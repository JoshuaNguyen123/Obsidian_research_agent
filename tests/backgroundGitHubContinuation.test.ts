import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  createPreparedBackgroundGitHubActionV1,
  fingerprintBackgroundGitHubValueV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionDraftV1,
  type PreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubOperationV1,
} from "../packages/core-api/src/preparedBackgroundGitHubActionV1";
import {
  createHostApprovalReceiptEvidenceV1,
  sealHostApprovalReceiptV1,
  type HostApprovalReceiptV1,
} from "../packages/core-api/src/hostApprovalReceiptV1";
import {
  parsePreparedBackgroundGitHubPackageIdentityV1,
} from "../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import type { CompanionJobV1 } from "../packages/headless-runtime/src/backgroundContinuation";
import { remoteJobToCompanionJob } from "../packages/headless-runtime/src/companionWorkerCoordinator";
import { createVerifiedCodePublicationHandoffV1 } from "../packages/core-api/src/verifiedCodePublicationHandoffV1";
import { detectRepositoryProfileV2 } from "../extensions/code/repositories/RepositoryProfileV2";
import {
  BackgroundGitHubContinuationRuntimeV1,
  type BackgroundGitHubAutoMergePortV1,
  type BackgroundGitHubHostApprovalReceiptVerifierV1,
  type BackgroundGitHubWorkflowFactoryV1,
} from "../extensions/integrations/background/BackgroundGitHubContinuationV1";
import {
  FileBackgroundGitHubActionAttemptStoreV1,
  type BackgroundGitHubActionAttemptStoreV1,
  type BackgroundGitHubActionAttemptV1,
} from "../extensions/integrations/background/BackgroundGitHubAttemptStoreV1";
import {
  PreparedBackgroundGitHubPackageStoreV1,
  createBackgroundGitHubRepositoryProofV1,
  createPreparedBackgroundGitHubPackageIdentityFromPackageV1,
  createPreparedBackgroundGitHubPackageV1,
  type BackgroundGitHubPullRequestDocumentV1,
  type PreparedBackgroundGitHubPackageV1,
} from "../extensions/integrations/background/PreparedBackgroundGitHubPackageStoreV1";
import { createPreparedBackgroundGitHubStandaloneExecutorV1 } from "../extensions/integrations/background/PreparedBackgroundGitHubStandaloneExecutorV1";
import {
  prepareBackgroundGitHubProviderDependencyFactoryV1,
} from "../extensions/integrations/background/BackgroundGitHubProviderFactoryV1";
import { createFixedGitHubNodeTransportV1 } from "../extensions/integrations/background/FixedGitHubNodeTransportV1";
import type { SecretStoreV1 } from "../packages/core-api/src/secretStoreV1";
import type { HttpTransport } from "../src/model/types";
import {
  createProofSnapshot,
  type GitHubPublicationApprovalPortV1,
  type GitHubPublicationCheckpointV1,
  type GitHubPublicationWorkflowV1,
} from "../src/integrations/github/GitHubPublicationWorkflow";
import { parseGitHubPublicationCheckpointV1 } from "../src/integrations/github/GitHubPublicationCheckpointStore";
import {
  createTrustedGitHubRepositoryBindingV1,
} from "../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  VerifiedGitPushGatewayV1,
  type EphemeralGitAskpassBrokerV1,
  type GitPushAttemptRecordV1,
  type GitPushAttemptStoreV1,
  type VerifiedGitCommandRunnerV1,
} from "../src/integrations/github/VerifiedGitPushGateway";

const BASE = "a".repeat(40);
const COMMIT = "b".repeat(40);
const TREE = "c".repeat(40);
const MERGE = "d".repeat(40);
const ROOT = "C:\\agent-worktrees\\background-github-1";
const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2026-07-13T13:00:00.000Z";

test("remote GitHub action is closed and path/body/command/token free while local package is restart-self-sufficient", async (t) => {
  const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  const remote = JSON.stringify(fixture.action);
  assert.doesNotMatch(remote, /agent-worktrees|Implement ENG-12|Linear: ENG-12|command|reviewText|github_pat_|ghp_/iu);
  assert.match(remote, /secret_github-credential-1/u, "only the opaque SecretStoreV1 reference crosses the remote boundary");

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "companion-app-data");
  const store = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    randomId: () => "write-1",
  });
  const persisted = await store.persist(fixture.package);
  assert.equal(persisted.receipt.readbackVerified, true);

  const serialized = await fs.readFile(
    path.join(store.packageRoot, `${fixture.package.id}.json`),
    "utf8",
  );
  assert.match(serialized, /canonicalRepositoryRoot/u);
  assert.match(serialized, /Implement ENG-12/u);
  assert.doesNotMatch(serialized, /github_pat_|ghp_|"command"|"reviewText"/iu);

  // A new process needs only companion app-data requirements; no Obsidian or plugin-data callback exists.
  const restarted = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  });
  const loaded = await restarted.load(requirements(fixture.package));
  assert.equal(loaded.localPlan.verifiedCodeHandoff, null);
  assert.equal(loaded.localPlan.pullRequestDocument?.title, "Implement ENG-12");
  assert.equal(loaded.localPlan.repositoryBinding.canonicalRepositoryRoot, fixture.binding.canonicalRepositoryRoot);
  assert.equal(loaded.localPlan.checkpointFingerprint, fixture.action.payload.checkpointFingerprint);
});

test("shared companion transport reloads the remote-safe identity and blocks before WAL/provider without a host signer", async (t) => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1);
  const identity = createPreparedBackgroundGitHubPackageIdentityFromPackageV1(
    fixture.package,
  );
  const remoteIdentity = JSON.stringify(identity);
  assert.doesNotMatch(
    remoteIdentity,
    /agent-worktrees|canonicalRepositoryRoot|command|body|reviewText|github_pat_|ghp_/iu,
  );
  assert.throws(
    () => parsePreparedBackgroundGitHubPackageIdentityV1({
      ...identity,
      applicationDataRoot: ROOT,
    }),
    /closed contract/iu,
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-transport-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  }).persist(fixture.package);
  const job: CompanionJobV1 = {
    version: 1,
    id: fixture.package.jobId,
    missionId: fixture.action.missionId,
    nodeId: fixture.action.nodeId,
    graphRevision: fixture.action.graphRevision,
    executionHost: fixture.action.executionHost,
    domain: "github",
    state: "queued",
    objective: "Publish the exact verified branch.",
    inputs: {},
    allowedTools: [fixture.action.toolName],
    requiredCapabilities: ["github:write"],
    bindings: [{
      id: fixture.action.binding.id,
      kind: "github-repository",
      destinationFingerprint: fixture.action.binding.destinationFingerprint,
    }],
    capabilityEnvelopeFingerprint: fixture.action.capabilityEnvelopeFingerprint,
    authorization: {
      version: 1,
      grantId: "background-github-grant-1",
      fingerprint: fixture.package.backgroundAuthorizationFingerprint,
      authorizedAt: NOW,
      expiresAt: EXPIRES,
    },
    preparedExternalActionHandoff: null,
    preparedBackgroundCodeAction: null,
    preparedBackgroundCodePackage: null,
    preparedBackgroundGitHubAction: fixture.action,
    preparedBackgroundGitHubPackage: identity,
    idempotencyKey: fp("9"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
  const roundTripped = remoteJobToCompanionJob({
    id: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    executionHost: job.domain,
    state: "queued",
    payload: {
      version: 1,
      graphRevision: job.graphRevision,
      executionHost: job.executionHost,
      objective: job.objective,
      inputs: job.inputs,
      allowedTools: job.allowedTools,
      requiredCapabilities: job.requiredCapabilities,
      bindings: job.bindings as never,
      authorization: job.authorization as never,
      preparedExternalActionHandoff: null,
      preparedBackgroundCodeAction: null,
      preparedBackgroundCodePackage: null,
      preparedBackgroundGitHubAction: fixture.action as never,
      preparedBackgroundGitHubPackage: identity as never,
      createdAt: NOW,
      updatedAt: NOW,
    },
    capabilityEnvelope: {
      fingerprint: job.capabilityEnvelopeFingerprint,
      authorizationFingerprint: job.authorization.fingerprint,
    },
    output: {},
    idempotencyKey: job.idempotencyKey,
    ownerCoordinatorId: null,
    leaseExpiresAt: null,
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  });
  assert.equal(
    roundTripped.preparedBackgroundGitHubPackage?.fingerprint,
    identity.fingerprint,
  );

  let providerFactories = 0;
  const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    createRuntimeDependencies() {
      providerFactories += 1;
      throw new Error("provider factory must not run without the trusted signer");
    },
  })(job, {
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress: async () => undefined,
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.blocker?.code, "background_github_host_signer_unavailable");
  assert.equal(providerFactories, 0);

  let signerReadbacks = 0;
  let verifierCalls = 0;
  const signerUnavailable = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => {
      signerReadbacks += 1;
      return false;
    },
    hostApprovalReceiptVerifier: {
      async verify() {
        verifierCalls += 1;
        return true;
      },
    },
    createRuntimeDependencies() {
      providerFactories += 1;
      throw new Error("provider factory must not run without the provisioned signer");
    },
  })(job, {
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress: async () => undefined,
  });
  assert.equal(signerUnavailable.status, "blocked");
  assert.equal(
    signerUnavailable.blocker?.code,
    "background_github_host_signer_unavailable",
  );
  assert.equal(signerReadbacks, 1);
  assert.equal(verifierCalls, 0);
  assert.equal(providerFactories, 0);

  const providerUnavailable = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: {
      async verify() {
        verifierCalls += 1;
        return true;
      },
    },
  })(job, {
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress: async () => undefined,
  });
  assert.equal(providerUnavailable.status, "blocked");
  assert.equal(
    providerUnavailable.blocker?.code,
    "background_github_provider_runtime_unavailable",
  );
  assert.equal(verifierCalls, 0);
  await assert.rejects(
    fs.stat(path.join(applicationDataRoot, "background-github-attempts-v1")),
    /ENOENT/u,
    "the signer/provider blockers must stop before provider WAL creation",
  );
});

test("production standalone provider leases only the action credential and projects a closed verified draft proof", async (t) => {
  const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  }).persist(fixture.package);

  const secret = "github_pat_ACTION_SCOPED_TEST_SECRET_123456789";
  const leasedReferences: string[] = [];
  const secretStore = persistentSecretStore(secret, leasedReferences);
  let created = false;
  const requests: Array<{ method: string; path: string }> = [];
  const transport = draftProviderTransport({
    secret,
    requests,
    isCreated: () => created,
    onCreate: () => { created = true; },
  });
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore,
    transport,
    gitCommandRunner: unusedRunner(),
    askpassBroker: unusedAskpass(),
    now: () => new Date(NOW),
  });
  const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  })(jobForFixture(fixture), workerContext());

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal(created, true);
  assert.ok(leasedReferences.length >= 4);
  assert.deepEqual(new Set(leasedReferences), new Set([fixture.action.binding.credentialReferenceId]));
  const proof = result.outputs?.githubVerifiedResult as Record<string, unknown>;
  assert.equal(proof.kind, "verified_background_github_action");
  assert.equal(proof.pullRequestNumber, 12);
  assert.equal(proof.fingerprint, result.outputs?.resultFingerprint);
  assert.deepEqual(result.receipts?.[0]?.payload.verifiedResult, proof);
  assert.equal(requests.filter((request) => request.method === "POST" && request.path === "/repos/acme/research-agent/pulls").length, 1);
  const logicalProviderCalls = requests.filter((request) =>
    !["/user", "/repos/acme/research-agent"].includes(request.path)).length;
  // One extra lease/pin pair is the outer pre-WAL account verification. The
  // proof-refresh reads may run concurrently, so their request order can interleave.
  assert.equal(requests.filter((request) => request.path === "/user").length, logicalProviderCalls + 1);
  assert.equal(requests.filter((request) => request.path === "/repos/acme/research-agent").length, logicalProviderCalls + 1);
  assert.equal(leasedReferences.length, logicalProviderCalls + 1);
  const persisted = await readAllFiles(applicationDataRoot);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secret, "u"));
  assert.doesNotMatch(persisted, new RegExp(secret, "u"));
});

test("ambiguous draft dispatch is recovered by readback without replay", async (t) => {
  const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-ambiguous-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({ applicationDataRoot, now: () => new Date(NOW) })
    .persist(fixture.package);
  const secret = "github_pat_AMBIGUOUS_TEST_SECRET_123456789";
  let created = false;
  let createCalls = 0;
  const requests: Array<{ method: string; path: string }> = [];
  const transport = draftProviderTransport({
    secret,
    requests,
    isCreated: () => created,
    onCreate: () => {
      created = true;
      createCalls += 1;
      throw new Error("connection closed after provider commit");
    },
  });
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore: persistentSecretStore(secret, []),
    transport,
    gitCommandRunner: unusedRunner(),
    askpassBroker: unusedAskpass(),
    now: () => new Date(NOW),
  });
  const executor = createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  });
  const job = jobForFixture(fixture);
  assert.equal((await executor(job, workerContext())).status, "reconcile_required");
  const recovered = await executor(job, workerContext());
  assert.equal(recovered.status, "complete", JSON.stringify(recovered));
  assert.equal(createCalls, 1, "readback-only recovery must never replay the POST");
  assert.equal(
    requests.filter((request) => request.method === "POST" && request.path === "/repos/acme/research-agent/pulls").length,
    1,
  );
});

test("production merge consumes the signed background approval without rebuilding a timestamped action", async (t) => {
  const fixture = fixtureFor(GITHUB_PULL_REQUEST_MERGE_OPERATION_V1, {
    canonicalProof: true,
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-merge-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  }).persist(fixture.package);
  const secret = "github_pat_PRODUCTION_MERGE_SECRET_123456789";
  const state = workflowProviderState();
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore: persistentSecretStore(secret, []),
    transport: workflowProviderTransport(secret, state),
    gitCommandRunner: unusedRunner(),
    askpassBroker: unusedAskpass(),
    now: () => new Date("2026-07-13T12:30:00.000Z"),
  });

  const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date("2026-07-13T12:30:00.000Z"),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  })(jobForFixture(fixture), workerContext("2026-07-13T12:30:00.000Z"));

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal((result.outputs?.githubVerifiedResult as { mergeSha?: string }).mergeSha, MERGE);
  assert.equal(state.mergeCalls, 1);
  assert.equal(state.requests.filter((request) => request.method === "PUT").length, 1);
});

test("production review repair consumes its signed approval and verifies one local fast-forward", async (t) => {
  const fixture = fixtureFor(GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-repair-provider-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  }).persist(fixture.package);
  const secret = "github_pat_PRODUCTION_REPAIR_SECRET_123456789";
  const state = workflowProviderState({ headSha: BASE });
  const runner = new FakeGitRunner({
    remoteSha: BASE,
    beforePush: () => { state.headSha = COMMIT; },
  });
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore: persistentSecretStore(secret, []),
    transport: workflowProviderTransport(secret, state),
    gitCommandRunner: runner,
    askpassBroker: new FakeAskpassBroker(),
    now: () => new Date("2026-07-13T12:30:00.000Z"),
  });

  const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date("2026-07-13T12:30:00.000Z"),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  })(jobForFixture(fixture), workerContext("2026-07-13T12:30:00.000Z"));

  assert.equal(result.status, "complete", JSON.stringify(result));
  assert.equal((result.outputs?.githubVerifiedResult as { headSha?: string }).headSha, COMMIT);
  assert.equal(runner.pushes, 1);
  assert.equal(state.headSha, COMMIT);
});

test("fresh auto-merge proof drift blocks before the GraphQL mutation", async (t) => {
  const fixture = fixtureFor(GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1, {
    canonicalProof: true,
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-auto-drift-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({ applicationDataRoot, now: () => new Date(NOW) })
    .persist(fixture.package);
  const secret = "github_pat_AUTO_DRIFT_SECRET_123456789";
  const state = workflowProviderState({ proofDrift: true });
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore: persistentSecretStore(secret, []),
    transport: workflowProviderTransport(secret, state),
    gitCommandRunner: unusedRunner(),
    askpassBroker: unusedAskpass(),
    now: () => new Date(NOW),
  });
  const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  })(jobForFixture(fixture), workerContext());

  assert.equal(result.status, "blocked", JSON.stringify(result));
  assert.equal(result.blocker?.code, "background_github_not_applied");
  assert.equal(state.autoMergeMutationCalls, 0);
});

test("ambiguous auto-merge converges by readback after later proof drift without replaying POST", async (t) => {
  const fixture = fixtureFor(GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1, {
    canonicalProof: true,
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-auto-reconcile-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "integrations");
  await new PreparedBackgroundGitHubPackageStoreV1({ applicationDataRoot, now: () => new Date(NOW) })
    .persist(fixture.package);
  const secret = "github_pat_AUTO_RECONCILE_SECRET_123456789";
  const state = workflowProviderState({ failAutoMergeAfterCommit: true });
  const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
    applicationDataRoot,
    secretStore: persistentSecretStore(secret, []),
    transport: workflowProviderTransport(secret, state),
    gitCommandRunner: unusedRunner(),
    askpassBroker: unusedAskpass(),
    now: () => new Date(NOW),
  });
  const executor = createPreparedBackgroundGitHubStandaloneExecutorV1({
    applicationDataRoot,
    now: () => new Date(NOW),
    hostApprovalSignerAvailable: async () => true,
    hostApprovalReceiptVerifier: approvalVerifier(),
    createRuntimeDependencies: factory,
  });
  const job = jobForFixture(fixture);
  assert.equal((await executor(job, workerContext())).status, "reconcile_required");
  state.proofDrift = true;
  const recovered = await executor(job, workerContext());

  assert.equal(recovered.status, "complete", JSON.stringify(recovered));
  assert.equal(state.autoMergeMutationCalls, 1);
  assert.ok(state.autoMergeReadCalls >= 1);
  assert.equal(state.autoMergeEnabled, true);
});

test("provider account or repository drift blocks before the outer mutation WAL", async (t) => {
  for (const scenario of ["account", "repository"] as const) {
    await t.test(scenario, async (subtest) => {
      const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `background-github-${scenario}-drift-`));
      subtest.after(() => fs.rm(root, { recursive: true, force: true }));
      const applicationDataRoot = path.join(root, "integrations");
      await new PreparedBackgroundGitHubPackageStoreV1({ applicationDataRoot, now: () => new Date(NOW) })
        .persist(fixture.package);
      const secret = `github_pat_${scenario.toUpperCase()}_DRIFT_SECRET_123456789`;
      const requests: Array<{ method: string; path: string }> = [];
      const transport = draftProviderTransport({
        secret,
        requests,
        isCreated: () => false,
        onCreate: () => { throw new Error("mutation must not run after identity drift"); },
        ...(scenario === "account" ? { userId: 999 } : { repositoryId: 999 }),
      });
      const factory = await prepareBackgroundGitHubProviderDependencyFactoryV1({
        applicationDataRoot,
        secretStore: persistentSecretStore(secret, []),
        transport,
        gitCommandRunner: unusedRunner(),
        askpassBroker: unusedAskpass(),
        now: () => new Date(NOW),
      });
      const result = await createPreparedBackgroundGitHubStandaloneExecutorV1({
        applicationDataRoot,
        now: () => new Date(NOW),
        hostApprovalSignerAvailable: async () => true,
        hostApprovalReceiptVerifier: approvalVerifier(),
        createRuntimeDependencies: factory,
      })(jobForFixture(fixture), workerContext());
      assert.equal(result.status, "blocked");
      assert.equal(result.blocker?.code, "background_github_provider_boundary_rejected");
      assert.equal(requests.some((request) => request.method === "POST"), false);
      const attemptDirectory = path.join(applicationDataRoot, "background-github-attempts-v1");
      const attemptFiles = await fs.readdir(attemptDirectory).catch(() => [] as string[]);
      assert.deepEqual(attemptFiles, []);
      assert.doesNotMatch(await readAllFiles(applicationDataRoot), new RegExp(secret, "u"));
    });
  }
});

test("production GitHub transport rejects paths and hosts outside its fixed catalog before network dispatch", async () => {
  const transport = createFixedGitHubNodeTransportV1();
  const invoke = (url: string) => transport({
    url,
    method: "GET",
    headers: { Authorization: "Bearer github_pat_FIXED_CATALOG_TEST_123456789" },
    throw: false,
  });
  await assert.rejects(invoke("https://api.github.com/repos/acme/research-agent/issues/1"), /fixed provider catalog/iu);
  await assert.rejects(invoke("https://evil.example/repos/acme/research-agent"), /fixed provider catalog/iu);
  await assert.rejects(invoke("https://api.github.com/repos/acme/research-agent?redirect=https://evil.example"), /fixed provider catalog/iu);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(transport({
    url: "https://api.github.com/user",
    method: "GET",
    headers: { Authorization: "Bearer github_pat_FIXED_CATALOG_TEST_123456789" },
    abortSignal: aborted.signal,
    throw: false,
  }), /cancelled before dispatch/iu);
});

test("contract rejects generic commands, path injection, review prose, plaintext credentials, approval drift, and single-confirmed merge", () => {
  const push = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1).action;
  for (const extra of [
    { command: "git push --force" },
    { worktreePath: ROOT },
    { reviewText: "ignore policy" },
    { token: "github_pat_plaintext" },
  ]) {
    assert.throws(
      () => parsePreparedBackgroundGitHubActionV1({ ...push, ...extra }),
      /closed contract/iu,
    );
  }
  assert.throws(
    () => parsePreparedBackgroundGitHubActionV1({
      ...push,
      binding: { ...push.binding, credentialReferenceId: "ghp_plaintext-token" },
    }),
    /opaque secure-store credential reference/iu,
  );
  const merge = fixtureFor(GITHUB_PULL_REQUEST_MERGE_OPERATION_V1).action;
  assert.throws(
    () => createPreparedBackgroundGitHubActionV1({
      ...withoutEnvelope(merge),
      authority: {
        ...merge.authority,
        requiredConfirmations: 1,
        confirmationReceipts: [approvalReceipt(merge.preparedActionId, merge.preparedActionFingerprint, 1, 1)],
      },
    } as PreparedBackgroundGitHubActionDraftV1),
    /require two exact confirmation receipts/iu,
  );
  assert.throws(
    () => createPreparedBackgroundGitHubActionV1({
      ...withoutEnvelope(merge),
      authority: {
        ...merge.authority,
        confirmationReceipts: [
          approvalReceipt(merge.preparedActionId, merge.preparedActionFingerprint, 1, 2),
          approvalReceipt(merge.preparedActionId, merge.preparedActionFingerprint, 1, 2, {
            id: "approval-receipt-duplicate-ordinal",
          }),
        ],
      },
    } as PreparedBackgroundGitHubActionDraftV1),
    /distinct receipts/iu,
  );
  for (const operation of [
    GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
    GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
    GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
    GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  ] as const) {
    const effectfulAction = fixtureFor(operation).action;
    const unrelatedOuterApproval = fp("e");
    assert.throws(
      () => createPreparedBackgroundGitHubActionV1({
        ...withoutEnvelope(effectfulAction),
        preparedActionFingerprint: unrelatedOuterApproval,
        authority: {
          ...effectfulAction.authority,
          actionFingerprint: unrelatedOuterApproval,
        },
      } as PreparedBackgroundGitHubActionDraftV1),
      /unbound|exact (?:publish|workflow) approval fingerprint/iu,
      `${operation} must reject an outer grant unrelated to the inner effect approval`,
    );
  }
});

test("cross-job replay is rejected before approval verification, WAL lookup, or provider dispatch", async () => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1);
  const attempts = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: null });
  let approvalVerifications = 0;
  const runtime = runtimeFor(fixture.package, attempts, git.gateway, {
    approvalReceipts: {
      async verify() {
        approvalVerifications += 1;
        return true;
      },
    },
  });

  await assert.rejects(
    runtime.execute({ jobId: "github-job-cross-tenant-replay", package: fixture.package }),
    /different companion job/iu,
  );
  assert.equal(approvalVerifications, 0);
  assert.equal(attempts.loads, 0);
  assert.equal(attempts.savedRecords.length, 0);
  assert.equal(git.runner.pushes, 0);
});

test("forged host approval receipt is rejected before WAL lookup or provider dispatch", async () => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1);
  const forgedReceipt = approvalReceipt(
    fixture.action.preparedActionId,
    fixture.action.preparedActionFingerprint,
    1,
    1,
    { authenticator: "A".repeat(43) },
  );
  const forgedAction = createPreparedBackgroundGitHubActionV1({
    ...withoutEnvelope(fixture.action),
    authority: {
      ...fixture.action.authority,
      confirmationReceipts: [forgedReceipt],
    },
  } as PreparedBackgroundGitHubActionDraftV1);
  const forgedPackage = createPreparedBackgroundGitHubPackageV1({
    jobId: fixture.package.jobId,
    backgroundAuthorizationFingerprint: fixture.package.backgroundAuthorizationFingerprint,
    action: forgedAction,
    repositoryBinding: fixture.binding,
    repositoryProof: fixture.proof,
    checkpoint: fixture.checkpoint,
    verifiedCodeHandoff: fixture.handoff,
  });
  const attempts = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: null });
  const runtime = runtimeFor(forgedPackage, attempts, git.gateway);

  await assert.rejects(
    runtime.execute({ jobId: forgedPackage.jobId, package: forgedPackage }),
    /receipt authentication failed/iu,
  );
  assert.equal(attempts.loads, 0);
  assert.equal(attempts.savedRecords.length, 0);
  assert.equal(git.runner.pushes, 0);
});

test("denied, unbound, duplicate-ordinal, and unstable-identity approval receipts fail closed", () => {
  const action = fixtureFor(GITHUB_PULL_REQUEST_MERGE_OPERATION_V1).action;
  const rebuild = (confirmationReceipts: HostApprovalReceiptV1[]) =>
    createPreparedBackgroundGitHubActionV1({
      ...withoutEnvelope(action),
      authority: { ...action.authority, confirmationReceipts },
    } as PreparedBackgroundGitHubActionDraftV1);

  assert.throws(
    () => rebuild([
      approvalReceipt(action.preparedActionId, action.preparedActionFingerprint, 1, 2, {
        decision: "denied",
      }),
      action.authority.confirmationReceipts[1],
    ]),
    /denied/iu,
  );
  assert.throws(
    () => rebuild([
      approvalReceipt(action.preparedActionId, fp("e"), 1, 2),
      action.authority.confirmationReceipts[1],
    ]),
    /unbound/iu,
  );
  assert.throws(
    () => rebuild([
      approvalReceipt(action.preparedActionId, action.preparedActionFingerprint, 1, 2),
      approvalReceipt(action.preparedActionId, action.preparedActionFingerprint, 1, 2, {
        id: "approval-receipt-ordinal-replay",
      }),
    ]),
    /distinct.*ordinal/iu,
  );
  assert.throws(
    () => rebuild([
      action.authority.confirmationReceipts[0],
      approvalReceipt(action.preparedActionId, action.preparedActionFingerprint, 2, 2, {
        actorFingerprint: fp("6"),
      }),
    ]),
    /stable host, actor, and session/iu,
  );
});

test("companion app-data boundary rejects parent-link escape, hard links, and tampered local plans", async (t) => {
  const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-boundary-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const linkedRoot = path.join(root, "linked-app-data");
  const outside = path.join(root, "outside");
  await fs.mkdir(linkedRoot, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const linkedStore = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot: linkedRoot,
    now: () => new Date(NOW),
  });
  await fs.symlink(
    outside,
    linkedStore.packageRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
  await assert.rejects(
    linkedStore.persist(fixture.package),
    /link|reparse/iu,
  );

  const tamperRoot = path.join(root, "tamper-app-data");
  const store = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot: tamperRoot,
    now: () => new Date(NOW),
  });
  await store.persist(fixture.package);
  const packagePath = path.join(store.packageRoot, `${fixture.package.id}.json`);
  const stats = await fs.stat(packagePath);
  if (process.platform !== "win32") assert.equal(stats.mode & 0o777, 0o600);

  const serialized = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  const localPlan = serialized.localPlan as Record<string, unknown>;
  const document = localPlan.pullRequestDocument as Record<string, unknown>;
  document.body = "tampered provider body";
  await fs.writeFile(packagePath, `${JSON.stringify(serialized)}\n`, { mode: 0o600 });
  await assert.rejects(store.load(requirements(fixture.package)), /fingerprint|fixed local text/iu);

  await fs.rm(packagePath, { force: true });
  const outsideFile = path.join(outside, "hard-link-source.json");
  await fs.writeFile(outsideFile, `${JSON.stringify(fixture.package)}\n`, { mode: 0o600 });
  await fs.link(outsideFile, packagePath);
  await assert.rejects(store.load(requirements(fixture.package)), /hard-linked|hard link/iu);
});

test("production push writes provider WAL before one verified fast-forward and never uses force", async (t) => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1, { expectedRemoteSha: BASE });
  const outer = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: BASE, beforePush: () => {
    assert.equal(outer.latest?.status, "dispatching", "provider WAL must precede Git mutation");
  }});
  const runtime = runtimeFor(fixture.package, outer, git.gateway, {
    remoteHead: () => BASE,
  });
  const result = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(result.status, "verified");
  assert.equal(git.runner.pushes, 1);
  assert.equal(git.runner.fetches, 1);
  assert.equal(git.runner.mergeBaseChecks, 1);
  const push = git.runner.calls.find((call) => gitOperation(call.args) === "push");
  assert.ok(push);
  assert.equal(push!.args.some((argument) => /force/iu.test(argument)), false);
  assert.deepEqual(push!.args.slice(-5), [
    "push", "--porcelain", "--no-verify",
    "https://github.com/acme/research-agent.git",
    `${COMMIT}:refs/heads/codex/repair-1`,
  ]);
  assert.equal(JSON.stringify(git.runner.calls).includes("github-secret-plaintext"), false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-wal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const fileStore = new FileBackgroundGitHubActionAttemptStoreV1(path.join(root, "companion-app-data"));
  const saved = outer.savedRecords[0]!;
  assert.equal(await fileStore.save(saved, null), true);
  const replacement: BackgroundGitHubActionAttemptV1 = {
    ...saved,
    revision: saved.revision + 1,
    status: "reconcile_required",
    updatedAt: new Date(Date.parse(saved.updatedAt) + 1_000).toISOString(),
    diagnostic: "fresh provider readback required",
  };
  assert.equal(await fileStore.save(replacement, saved.revision), true);
  assert.deepEqual(
    await new FileBackgroundGitHubActionAttemptStoreV1(path.join(root, "companion-app-data")).load(saved.id),
    replacement,
  );
});

test("ambiguous push resumes by readback only and never dispatches a second push", async () => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1, { expectedRemoteSha: null });
  const outer = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: null, pushMode: "applied_throw" });
  const runtime = runtimeFor(fixture.package, outer, git.gateway, { remoteHead: () => null });

  const first = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(first.status, "reconcile_required");
  assert.equal(git.runner.pushes, 1);
  const second = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(second.status, "verified");
  assert.equal(git.runner.pushes, 1, "durable dispatch marker must force readback-only recovery");
  assert.deepEqual(outer.savedStatuses, ["dispatching", "reconcile_required", "verified"]);
});

test("expired package loads only from an exact durable prior marker and recovery never redispatches", async (t) => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1);
  const attempts = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: null, pushMode: "applied_throw" });
  const firstRuntime = runtimeFor(fixture.package, attempts, git.gateway);
  const first = await firstRuntime.execute({
    jobId: fixture.package.jobId,
    package: fixture.package,
  });
  assert.equal(first.status, "reconcile_required");
  assert.equal(git.runner.pushes, 1);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-expired-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const applicationDataRoot = path.join(root, "companion-app-data");
  const currentStore = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date(NOW),
  });
  await currentStore.persist(fixture.package);
  const expiredStore = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot,
    now: () => new Date("2026-07-13T14:00:00.000Z"),
  });

  await assert.rejects(
    expiredStore.load(requirements(fixture.package)),
    /only for exact readback reconciliation/iu,
  );
  const loaded = await expiredStore.load(requirements(fixture.package), {
    reconciliationAttempts: attempts,
  });
  assert.equal(loaded.fingerprint, fixture.package.fingerprint);

  await assert.rejects(
    expiredStore.load(requirements(fixture.package), {
      reconciliationAttempts: {
        async load() {
          return { ...attempts.latest!, jobId: "github-job-wrong-scope" };
        },
      },
    }),
    /does not match its exact reconciliation scope/iu,
  );

  const restarted = runtimeFor(loaded, attempts, git.gateway, {
    now: () => new Date("2026-07-13T14:00:00.000Z"),
  });
  const recovered = await restarted.execute({ jobId: loaded.jobId, package: loaded });
  assert.equal(recovered.status, "verified");
  assert.equal(git.runner.pushes, 1, "expired reconciliation must remain readback-only");
});

test("expired package without prior WAL marker cannot perform a first dispatch", async () => {
  const fixture = fixtureFor(GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1);
  const attempts = new InstrumentedAttemptStore();
  const git = createGitGateway({ remoteSha: null });
  const runtime = runtimeFor(fixture.package, attempts, git.gateway, {
    now: () => new Date("2026-07-13T14:00:00.000Z"),
  });

  const result = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(result.status, "blocked");
  assert.equal(attempts.savedRecords.length, 0);
  assert.equal(git.runner.pushes, 0);
});

test("draft PR mutation starts after WAL and completes only from exact head/base readback", async () => {
  const fixture = fixtureFor(GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1);
  const outer = new InstrumentedAttemptStore();
  let creates = 0;
  const workflows: BackgroundGitHubWorkflowFactoryV1 = {
    async create({ package: preparedPackage }) {
      return {
        checkpoint: preparedPackage.localPlan.checkpoint,
        finalizers: "disabled_until_core_reconnect",
        workflow: {
          async resumeDraftPublication(checkpoint: GitHubPublicationCheckpointV1) {
            assert.equal(outer.latest?.status, "dispatching");
            creates += 1;
            return {
              ...checkpoint,
              status: "draft_pr_verified",
              updatedAt: "2026-07-13T12:01:00.000Z",
              pullRequest: pullRequest({ draft: true }),
              pendingAction: null,
              blocker: null,
              receiptIds: [...checkpoint.receiptIds, "receipt-draft-pr"],
            };
          },
        } as unknown as GitHubPublicationWorkflowV1,
      };
    },
  };
  const runtime = runtimeFor(fixture.package, outer, unusedGateway(), { workflows });
  const result = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.proof.pullRequestNumber, 12);
    assert.equal(result.proof.headSha, COMMIT);
  }
  assert.equal(creates, 1);
});

test("owned review-repair update consumes one exact approval and verifies only the descendant PR head", async () => {
  const fixture = fixtureFor(GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1);
  const outer = new InstrumentedAttemptStore();
  let approvalConfirmations = 0;
  const workflows: BackgroundGitHubWorkflowFactoryV1 = {
    async create({ package: preparedPackage, approvals }) {
      return {
        checkpoint: preparedPackage.localPlan.checkpoint,
        finalizers: "disabled_until_core_reconnect",
        workflow: {
          async publishVerifiedReviewRepairFastForward() {
            const action = preparedPackage.action;
            assert.equal(action.operation, GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1);
            const decision = await requestExactApproval(
              approvals,
              "repair_fast_forward",
              action.payload.workflowApprovalFingerprint,
              1,
            );
            approvalConfirmations = decision.confirmations ?? 0;
            assert.equal(outer.latest?.status, "dispatching");
            return {
              status: "verified" as const,
              remoteSha: COMMIT,
              receiptIds: ["receipt-review-push"],
              checkpoint: {
                ...preparedPackage.localPlan.checkpoint,
                status: "draft_pr_verified" as const,
                updatedAt: "2026-07-13T12:02:00.000Z",
                handoffFingerprint: action.payload.handoffFingerprint,
                headSha: COMMIT,
                remoteSha: COMMIT,
                pullRequest: pullRequest({ draft: true }),
                proofSnapshot: null,
                publishApprovalFingerprint: action.payload.workflowApprovalFingerprint,
                pendingAction: null,
                blocker: null,
                repairBaseSha: BASE,
                repairId: action.payload.repairId,
                repairPullRequestNumber: 12,
              },
            };
          },
        } as unknown as GitHubPublicationWorkflowV1,
      };
    },
  };
  const runtime = runtimeFor(fixture.package, outer, unusedGateway(), { workflows });
  const result = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(result.status, "verified");
  assert.equal(approvalConfirmations, 1);
});

test("merge consumes two distinct exact approval receipts, verifies merge SHA, and leaves finalization for core", async () => {
  const fixture = fixtureFor(GITHUB_PULL_REQUEST_MERGE_OPERATION_V1);
  const outer = new InstrumentedAttemptStore();
  let mergeCalls = 0;
  let observedConfirmations = 0;
  const workflows: BackgroundGitHubWorkflowFactoryV1 = {
    async create({ package: preparedPackage, approvals }) {
      return {
        checkpoint: preparedPackage.localPlan.checkpoint,
        finalizers: "disabled_until_core_reconnect",
        workflow: {
          async merge() {
            const action = preparedPackage.action;
            assert.equal(action.operation, GITHUB_PULL_REQUEST_MERGE_OPERATION_V1);
            const decision = await requestExactApproval(
              approvals,
              "merge",
              action.payload.workflowApprovalFingerprint,
              2,
            );
            observedConfirmations = decision.confirmations ?? 0;
            assert.equal(outer.latest?.status, "dispatching");
            mergeCalls += 1;
            return {
              ...preparedPackage.localPlan.checkpoint,
              status: "merged_verified",
              updatedAt: "2026-07-13T12:03:00.000Z",
              pullRequest: pullRequest({
                state: "closed",
                draft: false,
                merged: true,
                mergeSha: MERGE,
              }),
              mergeSha: MERGE,
              mergeApprovalFingerprint: action.payload.workflowApprovalFingerprint,
              pendingAction: null,
              blocker: null,
              receiptIds: [...preparedPackage.localPlan.checkpoint.receiptIds, "receipt-merge"],
            };
          },
        } as unknown as GitHubPublicationWorkflowV1,
      };
    },
  };
  const runtime = runtimeFor(fixture.package, outer, unusedGateway(), { workflows });
  const result = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(result.status, "verified");
  if (result.status === "verified") {
    assert.equal(result.proof.mergeSha, MERGE);
    assert.equal(result.proof.autoMergeEnabled, false);
  }
  assert.equal(observedConfirmations, 2);
  assert.equal(mergeCalls, 1);
  assert.equal(outer.latest?.status, "verified");
  assert.equal(outer.latest?.result?.mergeSha, MERGE);
  assert.equal(outer.latest?.diagnostic, null);
});

test("auto-merge uses the same double-exact proof and reconciles by fixed readback", async () => {
  const fixture = fixtureFor(GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1);
  const outer = new InstrumentedAttemptStore();
  let enables = 0;
  const autoMerge: BackgroundGitHubAutoMergePortV1 = {
    async enable({ checkpoint }) {
      assert.equal(outer.latest?.status, "dispatching");
      enables += 1;
      return { status: "reconcile_required", message: "transport closed after enable" };
    },
    async reconcile({ checkpoint }) {
      const action = fixture.action;
      assert.equal(action.operation, GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1);
      const evidence = {
        enabled: true,
        pullRequestNumber: 12,
        headSha: COMMIT,
        baseBranch: "main",
        mergeMethod: "squash" as const,
        proofSnapshotFingerprint: action.payload.proofSnapshotFingerprint,
        observedAt: "2026-07-13T12:04:00.000Z",
      };
      return {
        status: "verified",
        readback: {
          ...evidence,
          readbackFingerprint: fingerprintBackgroundGitHubValueV1(evidence),
        },
      };
    },
  };
  const runtime = runtimeFor(fixture.package, outer, unusedGateway(), { autoMerge });
  assert.equal((await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package })).status, "reconcile_required");
  const recovered = await runtime.execute({ jobId: fixture.package.jobId, package: fixture.package });
  assert.equal(recovered.status, "verified");
  if (recovered.status === "verified") assert.equal(recovered.proof.autoMergeEnabled, true);
  assert.equal(enables, 1);
});

function fixtureFor(
  operation: PreparedBackgroundGitHubOperationV1,
  options: { expectedRemoteSha?: string | null; canonicalProof?: boolean } = {},
) {
  const profile = detectRepositoryProfileV2({
    key: "fixture",
    displayName: "Fixture",
    repositoryRoot: "C:\\repos\\fixture",
    defaultBranch: "main",
    files: ["package.json", "package-lock.json"],
    requiredGitHubChecks: ["ci"],
  });
  const binding = createTrustedGitHubRepositoryBindingV1({
    key: "github-fixture",
    profile,
    owner: "acme",
    repository: "research-agent",
    repositoryId: 101,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agent-owner",
    trustedAt: "2026-07-13T11:55:00.000Z",
  });
  const proof = createBackgroundGitHubRepositoryProofV1({
    repositoryProfileKey: profile.key,
    repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
    canonicalRepositoryRoot: profile.repositoryRoot,
    defaultBranch: profile.defaultBranch,
    requiredChecks: profile.requiredGitHubChecks,
    mergeMethod: profile.mergePolicy.defaultMethod,
  });
  const handoff = verifiedHandoff(profile.key, binding.repositoryProfileFingerprint);
  let checkpoint = checkpointFor(
    operation,
    binding.fingerprint,
    operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
      ? fp("1")
      : handoff.fingerprint,
  );
  if (
    options.canonicalProof &&
    (operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
      operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1)
  ) {
    checkpoint = {
      ...checkpoint,
      proofSnapshot: canonicalPassingProof(),
    };
  }
  const action = actionFor(operation, binding, proof.requiredChecksFingerprint, handoff, checkpoint, options);
  const document = operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1
    ? pullRequestDocument()
    : null;
  const packageValue = createPreparedBackgroundGitHubPackageV1({
    jobId: `github-job-${operation}`,
    backgroundAuthorizationFingerprint: fp("9"),
    action,
    repositoryBinding: binding,
    repositoryProof: proof,
    checkpoint,
    verifiedCodeHandoff:
      operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 ||
      operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
        ? handoff
        : null,
    pullRequestDocument: document,
  });
  return { profile, binding, proof, handoff, checkpoint, action, package: packageValue };
}

function actionFor(
  operation: PreparedBackgroundGitHubOperationV1,
  binding: ReturnType<typeof createTrustedGitHubRepositoryBindingV1>,
  requiredChecksFingerprint: string,
  handoff: ReturnType<typeof verifiedHandoff>,
  checkpoint: GitHubPublicationCheckpointV1,
  options: { expectedRemoteSha?: string | null; canonicalProof?: boolean },
): PreparedBackgroundGitHubActionV1 {
  const exactPreparedActionFingerprint =
    operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1
        ? fp("5")
        : fp("a");
  const preparedActionId = `prepared-${operation}`;
  const requiredConfirmations = (
    operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1 ||
    operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1
      ? 2
      : 1
  ) as 1 | 2;
  const common = {
    id: `background-${operation}`,
    missionId: "mission-github-1",
    graphRevision: 7,
    capabilityEnvelopeFingerprint: fp("8"),
    nodeId: `node-${operation}`,
    nodeFingerprint: fp("7"),
    executionHost: "headless_runtime" as const,
    descriptorFingerprint: fp("6"),
    preparedActionId,
    preparedActionFingerprint: exactPreparedActionFingerprint,
    binding: {
      id: "github-binding-1",
      destinationFingerprint: fp("4"),
      repositoryBindingKey: binding.key,
      repositoryBindingFingerprint: binding.fingerprint,
      repositoryProfileKey: binding.repositoryProfileKey,
      repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
      owner: binding.owner,
      repository: binding.repository,
      repositoryId: binding.repositoryId,
      verifiedAccountId: binding.verifiedAccountId,
      verifiedAccountLogin: binding.verifiedAccountLogin,
      credentialReferenceId: "secret_github-credential-1",
    },
    authority: {
      id: `grant-${operation}`,
      authorityFingerprint: fp("3"),
      actionFingerprint: exactPreparedActionFingerprint,
      consumedAt: "2026-07-13T11:59:00.000Z",
      expiresAt: EXPIRES,
      requiredConfirmations,
      confirmationReceipts: Array.from(
        { length: requiredConfirmations },
        (_unused, index) => approvalReceipt(
          preparedActionId,
          exactPreparedActionFingerprint,
          (index + 1) as 1 | 2,
          requiredConfirmations,
        ),
      ),
    },
    idempotencyKey: `github:${operation}:1`,
    reconciliationKey: `github:${operation}:1`,
    preparedAt: NOW,
    expiresAt: EXPIRES,
  };
  const checkpointFingerprint = fingerprintBackgroundGitHubValueV1(
    parseGitHubPublicationCheckpointV1(checkpoint),
  );
  if (operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    return createPreparedBackgroundGitHubActionV1({
      ...common,
      operation,
      toolName: "github_publish_verified_branch",
      payload: {
        publicationId: checkpoint.publicationId,
        checkpointFingerprint,
        checkpointStatus: "local_verified",
        handoffFingerprint: handoff.fingerprint,
        branch: handoff.branch,
        baseBranch: handoff.baseBranch,
        baseSha: handoff.baseSha,
        headSha: handoff.commitSha,
        expectedRemoteSha: options.expectedRemoteSha ?? null,
        pushMode: options.expectedRemoteSha ? "fast_forward" : "create",
      },
    });
  }
  if (operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    const document = pullRequestDocument();
    return createPreparedBackgroundGitHubActionV1({
      ...common,
      operation,
      toolName: "github_create_draft_pull_request",
      payload: {
        publicationId: checkpoint.publicationId,
        checkpointFingerprint,
        checkpointStatus: "pushed_verified",
        handoffFingerprint: handoff.fingerprint,
        publishApprovalFingerprint: checkpoint.publishApprovalFingerprint!,
        workflowApprovalFingerprint: exactPreparedActionFingerprint,
        branch: handoff.branch,
        headSha: handoff.commitSha,
        baseBranch: handoff.baseBranch,
        baseSha: handoff.baseSha,
        titleFingerprint: document.titleFingerprint,
        bodyFingerprint: document.bodyFingerprint,
      },
    });
  }
  if (operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    return createPreparedBackgroundGitHubActionV1({
      ...common,
      operation,
      toolName: "github_update_owned_branch",
      payload: {
        publicationId: checkpoint.publicationId,
        checkpointFingerprint,
        checkpointStatus: "repair_required",
        workflowApprovalFingerprint: fp("a"),
        repairId: "repair-review-1",
        pullRequestNumber: 12,
        branch: handoff.branch,
        baseBranch: handoff.baseBranch,
        baseSha: BASE,
        expectedOldHeadSha: BASE,
        newHeadSha: COMMIT,
        previousHandoffFingerprint: checkpoint.handoffFingerprint,
        handoffFingerprint: handoff.fingerprint,
      },
    });
  }
  return createPreparedBackgroundGitHubActionV1({
    ...common,
    operation,
    toolName: operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1
      ? "github_merge_pull_request"
      : "github_enable_auto_merge",
    payload: {
      publicationId: checkpoint.publicationId,
      checkpointFingerprint,
      checkpointStatus: "review_or_merge_ready",
      workflowApprovalFingerprint: fp("a"),
      pullRequestNumber: 12,
      branch: handoff.branch,
      headSha: COMMIT,
      baseBranch: handoff.baseBranch,
      baseSha: BASE,
      pullRequestUpdatedAt: checkpoint.pullRequest!.updatedAt,
      proofSnapshotFingerprint: checkpoint.proofSnapshot!.snapshotFingerprint,
      requiredChecksFingerprint,
      mergeMethod: "squash",
    },
  } as PreparedBackgroundGitHubActionDraftV1);
}

function checkpointFor(
  operation: PreparedBackgroundGitHubOperationV1,
  bindingFingerprint: string,
  handoffFingerprint: string,
): GitHubPublicationCheckpointV1 {
  const base: GitHubPublicationCheckpointV1 = {
    version: 1,
    publicationId: "github-publication-eng-12",
    status: "local_verified",
    updatedAt: NOW,
    handoffFingerprint,
    bindingFingerprint,
    headSha: operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 ? BASE : COMMIT,
    branch: "codex/repair-1",
    remoteSha: null,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: null,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "merged_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [],
    pendingAction: null,
    blocker: null,
  };
  if (operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) return base;
  if (operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    return {
      ...base,
      status: "pushed_verified",
      remoteSha: COMMIT,
      publishApprovalFingerprint: fp("b"),
      receiptIds: ["receipt-push"],
    };
  }
  if (operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    return {
      ...base,
      status: "repair_required",
      remoteSha: BASE,
      pullRequest: pullRequest({ head: { ref: "codex/repair-1", sha: BASE } }),
      publishApprovalFingerprint: fp("b"),
      receiptIds: ["receipt-original-push", "receipt-pr"],
      blocker: { code: "github_review_repair_required", message: "Verified local repair is required." },
    };
  }
  const snapshot = {
    headSha: COMMIT,
    pullRequestUpdatedAt: "2026-07-13T12:00:30.000Z",
    requiredChecks: ["ci"],
    passedChecks: ["ci"],
    pendingChecks: [],
    failedChecks: [],
    approvingReviewers: ["reviewer"],
    changesRequestedBy: [],
    checkedAt: "2026-07-13T12:00:40.000Z",
    snapshotFingerprint: fp("c"),
  };
  return {
    ...base,
    status: "review_or_merge_ready",
    remoteSha: COMMIT,
    pullRequest: pullRequest({ draft: false }),
    proofSnapshot: snapshot,
    publishApprovalFingerprint: fp("b"),
    receiptIds: ["receipt-push", "receipt-pr"],
  };
}

function verifiedHandoff(profileKey: string, profileFingerprint: string) {
  const evidence = {
    requestId: "repair-1",
    runId: "run-1",
    worktreeId: "worktree-1",
    workspaceId: "workspace-1",
    branch: "codex/repair-1",
    baseSha: BASE,
    commitSha: COMMIT,
    parentSha: BASE,
    treeSha: TREE,
    diffFingerprint: fp("d"),
    changedPaths: ["src/fix.ts"],
    artifactHashes: [{ path: "src/fix.ts", sha256: fp("e"), bytes: 42 }],
    changedArtifacts: [{ path: "src/fix.ts", sha256: fp("e") }],
    targetedValidationReceiptId: "targeted-1",
    fullValidationReceiptId: "full-1",
    targetedValidationFingerprint: fp("f"),
    fullValidationFingerprint: fp("0"),
    committedAt: "2026-07-13T11:58:00.000Z",
  };
  return createVerifiedCodePublicationHandoffV1({
    id: "handoff-background-1",
    repositoryProfileKey: profileKey,
    repositoryProfileFingerprint: profileFingerprint,
    canonicalWorktreeRoot: ROOT,
    baseBranch: "main",
    localCommit: {
      version: 1,
      kind: "verified_local_commit",
      id: "verified-commit-1",
      status: "verified",
      ...evidence,
      fingerprint: hash(evidence),
    },
    preparedAt: "2026-07-13T11:59:00.000Z",
  });
}

function pullRequestDocument(): BackgroundGitHubPullRequestDocumentV1 {
  const title = "Implement ENG-12";
  const body = "Verified locally.\n\nLinear: ENG-12";
  return {
    title,
    body,
    titleFingerprint: fingerprintBackgroundGitHubValueV1(title),
    bodyFingerprint: fingerprintBackgroundGitHubValueV1(body),
  };
}

function pullRequest(overrides: Partial<NonNullable<GitHubPublicationCheckpointV1["pullRequest"]>> = {}) {
  return {
    number: 12,
    htmlUrl: "https://github.com/acme/research-agent/pull/12",
    state: "open" as const,
    draft: false,
    merged: false,
    head: { ref: "codex/repair-1", sha: COMMIT },
    base: { ref: "main", sha: BASE },
    updatedAt: "2026-07-13T12:00:30.000Z",
    ...overrides,
  };
}

function canonicalPassingProof() {
  return createProofSnapshot(
    pullRequest({ draft: false }),
    ["ci"],
    [{ name: "ci", status: "completed", conclusion: "success" }],
    [{ context: "ci", state: "success" }],
    [{
      id: 1,
      userLogin: "reviewer",
      state: "APPROVED",
      submittedAt: "2026-07-13T12:00:35.000Z",
      body: "Looks good",
    }],
    "2026-07-13T12:00:40.000Z",
  );
}

function runtimeFor(
  preparedPackage: PreparedBackgroundGitHubPackageV1,
  attempts: BackgroundGitHubActionAttemptStoreV1,
  pushGateway: VerifiedGitPushGatewayV1,
  overrides: {
    remoteHead?: () => string | null;
    workflows?: BackgroundGitHubWorkflowFactoryV1;
    autoMerge?: BackgroundGitHubAutoMergePortV1;
    approvalReceipts?: BackgroundGitHubHostApprovalReceiptVerifierV1;
    now?: () => Date;
  } = {},
) {
  const workflows = overrides.workflows ?? {
    async create({ package: packageValue }) {
      return {
        checkpoint: packageValue.localPlan.checkpoint,
        finalizers: "disabled_until_core_reconnect" as const,
        workflow: {} as GitHubPublicationWorkflowV1,
      };
    },
  };
  const autoMerge = overrides.autoMerge ?? {
    async enable() { return { status: "not_applied" as const, message: "unused" }; },
    async reconcile() { return { status: "not_applied" as const, message: "unused" }; },
  };
  return new BackgroundGitHubContinuationRuntimeV1({
    attempts,
    pushGateway,
    accountVerifier: {
      async verify(referenceId) {
        assert.equal(referenceId, "secret_github-credential-1");
        return { id: 202, login: "agent-owner" };
      },
    },
    remoteHeads: {
      async read() { return overrides.remoteHead?.() ?? null; },
    },
    workflows,
    autoMerge,
    approvalReceipts: overrides.approvalReceipts ?? {
      async verify(receipt) {
        return receipt.signingKeyFingerprint === APPROVAL_SIGNING_KEY_FINGERPRINT &&
          receipt.authenticator === approvalAuthenticator(receipt.evidenceFingerprint);
      },
    },
    now: overrides.now ?? tickingClock(),
  });
}

const APPROVAL_SIGNING_KEY_FINGERPRINT = fp("2");
const APPROVAL_AUTHENTICATOR_TEST_KEY = "background-github-approval-test-key";

function approvalReceipt(
  preparedActionId: string,
  preparedActionFingerprint: string,
  confirmationOrdinal: 1 | 2,
  requiredConfirmations: 1 | 2,
  overrides: Partial<{
    id: string;
    decision: "approved" | "denied";
    actorFingerprint: string;
    sessionFingerprint: string;
    hostInstanceFingerprint: string;
    authenticator: string;
  }> = {},
): HostApprovalReceiptV1 {
  const evidence = createHostApprovalReceiptEvidenceV1({
    id: overrides.id ?? `approval-receipt-${confirmationOrdinal}`,
    preparedActionId,
    preparedActionFingerprint,
    confirmationOrdinal,
    requiredConfirmations,
    decision: overrides.decision ?? "approved",
    hostInstanceFingerprint: overrides.hostInstanceFingerprint ?? fp("3"),
    actorFingerprint: overrides.actorFingerprint ?? fp("4"),
    sessionFingerprint: overrides.sessionFingerprint ?? fp("5"),
    decidedAt: "2026-07-13T11:58:30.000Z",
  });
  return sealHostApprovalReceiptV1(evidence, {
    signingKeyFingerprint: APPROVAL_SIGNING_KEY_FINGERPRINT,
    authenticator: overrides.authenticator ?? approvalAuthenticator(evidence.evidenceFingerprint),
  });
}

function approvalAuthenticator(evidenceFingerprint: string): string {
  return createHmac("sha256", APPROVAL_AUTHENTICATOR_TEST_KEY)
    .update(evidenceFingerprint, "utf8")
    .digest("base64url");
}

class InstrumentedAttemptStore implements BackgroundGitHubActionAttemptStoreV1 {
  private records = new Map<string, BackgroundGitHubActionAttemptV1>();
  readonly savedStatuses: string[] = [];
  readonly savedRecords: BackgroundGitHubActionAttemptV1[] = [];
  latest: BackgroundGitHubActionAttemptV1 | null = null;
  loads = 0;

  async load(id: string) {
    this.loads += 1;
    return clone(this.records.get(id) ?? null);
  }

  async save(record: BackgroundGitHubActionAttemptV1, expectedRevision: number | null) {
    const current = this.records.get(record.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.records.set(record.id, clone(record));
    this.latest = clone(record);
    this.savedStatuses.push(record.status);
    this.savedRecords.push(clone(record));
    return true;
  }
}

function createGitGateway(options: {
  remoteSha: string | null;
  pushMode?: "success" | "applied_throw";
  beforePush?: () => void;
}) {
  const runner = new FakeGitRunner(options);
  const gateway = new VerifiedGitPushGatewayV1({
    runner,
    askpassBroker: new FakeAskpassBroker(),
    attemptStore: new MemoryGitPushAttemptStore(),
    disabledHooksPath: "C:\\agent-runtime\\empty-hooks",
    now: tickingClock(),
  });
  return { gateway, runner };
}

class FakeAskpassBroker implements EphemeralGitAskpassBrokerV1 {
  async withHandle<TResult>(input: {
    credentialReferenceId: string;
    repositoryBindingFingerprint: string;
    signal?: AbortSignal;
    use(handle: { readonly id: string; readonly executablePath: string }): Promise<TResult>;
  }): Promise<TResult> {
    assert.equal(input.credentialReferenceId, "secret_github-credential-1");
    return input.use({ id: "opaque-handle-1", executablePath: "C:\\askpass\\github-helper.exe" });
  }
}

class MemoryGitPushAttemptStore implements GitPushAttemptStoreV1 {
  private records = new Map<string, GitPushAttemptRecordV1>();
  async load(id: string) { return clone(this.records.get(id) ?? null); }
  async save(record: GitPushAttemptRecordV1, expectedRevision: number | null) {
    const current = this.records.get(record.id);
    if (expectedRevision === null ? current !== undefined : current?.revision !== expectedRevision) return false;
    this.records.set(record.id, clone(record));
    return true;
  }
}

class FakeGitRunner implements VerifiedGitCommandRunnerV1 {
  readonly calls: Array<Parameters<VerifiedGitCommandRunnerV1["run"]>[0]> = [];
  pushes = 0;
  fetches = 0;
  mergeBaseChecks = 0;
  private remoteSha: string | null;

  constructor(private readonly options: {
    remoteSha: string | null;
    pushMode?: "success" | "applied_throw";
    beforePush?: () => void;
  }) {
    this.remoteSha = options.remoteSha;
  }

  async run(input: Parameters<VerifiedGitCommandRunnerV1["run"]>[0]) {
    this.calls.push(clone(input));
    const operation = gitOperation(input.args);
    if (operation === "rev-parse") {
      const subject = input.args.at(-1);
      if (subject === "--show-toplevel") return ok(ROOT);
      if (subject === "HEAD") return ok(COMMIT);
      if (subject === "HEAD^{tree}") return ok(TREE);
      if (subject === "HEAD^") return ok(BASE);
    }
    if (operation === "branch") return ok("codex/repair-1");
    if (operation === "ls-remote") {
      return ok(this.remoteSha ? `${this.remoteSha}\trefs/heads/codex/repair-1` : "");
    }
    if (operation === "fetch") { this.fetches += 1; return ok(""); }
    if (operation === "merge-base") { this.mergeBaseChecks += 1; return ok(""); }
    if (operation === "push") {
      this.options.beforePush?.();
      this.pushes += 1;
      this.remoteSha = COMMIT;
      if (this.options.pushMode === "applied_throw") throw new Error("transport closed after dispatch");
      return ok("push dispatched");
    }
    return { exitCode: 2, stdout: "", stderr: `Unexpected operation ${operation}` };
  }
}

function unusedGateway(): VerifiedGitPushGatewayV1 {
  return createGitGateway({ remoteSha: null }).gateway;
}

function unusedRunner(): VerifiedGitCommandRunnerV1 {
  return {
    async run() {
      throw new Error("Git must not run during draft-only provider tests.");
    },
  };
}

function unusedAskpass(): EphemeralGitAskpassBrokerV1 {
  return {
    async withHandle() {
      throw new Error("Askpass must not run during draft-only provider tests.");
    },
  };
}

function approvalVerifier(): BackgroundGitHubHostApprovalReceiptVerifierV1 {
  return {
    async verify(receipt) {
      return receipt.signingKeyFingerprint === APPROVAL_SIGNING_KEY_FINGERPRINT &&
        receipt.authenticator === approvalAuthenticator(receipt.evidenceFingerprint);
    },
  };
}

function persistentSecretStore(secret: string, leasedReferences: string[]): SecretStoreV1 {
  return {
    version: 1,
    async health() {
      return {
        version: 1,
        available: true,
        persistent: true,
        backend: "test-keyring",
        backgroundEligible: true,
        blocker: null,
      };
    },
    async put() { throw new Error("put is outside the provider test boundary"); },
    async remove() { return false; },
    async describe(referenceId) {
      assert.equal(referenceId, "secret_github-credential-1");
      return {
        version: 1,
        referenceId,
        label: "GitHub test credential",
        metadata: { provider: "github", credentialKind: "fine_grained_pat" },
        backend: "test-keyring",
        persistent: true,
        createdAt: NOW,
        updatedAt: NOW,
      };
    },
    async lease(referenceId) {
      assert.equal(referenceId, "secret_github-credential-1");
      leasedReferences.push(referenceId);
      let disposed = false;
      const description = {
        version: 1 as const,
        leaseId: `lease-${leasedReferences.length}`,
        referenceId,
        source: "secure_store_lease" as const,
        persistent: true,
        expiresAt: EXPIRES,
      };
      return {
        description,
        get disposed() { return disposed; },
        async withSecret<TResult>(use: (value: string) => Promise<TResult>) {
          if (disposed) throw new Error("lease already disposed");
          return use(secret);
        },
        dispose() { disposed = true; },
        toJSON() { return { redacted: true as const, description }; },
      };
    },
  };
}

function draftProviderTransport(input: {
  secret: string;
  requests: Array<{ method: string; path: string }>;
  isCreated(): boolean;
  onCreate(): void;
  userId?: number;
  repositoryId?: number;
}): HttpTransport {
  return async (request) => {
    assert.equal(request.headers?.Authorization, `Bearer ${input.secret}`);
    const url = new URL(request.url);
    const method = request.method ?? "GET";
    input.requests.push({ method, path: url.pathname });
    const ok = (json: unknown, status = 200) => ({ status, headers: {}, json });
    if (method === "GET" && url.pathname === "/user") {
      return ok({ id: input.userId ?? 202, login: "agent-owner", html_url: "https://github.com/agent-owner" });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent") {
      return ok({
        id: input.repositoryId ?? 101,
        full_name: "acme/research-agent",
        html_url: "https://github.com/acme/research-agent",
        default_branch: "main",
        private: true,
        archived: false,
      });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent/pulls") {
      return ok(input.isCreated() ? [rawDraftPullRequest()] : []);
    }
    if (method === "POST" && url.pathname === "/repos/acme/research-agent/pulls") {
      input.onCreate();
      return ok(rawDraftPullRequest(), 201);
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent/pulls/12") {
      if (!input.isCreated()) return { status: 404, headers: {}, json: { message: "not found" } };
      return ok(rawDraftPullRequest());
    }
    if (method === "GET" && url.pathname === `/repos/acme/research-agent/commits/${COMMIT}/check-runs`) {
      return ok({ total_count: 1, check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }] });
    }
    if (method === "GET" && url.pathname === `/repos/acme/research-agent/commits/${COMMIT}/status`) {
      return ok({
        state: "success",
        sha: COMMIT,
        total_count: 1,
        statuses: [{ id: 1, state: "success", context: "ci", description: "passed", target_url: "https://github.com/acme/research-agent/actions" }],
      });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent/pulls/12/reviews") {
      return ok([{ id: 1, html_url: "https://github.com/acme/research-agent/pull/12#review-1", state: "APPROVED", body: "Looks good", commit_id: COMMIT, user: { id: 303, login: "reviewer" }, submitted_at: "2026-07-13T12:00:35.000Z" }]);
    }
    throw new Error(`Unexpected fixed GitHub test request: ${method} ${url.pathname}${url.search}`);
  };
}

interface WorkflowProviderState {
  headSha: string;
  merged: boolean;
  proofDrift: boolean;
  autoMergeEnabled: boolean;
  failAutoMergeAfterCommit: boolean;
  mergeCalls: number;
  autoMergeMutationCalls: number;
  autoMergeReadCalls: number;
  requests: Array<{ method: string; path: string }>;
}

function workflowProviderState(
  overrides: Partial<WorkflowProviderState> = {},
): WorkflowProviderState {
  return {
    headSha: COMMIT,
    merged: false,
    proofDrift: false,
    autoMergeEnabled: false,
    failAutoMergeAfterCommit: false,
    mergeCalls: 0,
    autoMergeMutationCalls: 0,
    autoMergeReadCalls: 0,
    requests: [],
    ...overrides,
  };
}

function workflowProviderTransport(
  secret: string,
  state: WorkflowProviderState,
): HttpTransport {
  return async (request) => {
    assert.equal(request.headers?.Authorization, `Bearer ${secret}`);
    const url = new URL(request.url);
    const method = String(request.method ?? "GET").toUpperCase();
    state.requests.push({ method, path: url.pathname });
    const ok = (json: unknown, status = 200) => ({ status, headers: {}, json });
    if (method === "GET" && url.pathname === "/user") {
      return ok({ id: 202, login: "agent-owner", html_url: "https://github.com/agent-owner" });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent") {
      return ok({
        id: 101,
        full_name: "acme/research-agent",
        html_url: "https://github.com/acme/research-agent",
        default_branch: "main",
        private: true,
        archived: false,
      });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent/pulls/12") {
      return ok(rawWorkflowPullRequest(state));
    }
    if (method === "GET" && url.pathname === `/repos/acme/research-agent/commits/${COMMIT}/check-runs`) {
      return ok({
        total_count: 1,
        check_runs: [{ id: 1, name: "ci", status: "completed", conclusion: "success" }],
      });
    }
    if (method === "GET" && url.pathname === `/repos/acme/research-agent/commits/${COMMIT}/status`) {
      return ok({
        state: "success",
        sha: COMMIT,
        total_count: 1,
        statuses: [{
          id: 1,
          state: "success",
          context: "ci",
          description: "passed",
          target_url: "https://github.com/acme/research-agent/actions",
        }],
      });
    }
    if (method === "GET" && url.pathname === "/repos/acme/research-agent/pulls/12/reviews") {
      return ok([{
        id: state.proofDrift ? 2 : 1,
        html_url: "https://github.com/acme/research-agent/pull/12#review-1",
        state: state.proofDrift ? "CHANGES_REQUESTED" : "APPROVED",
        body: state.proofDrift ? "Please change this" : "Looks good",
        commit_id: COMMIT,
        user: { id: 303, login: "reviewer" },
        submitted_at: state.proofDrift
          ? "2026-07-13T12:20:35.000Z"
          : "2026-07-13T12:00:35.000Z",
      }]);
    }
    if (method === "PUT" && url.pathname === "/repos/acme/research-agent/pulls/12/merge") {
      state.mergeCalls += 1;
      state.merged = true;
      return ok({ sha: MERGE, merged: true, message: "Pull request merged" });
    }
    if (method === "POST" && url.pathname === "/graphql") {
      const body = JSON.parse(String(request.body ?? "{}")) as { query?: string };
      if (body.query?.includes("mutation AgenticResearcherEnableAutoMerge")) {
        state.autoMergeMutationCalls += 1;
        state.autoMergeEnabled = true;
        if (state.failAutoMergeAfterCommit) {
          state.failAutoMergeAfterCommit = false;
          throw new Error("connection closed after auto-merge committed");
        }
        return ok({ data: { enablePullRequestAutoMerge: { pullRequest: { id: "PR_test_node_12" } } } });
      }
      if (body.query?.includes("query AgenticResearcherAutoMergeReadback")) {
        state.autoMergeReadCalls += 1;
        return ok({
          data: {
            repository: {
              pullRequest: {
                id: "PR_test_node_12",
                number: 12,
                headRefOid: COMMIT,
                baseRefName: "main",
                autoMergeRequest: state.autoMergeEnabled
                  ? { enabledAt: "2026-07-13T12:10:00.000Z", mergeMethod: "SQUASH" }
                  : null,
              },
            },
          },
        });
      }
    }
    throw new Error(`Unexpected workflow GitHub test request: ${method} ${url.pathname}${url.search}`);
  };
}

function rawWorkflowPullRequest(state: WorkflowProviderState) {
  return {
    node_id: "PR_test_node_12",
    number: 12,
    html_url: "https://github.com/acme/research-agent/pull/12",
    state: state.merged ? "closed" : "open",
    title: "Implement ENG-12",
    body: "Verified locally.\n\nLinear: ENG-12",
    draft: false,
    merged: state.merged,
    merged_at: state.merged ? "2026-07-13T12:25:00.000Z" : null,
    merge_commit_sha: state.merged ? MERGE : null,
    head: { ref: "codex/repair-1", sha: state.headSha },
    base: { ref: "main", sha: BASE },
    updated_at: "2026-07-13T12:00:30.000Z",
  };
}

function rawDraftPullRequest() {
  return {
    node_id: "PR_test_node_12",
    number: 12,
    html_url: "https://github.com/acme/research-agent/pull/12",
    state: "open",
    title: "Implement ENG-12",
    body: "Verified locally.\n\nLinear: ENG-12",
    draft: true,
    merged: false,
    merged_at: null,
    head: { ref: "codex/repair-1", sha: COMMIT },
    base: { ref: "main", sha: BASE },
    updated_at: "2026-07-13T12:00:30.000Z",
  };
}

function jobForFixture(fixture: ReturnType<typeof fixtureFor>): CompanionJobV1 {
  return {
    version: 1,
    id: fixture.package.jobId,
    missionId: fixture.action.missionId,
    nodeId: fixture.action.nodeId,
    graphRevision: fixture.action.graphRevision,
    executionHost: fixture.action.executionHost,
    domain: "github",
    state: "queued",
    objective: "Continue the exact prepared GitHub action.",
    inputs: {},
    allowedTools: [fixture.action.toolName],
    requiredCapabilities: ["github:write"],
    bindings: [{
      id: fixture.action.binding.id,
      kind: "github-repository",
      destinationFingerprint: fixture.action.binding.destinationFingerprint,
    }],
    capabilityEnvelopeFingerprint: fixture.action.capabilityEnvelopeFingerprint,
    authorization: {
      version: 1,
      grantId: "background-github-grant-1",
      fingerprint: fixture.package.backgroundAuthorizationFingerprint,
      authorizedAt: NOW,
      expiresAt: EXPIRES,
    },
    preparedExternalActionHandoff: null,
    preparedBackgroundCodeAction: null,
    preparedBackgroundCodePackage: null,
    preparedBackgroundGitHubAction: fixture.action,
    preparedBackgroundGitHubPackage: createPreparedBackgroundGitHubPackageIdentityFromPackageV1(fixture.package),
    idempotencyKey: fp("9"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function workerContext(at = NOW) {
  return {
    signal: new AbortController().signal,
    now: () => new Date(at),
    reportProgress: async () => undefined,
  };
}

async function readAllFiles(root: string): Promise<string> {
  const values: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile()) values.push(await fs.readFile(target, "utf8"));
    }
  };
  await visit(root);
  return values.join("\n");
}

async function requestExactApproval(
  approvals: GitHubPublicationApprovalPortV1,
  kind: "repair_fast_forward" | "merge",
  fingerprint: string,
  confirmations: 1 | 2,
) {
  return approvals.request({
    kind,
    approvalFingerprint: fingerprint,
    preparedAction: { payloadFingerprint: fingerprint } as never,
    requiredConfirmations: confirmations,
    summary: "Exact fixed GitHub action",
    destination: "https://github.com/acme/research-agent/pull/12",
  });
}

function requirements(value: PreparedBackgroundGitHubPackageV1) {
  return {
    packageId: value.id,
    packageFingerprint: value.fingerprint,
    jobId: value.jobId,
    backgroundAuthorizationFingerprint: value.backgroundAuthorizationFingerprint,
    actionFingerprint: value.actionFingerprint,
    operation: value.operation,
    publicationId: value.publicationId,
    repositoryBindingFingerprint: value.repositoryBindingFingerprint,
    repositoryProfileFingerprint: value.repositoryProfileFingerprint,
    verifiedAccountId: value.verifiedAccountId,
  };
}

function withoutEnvelope(action: PreparedBackgroundGitHubActionV1) {
  const { version: _version, kind: _kind, status: _status, fingerprint: _fingerprint, ...draft } = action;
  return draft;
}

function gitOperation(args: readonly string[]) {
  return args.find((argument) => ["rev-parse", "branch", "ls-remote", "fetch", "merge-base", "push"].includes(argument)) ?? "unknown";
}

function ok(stdout: string) {
  return { exitCode: 0, stdout: stdout ? `${stdout}\n` : "", stderr: "" };
}

function tickingClock() {
  let now = Date.parse(NOW);
  return () => new Date((now += 1_000));
}

function fp(character: string) {
  return `sha256:${character.repeat(64)}`;
}

function hash(value: unknown) {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}

function clone<T>(value: T): T {
  return value === null ? value : JSON.parse(JSON.stringify(value)) as T;
}
