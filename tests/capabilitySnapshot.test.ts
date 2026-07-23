import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCapabilitySnapshotV1,
  formatCapabilitySnapshotForModel,
} from "../src/agent/capabilitySnapshot";

test("capability snapshot distinguishes availability and normalizes current-note authority", () => {
  const snapshot = buildCapabilitySnapshotV1({
    installed: ["read_current_note", "web_search"],
    authorized: ["web_search"],
    ready: ["web_search"],
    offered: ["read_current_note"],
    withheld: [
      {
        toolName: "github_delete_private_repository",
        reason: "delete_repo credential unavailable",
      },
    ],
    currentNote: {
      authorized: true,
      contextInjected: true,
      callableTool: "read_current_file",
    },
    provider: { provider: "ollama", model: "qwen-test" },
  });

  assert.deepEqual(snapshot.entries, [
    {
      toolName: "github_delete_private_repository",
      availability: ["withheld"],
      withheldReason: "delete_repo credential unavailable",
    },
    {
      toolName: "read_current_file",
      availability: ["installed", "offered"],
    },
    {
      toolName: "web_search",
      availability: ["installed", "authorized", "ready"],
    },
  ]);
  assert.equal(
    formatCapabilitySnapshotForModel(snapshot),
    [
      "CAPABILITY_SNAPSHOT_V1",
      "installed: read_current_file, web_search",
      "authorized: web_search",
      "ready: web_search",
      "offered_now: read_current_file",
      "withheld: github_delete_private_repository (delete_repo credential unavailable)",
      "current_note: authorized=true; context_injected=true; callable_tool=read_current_file",
      "provider: ollama; model=qwen-test",
      "The current frontier is a temporary callable subset, not the platform catalog.",
      "Authorization does not guarantee current exposure. Only offered_now tools may be called.",
      "`read_current_note` is an authority label mapped to `read_current_file`, not a missing tool.",
    ].join("\n"),
  );
});
