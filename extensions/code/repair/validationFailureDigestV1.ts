/**
 * Turns validation output into diagnostics a repair pass can act on.
 *
 * A failed fast validation produced exactly two things a reader could use: the
 * check's `exitCode`, and `failureFingerprint` -- a SHA-256 of the whole
 * output. The fingerprint answers one question ("is this the identical failure
 * as last time?") and nothing else. `code_repair_status`, which is what the
 * agent reads to decide what to fix, carried neither the output nor anything
 * derived from it: only receipt ids, a stage name, and a blocker code. The
 * model had to go re-read up to 32,000 characters of raw stdout per check and
 * re-derive the error list on every cycle, and a repair that fixed two of
 * three errors was indistinguishable from one that fixed none, because any
 * change at all produced a different fingerprint.
 *
 * This module parses the output formats the sandbox actually emits into a
 * bounded, deduplicated, ranked list, and diffs it against the previous
 * cycle's list so a status can say which problems are *still* there. Errors
 * outrank warnings, earlier checks outrank later ones, and everything is
 * capped so a digest cannot itself become the thing that blows the request
 * budget.
 *
 * Derivation only: it reads receipts and never writes to them, so the
 * hash-verified receipt shape and its fingerprint contract are untouched.
 * Parsing is best-effort by construction -- an unrecognised format degrades to
 * a first-error-line summary rather than to nothing, and never throws.
 */

export const MAX_DIGEST_DIAGNOSTICS_V1 = 20;
export const MAX_DIAGNOSTIC_MESSAGE_CHARS_V1 = 300;
export const MAX_DIGEST_SUMMARY_CHARS_V1 = 1_200;
/** Output beyond this is not scanned; failures state themselves early. */
export const MAX_SCANNED_OUTPUT_CHARS_V1 = 32_000;

export type ValidationDiagnosticSeverityV1 = "error" | "warning";

export interface ValidationDiagnosticV1 {
  /** The check whose output this came from. */
  check: string;
  /** Parser that recognised it, or "unstructured" for the fallback. */
  format: string;
  file: string | null;
  line: number | null;
  column: number | null;
  severity: ValidationDiagnosticSeverityV1;
  /** Tool-assigned code (`TS2304`, an ESLint rule, a Python exception). */
  code: string | null;
  message: string;
  /**
   * Identity across cycles. Deliberately excludes the line number: a repair
   * elsewhere in the file shifts every line below it, and that is not a
   * different problem.
   */
  signature: string;
}

export interface ValidationFailureDigestV1 {
  /** One line naming the failure, safe to put in a prompt as-is. */
  summary: string;
  diagnostics: ValidationDiagnosticV1[];
  /** Checks that exited non-zero, in receipt order. */
  failedChecks: string[];
  /** True when diagnostics were dropped to stay under the cap. */
  truncated: boolean;
  /** Present in the previous cycle and still here. */
  unresolved: string[];
  /** Present in the previous cycle and gone. */
  resolved: string[];
  /** Not in the previous cycle. */
  introduced: string[];
}

export interface ValidationCheckOutputV1 {
  label: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

interface ParsedLineV1 {
  format: string;
  file: string | null;
  line: number | null;
  column: number | null;
  severity: ValidationDiagnosticSeverityV1;
  code: string | null;
  message: string;
}

/** `src/a.ts(12,5): error TS2304: Cannot find name 'foo'.` */
const TSC_V1 =
  /^(?<file>[^\s(][^(]*)\((?<line>\d+),(?<column>\d+)\):\s*(?<severity>error|warning)\s+(?<code>TS\d+):\s*(?<message>.+)$/u;
/** `file.c:12:5: error: message` -- gcc, clang, ruff, tsc --pretty false, many more. */
const GNU_V1 =
  /^(?<file>[^\s:][^:]*):(?<line>\d+):(?:(?<column>\d+):)?\s*(?<severity>error|warning|fatal error)\b:?\s*(?<message>.+)$/u;
/** ESLint stylish body: `  12:5  error  Message  rule/name` */
const ESLINT_BODY_V1 =
  /^\s+(?<line>\d+):(?<column>\d+)\s+(?<severity>error|warning)\s+(?<message>.+?)(?:\s\s+(?<code>[\w@/-]+))?\s*$/u;
/** `  File "app.py", line 12, in <module>` */
const PYTHON_FRAME_V1 =
  /^\s*File "(?<file>[^"]+)", line (?<line>\d+)(?:, in (?<scope>.+))?$/u;
/** `NameError: name 'foo' is not defined` */
const PYTHON_EXCEPTION_V1 =
  /^(?<code>[A-Z][A-Za-z_]*(?:Error|Exception|Warning))(?::\s*(?<message>.*))?$/u;
/** `tests/test_x.py:12: AssertionError` */
const PYTEST_LOCATION_V1 =
  /^(?<file>[^\s:]+\.py):(?<line>\d+):\s*(?<code>[A-Za-z_]*(?:Error|Exception|Failed))\s*$/u;
/** Node test runner / assert stack frame: `at ... (file:12:5)` or `at file:12:5` */
const NODE_FRAME_V1 =
  /^\s*at\s+(?:.*\()?(?<file>[^\s()]+?):(?<line>\d+):(?<column>\d+)\)?\s*$/u;
/**
 * A thrown error line: `AssertionError [ERR_ASSERTION]: msg`, `Error: msg`.
 * Indented, because every runner that prints one nests it under the test.
 */
const THROWN_V1 =
  /^\s*(?<code>[A-Z][\w.]*(?:Error|Exception))(?:\s*\[[^\]]+\])?:\s*(?<message>.+)$/u;
/** node --test: `✖ name of the failing test (12.34ms)` */
const NODE_TEST_FAIL_V1 =
  /^\s*[✖✗×]\s+(?<message>.+?)\s*(?:\(\d+(?:\.\d+)?ms\))?\s*$/u;
/** pytest summary: `FAILED tests/test_x.py::test_y - AssertionError: ...` */
const PYTEST_FAILED_V1 =
  /^FAILED\s+(?<file>[^\s:]+)::(?<test>\S+)(?:\s+-\s+(?<message>.+))?$/u;

const NOISE_V1 =
  /^(?:npm (?:ERR!|WARN)\s*$|\s*$|-+$|=+$|\s*\^+\s*$|>\s|Command failed|npm error\s*$)/u;

function severityOf(raw: string): ValidationDiagnosticSeverityV1 {
  return raw.startsWith("warn") ? "warning" : "error";
}

function tidy(message: string): string {
  const collapsed = message.replace(/\s+/gu, " ").trim();
  return collapsed.length > MAX_DIAGNOSTIC_MESSAGE_CHARS_V1
    ? `${collapsed.slice(0, MAX_DIAGNOSTIC_MESSAGE_CHARS_V1 - 1)}…`
    : collapsed;
}

/** Normalize a path for comparison without resolving it against a filesystem. */
function tidyPath(file: string): string {
  return file.replace(/\\/gu, "/").replace(/^\.\//u, "").trim();
}

function parseInteger(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Recognise one line in isolation. ESLint's stylish format and Python
 * tracebacks carry the file on a *previous* line, so those two are stitched
 * together by the caller, which owns the only cross-line state here.
 */
function parseLineV1(text: string): ParsedLineV1 | null {
  const tsc = TSC_V1.exec(text);
  if (tsc?.groups) {
    return {
      format: "tsc",
      file: tidyPath(tsc.groups.file!),
      line: parseInteger(tsc.groups.line),
      column: parseInteger(tsc.groups.column),
      severity: severityOf(tsc.groups.severity!),
      code: tsc.groups.code ?? null,
      message: tidy(tsc.groups.message!),
    };
  }
  const pytest = PYTEST_LOCATION_V1.exec(text);
  if (pytest?.groups) {
    return {
      format: "pytest",
      file: tidyPath(pytest.groups.file!),
      line: parseInteger(pytest.groups.line),
      column: null,
      severity: "error",
      code: pytest.groups.code ?? null,
      message: tidy(pytest.groups.code ?? "test failed"),
    };
  }
  const gnu = GNU_V1.exec(text);
  if (gnu?.groups && /[./\\]/u.test(gnu.groups.file!)) {
    return {
      format: "gnu",
      file: tidyPath(gnu.groups.file!),
      line: parseInteger(gnu.groups.line),
      column: parseInteger(gnu.groups.column),
      severity: severityOf(gnu.groups.severity!),
      code: null,
      message: tidy(gnu.groups.message!),
    };
  }
  const pytestFailed = PYTEST_FAILED_V1.exec(text);
  if (pytestFailed?.groups) {
    return {
      format: "pytest",
      file: tidyPath(pytestFailed.groups.file!),
      line: null,
      column: null,
      severity: "error",
      code: pytestFailed.groups.test ?? null,
      message: tidy(pytestFailed.groups.message ?? pytestFailed.groups.test ?? "test failed"),
    };
  }
  const thrown = THROWN_V1.exec(text);
  if (thrown?.groups) {
    return {
      format: "thrown",
      file: null,
      line: null,
      column: null,
      severity: "error",
      code: thrown.groups.code ?? null,
      message: tidy(thrown.groups.message!),
    };
  }
  const nodeTest = NODE_TEST_FAIL_V1.exec(text);
  // "✖ failing tests:" is the section header the runner prints before
  // repeating each failure; it names no test.
  if (nodeTest?.groups && !/^failing tests:?$/iu.test(nodeTest.groups.message!.trim())) {
    return {
      format: "node-test",
      file: null,
      line: null,
      column: null,
      severity: "error",
      code: "test",
      message: tidy(nodeTest.groups.message!),
    };
  }
  return null;
}

function signatureOf(parsed: {
  file: string | null;
  code: string | null;
  message: string;
}): string {
  return [parsed.file ?? "?", parsed.code ?? "?", parsed.message].join("|");
}

/**
 * Parse one check's output. Returns diagnostics in the order they appeared,
 * which is the order the tool considered most important.
 */
export function parseCheckDiagnosticsV1(
  check: ValidationCheckOutputV1,
): ValidationDiagnosticV1[] {
  const found: ValidationDiagnosticV1[] = [];
  const push = (parsed: ParsedLineV1) => {
    found.push({
      check: check.label,
      format: parsed.format,
      file: parsed.file,
      line: parsed.line,
      column: parsed.column,
      severity: parsed.severity,
      code: parsed.code,
      message: parsed.message,
      signature: signatureOf(parsed),
    });
  };

  const combined = `${check.stdout}\n${check.stderr}`.slice(
    0,
    MAX_SCANNED_OUTPUT_CHARS_V1,
  );
  const lines = combined.split(/\r?\n/u);
  // ESLint names the file on its own line; Python names it in the deepest
  // traceback frame, and the exception that follows is the actual message.
  let eslintFile: string | null = null;
  let pythonFrame: { file: string; line: number | null } | null = null;

  for (const raw of lines) {
    if (NOISE_V1.test(raw)) continue;

    const frame = PYTHON_FRAME_V1.exec(raw);
    if (frame?.groups) {
      pythonFrame = { file: tidyPath(frame.groups.file!), line: parseInteger(frame.groups.line) };
      continue;
    }
    const exception = PYTHON_EXCEPTION_V1.exec(raw.trim());
    if (exception?.groups && pythonFrame) {
      push({
        format: "python",
        file: pythonFrame.file,
        line: pythonFrame.line,
        column: null,
        severity: "error",
        code: exception.groups.code ?? null,
        message: tidy(exception.groups.message ?? exception.groups.code ?? "error"),
      });
      pythonFrame = null;
      continue;
    }

    const eslintBody = ESLINT_BODY_V1.exec(raw);
    if (eslintBody?.groups && eslintFile) {
      push({
        format: "eslint",
        file: eslintFile,
        line: parseInteger(eslintBody.groups.line),
        column: parseInteger(eslintBody.groups.column),
        severity: severityOf(eslintBody.groups.severity!),
        code: eslintBody.groups.code ?? null,
        message: tidy(eslintBody.groups.message!),
      });
      continue;
    }

    const parsed = parseLineV1(raw);
    if (parsed) {
      push(parsed);
      continue;
    }
    // A bare path on its own line is ESLint announcing the next file. Node
    // stack frames are not diagnostics themselves, but the frame under a
    // thrown error tells us where it happened.
    if (/^\S+\.[a-z]{1,5}$/iu.test(raw.trim()) && /[./\\]/u.test(raw)) {
      eslintFile = tidyPath(raw.trim());
      continue;
    }
    const nodeFrame = NODE_FRAME_V1.exec(raw);
    if (nodeFrame?.groups) {
      const last = found.at(-1);
      if (last && last.file === null && last.format === "thrown") {
        last.file = tidyPath(nodeFrame.groups.file!).replace(/^file:\/*/u, "");
        last.line = parseInteger(nodeFrame.groups.line);
        last.column = parseInteger(nodeFrame.groups.column);
        last.signature = signatureOf(last);
      }
    }
  }

  if (found.length === 0) {
    // Nothing recognised. The first substantive stderr line beats silence.
    const fallback = `${check.stderr}\n${check.stdout}`
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !NOISE_V1.test(line));
    if (fallback) {
      const parsed: ParsedLineV1 = {
        format: "unstructured",
        file: null,
        line: null,
        column: null,
        severity: "error",
        code: null,
        message: tidy(fallback),
      };
      push(parsed);
    }
  }
  return found;
}

function rankV1(diagnostic: ValidationDiagnosticV1): number {
  let rank = diagnostic.severity === "error" ? 0 : 100;
  // A diagnostic that names a file and a line is actionable; one that does
  // not is a summary of the ones that do.
  if (diagnostic.file === null) rank += 10;
  if (diagnostic.format === "unstructured") rank += 20;
  return rank;
}

/**
 * Build the digest for one validation's checks, optionally diffed against the
 * diagnostics of the previous cycle.
 */
export function buildValidationFailureDigestV1(
  checks: readonly ValidationCheckOutputV1[],
  previous: readonly ValidationDiagnosticV1[] = [],
): ValidationFailureDigestV1 {
  const failed = checks.filter((check) => check.exitCode !== 0);
  const collected: ValidationDiagnosticV1[] = [];
  const seen = new Set<string>();
  for (const check of failed) {
    for (const diagnostic of parseCheckDiagnosticsV1(check)) {
      const key = `${diagnostic.check}|${diagnostic.signature}|${diagnostic.line ?? "?"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(diagnostic);
    }
  }
  // Stable: equal ranks keep the order the tools reported.
  const ordered = collected
    .map((diagnostic, index) => ({ diagnostic, index }))
    .sort((left, right) => {
      const delta = rankV1(left.diagnostic) - rankV1(right.diagnostic);
      return delta !== 0 ? delta : left.index - right.index;
    })
    .map((entry) => entry.diagnostic);
  const diagnostics = ordered.slice(0, MAX_DIGEST_DIAGNOSTICS_V1);

  const previousSignatures = new Set(previous.map((entry) => entry.signature));
  const currentSignatures = new Set(ordered.map((entry) => entry.signature));
  const unresolved = [...currentSignatures].filter((signature) =>
    previousSignatures.has(signature),
  );
  const resolved = [...previousSignatures].filter(
    (signature) => !currentSignatures.has(signature),
  );
  const introduced = [...currentSignatures].filter(
    (signature) => !previousSignatures.has(signature),
  );

  return {
    summary: summarizeV1(ordered, failed, { unresolved, resolved, introduced }, previous.length > 0),
    diagnostics,
    failedChecks: failed.map((check) => check.label),
    truncated: ordered.length > diagnostics.length,
    unresolved,
    resolved,
    introduced,
  };
}

function summarizeV1(
  diagnostics: readonly ValidationDiagnosticV1[],
  failedChecks: readonly ValidationCheckOutputV1[],
  diff: { unresolved: string[]; resolved: string[]; introduced: string[] },
  hadPrevious: boolean,
): string {
  if (failedChecks.length === 0) return "All checks passed.";
  const errors = diagnostics.filter((entry) => entry.severity === "error");
  const files = new Set(
    diagnostics.map((entry) => entry.file).filter((file): file is string => file !== null),
  );
  const parts: string[] = [];
  parts.push(
    `${failedChecks.length} check${failedChecks.length === 1 ? "" : "s"} failed (${failedChecks
      .map((check) => check.label)
      .join(", ")})`,
  );
  if (errors.length > 0) {
    parts.push(
      `${errors.length} error${errors.length === 1 ? "" : "s"}${
        files.size > 0 ? ` in ${files.size} file${files.size === 1 ? "" : "s"}` : ""
      }`,
    );
  }
  if (hadPrevious) {
    // The signal a fingerprint cannot carry: whether the last repair helped.
    parts.push(
      `${diff.unresolved.length} unresolved, ${diff.resolved.length} fixed, ${diff.introduced.length} new since the previous cycle`,
    );
  }
  const first = diagnostics[0];
  if (first) {
    const where = first.file
      ? `${first.file}${first.line === null ? "" : `:${first.line}`}`
      : first.check;
    parts.push(`first: ${where} ${first.code ? `${first.code} ` : ""}${first.message}`);
  }
  const text = `${parts.join("; ")}.`;
  return text.length > MAX_DIGEST_SUMMARY_CHARS_V1
    ? `${text.slice(0, MAX_DIGEST_SUMMARY_CHARS_V1 - 1)}…`
    : text;
}
