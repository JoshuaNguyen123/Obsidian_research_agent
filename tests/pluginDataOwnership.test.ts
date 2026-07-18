import assert from "node:assert/strict";
import test from "node:test";

import { selectExtensionOwnedPluginData } from "../src/extensions/pluginDataOwnership";

test("core persistence preserves only exact extension-owned plugin namespaces", () => {
  const selected = selectExtensionOwnedPluginData({
    schemaVersion: 1,
    codeRuntimeState: { profile: "retained" },
    codeRepairCheckpointsV1: { revision: 3, checkpoints: { repair: "retained" } },
    codeValidationReceiptsV1: { revision: 4, receipts: { validation: "retained" } },
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
    codeRepairCheckpointsV1: { revision: 3, checkpoints: { repair: "retained" } },
    codeValidationReceiptsV1: { revision: 4, receipts: { validation: "retained" } },
    companionRuntimeState: { service: "retained" },
    backgroundGitHubHostStateV1: { binding: "retained" },
  });
});

test("extension-owned projection tolerates missing legacy data", () => {
  assert.deepEqual(selectExtensionOwnedPluginData(null), {});
  assert.deepEqual(selectExtensionOwnedPluginData([]), {});
});
