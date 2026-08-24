/**
 * Notebook execution inside the existing verified sandbox.
 *
 * Until this module the plugin could author `.ipynb` files and nothing else:
 * `buildJupyterNotebookV1` emitted `executionState: "not_executed"` as a
 * literal type, so a scientist could never see a cell result and iterate.
 *
 * Three fixed properties of the host-provisioned sandbox shape everything here.
 *
 * 1. `runtime-manifest.json` binds the *first* argument of every sandbox
 *    command to an immutable allowlist - today `["node", "npm", "python",
 *    "python3"]`. `jupyter`, `jupyter-execute`, `nbconvert`, and `papermill`
 *    are console scripts, so none of them can ever be `command[0]`. Whatever
 *    engine executes cells, it must be reached through `python`.
 * 2. The runtime root is a frozen, read-only, SHA-256-fingerprinted copy of the
 *    distribution's Python (`scripts/setup-wsl2-sandbox-runtime.sh`). Installing
 *    a package into the WSL distribution changes nothing inside the sandbox:
 *    only re-provisioning the runtime root and re-persisting its digest does.
 * 3. Workspace manifests carry `sandboxPolicy: { network: "disabled" }`, so a
 *    validation command can never install its own dependency.
 *
 * The engine is therefore a fixed, host-owned, standard-library-only cell
 * runner delivered to the sandbox as base64 argv chunks. It is a *reduced*
 * kernel: it executes code cells in order in one shared namespace and captures
 * stdout, stderr, the trailing expression's repr, and tracebacks as real
 * nbformat outputs. It does not implement the Jupyter display protocol or
 * magics. `notebookRuntimeUpgradeAdviceV1` reports that boundary honestly.
 *
 * Nothing here decides *whether* to run. Contribution is gated on
 * `NotebookRuntimeAvailabilityV1`, which may only be produced by parsing the
 * output of a real execution of this runner inside the verified sandbox.
 */

import { portableSha256Text } from "../../../packages/core-api/src/portableSha256";

import { buildJupyterNotebookV1 } from "../JupyterNotebookV1";
import {
  createRepositoryProfileV2,
  defaultRepositoryMergePolicyV2,
  type RepositoryProfileV2,
  type RepositoryValidationCommandV2,
  type ValidationPhaseV2,
} from "../repositories/RepositoryProfileV2";

export const NOTEBOOK_EXECUTION_CONTRACT_V1 = 1 as const;

/** Fixed argv boundary. `RepositoryValidationCommandV2.args` allows 64 entries of 500 chars. */
export const NOTEBOOK_RUNNER_MAX_ARGS_V1 = 64;
export const NOTEBOOK_RUNNER_CHUNK_CHARS_V1 = 400;
export const NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 = 16;
export const NOTEBOOK_RUNNER_ARGV_SEPARATOR_V1 = "--";

/** Notebook the host stages for its own capability probe; never a user path. */
export const NOTEBOOK_RUNTIME_PROBE_PATH_V1 = "agentic-notebook-runtime-probe.ipynb";

export type NotebookRunnerModeV1 = "execute" | "probe";

/**
 * Optional modules the runner reports on. Their absence never blocks
 * execution; it explains, before the fact, why a scientist's imports will
 * fail inside a standard-library-only pinned runtime.
 */
export const NOTEBOOK_OPTIONAL_MODULES_V1 = [
  "ipykernel",
  "matplotlib",
  "nbclient",
  "nbformat",
  "numpy",
  "pandas",
] as const;

export interface NotebookCellFailureV1 {
  cellIndex: number;
  executionCount: number;
  ename: string;
  evalue: string;
}

export interface NotebookRunEntryV1 {
  path: string;
  status: "executed" | "failed" | "error";
  reason: string | null;
  codeCells: number;
  executedCells: number;
  failure: NotebookCellFailureV1 | null;
}

export interface NotebookRunSummaryV1 {
  version: 1;
  runner: "agentic_notebook_runner";
  contract: number;
  mode: NotebookRunnerModeV1;
  python: string;
  optionalModules: Readonly<Record<string, boolean>>;
  notebooks: NotebookRunEntryV1[];
  executedCellCount: number;
  failedNotebook: string | null;
  status: "executed" | "failed";
}

export interface NotebookRuntimeAvailabilityV1 {
  version: 1;
  available: boolean;
  /** Engine identity; a future kernel-backed engine gets its own value. */
  engine: "stdlib_cell_runner_v1";
  runnerFingerprint: string;
  python: string | null;
  optionalModules: Readonly<Record<string, boolean>>;
  checkedAt: string;
  /** Exact non-secret reason the probe failed. Null when available. */
  diagnostic: string | null;
}

export interface NotebookExecutionDegradationV1 {
  code:
    | "notebook_runtime_unprobed"
    | "notebook_runtime_probe_failed"
    | "notebook_runtime_contract_mismatch";
  message: string;
  requiredAction: string;
}

export class NotebookExecutionErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NotebookExecutionErrorV1";
  }
}

/**
 * Host-owned notebook cell runner. Standard library only: no import outside
 * CPython's own modules, no subprocess, no socket, no shell. It is the whole
 * reason notebook execution needs no network and no sandbox re-provisioning.
 *
 * Written without a single backslash so that embedding it here, base64
 * encoding it, and splitting it across argv can never change its meaning.
 */
const NOTEBOOK_RUNNER_SOURCE_RAW_V1 = `import ast
import io
import json
import sys
import traceback
from contextlib import redirect_stderr, redirect_stdout

CONTRACT = 1
NEWLINE = chr(10)
MAX_STREAM_CHARS = 16000
MAX_CELLS = 200
MAX_VALUE_CHARS = 500
TRUNCATION_NOTE = "[agentic_notebook_runner: output truncated]"
OPTIONAL_MODULES = (
    "ipykernel",
    "matplotlib",
    "nbclient",
    "nbformat",
    "numpy",
    "pandas",
)


def bounded(text):
    if len(text) <= MAX_STREAM_CHARS:
        return text
    return text[:MAX_STREAM_CHARS] + NEWLINE + TRUNCATION_NOTE + NEWLINE


def as_lines(text):
    return text.splitlines(True) if text else []


def cell_source(cell):
    source = cell.get("source", "")
    if isinstance(source, list):
        source = "".join(part for part in source if isinstance(part, str))
    return source if isinstance(source, str) else ""


def optional_modules():
    import importlib.util

    present = {}
    for name in OPTIONAL_MODULES:
        try:
            present[name] = importlib.util.find_spec(name) is not None
        except Exception:
            present[name] = False
    return present


def compile_cell(source, name):
    tree = ast.parse(source, filename=name, mode="exec")
    if tree.body and isinstance(tree.body[-1], ast.Expr):
        head = ast.Module(body=tree.body[:-1], type_ignores=[])
        tail = ast.Expression(body=tree.body[-1].value)
        return compile(head, name, "exec"), compile(tail, name, "eval")
    return compile(tree, name, "exec"), None


def result_output(value, counter):
    try:
        rendered = bounded(repr(value))
    except Exception as error:
        rendered = "<unrepresentable result: " + type(error).__name__ + ">"
    return {
        "output_type": "execute_result",
        "execution_count": counter,
        "data": {"text/plain": as_lines(rendered)},
        "metadata": {},
    }


def execute_notebook(path):
    with open(path, "r", encoding="utf-8") as handle:
        notebook = json.load(handle)
    cells = notebook.get("cells")
    if not isinstance(cells, list):
        raise ValueError("notebook has no cells array")
    if len(cells) > MAX_CELLS:
        raise ValueError("notebook exceeds the fixed cell bound")
    namespace = {"__name__": "__main__"}
    counter = 0
    executed = 0
    failure = None
    for index, cell in enumerate(cells):
        if not isinstance(cell, dict) or cell.get("cell_type") != "code":
            continue
        source = cell_source(cell)
        cell["outputs"] = []
        if failure is not None or not source.strip():
            cell["execution_count"] = None
            continue
        counter += 1
        cell["execution_count"] = counter
        out = io.StringIO()
        err = io.StringIO()
        error = None
        value = None
        tail = None
        try:
            head, tail = compile_cell(source, "cell " + str(index + 1))
        except SyntaxError:
            error = sys.exc_info()
        if error is None:
            try:
                with redirect_stdout(out), redirect_stderr(err):
                    exec(head, namespace)
                    if tail is not None:
                        value = eval(tail, namespace)
            except BaseException:
                error = sys.exc_info()
        outputs = []
        stdout_text = bounded(out.getvalue())
        if stdout_text:
            outputs.append({
                "output_type": "stream",
                "name": "stdout",
                "text": as_lines(stdout_text),
            })
        stderr_text = bounded(err.getvalue())
        if stderr_text:
            outputs.append({
                "output_type": "stream",
                "name": "stderr",
                "text": as_lines(stderr_text),
            })
        if error is None and tail is not None and value is not None:
            outputs.append(result_output(value, counter))
        executed += 1
        if error is not None:
            kind, raised, trace = error
            outputs.append({
                "output_type": "error",
                "ename": kind.__name__,
                "evalue": bounded(str(raised))[:MAX_VALUE_CHARS],
                "traceback": [
                    bounded(line)
                    for line in traceback.format_exception(kind, raised, trace)
                ],
            })
            failure = {
                "cellIndex": index,
                "executionCount": counter,
                "ename": kind.__name__,
                "evalue": bounded(str(raised))[:MAX_VALUE_CHARS],
            }
        cell["outputs"] = outputs
    return notebook, counter, executed, failure


def write_notebook(path, notebook):
    rendered = json.dumps(notebook, ensure_ascii=False, indent=2) + NEWLINE
    with open(path, "w", encoding="utf-8", newline=NEWLINE) as handle:
        handle.write(rendered)


def main(argv):
    mode = argv[0] if argv else ""
    paths = argv[1:]
    if mode not in ("execute", "probe") or not paths:
        sys.stderr.write("agentic_notebook_runner: invalid mode or paths" + NEWLINE)
        return 64
    entries = []
    total = 0
    failed = None
    for path in paths:
        try:
            notebook, counter, executed, failure = execute_notebook(path)
        except Exception as error:
            if failed is None:
                failed = path
            entries.append({
                "path": path,
                "status": "error",
                "reason": str(error)[:MAX_VALUE_CHARS],
                "codeCells": 0,
                "executedCells": 0,
                "failure": None,
            })
            continue
        write_notebook(path, notebook)
        total += executed
        entries.append({
            "path": path,
            "status": "failed" if failure is not None else "executed",
            "reason": None,
            "codeCells": counter,
            "executedCells": executed,
            "failure": failure,
        })
        if failure is not None and failed is None:
            failed = path
    summary = {
        "version": 1,
        "runner": "agentic_notebook_runner",
        "contract": CONTRACT,
        "mode": mode,
        "python": sys.version.split()[0],
        "optionalModules": optional_modules(),
        "notebooks": entries,
        "executedCellCount": total,
        "failedNotebook": failed,
        "status": "failed" if failed is not None else "executed",
    }
    sys.stdout.write(
        json.dumps(summary, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    )
    sys.stdout.write(NEWLINE)
    return 1 if failed is not None else 0


sys.exit(main(sys.argv[sys.argv.index("--") + 1:]))
`;

/**
 * The exact program the sandbox runs.
 *
 * The literal above is a template literal in a checked-out file, and this
 * repository stores text with `core.autocrlf`, so a fresh clone on Windows
 * would otherwise embed CRLF and produce a different program, a different
 * base64 payload, and a different runner fingerprint than the same commit
 * produces on Linux. Normalizing here makes the program a property of the
 * commit rather than of the checkout.
 */
export const NOTEBOOK_RUNNER_SOURCE_V1 = NOTEBOOK_RUNNER_SOURCE_RAW_V1.replace(
  /\r\n?/gu,
  "\n",
);

/**
 * The fixed `python -c` driver. It decodes the argv chunks up to the `--`
 * separator and executes them; everything after `--` belongs to the runner.
 */
export const NOTEBOOK_RUNNER_DRIVER_V1 =
  "import sys,base64;exec(base64.b64decode(''.join(" +
  "sys.argv[1:sys.argv.index('--')])).decode('utf-8'))";

/** Stable identity of the exact program the sandbox is asked to run. */
export function notebookRunnerFingerprintV1(): string {
  return `sha256:${portableSha256Text(
    `${NOTEBOOK_EXECUTION_CONTRACT_V1} ${NOTEBOOK_RUNNER_DRIVER_V1} ${NOTEBOOK_RUNNER_SOURCE_V1}`,
  )}`;
}

function encodeRunnerChunksV1(): string[] {
  const encoded = Buffer.from(NOTEBOOK_RUNNER_SOURCE_V1, "utf8").toString("base64");
  const chunks: string[] = [];
  for (let index = 0; index < encoded.length; index += NOTEBOOK_RUNNER_CHUNK_CHARS_V1) {
    chunks.push(encoded.slice(index, index + NOTEBOOK_RUNNER_CHUNK_CHARS_V1));
  }
  return chunks;
}

/**
 * Build the exact host-owned argv. The model contributes nothing to it: the
 * caller supplies only notebook paths already proven present in the trusted
 * hash-bound staging manifest.
 */
export function buildNotebookRunnerArgsV1(input: {
  mode: NotebookRunnerModeV1;
  notebookPaths: readonly string[];
}): string[] {
  const mode = input.mode;
  if (mode !== "execute" && mode !== "probe") {
    throw new NotebookExecutionErrorV1(
      "notebook_runner_mode_invalid",
      "Notebook runner mode must be execute or probe.",
    );
  }
  const paths = [...new Set(input.notebookPaths)].sort();
  if (paths.length < 1 || paths.length > NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1) {
    throw new NotebookExecutionErrorV1(
      "notebook_runner_path_count_invalid",
      `Notebook execution requires 1-${NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1} notebook paths.`,
    );
  }
  for (const path of paths) {
    if (!isSafeNotebookPathV1(path)) {
      throw new NotebookExecutionErrorV1(
        "notebook_runner_path_unsafe",
        `Notebook execution path is not a safe workspace-relative .ipynb path: ${path}.`,
      );
    }
  }
  const args = [
    "-c",
    NOTEBOOK_RUNNER_DRIVER_V1,
    ...encodeRunnerChunksV1(),
    NOTEBOOK_RUNNER_ARGV_SEPARATOR_V1,
    mode,
    ...paths,
  ];
  if (args.length > NOTEBOOK_RUNNER_MAX_ARGS_V1) {
    throw new NotebookExecutionErrorV1(
      "notebook_runner_argv_overflow",
      `Notebook execution argv needs ${args.length} entries but the immutable command contract allows ${NOTEBOOK_RUNNER_MAX_ARGS_V1}.`,
    );
  }
  return args;
}

/** Recover the exact program a prepared action would run. Used by tests and diagnostics. */
export function decodeNotebookRunnerArgsV1(args: readonly string[]): {
  source: string;
  mode: NotebookRunnerModeV1;
  notebookPaths: string[];
} {
  const separator = args.indexOf(NOTEBOOK_RUNNER_ARGV_SEPARATOR_V1);
  if (args[0] !== "-c" || args[1] !== NOTEBOOK_RUNNER_DRIVER_V1 || separator < 2) {
    throw new NotebookExecutionErrorV1(
      "notebook_runner_argv_unrecognized",
      "These arguments were not produced by the host notebook runner builder.",
    );
  }
  const mode = args[separator + 1];
  if (mode !== "execute" && mode !== "probe") {
    throw new NotebookExecutionErrorV1(
      "notebook_runner_mode_invalid",
      "Notebook runner argv carries no valid mode.",
    );
  }
  return {
    source: Buffer.from(args.slice(2, separator).join(""), "base64").toString("utf8"),
    mode,
    notebookPaths: args.slice(separator + 2),
  };
}

export function isSafeNotebookPathV1(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 7 || value.length > 400) return false;
  if (!value.toLowerCase().endsWith(".ipynb")) return false;
  if (value.includes("\\") || value.startsWith("/") || /^[a-z]:/iu.test(value)) return false;
  return value
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== ".." && !part.startsWith("."));
}

/** Notebook paths inside a trusted hash-bound staging manifest, deduplicated and ordered. */
export function notebookStagingPathsV1(
  stagingManifest: readonly { path: string }[],
): string[] {
  return [
    ...new Set(
      stagingManifest
        .map((entry) => entry.path)
        .filter((path) => isSafeNotebookPathV1(path)),
    ),
  ].sort();
}

/**
 * Parse the runner's bounded JSON summary. Anything that is not an exact
 * contract-matching document is rejected: a summary is evidence, so a partial
 * or unrecognized one must never be read as a successful execution.
 */
export function parseNotebookRunSummaryV1(stdout: unknown): NotebookRunSummaryV1 {
  if (typeof stdout !== "string" || stdout.length < 2 || stdout.length > 1_000_000) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary must be bounded text.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary is not valid JSON.",
    );
  }
  const record = asRecord(parsed);
  if (
    !record ||
    record.version !== 1 ||
    record.runner !== "agentic_notebook_runner" ||
    (record.mode !== "execute" && record.mode !== "probe") ||
    (record.status !== "executed" && record.status !== "failed") ||
    typeof record.python !== "string" ||
    record.python.length > 64 ||
    !Number.isSafeInteger(record.executedCellCount) ||
    (record.executedCellCount as number) < 0 ||
    !Array.isArray(record.notebooks) ||
    record.notebooks.length < 1 ||
    record.notebooks.length > NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 ||
    (record.failedNotebook !== null && typeof record.failedNotebook !== "string")
  ) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary does not match the host runner contract.",
    );
  }
  if (record.contract !== NOTEBOOK_EXECUTION_CONTRACT_V1) {
    throw new NotebookExecutionErrorV1(
      "notebook_runtime_contract_mismatch",
      `Notebook runner reported contract ${String(record.contract)}; this host speaks ${NOTEBOOK_EXECUTION_CONTRACT_V1}.`,
    );
  }
  const notebooks = record.notebooks.map((entry) => parseRunEntryV1(entry));
  const failedNotebook = (record.failedNotebook as string | null) ?? null;
  const anyFailed = notebooks.some((entry) => entry.status !== "executed");
  if ((record.status === "failed") !== anyFailed || (failedNotebook !== null) !== anyFailed) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary status disagrees with its own per-notebook results.",
    );
  }
  return {
    version: 1,
    runner: "agentic_notebook_runner",
    contract: NOTEBOOK_EXECUTION_CONTRACT_V1,
    mode: record.mode,
    python: record.python,
    optionalModules: parseOptionalModulesV1(record.optionalModules),
    notebooks,
    executedCellCount: record.executedCellCount as number,
    failedNotebook,
    status: record.status,
  };
}

function parseRunEntryV1(value: unknown): NotebookRunEntryV1 {
  const record = asRecord(value);
  if (
    !record ||
    typeof record.path !== "string" ||
    record.path.length < 1 ||
    record.path.length > 400 ||
    (record.status !== "executed" &&
      record.status !== "failed" &&
      record.status !== "error") ||
    (record.reason !== null && typeof record.reason !== "string") ||
    !Number.isSafeInteger(record.codeCells) ||
    !Number.isSafeInteger(record.executedCells) ||
    (record.executedCells as number) < 0 ||
    (record.executedCells as number) > (record.codeCells as number)
  ) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary contains an invalid notebook entry.",
    );
  }
  const failure =
    record.failure === null || record.failure === undefined
      ? null
      : parseFailureV1(record.failure);
  if ((record.status === "failed") !== (failure !== null)) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary reports a failed notebook without an exact failing cell.",
    );
  }
  return {
    path: record.path,
    status: record.status,
    reason: (record.reason as string | null) ?? null,
    codeCells: record.codeCells as number,
    executedCells: record.executedCells as number,
    failure,
  };
}

function parseFailureV1(value: unknown): NotebookCellFailureV1 {
  const record = asRecord(value);
  if (
    !record ||
    !Number.isSafeInteger(record.cellIndex) ||
    (record.cellIndex as number) < 0 ||
    !Number.isSafeInteger(record.executionCount) ||
    (record.executionCount as number) < 1 ||
    typeof record.ename !== "string" ||
    typeof record.evalue !== "string"
  ) {
    throw new NotebookExecutionErrorV1(
      "notebook_run_summary_invalid",
      "Notebook run summary failure record is invalid.",
    );
  }
  return {
    cellIndex: record.cellIndex as number,
    executionCount: record.executionCount as number,
    ename: record.ename.slice(0, 200),
    evalue: record.evalue.slice(0, 500),
  };
}

function parseOptionalModulesV1(value: unknown): Readonly<Record<string, boolean>> {
  const record = asRecord(value) ?? {};
  const output: Record<string, boolean> = {};
  for (const name of NOTEBOOK_OPTIONAL_MODULES_V1) {
    output[name] = record[name] === true;
  }
  return Object.freeze(output);
}

/** A runtime that has not proved itself. The only shape of an unavailable record. */
export function unprovedNotebookRuntimeV1(input: {
  checkedAt: string;
  diagnostic: string;
}): NotebookRuntimeAvailabilityV1 {
  return {
    version: 1,
    available: false,
    engine: "stdlib_cell_runner_v1",
    runnerFingerprint: notebookRunnerFingerprintV1(),
    python: null,
    optionalModules: parseOptionalModulesV1(null),
    checkedAt: input.checkedAt,
    diagnostic: input.diagnostic,
  };
}

/**
 * Turn one real probe execution into an availability record.
 *
 * The authority is the executed notebook that came back through the
 * hash-checked artifact importer, not the exit code and not the stdout
 * excerpt: it must show every probe cell executed, no error output, real
 * captured stdout, and a returned trailing-expression result. The runner's
 * stdout summary only supplies the interpreter version and the optional-module
 * inventory, which the notebook bytes cannot carry.
 */
export function notebookRuntimeAvailabilityFromProbeV1(input: {
  checkedAt: string;
  exitCode: number;
  stdout: string;
  executedNotebook: string | null;
  expectedExecutedCells: number;
}): NotebookRuntimeAvailabilityV1 {
  const base = {
    version: 1 as const,
    engine: "stdlib_cell_runner_v1" as const,
    runnerFingerprint: notebookRunnerFingerprintV1(),
    checkedAt: input.checkedAt,
  };
  let summary: NotebookRunSummaryV1 | null = null;
  let summaryDiagnostic: string | null = null;
  try {
    summary = parseNotebookRunSummaryV1(input.stdout);
  } catch (error) {
    summaryDiagnostic =
      error instanceof Error ? error.message : "unreadable runner summary";
  }
  if (input.executedNotebook === null) {
    return {
      ...base,
      available: false,
      python: summary?.python ?? null,
      optionalModules: summary?.optionalModules ?? parseOptionalModulesV1(null),
      diagnostic: `Notebook runtime probe exited ${input.exitCode} and returned no executed probe notebook${
        summaryDiagnostic ? ` (${summaryDiagnostic})` : ""
      }.`,
    };
  }
  let evidence: NotebookExecutionEvidenceV1;
  try {
    evidence = readNotebookExecutionEvidenceV1(input.executedNotebook);
  } catch (error) {
    return {
      ...base,
      available: false,
      python: summary?.python ?? null,
      optionalModules: summary?.optionalModules ?? parseOptionalModulesV1(null),
      diagnostic: `Notebook runtime probe returned an unreadable notebook: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const healthy =
    input.exitCode === 0 &&
    evidence.executedCells === input.expectedExecutedCells &&
    evidence.erroredCells === 0 &&
    evidence.streamCharacters > 0 &&
    evidence.resultCells > 0;
  return {
    ...base,
    available: healthy,
    python: summary?.python ?? null,
    optionalModules: summary?.optionalModules ?? parseOptionalModulesV1(null),
    diagnostic: healthy
      ? null
      : `Notebook runtime probe exited ${input.exitCode}; the returned notebook shows ${evidence.executedCells} of ${input.expectedExecutedCells} cells executed, ${evidence.erroredCells} errored, ${evidence.streamCharacters} captured stdout characters, and ${evidence.resultCells} returned results.`,
  };
}

export const NOTEBOOK_RUNTIME_PROBE_PROJECT_ID_V1 = "probe";
export const NOTEBOOK_RUNTIME_PROBE_WORKSPACE_ID_V1 = "agentic-notebook-runtime-probe";

/**
 * The fixed host-only profile the capability probe runs under. It carries no
 * repository or Git authority, stages exactly one notebook the host wrote
 * itself, and its single command is the same runner a real notebook mission
 * uses - so a green probe is evidence about the real path, not about a
 * simplified one.
 */
export function createNotebookRuntimeProbeProfileV2(input: {
  runtimeDigest: string;
}): RepositoryProfileV2 {
  return createRepositoryProfileV2({
    key: "agentic-notebook-runtime-probe",
    displayName: "Agentic Researcher notebook runtime probe",
    repositoryRoot: `/${NOTEBOOK_RUNTIME_PROBE_WORKSPACE_ID_V1}`,
    defaultBranch: "probe",
    projects: [
      {
        id: NOTEBOOK_RUNTIME_PROBE_PROJECT_ID_V1,
        root: ".",
        ecosystems: ["python"],
        allowedPaths: ["."],
      },
    ],
    ecosystems: ["python"],
    allowedPaths: ["."],
    protectedControls: [],
    pinnedRuntimes: [
      {
        projectId: NOTEBOOK_RUNTIME_PROBE_PROJECT_ID_V1,
        ecosystem: "python",
        executable: "python",
        version: "sandbox-bundled",
        source: "immutable_digest",
        digest: input.runtimeDigest,
        approval: "one_time_exact_digest",
      },
    ],
    validationCatalog: [
      {
        id: `${NOTEBOOK_RUNTIME_PROBE_PROJECT_ID_V1}-notebook-fast`,
        phase: "fast",
        projectId: NOTEBOOK_RUNTIME_PROBE_PROJECT_ID_V1,
        executable: "python",
        args: buildNotebookRunnerArgsV1({
          mode: "probe",
          notebookPaths: [NOTEBOOK_RUNTIME_PROBE_PATH_V1],
        }),
        cwd: ".",
        timeoutMs: 60_000,
        network: "disabled",
        credentialPolicy: "none",
        lockfile: null,
      },
    ],
    generatedOutputs: [NOTEBOOK_RUNTIME_PROBE_PATH_V1],
    requiredGitHubChecks: [],
    mergePolicy: defaultRepositoryMergePolicyV2(),
  });
}

/**
 * The single reason a notebook mission stays author-only. Production and the
 * degradation tests read this one predicate; nothing duplicates its wording.
 */
export function notebookExecutionDegradationV1(
  availability: NotebookRuntimeAvailabilityV1 | null,
): NotebookExecutionDegradationV1 | null {
  if (!availability) {
    return {
      code: "notebook_runtime_unprobed",
      message:
        "Notebook cell execution is unavailable because the verified sandbox has not yet proved it can run a notebook. Notebook authoring, reading, and export are unaffected.",
      requiredAction:
        "Refresh Code health, or run notebook validation again, so the host can execute its fixed probe notebook inside the verified sandbox.",
    };
  }
  if (availability.runnerFingerprint !== notebookRunnerFingerprintV1()) {
    return {
      code: "notebook_runtime_contract_mismatch",
      message:
        "Notebook cell execution is unavailable because the recorded probe proves a different notebook runner than this build ships. Notebook authoring, reading, and export are unaffected.",
      requiredAction:
        "Refresh Code health so the current runner is proved inside the verified sandbox before any notebook executes.",
    };
  }
  if (!availability.available) {
    return {
      code: "notebook_runtime_probe_failed",
      message: `Notebook cell execution is unavailable because the verified sandbox failed the host notebook probe. ${
        availability.diagnostic ?? "The probe reported no diagnostic."
      } Notebook authoring, reading, and export are unaffected.`,
      requiredAction:
        "Reprovision the sandbox runtime with scripts/setup-wsl2-sandbox.ps1 (or the Podman/bubblewrap equivalent) so its pinned Python can execute a notebook, then refresh Code health.",
    };
  }
  return null;
}

/**
 * What a proved-available runtime still cannot do. This is the honest answer
 * to "why did my notebook fail on import pandas" and it is the only place that
 * recommends provisioning work the product does not need in order to function.
 */
export function notebookRuntimeUpgradeAdviceV1(
  availability: NotebookRuntimeAvailabilityV1 | null,
): string | null {
  if (!availability?.available) return null;
  const missing = NOTEBOOK_OPTIONAL_MODULES_V1.filter(
    (name) => availability.optionalModules[name] !== true,
  );
  if (missing.length === 0) return null;
  return `Cells execute in a standard-library-only pinned runtime: ${missing.join(", ")} are not installed, so notebooks importing them fail with ModuleNotFoundError. Rich display output and IPython magics are not captured. Add the packages to the sandbox runtime root and re-fingerprint it to lift this.`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * The fixed probe notebook. Its cells are chosen so that a successful run is
 * unambiguous evidence: one cell must print through captured stdout and one
 * must return a value through the trailing-expression path. The bytes are
 * produced by the same deterministic builder that authors user notebooks.
 */
export const NOTEBOOK_RUNTIME_PROBE_CELLS_V1 = Object.freeze([
  Object.freeze({
    type: "markdown" as const,
    source: "# Agentic Researcher notebook runtime probe\n",
  }),
  Object.freeze({
    type: "code" as const,
    source: "answer = 6 * 7\nprint('answer=' + str(answer))\n",
  }),
  Object.freeze({ type: "code" as const, source: "answer\n" }),
]);

export const NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1 = 2;

export function notebookRuntimeProbeContentV1(): string {
  return buildJupyterNotebookV1({
    cells: NOTEBOOK_RUNTIME_PROBE_CELLS_V1.map((cell) => ({ ...cell })),
  }).content;
}

export interface NotebookExecutionEvidenceV1 {
  codeCells: number;
  executedCells: number;
  erroredCells: number;
  streamCharacters: number;
  resultCells: number;
}

/**
 * Read what a notebook's own bytes prove about execution. Nothing here trusts
 * a flag: a cell counts as executed only when it carries a positive
 * `execution_count`, which the authoring path never emits.
 */
export function readNotebookExecutionEvidenceV1(
  content: string,
): NotebookExecutionEvidenceV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unreadable",
      "Executed notebook bytes are not valid JSON.",
    );
  }
  const record = asRecord(parsed);
  const cells = record?.cells;
  if (!Array.isArray(cells)) {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unreadable",
      "Executed notebook bytes contain no cells array.",
    );
  }
  const evidence: NotebookExecutionEvidenceV1 = {
    codeCells: 0,
    executedCells: 0,
    erroredCells: 0,
    streamCharacters: 0,
    resultCells: 0,
  };
  for (const entry of cells) {
    const cell = asRecord(entry);
    if (!cell || cell.cell_type !== "code") continue;
    evidence.codeCells += 1;
    if (!Number.isSafeInteger(cell.execution_count) || (cell.execution_count as number) < 1) {
      continue;
    }
    evidence.executedCells += 1;
    const outputs = Array.isArray(cell.outputs) ? cell.outputs : [];
    for (const rawOutput of outputs) {
      const output = asRecord(rawOutput);
      if (!output) continue;
      if (output.output_type === "error") evidence.erroredCells += 1;
      if (output.output_type === "execute_result") evidence.resultCells += 1;
      if (output.output_type === "stream") {
        const text = output.text;
        evidence.streamCharacters += Array.isArray(text)
          ? text.reduce(
              (total: number, part: unknown) =>
                total + (typeof part === "string" ? part.length : 0),
              0,
            )
          : typeof text === "string"
            ? text.length
            : 0;
      }
    }
  }
  return evidence;
}

export interface NotebookExecutionReceiptEvidenceV1 {
  fingerprint: string;
  commandId: string;
  exitCode: number;
  status: "verified" | "failed";
  importedArtifacts: ReadonlyArray<{ path: string; readbackSha256: string }>;
}

export interface NotebookExecutionProofV1 {
  version: 1;
  notebookPath: string;
  executionState: "executed";
  engine: "stdlib_cell_runner_v1";
  runnerFingerprint: string;
  receiptFingerprint: string;
  commandId: string;
  exitCode: number;
  executedCells: number;
  erroredCells: number;
  artifactSha256: string;
}

/**
 * Flip a notebook from `not_executed` to `executed` - and only ever on real
 * evidence. Three independent facts must line up: a sandbox receipt exists,
 * that receipt imported *this* path with a readback hash equal to the exact
 * bytes in hand, and those bytes themselves show at least one executed cell.
 * Any weaker input throws rather than returning an optimistic state.
 */
export function buildNotebookExecutionProofV1(input: {
  notebookPath: string;
  content: string;
  receipt: NotebookExecutionReceiptEvidenceV1;
}): NotebookExecutionProofV1 {
  if (!isSafeNotebookPathV1(input.notebookPath)) {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unproven",
      "Notebook execution proof requires a safe workspace-relative .ipynb path.",
    );
  }
  const receipt = input.receipt;
  if (
    !receipt ||
    !/^sha256:[0-9a-f]{64}$/u.test(receipt.fingerprint ?? "") ||
    (receipt.status !== "verified" && receipt.status !== "failed") ||
    !Number.isSafeInteger(receipt.exitCode) ||
    typeof receipt.commandId !== "string" ||
    receipt.commandId.length < 1
  ) {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unproven",
      "Notebook execution proof requires a complete sandbox execution receipt.",
    );
  }
  const artifactSha256 = `sha256:${portableSha256Text(input.content)}`;
  const imported = (receipt.importedArtifacts ?? []).find(
    (artifact) => artifact.path === input.notebookPath,
  );
  if (!imported || imported.readbackSha256 !== artifactSha256) {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unproven",
      `The sandbox receipt does not bind these exact executed bytes to ${input.notebookPath}.`,
    );
  }
  const evidence = readNotebookExecutionEvidenceV1(input.content);
  if (evidence.executedCells < 1) {
    throw new NotebookExecutionErrorV1(
      "notebook_execution_unproven",
      `The imported notebook ${input.notebookPath} carries no executed cell.`,
    );
  }
  return {
    version: 1,
    notebookPath: input.notebookPath,
    executionState: "executed",
    engine: "stdlib_cell_runner_v1",
    runnerFingerprint: notebookRunnerFingerprintV1(),
    receiptFingerprint: receipt.fingerprint,
    commandId: receipt.commandId,
    exitCode: receipt.exitCode,
    executedCells: evidence.executedCells,
    erroredCells: evidence.erroredCells,
    artifactSha256,
  };
}

export const NOTEBOOK_EXECUTION_TIMEOUT_MS_V1 = 300_000;
export const NOTEBOOK_ARTIFACT_MAX_BYTES_V1 = 4_000_000;

export interface NotebookValidationPlanV1 {
  notebookPaths: string[];
  /** Phases notebook execution owns. Empty when it owns none. */
  phases: ValidationPhaseV2[];
  commands: RepositoryValidationCommandV2[];
  generatedOutputs: string[];
  expectedArtifacts: Array<{
    path: string;
    expectedSha256: null;
    maxBytes: number;
    required: false;
  }>;
  /** Non-null exactly when notebooks are present but cannot be executed. */
  degradation: NotebookExecutionDegradationV1 | null;
}

/**
 * Which validation phases notebook execution takes over.
 *
 * A workspace whose only sources are notebooks has no other validation at all
 * today - `createScratchPythonSandboxProfileV2` refuses it outright - so
 * notebooks own every phase. When Python sources are present their existing
 * compile and unittest contract is load-bearing and must not regress, so
 * notebooks claim only `targeted`: the phase whose whole meaning is "validate
 * the thing I just changed". `fast` still compiles and `full` still runs the
 * Python tests.
 */
export function notebookOwnedPhasesV1(input: {
  hasOtherSources: boolean;
}): ValidationPhaseV2[] {
  return input.hasOtherSources ? ["targeted"] : ["fast", "targeted", "full"];
}

/**
 * The single decision point for notebook validation. Production builds its
 * catalog from this and the tests assert against this; neither restates the
 * other's expression.
 */
export function planNotebookValidationV1(input: {
  projectId: string;
  projectRoot: string;
  stagingManifest: readonly { path: string }[];
  hasOtherSources: boolean;
  availability: NotebookRuntimeAvailabilityV1 | null;
}): NotebookValidationPlanV1 {
  const notebookPaths = notebookStagingPathsV1(input.stagingManifest);
  const empty: NotebookValidationPlanV1 = {
    notebookPaths,
    phases: [],
    commands: [],
    generatedOutputs: [],
    expectedArtifacts: [],
    degradation: null,
  };
  if (notebookPaths.length === 0) return empty;
  const degradation = notebookExecutionDegradationV1(input.availability);
  if (degradation) return { ...empty, degradation };
  if (notebookPaths.length > NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1) {
    return {
      ...empty,
      degradation: {
        code: "notebook_runtime_probe_failed",
        message: `Notebook cell execution is unavailable because this workspace holds ${notebookPaths.length} notebooks and one immutable command can execute at most ${NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1}. Notebook authoring, reading, and export are unaffected.`,
        requiredAction: `Split the workspace so no more than ${NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1} notebooks validate together.`,
      },
    };
  }
  const args = buildNotebookRunnerArgsV1({ mode: "execute", notebookPaths });
  const phases = notebookOwnedPhasesV1({ hasOtherSources: input.hasOtherSources });
  return {
    notebookPaths,
    phases,
    commands: phases.map((phase) => ({
      id: `${input.projectId}-notebook-${phase}`,
      phase,
      projectId: input.projectId,
      executable: "python",
      args: [...args],
      cwd: input.projectRoot,
      timeoutMs: NOTEBOOK_EXECUTION_TIMEOUT_MS_V1,
      network: "disabled" as const,
      credentialPolicy: "none" as const,
      lockfile: null,
    })),
    generatedOutputs: [...notebookPaths],
    expectedArtifacts: notebookPaths.map((path) => ({
      path,
      expectedSha256: null,
      maxBytes: NOTEBOOK_ARTIFACT_MAX_BYTES_V1,
      required: false as const,
    })),
    degradation: null,
  };
}

/**
 * Artifact declarations for a selected validation command, derived from the
 * command itself. A command that is not the host notebook runner declares
 * nothing, so this can never widen the artifact surface of any other
 * validation; and the notebooks it declares are the ones its own argv names,
 * not a separately computed list that could drift from it.
 */
export function notebookExecutionArtifactsForCommandV1(input: {
  generatedOutputs: readonly string[];
  command: { args: readonly string[] };
}): NotebookValidationPlanV1["expectedArtifacts"] {
  let decoded: { notebookPaths: string[] };
  try {
    decoded = decodeNotebookRunnerArgsV1(input.command.args);
  } catch {
    return [];
  }
  const declared = new Set(input.generatedOutputs);
  return decoded.notebookPaths
    .filter((path) => declared.has(path) && isSafeNotebookPathV1(path))
    .map((path) => ({
      path,
      expectedSha256: null,
      maxBytes: NOTEBOOK_ARTIFACT_MAX_BYTES_V1,
      required: false as const,
    }));
}
