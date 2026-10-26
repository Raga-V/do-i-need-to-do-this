// sentry.js — optional Sentry tracing for the Gemma calls (browser SDK from the CDN).
// Loaded only when the server's /api/config returns a DSN.
// Privacy: spans carry model name, step, token counts and timings. Never prompts, replies, photos or task text.

const SRC = "https://browser.sentry-cdn.com/11.9.0/bundle.tracing.min.js";
const INTEGRITY = "sha384-cpMO6Dm2uco5jrSeSdsOuINfaahIkSnKggH/HUa3fvjv4pqg0Ps+c7LPK6/ZF1wL";
const AGENT = "do-i-need-to-do-this";

function loadScript() {
  return new Promise((resolve, reject) => {
    const s = Object.assign(document.createElement("script"), { src: SRC, integrity: INTEGRITY, crossOrigin: "anonymous", async: true });
    s.onload = resolve;
    s.onerror = () => reject(new Error("Sentry SDK failed to load"));
    document.head.append(s);
  });
}

/** Error messages can quote model output (e.g. JSON.parse snippets), so cut them at the first quote. */
function scrub(message) {
  return String(message || "").split(/["'`]/)[0].trim().slice(0, 200);
}

/** Install Sentry and plug it into the app's hooks. Resolves false if there's no DSN or the SDK can't load. */
export async function setupSentry({ sentryDsn, sentryEnvironment }, hooks) {
  if (!sentryDsn) return false;
  try { await loadScript(); } catch (e) { console.warn(e.message); return false; }
  const Sentry = window.Sentry;
  Sentry.init({
    dsn: sentryDsn,
    environment: sentryEnvironment || "production",
    integrations: [Sentry.browserTracingIntegration()],
    tracesSampleRate: 1.0,
    // Ollama is called straight from the browser; don't add tracing headers to it (it would trigger CORS preflights).
    tracePropagationTargets: [/^\/api\//],
    sendDefaultPii: false,
    // Console and click breadcrumbs could contain what the user typed; keep only network/navigation ones.
    beforeBreadcrumb: (b) => (b.category === "console" || b.category?.startsWith("ui.") ? null : b),
  });

  // One trace per phase: an "agent" root span with one gen_ai.chat span per Gemma call inside it.
  // It must be a root (not a child of the pageload span), or the pageload's idle timeout ends the Gemma spans early.
  hooks.agent = (phase, fn) => Sentry.withActiveSpan(null, () => Sentry.startNewTrace(() => Sentry.startSpan({
    op: "gen_ai.invoke_agent", name: `invoke_agent ${AGENT}`, forceTransaction: true,
    attributes: { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": AGENT, "app.phase": phase },
  }, fn)));

  hooks.trace = (step, { model, attempt }, fn) => Sentry.startSpan({
    op: "gen_ai.chat", name: `chat ${model}`,
    attributes: {
      "gen_ai.operation.name": "chat",
      "gen_ai.provider.name": "ollama",
      "gen_ai.system": "ollama",
      "gen_ai.request.model": model,
      "gen_ai.agent.name": AGENT,
      "step": step,               // photo | questions | facts
      "attempt": attempt,         // 2 = retry after malformed JSON
    },
  }, async (span) => {
    const t0 = performance.now();
    try {
      return await fn(span);      // gemma.js sets gen_ai.usage.input_tokens / output_tokens from prompt_eval_count / eval_count
    } catch (e) {
      span.setStatus({ code: 2, message: e.code || "error" });
      throw e;
    } finally {
      span.setAttribute("latency_ms", Math.round(performance.now() - t0));
    }
  });

  hooks.reportError = (err, ctx = {}) => {
    if (err?.name === "AbortError") return;
    const safe = new Error(err?.code ? `${err.name || "Error"} (${err.code})` : scrub(err?.message));
    safe.name = err?.name || "Error";
    Sentry.captureException(safe, {
      tags: { step: ctx.step || ctx.phase || "app", attempt: ctx.attempt, code: err?.code },
      extra: { reply_chars: typeof ctx.content === "string" ? ctx.content.length : undefined },
    });
  };

  hooks.annotate = (attrs) => Sentry.getActiveSpan()?.setAttributes(attrs);

  // decide() is the agent's tool: the rules that turn Gemma's facts into a verdict.
  // Its input is only categorical/numeric facts (no sentences), its output the verdict and the rule that fired.
  hooks.tool = (name, input, fn) => Sentry.startSpan({
    op: "gen_ai.execute_tool", name: `execute_tool ${name}`,
    attributes: {
      "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": name, "gen_ai.agent.name": AGENT,
      "gen_ai.tool.description": "Plain JS rules: Gemma's facts in, verdict out. Safety rules can't be overridden.",
      "gen_ai.tool.input": JSON.stringify(input),
    },
  }, (span) => {
    const out = fn();
    span.setAttributes({
      "gen_ai.tool.output": JSON.stringify({ verdict: out.verdict, rule: out.rule, safety_override: out.safety_override }),
      "app.verdict": out.verdict, "app.rule": out.rule,
    });
    return out;
  });

  // Partner calls (ElevenLabs voice, TabPFN prediction) as their own small traces.
  hooks.span = (op, name, attributes, fn) =>
    Sentry.withActiveSpan(null, () => Sentry.startSpan({ op, name, attributes, forceTransaction: true }, fn));

  // When someone disagrees with the court, that's the most useful signal for tuning the rules.
  // Only the two verdict keys and the rule id are sent; never the task.
  hooks.feedback = ({ ai, user, rule }) => {
    const message = `Court said "${ai}" (rule ${rule}); the user would "${user}".`;
    if (Sentry.captureFeedback) Sentry.captureFeedback({ message }, { includeReplay: false, captureContext: { tags: { ai_verdict: ai, user_verdict: user, rule } } });
    else Sentry.captureMessage(message, { level: "info", tags: { ai_verdict: ai, user_verdict: user, rule } });
  };
  return true;
}
