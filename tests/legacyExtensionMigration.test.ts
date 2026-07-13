import assert from "node:assert/strict";
import test from "node:test";

import {
  createAuthorityGrantStoreState,
} from "../src/agent/authority/AuthorityGrantStore";
import { createDefaultLinearQueueGrant } from "../src/agent/authority/DefaultLinearQueueGrant";
import {
  createQueueDailyStartBudgetState,
} from "../src/agent/queue/dailyStartBudget";
import { fingerprintCanonicalJson } from "../src/agent/queue/fingerprint";
import { createLinearQueueState } from "../src/agent/queue/linearQueue";
import { createResourceLockState } from "../src/agent/queue/resourceLocks";
import {
  createNodeNpmValidationProfile,
  createRepositoryProfile,
  createRepositoryProfileRegistry,
} from "../src/agent/repositories";
import {
  acceptExtensionStateMigrationReadback,
  createExtensionStateMigrationOffer,
  isExtensionStateMigrationVerified,
  loadOrPrepareExtensionStateMigration,
  prepareLegacyExtensionMigration,
  prepareNewInstallExtensionState,
  verifyExtensionMigrationAcknowledgement,
  type ExtensionMigrationAcknowledgementV1,
  type ExtensionNamespace,
  type ExtensionStateMigrationPlanV1,
} from "../src/extensions/legacyExtensionMigration";
import { createExternalActionReceiptLedgerState } from "../src/integrations/linear/ExternalActionReceiptLedger";
import { createLinearIntegrationState } from "../src/integrations/linear/LinearIntegrationState";
import { createPendingLinearReconciliationState } from "../src/integrations/linear/PendingLinearReconciliationState";

const PREPARED_AT = "2026-07-11T22:00:00.000Z";
const RELEASES = ["0.3.0", "0.4.0"] as const;
const LEGACY_SECRET = "lin_api_this_value_must_never_leave_the_source";

test("legacy migration creates three immutable independently hashed secret-free snapshots", async () => {
  const source = legacySource();
  const before = JSON.stringify(source);
  const plan = await prepareLegacyExtensionMigration({
    sourceData: source,
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });

  assert.equal(JSON.stringify(source), before, "migration must not mutate its source");
  assert.equal(plan.mode, "legacy_v2");
  assert.deepEqual(plan.pendingSecretKinds, ["linear_personal_api_key"]);
  assert.equal(plan.sourceSnapshot?.legacySettingsSchemaVersion, 2);
  assert.deepEqual(plan.retention, {
    policy: "legacy_source_read_only_two_releases",
    releaseIds: [...RELEASES],
    retainedReleaseCount: 2,
    eligibleForRemovalAfterRelease: "0.4.0",
    sourceSnapshotHash: plan.sourceSnapshotHash,
  });
  assert.equal(plan.namespaces.code.status, "pending");
  assert.equal(plan.namespaces.integrations.status, "pending");
  assert.equal(plan.namespaces.companion.status, "pending");
  assert.equal(
    plan.namespaces.code.snapshot.repositoryProfiles.profiles["research-agent"]
      .displayName,
    "Research Agent",
  );
  assert.deepEqual(plan.namespaces.code.snapshot.codeBudgets, {
    maxCodeRunsPerMission: 7,
    workerMaxSteps: 18,
    workerMaxToolCalls: 22,
    workerMaxMinutes: 11,
    autoMergeGreen: false,
  });
  assert.equal(
    plan.namespaces.integrations.snapshot.linearSettings.queueProjectId,
    "project_queue",
  );
  assert.equal(
    plan.namespaces.companion.snapshot.baseUrl,
    "http://127.0.0.1:9876",
  );

  const hashes = [
    plan.namespaces.code.snapshotHash,
    plan.namespaces.integrations.snapshotHash,
    plan.namespaces.companion.snapshotHash,
  ];
  assert.equal(new Set(hashes).size, 3);
  assert.equal(
    plan.namespaces.code.snapshotHash,
    fingerprintCanonicalJson(plan.namespaces.code.snapshot),
  );
  assert.equal(
    plan.namespaces.integrations.snapshotHash,
    fingerprintCanonicalJson(plan.namespaces.integrations.snapshot),
  );
  assert.equal(
    plan.namespaces.companion.snapshotHash,
    fingerprintCanonicalJson(plan.namespaces.companion.snapshot),
  );
  const serialized = JSON.stringify(plan);
  assert.equal(serialized.includes(LEGACY_SECRET), false);
  assert.equal(serialized.includes("linearApiKey"), false);
  assert.equal(Object.isFrozen(plan), true);
  assert.equal(Object.isFrozen(plan.sourceSnapshot), true);
  assert.equal(Object.isFrozen(plan.namespaces.code.snapshot.codeBudgets), true);

  source.orchestratorWorkerMaxSteps = 4;
  source.repositoryProfileRegistry.profiles["research-agent"].displayName =
    "Mutated after migration";
  assert.equal(plan.namespaces.code.snapshot.codeBudgets.workerMaxSteps, 18);
  assert.equal(
    plan.namespaces.code.snapshot.repositoryProfiles.profiles["research-agent"]
      .displayName,
    "Research Agent",
  );
});

test("legacy migration and exact namespace acknowledgements are idempotent", async () => {
  const input = {
    sourceData: legacySource(),
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  } as const;
  const first = await prepareLegacyExtensionMigration(input);
  const second = await prepareLegacyExtensionMigration(input);
  assert.deepEqual(second, first);

  const badAck = acknowledgement(first, "code", "2026-07-11T22:01:00.000Z");
  badAck.observedSnapshotHash = `sha256:${"0".repeat(64)}`;
  assert.throws(
    () => verifyExtensionMigrationAcknowledgement(first, badAck),
    /snapshot hash does not match/i,
  );

  const codeAck = acknowledgement(first, "code", "2026-07-11T22:01:00.000Z");
  const codeVerified = verifyExtensionMigrationAcknowledgement(first, codeAck);
  assert.equal(codeVerified.namespaces.code.status, "verified");
  assert.equal(codeVerified.namespaces.integrations.status, "pending");
  assert.equal(isExtensionStateMigrationVerified(codeVerified), false);
  assert.deepEqual(
    verifyExtensionMigrationAcknowledgement(codeVerified, codeAck),
    codeVerified,
  );
  assert.throws(
    () =>
      verifyExtensionMigrationAcknowledgement(
        codeVerified,
        acknowledgement(codeVerified, "code", "2026-07-11T22:02:00.000Z"),
      ),
    /different acknowledgement/i,
  );

  const integrationsVerified = verifyExtensionMigrationAcknowledgement(
    codeVerified,
    acknowledgement(codeVerified, "integrations", "2026-07-11T22:02:00.000Z"),
  );
  const allVerified = verifyExtensionMigrationAcknowledgement(
    integrationsVerified,
    acknowledgement(
      integrationsVerified,
      "companion",
      "2026-07-11T22:03:00.000Z",
    ),
  );
  assert.equal(isExtensionStateMigrationVerified(allVerified), true);
});

test("new installs bootstrap defaults without accepting a legacy fallback", async () => {
  await assert.rejects(
    () =>
      prepareNewInstallExtensionState({
        preparedAt: PREPARED_AT,
        sourceData: legacySource(),
      } as never),
    /unknown: sourceData/i,
  );

  const plan = await prepareNewInstallExtensionState({
    preparedAt: PREPARED_AT,
  });
  assert.equal(plan.mode, "new_install");
  assert.equal(plan.sourceSnapshot, null);
  assert.equal(plan.sourceSnapshotHash, null);
  assert.equal(plan.retention, null);
  assert.deepEqual(plan.pendingSecretKinds, []);
  assert.equal(
    Object.keys(plan.namespaces.code.snapshot.repositoryProfiles.profiles).length,
    0,
  );
  assert.equal(plan.namespaces.integrations.snapshot.linearSettings.enabled, false);
  assert.equal(plan.namespaces.companion.snapshot.baseUrl, "http://127.0.0.1:8765");
  assert.equal(JSON.stringify(plan).includes("project_queue"), false);
});

test("malformed or unknown persisted authority aborts instead of becoming empty", async () => {
  const unknown = legacySource();
  unknown.authorityGrantStoreState = {
    ...unknown.authorityGrantStoreState,
    unexpectedAuthority: true,
  } as typeof unknown.authorityGrantStoreState;
  await assert.rejects(
    () =>
      prepareLegacyExtensionMigration({
        sourceData: unknown,
        preparedAt: PREPARED_AT,
        retainedReleaseIds: RELEASES,
      }),
    /unknown: unexpectedAuthority/i,
  );

  const malformed = legacySource();
  malformed.authorityGrantStoreState = {
    version: 99,
    revision: 0,
    grants: [],
    updatedAt: PREPARED_AT,
  } as never;
  await assert.rejects(
    () =>
      prepareLegacyExtensionMigration({
        sourceData: malformed,
        preparedAt: PREPARED_AT,
        retainedReleaseIds: RELEASES,
      }),
    /malformed|unsupported/i,
  );
});

test("valid persisted authority is retained core-side and never copied into integrations", async () => {
  const source = legacySource();
  const grant = await createDefaultLinearQueueGrant({
    id: "grant-retained",
    queueProjectId: "project_queue",
    userApproved: true,
    repositoryProfileIds: ["research-agent"],
    issuedAt: new Date(PREPARED_AT),
  });
  source.authorityGrantStoreState = {
    version: 1,
    revision: 1,
    grants: [grant],
    updatedAt: PREPARED_AT,
  };

  const plan = await prepareLegacyExtensionMigration({
    sourceData: source,
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });
  assert.equal(
    plan.sourceSnapshot?.retainedCoreAuthority.grants[0].id,
    "grant-retained",
  );
  assert.equal(
    JSON.stringify(plan.namespaces.integrations.snapshot).includes(
      "grant-retained",
    ),
    false,
  );
});

test("runtime migration safely handles boundary schema 3 and credential-only legacy data", async () => {
  const boundary = legacySource();
  boundary.settingsSchemaVersion = 3;
  const boundaryLoaded = await loadOrPrepareExtensionStateMigration({
    rawData: boundary,
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });
  assert.equal(boundaryLoaded.needsPersistence, true);
  assert.equal(boundaryLoaded.plan.mode, "legacy_v2");
  assert.deepEqual(boundaryLoaded.plan.pendingSecretKinds, [
    "linear_personal_api_key",
  ]);
  assert.equal(JSON.stringify(boundaryLoaded.plan).includes(LEGACY_SECRET), false);

  const credentialOnly = await loadOrPrepareExtensionStateMigration({
    rawData: { linearApiKey: LEGACY_SECRET },
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });
  assert.equal(credentialOnly.plan.mode, "legacy_v2");
  assert.deepEqual(credentialOnly.plan.pendingSecretKinds, [
    "linear_personal_api_key",
  ]);
  assert.equal(
    credentialOnly.plan.namespaces.integrations.snapshot.linearSettings.enabled,
    false,
  );
  assert.equal(JSON.stringify(credentialOnly.plan).includes(LEGACY_SECRET), false);

  const resumed = await loadOrPrepareExtensionStateMigration({
    rawData: { extensionStateMigration: boundaryLoaded.plan },
    preparedAt: "2026-07-12T00:00:00.000Z",
    retainedReleaseIds: RELEASES,
  });
  assert.equal(resumed.needsPersistence, false);
  assert.deepEqual(resumed.plan, boundaryLoaded.plan);
});

test("runtime migration treats explicit null legacy optional state as absent", async () => {
  const source = legacySource();
  Object.assign(source, {
    linearIntegrationState: null,
    pendingLinearReconciliationState: null,
    externalActionReceiptLedger: null,
    linearQueueState: null,
    queueResourceLockState: null,
    queueDailyStartBudgetState: null,
    authorityGrantStoreState: null,
  });
  const loaded = await loadOrPrepareExtensionStateMigration({
    rawData: source,
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });
  assert.equal(loaded.plan.mode, "legacy_v2");
  assert.equal(loaded.plan.namespaces.integrations.snapshot.linearQueueState, null);
  assert.equal(
    loaded.plan.sourceSnapshot?.retainedCoreAuthority.grants.length,
    0,
  );
});

test("extension readback verifies only its token-owned namespace by canonical hash", async () => {
  const plan = await prepareLegacyExtensionMigration({
    sourceData: legacySource(),
    preparedAt: PREPARED_AT,
    retainedReleaseIds: RELEASES,
  });
  const offer = createExtensionStateMigrationOffer(plan, "integrations");
  assert.deepEqual(offer.pendingSecureImportKinds, ["linear_personal_api_key"]);
  assert.equal(JSON.stringify(offer).includes(LEGACY_SECRET), false);

  const accepted = acceptExtensionStateMigrationReadback(plan, "integrations", {
    version: 1,
    migrationId: offer.migrationId,
    namespace: offer.namespace,
    snapshot: offer.snapshot,
    acknowledgedAt: "2026-07-11T22:05:00.000Z",
  });
  assert.equal(accepted.plan.namespaces.integrations.status, "verified");
  assert.equal(accepted.plan.namespaces.code.status, "pending");
  assert.equal(accepted.plan.namespaces.companion.status, "pending");
  assert.equal(accepted.result.snapshotHash, offer.snapshotHash);

  assert.throws(
    () =>
      acceptExtensionStateMigrationReadback(plan, "integrations", {
        version: 1,
        migrationId: offer.migrationId,
        namespace: offer.namespace,
        snapshot: { tampered: true },
        acknowledgedAt: "2026-07-11T22:05:00.000Z",
      }),
    /snapshot hash does not match/i,
  );
  assert.throws(
    () =>
      acceptExtensionStateMigrationReadback(plan, "code", {
        version: 1,
        migrationId: offer.migrationId,
        namespace: "integrations",
        snapshot: offer.snapshot,
        acknowledgedAt: "2026-07-11T22:05:00.000Z",
      }),
    /another namespace/i,
  );
});

function legacySource() {
  const profile = createRepositoryProfile({
    key: "research-agent",
    displayName: "Research Agent",
    repositoryRoot: "C:\\work\\research-agent",
    defaultBranch: "main",
    allowedPathPrefixes: ["src", "tests"],
    validationProfile: createNodeNpmValidationProfile({
      allowedGeneratedPaths: ["main.js"],
    }),
  });
  return {
    settingsSchemaVersion: 2,
    maxCodeRunsPerMission: 7,
    orchestratorWorkerMaxSteps: 18,
    orchestratorWorkerMaxToolCalls: 22,
    orchestratorWorkerMaxMinutes: 11,
    orchestratorAutoMergeGreen: false,
    repositoryProfileRegistry: createRepositoryProfileRegistry([profile]),
    linearEnabled: true,
    linearCapabilityGate: 5,
    linearDefaultTeamId: "team_default",
    linearQueueEnabled: true,
    linearQueueProjectId: "project_queue",
    linearStartedStateId: "state_started",
    linearCompletedStateId: "state_completed",
    linearBlockedStateId: "state_blocked",
    linearScanIntervalMinutes: 15,
    linearApiKey: LEGACY_SECRET,
    linearIntegrationState: createLinearIntegrationState({
      at: PREPARED_AT,
      workspaceId: "workspace_one",
    }),
    pendingLinearReconciliationState: createPendingLinearReconciliationState(
      new Date(PREPARED_AT),
    ),
    externalActionReceiptLedger: createExternalActionReceiptLedgerState(
      new Date(PREPARED_AT),
    ),
    linearQueueState: createLinearQueueState({
      workspaceId: "workspace_one",
      at: PREPARED_AT,
    }),
    queueResourceLockState: createResourceLockState(PREPARED_AT),
    queueDailyStartBudgetState: createQueueDailyStartBudgetState({
      at: PREPARED_AT,
    }),
    authorityGrantStoreState: createAuthorityGrantStoreState(
      new Date(PREPARED_AT),
    ),
    companionBaseUrl: "http://127.0.0.1:9876/",
    browserToolsEnabled: true,
    experienceMemoryEnabled: true,
    defaultBrowserMissionMode: "extract_only" as const,
  };
}

function acknowledgement(
  plan: ExtensionStateMigrationPlanV1,
  namespace: ExtensionNamespace,
  acknowledgedAt: string,
): ExtensionMigrationAcknowledgementV1 {
  return {
    version: 1,
    migrationId: plan.migrationId,
    namespace,
    sourceSnapshotHash: plan.sourceSnapshotHash,
    observedSnapshotHash: plan.namespaces[namespace].snapshotHash,
    acknowledgedAt,
  };
}
