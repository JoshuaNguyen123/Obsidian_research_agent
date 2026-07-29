import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const DEFAULT_MISSION_SCORECARD_BASELINE_PATH = path.join(
  repoRoot,
  "e2e",
  "baselines",
  "mission-scorecards.v1.json",
);
export const DEFAULT_DAILY_USE_SUMMARY_PATH = path.join(
  repoRoot,
  "test-results",
  "daily-use-run-summary.json",
);

/**
 * Lanes that legitimately emit no mission scorecard, with the reason. Anything
 * not listed here and not in the baseline is treated as proof debt and fails.
 */
export const MISSION_SCORECARD_EXEMPT_PROJECTS = new Set([
  // No model calls: these drive production tools against real external
  // services, so there is no mission to score.
  "configured-linear-live",
  "linear-flow-real-cleanup",
  "github-askpass-runtime-live",
  "disposable-live-external",
  // Single-call provider smoke; qualifies a model, not a mission.
  "provider-canary",
  // Bare-prompt Desktop delivery with no scenario mapping: the daily-use
  // reporter records scenarioId=null for it, so no scorecard is ever emitted.
  // Its proof lives in the execution report and mission acceptance asserts.
  "desktop-code-delivery-real-live",
]);

const DIMENSION_IDS = Object.freeze([
  "acceptance_coverage",
  "evidence_grounding",
  "receipt_coverage",
  "recovery_cleanliness",
  "model_call_efficiency",
  "wall_clock_efficiency",
]);

export function missionScorecardRecordKey(record) {
  return [
    boundedString(record?.project, "project"),
    boundedString(record?.scenarioId, "scenarioId"),
    normalizeProofPath(record?.file),
    boundedString(record?.title, "title"),
  ].join("|");
}

export async function assertMissionScorecardSummaryFile(options = {}) {
  const baselinePath = path.resolve(
    options.baselinePath ?? DEFAULT_MISSION_SCORECARD_BASELINE_PATH,
  );
  const baseline = JSON.parse(await readFile(baselinePath, "utf8"));
  const selectedProjects = new Set(
    (options.selectedProjects ?? [])
      .filter((value) => typeof value === "string" && value.trim())
      .map((value) => value.trim()),
  );
  const baselineProjects = new Set(
    Array.isArray(baseline?.records)
      ? baseline.records.map((record) => String(record?.project ?? ""))
      : [],
  );
  // A project with no baseline record used to return success here, before the
  // summary file was even read. Because the only baseline record named a
  // deleted lane, that made the gate a no-op for every remaining project.
  // Absence of a baseline is now proof debt, reported loudly, and only the
  // named lanes below are allowed to carry none.
  const unbaselined = [...selectedProjects].filter(
    (project) =>
      !baselineProjects.has(project) &&
      !MISSION_SCORECARD_EXEMPT_PROJECTS.has(project),
  );
  if (unbaselined.length > 0) {
    throw new Error(
      `No mission-scorecard baseline exists for: ${unbaselined.join(", ")}. ` +
        "Harvest the scorecards from a green run into " +
        `${path.relative(process.cwd(), baselinePath).replace(/\\/gu, "/")}, ` +
        "or add the lane to MISSION_SCORECARD_EXEMPT_PROJECTS with a reason.",
    );
  }
  if (selectedProjects.size > 0 && baselineProjects.size === 0) {
    return { checkedRecords: 0, skipped: true, reason: "empty_baseline" };
  }

  const summaryPath = path.resolve(
    options.summaryPath ?? DEFAULT_DAILY_USE_SUMMARY_PATH,
  );
  const summary = JSON.parse(await readFile(summaryPath, "utf8"));
  return assertMissionScorecardRegressions({
    summary,
    baseline,
    selectedProjects: [...selectedProjects],
  });
}

export function assertMissionScorecardRegressions({
  summary,
  baseline,
  selectedProjects = [],
}) {
  validateBaseline(baseline);
  if (
    !summary ||
    typeof summary !== "object" ||
    summary.version !== 1 ||
    !Array.isArray(summary.records)
  ) {
    throw new Error("Mission scorecard regression gate requires a v1 daily-use summary.");
  }

  const activeProjects = new Set(
    selectedProjects.length > 0
      ? selectedProjects
      : summary.records.map((record) => String(record?.project ?? "")),
  );
  const applicableBaselines = baseline.records.filter((record) =>
    activeProjects.has(record.project),
  );
  if (applicableBaselines.length === 0) {
    return { checkedRecords: 0, skipped: true };
  }

  const currentByKey = new Map();
  for (const record of summary.records) {
    if (!activeProjects.has(String(record?.project ?? ""))) continue;
    const key = missionScorecardRecordKey(record);
    if (currentByKey.has(key)) {
      throw new Error(`Daily-use summary contains duplicate scorecard key ${key}.`);
    }
    currentByKey.set(key, record);
  }

  const failures = [];
  for (const expected of applicableBaselines) {
    const key = missionScorecardRecordKey(expected);
    if (expected.key !== key) {
      throw new Error(`Mission scorecard baseline key drifted: ${expected.key}.`);
    }
    const currentRecord = currentByKey.get(key);
    if (!currentRecord) {
      failures.push(`${key}: required baseline record is missing`);
      continue;
    }
    const current = validateScorecard(
      currentRecord.missionScorecard,
      `current scorecard ${key}`,
    );
    const previous = validateScorecard(
      expected.scorecard,
      `baseline scorecard ${key}`,
    );
    const previousById = new Map(
      previous.dimensions.map((dimension) => [dimension.id, dimension.score]),
    );
    for (const dimension of current.dimensions) {
      const baselineScore = previousById.get(dimension.id);
      if (baselineScore === undefined) continue;
      const delta = round4(dimension.score - baselineScore);
      if (delta < -Math.abs(baseline.tolerance)) {
        failures.push(
          `${key}: ${dimension.id} regressed ${baselineScore.toFixed(4)} -> ` +
            `${dimension.score.toFixed(4)} (delta=${delta.toFixed(4)})`,
        );
      }
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `Mission scorecard regression gate failed:\n- ${failures.join("\n- ")}`,
    );
  }
  return { checkedRecords: applicableBaselines.length, skipped: false };
}

function validateBaseline(value) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    !unitInterval(value.tolerance) ||
    !Array.isArray(value.records)
  ) {
    throw new Error("Mission scorecard baseline manifest is invalid.");
  }
  const keys = new Set();
  for (const record of value.records) {
    const key = missionScorecardRecordKey(record);
    if (record.key !== key || keys.has(key)) {
      throw new Error(`Mission scorecard baseline contains an invalid key: ${record?.key}.`);
    }
    keys.add(key);
    validateScorecard(record.scorecard, `baseline scorecard ${key}`);
  }
}

function validateScorecard(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.acceptancePassed !== "boolean" ||
    !unitInterval(value.total) ||
    !Array.isArray(value.dimensions) ||
    value.dimensions.length !== DIMENSION_IDS.length
  ) {
    throw new Error(`${label} is invalid.`);
  }
  const seen = new Set();
  for (const dimension of value.dimensions) {
    if (
      !DIMENSION_IDS.includes(dimension?.id) ||
      seen.has(dimension.id) ||
      !unitInterval(dimension.score) ||
      !unitInterval(dimension.weight)
    ) {
      throw new Error(`${label} contains an invalid dimension.`);
    }
    seen.add(dimension.id);
  }
  return value;
}

function normalizeProofPath(value) {
  return boundedString(value, "file").replace(/\\/gu, "/");
}

function boundedString(value, label) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.length > 500 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`Mission scorecard ${label} is invalid.`);
  }
  return value.trim();
}

function unitInterval(value) {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
  );
}

function round4(value) {
  return Math.round(value * 10_000) / 10_000;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void assertMissionScorecardSummaryFile()
    .then((result) => {
      console.log(
        result.skipped
          ? "Mission scorecard regression gate skipped: no baselined records were selected."
          : `Mission scorecard regression gate passed for ${result.checkedRecords} record(s).`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
