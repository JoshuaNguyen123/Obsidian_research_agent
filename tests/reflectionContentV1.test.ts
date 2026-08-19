import assert from "node:assert/strict";
import test from "node:test";

import {
  assertMeaningfulReflectionContentV1,
  hasMeaningfulReflectionContentV1,
  ReflectionContentErrorV1,
} from "../packages/core-api/src/reflectionContentV1";

test("reflection content requires explanatory prose beyond markers and URLs", () => {
  const meaningful = [
    "## Mission completion reflection",
    "<!-- agentic-initiating-reflection:run-1 -->",
    "The implementation now validates each requested value before publication and reports a clear error when the input is unsafe.",
    "https://github.com/acme/repo/pull/1",
  ].join("\n\n");
  assert.equal(assertMeaningfulReflectionContentV1(meaningful), meaningful);
  assert.equal(hasMeaningfulReflectionContentV1(meaningful), true);

  for (const invalid of [
    "<!-- agentic-initiating-reflection:run-1 -->",
    "## Done\n\nhttps://linear.app/acme/issue/ABC-1\nhttps://github.com/acme/repo/pull/1",
    "## Example\n\n```ts\nexport const value = 42;\n```",
  ]) {
    assert.throws(
      () => assertMeaningfulReflectionContentV1(invalid),
      (error: unknown) => error instanceof ReflectionContentErrorV1,
    );
    assert.equal(hasMeaningfulReflectionContentV1(invalid), false);
  }
});
