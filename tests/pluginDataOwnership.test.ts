import assert from "node:assert/strict";
import test from "node:test";

import { selectExtensionOwnedPluginData } from "../src/extensions/pluginDataOwnership";

test("core persistence preserves only exact extension-owned plugin namespaces", () => {
  const selected = selectExtensionOwnedPluginData({
    schemaVersion: 1,
    codeRuntimeState: { profile: "retained" },
    companionRuntimeState: { service: "retained" },
    backgroundGitHubHostStateV1: { binding: "retained" },
    ollamaApiKey: "must-not-survive",
    linearApiKey: "must-not-survive",
    githubApiToken: "must-not-survive",
    arbitraryFutureField: { unowned: true },
  });

  assert.deepEqual(selected, {
    schemaVersion: 1,
    codeRuntimeState: { profile: "retained" },
    companionRuntimeState: { service: "retained" },
    backgroundGitHubHostStateV1: { binding: "retained" },
  });
});

test("extension-owned projection tolerates missing legacy data", () => {
  assert.deepEqual(selectExtensionOwnedPluginData(null), {});
  assert.deepEqual(selectExtensionOwnedPluginData([]), {});
});
