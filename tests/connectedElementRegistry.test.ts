import assert from "node:assert/strict";
import test from "node:test";

import { getConnectedRegistryElement } from "../src/ui/connectedElementRegistry";

test("connected element registry evicts stale entries before replay accounting", () => {
  const stale = { isConnected: false };
  const registry = new Map<string, { isConnected: boolean }>([["trace-1", stale]]);

  assert.equal(getConnectedRegistryElement(registry, "trace-1"), null);
  assert.equal(registry.has("trace-1"), false);

  const replayed = { isConnected: true };
  registry.set("trace-1", replayed);
  assert.equal(getConnectedRegistryElement(registry, "trace-1"), replayed);
  assert.equal(registry.size, 1);
});
