// Repeat-green proof matrix over the six daily-mission lanes.
//
// Purpose: replace "one successful specimen" with consecutive-green evidence at
// one exact HEAD. Each cell is one lane run through the sanctioned exclusive
// runner (scripts/run-e2e-exclusive.mjs); a cell is DONE when it has recorded
// the required number of CONSECUTIVE greens (a real red resets the streak).
// Harness/process deaths (harness:*, process:*) are recorded for visibility
// but neither spend attempt budget nor reset the streak — they measure the
// harness, not the product; more than MAX_CONSECUTIVE_HARNESS_FAILURES of
// them in a row for one cell aborts the campaign instead of looping. The
// campaign fails fast when any `product:` failure class is seen twice — that is
// a regression alarm, not a statistic. A lane that refuses to start because a
// variable it requires is unset is `environment_not_configured`: terminal for
// the cell, budget-exempt, and stamped `not_run` in the manifest — it is not a
// red, because the product was never exercised (see that class below). The
// mirror case is `harness:cleanup_failed`: every product assertion PASSED and
// only mandatory harness teardown failed. Loud, still a failed run, still
// counted by the harness-failure valve — but budget-exempt, streak-neutral and
// written to no run-metrics row, because the product succeeded.
//
// Environment (PowerShell only — Git Bash mangles AGENTIC_SANDBOX_CI_RUNTIME_ROOT):
//   PROOF_MATRIX_EXPECTED_HEAD   exact 40-char lowercase sha this campaign pins
//   E2E_OLLAMA_API_KEY           real-model credential (cloud API)
//   LINEAR_LIVE_TEST_TEAM_ID     required by Linear-exercising lanes
//   E2E_GITHUB_TOKEN             required by GitHub-exercising lanes
// The model defaults to deepseek-v4-pro and can be pinned explicitly with
// --model=<exact-tag>. E2E_AI_MODEL is still ignored: campaign identity must
// come from the command recorded in the manifest, not ambient process state.
//
// Usage:
//   node scripts/run-proof-matrix.mjs [--model=exact-tag] [--cells=a,b]
//                                     [--dry-run] [--resume]
//                                     [--allow-preexisting-workspaces]
//
// Evidence duties handled per attempt (previously hand-maintained):
//   - one row appended to docs/eval/playwright-run-metrics.csv
//   - per-attempt tool-event counts mined from the vault's persisted mission
//     graphs (same node vocabulary as scripts/eval-tool-events.mjs)
//   - manifest accumulated at proof-matrix-state/proof-matrix-manifest.json
//
// Durable state lives OUTSIDE test-results/ on purpose: Playwright wipes
// test-results/ at the start of every attempt, which on 2026-08-25 deleted
// attempt logs mid-write and made --resume silently restart a campaign from
// zero after a mid-attempt runner death (the manifest was only rewritten
// after each attempt). proof-matrix-state/ is gitignored, survives Playwright,
// and every manifest write is temp-then-rename so a kill never tears it.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { nullableCount } from "./honest-counts.mjs";
import { sweepTestVaultObsidianZombiesV1 } from "./e2e-obsidian-campaign-sweep.mjs";
import {
  ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
  isInfrastructureFailureClass,
  measuresProduct,
} from "./product-evidence.mjs";
import {
  evaluateReliabilityCampaign,
  hasGreenAcceptanceProof,
  resolveReliabilityGate,
} from "./reliability-campaign.mjs";

// Re-exported so this script stays the campaign's single entry point while the
// DEFINITION lives in scripts/product-evidence.mjs — the same module every eval
// reader consumes, so the writer's exclusion rule and the readers' pass-rate
// denominators cannot drift apart.
export { ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS, isInfrastructureFailureClass };

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVAL_DIR = path.join(REPO_ROOT, "docs", "eval");
const RUN_CSV = path.join(EVAL_DIR, "playwright-run-metrics.csv");
/**
 * Repo-root state dir (gitignored) for everything the campaign must not lose
 * when Playwright wipes test-results/: the manifest and per-attempt logs.
 * Supersedes the interim docs/eval/proof-matrix-logs location (8c72421).
 */
export const PROOF_MATRIX_STATE_RELATIVE_DIR = "proof-matrix-state";
export const PROOF_MATRIX_MANIFEST_RELATIVE_PATH = `${PROOF_MATRIX_STATE_RELATIVE_DIR}/proof-matrix-manifest.json`;
export const PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR = `${PROOF_MATRIX_STATE_RELATIVE_DIR}/logs`;
/** Pre-2026-08-25 manifest location, inside the wiped tree; migrated on load. */
export const LEGACY_MANIFEST_RELATIVE_PATH = "test-results/proof-matrix-manifest.json";
const MANIFEST_PATH = path.join(REPO_ROOT, ...PROOF_MATRIX_MANIFEST_RELATIVE_PATH.split("/"));
export const ATTEMPT_LOG_DIR = path.join(REPO_ROOT, ...PROOF_MATRIX_ATTEMPT_LOG_RELATIVE_DIR.split("/"));
const LEGACY_MANIFEST_PATH = path.join(REPO_ROOT, ...LEGACY_MANIFEST_RELATIVE_PATH.split("/"));
const PLAYWRIGHT_EXECUTION_REPORT_PATH = path.join(
  REPO_ROOT,
  "test-results",
  "playwright-execution-report.json",
);
const RUN_SUMMARY_PATH = path.join(REPO_ROOT, "test-results", "daily-use-run-summary.json");
const SCORECARD_BASELINE_PATH = path.join(REPO_ROOT, "e2e", "baselines", "mission-scorecards.v1.json");
// Graph mining honors OBSIDIAN_VAULT (the same env the exclusive runner and
// vault sync honor) before the hardcoded default vault: a campaign pointed at
// a different vault must mine THAT vault's persisted graphs, not the stale
// default one.
const VAULT_ROOT =
  process.env.OBSIDIAN_VAULT?.trim() ||
  path.join(
    process.env.USERPROFILE ?? "",
    "OneDrive",
    "Desktop",
    "test_vault_obsidian_ai",
  );
const GRAPH_DIR = path.join(VAULT_ROOT, "Agent Runs", "Mission Graphs");
const WORKSPACES_ROOT = path.join(
  process.env.LOCALAPPDATA ?? "",
  "AgenticResearcher",
  "code",
  "workspaces-v2",
);

export const DEFAULT_PROOF_MATRIX_MODEL = "deepseek-v4-pro";
export const ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS =
  "harness:acceptance_proof_missing";

export function resolveProofMatrixModel(args = process.argv.slice(2)) {
  const modelArgs = args.filter((argument) => argument.startsWith("--model="));
  if (modelArgs.length > 1) {
    throw new Error("proof-matrix: --model may be specified only once.");
  }
  if (modelArgs.length === 0) return DEFAULT_PROOF_MATRIX_MODEL;
  const model = modelArgs[0].slice("--model=".length).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/u.test(model)) {
    throw new Error("proof-matrix: --model requires one bounded exact model tag.");
  }
  return model;
}

export const PROOF_MATRIX_MODEL = resolveProofMatrixModel();

/**
 * The pre-2026-08-25 header. New columns are APPENDED only — readers index by
 * header name and existing rows must keep their positions forever.
 */
export const LEGACY_RUN_CSV_HEADER =
  "run_started_at,lane,model,head_sha,duration_s,mission_outcome,primary_failure_class," +
  "primary_failure_detail,tool_events_observed,tool_events_failed,pct_tool_calls_failed," +
  "tool_not_allowed,mission_graph_authority_blocked,invalid_arguments,execution_failed," +
  "authority_grant_invalid,tool_failure_terminal,data_source,notes";

/**
 * Appended columns (2026-08-25, success/uncertainty wave):
 *   tool_events_source          summary|graphs|none — which source produced the
 *                               tool-event columns. "summary" = the attempt's
 *                               fresh daily-use run summary; "graphs" = mined
 *                               persisted mission graphs; "none" = no source
 *                               (blank counts mean UNKNOWN, never zero).
 *   tool_calls_succeeded        observed - failed - (vacuous when known);
 *                               blank when failed is unknown.
 *   pct_tool_calls_succeeded    complement of the failed pct; blank when unknown.
 *   secondary_failure_classes   semicolon-joined extra failure classes that
 *                               ALSO matched this attempt (a failure can have
 *                               more than one cause).
 *   classification_confidence   confirmed|mechanical|unclassified.
 *   tool_calls_vacuous          "called but did no work" count; blank = unknown
 *                               (graph mining cannot see receipts; only fresh
 *                               summaries with receipt-counting specs know).
 * Rows written before this wave are shorter than the header — readers must
 * treat the missing cells as blank/unknown.
 *
 * Appended (2026-08-26, off-frontier gate wave):
 *   frontier_narrowed_mid_response
 *                               HOST-caused off-frontier refusals: the tool was
 *                               on the menu the model answered, and AgentRunner
 *                               rebuilt the menu after an earlier call in the
 *                               same response. Split out of tool_not_allowed,
 *                               which means the opposite ("the model named a
 *                               tool it was never offered"). It is APPENDED
 *                               rather than slotted beside the other bucket
 *                               columns because every existing row indexes the
 *                               legacy block by position.
 *   frontier_withheld_since_earlier_step
 *                               HOST-caused off-frontier refusals of a tool the
 *                               run offered in an EARLIER step and withheld
 *                               since. Also split out of tool_not_allowed; the
 *                               model was pursuing a name it had been taught.
 */
export const RUN_CSV_HEADER =
  LEGACY_RUN_CSV_HEADER +
  ",tool_events_source,tool_calls_succeeded,pct_tool_calls_succeeded," +
  "secondary_failure_classes,classification_confidence,tool_calls_vacuous," +
  "frontier_narrowed_mid_response,frontier_withheld_since_earlier_step," +
  "harness_outcome,acceptance_status,scorecard_total,scorecard_acceptance_passed," +
  "retries,artifact_proof_count,cleanup_proof_count," +
  // Appended 2026-09-03 (cost/latency instruments): all four come from the
  // attempt's fresh daily-use summary and are BLANK when the lane did not
  // annotate them — blank is unknown, never zero.
  //   model_calls              provider calls the lane counted
  //   reported_tokens          provider-reported prompt+completion tokens
  //   cached_prompt_tokens     provider-reported cached prompt tokens
  //   prompt_prefix_reuse_avg  mean per-step prompt-prefix reuse ratio (0..1)
  "model_calls,reported_tokens,cached_prompt_tokens,prompt_prefix_reuse_avg";

/**
 * Upgrade an existing CSV's header line in place when it is a strict
 * column-prefix of the current header (an older schema). Data rows are left
 * byte-for-byte untouched — they simply stay shorter than the new header,
 * which name-indexing readers already tolerate. Returns the upgraded text,
 * or null when nothing should change (already current, unrecognized header,
 * or empty file).
 */
export function upgradeRunCsvHeader(text, header = RUN_CSV_HEADER) {
  if (typeof text !== "string" || text === "") return null;
  const newlineIndex = text.search(/\r?\n/u);
  const firstLine = newlineIndex === -1 ? text : text.slice(0, newlineIndex);
  if (firstLine === header) return null;
  if (!header.startsWith(`${firstLine},`)) return null;
  const rest = newlineIndex === -1 ? "\n" : text.slice(newlineIndex);
  return header + rest;
}

/**
 * The six mission cells. `requiredGreens` are CONSECUTIVE; `maxAttempts`
 * bounds total spend per cell. Grep filters follow the audit's stage-6
 * precedent of pinning one scenario inside a larger spec.
 */
export const CELLS = [
  {
    id: "research-current-note",
    project: "daily-use-research",
    scenarioId: "DU-02",
    grep: "DU-02 proof-gated sourced writeback binds owned fetched passages",
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "vault-recall",
    project: "real-ai-soak",
    scenarioId: "VAULT-01",
    grep: "deep vault retrieval and semantic expansion",
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "code-delivery",
    project: "desktop-code-delivery-real-live",
    scenarioId: "CODE-DELIVERY-01",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "interrupted-continuation",
    project: "interrupted-continuation-live",
    scenarioId: "INTERRUPT-01",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "notebook-execution",
    project: "notebook-execution-live",
    scenarioId: "NOTEBOOK-01",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "compound-linear-github",
    project: "compound-flow-real-live",
    scenarioId: "FLOW-REAL-01",
    grep: null,
    requiredGreens: 3,
    maxAttempts: 5,
  },
];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.slice(name.length + 1) : null;
};

function fail(message) {
  console.error(`proof-matrix: ${message}`);
  process.exit(1);
}

export function normalizeGitCommandOutput(output, { preserveLeading = false } = {}) {
  const text = typeof output === "string" ? output : "";
  return preserveLeading ? text.trimEnd() : text.trim();
}

function git(args, options = {}) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
  return normalizeGitCommandOutput(result.stdout, options);
}

export const SCORECARD_BASELINE_RELATIVE_PATH =
  "e2e/baselines/mission-scorecards.v1.json";

/**
 * First-green harvest rewrites the tracked baseline. That must not fail the
 * exact-HEAD pin: the SHA names the plugin source, and harvest is an allowed
 * working-tree update of this one file.
 */
export function porcelainWithoutAllowedHarvest(status) {
  const text = typeof status === "string" ? status : "";
  return text
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== "")
    .filter((line) => {
      const path = line.slice(3).replaceAll("\\", "/");
      return path !== SCORECARD_BASELINE_RELATIVE_PATH;
    })
    .join("\n");
}

/** Exact-HEAD invariant, before and after every attempt (audit precedent). */
function assertExactCleanHead(expectedHead, stage) {
  const head = git(["rev-parse", "HEAD"]);
  if (head !== expectedHead) {
    fail(`${stage}: HEAD ${head} != pinned ${expectedHead}; the campaign's evidence would be unattributable.`);
  }
  const status = porcelainWithoutAllowedHarvest(
    git(
      ["status", "--porcelain=v1", "--untracked-files=all"],
      { preserveLeading: true },
    ),
  );
  if (status !== "") {
    fail(`${stage}: working tree not clean:\n${status}`);
  }
}

/**
 * Kill leaked test-vault Obsidian processes between cells.
 *
 * The sweep body now lives in scripts/e2e-obsidian-campaign-sweep.mjs (over the
 * shared CommonJS core in scripts/e2e-obsidian-sweep.js) and is shared
 * with run-workflow-audit-e2e.mjs. The previously duplicated copies selected
 * by command-line vault match and force-killed with `Stop-Process -Force`,
 * with NO consultation of the exclusive e2e lock — and they ran here in the
 * campaign PARENT, before the child runner acquires that lock. A campaign
 * starting while another session's lane was mid-mission therefore force-killed
 * that lane's live Obsidian, producing exit 4294967295 with no Windows Error
 * Reporting event and no crash dump: the "silent host death". The shared
 * helper defers to a live lock holder and journals every decision.
 */
async function sweepTestVaultObsidianZombies(stage, sinceMs = 0) {
  return sweepTestVaultObsidianZombiesV1({
    stage: `proof-matrix[${stage}]`,
    env: process.env,
    repoRoot: REPO_ROOT,
    sinceMs,
  });
}

/**
 * How long to let campaign-owned Obsidian residue finish dying before giving up
 * on the attempt slot.
 *
 * A root that taskkill reports as already terminating cannot be reaped by any
 * kill — the 2026-08-27 campaign's PID 25596 shrugged off six force-kills over
 * 5.5 minutes and then exited on its own. Waiting is the ONLY remediation for
 * that state, so the matrix waits here instead of launching attempts into a
 * machine it knows is dirty: attempts 4 and 5 of that campaign each spent
 * ~150s starting up only to be refused by the already-running gate, and four
 * consecutive infrastructure reds put the cell two away from the
 * MAX_CONSECUTIVE_HARNESS_FAILURES abort valve.
 */
const OBSIDIAN_RESIDUE_DRAIN_MS = Number.parseInt(
  process.env.PROOF_MATRIX_RESIDUE_DRAIN_MS ?? "300000",
  10,
);
const OBSIDIAN_RESIDUE_POLL_MS = 5_000;

/**
 * Wait for campaign-owned Obsidian residue to drain, re-sweeping as we go.
 *
 * Returns the PIDs still present when the budget ran out — empty means the
 * machine is clean and the attempt may proceed.
 */
async function drainCampaignObsidianResidue(stage, sinceMs, initial) {
  let residual = initial?.residualPids ?? [];
  if (residual.length === 0 && initial?.enumerationOk !== false) return [];
  const deadline = Date.now() + Math.max(0, OBSIDIAN_RESIDUE_DRAIN_MS);
  console.log(
    `proof-matrix[${stage}]: campaign-owned Obsidian residue ${residual.join(", ") || "(unknown)"} ` +
    `is still present; waiting up to ${Math.round(OBSIDIAN_RESIDUE_DRAIN_MS / 1000)}s for it to drain ` +
    "rather than starting an attempt the already-running gate will refuse.",
  );
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, OBSIDIAN_RESIDUE_POLL_MS));
    const swept = await sweepTestVaultObsidianZombies(`${stage} residue-drain`, sinceMs);
    residual = swept.residualPids ?? [];
    // An enumeration we could not perform proves nothing; keep waiting rather
    // than reading "we could not look" as "the machine is clean".
    if (residual.length === 0 && swept.enumerationOk !== false) {
      console.log(`proof-matrix[${stage}]: residue drained; the attempt may proceed.`);
      return [];
    }
  }
  return residual.length > 0 ? residual : [-1];
}

function listWorkspaceEntries() {
  try {
    return readdirSync(WORKSPACES_ROOT);
  } catch {
    return [];
  }
}

/**
 * Failed code lanes leave model-named workspaces the owned-residue cleanup
 * deliberately refuses to delete (real user workspaces share the root). The
 * matrix may delete only debris that APPEARED during its own cell window —
 * time-scoped ownership. Anything predating the campaign is surfaced, never
 * touched.
 */
function removeCampaignWorkspaceDebris(before, stage) {
  const after = listWorkspaceEntries();
  const debris = after.filter((name) => !before.includes(name));
  for (const name of debris) {
    const target = path.join(WORKSPACES_ROOT, name);
    const result = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        `Remove-Item -LiteralPath '${target.replace(/'/g, "''")}' -Recurse -Force -ErrorAction SilentlyContinue`],
      { encoding: "utf8", timeout: 60_000, windowsHide: true },
    );
    console.log(
      `proof-matrix[${stage}]: removed campaign workspace debris '${name}'` +
      (result.status === 0 ? "" : " (best-effort)"),
    );
  }
}

function runTimestampMs(missionId) {
  const match = /run-(\d{4}-\d{2}-\d{2})[tT](\d{2})-(\d{2})-(\d{2})\.(\d{3})[zZ]/.exec(missionId);
  if (!match) return NaN;
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`);
}

// Must stay key-for-key with TOOL_REFUSAL_MARKER_BUCKETS in
// e2e/reporters/dailyUseReporter.ts, or graph-mined and summary-sourced rows
// in docs/eval/playwright-run-metrics.csv stop being comparable.
// tests/proofMatrix.test.ts asserts the two lists agree.
export const BLOCKER_BUCKETS = [
  ["tool_not_allowed", /tool_not_allowed/iu],
  ["frontier_narrowed_mid_response", /frontier_narrowed_mid_response/iu],
  ["frontier_withheld_since_earlier_step", /frontier_withheld_since_earlier_step/iu],
  ["mission_graph_authority_blocked", /mission_graph_authority_blocked/iu],
  ["invalid_arguments", /invalid_argument/iu],
  ["execution_failed", /execution_failed/iu],
  ["authority_grant_invalid", /authority_grant_invalid/iu],
  ["tool_failure_terminal", /tool_failure_(terminal|repeated)/iu],
];

/**
 * Mine per-tool outcomes for one attempt from the vault's persisted mission
 * graphs (same node vocabulary as scripts/eval-tool-events.mjs, filtered to
 * this attempt's wall-clock window so serialized same-model cells attribute
 * exactly instead of via the 45-minute nearest-row heuristic).
 */
export function mineToolEvents(windowStartMs, windowEndMs) {
  const counts = {
    observed: 0,
    failed: 0,
    buckets: Object.fromEntries(BLOCKER_BUCKETS.map(([key]) => [key, 0])),
  };
  let files = [];
  try {
    files = readdirSync(GRAPH_DIR).filter((name) => name.endsWith(".md"));
  } catch {
    return counts;
  }
  for (const name of files) {
    const full = path.join(GRAPH_DIR, name);
    let data;
    try {
      const mtime = statSync(full).mtimeMs;
      if (mtime < windowStartMs - 60_000 || mtime > windowEndMs + 60_000) continue;
      const text = readFileSync(full, "utf8");
      data = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
    } catch {
      continue;
    }
    const missionMs = runTimestampMs(data.missionId ?? name);
    if (Number.isFinite(missionMs) && (missionMs < windowStartMs - 60_000 || missionMs > windowEndMs + 60_000)) {
      continue;
    }
    for (const node of Object.values(data.graph?.nodes ?? {})) {
      const tool = (node.allowedTools ?? [])[0];
      if (!tool) continue;
      const status = node.status ?? "";
      if (status === "cancelled" || status === "queued" || status === "ready") continue;
      counts.observed += 1;
      if (status !== "complete") counts.failed += 1;
      const blocker = node.blocker ? String(node.blocker.reason ?? node.blocker) : "";
      for (const [key, pattern] of BLOCKER_BUCKETS) {
        if (pattern.test(blocker)) counts.buckets[key] += 1;
      }
    }
  }
  return counts;
}

export const TOOL_EVENT_SOURCE_SUMMARY = "summary";
export const TOOL_EVENT_SOURCE_GRAPHS = "graphs";
export const TOOL_EVENT_SOURCE_NONE = "none";

function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}
// nullableCount is imported from ./honest-counts.mjs — the one shared seat for
// unknown-preserving count arithmetic. Do not re-inline it here.

/**
 * Sum the tool-call counters across a daily-use run summary's records. The
 * caller guarantees freshness (the summary was written during THIS attempt),
 * so every record belongs to the attempt window. Failed and vacuous sums are
 * nullable: null when NO record knew its count (unknown ≠ zero); a number
 * when at least one did (an explicit lower bound). Returns null when the
 * summary has no records to speak for the attempt.
 */
export function summaryToolEventTotals(summary) {
  const records = Array.isArray(summary?.records) ? summary.records : null;
  if (!records || records.length === 0) return null;
  const totals = {
    // Nullable: null when NO record knew a real call count. A record without
    // counters (a lane that annotated nothing) contributes UNKNOWN, not zero.
    // The folded per-call count (toolCallsAttempted, from
    // e2e/fixtures/toolCallOutcomes.ts) outranks the legacy DU-acceptance
    // counter (toolCalls), which specs feed from missionEvidence lengths.
    observed: null,
    failed: null,
    vacuous: null,
    intentionalNoOp: null,
    // Calls that started and never terminated. Tracked apart so the success
    // formula below cannot score them as successes: `observed - failed` would
    // do exactly that for an interrupted run.
    undetermined: null,
    // Only keys some record actually contributed are present; an absent key is
    // UNKNOWN and prints blank. The previous all-keys-at-0 seed printed six
    // fabricated refusal zeros on EVERY summary-sourced CSV row. A record whose
    // buckets came from a complete fold contributes all keys with explicit
    // zeros, so those rows still make the whole vocabulary known.
    buckets: null,
    // Content-free failed-call identity from the shared collector. The
    // reporter carries this inside toolCallOutcomes, so it survives the
    // passing lane's mandatory cleanup that deletes run-owned graphs.
    failureDetails: null,
    failureDetailsTruncated: null,
  };
  for (const record of records) {
    const observed =
      nullableCount(record?.toolCallsAttempted) ??
      nullableCount(record?.toolCalls);
    if (observed !== null) totals.observed = (totals.observed ?? 0) + observed;
    const failed = nullableCount(record?.toolCallsFailed);
    if (failed !== null) totals.failed = (totals.failed ?? 0) + failed;
    const vacuous = nullableCount(record?.toolCallsVacuous);
    if (vacuous !== null) totals.vacuous = (totals.vacuous ?? 0) + vacuous;
    // Intentional no-ops (commitKind no_op/reconciled) are correct behavior:
    // tracked, but NEVER subtracted from succeeded like vacuous calls are.
    const noOp = nullableCount(record?.toolCallsIntentionalNoOp);
    if (noOp !== null) totals.intentionalNoOp = (totals.intentionalNoOp ?? 0) + noOp;
    const undetermined = nullableCount(record?.toolCallsUndetermined);
    if (undetermined !== null) {
      totals.undetermined = (totals.undetermined ?? 0) + undetermined;
    }
    const buckets = record?.refusalBuckets;
    if (buckets && typeof buckets === "object") {
      // Vocabulary-restricted: keys outside BLOCKER_BUCKETS stay dropped.
      for (const [key] of BLOCKER_BUCKETS) {
        const parsed = nullableCount(buckets[key]);
        if (parsed !== null) {
          totals.buckets ??= {};
          totals.buckets[key] = (totals.buckets[key] ?? 0) + parsed;
        }
      }
    }
    const failureDetails = record?.toolCallOutcomes?.failureDetails;
    if (Array.isArray(failureDetails)) {
      totals.failureDetails ??= [];
      for (const detail of failureDetails) {
        if (
          !detail ||
          typeof detail !== "object" ||
          typeof detail.id !== "string" ||
          detail.id.length === 0 ||
          !(
            detail.toolName === null ||
            typeof detail.toolName === "string"
          ) ||
          !(
            detail.errorCode === null ||
            typeof detail.errorCode === "string"
          ) ||
          typeof detail.bucket !== "string"
        ) {
          continue;
        }
        totals.failureDetails.push({
          id: detail.id,
          toolName: detail.toolName,
          errorCode: detail.errorCode,
          bucket: detail.bucket,
        });
      }
      totals.failureDetailsTruncated =
        totals.failureDetailsTruncated === true ||
        record?.toolCallOutcomes?.failureDetailsTruncated === true;
    }
  }
  return totals;
}

/**
 * Resolve one attempt's tool-event counts with explicit provenance:
 *   1. "summary" — the attempt's own fresh run-summary records (the durable
 *      per-lane source; survives the cleanup that deletes mission graphs).
 *      A summary that says zero is an EXPLICIT zero.
 *   2. "graphs" — mined persisted mission graphs, kept for failed attempts
 *      whose cleanup never ran. Zero mined events is NOT evidence of zero
 *      tool calls (green lanes delete their run-owned graphs), so an empty
 *      mine falls through to...
 *   3. "none" — no source; every count is null (unknown, never zero).
 * `succeeded` = observed - failed - (vacuous when known); null when failed
 * is unknown. Graph mining cannot see receipts, so its vacuous is null.
 */
export function resolveAttemptToolEvents({ summary, summaryFresh, minedCounts }) {
  if (summaryFresh) {
    const totals = summaryToolEventTotals(summary);
    // Records that merely EXIST do not speak. A summary whose records all carry
    // null counts (a lane with neither a fold nor an annotation) proves nothing
    // about tool calls and must fall through to graph mining, then to "none" —
    // treating existence as knowledge is how the scenario-less lanes produced
    // explicit observed=0 rows.
    if (totals && totals.observed !== null) {
      return {
        source: TOOL_EVENT_SOURCE_SUMMARY,
        observed: totals.observed,
        failed: totals.failed,
        vacuous: totals.vacuous,
        intentionalNoOp: totals.intentionalNoOp,
        undetermined: totals.undetermined,
        // Undetermined calls are subtracted, never credited: a call that
        // started and never reported an outcome is not a success. Records that
        // cannot report it contribute null, which leaves the previous
        // behaviour unchanged for them.
        succeeded:
          totals.failed === null
            ? null
            : Math.max(
                0,
                totals.observed -
                  totals.failed -
                  (totals.vacuous ?? 0) -
                  (totals.undetermined ?? 0),
              ),
        buckets: totals.buckets,
        failureDetails: totals.failureDetails,
        failureDetailsTruncated: totals.failureDetailsTruncated,
      };
    }
  }
  const mined = minedCounts ?? { observed: 0, failed: 0, buckets: null };
  if (safeCount(mined.observed) > 0) {
    return {
      source: TOOL_EVENT_SOURCE_GRAPHS,
      observed: mined.observed,
      failed: mined.failed,
      vacuous: null,
      intentionalNoOp: null,
      undetermined: null,
      succeeded: Math.max(0, mined.observed - mined.failed),
      buckets: mined.buckets,
      failureDetails: null,
      failureDetailsTruncated: null,
    };
  }
  return {
    source: TOOL_EVENT_SOURCE_NONE,
    observed: null,
    failed: null,
    vacuous: null,
    intentionalNoOp: null,
    undetermined: null,
    succeeded: null,
    buckets: null,
    failureDetails: null,
    failureDetailsTruncated: null,
  };
}

/** Separate mission/acceptance evidence from the Playwright process verdict. */
/**
 * Cost/latency instruments for one attempt, from its fresh daily-use summary.
 * Every field is null when no summary record knew it; the CSV writes blanks
 * for nulls so unknown never reads as zero.
 */
export function summarizeAttemptUsage(summary, summaryFresh, expectedScenarioId = null) {
  const allSummaries = summaryFresh && Array.isArray(summary?.summaries)
    ? summary.summaries
    : [];
  const summaries = expectedScenarioId
    ? allSummaries.filter((record) => record?.scenarioId === expectedScenarioId)
    : allSummaries;
  const sumKnown = (key) => {
    let total = null;
    for (const record of summaries) {
      const value = record?.[key];
      if (Number.isSafeInteger(value) && value >= 0) total = (total ?? 0) + value;
    }
    return total;
  };
  const ratios = summaries
    .map((record) => record?.promptPrefixReuseAvg)
    .filter((value) => typeof value === "number" && Number.isFinite(value));
  return {
    modelCalls: sumKnown("modelCalls"),
    reportedTokens: sumKnown("reportedTokens"),
    cachedPromptTokens: sumKnown("cachedPromptTokens"),
    promptPrefixReuseAvg: ratios.length > 0
      ? ratios.reduce((total, value) => total + value, 0) / ratios.length
      : null,
  };
}

export function usageCsvCells(usage) {
  return [
    usage?.modelCalls ?? "",
    usage?.reportedTokens ?? "",
    usage?.cachedPromptTokens ?? "",
    typeof usage?.promptPrefixReuseAvg === "number"
      ? usage.promptPrefixReuseAvg.toFixed(3)
      : "",
  ];
}

export function summarizeAttemptAcceptance(summary, summaryFresh, expectedScenarioId = null) {
  const allSummaries = summaryFresh && Array.isArray(summary?.summaries)
    ? summary.summaries
    : [];
  const summaries = expectedScenarioId
    ? allSummaries.filter((record) => record?.scenarioId === expectedScenarioId)
    : allSummaries;
  if (summaries.length === 0) {
    return {
      missionOutcome: "unknown",
      acceptanceStatus: "unknown",
      scorecardTotal: null,
      scorecardAcceptancePassed: null,
      retries: null,
      artifactProofCount: null,
      cleanupProofCount: null,
    };
  }
  const acceptancePassed = summaries.every(
    (record) => record?.acceptanceStatus === "pass",
  );
  const scorecards = summaries
    .map((record) => record?.missionScorecard)
    .filter((scorecard) => scorecard && Number.isFinite(scorecard.total));
  return {
    missionOutcome: acceptancePassed ? "accepted" : "needs_more_work",
    acceptanceStatus: acceptancePassed ? "pass" : "needs_more_work",
    scorecardTotal: scorecards.length === summaries.length
      ? Math.min(...scorecards.map((scorecard) => scorecard.total))
      : null,
    scorecardAcceptancePassed: scorecards.length === summaries.length
      ? scorecards.every((scorecard) => scorecard.acceptancePassed === true)
      : null,
    retries: summaries.reduce(
      (total, record) =>
        total + (Number.isSafeInteger(record?.retries) ? record.retries : 0),
      0,
    ),
    artifactProofCount: summaries.reduce(
      (total, record) =>
        total +
        (Number.isSafeInteger(record?.artifactProofCount)
          ? record.artifactProofCount
          : 0),
      0,
    ),
    cleanupProofCount: summaries.reduce(
      (total, record) =>
        total +
        (Number.isSafeInteger(record?.cleanupProofCount)
          ? record.cleanupProofCount
          : 0),
      0,
    ),
  };
}

/**
 * A zero Playwright exit is not campaign evidence until the selected test also
 * emits an accepted mission scorecard. Fail this at the first attempt instead
 * of discovering after 60 paid calls that the fixed-attempt gate was
 * structurally impossible to satisfy.
 */
export function resolveCampaignAttemptVerdict(input) {
  if (!input.green || hasGreenAcceptanceProof(input)) return { ...input };
  return {
    ...input,
    green: false,
    failureClass: ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS,
    failureDetail:
      "Playwright exited 0, but the lane emitted no accepted mission and scorecard proof.",
    confidence: CLASSIFICATION_CONFIRMED,
    secondaryClasses: [],
  };
}

export function readJsonFile(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Harness-stage signatures printed by run-e2e-exclusive.mjs before Playwright
 * ever starts. An attempt that dies on one of these is a harness refusal, not
 * a product failure, and must be classified as such — four attempts died at
 * "process:matrix_unclassified" on 2026-08-25 because a tsc failure in the
 * build stage (exit 2) was indistinguishable from a mission failure.
 */
const HARNESS_LOG_SIGNATURES = [
  [/Timed out after \d+ ms waiting for the exclusive Obsidian e2e lock/u, "harness:e2e_lock_timeout"],
  [/^build exited with code \d+\.$/mu, "harness:build_failed"],
  [/^test-vault sync exited with code \d+\.$/mu, "harness:vault_sync_failed"],
  [/^e2e preflight exited with code \d+\.$/mu, "harness:preflight_refused"],
  [/Unknown E2E project /u, "harness:unknown_project"],
  [
    /process:prior_plugin_run_did_not_settle\b/u,
    "process:prior_plugin_run_did_not_settle",
  ],
];

/** Stable lane-owned product assertions that are precise enough to alarm. */
const PRODUCT_LOG_SIGNATURES = [
  [
    /product:resume_attempt_projection_lost\b/u,
    "product:resume_attempt_projection_lost",
  ],
  [
    /product:semantic_index_setup_timeout\b/u,
    "product:semantic_index_setup_timeout",
  ],
  [
    /product:final_projection_candidate_rejected\b/u,
    "product:final_projection_candidate_rejected",
  ],
  [
    /MissionGraph frontier tools: none[\s\S]{0,12000}claim_grounding|claim_grounding[\s\S]{0,12000}MissionGraph frontier tools: none/u,
    "product:sealed_frontier_emptied_citation_gather",
  ],
  [
    /twice returned no tool call against the same unchanged executable frontier[\s\S]{0,20000}verify_citation|verify_citation[\s\S]{0,20000}twice returned no tool call against the same unchanged executable frontier/u,
    "product:citation_gather_no_tool_breaker",
  ],
  [
    // RunCoordinator's whole-team aggregate came in BELOW the model-call count
    // its own final ledger segment attested. An aggregate is never smaller than
    // one of its parts, so the two accounting subsystems disagree about the
    // same calls. Reached for the first time on 2026-09-04 once claim grounding
    // stopped ending Phase A early; it classified as process:matrix_unclassified.
    // FIXED 2026-09-04 (c5755ad): the coordinator now declares the usage its
    // scope inherited, and the lane compares runScopedProviderUsageV1. Kept so
    // historical rows still classify; a fresh hit means the baseline regressed.
    /coordinator aggregate omitted calls attested by its final ledger segment/u,
    "product:coordinator_usage_aggregate_short",
  ],
  [
    // Phase A pulled the same four owned sources over the wire 33 times. The
    // fixture backend counts transport hits, so this is refetching, not the
    // model calling web_fetch again against a warm cache. Reached for the
    // first time on 2026-09-04 once the usage aggregate above stopped ending
    // Phase A one assertion earlier; the run itself passed acceptance 15/15.
    /refetched owned sources over the wire instead of reusing them/u,
    "product:owned_source_refetch_amplification",
  ],
];

/**
 * Driver/renderer deaths Playwright reports when the app process goes away
 * under the test: the lane never got to assert anything, so this is harness
 * evidence, not product evidence (budget-exempt like the other harness:*).
 */
const RENDERER_DEATH_PATTERNS = [
  /Target page, context or browser has been closed/u,
  /Target closed/u,
  /Target crashed/u,
  /Renderer process crashed/iu,
  /page crashed/iu,
  /browser has (?:been )?disconnected/iu,
];

/**
 * Signs that Playwright ran the lane and the TEST ITSELF failed: an assertion
 * error, an expect() diff, a test timeout, or a numbered failing-test header
 * ("  1) [project] › file › title"). Whether that red is model: or product:
 * cannot be decided mechanically from the log, so these classify as the
 * prefix-less `lane_assertion_failed` — it consumes attempt budget and resets
 * the streak like any real red, and the assertion excerpt rides along in
 * failureDetail for a human to attribute (visibility, not fake precision).
 */
const LANE_ASSERTION_PATTERNS = [
  /^\s*Error: expect\(/mu,
  /^\s*AssertionError\b/mu,
  /expect\(received\)/u,
  /Test timeout of \d+\s*ms exceeded/u,
  /^\s*\d+\)\s+\[[^\]\n]+\]\s+›\s/mu,
];

export const LANE_ASSERTION_FAILURE_CLASS = "lane_assertion_failed";
export const RENDERER_DEATH_FAILURE_CLASS = "harness:renderer_death";

/**
 * The lane's product assertions ALL PASSED and only its mandatory harness
 * cleanup failed.
 *
 * On 2026-08-26 a compound-linear-github attempt did its entire job in 1120s —
 * web research, Linear issue, code workspace, three validations, a verified
 * commit, a private GitHub repo, a draft PR and the Results note — and then
 * failed on a teardown process probe:
 *
 *   COMPOUND-REAL assertions passed; mandatory cleanup failed:
 *   Harness cleanup: Controlled Obsidian teardown did not drain cleanly
 *   (owned process exit; Obsidian process drain).
 *
 * Playwright still printed a numbered failing-test header, so it matched
 * LANE_ASSERTION_PATTERNS and was filed as `lane_assertion_failed` — the bucket
 * a genuine product failure lands in. It spent attempt budget and reset a
 * consecutive-green streak that needs 3 in a row. That is the same lie
 * `environment_not_configured` was added to end, in a different direction: this
 * time the product WAS exercised and it SUCCEEDED, and the instrument recorded
 * a product failure.
 *
 * It stays loud and it stays a failure — a leaked Obsidian is real, and it
 * poisons the next lane's already-running check. But it is harness evidence,
 * not product evidence: `harness:` prefixed, so isInfrastructureFailureClass
 * exempts it from budget and streak through the one shared predicate, the
 * consecutive-harness-failure valve still aborts a persistently broken teardown,
 * and it writes NO run-metrics CSV row (every eval reader counts each row in its
 * pass-rate denominator and only classifies green/not-green).
 */
export const HARNESS_CLEANUP_FAILURE_CLASS = "harness:cleanup_failed";

/**
 * A previous attempt's Obsidian is STILL on the machine and would not drain, so
 * this attempt was never launched.
 *
 * THE CASCADE THIS ENDS. On 2026-08-27 two `harness:cleanup_failed` teardowns
 * leaked a live Obsidian, and the matrix launched straight into it twice more:
 * attempts 4 and 5 each paid ~150s of build, vault sync and lane startup only
 * to be refused by `assertObsidianClosed`, which is behaving correctly — a live
 * Obsidian genuinely poisons a lane. Four of nine attempts were consumed by one
 * root cause, and four CONSECUTIVE infrastructure reds left the cell two short
 * of the MAX_CONSECUTIVE_HARNESS_FAILURES abort valve.
 *
 * The gate now reaps what the campaign can PROVE it owns, then waits for
 * anything already terminating (no kill can reach that state), and only records
 * this class when the machine is still dirty at the end. It is `harness:`
 * prefixed, so the one shared predicate keeps it off the attempt budget and the
 * green streak, it writes no run-metrics CSV row, and the valve still aborts a
 * campaign that can never get a clean machine.
 */
export const OBSIDIAN_RESIDUE_FAILURE_CLASS = "harness:obsidian_residue_blocked";

/**
 * The model provider refused to serve the run — quota, monthly cap, or rate
 * limit — so the product was never exercised.
 *
 * `harness:` prefixed so the ONE shared predicate (isInfrastructureFailureClass)
 * exempts it from attempt budget and the consecutive-green streak, and so it
 * writes no run-metrics CSV row. Burning a 5-attempt budget against an
 * exhausted account teaches nothing, and recording it as a product red is a
 * lie about a run the product never got to attempt.
 *
 * It stays LOUD: an operator whose quota is spent must be told plainly, and
 * the consecutive-harness-failure valve still aborts rather than looping.
 */
export const PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS = "harness:provider_quota_exhausted";

/**
 * Provider refusals, keyed on the stable operator-facing sentences the model
 * clients already distinguish (`rate_limit` / `provider_budget_exhausted` in
 * src/model/OllamaClient.ts and src/model/OpenAICompatibleClient.ts, both from
 * HTTP 429).
 *
 * Deliberately NOT keyed on a bare "limit", "quota", or "429": a product
 * assertion can easily contain any of those in an expected/received diff. Each
 * pattern below is a whole provider sentence.
 */
const PROVIDER_QUOTA_PATTERNS = Object.freeze([
  /Cloud model rate limit reached[^\r\n]*/u,
  /extra usage auto reload monthly max reached[^\r\n]*/u,
  /\brate limit reached\b[^\r\n]*/u,
  /\bprovider_budget_exhausted\b[^\r\n]*/u,
]);

/**
 * The provider sentence that refused this run, or null when the log carries
 * none.
 */
export function detectProviderQuotaExhaustion(logText) {
  const text = typeof logText === "string" ? logText : "";
  for (const pattern of PROVIDER_QUOTA_PATTERNS) {
    const match = pattern.exec(text);
    if (match) {
      return { detail: match[0].trim(), index: match.index };
    }
  }
  return null;
}

/**
 * No sandbox provider could ATTEST — the boundary probe never returned a
 * verdict — so the product's code-execution stages were never exercised.
 *
 * Measured 2026-08-27: two compound attempts died on
 *   "No sandbox provider has passed its boundary probe.
 *    wsl2 rejected: Sandbox provider process exceeded its fixed timeout."
 * with the host at 100% CPU and 56-63 competing node processes. The same lane
 * had proven 3 consecutive greens hours earlier on a quiet machine, and the
 * WSL2 probe budget's own comment scopes it to "normal workstation load". Both
 * attempts were filed as `lane_assertion_failed` — the product bucket — and
 * each one burned ~40 minutes of a pinned premium model.
 *
 * CRITICAL DISTINCTION, and the reason this keys on the timeout sentence
 * rather than on "boundary probe" alone: a probe that RAN and returned a
 * verdict of FAIL means the sandbox did not confine code. That is a real,
 * severe product finding and must stay in the product bucket. Only "the probe
 * never answered" is infrastructure. Conflating them would let a genuine
 * containment failure hide behind an infrastructure label, which would be far
 * worse than any mis-scored lane.
 */
export const SANDBOX_UNAVAILABLE_FAILURE_CLASS = "harness:sandbox_unavailable";

/**
 * A boundary probe that produced NO VERDICT. Both clauses are required: the
 * "no provider passed" sentence AND an explicit timeout, so a probe that ran
 * and reported a violation can never match.
 */
const SANDBOX_NO_VERDICT_CONTRACT =
  /No sandbox provider has passed its boundary probe\.[^\r\n]*?(?:sandbox_probe_no_verdict|exceeded its fixed timeout|provider_timeout)[^\r\n]*/u;

/** The no-verdict sentence, or null when the log carries none. */
export function detectSandboxNoVerdict(logText) {
  const match = SANDBOX_NO_VERDICT_CONTRACT.exec(
    typeof logText === "string" ? logText : "",
  );
  if (!match) return null;
  return { detail: match[0].trim(), index: match.index };
}

/**
 * The lane's own contract sentence, composed in exactly one place
 * (e2e/fixtures/externalCleanup.ts composeMandatoryCleanupError). Detection
 * keys on the "assertions passed" half, which the composer emits ONLY when the
 * test body threw nothing: a lane whose assertions failed says
 * "<LANE> failed: ..." instead and can never reach this class.
 */
const LANE_CLEANUP_CONTRACT =
  /(?:^|\s)([A-Z][A-Z0-9-]{2,}) assertions passed; mandatory cleanup failed: ([^\r\n]*)/u;

/**
 * The lane that reported passing assertions with failing cleanup, and what
 * cleanup said, or null when the log carries no such sentence.
 */
export function detectLaneCleanupFailure(logText) {
  const match = LANE_CLEANUP_CONTRACT.exec(
    typeof logText === "string" ? logText : "",
  );
  if (!match) return null;
  return { lane: match[1], detail: match[2].trim(), index: match.index };
}

/**
 * Some single-purpose lanes close their native harness directly instead of
 * using composeMandatoryCleanupError. They therefore cannot emit the stronger
 * "assertions passed" sentence above. Treat their controlled teardown as
 * cleanup-only evidence only when the same attempt wrote exactly one fresh,
 * accepted scorecard and the teardown is the log's sole Error header. The
 * conjunction matters: neither a stale scorecard nor a second assertion error
 * can launder a real product red into the budget-exempt harness bucket.
 */
const DIRECT_OBSIDIAN_CLEANUP_CONTRACT =
  /Controlled Obsidian teardown did not drain cleanly \([^\r\n)]*\)(?:\.\s*Survivor sweep:[^\r\n]*)?/u;
const PLAYWRIGHT_ERROR_HEADER = /^\s*Error:\s+([^\r\n]+)/gmu;

function detectAttestedDirectCleanupFailure({ logText, summary, summaryFresh }) {
  if (!summaryFresh) return null;
  const text = typeof logText === "string" ? logText : "";
  const errorHeaders = [...text.matchAll(PLAYWRIGHT_ERROR_HEADER)];
  if (errorHeaders.length !== 1) return null;
  const cleanup = DIRECT_OBSIDIAN_CLEANUP_CONTRACT.exec(errorHeaders[0][1] ?? "");
  if (!cleanup) return null;
  const records = Array.isArray(summary?.records)
    ? summary.records
    : Array.isArray(summary)
      ? summary
      : [];
  if (records.length !== 1 || records[0]?.missionScorecard?.acceptancePassed !== true) {
    return null;
  }
  const record = records[0];
  return {
    lane: record.scenarioId ?? record.project ?? "scorecard-attested lane",
    detail: cleanup[0].trim(),
    index: errorHeaders[0].index,
  };
}

/**
 * The live lanes guard their required environment with a `requiredEnvironment()`
 * (or `requiredSecret()`) helper that throws a DELIBERATE, fixed, greppable
 * sentence NAMING the variable. Detection keys on those whole sentences plus an
 * ALL-CAPS variable token — never on a bare "missing" or "environment", either
 * of which a product assertion could easily contain in its expected/received
 * diff. Two contract families cover every such guard in e2e/:
 *
 *   A. "<label> is missing required environment <NAME>."
 *      e2e/compound-flow-real-live.spec.ts, e2e/daily-use-compound.spec.ts,
 *      e2e/obsidian-hello-github-live.spec.ts
 *   B. "<NAME> is {required and must be bounded|missing or invalid}; no
 *      external mutation was attempted."
 *      e2e/disposable-live-external.spec.ts (env + secret guards) — the
 *      trailing clause is itself the lane stating that it exercised nothing.
 *
 * Adding a new guard means speaking one of these two sentences; a lane that
 * invents its own phrasing silently falls back to `lane_assertion_failed` and
 * will burn its cell's budget, which is why the wording is a contract.
 */
const REQUIRED_ENVIRONMENT_CONTRACTS = [
  /\bis missing required environment ([A-Z][A-Z0-9_]{2,})\b/gu,
  /\b([A-Z][A-Z0-9_]{2,}) is (?:required and must be bounded|missing or invalid); no external mutation was attempted/gu,
];

/**
 * Every required-environment variable the log reports as absent, in first-seen
 * order and deduplicated. Empty when the log carries no such guard sentence —
 * which is the only thing that distinguishes this class from a real red, so it
 * is deliberately strict.
 */
export function detectMissingRequiredEnvironment(logText) {
  const text = typeof logText === "string" ? logText : "";
  const names = [];
  for (const contract of REQUIRED_ENVIRONMENT_CONTRACTS) {
    for (const match of text.matchAll(contract)) {
      const name = match[1];
      if (name && !names.includes(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Every error message a Playwright JSON report carries, flattened.
 *
 * Exported for the model-tier benchmark, which drives the SAME lanes through
 * the SAME exclusive runner at caller-chosen models and must classify their
 * outcomes with the SAME authority the matrix uses. Sharing the classifier is
 * the point: a benchmark that forked its own copy would drift from the matrix
 * and the two would disagree about what a red means.
 */
export function extractPlaywrightReportErrorText(report) {
  const chunks = [];
  const pushError = (error) => {
    if (typeof error?.message === "string") chunks.push(error.message);
  };
  const walkSuite = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const testEntry of spec?.tests ?? []) {
        for (const result of testEntry?.results ?? []) {
          pushError(result?.error);
          for (const error of result?.errors ?? []) pushError(error);
        }
      }
    }
    for (const child of suite?.suites ?? []) walkSuite(child);
  };
  for (const suite of report?.suites ?? []) walkSuite(suite);
  for (const error of report?.errors ?? []) pushError(error);
  return chunks.join("\n").slice(0, 200_000);
}

/** Earliest match of any pattern in the text, or null. */
function firstPatternMatch(text, patterns) {
  let best = null;
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && (best === null || match.index < best.index)) best = match;
  }
  return best;
}

/**
 * Failure class for a red attempt. A required-environment refusal is settled
 * FIRST, ahead of even the lane's own proof class: a lane that threw on an
 * absent variable never exercised the product, so nothing further down the log
 * can be evidence about it. That precedence can only ever refuse to score a
 * run — never score one falsely — which is the safe direction for an
 * instrument. Otherwise prefer the lane's own proof-class annotation, but only
 * when the run summary was written during THIS attempt — a summary left behind
 * by an earlier run must not label a later failure. Otherwise scan the
 * attempt's captured output: harness-stage signatures (pre-Playwright deaths)
 * first — their classification must never change — then renderer/target-closed
 * driver deaths, then the failing lane's own assertion text. Only a log with
 * none of those stays matrix_unclassified, and even then the log tail rides
 * along in failureDetail.
 */
/**
 * How much to trust the classification:
 *   confirmed    — the lane's own fresh run-summary proof class matched, or
 *                  the lane's own required-environment guard named the absent
 *                  variable (both are the lane stating a fact about itself,
 *                  not the matrix guessing), or the attempt was green:
 *                  nothing to classify.
 *   mechanical   — pattern-matched from the attempt log (harness signatures,
 *                  renderer deaths, lane assertions). Correct shape, but the
 *                  root cause was never confirmed by the lane or a human.
 *   unclassified — nothing parseable; only the log tail rides along.
 */
export const CLASSIFICATION_CONFIRMED = "confirmed";
export const CLASSIFICATION_MECHANICAL = "mechanical";
export const CLASSIFICATION_UNCLASSIFIED = "unclassified";

/**
 * Every failure class the log MECHANICALLY matches, in precedence order and
 * deduplicated. A failure can have more than one cause (a harness death whose
 * log also carries an assertion diff); the primary classifier picks one, and
 * the others become secondary classes instead of being silently dropped.
 */
export function collectMechanicalFailureClasses(logText) {
  const text = typeof logText === "string" ? logText : "";
  const classes = [];
  for (const [pattern, failureClass] of PRODUCT_LOG_SIGNATURES) {
    if (pattern.test(text) && !classes.includes(failureClass)) {
      classes.push(failureClass);
    }
  }
  for (const [pattern, failureClass] of HARNESS_LOG_SIGNATURES) {
    if (pattern.test(text) && !classes.includes(failureClass)) {
      classes.push(failureClass);
    }
  }
  if (firstPatternMatch(text, RENDERER_DEATH_PATTERNS)) {
    classes.push(RENDERER_DEATH_FAILURE_CLASS);
  }
  if (firstPatternMatch(text, LANE_ASSERTION_PATTERNS)) {
    classes.push(LANE_ASSERTION_FAILURE_CLASS);
  }
  return classes;
}

export function classifyAttemptOutcome({ exitCode, summary, summaryFresh, logText }) {
  if (exitCode === 0) {
    return {
      failureClass: "none",
      detail: "",
      confidence: CLASSIFICATION_CONFIRMED,
      secondaryClasses: [],
    };
  }
  const text = typeof logText === "string" ? logText : "";
  const mechanical = collectMechanicalFailureClasses(text);
  const secondaryFor = (primary) => mechanical.filter((cls) => cls !== primary);
  const missingEnvironment = detectMissingRequiredEnvironment(text);
  if (missingEnvironment.length > 0) {
    return {
      failureClass: ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
      detail:
        `required environment not set: ${missingEnvironment.join(", ")}\n` +
        attemptLogExcerptFrom(text, text.search(/\bis missing required environment\b|; no external mutation was attempted/u)),
      confidence: CLASSIFICATION_CONFIRMED,
      // Deliberately EMPTY even though the log also matches the lane-assertion
      // patterns (Playwright still prints a numbered failing-test header for a
      // guard that threw). Carrying `lane_assertion_failed` here would smuggle
      // the same lie into a different column of the report.
      secondaryClasses: [],
      missingEnvironment,
    };
  }
  // Settled SECOND, ahead of the lane's own proof class and every log scan, for
  // the same reason as the environment refusal: the lane has stated a fact
  // about ITSELF — that every product assertion passed — so nothing further
  // down the log is evidence of a product failure. The precedence can only
  // refuse to score a red, never invent a green.
  const cleanupFailure = detectLaneCleanupFailure(text);
  if (cleanupFailure) {
    return {
      failureClass: HARNESS_CLEANUP_FAILURE_CLASS,
      detail:
        `${cleanupFailure.lane} product assertions passed; mandatory harness cleanup failed: ` +
        `${cleanupFailure.detail}\n` +
        attemptLogExcerptFrom(text, cleanupFailure.index),
      confidence: CLASSIFICATION_CONFIRMED,
      // `lane_assertion_failed` is dropped deliberately — Playwright prints a
      // numbered failing-test header for ANY thrown error, including this one,
      // and carrying it would smuggle the product-failure reading into a
      // different column of the same report. Other signatures are real and ride
      // along as secondaries.
      secondaryClasses: secondaryFor(HARNESS_CLEANUP_FAILURE_CLASS).filter(
        (cls) => cls !== LANE_ASSERTION_FAILURE_CLASS,
      ),
      cleanupFailure: { lane: cleanupFailure.lane, detail: cleanupFailure.detail },
    };
  }
  const directCleanupFailure = detectAttestedDirectCleanupFailure({
    logText: text,
    summary,
    summaryFresh,
  });
  if (directCleanupFailure) {
    return {
      failureClass: HARNESS_CLEANUP_FAILURE_CLASS,
      detail:
        `${directCleanupFailure.lane} fresh accepted scorecard; mandatory harness cleanup failed: ` +
        `${directCleanupFailure.detail}\n` +
        attemptLogExcerptFrom(text, directCleanupFailure.index),
      confidence: CLASSIFICATION_CONFIRMED,
      secondaryClasses: secondaryFor(HARNESS_CLEANUP_FAILURE_CLASS).filter(
        (cls) => cls !== LANE_ASSERTION_FAILURE_CLASS,
      ),
      cleanupFailure: {
        lane: directCleanupFailure.lane,
        detail: directCleanupFailure.detail,
      },
    };
  }
  // Settled THIRD, for the same reason as the two above: the model provider
  // refused to serve the run at all, so nothing downstream is product
  // evidence. On 2026-08-26 five of six compound attempts died on
  // "Cloud model rate limit reached ... extra usage auto reload monthly max
  // reached" — including one that had already reached five lifecycle stages in
  // 1044s before the quota cut it off mid-mission. Every one was filed as
  // `lane_assertion_failed`, and the cell recorded 0/3 greens as though the
  // product had regressed. It had not: the account's monthly cap was spent.
  //
  // This is the third direction of the same lie. `environment_not_configured`
  // covers "the cell never ran"; `harness:cleanup_failed` covers "the product
  // passed and the harness leaked"; this covers "an external provider refused
  // to serve us". None of the three is product evidence, and only the product
  // belongs in a pass-rate denominator.
  // Settled alongside the provider-quota case and for the same reason: the
  // sandbox never attested, so the code-execution stages were never exercised
  // and nothing downstream is product evidence. Keyed on the NO-VERDICT
  // sentence only -- a probe that ran and reported a boundary violation is a
  // genuine product finding and deliberately does not match.
  const sandboxNoVerdict = detectSandboxNoVerdict(text);
  if (sandboxNoVerdict) {
    return {
      failureClass: SANDBOX_UNAVAILABLE_FAILURE_CLASS,
      detail:
        `Sandbox never attested (no verdict): ${sandboxNoVerdict.detail}\n` +
        attemptLogExcerptFrom(text, sandboxNoVerdict.index),
      confidence: CLASSIFICATION_CONFIRMED,
      secondaryClasses: secondaryFor(SANDBOX_UNAVAILABLE_FAILURE_CLASS).filter(
        (cls) => cls !== LANE_ASSERTION_FAILURE_CLASS,
      ),
    };
  }
  const providerQuota = detectProviderQuotaExhaustion(text);
  if (providerQuota) {
    return {
      failureClass: PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS,
      detail:
        `Model provider refused the run: ${providerQuota.detail}\n` +
        attemptLogExcerptFrom(text, providerQuota.index),
      confidence: CLASSIFICATION_CONFIRMED,
      // Same reasoning as the cleanup class: Playwright prints a numbered
      // failing-test header for any thrown error, so the lane-assertion
      // signature co-matches and must not ride along.
      secondaryClasses: secondaryFor(PROVIDER_QUOTA_EXHAUSTED_FAILURE_CLASS).filter(
        (cls) => cls !== LANE_ASSERTION_FAILURE_CLASS,
      ),
    };
  }
  if (summaryFresh) {
    const records = Array.isArray(summary?.records)
      ? summary.records
      : Array.isArray(summary)
        ? summary
        : [];
    for (const record of records) {
      const cls = record?.proofClass ?? record?.failureClass ?? null;
      if (typeof cls === "string" && cls.includes(":")) {
        return {
          failureClass: cls,
          detail: "",
          confidence: CLASSIFICATION_CONFIRMED,
          secondaryClasses: secondaryFor(cls),
        };
      }
    }
  }
  for (const [pattern, failureClass] of PRODUCT_LOG_SIGNATURES) {
    const match = pattern.exec(text);
    if (match) {
      return {
        failureClass,
        detail: attemptLogExcerpt(text, match.index),
        confidence: CLASSIFICATION_MECHANICAL,
        secondaryClasses: secondaryFor(failureClass),
      };
    }
  }
  for (const [pattern, failureClass] of HARNESS_LOG_SIGNATURES) {
    const match = pattern.exec(text);
    if (match) {
      return {
        failureClass,
        detail: attemptLogExcerpt(text, match.index),
        confidence: CLASSIFICATION_MECHANICAL,
        secondaryClasses: secondaryFor(failureClass),
      };
    }
  }
  const rendererDeath = firstPatternMatch(text, RENDERER_DEATH_PATTERNS);
  if (rendererDeath) {
    return {
      failureClass: RENDERER_DEATH_FAILURE_CLASS,
      detail: attemptLogExcerptFrom(text, rendererDeath.index),
      confidence: CLASSIFICATION_MECHANICAL,
      secondaryClasses: secondaryFor(RENDERER_DEATH_FAILURE_CLASS),
    };
  }
  const laneAssertion = firstPatternMatch(text, LANE_ASSERTION_PATTERNS);
  if (laneAssertion) {
    return {
      failureClass: LANE_ASSERTION_FAILURE_CLASS,
      detail: attemptLogExcerptFrom(text, laneAssertion.index),
      confidence: CLASSIFICATION_MECHANICAL,
      secondaryClasses: secondaryFor(LANE_ASSERTION_FAILURE_CLASS),
    };
  }
  return {
    failureClass: "process:matrix_unclassified",
    detail: attemptLogExcerpt(text),
    confidence: CLASSIFICATION_UNCLASSIFIED,
    secondaryClasses: [],
  };
}

/**
 * A short excerpt of the attempt log for the manifest: the lines just before
 * the matched harness signature (where the actual compiler/preflight error
 * lives), or the tail of the log when nothing matched.
 */
export function attemptLogExcerpt(logText, endIndex = null) {
  const text = typeof logText === "string" ? logText : "";
  if (text.trim() === "") return "";
  let upTo = text.length;
  if (endIndex !== null) {
    const lineEnd = text.indexOf("\n", endIndex);
    upTo = lineEnd === -1 ? text.length : lineEnd;
  }
  const lines = text
    .slice(0, upTo)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines.slice(-8).join("\n").slice(-1_000);
}

/**
 * Excerpt starting AT the matched line and reading forward — for failures
 * whose useful context follows the trigger line (an assertion's
 * expected/received diff, the stack under a driver error), unlike
 * attemptLogExcerpt which reads backward from a harness-stage signature.
 */
export function attemptLogExcerptFrom(logText, startIndex = 0) {
  const text = typeof logText === "string" ? logText : "";
  if (text.trim() === "") return "";
  const lineStart = text.lastIndexOf("\n", Math.max(0, startIndex - 1)) + 1;
  const lines = text
    .slice(lineStart)
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "");
  return lines.slice(0, 12).join("\n").slice(0, 1_000);
}

/** The file's mtime in ms, or null when it does not exist. */
export function fileMtimeMs(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * True when the run summary was (re)written during THIS attempt: it exists now
 * and is strictly newer than the exact pre-spawn snapshot (or was absent then
 * and is present now).
 *
 * No wall-clock grace. The old rule (`mtime >= windowStart - 5s`) admitted the
 * PREVIOUS attempt's summary as fresh for any attempt that died inside the
 * 5-second harness stage, which then labelled the new attempt with the old
 * attempt's records — both for classification and for tool-event sourcing. Any
 * tolerance around an exact before-reference is an admission window for stale
 * evidence, so there is none.
 */
export function summaryWrittenSince(file, mtimeBeforeLaunchMs) {
  const current = fileMtimeMs(file);
  if (current === null) return false;
  return mtimeBeforeLaunchMs === null || current > mtimeBeforeLaunchMs;
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function appendRunCsvRow(row) {
  if (Array.isArray(row) && row.length > 2) {
    row[2] = String(row[2] ?? "").trim();
  }
  mkdirSync(EVAL_DIR, { recursive: true });
  if (!existsSync(RUN_CSV)) {
    writeFileSync(RUN_CSV, RUN_CSV_HEADER + "\n");
  } else {
    // A CSV started under the old schema keeps its rows untouched; only the
    // header line is upgraded so name-indexing readers see the new columns.
    const upgraded = upgradeRunCsvHeader(readFileSync(RUN_CSV, "utf8"));
    if (upgraded !== null) writeFileSync(RUN_CSV, upgraded);
  }
  appendFileSync(RUN_CSV, row.map(csvField).join(",") + "\n");
}

export function laneHasScorecardBaselineFrom(baseline, project) {
  const records = baseline?.records;
  if (Array.isArray(records)) {
    return records.some((record) => record?.project === project);
  }
  if (records && typeof records === "object") {
    return Object.keys(records).some(
      (key) =>
        key === project ||
        key.startsWith(`${project}/`) ||
        key.startsWith(`${project}|`),
    );
  }
  return false;
}

function laneHasScorecardBaseline(project) {
  return laneHasScorecardBaselineFrom(readJsonFile(SCORECARD_BASELINE_PATH), project);
}

export const EMPTY_SCORECARD_HARVEST_MESSAGE =
  "No passing, fully-scored mission records to harvest";

export function isEmptyScorecardHarvestOutput(output) {
  return String(output ?? "").includes(EMPTY_SCORECARD_HARVEST_MESSAGE);
}

function runNpm(args, env) {
  const result = spawnSync("npm", args, {
    cwd: REPO_ROOT,
    env,
    stdio: "inherit",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return result.status ?? 1;
}

function runNpmCaptured(args, env) {
  const result = spawnSync("npm", args, {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
    windowsHide: true,
  });
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/**
 * Write JSON durably: temp file in the same directory, then rename. A rename
 * is atomic on the same volume, so a runner killed mid-write leaves either
 * the previous manifest or the new one — never a torn, unparseable file.
 */
export function writeJsonAtomic(filePath, value) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tempPath, JSON.stringify(value, null, 2) + "\n");
  renameSync(tempPath, filePath);
}

/**
 * Claim an attempt-log path before the child starts. Fresh campaigns reuse
 * per-cell attempt ordinals, so leaving the previous campaign's file in place
 * makes live inspection show convincing but stale output until spawnSync
 * returns. The content-free header both truncates that output and records the
 * exact evidence identity if the parent dies while the child is in flight.
 */
export function initializeAttemptLogFile(filePath, metadata) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(
    filePath,
    `${JSON.stringify({
      schema: "proof-matrix-attempt-log-v1",
      status: "in_flight",
      ...metadata,
    })}\n`,
    "utf8",
  );
}

/**
 * One-time migration from the pre-2026-08-25 manifest location inside
 * test-results/ (which Playwright wipes). Copies the legacy manifest to the
 * durable location only when no durable manifest exists yet; the legacy file
 * is left in place for Playwright to wipe. Returns true when it migrated.
 */
export function migrateLegacyManifestFile(legacyPath, newPath) {
  if (existsSync(newPath) || !existsSync(legacyPath)) return false;
  const legacy = readJsonFile(legacyPath);
  if (!legacy || typeof legacy !== "object") return false;
  writeJsonAtomic(newPath, legacy);
  return true;
}

function loadManifest() {
  if (migrateLegacyManifestFile(LEGACY_MANIFEST_PATH, MANIFEST_PATH)) {
    console.log(
      `proof-matrix: migrated legacy manifest ${LEGACY_MANIFEST_RELATIVE_PATH} -> ${PROOF_MATRIX_MANIFEST_RELATIVE_PATH}.`,
    );
  }
  return (
    readJsonFile(MANIFEST_PATH) ?? {
      startedAt: new Date().toISOString(),
      model: PROOF_MATRIX_MODEL,
      expectedHead: null,
      attempts: [],
      productClassCounts: {},
      harnessFailureCounts: {},
    }
  );
}

function saveManifest(manifest) {
  writeJsonAtomic(MANIFEST_PATH, manifest);
}

/**
 * A runner death mid-attempt is a harness/process fact, not product evidence:
 * budget-exempt and streak-preserving, like every other harness:* class.
 */
export const IN_FLIGHT_FAILURE_CLASS = "harness:runner_died_mid_attempt";

/**
 * Persisted BEFORE the attempt's child process is spawned, so the on-disk
 * manifest always says which attempt was running when the runner died.
 * Cleared (and replaced by the real attempt record) when the attempt ends.
 */
export function markAttemptInFlight(manifest, { cell, project, attempt, startedAt }) {
  manifest.inFlight = { cell, project, attempt, startedAt };
}

/**
 * Record an attempt slot that was never launched.
 *
 * Distinct from the attempt record written after a run finishes: there is no
 * runner, no exit code and no log to classify, only a reason the matrix
 * declined to start. It is a plain push of a prepared record precisely so the
 * source-shape guards over the POST-RUN attempt record keep matching the one
 * literal they are about.
 */
function recordUnlaunchedAttempt(manifest, record) {
  manifest.attempts.push(record);
}

export function clearAttemptInFlight(manifest) {
  delete manifest.inFlight;
}

/**
 * On load: if the manifest still carries an inFlight marker, the previous
 * runner died mid-attempt. Materialize that death as a budget-exempt
 * harness attempt so it is visible in the record, then clear the marker.
 * Returns the reconciled attempt, or null when there was nothing in flight.
 */
export function reconcileInFlightAttempt(manifest) {
  const pending = manifest.inFlight;
  clearAttemptInFlight(manifest);
  if (!pending || typeof pending !== "object" || typeof pending.cell !== "string") {
    return null;
  }
  const reconciled = {
    cell: pending.cell,
    project: pending.project ?? "",
    attempt: pending.attempt ?? totalAttemptCount(manifest, pending.cell) + 1,
    startedAt: pending.startedAt ?? null,
    durationS: null,
    green: false,
    exitCode: null,
    failureClass: IN_FLIGHT_FAILURE_CLASS,
    // Derived from the persisted marker, not from lane output or a human.
    confidence: CLASSIFICATION_MECHANICAL,
    secondaryClasses: [],
    failureDetail:
      "runner process died mid-attempt; reconciled from the persisted in-flight marker on the next load",
    interrupted: true,
  };
  manifest.attempts.push(reconciled);
  manifest.harnessFailureCounts = manifest.harnessFailureCounts ?? {};
  manifest.harnessFailureCounts[reconciled.cell] =
    (manifest.harnessFailureCounts[reconciled.cell] ?? 0) + 1;
  return reconciled;
}

/**
 * True when the attempt spends budget and can move the streak.
 *
 * Attempts exist to measure the PRODUCT. A death in the harness or the matrix
 * process itself (harness:*, process:*) is not evidence about the product, so
 * it must neither spend the cell's attempt budget nor reset its
 * consecutive-green streak — on 2026-08-25 one bad commit burned a whole cell
 * in 3 minutes as four harness:build_failed reds. Real reds (model:*,
 * product:*, external:*) keep their full cost.
 *
 * `environment_not_configured` joins them: a lane that threw on an absent
 * required variable measured nothing either. The live path aborts the cell
 * before any attempt record is written, so this exemption is defense in depth
 * — one shared predicate, so budget, streak and counts can never disagree
 * about it if such a record ever reaches the manifest another way.
 *
 * That predicate is `measuresProduct` in scripts/product-evidence.mjs, and it
 * is the same expression every eval reader applies to this campaign's CSV
 * rows: an attempt that cannot spend budget here cannot enter a pass-rate
 * denominator there.
 */
export function attemptConsumesBudget(attempt) {
  return measuresProduct(attempt);
}

export function consecutiveGreens(manifest, cellId) {
  let streak = 0;
  for (const attempt of manifest.attempts) {
    if (attempt.cell !== cellId) continue;
    if (attempt.green) streak += 1;
    else if (attemptConsumesBudget(attempt)) streak = 0;
    // Infrastructure deaths leave the streak exactly where it was.
  }
  return streak;
}

export function consumedAttemptCount(manifest, cellId) {
  return manifest.attempts.filter(
    (attempt) => attempt.cell === cellId && attemptConsumesBudget(attempt),
  ).length;
}

export function harnessFailureCount(manifest, cellId) {
  return manifest.attempts.filter(
    (attempt) => attempt.cell === cellId && !attemptConsumesBudget(attempt),
  ).length;
}

/**
 * Safety valve: budget-exempt harness failures must not let a persistently
 * broken build loop forever. More than this many CONSECUTIVE harness/process
 * failures for one cell aborts the campaign. A green or a real red resets the
 * run — the harness demonstrably recovered.
 */
export const MAX_CONSECUTIVE_HARNESS_FAILURES = 6;

export function consecutiveHarnessFailures(manifest, cellId) {
  let run = 0;
  for (const attempt of manifest.attempts) {
    if (attempt.cell !== cellId) continue;
    run = attemptConsumesBudget(attempt) ? 0 : run + 1;
  }
  return run;
}

/**
 * Counts a product-class sighting and reports whether the campaign must stop
 * (the same class seen twice is a regression alarm, not a statistic).
 */
export function registerProductFailure(manifest, failureClass) {
  if (!String(failureClass ?? "").startsWith("product:")) return false;
  manifest.productClassCounts[failureClass] =
    (manifest.productClassCounts[failureClass] ?? 0) + 1;
  return manifest.productClassCounts[failureClass] >= 2;
}

function totalAttemptCount(manifest, cellId) {
  return manifest.attempts.filter((attempt) => attempt.cell === cellId).length;
}

/**
 * The per-cell verdict the manifest records, so a campaign report never has to
 * infer a cell's fate from attempt arithmetic (where "0 greens" reads as red
 * whether the cell failed or never ran):
 *
 *   done       — reached its consecutive-green bar. Product evidence.
 *   exhausted  — spent its attempt budget without reaching the bar. Product
 *                evidence, and a genuine red.
 *   not_run    — never exercised the product at all (the environment it
 *                requires was not configured). Honestly NEITHER green nor red.
 */
export const CELL_STATUS_DONE = "done";
export const CELL_STATUS_EXHAUSTED = "exhausted";
export const CELL_STATUS_NOT_RUN = "not_run";

/**
 * True when a cell's status carries product evidence and therefore belongs in
 * a pass-rate. `not_run` does not: it must appear in neither the numerator nor
 * the DENOMINATOR — counting it as a failure is the exact lie this status
 * exists to prevent. One shared predicate for every future reader.
 */
export function cellStatusIsScored(status) {
  return status === CELL_STATUS_DONE || status === CELL_STATUS_EXHAUSTED;
}

export function recordCellStatus(manifest, cellId, status, extra = {}) {
  manifest.cellStatus = manifest.cellStatus ?? {};
  manifest.cellStatus[cellId] = { status, ...extra };
  return manifest.cellStatus[cellId];
}

export function cellStatusOf(manifest, cellId) {
  return manifest.cellStatus?.[cellId]?.status ?? null;
}

async function main() {
  const gate = resolveReliabilityGate(opt("--gate") ?? "recovery");
  const expectedHead = (process.env.PROOF_MATRIX_EXPECTED_HEAD ?? "").trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(expectedHead)) {
    fail("set PROOF_MATRIX_EXPECTED_HEAD to the exact 40-char sha this campaign pins.");
  }
  if (process.platform !== "win32") fail("win32 only (sandbox lanes + Obsidian sweeps).");

  const selected = opt("--cells");
  const cells = selected
    ? CELLS.filter((cell) => selected.split(",").map((s) => s.trim()).includes(cell.id))
    : CELLS;
  if (cells.length === 0) fail(`--cells matched nothing. Known: ${CELLS.map((c) => c.id).join(", ")}`);

  const preexistingWorkspaces = listWorkspaceEntries();

  if (flag("--dry-run")) {
    console.log(`proof-matrix ${gate.id} dry run @ ${expectedHead} model=${PROOF_MATRIX_MODEL}`);
    for (const cell of cells) {
      console.log(
        `  ${cell.id}: project=${cell.project}` +
        (cell.grep ? ` grep="${cell.grep}"` : "") +
        (gate.kind === "consecutive"
          ? ` requiredGreens=${cell.requiredGreens} maxAttempts=${cell.maxAttempts}`
          : ` validAttempts=${gate.validAttemptsPerLane} minimumGreens=${gate.minimumGreensPerLane}`),
      );
    }
    if (preexistingWorkspaces.length > 0) {
      console.log(
        `  NOTE: workspaces-v2 holds ${preexistingWorkspaces.length} pre-existing entries; ` +
        "a live run refuses to start until they are cleaned up or --allow-preexisting-workspaces is passed.",
      );
    }
    return;
  }

  if (preexistingWorkspaces.length > 0 && !flag("--allow-preexisting-workspaces")) {
    fail(
      `workspaces-v2 already holds ${preexistingWorkspaces.length} entries the matrix must not touch ` +
      `and code cells may collide with: ${preexistingWorkspaces.join(", ")}. ` +
      "Clean them up (or pass --allow-preexisting-workspaces to accept the collision risk).",
    );
  }

  // A fresh campaign starts a fresh manifest — stale attempts from an earlier
  // HEAD must never satisfy this campaign's consecutive-green bar.
  const manifest = flag("--resume")
    ? loadManifest()
    : {
        ...loadManifest(),
        startedAt: new Date().toISOString(),
        attempts: [],
        productClassCounts: {},
        harnessFailureCounts: {},
        // Per-cell verdicts are campaign-scoped like the attempts they
        // summarize: a fresh campaign must not inherit an earlier HEAD's
        // `done`/`not_run` stamps through the loadManifest() spread.
        cellStatus: {},
      };
  if (flag("--resume") && manifest.expectedHead && manifest.expectedHead !== expectedHead) {
    fail(`manifest pins ${manifest.expectedHead}; refusing to resume at ${expectedHead}.`);
  }
  if (flag("--resume") && manifest.gate && manifest.gate !== gate.id) {
    fail(`manifest pins gate ${manifest.gate}; refusing to resume as ${gate.id}.`);
  }
  if (flag("--resume") && manifest.model && manifest.model !== PROOF_MATRIX_MODEL) {
    fail(`manifest pins model ${manifest.model}; refusing to resume as ${PROOF_MATRIX_MODEL}.`);
  }
  manifest.expectedHead = expectedHead;
  manifest.gate = gate.id;
  manifest.model = PROOF_MATRIX_MODEL;
  if (flag("--resume")) {
    const reconciled = reconcileInFlightAttempt(manifest);
    if (reconciled) {
      console.log(
        `proof-matrix: previous runner died mid-attempt (${reconciled.cell}#${reconciled.attempt}); ` +
        `recorded as ${IN_FLIGHT_FAILURE_CLASS} — budget unspent, streak preserved.`,
      );
    }
  } else {
    clearAttemptInFlight(manifest);
  }
  saveManifest(manifest);

  for (const cell of cells) {
    while (
      gate.kind === "consecutive"
        ? consecutiveGreens(manifest, cell.id) < cell.requiredGreens &&
          consumedAttemptCount(manifest, cell.id) < cell.maxAttempts
        : consumedAttemptCount(manifest, cell.id) < gate.validAttemptsPerLane
    ) {
      // Ordinal over ALL runs of this cell (harness deaths included) so stage
      // labels and per-attempt log files never collide or overwrite.
      const attemptIndex = totalAttemptCount(manifest, cell.id) + 1;
      const stage = `${cell.id}#${attemptIndex}`;
      assertExactCleanHead(expectedHead, `${stage} pre`);
      // Reap what this campaign can PROVE it started, then refuse to launch
      // into a machine that is still dirty. `assertObsidianClosed` refusing is
      // correct behaviour — the fix is to not hand it a dirty machine, never to
      // start anyway.
      const campaignSinceMs = Date.parse(manifest.startedAt ?? "") || 0;
      const preSweep = await sweepTestVaultObsidianZombies(stage, campaignSinceMs);
      const blockingResidue = await drainCampaignObsidianResidue(
        stage,
        campaignSinceMs,
        preSweep,
      );
      if (blockingResidue.length > 0) {
        const residueDetail =
          `campaign-owned Obsidian residue did not drain within ` +
          `${Math.round(OBSIDIAN_RESIDUE_DRAIN_MS / 1000)}s` +
          (blockingResidue[0] === -1
            ? " (and the process table could not be read, so the machine is UNKNOWN, not clean)"
            : `: PID(s) ${blockingResidue.join(", ")} are still present`) +
          ". The attempt was NOT launched — starting it would only be refused by " +
          "the already-running gate after paying full lane startup.";
        console.warn(`proof-matrix[${stage}]: ${residueDetail}`);
        clearAttemptInFlight(manifest);
        recordUnlaunchedAttempt(manifest, {
          cell: cell.id,
          project: cell.project,
          attempt: attemptIndex,
          startedAt: new Date().toISOString(),
          durationS: 0,
          green: false,
          exitCode: null,
          failureClass: OBSIDIAN_RESIDUE_FAILURE_CLASS,
          confidence: CLASSIFICATION_CONFIRMED,
          secondaryClasses: [],
          failureDetail: residueDetail,
          toolEvents: null,
        });
        manifest.harnessFailureCounts = manifest.harnessFailureCounts ?? {};
        manifest.harnessFailureCounts[cell.id] =
          (manifest.harnessFailureCounts[cell.id] ?? 0) + 1;
        console.log(
          `proof-matrix[${stage}]: ${OBSIDIAN_RESIDUE_FAILURE_CLASS} is a harness death, not product evidence — ` +
          `attempt budget stays ${consumedAttemptCount(manifest, cell.id)}/${cell.maxAttempts}, streak preserved.`,
        );
        saveManifest(manifest);
        if (consecutiveHarnessFailures(manifest, cell.id) > MAX_CONSECUTIVE_HARNESS_FAILURES) {
          fail(
            `cell '${cell.id}' hit ${consecutiveHarnessFailures(manifest, cell.id)} consecutive ` +
            `harness/process failures (> ${MAX_CONSECUTIVE_HARNESS_FAILURES}) — a leaked Obsidian that ` +
            "never drains cannot be retried around. Clear it, then resume (--resume); no attempt budget " +
            "was spent on these deaths.",
          );
        }
        continue;
      }
      const workspacesBefore = listWorkspaceEntries();

      const env = {
        ...process.env,
        E2E_AI_MODEL: PROOF_MATRIX_MODEL,
        E2E_MODEL_PROVIDER: process.env.E2E_MODEL_PROVIDER ?? "ollama",
        // The campaign writes the authoritative row after it adds attempt,
        // streak, and classification evidence. Prevent the child runner from
        // recording a second, less specific row for the same execution.
        E2E_RUN_METRICS_OWNER: "proof-matrix",
        // A campaign attempt must outwait a stray exclusive run, not burn an
        // attempt every 30 seconds against a held lock (the 2026-08-25 03:06
        // crash loop exhausted a cell in 90 seconds this way). Explicit
        // caller values still win.
        OBSIDIAN_E2E_LOCK_WAIT_MS:
          process.env.OBSIDIAN_E2E_LOCK_WAIT_MS ?? String(20 * 60 * 1000),
      };
      const runnerArgs = [
        path.join(REPO_ROOT, "scripts", "run-e2e-exclusive.mjs"),
        "--real-ai",
        `--project=${cell.project}`,
      ];
      if (cell.grep) runnerArgs.push(`--grep=${cell.grep}`);

      const startedAt = Date.now();
      const attemptStartedAt = new Date(startedAt).toISOString();
      // Persist the manifest BEFORE launching: if the runner dies mid-attempt
      // the marker survives (outside the wiped tree), and the next --resume
      // reconciles it instead of silently restarting the campaign from zero.
      markAttemptInFlight(manifest, {
        cell: cell.id,
        project: cell.project,
        attempt: attemptIndex,
        startedAt: attemptStartedAt,
      });
      saveManifest(manifest);
      // Attempt output goes to a per-attempt file, not the launcher console:
      // detached campaigns have no console, and a red attempt whose stderr is
      // gone is undiagnosable (the 2026-08-25 02:37 crash loop left nothing).
      // Claim/truncate the path before launch because fresh campaigns reuse
      // ordinals; otherwise a live tail can show a prior campaign's result.
      // The log dir lives in proof-matrix-state/ so Playwright's test-results
      // wipe can never delete a log mid-write again.
      mkdirSync(ATTEMPT_LOG_DIR, { recursive: true });
      const attemptLogPath = path.join(ATTEMPT_LOG_DIR, `${cell.id}-attempt-${attemptIndex}.log`);
      initializeAttemptLogFile(attemptLogPath, {
        campaignStartedAt: manifest.startedAt,
        attemptStartedAt,
        expectedHead,
        model: PROOF_MATRIX_MODEL,
        cell: cell.id,
        project: cell.project,
        attempt: attemptIndex,
      });
      console.log(
        `proof-matrix[${stage}]: node ${runnerArgs.map((a) => path.basename(a)).join(" ")}` +
        ` (output: ${path.relative(REPO_ROOT, attemptLogPath)})`,
      );
      // Freshness reference for the run summary: its exact mtime BEFORE the
      // child launches. A summary counts as this attempt's only when it is
      // strictly newer than this.
      const summaryMtimeBeforeLaunch = fileMtimeMs(RUN_SUMMARY_PATH);
      const result = spawnSync(process.execPath, runnerArgs, {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      appendFileSync(
        attemptLogPath,
        `${result.stdout ?? ""}${result.stderr ?? ""}`,
      );
      try {
        copyFileSync(
          PLAYWRIGHT_EXECUTION_REPORT_PATH,
          `${attemptLogPath}.playwright-report.json`,
        );
      } catch {
        // Report is best-effort; Playwright only writes it after a real run.
      }
      const endedAt = Date.now();
      const exitCode = result.status ?? 1;
      let green = exitCode === 0;
      let attemptLogText = "";
      try {
        attemptLogText = readFileSync(attemptLogPath, "utf8");
      } catch {
        // The excerpt is best-effort; classification falls back to the tail rule.
      }

      await sweepTestVaultObsidianZombies(`${stage} post`, campaignSinceMs);
      removeCampaignWorkspaceDebris(workspacesBefore, stage);
      assertExactCleanHead(expectedHead, `${stage} post`);

      const summary = readJsonFile(RUN_SUMMARY_PATH);
      // One freshness verdict feeds BOTH classification and tool-event
      // sourcing — two predicates would eventually disagree.
      const summaryFresh = summaryWrittenSince(
        RUN_SUMMARY_PATH,
        summaryMtimeBeforeLaunch,
      );
      const classification = classifyAttemptOutcome({
        exitCode,
        summary,
        summaryFresh,
        logText: attemptLogText,
      });
      let {
        failureClass,
        detail: failureDetail,
        confidence,
        secondaryClasses,
      } = classification;

      // METRIC INTEGRITY: the lane refused to start because the environment it
      // requires is not configured, so it measured nothing. Stop the cell here,
      // before ANY of the recording below runs:
      //   - no CSV row       — a run that never happened has no run metrics,
      //                        and every reader of playwright-run-metrics.csv
      //                        counts each row in its pass-rate denominator;
      //   - no attempt record — budget and streak stay exactly where they were,
      //                        and nothing can later read as "attempted";
      //   - no in-flight marker — otherwise the next --resume would reconcile
      //                        it into a phantom attempt;
      //   - cellStatus not_run — the positive record: neither green nor red.
      // Burning the budget on a misconfiguration is waste; scoring it is a lie.
      if (failureClass === ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS) {
        const missing = classification.missingEnvironment ?? [];
        const missingList = missing.join(", ");
        clearAttemptInFlight(manifest);
        recordCellStatus(manifest, cell.id, CELL_STATUS_NOT_RUN, {
          failureClass,
          missingEnvironment: missing,
          detectedAt: new Date(endedAt).toISOString(),
          project: cell.project,
          attemptsConsumed: consumedAttemptCount(manifest, cell.id),
          maxAttempts: cell.maxAttempts,
          attemptLog: path.relative(REPO_ROOT, attemptLogPath),
          note:
            "the lane threw on required environment that is not configured, before it exercised the " +
            "product: not an attempt, not a red, not scored",
        });
        saveManifest(manifest);
        fail(
          `cell '${cell.id}' did NOT RUN — required environment not configured: ${missingList}. ` +
          `${cell.project} threw before it exercised the product, so this is neither a green nor a red: ` +
          `no attempt budget was spent (${consumedAttemptCount(manifest, cell.id)}/${cell.maxAttempts} ` +
          `still available), no streak was recorded, and the manifest marks the cell '${CELL_STATUS_NOT_RUN}'. ` +
          `Set ${missingList} in the campaign environment (PowerShell) and re-run with --resume. ` +
          `Attempt log: ${path.relative(REPO_ROOT, attemptLogPath)}.`,
        );
      }

      // METRIC INTEGRITY: the product was exercised and every assertion passed;
      // only mandatory harness cleanup failed. Loud, and still a failed run —
      // a leaked Obsidian is real and poisons the NEXT lane's already-running
      // check — but it is NOT product-assertion evidence, so it must not be
      // recorded as one. It is `harness:` prefixed (budget-exempt and
      // streak-neutral through isInfrastructureFailureClass) and it writes no
      // CSV row below.
      if (failureClass === HARNESS_CLEANUP_FAILURE_CLASS) {
        console.error(
          `proof-matrix[${stage}]: HARNESS CLEANUP FAILED after PASSING assertions — ` +
          `${classification.cleanupFailure?.detail ?? ""}\n` +
          `  The mission succeeded; the harness could not tear itself down. Check for a leaked ` +
          `Obsidian process before the next lane runs (it will fail its already-running gate). ` +
          `Not scored as a product failure: no attempt budget spent, streak preserved, no run-metrics row.`,
        );
      } else if (!green) {
        console.error(
          `proof-matrix[${stage}]: red (exit ${exitCode}, ${failureClass}). Attempt log tail:\n` +
          attemptLogExcerpt(attemptLogText),
        );
      }
      const toolEvents = resolveAttemptToolEvents({
        summary,
        summaryFresh,
        minedCounts: mineToolEvents(startedAt, endedAt),
      });
      if ((toolEvents.failed ?? 0) > 0) {
        const details = Array.isArray(toolEvents.failureDetails)
          ? JSON.stringify(toolEvents.failureDetails)
          : "unavailable";
        console.warn(
          `proof-matrix[${stage}]: mission outcome may still be green, but ` +
            `${toolEvents.failed}/${toolEvents.observed ?? "?"} tool calls failed; ` +
            `content-free failure details=${details}` +
            (toolEvents.failureDetailsTruncated === true ? " (truncated)" : ""),
        );
      }
      const acceptance = summarizeAttemptAcceptance(
        summary,
        summaryFresh,
        cell.scenarioId,
      );
      const usage = summarizeAttemptUsage(summary, summaryFresh, cell.scenarioId);
      const campaignVerdict = resolveCampaignAttemptVerdict({
        green,
        failureClass,
        failureDetail,
        confidence,
        secondaryClasses,
        acceptance,
      });
      green = campaignVerdict.green;
      failureClass = campaignVerdict.failureClass;
      failureDetail = campaignVerdict.failureDetail;
      confidence = campaignVerdict.confidence;
      secondaryClasses = campaignVerdict.secondaryClasses;
      if (failureClass === ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS) {
        console.error(
          `proof-matrix[${stage}]: ${failureDetail} ` +
            "The application assertions passed, but this cannot count as a campaign green.",
        );
      }
      const sourceKnown = toolEvents.source !== TOOL_EVENT_SOURCE_NONE;
      const observedKnown = sourceKnown && toolEvents.observed !== null;
      const failedKnown = observedKnown && toolEvents.failed !== null;
      const pctFailed =
        failedKnown && toolEvents.observed > 0
          ? ((100 * toolEvents.failed) / toolEvents.observed).toFixed(1) + "%"
          : "";
      const pctSucceeded =
        failedKnown && toolEvents.observed > 0
          ? ((100 * toolEvents.succeeded) / toolEvents.observed).toFixed(1) + "%"
          : "";
      const bucketCell = (key) =>
        sourceKnown && toolEvents.buckets ? toolEvents.buckets[key] ?? "" : "";
      const consumesBudget = green || !isInfrastructureFailureClass(failureClass);
      const attemptBudget = gate.kind === "consecutive"
        ? cell.maxAttempts
        : gate.validAttemptsPerLane;
      const csvNotes = consumesBudget
        ? `gate ${gate.id}; attempt ${consumedAttemptCount(manifest, cell.id) + 1}/${attemptBudget}; ` +
          (gate.kind === "consecutive"
            ? `streak target ${cell.requiredGreens}`
            : `lane minimum ${gate.minimumGreensPerLane}/${gate.validAttemptsPerLane}`)
        : `harness failure ${harnessFailureCount(manifest, cell.id) + 1}; ` +
          `attempt budget ${consumedAttemptCount(manifest, cell.id)}/${attemptBudget} unspent; streak preserved`;

      // Unknown vs zero is explicit: a fresh summary that said zero writes an
      // explicit 0; blank means NO source was available (tool_events_source
      // says which case a row is).
      //
      // A harness-cleanup failure writes NO row at all, for the same reason
      // `environment_not_configured` writes none: every reader of
      // playwright-run-metrics.csv (eval-kpis, eval-dashboard and the notebook
      // it generates, eval-tool-events) counts each row in its pass-rate
      // denominator and classifies only green/not-green. There is no way to
      // spell "the product passed but the harness leaked" in that vocabulary —
      // a row would read as a product red, which is the exact
      // misattribution this class exists to end. The manifest attempt record
      // below keeps the event durable and greppable.
      //
      // Generalized to the ONE shared predicate rather than naming each class:
      // the reasoning is identical for every infrastructure outcome, and a
      // per-class list is how the third one (provider quota) got missed. A
      // measurement of 102 recorded rows found 23 that were `harness:*`,
      // `process:*` or `environment_not_configured` and every one of them was
      // counted as a product red — 41/102 = 40.2% reported, 41/79 = 51.9%
      // once infrastructure is excluded. Green runs always write their row;
      // only non-product failures are withheld, so this can never inflate a
      // pass rate by hiding a product red.
      if (green || !isInfrastructureFailureClass(failureClass)) appendRunCsvRow([
        new Date(startedAt).toISOString(),
        cell.project,
        PROOF_MATRIX_MODEL,
        expectedHead,
        Math.round((endedAt - startedAt) / 1000),
        acceptance.missionOutcome,
        failureClass,
        green
          ? ""
          : `matrix ${stage} exit ${exitCode}` +
            (failureDetail ? `: ${failureDetail.split(/\r?\n/u).at(-1).slice(0, 160)}` : ""),
        observedKnown ? toolEvents.observed : "",
        failedKnown ? toolEvents.failed : "",
        pctFailed,
        bucketCell("tool_not_allowed"),
        bucketCell("mission_graph_authority_blocked"),
        bucketCell("invalid_arguments"),
        bucketCell("execution_failed"),
        bucketCell("authority_grant_invalid"),
        bucketCell("tool_failure_terminal"),
        "proof-matrix",
        csvNotes,
        toolEvents.source,
        failedKnown ? toolEvents.succeeded : "",
        pctSucceeded,
        secondaryClasses.join(";"),
        confidence,
        toolEvents.vacuous ?? "",
        bucketCell("frontier_narrowed_mid_response"),
        bucketCell("frontier_withheld_since_earlier_step"),
        green ? "passed" : "failed",
        acceptance.acceptanceStatus,
        acceptance.scorecardTotal ?? "",
        acceptance.scorecardAcceptancePassed ?? "",
        acceptance.retries ?? "",
        acceptance.artifactProofCount ?? "",
        acceptance.cleanupProofCount ?? "",
        ...usageCsvCells(usage),
      ]);

      // The attempt finished (green or red) — the in-flight marker is now
      // superseded by the real record below.
      clearAttemptInFlight(manifest);
      manifest.attempts.push({
        cell: cell.id,
        project: cell.project,
        attempt: attemptIndex,
        startedAt: new Date(startedAt).toISOString(),
        durationS: Math.round((endedAt - startedAt) / 1000),
        green,
        exitCode,
        failureClass,
        confidence,
        secondaryClasses,
        ...(green
          ? {}
          : {
              failureDetail,
              attemptLog: path.relative(REPO_ROOT, attemptLogPath),
            }),
        // source/succeeded/vacuous mirror the CSV columns; null = unknown.
        toolEvents,
        acceptance,
      });

      if (!consumesBudget) {
        manifest.harnessFailureCounts = manifest.harnessFailureCounts ?? {};
        manifest.harnessFailureCounts[cell.id] =
          (manifest.harnessFailureCounts[cell.id] ?? 0) + 1;
        console.log(
          `proof-matrix[${stage}]: ${failureClass} is a harness death, not product evidence — ` +
          `attempt budget stays ${consumedAttemptCount(manifest, cell.id)}/${attemptBudget}, streak preserved.`,
        );
        if (consecutiveHarnessFailures(manifest, cell.id) > MAX_CONSECUTIVE_HARNESS_FAILURES) {
          saveManifest(manifest);
          fail(
            `cell '${cell.id}' hit ${consecutiveHarnessFailures(manifest, cell.id)} consecutive ` +
            `harness/process failures (> ${MAX_CONSECUTIVE_HARNESS_FAILURES}) — the build or harness is ` +
            "persistently broken and budget-exempt retries would loop forever. Fix the harness at the pinned " +
            "HEAD, then resume (--resume); no attempt budget was spent on these deaths.",
          );
        }
      }
      if (!green && registerProductFailure(manifest, failureClass)) {
        saveManifest(manifest);
        fail(
          `product failure class '${failureClass}' seen twice — regression alarm. ` +
          "The matrix stops here; fix the product before resuming (--resume).",
        );
      }
      if (!green && gate.rejectAnyProductFailure && failureClass.startsWith("product:")) {
        saveManifest(manifest);
        fail(
          `target gate encountered product failure '${failureClass}' — stop before spending more attempts, ` +
          "repair it, and restart the exact-HEAD campaign.",
        );
      }
      saveManifest(manifest);

      if (failureClass === ACCEPTANCE_PROOF_MISSING_FAILURE_CLASS) {
        fail(
          `cell '${cell.id}' cannot emit the accepted mission/scorecard proof required by every ` +
            "reliability gate. Repair the lane instrumentation, commit it, and start a fresh exact-HEAD campaign.",
        );
      }

      if (green && !laneHasScorecardBaseline(cell.project)) {
        console.log(`proof-matrix[${stage}]: first green for unbaselined lane — harvesting scorecards.`);
        const harvest = runNpmCaptured(["run", "scorecards:harvest"], env);
        if (harvest.output) process.stdout.write(harvest.output);
        if (harvest.status !== 0) {
          if (isEmptyScorecardHarvestOutput(harvest.output)) {
            console.log(
              `proof-matrix[${stage}]: lane has no harvestable scorecard; continuing without a baseline record.`,
            );
          } else {
            fail(`${stage}: scorecards:harvest failed after a green run.`);
          }
        } else if (runNpm(["run", "check:mission-scorecards"], env) !== 0) {
          fail(`${stage}: check:mission-scorecards failed right after harvest.`);
        }
      }
    }

    if (gate.kind === "consecutive") {
      const streak = consecutiveGreens(manifest, cell.id);
      const cellVerdict = {
        project: cell.project,
        greens: streak,
        requiredGreens: cell.requiredGreens,
        attemptsConsumed: consumedAttemptCount(manifest, cell.id),
        maxAttempts: cell.maxAttempts,
      };
      if (streak < cell.requiredGreens) {
        recordCellStatus(manifest, cell.id, CELL_STATUS_EXHAUSTED, cellVerdict);
        saveManifest(manifest);
        fail(
          `cell '${cell.id}' exhausted ${cell.maxAttempts} attempts with streak ${streak}/${cell.requiredGreens}. ` +
          "Investigate before spending more.",
        );
      }
      recordCellStatus(manifest, cell.id, CELL_STATUS_DONE, cellVerdict);
      console.log(`proof-matrix: cell '${cell.id}' DONE (${streak} consecutive greens).`);
    } else {
      const valid = consumedAttemptCount(manifest, cell.id);
      const greens = manifest.attempts.filter(
        (attempt) => attempt.cell === cell.id && attempt.green,
      ).length;
      console.log(`proof-matrix: cell '${cell.id}' COLLECTED (${greens}/${valid} greens).`);
    }
  }

  saveManifest(manifest);
  if (gate.kind === "fixed-attempts") {
    const evaluation = evaluateReliabilityCampaign({
      gate,
      cells,
      attempts: manifest.attempts.filter((attempt) =>
        cells.some((cell) => cell.id === attempt.cell)),
    });
    manifest.evaluation = evaluation;
    saveManifest(manifest);
    console.log(JSON.stringify(evaluation, null, 2));
    if (!evaluation.passed) {
      fail(`${gate.id} gate failed: ${evaluation.failures.join("; ")}`);
    }
    for (const cell of cells) {
      recordCellStatus(manifest, cell.id, CELL_STATUS_DONE, {
        project: cell.project,
        attemptsConsumed: consumedAttemptCount(manifest, cell.id),
        gate: gate.id,
      });
    }
    saveManifest(manifest);
    console.log(
      `proof-matrix: ${gate.id} PASSED with ${evaluation.greens}/${evaluation.validAttempts} observed greens.` +
      (evaluation.observedPerfectCampaign
        ? " This campaign observed 100%; it is not a guarantee of future reliability."
        : ""),
    );
  } else {
    console.log("proof-matrix: all selected cells reached their consecutive-green bar.");
  }
  console.log("proof-matrix: run `npm run eval:dashboard` to refresh the KPI dashboard, and finish the campaign with the 8-stage workflow audit bookend.");
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => fail(String(error?.stack ?? error)));
}
