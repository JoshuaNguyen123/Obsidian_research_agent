import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
  csvRecords,
  describeExcludedInfrastructure,
  isInfrastructureFailureClass,
  measuresProduct,
  partitionRunRows,
  pythonProductEvidenceSource,
  runRowIsGreen,
  runRowIsInfrastructure,
  summarizeRunRows,
  toRunRow,
} from "../scripts/product-evidence.mjs";
import {
  RUN_CSV_HEADER,
  attemptConsumesBudget,
  isInfrastructureFailureClass as matrixInfrastructurePredicate,
} from "../scripts/run-proof-matrix.mjs";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const readRepoFile = (relative: string) =>
  readFileSync(path.join(REPO_ROOT, ...relative.split("/")), "utf8");

const COLUMNS = RUN_CSV_HEADER.split(",");

/** One run-metrics row, addressed by column NAME exactly as the readers do. */
function csvRow(fields: Record<string, string>): string {
  const cells = COLUMNS.map((name) => fields[name] ?? "");
  return cells.join(",");
}

function metricsCsv(rows: Array<Record<string, string>>): string {
  return [RUN_CSV_HEADER, ...rows.map(csvRow)].join("\n") + "\n";
}

const GREEN_ROW = {
  run_started_at: "2026-08-26T01:00:00.000Z",
  lane: "daily-use-research",
  model: "deepseek-v4-pro",
  mission_outcome: "green",
  primary_failure_class: "none",
};
const PRODUCT_RED_ROW = {
  run_started_at: "2026-08-26T02:00:00.000Z",
  lane: "daily-use-research",
  model: "deepseek-v4-pro",
  mission_outcome: "red",
  primary_failure_class: "product:writeback_unproven",
};
const HARNESS_ROW = {
  run_started_at: "2026-08-26T03:00:00.000Z",
  lane: "daily-use-research",
  model: "deepseek-v4-pro",
  mission_outcome: "red",
  primary_failure_class: "harness:build_failed",
};

const rowsOf = (csv: string) => csvRecords(csv).map(toRunRow);

test("a harness row in the CSV does not lower the reported pass rate", () => {
  // The whole misattribution in one comparison: the same two product runs,
  // once alone and once with a harness death recorded beside them. A build
  // that never compiled is not a failed mission, so the rate must not move.
  const withoutHarness = summarizeRunRows(rowsOf(metricsCsv([GREEN_ROW, PRODUCT_RED_ROW])));
  const withHarness = summarizeRunRows(
    rowsOf(metricsCsv([GREEN_ROW, PRODUCT_RED_ROW, HARNESS_ROW])),
  );

  assert.equal(withoutHarness.passRate, 50);
  assert.equal(withHarness.passRate, 50, "a harness death must not move the product pass rate");
  assert.equal(withHarness.green, withoutHarness.green, "and it must not move the numerator");

  // It is EXCLUDED, not deleted: the count is reported beside the rate.
  assert.equal(withHarness.rows, 3);
  assert.equal(withHarness.scored, 2);
  assert.equal(withHarness.infrastructure, 1);
  assert.match(describeExcludedInfrastructure(withHarness.infrastructure, withHarness.rows), /1 of 3/u);

  // What the four readers used to print: the harness row in the denominator,
  // 50% reported as 33.3%. Pinned so the regression is recognizable on sight.
  assert.equal(Number(((100 * withHarness.green) / withHarness.rows).toFixed(1)), 33.3);
});

test("every infrastructure class leaves the denominator; every real one stays in it", () => {
  const infrastructure = [
    "harness:build_failed",
    "harness:e2e_lock_timeout",
    "harness:cleanup_failed",
    "harness:provider_quota_exhausted",
    "harness:renderer_death",
    "process:matrix_unclassified",
    "process:unverified_build",
    ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS,
  ];
  const product = [
    "product:writeback_unproven",
    "model:degenerate_stream",
    "external:provider_internal_server_error",
    "lane_assertion_failed",
  ];

  const rows = rowsOf(
    metricsCsv([
      GREEN_ROW,
      ...infrastructure.map((cls, i) => ({
        ...HARNESS_ROW,
        run_started_at: `2026-08-26T04:0${i}:00.000Z`,
        primary_failure_class: cls,
      })),
      ...product.map((cls, i) => ({
        ...PRODUCT_RED_ROW,
        run_started_at: `2026-08-26T05:0${i}:00.000Z`,
        primary_failure_class: cls,
      })),
    ]),
  );

  const { scored, infrastructure: excluded } = partitionRunRows(rows);
  assert.equal(excluded.length, infrastructure.length);
  assert.equal(scored.length, product.length + 1);
  const summary = summarizeRunRows(rows);
  assert.equal(summary.green, 1);
  assert.equal(summary.red, product.length);
  // One green of five product rows — the eight harness/process rows are in
  // neither half of that fraction.
  assert.equal(summary.passRate, 20);
});

test("a curated outcome that says 'passed' cannot drag an infrastructure row back in", () => {
  // Both rows are real history. `stages_1-2-7_passed_stage4_build_failed`
  // matches the legacy green vocabulary on the word "passed" while recording
  // `process:unverified_build`; the weak text signal must not outvote the
  // authoritative failure class, or the exclusion silently loses rows.
  const rows = rowsOf(
    metricsCsv([
      {
        ...HARNESS_ROW,
        mission_outcome: "stages_1-2-7_passed_stage4_build_failed",
        primary_failure_class: "process:unverified_build",
      },
      {
        ...HARNESS_ROW,
        run_started_at: "2026-08-26T03:30:00.000Z",
        mission_outcome: "stages_1-7_passed_stage8_empty_final_again",
        primary_failure_class: "process:retry_fix_wrong_terminal",
      },
    ]),
  );
  for (const row of rows) assert.ok(runRowIsInfrastructure(row), `${row.outcome} must be excluded`);
  assert.equal(summarizeRunRows(rows).scored, 0);
  assert.equal(summarizeRunRows(rows).passRate, null, "an empty denominator is unknown, not 0%");
});

test("the exclusion can never hide a product red, only a harness death", () => {
  // `green ||` is the safety half of the shared predicate: a run the campaign
  // recorded as passing is scored whatever else its class says, so no path
  // through this module can withhold a red and inflate a rate.
  assert.equal(measuresProduct({ green: true, failureClass: "harness:build_failed" }), true);
  assert.equal(measuresProduct({ green: false, failureClass: "harness:build_failed" }), false);
  assert.equal(measuresProduct({ green: false, failureClass: "product:writeback_unproven" }), true);
  assert.equal(measuresProduct({ green: false, failureClass: "none" }), true);
  assert.equal(measuresProduct(undefined), true, "an unclassified row is product evidence");

  const green = rowsOf(metricsCsv([GREEN_ROW]))[0];
  assert.ok(runRowIsGreen(green));
  assert.ok(!runRowIsInfrastructure(green));
});

test("the proof matrix and the eval readers share ONE predicate, by identity", () => {
  // Not "they agree today" — the same function object. Budget, streak, the
  // CSV write gate and every pass-rate denominator cannot drift apart.
  assert.equal(matrixInfrastructurePredicate, isInfrastructureFailureClass);
  assert.equal(attemptConsumesBudget({ green: false, failureClass: "harness:build_failed" }), false);
  assert.equal(
    attemptConsumesBudget({ green: false, failureClass: "harness:build_failed" }),
    measuresProduct({ green: false, failureClass: "harness:build_failed" }),
    "the writer's budget rule and the reader's scoring rule are one expression",
  );
});

test("no eval reader may re-inline the green test or the infrastructure predicate", () => {
  // Source-level guard. Four copies of "is this green" is what put harness
  // deaths in the product denominator in three readers and a generated Python
  // notebook; re-inlining any of them must fail here rather than quietly
  // depress a KPI for another week.
  for (const relative of [
    "scripts/eval-kpis.mjs",
    "scripts/eval-dashboard.mjs",
    "scripts/eval-tool-events.mjs",
  ]) {
    const source = readRepoFile(relative);
    assert.ok(
      /from "\.\/product-evidence\.mjs"/u.test(source),
      `${relative} must consume the shared product-evidence seat`,
    );
    assert.ok(
      !/write_completed/u.test(source),
      `${relative} must not re-spell the green outcome vocabulary`,
    );
    assert.ok(
      !/\(\?:harness\|process\):/u.test(source),
      `${relative} must not re-inline the infrastructure class pattern`,
    );
    assert.ok(
      !/function parseCsv\s*\(/u.test(source),
      `${relative} must not re-inline the CSV parser`,
    );
    assert.ok(
      !/===\s*["']none["']/u.test(source),
      `${relative} must not re-inline the "no failure class" test`,
    );
  }

  const matrix = readRepoFile("scripts/run-proof-matrix.mjs");
  assert.ok(
    /from "\.\/product-evidence\.mjs"/u.test(matrix),
    "the writer must consume the same seat it asks its readers to consume",
  );
  assert.ok(
    !/function isInfrastructureFailureClass\s*\(/u.test(matrix),
    "run-proof-matrix.mjs must not re-inline the infrastructure predicate",
  );
});

test("the notebook's Python predicate is generated, not a fourth hand-written copy", () => {
  const dashboard = readRepoFile("scripts/eval-dashboard.mjs");
  assert.ok(
    /pythonProductEvidenceSource\(\)/u.test(dashboard),
    "the generated cells must spread the shared Python projection",
  );
  // Comment lines are excluded: the file explains the old duplication in prose
  // and that explanation is the point.
  const code = dashboard
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
  for (const banned of [/"def green\(/u, /"def measures_product\(/u, /re\.search\(r'passed/u]) {
    assert.doesNotMatch(code, banned, "the notebook predicate must come from the shared module");
  }

  // And the projection really is derived from the constants rather than
  // retyped beside them.
  const python = pythonProductEvidenceSource().join("\n");
  assert.match(python, /\(\?:harness\|process\):/u);
  assert.match(python, /passed\|green\|write_completed\|fix_merged/u);
  assert.match(python, new RegExp(ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS, "u"));
  for (const fn of ["failure_class", "is_infrastructure_class", "green", "measures_product", "infrastructure"]) {
    assert.match(python, new RegExp(`def ${fn}\\(`, "u"));
  }
});

test("the generated Python agrees with the JS on every row", (t) => {
  // The fourth reader is a different LANGUAGE, so identity cannot prove it.
  // Execute the generated predicate over the same fixtures instead.
  const fixtures = [
    GREEN_ROW,
    PRODUCT_RED_ROW,
    HARNESS_ROW,
    { ...HARNESS_ROW, primary_failure_class: "process:matrix_unclassified" },
    { ...HARNESS_ROW, primary_failure_class: ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS },
    { ...HARNESS_ROW, mission_outcome: "stages_1-2-7_passed_stage4_build_failed", primary_failure_class: "process:unverified_build" },
    { ...PRODUCT_RED_ROW, primary_failure_class: "lane_assertion_failed" },
    { ...GREEN_ROW, mission_outcome: "AUDIT_PASSED_8_OF_8" },
  ];
  const runner = [
    "import sys, json",
    ...pythonProductEvidenceSource(),
    "rows = json.load(sys.stdin)",
    "print(json.dumps([[green(r), measures_product(r)] for r in rows]))",
  ].join("\n");

  let stdout: string;
  try {
    stdout = execFileSync("python", ["-c", runner], {
      encoding: "utf8",
      timeout: 60_000,
      input: JSON.stringify(fixtures),
    });
  } catch (error) {
    t.skip(`python unavailable: ${String((error as Error).message).slice(0, 80)}`);
    return;
  }

  const fromPython = JSON.parse(stdout) as Array<[boolean, boolean]>;
  const fromJs = rowsOf(metricsCsv(fixtures)).map((row) => [
    runRowIsGreen(row),
    !runRowIsInfrastructure(row),
  ]);
  assert.deepEqual(fromPython, fromJs, "the notebook and the dashboard must score identically");
});
