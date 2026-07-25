import test from "node:test";
import assert from "node:assert/strict";
import { classifyMissionSpeechAct } from "../src/agent/missionSpeechAct";
import { createRunPlan } from "../src/agent/runPlan";
import { getRequiredCodeWorkflowToolNames } from "../src/AgentRunner";
import type { ModelToolDefinition } from "../src/model/types";
import type { MissionIntent } from "../src/tools/types";
import {
  ROUTING_BASELINE_ACCURACY,
  ROUTING_GOLDEN_CORPUS,
  type RoutingGoldenCaseV1,
} from "./fixtures/routingGoldenCorpus";

const CORPUS_TOOL_NAMES = [
  "append_to_current_file",
  "replace_current_file",
  "search_markdown_files",
  "web_search",
  "web_fetch",
  "count_words",
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_workspace_export_directory",
  "code_commit_verified",
];

test("golden routing corpus pins every case at its expected or recorded-current output", () => {
  for (const item of ROUTING_GOLDEN_CORPUS) {
    const observed = observe(item);
    const wanted = resolveAssertedFields(item);
    if (wanted.speechAct !== undefined) {
      assert.equal(observed.speechAct, wanted.speechAct, label(item, "speechAct"));
    }
    if (wanted.executionTier !== undefined) {
      assert.equal(
        observed.executionTier,
        wanted.executionTier,
        label(item, "executionTier"),
      );
    }
    if (wanted.route !== undefined) {
      assert.equal(observed.route, wanted.route, label(item, "route"));
    }
    if (wanted.requiredCodeToolNames !== undefined) {
      assert.deepEqual(
        observed.requiredCodeToolNames,
        [...wanted.requiredCodeToolNames],
        label(item, "requiredCodeToolNames"),
      );
    }
    // reasonsInclude is asserted only for pass cases: it describes the
    // desired route derivation, which a known_miss case does not produce yet.
    if (item.status === "pass" && item.expected.reasonsInclude) {
      for (const reason of item.expected.reasonsInclude) {
        assert.ok(
          observed.traceReasons.includes(reason),
          `${label(item, "reasonsInclude")}: missing ${reason} in ${JSON.stringify(observed.traceReasons)}`,
        );
      }
    }
  }
});

test("routing accuracy never drops below the checked-in baseline ratchet", () => {
  const passCount = ROUTING_GOLDEN_CORPUS.filter(
    (item) => item.status === "pass",
  ).length;
  const accuracy = passCount / ROUTING_GOLDEN_CORPUS.length;
  assert.ok(
    accuracy >= ROUTING_BASELINE_ACCURACY,
    `corpus accuracy ${accuracy.toFixed(3)} fell below baseline ${ROUTING_BASELINE_ACCURACY.toFixed(3)}`,
  );
  // The recorded baseline must match reality so the ratchet is honest: when a
  // known_miss case is fixed, flip its status AND raise the constant.
  assert.equal(
    accuracy,
    ROUTING_BASELINE_ACCURACY,
    "ROUTING_BASELINE_ACCURACY is stale; update it to passCount/total after changing case statuses",
  );
});

test("every known_miss case records the differing current fields", () => {
  for (const item of ROUTING_GOLDEN_CORPUS) {
    if (item.status === "known_miss") {
      assert.ok(
        item.current && Object.keys(item.current).length > 0,
        `${item.id}: known_miss cases must pin their present-day output`,
      );
    } else {
      assert.equal(
        item.current,
        undefined,
        `${item.id}: pass cases must not carry a current override`,
      );
    }
  }
});

function observe(item: RoutingGoldenCaseV1) {
  const speech = classifyMissionSpeechAct(item.prompt);
  const plan = createRunPlan({
    prompt: item.prompt,
    missionIntent: missionIntent(item.intent),
    tools: [...CORPUS_TOOL_NAMES, ...(item.extraTools ?? [])].map(tool),
    streamingWritebackKind: item.streamingWritebackKind ?? null,
    directCurrentNoteWritebackKind: null,
  });
  return {
    speechAct: speech.speechAct,
    executionTier: speech.executionTier,
    route: plan.route,
    traceReasons: plan.traceReasons,
    requiredCodeToolNames: getRequiredCodeWorkflowToolNames(item.prompt),
  };
}

/** pass → assert expected; known_miss → current overrides the differing fields. */
function resolveAssertedFields(item: RoutingGoldenCaseV1) {
  return item.status === "pass"
    ? item.expected
    : { ...item.expected, ...item.current };
}

function label(item: RoutingGoldenCaseV1, field: string): string {
  return `[${item.id}] ${field} (${item.status}) :: ${item.prompt}`;
}

function tool(name: string): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description: name,
      parameters: { type: "object", properties: {} },
    },
  };
}

function missionIntent(overrides: Partial<MissionIntent> = {}): MissionIntent {
  return {
    mode: "chat_only",
    vaultContext: false,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: {
      read: {
        currentNote: false,
        vault: false,
        folders: [],
        files: [],
        web: false,
      },
      write: {
        currentNote: false,
        folders: [],
        files: [],
        artifacts: false,
        researchMemory: false,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
    ...overrides,
  };
}
