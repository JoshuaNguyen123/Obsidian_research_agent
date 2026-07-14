import assert from "node:assert/strict";
import test from "node:test";
import {
  buildHeadlessExecutorCatalogV1,
  createSecretLeaseV1,
  InMemorySecretStoreV1,
  INSTALLED_HEADLESS_EXECUTOR_IDS_V1,
  parseHeadlessExecutorCatalogConfigV1,
  type BackgroundExecutionDomainV1,
  type CompanionJobV1,
  type HeadlessDomainExecutorV1,
} from "../packages/headless-runtime/src";
import type { SecretStoreHealthV1 } from "../packages/core-api/src/secretStoreV1";

const NOW = "2026-07-13T12:00:00.000Z";
const CREDENTIAL = "credential-material-that-must-never-persist-123456789";
const CREDENTIAL_REFERENCE = "credential_reference-12345678";

test("the installed executor catalog is closed and contains no dynamic module ids", () => {
  const config = fullCatalog();
  assert.deepEqual(parseHeadlessExecutorCatalogConfigV1(config), config);
  assert.throws(
    () =>
      parseHeadlessExecutorCatalogConfigV1({
        ...config,
        module: "./execute-arbitrary-code.js",
      }),
    /unknown or missing fields/u,
  );
  assert.throws(
    () =>
      parseHeadlessExecutorCatalogConfigV1({
        version: 1,
        executors: { github: "dynamic_graphql_module" },
      }),
    /Unknown installed github executor/u,
  );
});

test("code, Linear, and GitHub executors accept only one fixed bounded operation", async () => {
  const observedCredentials: string[] = [];
  const secretStore = persistentSecretStore();
  const catalog = buildHeadlessExecutorCatalogV1(fullCatalog(), {
    secretStore,
    publicResearchFetch: {
      requestPinned: async () => new Response("unused"),
      resolveHost: async () => ["203.0.113.1"],
    },
    linearReadIssue: async ({ issueId }, credential) => {
      observedCredentials.push(credential);
      return {
        id: issueId,
        identifier: "ENG-42",
        title: "Bounded issue readback",
        updatedAt: NOW,
        url: "https://linear.app/example/issue/ENG-42",
        state: { id: "state-1", name: "In Progress" },
      };
    },
    githubReadRepository: async ({ owner, repository }, credential) => {
      observedCredentials.push(credential);
      return {
        id: 42,
        nodeId: "R_kgDOExample",
        fullName: `${owner}/${repository}`,
        defaultBranch: "main",
        private: true,
        archived: false,
        updatedAt: NOW,
      };
    },
    now: () => new Date(NOW),
  });

  const code = await execute(catalog.code!, job("code", "code_workspace_status", {
    workspaceId: "workspace-42",
    manifestFingerprint: fp("a"),
    repositoryBindingFingerprint: fp("b"),
  }));
  assert.equal(code.status, "complete");
  assert.equal(code.receipts?.[0]?.operation, "verified_code_manifest_readback");

  const linear = await execute(catalog.linear!, job("linear", "linear_get_issue", {
    issueId: "issue-42",
    credentialReferenceId: CREDENTIAL_REFERENCE,
  }));
  assert.equal(linear.status, "complete");
  assert.equal(linear.receipts?.[0]?.operation, "linear_issue_readback");

  const github = await execute(catalog.github!, job("github", "github_get_repository", {
    owner: "example-owner",
    repository: "example-repository",
    credentialReferenceId: CREDENTIAL_REFERENCE,
  }));
  assert.equal(github.status, "complete");
  assert.equal(github.receipts?.[0]?.operation, "github_repository_readback");
  assert.deepEqual(observedCredentials, [CREDENTIAL, CREDENTIAL]);

  const serialized = JSON.stringify({ linear, github, secretStore });
  assert.equal(serialized.includes(CREDENTIAL), false);
  assert.equal(serialized.includes("Authorization"), false);

  for (const [domain, executor] of [
    ["code", catalog.code!],
    ["linear", catalog.linear!],
    ["github", catalog.github!],
  ] as const) {
    const rejected = await execute(
      executor,
      job(domain, "arbitrary_rest_or_command", {}),
    );
    assert.equal(rejected.status, "blocked");
    assert.equal(rejected.blocker?.code, "executor_scope_mismatch");
  }
});

test("credentialed background reads block when only session-memory secrets exist", async () => {
  const foregroundStore = new InMemorySecretStoreV1({
    now: () => new Date(NOW),
    randomBytes: (length) => new Uint8Array(length).fill(7),
  });
  const secret = await foregroundStore.put({
    value: CREDENTIAL,
    label: "foreground only",
  });
  let providerCalls = 0;
  const catalog = buildHeadlessExecutorCatalogV1(fullCatalog(), {
    secretStore: foregroundStore,
    publicResearchFetch: {
      requestPinned: async () => new Response("unused"),
      resolveHost: async () => ["203.0.113.1"],
    },
    linearReadIssue: async () => {
      providerCalls += 1;
      throw new Error("provider must not run without a persistent backend");
    },
  });
  const result = await execute(catalog.linear!, job("linear", "linear_get_issue", {
    issueId: "issue-42",
    credentialReferenceId: secret.referenceId,
  }));
  assert.equal(result.status, "blocked");
  assert.equal(
    result.blocker?.code,
    "secure_persistent_credential_backend_required",
  );
  assert.equal(providerCalls, 0);
  assert.equal(JSON.stringify(result).includes(CREDENTIAL), false);
});

test("Linear queue readback independently verifies project and signed contract fingerprints", async () => {
  let driftContract = false;
  const catalog = buildHeadlessExecutorCatalogV1(fullCatalog(), {
    secretStore: persistentSecretStore(),
    publicResearchFetch: {
      requestPinned: async () => new Response("unused"),
      resolveHost: async () => ["203.0.113.1"],
    },
    linearReadIssue: async ({ issueId }) => ({
      id: issueId,
      identifier: "LIN-QUEUE-1",
      title: "Untrusted title must not enter queue outputs",
      updatedAt: NOW,
      url: null,
      state: { id: "state-triage", name: "Triage" },
      projectId: "project-linear-queue",
      workItemFingerprint: driftContract ? fp("f") : fp("b"),
      snapshotFingerprint: fp("d"),
    }),
    now: () => new Date(NOW),
  });
  const queueJob: CompanionJobV1 = {
    ...job("linear", "linear_get_issue", {
      issueId: "issue-linear-queue",
      credentialReferenceId: CREDENTIAL_REFERENCE,
      projectBindingId: "project-linear-queue",
      contractFingerprint: fp("b"),
      queueCandidateFingerprint: fp("e"),
    }),
    requiredCapabilities: ["linear.issue.read"],
  };

  const completed = await execute(catalog.linear!, queueJob);
  assert.equal(completed.status, "complete");
  assert.deepEqual(completed.outputs, {
    issueId: "issue-linear-queue",
    state: "state-triage",
    candidateFingerprint: fp("e"),
    workItemFingerprint: fp("b"),
    readbackFingerprint: fp("d"),
  });
  assert.equal(JSON.stringify(completed).includes("Untrusted title"), false);
  assert.equal(completed.receipts?.[0]?.payload.candidateFingerprint, fp("e"));

  driftContract = true;
  const blocked = await execute(catalog.linear!, queueJob);
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.blocker?.code, "linear_queue_candidate_changed");
  assert.equal(blocked.receipts?.length ?? 0, 0);
});

function fullCatalog() {
  return {
    version: 1 as const,
    executors: { ...INSTALLED_HEADLESS_EXECUTOR_IDS_V1 },
  };
}

function persistentSecretStore() {
  const health: SecretStoreHealthV1 = {
    version: 1,
    available: true,
    persistent: true,
    backend: "test-os-keyring",
    backgroundEligible: true,
    blocker: null,
  };
  return {
    health: async () => health,
    lease: async (referenceId: string) => {
      assert.equal(referenceId, CREDENTIAL_REFERENCE);
      return createSecretLeaseV1(
        CREDENTIAL,
        {
          version: 1,
          leaseId: "lease_reference-12345678",
          referenceId,
          source: "secure_store_lease",
          persistent: true,
          expiresAt: "2999-01-01T00:00:00.000Z",
        },
        { now: () => new Date(NOW) },
      );
    },
    toJSON: () => ({ redacted: true }),
  };
}

function job(
  domain: BackgroundExecutionDomainV1,
  tool: string,
  inputs: CompanionJobV1["inputs"],
): CompanionJobV1 {
  return {
    version: 1,
    id: `job-${domain}`,
    missionId: "mission-fixed-executors",
    nodeId: `node-${domain}`,
    graphRevision: 0,
    domain,
    executionHost: "headless_runtime",
    state: "queued",
    objective: `Run fixed ${domain} readback.`,
    inputs,
    allowedTools: [tool],
    requiredCapabilities: [`${domain}.read`],
    bindings: [],
    capabilityEnvelopeFingerprint: fp("c"),
    authorization: {
      version: 1,
      grantId: "fixed-readback-grant",
      fingerprint: fp("d"),
      authorizedAt: NOW,
      expiresAt: null,
    },
    idempotencyKey: fp("e"),
    attempts: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

async function execute(executor: HeadlessDomainExecutorV1, value: CompanionJobV1) {
  return executor(value, {
    signal: new AbortController().signal,
    now: () => new Date(NOW),
    reportProgress: async () => undefined,
  });
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
