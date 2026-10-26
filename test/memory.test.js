import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeFacts, sameFact, groundedIn, factsText, MAX_FACTS } from "../public/memory.js";
import { cleanMemoryFacts, learnFacts } from "../public/gemma.js";

test("sameFact catches rewordings, not different facts", () => {
  assert.ok(sameFact("College requires 75% attendance.", "My college requires 75% attendance"));
  assert.ok(sameFact("Pays rent on the 5th.", "Pays rent on the 5th of each month."));
  assert.ok(!sameFact("Pays rent on the 5th.", "Goes to the gym Mon/Wed/Fri."));
});

test("mergeFacts dedupes, keeps the newest 30, reports what was added", () => {
  let { list, added } = mergeFacts([], ["Pays rent on the 5th.", "Goes to the gym Mon/Wed/Fri."], { now: 1 });
  assert.equal(list.length, 2);
  assert.deepEqual(added, ["Pays rent on the 5th.", "Goes to the gym Mon/Wed/Fri."]);
  ({ list, added } = mergeFacts(list, ["Pays rent on the 5th of each month.", "College requires 75% attendance."], { now: 2 }));
  assert.equal(list.length, 3);
  assert.deepEqual(added, ["College requires 75% attendance."]);
  const many = Array.from({ length: 40 }, (_, i) => `Fact number ${i} about topic${i} zone${i}.`);
  ({ list } = mergeFacts([], many, { now: 3 }));
  assert.equal(list.length, MAX_FACTS);
  assert.match(list.at(-1).text, /39/);
});

test("learned facts must be grounded in what the user typed", () => {
  const userText = "Pay rent\nIt's due on the 5th every month";
  assert.ok(groundedIn("Pays rent on the 5th of each month.", userText));
  assert.ok(!groundedIn("Owns a golden retriever named Max.", userText));
  const clean = cleanMemoryFacts({ facts: ["Pays rent on the 5th of each month", "Owns a golden retriever named Max.", "x", 42, "a", "b", "c"] }, userText);
  assert.deepEqual(clean, ["Pays rent on the 5th of each month."]);
  assert.throws(() => cleanMemoryFacts({}));
});

test("factsText ends every fact with a period (so the topic filter can split them)", () => {
  assert.equal(factsText([{ text: "Gym Mon/Wed/Fri" }, { text: "Pays rent on the 5th." }]), "Gym Mon/Wed/Fri. Pays rent on the 5th.");
});

test("learnFacts sends the task, answers and known facts to Gemma with a schema", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return { ok: true, json: async () => ({ message: { content: JSON.stringify({ facts: ["College requires 75% attendance."] }) }, eval_count: 9 }) };
  };
  const r = await learnFacts({ fetchImpl, task: "Go to the lecture", context: "College requires 75% attendance", answers: [], known: ["Pays rent on the 5th."] });
  assert.deepEqual(r.data, ["College requires 75% attendance."]);
  assert.equal(calls[0].format.properties.facts.type, "array");
  assert.match(calls[0].messages[1].content, /Already known/);
});

test("one-off deadlines never become memory facts", () => {
  const userText = "Pay the rent. Landlord charges a late fee after the 5th. Within a week";
  assert.deepEqual(cleanMemoryFacts({ facts: ["Landlord charges a late fee after the 5th.", "Rent needs to be paid within a week."] }, userText),
    ["Landlord charges a late fee after the 5th."]);
});
