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

interface DailyUseRunRecord {
  version: 1;
  scenarioId: string | null;
  taskFamily: DailyUseTaskFamily;
  project: string;
  file: string;
  title: string;
  status: string;
  durationMs: number;
  retry: number;
  failureCategory: DailyUseFailureCategory | null;
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

    this.records.push({
      version: 1,
      scenarioId,
      taskFamily: classification.taskFamily,
      project,
      file: relativeFile,
      title: test.title,
      status: result.status,
      durationMs: result.duration,
      retry: result.retry,
      failureCategory: result.status === "passed" ? null : classification.category,
    });
  }

  async onEnd(result: FullResult): Promise<void> {
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
      return {
        key,
        runs: group.length,
        passed: group.filter((record) => record.status === "passed").length,
        retries: group.reduce((total, record) => total + record.retry, 0),
        medianDurationMs: percentile(durations, 0.5),
        p95DurationMs: percentile(durations, 0.95),
      };
    });
}

function percentile(sortedValues: readonly number[], fraction: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil(sortedValues.length * fraction) - 1),
  );
  return sortedValues[index];
}
