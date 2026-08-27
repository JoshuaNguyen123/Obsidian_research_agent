// ONE answer to "is this run evidence about the PRODUCT?", shared by the
// campaign that WRITES docs/eval/playwright-run-metrics.csv
// (scripts/run-proof-matrix.mjs) and by every reader that aggregates it:
// scripts/eval-kpis.mjs, scripts/eval-dashboard.mjs (including the Python
// notebook it generates), and scripts/eval-tool-events.mjs.
//
// Why one module. The writer learned three times over that a harness death is
// not a product failure — `environment_not_configured` (the cell never ran),
// `harness:cleanup_failed` (the mission passed and only teardown broke) and
// `harness:provider_quota_exhausted` (the account's cap was spent) — and
// generalized every budget, streak and CSV-gate decision onto one predicate so
// a fourth class could never be missed. The readers were never given the same
// treatment: each of them re-implemented "green" itself, and every one of them
// counted an infrastructure row in its pass-rate DENOMINATOR. Four copies of a
// definition is four chances to disagree, and they already did — one reader
// treated a blank failure class as green and another did not.
//
// A measurement of the 102 rows recorded through 2026-08-26 found 23 that were
// `harness:*`, `process:*` or `environment_not_configured`. Every one of them
// was scored as a product red.
//
// This module is deliberately dependency-free (node builtins only, and not
// even those): the readers are best-effort scripts that must never fail a test
// run, so the shared vocabulary must not drag the campaign runner in with it.
// The Python projection at the bottom exists so the generated notebook cells
// are derived from these same constants rather than hand-copied a fourth time.

/** The class recorded when nothing failed. Blank normalizes to this. */
export const NO_FAILURE_CLASS = "none";

/**
 * The lane refused to start because a variable IT requires is absent (or
 * unusable) in the process environment. Nothing about the product was
 * exercised, so this is not a red, not a green, and not an attempt: it is
 * terminal for the cell, spends no budget, and is never scored.
 *
 * On 2026-08-26 08:49 `--cells=compound-linear-github` burned all five
 * attempts in three minutes, every one of them dying instantly at
 * compound-flow-real-live.spec.ts:116 on an unset LINEAR_LIVE_TEST_TEAM_ID.
 * Because Playwright still printed a numbered failing-test header, each death
 * matched the lane-assertion patterns and was filed as `lane_assertion_failed`
 * — the bucket a genuine product failure lands in — and the cell was recorded
 * as "exhausted 5 attempts with streak 0/3". That record is indistinguishable
 * from "the product failed five times" when the truth is that the cell never
 * ran. An instrument must not misreport what it measured.
 *
 * It is spelled without a prefix for history's sake (rows carrying it are
 * already on disk), so the predicate below names it explicitly.
 */
export const ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS = "environment_not_configured";

/**
 * Class prefixes that mark a failure as measuring the HARNESS or the matrix
 * PROCESS rather than the product: `harness:renderer_death`,
 * `harness:cleanup_failed`, `harness:provider_quota_exhausted`,
 * `process:matrix_unclassified`, and every future sibling.
 */
export const INFRASTRUCTURE_FAILURE_CLASS_PREFIXES = Object.freeze(["harness", "process"]);

/**
 * Built from the prefixes above so the JS predicate and the Python cells the
 * dashboard generates can never name a different set.
 */
export const INFRASTRUCTURE_FAILURE_CLASS_PATTERN = new RegExp(
  `^(?:${INFRASTRUCTURE_FAILURE_CLASS_PREFIXES.join("|")}):`,
  "u",
);

/**
 * True when the failure class measured the harness or the process, not the
 * product. Such an outcome must appear in neither the numerator nor the
 * DENOMINATOR of a product pass rate — the same rule `cellStatusIsScored`
 * states for a `not_run` cell. Counting it as a failure is the exact lie these
 * classes exist to prevent.
 */
export function isInfrastructureFailureClass(failureClass) {
  const cls = String(failureClass ?? "");
  if (cls === ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS) return true;
  return INFRASTRUCTURE_FAILURE_CLASS_PATTERN.test(cls);
}

/**
 * THE shared predicate. An attempt (manifest record) or a run row (CSV) is
 * product evidence unless it died in infrastructure.
 *
 * `green ||` is deliberate and load-bearing in both directions: a passing run
 * is always evidence, whatever else its log matched, so this can never inflate
 * a pass rate by withholding a red, and it can never silently drop a green.
 * The proof-matrix writer gates its CSV append on exactly this expression, and
 * `attemptConsumesBudget` gates budget and streak on it — reader and writer
 * agree by construction rather than by review.
 */
export function measuresProduct(subject) {
  return Boolean(subject?.green) || !isInfrastructureFailureClass(subject?.failureClass);
}

// ---------------------------------------------------------------------------
// The reader half: docs/eval/playwright-run-metrics.csv rows.
// ---------------------------------------------------------------------------

/**
 * The curated `mission_outcome` vocabulary that reads as success. The
 * proof-matrix writer spells it "green"/"red"; hand-curated rows predating it
 * use `write_completed`, `AUDIT_PASSED_8_OF_8`, `fix_merged`, `lane_green` and
 * friends, so the match is a substring test over that legacy vocabulary.
 *
 * It is a WEAK signal and deliberately stays one: a curated row like
 * `stages_1-7_passed_stage8_external` matches it while recording a real
 * failure class. Every reader has counted such rows green since the CSV
 * existed and this module does not change that verdict — but the weak signal
 * is never allowed to decide whether a row is SCORED. See
 * `runRowRecordedNoFailure`.
 */
export const GREEN_OUTCOME_PATTERN = /passed|green|write_completed|fix_merged/iu;

/** Blank is unrecorded, not a distinct class: it normalizes to `none`. */
export function normalizeFailureClass(value) {
  const text = String(value ?? "").trim();
  return text === "" ? NO_FAILURE_CLASS : text;
}

/**
 * Project a header-keyed CSV record onto the two columns that decide scoring.
 * Readers spread their own columns on top of the result.
 */
export function toRunRow(record) {
  return {
    outcome: String(record?.mission_outcome ?? ""),
    failureClass: normalizeFailureClass(record?.primary_failure_class),
  };
}

/**
 * The AUTHORITATIVE success signal: the row recorded no failure at all. The
 * proof matrix writes `none` for exactly the attempts that exited 0, so this
 * is the CSV's equivalent of an attempt record's `green: true`.
 */
export function runRowRecordedNoFailure(row) {
  return normalizeFailureClass(row?.failureClass) === NO_FAILURE_CLASS;
}

/** True when the row recorded a success (authoritative, or curated vocabulary). */
export function runRowIsGreen(row) {
  if (runRowRecordedNoFailure(row)) return true;
  return GREEN_OUTCOME_PATTERN.test(String(row?.outcome ?? ""));
}

/**
 * True when the row belongs in a product pass rate (numerator or denominator).
 *
 * The `green` fed to the shared predicate is the AUTHORITATIVE signal, not the
 * curated-text one: `stages_1-2-7_passed_stage4_build_failed` carries the class
 * `process:unverified_build` and matches GREEN_OUTCOME_PATTERN on the word
 * "passed", and a weak text match must not be able to drag an infrastructure
 * row back into a pass rate. A row the campaign recorded as `none` is still
 * unconditionally scored, so this can never drop a green.
 */
export function runRowMeasuresProduct(row) {
  return measuresProduct({
    green: runRowRecordedNoFailure(row),
    failureClass: normalizeFailureClass(row?.failureClass),
  });
}

/** True when the row is a harness/process death — reported, never scored. */
export function runRowIsInfrastructure(row) {
  return !runRowMeasuresProduct(row);
}

/** Split rows into the ones a pass rate may see and the ones it may not. */
export function partitionRunRows(rows) {
  const scored = [];
  const infrastructure = [];
  for (const row of rows ?? []) {
    if (runRowIsInfrastructure(row)) infrastructure.push(row);
    else scored.push(row);
  }
  return { scored, infrastructure };
}

/**
 * The one arithmetic every reader prints. `passRate` is null — never 0 — when
 * no row carried product evidence: an empty denominator is unknown, not a
 * failure.
 */
export function summarizeRunRows(rows) {
  const list = rows ?? [];
  const { scored, infrastructure } = partitionRunRows(list);
  const green = scored.filter(runRowIsGreen).length;
  return {
    rows: list.length,
    scored: scored.length,
    green,
    red: scored.length - green,
    infrastructure: infrastructure.length,
    passRate: scored.length > 0 ? (100 * green) / scored.length : null,
  };
}

/** "51.9%", or "n/a" when nothing was scored. */
export function formatRate(part, whole) {
  return whole > 0 ? `${((100 * part) / whole).toFixed(1)}%` : "n/a";
}

/**
 * The sentence every reader appends so an excluded row is reported rather than
 * silently vanished: a count the operator can reconcile against the CSV.
 */
export function describeExcludedInfrastructure(count, total) {
  if (!count) return "";
  return (
    `${count} of ${total} rows were infrastructure (harness/process deaths and ` +
    "unconfigured environments) and are excluded from every pass rate below — " +
    "they measured the harness, not the product."
  );
}

// ---------------------------------------------------------------------------
// Shared CSV reader. One parser for playwright-run-metrics.csv and
// tool-events.csv, so a quoting bug cannot be fixed in one reader and not the
// others. Rows written before a column was appended are SHORTER than the
// header: the missing cells read as undefined -> blank -> unknown.
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; }
        else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** Header-keyed records; absent trailing cells stay undefined, never "". */
export function csvRecords(text) {
  const rows = parseCsv(text);
  const header = rows[0] ?? [];
  return rows.slice(1).map((cells) => {
    const record = {};
    header.forEach((name, index) => { record[name] = cells[index]; });
    return record;
  });
}

// ---------------------------------------------------------------------------
// Python projection. scripts/eval-dashboard.mjs regenerates an EXECUTED
// notebook whose cells re-derive these same counts; before this, those cells
// carried a fourth hand-written copy of the green test and no infrastructure
// exclusion at all. Generating them from the constants above means the
// notebook cannot drift from the dashboard that generated it.
// ---------------------------------------------------------------------------

export function pythonProductEvidenceSource() {
  return [
    "import re",
    `INFRASTRUCTURE_CLASS_RE = re.compile(r'${INFRASTRUCTURE_FAILURE_CLASS_PATTERN.source}')`,
    `GREEN_OUTCOME_RE = re.compile(r'${GREEN_OUTCOME_PATTERN.source}', re.I)`,
    `ENVIRONMENT_NOT_CONFIGURED = '${ENVIRONMENT_NOT_CONFIGURED_FAILURE_CLASS}'`,
    `NO_FAILURE_CLASS = '${NO_FAILURE_CLASS}'`,
    "def failure_class(r):",
    "    return (r.get('primary_failure_class') or '').strip() or NO_FAILURE_CLASS",
    "def is_infrastructure_class(cls):",
    "    return cls == ENVIRONMENT_NOT_CONFIGURED or bool(INFRASTRUCTURE_CLASS_RE.match(cls))",
    "def recorded_no_failure(r):",
    "    return failure_class(r) == NO_FAILURE_CLASS",
    "def green(r):",
    "    return recorded_no_failure(r) or bool(GREEN_OUTCOME_RE.search(r.get('mission_outcome') or ''))",
    "def measures_product(r):",
    "    return recorded_no_failure(r) or not is_infrastructure_class(failure_class(r))",
    "def infrastructure(r):",
    "    return not measures_product(r)",
  ];
}
