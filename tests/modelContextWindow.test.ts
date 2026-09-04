import test from "node:test";
import assert from "node:assert/strict";
import {
  dropUncallableToolSchemas,
  EARLY_COMPACTION_THRESHOLD_RATIO,
  resolveConversationCompactionThreshold,
  resolveVerifiedModelContextLength,
  shouldCompactConversationEarly,
} from "../src/agent/modelContextWindow";

const verified = {
  modelProvider: "ollama",
  model: "minimax-m3:cloud",
  modelConnectionVerifiedProvider: "ollama",
  modelConnectionVerifiedModel: "minimax-m3:cloud",
  modelConnectionVerifiedContextLength: 196_608,
};

test("verified context length resolves only for the matching ollama model", () => {
  assert.equal(resolveVerifiedModelContextLength(verified), 196_608);
  assert.equal(resolveVerifiedModelContextLength(undefined), null);
  assert.equal(resolveVerifiedModelContextLength(null), null);
  assert.equal(
    resolveVerifiedModelContextLength({ ...verified, model: "other:cloud" }),
    null,
  );
  assert.equal(
    resolveVerifiedModelContextLength({
      ...verified,
      modelConnectionVerifiedModel: "stale:cloud",
    }),
    null,
  );
  assert.equal(
    resolveVerifiedModelContextLength({
      ...verified,
      modelProvider: "openai_compatible",
      modelConnectionVerifiedProvider: "openai_compatible",
    }),
    null,
  );
  assert.equal(
    resolveVerifiedModelContextLength({
      ...verified,
      modelConnectionVerifiedProvider: undefined,
    }),
    null,
  );
});

test("conversation compaction trips at 40-50% of the prompt budget, not 85%", () => {
  const threshold = resolveConversationCompactionThreshold();
  assert.ok(threshold >= 0.4);
  assert.ok(threshold <= 0.5);
  assert.equal(threshold, EARLY_COMPACTION_THRESHOLD_RATIO);
  assert.equal(shouldCompactConversationEarly(44, 100), false);
  assert.equal(shouldCompactConversationEarly(46, 100), true);
  assert.equal(shouldCompactConversationEarly(84, 100), true);
});

test("uncallable frontier tool schemas are dropped from the context window", () => {
  const schemas = [
    { function: { name: "web_search" } },
    { function: { name: "append_to_current_file" } },
    { function: { name: "linear_create_issue" } },
  ];
  const kept = dropUncallableToolSchemas(
    schemas,
    new Set(["append_to_current_file"]),
  );
  assert.deepEqual(
    kept.map((schema) => schema.function.name),
    ["append_to_current_file"],
  );
});

test("verified context length rejects non-positive and non-integer values", () => {
  const invalidValues = [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    null,
    undefined,
  ];
  for (const value of invalidValues) {
    assert.equal(
      resolveVerifiedModelContextLength({
        ...verified,
        modelConnectionVerifiedContextLength: value as number | null | undefined,
      }),
      null,
    );
  }
});
