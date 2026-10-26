// Run the real pipeline against local Ollama from the terminal.
//   node scripts/try-gemma.mjs "Pay the electricity bill" ["context"] [photo.png] [--answer=N]
// Questions are answered automatically with option N (default 0) so the run is non-interactive.
import { readFile } from "node:fs/promises";
import { askQuestions, describePhoto, extractFacts, photoNotesText, DEFAULT_MODEL } from "../public/gemma.js";
import { decide, localISODate, verdictLine } from "../public/decide.js";

const args = process.argv.slice(2);
const pick = Number((args.find((a) => a.startsWith("--answer=")) || "--answer=0").split("=")[1]);
const [task, context = "", photo] = args.filter((a) => !a.startsWith("--"));
if (!task) { console.error("usage: node scripts/try-gemma.mjs <task> [context] [photo]"); process.exit(1); }

const today = localISODate();
const profile = process.env.PROFILE || "";
// DEBUG=1 prints every raw model reply.
const debugFetch = async (url, init) => {
  const res = await fetch(url, init);
  if (!process.env.DEBUG) return res;
  const j = await res.json();
  console.log("  [raw]", j.message?.content);
  return { ok: res.ok, status: res.status, json: async () => j, text: async () => JSON.stringify(j) };
};
const opts = { model: process.env.MODEL || DEFAULT_MODEL, fetchImpl: debugFetch, onError: (e) => console.warn("  ⚠", e.message) };
const total = { ms: 0 };
const log = (label, r) => { total.ms += r.stats.wall_ms; console.log(`\n== ${label} (${(r.stats.wall_ms / 1000).toFixed(1)} s, attempts ${r.stats.attempts}, tokens ${r.stats.prompt_tokens}→${r.stats.output_tokens})`); };

let photoNotes = "";
if (photo) {
  const r = await describePhoto({ ...opts, task, today, imageBase64: (await readFile(photo)).toString("base64") });
  log("photo", r);
  photoNotes = photoNotesText(r.data);
  console.log(photoNotes);
}
const q = await askQuestions({ ...opts, task, context, photoNotes, profile, today });
log("questions", q);
const answers = q.data.map((x) => ({ question: x.question, answer: x.options[Math.min(pick, x.options.length - 1)] }));
for (const a of answers) console.log(`Q: ${a.question}\n   options: ${q.data.find((x) => x.question === a.question).options.join(" | ")}\n   → ${a.answer}`);
const f = await extractFacts({ ...opts, task, context, photoNotes, profile, today, answers });
log("facts", f);
console.log(f.data);
for (const n of f.data.notes) console.log("  note:", n);
const v = decide(f.data.facts, today);
console.log(`\n${v.emoji} ${v.label} [${v.rule}]${v.safety_override ? " (safety override)" : ""}\n${v.reason}${v.by_when ? `\nBy: ${v.by_when}` : ""}`);
console.log(`Voice: ${verdictLine(v)}\nGemma total: ${(total.ms / 1000).toFixed(1)} s`);
