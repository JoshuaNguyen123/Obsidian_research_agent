import assert from "node:assert/strict";
import test from "node:test";

import {
  createAcceptedResearchArtifactV1,
  parseAcceptedResearchArtifactV1,
  type AcceptedResearchArtifactV1Unsigned,
} from "../src/integrations/linear/AcceptedResearchArtifactV1";
import {
  createExternalWorkItemBindingV1,
  parseExternalWorkItemBindingV1,
  type ExternalWorkItemBindingV1Unsigned,
} from "../src/integrations/linear/ExternalWorkItemBindingV1";
import {
  appendWorkItemLineageTransitionV1,
  createWorkItemLineageV1,
  parseWorkItemLineageV1,
  type WorkItemLineageV1Unsigned,
} from "../src/integrations/linear/WorkItemLineageV1";
import {
  createWorkItemSpecV1,
  type WorkItemSpecV1Unsigned,
} from "../src/integrations/linear/WorkItemSpecV1";
import {
  createWorkItemSpecV2,
  migrateWorkItemSpecV1ToV2,
  parseCompatibleWorkItemSpec,
  parseOrMigrateWorkItemSpecV2,
  parseWorkItemSpecV2,
  type WorkItemSpecV2Unsigned,
} from "../src/integrations/linear/WorkItemSpecV2";

const SHA_A = `sha256:${"a".repeat(64)}`;
const SHA_B = `sha256:${"b".repeat(64)}`;
const SHA_C = `sha256:${"c".repeat(64)}`;

const ACCEPTED_RESEARCH: AcceptedResearchArtifactV1Unsigned = {
  schemaVersion: 1,
  artifactId: "research-42",
  originRunId: "run-42",
  vaultBindingKey: "primary-vault",
  notePath: "Research/Agent queues.md",
  noteSha256: SHA_A,
  noteReceiptId: "receipt-note-42",
  evidence: [
    {
      id: "source-1",
      kind: "web",
      reference: "https://example.com/research/queue",
      contentSha256: SHA_B,
    },
  ],
  acceptanceCriteria: [
    { id: "AC-1", text: "Queue state survives a plugin restart." },
  ],
  riskClass: "medium",
  acceptedAt: "2026-07-12T16:00:00.000Z",
  acceptedBy: "host",
};

const WORK_ITEM_V2: WorkItemSpecV2Unsigned = {
  schemaVersion: 2,
  ready: true,
  executionClass: "code",
  objective: "Implement a durable execution queue with bounded retries.",
  repositoryKey: "agentic-researcher",
  acceptanceCriteria: [
    { id: "AC-1", text: "Queue state survives a plugin restart." },
  ],
  validationRequirementKeys: ["unit-tests", "production-build"],
  evidenceRefs: ["https://example.com/research/queue"],
  riskClass: "medium",
  originRunId: "run-42",
  acceptedResearchArtifactFingerprint: SHA_A,
  generation: 0,
};

const EXTERNAL_BINDING: ExternalWorkItemBindingV1Unsigned = {
  schemaVersion: 1,
  bindingId: "linear-eng-42",
  provider: "linear",
  originRunId: "run-42",
  workspaceId: "workspace-1",
  teamId: "team-1",
  issueId: "issue-42",
  issueIdentifier: "ENG-42",
  issueUrl: "https://linear.app/acme/issue/ENG-42/durable-queue",
  issueUpdatedAt: "2026-07-12T16:01:00.000Z",
  workItemFingerprint: SHA_B,
  acceptedResearchArtifactFingerprint: SHA_A,
  verifiedAt: "2026-07-12T16:01:01.000Z",
};

test("accepted research artifacts require host acceptance, note proof, evidence, and canonical hashes", () => {
  const artifact = createAcceptedResearchArtifactV1(ACCEPTED_RESEARCH);
  assert.match(artifact.artifactFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    parseAcceptedResearchArtifactV1(JSON.parse(JSON.stringify(artifact))),
    artifact,
  );
  assert.throws(
    () => parseAcceptedResearchArtifactV1({ ...artifact, noteSha256: SHA_C }),
    /fingerprint/i,
  );
  assert.throws(
    () => createAcceptedResearchArtifactV1({ ...ACCEPTED_RESEARCH, notePath: "../Secrets.md" }),
    /vault-relative/i,
  );
  assert.throws(
    () => createAcceptedResearchArtifactV1({
      ...ACCEPTED_RESEARCH,
      acceptedBy: "model" as "host",
    }),
    /host-accepted/i,
  );
  assert.throws(
    () => createAcceptedResearchArtifactV1({
      ...ACCEPTED_RESEARCH,
      acceptanceCriteria: [{ id: "AC-1", text: "Run npm install --force" }],
    }),
    /raw filesystem paths|shell commands/i,
  );
});

test("work item v2 uses only logical authority bindings and canonical fingerprints", () => {
  const spec = createWorkItemSpecV2(WORK_ITEM_V2);
  assert.match(spec.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseWorkItemSpecV2(JSON.parse(JSON.stringify(spec))), spec);
  const reordered = createWorkItemSpecV2({
    generation: 0,
    acceptedResearchArtifactFingerprint: SHA_A,
    originRunId: "run-42",
    riskClass: "medium",
    evidenceRefs: ["https://example.com/research/queue"],
    validationRequirementKeys: ["unit-tests", "production-build"],
    acceptanceCriteria: [
      { text: "Queue state survives a plugin restart.", id: "AC-1" },
    ],
    repositoryKey: "agentic-researcher",
    objective: "Implement a durable execution queue with bounded retries.",
    executionClass: "code",
    ready: true,
    schemaVersion: 2,
  });
  assert.equal(reordered.fingerprint, spec.fingerprint);

  assert.throws(
    () => createWorkItemSpecV2({ ...WORK_ITEM_V2, repositoryKey: "C:\\source\\repo" }),
    /logical binding key/i,
  );
  assert.throws(
    () => createWorkItemSpecV2({ ...WORK_ITEM_V2, objective: "Run npm test before publishing." }),
    /raw filesystem paths|shell commands/i,
  );
  assert.throws(
    () => createWorkItemSpecV2({ ...WORK_ITEM_V2, objective: "Update src/queue/worker.ts." }),
    /raw filesystem paths|shell commands/i,
  );
  assert.doesNotThrow(() => createWorkItemSpecV2({
    ...WORK_ITEM_V2,
    objective: "Verify Git repository lineage without accepting executable instructions.",
  }));
  assert.throws(
    () => createWorkItemSpecV2({
      ...WORK_ITEM_V2,
      objective: "Use api_key=super-secret-value while publishing.",
    }),
    /credentials or secrets/i,
  );
  assert.throws(
    () => createWorkItemSpecV2({
      ...WORK_ITEM_V2,
      executionClass: "vault",
      repositoryKey: undefined,
      vaultBindingKey: undefined,
    }),
    /omitted rather than undefined|vault work items/i,
  );
});

test("v1 parsing remains compatible and migration requires explicit trusted validation keys", () => {
  const v1Unsigned: WorkItemSpecV1Unsigned = {
    schemaVersion: 1,
    ready: true,
    executionClass: "code",
    objective: "Add a resumable Linear execution queue.",
    repositoryKey: "agentic-researcher",
    acceptanceCriteria: [{ id: "AC-1", text: "Queue state survives restart." }],
    validationRequirements: ["npm test", "npm run build"],
    evidenceRefs: ["https://example.com/research/queue"],
    riskClass: "medium",
    originRunId: "run-42",
    generation: 0,
  };
  const v1 = createWorkItemSpecV1(v1Unsigned);
  assert.deepEqual(parseCompatibleWorkItemSpec(v1), v1);
  assert.throws(() => parseOrMigrateWorkItemSpecV2(v1), /explicit host-approved migration/i);

  const v2 = migrateWorkItemSpecV1ToV2(v1, {
    validationRequirementKeys: ["unit-tests", "production-build"],
    acceptedResearchArtifactFingerprint: SHA_A,
  });
  assert.deepEqual(v2.validationRequirementKeys, ["unit-tests", "production-build"]);
  assert.equal("validationRequirements" in v2, false);
  assert.deepEqual(parseOrMigrateWorkItemSpecV2(v2), v2);
});

test("external Linear bindings pin verified identity and reject stale or non-Linear observations", () => {
  const binding = createExternalWorkItemBindingV1(EXTERNAL_BINDING);
  assert.deepEqual(
    parseExternalWorkItemBindingV1(JSON.parse(JSON.stringify(binding))),
    binding,
  );
  assert.throws(
    () => parseExternalWorkItemBindingV1({ ...binding, issueIdentifier: "ENG-99" }),
    /fingerprint/i,
  );
  assert.throws(
    () => createExternalWorkItemBindingV1({
      ...EXTERNAL_BINDING,
      issueUrl: "https://attacker.example/ENG-42",
    }),
    /linear\.app/i,
  );
  assert.throws(
    () => createExternalWorkItemBindingV1({
      ...EXTERNAL_BINDING,
      verifiedAt: "2026-07-12T15:59:00.000Z",
    }),
    /cannot predate/i,
  );
});

test("code lineage is append-only, receipt-backed, and cannot skip or regress states", () => {
  const unsigned: WorkItemLineageV1Unsigned = {
    schemaVersion: 1,
    lineageId: "lineage-42",
    originRunId: "run-42",
    executionClass: "code",
    workItemFingerprint: SHA_B,
    researchArtifactFingerprint: SHA_A,
    repositoryKey: "agentic-researcher",
    events: [
      {
        sequence: 1,
        state: "accepted_research",
        domain: "research",
        occurredAt: "2026-07-12T16:00:00.000Z",
        receiptId: "receipt-research",
        evidenceFingerprint: SHA_A,
      },
    ],
  };
  const created = createWorkItemLineageV1(unsigned);
  const noted = appendWorkItemLineageTransitionV1(created, {
    state: "note_verified",
    occurredAt: "2026-07-12T16:00:30.000Z",
    receiptId: "receipt-note",
    evidenceFingerprint: SHA_C,
  });
  assert.throws(
    () => appendWorkItemLineageTransitionV1(noted, {
      state: "claimed",
      occurredAt: "2026-07-12T16:01:00.000Z",
      receiptId: "receipt-claim",
      evidenceFingerprint: SHA_C,
    }),
    /expected linear_verified/i,
  );
  assert.throws(
    () => appendWorkItemLineageTransitionV1(noted, {
      state: "linear_verified",
      occurredAt: "2026-07-12T16:01:00.000Z",
      receiptId: "receipt-linear",
      evidenceFingerprint: SHA_B,
    }),
    /requires an external/i,
  );
  const linear = appendWorkItemLineageTransitionV1(noted, {
    state: "linear_verified",
    occurredAt: "2026-07-12T16:01:00.000Z",
    receiptId: "receipt-linear",
    evidenceFingerprint: SHA_B,
    externalWorkItemBindingFingerprint: SHA_B,
  });
  assert.equal(linear.externalWorkItemBindingFingerprint, SHA_B);
  assert.deepEqual(parseWorkItemLineageV1(JSON.parse(JSON.stringify(linear))), linear);
  assert.throws(
    () => appendWorkItemLineageTransitionV1(linear, {
      state: "claimed",
      occurredAt: "2026-07-12T15:00:00.000Z",
      receiptId: "receipt-claim",
      evidenceFingerprint: SHA_C,
    }),
    /backwards/i,
  );

  let completed = linear;
  const remaining = [
    "claimed",
    "workspace_ready",
    "local_verified",
    "push_prepared",
    "pushed_verified",
    "draft_pr_verified",
    "checks_pending",
    "review_or_merge_ready",
    "merge_prepared",
    "merged_verified",
    "finalized",
  ] as const;
  for (const [index, state] of remaining.entries()) {
    completed = appendWorkItemLineageTransitionV1(completed, {
      state,
      occurredAt: new Date(Date.parse("2026-07-12T16:02:00.000Z") + index * 1_000).toISOString(),
      receiptId: `receipt-${state}`,
      evidenceFingerprint: SHA_C,
    });
  }
  assert.equal(completed.events.at(-1)?.state, "finalized");
  assert.equal(completed.events.find((event) => event.state === "workspace_ready")?.domain, "code");
  assert.equal(completed.events.find((event) => event.state === "draft_pr_verified")?.domain, "github");
  assert.throws(
    () => appendWorkItemLineageTransitionV1(completed, {
      state: "finalized",
      occurredAt: "2026-07-12T17:00:00.000Z",
      receiptId: "receipt-after-final",
      evidenceFingerprint: SHA_C,
    }),
    /no further state/i,
  );
});

test("human lineage stops at Linear verification and never gains execution authority", () => {
  let lineage = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: "lineage-human",
    originRunId: "run-human",
    executionClass: "human",
    workItemFingerprint: SHA_B,
    researchArtifactFingerprint: SHA_A,
    events: [
      {
        sequence: 1,
        state: "accepted_research",
        domain: "research",
        occurredAt: "2026-07-12T16:00:00.000Z",
        receiptId: "receipt-human-research",
        evidenceFingerprint: SHA_A,
      },
    ],
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "note_verified",
    occurredAt: "2026-07-12T16:00:10.000Z",
    receiptId: "receipt-human-note",
    evidenceFingerprint: SHA_C,
  });
  lineage = appendWorkItemLineageTransitionV1(lineage, {
    state: "linear_verified",
    occurredAt: "2026-07-12T16:00:20.000Z",
    receiptId: "receipt-human-linear",
    evidenceFingerprint: SHA_B,
    externalWorkItemBindingFingerprint: SHA_B,
  });
  assert.throws(
    () => appendWorkItemLineageTransitionV1(lineage, {
      state: "claimed",
      occurredAt: "2026-07-12T16:00:30.000Z",
      receiptId: "receipt-human-claim",
      evidenceFingerprint: SHA_C,
    }),
    /no further state/i,
  );
});
