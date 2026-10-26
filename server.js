// server.js — tiny Node 20 server for Render. No dependencies.
// Serves public/ and a few /api routes. It never receives photos or raw task text:
// only the short verdict line (/api/speak) and numeric/categorical features (/api/predict).
// Secrets come from environment variables (Render dashboard), never from the browser.

import http from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize, sep, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { gzipSync } from "node:zlib";
import { VERDICTS } from "./public/decide.js";
import { MAX_ROWS, MIN_LABELLED_ROWS, validFeatureRow, validTrainingRow } from "./public/features.js";
import { predictPersonalVerdict } from "./tabpfn.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "public");
const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8",
};
const MAX_BODY = 16 * 1024; // small on purpose: a photo can't fit through here
const gzipped = new Map();  // "file:size" → gzipped bytes

// ---------- rate limiting: fixed window per IP and route group, in memory ----------
export function createRateLimiter({ limit, windowMs, now = Date.now }) {
  const hits = new Map();
  return {
    check(key) {
      const t = now();
      let h = hits.get(key);
      if (!h || t >= h.reset) { h = { count: 0, reset: t + windowMs }; hits.set(key, h); }
      h.count++;
      if (hits.size > 10000) for (const [k, v] of hits) if (t >= v.reset) hits.delete(k);
      return { ok: h.count <= limit, retryAfter: Math.ceil((h.reset - t) / 1000) };
    },
  };
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket.remoteAddress || "?";
}

function send(res, status, body, headers = {}) {
  const isJSON = typeof body === "object" && !Buffer.isBuffer(body);
  res.writeHead(status, { "Content-Type": isJSON ? "application/json" : "text/plain; charset=utf-8", ...headers });
  res.end(isJSON ? JSON.stringify(body) : body);
}

export async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Request too large"), { status: 413 });
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); }
  catch { throw Object.assign(new Error("Invalid JSON"), { status: 400 }); }
}

async function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel.endsWith("/")) rel += "index.html";
  const file = normalize(join(ROOT, rel));
  if (file !== ROOT && !file.startsWith(ROOT + sep)) return send(res, 403, "Forbidden");
  try {
    let data = await readFile(file);
    const type = MIME[extname(file)] || "application/octet-stream";
    const headers = {
      "Content-Type": type,
      // always revalidate: the files are small, and a half-updated set of ES modules would break the app after a deploy
      "Cache-Control": "no-cache",
      Vary: "Accept-Encoding",
    };
    // gzip text files (app.js, style.css…) once and keep them; it roughly quarters what the phone downloads
    if (/^(text\/|application\/json|image\/svg)/.test(type) && data.length > 1024 && /\bgzip\b/.test(req.headers["accept-encoding"] || "")) {
      const key = `${file}:${data.length}`;
      if (!gzipped.has(key)) gzipped.set(key, gzipSync(data));
      data = gzipped.get(key);
      headers["Content-Encoding"] = "gzip";
    }
    res.writeHead(200, headers);
    res.end(req.method === "HEAD" ? undefined : data);
  } catch {
    send(res, 404, "Not found");
  }
}

/**
 * Build the request handler. `env` holds the secrets; `deps` lets tests inject fetch.
 * Each /api feature is optional: without its key it answers 503 and the frontend hides it.
 */
export function createApp(env = process.env, deps = {}) {
  const fetchImpl = deps.fetch || globalThis.fetch;
  const sfxCache = new Map(); // name → Promise<Buffer>: each sound effect is generated once per server process
  const limiters = {
    api: createRateLimiter({ limit: Number(env.RATE_LIMIT_PER_10MIN || 60), windowMs: 10 * 60 * 1000 }),
    // each voice line costs ElevenLabs credits, so it gets a tighter limit
    speak: createRateLimiter({ limit: Number(env.SPEAK_LIMIT_PER_10MIN || 20), windowMs: 10 * 60 * 1000 }),
  };
  const routes = {
    "GET /api/config": async () => ({
      speak: Boolean(env.ELEVENLABS_API_KEY),
      sfx: Boolean(env.ELEVENLABS_API_KEY),
      predict: Boolean(env.TABPFN_TOKEN),
      sentryDsn: env.SENTRY_DSN || "",
      sentryEnvironment: env.SENTRY_ENVIRONMENT || (env.RENDER ? "render" : "local"),
      // Render sets these on every deploy; shown in the footer so you can tell which commit is live.
      render: env.RENDER_GIT_COMMIT ? { commit: env.RENDER_GIT_COMMIT.slice(0, 7), service: env.RENDER_SERVICE_NAME || "" } : null,
    }),
    "POST /api/speak": async (req, res) => speak(req, res, env, fetchImpl),
    ...Object.fromEntries(Object.keys(SFX).map((name) =>
      [`GET /api/sfx/${name}`, async (req, res) => soundEffect(name, res, env, fetchImpl, sfxCache)])),
    "POST /api/predict": async (req, res) => predict(req, res, env, fetchImpl),
  };

  return async function handler(req, res) {
    const url = new URL(req.url, "http://x");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      if (url.pathname === "/healthz") return send(res, 200, { ok: true });
      if (url.pathname.startsWith("/api/")) {
        const rl = limiters.api.check(clientIp(req));
        if (!rl.ok) return send(res, 429, { error: "Too many requests. Try again later." }, { "Retry-After": String(rl.retryAfter) });
        if (url.pathname === "/api/speak") {
          const sl = limiters.speak.check(clientIp(req));
          if (!sl.ok) return send(res, 429, { error: "The judge needs a break. Try again later." }, { "Retry-After": String(sl.retryAfter) });
        }
        const route = routes[`${req.method} ${url.pathname}`];
        if (!route) return send(res, 404, { error: "Not found" });
        const out = await route(req, res);
        if (out !== undefined && !res.headersSent) send(res, 200, out);
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");
      return serveStatic(req, res, url.pathname);
    } catch (err) {
      if (!res.headersSent) send(res, err.status || 500, { error: err.status ? err.message : "Server error" });
      if (!err.status) console.error(err);
    }
  };
}

// ---------- /api/speak: ElevenLabs text-to-speech for the one-line verdict ----------
export const DEFAULT_VOICE_ID = "onwK4e9ZLuTAKqWW03F9"; // "Daniel": deep, authoritative British voice from the premade library
const VERDICT_LABELS = Object.values(VERDICTS).map((v) => v.label);

/** Only verdict lines get voiced ("Skip it. … Court is adjourned."), so this can't be used as a free TTS proxy. */
export function isVerdictLine(text) {
  return typeof text === "string" && text.length <= 300 &&
    VERDICT_LABELS.some((l) => text.startsWith(`${l}.`)) && text.endsWith("Court is adjourned.");
}

export const V3 = "eleven_v3", V2 = "eleven_multilingual_v2";

/**
 * Judge Lazy's stage directions: eleven_v3 audio tags, added here on the server (never taken from the client).
 * "Skip it. At 88 percent… Court is adjourned." → "[sighs] Skip it. At 88 percent… [laughs] Court is adjourned."
 */
const PERFORMANCE = {
  skip: ["[sighs]", "[laughs]"], lazy: ["[clears throat]", ""], later: ["[sighs]", "[whispers]"],
  yes: ["[clears throat]", ""], unsure: ["[sighs]", ""],
};
export function performLine(line) {
  const key = Object.keys(VERDICTS).find((k) => line.startsWith(`${VERDICTS[k].label}.`));
  const [open, close] = PERFORMANCE[key] || ["", ""];
  return `${open} ${line.replace(/ Court is adjourned\.$/, "")} ${close} Court is adjourned.`.replace(/\s+/g, " ").trim();
}

/** Lazy's follow-up questions ("What happens if you miss it?"): short, one sentence, ending in "?", no links. */
export function isQuestionLine(text) {
  return typeof text === "string" && text.length >= 5 && text.length <= 140 && /\?$/.test(text) &&
    !/https?:|www\.|[<>{}]/i.test(text) && (text.match(/[.?!]/g) || []).length <= 2;
}

async function speak(req, res, env, fetchImpl) {
  if (!env.ELEVENLABS_API_KEY) return send(res, 503, { error: "Voice is not configured on this server." });
  const { text } = await readJSON(req);
  const line = typeof text === "string" ? text.replace(/\s+/g, " ").trim() : "";
  const question = isQuestionLine(line);
  if (!isVerdictLine(line) && !question) return send(res, 400, { error: "Only verdict lines and short questions can be spoken." });
  const voice = encodeURIComponent(env.ELEVENLABS_VOICE_ID || DEFAULT_VOICE_ID);
  const tts = (model) => fetchImpl(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/stream?output_format=mp3_44100_128`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
    body: JSON.stringify(model === V3
      // v3 performs the audio tags; "natural" stability keeps the judge recognisable
      ? { text: question ? line : performLine(line), model_id: V3, voice_settings: { stability: 0.5 } }
      // older models would read the tags aloud, so they get the plain line with theatrical settings
      : { text: line, model_id: model, voice_settings: { stability: 0.3, similarity_boost: 0.8, style: 0.65, use_speaker_boost: true } }),
  });
  let model = env.ELEVENLABS_MODEL_ID || V3;
  let upstream = await tts(model);
  if (!upstream.ok && model === V3 && ![401, 429].includes(upstream.status)) {
    console.warn(`ElevenLabs ${V3} failed (${upstream.status}); falling back to ${V2}`);
    await upstream.text().catch(() => "");
    model = V2;
    upstream = await tts(model);
  }
  if (!upstream.ok || !upstream.body) {
    console.error(`ElevenLabs error ${upstream.status}: ${(await upstream.text().catch(() => "")).slice(0, 300)}`);
    return send(res, 502, { error: "The voice service didn't answer." });
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Voice-Model": model });
  await pipeline(Readable.fromWeb(upstream.body), res);
}

// ---------- /api/sfx/:name: ElevenLabs sound effects from fixed prompts (no user data involved) ----------
export const SFX = {
  gavel: { text: "Two sharp wooden judge's gavel strikes on a sound block in a quiet courtroom, short natural echo", seconds: 1.5 },
  snore: { text: "One soft, cute cartoon snore from a sleepy little character dozing on a couch, gentle and funny", seconds: 2 },
};

async function soundEffect(name, res, env, fetchImpl, cache) {
  if (!env.ELEVENLABS_API_KEY) return send(res, 503, { error: "Sound effects are not configured on this server." });
  if (!cache.has(name)) {
    cache.set(name, (async () => {
      const r = await fetchImpl("https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128", {
        method: "POST",
        headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text: SFX[name].text, duration_seconds: SFX[name].seconds, prompt_influence: 0.6 }),
      });
      if (!r.ok) throw new Error(`ElevenLabs sound-generation ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`);
      return Buffer.from(await r.arrayBuffer());
    })().catch((e) => { cache.delete(name); throw e; }));
  }
  let audio;
  try { audio = await cache.get(name); } catch (e) {
    console.error(e.message);
    return send(res, 502, { error: "The sound effect service didn't answer." });
  }
  res.writeHead(200, { "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400", "Content-Length": audio.length });
  res.end(audio);
}

// ---------- /api/predict: TabPFN learns the user's own verdicts from their labelled history ----------
// Body: { rows: [[category, consequence, days|null, 0/1, 0/1, minutes, label], ...], query: [same six features] }.
// Every value is checked against the fixed enums/types, so no free text can reach this route or TabPFN.
async function predict(req, res, env, fetchImpl) {
  if (!env.TABPFN_TOKEN) return send(res, 503, { error: "Personal predictions are not configured on this server." });
  const { rows, query } = await readJSON(req);
  if (!Array.isArray(rows) || rows.length > MAX_ROWS || !rows.every(validTrainingRow) || !validFeatureRow(query)) {
    return send(res, 400, { error: "Only the six numeric/categorical features and your own verdict labels are accepted." });
  }
  if (rows.length < MIN_LABELLED_ROWS) return send(res, 422, { error: `Need at least ${MIN_LABELLED_ROWS} labelled verdicts.` });
  if (new Set(rows.map((r) => r.at(-1))).size < 2) return send(res, 422, { error: "All your past choices are the same; nothing to learn yet." });
  try {
    const out = await predictPersonalVerdict({ rows, query, token: env.TABPFN_TOKEN, fetchImpl });
    return { ...out, rows: rows.length };
  } catch (e) {
    console.error(e.message);
    return send(res, e.status === 429 ? 429 : 502, { error: "The prediction service didn't answer." });
  }
}

// Start only when run directly (`node server.js`), not when imported by tests.
if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  // Local development: secrets can live in a git-ignored .env next to this file (see .env.example).
  // On Render they come from the dashboard instead; real environment variables always win.
  const envFile = join(dirname(fileURLToPath(import.meta.url)), ".env");
  if (existsSync(envFile) && typeof process.loadEnvFile === "function") process.loadEnvFile(envFile);
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp()).listen(port, () => {
    const on = ["ELEVENLABS_API_KEY", "SENTRY_DSN", "TABPFN_TOKEN"].map((k) => `${k}=${process.env[k] ? "set" : "missing"}`);
    console.log(`Listening on http://localhost:${port}  (${on.join(", ")})`);
  });
}
