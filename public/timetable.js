// timetable.js — "Your timetable": weekly entries read by Gemma, fixed by the user, stored in the browser.
// Pure functions (shared with node tests). The timetable is only ever sent to the local Gemma.
import { words } from "./memory.js";

export const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
export const TYPES = ["class", "lab", "work", "other"];
export const MAX_ENTRIES = 120;

/** "mon", "Mon.", "MONDAY", "thurs" → "Monday" … or "" if it isn't a day. */
export function normalizeDay(d) {
  const s = String(d || "").trim().toLowerCase().replace(/\.$/, "");
  if (s.length < 2) return "";
  // "mon", "tues", "thurs", "monday", "mondays"
  return DAYS.find((day) => { const x = day.toLowerCase(); return x.startsWith(s) || s.startsWith(x); }) || "";
}

/** "8", "8:00", "08.30", "1:30 PM", "13:30" → "HH:MM" (24h), or "" if it can't be read. Never guesses AM/PM. */
export function normalizeTime(t) {
  const m = String(t || "").trim().toLowerCase().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/);
  if (!m) return "";
  let h = Number(m[1]);
  const min = Number(m[2] || 0);
  const ap = m[3]?.[0];
  if (ap === "p" && h < 12) h += 12;
  if (ap === "a" && h === 12) h = 0;
  if (h > 23 || min > 59) return "";
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/**
 * Validate Gemma's rows. Rows Gemma wasn't sure about, or that don't add up (unreadable times,
 * end before start, a title that isn't in what Gemma read), keep a `check` flag instead of being guessed.
 */
export function cleanTimetable(raw, sourceText = "") {
  if (!raw || !Array.isArray(raw.entries)) throw new Error("missing entries array");
  const source = sourceText.toLowerCase();
  const seen = new Set();
  const out = [];
  for (const e of raw.entries) {
    if (!e || typeof e !== "object") continue;
    const title = String(e.title || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!title || /^[-–—.\s]+$/.test(title) || /^(free|break|lunch|--)$/i.test(title)) continue;
    const day = normalizeDay(e.day);
    const start = normalizeTime(e.start), end = normalizeTime(e.end);
    const type = TYPES.includes(String(e.type).toLowerCase()) ? String(e.type).toLowerCase() : "other";
    const key = `${day}|${start}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const titleSeen = !source || words(title).some((w) => source.includes(w)) || source.includes(title.toLowerCase());
    const check = e.confident === false || !day || !start || (end && end <= start) || !titleSeen;
    out.push({ day: day || "Monday", start, end, title, type, check: Boolean(check) });
    if (out.length === MAX_ENTRIES) break;
  }
  return sortEntries(out);
}

const RANGE = /(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)\s*(?:-|–|—|to)\s*(\d{1,2}(?:[:.]\d{2})?\s*(?:am|pm)?)/i;

function guessType(title) {
  if (/\b(lab|practical|workshop)\b/i.test(title)) return "lab";
  if (/\b(shift|work|office|job)\b/i.test(title)) return "work";
  if (/\b(library|sports?|games|club|break|lunch|meeting|counsel+ing|mentoring|free)\b/i.test(title)) return "other";
  return "class";
}

/** Turn "1:00-2:00" slots that come after a morning slot into 13:00-14:00 (timetables often skip AM/PM). */
function afternoonFix(slots) {
  let prev = -1;
  return slots.map((s) => {
    if (!s) return s;
    let [start, end] = s;
    const mins = (t) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
    const plus12 = (t) => `${String(Number(t.slice(0, 2)) + 12).padStart(2, "0")}${t.slice(2)}`;
    if (prev >= 0 && mins(start) < prev && Number(start.slice(0, 2)) < 12) { start = plus12(start); if (end && Number(end.slice(0, 2)) < 12) end = plus12(end); }
    if (end && mins(end) <= mins(start) && Number(end.slice(0, 2)) < 12) end = plus12(end);
    prev = mins(start);
    return [start, end];
  });
}

/**
 * Exact, instant reading of a grid transcript ("Day | 8:00-9:00 | … " with one row per day, or the transposed form).
 * Returns entries, or null when the text isn't such a grid (then Gemma structures it instead).
 */
export function parseGrid(transcript) {
  const rows = String(transcript || "").split(/\r?\n/).filter((l) => l.includes("|"))
    .map((l) => l.split("|").map((c) => c.trim()).filter((c, i, a) => !(c === "" && (i === 0 || i === a.length - 1))));
  if (rows.length < 2) return null;
  const empty = (c) => !c || /^(-+|–|—|\[\?\]|free|break|lunch)$/i.test(c);
  const out = [];
  const add = (day, slot, title) => {
    if (!day || !slot || empty(title)) return;
    out.push({ day, start: slot[0], end: slot[1] || "", title: title.replace(/\s+/g, " ").slice(0, 80), type: guessType(title), check: /\[\?\]/.test(title) });
  };
  const slotOf = (c) => { const m = String(c).match(RANGE); return m ? [normalizeTime(m[1]), normalizeTime(m[2])] : null; };
  const headerIdx = rows.findIndex((r) => r.filter(slotOf).length >= 2);
  if (headerIdx >= 0) {
    // times across the top, one row per day
    const slots = afternoonFix(rows[headerIdx].map((c) => { const s = slotOf(c); return s && s[0] ? s : null; }));
    for (const r of rows.slice(headerIdx + 1)) {
      const day = normalizeDay(r[0]);
      if (!day) continue;
      r.slice(1).forEach((cell, i) => add(day, slots[i + 1], cell));
    }
  } else {
    // days across the top, one row per time slot
    const dayHeader = rows.findIndex((r) => r.filter((c) => normalizeDay(c)).length >= 2);
    if (dayHeader < 0) return null;
    const days = rows[dayHeader].map((c) => normalizeDay(c));
    const body = rows.slice(dayHeader + 1).filter((r) => slotOf(r[0]));
    const slots = afternoonFix(body.map((r) => slotOf(r[0])));
    body.forEach((r, j) => r.slice(1).forEach((cell, i) => add(days[i + 1], slots[j], cell)));
  }
  return out.length >= 2 ? sortEntries(out) : null;
}

export function sortEntries(list) {
  return [...list].sort((a, b) => DAYS.indexOf(a.day) - DAYS.indexOf(b.day) || (a.start || "99").localeCompare(b.start || "99"));
}

/** Weekday name of a "YYYY-MM-DD" date. */
export function dayOf(iso) {
  return DAYS[(new Date(`${iso}T12:00:00Z`).getUTCDay() + 6) % 7];
}

export function entriesOn(list, iso) {
  const day = dayOf(iso);
  return sortEntries(list.filter((e) => e.day === day));
}

const line = (e) => `${e.day} ${e.start || "?"}${e.end ? `–${e.end}` : ""} ${e.title} (${e.type})`;

/** Today's and tomorrow's entries as prompt text, e.g. "Today (Monday): Monday 08:00–09:00 DBMS (class)". */
export function scheduleText(list, today, tomorrow) {
  const fmt = (iso, label) => {
    const items = entriesOn(list, iso);
    return `${label} (${dayOf(iso)}): ${items.length ? items.map(line).join("; ") : "nothing on the timetable"}`;
  };
  return list.length ? `${fmt(today, "Today")}\n${fmt(tomorrow, "Tomorrow")}` : "";
}

const SCHEDULE_WORDS = /\b(class(es)?|lectures?|labs?|lessons?|tutorials?|periods?|seminars?|shifts?|work|office|meeting|college|school|uni(versity)?|timetable|schedule|attendance|viva|practical)\b/i;
const CLOCK = /\b\d{1,2}([:.]\d{2})?\s*(am|pm)\b|\b\d{1,2}[:.]\d{2}\b/i;

/**
 * Only schedule-ish tasks see the timetable: classes, work, a clock time, or a title from the timetable.
 * (A 4B model otherwise mentions your DBMS lecture when you ask about laundry.)
 */
export function scheduleRelevant(taskText, list) {
  if (!list.length) return false;
  if (SCHEDULE_WORDS.test(taskText) || CLOCK.test(taskText)) return true;
  const taskWords = new Set(words(taskText));
  return list.some((e) => words(e.title).some((w) => w.length >= 3 && taskWords.has(w)));
}
