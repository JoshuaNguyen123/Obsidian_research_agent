import assert from "node:assert/strict";
import test from "node:test";
import {
  detectLinearIntent,
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
