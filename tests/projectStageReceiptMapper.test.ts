import assert from "node:assert/strict";
import test from "node:test";

import { readFileSync } from "node:fs";

import type { ActionReceipt, ResourceRef } from "../src/agent/actions";
import {
  projectStageEventFromActionReceiptV1,
  projectStageEventFromReceiptObservationV1,
} from "../src/agent/projectStageReceiptMapper";
import { canonicalGitCommitShaV1 } from "../src/agent/projectRunReport";
import { resolveVerifiedCommitEvidenceV1 } from "../src/agent/projectStageLineageMapper";

const fp = (character: string) => `sha256:${character.repeat(64)}`;

const COMMIT_SHA = "a".repeat(40);
const REPAIR_CHECKPOINT_ID =
  "code-repair:run-42:workspace-1:request-1";

/**
 * The exact shape extensions/code/repair/CodeRepairToolRuntimeV1.ts emits: the
 * receipt TARGETS the durable repair checkpoint (revision = the checkpoint's
 * sequence number, and observedRevision echoes it), and NAMES the commit it
 * verified as a related Git resource. Fabricating a 40-hex SHA into
 * `resource.id` instead would test a receipt no producer ever writes.
 */
function verifiedCommitReceipt(
  overrides: {
    relatedResources?: ResourceRef[];
    minute?: number;
  } = {},
): ActionReceipt {
  return receipt({
    toolName: "code_commit_verified",
    system: "git",
    resourceType: "verified_local_commit",
    id: REPAIR_CHECKPOINT_ID,
    revision: "1",
    minute: overrides.minute ?? 4,
    relatedResources: overrides.relatedResources ?? [
      {
        system: "workspace",
        resourceType: "workspace",
        id: "workspace-1",
        workspaceId: "workspace-1",
      },
      {
        system: "git",
        resourceType: "commit",
        id: COMMIT_SHA,
        workspaceId: "workspace-1",
        repositoryProfileId: "profile-1",
        revision: COMMIT_SHA,
      },
    ],
  });
}

function receipt(input: {
  toolName: string;
  system?: ResourceRef["system"];
  resourceType?: string;
  id?: string;
  path?: string;
  url?: string;
  revision?: string;
  relatedResources?: ResourceRef[];
  readback?: "verified" | "not_required";
  minute?: number;
}): ActionReceipt {
  const minute = input.minute ?? 1;
  return {
    version: 1,
    id: `receipt-${input.toolName}-${minute}`,
    runId: "run-42",
    actionId: `action-${input.toolName}-${minute}`,
    toolName: input.toolName,
    operation: "update",
    resource: {
      system: input.system ?? "workspace",
      resourceType: input.resourceType ?? "file",
      id: input.id ?? "src/result.ts",
      ...(input.path ? { path: input.path } : {}),
      ...(input.url ? { url: input.url } : {}),
      ...(input.revision ? { revision: input.revision } : {}),
    },
    ...(input.relatedResources
      ? { relatedResources: input.relatedResources }
      : {}),
    message: "Host receipt.",
    payloadFingerprint: fp("a"),
    grantId: "grant-42",
    startedAt: `2026-08-19T12:${String(minute).padStart(2, "0")}:00.000Z`,
    committedAt: `2026-08-19T12:${String(minute).padStart(2, "0")}:01.000Z`,
    commitKind: "committed",
    readback: {
      status: input.readback ?? "verified",
      checkedAt: `2026-08-19T12:${String(minute).padStart(2, "0")}:00.500Z`,
      observedRevision: input.revision ?? "revision-1",
      observedFingerprint: fp("b"),
    },
  };
}

const workUnits = [
  { workUnitId: "work-1", acceptanceCriterionIds: ["AC-1"] },
];

test("receipt mapper classifies implementation and validation/commit without prose", () => {
  const implementation = projectStageEventFromActionReceiptV1({
    receipt: receipt({ toolName: "code_workspace_patch" }),
    workUnits,
  });
  assert.equal(implementation?.phase, "implement");
  assert.equal(implementation?.evidenceKind, "workspace_mutation");
  assert.equal(implementation?.resource.id, "src/result.ts");

  const targeted = projectStageEventFromActionReceiptV1({
    receipt: receipt({ toolName: "code_validate_targeted", minute: 2 }),
    workUnits,
  });
  const full = projectStageEventFromActionReceiptV1({
    receipt: receipt({ toolName: "code_workspace_validate_full", minute: 3 }),
    workUnits,
  });
  const commit = projectStageEventFromActionReceiptV1({
    receipt: verifiedCommitReceipt(),
    workUnits,
  });
  assert.deepEqual(
    [targeted, full, commit].map((event) => [event?.phase, event?.evidenceKind]),
    [
      ["test", "targeted_validation"],
      ["test", "full_validation"],
      ["test", "commit_readback"],
    ],
  );
});

test("receipt mapper can project an exact child receipt into its host-verified root mission", () => {
  const implementation = projectStageEventFromActionReceiptV1({
    receipt: receipt({ toolName: "code_workspace_patch" }),
    runId: "root-project-run",
    workUnits,
  });
  assert.equal(implementation?.runId, "root-project-run");
  assert.equal(implementation?.sourceReceiptId, "receipt-code_workspace_patch-1");
});

test("receipt mapper projects independent GitHub and reflection readbacks", () => {
  const repository = projectStageEventFromActionReceiptV1({
    receipt: receipt({
      toolName: "github_repository_readback",
      system: "github",
      resourceType: "repository",
      id: "acme/project",
      url: "https://github.com/acme/project",
      minute: 5,
    }),
    workUnits,
  });
  const pullRequest = projectStageEventFromActionReceiptV1({
    receipt: receipt({
      toolName: "publish_verified_code_to_github",
      system: "github",
      resourceType: "pull_request",
      id: "acme/project#7",
      url: "https://github.com/acme/project/pull/7",
      minute: 6,
    }),
    workUnits,
  });
  const reflection = projectStageEventFromActionReceiptV1({
    receipt: receipt({
      toolName: "append_jupyter_reflection",
      system: "vault",
      resourceType: "notebook",
      id: "Results/final.ipynb",
      path: "Results/final.ipynb",
      minute: 7,
    }),
    workUnits,
  });
  assert.deepEqual(
    [repository, pullRequest, reflection].map((event) => [
      event?.phase,
      event?.evidenceKind,
    ]),
    [
      ["github", "github_repository_readback"],
      ["github", "github_draft_pr_readback"],
      ["reflect", "reflection_writeback"],
    ],
  );
});

test("verified blocker observation becomes a blocked event in the mapped phase", () => {
  const blocker = projectStageEventFromReceiptObservationV1({
    schemaVersion: 1,
    runId: "run-42",
    receiptId: "blocker-readback-42",
    toolName: "code_validate_full",
    committedAt: "2026-08-19T12:08:00.000Z",
    payloadFingerprint: fp("c"),
    readbackStatus: "verified",
    observedFingerprint: fp("d"),
    outcome: "blocked",
    resource: {
      system: "workspace",
      resourceType: "validation",
      id: "full-validation",
      url: null,
      path: null,
      revision: null,
    },
    workUnits,
  });
  assert.equal(blocker?.phase, "test");
  assert.equal(blocker?.evidenceKind, "actionable_blocker");
  assert.equal(blocker?.disposition, "blocked");
  assert.equal(blocker?.evidenceFingerprint, fp("d"));
});

test("unverified and unsupported receipts produce no stage evidence", () => {
  assert.equal(
    projectStageEventFromActionReceiptV1({
      receipt: receipt({
        toolName: "code_workspace_patch",
        readback: "not_required",
      }),
      workUnits,
    }),
    null,
  );
  assert.equal(
    projectStageEventFromActionReceiptV1({
      receipt: receipt({ toolName: "model_claimed_success" }),
      workUnits,
    }),
    null,
  );
  assert.equal(
    projectStageEventFromReceiptObservationV1({
      schemaVersion: 1,
      runId: "run-42",
      receiptId: "unverified-blocker-42",
      toolName: "code_validate_full",
      committedAt: "2026-08-19T12:09:00.000Z",
      payloadFingerprint: fp("e"),
      readbackStatus: "unverified",
      observedFingerprint: null,
      outcome: "blocked",
      resource: {
        system: "workspace",
        resourceType: "validation",
        id: "full-validation",
        url: null,
        path: null,
        revision: null,
      },
      workUnits,
    }),
    null,
  );
});

/**
 * The producer keeps the checkpoint as the receipt's target because
 * reconciliation, the idempotency key, and the prepared-action id all derive
 * from it. Naming the commit must therefore be additive: the projection reads
 * the related Git commit, and nothing about the checkpoint identity moves.
 */
test("a verified commit receipt names its commit without moving its checkpoint target", () => {
  const source = verifiedCommitReceipt();
  assert.equal(source.resource.id, REPAIR_CHECKPOINT_ID);
  assert.equal(source.resource.revision, "1");
  assert.equal(source.readback.observedRevision, "1");

  const commit = projectStageEventFromActionReceiptV1({
    receipt: source,
    workUnits,
  });
  assert.equal(commit?.evidenceKind, "commit_readback");
  assert.equal(commit?.resource.system, "git");
  assert.equal(commit?.resource.resourceType, "commit");
  assert.equal(commit?.resource.id, COMMIT_SHA);
  assert.equal(commit?.resource.revision, COMMIT_SHA);
  assert.equal(
    canonicalGitCommitShaV1(commit?.resource.revision ?? commit?.resource.id),
    COMMIT_SHA,
    "the checkpoint sequence number must never reach a commit-SHA consumer",
  );
  assert.equal(commit?.sourceReceiptId, source.id);
});

/**
 * A run whose durable lineage begins at accepted_research has no code stage,
 * so the receipt is the only subsystem that can name the commit. That is the
 * whole point of carrying it.
 */
test("receipt evidence alone names the verified commit with no code lineage", () => {
  const commit = projectStageEventFromActionReceiptV1({
    receipt: verifiedCommitReceipt(),
    workUnits,
  });
  assert.ok(commit);
  const evidence = resolveVerifiedCommitEvidenceV1({
    acceptedRunIds: new Set(["run-42"]),
    events: [commit],
    lineages: [],
  });
  assert.equal(evidence.commitAttested, true);
  assert.equal(evidence.commitSha, COMMIT_SHA);
  assert.equal(evidence.lineageCommit, null);
  assert.equal(evidence.repositoryProfileKey, null);
});

/**
 * Fail-closed both ways. Evidence that names no Git object id anywhere still
 * refuses to produce one, and a related resource that only claims to be a
 * commit is not trusted into that role.
 */
test("commit evidence that names no Git object id is still refused", () => {
  const withoutCommit = projectStageEventFromActionReceiptV1({
    receipt: verifiedCommitReceipt({ relatedResources: [] }),
    workUnits,
  });
  assert.equal(withoutCommit?.resource.id, REPAIR_CHECKPOINT_ID);
  assert.equal(withoutCommit?.resource.revision, "1");
  assert.equal(
    resolveVerifiedCommitEvidenceV1({
      acceptedRunIds: new Set(["run-42"]),
      events: [withoutCommit!],
      lineages: [],
    }).commitSha,
    null,
  );

  for (const impostor of [
    { system: "git", resourceType: "commit", id: "HEAD" },
    { system: "git", resourceType: "commit", id: "1" },
    { system: "git", resourceType: "repository", id: COMMIT_SHA },
    {
      system: "git",
      resourceType: "commit",
      id: COMMIT_SHA,
      revision: "b".repeat(40),
    },
  ] satisfies ResourceRef[]) {
    const event = projectStageEventFromActionReceiptV1({
      receipt: verifiedCommitReceipt({ relatedResources: [impostor] }),
      workUnits,
    });
    assert.equal(
      event?.resource.id,
      REPAIR_CHECKPOINT_ID,
      `${JSON.stringify(impostor)} must not be read as the verified commit`,
    );
    assert.equal(
      resolveVerifiedCommitEvidenceV1({
        acceptedRunIds: new Set(["run-42"]),
        events: [event!],
        lineages: [],
      }).commitSha,
      null,
    );
  }
});

/**
 * A receipt whose own target already IS a Git object id keeps addressing it.
 * The related-commit lookup is a fallback for receipts that address something
 * else, never an override.
 */
test("a receipt that already targets a Git object id keeps that target", () => {
  const direct = projectStageEventFromActionReceiptV1({
    receipt: receipt({
      toolName: "code_commit_verified",
      system: "git",
      resourceType: "commit",
      id: COMMIT_SHA,
      revision: COMMIT_SHA,
      minute: 8,
      relatedResources: [
        {
          system: "git",
          resourceType: "commit",
          id: "b".repeat(40),
          revision: "b".repeat(40),
        },
      ],
    }),
    workUnits,
  });
  assert.equal(direct?.resource.id, COMMIT_SHA);
  assert.equal(direct?.resource.revision, COMMIT_SHA);
});

/**
 * Source-level guard, deliberately not behavioural. AgentRunner replays the
 * SAME immutable receipt out of the persisted ledger; when it kept a private
 * copy of this mapping the live projection and the replay could name different
 * resources for one commit, and the disagreement is only observable once they
 * have already drifted.
 */
test("the persisted-receipt replay shares one resource projection", () => {
  const text = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    text,
    /projectResourceFromReceiptResourcesV1/u,
    "AgentRunner must project receipt resources through the shared mapper.",
  );
  assert.doesNotMatch(
    text,
    /receipt\.readback\.observedRevision \?\? receipt\.resource\.revision/u,
    "AgentRunner re-inlined the receipt resource mapping. Use " +
      "projectResourceFromReceiptResourcesV1 so the live receipt and its " +
      "persisted replay stay one implementation.",
  );
});
