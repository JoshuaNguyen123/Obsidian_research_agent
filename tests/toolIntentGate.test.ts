import assert from "node:assert/strict";
import test from "node:test";
import {
  buildIntentGateCorrective,
  isIntentGateFailureEvent,
  isIntentGateMessage,
} from "../src/agent/toolIntentGate";

test("intent-gate classifier matches both host gate phrasings", () => {
  assert.equal(
    isIntentGateMessage(
      "append_to_current_file requires the user to explicitly ask to append, save, write, add, insert, or update the note.",
    ),
    true,
  );
  assert.equal(
    isIntentGateMessage(
      "read_template requires the user to ask about templates.",
    ),
    true,
  );
  assert.equal(isIntentGateMessage("path_exists: Desktop/game.py"), false);
  assert.equal(isIntentGateMessage(""), false);
  assert.equal(isIntentGateMessage(null), false);
  assert.equal(isIntentGateMessage(undefined), false);
});

test("event-shaped classifier reads message and error.message together", () => {
  assert.equal(
    isIntentGateFailureEvent({
      message:
        "Tool returned error: read_template (read_template requires the user to ask about templates.)",
    }),
    true,
  );
  assert.equal(
    isIntentGateFailureEvent({
      message: "Tool returned error: append_to_current_file",
      error: {
        message:
          "append_to_current_file requires the user to explicitly ask to append.",
      },
    }),
    true,
  );
  assert.equal(
    isIntentGateFailureEvent({ message: "Tool complete: web_search" }),
    false,
  );
  assert.equal(isIntentGateFailureEvent({}), false);
});

test("intent-gate corrective names the tool, bans the retry, and offers exits", () => {
  const corrective = buildIntentGateCorrective("append_to_current_file");
  assert.match(corrective, /skipped append_to_current_file/);
  assert.match(corrective, /Do not call append_to_current_file again/);
  assert.match(corrective, /what the user actually asked for/);
  assert.match(corrective, /final answer/i);
  // Never classify itself as a gate refusal: the corrective must not trip the
  // "requires the user to ask" regex when it later appears in transcripts.
  assert.equal(isIntentGateMessage(corrective), false);
  // Rides inside the per-step prompt budget; keep it compact.
  assert.ok(corrective.length < 500, `corrective too long: ${corrective.length}`);
});
