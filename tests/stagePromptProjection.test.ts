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
  assert.match(projection.objective, /Implement the accepted Linear work/i);
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
    "code_validation",
    "private_github_publication",
    "reflection",
    "reconciliation_cleanup",
  ] as const) {
    assert.ok(objectiveForLifecycleStage(stage).length > 10);
  }
  assert.match(objectiveForLifecycleStage(null), /callable tools/i);
});

test("publication objective echoes an already-made visibility choice instead of asking again", () => {
  // The generic objective told the model to ask public-or-private even when
  // the mission prompt had already chosen; on frontiers without an ask tool
  // that instruction was unfollowable and the turn was wasted.
  assert.match(
    objectiveForLifecycleStage("private_github_publication"),
    /Ask whether/u,
  );
  assert.match(
    objectiveForLifecycleStage("private_github_publication", "private"),
    /already chose a private repository/u,
  );
  assert.match(
    objectiveForLifecycleStage("private_github_publication", "private"),
    /visibility="private"/u,
  );
  // Other stages ignore the visibility.
  assert.match(
    objectiveForLifecycleStage("code_validation", "private"),
    /validation/iu,
  );

  const text = buildMissionGraphFrontierTurnContext(
    [tool("github_create_repository")],
    null,
    {
      setLoose: true,
      currentStage: "private_github_publication",
      resolvedRepositoryVisibility: "private",
    },
  );
  assert.match(text, /already chose a private repository/u);
  assert.doesNotMatch(text, /Ask whether/u);
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
      tool("github_create_repository"),
      tool("web_search"),
    ],
  });
  assert.deepEqual(
    schemas.map((schema) => schema.function.name),
    ["code_validate_fast", "append_to_current_file"],
  );
});

test("callableTools survive a long objective plus full evidence", () => {
  // Regression: the old formatter rendered the tool list near the end and
  // blind-sliced the whole block at the total cap, so a long objective plus
  // eight evidence lines chopped the list mid-name -- observed as
  // "callableTools: code_sandbox_status" while eight schemas were live.
  const toolNames = [
    "code_workspace_status",
    "code_workspace_stat",
    "code_workspace_list",
    "code_workspace_read",
    "code_workspace_search",
    "code_workspace_append",
    "code_sandbox_status",
    "code_repair_status",
  ];
  const projection = projectStagePrompt({
    stage: "code_validation",
    setLoose: true,
    callableTools: toolNames,
    budgetLine: "b".repeat(400),
    evidenceLines: Array.from({ length: 8 }, (_, index) =>
      `readback proof line ${index} path=src/file${index}.py sha256=${"e".repeat(64)}`,
    ),
    objective: "o".repeat(1_600),
  });
  const formatted = formatStagePromptProjection(projection);
  for (const name of toolNames) {
    assert.ok(
      formatted.includes(name),
      `${name} must survive formatting untruncated`,
    );
  }
  assert.match(formatted, /Use the provided JSON schema exactly\./u);
});

test("EXACT host binding lines survive the evidence filter and formatting", () => {
  const exactLine =
    `EXACT GRAPH-BOUND WORKSPACE READ: path=src/very/deep/module/implementation.py workspaceId=run-2026-08-24t05-48-15.303z sha256=${"a".repeat(64)} ` +
    "Call code_workspace_read with this exact path now and do not substitute another file. " +
    "x".repeat(300);
  assert.ok(exactLine.length > 280, "the fixture must exceed the generic cap");
  const lines = extractCompactStageEvidence(
    [
      exactLine,
      "ordinary readback proof sha256=abc",
    ].join("\n\n"),
  );
  assert.ok(
    lines.some((line) => line.startsWith("EXACT GRAPH-BOUND WORKSPACE READ:")),
    "the exact binding line must not be dropped by the 280-char filter",
  );
  const formatted = formatStagePromptProjection(
    projectStagePrompt({
      stage: "code_execution",
      setLoose: true,
      callableTools: ["code_workspace_read"],
      observedBinding: exactLine,
    }),
  );
  assert.match(formatted, /EXACT GRAPH-BOUND WORKSPACE READ:/u);
  assert.match(formatted, /implementation\.py/u);
});

test("bulky cards stay excluded but their load-bearing routing line is salvaged", () => {
  const lines = extractCompactStageEvidence(
    [
      [
        "HOST ROUTING CARD (authoritative; call only listed tools):",
        "route=grounded_workflow",
        "currentStage=code_validation",
        "preferredNext=code_validate_fast",
        "offered:",
        "- code_validate_fast — sandbox smoke tests",
      ].join("\n"),
      "evidence readback sha256=abc",
    ].join("\n\n"),
  );
  assert.ok(lines.some((line) => line === "preferredNext=code_validate_fast"));
  assert.ok(lines.some((line) => line === "currentStage=code_validation"));
  assert.ok(
    !lines.some((line) => /HOST ROUTING CARD|offered:/u.test(line)),
    "the card itself stays out; only the routing line is salvaged",
  );
});
