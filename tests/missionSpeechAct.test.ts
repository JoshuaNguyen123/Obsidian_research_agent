import assert from "node:assert/strict";
import test from "node:test";

import { classifyMissionSpeechAct } from "../src/agent/missionSpeechAct";

test("analytical prompts remain direct chat", () => {
  for (const prompt of [
    "Is the red list the complete current set of fully-agentic gaps or only the immediate closure slice?",
    "Analyze the current implementation and explain which proof lanes are still missing.",
    "The current platform that I created to give you tools, NO specific document, I want you to rate actual usefulness",
    "From your perspective, what is hard about doing research in obsidian, agentically, converting the notebook into Linear issues, Linear issues to real code project code files, github and fianlly a reflection ?",
  ]) {
    const result = classifyMissionSpeechAct(prompt);
    assert.ok(["explain", "evaluate"].includes(result.speechAct));
    assert.equal(result.executionTier, "direct_chat");
  }
});

test("explicit imperative compound prompt becomes a durable mission", () => {
  const result = classifyMissionSpeechAct(
    "Run the full pipeline: create a Linear issue, implement and validate the repository workspace, publish to private GitHub, then append the reflection to the current note.",
  );
  assert.equal(result.speechAct, "execute");
  assert.equal(result.executionTier, "durable_mission");
  assert.ok(result.reasons.includes("explicit_execution"));
  assert.ok(result.reasons.includes("compound_stage_request"));
});

test("domain nouns alone do not create execution authority", () => {
  const result = classifyMissionSpeechAct(
    "How do Linear, code files, GitHub, and reflection fit together?",
  );
  assert.equal(result.speechAct, "explain");
  assert.equal(result.executionTier, "direct_chat");
});

test("an explicit request to make a diagram is executable", () => {
  const result = classifyMissionSpeechAct(
    "Using design tools can you make a diagram?",
  );
  assert.equal(result.speechAct, "execute");
  assert.equal(result.executionTier, "bounded_tool");
});

test("tool-dependent imperatives are not mistaken for analytical chat", () => {
  for (const prompt of [
    "Seed the default starter templates in my vault.",
    "Revise the Mermaid diagram under the Architecture heading in Designs/System.md.",
    "Count the words in the current note.",
    "Read the GitHub pull request status and summarize the checks without changing anything.",
    "Close GitHub issue 12 in repository profile trusted-repository.",
    "Search the web for the latest Obsidian release and cite the source.",
  ]) {
    assert.notEqual(
      classifyMissionSpeechAct(prompt).executionTier,
      "direct_chat",
      prompt,
    );
  }
});

test("single writes are bounded persistence and explicit resume is durable", () => {
  assert.deepEqual(
    classifyMissionSpeechAct("Append this summary to the current note"),
    {
      speechAct: "persist",
      executionTier: "bounded_tool",
      reasons: ["explicit_persistence"],
      explicitChatOnly: false,
    },
  );
  assert.equal(
    classifyMissionSpeechAct("Continue the latest run").speechAct,
    "continue",
  );
});
