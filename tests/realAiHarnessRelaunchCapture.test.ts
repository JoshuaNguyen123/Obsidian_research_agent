import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Page } from "@playwright/test";

import { relaunchPreservingToolCallCaptureV1 } from "../e2e/fixtures/realAiHarness";

/**
 * `relaunchOwnedProcess` destroys the page context, and with it the injected
 * collector and every unharvested segment. The repair is an ORDER, not a call:
 * harvest the outgoing page BEFORE the teardown, and arm the incoming page
 * BEFORE any lane work can drive it.
 *
 * These tests pin that order, and — critically — the last one replays the
 * pre-fix implementation through the SAME predicate to prove the predicate can
 * fail. An order assertion that also passes on the broken implementation would
 * be exactly the vacuous instrument this campaign exists to remove.
 */

function fakePage(label: string, closed = false): Page {
  return {
    __label: label,
    isClosed: () => closed,
  } as unknown as Page;
}

interface Trace {
  steps: string[];
  hooks: {
    harvest: (page: Page) => Promise<unknown>;
    arm: (page: Page) => Promise<void>;
  };
}

function tracer(): Trace {
  const steps: string[] = [];
  return {
    steps,
    hooks: {
      harvest: async (page: Page) => {
        steps.push(`harvest:${(page as unknown as { __label: string }).__label}`);
        return {};
      },
      arm: async (page: Page) => {
        steps.push(`arm:${(page as unknown as { __label: string }).__label}`);
      },
    },
  };
}

/**
 * The property under test, isolated so both the repaired seam and the pre-fix
 * implementation can be driven through it identically.
 */
function assertCaptureSurvivesRelaunch(steps: readonly string[]): void {
  const harvestOld = steps.indexOf("harvest:old");
  const teardown = steps.indexOf("teardown");
  const armNew = steps.indexOf("arm:new");
  const laneWork = steps.indexOf("afterReady:new");
  assert.notEqual(harvestOld, -1, "the outgoing page must be harvested");
  assert.notEqual(armNew, -1, "the incoming page must be re-armed");
  assert.ok(
    harvestOld < teardown,
    "the outgoing page must be harvested BEFORE the process is torn down",
  );
  assert.ok(
    armNew < laneWork,
    "the incoming page must be armed BEFORE any lane work runs on it",
  );
}

async function driveSeam(outgoing: Page, trace: Trace): Promise<void> {
  await relaunchPreservingToolCallCaptureV1({
    pageBeforeRelaunch: outgoing,
    relaunch: async (afterConnect) => {
      trace.steps.push("teardown");
      await afterConnect({ page: fakePage("new") });
    },
    afterReady: async ({ page }) => {
      trace.steps.push(
        `afterReady:${(page as unknown as { __label: string }).__label}`,
      );
    },
    hooks: trace.hooks,
  });
}

describe("relaunchPreservingToolCallCaptureV1", () => {
  it("harvests the outgoing page before teardown and arms the new page before lane work", async () => {
    const trace = tracer();
    await driveSeam(fakePage("old"), trace);
    assert.deepEqual(trace.steps, [
      "harvest:old",
      "teardown",
      "arm:new",
      "afterReady:new",
    ]);
    assertCaptureSurvivesRelaunch(trace.steps);
  });

  it("still arms the new page when the outgoing page is already closed", async () => {
    // An already-dead page has nothing to harvest, but the incoming process
    // must still be subscribed or every post-relaunch call is unobserved.
    const trace = tracer();
    await driveSeam(fakePage("old", true), trace);
    assert.deepEqual(trace.steps, ["teardown", "arm:new", "afterReady:new"]);
    assert.equal(
      trace.steps.some((step) => step.startsWith("harvest:")),
      false,
      "a closed page must not be harvested",
    );
  });

  it("tolerates a null outgoing page without skipping the re-arm", async () => {
    const trace = tracer();
    await relaunchPreservingToolCallCaptureV1({
      pageBeforeRelaunch: null,
      relaunch: async (afterConnect) => {
        trace.steps.push("teardown");
        await afterConnect({ page: fakePage("new") });
      },
      afterReady: async () => {
        trace.steps.push("afterReady:new");
      },
      hooks: trace.hooks,
    });
    assert.deepEqual(trace.steps, ["teardown", "arm:new", "afterReady:new"]);
  });

  it("PROVES THE PREDICATE CAN FAIL: the pre-fix relaunch loses capture on both sides", async () => {
    // Verbatim shape of the implementation before this repair: relaunch, then
    // the lane's readiness work, with no harvest and no re-arm anywhere.
    const steps: string[] = [];
    const legacyRelaunch = async () => {
      steps.push("teardown");
      steps.push("afterReady:new");
    };
    await legacyRelaunch();

    assert.throws(
      () => assertCaptureSurvivesRelaunch(steps),
      /the outgoing page must be harvested/u,
      "the pre-fix implementation MUST fail this predicate; if it passes, the predicate proves nothing",
    );
  });
});
