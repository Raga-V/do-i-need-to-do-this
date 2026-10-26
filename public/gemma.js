// gemma.js — talks to Gemma 3 through Ollama on the user's own machine.
// Gemma does two jobs only: decide what to ask, and extract facts as JSON.
// The verdict itself comes from decide.js. Works in the browser and in Node 20 (global fetch).

import { CATEGORIES, CATEGORY_LABELS, CONSEQUENCES, PROTECTED, addDays, normalizeFacts, safetyCategory } from "./decide.js";
import { groundedIn } from "./memory.js";
import { DAYS, TYPES, cleanTimetable, parseGrid } from "./timetable.js";

// 127.0.0.1, not "localhost": a Docker/WSL service on [::]:11434 can otherwise answer instead of the real Ollama.
export const DEFAULT_HOST = "http://127.0.0.1:11434";
export const DEFAULT_MODEL = "gemma3:4b";
export const MAX_QUESTIONS = 3;

const ASKABLE = ["deadline", "if_skipped", "consequence", "affects_others", "can_be_undone_later", "effort_minutes", "lazy_minimum"];

// ---------- JSON schemas passed to Ollama's `format` ----------

export const PHOTO_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["timetable", "notice", "screenshot", "bill", "message", "other"] },
    readable: { type: "boolean" },
    visible_text: { type: "string" },
    unreadable_parts: { type: "string" },
  },
  required: ["kind", "readable", "visible_text", "unreadable_parts"],
};

export const QUESTIONS_SCHEMA = {
  type: "object",
  properties: {
    // Each "already answered" claim must quote the user's own words; code checks the quote is really there.
    answered_by_context: {
      type: "array",
      items: {
        type: "object",
        properties: { about: { type: "string", enum: ASKABLE }, quote: { type: "string" } },
        required: ["about", "quote"],
      },
    },
    questions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          about: { type: "string", enum: ASKABLE },
          question: { type: "string" },
          options: { type: "array", items: { type: "string" } },
        },
        required: ["about", "question", "options"],
      },
    },
  },
  required: ["answered_by_context", "questions"],
};

export const FACTS_SCHEMA = {
  type: "object",
  properties: {
    working: { type: "string" }, // generated first: the key numbers/facts, so the fields below follow from them
    category: { type: "string", enum: CATEGORIES },
    deadline: { type: "string" },
    if_skipped: { type: "string" },
    consequence: { type: "string", enum: CONSEQUENCES },
    affects_others: { type: "boolean" },
    can_be_undone_later: { type: "boolean" },
    effort_minutes: { type: "integer" },
    lazy_minimum: { type: "string" },
    lazy_minimum_minutes: { type: "integer" },
    confidence: { type: "number" },
    one_line_reason: { type: "string" },
  },
  required: ["working", "category", "deadline", "if_skipped", "consequence", "affects_others", "can_be_undone_later",
    "effort_minutes", "lazy_minimum", "lazy_minimum_minutes", "confidence", "one_line_reason"],
};

// ---------- parsing & validation (pure, unit-tested) ----------

/** Parse model output as a JSON object, tolerating ``` fences or chatter around it. Throws on failure. */
export function parseModelJSON(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("empty reply");
  let s = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(s); } catch { /* fall through */ }
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
  throw new Error("no JSON object in reply");
}

/** Does free text pin down a date or day? Used to drop redundant deadline questions and to reject invented deadlines. */
export function mentionsDate(text) {
  return /\b(today|tonight|tomorrow|tmrw|day after|yesterday|next (week|month)|(this|next) (week|weekend|month)|end of (the )?(day|week|month)|(with)?in (a|\d+) (days?|weeks?|months?)|(mon|tues|wednes|thurs|fri|satur|sun)day|\d{4}-\d{2}-\d{2}|\d{1,2}[/.-]\d{1,2}([/.-]\d{2,4})?|\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+\d{1,2}(st|nd|rd|th)?)\b/i
    .test(text || "");
}

/**
 * Clean the question list: valid shape, 2–4 tap options, no duplicates,
 * nothing the context already answers, at most 3.
 */
/** Gemma sometimes writes Markdown emphasis ("What if you *don't* reply?"); it's shown and spoken, so strip it. */
const plain = (s) => s.replace(/(\*\*|\*|__|_)(\S(?:.*?\S)?)\1/g, "$2").replace(/[*`]/g, "").trim();

export function cleanQuestions(raw, knownText = "", dateText = knownText) {
  if (!raw || !Array.isArray(raw.questions)) throw new Error("missing questions array");
  const known = squash(knownText);
  const answered = new Set();
  for (const a of Array.isArray(raw.answered_by_context) ? raw.answered_by_context : []) {
    // Only believe "already answered" when the quoted words really are in what the user gave us.
    const quote = squash(a?.quote);
    if (!ASKABLE.includes(a?.about) || quote.length < 3 || !known.includes(quote)) continue;
    if (a.about === "deadline" && !mentionsDate(quote)) continue;
    answered.add(a.about);
  }
  // the saved timetable is in knownText (Gemma may quote it), but it doesn't by itself answer every task's deadline
  if (mentionsDate(dateText)) answered.add("deadline");
  const seenAbout = new Set(), seenText = new Set(), out = [];
  for (const q of raw.questions) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) continue;
    const about = ASKABLE.includes(q.about) ? q.about : "other";
    const text = plain(q.question).slice(0, 140);
    if (answered.has(about) || seenText.has(text.toLowerCase())) continue;
    if (about !== "other" && seenAbout.has(about)) continue;
    const options = [...new Set((Array.isArray(q.options) ? q.options : [])
      .filter((o) => typeof o === "string").map((o) => plain(o).slice(0, 60)).filter(Boolean))]
      .filter((o) => !/^not sure$/i.test(o)).slice(0, 4);
    if (options.length < 2) continue;
    seenAbout.add(about); seenText.add(text.toLowerCase());
    out.push({ about, question: text, options });
    if (out.length === MAX_QUESTIONS) break;
  }
  // The deadline changes the verdict more than anything else; if it's still unknown, make sure it gets asked.
  if (!answered.has("deadline") && !seenAbout.has("deadline")) {
    const ask = { about: "deadline", question: "When does it actually need to be done?",
      options: ["Today", "Tomorrow", "Within a week", "No real deadline"], added_by_app: true };
    if (out.length < MAX_QUESTIONS) out.push(ask); else out[MAX_QUESTIONS - 1] = ask;
  }
  return out;
}

export function cleanPhoto(raw) {
  if (!raw || typeof raw.visible_text !== "string") throw new Error("missing visible_text");
  return {
    kind: typeof raw.kind === "string" ? raw.kind : "other",
    readable: raw.readable !== false,
    visible_text: raw.visible_text.trim().slice(0, 1500),
    unreadable_parts: typeof raw.unreadable_parts === "string" ? raw.unreadable_parts.trim().slice(0, 300) : "",
  };
}

/** Photo description → plain text that later prompts (and the user) can read. */
export function photoNotesText(p) {
  const lines = [`Photo type: ${p.kind}${p.readable ? "" : " (mostly unreadable)"}`];
  if (p.visible_text) lines.push(`Text visible in the photo: ${p.visible_text}`);
  if (p.unreadable_parts && !/^(none|n\/a|nothing)\.?$/i.test(p.unreadable_parts)) lines.push(`Could not read: ${p.unreadable_parts}`);
  return lines.join("\n");
}

function squash(s) {
  return typeof s === "string" ? s.toLowerCase().replace(/[^a-z0-9%]+/g, " ").trim() : "";
}

/**
 * Validate the facts reply and ground it in what the user actually said.
 * Returns { facts, working, notes } — notes explain anything code overrode.
 */
export function cleanFacts(raw, knownText = "", task = "") {
  if (!raw || typeof raw !== "object") throw new Error("not an object");
  const missing = FACTS_SCHEMA.required.filter((k) => k !== "working" && !(k in raw));
  if (missing.length) throw new Error(`missing fields: ${missing.join(", ")}`);
  if (!CONSEQUENCES.includes(String(raw.consequence).toLowerCase())) throw new Error(`bad consequence "${raw.consequence}"`);
  const facts = normalizeFacts(raw);
  const notes = [];
  if (facts.deadline && !mentionsDate(knownText)) {
    notes.push(`Gemma suggested a deadline (${facts.deadline}) that nothing you said mentions, so it was ignored.`);
    facts.deadline = "";
  }
  const forced = safetyCategory(task);
  if (forced && !PROTECTED.has(facts.category)) {
    notes.push(`Gemma filed this under "${CATEGORY_LABELS[facts.category]}", but the task mentions ${CATEGORY_LABELS[forced]}, so the safety rules treat it that way.`);
    facts.category = forced;
  }
  return { facts, working: typeof raw.working === "string" ? raw.working.trim().slice(0, 400) : "", notes };
}

// ---------- the Ollama call, with one retry on malformed JSON ----------

const noTrace = (_step, _attrs, fn) => fn({ setAttribute() {} });

/**
 * POST /api/chat with a JSON schema. If the reply doesn't parse or validate,
 * retry once, telling the model what was wrong. Returns { data, stats }.
 * `trace(step, attrs, fn)` lets the app wrap each call in a tracing span (Sentry); no-op by default.
 */
// Output caps per step: a small model can loop ("Mon | DBMS | Mon | DBMS …") until the context is full,
// which on a laptop ties Ollama up for many minutes. A capped reply that gets cut off fails JSON parsing and is retried.
export const MAX_TOKENS = { photo: 700, questions: 700, facts: 700, memory: 250, timetable_photo: 1500, timetable: 3500, plan: 3000 };

export async function chatJSON({ host = DEFAULT_HOST, model = DEFAULT_MODEL, messages, schema, clean, step,
  fetchImpl = globalThis.fetch, trace = noTrace, onError = () => {}, signal }) {
  const stats = { step, attempts: 0, wall_ms: 0, load_ms: 0, eval_ms: 0, prompt_tokens: 0, output_tokens: 0 };
  let convo = messages, lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    stats.attempts = attempt;
    const t0 = Date.now();
    const reply = await trace(step, { model, attempt }, async (span) => {
      let res;
      try {
        res = await fetchImpl(`${host.replace(/\/$/, "")}/api/chat`, {
          method: "POST", headers: { "Content-Type": "application/json" }, signal,
          body: JSON.stringify({ model, messages: convo, format: schema, stream: false, keep_alive: "30m",
            options: { temperature: attempt === 1 ? 0.2 : 0, num_predict: MAX_TOKENS[step] || 1000 } }),
        });
      } catch (e) {
        if (e.name === "AbortError") throw e;
        const why = e.cause?.code || e.cause?.message || e.message;
        throw new OllamaError(`Couldn't reach Ollama at ${host} (${why}). Is it running?`, "unreachable");
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        if (res.status === 404 && /model/i.test(body)) throw new OllamaError(`Model "${model}" isn't installed. Run: ollama pull ${model}`, "no_model");
        if (res.status === 403) throw new OllamaError("Ollama refused this page's origin. Set OLLAMA_ORIGINS (see AI setup).", "cors");
        throw new OllamaError(`Ollama error ${res.status}: ${body.slice(0, 200)}`, "http");
      }
      const j = await res.json();
      span.setAttribute("gen_ai.usage.input_tokens", j.prompt_eval_count || 0);
      span.setAttribute("gen_ai.usage.output_tokens", j.eval_count || 0);
      span.setAttribute("gen_ai.usage.total_tokens", (j.prompt_eval_count || 0) + (j.eval_count || 0));
      span.setAttribute("gen_ai.response.model", j.model || model);
      span.setAttribute("ollama.load_ms", Math.round((j.load_duration || 0) / 1e6));
      span.setAttribute("ollama.total_ms", Math.round((j.total_duration || 0) / 1e6));
      span.setAttribute("ollama.eval_ms", Math.round((j.eval_duration || 0) / 1e6));
      return j;
    });
    stats.wall_ms += Date.now() - t0;
    stats.load_ms += Math.round((reply.load_duration || 0) / 1e6);
    stats.eval_ms += Math.round((reply.eval_duration || 0) / 1e6);
    stats.prompt_tokens += reply.prompt_eval_count || 0;
    stats.output_tokens += reply.eval_count || 0;
    const content = reply.message?.content ?? "";
    try {
      return { data: clean(parseModelJSON(content)), stats };
    } catch (e) {
      lastErr = e;
      onError(new Error(`Gemma ${step}: malformed JSON on attempt ${attempt}: ${e.message}`), { step, attempt, content: content.slice(0, 500) });
      convo = [...messages,
        { role: "assistant", content: content.slice(0, 2000) },
        { role: "user", content: `That reply was not valid (${e.message}). Reply again with ONLY the JSON object matching the schema.` }];
    }
  }
  throw new OllamaError(`Gemma's ${step} reply wasn't valid JSON twice (${lastErr.message}).`, "bad_json");
}

export class OllamaError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

// ---------- prompts ----------

function weekday(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
}

// A 4B model uses whatever background it's given ("your attendance is high, so skip the laundry").
// So only profile sentences on the same topic as the task reach the prompt; sentences with no topic always do.
const TOPICS = {
  study: /\b(lectures?|class(es)?|attendance|exams?|tests?|quiz|assignments?|homework|professor|prof|college|school|uni(versity)?|labs?|course|semester|marks|grades?|tutorials?|seminars?|viva)\b/i,
  money: /\b(bills?|rent|pay(ment)?s?|salary|bank|loans?|emi|fees?|cards?|budget|money|tax(es)?|electricity|subscriptions?|auto-?debit(ed)?)\b/i,
  work: /\b(work|office|manager|boss|meetings?|clients?|shifts?|job|colleagues?|standup|team|async)\b/i,
  health: /\b(doctor|dentist|gym|medicine|meds|health|workout|diet|therapy|appointments?)\b/i,
  social: /\b(friends?|family|mom|mum|dad|parents?|party|birthday|wedding|chat|reply|messages?|texts?|calls?)\b/i,
};
const topicsOf = (text) => new Set(Object.keys(TOPICS).filter((t) => TOPICS[t].test(text || "")));

export function relevantProfile(profile, taskText) {
  if (!profile) return "";
  const taskTopics = topicsOf(taskText);
  return profile.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).filter((sentence) => {
    const t = topicsOf(sentence);
    return t.size === 0 || [...t].some((x) => taskTopics.has(x));
  }).join(" ");
}

function situation({ task, context, photoNotes, profile, schedule, today }) {
  profile = relevantProfile(profile, [task, context, photoNotes].join(" "));
  return [
    `Today is ${weekday(today)}, ${today}. Tomorrow is ${weekday(addDays(today, 1))}, ${addDays(today, 1)}.`,
    `Task the user is avoiding: ${task}`,
    context ? `Extra context from the user: ${context}` : "",
    photoNotes ? `What their photo shows (already transcribed):\n${photoNotes}` : "",
    profile ? `Background about the user (only relevant if this task is about it): ${profile}` : "",
    schedule ? `Their saved weekly timetable:\n${schedule}` : "",
  ].filter(Boolean).join("\n");
}

export async function describePhoto({ imageBase64, task, today, ...opts }) {
  return chatJSON({
    ...opts, step: "photo", schema: PHOTO_SCHEMA, clean: cleanPhoto,
    messages: [
      { role: "system", content:
        "You transcribe photos. Describe ONLY what is actually visible. Copy dates, times, amounts, room numbers and " +
        "names exactly as written. Never guess or fill in text you cannot read: list it in unreadable_parts instead. " +
        "Do not give advice." },
      { role: "user", content:
        (today ? `Today is ${weekday(today)}, ${today} (so tomorrow is ${weekday(addDays(today, 1))}).\n` : "") +
        `The user is deciding whether to do this task: "${task}".\n` +
        "visible_text: transcribe the text in the image faithfully. For a table, write one line per row " +
        "as `row label | cell | cell` (header row first). Keep it under 60 lines.\n" +
        "If the image is blurry or cut off, set readable to false and say what you couldn't read.",
        images: [imageBase64] },
    ],
  });
}

export async function askQuestions({ task, context, photoNotes, profile, schedule = "", today, ...opts }) {
  const userText = [task, context, photoNotes, profile].filter(Boolean).join("\n");
  const known = [userText, schedule].filter(Boolean).join("\n");
  return chatJSON({
    ...opts, step: "questions", schema: QUESTIONS_SCHEMA, clean: (raw) => cleanQuestions(raw, known, userText),
    messages: [
      { role: "system", content:
        "You help a lazy but sensible person decide whether a task is worth doing. You do NOT give the verdict. " +
        "Your job: find out the few facts that would change the decision — what really happens if they skip it, " +
        "the deadline, whether someone else is let down, and whether a much lazier version exists.\n" +
        "Rules:\n- First, in answered_by_context, list each fact the user's own words already state, with quote = the exact words (copied verbatim) that state it. " +
        "If you can't quote it, it is NOT answered. A task without a date does NOT answer the deadline.\n" +
        "- Ask about different facts; never two questions about the same thing.\n" +
        "- Then ask at most 3 questions about facts that are still unclear, most decision-changing first. Never ask about something already answered.\n" +
        "- Each question: under 12 words, casual. Each has 2–4 short tap-to-answer options (under 6 words each) that cover the realistic answers.\n" +
        "- If everything important is already clear, return an empty questions list." },
      { role: "user", content: situation({ task, context, photoNotes, profile, schedule, today }) },
    ],
  });
}

/**
 * A tapped deadline answer like "Today" or "Within a week" is unambiguous, so code sets the date
 * instead of trusting Gemma's date arithmetic (in testing it turned "Today" into tomorrow's date).
 * Returns "YYYY-MM-DD", "" for "no deadline", or null when the answer isn't one of these phrases.
 */
export function deadlineFromAnswer(answer, today) {
  const a = String(answer || "").trim().toLowerCase().replace(/[.!]$/, "");
  if (/^(today|tonight|by tonight|today itself)$/.test(a)) return today;
  if (/^(tomorrow|by tomorrow|tmrw)$/.test(a)) return addDays(today, 1);
  if (/^(day after tomorrow)$/.test(a)) return addDays(today, 2);
  if (/^(within a week|this week|in a week|by next week|next week)$/.test(a)) return addDays(today, 7);
  if (/^(no real deadline|no deadline|whenever|no rush)$/.test(a)) return "";
  return null;
}

export async function extractFacts({ task, context, photoNotes, profile, schedule = "", today, answers = [], ...opts }) {
  const qa = answers.filter((a) => a.answer).map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n");
  const known = [task, context, photoNotes, profile, schedule, ...answers.map((a) => a.answer)].filter(Boolean).join("\n");
  const tapped = answers.filter((a) => a.about === "deadline").map((a) => deadlineFromAnswer(a.answer, today)).find((d) => d !== null);
  const clean = (raw) => {
    const out = cleanFacts(raw, known, task);
    if (tapped !== undefined && tapped !== out.facts.deadline) {
      out.notes.push(tapped
        ? `You said when it's due, so the deadline is ${tapped}${out.facts.deadline ? ` (Gemma wrote ${out.facts.deadline})` : ""}.`
        : `You said there's no real deadline, so Gemma's date (${out.facts.deadline}) was dropped.`);
      out.facts.deadline = tapped;
    }
    return out;
  };
  return chatJSON({
    ...opts, step: "facts", schema: FACTS_SCHEMA, clean,
    messages: [
      { role: "system", content:
        "You extract facts about a task someone is avoiding. You do NOT decide whether they should do it; " +
        "other code does that from your facts. Use only what the user told you plus common sense. Do not invent details. " +
        "Use the 'About the user' notes only when they matter for this particular task; otherwise ignore them.\n" +
        "Fields:\n" +
        "- working: FIRST, in at most 2 short sentences, note the key facts and do any arithmetic " +
        "(e.g. \"92% now; missing one of ~60 classes leaves ~91%, still above 75%.\").\n" +
        "- category: exam_or_graded (exams, assignments, anything graded), class_or_lecture (ungraded classes), work, money (bills, payments, fees), " +
        "health (doctor, medicine, health checks), legal_or_official (documents, government, legal, visa, ID), social, chores, errand, personal, other.\n" +
        "- deadline: the date it must be done by, as YYYY-MM-DD, worked out from today's date, ONLY if the user, photo or answers give a date or day. Never invent one; otherwise empty string.\n" +
        "- Judge skipping THIS one occurrence (this lecture, this bill, this trip), not giving up the habit forever. " +
        "If the user gives numbers (attendance %, marks, balance, fees), do the arithmetic before judging: e.g. 92% attendance with 75% required leaves room to miss a class.\n" +
        "- if_skipped: one concrete sentence, to the user as \"you\", on what happens if you skip it this time.\n" +
        "- consequence: nothing (nobody would notice), minor (small, easily fixed), annoying (real hassle, cost or awkwardness but recoverable), " +
        "serious (significant money, grades, health, legal or relationship damage), severe (lasting harm, very hard to undo).\n" +
        "- affects_others: true only if another person is let down, blocked or harmed.\n" +
        "- can_be_undone_later: true if skipping now can be fully fixed later at no extra cost.\n" +
        "- effort_minutes: realistic minutes for the full task, including travel.\n" +
        "- lazy_minimum: the smallest action that avoids most of the consequence (e.g. \"Pay it in the bank app\", \"Ask a friend for the notes\"). It must be smaller than the task itself; if the only option is doing the whole task, use an empty string.\n" +
        "- lazy_minimum_minutes: minutes for that minimum (0 if none).\n" +
        "- confidence: 0 to 1, how sure you are of consequence and deadline. Below 0.5 if those are guesses.\n" +
        "- one_line_reason: one short sentence (max 18 words) in the voice of Lazy, a laid-back, witty, kind couch potato, " +
        "said to the user as \"you\" and stating the deciding fact about THIS task " +
        "(mention the background notes only if the task is directly about them; attendance has nothing to do with chores) " +
        "(e.g. \"Your landlord only charges a late fee after the 5th, so the couch is safe till then.\"). " +
        "Never say \"the user\". Don't tell them what to do: the court rules separately." },
      { role: "user", content: situation({ task, context, photoNotes, profile, schedule, today }) + (qa ? `\nThe user's answers:\n${qa}` : "") },
    ],
  });
}

// ---------- "Plan my lazy day": facts for every timetable item today, in one call ----------

const PLAN_FIELDS = ["category", "if_skipped", "consequence", "affects_others", "can_be_undone_later", "effort_minutes",
  "lazy_minimum", "lazy_minimum_minutes", "confidence", "one_line_reason"];
export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: { index: { type: "integer" }, ...Object.fromEntries(PLAN_FIELDS.map((k) => [k, FACTS_SCHEMA.properties[k]])) },
        required: ["index", ...PLAN_FIELDS],
      },
    },
  },
  required: ["items"],
};

/** One facts object per item, in order. Items Gemma skipped get confidence 0, so decide() says "Not sure yet". */
export function cleanPlan(raw, items, today) {
  if (!raw || !Array.isArray(raw.items)) throw new Error("missing items array");
  return items.map((it, i) => {
    const r = raw.items.find((x) => Number(x?.index) === i + 1) || raw.items[i] || { confidence: 0, consequence: "" };
    const facts = normalizeFacts({ ...r, deadline: today }); // these all happen today
    const forced = safetyCategory(it.title);
    if (forced && !PROTECTED.has(facts.category)) facts.category = forced;
    return facts;
  });
}

export async function planDay({ items, profile = "", today, ...opts }) {
  const list = items.map((it, i) => `${i + 1}. ${it.start || "?"}${it.end ? `–${it.end}` : ""} ${it.title} (${it.type})`).join("\n");
  const background = relevantProfile(profile, items.map((it) => `${it.title} ${it.type}`).join(" "));
  return chatJSON({
    ...opts, step: "plan", schema: PLAN_SCHEMA, clean: (raw) => cleanPlan(raw, items, today),
    messages: [
      { role: "system", content:
        "For each item on someone's timetable today, write down the facts about skipping THIS one occurrence. You do NOT decide what they should do. " +
        "Use the same fields for every item, with index = the item's number. " +
        "consequence: nothing | minor | annoying | serious | severe. category: exam_or_graded, class_or_lecture, work, money, health, legal_or_official, social, chores, errand, personal or other. " +
        "lazy_minimum: the smallest action that avoids most of the consequence (e.g. \"Ask a friend for the notes\"), or an empty string. " +
        "confidence below 0.5 when you're guessing. one_line_reason: max 14 words, to the user as \"you\"." },
      { role: "user", content: [`Today is ${weekday(today)}, ${today}.`, `Today's timetable:\n${list}`,
        background ? `Background about the user: ${background}` : ""].filter(Boolean).join("\n") },
    ],
  });
}

// ---------- "Your timetable": photo or pasted text → weekly entries ----------

export const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: { readable: { type: "boolean" }, transcript: { type: "string" } },
  required: ["readable", "transcript"],
};

export const TIMETABLE_SCHEMA = {
  type: "object",
  properties: {
    entries: {
      type: "array",
      items: {
        type: "object",
        properties: {
          day: { type: "string", enum: DAYS },
          start: { type: "string" },
          end: { type: "string" },
          title: { type: "string" },
          type: { type: "string", enum: TYPES },
          confident: { type: "boolean" },
        },
        required: ["day", "start", "end", "title", "type", "confident"],
      },
    },
  },
  required: ["entries"],
};

/**
 * Read a weekly timetable. A photo is first transcribed row by row (what a 4B model does reliably),
 * then that text is turned into entries; pasted text skips the first step.
 * Returns { data: { entries, transcript }, stats: [photo stats?, entries stats] }.
 */
export async function readTimetable({ imageBase64 = "", text = "", ...opts }) {
  const stats = [];
  let transcript = text.trim();
  if (imageBase64) {
    const t = await chatJSON({
      ...opts, step: "timetable_photo", schema: TRANSCRIPT_SCHEMA,
      clean: (raw) => { if (typeof raw?.transcript !== "string" || !raw.transcript.trim()) throw new Error("empty transcript"); return raw; },
      messages: [
        { role: "system", content: "You transcribe photos of timetables. Copy ONLY what is visible, exactly as written. Never guess unreadable text; write [?] instead." },
        { role: "user", content:
          "Transcribe this weekly timetable, one line per table row, as `row label | cell | cell | …`, header row first. " +
          "Keep every time slot and every empty cell (write --). If it is blurry or cut off, set readable to false.", images: [imageBase64] },
      ],
    });
    stats.push(t.stats);
    transcript = t.data.transcript.trim();
  }
  if (!transcript) throw new OllamaError("There's no timetable to read.", "empty");
  // A clean grid (one row per day, time slots across the top) is converted exactly in code, instantly.
  const grid = parseGrid(transcript);
  if (grid) return { data: { entries: grid, transcript, method: "grid" }, stats };
  const e = await chatJSON({
    ...opts, step: "timetable", schema: TIMETABLE_SCHEMA, clean: (raw) => cleanTimetable(raw, transcript),
    messages: [
      { role: "system", content:
        "You turn a weekly timetable into a list of entries. One entry per class, lab, shift or appointment: " +
        "day (full weekday name), start and end as 24-hour HH:MM, title exactly as written, and type (class, lab, work or other). " +
        "If the times are column headers and the days are rows (or the other way round), combine them for each cell. " +
        "Skip empty cells, \"--\", breaks and lunch. Never invent entries. " +
        "Set confident to false when you're unsure about an entry's day, time or title (for example [?], a merged cell, or an AM/PM you can't tell)." },
      { role: "user", content: `Timetable:\n${transcript.slice(0, 6000)}` },
    ],
  });
  stats.push(e.stats);
  return { data: { entries: e.data, transcript, method: "gemma" }, stats };
}

// ---------- "Lazy remembers you": durable facts about the user ----------

export const MEMORY_SCHEMA = {
  type: "object",
  properties: { facts: { type: "array", items: { type: "string" } } },
  required: ["facts"],
};

export function cleanMemoryFacts(raw, userText = "") {
  if (!raw || !Array.isArray(raw.facts)) throw new Error("missing facts array");
  return raw.facts
    .filter((f) => typeof f === "string")
    .map((f) => f.trim().replace(/\s+/g, " ").slice(0, 140))
    .filter((f) => f.length >= 8 && groundedIn(f, userText))
    // a deadline for this one task isn't a lasting fact, even when Gemma phrases it like one
    .filter((f) => !/\b(today|tonight|tomorrow|within a week|this week|next week|right now)\b/i.test(f))
    .map((f) => (/[.!?]$/.test(f) ? f : `${f}.`))
    .slice(0, 3);
}

/** One extra call after a verdict: up to 3 lasting facts from what the user said. */
export async function learnFacts({ task, context = "", answers = [], known = [], ...opts }) {
  const said = answers.filter((a) => a.answer).map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n");
  const userText = [task, context, ...answers.map((a) => a.answer)].join("\n");
  return chatJSON({
    ...opts, step: "memory", schema: MEMORY_SCHEMA, clean: (raw) => cleanMemoryFacts(raw, userText),
    messages: [
      { role: "system", content:
        "You keep a short memory about a user of a to-do app. From what the user said below, extract at most 3 LASTING facts about them: " +
        "things that will still be true next month (rules they live under like an attendance minimum, regular schedules, recurring bills and their dates, " +
        "people who depend on them, standing preferences). " +
        "Ignore one-off details about this particular task (today's lecture, this bill's amount, a specific date, how they feel today). " +
        "Answers about THIS task's deadline (today, tomorrow, within a week) are one-off: never turn them into a fact. " +
        "Each fact: one short sentence, max 15 words, in the user's own words, without \"they\" or \"the user\" " +
        "(e.g. \"College requires 75% attendance.\", \"Landlord charges a late fee after the 5th.\", \"Goes to the gym Mon, Wed and Fri.\"). " +
        "Never repeat a fact that is already known. Never guess. If nothing lasting was said, return an empty list." },
      { role: "user", content: [
        `Task: ${task}`,
        context ? `Extra context: ${context}` : "",
        said ? `Their answers:\n${said}` : "",
        known.length ? `Already known (don't repeat):\n${known.map((k) => `- ${k}`).join("\n")}` : "",
      ].filter(Boolean).join("\n") },
    ],
  });
}

/** Check Ollama is reachable and the model is installed (and whether it can see images). */
export async function checkOllama({ host = DEFAULT_HOST, model = DEFAULT_MODEL, fetchImpl = globalThis.fetch } = {}) {
  let tags;
  try {
    tags = await (await fetchImpl(`${host.replace(/\/$/, "")}/api/tags`)).json();
  } catch {
    return { ok: false, message: `Can't reach Ollama at ${host}.` };
  }
  const names = (tags.models || []).map((m) => m.name);
  const found = (tags.models || []).find((m) => m.name === model || m.name === `${model}:latest`);
  if (!found) return { ok: false, message: `Ollama is running, but "${model}" isn't installed. Run: ollama pull ${model}`, models: names };
  const vision = Array.isArray(found.capabilities) ? found.capabilities.includes("vision") : null;
  return { ok: true, message: `Connected. ${model} is installed${vision === false ? " (no vision support: photos won't work)" : ""}.`, models: names, vision };
}
