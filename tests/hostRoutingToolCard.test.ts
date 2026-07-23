import assert from "node:assert/strict";
import test from "node:test";
import {
  HOST_ROUTING_TOOL_CARD_MAX_CHARS,
  buildOfferedToolLines,
  formatHostRoutingToolCard,
  pickPreferredNextTool,
} from "../src/agent/hostRoutingToolCard";

test("pickPreferredNextTool prefers unpaid delivery tools that are ready", () => {
  assert.equal(
    pickPreferredNextTool({
      unpaidDeliveryTools: ["code_validate_fast", "code_commit_verified"],
      readyFrontierToolNames: [
        "code_workspace_read",
        "code_validate_fast",
        "code_commit_verified",
      ],
    }),
    "code_validate_fast",
  );
});

test("formatHostRoutingToolCard stays under char bound", () => {
  const offered = buildOfferedToolLines({
    readyFrontierToolNames: [
      "code_validate_fast",
      "code_commit_verified",
      "publish_verified_code_to_github",
    ],
  });
  const card = formatHostRoutingToolCard({
    route: "grounded_workflow",
    stages: ["linear_hierarchy", "code_execution", "private_github_publication"],
    currentStage: "code_execution",
    setLoose: true,
    unpaidDelivery: ["code_execution"],
    preferredNextTool: "code_validate_fast",
    offeredToolLines: offered,
  });
  assert.ok(card.startsWith("HOST ROUTING CARD"));
  assert.match(card, /preferredNext=code_validate_fast/);
  assert.match(card, /code_validate_fast/);
  assert.ok(card.length <= HOST_ROUTING_TOOL_CARD_MAX_CHARS);
});
