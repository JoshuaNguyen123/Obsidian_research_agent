import assert from "node:assert/strict";
import test from "node:test";
import {
  createElectronKeepAwakeController,
  type ElectronPowerSaveBlocker,
} from "../src/platform/electronKeepAwake";

test("electron keep-awake lease starts and releases exactly once", async () => {
  const active = new Set<number>();
  let starts = 0;
  let stops = 0;
  const blocker: ElectronPowerSaveBlocker = {
    start: (mode) => {
      assert.equal(mode, "prevent-app-suspension");
      starts += 1;
      active.add(17);
      return 17;
    },
    isStarted: (id) => active.has(id),
    stop: (id) => {
      stops += 1;
      return active.delete(id);
    },
  };

  const controller = createElectronKeepAwakeController(blocker);
  const lease = await controller.acquire({ missionId: "mission-overnight" });
  assert.equal(controller.supported, true);
  assert.equal(lease.acquired, true);
  assert.equal(lease.warning, undefined);
  assert.equal(starts, 1);

  await lease.release();
  await lease.release();
  assert.equal(lease.released, true);
  assert.equal(stops, 1);
});

test("electron keep-awake failure is visible without claiming protection", async () => {
  const blocker: ElectronPowerSaveBlocker = {
    start: () => {
      throw new Error("native blocker unavailable");
    },
    isStarted: () => false,
    stop: () => false,
  };

  const lease = await createElectronKeepAwakeController(blocker).acquire({
    missionId: "mission-fallback",
  });
  assert.equal(lease.acquired, false);
  assert.match(lease.warning ?? "", /native blocker unavailable/);
  await lease.release();
  assert.equal(lease.released, true);
});
