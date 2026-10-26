# Copilot instructions for "Do I Need to Do This?"

These are the project's hard rules. Follow them in every suggestion, review and chat answer for this repo.

## How the app works
- Gemma 3 4B runs **locally via Ollama** (`public/gemma.js`). It only (a) decides which questions to ask and (b) extracts facts as JSON through Ollama's `format` schema.
- **The model never picks the verdict.** `decide()` in `public/decide.js` is plain JS rules. Don't move verdict logic into prompts, and don't let model output pick the verdict directly.
- Lazy the couch potato (`public/mascot.js`) is flavour text and moods only; it never changes a verdict.

## Never do
- Never use Gemini, OpenAI or other closed models for reasoning. The core AI is open-weight Gemma via Ollama.
- Never let "skip" through for health, money, legal/official or exam/graded tasks. That rule lives in `decide()` plus the keyword safety net `safetyCategory()`; keep both.
- Never send photos, raw task text or the user's profile to `server.js` or any third party. The server may only receive the one-line verdict (`/api/speak`) and the six numeric/categorical features validated in `public/features.js` (`/api/predict`).
- Never put API keys in the browser. Secrets come from environment variables (`ELEVENLABS_API_KEY`, `SENTRY_DSN`, `TABPFN_TOKEN`) set in Render.
- Never invent results, users or numbers in UI text, README or docs. Show measured values (e.g. Gemma's time on the laptop) or nothing.
- Don't add runtime dependencies to `server.js` (it uses Node 20 built-ins only) or a build step to `public/` (plain ES modules).

## Conventions
- Confidence below 0.5 → "Not sure yet". Code guard rails (quote checks, invented-deadline removal) belong in `gemma.js`, not in prompts alone.
- Build DOM with the `h()` helper in `app.js`; model output must never be inserted as HTML.
- Every server feature must degrade gracefully: missing key → 503 → the UI hides that feature.
- Sentry spans carry only model names, steps, token counts, timings, verdict keys and rule ids, never prompts or replies.

## Before you finish
- `npm run check` (node --check on every file) and `npm test` (node:test) must pass.
- New rules in `decide()` need a test in `test/decide.test.js`; new server routes need one in `test/server.test.js`.
