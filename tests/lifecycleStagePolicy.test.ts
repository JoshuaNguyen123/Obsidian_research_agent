import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_EXECUTION_TOOL_ALLOW,
  GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW,
  GITHUB_STAGE_READ_TOOL_ALLOW,
  GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW,
  insertExplicitLinearReadbacksIntoLifecycleToolNames,
  nextLifecycleStageAfter,
  PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES,
  shouldDeferAdditionalProjectLifecycleMutation,
  toolsAllowedForLifecycleStage,
} from "../src/agent/lifecycleStagePolicy";
import { toolsAllowedForEnvelopeStage } from "../src/agent/missionStageEnvelope";
import {
  SET_LOOSE_BOUND_TOOL_NAMES,
  toolsOfferedForSetLoosePipeline,
} from "../src/agent/setLooseCompoundAutonomy";
import { ROUTE_BASE_TOOLS } from "../src/agent/toolSchemaPolicy";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "../src/tools/researchProjectHierarchyTool";

test("toolsAllowedForLifecycleStage returns stage-scoped tool names", () => {
  const research = toolsAllowedForLifecycleStage("accepted_research");
  assert.ok(research.includes("web_search"));
  assert.ok(research.includes("web_fetch"));
  assert.ok(research.includes("publish_research_to_linear"));
  assert.ok(research.includes("semantic_search_notes"));
  assert.ok(research.includes("find_related_notes"));
  assert.ok(research.includes("get_note_graph_context"));

  const code = toolsAllowedForLifecycleStage("code_execution");
  assert.ok(code.includes("code_commit_verified"));
  assert.ok(code.includes("code_validate_full"));
  assert.ok(code.includes("code_workspace_patch"));
  assert.ok(code.includes("code_workspace_mkdir"));
  assert.ok(code.includes("code_repair_record_cycle"));
});

test("GitHub lifecycle stage separates catalog reads and safe mutations from destructive cleanup", () => {
  const github = toolsAllowedForLifecycleStage("private_github_publication");
  const cleanup = toolsAllowedForLifecycleStage("reconciliation_cleanup");

  for (const tool of GITHUB_STAGE_READ_TOOL_ALLOW) {
    assert.ok(github.includes(tool), `GitHub stage missing read ${tool}`);
  }
  for (const tool of GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW) {
    assert.ok(github.includes(tool), `GitHub stage missing mutation ${tool}`);
    assert.ok(
      PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES.has(tool),
      `lifecycle mutation set missing ${tool}`,
    );
  }
  for (const tool of GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW) {
    assert.equal(github.includes(tool), false, `${tool} leaked into GitHub stage`);
    assert.ok(cleanup.includes(tool), `cleanup stage missing ${tool}`);
  }
});

test("CODE_EXECUTION_TOOL_ALLOW stays shared across lifecycle Soft-union envelope and route base", () => {
  const lifecycle = new Set(toolsAllowedForLifecycleStage("code_execution"));
  const envelope = new Set(toolsAllowedForEnvelopeStage("code_execution"));
  const routeBase = new Set(ROUTE_BASE_TOOLS.code);
  for (const tool of CODE_EXECUTION_TOOL_ALLOW) {
    assert.ok(lifecycle.has(tool), `lifecycle missing ${tool}`);
    assert.ok(envelope.has(tool), `envelope missing ${tool}`);
    assert.ok(routeBase.has(tool), `ROUTE_BASE_TOOLS.code missing ${tool}`);
    assert.ok(
      SET_LOOSE_BOUND_TOOL_NAMES.has(tool),
      `SET_LOOSE_BOUND_TOOL_NAMES missing ${tool}`,
    );
  }
  assert.ok(envelope.has("append_to_current_file"));
  assert.ok(envelope.has("read_current_file"));
  assert.equal(lifecycle.has("append_to_current_file"), false);

  const softUnion = toolsOfferedForSetLoosePipeline({
    stages: ["code_execution"],
    currentStage: "code_execution",
    passedFastRepairCycle: false,
  });
  assert.ok(softUnion.includes("code_workspace_patch"));
  assert.ok(softUnion.includes("code_validate_fast"));
  assert.ok(softUnion.includes("code_repair_record_cycle"));
  assert.equal(softUnion.includes("code_commit_verified"), false);
});

test("nextLifecycleStageAfter advances only after commit", () => {
  assert.equal(
    nextLifecycleStageAfter("accepted_research", false),
    "accepted_research",
  );
  assert.equal(
    nextLifecycleStageAfter("accepted_research", true),
    "linear_hierarchy",
  );
  assert.equal(
    nextLifecycleStageAfter("reconciliation_cleanup", true),
    null,
  );
});

test("shouldDeferAdditionalProjectLifecycleMutation blocks second stage mutation", () => {
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation(
      "publish_research_project_to_linear",
      true,
    ),
    true,
  );
  assert.equal(
    shouldDeferAdditionalProjectLifecycleMutation("web_fetch", true),
    false,
  );
  assert.ok(
    PROJECT_LIFECYCLE_STAGE_MUTATION_TOOL_NAMES.has("code_commit_verified"),
  );
});

test("insertExplicitLinearReadbacksIntoLifecycleToolNames inserts reads after hierarchy publish", () => {
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      ["publish_research_to_linear", PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME],
      ["linear_get_issue"],
    ),
    [
      "publish_research_to_linear",
      PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
      "linear_get_issue",
    ],
  );
});
