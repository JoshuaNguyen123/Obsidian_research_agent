import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../packages/headless-runtime/src/canonicalize";
import {
  detectRepositoryProfileV2,
  parseRepositoryProfileV2,
} from "../extensions/code/repositories/RepositoryProfileV2";
import {
  DurableSandboxExecutionJournalErrorV1,
  DurableSandboxExecutionJournalV1,
  parseDurableSandboxExecutionNamespaceV1,
  type DurableSandboxExecutionJournalPersistenceV1,
  type DurableSandboxExecutionNamespaceV1,
  type DurableSandboxExecutionRecordV1,
} from "../extensions/code/sandbox/DurableSandboxExecutionJournalV1";
import {
  SandboxManagerV2,
  type PreparedSandboxActionV2,
  type SandboxExecutionReceiptV2,
  type SandboxProviderConfigV2,
} from "../extensions/code/sandbox/SandboxManager";

const NOW = "2026-08-19T12:00:00.000Z";
const PROBE = JSON.stringify({
  version: 1,
  uid: 65532,
  networkBlocked: true,
  rootReadOnly: true,
  hostRootAbsent: true,
  containerSocketAbsent: true,
  runtimeReadOnly: true,
  runtimeDigest: `sha256:${"f".repeat(64)}`,
  stagingIsolated: true,
  resourceLimitsEnforced: true,
});

test("prepared reconciliation durably proves not-applied and permanently suppresses dispatch", async () => {
  const fixture = await createFixture("validation_fast");
  const persistence = new MemoryPersistence();
  const journal = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));

  const prepared = await journal.recordPrepared({ runId: "run-1", action: fixture.action });
  assert.equal(prepared.status, "prepared");
  const reconciled = await journal.reconcile({ runId: "run-1", action: fixture.action });
  assert.equal(reconciled.outcome, "not_applied");
  if (reconciled.outcome !== "not_applied") return;
  assert.equal(reconciled.proof.actionId, fixture.action.id);
  assert.equal(
    reconciled.proof.fingerprint,
    fingerprint({
      actionId: fixture.action.id,
      actionFingerprint: fixture.action.payloadFingerprint,
      checkedAt: NOW,
    }),
  );
  await assert.rejects(
    journal.markDispatching({ runId: "run-1", action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_transition",
  );
  assert.equal(fixture.executions(), 0);

  const restarted = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  assert.equal(
    (await restarted.reconcile({ runId: "run-1", action: fixture.action })).outcome,
    "not_applied",
  );
});

test("a durable dispatch marker stays uncertain and can never authorize replay", async () => {
  const fixture = await createFixture("validation_fast");
  const persistence = new MemoryPersistence();
  const journal = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  await journal.recordPrepared({ runId: "run-1", action: fixture.action });
  await journal.markDispatching({ runId: "run-1", action: fixture.action });

  const reconciled = await journal.reconcile({ runId: "run-1", action: fixture.action });
  assert.equal(reconciled.outcome, "still_uncertain");
  if (reconciled.outcome === "still_uncertain") assert.match(reconciled.message, /Do not replay/iu);
  await assert.rejects(
    journal.markDispatching({ runId: "run-1", action: fixture.action }),
    /cannot dispatch from dispatch_uncertain/u,
  );
  assert.equal(fixture.executions(), 0);
});

test("non-validation execution persists exact receipt and reconciles across restart", async () => {
  const fixture = await createFixture("code_block");
  const persistence = new MemoryPersistence();
  const journal = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  await journal.recordPrepared({ runId: "run-1", action: fixture.action });
  await journal.markDispatching({ runId: "run-1", action: fixture.action });
  const receipt = await fixture.execute();
  const committed = await journal.recordExecutionReceipt({
    runId: "run-1",
    action: fixture.action,
    receipt,
  });
  assert.equal(committed.status, "committed");
  assert.deepEqual(committed.receipt, receipt);

  const restarted = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  const reconciled = await restarted.reconcile({ runId: "run-1", action: fixture.action });
  assert.equal(reconciled.outcome, "committed");
  if (reconciled.outcome === "committed") assert.deepEqual(reconciled.receipt, receipt);
  assert.equal(fixture.executions(), 1, "journal reconciliation must not run the sandbox again");
});

test("repair validation remains uncertain until both exact durable receipts exist", async () => {
  const fixture = await createFixture("validation_fast");
  const persistence = new MemoryPersistence();
  const journal = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  await journal.recordPrepared({ runId: "run-1", action: fixture.action });
  await journal.markDispatching({ runId: "run-1", action: fixture.action });
  const receipt = await fixture.execute();
  const executionVerified = await journal.recordExecutionReceipt({
    runId: "run-1",
    action: fixture.action,
    receipt,
  });
  assert.equal(executionVerified.status, "execution_verified");
  assert.equal(
    (await journal.reconcile({ runId: "run-1", action: fixture.action })).outcome,
    "still_uncertain",
  );

  const validation = validationReceipt(fixture.action, receipt);
  const committed = await journal.recordValidationReceipt({
    runId: "run-1",
    action: fixture.action,
    validationReceipt: validation,
  });
  assert.equal(committed.status, "committed");
  const reconciled = await new DurableSandboxExecutionJournalV1(
    persistence,
    () => new Date(NOW),
  ).reconcile({ runId: "run-1", action: fixture.action });
  assert.equal(reconciled.outcome, "committed");
  if (reconciled.outcome === "committed") {
    assert.deepEqual(reconciled.receipt, receipt);
    assert.deepEqual(reconciled.validationReceipt, validation);
  }
  assert.equal(fixture.executions(), 1);
});

test("journal parsing, CAS, and receipt conflicts fail closed", async () => {
  const fixture = await createFixture("code_block");
  const lyingPersistence = new MemoryPersistence();
  lyingPersistence.acknowledgeWithoutWrite = true;
  await assert.rejects(
    new DurableSandboxExecutionJournalV1(
      lyingPersistence,
      () => new Date(NOW),
    ).recordPrepared({ runId: "run-lied", action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_readback",
  );

  const persistence = new MemoryPersistence();
  const journal = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));
  await journal.recordPrepared({ runId: "run-1", action: fixture.action });
  const valid = persistence.snapshot()!;
  const id = Object.keys(valid.records)[0]!;
  const tampered = structuredClone(valid);
  tampered.records[id]!.action.command.timeoutMs += 1;
  assert.throws(
    () => parseDurableSandboxExecutionNamespaceV1(tampered),
    /prepared sandbox action fingerprint|journal record fingerprint/iu,
  );

  persistence.rejectNextWrite = true;
  await assert.rejects(
    journal.markDispatching({ runId: "run-1", action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_conflict",
  );

  await journal.markDispatching({ runId: "run-1", action: fixture.action });
  const receipt = await fixture.execute();
  await assert.rejects(
    journal.recordExecutionReceipt({
      runId: "run-1",
      action: fixture.action,
      receipt: { ...receipt, stdoutBytes: receipt.stdoutBytes + 1 },
    }),
    /canonical evidence/iu,
  );
  await journal.recordExecutionReceipt({ runId: "run-1", action: fixture.action, receipt });
  const { fingerprint: _fingerprint, ...conflictingEvidence } = {
    ...receipt,
    stdoutBytes: receipt.stdoutBytes + 1,
  };
  await assert.rejects(
    journal.recordExecutionReceipt({
      runId: "run-1",
      action: fixture.action,
      receipt: {
        ...conflictingEvidence,
        fingerprint: fingerprint(conflictingEvidence),
      },
    }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_receipt_conflict",
  );
});

test("capacity pruning removes only the deterministic oldest terminal proof", async () => {
  const fixture = await createFixture("validation_fast");
  const partialPersistence = new MemoryPersistence();
  const partial = new DurableSandboxExecutionJournalV1(
    partialPersistence,
    () => new Date(NOW),
  );
  await partial.recordPrepared({ runId: "run-prepared", action: fixture.action });
  await partial.recordPrepared({ runId: "run-dispatch", action: fixture.action });
  await partial.markDispatching({ runId: "run-dispatch", action: fixture.action });
  await partial.recordPrepared({ runId: "run-execution", action: fixture.action });
  await partial.markDispatching({ runId: "run-execution", action: fixture.action });
  await partial.recordExecutionReceipt({
    runId: "run-execution",
    action: fixture.action,
    receipt: await fixture.execute(),
  });
  const partialNamespace = partialPersistence.snapshot()!;
  const inFlight = Object.values(partialNamespace.records);
  assert.deepEqual(
    inFlight.map((record) => record.status).sort(),
    ["dispatch_uncertain", "execution_verified", "prepared"],
  );

  const terminalRecords = Array.from({ length: 509 }, (_, index) =>
    notAppliedRecord(
      `run-terminal-${index.toString().padStart(3, "0")}`,
      fixture.action,
      new Date(Date.parse(NOW) - (509 - index) * 1_000).toISOString(),
    )
  );
  const oldestTerminal = terminalRecords[0]!;
  const persistence = new MemoryPersistence({
    version: 1,
    revision: partialNamespace.revision,
    records: Object.fromEntries([
      ...Object.entries(partialNamespace.records),
      ...terminalRecords.map((record) => [record.id, record] as const),
    ]),
    retirement: retirementFence(),
  });
  const journal = new DurableSandboxExecutionJournalV1(
    persistence,
    () => new Date("2026-08-19T13:00:00.000Z"),
  );
  const added = await journal.recordPrepared({
    runId: "run-after-capacity",
    action: fixture.action,
  });
  const readback = persistence.snapshot()!;
  assert.equal(Object.keys(readback.records).length, 512);
  assert.equal(readback.records[oldestTerminal.id], undefined);
  assert.deepEqual(readback.retirement.recordIds, [oldestTerminal.id]);
  assert.equal(readback.retirement.retiredCount, 1);
  assert.equal(readback.records[terminalRecords[1]!.id]?.status, "not_applied");
  assert.equal(readback.records[added.id]?.status, "prepared");
  for (const record of inFlight) {
    assert.deepEqual(readback.records[record.id], record);
  }

  const executionsBeforeReplayAttempt = fixture.executions();
  const restarted = new DurableSandboxExecutionJournalV1(
    persistence,
    () => new Date("2026-08-19T14:00:00.000Z"),
  );
  await assert.rejects(
    restarted.recordPrepared({ runId: oldestTerminal.runId, action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_replay_blocked",
  );
  const compacted = await restarted.reconcile({
    runId: oldestTerminal.runId,
    action: fixture.action,
  });
  assert.equal(compacted.outcome, "still_uncertain");
  if (compacted.outcome === "still_uncertain") {
    assert.match(compacted.message, /compacted.*do not replay/iu);
  }
  await assert.rejects(
    restarted.markDispatching({ runId: oldestTerminal.runId, action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_replay_blocked",
  );
  assert.equal(
    fixture.executions(),
    executionsBeforeReplayAttempt,
    "a compacted terminal identity must never redispatch after restart",
  );

  const preparedOnly = Array.from({ length: 512 }, (_, index) =>
    preparedRecord(`run-in-flight-${index}`, fixture.action, NOW)
  );
  const fullInFlightPersistence = new MemoryPersistence({
    version: 1,
    revision: 512,
    records: Object.fromEntries(preparedOnly.map((record) => [record.id, record] as const)),
    retirement: retirementFence(),
  });
  await assert.rejects(
    new DurableSandboxExecutionJournalV1(
      fullInFlightPersistence,
      () => new Date(NOW),
    ).recordPrepared({ runId: "run-must-not-prune", action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_capacity",
  );
});

test("bounded retirement accumulator rolls over while exact retired actions stay blocked", async () => {
  const fixture = await createFixture("code_block");
  const exactRetiredRunId = "run-retired-exact";
  const exactRetiredId = journalRecordId(exactRetiredRunId, fixture.action);
  const fillerIds = Array.from(
    { length: 512 },
    (_, index) => `sandbox-execution:${index.toString(16).padStart(40, "0")}`,
  );
  const retirement = retirementFence([exactRetiredId, ...fillerIds]);
  assert.equal(retirement.recordIds.length, 512);
  assert.equal(retirement.retiredCount, 513);
  assert.equal(retirement.recordIds.includes(exactRetiredId), false);
  const persistence = new MemoryPersistence({
    version: 1,
    revision: 513,
    records: {},
    retirement,
  });
  const restarted = new DurableSandboxExecutionJournalV1(persistence, () => new Date(NOW));

  await assert.rejects(
    restarted.recordPrepared({ runId: exactRetiredRunId, action: fixture.action }),
    (error: unknown) =>
      error instanceof DurableSandboxExecutionJournalErrorV1 &&
      error.code === "sandbox_journal_replay_blocked",
  );
  assert.equal(
    (await restarted.reconcile({ runId: exactRetiredRunId, action: fixture.action })).outcome,
    "still_uncertain",
  );
  const unique = await restarted.recordPrepared({
    runId: "run-never-seen",
    action: fixture.action,
  });
  assert.equal(unique.status, "prepared");
  assert.equal(fixture.executions(), 0);
  assert.equal(persistence.snapshot()!.retirement.recordIds.length, 512);
  assert.equal(persistence.snapshot()!.retirement.retiredCount, 513);
});

function preparedRecord(
  runId: string,
  action: PreparedSandboxActionV2,
  timestamp: string,
): DurableSandboxExecutionRecordV1 {
  const evidence: Omit<DurableSandboxExecutionRecordV1, "fingerprint"> = {
    version: 1,
    id: journalRecordId(runId, action),
    revision: 0,
    runId,
    action: structuredClone(action),
    status: "prepared",
    preparedAt: timestamp,
    dispatchStartedAt: null,
    receiptRecordedAt: null,
    committedAt: null,
    updatedAt: timestamp,
    receipt: null,
    validationReceipt: null,
    notAppliedProof: null,
  };
  return { ...evidence, fingerprint: fingerprint(evidence) };
}

function notAppliedRecord(
  runId: string,
  action: PreparedSandboxActionV2,
  timestamp: string,
): DurableSandboxExecutionRecordV1 {
  const proofEvidence = {
    actionId: action.id,
    actionFingerprint: action.payloadFingerprint,
    checkedAt: timestamp,
  };
  const { fingerprint: _preparedFingerprint, ...preparedEvidence } = preparedRecord(
    runId,
    action,
    timestamp,
  );
  const evidence: Omit<DurableSandboxExecutionRecordV1, "fingerprint"> = {
    ...preparedEvidence,
    revision: 1,
    status: "not_applied",
    notAppliedProof: {
      ...proofEvidence,
      fingerprint: fingerprint(proofEvidence),
    },
  };
  return { ...evidence, fingerprint: fingerprint(evidence) };
}

function journalRecordId(runId: string, action: PreparedSandboxActionV2): string {
  return `sandbox-execution:${fingerprint({
    runId,
    actionFingerprint: action.payloadFingerprint,
  }).slice(7, 47)}`;
}

function retirementFence(recordIds: string[] = []) {
  const filter = Buffer.alloc(8_192);
  for (const id of recordIds) {
    const digest = createHash("sha256")
      .update(`sandbox-execution-retirement-v1:${id}`, "utf8")
      .digest();
    for (let index = 0; index < 7; index += 1) {
      const bit = digest.readUInt32BE(index * 4) % (8_192 * 8);
      filter[Math.floor(bit / 8)]! |= 1 << (bit % 8);
    }
  }
  const evidence = {
    version: 1 as const,
    recordIds: recordIds.slice(-512),
    filterHex: filter.toString("hex"),
    retiredCount: recordIds.length,
  };
  return { ...evidence, fingerprint: fingerprint(evidence) };
}

async function createFixture(
  purpose: "validation_fast" | "code_block",
): Promise<{
  action: PreparedSandboxActionV2;
  execute(): Promise<SandboxExecutionReceiptV2>;
  executions(): number;
}> {
  let executions = 0;
  const manager = new SandboxManagerV2({
    providers: [dockerProvider()],
    runner: {
      async run(spec) {
        if (spec.purpose === "boundary_probe") {
          return { exitCode: 0, stdout: PROBE, stderr: "" };
        }
        executions += 1;
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    now: () => new Date(NOW),
  });
  await manager.probeProviders();
  const source = new TextEncoder().encode("export const value = 1;\n");
  let profile = detectRepositoryProfileV2({
    key: "sandbox-journal-fixture",
    displayName: "Sandbox journal fixture",
    repositoryRoot: "/work/sandbox-journal-fixture",
    defaultBranch: "main",
    files: ["package.json", "package-lock.json", ".nvmrc", "src/index.ts"],
    fileContents: { ".nvmrc": "24.16.0" },
  });
  if (purpose === "code_block") {
    const offlineCommand = profile.validationCatalog.find((command) => command.phase === "fast");
    assert.ok(offlineCommand);
    profile = parseRepositoryProfileV2({
      ...profile,
      validationCatalog: [
        ...profile.validationCatalog,
        {
          ...offlineCommand,
          id: "root-code-block",
          phase: "targeted",
        },
      ],
    });
  }
  const prepared = await manager.prepareExecution({
    profile,
    purpose,
    projectId: "root",
    commandId: purpose === "code_block" ? "root-code-block" : "root-npm-test",
    workspaceId: "workspace-1",
    repairRequestId: purpose === "validation_fast" ? "request-1" : null,
    workspaceManifestFingerprint: `sha256:${"e".repeat(64)}`,
    stagingManifest: [{
      path: "src/index.ts",
      bytes: source.byteLength,
      sha256: bytesFingerprint(source),
    }],
  });
  if (prepared.status !== "prepared") throw new Error("Sandbox fixture preparation was blocked.");
  assert.equal(prepared.status, "prepared");
  return {
    action: prepared.action,
    async execute() {
      const result = await manager.executePrepared(prepared.action, {
        authorization: {
          preparedActionId: prepared.action.id,
          payloadFingerprint: prepared.action.payloadFingerprint,
          grantId: "grant-1",
        },
        stagedFiles: [{ path: "src/index.ts", bytes: source }],
      });
      assert.notEqual(result.status, "blocked");
      if (result.status === "blocked") throw new Error(result.blocker.message);
      return result.receipt;
    },
    executions: () => executions,
  };
}

function validationReceipt(
  action: PreparedSandboxActionV2,
  receipt: SandboxExecutionReceiptV2,
) {
  const evidence = {
    operationId: action.id,
    kind: "fast" as const,
    sandboxId: "sandbox-docker-journal",
    freshSandbox: true,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    checks: [{
      label: "root:root-npm-test",
      exitCode: receipt.exitCode,
      stdout: `sha256=${receipt.stdoutSha256};bytes=${receipt.stdoutBytes}`,
      stderr: `sha256=${receipt.stderrSha256};bytes=${receipt.stderrBytes}`,
      durationMs: 0,
    }],
    status: "passed" as const,
    failureFingerprint: null,
    binding: {
      requestId: action.repairRequestId,
      workspaceId: action.workspaceId,
      profileKey: action.profileKey,
      inputWorkspaceManifestFingerprint: action.workspaceManifestFingerprint,
      validatedWorkspaceManifestFingerprint: action.workspaceManifestFingerprint,
      workspaceChangedPaths: ["src/index.ts"],
      stagingManifestFingerprint: fingerprint(action.stagingManifest),
      stagedFiles: action.stagingManifest.map(({ path, sha256, bytes }) => ({
        path,
        sha256,
        bytes,
      })),
      importedArtifacts: receipt.importedArtifacts.map(({ path, sha256, bytes }) => ({
        path,
        sha256,
        bytes,
      })),
    },
  };
  return {
    version: 1,
    kindName: "code_validation",
    id: receipt.id,
    ...evidence,
    fingerprint: fingerprint(evidence),
  };
}

function dockerProvider(): SandboxProviderConfigV2 {
  return {
    version: 1,
    kind: "docker",
    executable: "docker",
    priority: 1,
    runtimeReference: "ghcr.io/openai/agentic-sandbox",
    runtimeDigest: `sha256:${"f".repeat(64)}`,
    wslDistribution: null,
    runtimeRoot: null,
  };
}

class MemoryPersistence implements DurableSandboxExecutionJournalPersistenceV1 {
  private value: DurableSandboxExecutionNamespaceV1 | null;
  rejectNextWrite = false;
  acknowledgeWithoutWrite = false;

  constructor(initial: DurableSandboxExecutionNamespaceV1 | null = null) {
    this.value = initial ? structuredClone(initial) : null;
  }

  async readNamespace(): Promise<DurableSandboxExecutionNamespaceV1 | null> {
    return this.value ? structuredClone(this.value) : null;
  }

  async writeNamespace(
    next: DurableSandboxExecutionNamespaceV1,
    expectedRevision: number,
  ): Promise<boolean> {
    if (this.rejectNextWrite) {
      this.rejectNextWrite = false;
      return false;
    }
    if (this.acknowledgeWithoutWrite) {
      this.acknowledgeWithoutWrite = false;
      return true;
    }
    if ((this.value?.revision ?? 0) !== expectedRevision) return false;
    this.value = structuredClone(next);
    return true;
  }

  snapshot(): DurableSandboxExecutionNamespaceV1 | null {
    return this.value ? structuredClone(this.value) : null;
  }
}

function bytesFingerprint(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function fingerprint(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}
