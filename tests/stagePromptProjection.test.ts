import assert from "node:assert/strict";
import test from "node:test";

import { buildMissionGraphFrontierTurnContext } from "../src/agent/missionGraphFrontier";
import {
  extractCompactStageEvidence,
  formatStagePromptProjection,
  objectiveForLifecycleStage,
  projectStagePrompt,
  STAGE_PROMPT_MAX_TOTAL_CHARS,
} from "../src/agent/stagePromptProjection";
import { schemasForLifecycleStage } from "../src/agent/toolSchemaPolicy";
import type { ModelToolDefinition } from "../src/model/types";

function tool(name: string): ModelToolDefinition {
  return {
    type: "function",
    function: { name, description: `${name} tool`, parameters: { type: "object" } },
  };
}

test("stage prompt projection keeps only objective evidence and callable tools", () => {
  const projection = projectStagePrompt({
    stage: "code_execution",
    setLoose: true,
    callableTools: ["code_validate_fast", "code_commit_verified", "read_current_file"],
    budgetLine: "code_execution ~12 min remaining",
    observedBinding: [
      "HOST ROUTING CARD (authoritative; call only listed tools):",
      "route=grounded_workflow stages=code_execution currentStage=code_execution setLoose=true",
      "offered:",
      "- code_validate_fast — sandbox smoke tests",
      "",
      "VERIFIED GIT PATH (host-only; do not invent git_* tools):",
      "1) code_workspace_create",
      "",
      "evidence readback: workspaceRoot=/tmp/ws sha256=abc issueId=LIN-1",
      "paid=linear_hierarchy unpaid=code_execution",
    ].join("\n\n"),
  });

  assert.equal(projection.stage, "code_execution");
  assert.match(projection.objective, /code proof/i);
  assert.deepEqual(projection.callableTools, [
    "code_validate_fast",
    "code_commit_verified",
    "read_current_file",
  ]);
  assert.ok(
    projection.evidenceLines.some((line) => /issueId=LIN-1|sha256=abc/u.test(line)),
  );
  assert.ok(
    !projection.evidenceLines.some((line) => /HOST ROUTING CARD|VERIFIED GIT PATH/u.test(line)),
  );

  const formatted = formatStagePromptProjection(projection);
  assert.match(formatted, /STAGE PROMPT \(set-loose/u);
  assert.match(formatted, /callableTools:/u);
  assert.match(formatted, /code_validate_fast, code_commit_verified, read_current_file/u);
  assert.doesNotMatch(formatted, /HOST ROUTING CARD/u);
  assert.ok(formatted.length <= STAGE_PROMPT_MAX_TOTAL_CHARS);
});

test("extractCompactStageEvidence drops bulky cards and caps lines", () => {
  const lines = extractCompactStageEvidence(
    [
      "HOST ROUTING CARD: ignore this whole section",
      "path=src/main.ts proof unpaid",
      "status=verified readback commit sha256=deadbeef",
      "x".repeat(400),
    ].join("\n\n"),
    { maxLines: 2 },
  );
  assert.equal(lines.length, 2);
  assert.ok(lines.every((line) => line.length <= 280));
  assert.ok(lines.some((line) => /path=src\/main\.ts/u.test(line)));
});

test("objectiveForLifecycleStage covers every durable stage", () => {
  for (const stage of [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "private_github_publication",
    "reconciliation_cleanup",
  ] as const) {
    assert.ok(objectiveForLifecycleStage(stage).length > 10);
  }
  assert.match(objectiveForLifecycleStage(null), /callable tools/i);
});

test("frontier turn context uses stage projection instead of echoing host cards", () => {
  const text = buildMissionGraphFrontierTurnContext(
    [tool("linear_create_issue"), tool("linear_get_issue")],
    [
      "HOST ROUTING CARD (authoritative):",
      "route=grounded_workflow",
      "",
      "evidence: Linear issueId=abc123 readback verified",
    ].join("\n\n"),
    {
      setLoose: true,
      currentStage: "linear_hierarchy",
      stageBudgetBlock: "linear_hierarchy ~5 min remaining",
    },
  );
  assert.match(text, /STAGE PROMPT \(set-loose/u);
  assert.match(text, /linear_hierarchy/u);
  assert.match(text, /linear_create_issue, linear_get_issue/u);
  assert.doesNotMatch(text, /HOST ROUTING CARD/u);
  assert.doesNotMatch(text, /SET-LOOSE ALLOWED TOOLS FOR THIS TURN/u);
});

test("schemasForLifecycleStage keeps only callable stage tools", () => {
  const schemas = schemasForLifecycleStage({
    callableToolNames: ["code_validate_fast", "append_to_current_file"],
    allSchemas: [
      tool("code_validate_fast"),
      tool("append_to_current_file"),
      tool("github_create_private_repository"),
      tool("web_search"),
    ],
  });
  assert.deepEqual(
    schemas.map((schema) => schema.function.name),
    ["code_validate_fast", "append_to_current_file"],
  );
});
