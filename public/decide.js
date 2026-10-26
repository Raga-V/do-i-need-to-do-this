// decide.js — the verdict is chosen HERE, by plain rules.
// Gemma never picks the verdict: it only supplies the facts this file reads.
// Pure ES module with no DOM access, so the browser and `node --test` share it.

export const VERDICTS = {
  skip:   { emoji: "🛋️", label: "Skip it" },
  lazy:   { emoji: "🪫", label: "Do the lazy minimum" },
  later:  { emoji: "📅", label: "Do it later" },
  yes:    { emoji: "🚨", label: "Yes, do it" },
  unsure: { emoji: "🤔", label: "Not sure yet" },
};
export const VERDICT_KEYS = Object.keys(VERDICTS);

export const CATEGORIES = [
  "exam_or_graded", "class_or_lecture", "work", "money", "health",
  "legal_or_official", "social", "chores", "errand", "personal", "other",
];
export const CATEGORY_LABELS = {
  exam_or_graded: "exam / graded work", class_or_lecture: "class / lecture", work: "work",
  money: "money", health: "health", legal_or_official: "legal / official", social: "social",
  chores: "chores", errand: "errand", personal: "personal", other: "other",
};
// Safety: these never get "skip", whatever the model says.
export const PROTECTED = new Set(["exam_or_graded", "money", "health", "legal_or_official"]);

// Keyword backstop: a small model can misfile "pay the electricity bill" as "other".
// If the task's own words match one of these, it's treated as protected regardless of the model.
const SAFETY_KEYWORDS = {
  money: /\b(bills?|pay|paying|payment|rent|fees?|emi|loan|tax(es)?|invoice|credit card|bank|fine|insurance|premium|subscription renewal|dues)\b/i,
  health: /\b(doctor|dentist|medicine|meds|pills?|tablets?|hospital|clinic|check-?up|vaccin\w*|therapy|therapist|prescription|blood test|physio\w*|inhaler|insulin)\b/i,
  legal_or_official: /\b(passport|visa|licen[cs]e|court|police|aadhaar|pan card|government|govt|tax return|lawyer|notary|registration|affidavit|summons|permit|kyc)\b/i,
  exam_or_graded: /\b(exams?|tests?|quiz(zes)?|assignments?|homework|submission|lab record|viva|mid-?terms?|finals|graded|marks|internals?|thesis|dissertation)\b/i,
};
export function safetyCategory(taskText) {
  for (const [category, re] of Object.entries(SAFETY_KEYWORDS)) if (re.test(taskText || "")) return category;
  return "";
}

export const CONSEQUENCES =["nothing", "minor", "annoying", "serious", "severe"];
export const MIN_CONFIDENCE = 0.5;
export const FAR_DAYS = 3; // a deadline more than this many days away counts as "far"

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;

function str(v, max = 240) {
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}
function bool(v) {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|y|1)$/i.test(v.trim());
  return v === 1;
}
function minutes(v) {
  const n = typeof v === "string" ? parseFloat(v) : v;
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), 100000) : 0;
}

/** Parse "YYYY-MM-DD" to a UTC day number, or null if it isn't a real date. */
function dayNumber(iso) {
  if (!DATE_RE.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return t / DAY_MS;
}

/** Local calendar date of a Date as "YYYY-MM-DD" (not UTC, so 1 AM IST is still "today"). */
export function localISODate(date = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}

export function addDays(iso, n) {
  const day = dayNumber(iso);
  return day === null ? "" : new Date((day + n) * DAY_MS).toISOString().slice(0, 10);
}

/** Whole days from `today` to `deadline` (negative = overdue), or null without a valid deadline. */
export function daysUntil(deadline, today) {
  const a = dayNumber(today), b = dayNumber(deadline);
  return a === null || b === null ? null : b - a;
}

/**
 * Clean whatever the model returned into well-typed facts.
 * Unknown enum values become "" (consequence) or "other" (category) instead of being guessed.
 */
export function normalizeFacts(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  let confidence = typeof f.confidence === "string" ? parseFloat(f.confidence) : f.confidence;
  if (!Number.isFinite(confidence)) confidence = 0;
  if (confidence > 1 && confidence <= 100) confidence /= 100; // "85" meaning 85%
  confidence = Math.max(0, Math.min(1, confidence));
  const deadline = str(f.deadline, 10);
  const consequence = str(f.consequence, 20).toLowerCase();
  const category = str(f.category, 40).toLowerCase();
  return {
    category: CATEGORIES.includes(category) ? category : "other",
    deadline: dayNumber(deadline) === null ? "" : deadline,
    if_skipped: str(f.if_skipped),
    consequence: CONSEQUENCES.includes(consequence) ? consequence : "",
    affects_others: bool(f.affects_others),
    can_be_undone_later: bool(f.can_be_undone_later),
    effort_minutes: minutes(f.effort_minutes),
    lazy_minimum: str(f.lazy_minimum),
    lazy_minimum_minutes: minutes(f.lazy_minimum_minutes),
    confidence: Math.round(confidence * 100) / 100,
    one_line_reason: str(f.one_line_reason, 200),
  };
}

function whenText(days) {
  if (days === null) return "";
  if (days < 0) return `it was due ${-days} day${days === -1 ? "" : "s"} ago`;
  if (days === 0) return "it's due today";
  if (days === 1) return "it's due tomorrow";
  return `it's due in ${days} days`;
}

/**
 * The whole decision. `today` is "YYYY-MM-DD" in the user's local time.
 * Returns { verdict, emoji, label, reason, lazy_minimum, by_when, rule, safety_override, days_to_deadline, facts }.
 */
export function decide(rawFacts, today = localISODate()) {
  const f = normalizeFacts(rawFacts);
  const days = daysUntil(f.deadline, today);
  const far = days !== null && days > FAR_DAYS;
  const isProtected = PROTECTED.has(f.category);
  // A real minimum takes at least a minute and is cheaper than the whole task ("Attend the class", 0 min, is not one).
  const hasMinimum = f.lazy_minimum !== "" && f.lazy_minimum_minutes >= 1 && f.lazy_minimum_minutes < f.effort_minutes;
  const when = whenText(days);

  const out = (verdict, rule, reason, extra = {}) => ({
    verdict, ...VERDICTS[verdict], rule, reason,
    lazy_minimum: verdict === "lazy" ? f.lazy_minimum : "",
    by_when: "", safety_override: false, days_to_deadline: days, facts: f, ...extra,
  });
  const later = (rule, reason) =>
    out("later", rule, reason, { by_when: far ? addDays(f.deadline, -1) : "" });
  const minimum = (rule, reason) => out("lazy", rule,
    `${reason} The minimum takes ~${f.lazy_minimum_minutes} min instead of ~${f.effort_minutes} min.`);

  // 1. Low confidence: don't pretend.
  if (f.confidence < MIN_CONFIDENCE) {
    return out("unsure", "low_confidence",
      `Gemma is only ${Math.round(f.confidence * 100)}% sure about the facts. Add context or answer the questions.`);
  }
  if (!f.consequence) {
    return out("unsure", "no_consequence", "Gemma couldn't say what happens if you skip it.");
  }

  // 2. Rules by consequence.
  let result;
  switch (f.consequence) {
    case "severe":
      result = out("yes", "severe", `Skipping this has severe consequences${when ? ` and ${when}` : ""}.`);
      break;
    case "serious":
      result = far
        ? later("serious_far", `Serious if skipped, but ${when}, so there's time.`)
        : out("yes", "serious_soon", `Serious if skipped${when ? `, and ${when}` : " and there's no slack"}.`);
      break;
    case "annoying":
      if (hasMinimum) result = minimum("annoying_minimum", "Skipping is annoying, but there's a cheaper way out.");
      else if (far) result = later("annoying_far", `Annoying if skipped, but ${when}.`);
      else if (f.can_be_undone_later && !f.affects_others)
        result = later("annoying_undoable", "Annoying if skipped, but nothing is lost by doing it later.");
      else result = out("yes", "annoying_no_way_out", "Annoying if skipped, and there's no lazier way or later date.");
      break;
    case "minor":
      if (!f.affects_others) result = out("skip", "minor_alone", "Only a minor consequence, and it lands on nobody else.");
      else if (hasMinimum) result = minimum("minor_others_minimum", "Minor, but someone else is affected.");
      else if (far) result = later("minor_others_far", `Minor, but someone else is affected; ${when}.`);
      else result = out("yes", "minor_others", "Minor, but someone else is counting on you.");
      break;
    default: // "nothing"
      result = out("skip", "nothing", "Nothing really happens if you skip it.");
  }

  // 3. Safety override: health, money, legal/official and graded work never get "skip".
  if (result.verdict === "skip" && isProtected) {
    const why = `Safety rule: ${CATEGORY_LABELS[f.category]} tasks never get "skip".`;
    if (hasMinimum) result = minimum("safety_minimum", why);
    else if (far) result = later("safety_later", `${why} ${when[0].toUpperCase()}${when.slice(1)}.`);
    else result = out("yes", "safety_yes", why);
    result.safety_override = true;
  }
  return result;
}

/** Short line for the voice verdict, e.g. "Skip it. At 88 percent, the professor will survive. Court is adjourned." */
export function verdictLine(result) {
  const reason = result.facts.one_line_reason || result.reason;
  const extra = result.verdict === "lazy" && result.lazy_minimum
    ? ` Just: ${result.lazy_minimum.replace(/[.!\s]+$/, "")}.` : "";
  return `${result.label}. ${reason}${/[.!?]$/.test(reason) ? "" : "."}${extra} Court is adjourned.`
    .replace(/%/g, " percent").replace(/\s+/g, " ").slice(0, 300);
}
