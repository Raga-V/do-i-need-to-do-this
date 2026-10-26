import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { predictPersonalVerdict, readProbabilities } from "../tabpfn.js";
import { trainingRows, featureRow, validTrainingRow } from "../public/features.js";
import { createApp } from "../server.js";

const LABELS = ["skip", "lazy", "yes"];
const rows = Array.from({ length: 12 }, (_, i) => ["chores", "minor", i % 3 ? 2 : null, i % 2, 1, 15 + i, LABELS[i % 3]]);
const query = ["chores", "minor", 1, 0, 1, 20];

/** Fake Prior Labs API that follows the documented flow and records every request. */
function fakePriorLabs({ prediction = [[0.1, 0.72, 0.18]], classes = ["lazy", "skip", "yes"], duplicateTrain = false } = {}) {
  const calls = [], uploads = {};
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method, auth: init.headers?.Authorization, body: init.method === "PUT" ? init.body : JSON.parse(init.body) });
    if (init.method === "PUT") { uploads[path] = init.body; return new Response("", { status: 200 }); }
    const signed = (name) => ({ signed_urls: [`https://storage.example/${name}`], expires_at: 0, required_headers: { "x-goog-meta": "1" } });
    switch (path) {
      case "/tabpfn/prepare_train_set_upload":
        return duplicateTrain ? json(409, { message: "dup", train_set_upload_id: "train-1" })
          : json(200, { train_set_upload_id: "train-1", x_train_info: signed("x_train"), y_train_info: signed("y_train") });
      case "/tabpfn/fit": return json(200, { fitted_train_set_id: "fit-1", status: "completed" });
      case "/tabpfn/prepare_test_set_upload": return json(200, { test_set_upload_id: "test-1", x_test_info: signed("x_test") });
      case "/tabpfn/predict": return json(200, { prediction, metadata: { classes, test_set_num_rows: 1, test_set_num_cols: 6, package_version: "x", tabpfn_config: {} } });
      default: return json(404, { message: "nope" });
    }
  };
  return { fetchImpl, calls, uploads };
}

test("follows the documented TabPFN flow and reads class probabilities", async () => {
  const api = fakePriorLabs();
  const r = await predictPersonalVerdict({ rows, query, token: "tp-token", fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls.filter((c) => c.method === "POST").map((c) => c.path), [
    "/tabpfn/prepare_train_set_upload", "/tabpfn/fit", "/tabpfn/prepare_test_set_upload", "/tabpfn/predict"]);
  assert.ok(api.calls.filter((c) => c.method === "POST").every((c) => c.auth === "Bearer tp-token"));
  assert.equal(api.calls.find((c) => c.path === "/tabpfn/predict").body.task_config.predict_params.output_type, "probas");
  assert.equal(r.verdict, "skip");
  assert.equal(r.probability, 0.72);
  // what was uploaded is only the six features and the labels
  assert.equal(api.uploads["/x_train"].split("\n")[0], "category,consequence,days_to_deadline,affects_others,can_be_undone_later,effort_minutes");
  assert.equal(api.uploads["/x_train"].split("\n")[1], "chores,minor,,0,1,15");
  assert.equal(api.uploads["/y_train"].split("\n").slice(0, 3).join("|"), "verdict|skip|lazy");
  assert.equal(api.uploads["/x_test"].trim().split("\n")[1], "chores,minor,1,0,1,20");
});

test("reuses an already-uploaded training set (409)", async () => {
  const api = fakePriorLabs({ duplicateTrain: true });
  const r = await predictPersonalVerdict({ rows, query, token: "t", fetchImpl: api.fetchImpl });
  assert.equal(api.uploads["/x_train"], undefined);
  assert.equal(r.verdict, "skip");
});

test("readProbabilities handles the documented prediction shapes", () => {
  assert.equal(readProbabilities({ prediction: [0.2, 0.8], metadata: { classes: ["skip", "yes"] } }, rows).verdict, "yes");
  assert.equal(readProbabilities({ prediction: { skip: [0.9], yes: [0.1] } }, rows).verdict, "skip");
  // no metadata.classes → sorted labels, like scikit-learn
  assert.equal(readProbabilities({ prediction: [[0.5, 0.3, 0.2]] }, rows).verdict, "lazy");
  assert.throws(() => readProbabilities({ prediction: [[0.5, 0.5]] }, rows));
  assert.throws(() => readProbabilities({}, rows));
});

test("trainingRows uses only labelled rows and only the six features", () => {
  const history = [
    { task: "secret task text", category: "money", consequence: "serious", days_to_deadline: 5, affects_others: false,
      can_be_undone_later: false, effort_minutes: 10, user_verdict: "yes", verdict: "later" },
    { task: "unlabelled", category: "chores", consequence: "minor", days_to_deadline: null, affects_others: true,
      can_be_undone_later: true, effort_minutes: 30, user_verdict: null, verdict: "skip" },
  ];
  const t = trainingRows(history);
  assert.deepEqual(t, [["money", "serious", 5, 0, 0, 10, "yes"]]);
  assert.ok(!JSON.stringify(t).includes("secret"));
  assert.deepEqual(featureRow(history[1]), ["chores", "minor", null, 1, 1, 30]);
  assert.ok(validTrainingRow(t[0]));
});

function start(env, deps) {
  return new Promise((resolve) => {
    const server = http.createServer(createApp(env, deps)).listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}
const post = (base, body) => fetch(`${base}/api/predict`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

test("/api/predict returns the personal verdict with probabilities", async () => {
  const api = fakePriorLabs();
  const s = await start({ TABPFN_TOKEN: "t" }, { fetch: api.fetchImpl });
  const r = await post(s.base, { rows, query });
  const j = await r.json();
  s.server.close();
  assert.equal(r.status, 200);
  assert.equal(j.verdict, "skip");
  assert.equal(j.rows, 12);
  assert.equal(Math.round(j.probabilities.skip * 100), 72);
});

test("/api/predict rejects anything but the six features (no text can get through)", async () => {
  const api = fakePriorLabs();
  const s = await start({ TABPFN_TOKEN: "t" }, { fetch: api.fetchImpl });
  const withText = rows.map((r, i) => (i === 0 ? ["Pay rent to Mr. Sharma", ...r.slice(1)] : r));
  const extraCol = rows.map((r) => [...r.slice(0, 6), "my secret", r[6]]);
  const codes = [
    (await post(s.base, { rows: withText, query })).status,
    (await post(s.base, { rows: extraCol, query })).status,
    (await post(s.base, { rows, query: [...query, "extra"] })).status,
    (await post(s.base, { rows: rows.slice(0, 9), query })).status,                                  // < 10 rows
    (await post(s.base, { rows: rows.map((r) => [...r.slice(0, 6), "skip"]), query })).status,       // one class only
  ];
  s.server.close();
  assert.deepEqual(codes, [400, 400, 400, 422, 422]);
  assert.equal(api.calls.length, 0);
});
