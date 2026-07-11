import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyRecommendedAutomaticDefaults,
  detectInstallKind,
  normalizeAgentSettings,
  SETTINGS_SCHEMA_VERSION,
} from "../src/agent/settingsNormalize";
import {
  allocateUniqueMarkdownPath,
} from "../src/agent/placeholderNoteTitle";
import {
  resolveAutonomousNoteTarget,
} from "../src/agent/autonomousNoteTarget";

describe("settingsNormalize", () => {
  it("new installs resolve to Automatic and active_or_new_note", () => {
    assert.equal(detectInstallKind({}), "new_install");
    const settings = normalizeAgentSettings({}, "new_install");
    assert.equal(settings.autonomyProfile, "automatic");
    assert.equal(settings.outputProfile, "active_or_new_note");
    assert.equal(settings.enableStreaming, true);
    assert.equal(settings.streamWritebackMode, "all_current_note_content_writes");
    assert.equal(settings.autoTitleOnWrite, true);
    assert.equal(settings.settingsSchemaVersion, SETTINGS_SCHEMA_VERSION);
  });

  it("legacy explicit false values resolve to Custom and remain false", () => {
    const settings = normalizeAgentSettings(
      {
        enableStreaming: false,
        streamWritebackMode: "off",
        autoTitleOnWrite: false,
        ollamaApiKey: "secret-key",
      },
      "existing_install",
    );
    assert.equal(settings.autonomyProfile, "custom");
    assert.equal(settings.enableStreaming, false);
    assert.equal(settings.streamWritebackMode, "off");
    assert.equal(settings.autoTitleOnWrite, false);
    assert.equal(settings.ollamaApiKey, "secret-key");
  });

  it("malformed streaming flags normalize without losing credentials", () => {
    const settings = normalizeAgentSettings(
      {
        enableStreaming: "yes",
        streamWritebackMode: "bogus",
        autoTitleOnWrite: "nope",
        openAiCompatibleApiKey: "sk-test",
        linearDefaultTeamId: "team-1",
      },
      "existing_install",
    );
    assert.equal(typeof settings.enableStreaming, "boolean");
    assert.ok(
      settings.streamWritebackMode === "off" ||
        settings.streamWritebackMode === "all_current_note_content_writes",
    );
    assert.equal(settings.openAiCompatibleApiKey, "sk-test");
    assert.equal(settings.linearDefaultTeamId, "team-1");
  });

  it("recommended defaults action moves Custom to Automatic", () => {
    const custom = normalizeAgentSettings(
      {
        enableStreaming: false,
        streamWritebackMode: "off",
        autoTitleOnWrite: false,
        ollamaApiKey: "keep-me",
      },
      "existing_install",
    );
    const recommended = applyRecommendedAutomaticDefaults(custom);
    assert.equal(recommended.autonomyProfile, "automatic");
    assert.equal(recommended.outputProfile, "active_or_new_note");
    assert.equal(recommended.enableStreaming, true);
    assert.equal(recommended.ollamaApiKey, "keep-me");
  });
});

describe("autonomousNoteTarget path allocation", () => {
  it("allocates unique markdown paths without overwrite", () => {
    const existing = new Set(["Notes/Untitled.md"]);
    const path = allocateUniqueMarkdownPath(
      "Notes/Untitled.md",
      (candidate) => existing.has(candidate),
    );
    assert.equal(path, "Notes/Untitled 2.md");
  });

  it("prefers explicit folder then vault root", () => {
    const fakeApp = {
      vault: {
        getAbstractFileByPath: () => null,
      },
      fileManager: {},
    } as never;
    const target = resolveAutonomousNoteTarget({
      app: fakeApp,
      explicitFolderOrPath: "Research",
      preferredBasename: "Untitled",
      exists: () => false,
    });
    assert.equal(target.path, "Research/Untitled.md");
    assert.equal(target.reason, "explicit_folder");
  });
});
