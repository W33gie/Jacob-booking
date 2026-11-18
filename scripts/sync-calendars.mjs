// Pulls Jacob's Airbnb calendars and direct bookings together.
// Writes:
//   availability.json   -> booked date ranges the website reads (dates only, no guest info)
//   direct/<id>.ics     -> direct bookings, for Airbnb to import so those dates get blocked there
//
// Airbnb export links live in GitHub repo secrets (never in the code):
//   AIRBNB_ICAL_APT, AIRBNB_ICAL_TOWNSITE

import { readFile, writeFile, mkdir } from "node:fs/promises";

const PROPERTIES = {
  apt:      { name: "The Cozy Apartment", secret: "AIRBNB_ICAL_APT" },
  townsite: { name: "Townsite Delight",   secret: "AIRBNB_ICAL_TOWNSITE" },
};

const ROOT = new URL("../", import.meta.url);
const file = (p) => new URL(p, ROOT);

// --- tiny iCal parser: pulls DTSTART / DTEND dates out of each VEVENT ---
export function parseIcal(text) {
  const lines = text.replace(/\r\n[ \t]/g, "").split(/\r?\n/); // unfold
  const out = [];
  let ev = null;
  for (const line of lines) {
    if (line.startsWith("BEGIN:VEVENT")) ev = {};
    else if (line.startsWith("END:VEVENT")) {
      if (ev?.start && ev?.end && ev.end > ev.start) out.push(ev);
      ev = null;
    } else if (ev) {
      const m = line.match(/^(DTSTART|DTEND)[^:]*:(\d{4})(\d{2})(\d{2})/);
      if (m) ev[m[1] === "DTSTART" ? "start" : "end"] = `${m[2]}-${m[3]}-${m[4]}`;
    }
  }
  return out; // end = checkout day (exclusive)
}

function mergeRanges(ranges) {
  const s = [...ranges].sort((a, b) => a.start.localeCompare(b.start));
  const out = [];
  for (const r of s) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end) { if (r.end > last.end) last.end = r.end; }
    else out.push({ start: r.start, end: r.end });
  }
  return out;
}

function toIcs(id, ranges) {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const ev = ranges.map((r, i) => [
    "BEGIN:VEVENT",
    `UID:direct-${id}-${r.start}-${i}@jacobs-stays`,
    `DTSTAMP:${stamp}`,
    `DTSTART;VALUE=DATE:${r.start.replace(/-/g, "")}`,
    `DTEND;VALUE=DATE:${r.end.replace(/-/g, "")}`,
    "SUMMARY:Direct booking",
    "END:VEVENT",
  ].join("\r\n"));
  return ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Jacobs Stays//Direct bookings//EN",
          "CALSCALE:GREGORIAN", ...ev, "END:VCALENDAR", ""].join("\r\n");
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  let direct = [];
  try { direct = JSON.parse(await readFile(file("direct-bookings.json"), "utf8")); }
  catch { console.warn("No direct-bookings.json yet, skipping."); }

  let previous = {};
  try { previous = JSON.parse(await readFile(file("availability.json"), "utf8")).properties || {}; } catch {}

  const result = {};
  let failed = 0;
  await mkdir(file("direct/"), { recursive: true });

  for (const [id, cfg] of Object.entries(PROPERTIES)) {
    const directRanges = direct
      .filter((b) => b.property === id && b.start && b.end && b.end > b.start)
      .map(({ start, end }) => ({ start, end }));

    let airbnb = null;
    const url = process.env[cfg.secret];
    if (url) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (calendar sync)" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not an iCal file");
        airbnb = parseIcal(text);
        console.log(`${cfg.name}: ${airbnb.length} blocked ranges from Airbnb`);
      } catch (e) {
        failed++;
        console.error(`${cfg.name}: Airbnb fetch failed (${e.message}). Keeping last known dates.`);
      }
    } else {
      console.warn(`${cfg.name}: secret ${cfg.secret} not set.`);
    }

    // if Airbnb failed, keep what we had before rather than showing everything as free
    const base = airbnb ?? (previous[id] || []);
    result[id] = mergeRanges([...base, ...directRanges]).filter((r) => r.end > today);

    await writeFile(file(`direct/${id}.ics`), toIcs(id, directRanges));
  }

  const data = { updated: new Date().toISOString(), properties: result };
  await writeFile(file("availability.json"), JSON.stringify(data, null, 2) + "\n");
  console.log("availability.json written.");
  if (failed === Object.keys(PROPERTIES).length) process.exitCode = 1;
}

if (import.meta.url === `file://${process.argv[1]}`) main();
