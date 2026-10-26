// Writes Lazy's moods to docs/images/lazy-<mood>.svg for the README (the app itself draws them inline).
// Run after changing public/mascot.js:  node scripts/export-mascot.mjs
import { writeFileSync, mkdirSync } from "node:fs";
import { lazy } from "../public/mascot.js";

const MOODS = ["chill", "thinking", "skip", "min", "later", "do", "unsure"];
mkdirSync("docs/images", { recursive: true });
for (const mood of MOODS) writeFileSync(`docs/images/lazy-${mood}.svg`, `${lazy(mood, 240)}\n`);
console.log(`wrote ${MOODS.length} moods to docs/images/`);
