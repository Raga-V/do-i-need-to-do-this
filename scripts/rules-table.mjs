// Print a Markdown table of what decide() rules for common situations (CI writes it into the job summary).
//   node scripts/rules-table.mjs >> "$GITHUB_STEP_SUMMARY"
import { decide, addDays, CONSEQUENCES } from "../public/decide.js";

const today = "2026-01-15";
const base = { category: "chores", deadline: "", consequence: "minor", affects_others: false, can_be_undone_later: false,
  effort_minutes: 60, lazy_minimum: "", lazy_minimum_minutes: 0, confidence: 0.9, one_line_reason: "" };
const columns = [
  ["no deadline", {}],
  ["due in 2 days", { deadline: addDays(today, 2) }],
  ["due in 10 days", { deadline: addDays(today, 10) }],
  ["affects others", { affects_others: true }],
  ["5-min minimum exists", { lazy_minimum: "the tiny version", lazy_minimum_minutes: 5 }],
  ["money task", { category: "money" }],
  ["confidence 0.4", { confidence: 0.4 }],
];
const cell = (r) => `${r.emoji} ${r.label}${r.safety_override ? " 🛡️" : ""}`;
const lines = [
  "### ⚖️ What the court rules (live from `decide()`)",
  "",
  `| consequence | ${columns.map(([c]) => c).join(" | ")} |`,
  `|---|${columns.map(() => "---").join("|")}|`,
  ...CONSEQUENCES.map((c) => `| **${c}** | ${columns.map(([, over]) => cell(decide({ ...base, consequence: c, ...over }, today))).join(" | ")} |`),
  "",
  "🛡️ = safety override: health, money, legal/official and graded work never get *skip*.",
];
console.log(lines.join("\n"));
