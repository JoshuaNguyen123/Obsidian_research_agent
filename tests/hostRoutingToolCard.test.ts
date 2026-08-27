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

test("the card claims authority only over an authority-derived list", () => {
  // The header used to say "authoritative; call only listed tools" over the raw
  // offered menu, which on a set-loose run over an exact planned frontier
  // contained capability reads the mission graph would refuse. That is the same
  // class of lie the refusal seats stopped telling: everything the model is
  // told has to be true. "call only listed tools" is a restriction and stays
  // either way; "authoritative" additionally promises callability, so it is
  // claimed only when the list came from
  // `authoritativeRefusalFrontierToolNamesV1`.
  const base = {
    route: "grounded_workflow",
    stages: ["accepted_research", "code_execution"],
    currentStage: "code_execution",
    setLoose: true,
    unpaidDelivery: ["code_execution"],
    preferredNextTool: "code_validate_fast",
    offeredToolLines: buildOfferedToolLines({
      readyFrontierToolNames: ["code_validate_fast", "read_current_file"],
    }),
  } as const;

  const authoritative = formatHostRoutingToolCard({
    ...base,
    offeredToolsAreAuthoritative: true,
  });
  assert.ok(
    authoritative.startsWith(
      "HOST ROUTING CARD (authoritative; call only listed tools):",
    ),
  );

  const rawMenu = formatHostRoutingToolCard({
    ...base,
    offeredToolsAreAuthoritative: false,
  });
  assert.ok(
    rawMenu.startsWith("HOST ROUTING CARD (offered menu; call only listed tools):"),
  );
  assert.equal(rawMenu.includes("authoritative"), false);
  // A seat that does not say fails closed to the weaker claim.
  assert.equal(formatHostRoutingToolCard(base), rawMenu);
});
