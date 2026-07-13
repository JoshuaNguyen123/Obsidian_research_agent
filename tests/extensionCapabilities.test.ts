import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_EXTENSION_ID,
  COMPANION_EXTENSION_ID,
  INTEGRATIONS_EXTENSION_ID,
  extensionIdForCapability,
  resolveOptionalExtensionCapabilities,
} from "../src/extensions/extensionCapabilities";

test("optional capabilities derive only from exact live extension ids", () => {
  assert.deepEqual(resolveOptionalExtensionCapabilities([]), {
    code: false,
    integrations: false,
    companion: false,
  });
  assert.deepEqual(
    resolveOptionalExtensionCapabilities([
      CODE_EXTENSION_ID,
      INTEGRATIONS_EXTENSION_ID,
      COMPANION_EXTENSION_ID,
      "agentic-researcher-code-lookalike",
    ]),
    { code: true, integrations: true, companion: true },
  );
});

test("registered extensions expose no capability until their migration is verified", () => {
  const registered = [
    CODE_EXTENSION_ID,
    INTEGRATIONS_EXTENSION_ID,
    COMPANION_EXTENSION_ID,
  ];
  assert.deepEqual(resolveOptionalExtensionCapabilities(registered, []), {
    code: false,
    integrations: false,
    companion: false,
  });
  assert.deepEqual(
    resolveOptionalExtensionCapabilities(registered, [
      CODE_EXTENSION_ID,
      COMPANION_EXTENSION_ID,
    ]),
    { code: true, integrations: false, companion: true },
  );
});

test("optional capability ownership is stable", () => {
  assert.equal(extensionIdForCapability("code"), CODE_EXTENSION_ID);
  assert.equal(
    extensionIdForCapability("integrations"),
    INTEGRATIONS_EXTENSION_ID,
  );
  assert.equal(extensionIdForCapability("companion"), COMPANION_EXTENSION_ID);
});
