import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createApp, createRateLimiter } from "../server.js";

function start(env = {}, deps = {}) {
  return new Promise((resolve) => {
    const server = http.createServer(createApp(env, deps)).listen(0, "127.0.0.1", () =>
      resolve({ server, base: `http://127.0.0.1:${server.address().port}` }));
  });
}

let plain;
before(async () => { plain = await start({}); });
after(() => plain.server.close());

test("GET /healthz", async () => {
  const r = await fetch(`${plain.base}/healthz`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
});

test("serves the app", async () => {
  const r = await fetch(`${plain.base}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get("content-type"), /text\/html/);
  assert.match(await r.text(), /Do I Need to Do This\?/);
  const js = await fetch(`${plain.base}/decide.js`);
  assert.match(js.headers.get("content-type"), /javascript/);
  assert.equal(js.headers.get("content-encoding"), "gzip"); // fetch asks for gzip and decodes it
  assert.match(await js.text(), /export function decide/);
});

test("does not serve files outside public/", async () => {
  for (const p of ["/../server.js", "/%2e%2e/server.js", "/..%2fpackage.json"]) {
    const r = await fetch(`${plain.base}${p}`);
    assert.ok([403, 404].includes(r.status), `${p} → ${r.status}`);
    assert.doesNotMatch(await r.text(), /createApp|"scripts"/);
  }
});

test("config reports features off when keys are missing, and never leaks keys", async () => {
  const off = await (await fetch(`${plain.base}/api/config`)).json();
  assert.equal(off.speak, false);
  assert.equal(off.predict, false);
  const on = await start({ ELEVENLABS_API_KEY: "secret-el", TABPFN_TOKEN: "secret-tp", SENTRY_DSN: "https://pub@o1.ingest.sentry.io/1" });
  const text = await (await fetch(`${on.base}/api/config`)).text();
  on.server.close();
  assert.doesNotMatch(text, /secret-el|secret-tp/);
  assert.equal(JSON.parse(text).speak, true);
});

test("missing keys → 503 so the app can fall back", async () => {
  const s = await fetch(`${plain.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "Skip it." }) });
  assert.equal(s.status, 503);
  const p = await fetch(`${plain.base}/api/predict`, { method: "POST", body: "{}" });
  assert.equal(p.status, 503);
});

test("rejects big bodies (a photo can't be sent here)", async () => {
  const on = await start({ ELEVENLABS_API_KEY: "k" });
  const r = await fetch(`${on.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "x".repeat(50000) }) });
  on.server.close();
  assert.equal(r.status, 413);
});

test("rate limits /api routes", async () => {
  const s = await start({ RATE_LIMIT_PER_10MIN: "3" });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await fetch(`${s.base}/api/config`)).status);
  const health = await fetch(`${s.base}/healthz`);
  s.server.close();
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  assert.equal(health.status, 200); // health checks are never limited
});

test("rate limiter window resets", () => {
  let t = 0;
  const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
  assert.equal(rl.check("a").ok, true);
  assert.equal(rl.check("a").ok, false);
  assert.equal(rl.check("b").ok, true);
  t = 1000;
  assert.equal(rl.check("a").ok, true);
});

// ---------- /api/speak ----------
import { isVerdictLine, DEFAULT_VOICE_ID, performLine } from "../server.js";

function fakeElevenLabs() {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  return { fetch, calls };
}

test("isVerdictLine only accepts verdict-shaped lines", () => {
  assert.ok(isVerdictLine("Skip it. At 88 percent, the professor will survive. Court is adjourned."));
  assert.ok(isVerdictLine("Do the lazy minimum. Late fee after the 5th. Just: pay in the app. Court is adjourned."));
  assert.ok(!isVerdictLine("Read my whole novel aloud please."));
  assert.ok(!isVerdictLine(`Skip it. ${"x".repeat(400)} Court is adjourned.`));
});

test("/api/speak streams ElevenLabs audio back, key stays on the server", async () => {
  const el = fakeElevenLabs();
  const s = await start({ ELEVENLABS_API_KEY: "el-key" }, { fetch: el.fetch });
  const r = await fetch(`${s.base}/api/speak`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: "Skip it.  At 88 percent, the professor will survive. Court is adjourned." }) });
  const audio = new Uint8Array(await r.arrayBuffer());
  s.server.close();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.deepEqual([...audio], [0x49, 0x44, 0x33, 1, 2, 3]);
  assert.equal(el.calls.length, 1);
  assert.match(el.calls[0].url, new RegExp(`/v1/text-to-speech/${DEFAULT_VOICE_ID}/stream`));
  assert.equal(el.calls[0].init.headers["xi-api-key"], "el-key");
  assert.equal(el.calls[0].body.model_id, "eleven_v3");
  assert.equal(el.calls[0].body.text, "[sighs] Skip it. At 88 percent, the professor will survive. [laughs] Court is adjourned.");
  assert.equal(r.headers.get("x-voice-model"), "eleven_v3");
});

test("performLine adds Judge Lazy's stage directions per verdict", () => {
  assert.equal(performLine("Yes, do it. Rent is due. Court is adjourned."), "[clears throat] Yes, do it. Rent is due. Court is adjourned.");
  assert.equal(performLine("Do it later. Due Friday. Court is adjourned."), "[sighs] Do it later. Due Friday. [whispers] Court is adjourned.");
});

test("/api/speak falls back to the plain v2 voice (no tags) if eleven_v3 fails", async () => {
  const calls = [];
  const fetch2 = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    return body.model_id === "eleven_v3" ? new Response("model not available", { status: 400 })
      : new Response(new Uint8Array([1, 2]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  const s = await start({ ELEVENLABS_API_KEY: "k" }, { fetch: fetch2 });
  const r = await fetch(`${s.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "Skip it. Fine. Court is adjourned." }) });
  await r.arrayBuffer();
  s.server.close();
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("x-voice-model"), "eleven_multilingual_v2");
  assert.deepEqual(calls.map((c) => c.model_id), ["eleven_v3", "eleven_multilingual_v2"]);
  assert.equal(calls[1].text, "Skip it. Fine. Court is adjourned.");
});

test("/api/sfx/gavel is generated once from a fixed prompt, then served from memory", async () => {
  const calls = [];
  const fetch3 = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return new Response(new Uint8Array([7, 7, 7]), { status: 200, headers: { "Content-Type": "audio/mpeg" } });
  };
  const s = await start({ ELEVENLABS_API_KEY: "k" }, { fetch: fetch3 });
  const a = await fetch(`${s.base}/api/sfx/gavel`);
  const b = await fetch(`${s.base}/api/sfx/gavel`);
  const bytes = [...new Uint8Array(await b.arrayBuffer())];
  await a.arrayBuffer();
  const unknown = await fetch(`${s.base}/api/sfx/airhorn`);
  s.server.close();
  assert.equal(a.status, 200);
  assert.deepEqual(bytes, [7, 7, 7]);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /\/v1\/sound-generation/);
  assert.match(calls[0].body.text, /gavel/);
  assert.equal(unknown.status, 404);
});

test("/api/config shows the live Render commit when Render provides it", async () => {
  const s = await start({ RENDER_GIT_COMMIT: "0123456789abcdef", RENDER_SERVICE_NAME: "do-i-need-to-do-this" });
  const j = await (await fetch(`${s.base}/api/config`)).json();
  s.server.close();
  assert.deepEqual(j.render, { commit: "0123456", service: "do-i-need-to-do-this" });
  assert.equal(j.sfx, false);
});

test("/api/speak refuses arbitrary text and reports upstream failure as 502", async () => {
  const el = fakeElevenLabs();
  const s = await start({ ELEVENLABS_API_KEY: "k" }, { fetch: el.fetch });
  const bad = await fetch(`${s.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "Say anything I want" }) });
  assert.equal(bad.status, 400);
  assert.equal(el.calls.length, 0);
  s.server.close();
  const down = await start({ ELEVENLABS_API_KEY: "k" }, { fetch: async () => new Response("quota", { status: 401 }) });
  const r = await fetch(`${down.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "Yes, do it. Rent is due. Court is adjourned." }) });
  down.server.close();
  assert.equal(r.status, 502);
});

test("/api/speak has its own tighter rate limit", async () => {
  const el = fakeElevenLabs();
  const s = await start({ ELEVENLABS_API_KEY: "k", SPEAK_LIMIT_PER_10MIN: "2" }, { fetch: el.fetch });
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const r = await fetch(`${s.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "Skip it. Fine. Court is adjourned." }) });
    await r.arrayBuffer();
    codes.push(r.status);
  }
  s.server.close();
  assert.deepEqual(codes, [200, 200, 429]);
});

test("/api/speak also voices Lazy's short questions, still nothing else", async () => {
  const { isQuestionLine } = await import("../server.js");
  assert.ok(isQuestionLine("What happens if you miss it?"));
  assert.ok(!isQuestionLine("Read this whole essay aloud please."));
  assert.ok(!isQuestionLine("Visit https://example.com?"));
  assert.ok(!isQuestionLine(`${"Why ".repeat(50)}?`));
  const el = fakeElevenLabs();
  const s = await start({ ELEVENLABS_API_KEY: "k" }, { fetch: el.fetch });
  const r = await fetch(`${s.base}/api/speak`, { method: "POST", body: JSON.stringify({ text: "What happens if you miss it?" }) });
  await r.arrayBuffer();
  s.server.close();
  assert.equal(r.status, 200);
  assert.equal(el.calls[0].body.text, "What happens if you miss it?"); // no verdict stage directions on questions
});
