import assert from "node:assert/strict";
import test from "node:test";

import { LatestRenderGate } from "../src/ui/latestRenderGate";

test("LatestRenderGate accepts only the newest render for a target", () => {
  const gate = new LatestRenderGate<object>();
  const target = {};
  const first = gate.begin(target);
  const second = gate.begin(target);

  assert.equal(gate.isCurrent(target, first), false);
  assert.equal(gate.isCurrent(target, second), true);
});

test("LatestRenderGate isolates targets and supports explicit invalidation", () => {
  const gate = new LatestRenderGate<object>();
  const firstTarget = {};
  const secondTarget = {};
  const first = gate.begin(firstTarget);
  const second = gate.begin(secondTarget);

  assert.equal(gate.isCurrent(firstTarget, first), true);
  assert.equal(gate.isCurrent(secondTarget, second), true);
  gate.invalidate(firstTarget);
  assert.equal(gate.isCurrent(firstTarget, first), false);
  assert.equal(gate.isCurrent(secondTarget, second), true);
});
