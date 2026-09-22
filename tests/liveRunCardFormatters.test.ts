import assert from "node:assert/strict";
import test from "node:test";

import {
  formatModelWaitStatusLine,
  MODEL_WAIT_STATUS_PREFIX,
  parseModelWaitStatusLine,
} from "../src/agent/failureCopy";
import {
  formatLiveRunProofLabel,
  formatLiveRunToolLabel,
  formatToolTargetV1,
  MAX_TOOL_TARGET_CHARS,
} from "../src/ui/agentViewFormatters";

test("tool target prefers the note basename from the trace path", () => {
  assert.equal(
    formatToolTargetV1({ path: "Research/Notes/Onboarding plan.md" }),
    "Onboarding plan.md",
  );
  assert.equal(
    formatToolTargetV1({ toPath: "Archive\\Old\\moved.md" }),
    "moved.md",
  );
  // A path inside the redacted argument preview counts the same way.
  assert.equal(
    formatToolTargetV1({ inputPreview: { path: "a/b/c.md", query: "ignored" } }),
    "c.md",
  );
});

test("tool target shows only the hostname of a URL", () => {
  assert.equal(
    formatToolTargetV1({
      inputPreview: { url: "https://docs.example.org/guide/page?x=1#frag" },
    }),
    "docs.example.org",
  );
  // A malformed URL is still bounded and never throws.
  assert.equal(
    formatToolTargetV1({ inputPreview: { url: "not a url" } }),
    "not a url",
  );
});

test("tool target clips a long query and reports nothing for an empty preview", () => {
  const query = "q".repeat(MAX_TOOL_TARGET_CHARS * 2);
  const clipped = formatToolTargetV1({ inputPreview: { query } });
  assert.equal(clipped.length, MAX_TOOL_TARGET_CHARS);
  assert.ok(clipped.endsWith("…"), clipped);
  assert.equal(formatToolTargetV1({}), "");
  assert.equal(formatToolTargetV1({ inputPreview: { count: 3 } }), "");
  assert.equal(formatToolTargetV1({ inputPreview: "opaque" }), "");
});

test("live-run tool and proof labels read as one line each", () => {
  assert.equal(formatLiveRunToolLabel("read_file", "c.md"), "read_file · c.md");
  assert.equal(formatLiveRunToolLabel("read_file", ""), "read_file");
  assert.equal(formatLiveRunToolLabel("", "x"), "—");
  assert.equal(formatLiveRunProofLabel(0, 0), "0 receipts · 0 sources");
  assert.equal(formatLiveRunProofLabel(1, 1), "1 receipt · 1 source");
  assert.equal(formatLiveRunProofLabel(2, 3), "2 receipts · 3 sources");
  assert.equal(formatLiveRunProofLabel(-4, 2.9), "0 receipts · 2 sources");
});

test("the model-wait heartbeat round-trips through one shared shape", () => {
  const line = formatModelWaitStatusLine("the planner", 90);
  assert.ok(line.startsWith(MODEL_WAIT_STATUS_PREFIX), line);
  assert.deepEqual(parseModelWaitStatusLine(line), {
    label: "the planner",
    elapsedSeconds: 90,
  });
  // Ordinary status lines are not mistaken for a heartbeat.
  assert.equal(parseModelWaitStatusLine("Running tool: read_file"), null);
  assert.equal(parseModelWaitStatusLine("Still waiting for nothing"), null);
});
