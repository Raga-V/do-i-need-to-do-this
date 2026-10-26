import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeDay, normalizeTime, cleanTimetable, parseGrid, scheduleText, scheduleRelevant, dayOf, entriesOn } from "../public/timetable.js";
import { readTimetable } from "../public/gemma.js";

const GRID = `III B.Tech CSE - Section A - Timetable (Odd Sem)

Day | 8:00-9:00 | 9:00-10:00 | 10:15-11:15 | 11:15-12:15
Mon | DBMS | OS | CN | Lab
Tue | OS | DBMS (Rm 204) | Maths | CN
Sat | OS Revision | -- | -- | --
Sun | DBMS Revision (Rm 101) | -- | -- | --`;

test("days and times are normalised, never guessed", () => {
  assert.equal(normalizeDay("Mon"), "Monday");
  assert.equal(normalizeDay("thurs"), "Thursday");
  assert.equal(normalizeDay("TUESDAY"), "Tuesday");
  assert.equal(normalizeDay("x"), "");
  assert.equal(normalizeTime("8"), "08:00");
  assert.equal(normalizeTime("8.30"), "08:30");
  assert.equal(normalizeTime("1:30 PM"), "13:30");
  assert.equal(normalizeTime("12 am"), "00:00");
  assert.equal(normalizeTime("25:00"), "");
  assert.equal(normalizeTime("noonish"), "");
});

test("parseGrid reads a day-per-row grid exactly", () => {
  const e = parseGrid(GRID);
  assert.equal(e.length, 10);
  assert.deepEqual(e[0], { day: "Monday", start: "08:00", end: "09:00", title: "DBMS", type: "class", check: false });
  assert.equal(e.find((x) => x.title === "Lab").type, "lab");
  assert.equal(e.at(-1).title, "DBMS Revision (Rm 101)");
  assert.ok(!e.some((x) => x.title === "--"));
});

test("parseGrid handles the transposed form and afternoon slots without AM/PM", () => {
  const t = `Time | Mon | Tue\n11:00-12:00 | Physics | Chem\n1:00-2:00 | Lab | --\n2:00-3:00 | [?] | Maths`;
  const e = parseGrid(t);
  assert.deepEqual(e.map((x) => `${x.day} ${x.start}-${x.end} ${x.title}`), [
    "Monday 11:00-12:00 Physics", "Monday 13:00-14:00 Lab", "Tuesday 11:00-12:00 Chem", "Tuesday 14:00-15:00 Maths"]);
  assert.equal(parseGrid("Mon 9am Physics\nTue 10am Chemistry"), null); // not a grid → Gemma structures it
});

test("cleanTimetable flags rows to check instead of guessing", () => {
  const rows = cleanTimetable({ entries: [
    { day: "Mon", start: "9:00", end: "10:00", title: "Physics", type: "class", confident: true },
    { day: "Tue", start: "?", end: "", title: "Chemistry", type: "class", confident: true },        // no time
    { day: "Wed", start: "10:00", end: "9:00", title: "Maths", type: "class", confident: true },    // ends before it starts
    { day: "Thu", start: "9:00", end: "10:00", title: "Astrology", type: "class", confident: true }, // not in the source
    { day: "Fri", start: "9:00", end: "10:00", title: "Biology", type: "class", confident: false },
    { day: "Fri", start: "11:00", end: "12:00", title: "--", type: "class", confident: true },       // empty cell dropped
  ] }, "Mon Physics 9-10. Tue Chemistry. Wed Maths 10-9. Fri Biology 9-10");
  assert.deepEqual(rows.map((r) => `${r.title}:${r.check}`), ["Physics:false", "Chemistry:true", "Maths:true", "Astrology:true", "Biology:true"]);
});

test("schedule text for today and tomorrow, only for schedule-ish tasks", () => {
  const e = parseGrid(GRID);
  assert.equal(dayOf("2026-10-25"), "Sunday");
  assert.equal(entriesOn(e, "2026-10-26").length, 4);
  const text = scheduleText(e, "2026-10-25", "2026-10-26");
  assert.match(text, /^Today \(Sunday\): Sunday 08:00–09:00 DBMS Revision \(Rm 101\) \(class\)/);
  assert.match(text, /Tomorrow \(Monday\): Monday 08:00–09:00 DBMS \(class\); Monday 09:00–10:00 OS/);
  assert.ok(scheduleRelevant("Go to the 8 AM lecture", e));
  assert.ok(scheduleRelevant("Skip DBMS tomorrow?", e));
  assert.ok(!scheduleRelevant("Do the laundry", e));
  assert.ok(!scheduleRelevant("Go to class", []));
});

test("readTimetable: photo → transcript → grid parse (one Gemma call), text list → Gemma structuring", async () => {
  const calls = [];
  const reply = (content) => ({ ok: true, json: async () => ({ message: { content: JSON.stringify(content) }, eval_count: 5 }) });
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return body.format.properties.transcript ? reply({ readable: true, transcript: GRID })
      : reply({ entries: [{ day: "Monday", start: "09:00", end: "10:00", title: "Physics", type: "class", confident: true }] });
  };
  const fromPhoto = await readTimetable({ fetchImpl, imageBase64: "AAAA" });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].messages[1].images);
  assert.equal(fromPhoto.data.method, "grid");
  assert.equal(fromPhoto.data.entries.length, 10);
  const fromText = await readTimetable({ fetchImpl, text: "Mon 9-10 Physics" });
  assert.equal(calls.length, 2);
  assert.equal(fromText.data.method, "gemma");
  assert.equal(fromText.data.entries[0].title, "Physics");
});

test("planDay: one batched call, facts per item in order, safety + today's deadline set in code", async () => {
  const { planDay } = await import("../public/gemma.js");
  const { decide } = await import("../public/decide.js");
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const item = (index, o) => ({ index, category: "class_or_lecture", if_skipped: "x", consequence: "minor", affects_others: false,
      can_be_undone_later: true, effort_minutes: 60, lazy_minimum: "", lazy_minimum_minutes: 0, confidence: 0.9, one_line_reason: "fine", ...o });
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ items: [
      item(2, { category: "other", consequence: "nothing" }),          // the exam, misfiled by the model
      item(1, { consequence: "nothing" }),
    ] }) } }) };
  };
  const items = [{ title: "DBMS revision", start: "08:00", end: "09:00", type: "class" }, { title: "Maths exam", start: "10:00", end: "12:00", type: "class" }, { title: "Library", start: "13:00", end: "14:00", type: "other" }];
  const r = await planDay({ fetchImpl, items, today: "2026-10-26" });
  assert.equal(calls.length, 1);
  assert.match(calls[0].messages[1].content, /1\. 08:00–09:00 DBMS revision \(class\)\n2\. 10:00–12:00 Maths exam/);
  assert.equal(r.data.length, 3);
  assert.equal(r.data[0].deadline, "2026-10-26");
  assert.equal(decide(r.data[0], "2026-10-26").verdict, "skip");
  assert.equal(r.data[1].category, "exam_or_graded");                  // safety keyword wins
  assert.notEqual(decide(r.data[1], "2026-10-26").verdict, "skip");
  assert.equal(decide(r.data[2], "2026-10-26").verdict, "unsure");     // skipped by the model → not sure
});
