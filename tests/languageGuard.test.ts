import test from "node:test";
import assert from "node:assert/strict";
import {
  assertEnglishOnlyOutput,
  buildEnglishOnlyRepairPrompt,
  inspectEnglishOnlyOutput,
  isLikelyEnglishPrompt,
  requestsNonEnglishOutput,
  shouldEnforceEnglishOutput,
} from "../src/languageGuard";

test("english-only guard detects CJK and ignores URLs", () => {
  const result = inspectEnglishOnlyOutput(
    "Use this English summary. Source: https://example.com/%E4%B8%AD%E6%96%87",
  );
  assert.equal(result.ok, true);
  assert.equal(result.cjkCount, 0);

  const cjkResult = inspectEnglishOnlyOutput("Axios 请求 flow summary.");
  assert.equal(cjkResult.ok, false);
  assert.equal(cjkResult.reason, "cjk_detected");
  assert.equal(cjkResult.cjkCount, 2);
});

test("the guard stands down for an English prompt that asks for CJK output", () => {
  assert.equal(isLikelyEnglishPrompt("Summarize this article for me"), true);
  assert.equal(isLikelyEnglishPrompt("把这段翻译成中文"), false);
  assert.equal(shouldEnforceEnglishOutput("Summarize this article for me"), true);
  assert.equal(shouldEnforceEnglishOutput("Translate this note into Japanese"), false);
  assert.equal(shouldEnforceEnglishOutput("Give me a Chinese translation of the summary"), false);
  assert.equal(shouldEnforceEnglishOutput("把这段翻译成中文"), false, "a CJK prompt was never guarded");
  assert.equal(requestsNonEnglishOutput("Write it in plain English"), false);
});

test("english-only guard exposes repair prompt and throws on CJK", () => {
  assert.doesNotThrow(() => assertEnglishOnlyOutput("English markdown only."));
  assert.throws(
    () => assertEnglishOnlyOutput("中文 output"),
    /English-only guard failed: cjk_detected/,
  );
  assert.match(buildEnglishOnlyRepairPrompt(), /Rewrite the previous answer/);
});
