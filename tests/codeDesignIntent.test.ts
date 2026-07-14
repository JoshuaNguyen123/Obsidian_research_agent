import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_TEAM_CLARIFY_TEMPLATE,
  extractRepositoryPathHint,
  hasCodeIntent,
  hasCodeTeamBridgeIntent,
  hasDesignIntent,
  hasExplicitCanvasDestinationIntent,
  hasExplicitCodeTeamMagicPhrase,
  hasHtmlPreviewIntent,
  hasReviseDesignIntent,
} from "../src/agent/codeDesignIntent";

test("codeDesignIntent classifies code and design prompts", () => {
  assert.equal(hasCodeIntent("run this python script"), true);
  assert.equal(hasDesignIntent("create a canvas diagram of the flow"), true);
  assert.equal(
    hasDesignIntent("Can you turn those 5 laws into a design graph?"),
    true,
  );
  assert.equal(hasDesignIntent("Turn these ideas into a graph."), true);
  assert.equal(hasDesignIntent("I want this to be on a canvas."), true);
  assert.equal(
    hasExplicitCanvasDestinationIntent(
      "Move this Mermaid diagram into an Obsidian Canvas.",
    ),
    true,
  );
  assert.equal(
    hasDesignIntent("How are my notes connected in the graph?"),
    false,
  );
  assert.equal(hasReviseDesignIntent("revise the canvas layout"), true);
  assert.equal(hasHtmlPreviewIntent("preview the html page"), true);
});

test("repository code intent is detected without making a magic phrase authoritative", () => {
  assert.equal(
    hasExplicitCodeTeamMagicPhrase("code team repository: C:/repo"),
    true,
  );
  assert.equal(
    hasCodeTeamBridgeIntent(
      "fix the bug in repository: C:/Users/me/project",
    ),
    true,
  );
  assert.equal(
    hasCodeTeamBridgeIntent(
      "code team fix the bug repository: C:/Users/me/project",
    ),
    true,
  );
  assert.equal(
    hasCodeTeamBridgeIntent(
      "refactor repository: C:/Users/me/project",
    ),
    true,
  );
  assert.equal(extractRepositoryPathHint('repo: "C:/tmp/app"'), "C:/tmp/app");
  assert.match(CODE_TEAM_CLARIFY_TEMPLATE, /trusted repository binding/i);
  assert.doesNotMatch(CODE_TEAM_CLARIFY_TEMPLATE, /magic phrase/i);
});
