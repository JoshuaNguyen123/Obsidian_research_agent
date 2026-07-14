import assert from "node:assert/strict";
import test from "node:test";

import {
  createEmptyBundledCapabilityData,
  importLegacyBundledCapabilityData,
  parseBundledCapabilityData,
  readBundledCapabilityState,
  writeBundledCapabilityState,
} from "../src/extensions/bundledCapabilityData";

const CREATED_AT = "2026-07-13T12:00:00.000Z";
const IMPORTED_AT = "2026-07-13T12:01:00.000Z";

test("bundled capability data imports each legacy plugin namespace once", () => {
  const imported = importLegacyBundledCapabilityData({
    current: createEmptyBundledCapabilityData(CREATED_AT),
    legacy: {
      code: { schemaVersion: 1, codeRuntimeState: { revision: 4 } },
      integrations: {
        schemaVersion: 1,
        backgroundGitHubHostStateV1: { revision: 2 },
      },
      companion: {
        schemaVersion: 1,
        companionRuntimeState: { serviceInstalled: true },
      },
    },
    importedAt: IMPORTED_AT,
  });

  assert.deepEqual(imported.imported, ["code", "integrations", "companion"]);
  assert.equal(
    imported.data.modules.code.legacyImport?.sourcePluginId,
    "agentic-researcher-code",
  );
  assert.match(
    imported.data.modules.code.legacyImport?.sourceFingerprint ?? "",
    /^sha256:[0-9a-f]{64}$/u,
  );
  assert.deepEqual(readBundledCapabilityState(imported.data, "companion"), {
    schemaVersion: 1,
    companionRuntimeState: { serviceInstalled: true },
  });

  const repeated = importLegacyBundledCapabilityData({
    current: imported.data,
    legacy: { code: { replaced: true } },
    importedAt: "2026-07-13T12:02:00.000Z",
  });
  assert.deepEqual(repeated.imported, []);
  assert.equal(
    readBundledCapabilityState(repeated.data, "code").replaced,
    undefined,
  );
});

test("bundled capability writes preserve import provenance and other modules", () => {
  const imported = importLegacyBundledCapabilityData({
    current: createEmptyBundledCapabilityData(CREATED_AT),
    legacy: { code: { schemaVersion: 1, old: true } },
    importedAt: IMPORTED_AT,
  }).data;
  const next = writeBundledCapabilityState({
    current: imported,
    namespace: "code",
    state: { schemaVersion: 1, current: true },
    updatedAt: "2026-07-13T12:03:00.000Z",
  });

  assert.deepEqual(readBundledCapabilityState(next, "code"), {
    schemaVersion: 1,
    current: true,
  });
  assert.equal(
    next.modules.code.legacyImport?.sourceFingerprint,
    imported.modules.code.legacyImport?.sourceFingerprint,
  );
  assert.deepEqual(readBundledCapabilityState(next, "integrations"), {});
  assert.deepEqual(
    parseBundledCapabilityData(next, CREATED_AT),
    next,
  );
});

test("bundled capability data rejects unknown persisted keys", () => {
  const valid = createEmptyBundledCapabilityData(CREATED_AT);
  assert.throws(
    () =>
      parseBundledCapabilityData(
        { ...valid, unexpected: true },
        CREATED_AT,
      ),
    /keys are invalid/u,
  );
});
