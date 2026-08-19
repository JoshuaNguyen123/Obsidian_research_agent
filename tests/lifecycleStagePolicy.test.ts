import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_EXECUTION_TOOL_ALLOW,
  CODE_IMPLEMENTATION_TOOL_ALLOW,
  CODE_VALIDATION_TOOL_ALLOW,
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
import { CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME } from "../src/tools/githubPrivateRepositoryTool";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "../src/tools/githubPublicationTool";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "../src/tools/researchProjectHierarchyTool";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../src/tools/researchPublicationTool";

test("toolsAllowedForLifecycleStage returns stage-scoped tool names", () => {
  const research = toolsAllowedForLifecycleStage("accepted_research");
  assert.ok(research.includes("web_search"));
  assert.ok(research.includes("web_fetch"));
  assert.ok(research.includes("create_project_idea_brief"));
  assert.ok(
    toolsAllowedForEnvelopeStage("accepted_research").includes(
      "create_project_idea_brief",
    ),
  );
  assert.ok(research.includes("publish_research_to_linear"));
  assert.ok(research.includes("semantic_search_notes"));
  assert.ok(research.includes("find_related_notes"));
  assert.ok(research.includes("get_note_graph_context"));

  const implementation = toolsAllowedForLifecycleStage("code_execution");
  assert.ok(implementation.includes("code_workspace_patch"));
  assert.ok(implementation.includes("code_workspace_mkdir"));
  assert.equal(implementation.includes("code_validate_full"), false);
  assert.equal(implementation.includes("code_commit_verified"), false);

  const validation = toolsAllowedForLifecycleStage("code_validation");
  assert.ok(validation.includes("code_validate_full"));
  assert.ok(validation.includes("code_repair_record_cycle"));
  assert.ok(validation.includes("code_commit_verified"));
  assert.equal(validation.includes("code_workspace_patch"), false);

  const reflection = toolsAllowedForLifecycleStage("reflection");
  assert.ok(reflection.includes("write_project_results"));
  assert.ok(reflection.includes("append_jupyter_reflection"));
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

test("code route union stays shared while lifecycle and envelope keep implementation and validation separate", () => {
  const implementationLifecycle = new Set(
    toolsAllowedForLifecycleStage("code_execution"),
  );
  const validationLifecycle = new Set(
    toolsAllowedForLifecycleStage("code_validation"),
  );
  const implementationEnvelope = new Set(
    toolsAllowedForEnvelopeStage("code_execution"),
  );
  const validationEnvelope = new Set(
    toolsAllowedForEnvelopeStage("code_validation"),
  );
  const routeBase = new Set(ROUTE_BASE_TOOLS.code);
  for (const tool of CODE_EXECUTION_TOOL_ALLOW) {
    assert.ok(routeBase.has(tool), `ROUTE_BASE_TOOLS.code missing ${tool}`);
    assert.ok(
      SET_LOOSE_BOUND_TOOL_NAMES.has(tool),
      `SET_LOOSE_BOUND_TOOL_NAMES missing ${tool}`,
    );
  }
  for (const tool of CODE_IMPLEMENTATION_TOOL_ALLOW) {
    assert.ok(implementationLifecycle.has(tool), `implementation missing ${tool}`);
    assert.ok(implementationEnvelope.has(tool), `implementation envelope missing ${tool}`);
    assert.equal(validationLifecycle.has(tool), false, `${tool} leaked into validation`);
  }
  for (const tool of CODE_VALIDATION_TOOL_ALLOW) {
    assert.ok(validationLifecycle.has(tool), `validation missing ${tool}`);
    assert.ok(validationEnvelope.has(tool), `validation envelope missing ${tool}`);
    assert.equal(implementationLifecycle.has(tool), false, `${tool} leaked into implementation`);
  }
  assert.ok(implementationEnvelope.has("append_to_current_file"));
  assert.ok(implementationEnvelope.has("read_current_file"));
  assert.ok(validationEnvelope.has("append_to_current_file"));
  assert.ok(validationEnvelope.has("read_current_file"));
  assert.equal(implementationLifecycle.has("append_to_current_file"), false);
  assert.equal(validationLifecycle.has("append_to_current_file"), false);

  const softUnion = toolsOfferedForSetLoosePipeline({
    stages: ["code_execution", "code_validation"],
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

test("explicit Linear readback is first in an isolated Phase B code and GitHub lifecycle", () => {
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      [
        "code_sandbox_status",
        "code_workspace_create",
        "code_validate_targeted",
        "code_commit_verified",
        CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
        PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
        // Reproduce the stale planner placement that previously left the
        // explicit issue read at the end of the effect chain.
        "linear_get_issue",
      ],
      ["linear_get_issue"],
    ),
    [
      "linear_get_issue",
      "code_sandbox_status",
      "code_workspace_create",
      "code_validate_targeted",
      "code_commit_verified",
      CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
      PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
    ],
  );
});

test("explicit Linear readback follows the atomic research publisher before code", () => {
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      [
        PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
        "code_workspace_create",
        "code_validate_targeted",
      ],
      ["linear_get_issue"],
    ),
    [
      PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
      "linear_get_issue",
      "code_workspace_create",
      "code_validate_targeted",
    ],
  );
});

test("explicit Linear readback preserves hierarchy publisher ordering before code", () => {
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      [
        PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
        PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
        "code_workspace_create",
      ],
      ["linear_get_issue"],
    ),
    [
      PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
      PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
      "linear_get_issue",
      "code_workspace_create",
    ],
  );
});

test("explicit Linear readback ordering retains create fallback and stable dedupe behavior", () => {
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      [
        "read_template",
        "linear_create_issue",
        "linear_get_issue",
        "linear_get_issue",
        "code_workspace_create",
        "code_workspace_create",
      ],
      ["linear_get_issue", "linear_get_issue"],
    ),
    [
      "read_template",
      "linear_create_issue",
      "linear_get_issue",
      "code_workspace_create",
    ],
  );
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      ["read_template", "read_template"],
      [],
    ),
    ["read_template"],
  );
  assert.deepEqual(
    insertExplicitLinearReadbacksIntoLifecycleToolNames(
      ["read_template"],
      ["linear_get_issue"],
    ),
    ["read_template", "linear_get_issue"],
  );
});
