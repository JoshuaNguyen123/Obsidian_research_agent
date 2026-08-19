import assert from "node:assert/strict";
import test from "node:test";

import type { ActionReceipt, ResourceRef } from "../src/agent/actions";
import {
  projectStageEventFromActionReceiptV1,
  projectStageEventFromReceiptObservationV1,
} from "../src/agent/projectStageReceiptMapper";

const fp = (character: string) => `sha256:${character.repeat(64)}`;

function receipt(input: {
  toolName: string;
  system?: ResourceRef["system"];
  resourceType?: string;
  id?: string;
  path?: string;
  url?: string;
  revision?: string;
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
    receipt: receipt({
      toolName: "code_commit_verified",
      system: "git",
      resourceType: "commit",
      id: "a".repeat(40),
      revision: "a".repeat(40),
      minute: 4,
    }),
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
