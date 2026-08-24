import test from "node:test";
import assert from "node:assert/strict";
import {
  constrainToolsToMissionGraphFrontier,
  narrowAdaptiveCodeMutationsToPlannedWritesV1,
} from "../src/agent/missionGraphFrontier";
import {
  countReadyMissionGraphToolSlots,
  readyMissionGraphFrontierToolNamesV1,
} from "../src/agent/missionGraphSelectors";
import type { ModelToolDefinition } from "../src/model/types";

const tool = (name: string): ModelToolDefinition => ({
  type: "function",
  function: { name, parameters: { type: "object", properties: {} } },
});

const CODE_MENU = [
  "read_template",
  "code_workspace_status",
  "code_workspace_read",
  "code_workspace_list",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_sandbox_status",
  "append_to_current_file",
].map(tool);

test("a ready planned workspace write pins the menu to that mutation", () => {
  // Regression: with code_workspace_append ready, the broad route catalog
  // still offered create_file / write_expected / patch / mkdir. The model
  // wrote the file through create_file, the planned node stayed ready, and
  // every validator behind it was deferred until the segment budget expired.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-04-code_workspace_create": {
        status: "complete",
        allowedTools: ["code_workspace_create"],
      },
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "queued",
        allowedTools: ["code_validate_fast"],
      },
    },
  });
  assert.deepEqual(
    narrowed.map((item) => item.function.name),
    [
      "read_template",
      "code_workspace_status",
      "code_workspace_read",
      "code_workspace_list",
      "code_workspace_append",
      "code_sandbox_status",
      "append_to_current_file",
    ],
  );
});

test("adaptive workspace mutations return once no ready node pins one", () => {
  const graph = {
    nodes: {
      "tool-05-code_workspace_append": {
        status: "complete",
        allowedTools: ["code_workspace_append"],
      },
      "tool-06-code_validate_fast": {
        status: "ready",
        allowedTools: ["code_validate_fast"],
      },
    },
  };
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, graph),
    CODE_MENU,
  );
  assert.deepEqual(
    narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, null),
    CODE_MENU,
  );
});

test("two ready planned writes keep both pinned mutations", () => {
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      a: { status: "ready", allowedTools: ["code_workspace_create_file"] },
      b: { status: "running", allowedTools: ["code_workspace_patch"] },
    },
  });
  const names = narrowed.map((item) => item.function.name);
  assert.ok(names.includes("code_workspace_create_file"));
  assert.ok(names.includes("code_workspace_patch"));
  assert.ok(!names.includes("code_workspace_append"));
  assert.ok(!names.includes("code_workspace_write_expected"));
  assert.ok(names.includes("code_workspace_read"));
});

test("a failed planned write unpins its siblings so the named remedy stays callable", () => {
  // Pinning is a first-attempt focus aid, not a cage. Each adaptive mutation's
  // failure names a sibling as the remedy (patch -> create_file, create_file ->
  // write_expected, append on an absent path used to -> create_file). Keeping
  // the pin after a failure removes exactly the tool the error asks for.
  const nested = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_patch": {
        status: "ready",
        allowedTools: ["code_workspace_patch"],
        // The production graph nests attempts under retries.
        retries: { attempts: 1 },
      },
    },
  });
  assert.deepEqual(nested, CODE_MENU);

  // UI/E2E projections flatten attempts; both shapes must unpin.
  const flat = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_create_file": {
        status: "ready",
        allowedTools: ["code_workspace_create_file"],
        attempts: 2,
      },
    },
  });
  assert.deepEqual(flat, CODE_MENU);

  // A fresh node still pins.
  const fresh = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
        retries: { attempts: 0 },
      },
    },
  });
  assert.ok(!fresh.some((item) => item.function.name === "code_workspace_create_file"));
  assert.ok(fresh.some((item) => item.function.name === "code_workspace_append"));
});

test("an active validation recovery window is never narrowed", () => {
  // A red validation opens the diagnostic + correction set on purpose. If a
  // ready node also names an adaptive mutation, pinning would strip exactly
  // the correction tools the repair cycle depends on.
  const narrowed = narrowAdaptiveCodeMutationsToPlannedWritesV1(CODE_MENU, {
    nodes: {
      "tool-06-code_validate_fast": {
        status: "queued",
        allowedTools: ["code_validate_fast"],
        outputs: {
          validationRecovery: {
            status: "awaiting_correction",
            fastNodeId: "tool-06-code_validate_fast",
            repairNodeId: "tool-07-code_repair_record_cycle",
          },
        },
      },
      "tool-07-code_repair_record_cycle": {
        status: "ready",
        allowedTools: ["code_repair_record_cycle"],
      },
      "tool-05-code_workspace_append": {
        status: "ready",
        allowedTools: ["code_workspace_append"],
      },
    },
  });
  assert.deepEqual(narrowed, CODE_MENU);
});

test("an exact planned frontier never advertises a tool its own authority will refuse", () => {
  // Stage 8, 45 consecutive refusals. The offered menu carried the whole
  // GitHub read surface while MissionGraphSession refused every one of them
  // with "not ready in the exact authoritative mission graph". The model had
  // no way to learn which entries were callable except by calling them, so it
  // enumerated the list one refused call at a time.
  //
  // The two computations disagreed on one term. The offer read
  // `setLooseCompoundEnabled || !missionGraphUsesExactPlannedFrontier`; the
  // authority read `!missionGraphUsesExactPlannedFrontier`. On a set-loose
  // compound mission with an exact planned frontier the first is true and the
  // second is false, so everything unplanned was advertised and nothing
  // unplanned was admitted.
  const menu = [
    "read_template",
    "web_search",
    "github_get_repository",
    "github_get_commit",
    "github_get_reference",
    "github_list_branches",
    "github_get_tree",
    "append_jupyter_reflection",
  ];
  const definitions = menu.map(tool);
  // The terminal shape: the reflection node has paid and nothing is ready.
  const graph = {
    nodes: {
      reflect: {
        id: "reflect",
        status: "complete",
        allowedTools: ["append_jupyter_reflection"],
        inputs: {},
        outputs: {},
      },
      final: { id: "final", status: "queued", allowedTools: [], inputs: {}, outputs: {} },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  assert.deepEqual(
    readyMissionGraphFrontierToolNamesV1(graph),
    [],
    "nothing is ready in this graph",
  );

  const offeredUnderExactFrontier = constrainToolsToMissionGraphFrontier(
    definitions,
    graph,
    {
      setLooseOfferedToolNames: menu,
      allowDynamicReadContinuation: false,
    },
  ).map((definition) => definition.function.name);

  for (const name of [
    "github_get_repository",
    "github_get_commit",
    "github_get_reference",
    "github_list_branches",
    "github_get_tree",
  ]) {
    assert.equal(
      offeredUnderExactFrontier.includes(name),
      false,
      `${name} has no ready node and no dynamic continuation; offering it advertises a refusal`,
    );
  }

  // Without an exact planned frontier the same unplanned reads stay available,
  // because there authority really will materialize a bounded dynamic node.
  const offeredUnderDynamicFrontier = constrainToolsToMissionGraphFrontier(
    definitions,
    graph,
    {
      setLooseOfferedToolNames: menu,
      allowDynamicReadContinuation: true,
    },
  ).map((definition) => definition.function.name);
  assert.ok(
    offeredUnderDynamicFrontier.includes("github_get_commit"),
    "dynamic read continuation must keep unplanned companions callable",
  );
});

test("slot counting and frontier naming are one readiness answer", () => {
  // Three predicates for "may this tool run now?" is how the offer and the
  // authority drifted apart. Anything that decides what to offer, what to
  // schedule, or what to name as the next call must agree with the node-level
  // rule MissionGraphSession admits calls from.
  const graph = {
    nodes: {
      a: { id: "a", status: "ready", allowedTools: ["code_workspace_append"], inputs: {}, outputs: {} },
      b: { id: "b", status: "ready", allowedTools: ["code_validate_fast"], inputs: {}, outputs: {} },
      c: { id: "c", status: "running", allowedTools: ["github_create_repository"], inputs: {}, outputs: {} },
      d: { id: "d", status: "queued", allowedTools: ["github_get_commit"], inputs: {}, outputs: {} },
    },
    capabilityEnvelope: { tools: {} },
  } as any;

  const named = readyMissionGraphFrontierToolNamesV1(graph);
  assert.deepEqual(named.sort(), ["code_validate_fast", "code_workspace_append"]);
  for (const name of [
    "code_workspace_append",
    "code_validate_fast",
    "github_create_repository",
    "github_get_commit",
    "never_planned_tool",
  ]) {
    assert.equal(
      countReadyMissionGraphToolSlots(graph, name) > 0,
      named.includes(name),
      `${name}: slot count and frontier naming must give the same answer`,
    );
  }
});
