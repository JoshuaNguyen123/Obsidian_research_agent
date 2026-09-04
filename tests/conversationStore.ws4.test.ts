import assert from "node:assert/strict";
import test from "node:test";
import { resolveConversationHistoryOnProjectLoadV1 } from "../src/conversationHistory";
import {
  conversationPersistTargetsV1,
  getProjectMemoryLocation,
  isFolderScopedProjectMemoryV1,
} from "../src/agent/projectMemory";

test("conversation leak: a folder without a history file starts empty", () => {
  const previousFolder = getProjectMemoryLocation("Projects/Alpha/Note.md");
  const nextFolder = getProjectMemoryLocation("Projects/Beta/Note.md");
  assert.equal(isFolderScopedProjectMemoryV1(previousFolder), true);
  assert.equal(isFolderScopedProjectMemoryV1(nextFolder), true);
  assert.notEqual(previousFolder.conversationPath, nextFolder.conversationPath);

  const leaked = resolveConversationHistoryOnProjectLoadV1({
    folderScoped: true,
    folderHistory: null,
    pluginDataHistory: [
      { role: "user", content: "transcript that belongs to Projects/Alpha" },
    ],
  });
  assert.deepEqual(
    leaked,
    [],
    "loading Beta with no conversation-history.json must not keep Alpha's chat",
  );
});

test("single conversation store: folder JSON xor data.json", () => {
  assert.deepEqual(conversationPersistTargetsV1(true), {
    pluginData: false,
    folderJson: true,
  });
  assert.deepEqual(conversationPersistTargetsV1(false), {
    pluginData: true,
    folderJson: false,
  });
});
