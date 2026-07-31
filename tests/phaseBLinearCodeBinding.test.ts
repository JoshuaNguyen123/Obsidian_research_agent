import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalExactLinearIssueReadIdV1,
  filterToolsUntilVerifiedLinearCodeSpecReadbackV1,
  isVerifiedLinearCodeSpecConsumerToolV1,
  requiresVerifiedLinearCodeSpecReadbackV1,
  shouldEvaluateVerifiedLinearCodeRepositoryBindingV1,
  shouldRefreshVerifiedLinearCodeRepositoryBindingOnResumeV1,
} from "../src/AgentRunner";
import {
  decideLinearGetIssueHostBindingV1,
} from "../src/agent/linearIssueBinding";
import {
  missionGraphOnlyFinalSynthesisRemainsV1,
} from "../src/agent/missionGraphSelectors";
import {
  bindTrustedRepositoryWorkspaceCreate,
} from "../src/agent/verifiedWorkspaceBinding";

const ISSUE_ID = "71aa708b-70a1-4b26-9e6f-fb8a9c31a4d2";
const PHASE_B_PROMPT = [
  `Review and implement Linear issue ${ISSUE_ID}.`,
  "Begin with an independent linear_get_issue read of that exact identity and treat its signed accepted-research contract as the sole product specification.",
  "Publish the exact behaviorally tested commit to the issue-bound private GitHub destination as one open draft pull request; never merge it.",
  "Implement the requested Python library in its bound trusted repository and create one verified local commit.",
].join(" ");

test("isolated Phase B withholds every code and GitHub consumer until verified readback", () => {
  assert.equal(
    requiresVerifiedLinearCodeSpecReadbackV1(PHASE_B_PROMPT, [
      "code_execution",
      "private_github_publication",
    ]),
    true,
  );
  const offered = [
    "linear_get_issue",
    "code_sandbox_status",
    "code_workspace_create",
    "code_workspace_create_file",
    "code_workspace_move",
    "code_workspace_trash",
    "code_validate_full",
    "code_validate_commit_prepared",
    "code_commit_verified",
    "run_code_block",
    "write_workspace_file",
    "github_get_repository",
    "github_publish_verified_branch",
    "github_update_owned_branch",
    "github_enable_auto_merge",
    "github_delete_private_repository",
    "github_create_private_repository",
    "publish_verified_code_to_github",
    "finalize_github_links_in_obsidian",
    "append_to_current_file",
  ];
  assert.deepEqual(
    filterToolsUntilVerifiedLinearCodeSpecReadbackV1({
      toolNames: offered,
      required: true,
      verified: false,
    }),
    ["linear_get_issue", "append_to_current_file"],
  );
  assert.deepEqual(
    filterToolsUntilVerifiedLinearCodeSpecReadbackV1({
      toolNames: offered,
      required: true,
      verified: true,
    }),
    offered,
  );
  for (const toolName of offered.filter(
    (name) => name !== "linear_get_issue" && name !== "append_to_current_file",
  )) {
    assert.equal(
      isVerifiedLinearCodeSpecConsumerToolV1(toolName),
      true,
      `${toolName} must not bypass the verified Linear readback gate`,
    );
  }
});

test("explicit existing-issue authority fails closed even when lifecycle routing misses code", () => {
  assert.equal(
    requiresVerifiedLinearCodeSpecReadbackV1(PHASE_B_PROMPT, []),
    true,
  );
});

test("explicit Phase B issue identity host-binds linear_get_issue", () => {
  assert.deepEqual(
    decideLinearGetIssueHostBindingV1({
      dependencyToolNames: [],
      context: {},
      messages: [],
      durableReceipts: [],
      setLooseCompoundEnabled: true,
      linearDeliveryPaid: false,
      activeIntentPrompt: PHASE_B_PROMPT,
    }),
    {
      action: "bind",
      issueId: ISSUE_ID,
      source: "explicit_mission_identity",
    },
  );
});

test("verified Linear repository authority overrides scratch and raw-root model arguments", () => {
  const bound = bindTrustedRepositoryWorkspaceCreate(
    {
      name: "code_workspace_create",
      arguments: {
        workspaceId: "phase-b-workspace",
        kind: "scratch",
        repositoryProfileKey: "model-invented",
        repositoryRoot: "C:\\untrusted\\path",
      },
    },
    PHASE_B_PROMPT,
    ["byok-autonomous-python", "other-profile"],
    "byok-autonomous-python",
  );
  assert.deepEqual(bound?.arguments, {
    workspaceId: "phase-b-workspace",
    kind: "repository",
    repositoryProfileKey: "byok-autonomous-python",
  });
});

test("ordinary scratch delivery remains unchanged without an existing Linear handoff", () => {
  assert.equal(
    requiresVerifiedLinearCodeSpecReadbackV1(
      "Build a Python script in a new Desktop folder and test it.",
      ["code_execution"],
    ),
    false,
  );
  assert.equal(
    bindTrustedRepositoryWorkspaceCreate(
      {
        name: "code_workspace_create",
        arguments: { kind: "scratch" },
      },
      "Build a Python script in a new Desktop folder and test it.",
      ["byok-autonomous-python"],
    ),
    null,
  );
});

test("a failed duplicate Linear read cannot revoke an established repository binding", () => {
  assert.equal(
    shouldEvaluateVerifiedLinearCodeRepositoryBindingV1({
      toolName: "linear_get_issue",
      resultOk: false,
      required: true,
    }),
    false,
  );
  assert.equal(
    shouldEvaluateVerifiedLinearCodeRepositoryBindingV1({
      toolName: "linear_get_issue",
      resultOk: true,
      required: true,
    }),
    true,
  );
  assert.equal(
    shouldEvaluateVerifiedLinearCodeRepositoryBindingV1({
      toolName: "code_workspace_mkdir",
      resultOk: true,
      required: true,
    }),
    false,
  );
});

test("a continuation re-establishes repository authority only through a fresh exact read-only Linear read", () => {
  const eligible = {
    isContinuation: true,
    required: true,
    verified: false,
    exactIssueIdentity: ISSUE_ID,
    linearGetIssueInstalled: true,
    linearGetIssueReadOnly: true,
  };
  assert.equal(
    shouldRefreshVerifiedLinearCodeRepositoryBindingOnResumeV1(eligible),
    true,
  );
  for (const unsafe of [
    { ...eligible, isContinuation: false },
    { ...eligible, required: false },
    { ...eligible, verified: true },
    { ...eligible, exactIssueIdentity: null },
    { ...eligible, linearGetIssueInstalled: false },
    { ...eligible, linearGetIssueReadOnly: false },
  ]) {
    assert.equal(
      shouldRefreshVerifiedLinearCodeRepositoryBindingOnResumeV1(unsafe),
      false,
    );
  }
});

test("a mistranscribed linear_get_issue id is replaced with the exact mission identity until the contract read verifies", () => {
  const eligible = {
    toolName: "linear_get_issue",
    required: true,
    verified: false,
    exactIssueIdentity: ISSUE_ID,
    echoedIssueId: "71aa708b-70a1-4b26-9e6f-fb8a9c31a4d3",
  };
  assert.equal(canonicalExactLinearIssueReadIdV1(eligible), ISSUE_ID);
  assert.equal(
    canonicalExactLinearIssueReadIdV1({ ...eligible, echoedIssueId: null }),
    ISSUE_ID,
    "a missing id argument must also resolve to the exact mission identity",
  );
  assert.equal(
    canonicalExactLinearIssueReadIdV1({
      ...eligible,
      echoedIssueId: ISSUE_ID.toUpperCase(),
    }),
    null,
    "a case-variant echo of the exact identity needs no replacement",
  );
});

test("a resumed graph holding only the final node steers the loop to synthesis", () => {
  const node = (status: string) => ({ status }) as never;
  const completeGraph = {
    nodes: {
      final: node("ready"),
      "tool-01-read_template": node("complete"),
      "tool-13-publish_verified_code_to_github": node("complete"),
      "optional-retry-28-code_workspace_create_file": node("cancelled"),
    },
  };
  assert.equal(missionGraphOnlyFinalSynthesisRemainsV1(completeGraph), true);
  assert.equal(
    missionGraphOnlyFinalSynthesisRemainsV1({
      nodes: {
        ...completeGraph.nodes,
        "tool-08-code_validate_targeted": node("queued"),
      },
    }),
    false,
    "an outstanding tool node must keep the tool loop open",
  );
  assert.equal(
    missionGraphOnlyFinalSynthesisRemainsV1({
      nodes: {
        ...completeGraph.nodes,
        "repair-record-40": node("blocked"),
      },
    }),
    false,
    "a blocked node must never be skipped by final steering",
  );
  assert.equal(
    missionGraphOnlyFinalSynthesisRemainsV1({
      nodes: { ...completeGraph.nodes, final: node("blocked") },
    }),
    false,
    "a blocked final node is not a synthesis frontier",
  );
  assert.equal(missionGraphOnlyFinalSynthesisRemainsV1(null), false);
  assert.equal(
    missionGraphOnlyFinalSynthesisRemainsV1({ nodes: {} }),
    false,
    "a graph without a final node never claims synthesis readiness",
  );
});

test("linear_get_issue canonicalization never fires outside the unverified exact-contract window", () => {
  const eligible = {
    toolName: "linear_get_issue",
    required: true,
    verified: false,
    exactIssueIdentity: ISSUE_ID,
    echoedIssueId: "model-invented-id",
  };
  for (const inert of [
    { ...eligible, toolName: "linear_list_issues" },
    { ...eligible, required: false },
    { ...eligible, verified: true },
    { ...eligible, exactIssueIdentity: null },
    { ...eligible, exactIssueIdentity: "   " },
  ]) {
    assert.equal(canonicalExactLinearIssueReadIdV1(inert), null);
  }
});
