// `node --check` every JS file in the repo (CI runs this before the tests).
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(e.name)) files.push(p);
  }
})(".");

let failed = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ["--check", f], { stdio: "pipe" }); console.log(`ok  ${f}`); }
  catch (e) { failed++; console.error(`ERR ${f}\n${e.stderr}`); }
}
process.exit(failed ? 1 : 0);
