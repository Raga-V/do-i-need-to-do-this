// features.js — the ONLY data that goes to TabPFN: six numeric/categorical features + the user's own verdict.
// Shared by the browser (to build the payload) and the server (to validate it). No text, ever.
import { CATEGORIES, CONSEQUENCES, VERDICT_KEYS } from "./decide.js";

export const FEATURES = ["category", "consequence", "days_to_deadline", "affects_others", "can_be_undone_later", "effort_minutes"];
export const MIN_LABELLED_ROWS = 10;
export const MAX_ROWS = 300;

/** One verdict (history row or decide() result facts) → [category, consequence, days|null, 0/1, 0/1, minutes]. */
export function featureRow(r) {
  return [
    r.category,
    r.consequence,
    Number.isFinite(r.days_to_deadline) ? r.days_to_deadline : null,
    r.affects_others ? 1 : 0,
    r.can_be_undone_later ? 1 : 0,
    Math.round(r.effort_minutes || 0),
  ];
}

/** History rows the user labelled themselves → [...features, label], most recent MAX_ROWS. */
export function trainingRows(history) {
  return history.filter((r) => r.user_verdict && VERDICT_KEYS.includes(r.user_verdict) && r.consequence)
    .slice(0, MAX_ROWS)
    .map((r) => [...featureRow(r), r.user_verdict]);
}

/** Strict check used by the server: anything that isn't exactly these typed values is rejected. */
export function validFeatureRow(x) {
  return Array.isArray(x) && x.length === FEATURES.length &&
    CATEGORIES.includes(x[0]) && CONSEQUENCES.includes(x[1]) &&
    (x[2] === null || (Number.isInteger(x[2]) && Math.abs(x[2]) <= 3650)) &&
    (x[3] === 0 || x[3] === 1) && (x[4] === 0 || x[4] === 1) &&
    Number.isInteger(x[5]) && x[5] >= 0 && x[5] <= 100000;
}
export function validTrainingRow(x) {
  return Array.isArray(x) && x.length === FEATURES.length + 1 &&
    validFeatureRow(x.slice(0, -1)) && VERDICT_KEYS.includes(x.at(-1));
}

/** CSV the way TabPFN reads it: header + one row per sample; null → empty cell (missing value). */
export function toCSV(header, rows) {
  return [header.join(","), ...rows.map((r) => r.map((v) => (v === null ? "" : String(v))).join(","))].join("\n") + "\n";
}
