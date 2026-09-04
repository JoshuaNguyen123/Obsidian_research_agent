import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  measurePreloopModelCalls,
  resolvePreloopSkip,
  shouldSkipCurrentNotePrefetch,
  TARGET_ONLY_ESSAY_FIXTURE_PROMPT,
} from "../src/agent/preloopSkip";
import {
  DEFAULT_OLLAMA_UTILITY_MODEL,
  resolveSameProviderUtilityModel,
  resolveStructuredPreloopDecision,
} from "../src/agent/modelPhaseRouting";

const SETTINGS_SOURCE = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "src",
    "settings.ts",
  ),
  "utf8",
);

test("Metric A: target-only essay spends 0 preloop model calls", () => {
  const decision = resolveStructuredPreloopDecision({
    prompt: TARGET_ONLY_ESSAY_FIXTURE_PROMPT,
  });
  assert.equal(decision.reason, "target_only_write");
  assert.equal(decision.skipClassifyAndPlan, true);
  assert.equal(decision.preloopModelCalls, 0);
  assert.equal(
    measurePreloopModelCalls({ prompt: TARGET_ONLY_ESSAY_FIXTURE_PROMPT }),
    0,
  );
  assert.equal(shouldSkipCurrentNotePrefetch(TARGET_ONLY_ESSAY_FIXTURE_PROMPT), true);
});

test("sourced or edit prompts still pay classify + graph planner", () => {
  const sourced = resolvePreloopSkip({
    prompt: "Write a 300-word essay into this note with cited sources",
  });
  assert.equal(sourced.skipClassifyAndPlan, false);
  assert.equal(sourced.preloopModelCalls, 2);
  assert.equal(
    shouldSkipCurrentNotePrefetch(
      "Write a 300-word essay into this note with cited sources",
    ),
    false,
  );

  const edited = resolvePreloopSkip({
    prompt: "Edit the Introduction section of this note",
  });
  assert.equal(edited.preloopModelCalls, 2);
});

test("direct chat skips authority classify and plan", () => {
  const decision = resolveStructuredPreloopDecision({
    prompt: "From your perspective, what is missing from this platform?",
  });
  assert.equal(decision.reason, "direct_chat");
  assert.equal(decision.preloopModelCalls, 0);
});

test("prompt-on-page extracts the note prompt first and classifies once", () => {
  const note = [
    "# Task",
    "Summarize the attached meeting in five bullets.",
    "",
    "## Generated output",
    "old draft",
  ].join("\n");
  const decision = resolveStructuredPreloopDecision({
    prompt: "Follow the prompt on the page",
    noteMarkdown: note,
  });
  assert.equal(decision.reason, "prompt_on_page");
  assert.equal(decision.skipWrapperRouter, true);
  assert.equal(decision.classifyCount, 1);
  assert.equal(decision.embedCount, 1);
  assert.equal(decision.preloopModelCalls, 0);
  assert.match(decision.routingPrompt, /Summarize the attached meeting/);
  assert.doesNotMatch(decision.routingPrompt, /old draft/);
});

test("generate-into-empty and append skip current-note prefetch", () => {
  assert.equal(
    shouldSkipCurrentNotePrefetch("Generate a 300-word essay into this empty note"),
    true,
  );
  assert.equal(
    shouldSkipCurrentNotePrefetch("Append 5 action items to this note"),
    true,
  );
});

test("new installs default a same-provider fast utility model", () => {
  assert.match(
    SETTINGS_SOURCE,
    new RegExp(`specialistModel:\\s*"${DEFAULT_OLLAMA_UTILITY_MODEL}"`),
  );
  assert.match(
    SETTINGS_SOURCE,
    new RegExp(`utilityModel:\\s*"${DEFAULT_OLLAMA_UTILITY_MODEL}"`),
  );
  assert.match(SETTINGS_SOURCE, /model:\s*"glm-5\.3-flash:cloud"/);
  assert.notEqual("glm-5.3-flash:cloud", DEFAULT_OLLAMA_UTILITY_MODEL);
  assert.equal(
    resolveSameProviderUtilityModel({
      provider: "ollama",
      leadModel: "glm-5.3-flash:cloud",
    }),
    DEFAULT_OLLAMA_UTILITY_MODEL,
  );
  assert.equal(
    resolveSameProviderUtilityModel({
      provider: "ollama",
      leadModel: "glm-5.3-flash:cloud",
      configuredUtility: "",
    }),
    DEFAULT_OLLAMA_UTILITY_MODEL,
  );
});
