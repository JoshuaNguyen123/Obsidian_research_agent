import assert from "node:assert/strict";
import test from "node:test";

import {
  BUNDLED_COMPOUND_BOUND_PREVIEW_TOOL_NAME,
  isBundledApprovalRequest,
} from "../src/agent/approvalBroker";
import {
  boundMayAutoUnderBundledGrant,
  buildBundledApprovalPreview,
  bundledPreviewToApprovalRequest,
  consumeBundledStageGrant,
  evaluateBundledApprovalGate,
  issueBundledStageGrant,
  partitionToolsForBundledApproval,
  shouldOfferBundledApprovalPreview,
} from "../src/agent/bundledApprovalPreview";
import { createBundledCompoundAuthorityGrant } from "../src/agent/authority";
import {
  boundMayAutoWithoutChatGrant,
  boundMayAutoWithoutGrant,
} from "../src/agent/setLooseCompoundAutonomy";
import { effectClassForTool } from "../src/agent/autonomyEffectClass";

const COMPOUND_STAGES = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
] as const;

test("partitionToolsForBundledApproval separates Bound from Hard", () => {
  const partitioned = partitionToolsForBundledApproval([
    "web_search",
    "linear_create_issue",
    "code_commit_verified",
    "publish_verified_code_to_github",
    "github_merge_pull_request",
    "linear_trash_issue",
    "github_delete_private_repository",
  ]);
  assert.deepEqual(partitioned.soft, ["web_search"]);
  assert.ok(partitioned.bound.includes("linear_create_issue"));
  assert.ok(partitioned.bound.includes("code_commit_verified"));
  assert.ok(partitioned.bound.includes("publish_verified_code_to_github"));
  assert.deepEqual(
    [...partitioned.hard].sort(),
    [
      "github_delete_private_repository",
      "github_merge_pull_request",
      "linear_trash_issue",
    ].sort(),
  );
});

test("buildBundledApprovalPreview seeds Bound families and excludes Hard", async () => {
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-1",
    stages: [...COMPOUND_STAGES, "reconciliation_cleanup"],
    toolNames: [
      "publish_research_to_linear",
      "linear_create_issue",
      "code_workspace_create",
      "code_validate_fast",
      "code_commit_verified",
      "github_create_repository",
      "publish_verified_code_to_github",
      "github_merge_pull_request",
      "github_delete_private_repository",
    ],
    now: new Date("2026-07-22T18:00:00.000Z"),
  });

  assert.equal(preview.version, 1);
  assert.equal(preview.runId, "run-bundle-1");
  assert.match(preview.bundleFingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.ok(preview.items.length >= 4);
  assert.ok(
    preview.items.every((item) => item.effectClass === "bound"),
    "preview items must be Bound only",
  );
  assert.ok(
    preview.hardExcluded.some((item) => item.toolName === "github_merge_pull_request"),
  );
  assert.ok(
    preview.hardExcluded.some(
      (item) => item.toolName === "github_delete_private_repository",
    ),
  );
  assert.ok(
    !preview.familyFingerprints.some((fp) => /merge|trash|delete|cleanup/i.test(fp)),
  );
});

test("one approved bundle allows related Bound steps and still blocks Hard", async () => {
  const t0 = new Date();
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-2",
    stages: [...COMPOUND_STAGES],
    now: t0,
  });
  const grant = issueBundledStageGrant({
    preview,
    userApproved: true,
    now: t0,
  });

  assert.equal(
    evaluateBundledApprovalGate({
      grant,
      toolName: "linear_create_issue",
      now: t0,
    }).decision,
    "allow_under_bundle",
  );
  assert.equal(
    evaluateBundledApprovalGate({
      grant,
      toolName: "linear_update_issue",
      now: t0,
    }).decision,
    "allow_under_bundle",
    "closely related Linear Bound action should reuse the family grant",
  );
  assert.equal(
    evaluateBundledApprovalGate({
      grant,
      toolName: "code_commit_verified",
      now: t0,
    }).decision,
    "allow_under_bundle",
  );
  assert.equal(
    evaluateBundledApprovalGate({
      grant,
      toolName: "publish_verified_code_to_github",
      now: t0,
    }).decision,
    "allow_under_bundle",
  );

  const hardGate = evaluateBundledApprovalGate({
    grant,
    toolName: "github_merge_pull_request",
    now: t0,
  });
  assert.equal(hardGate.decision, "require_exact");
  assert.equal(hardGate.effectClass, "hard");
  assert.equal(effectClassForTool("github_merge_pull_request"), "hard");

  assert.equal(
    boundMayAutoUnderBundledGrant({
      toolName: "linear_create_issue",
      grant,
      now: t0,
    }),
    true,
  );
  assert.equal(
    boundMayAutoUnderBundledGrant({
      toolName: "github_delete_private_repository",
      grant,
      now: t0,
    }),
    false,
  );
  assert.equal(
    boundMayAutoUnderBundledGrant({
      toolName: "linear_trash_issue",
      grant,
      now: t0,
    }),
    false,
  );
});

test("consumeBundledStageGrant tracks Bound usage and never covers Hard", async () => {
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-3",
    stages: ["linear_hierarchy", "code_execution"],
    toolNames: ["linear_create_issue", "code_commit_verified"],
    now: new Date("2026-07-22T18:00:00.000Z"),
    ttlMs: 60_000,
  });
  let grant = issueBundledStageGrant({
    preview,
    userApproved: true,
    maxBoundActions: 2,
    now: new Date("2026-07-22T18:00:01.000Z"),
  });

  const first = consumeBundledStageGrant({
    grant,
    toolName: "linear_create_issue",
    now: new Date("2026-07-22T18:00:02.000Z"),
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  grant = first.grant;
  assert.equal(grant.boundActionsUsed, 1);

  const hard = consumeBundledStageGrant({
    grant,
    toolName: "linear_trash_issue",
    now: new Date("2026-07-22T18:00:03.000Z"),
  });
  assert.equal(hard.ok, false);
  assert.match(hard.reason, /hard_effect_excluded/);

  const second = consumeBundledStageGrant({
    grant,
    toolName: "code_commit_verified",
    now: new Date("2026-07-22T18:00:04.000Z"),
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;
  assert.equal(second.grant.state, "exhausted");
  assert.equal(second.grant.boundActionsUsed, 2);
});

test("bundledPreviewToApprovalRequest is recognizable by the broker helper", async () => {
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-4",
    stages: ["linear_hierarchy"],
    now: new Date("2026-07-22T18:00:00.000Z"),
  });
  const request = {
    ...bundledPreviewToApprovalRequest(preview),
    id: "approval-1",
    expiresAtMs: Date.now() + 60_000,
  };
  assert.equal(request.toolName, BUNDLED_COMPOUND_BOUND_PREVIEW_TOOL_NAME);
  assert.equal(request.bundleFingerprint, preview.bundleFingerprint);
  assert.equal(isBundledApprovalRequest(request), true);
  assert.match(request.reason, /approve once/i);
  assert.match(request.reason, /separate exact confirmation/i);
});

test("boundMayAutoWithoutChatGrant preserves exact approval for Linear mutations and blocks Hard", async () => {
  const t0 = new Date();
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-5",
    stages: [...COMPOUND_STAGES],
    now: t0,
  });
  const grant = issueBundledStageGrant({
    preview,
    userApproved: true,
    now: t0,
  });

  // A family-level bundle is not an exact prepared-action approval for an
  // externally visible Linear mutation.
  assert.equal(
    boundMayAutoWithoutGrant({
      toolName: "linear_create_issue",
      autonomyProfile: "conservative",
      compoundLifecycleDetected: true,
    }),
    false,
  );
  assert.equal(
    boundMayAutoWithoutChatGrant({
      toolName: "linear_create_issue",
      autonomyProfile: "conservative",
      compoundLifecycleDetected: true,
      bundledGrant: grant,
      now: t0,
    }),
    false,
  );
  assert.equal(
    boundMayAutoWithoutChatGrant({
      toolName: "github_merge_pull_request",
      autonomyProfile: "automatic",
      compoundLifecycleDetected: true,
      bundledGrant: grant,
      now: t0,
    }),
    false,
  );
});

test("shouldOfferBundledApprovalPreview is once-per-active-grant", async () => {
  assert.equal(
    shouldOfferBundledApprovalPreview({
      compoundLifecycleDetected: true,
      stages: [...COMPOUND_STAGES],
    }),
    true,
  );
  assert.equal(
    shouldOfferBundledApprovalPreview({
      compoundLifecycleDetected: false,
      stages: [...COMPOUND_STAGES],
    }),
    false,
  );

  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-6",
    stages: [...COMPOUND_STAGES],
    now: new Date("2026-07-22T18:00:00.000Z"),
  });
  const grant = issueBundledStageGrant({
    preview,
    userApproved: true,
    now: new Date("2026-07-22T18:00:01.000Z"),
  });
  assert.equal(
    shouldOfferBundledApprovalPreview({
      compoundLifecycleDetected: true,
      stages: [...COMPOUND_STAGES],
      existingGrant: grant,
      now: new Date("2026-07-22T18:00:02.000Z"),
    }),
    false,
  );
});

test("createBundledCompoundAuthorityGrant mints Linear/GitHub rules without deletes", async () => {
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-7",
    stages: [...COMPOUND_STAGES],
    now: new Date("2026-07-22T18:00:00.000Z"),
  });
  const grant = await createBundledCompoundAuthorityGrant({
    id: "authority-bundle-7",
    preview,
    userApproved: true,
    teamId: "team-1",
    projectId: "project-1",
    repositoryProfileId: "repo-profile-1",
    issuedAt: new Date("2026-07-22T18:00:01.000Z"),
  });
  assert.ok(grant);
  assert.equal(grant!.kind, "run_bounded");
  assert.equal(grant!.limits.maxDeletes, 0);
  assert.ok(grant!.rules.some((rule) => rule.system === "linear"));
  assert.ok(grant!.rules.some((rule) => rule.system === "github"));
  assert.ok(
    grant!.rules.every((rule) => !rule.actions.includes("delete")),
    "Hard delete actions must not appear in bundled authority rules",
  );
  assert.ok(
    grant!.rules.every((rule) => !rule.actions.includes("trash")),
    "Hard trash actions must not appear in bundled authority rules",
  );
  assert.ok(
    grant!.rules.every((rule) => !rule.actions.includes("merge")),
    "Hard merge actions must not appear in bundled authority rules",
  );
});

test("createBundledCompoundAuthorityGrant returns null without concrete selectors", async () => {
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-8",
    stages: ["code_execution"],
    toolNames: ["code_commit_verified"],
    now: new Date("2026-07-22T18:00:00.000Z"),
  });
  const grant = await createBundledCompoundAuthorityGrant({
    id: "authority-bundle-8",
    preview,
    userApproved: true,
  });
  assert.equal(grant, null);
});
