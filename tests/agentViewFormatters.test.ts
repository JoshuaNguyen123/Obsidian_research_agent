import test from "node:test";
import assert from "node:assert/strict";
import {
  formatAgentMetric,
  formatChars,
  formatOptionalNumber,
  formatReceiptOperationLabel,
  formatScopeList,
  formatStepMetric,
  formatStreamLifecycleLabel,
} from "../src/ui/agentViewFormatters";

test("agent view formatters preserve visible run detail copy", () => {
  assert.equal(formatStreamLifecycleLabel("first_visible_content"), "chat_stream");
  assert.equal(formatStreamLifecycleLabel("first_note_write"), "note_stream");
  assert.equal(formatReceiptOperationLabel("append"), "note_append");
  assert.equal(formatReceiptOperationLabel("replace"), "note_replace");
  assert.equal(formatReceiptOperationLabel("delete"), "note_delete");
  assert.equal(formatScopeList([]), "none");
  assert.equal(formatScopeList(["read_current_file", "web_fetch"]), "read_current_file,web_fetch");
  assert.equal(formatOptionalNumber(undefined), "default");
  assert.equal(formatOptionalNumber(0.2), "0.2");
  assert.equal(formatChars(512), "512 B");
  assert.equal(formatChars(2048), "2.0 KB");
  assert.equal(formatStepMetric(3, 12), "3 used (max 12)");
});

test("agent metric formatter preserves model and tool timing labels", () => {
  assert.equal(
    formatAgentMetric({
      kind: "model_chat",
      name: "model_chat",
      step: 2,
      durationMs: 123.4,
      requestChars: 2048,
      responseChars: 64,
      promptTokens: 10,
      completionTokens: 2,
      totalTokens: 12,
    }),
    "Timing: model step 2, 123ms, request 2.0 KB, response 64 B, prompt tokens 10, completion tokens 2, total tokens 12",
  );
  assert.equal(
    formatAgentMetric({
      kind: "tool",
      name: "read_current_file",
      durationMs: 9,
      cached: true,
      inputChars: 12,
      outputChars: 1024,
    }),
    "Cache hit: read_current_file, 9ms, input 12 B, output 1.0 KB",
  );
});
