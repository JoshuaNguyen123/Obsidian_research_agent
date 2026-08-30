import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const NATIVE_DOGFOOD_STAGES = Object.freeze([
  "read_only_chat",
  "grounded_append",
  "sandbox_notebook",
  "restart_resume",
  "supervised_compound",
]);

const STATUS = new Set(["passed", "failed", "blocked", "not_run"]);
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization)/iu;
const SECRET_VALUE = /(?:sk-[A-Za-z0-9_-]{12,}|github_pat_[A-Za-z0-9_]{12,}|gh[opusr]_[A-Za-z0-9_]{12,}|Bearer\s+[A-Za-z0-9._~-]{12,})/u;

/**
 * Validate one visible-UI dogfood receipt. It stores observable outcomes and
 * artifact references, never screenshots, credentials, note bodies, or raw
 * tool results. A blocked pre-run stage may legitimately have no run id.
 */
export function validateNativeDogfoodEvidence(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native dogfood evidence must be an object.");
  }
  rejectSecrets(value);
  if (value.version !== 1) throw new Error("Native dogfood evidence version must be 1.");
  if (!NATIVE_DOGFOOD_STAGES.includes(value.stage)) throw new Error("Unknown native dogfood stage.");
  if (!STATUS.has(value.status)) throw new Error("Unknown native dogfood status.");
  requireText(value.observedAt, "observedAt");
  requireText(value.exactHead, "exactHead");
  requireText(value.bundleProof, "bundleProof");
  requireText(value.windowTitle, "windowTitle");
  requireText(value.prompt, "prompt");
  requireText(value.visibleOutcome, "visibleOutcome");
  if (value.runId !== null && !/^run-/u.test(String(value.runId))) {
    throw new Error("runId must be null or a durable run id.");
  }
  if (value.status === "passed" && value.runId === null) {
    throw new Error("A passed native dogfood mission requires a run id.");
  }
  for (const field of ["receipts", "artifacts", "cleanupResults"]) {
    if (!Array.isArray(value[field]) || value[field].some((item) => typeof item !== "string")) {
      throw new Error(`${field} must be an array of secret-free references.`);
    }
  }
  if (typeof value.approvalBoundary !== "object" || value.approvalBoundary === null) {
    throw new Error("approvalBoundary is required.");
  }
  if (!["not_reached", "paused", "approved", "not_required"].includes(value.approvalBoundary.status)) {
    throw new Error("approvalBoundary.status is invalid.");
  }
  return structuredClone(value);
}

function rejectSecrets(value, pathParts = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSecrets(item, [...pathParts, String(index)]));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) throw new Error(`Secret-bearing field is forbidden: ${[...pathParts, key].join(".")}`);
      rejectSecrets(item, [...pathParts, key]);
    }
    return;
  }
  if (typeof value === "string" && SECRET_VALUE.test(value)) {
    throw new Error(`Secret-like value is forbidden at ${pathParts.join(".")}.`);
  }
}

function requireText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required.`);
}

export function appendNativeDogfoodEvidence(filePath, value) {
  const record = validateNativeDogfoodEvidence(value);
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: "utf8" });
  return record;
}

function option(name) {
  const prefix = `${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length) ?? null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const inputPath = option("--input");
  const outputPath = option("--output") ?? path.join("docs", "eval", "native-dogfood-runs.jsonl");
  if (!inputPath) throw new Error("Usage: node scripts/native-dogfood-evidence.mjs --input=record.json [--output=path]");
  const record = JSON.parse(readFileSync(inputPath, "utf8"));
  appendNativeDogfoodEvidence(path.resolve(outputPath), record);
  process.stdout.write(`Recorded native dogfood evidence in ${outputPath}.\n`);
}
