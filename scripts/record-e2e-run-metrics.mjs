import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import {
  BLOCKER_BUCKETS,
  appendRunCsvRow,
  classifyAttemptOutcome,
  extractPlaywrightReportErrorText,
  fileMtimeMs,
  resolveAttemptToolEvents,
  summarizeAttemptAcceptance,
  summarizeAttemptUsage,
  summaryWrittenSince,
  usageCsvCells,
} from "./run-proof-matrix.mjs";

/**
 * Record one directly-invoked exclusive E2E run. Proof-matrix children opt out
 * because their parent owns the richer attempt/streak row.
 */
export function recordExclusiveRunMetricsIfExecuted(input) {
  if (input.metricsOwner === "proof-matrix") {
    return { recorded: false, reason: "parent_owned" };
  }
  if (!summaryOrReportWasWritten(input)) {
    return { recorded: false, reason: "no_fresh_execution_evidence" };
  }
  const report = readJson(input.reportPath);
  if (!selectedProjectExecuted(report, input.projects)) {
    return { recorded: false, reason: "no_selected_test_executed" };
  }
  const summaryFresh = summaryWrittenSince(
    input.summaryPath,
    input.summaryMtimeBefore,
  );
  const summary = summaryFresh ? readJson(input.summaryPath) : null;
  const head = exactHead(input.repoRoot);
  const dirty = hasTrackedChanges(input.repoRoot);
  const row = buildExclusiveRunMetricRow({
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    projects: input.projects,
    model: input.model,
    head,
    dirty,
    exitCode: input.exitCode,
    summary,
    summaryFresh,
    logText: extractPlaywrightReportErrorText(report),
  });
  appendRunCsvRow(row);
  return { recorded: true, row };
}

export function buildExclusiveRunMetricRow(input) {
  const green = input.exitCode === 0;
  const classification = classifyAttemptOutcome({
    exitCode: input.exitCode,
    summary: input.summary,
    summaryFresh: input.summaryFresh,
    logText: input.logText ?? "",
  });
  const toolEvents = resolveAttemptToolEvents({
    summary: input.summary,
    summaryFresh: input.summaryFresh,
    minedCounts: { observed: 0, failed: 0, buckets: {} },
  });
  const acceptance = summarizeAttemptAcceptance(
    input.summary,
    input.summaryFresh,
  );
  const usage = summarizeAttemptUsage(input.summary, input.summaryFresh);
  const observedKnown = toolEvents.observed !== null;
  const failedKnown = observedKnown && toolEvents.failed !== null;
  const pctFailed = failedKnown && toolEvents.observed > 0
    ? `${((100 * toolEvents.failed) / toolEvents.observed).toFixed(1)}%`
    : "";
  const pctSucceeded = failedKnown && toolEvents.observed > 0
    ? `${((100 * toolEvents.succeeded) / toolEvents.observed).toFixed(1)}%`
    : "";
  const bucket = (key) =>
    toolEvents.buckets && Object.prototype.hasOwnProperty.call(toolEvents.buckets, key)
      ? toolEvents.buckets[key]
      : "";
  const startedAtMs = Number(input.startedAt);
  const endedAtMs = Number(input.endedAt);
  const durationSeconds = Number.isFinite(startedAtMs) && Number.isFinite(endedAtMs)
    ? Math.max(0, Math.round((endedAtMs - startedAtMs) / 1000))
    : "";
  const notes = [
    "direct exclusive runner",
    input.dirty ? "working tree dirty; not exact-HEAD release proof" : "exact-HEAD clean",
  ].join("; ");

  return [
    new Date(startedAtMs).toISOString(),
    input.projects.join("+"),
    String(input.model ?? "").trim(),
    input.head,
    durationSeconds,
    acceptance.missionOutcome,
    green ? "none" : classification.failureClass,
    green ? "" : classification.detail,
    observedKnown ? toolEvents.observed : "",
    failedKnown ? toolEvents.failed : "",
    pctFailed,
    bucket("tool_not_allowed"),
    bucket("mission_graph_authority_blocked"),
    bucket("invalid_arguments"),
    bucket("execution_failed"),
    bucket("authority_grant_invalid"),
    bucket("tool_failure_terminal"),
    "exclusive-runner",
    notes,
    toolEvents.source,
    failedKnown ? toolEvents.succeeded : "",
    pctSucceeded,
    classification.secondaryClasses.join(";"),
    classification.confidence,
    toolEvents.vacuous ?? "",
    bucket("frontier_narrowed_mid_response"),
    bucket("frontier_withheld_since_earlier_step"),
    green ? "passed" : "failed",
    acceptance.acceptanceStatus,
    acceptance.scorecardTotal ?? "",
    acceptance.scorecardAcceptancePassed ?? "",
    acceptance.retries ?? "",
    acceptance.artifactProofCount ?? "",
    acceptance.cleanupProofCount ?? "",
    ...usageCsvCells(usage),
  ];
}

export function selectedProjectExecuted(report, selectedProjects) {
  const projects = new Set(selectedProjects ?? []);
  let executed = false;
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (!projects.has(String(test.projectName ?? ""))) continue;
        if ((test.results ?? []).some((result) => result?.status && result.status !== "skipped")) {
          executed = true;
        }
      }
    }
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);
  return executed;
}

function summaryOrReportWasWritten(input) {
  return (
    summaryWrittenSince(input.summaryPath, input.summaryMtimeBefore) ||
    (fileMtimeMs(input.reportPath) !== null &&
      (input.reportMtimeBefore === null ||
        fileMtimeMs(input.reportPath) > input.reportMtimeBefore))
  );
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function exactHead(repoRoot) {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function hasTrackedChanges(repoRoot) {
  return execFileSync(
    "git",
    ["status", "--porcelain", "--untracked-files=no"],
    { cwd: repoRoot, encoding: "utf8", windowsHide: true },
  ).trim().length > 0;
}

// Import-time agreement guard: if the campaign adds a bucket, this recorder
// must keep emitting a column for it through the shared schema.
if (BLOCKER_BUCKETS.length !== 8) {
  throw new Error("Direct E2E metrics recorder is out of sync with blocker buckets.");
}
