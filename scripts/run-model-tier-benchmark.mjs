// Model-tier benchmark over the proof-matrix cells.
//
// This runner measures model suitability without changing the proof matrix's
// canonical campaign manifest. It deliberately shares classification, tool
// event, and acceptance evidence with run-proof-matrix.mjs so the benchmark
// cannot invent a second definition of green.

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ATTEMPT_LOG_DIR,
  CELLS,
  TOOL_EVENT_SOURCE_NONE,
  appendRunCsvRow,
  attemptLogExcerpt,
  classifyAttemptOutcome,
  extractPlaywrightReportErrorText,
  fileMtimeMs,
  isInfrastructureFailureClass,
  mineToolEvents,
  readJsonFile,
  resolveAttemptToolEvents,
  summarizeAttemptAcceptance,
  summaryWrittenSince,
  writeJsonAtomic,
} from "./run-proof-matrix.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUN_SUMMARY_PATH = path.join(REPO_ROOT, "test-results", "daily-use-run-summary.json");
const PLAYWRIGHT_REPORT_PATH = path.join(
  REPO_ROOT,
  "test-results",
  "playwright-execution-report.json",
);
const BENCHMARK_ROOT = path.dirname(ATTEMPT_LOG_DIR);
const BENCHMARK_LOG_DIR = path.join(BENCHMARK_ROOT, "benchmark-logs");
const BENCHMARK_STATE_PATH = path.join(BENCHMARK_ROOT, "model-tier-benchmark.json");

export const DEFAULT_BENCHMARK_CELL_IDS = Object.freeze([
  "research-current-note",
  "vault-recall",
  "code-delivery",
]);
export const DEFAULT_BENCHMARK_MODELS = Object.freeze([
  "glm-5.3-flash:cloud",
  "glm-5.3:cloud",
  "kimi-k3:cloud",
  "deepseek-v4-pro",
]);
export const BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS =
  "harness:benchmark_evidence_missing";

const USAGE = `Model-tier benchmark

Options:
  --model=<tag>       Benchmark one exact model tag.
  --models=<a,b>      Benchmark an ordered comma-separated model list.
  --cells=<a,b>       Select proof-matrix cell ids.
  --attempts=<n>      Attempts per model/cell (default: 1).
  --dry-run           Print the complete execution plan without writing files.
  --help              Print this help.
`;

function fail(message) {
  throw new Error(`model-tier-benchmark: ${message}`);
}

function parseCsvOption(value, optionName) {
  const values = [...new Set(
    String(value ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
  )];
  if (values.length === 0) {
    fail(`${optionName} must contain at least one non-empty value.`);
  }
  return values;
}

function optionValue(argument, name) {
  const prefix = `${name}=`;
  return argument.startsWith(prefix) ? argument.slice(prefix.length) : null;
}

export function parseBenchmarkOptions(argv = process.argv.slice(2)) {
  let model = null;
  let models = null;
  let cells = null;
  let attempts = null;
  let dryRun = false;
  let help = false;

  for (const argument of argv) {
    if (argument === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }

    const singleModel = optionValue(argument, "--model");
    if (singleModel !== null) {
      if (model !== null) fail("--model may be specified only once.");
      model = singleModel.trim();
      if (!model) fail("--model requires a non-empty exact tag.");
      continue;
    }

    const modelList = optionValue(argument, "--models");
    if (modelList !== null) {
      if (models !== null) fail("--models may be specified only once.");
      models = parseCsvOption(modelList, "--models");
      continue;
    }

    const cellList = optionValue(argument, "--cells");
    if (cellList !== null) {
      if (cells !== null) fail("--cells may be specified only once.");
      cells = parseCsvOption(cellList, "--cells");
      continue;
    }

    const attemptValue = optionValue(argument, "--attempts");
    if (attemptValue !== null) {
      if (attempts !== null) fail("--attempts may be specified only once.");
      attempts = Number.parseInt(attemptValue, 10);
      if (!/^\d+$/u.test(attemptValue) || !Number.isSafeInteger(attempts) || attempts < 1) {
        fail("--attempts must be a positive integer.");
      }
      continue;
    }

    fail(`unknown argument '${argument}'. Use --help for supported options.`);
  }

  if (model !== null && models !== null) {
    fail("use either --model or --models, not both.");
  }

  return {
    models: model !== null ? [model] : models ?? [...DEFAULT_BENCHMARK_MODELS],
    cellIds: cells ?? [...DEFAULT_BENCHMARK_CELL_IDS],
    attemptsPerCell: attempts ?? 1,
    dryRun,
    help,
  };
}

export function createBenchmarkPlan(options) {
  const cellsById = new Map(CELLS.map((cell) => [cell.id, cell]));
  const selectedCells = options.cellIds.map((id) => {
    const cell = cellsById.get(id);
    if (!cell) {
      fail(`unknown cell '${id}'. Known: ${CELLS.map((entry) => entry.id).join(", ")}`);
    }
    return cell;
  });

  const plan = [];
  for (const model of options.models) {
    for (const cell of selectedCells) {
      for (let attempt = 1; attempt <= options.attemptsPerCell; attempt += 1) {
        plan.push({ model, cell, attempt });
      }
    }
  }
  if (plan.length === 0) {
    fail("execution plan is empty; refusing a vacuous successful run.");
  }
  return plan;
}

export function hasAcceptedBenchmarkEvidence({ exitCode, summaryFresh, acceptance }) {
  return Boolean(
    exitCode === 0 &&
    summaryFresh === true &&
    acceptance?.acceptanceStatus === "pass" &&
    acceptance?.scorecardAcceptancePassed === true &&
    Number.isFinite(acceptance?.scorecardTotal),
  );
}

export function describeMissingBenchmarkEvidence({ summaryFresh, acceptance }) {
  const missing = [];
  if (!summaryFresh) missing.push("fresh run summary");
  if (acceptance?.acceptanceStatus !== "pass") missing.push("acceptanceStatus=pass");
  if (acceptance?.scorecardAcceptancePassed !== true) {
    missing.push("scorecardAcceptancePassed=true");
  }
  if (!Number.isFinite(acceptance?.scorecardTotal)) missing.push("finite scorecardTotal");
  return missing.join(", ");
}

function gitText(args) {
  const result = spawnSync("git", args, {
    cwd: REPO_ROOT,
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`git ${args.join(" ")} failed: ${String(result.stderr ?? result.stdout ?? "").trim()}`);
  }
  return String(result.stdout ?? "").trim();
}

export function assertBenchmarkExactCleanHead(expectedHead, readGit = gitText, stage = "benchmark") {
  const head = readGit(["rev-parse", "HEAD"]);
  if (head !== expectedHead) {
    fail(`${stage}: HEAD ${head || "(missing)"} != pinned ${expectedHead}.`);
  }
  const status = readGit(["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") {
    fail(`${stage}: working tree is not clean:\n${status}`);
  }
}

function percent(numerator, denominator) {
  return denominator > 0 ? `${((100 * numerator) / denominator).toFixed(1)}%` : "";
}

function safeModelFileName(model) {
  return model.replace(/[^A-Za-z0-9_.-]+/gu, "-");
}

function readFreshPlaywrightEvidence(reportMtimeBeforeLaunch) {
  if (!summaryWrittenSince(PLAYWRIGHT_REPORT_PATH, reportMtimeBeforeLaunch)) {
    return { fresh: false, text: "" };
  }
  const report = readJsonFile(PLAYWRIGHT_REPORT_PATH);
  return {
    fresh: report !== null,
    text: report === null ? "" : extractPlaywrightReportErrorText(report),
  };
}

export function runModelTierBenchmark(argv = process.argv.slice(2)) {
  const options = parseBenchmarkOptions(argv);
  if (options.help) {
    process.stdout.write(USAGE);
    return { planned: 0, launched: 0, recorded: 0, help: true };
  }

  const plan = createBenchmarkPlan(options);
  if (options.dryRun) {
    for (const entry of plan) {
      console.log(
        `model-tier-benchmark[dry-run]: ${entry.model} × ${entry.cell.id} ` +
        `(project=${entry.cell.project}${entry.cell.grep ? `, grep=${entry.cell.grep}` : ""}) ` +
        `attempt ${entry.attempt}/${options.attemptsPerCell}`,
      );
    }
    console.log(`model-tier-benchmark[dry-run]: planned=${plan.length} launched=0 recorded=0`);
    return { planned: plan.length, launched: 0, recorded: 0, help: false };
  }

  const expectedHead = gitText(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/u.test(expectedHead)) {
    fail(`cannot resolve a full Git HEAD (received '${expectedHead}').`);
  }
  assertBenchmarkExactCleanHead(expectedHead, gitText, "sweep preflight");
  const headShort = expectedHead.slice(0, 12);
  mkdirSync(BENCHMARK_LOG_DIR, { recursive: true });
  const state = readJsonFile(BENCHMARK_STATE_PATH) ?? { version: 2, sweeps: [] };
  state.version = 2;
  state.sweeps = Array.isArray(state.sweeps) ? state.sweeps : [];
  const sweep = {
    startedAt: new Date().toISOString(),
    completedAt: null,
    headShort,
    expectedHead,
    status: "running",
    plannedAttempts: plan.length,
    launchedAttempts: 0,
    recordedAttempts: 0,
    models: {},
  };
  state.sweeps.push(sweep);
  writeJsonAtomic(BENCHMARK_STATE_PATH, state);

  for (const entry of plan) {
    const { model, cell, attempt } = entry;
    const stage = `${model} ${cell.id}#${attempt}`;
    const runnerArgs = [
      path.join(REPO_ROOT, "scripts", "run-e2e-exclusive.mjs"),
      "--real-ai",
      `--project=${cell.project}`,
      ...(cell.grep ? [`--grep=${cell.grep}`] : []),
    ];
    const logPath = path.join(
      BENCHMARK_LOG_DIR,
      `${safeModelFileName(model)}-${cell.id}-attempt-${attempt}.log`,
    );
    console.log(
      `model-tier-benchmark[${stage}]: starting (log: ${path.relative(REPO_ROOT, logPath)})`,
    );
    assertBenchmarkExactCleanHead(expectedHead, gitText, `${stage} pre`);

    const summaryMtimeBeforeLaunch = fileMtimeMs(RUN_SUMMARY_PATH);
    const reportMtimeBeforeLaunch = fileMtimeMs(PLAYWRIGHT_REPORT_PATH);
    const startedAt = Date.now();
    sweep.launchedAttempts += 1;
    writeJsonAtomic(BENCHMARK_STATE_PATH, state);

    const child = spawnSync(process.execPath, runnerArgs, {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        E2E_AI_MODEL: model,
        E2E_MODEL_PROVIDER: process.env.E2E_MODEL_PROVIDER ?? "ollama",
        OBSIDIAN_E2E_LOCK_WAIT_MS: process.env.OBSIDIAN_E2E_LOCK_WAIT_MS ?? "60000",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const endedAt = Date.now();
    const logText = `${child.stdout ?? ""}${child.stderr ?? ""}` +
      (child.error ? `\nspawn error: ${child.error.message}` : "");
    writeFileSync(logPath, logText);
    assertBenchmarkExactCleanHead(expectedHead, gitText, `${stage} post`);

    const freshReport = readFreshPlaywrightEvidence(reportMtimeBeforeLaunch);
    if (freshReport.fresh) {
      copyFileSync(PLAYWRIGHT_REPORT_PATH, `${logPath}.playwright-report.json`);
    }
    const combinedEvidenceText = [logText, freshReport.text].filter(Boolean).join("\n");
    const exitCode = child.status ?? 1;
    const summary = readJsonFile(RUN_SUMMARY_PATH);
    const summaryFresh = summaryWrittenSince(RUN_SUMMARY_PATH, summaryMtimeBeforeLaunch);
    const acceptance = summarizeAttemptAcceptance(summary, summaryFresh);
    const green = hasAcceptedBenchmarkEvidence({ exitCode, summaryFresh, acceptance });

    let classified;
    if (exitCode === 0 && !green) {
      const missing = describeMissingBenchmarkEvidence({ summaryFresh, acceptance });
      classified = {
        failureClass: BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS,
        detail: `runner exited 0 without required benchmark evidence: ${missing}`,
        confidence: "confirmed",
        secondaryClasses: [],
      };
    } else if (green) {
      classified = {
        failureClass: "none",
        detail: "",
        confidence: "confirmed",
        secondaryClasses: [],
      };
    } else {
      classified = classifyAttemptOutcome({
        exitCode,
        summary,
        summaryFresh,
        logText: combinedEvidenceText,
      });
    }

    const toolEvents = resolveAttemptToolEvents({
      summary,
      summaryFresh,
      minedCounts: mineToolEvents(startedAt, endedAt),
    });
    const sourceKnown = toolEvents.source !== TOOL_EVENT_SOURCE_NONE;
    const observedKnown = sourceKnown && toolEvents.observed !== null;
    const failedKnown = observedKnown && toolEvents.failed !== null;
    const bucketCell = (key) =>
      sourceKnown && toolEvents.buckets && key in toolEvents.buckets
        ? toolEvents.buckets[key]
        : "";
    const durationS = Math.round((endedAt - startedAt) / 1000);

    if (green || !isInfrastructureFailureClass(classified.failureClass)) {
      appendRunCsvRow([
        new Date(startedAt).toISOString(),
        cell.project,
        model,
        expectedHead,
        durationS,
        acceptance.missionOutcome,
        classified.failureClass,
        green ? "" : `benchmark ${stage} exit ${exitCode}: ${classified.detail}`.slice(0, 500),
        observedKnown ? toolEvents.observed : "",
        failedKnown ? toolEvents.failed : "",
        failedKnown ? percent(toolEvents.failed, toolEvents.observed) : "",
        bucketCell("tool_not_allowed"),
        bucketCell("mission_graph_authority_blocked"),
        bucketCell("invalid_arguments"),
        bucketCell("execution_failed"),
        bucketCell("authority_grant_invalid"),
        bucketCell("tool_failure_terminal"),
        "model-tier-benchmark",
        `benchmark ${model} attempt ${attempt}/${options.attemptsPerCell}`,
        toolEvents.source,
        failedKnown ? toolEvents.succeeded : "",
        failedKnown ? percent(toolEvents.succeeded, toolEvents.observed) : "",
        classified.secondaryClasses.join(";"),
        classified.confidence,
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
      ]);
    }

    const result = {
      cell: cell.id,
      project: cell.project,
      attempt,
      green,
      exitCode,
      failureClass: classified.failureClass,
      failureDetail: classified.detail,
      confidence: classified.confidence,
      secondaryClasses: classified.secondaryClasses,
      durationS,
      toolEvents,
      acceptance,
      logPath: path.relative(REPO_ROOT, logPath),
    };
    const modelState = sweep.models[model] ?? { results: [], tierBarMet: false };
    modelState.results.push(result);
    modelState.tierBarMet = DEFAULT_BENCHMARK_CELL_IDS.every((id) =>
      modelState.results.some((candidate) => candidate.cell === id && candidate.green),
    );
    sweep.models[model] = modelState;
    sweep.recordedAttempts += 1;
    writeJsonAtomic(BENCHMARK_STATE_PATH, state);

    console.log(
      `model-tier-benchmark[${stage}]: ${green ? "GREEN" : `red (${classified.failureClass})`} in ${durationS}s`,
    );
    if (!green) console.error(attemptLogExcerpt(combinedEvidenceText));

    if (classified.failureClass === BENCHMARK_EVIDENCE_MISSING_FAILURE_CLASS) {
      sweep.status = "failed";
      sweep.completedAt = new Date().toISOString();
      writeJsonAtomic(BENCHMARK_STATE_PATH, state);
      fail(
        `${stage} produced a vacuous exit-0 result without accepted fresh evidence; ` +
        "repair the harness before spending another provider call.",
      );
    }
  }

  if (sweep.launchedAttempts !== plan.length || sweep.recordedAttempts !== plan.length) {
    sweep.status = "failed";
    sweep.completedAt = new Date().toISOString();
    writeJsonAtomic(BENCHMARK_STATE_PATH, state);
    fail(
      `non-vacuity invariant failed: planned=${plan.length} ` +
      `launched=${sweep.launchedAttempts} recorded=${sweep.recordedAttempts}.`,
    );
  }

  sweep.status = "complete";
  sweep.completedAt = new Date().toISOString();
  writeJsonAtomic(BENCHMARK_STATE_PATH, state);
  for (const model of options.models) {
    const modelState = sweep.models[model];
    const greens = modelState.results.filter((result) => result.green).length;
    console.log(
      `model-tier-benchmark: ${model} → ${greens}/${modelState.results.length} green; ` +
      `tier bar (${DEFAULT_BENCHMARK_CELL_IDS.join("+")}) ` +
      `${modelState.tierBarMet ? "MET" : "not met"}`,
    );
  }
  console.log(
    `model-tier-benchmark: sweep complete at ${headShort}; ` +
    `planned=${plan.length} launched=${sweep.launchedAttempts} recorded=${sweep.recordedAttempts}; ` +
    `state → ${path.relative(REPO_ROOT, BENCHMARK_STATE_PATH)}`,
  );
  return {
    planned: plan.length,
    launched: sweep.launchedAttempts,
    recorded: sweep.recordedAttempts,
    help: false,
  };
}

if (
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1])
) {
  try {
    runModelTierBenchmark();
  } catch (error) {
    console.error(String(error?.stack ?? error));
    process.exitCode = 1;
  }
}
