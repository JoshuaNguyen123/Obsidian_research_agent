import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  FullResult,
  Reporter,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";

import {
  classifyDailyUseFailure,
  extractScenarioId,
  type DailyUseFailureCategory,
  type DailyUseTaskFamily,
} from "../fixtures/dailyUseFailureClassification";
import {
  DAILY_USE_ACCEPTANCE_V1,
  type DailyUseObservedAcceptanceV1,
  type DailyUseScenarioId,
} from "../../src/agent/dailyUseAcceptance";
import {
  createDailyUseRunMetricsV1,
  type DailyUseRunMetricsV1,
} from "../../src/agent/dailyUseRunMetrics";
import {
  DAILY_USE_METRICS_ANNOTATION,
  DAILY_USE_OBSERVED_ANNOTATION,
} from "../fixtures/dailyUseAcceptance";

interface DailyUseRunRecord extends Pick<
  DailyUseRunMetricsV1,
  | "modelCalls"
  | "toolCalls"
  | "continuations"
  | "approvals"
  | "artifactProofCount"
  | "cleanupProofCount"
  | "missingAcceptanceCriteria"
  | "acceptanceStatus"
  | "fingerprint"
> {
  version: 1;
  scenarioId: DailyUseScenarioId | null;
  taskFamily: DailyUseTaskFamily;
  project: string;
  file: string;
  title: string;
  status: string;
  durationMs: number;
  retry: number;
  failureCategory: DailyUseFailureCategory | null;
  observed: DailyUseObservedAcceptanceV1 | null;
}

export default class DailyUseReporter implements Reporter {
  private readonly records: DailyUseRunRecord[] = [];

  onTestEnd(test: TestCase, result: TestResult): void {
    const project = test.parent.project()?.name ?? "unknown";
    const relativeFile = path
      .relative(process.cwd(), test.location.file)
      .replace(/\\/gu, "/");
    const errorMessages = result.errors.map((error) => error.message ?? "");
    const classification = classifyDailyUseFailure({
      title: test.title,
      file: relativeFile,
      project,
      errorMessages,
    });
    const scenarioId = classification.scenarioId ?? extractScenarioId(test.title);
    const relevant =
      Boolean(scenarioId) ||
      project.toLowerCase().includes("daily-use") ||
      result.status !== "passed";
    if (!relevant) return;

    const typedScenarioId = isDailyUseScenarioId(scenarioId)
      ? scenarioId
      : null;
    const observed = typedScenarioId
      ? parseObservedAnnotation(test)
      : null;
    const annotatedMetrics = typedScenarioId
      ? parseMetricsAnnotation(test, typedScenarioId)
      : null;
    // The evaluator is invoked for every DU-labelled test. Missing annotations
    // remain explicit proof debt rather than being converted into a pass.
    const metrics = typedScenarioId
      ? createDailyUseRunMetricsV1({
          scenarioId: typedScenarioId,
          releaseSha: exactReleaseSha(),
          observed: observed ?? emptyObserved(),
          modelCalls: annotatedMetrics?.modelCalls,
          toolCalls: annotatedMetrics?.toolCalls,
          continuations: annotatedMetrics?.continuations,
          approvals: annotatedMetrics?.approvals,
          observedAt: new Date().toISOString(),
        })
      : null;
    this.records.push({
      version: 1,
      scenarioId: typedScenarioId,
      taskFamily: classification.taskFamily,
      project,
      file: relativeFile,
      title: test.title,
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
      failureCategory: result.status === "passed" ? null : classification.category,
      observed,
      modelCalls: metrics?.modelCalls ?? 0,
      toolCalls: metrics?.toolCalls ?? 0,
      continuations: metrics?.continuations ?? 0,
      approvals: metrics?.approvals ?? 0,
      artifactProofCount: metrics?.artifactProofCount ?? 0,
      cleanupProofCount: metrics?.cleanupProofCount ?? 0,
      missingAcceptanceCriteria: metrics?.missingAcceptanceCriteria ?? [],
      acceptanceStatus: metrics?.acceptanceStatus ?? "needs_more_work",
      fingerprint:
        metrics?.fingerprint ?? `sha256:${"0".repeat(64)}`,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
    // Playwright --list and an accidental zero-test selection must not erase a
    // valid exact-SHA daily-use summary from the most recent real run.
    if (!shouldWriteDailyUseSummary(this.records.length)) return;
    const outputDirectory = path.resolve(process.cwd(), "test-results");
    await mkdir(outputDirectory, { recursive: true });
    const payload = {
      version: 1,
      status: result.status,
      generatedAt: new Date().toISOString(),
      summaries: summarizeRecords(this.records),
      records: this.records,
    };
    await writeFile(
      path.join(outputDirectory, "daily-use-run-summary.json"),
      `${JSON.stringify(payload, null, 2)}\n`,
      "utf8",
    );
  }
}

function summarizeRecords(records: readonly DailyUseRunRecord[]) {
  const groups = new Map<string, DailyUseRunRecord[]>();
  for (const record of records) {
    const key = `${record.scenarioId ?? "unlabeled"}:${record.taskFamily}`;
    groups.set(key, [...(groups.get(key) ?? []), record]);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, group]) => {
      const durations = group.map((record) => record.durationMs).sort((a, b) => a - b);
      const scenarioId = group[0]?.scenarioId;
      const observed = mergeObserved(group);
      const metrics = scenarioId
        ? createDailyUseRunMetricsV1({
            scenarioId,
            releaseSha: exactReleaseSha(),
            observed,
            modelCalls: sum(group, "modelCalls"),
            toolCalls: sum(group, "toolCalls"),
            continuations: sum(group, "continuations"),
            approvals: sum(group, "approvals"),
            observedAt: new Date().toISOString(),
          })
        : null;
      return {
        key,
        runs: group.length,
        passed: group.filter((record) => record.status === "passed").length,
        retries: group.reduce((total, record) => total + record.retry, 0),
        medianDurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
        modelCalls: metrics?.modelCalls ?? 0,
        toolCalls: metrics?.toolCalls ?? 0,
        continuations: metrics?.continuations ?? 0,
        approvals: metrics?.approvals ?? 0,
        artifactProofCount: metrics?.artifactProofCount ?? 0,
        cleanupProofCount: metrics?.cleanupProofCount ?? 0,
        acceptanceStatus: metrics?.acceptanceStatus ?? "needs_more_work",
        missingAcceptanceCriteria:
          metrics?.missingAcceptanceCriteria ?? [],
      };
    });
}

export function shouldWriteDailyUseSummary(recordCount: number): boolean {
  return Number.isSafeInteger(recordCount) && recordCount > 0;
}

function parseObservedAnnotation(
  test: TestCase,
): DailyUseObservedAcceptanceV1 | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_OBSERVED_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    return {
      artifacts: stringArray(value.artifacts),
      proofs: stringArray(value.proofs),
      approvals: stringArray(value.approvals),
      bindings: stringArray(value.bindings),
      cleanup: stringArray(value.cleanup),
    };
  } catch {
    return null;
  }
}

function parseMetricsAnnotation(
  test: TestCase,
  scenarioId: DailyUseScenarioId,
): Pick<
  DailyUseRunMetricsV1,
  "modelCalls" | "toolCalls" | "continuations" | "approvals"
> | null {
  const raw = [...test.annotations]
    .reverse()
    .find((annotation) => annotation.type === DAILY_USE_METRICS_ANNOTATION)
    ?.description;
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.scenarioId !== scenarioId) return null;
    return {
      modelCalls: safeCounter(value.modelCalls),
      toolCalls: safeCounter(value.toolCalls),
      continuations: safeCounter(value.continuations),
      approvals: safeCounter(value.approvals),
    };
  } catch {
    return null;
  }
}

function mergeObserved(
  records: readonly DailyUseRunRecord[],
): DailyUseObservedAcceptanceV1 {
  const merge = (key: keyof DailyUseObservedAcceptanceV1) => [
    ...new Set(records.flatMap((record) => record.observed?.[key] ?? [])),
  ].sort();
  return {
    artifacts: merge("artifacts"),
    proofs: merge("proofs"),
    approvals: merge("approvals"),
    bindings: merge("bindings"),
    cleanup: merge("cleanup"),
  };
}

function emptyObserved(): DailyUseObservedAcceptanceV1 {
  return { artifacts: [], proofs: [], approvals: [], bindings: [], cleanup: [] };
}

function isDailyUseScenarioId(value: string | null): value is DailyUseScenarioId {
  return Boolean(value && value in DAILY_USE_ACCEPTANCE_V1);
}

function exactReleaseSha(): string | null {
  const value = process.env.E2E_RELEASE_COMMIT_SHA?.trim().toLowerCase();
  return value && /^[0-9a-f]{40}$/u.test(value) ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string =>
        typeof item === "string" && item.length > 0))].sort()
    : [];
}

function safeCounter(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? value as number
    : 0;
}

function sum(
  records: readonly DailyUseRunRecord[],
  key: "modelCalls" | "toolCalls" | "continuations" | "approvals",
): number {
  return records.reduce((total, record) => total + record[key], 0);
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}
