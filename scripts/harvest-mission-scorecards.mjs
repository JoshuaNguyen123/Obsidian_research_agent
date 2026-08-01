import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_DAILY_USE_SUMMARY_PATH,
  DEFAULT_MISSION_SCORECARD_BASELINE_PATH,
  MISSION_SCORECARD_EXEMPT_PROJECTS,
  missionScorecardRecordKey,
} from "./mission-scorecard-regression.mjs";

/**
 * Lift mission scorecards from the last green run into the regression baseline.
 *
 * This is the local half of the proof loop. The gate compares each run against
 * a harvested baseline, but nothing produced one: the only path was to read a
 * run summary by hand, or download a CI artifact from a self-hosted runner that
 * no longer exists. Neither is a workflow.
 *
 * MERGES rather than replaces, which is the property that makes this usable
 * without CI: the three scored lanes take hours in total, but each can be run
 * and harvested independently, in any order, across separate sittings. Lanes
 * you did not run keep the records they already had.
 *
 * Refuses to harvest anything but a passing, fully-scored record — a baseline
 * built from a red or partial run would silently lower the bar it exists to
 * hold.
 */

function parseArgs(argv) {
  const options = {
    summaryPath: DEFAULT_DAILY_USE_SUMMARY_PATH,
    baselinePath: DEFAULT_MISSION_SCORECARD_BASELINE_PATH,
    dryRun: false,
  };
  for (const argument of argv) {
    if (argument === "--dry-run") {
      options.dryRun = true;
      continue;
    }
    const summary = /^--summary=(.+)$/u.exec(argument);
    if (summary) {
      options.summaryPath = path.resolve(summary[1]);
      continue;
    }
    const baseline = /^--baseline=(.+)$/u.exec(argument);
    if (baseline) {
      options.baselinePath = path.resolve(baseline[1]);
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

async function readJson(filePath, label) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(
        `No ${label} at ${path.relative(process.cwd(), filePath).replace(/\\/gu, "/")}.`,
      );
    }
    throw error;
  }
}

export function selectHarvestableRecords(summary) {
  if (
    !summary ||
    typeof summary !== "object" ||
    summary.version !== 1 ||
    !Array.isArray(summary.records)
  ) {
    throw new Error("Harvest requires a v1 daily-use run summary.");
  }
  const harvestable = [];
  const skipped = [];
  for (const record of summary.records) {
    const project = String(record?.project ?? "");
    const scenarioId =
      typeof record?.scenarioId === "string" ? record.scenarioId.trim() : "";
    // Guard tests carry no scenario mapping and nothing to regress.
    if (!scenarioId) continue;
    if (MISSION_SCORECARD_EXEMPT_PROJECTS.has(project)) {
      skipped.push(`${project}/${scenarioId}: lane is exempt from scorecards`);
      continue;
    }
    if (record.status !== "passed") {
      skipped.push(`${project}/${scenarioId}: run status was ${record.status}`);
      continue;
    }
    if (!record.missionScorecard) {
      skipped.push(`${project}/${scenarioId}: no mission scorecard emitted`);
      continue;
    }
    if (record.missionScorecard.acceptancePassed !== true) {
      skipped.push(`${project}/${scenarioId}: mission acceptance did not pass`);
      continue;
    }
    harvestable.push({
      key: missionScorecardRecordKey(record),
      project,
      scenarioId,
      file: String(record.file ?? "").replace(/\\/gu, "/"),
      title: String(record.title ?? ""),
      scorecard: record.missionScorecard,
    });
  }
  return { harvestable, skipped };
}

export function mergeBaselineRecords(existing, harvested) {
  const byKey = new Map();
  for (const record of existing) {
    byKey.set(record.key, { record, origin: "kept" });
  }
  const added = [];
  const updated = [];
  for (const record of harvested) {
    if (byKey.has(record.key)) {
      updated.push(record.key);
    } else {
      added.push(record.key);
    }
    byKey.set(record.key, { record, origin: "harvested" });
  }
  // Stable ordering keeps the committed diff to the records that changed.
  const records = [...byKey.values()]
    .map((entry) => entry.record)
    .sort((left, right) => left.key.localeCompare(right.key));
  return { records, added, updated };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const summary = await readJson(options.summaryPath, "daily-use run summary").catch(
    (error) => {
      throw new Error(
        `${error.message}\nRun a scored lane first, for example:\n  npm run test:e2e:research`,
      );
    },
  );

  const baseline = await readJson(options.baselinePath, "scorecard baseline").catch(
    () => ({ version: 1, tolerance: 0.05, records: [] }),
  );

  const { harvestable, skipped } = selectHarvestableRecords(summary);
  for (const reason of skipped) {
    console.log(`skipped  ${reason}`);
  }
  if (harvestable.length === 0) {
    throw new Error(
      "No passing, fully-scored mission records to harvest. A baseline built from a red or partial run would lower the bar it exists to hold.",
    );
  }

  const existing = Array.isArray(baseline.records) ? baseline.records : [];
  const { records, added, updated } = mergeBaselineRecords(existing, harvestable);
  for (const key of added) console.log(`added    ${key}`);
  for (const key of updated) console.log(`updated  ${key}`);

  const kept = records.length - added.length - updated.length;
  console.log(
    `\n${added.length} added, ${updated.length} updated, ${kept} kept from lanes not run.`,
  );

  if (options.dryRun) {
    console.log("Dry run: baseline not written.");
    return;
  }

  const next = {
    version: 1,
    tolerance: typeof baseline.tolerance === "number" ? baseline.tolerance : 0.05,
    records,
  };
  await writeFile(
    options.baselinePath,
    `${JSON.stringify(next, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `Wrote ${path.relative(process.cwd(), options.baselinePath).replace(/\\/gu, "/")}. ` +
      "Verify with: npm run check:mission-scorecards",
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
