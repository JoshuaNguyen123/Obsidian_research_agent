import test from "node:test";
import assert from "node:assert/strict";
import {
  CODE_TEAM_CLARIFY_TEMPLATE,
  extractRepositoryPathHint,
  hasCodeIntent,
  hasCodeTeamBridgeIntent,
  hasDesignIntent,
  hasExplicitCodeTeamMagicPhrase,
  hasHtmlPreviewIntent,
  hasReviseDesignIntent,
} from "../src/agent/codeDesignIntent";

test("codeDesignIntent classifies code and design prompts", () => {
  assert.equal(hasCodeIntent("run this python script"), true);
  assert.equal(hasDesignIntent("create a canvas diagram of the flow"), true);
  assert.equal(hasReviseDesignIntent("revise the canvas layout"), true);
  assert.equal(hasHtmlPreviewIntent("preview the html page"), true);
});

test("code-team bridge requires repo path + fix intent without magic phrase", () => {
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
    false,
  );
  assert.equal(extractRepositoryPathHint('repo: "C:/tmp/app"'), "C:/tmp/app");
  assert.match(CODE_TEAM_CLARIFY_TEMPLATE, /code team|git worktree/i);
});
