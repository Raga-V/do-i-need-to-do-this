// app.js — UI only. Gemma (gemma.js) asks and extracts; decide.js picks the verdict; Lazy (mascot.js) just has feelings.
import { decide, VERDICTS, CATEGORY_LABELS, localISODate, verdictLine, daysUntil, addDays } from "./decide.js";
import { setupSentry } from "./sentry.js";
import { featureRow, trainingRows, MIN_LABELLED_ROWS } from "./features.js";
import { lazy, lazyFace } from "./mascot.js";
import { iconSVG, VERDICT_ICON } from "./icons.js";
import { askQuestions, describePhoto, extractFacts, learnFacts, readTimetable, planDay, photoNotesText, checkOllama, DEFAULT_HOST, DEFAULT_MODEL } from "./gemma.js";
import { DAYS, TYPES, scheduleText, scheduleRelevant, sortEntries, entriesOn } from "./timetable.js";
import { mergeFacts, factsText } from "./memory.js";
import { sfx as synth, setSound, soundOn, VERDICT_SOUND } from "./sounds.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

/** Tiny DOM builder. Strings become text nodes, so model output is never parsed as HTML. */
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false && kid !== "") el.append(kid instanceof Node ? kid : String(kid));
  return el;
}

/** Lazy's SVG comes from fixed strings in mascot.js (never user text), so innerHTML is safe here. */
function showLazy(el, mood, size) { el.innerHTML = lazy(mood, size); }
const MOOD = { skip: "skip", lazy: "min", later: "later", yes: "do", unsure: "unsure" };

/** Fixed SVG strings (icons.js, mascot.js) → an element, for use as an h() child. */
function svgEl(markup) { const t = document.createElement("template"); t.innerHTML = markup; return t.content.firstChild; }
const icon = (name) => svgEl(iconSVG(name));
const face = (mood) => svgEl(lazyFace(mood));
/** An icon (or a small Lazy) followed by a label: verdict chips, plan groups, the payoff pill. */
const withIcon = (name, text) => [icon(name), text];

for (const el of $$("[data-icon]")) el.prepend(icon(el.dataset.icon));
$("#logo-mark").append(svgEl(lazyFace("chill", 30)));
$("#favicon").href = `data:image/svg+xml,${encodeURIComponent(lazyFace("chill", 64))}`;

// ---------- storage (localStorage can throw in private mode; the app still works without it) ----------
const store = {
  get(key, fallback) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* not persisted */ } },
};
const K = { settings: "dintd.settings", profile: "dintd.profile", history: "dintd.history", memory: "dintd.memory", timetable: "dintd.timetable" };
const settings = () => {
  const s = { host: DEFAULT_HOST, model: DEFAULT_MODEL, ...store.get(K.settings, {}) };
  if (/^http:\/\/localhost:11434\/?$/.test(s.host)) s.host = DEFAULT_HOST; // old default; see DEFAULT_HOST
  return s;
};
const history = () => store.get(K.history, []);
const saveHistory = (rows) => store.set(K.history, rows);
const memory = () => store.get(K.memory, []);
const saveMemory = (list) => store.set(K.memory, list);
const timetable = () => store.get(K.timetable, []);
const saveTimetable = (list) => store.set(K.timetable, sortEntries(list));

/** Features that can be switched off without touching the rest (anything not working at the deadline stays off). */
export const FEATURES = { memory: true, timetable: true, plan: true };

/** Background for Gemma: role, notes and what Lazy remembers. gemma.js only passes on sentences on the task's topic. */
function profileText() {
  const p = store.get(K.profile, {});
  return [p.role ? `I'm a ${p.role}.` : "", p.notes || "", FEATURES.memory ? factsText(memory()) : ""].join(" ").trim();
}

/** Extension points for optional server features (Sentry tracing etc.); no-ops by default. */
export const hooks = {
  agent: (_phase, fn) => fn(),
  trace: (_step, _attrs, fn) => fn({ setAttribute() {} }),
  tool: (_name, _input, fn) => fn(),
  span: (_op, _name, _attrs, fn) => fn(),
  annotate: () => {},
  reportError: () => {},
  feedback: () => {},
};

let toastTimer = null;
function toast(message) {
  const t = $("#toast");
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---------- funny sounds (sounds.js, Web Audio, nothing downloaded) ----------
let voiceBusy = false; // true while Lazy's ElevenLabs voice (or gavel) is playing
/** Quiet, optional, never during the voice, never blocking. */
function blip(name) { if (!voiceBusy) synth(name, 0.15); }
document.addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  if (b.matches(".btn.primary")) blip("pop");
  else if (b.matches(".pill, .chip") && !b.closest(".agree")) blip("tap");
});
{
  const btn = $("#sound-toggle");
  const paint = () => {
    const on = soundOn();
    btn.replaceChildren(icon(on ? "volume" : "volume-x"));
    btn.setAttribute("aria-pressed", String(on));
    btn.title = on ? "Sound effects on" : "Sound effects off";
  };
  btn.addEventListener("click", () => { setSound(!soundOn()); paint(); blip("tap"); });
  paint();
}

// ---------- views: the flow, History, Settings ----------
function showView(name) {
  for (const v of $$(".view")) v.hidden = v.id !== `view-${name}`;
  for (const b of $$(".bar-actions [data-view]")) {
    if (b.dataset.view === name) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (name === "history") renderHistory();
  window.scrollTo({ top: 0 });
}
for (const b of $$("[data-view]")) b.addEventListener("click", () => showView(b.dataset.view));

// ---------- the 3-step flow ----------
let run = null;        // the task being judged right now
let controller = null; // aborts the in-flight Gemma call
let photo = null;      // { url, base64 } of the resized photo
let current = "home";

const PROGRESS = { home: 1, thinking: 1, questions: 2, verdict: 3, error: 1, plan: 3 };
const THINKING = [
  "Lazy is consulting the couch…",
  "Weighing your excuses…",
  "Checking if this is a “future you” problem…",
  "Fluffing the cushions of judgement…",
  "Estimating the minimum possible effort…",
  "Asking Gemma, very politely, on your laptop…",
  "Reading the fine print. Slowly.",
];
let thinkTimer = null, statusTimer = null;

function go(step, progress = PROGRESS[step]) {
  current = step;
  for (const s of $$(".step")) s.hidden = s.dataset.step !== step;
  $("#back").hidden = !(step === "questions" || step === "verdict" || step === "plan");
  if (step === "home") $("#plan-link").hidden = !(FEATURES.plan && FEATURES.timetable && timetable().length);
  $("#progress-fill").style.width = `${(progress / 3) * 100}%`;
  $(".progress").setAttribute("aria-valuenow", String(progress));
  $("#step-label").textContent = `${progress} of 3`;
  clearInterval(thinkTimer);
  clearInterval(statusTimer);
  if (step === "home") showLazy($("#home-lazy"), "chill", 170);
  if (step === "thinking") {
    blip("think");
    showLazy($("#think-lazy"), "thinking", 170);
    let i = Math.floor(Math.random() * THINKING.length);
    const line = $("#think-line");
    line.textContent = THINKING[i];
    thinkTimer = setInterval(() => {
      line.classList.add("fade");
      setTimeout(() => { i = (i + 1) % THINKING.length; line.textContent = THINKING[i]; line.classList.remove("fade"); }, 200);
    }, 3200);
  }
  window.scrollTo({ top: 0 });
}

/** The small line under the thinking potato: what Gemma is doing, with a live timer. */
function status(text) {
  clearInterval(statusTimer);
  const t0 = performance.now();
  const el = $("#think-status");
  const tick = () => { el.textContent = `${text} · ${Math.floor((performance.now() - t0) / 1000)} s`; };
  tick();
  statusTimer = setInterval(tick, 1000);
}

const ctx = () => ({ task: run.task, context: run.context, photoNotes: run.photoNotes, profile: run.profile, schedule: run.schedule, today: run.today });

/** Today's and tomorrow's timetable, but only for class/work/time-ish tasks (see scheduleRelevant). */
function scheduleFor(text, today) {
  const tt = FEATURES.timetable ? timetable() : [];
  return scheduleRelevant(text, tt) ? scheduleText(tt, today, addDays(today, 1)) : "";
}
const gemmaOpts = () => {
  const s = settings();
  return { host: s.host, model: s.model, signal: controller.signal, trace: hooks.trace, onError: hooks.reportError };
};

// Step 1
$("#ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const task = $("#task").value.trim();
  if (!task) { $("#task").focus(); toast("Tell Lazy what you're avoiding first."); return; }
  run = { task, context: $("#context").value.trim(), image: photo?.base64 || "", photoNotes: "", photo: null,
    today: localISODate(), profile: profileText(), questions: [], answers: [], calls: [], qIndex: 0 };
  run.schedule = scheduleFor(`${run.task} ${run.context}`, run.today);
  askPhase();
});
$("#task").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); $("#ask-form").requestSubmit(); }
});
for (const chip of $$("#ask-form .chip")) chip.addEventListener("click", () => { $("#task").value = chip.textContent; $("#task").focus(); });
$("#more-toggle").addEventListener("click", (e) => {
  const open = $("#more").hidden;
  $("#more").hidden = !open;
  e.currentTarget.setAttribute("aria-expanded", String(open));
  e.currentTarget.textContent = open ? "− Hide context and photo" : "+ Add context or a photo";
  if (open) $("#context").focus();
});
$("#home-lazy").addEventListener("click", () => {
  const m = $("#home-lazy");
  m.classList.remove("wiggle");
  void m.offsetWidth;
  m.classList.add("wiggle");
  if (soundOn()) server.sfx ? playElevenSfx("snore") : blip("snore");
});

async function askPhase() {
  controller = new AbortController();
  go("thinking", 1);
  let next;
  try {
    next = await hooks.agent("ask", askGemma);
  } catch (err) { return fail(err, askPhase); }
  if (next === "facts") factsPhase(); else { run.qIndex = run.photo ? -1 : 0; showQuestion(); }
}

/** Photo (if any) → questions. Returns "facts" when there's nothing to ask or confirm. */
async function askGemma() {
  if (run.image && !run.photo) {
    status("Gemma is reading your photo");
    const r = await describePhoto({ ...gemmaOpts(), task: run.task, today: run.today, imageBase64: run.image });
    run.calls.push(r.stats);
    run.photo = r.data;
    run.photoNotes = photoNotesText(r.data);
  }
  status("Gemma is deciding what to ask");
  const q = await askQuestions({ ...gemmaOpts(), ...ctx() });
  run.calls.push(q.stats);
  run.questions = q.data;
  run.answers = q.data.map((x) => ({ question: x.question, answer: "", about: x.about }));
  hooks.annotate({ "app.questions": run.questions.length, "app.has_photo": Boolean(run.photo) });
  return !run.questions.length && !run.photo ? "facts" : "questions";
}

// Step 2: one card at a time. Index -1 is "did Gemma read your photo right?"
function showQuestion() {
  const card = $("#question-card");
  const total = run.questions.length;
  const i = run.qIndex;
  const last = i === total - 1 || (i === -1 && total === 0);
  const next = () => {
    if (last) return factsPhase();
    run.qIndex++;
    showQuestion();
  };

  if (i === -1) {
    const notes = h("textarea", { rows: "8", "aria-label": "What Gemma read in your photo" });
    notes.value = run.photoNotes;
    card.replaceChildren(
      h("span", { class: "q-count" }, withIcon("camera", "From your photo")),
      h("h2", {}, "Did Gemma read this right?"),
      h("p", { class: "fine", style: "margin:-8px 0 12px" }, "A small model can misread photos. Fix anything that's wrong."),
      notes,
      h("button", { type: "button", class: "btn primary", onclick: () => { run.photoNotes = notes.value.trim(); next(); } },
        last ? "Get my verdict" : "Looks right"),
    );
  } else {
    const q = run.questions[i];
    const answer = (value) => {
      run.answers[i].answer = value;
      for (const b of card.querySelectorAll(".pill")) b.setAttribute("aria-pressed", String(b.textContent === value));
      if (!last) setTimeout(next, 180); // auto-advance; the last question waits for "Get my verdict"
      else card.querySelector(".btn.primary").focus();
    };
    const own = h("input", { type: "text", placeholder: "…or type your own", "aria-label": "Type your own answer", maxlength: "120" });
    card.replaceChildren(
      h("span", { class: "q-count" }, `Question ${i + 1} of ${total}`),
      h("h2", {}, q.question),
      h("div", { class: "pills", role: "group", "aria-label": q.question },
        q.options.map((opt) => h("button", { type: "button", class: "pill", "aria-pressed": String(run.answers[i].answer === opt), onclick: () => answer(opt) }, opt))),
      h("form", { class: "own", onsubmit: (e) => { e.preventDefault(); if (own.value.trim()) answer(own.value.trim()); } },
        own, h("button", { type: "submit", class: "icon-btn", "aria-label": "Use my answer" }, icon("arrow-right"))),
      q.added_by_app ? h("p", { class: "fine q-note" }, "Asked by the app: the deadline changes the verdict the most.") : "",
      last
        ? h("button", { type: "button", class: "btn primary", onclick: factsPhase }, "Get my verdict")
        : h("button", { type: "button", class: "text-btn q-skip", onclick: next }, "Skip this one"),
    );
    if (!q.options.includes(run.answers[i].answer)) own.value = run.answers[i].answer;
  }
  go("questions");
  if (i >= 0) speakQuestion(run.questions[i].question);
  card.classList.remove("swap");
  void card.offsetWidth;
  card.classList.add("swap");
}

$("#back").addEventListener("click", () => {
  const first = run?.photo ? -1 : 0;
  if (current === "plan") return go("home");
  if (current === "questions") {
    if (run.qIndex > first) { run.qIndex--; showQuestion(); } else go("home");
  } else if (current === "verdict") {
    if (run.questions.length || run.photo) { run.qIndex = run.questions.length ? run.questions.length - 1 : -1; showQuestion(); } else go("home");
  }
});

async function factsPhase() {
  controller = new AbortController();
  playing?.pause(); // stop reading the question once the user asks for the verdict
  go("thinking", 2);
  status("Gemma is writing down the facts");
  try {
    await hooks.agent("verdict", factsAndVerdict);
    run.id = saveRun();
    await serverReady;
    renderVerdict();
    go("verdict");
    blip("flump"); // Lazy lands on the couch…
    const landed = VERDICT_SOUND[MOOD[run.result.verdict]];
    setTimeout(() => blip(landed), 300);
  } catch (err) { return fail(err, factsPhase); }
  rememberFrom(run);
}

/** After a verdict: one extra Gemma call for lasting facts, in the background. Never blocks or breaks the verdict. */
async function rememberFrom(r) {
  if (!FEATURES.memory) return;
  try {
    const known = memory().map((f) => f.text);
    const s = settings();
    const { data } = await learnFacts({ host: s.host, model: s.model, trace: hooks.trace, onError: hooks.reportError,
      task: r.task, context: r.context, answers: r.answers, known });
    const { list, added } = mergeFacts(memory(), data);
    if (!added.length) return;
    saveMemory(list);
    renderMemory();
    blip("learned");
    if (run === r && current === "verdict") {
      $("#learned").replaceChildren(face("thinking"), "Lazy learned: ", h("strong", {}, added.join(" ")));
      $("#learned").hidden = false;
    }
  } catch (e) {
    hooks.reportError(e, { phase: "memory" });
  }
}

/** Gemma extracts the facts; decide() picks the verdict. */
async function factsAndVerdict() {
  const f = await extractFacts({ ...gemmaOpts(), ...ctx(), answers: run.answers });
  run.calls.push(f.stats);
  run.extracted = f.data;
  const facts = f.data.facts;
  // Only categorical/numeric facts go into the trace, never Gemma's sentences.
  const toolInput = {
    category: facts.category, consequence: facts.consequence, days_to_deadline: daysUntil(facts.deadline, run.today),
    affects_others: facts.affects_others, can_be_undone_later: facts.can_be_undone_later, effort_minutes: facts.effort_minutes,
    has_lazy_minimum: Boolean(facts.lazy_minimum), lazy_minimum_minutes: facts.lazy_minimum_minutes, confidence: facts.confidence,
  };
  run.result = hooks.tool("decide_verdict", toolInput, () => decide(facts, run.today));
  hooks.annotate({
    "app.verdict": run.result.verdict, "app.rule": run.result.rule, "app.safety_override": run.result.safety_override,
    "app.code_overrides": f.data.notes.length, "app.gemma_ms_total": sum("wall_ms"),
  });
}

let retryFn = null;
function fail(err, again) {
  if (err.name === "AbortError") { go("home"); return; }
  console.error(err);
  if (err.code !== "bad_json") hooks.reportError(err, { phase: again.name }); // bad_json was already reported per attempt
  retryFn = again;
  const offline = ["unreachable", "cors", "no_model"].includes(err.code);
  showLazy($("#error-lazy"), "unsure", 150);
  $("#error-title").textContent = offline ? "Lazy can't reach Gemma." : "Something went bonk.";
  $("#error-text").textContent = err.message || String(err);
  go("error");
}
$("#retry").addEventListener("click", () => retryFn && retryFn());
$("#cancel").addEventListener("click", () => controller?.abort());

// ---------- Plan my lazy day: today's timetable → one batched Gemma call → the same decide() per item ----------
const PLAN_GROUPS = [["yes", "Must do"], ["lazy", "Lazy minimum"], ["skip", "Skip"], ["later", "Later"], ["unsure", "Not sure"]];
const SEVERITY = ["yes", "lazy", "later", "skip", "unsure"];

async function planPhase() {
  const today = localISODate();
  const items = entriesOn(timetable(), today);
  if (!items.length) { toast("Nothing on today's timetable. Lazy approves."); return; }
  controller = new AbortController();
  go("thinking", 1);
  status(`Gemma is weighing ${items.length} item${items.length === 1 ? "" : "s"} on today's timetable`);
  try {
    const s = settings();
    const { data, stats } = await hooks.agent("plan", () => planDay({ host: s.host, model: s.model, signal: controller.signal,
      trace: hooks.trace, onError: hooks.reportError, items, profile: profileText(), today }));
    const results = items.map((it, i) => ({ it, r: hooks.tool("decide_verdict", { category: data[i].category, consequence: data[i].consequence },
      () => decide(data[i], today)) }));
    renderPlan(results, stats);
    go("plan");
    blip("flump");
    const mood = MOOD[dayVerdict(results)];
    setTimeout(() => blip(VERDICT_SOUND[mood]), 300);
  } catch (err) { fail(err, planPhase); }
}

/** The day's overall verdict: the most common one, ties going to the more serious. */
function dayVerdict(results) {
  const count = (v) => results.filter((x) => x.r.verdict === v).length;
  return [...SEVERITY].sort((a, b) => count(b) - count(a) || SEVERITY.indexOf(a) - SEVERITY.indexOf(b))[0];
}

function renderPlan(results, stats) {
  const overall = dayVerdict(results);
  const saved = results.reduce((t, { r }) => t + minutesSaved(r.facts, r.verdict), 0);
  const lazyEl = h("div", { class: "mascot" });
  showLazy(lazyEl, MOOD[overall], 170);
  const box = $("#plan");
  box.className = `plan v-${overall}`;
  box.replaceChildren(h("div", {},
    lazyEl,
    h("h1", { class: "v-title" }, "Your lazy day."),
    saved > 0 ? h("div", { class: "payoff" }, withIcon("sofa", `~${fmtMinutes(saved)} saved today`)) : "",
    PLAN_GROUPS.map(([v, label]) => {
      const group = results.filter((x) => x.r.verdict === v);
      if (!group.length) return "";
      return h("section", { class: `plan-group v-${v}` }, h("h3", {}, withIcon(VERDICT_ICON[v], label)), group.map(({ it, r }) =>
        h("button", { type: "button", class: "plan-item", onclick: () => askAbout(it) },
          h("b", {}, `${it.start || ""}${it.end ? `–${it.end}` : ""} ${it.title}`),
          v === "lazy" && r.lazy_minimum ? h("span", { class: "min" }, `${r.lazy_minimum} · ${r.facts.lazy_minimum_minutes} min`) : "",
          h("span", {}, r.facts.one_line_reason || r.reason))));
    }),
    h("p", { class: "fine v-time" }, `Planned by Gemma in ${(stats.wall_ms / 1000).toFixed(1)} s on your laptop · tap an item to ask about it properly.`),
    h("button", { type: "button", class: "btn primary", onclick: startOver }, "Back to asking"),
  ));
}

/** Tapping a plan item runs the normal question → verdict flow for it. */
function askAbout(it) {
  $("#task").value = `Go to ${it.title}${it.start ? ` at ${it.start}` : ""} today`;
  $("#context").value = "";
  clearPhoto();
  $("#ask-form").requestSubmit();
}
$("#plan-link").addEventListener("click", () => planPhase());

function startOver() {
  $("#task").value = "";
  $("#context").value = "";
  clearPhoto();
  go("home");
  $("#task").focus();
}

// ---------- Step 3: the verdict ----------
function fmtDate(iso) {
  if (!iso) return "";
  return new Date(`${iso}T12:00:00`).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}
function fmtMinutes(m) {
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const hrs = Math.floor(m / 60), rest = m % 60;
  return `${hrs} hour${hrs === 1 ? "" : "s"}${rest ? ` ${rest} min` : ""}`;
}
function sum(key) { return run.calls.reduce((t, c) => t + (c[key] || 0), 0); }

export function gemmaTimeLine(calls) {
  const s = (ms) => (ms / 1000).toFixed(1);
  const add = (key) => calls.reduce((t, c) => t + (c[key] || 0), 0);
  const total = add("wall_ms"), load = add("load_ms"), evalMs = add("eval_ms"), out = add("output_tokens");
  const retries = calls.reduce((t, c) => t + c.attempts - 1, 0);
  return [
    `${s(total)} s on your laptop`,
    load > 1000 ? ` (incl. ${s(load)} s loading the model)` : "",
    ` · ${calls.length} call${calls.length === 1 ? "" : "s"}`,
    ` · ${add("prompt_tokens")} → ${out} tokens`,
    evalMs > 0 ? ` · ${(out / (evalMs / 1000)).toFixed(1)} tokens/s` : "",
    retries ? ` · ${retries} retr${retries === 1 ? "y" : "ies"} after malformed JSON` : "",
  ].join("");
}

/** Minutes not spent, using Gemma's own effort estimate and the user's choice where they gave one. */
function minutesSaved(row, choice = row.user_verdict || row.verdict) {
  if (choice === "skip") return row.effort_minutes;
  if (choice === "lazy") return Math.max(0, row.effort_minutes - row.lazy_minimum_minutes);
  return 0;
}

function whyPanel(r) {
  const f = r.facts;
  const days = r.days_to_deadline;
  const rows = [
    ["Consequence", f.consequence || "—"],
    ["Deadline", f.deadline ? `${fmtDate(f.deadline)} (${days === 0 ? "today" : days === 1 ? "tomorrow" : days < 0 ? `${-days} days ago` : `in ${days} days`})` : "none given"],
    ["Lets someone down", f.affects_others ? "yes" : "no"],
    ["AI confidence", `${Math.round(f.confidence * 100)}%`],
    ["Gemma time", gemmaTimeLine(run.calls)],
    ["If you skip it", f.if_skipped || "—"],
    ["Effort", `~${f.effort_minutes} min`],
    ["Lazy minimum", f.lazy_minimum ? `${f.lazy_minimum} (~${f.lazy_minimum_minutes} min)` : "none"],
    ["Can be fixed later", f.can_be_undone_later ? "yes" : "no"],
    ["Category", CATEGORY_LABELS[f.category]],
    ["Rule", r.rule + (r.safety_override ? " (safety override)" : "")],
  ];
  const notes = run.extracted.notes;
  return h("details", { class: "why" },
    h("summary", {}, "Why?"),
    h("div", { class: "why-body" },
      h("p", {}, r.reason),
      h("dl", { class: "facts" }, rows.map(([k, v]) => [h("dt", {}, k), h("dd", {}, v)])),
      run.extracted.working ? [h("h3", {}, "Gemma's working"), h("p", { class: "fine" }, run.extracted.working)] : "",
      notes.length ? [h("h3", {}, "The app overruled Gemma"), h("ul", {}, notes.map((n) => h("li", {}, n)))] : "",
      run.answers.some((a) => a.answer) ? [h("h3", {}, "Your answers"),
        h("ul", {}, run.answers.filter((a) => a.answer).map((a) => h("li", {}, `${a.question} → ${a.answer}`)))] : "",
      run.photo ? [h("h3", {}, "From your photo"), h("pre", {}, run.photoNotes)] : "",
      h("p", { class: "fine", style: "margin-top:14px" }, "Gemma only writes down the facts above. Plain rules in decide.js pick the verdict."),
    ));
}

function renderVerdict() {
  const r = run.result, f = r.facts;
  const card = $("#verdict");
  card.className = `verdict v-${r.verdict}`;
  const lazyEl = h("div", { class: "mascot" });
  showLazy(lazyEl, MOOD[r.verdict], 210);
  const saved = minutesSaved(f, r.verdict);
  card.replaceChildren(
    lazyEl,
    h("h1", { class: "v-title" }, `${r.label}.`),
    r.verdict !== "unsure" && f.one_line_reason ? h("p", { class: "v-reason" }, f.one_line_reason)
      : h("p", { class: "v-reason" }, "Lazy needs a bit more to go on. Add some context and ask again."),
    r.safety_override ? h("p", { class: "fine v-safety" }, withIcon("shield", "Lazy never lets you skip health, money, legal or graded work.")) : "",
    saved > 0 ? h("div", { class: "payoff", title: "Based on Gemma's estimate of the effort" }, withIcon("sofa", `~${fmtMinutes(saved)} back in your life`)) : "",
    r.verdict === "lazy" ? h("div", { class: "v-card" }, h("span", { class: "k" }, "Your lazy minimum"),
      h("strong", {}, r.lazy_minimum), ` · ${f.lazy_minimum_minutes} min`) : "",
    r.verdict === "later" ? h("div", { class: "v-card" }, h("span", { class: "k" }, "Do it by"),
      r.by_when ? [h("strong", {}, fmtDate(r.by_when)), ` · it's due ${fmtDate(f.deadline)}`] : h("strong", {}, "No hard date. Whenever it starts to bug you.")) : "",
    r.verdict === "yes" && f.deadline ? h("div", { class: "v-card" }, h("span", { class: "k" }, "Due"), h("strong", {}, fmtDate(f.deadline))) : "",
    speakButton(),
    personalPrediction(),
    whyPanel(r),
    agreeRow(run.id, r),
    h("button", { type: "button", class: "btn primary", onclick: startOver }, "Ask about something else"),
    h("p", { class: "fine v-time" }, `Judged by Gemma in ${(sum("wall_ms") / 1000).toFixed(1)} s, on your laptop.`),
    h("p", { id: "learned", class: "learned", "aria-live": "polite", hidden: true }),
  );
}

// "Would you have decided the same?" — four pills; the answer becomes your label in History (and TabPFN's training data).
const CHOICES = { skip: "I'd skip it", lazy: "Bare minimum", later: "Later", yes: "I'd do it" };
function agreeRow(id, r) {
  const picked = history().find((x) => x.id === id)?.user_verdict || null;
  const choice = (k) => [k, withIcon(VERDICT_ICON[k], CHOICES[k])];
  const options = r.verdict === "unsure"
    ? Object.keys(CHOICES).map(choice)
    : [[r.verdict, withIcon("thumbs-up", "Same call")], ...Object.keys(CHOICES).filter((k) => k !== r.verdict).map(choice)];
  return h("div", { class: "agree" },
    h("p", {}, "Would you have decided the same?"),
    h("div", { class: "chips", role: "group", "aria-label": "Would you have decided the same?" }, options.map(([key, label]) =>
      h("button", { type: "button", class: "chip", "aria-pressed": String(picked === key), onclick: (e) => {
        setUserVerdict(id, key, r);
        for (const b of e.currentTarget.parentElement.children) b.setAttribute("aria-pressed", String(b === e.currentTarget));
        toast(key === r.verdict ? "Thanks! Great minds nap alike." : "Thanks! Lazy is taking notes.");
        blip("ding");
      } }, label))));
}

// ---------- sound (ElevenLabs via the server; only the one-line verdict leaves the browser) ----------
const audioCache = new Map(); // key → Promise<object URL>, so replaying costs nothing
let playing = null;

async function fetchAudio(url, init) {
  const r = await fetch(url, init);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Sound failed (${r.status})`);
  return URL.createObjectURL(await r.blob());
}
function cachedAudio(key, load) {
  if (!audioCache.has(key)) audioCache.set(key, load().catch((e) => { audioCache.delete(key); throw e; }));
  return audioCache.get(key);
}
function playURL(url) {
  return new Promise((resolve, reject) => {
    playing?.pause();
    playing = new Audio(url);
    playing.onended = resolve;
    playing.onerror = () => reject(new Error("Couldn't play the sound"));
    playing.play().catch(reject);
  });
}
// ElevenLabs sound effects (gavel, snore) from the server; the little UI blips come from sounds.js instead.
const elevenSfx = (name) => cachedAudio(`sfx:${name}`, () => fetchAudio(`api/sfx/${name}`));
async function playElevenSfx(name) {
  try { await playURL(await elevenSfx(name)); } catch { blip(name); /* fall back to the synth version */ }
}

const isLocal = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);

// Lazy reads each question aloud (ElevenLabs via /api/speak), so it feels like a conversation. Settings → Voice turns it off.
const voiceOn = () => store.get("dintd.voice", true);
function speakQuestion(text) {
  if (!server.speak || !voiceOn()) return;
  cachedAudio(`q:${text}`, () => fetchAudio("api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) }))
    .then(async (url) => {
      if (current !== "questions" || run.questions[run.qIndex]?.question !== text) return; // the user already moved on
      voiceBusy = true;
      try { await playURL(url); } finally { voiceBusy = false; }
    })
    .catch(() => { /* reading aloud is a bonus */ });
}
$("#voice-toggle").addEventListener("change", (e) => {
  store.set("dintd.voice", e.target.checked);
  if (!e.target.checked) playing?.pause();
  $("#voice-hint").textContent = e.target.checked ? "Lazy reads questions aloud" : "Voice off";
});

function speakButton() {
  if (!server.speak) {
    // On a public site the button just stays hidden; when you run it yourself, say why there's no voice.
    return isLocal && server.reachable
      ? h("p", { class: "fine voice-off" }, withIcon("volume-x", "Lazy's voice is off. Add ELEVENLABS_API_KEY to .env and restart the server."))
      : "";
  }
  const result = run.result;
  const line = verdictLine(result);
  const btn = h("button", { type: "button", class: "btn secondary", title: `Sends only this line to the server: "${line}"` }, withIcon("volume", "Hear the verdict"));
  const label = (name, text) => btn.replaceChildren(...withIcon(name, text));
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    try {
      btn.replaceChildren(face("thinking"), "Summoning Lazy…");
      const voice = cachedAudio(`voice:${line}`, () => hooks.span("ai.tts", "ElevenLabs: speak verdict", { verdict: result.verdict },
        () => fetchAudio("api/speak", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: line }) })));
      const gavel = server.sfx ? elevenSfx("gavel").catch(() => null) : null;
      const [voiceURL, gavelURL] = await Promise.all([voice, gavel]);
      voiceBusy = true;
      if (gavelURL) { label("gavel", "Order!"); await playURL(gavelURL); }
      label("volume", "Playing…");
      await playURL(voiceURL);
      label("volume", "Hear it again");
    } catch (e) {
      label("volume-x", e.message);
      hooks.reportError(e, { phase: "speak" });
    }
    voiceBusy = false;
    btn.disabled = false;
  });
  return btn;
}

// ---------- personal laziness (TabPFN via /api/predict; only six numeric/categorical features leave the browser) ----------
const predictions = new Map(); // payload → promise, so re-rendering doesn't spend another prediction
function personalPrediction() {
  if (!server.predict) return "";
  const result = run.result;
  const rows = trainingRows(history().filter((r) => r.id !== run.id));
  if (rows.length < MIN_LABELLED_ROWS) return "";
  const query = featureRow({ ...result.facts, days_to_deadline: result.days_to_deadline });
  const body = JSON.stringify({ rows, query });
  if (!predictions.has(body)) {
    predictions.set(body, hooks.span("gen_ai.execute_tool", "execute_tool tabpfn_personal_verdict",
      { "gen_ai.tool.name": "tabpfn_personal_verdict", "app.rows": rows.length },
      () => fetch("api/predict", { method: "POST", headers: { "Content-Type": "application/json" }, body })
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`))))));
  }
  const box = h("div", { class: "v-card prediction", "aria-live": "polite" }, h("span", { class: "k" }, "Your habits"), "Checking your past choices…");
  predictions.get(body).then((p) => {
    const v = VERDICTS[p.verdict];
    if (!v) return box.remove();
    const pct = (x) => `${Math.round(x * 100)}%`;
    const bars = Object.entries(p.probabilities).filter(([k]) => VERDICTS[k]).sort((a, b) => b[1] - a[1]);
    box.replaceChildren(
      h("span", { class: "k" }, "Your habits"),
      h("div", {}, "Based on your past choices, you'd probably pick ", h("strong", {}, `${v.label} (${pct(p.probability)})`), "."),
      h("div", { class: "probs" }, bars.map(([k, x]) => h("div", { class: "prob" },
        h("span", {}, VERDICTS[k].label),
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${pct(x)}` })),
        h("span", { class: "pct" }, pct(x))))),
      h("p", { class: "fine", style: "margin-top:8px" },
        p.verdict === result.verdict ? "Your past self agrees. " : "Your past self leans differently; the verdict above still stands. ",
        `TabPFN, from ${p.rows} of your answers.`));
  }).catch((e) => { box.remove(); predictions.delete(body); hooks.reportError(e, { phase: "predict" }); });
  return box;
}

// ---------- history ----------
function saveRun() {
  const r = run.result, f = r.facts;
  const row = {
    id: globalThis.crypto?.randomUUID ? crypto.randomUUID() : String(Date.now()),
    ts: new Date().toISOString(), today: run.today, task: run.task,
    verdict: r.verdict, rule: r.rule, safety_override: r.safety_override, user_verdict: null,
    category: f.category, consequence: f.consequence, deadline: f.deadline, days_to_deadline: r.days_to_deadline,
    affects_others: f.affects_others, can_be_undone_later: f.can_be_undone_later,
    effort_minutes: f.effort_minutes, lazy_minimum_minutes: f.lazy_minimum_minutes, confidence: f.confidence,
    gemma_ms: sum("wall_ms"),
  };
  // Going back and re-answering replaces this task's earlier verdict instead of adding a duplicate.
  saveHistory([row, ...history().filter((x) => x.id !== run.id)].slice(0, 500));
  return row.id;
}

function setUserVerdict(id, v, result) {
  const rows = history();
  const row = rows.find((x) => x.id === id);
  saveHistory(rows.map((x) => (x.id === id ? { ...x, user_verdict: v || null } : x)));
  if (row && v && v !== row.verdict) hooks.feedback({ ai: row.verdict, user: v, rule: result?.rule || row.rule });
}

function renderHistory() {
  const rows = history();
  const weekAgo = Date.now() - 7 * 864e5;
  const week = rows.filter((r) => new Date(r.ts).getTime() >= weekAgo).reduce((t, r) => t + minutesSaved(r), 0);
  const labelled = rows.filter((r) => r.user_verdict);
  const agreed = labelled.filter((r) => r.user_verdict === r.verdict).length;
  const stat = (big, small) => h("div", { class: "stat" }, h("b", {}, big), h("span", {}, small));
  $("#stats").replaceChildren(
    stat(week >= 60 ? `${(week / 60).toFixed(1)} h` : `${week} min`, "saved this week"),
    stat(labelled.length ? `${Math.round((agreed / labelled.length) * 100)}%` : "—", labelled.length ? `agree with AI (${agreed}/${labelled.length})` : "agree with AI"),
    stat(rows.length, rows.length === 1 ? "task judged" : "tasks judged"),
  );
  const taught = trainingRows(rows).length;
  $("#teach").hidden = !server.predict;
  $("#teach").replaceChildren(face("thinking"), taught >= MIN_LABELLED_ROWS
    ? "Lazy knows your habits: new verdicts show what you'd probably pick."
    : `${MIN_LABELLED_ROWS - taught} more “Would you have decided the same?” answers and Lazy learns your habits.`);
  const empty = h("li", { class: "empty" }, h("div", { class: "mascot" }), h("p", { class: "muted" }, "Nothing judged yet. Lazy is very relaxed about it."),
    h("button", { type: "button", class: "btn primary", onclick: () => showView("flow") }, "Ask Lazy"));
  if (!rows.length) showLazy(empty.querySelector(".mascot"), "unsure", 130);
  $("#history-list").replaceChildren(...(rows.length ? rows.map((r) => h("li", { class: `v-${r.verdict}` },
    h("span", { class: "dot", "aria-hidden": "true" }),
    h("span", { class: "h-task" }, r.task),
    minutesSaved(r) ? h("span", { class: "h-save" }, `${minutesSaved(r)} min`) : h("span", { class: "h-save" }),
    h("span", { class: "h-meta" }, `${new Date(r.ts).toLocaleDateString(undefined, { day: "numeric", month: "short" })} · ${VERDICTS[r.verdict].label}`,
      r.user_verdict && r.user_verdict !== r.verdict ? ` · you: ${VERDICTS[r.user_verdict].label}` : r.user_verdict ? " · you agreed" : ""),
  )) : [empty]));
  $("#export-csv").disabled = !rows.length;
}

const CSV_COLUMNS = ["ts", "task", "verdict", "user_verdict", "rule", "safety_override", "category", "consequence", "deadline",
  "days_to_deadline", "affects_others", "can_be_undone_later", "effort_minutes", "lazy_minimum_minutes", "confidence", "gemma_ms"];
function toCSV(rows) {
  const cell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [CSV_COLUMNS.join(","), ...rows.map((r) => CSV_COLUMNS.map((c) => cell(r[c])).join(","))].join("\r\n");
}
$("#export-csv").addEventListener("click", () => {
  const url = URL.createObjectURL(new Blob([toCSV(history())], { type: "text/csv" }));
  const a = h("a", { href: url, download: `my-verdicts-${localISODate()}.csv` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
$("#clear-history").addEventListener("click", () => {
  if (confirm("Delete all saved verdicts from this browser?")) { saveHistory([]); renderHistory(); }
});

// ---------- photo ----------
async function loadPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = h("canvas", { width: Math.round(bmp.width * scale), height: Math.round(bmp.height * scale) });
  canvas.getContext("2d").drawImage(bmp, 0, 0, canvas.width, canvas.height);
  const url = canvas.toDataURL("image/jpeg", 0.88);
  return { url, base64: url.slice(url.indexOf(",") + 1) };
}
function clearPhoto() { photo = null; $("#photo").value = ""; $("#photo-preview").hidden = true; }
$("#photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return clearPhoto();
  try {
    photo = await loadPhoto(file);
    $("#photo-preview img").src = photo.url;
    $("#photo-preview").hidden = false;
  } catch { clearPhoto(); toast("Couldn't read that image."); }
});
$("#photo-remove").addEventListener("click", clearPhoto);

// ---------- settings: what Lazy knows about you ----------
function renderMemory() {
  const list = memory();
  $("#memory-section").hidden = !FEATURES.memory;
  $("#memory-count").textContent = list.length ? `${list.length} fact${list.length === 1 ? "" : "s"}` : "Nothing yet";
  $("#memory-clear").hidden = !list.length;
  $("#memory-list").replaceChildren(...(list.length ? list.map((f) => {
    const input = h("textarea", { rows: "1", maxlength: "140", "aria-label": "Fact about you" });
    input.value = f.text;
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); input.blur(); } });
    input.addEventListener("input", () => fitHeight(input));
    input.addEventListener("change", () => {
      const text = input.value.trim();
      saveMemory(text ? memory().map((x) => (x.id === f.id ? { ...x, text, by: "you" } : x)) : memory().filter((x) => x.id !== f.id));
      renderMemory();
    });
    return h("li", {},
      h("span", { class: "by", title: f.by === "you" ? "Added or edited by you" : "Learned by Lazy" }, f.by === "you" ? "you" : "Lazy"),
      input,
      h("button", { type: "button", class: "icon-btn", "aria-label": `Forget: ${f.text}`, onclick: () => { saveMemory(memory().filter((x) => x.id !== f.id)); renderMemory(); } }, icon("x")));
  }) : [h("li", { class: "memory-empty" }, "Lazy hasn't learned anything yet. Ask about a few things, or add a fact below.")]));
  fitAll();
}
/** Grow each fact box to show the whole fact (it can only be measured while the section is open). */
function fitHeight(el) { el.style.height = "auto"; el.style.height = `${el.scrollHeight + 2}px`; }
function fitAll() { for (const t of $$("#memory-list textarea")) fitHeight(t); }
$("#memory-section").addEventListener("toggle", fitAll);
$("#memory-add").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#memory-new").value.trim();
  if (!text) return;
  const { list, added } = mergeFacts(memory(), [text], { by: "you" });
  saveMemory(list);
  $("#memory-new").value = "";
  renderMemory();
  toast(added.length ? "Got it. Lazy will remember." : "Lazy already knows that one.");
});
$("#memory-clear").addEventListener("click", () => {
  if (confirm("Forget everything Lazy has learned about you?")) { saveMemory([]); renderMemory(); }
});
renderMemory();

// ---------- settings: your timetable ----------
function renderTimetable() {
  const list = timetable();
  $("#timetable-section").hidden = !FEATURES.timetable;
  const toCheck = list.filter((e) => e.check).length;
  $("#tt-hint").textContent = list.length ? `${list.length} entr${list.length === 1 ? "y" : "ies"}${toCheck ? ` · ${toCheck} to check` : ""}` : "Not added yet";
  $("#tt-actions").hidden = !list.length;
  const update = (i, patch) => { const next = timetable(); next[i] = { ...next[i], ...patch, check: false }; saveTimetable(next); renderTimetable(); };
  const items = [];
  let lastDay = "";
  list.forEach((e, i) => {
    if (e.day !== lastDay) { items.push(h("li", { class: "tt-day-head" }, e.day)); lastDay = e.day; }
    const day = h("select", { "aria-label": "Day", onchange: (ev) => update(i, { day: ev.target.value }) }, DAYS.map((d) => h("option", { value: d, selected: d === e.day }, d.slice(0, 3))));
    const start = h("input", { type: "time", "aria-label": "Start", value: e.start || "", onchange: (ev) => update(i, { start: ev.target.value }) });
    const end = h("input", { type: "time", "aria-label": "End", value: e.end || "", onchange: (ev) => update(i, { end: ev.target.value }) });
    const title = h("input", { type: "text", class: "tt-title", maxlength: "80", "aria-label": "What", value: e.title, onchange: (ev) => update(i, { title: ev.target.value.trim() || e.title }) });
    const type = h("select", { class: "tt-type", "aria-label": "Type", onchange: (ev) => update(i, { type: ev.target.value }) }, TYPES.map((t) => h("option", { value: t, selected: t === e.type }, t)));
    const del = h("button", { type: "button", class: "icon-btn", "aria-label": `Remove ${e.day} ${e.title}`, onclick: () => { saveTimetable(timetable().filter((_, j) => j !== i)); renderTimetable(); } }, icon("x"));
    items.push(h("li", { class: `tt-row${e.check ? " check" : ""}` }, e.check ? h("span", { class: "tt-badge" }, "check this") : "", day, start, end, del, title, type));
  });
  $("#tt-list").replaceChildren(...items);
}

async function readTimetableFrom(input) {
  const s = settings();
  const t0 = performance.now();
  const status = $("#tt-status");
  const tick = () => { status.textContent = `Gemma is reading your timetable on your laptop · ${Math.floor((performance.now() - t0) / 1000)} s (this can take a minute or two)`; };
  tick();
  const timer = setInterval(tick, 1000);
  for (const b of $$("#tt-read, #tt-photo")) b.disabled = true;
  try {
    const { data } = await readTimetable({ host: s.host, model: s.model, trace: hooks.trace, onError: hooks.reportError, ...input });
    if (!data.entries.length) throw new Error("Gemma couldn't find any entries. Try a clearer photo, or paste the text.");
    saveTimetable(data.entries);
    renderTimetable();
    const toCheck = data.entries.filter((e) => e.check).length;
    status.textContent = `Found ${data.entries.length} entries in ${((performance.now() - t0) / 1000).toFixed(0)} s.${toCheck ? ` ${toCheck} marked "check this": fix or keep them.` : " Fix anything that's off."}`;
    blip("learned");
  } catch (e) {
    status.replaceChildren(face("unsure"), e.message);
    hooks.reportError(e, { phase: "timetable" });
  } finally {
    clearInterval(timer);
    for (const b of $$("#tt-read, #tt-photo")) b.disabled = false;
  }
}
$("#tt-photo").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  try { readTimetableFrom({ imageBase64: (await loadPhoto(file)).base64 }); } catch { toast("Couldn't read that image."); }
});
$("#tt-paste-toggle").addEventListener("click", (e) => {
  const open = $("#tt-paste").hidden;
  $("#tt-paste").hidden = !open;
  e.currentTarget.setAttribute("aria-expanded", String(open));
  if (open) $("#tt-text").focus();
});
$("#tt-read").addEventListener("click", () => {
  const text = $("#tt-text").value.trim();
  if (text) readTimetableFrom({ text }); else $("#tt-text").focus();
});
$("#tt-add").addEventListener("click", () => {
  saveTimetable([...timetable(), { day: DAYS[(new Date().getDay() + 6) % 7], start: "09:00", end: "10:00", title: "New entry", type: "class", check: false }]);
  renderTimetable();
});
$("#tt-clear").addEventListener("click", () => {
  if (confirm("Remove your saved timetable?")) { saveTimetable([]); $("#tt-status").textContent = ""; renderTimetable(); }
});
renderTimetable();

// ---------- settings: about me ----------
{
  const p = store.get(K.profile, {});
  $("#role").value = p.role || "";
  $("#profile-notes").value = p.notes || "";
  $("#profile-form").addEventListener("submit", (e) => {
    e.preventDefault();
    store.set(K.profile, { role: $("#role").value, notes: $("#profile-notes").value.trim() });
    toast("Saved. Lazy will remember (in this browser).");
  });
}

// ---------- settings: local AI ----------
async function testConnection() {
  const res = await checkOllama(settings());
  $("#setup-result").textContent = res.message;
  const notice = $("#ollama-notice");
  notice.hidden = res.ok;
  if (!res.ok) notice.replaceChildren(face("skip"), "Lazy can't reach Gemma yet. Is Ollama running? ",
    h("button", { type: "button", class: "text-btn", style: "min-height:auto;display:inline", onclick: () => showView("settings") }, "Open Settings"));
  return res;
}
{
  const s = settings();
  $("#host").value = s.host;
  $("#model").value = s.model;
  const origin = location.origin;
  const local = /^https?:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin);
  $("#origins-cmd").textContent = local || origin === "null"
    ? "# Nothing to do: you're on localhost, which Ollama allows by default."
    : `# macOS / Linux\nOLLAMA_ORIGINS="${origin}" ollama serve\n\n# Windows (PowerShell; quit the Ollama tray app first)\n$env:OLLAMA_ORIGINS="${origin}"; ollama serve`;
  $("#setup-form").addEventListener("submit", (e) => {
    e.preventDefault();
    store.set(K.settings, { host: $("#host").value.trim() || DEFAULT_HOST, model: $("#model").value.trim() || DEFAULT_MODEL });
    $("#setup-result").textContent = "Testing…";
    testConnection();
  });
}

// ---------- optional server features (Render). On static hosting they simply stay off. ----------
export const server = { speak: false, sfx: false, predict: false, sentryDsn: "", render: null, reachable: false };
export const serverReady = (async () => {
  try {
    const r = await fetch("api/config", { headers: { Accept: "application/json" } });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) Object.assign(server, await r.json(), { reachable: true });
  } catch { /* no server: everything still works locally */ }
  const sent = [
    server.speak && "the one-line spoken verdict, only when you tap “Hear the verdict” (passed to ElevenLabs for the voice)",
    server.predict && "category, consequence, days to deadline, yes/no flags and minutes from your answered verdicts, once you have 10+ (passed to TabPFN)",
  ].filter(Boolean);
  $("#server-privacy").textContent = sent.length
    ? `This site's server only ever receives: ${sent.join("; and ")}. Never photos, never your profile.`
    : "Nothing is sent to any server.";
  // [name, what it does, on?, how to switch it on]
  const partners = [
    ["Gemma 3 4B via Ollama", "on your laptop: reads photos, asks the questions, writes down the facts", true, ""],
    ["Render", server.render ? `serves this app and its API (deploy ${server.render.commit})` : "hosts the app and its API", Boolean(server.render), "Deploy with the render.yaml Blueprint."],
    ["ElevenLabs", "Lazy's voice, the gavel and the snore", server.speak, "Add ELEVENLABS_API_KEY to .env (or Render) and restart."],
    ["Sentry", "traces every Gemma call and rule decision", Boolean(server.sentryDsn), "Add SENTRY_DSN to .env (or Render) and restart."],
    ["TabPFN", "learns your personal laziness from your answers", server.predict, "Add TABPFN_TOKEN to .env (or Render) and restart."],
    ["GitHub Actions", "tests every push and deploys the static copy to Pages", null, ""],
  ];
  $("#partners").replaceChildren(...partners.map(([name, what, on, how]) => h("li", { class: "partner" },
    h("span", { class: `status ${on === null ? "na" : on ? "on" : "off"}`, "aria-hidden": "true" }),
    h("div", {}, h("strong", {}, name), on === true ? h("span", { class: "tag on" }, "On") : on === false ? h("span", { class: "tag" }, "Off") : "",
      h("span", { class: "fine", style: "display:block" }, what),
      on === false && how ? h("span", { class: "fine how", style: "display:block" }, how) : ""))));
  if (server.render) $("#served-by").textContent = `Render · ${server.render.commit}`;
  $("#voice-section").hidden = !server.speak;
  $("#voice-toggle").checked = voiceOn();
  $("#voice-hint").textContent = voiceOn() ? "Lazy reads questions aloud" : "Voice off";
  if (server.sentryDsn) await setupSentry(server, hooks);
  return server;
})();

go("home");
testConnection();
