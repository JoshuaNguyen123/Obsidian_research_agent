import assert from "node:assert/strict";
import test from "node:test";

import { parseOllamaChatResponse } from "../src/model/OllamaClient";
import { parseOpenAIChatResponse } from "../src/model/OpenAICompatibleClient";
import { parseProviderToolArguments } from "../src/model/toolArgumentNormalization";

test("provider tool arguments unwrap one redundant envelope and double encoding", () => {
  assert.deepEqual(
    parseProviderToolArguments({ arguments: { path: "Current.md" } }),
    { path: "Current.md" },
  );
  assert.deepEqual(
    parseProviderToolArguments(
      JSON.stringify(JSON.stringify({ query: "checkers rules" })),
    ),
    { query: "checkers rules" },
  );
  assert.deepEqual(
    parseProviderToolArguments({ input: "a real scalar tool field", path: "x" }),
    { input: "a real scalar tool field", path: "x" },
  );
});

test("Ollama and OpenAI-compatible responses recover wrapped tool arguments", () => {
  const ollama = parseOllamaChatResponse({
    message: {
      role: "assistant",
      content: "",
      tool_calls: [{
        function: {
          name: "read_file",
          arguments: { input: { path: "Research.md" } },
        },
      }],
    },
  });
  assert.deepEqual(ollama.toolCalls[0].arguments, { path: "Research.md" });

  const openAi = parseOpenAIChatResponse({
    choices: [{
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{
          id: "wrapped",
          function: {
            name: "web_search",
            arguments: JSON.stringify({ arguments: { query: "checkers rules" } }),
          },
        }],
      },
    }],
  });
  assert.deepEqual(openAi.toolCalls[0].arguments, { query: "checkers rules" });
});
