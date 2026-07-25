import test from "node:test";
import assert from "node:assert/strict";
import { resolveVerifiedModelContextLength } from "../src/agent/modelContextWindow";

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
