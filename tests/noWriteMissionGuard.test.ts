import assert from "node:assert/strict";
import test from "node:test";

import { missionForbidsNoteMutationV1 } from "../src/agent/noWriteMissionGuard";

const DU02_CACHE_READ =
  "Call web_fetch once for the exact already-fetched URL https://primary.owned.example/evidence/marker with refresh=false. Verify the cached passage is readable, do not search, and do not write or edit any note.";

const DU02_SOURCED_APPEND =
  "Search the web for the owned alpha and beta evidence, fetch both returned sources, and append a ## Findings section to the current note. Do not write before fetch, comparison, and verification.";

const READ_ONLY_TOOLS = ["web_fetch", "read_current_file", "read_file", "count_words"];

test("DU-02 exact cache follow-up forbids note mutation (fail-closed)", () => {
  assert.equal(
    missionForbidsNoteMutationV1({ userPrompt: DU02_CACHE_READ }),
    true,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt: `[agentic-daily-use:DU-02] ${DU02_CACHE_READ}`,
    }),
    true,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt: DU02_CACHE_READ,
      allowedToolNames: READ_ONLY_TOOLS,
    }),
    true,
  );
});

test("sourced research append missions allow note mutation", () => {
  assert.equal(
    missionForbidsNoteMutationV1({ userPrompt: DU02_SOURCED_APPEND }),
    false,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt:
        "Research controlled onboarding validation and append your findings to the current note with citations.",
    }),
    false,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt:
        "Search the web, fetch two sources, and write a ## Findings section into this note.",
    }),
    false,
  );
});

test("explicit no-write phrasings forbid note mutation", () => {
  for (const prompt of [
    "What is 2+2? Answer in chat only; do not write to the note.",
    "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
    "Respond in chat please",
    "Verify the summary and do not edit any note.",
    "Read the cache and do not write or edit any note.",
  ]) {
    assert.equal(
      missionForbidsNoteMutationV1({ userPrompt: prompt }),
      true,
      prompt,
    );
  }
});

test("sequencing-only do-not-write-before does not forbid eventual writeback", () => {
  assert.equal(
    missionForbidsNoteMutationV1({ userPrompt: DU02_SOURCED_APPEND }),
    false,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt:
        "Fetch sources first. Do not write before verification, then append findings to the current note.",
    }),
    false,
  );
});

test("write tools in catalogue do not override an explicit no-write mission", () => {
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt: DU02_CACHE_READ,
      allowedToolNames: [...READ_ONLY_TOOLS, "append_to_current_file"],
    }),
    true,
  );
});

test("ordinary chat questions without write refusal stay permissive", () => {
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt: "Summarize the active note for me.",
    }),
    false,
  );
  assert.equal(
    missionForbidsNoteMutationV1({
      userPrompt: "What does the current note say about onboarding?",
    }),
    false,
  );
});
