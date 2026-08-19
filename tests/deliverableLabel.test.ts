import test from "node:test";
import assert from "node:assert/strict";

import {
  deliverableLabelFromPromptV1,
  deliverableTitleFromPromptV1,
} from "../src/agent/verifiedWorkspaceBinding";
import { stopReasonChatLine } from "../src/agent/missionStopReason";

test("the delivered folder is named after what the user asked for", () => {
  // The reported prompt used to land on the Desktop as code-deliverable-<hex>.
  assert.equal(
    deliverableLabelFromPromptV1(
      "Can you create a cli checkers game in Python on my desktop?",
    ),
    "cli-checkers-game",
  );
  assert.equal(
    deliverableLabelFromPromptV1("generate a python snake game on my desktop"),
    "python-snake-game",
  );
  assert.equal(
    deliverableLabelFromPromptV1(
      "save a tic tac toe game in Python to my Documents folder",
    ),
    "tic-tac-toe-game",
  );
});

test("the previously hardcoded number-guessing label is preserved", () => {
  assert.equal(
    deliverableLabelFromPromptV1(
      "write a number guessing game in Python on my desktop",
    ),
    "number-guessing-game",
  );
});

test("a label is always a safe, bounded path segment", () => {
  for (const prompt of [
    "build a ../../etc/passwd script on my desktop",
    "make a  game  on my desktop",
    "create an app named C:\\Windows\\System32 on my desktop",
    "write a Ünïcödé Ω tool on my desktop",
    `create a ${"x".repeat(400)} game on my desktop`,
  ]) {
    const label = deliverableLabelFromPromptV1(prompt);
    assert.match(label, /^[a-z0-9]+(?:-[a-z0-9]+)*$/u, prompt);
    assert.ok(label.length > 0 && label.length <= 48, prompt);
    assert.equal(label.includes(".."), false, prompt);
  }
});

test("a request with no recognizable artifact keeps the neutral fallback", () => {
  assert.equal(
    deliverableLabelFromPromptV1("put something on my desktop"),
    "code-deliverable",
  );
  assert.equal(deliverableLabelFromPromptV1(""), "code-deliverable");
  // A bare noun is no more informative than the fallback.
  assert.equal(deliverableLabelFromPromptV1("make a game"), "code-deliverable");
  assert.equal(deliverableTitleFromPromptV1("put something on my desktop"), null);
});

test("the human-facing title reads as prose", () => {
  assert.equal(
    deliverableTitleFromPromptV1(
      "Can you create a cli checkers game in Python on my desktop?",
    ),
    "cli checkers game",
  );
});

test("a blocked run states the blocker in chat instead of pointing at a panel", () => {
  const line = stopReasonChatLine(
    "graph_blocked",
    "Mission graph stopped at tool-04-code_validate_fast: No sandbox provider has passed its boundary probe.",
  );
  assert.match(line, /No sandbox provider has passed its boundary probe/u);
  assert.doesNotMatch(line, /^Blocked — open Run Details/u);
  assert.match(
    stopReasonChatLine("required_tools_failed", "code_commit_verified failed."),
    /code_commit_verified failed/u,
  );
  // Persisted Chat history must remain useful after ephemeral Run Details have
  // been cleared or replaced by another run.
  assert.match(stopReasonChatLine("graph_blocked"), /Retry the mission/u);
  assert.doesNotMatch(stopReasonChatLine("graph_blocked"), /open Run Details/u);
});
