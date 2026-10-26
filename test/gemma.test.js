import { test } from "node:test";
import assert from "node:assert/strict";
import { chatJSON, cleanQuestions, cleanFacts, parseModelJSON, mentionsDate, askQuestions } from "../public/gemma.js";

/** A fake Ollama: returns the given message contents in order and records requests. */
function fakeOllama(...contents) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const content = contents[Math.min(calls.length - 1, contents.length - 1)];
    return { ok: true, status: 200, json: async () => ({ message: { content }, prompt_eval_count: 10, eval_count: 5, load_duration: 0 }) };
  };
  return { fetchImpl, calls };
}

test("parseModelJSON tolerates fences and chatter", () => {
  assert.deepEqual(parseModelJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(parseModelJSON('Sure! {"a":2} hope that helps'), { a: 2 });
  assert.throws(() => parseModelJSON("no json here"));
  assert.throws(() => parseModelJSON(""));
});

test("malformed JSON is retried once, then succeeds", async () => {
  const { fetchImpl, calls } = fakeOllama('{"oops": ', '{"ok": true}');
  const errors = [];
  const r = await chatJSON({ fetchImpl, messages: [{ role: "user", content: "hi" }], schema: {}, step: "test",
    clean: (x) => { if (!x.ok) throw new Error("bad"); return x; }, onError: (e) => errors.push(e) });
  assert.deepEqual(r.data, { ok: true });
  assert.equal(r.stats.attempts, 2);
  assert.equal(calls.length, 2);
  assert.equal(errors.length, 1);
  // the retry tells the model what went wrong
  assert.match(calls[1].body.messages.at(-1).content, /not valid/);
  assert.equal(calls[1].body.format !== undefined, true);
});

test("two malformed replies → a clear error, no third call", async () => {
  const { fetchImpl, calls } = fakeOllama("garbage", "more garbage");
  await assert.rejects(
    chatJSON({ fetchImpl, messages: [], schema: {}, step: "facts", clean: (x) => x }),
    (e) => e.code === "bad_json");
  assert.equal(calls.length, 2);
});

test("unreachable Ollama gives a helpful error", async () => {
  const fetchImpl = async () => { throw new TypeError("fetch failed"); };
  await assert.rejects(chatJSON({ fetchImpl, messages: [], schema: {}, step: "x", clean: (x) => x }), (e) => e.code === "unreachable");
});

test("questions are capped at 3 and need 2+ options", () => {
  const raw = { answered_by_context: [], questions: [
    { about: "consequence", question: "What happens?", options: ["A", "B"] },
    { about: "affects_others", question: "Anyone waiting?", options: ["Yes", "No"] },
    { about: "lazy_minimum", question: "Lazier way?", options: ["Only one"] },        // dropped: 1 option
    { about: "effort_minutes", question: "How long?", options: ["5 min", "1 hour"] },
    { about: "can_be_undone_later", question: "Fixable later?", options: ["Yes", "No"] },
  ] };
  const qs = cleanQuestions(raw, "Go to the lecture tomorrow");
  assert.equal(qs.length, 3);
  assert.ok(qs.every((q) => q.options.length >= 2 && q.options.length <= 4));
  assert.ok(!qs.some((q) => q.question === "Lazier way?"));
});

test("questions the context already answers are dropped (quote must really be there)", () => {
  const known = "Reply to the group chat\nNobody is waiting on me, it's just memes";
  const raw = {
    answered_by_context: [
      { about: "affects_others", quote: "Nobody is waiting on me" },        // real quote → trusted
      { about: "consequence", quote: "They'll cut off the power" },          // invented → ignored
    ],
    questions: [
      { about: "affects_others", question: "Is anyone waiting?", options: ["Yes", "No"] },
      { about: "consequence", question: "What happens if you don't?", options: ["Nothing", "Drama"] },
    ],
  };
  const qs = cleanQuestions(raw, known);
  assert.ok(!qs.some((q) => q.about === "affects_others"));
  assert.ok(qs.some((q) => q.about === "consequence"));
});

test("a date in the context drops deadline questions; no date adds one", () => {
  const ask = { answered_by_context: [], questions: [{ about: "deadline", question: "When is it due?", options: ["Today", "Later"] }] };
  assert.equal(cleanQuestions(ask, "Go to the 8 AM lecture tomorrow").length, 0);
  const none = cleanQuestions({ answered_by_context: [], questions: [] }, "Pay the electricity bill");
  assert.equal(none.length, 1);
  assert.equal(none[0].about, "deadline");
  assert.equal(none[0].added_by_app, true);
});

test("duplicate questions about the same fact are dropped", () => {
  const qs = cleanQuestions({ answered_by_context: [], questions: [
    { about: "consequence", question: "What happens?", options: ["A", "B"] },
    { about: "consequence", question: "Is it crucial?", options: ["A", "B"] },
  ] }, "today");
  assert.equal(qs.length, 1);
});

test("mentionsDate", () => {
  for (const s of ["tomorrow", "on Friday", "by 5/11", "2026-11-01", "12th Nov", "within a week", "in 3 days", "end of the month"]) assert.ok(mentionsDate(s), s);
  for (const s of ["Pay the electricity bill", "Go to the 8 AM lecture", "Reply to mom"]) assert.ok(!mentionsDate(s), s);
});

const goodFacts = {
  working: "x", category: "other", deadline: "2026-11-01", if_skipped: "x", consequence: "minor", affects_others: false,
  can_be_undone_later: true, effort_minutes: 10, lazy_minimum: "", lazy_minimum_minutes: 0, confidence: 0.9, one_line_reason: "x",
};

test("cleanFacts drops a deadline the user never mentioned", () => {
  const r = cleanFacts(goodFacts, "Pay the electricity bill");
  assert.equal(r.facts.deadline, "");
  assert.equal(r.notes.length >= 1, true);
  const kept = cleanFacts(goodFacts, "Pay the bill\nWithin a week");
  assert.equal(kept.facts.deadline, "2026-11-01");
});

test("cleanFacts forces protected category from task keywords", () => {
  const r = cleanFacts(goodFacts, "by Friday", "Pay the electricity bill");
  assert.equal(r.facts.category, "money");
  assert.match(r.notes.join(" "), /money/);
});

test("cleanFacts rejects missing fields or bad consequence (so chatJSON retries)", () => {
  const { consequence, ...missing } = goodFacts;
  assert.throws(() => cleanFacts(missing));
  assert.throws(() => cleanFacts({ ...goodFacts, consequence: "catastrophic-ish" }));
});

test("askQuestions sends the schema and the task to Ollama, and returns cleaned questions", async () => {
  const { fetchImpl, calls } = fakeOllama(JSON.stringify({ answered_by_context: [], questions: [
    { about: "consequence", question: "What happens?", options: ["Nothing", "Fine"] }] }));
  const r = await askQuestions({ fetchImpl, task: "Go to the gym today", context: "", photoNotes: "", profile: "", today: "2026-10-24" });
  assert.equal(calls[0].body.model, "gemma3:4b");
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.format.type, "object");
  assert.match(calls[0].body.messages[1].content, /Go to the gym today/);
  assert.equal(r.data.length, 1);
});

test("relevantProfile only passes background that matches the task's topic", async () => {
  const { relevantProfile } = await import("../public/gemma.js");
  const profile = "I'm a student. My attendance is 88% and the minimum is 75%.\nMy manager doesn't mind async replies.";
  assert.equal(relevantProfile(profile, "Do the laundry tonight"), "I'm a student.");
  assert.equal(relevantProfile(profile, "Go to the 8 AM lecture tomorrow"), "I'm a student. My attendance is 88% and the minimum is 75%.");
  assert.equal(relevantProfile(profile, "Reply to my manager's email"), "I'm a student. My manager doesn't mind async replies.");
  assert.equal(relevantProfile("", "anything"), "");
});

test("a tapped deadline answer sets the date in code, overriding Gemma's arithmetic", async () => {
  const { deadlineFromAnswer, extractFacts } = await import("../public/gemma.js");
  assert.equal(deadlineFromAnswer("Today", "2026-10-25"), "2026-10-25");
  assert.equal(deadlineFromAnswer("Tomorrow", "2026-10-25"), "2026-10-26");
  assert.equal(deadlineFromAnswer("Within a week", "2026-10-25"), "2026-11-01");
  assert.equal(deadlineFromAnswer("No real deadline", "2026-10-25"), "");
  assert.equal(deadlineFromAnswer("When the professor says so", "2026-10-25"), null);

  // Gemma writes tomorrow's date although the user tapped "Today"
  const { fetchImpl } = fakeOllama(JSON.stringify({ ...goodFacts, deadline: "2026-10-26", category: "money" }));
  const r = await extractFacts({ fetchImpl, task: "Pay the electricity bill", context: "", photoNotes: "", profile: "", today: "2026-10-25",
    answers: [{ question: "When does it actually need to be done?", answer: "Today", about: "deadline" }] });
  assert.equal(r.data.facts.deadline, "2026-10-25");
  assert.match(r.data.notes.join(" "), /Gemma wrote 2026-10-26/);
});

test("questions and options lose Markdown emphasis (they're shown and spoken)", () => {
  const qs = cleanQuestions({ answered_by_context: [], questions: [{ about: "consequence", question: "What happens if you *don't* reply?", options: ["**Nothing**", "They get _annoyed_"] }] }, "today");
  assert.equal(qs[0].question, "What happens if you don't reply?");
  assert.deepEqual(qs[0].options, ["Nothing", "They get annoyed"]);
});
