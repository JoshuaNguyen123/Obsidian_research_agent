import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLinearIntent,
  extractExplicitLinearIssueReadIdentity,
  hasExplicitPermanentLinearDeleteIntent,
} from "../src/agent/linearIntent";

test("detectLinearIntent recognizes Linear URLs", () => {
  const result = detectLinearIntent(
    "Read https://linear.app/acme/issue/ENG-123/fix-the-runner and summarize it.",
  );
  assert.equal(result.explicit, true);
  assert.equal(result.reason, "linear_url");
});

test("detectLinearIntent recognizes acted-on issue identifiers", () => {
  const result = detectLinearIntent("Execute ENG-123 after reading the ticket.");
  assert.deepEqual(result, {
    explicit: true,
    reason: "linear_issue_identifier",
    issueIdentifier: "ENG-123",
  });
});

test("detectLinearIntent recognizes explicit Linear resource language", () => {
  assert.equal(
    detectLinearIntent("Create a Linear issue for the accepted research.")
      .explicit,
    true,
  );
  assert.equal(
    detectLinearIntent(
      "Publish the accepted research to one Linear implementation issue.",
    ).explicit,
    true,
  );
  assert.equal(
    detectLinearIntent("List projects from Linear.").explicit,
    true,
  );
});

test("detectLinearIntent rejects ordinary linear terminology", () => {
  assert.deepEqual(detectLinearIntent("Explain linear algebra to me."), {
    explicit: false,
    reason: "none",
  });
  assert.deepEqual(
    detectLinearIntent("Read Templates/Linear ticket.md from my vault."),
    { explicit: false, reason: "none" },
  );
  assert.deepEqual(detectLinearIntent("Use a linear regression model."), {
    explicit: false,
    reason: "none",
  });
});

test("detectLinearIntent recognizes named linear_* tool tokens", () => {
  assert.deepEqual(
    detectLinearIntent(
      "Call linear_create_issue exactly once, then append_to_current_file.",
    ),
    { explicit: true, reason: "linear_tool_token" },
  );
  assert.equal(
    detectLinearIntent(
      "Required tools: linear_get_issue, append_to_current_file.",
    ).explicit,
    true,
  );
});

test("extractExplicitLinearIssueReadIdentity binds only an acted-on Linear issue identity", () => {
  assert.equal(
    extractExplicitLinearIssueReadIdentity(
      "Review and implement Linear issue 71AA708B-70A1-4B26-9E6F-FB8A9C31A4D2. Begin with linear_get_issue.",
    ),
    "71aa708b-70a1-4b26-9e6f-fb8a9c31a4d2",
  );
  assert.equal(
    extractExplicitLinearIssueReadIdentity(
      "Read Linear issue ENG-123 before implementing it.",
    ),
    "ENG-123",
  );
  assert.equal(
    extractExplicitLinearIssueReadIdentity(
      "Do not read Linear issue ENG-123; create a different issue.",
    ),
    null,
  );
  assert.equal(
    extractExplicitLinearIssueReadIdentity(
      "The note mentions Linear issue ENG-123 as historical context.",
    ),
    null,
  );
});

test("permanent Linear deletion requires explicit irreversible wording", () => {
  assert.equal(
    hasExplicitPermanentLinearDeleteIntent("Delete Linear issue ENG-42."),
    false,
  );
  assert.equal(
    hasExplicitPermanentLinearDeleteIntent(
      "Permanently delete Linear issue ENG-42.",
    ),
    true,
  );
  assert.equal(
    hasExplicitPermanentLinearDeleteIntent(
      "Permanently delete Templates/Linear ticket.md.",
    ),
    false,
  );
});
