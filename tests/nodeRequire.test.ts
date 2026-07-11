import test from "node:test";
import assert from "node:assert/strict";
import { createPythonFastEmbedProvider } from "../src/embeddings/pythonFastEmbedProvider";
import {
  __setNodeRequireForTests,
  requireNodeModule,
} from "../src/platform/nodeRequire";
import type { AgentSettings } from "../src/settings";

test("requireNodeModule loads Node builtins through the available require", () => {
  __setNodeRequireForTests(require);
  try {
    const childProcess = requireNodeModule<typeof import("child_process")>(
      "child_process",
      "test",
    );

    assert.equal(typeof childProcess.spawn, "function");
  } finally {
    __setNodeRequireForTests(undefined);
  }
});

test("FastEmbed provider returns fallback-compatible failure when Node require is unavailable", async () => {
  __setNodeRequireForTests(null);
  try {
    const provider = createPythonFastEmbedProvider({
      semanticPythonCommand: "",
      semanticModelCacheDir: "",
    } as AgentSettings);
    const result = await provider.embed({
      model: "nomic-ai/nomic-embed-text-v1.5-Q",
      dim: 512,
      documents: ["local semantic note"],
      queries: ["local semantic query"],
    });

    assert.equal(result.ok, false);
    assert.equal(result.code, "node_runtime_unavailable");
    assert.match(result.message ?? "", /Node require is unavailable/);
  } finally {
    __setNodeRequireForTests(undefined);
  }
});
