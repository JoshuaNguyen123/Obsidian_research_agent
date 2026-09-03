import assert from "node:assert/strict";
import test from "node:test";
import {
  hasCodeDeliverableIntent,
  hasProseDocumentWriteObject,
  isLanguageNamedOnlyAsTopicModifier,
} from "../src/agent/codeDeliverableIntent";
import { hasCodeExecutionIntent } from "../src/agent/promptIntentClassifiers";
import { detectProjectLifecycleStagesV1 } from "../src/agent/projectLifecycle";

const LIVE_DFS_BFS_BRIEF = "Write me brief about dfs and bfs in python";

test("write me brief about dfs/bfs in python is a note, not a code deliverable", () => {
  assert.equal(hasProseDocumentWriteObject(LIVE_DFS_BFS_BRIEF), true);
  assert.equal(isLanguageNamedOnlyAsTopicModifier(LIVE_DFS_BFS_BRIEF), true);
  assert.equal(hasCodeDeliverableIntent(LIVE_DFS_BFS_BRIEF), false);
  assert.equal(hasCodeExecutionIntent(LIVE_DFS_BFS_BRIEF), false);
  assert.equal(
    detectProjectLifecycleStagesV1(LIVE_DFS_BFS_BRIEF).includes("code_execution"),
    false,
  );
});

test("informal and article forms of a language-topic brief stay notes", () => {
  for (const prompt of [
    "Write me a brief about dfs and bfs in python",
    "write a brief about dfs and bfs in python",
    "Write me brief about DFS and BFS in Python.",
    "write an explanation about breadth-first search in python",
  ]) {
    assert.equal(hasCodeDeliverableIntent(prompt), false, prompt);
    assert.equal(hasCodeExecutionIntent(prompt), false, prompt);
  }
});

test("brief as adjective on a python script remains a code deliverable", () => {
  assert.equal(
    hasProseDocumentWriteObject("write me a brief python script"),
    false,
  );
  assert.equal(hasCodeDeliverableIntent("write me a brief python script"), true);
  assert.equal(
    hasCodeDeliverableIntent("write a number guessing game in python"),
    true,
  );
});
