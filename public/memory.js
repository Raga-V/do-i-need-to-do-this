// memory.js — "Lazy remembers you": a short list of lasting facts about the user.
// Pure functions only (storage lives in app.js), shared with node tests.
// Facts stay in the browser and are only ever sent to the local Gemma.

export const MAX_FACTS = 30;

const STOP = new Set(("a an the and or but of to in on at for by with from is are was were be been am i my me you your " +
  "it its this that these those has have had do does did not no so as if then than they them their he she his her " +
  "we our us user who which what when where how every each per").split(" "));

/** Content words of a sentence, lowercased, without stopwords or punctuation. */
export function words(text) {
  return String(text || "").toLowerCase().replace(/[^a-z0-9%/ ]+/g, " ").split(/\s+/)
    .filter((w) => w && !STOP.has(w) && (w.length > 2 || /\d/.test(w)));
}

/** Two facts say the same thing if their content words mostly overlap. */
export function sameFact(a, b) {
  const x = new Set(words(a)), y = new Set(words(b));
  if (!x.size || !y.size) return false;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  const jaccard = both / (x.size + y.size - both);
  const containment = both / Math.min(x.size, y.size);
  return jaccard >= 0.6 || containment >= 0.85;
}

/**
 * Only keep a learned fact if it shares real words with what the user actually typed,
 * so Gemma can't "remember" things the user never said.
 */
export function groundedIn(fact, userText) {
  const said = new Set(words(userText));
  return words(fact).some((w) => said.has(w));
}

/**
 * Add new facts to the list, skipping near-duplicates. Newest last; keeps the newest MAX_FACTS.
 * Returns { list, added } where `added` holds the texts that were actually new.
 */
export function mergeFacts(list, incoming, { by = "lazy", now = Date.now() } = {}) {
  const out = [...list];
  const added = [];
  for (const text of incoming) {
    const t = String(text || "").trim().replace(/\s+/g, " ").slice(0, 140);
    if (t.length < 6 || out.some((f) => sameFact(f.text, t))) continue;
    out.push({ id: `${now.toString(36)}-${out.length}`, text: t, by, ts: now });
    added.push(t);
  }
  return { list: out.slice(-MAX_FACTS), added };
}

/** Facts as background sentences for the prompt (each ends with a period so the topic filter can split them). */
export function factsText(list) {
  return list.map((f) => (/[.!?]$/.test(f.text) ? f.text : `${f.text}.`)).join(" ");
}
