import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import type { ScopedExtensionContextV1 } from "../packages/core-api/src";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import {
  SandboxManagerV2,
  type SandboxProviderConfigV2,
} from "../extensions/code/sandbox/SandboxManager";
import {
  DurableSandboxExecutionJournalV1,
  type DurableSandboxExecutionJournalPersistenceV1,
  type DurableSandboxExecutionNamespaceV1,
} from "../extensions/code/sandbox/DurableSandboxExecutionJournalV1";
import {
  SANDBOX_PREPARATION_FAILURE_CODES_V2,
  SANDBOX_PREPARATION_FAILURE_STAGES_V2,
  classifySandboxPreparationFailureV2,
  createCodeExecutionContributionsV2,
} from "../extensions/code/sandbox/CodeExecutionContributionsV2";

/**
 * Runtime failure ATTRIBUTION at the sandbox preparation boundary.
 *
 * Why this file exists. The 2026-09-06 reliability evidence retained exactly
 * `{id, toolName, errorCode, bucket}` for each failed tool call. Two of the
 * three unexplained failures read
 * `code_validate_fast -> sandbox_prepare_rejected (bucket "other")`, which is
 * the same string this boundary produced for SIX structurally different
 * causes. Those historical failures are therefore not attributable from
 * surviving evidence and stay unresolved; this file makes the same signature
 * attributable in FUTURE runs and closes the raw-message leak reproduced
 * alongside it.
 *
 * Anti-vacuity discipline. Every assertion below is paired with a positive
 * proof that it can fail: the privacy checks assert the leakable marker was
 * genuinely present in the source error, and the attribution checks assert the
 * codes are DISTINCT rather than merely each-equal-to-a-constant, so a
 * regression that collapses them back onto one string is caught.
 */

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

/**
 * A single string carrying every content class the boundary must never
 * re-emit: an absolute host path, a vault note title, a command line and a
 * credential-shaped token. One marker keeps the assertions exact.
 */
const LEAK_MARKER =
  "C:/Users/joshb/OneDrive/vault/Quarterly Salary Review.md :: npm run deploy --token=sk-live-9f2a41c7";

test("sandbox preparation failures never re-emit foreign error text", async () => {
  const fixture = prepareInput();
  const manager = await verifiedManager();

  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => fixture.profile,
    async resolvePreparationInput() {
      // An untyped host-boundary failure. Real hosts surface exactly this
      // shape: fs/ENOENT, spawn failures and provider SDK errors all carry
      // arbitrary text the sandbox boundary has never sanitized.
      throw new Error(`ENOENT: no such file or directory, open '${LEAK_MARKER}'`);
    },
  });

  const validation = validationTool(contributions);
  const result = await validation.prepare!(
    { workspaceId: "workspace-1", repairRequestId: "request-1" },
    context(),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;

  // POSITIVE PROOF the check is not vacuous: the marker really was inside the
  // error this boundary caught, so an unsanitized boundary WOULD leak it.
  const source = new Error(`ENOENT: no such file or directory, open '${LEAK_MARKER}'`);
  assert.ok(
    source.message.includes(LEAK_MARKER),
    "fixture must actually carry the leakable marker",
  );

  const projected = `${result.error.code}\u0000${result.error.message}`;
  assert.equal(
    projected.includes(LEAK_MARKER),
    false,
    "raw host error text must not reach the prepared-action failure",
  );
  assert.equal(projected.includes("C:/Users"), false);
  assert.equal(projected.includes("sk-live"), false);
  assert.equal(projected.includes("npm run deploy"), false);
  assert.equal(projected.includes("Quarterly Salary Review"), false);
  assert.equal(projected.includes("ENOENT"), false);

  // The failure must still be USABLE: a bounded, allowlisted code survives.
  assert.ok(
    SANDBOX_PREPARATION_FAILURE_CODES_V2.includes(result.error.code as never),
    `unexpected preparation failure code ${result.error.code}`,
  );
  assert.ok(result.error.message.length > 0);
});

test("sandbox preparation failures never re-emit model argument names", async () => {
  const fixture = prepareInput();
  const manager = await verifiedManager();
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => fixture.profile,
    resolvePreparationInput: hostProof(fixture),
  });

  const validation = validationTool(contributions);
  const result = await validation.prepare!(
    {
      workspaceId: "workspace-1",
      repairRequestId: "request-1",
      // A model that hallucinates argument names puts model-authored text on
      // this path. Names are model output, not product vocabulary.
      "notes/Quarterly Salary Review.md": "leak",
      apiToken: "sk-live-9f2a41c7",
    },
    context(),
  );

  assert.equal(result.ok, false);
  if (result.ok) return;

  // POSITIVE PROOF: this really is the unknown-argument path, so a boundary
  // that echoed argument names WOULD leak them here.
  assert.equal(result.error.code, "invalid_arguments");

  const projected = `${result.error.code}\u0000${result.error.message}`;
  assert.equal(projected.includes("Quarterly Salary Review"), false);
  assert.equal(projected.includes("sk-live"), false);
  assert.equal(projected.includes("apiToken"), false);

  // Still diagnosable: the COUNT of rejected keys survives, the keys do not.
  assert.match(result.error.message, /\b2\b/u);
});

test("sandbox preparation attributes each lost cause to a distinct bounded stage", async () => {
  const fixture = prepareInput();
  const manager = await verifiedManager();

  // 1. Host preparation boundary threw an untyped error.
  const hostBoundary = await prepareOnce({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => fixture.profile,
    async resolvePreparationInput() {
      throw new Error("host staging boundary failed");
    },
  });

  // 2. Repository profile failed its own schema parse.
  const profileInvalid = await prepareOnce(
    {
      sandboxManager: manager,
      executionJournal: testExecutionJournal(),
      getProfile: async () => ({ ...fixture.profile, schemaVersion: 99 }) as never,
    },
    {
      profileKey: "sandbox-fixture",
      projectId: "root",
      commandId: "root-npm-test",
      workspaceId: "workspace-1",
      repairRequestId: "request-1",
      workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
      stagingManifest: fixture.stagingManifest,
    },
  );

  // 3. SandboxManagerV2 rejected the action itself (unknown catalog target).
  const managerRejected = await prepareOnce({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => fixture.profile,
    async resolvePreparationInput() {
      return { ...(await hostProof(fixture)()), commandId: "root-npm-not-a-command" };
    },
  });

  // 4. The durable journal already holds a terminal/ambiguous record for this
  //    exact prepared action, so re-preparing it is a replay, not a new call.
  const journal = testExecutionJournal();
  const replayTool = validationTool(
    createCodeExecutionContributionsV2({
      sandboxManager: manager,
      executionJournal: journal,
      getProfile: async () => fixture.profile,
      resolvePreparationInput: hostProof(fixture),
    }),
  );
  const first = await replayTool.prepare!(
    { workspaceId: "workspace-1", repairRequestId: "request-1" },
    context(),
  );
  assert.equal(first.ok, true, "the first prepare must succeed for a replay to exist");
  if (!first.ok) return;
  await journal.markDispatching({
    runId: "mission-1",
    action: (first.action.normalizedArgs as { sandboxAction: never }).sandboxAction,
  });
  const replayed = await replayTool.prepare!(
    { workspaceId: "workspace-1", repairRequestId: "request-1" },
    context(),
  );
  assert.equal(replayed.ok, false);
  if (replayed.ok) return;

  const codes = [
    hostBoundary.code,
    profileInvalid.code,
    managerRejected.code,
    replayed.error.code,
  ];

  // POSITIVE PROOF the attribution is real: before this repair all four of
  // these produced the SAME string, so a regression that collapses them is
  // caught here rather than silently restoring an unattributable failure.
  assert.equal(
    new Set(codes).size,
    codes.length,
    `preparation causes must stay distinguishable, got ${JSON.stringify(codes)}`,
  );

  for (const code of codes) {
    assert.ok(
      SANDBOX_PREPARATION_FAILURE_CODES_V2.includes(code as never),
      `${code} is outside the bounded preparation failure allowlist`,
    );
    const classified = classifySandboxPreparationFailureV2(code);
    assert.ok(
      SANDBOX_PREPARATION_FAILURE_STAGES_V2.includes(classified.stage as never),
      `${code} classified to unlisted stage ${classified.stage}`,
    );
  }

  assert.equal(classifySandboxPreparationFailureV2(hostBoundary.code).stage, "host_preparation");
  assert.equal(classifySandboxPreparationFailureV2(profileInvalid.code).stage, "profile");
  assert.equal(classifySandboxPreparationFailureV2(managerRejected.code).stage, "sandbox_prepare");
  assert.equal(classifySandboxPreparationFailureV2(replayed.error.code).stage, "journal");
});

test("an unrecognized preparation failure stays unknown rather than borrowing a stage", () => {
  // Missing causes stay unknown: a code this boundary never emits must not be
  // silently mapped onto a stage that would then read as an explanation.
  const unknown = classifySandboxPreparationFailureV2("totally_unrelated_code");
  assert.deepEqual(unknown, { stage: null, cause: null });

  // POSITIVE PROOF the classifier is not simply always-null.
  const known = classifySandboxPreparationFailureV2("sandbox_prepare_rejected");
  assert.notEqual(known.stage, null);
});

test("the bounded preparation vocabulary is closed and self-consistent", () => {
  assert.ok(SANDBOX_PREPARATION_FAILURE_CODES_V2.length > 0);
  assert.equal(
    new Set(SANDBOX_PREPARATION_FAILURE_CODES_V2).size,
    SANDBOX_PREPARATION_FAILURE_CODES_V2.length,
    "the failure code allowlist must not contain duplicates",
  );
  for (const code of SANDBOX_PREPARATION_FAILURE_CODES_V2) {
    const classified = classifySandboxPreparationFailureV2(code);
    assert.ok(
      SANDBOX_PREPARATION_FAILURE_STAGES_V2.includes(classified.stage as never),
      `allowlisted code ${code} must classify to a listed stage`,
    );
    // Codes and stages are identifiers, never sentences: this keeps the only
    // channel that reaches telemetry incapable of carrying content.
    assert.match(code, /^[a-z][a-z0-9_]*$/u);
  }
  for (const stage of SANDBOX_PREPARATION_FAILURE_STAGES_V2) {
    assert.match(stage, /^[a-z][a-z0-9_]*$/u);
  }
});

// ---------------------------------------------------------------------------

function validationTool(contributions: readonly unknown[]) {
  return (
    contributions
      .filter((entry) => (entry as { descriptor: { kind: string } }).descriptor.kind === "tool")
      .find(
        (entry) => (entry as { tool: { name: string } }).tool.name === "code_validate_fast",
      ) as { tool: { prepare?: (args: Record<string, unknown>, ctx: ScopedExtensionContextV1) => Promise<{ ok: true; action: { normalizedArgs: Record<string, unknown> } } | { ok: false; error: { code: string; message: string } }> } }
  ).tool;
}

async function prepareOnce(
  options: Parameters<typeof createCodeExecutionContributionsV2>[0],
  args: Record<string, unknown> = { workspaceId: "workspace-1", repairRequestId: "request-1" },
): Promise<{ code: string; message: string }> {
  const result = await validationTool(
    createCodeExecutionContributionsV2(options),
  ).prepare!(args, context());
  assert.equal(result.ok, false, `expected a preparation failure, got ${JSON.stringify(result)}`);
  if (result.ok) throw new Error("unreachable");
  return result.error;
}

function hostProof(fixture: ReturnType<typeof prepareInput>) {
  return async () => ({
    profile: fixture.profile,
    projectId: fixture.projectId,
    commandId: fixture.commandId,
    workspaceId: fixture.workspaceId,
    repairRequestId: "request-1",
    workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
    stagingManifest: fixture.stagingManifest,
  });
}

async function verifiedManager(): Promise<SandboxManagerV2> {
  const manager = new SandboxManagerV2({
    runner: {
      async run(spec) {
        if (spec.purpose === "boundary_probe") {
          return { exitCode: 0, stdout: PROBE, stderr: "" };
        }
        return { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    providers: [dockerProvider()],
    now: () => new Date("2026-07-12T12:00:00.000Z"),
  });
  await manager.probeProviders();
  return manager;
}

function prepareInput() {
  const source = new TextEncoder().encode("export const value = 1;\n");
  return {
    profile: detectRepositoryProfileV2({
      key: "sandbox-fixture",
      displayName: "Sandbox fixture",
      repositoryRoot: "/work/sandbox-fixture",
      defaultBranch: "main",
      files: ["package.json", "package-lock.json", ".nvmrc", "src/index.ts"],
      fileContents: { ".nvmrc": "24.16.0" },
    }),
    projectId: "root",
    commandId: "root-npm-test",
    workspaceId: "workspace-1",
    workspaceManifestFingerprint: `sha256:${"e".repeat(64)}`,
    stagingManifest: [
      {
        path: "src/index.ts",
        bytes: source.byteLength,
        sha256: `sha256:${createHash("sha256").update(source).digest("hex")}`,
      },
    ],
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

function testExecutionJournal(): DurableSandboxExecutionJournalV1 {
  let namespace: DurableSandboxExecutionNamespaceV1 | null = null;
  const persistence: DurableSandboxExecutionJournalPersistenceV1 = {
    async readNamespace() {
      return namespace === null ? null : structuredClone(namespace);
    },
    async writeNamespace(next, expectedRevision) {
      if ((namespace?.revision ?? 0) !== expectedRevision) return false;
      namespace = structuredClone(next);
      return true;
    },
  };
  let tick = 0;
  return new DurableSandboxExecutionJournalV1(
    persistence,
    () => new Date(Date.parse("2026-07-12T12:00:00.000Z") + tick++ * 1_000),
  );
}

function context(
  overrides: Partial<ScopedExtensionContextV1> = {},
): ScopedExtensionContextV1 {
  return {
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: "mission-1",
    operationId: "operation-1",
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-07-12T12:00:00.000Z"),
    reportProgress() {},
    ...overrides,
  };
}

test("a host-owned validation run drops the model's environment hints outside the allowlist instead of failing", async () => {
  // Reliability cohort 10 (2026-09-07, code-delivery#007): both validate
  // calls of an otherwise complete mission were rejected by the manager, the
  // validation node blocked after the second, and the cohort was lost. The
  // host binding was proven sound with the mission's own receipts, so the
  // rejection came from a model-authored hint.
  const fixture = prepareInput();
  const manager = await verifiedManager();
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => fixture.profile,
    resolvePreparationInput: hostProof(fixture),
  });
  const result = await validationTool(contributions).prepare!(
    {
      workspaceId: "workspace-1",
      repairRequestId: "request-1",
      environment: { PYTHONUNBUFFERED: "1", TZ: "UTC" },
    },
    context(),
  );
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  if (!result.ok) return;
  const sandboxAction = result.action.normalizedArgs.sandboxAction as { environment: Record<string, string> };
  assert.deepEqual(sandboxAction.environment, { TZ: "UTC" }, "the allowlisted hint survives, the other is dropped");

  // POSITIVE PROOF the hint really is refused where the host does not own
  // the run: the model-driven path sends the same key to the manager.
  const modelDriven = await prepareOnce(
    {
      sandboxManager: manager,
      executionJournal: testExecutionJournal(),
      getProfile: async () => fixture.profile,
    },
    {
      workspaceId: fixture.workspaceId,
      repairRequestId: "request-1",
      profileKey: fixture.profile.key,
      projectId: fixture.projectId,
      commandId: fixture.commandId,
      workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
      stagingManifest: fixture.stagingManifest,
      environment: { PYTHONUNBUFFERED: "1", TZ: "UTC" },
    },
  );
  assert.equal(modelDriven.code, "sandbox_prepare_rejected_by_manager");

  // The credential screen is the manager's and still applies to what survives.
  const credential = await validationTool(contributions).prepare!(
    { workspaceId: "workspace-1", repairRequestId: "request-1", environment: { TZ: "token=sk-live-1" } },
    context(),
  );
  assert.equal(credential.ok, false);
  if (credential.ok) return;
  assert.equal(credential.error.code, "sandbox_prepare_rejected_by_manager");
});

test("a host-owned validation run keeps only the model's artifacts the profile declares", async () => {
  const fixture = prepareInput();
  const profile = { ...fixture.profile, generatedOutputs: ["dist"] };
  const manager = await verifiedManager();
  const proof = hostProof(fixture);
  const contributions = createCodeExecutionContributionsV2({
    sandboxManager: manager,
    executionJournal: testExecutionJournal(),
    getProfile: async () => profile,
    resolvePreparationInput: async () => ({ ...(await proof()), profile }),
  });
  const artifacts = [
    { path: "main.py", expectedSha256: null, maxBytes: 4096, required: true },
    { path: "./dist/bundle.js", expectedSha256: null, maxBytes: 4096, required: false },
  ];
  const result = await validationTool(contributions).prepare!(
    { workspaceId: "workspace-1", repairRequestId: "request-1", expectedArtifacts: artifacts },
    context(),
  );
  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 300));
  if (!result.ok) return;
  const sandboxAction = result.action.normalizedArgs.sandboxAction as { expectedArtifacts: Array<{ path: string }> };
  assert.deepEqual(
    sandboxAction.expectedArtifacts.map((artifact) => artifact.path),
    ["dist/bundle.js"],
    "the declared artifact survives, the undeclared hint is dropped",
  );

  // POSITIVE PROOF: the same undeclared artifact is a rejection on the
  // model-driven path, so the drop is doing real work.
  const modelDriven = await prepareOnce(
    {
      sandboxManager: manager,
      executionJournal: testExecutionJournal(),
      getProfile: async () => profile,
    },
    {
      workspaceId: fixture.workspaceId,
      repairRequestId: "request-1",
      profileKey: fixture.profile.key,
      projectId: fixture.projectId,
      commandId: fixture.commandId,
      workspaceManifestFingerprint: fixture.workspaceManifestFingerprint,
      stagingManifest: fixture.stagingManifest,
      expectedArtifacts: artifacts,
    },
  );
  assert.equal(modelDriven.code, "sandbox_prepare_rejected_by_manager");
});
