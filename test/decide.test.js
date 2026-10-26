import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, normalizeFacts, daysUntil, addDays, verdictLine, safetyCategory } from "../public/decide.js";

const TODAY = "2026-10-24";
const base = {
  category: "other", deadline: "", if_skipped: "Nothing much.", consequence: "minor",
  affects_others: false, can_be_undone_later: true, effort_minutes: 60,
  lazy_minimum: "", lazy_minimum_minutes: 0, confidence: 0.9, one_line_reason: "It's fine.",
};
const facts = (over) => ({ ...base, ...over });

test("money task never gets skip, even when Gemma says nothing happens", () => {
  const r = decide(facts({ category: "money", consequence: "nothing" }), TODAY);
  assert.notEqual(r.verdict, "skip");
  assert.equal(r.safety_override, true);
});

test("every protected category is protected from skip", () => {
  for (const category of ["money", "health", "legal_or_official", "exam_or_graded"]) {
    for (const consequence of ["nothing", "minor"]) {
      const r = decide(facts({ category, consequence }), TODAY);
      assert.notEqual(r.verdict, "skip", `${category}/${consequence}`);
    }
  }
});

test("money task with a cheap minimum gets the lazy minimum under the safety rule", () => {
  const r = decide(facts({ category: "money", consequence: "minor", lazy_minimum: "Pay in the app", lazy_minimum_minutes: 3, effort_minutes: 20 }), TODAY);
  assert.equal(r.verdict, "lazy");
  assert.equal(r.rule, "safety_minimum");
});

test("low confidence → not sure yet", () => {
  const r = decide(facts({ confidence: 0.3, consequence: "nothing" }), TODAY);
  assert.equal(r.verdict, "unsure");
  assert.equal(r.rule, "low_confidence");
});

test("confidence exactly 0.5 is enough", () => {
  assert.equal(decide(facts({ confidence: 0.5, consequence: "nothing" }), TODAY).verdict, "skip");
});

test("consequence 'nothing' → skip", () => {
  const r = decide(facts({ consequence: "nothing" }), TODAY);
  assert.equal(r.verdict, "skip");
  assert.equal(r.safety_override, false);
});

test("minor and nobody else affected → skip", () => {
  assert.equal(decide(facts({ consequence: "minor" }), TODAY).verdict, "skip");
});

test("minor but affects others → not skip; lazy minimum if there is one", () => {
  const withMin = decide(facts({ consequence: "minor", affects_others: true, lazy_minimum: "Text the group", lazy_minimum_minutes: 2 }), TODAY);
  assert.equal(withMin.verdict, "lazy");
  assert.equal(withMin.lazy_minimum, "Text the group");
  const noMin = decide(facts({ consequence: "minor", affects_others: true }), TODAY);
  assert.equal(noMin.verdict, "yes");
});

test("serious with deadline more than 3 days away → later, by the day before", () => {
  const r = decide(facts({ consequence: "serious", deadline: "2026-11-03" }), TODAY);
  assert.equal(r.verdict, "later");
  assert.equal(r.by_when, "2026-11-02");
  assert.equal(r.days_to_deadline, 10);
});

test("serious with deadline within 3 days, overdue, or none → yes", () => {
  for (const deadline of ["2026-10-27", "2026-10-24", "2026-10-20", ""]) {
    assert.equal(decide(facts({ consequence: "serious", deadline }), TODAY).verdict, "yes", deadline || "no deadline");
  }
});

test("severe → yes, even with a far deadline", () => {
  assert.equal(decide(facts({ consequence: "severe", deadline: "2026-12-31" }), TODAY).verdict, "yes");
});

test("minimum cheaper than the full effort → lazy minimum", () => {
  const r = decide(facts({ consequence: "annoying", effort_minutes: 90, lazy_minimum: "Ask a friend for notes", lazy_minimum_minutes: 5 }), TODAY);
  assert.equal(r.verdict, "lazy");
  assert.match(r.reason, /~5 min instead of ~90 min/);
});

test("a 'minimum' that is the whole task or takes 0 minutes is not a minimum", () => {
  const same = decide(facts({ consequence: "annoying", can_be_undone_later: false, effort_minutes: 30, lazy_minimum: "Attend", lazy_minimum_minutes: 30 }), TODAY);
  assert.equal(same.verdict, "yes");
  const zero = decide(facts({ consequence: "annoying", can_be_undone_later: false, effort_minutes: 30, lazy_minimum: "Attend the class.", lazy_minimum_minutes: 0 }), TODAY);
  assert.equal(zero.verdict, "yes");
});

test("annoying, undoable, nobody affected, no deadline → later without a date", () => {
  const r = decide(facts({ consequence: "annoying", can_be_undone_later: true }), TODAY);
  assert.equal(r.verdict, "later");
  assert.equal(r.by_when, "");
});

test("unknown consequence → not sure yet instead of guessing", () => {
  assert.equal(decide(facts({ consequence: "kinda bad" }), TODAY).verdict, "unsure");
});

test("normalizeFacts cleans sloppy model output", () => {
  const f = normalizeFacts({ category: "Banana", deadline: "2026-02-30", consequence: "MINOR", affects_others: "yes",
    effort_minutes: "45.6", lazy_minimum_minutes: -3, confidence: 85, one_line_reason: 42 });
  assert.equal(f.category, "other");
  assert.equal(f.deadline, "");         // Feb 30 doesn't exist
  assert.equal(f.consequence, "minor");
  assert.equal(f.affects_others, true);
  assert.equal(f.effort_minutes, 46);
  assert.equal(f.lazy_minimum_minutes, 0);
  assert.equal(f.confidence, 0.85);     // "85" read as a percentage
  assert.equal(f.one_line_reason, "");
  assert.equal(normalizeFacts(null).confidence, 0);
});

test("date helpers", () => {
  assert.equal(daysUntil("2026-10-25", TODAY), 1);
  assert.equal(daysUntil("2026-10-23", TODAY), -1);
  assert.equal(daysUntil("", TODAY), null);
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
});

test("safety keywords catch protected tasks the model misfiles", () => {
  assert.equal(safetyCategory("Pay the electricity bill"), "money");
  assert.equal(safetyCategory("Book a dentist appointment"), "health");
  assert.equal(safetyCategory("Renew my passport"), "legal_or_official");
  assert.equal(safetyCategory("Finish the DBMS assignment"), "exam_or_graded");
  assert.equal(safetyCategory("Do the laundry"), "");
});

test("verdictLine is short and speakable", () => {
  const r = decide(facts({ consequence: "nothing", one_line_reason: "At 88% attendance, the professor will survive" }), TODAY);
  assert.equal(verdictLine(r), "Skip it. At 88 percent attendance, the professor will survive. Court is adjourned.");
  const lazy = decide(facts({ consequence: "annoying", lazy_minimum: "Pay it in the app.", lazy_minimum_minutes: 2, one_line_reason: "Late fee after the 5th." }), TODAY);
  assert.match(verdictLine(lazy), /Just: Pay it in the app\. Court/);
  assert.ok(verdictLine(r).length <= 300);
});
