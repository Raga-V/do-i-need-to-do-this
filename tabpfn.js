// tabpfn.js — server-side client for the Prior Labs TabPFN REST API (https://docs.priorlabs.ai/api-reference).
// Flow: prepare train upload → PUT CSVs to signed URLs → fit → prepare test upload → PUT CSV → predict (probas).
import { FEATURES, toCSV } from "./public/features.js";

const BASE = "https://api.priorlabs.ai";
const MODEL = "v3.5_default";

export class TabPFNError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}

/**
 * Predict the user's personal verdict for `query` from their labelled `rows`.
 * Returns { verdict, probability, probabilities: {label: p} }.
 */
export async function predictPersonalVerdict({ rows, query, token, fetchImpl = globalThis.fetch, base = BASE, timeoutMs = 120000 }) {
  const call = async (path, body) => {
    const res = await fetchImpl(`${base}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text(); // long fits may stream keepalive whitespace before the JSON
    let json = {};
    try { json = JSON.parse(text.trim() || "{}"); } catch { /* keep {} */ }
    if (res.status === 409) return json; // already uploaded: the body carries the id to reuse
    if (!res.ok) throw new TabPFNError(`TabPFN ${path} ${res.status}: ${json.message || text.slice(0, 200)}`, res.status);
    return json;
  };
  const put = async (info, csv) => {
    const res = await fetchImpl(info.signed_urls[0], {
      method: "PUT", headers: info.required_headers || {}, body: csv, signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) throw new TabPFNError(`TabPFN upload ${res.status}`, res.status);
  };

  const xTrain = toCSV(FEATURES, rows.map((r) => r.slice(0, -1)));
  const yTrain = toCSV(["verdict"], rows.map((r) => [r.at(-1)]));
  const xTest = toCSV(FEATURES, [query]);

  const train = await call("/tabpfn/prepare_train_set_upload", { x_train_info: { format: "csv" }, y_train_info: { format: "csv" } });
  if (train.x_train_info?.signed_urls) {
    await put(train.x_train_info, xTrain);
    await put(train.y_train_info, yTrain);
  }
  const fit = await call("/tabpfn/fit", {
    train_set_upload_id: train.train_set_upload_id,
    task_config: { task: "classification", tabpfn_config: { model_path: MODEL } },
  });
  if (fit.status === "failed" || !fit.fitted_train_set_id) throw new TabPFNError("TabPFN fit failed", 502);

  const test = await call("/tabpfn/prepare_test_set_upload", { fitted_train_set_id: fit.fitted_train_set_id, x_test_info: { format: "csv" } });
  if (test.x_test_info?.signed_urls) await put(test.x_test_info, xTest);

  const out = await call("/tabpfn/predict", {
    test_set_upload_id: test.test_set_upload_id,
    fitted_train_set_id: fit.fitted_train_set_id,
    task_config: { task: "classification", predict_params: { output_type: "probas" } },
  });
  return readProbabilities(out, rows);
}

/**
 * The docs allow `prediction` to be rows×classes, a single row, or an object keyed by class.
 * Class order comes from metadata.classes, falling back to sorted labels (scikit-learn's order).
 */
export function readProbabilities(out, rows) {
  const classes = out?.metadata?.classes?.map(String) || [...new Set(rows.map((r) => r.at(-1)))].sort();
  let p = out?.prediction;
  let probabilities = {};
  if (Array.isArray(p)) {
    const row = Array.isArray(p[0]) ? p[0] : p;
    if (row.length !== classes.length || row.some((v) => typeof v !== "number")) throw new TabPFNError("Unexpected TabPFN prediction shape", 502);
    classes.forEach((c, i) => { probabilities[c] = row[i]; });
  } else if (p && typeof p === "object") {
    for (const [k, v] of Object.entries(p)) probabilities[k] = Array.isArray(v) ? v[0] : v;
  } else {
    throw new TabPFNError("TabPFN returned no prediction", 502);
  }
  const [verdict, probability] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0];
  return { verdict, probability, probabilities };
}
