// Repeat-green proof matrix over the six daily-mission lanes.
//
// Purpose: replace "one successful specimen" with consecutive-green evidence at
// one exact HEAD. Each cell is one lane run through the sanctioned exclusive
// runner (scripts/run-e2e-exclusive.mjs); a cell is DONE when it has recorded
// the required number of CONSECUTIVE greens (a red resets the streak). The
// campaign fails fast when any `product:` failure class is seen twice — that is
// a regression alarm, not a statistic.
//
// Environment (PowerShell only — Git Bash mangles AGENTIC_SANDBOX_CI_RUNTIME_ROOT):
//   PROOF_MATRIX_EXPECTED_HEAD   exact 40-char lowercase sha this campaign pins
//   E2E_OLLAMA_API_KEY           real-model credential (cloud API)
//   LINEAR_LIVE_TEST_TEAM_ID     required by Linear-exercising lanes
//   E2E_GITHUB_TOKEN             required by GitHub-exercising lanes
// The model is hard-pinned (deepseek-v4-pro) regardless of E2E_AI_MODEL, the
// same rule the 8-stage workflow audit applies.
//
// Usage:
//   node scripts/run-proof-matrix.mjs [--cells=a,b] [--dry-run] [--resume]
//                                     [--allow-preexisting-workspaces]
//
// Evidence duties handled per attempt (previously hand-maintained):
//   - one row appended to docs/eval/playwright-run-metrics.csv
//   - per-attempt tool-event counts mined from the vault's persisted mission
//     graphs (same node vocabulary as scripts/eval-tool-events.mjs)
//   - manifest accumulated at test-results/proof-matrix-manifest.json
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const EVAL_DIR = path.join(REPO_ROOT, "docs", "eval");
const RUN_CSV = path.join(EVAL_DIR, "playwright-run-metrics.csv");
const MANIFEST_PATH = path.join(REPO_ROOT, "test-results", "proof-matrix-manifest.json");
// Playwright wipes `test-results/` as its outputDir. Logs have to live outside
// that tree or every attempt truncates the file we just opened.
export const ATTEMPT_LOG_DIR = path.join(EVAL_DIR, "proof-matrix-logs");
const PLAYWRIGHT_EXECUTION_REPORT_PATH = path.join(
  REPO_ROOT,
  "test-results",
  "playwright-execution-report.json",
);
const RUN_SUMMARY_PATH = path.join(REPO_ROOT, "test-results", "daily-use-run-summary.json");
const SCORECARD_BASELINE_PATH = path.join(REPO_ROOT, "e2e", "baselines", "mission-scorecards.v1.json");
const GRAPH_DIR = path.join(
  process.env.USERPROFILE ?? "",
  "OneDrive",
  "Desktop",
  "test_vault_obsidian_ai",
  "Agent Runs",
  "Mission Graphs",
);
const WORKSPACES_ROOT = path.join(
  process.env.LOCALAPPDATA ?? "",
  "AgenticResearcher",
  "code",
  "workspaces-v2",
);

// Same pin rule as scripts/run-workflow-audit-e2e.mjs: matrix evidence is
// meaningful only on the recommended profile; other models come later, behind
// the behavioral canary.
const PROOF_MATRIX_MODEL = "deepseek-v4-pro";

const RUN_CSV_HEADER =
  "run_started_at,lane,model,head_sha,duration_s,mission_outcome,primary_failure_class," +
  "primary_failure_detail,tool_events_observed,tool_events_failed,pct_tool_calls_failed," +
  "tool_not_allowed,mission_graph_authority_blocked,invalid_arguments,execution_failed," +
  "authority_grant_invalid,tool_failure_terminal,data_source,notes";

/**
 * The six mission cells. `requiredGreens` are CONSECUTIVE; `maxAttempts`
 * bounds total spend per cell. Grep filters follow the audit's stage-6
 * precedent of pinning one scenario inside a larger spec.
 */
export const CELLS = [
  {
    id: "research-current-note",
    project: "daily-use-research",
    grep: "DU-02 proof-gated sourced writeback binds owned fetched passages",
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "vault-recall",
    project: "real-ai-soak",
    grep: "deep vault retrieval and semantic expansion",
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "code-delivery",
    project: "desktop-code-delivery-real-live",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "interrupted-continuation",
    project: "interrupted-continuation-live",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "notebook-execution",
    project: "notebook-execution-live",
    grep: null,
    requiredGreens: 2,
    maxAttempts: 4,
  },
  {
    id: "compound-linear-github",
    project: "compound-flow-real-live",
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

function git(args) {
  const result = spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) fail(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
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
    git(["status", "--porcelain=v1", "--untracked-files=all"]),
  );
  if (status !== "") {
    fail(`${stage}: working tree not clean:\n${status}`);
  }
}

/**
 * Kill leaked test-vault Obsidian processes between cells. Copied from
 * sweepTestVaultObsidianZombiesV1 (scripts/run-workflow-audit-e2e.mjs) — the
 * command-line filter guarantees a user's real-vault Obsidian is untouched.
 */
function sweepTestVaultObsidianZombies(stage) {
  if (process.platform !== "win32") return;
  const script =
    "$procs = @(Get-CimInstance Win32_Process -Filter \"Name = 'Obsidian.exe'\" | " +
    "Where-Object { $_.CommandLine -match 'test_vault_obsidian_ai' }); " +
    "foreach ($p in $procs) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }; " +
    "Write-Output $procs.Count";
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", timeout: 30_000, windowsHide: true },
  );
  const count = Number.parseInt(String(result.stdout ?? "").trim(), 10);
  if (Number.isFinite(count) && count > 0) {
    console.log(`proof-matrix[${stage}]: swept ${count} test-vault Obsidian zombie(s).`);
  }
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

const BLOCKER_BUCKETS = [
  ["tool_not_allowed", /tool_not_allowed/iu],
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
function mineToolEvents(windowStartMs, windowEndMs) {
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

function readJsonFile(file) {
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
];

/**
 * Failure class for a red attempt: prefer the lane's own proof-class
 * annotation, but only when the run summary was written during THIS attempt —
 * a summary left behind by an earlier run must not label a later failure.
 * Otherwise scan the attempt's captured output for harness-stage signatures.
 */
export function classifyAttemptOutcome({ exitCode, summary, summaryFresh, logText }) {
  if (exitCode === 0) return { failureClass: "none", detail: "" };
  if (summaryFresh) {
    const records = Array.isArray(summary?.records)
      ? summary.records
      : Array.isArray(summary)
        ? summary
        : [];
    for (const record of records) {
      const cls = record?.proofClass ?? record?.failureClass ?? null;
      if (typeof cls === "string" && cls.includes(":")) {
        return { failureClass: cls, detail: "" };
      }
    }
  }
  const text = typeof logText === "string" ? logText : "";
  for (const [pattern, failureClass] of HARNESS_LOG_SIGNATURES) {
    const match = pattern.exec(text);
    if (match) {
      return { failureClass, detail: attemptLogExcerpt(text, match.index) };
    }
  }
  return { failureClass: "process:matrix_unclassified", detail: attemptLogExcerpt(text) };
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

/** True when the run summary file was (re)written during the attempt window. */
function summaryWrittenDuring(file, windowStartMs) {
  try {
    return statSync(file).mtimeMs >= windowStartMs - 5_000;
  } catch {
    return false;
  }
}

function csvField(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function appendRunCsvRow(row) {
  mkdirSync(EVAL_DIR, { recursive: true });
  if (!existsSync(RUN_CSV)) {
    writeFileSync(RUN_CSV, RUN_CSV_HEADER + "\n");
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

function loadManifest() {
  return (
    readJsonFile(MANIFEST_PATH) ?? {
      startedAt: new Date().toISOString(),
      model: PROOF_MATRIX_MODEL,
      expectedHead: null,
      attempts: [],
      productClassCounts: {},
    }
  );
}

function saveManifest(manifest) {
  mkdirSync(path.dirname(MANIFEST_PATH), { recursive: true });
  writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + "\n");
}

function consecutiveGreens(manifest, cellId) {
  let streak = 0;
  for (const attempt of manifest.attempts) {
    if (attempt.cell !== cellId) continue;
    streak = attempt.green ? streak + 1 : 0;
  }
  return streak;
}

function attemptCount(manifest, cellId) {
  return manifest.attempts.filter((attempt) => attempt.cell === cellId).length;
}

async function main() {
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
    console.log(`proof-matrix dry run @ ${expectedHead}`);
    for (const cell of cells) {
      console.log(
        `  ${cell.id}: project=${cell.project}` +
        (cell.grep ? ` grep="${cell.grep}"` : "") +
        ` requiredGreens=${cell.requiredGreens} maxAttempts=${cell.maxAttempts}`,
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
    : { ...loadManifest(), startedAt: new Date().toISOString(), attempts: [], productClassCounts: {} };
  if (flag("--resume") && manifest.expectedHead && manifest.expectedHead !== expectedHead) {
    fail(`manifest pins ${manifest.expectedHead}; refusing to resume at ${expectedHead}.`);
  }
  manifest.expectedHead = expectedHead;

  for (const cell of cells) {
    while (
      consecutiveGreens(manifest, cell.id) < cell.requiredGreens &&
      attemptCount(manifest, cell.id) < cell.maxAttempts
    ) {
      const attemptIndex = attemptCount(manifest, cell.id) + 1;
      const stage = `${cell.id}#${attemptIndex}`;
      assertExactCleanHead(expectedHead, `${stage} pre`);
      sweepTestVaultObsidianZombies(stage);
      const workspacesBefore = listWorkspaceEntries();

      const env = {
        ...process.env,
        E2E_AI_MODEL: PROOF_MATRIX_MODEL,
        E2E_MODEL_PROVIDER: process.env.E2E_MODEL_PROVIDER ?? "ollama",
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
      // Attempt output goes to a per-attempt file, not the launcher console:
      // detached campaigns have no console, and a red attempt whose stderr is
      // gone is undiagnosable (the 2026-08-25 02:37 crash loop left nothing).
      mkdirSync(ATTEMPT_LOG_DIR, { recursive: true });
      const attemptLogPath = path.join(ATTEMPT_LOG_DIR, `${cell.id}-attempt-${attemptIndex}.log`);
      console.log(
        `proof-matrix[${stage}]: node ${runnerArgs.map((a) => path.basename(a)).join(" ")}` +
        ` (output: ${path.relative(REPO_ROOT, attemptLogPath)})`,
      );
      const result = spawnSync(process.execPath, runnerArgs, {
        cwd: REPO_ROOT,
        env,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      writeFileSync(
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
      const green = exitCode === 0;
      let attemptLogText = "";
      try {
        attemptLogText = readFileSync(attemptLogPath, "utf8");
      } catch {
        // The excerpt is best-effort; classification falls back to the tail rule.
      }

      sweepTestVaultObsidianZombies(`${stage} post`);
      removeCampaignWorkspaceDebris(workspacesBefore, stage);
      assertExactCleanHead(expectedHead, `${stage} post`);

      const summary = readJsonFile(RUN_SUMMARY_PATH);
      const { failureClass, detail: failureDetail } = classifyAttemptOutcome({
        exitCode,
        summary,
        summaryFresh: summaryWrittenDuring(RUN_SUMMARY_PATH, startedAt),
        logText: attemptLogText,
      });
      if (!green) {
        console.error(
          `proof-matrix[${stage}]: red (exit ${exitCode}, ${failureClass}). Attempt log tail:\n` +
          attemptLogExcerpt(attemptLogText),
        );
      }
      const toolEvents = mineToolEvents(startedAt, endedAt);
      const pctFailed = toolEvents.observed
        ? ((100 * toolEvents.failed) / toolEvents.observed).toFixed(1) + "%"
        : "";

      appendRunCsvRow([
        new Date(startedAt).toISOString(),
        cell.project,
        PROOF_MATRIX_MODEL,
        expectedHead.slice(0, 7),
        Math.round((endedAt - startedAt) / 1000),
        green ? "green" : "red",
        failureClass,
        green
          ? ""
          : `matrix ${stage} exit ${exitCode}` +
            (failureDetail ? `: ${failureDetail.split(/\r?\n/u).at(-1).slice(0, 160)}` : ""),
        toolEvents.observed || "",
        toolEvents.observed ? toolEvents.failed : "",
        pctFailed,
        toolEvents.buckets.tool_not_allowed || "",
        toolEvents.buckets.mission_graph_authority_blocked || "",
        toolEvents.buckets.invalid_arguments || "",
        toolEvents.buckets.execution_failed || "",
        toolEvents.buckets.authority_grant_invalid || "",
        toolEvents.buckets.tool_failure_terminal || "",
        "proof-matrix",
        `attempt ${attemptIndex}/${cell.maxAttempts}; streak target ${cell.requiredGreens}`,
      ]);

      manifest.attempts.push({
        cell: cell.id,
        project: cell.project,
        attempt: attemptIndex,
        startedAt: new Date(startedAt).toISOString(),
        durationS: Math.round((endedAt - startedAt) / 1000),
        green,
        exitCode,
        failureClass,
        ...(green
          ? {}
          : {
              failureDetail,
              attemptLog: path.relative(REPO_ROOT, attemptLogPath),
            }),
        toolEvents,
      });

      if (!green && failureClass.startsWith("product:")) {
        manifest.productClassCounts[failureClass] =
          (manifest.productClassCounts[failureClass] ?? 0) + 1;
        if (manifest.productClassCounts[failureClass] >= 2) {
          saveManifest(manifest);
          fail(
            `product failure class '${failureClass}' seen twice — regression alarm. ` +
            "The matrix stops here; fix the product before resuming (--resume).",
          );
        }
      }
      saveManifest(manifest);

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

    const streak = consecutiveGreens(manifest, cell.id);
    if (streak < cell.requiredGreens) {
      saveManifest(manifest);
      fail(
        `cell '${cell.id}' exhausted ${cell.maxAttempts} attempts with streak ${streak}/${cell.requiredGreens}. ` +
        "Investigate before spending more.",
      );
    }
    console.log(`proof-matrix: cell '${cell.id}' DONE (${streak} consecutive greens).`);
  }

  saveManifest(manifest);
  console.log("proof-matrix: all selected cells reached their consecutive-green bar.");
  console.log("proof-matrix: run `npm run eval:dashboard` to refresh the KPI dashboard, and finish the campaign with the 8-stage workflow audit bookend.");
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  main().catch((error) => fail(String(error?.stack ?? error)));
}
