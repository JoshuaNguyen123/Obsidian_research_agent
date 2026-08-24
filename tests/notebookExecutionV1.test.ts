import assert from "node:assert/strict";
import test from "node:test";

import { buildJupyterNotebookV1 } from "../extensions/code/JupyterNotebookV1";
import {
  NOTEBOOK_RUNNER_MAX_ARGS_V1,
  NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1,
  NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  NOTEBOOK_RUNTIME_PROBE_PATH_V1,
  NotebookExecutionErrorV1,
  buildNotebookExecutionProofV1,
  buildNotebookRunnerArgsV1,
  createNotebookRuntimeProbeProfileV2,
  decodeNotebookRunnerArgsV1,
  notebookExecutionArtifactsForCommandV1,
  notebookExecutionDegradationV1,
  notebookOwnedPhasesV1,
  notebookRunnerArgvBudgetV1,
  notebookRunnerFingerprintV1,
  notebookRuntimeAvailabilityFromProbeV1,
  notebookRuntimeProbeContentV1,
  notebookRuntimeUpgradeAdviceV1,
  parseNotebookRunSummaryV1,
  planNotebookValidationV1,
  readNotebookExecutionEvidenceV1,
  unprovedNotebookRuntimeV1,
  type NotebookRuntimeAvailabilityV1,
} from "../extensions/code/notebooks/NotebookExecutionV1";
import { parseRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import { portableSha256Text } from "../packages/core-api/src/portableSha256";

const CHECKED_AT = "2026-08-23T09:00:00.000Z";

function provedRuntime(
  overrides: Partial<NotebookRuntimeAvailabilityV1> = {},
): NotebookRuntimeAvailabilityV1 {
  return {
    version: 1,
    available: true,
    engine: "stdlib_cell_runner_v1",
    runnerFingerprint: notebookRunnerFingerprintV1(),
    python: "3.12.3",
    optionalModules: {
      ipykernel: false,
      matplotlib: false,
      nbclient: false,
      nbformat: false,
      numpy: false,
      pandas: false,
    },
    checkedAt: CHECKED_AT,
    diagnostic: null,
    ...overrides,
  };
}

/** An executed notebook exactly as the host runner writes one back. */
function executedNotebook(input: {
  executionCount?: number | null;
  withError?: boolean;
  withStream?: boolean;
  withResult?: boolean;
} = {}): string {
  const outputs: unknown[] = [];
  if (input.withStream !== false) {
    outputs.push({
      output_type: "stream",
      name: "stdout",
      text: ["answer=42\n"],
    });
  }
  if (input.withResult !== false) {
    outputs.push({
      output_type: "execute_result",
      execution_count: 1,
      data: { "text/plain": ["42"] },
      metadata: {},
    });
  }
  if (input.withError) {
    outputs.push({
      output_type: "error",
      ename: "ModuleNotFoundError",
      evalue: "No module named 'pandas'",
      traceback: ["Traceback"],
    });
  }
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count:
            input.executionCount === undefined ? 1 : input.executionCount,
          metadata: {},
          outputs,
          source: ["answer = 6 * 7\n"],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  )}\n`;
}

test("notebook runner argv stays inside the immutable command contract and round-trips exactly", () => {
  const args = buildNotebookRunnerArgsV1({
    mode: "execute",
    notebookPaths: ["results/analysis.ipynb", "intro.ipynb"],
  });
  assert.ok(
    args.length <= NOTEBOOK_RUNNER_MAX_ARGS_V1,
    `argv used ${args.length} of ${NOTEBOOK_RUNNER_MAX_ARGS_V1} allowed entries`,
  );
  for (const argument of args) {
    assert.ok(argument.length >= 1 && argument.length <= 500, argument.slice(0, 40));
    assert.equal(/[\r\n\0]/u.test(argument), false);
    assert.equal(argument.trim(), argument);
  }
  const decoded = decodeNotebookRunnerArgsV1(args);
  assert.equal(decoded.mode, "execute");
  assert.deepEqual(decoded.notebookPaths, ["intro.ipynb", "results/analysis.ipynb"]);
  assert.ok(decoded.source.includes("def execute_notebook(path):"));
  assert.equal(
    decoded.source.includes(String.fromCharCode(92)),
    false,
    "the runner program must contain no backslash so argv transport cannot change its meaning",
  );
  assert.equal(
    decoded.source.includes(String.fromCharCode(13)),
    false,
    "a CRLF checkout must not change the program the sandbox runs or its fingerprint",
  );
});

test("notebook runner argv refuses paths and counts it cannot execute safely", () => {
  for (const unsafe of [
    "../escape.ipynb",
    "/absolute.ipynb",
    "windows\\path.ipynb",
    ".hidden/analysis.ipynb",
    "notebook.txt",
  ]) {
    assert.throws(
      () => buildNotebookRunnerArgsV1({ mode: "execute", notebookPaths: [unsafe] }),
      (error: unknown) =>
        error instanceof NotebookExecutionErrorV1 &&
        (error.code === "notebook_runner_path_unsafe" ||
          error.code === "notebook_runner_path_count_invalid"),
      unsafe,
    );
  }
  assert.throws(
    () => buildNotebookRunnerArgsV1({ mode: "execute", notebookPaths: [] }),
    /1-16 notebook paths/u,
  );
  assert.throws(
    () =>
      buildNotebookRunnerArgsV1({
        mode: "execute",
        notebookPaths: Array.from(
          { length: NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 + 1 },
          (_unused, index) => `notebook-${index}.ipynb`,
        ),
      }),
    /1-16 notebook paths/u,
  );
});

test("an unprobed or unproved notebook runtime contributes no command and says why", () => {
  const unprobed = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }],
    hasOtherSources: false,
    availability: null,
  });
  assert.deepEqual(unprobed.commands, []);
  assert.deepEqual(unprobed.generatedOutputs, []);
  assert.deepEqual(unprobed.expectedArtifacts, []);
  assert.equal(unprobed.degradation?.code, "notebook_runtime_unprobed");
  assert.match(unprobed.degradation!.message, /authoring, reading, and export are unaffected/u);

  const failed = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }],
    hasOtherSources: false,
    availability: provedRuntime({
      available: false,
      diagnostic: "the returned notebook shows 0 of 2 cells executed",
    }),
  });
  assert.equal(failed.degradation?.code, "notebook_runtime_probe_failed");
  assert.match(failed.degradation!.message, /0 of 2 cells executed/u);
  assert.deepEqual(failed.commands, []);

  const drifted = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }],
    hasOtherSources: false,
    availability: provedRuntime({ runnerFingerprint: `sha256:${"0".repeat(64)}` }),
  });
  assert.equal(drifted.degradation?.code, "notebook_runtime_contract_mismatch");
  assert.deepEqual(drifted.commands, []);
});

test("a proved runtime contributes host-owned notebook commands scoped to the phases it should own", () => {
  const notebookOnly = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }, { path: "notes.md" }],
    hasOtherSources: false,
    availability: provedRuntime(),
  });
  assert.equal(notebookOnly.degradation, null);
  assert.deepEqual(
    notebookOnly.commands.map((command) => command.phase),
    notebookOwnedPhasesV1({ hasOtherSources: false }),
  );
  assert.deepEqual(notebookOnly.commands.map((command) => command.id), [
    "scratch-notebook-fast",
    "scratch-notebook-targeted",
    "scratch-notebook-full",
  ]);
  for (const command of notebookOnly.commands) {
    assert.equal(command.executable, "python");
    assert.equal(command.network, "disabled");
    assert.equal(command.credentialPolicy, "none");
    assert.equal(command.lockfile, null);
    assert.deepEqual(decodeNotebookRunnerArgsV1(command.args).notebookPaths, [
      "analysis.ipynb",
    ]);
  }
  assert.deepEqual(notebookOnly.generatedOutputs, ["analysis.ipynb"]);
  assert.deepEqual(notebookOnly.expectedArtifacts, [
    {
      path: "analysis.ipynb",
      expectedSha256: null,
      maxBytes: 4_000_000,
      required: false,
    },
  ]);

  const mixed = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }, { path: "helper.py" }],
    hasOtherSources: true,
    availability: provedRuntime(),
  });
  assert.deepEqual(
    mixed.commands.map((command) => command.phase),
    ["targeted"],
    "a workspace with Python sources keeps its existing fast compile and full unittest contract",
  );
});

test("notebook execution declares nothing on a workspace holding no notebook", () => {
  const plan = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "main.py" }, { path: "README.md" }],
    hasOtherSources: true,
    availability: provedRuntime(),
  });
  assert.deepEqual(plan.notebookPaths, []);
  assert.deepEqual(plan.commands, []);
  assert.deepEqual(plan.phases, []);
  assert.equal(plan.degradation, null);
});

test("artifact declarations come from the selected command and never widen another one", () => {
  const notebookCommand = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: [{ path: "analysis.ipynb" }],
    hasOtherSources: false,
    availability: provedRuntime(),
  }).commands[0]!;
  assert.deepEqual(
    notebookExecutionArtifactsForCommandV1({
      generatedOutputs: ["analysis.ipynb"],
      command: notebookCommand,
    }).map((artifact) => artifact.path),
    ["analysis.ipynb"],
  );
  assert.deepEqual(
    notebookExecutionArtifactsForCommandV1({
      generatedOutputs: ["analysis.ipynb"],
      command: { args: ["-m", "compileall", "-q", "."] },
    }),
    [],
    "a Python validation command must keep declaring no generated artifact",
  );
  assert.deepEqual(
    notebookExecutionArtifactsForCommandV1({
      generatedOutputs: [],
      command: notebookCommand,
    }),
    [],
    "a notebook outside the profile's generated outputs is never declared",
  );
});

test("notebook runtime availability follows the executed artifact, not the exit code", () => {
  const stdout = JSON.stringify({
    version: 1,
    runner: "agentic_notebook_runner",
    contract: 1,
    mode: "probe",
    python: "3.12.3",
    optionalModules: { numpy: false },
    notebooks: [
      {
        path: NOTEBOOK_RUNTIME_PROBE_PATH_V1,
        status: "executed",
        reason: null,
        codeCells: 2,
        executedCells: 2,
        failure: null,
      },
    ],
    executedCellCount: 2,
    failedNotebook: null,
    status: "executed",
  });
  const probeNotebook = `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [{ output_type: "stream", name: "stdout", text: ["answer=42\n"] }],
          source: ["answer = 6 * 7\n"],
        },
        {
          cell_type: "code",
          execution_count: 2,
          metadata: {},
          outputs: [
            {
              output_type: "execute_result",
              execution_count: 2,
              data: { "text/plain": ["42"] },
              metadata: {},
            },
          ],
          source: ["answer\n"],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  )}\n`;

  const healthy = notebookRuntimeAvailabilityFromProbeV1({
    checkedAt: CHECKED_AT,
    exitCode: 0,
    stdout,
    executedNotebook: probeNotebook,
    expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  });
  assert.equal(healthy.available, true);
  assert.equal(healthy.python, "3.12.3");
  assert.equal(healthy.diagnostic, null);
  assert.equal(notebookExecutionDegradationV1(healthy), null);

  const noArtifact = notebookRuntimeAvailabilityFromProbeV1({
    checkedAt: CHECKED_AT,
    exitCode: 0,
    stdout,
    executedNotebook: null,
    expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  });
  assert.equal(
    noArtifact.available,
    false,
    "a clean exit code and a happy summary must not make notebooks executable on their own",
  );
  assert.match(noArtifact.diagnostic!, /returned no executed probe notebook/u);

  const unexecuted = notebookRuntimeAvailabilityFromProbeV1({
    checkedAt: CHECKED_AT,
    exitCode: 0,
    stdout,
    executedNotebook: notebookRuntimeProbeContentV1(),
    expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  });
  assert.equal(unexecuted.available, false);
  assert.match(unexecuted.diagnostic!, /0 of 2 cells executed/u);
});

test("an unproved runtime record carries the reason and never the executed engine claim", () => {
  const unproved = unprovedNotebookRuntimeV1({
    checkedAt: CHECKED_AT,
    diagnostic: "No sandbox provider has passed its boundary probe.",
  });
  assert.equal(unproved.available, false);
  assert.equal(unproved.python, null);
  assert.equal(notebookRuntimeUpgradeAdviceV1(unproved), null);
  assert.equal(
    notebookExecutionDegradationV1(unproved)?.code,
    "notebook_runtime_probe_failed",
  );
});

test("a proved runtime still reports which scientific packages the pinned runtime lacks", () => {
  const advice = notebookRuntimeUpgradeAdviceV1(provedRuntime());
  assert.match(advice!, /numpy/u);
  assert.match(advice!, /pandas/u);
  assert.match(advice!, /ModuleNotFoundError/u);
  assert.equal(
    notebookRuntimeUpgradeAdviceV1(
      provedRuntime({
        optionalModules: {
          ipykernel: true,
          matplotlib: true,
          nbclient: true,
          nbformat: true,
          numpy: true,
          pandas: true,
        },
      }),
    ),
    null,
  );
});

test("authoring still emits not_executed and its bytes prove no cell ran", () => {
  const built = buildJupyterNotebookV1({
    cells: [
      { type: "markdown", source: "# Analysis\n" },
      { type: "code", source: "value = 6 * 7\nprint(value)\n" },
    ],
  });
  assert.equal(built.executionState, "not_executed");
  const evidence = readNotebookExecutionEvidenceV1(built.content);
  assert.deepEqual(evidence, {
    codeCells: 1,
    executedCells: 0,
    erroredCells: 0,
    streamCharacters: 0,
    resultCells: 0,
  });
});

test("executionState flips to executed only for hash-bound receipted bytes", () => {
  const content = executedNotebook();
  const artifactSha256 = `sha256:${portableSha256Text(content)}`;
  const receipt = {
    fingerprint: `sha256:${"a".repeat(64)}`,
    commandId: "scratch-notebook-targeted",
    exitCode: 0,
    status: "verified" as const,
    importedArtifacts: [
      { path: "analysis.ipynb", readbackSha256: artifactSha256 },
    ],
  };
  const proof = buildNotebookExecutionProofV1({
    notebookPath: "analysis.ipynb",
    content,
    receipt,
  });
  assert.equal(proof.executionState, "executed");
  assert.equal(proof.executedCells, 1);
  assert.equal(proof.erroredCells, 0);
  assert.equal(proof.artifactSha256, artifactSha256);
  assert.equal(proof.receiptFingerprint, receipt.fingerprint);
  assert.equal(proof.runnerFingerprint, notebookRunnerFingerprintV1());

  assert.throws(
    () =>
      buildNotebookExecutionProofV1({
        notebookPath: "analysis.ipynb",
        content: `${content} `,
        receipt,
      }),
    (error: unknown) =>
      error instanceof NotebookExecutionErrorV1 &&
      error.code === "notebook_execution_unproven",
    "bytes the receipt did not hash must never claim execution",
  );
  assert.throws(
    () =>
      buildNotebookExecutionProofV1({
        notebookPath: "analysis.ipynb",
        content,
        receipt: { ...receipt, importedArtifacts: [] },
      }),
    /does not bind these exact executed bytes/u,
    "a receipt that imported nothing must never claim execution",
  );
  const unexecutedContent = executedNotebook({ executionCount: null });
  assert.throws(
    () =>
      buildNotebookExecutionProofV1({
        notebookPath: "analysis.ipynb",
        content: unexecutedContent,
        receipt: {
          ...receipt,
          importedArtifacts: [
            {
              path: "analysis.ipynb",
              readbackSha256: `sha256:${portableSha256Text(unexecutedContent)}`,
            },
          ],
        },
      }),
    /carries no executed cell/u,
    "a receipted notebook without an execution count must never claim execution",
  );
});

test("a failed cell still yields a proof, because a red result is a real result", () => {
  const content = executedNotebook({ withError: true });
  const proof = buildNotebookExecutionProofV1({
    notebookPath: "analysis.ipynb",
    content,
    receipt: {
      fingerprint: `sha256:${"b".repeat(64)}`,
      commandId: "scratch-notebook-full",
      exitCode: 1,
      status: "failed",
      importedArtifacts: [
        {
          path: "analysis.ipynb",
          readbackSha256: `sha256:${portableSha256Text(content)}`,
        },
      ],
    },
  });
  assert.equal(proof.executionState, "executed");
  assert.equal(proof.erroredCells, 1);
  assert.equal(proof.exitCode, 1);
});

test("the capability probe profile is a valid closed profile running the same runner", () => {
  const profile = createNotebookRuntimeProbeProfileV2({
    runtimeDigest: `sha256:${"c".repeat(64)}`,
  });
  assert.deepEqual(parseRepositoryProfileV2(profile), profile);
  assert.equal(profile.validationCatalog.length, 1);
  const command = profile.validationCatalog[0]!;
  assert.equal(command.executable, "python");
  assert.equal(command.network, "disabled");
  const decoded = decodeNotebookRunnerArgsV1(command.args);
  assert.equal(decoded.mode, "probe");
  assert.deepEqual(decoded.notebookPaths, [NOTEBOOK_RUNTIME_PROBE_PATH_V1]);
  assert.deepEqual(profile.generatedOutputs, [NOTEBOOK_RUNTIME_PROBE_PATH_V1]);
  const probe = notebookRuntimeProbeContentV1();
  assert.equal(probe, notebookRuntimeProbeContentV1());
  assert.equal(readNotebookExecutionEvidenceV1(probe).codeCells, 2);
});

/** A probe summary exactly as the host runner writes one for a green probe. */
function probeSummary(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({
    version: 1,
    runner: "agentic_notebook_runner",
    contract: 1,
    mode: "probe",
    python: "3.12.3",
    optionalModules: { numpy: false },
    notebooks: [
      {
        path: NOTEBOOK_RUNTIME_PROBE_PATH_V1,
        status: "executed",
        reason: null,
        codeCells: 2,
        executedCells: 2,
        failure: null,
      },
    ],
    executedCellCount: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
    failedNotebook: null,
    status: "executed",
    ...overrides,
  })}\n`;
}

/** Probe notebook bytes that show a real, healthy run of both probe cells. */
function executedProbeNotebook(): string {
  return `${JSON.stringify(
    {
      cells: [
        {
          cell_type: "code",
          execution_count: 1,
          metadata: {},
          outputs: [{ output_type: "stream", name: "stdout", text: ["answer=42\n"] }],
          source: ["answer = 6 * 7\n"],
        },
        {
          cell_type: "code",
          execution_count: 2,
          metadata: {},
          outputs: [
            {
              output_type: "execute_result",
              execution_count: 2,
              data: { "text/plain": ["42"] },
              metadata: {},
            },
          ],
          source: ["answer\n"],
        },
      ],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    },
    null,
    2,
  )}\n`;
}

test("the runner program still fits the immutable argv contract at full notebook capacity", () => {
  const budget = notebookRunnerArgvBudgetV1();
  const args = buildNotebookRunnerArgsV1({
    mode: "execute",
    notebookPaths: Array.from(
      { length: NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 },
      (_unused, index) => `notebook-${index}.ipynb`,
    ),
  });
  assert.equal(
    args.length,
    budget.worstCaseEntries,
    "the published budget must describe the argv the builder actually emits",
  );
  assert.equal(budget.limit, NOTEBOOK_RUNNER_MAX_ARGS_V1);
  assert.ok(
    budget.headroomEntries > 0,
    `the runner program grew past the immutable command contract: a full-capacity command needs ${budget.worstCaseEntries} of ${budget.limit} argv entries. Shrink the runner, raise NOTEBOOK_RUNNER_CHUNK_CHARS_V1, or lower NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 - never raise NOTEBOOK_RUNNER_MAX_ARGS_V1, which the sandbox entrypoint enforces at 65 entries including the executable.`,
  );
  // The overflow guard inside the builder is unreachable while this holds, so
  // this arithmetic - not a runtime path - is what keeps the bound honest.
  assert.ok(
    budget.headroomSourceChars > 0,
    "headroom must be expressible as runner-source characters",
  );
});

test("a notebook payload too large for one immutable command degrades and never throws", () => {
  const overflowing = planNotebookValidationV1({
    projectId: "scratch",
    projectRoot: ".",
    stagingManifest: Array.from(
      { length: NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 + 1 },
      (_unused, index) => ({ path: `notebook-${index}.ipynb` }),
    ),
    hasOtherSources: false,
    availability: provedRuntime(),
  });
  assert.equal(
    overflowing.degradation?.code,
    "notebook_runtime_payload_overflow",
    "a payload that does not fit is not a probe failure and must not be reported as one",
  );
  assert.match(
    overflowing.degradation!.message,
    /authoring, reading, and export are unaffected/u,
  );
  assert.deepEqual(overflowing.commands, []);
  assert.deepEqual(overflowing.generatedOutputs, []);
  assert.deepEqual(overflowing.expectedArtifacts, []);
});

test("a probe summary that is not this runner's own contract-matching output proves nothing", () => {
  const healthy = notebookRuntimeAvailabilityFromProbeV1({
    checkedAt: CHECKED_AT,
    exitCode: 0,
    stdout: probeSummary(),
    executedNotebook: executedProbeNotebook(),
    expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  });
  assert.equal(healthy.available, true, "the honest summary must still prove the runtime");

  const forged: Array<[string, string, RegExp]> = [
    ["truncated JSON", '{"version":1,"runner":"agentic_notebook_run', /not valid JSON/u],
    ["empty stdout", "", /bounded text/u],
    ["a newer runner contract", probeSummary({ contract: 2 }), /this host speaks 1/u],
    ["a foreign runner name", probeSummary({ runner: "papermill" }), /host runner contract/u],
    [
      "an execute-mode summary",
      probeSummary({ mode: "execute" }),
      /mode execute rather than probe/u,
    ],
    [
      "a summary whose own status disagrees with its notebooks",
      probeSummary({ status: "failed" }),
      /disagrees with its own per-notebook results/u,
    ],
    [
      "a summary counting cells the probe never had",
      probeSummary({ executedCellCount: 99 }),
      /counted 99 executed cells/u,
    ],
  ];
  for (const [label, stdout, expected] of forged) {
    const record = notebookRuntimeAvailabilityFromProbeV1({
      checkedAt: CHECKED_AT,
      exitCode: 0,
      stdout,
      // The executed artifact is impeccable; only the runner's own report is
      // forged. Availability must still be refused.
      executedNotebook: executedProbeNotebook(),
      expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
    });
    assert.equal(record.available, false, label);
    assert.match(record.diagnostic!, expected, label);
    assert.equal(
      notebookExecutionDegradationV1(record)?.code,
      "notebook_runtime_probe_failed",
      label,
    );
  }
});

test("the runner fingerprint on a probe record is the host's own, never the payload's", () => {
  const record = notebookRuntimeAvailabilityFromProbeV1({
    checkedAt: CHECKED_AT,
    exitCode: 0,
    stdout: probeSummary({
      runnerFingerprint: `sha256:${"e".repeat(64)}`,
      engine: "papermill",
      available: true,
    }),
    executedNotebook: executedProbeNotebook(),
    expectedExecutedCells: NOTEBOOK_RUNTIME_PROBE_EXECUTED_CELLS_V1,
  });
  assert.equal(record.runnerFingerprint, notebookRunnerFingerprintV1());
  assert.equal(record.engine, "stdlib_cell_runner_v1");
  assert.equal(
    notebookExecutionDegradationV1({
      ...record,
      runnerFingerprint: `sha256:${"e".repeat(64)}`,
    })?.code,
    "notebook_runtime_contract_mismatch",
    "a stored record proving another runner must never contribute a command",
  );
});

test("the run summary parser rejects every partial or self-contradicting document", () => {
  assert.equal(parseNotebookRunSummaryV1(probeSummary()).executedCellCount, 2);
  const rejected: Array<[string, unknown, string]> = [
    ["not text", 42, "notebook_run_summary_invalid"],
    ["truncated JSON", '{"version":1', "notebook_run_summary_invalid"],
    ["a JSON array", "[]", "notebook_run_summary_invalid"],
    ["a newer contract", probeSummary({ contract: 7 }), "notebook_runtime_contract_mismatch"],
    ["no notebooks", probeSummary({ notebooks: [] }), "notebook_run_summary_invalid"],
    [
      "more notebooks than one command can carry",
      probeSummary({
        notebooks: Array.from({ length: NOTEBOOK_RUNNER_MAX_NOTEBOOKS_V1 + 1 }, () => ({
          path: "n.ipynb",
          status: "executed",
          reason: null,
          codeCells: 1,
          executedCells: 1,
          failure: null,
        })),
      }),
      "notebook_run_summary_invalid",
    ],
    [
      "a failed notebook with no failing cell",
      probeSummary({
        notebooks: [
          {
            path: NOTEBOOK_RUNTIME_PROBE_PATH_V1,
            status: "failed",
            reason: null,
            codeCells: 2,
            executedCells: 2,
            failure: null,
          },
        ],
        failedNotebook: NOTEBOOK_RUNTIME_PROBE_PATH_V1,
        status: "failed",
      }),
      "notebook_run_summary_invalid",
    ],
    [
      "more executed cells than the notebook holds",
      probeSummary({
        notebooks: [
          {
            path: NOTEBOOK_RUNTIME_PROBE_PATH_V1,
            status: "executed",
            reason: null,
            codeCells: 1,
            executedCells: 9,
            failure: null,
          },
        ],
      }),
      "notebook_run_summary_invalid",
    ],
  ];
  for (const [label, stdout, code] of rejected) {
    assert.throws(
      () => parseNotebookRunSummaryV1(stdout),
      (error: unknown) =>
        error instanceof NotebookExecutionErrorV1 && error.code === code,
      label,
    );
  }
  // Optional-module claims are never trusted as reported: anything that is not
  // an exact `true` reads as absent, so a forged inventory cannot silence the
  // upgrade advice a scientist needs.
  const forgedModules = parseNotebookRunSummaryV1(
    probeSummary({ optionalModules: { numpy: "yes", pandas: 1 } }),
  );
  assert.equal(forgedModules.optionalModules.numpy, false);
  assert.equal(forgedModules.optionalModules.pandas, false);
});
