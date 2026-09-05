import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { approveUntilMissionComplete } from "../e2e/fixtures/realAiHarness";

for (const limit of [0, 1, 2]) {
  test(`the live driver performs at most ${limit} requested continuation clicks`, async () => {
    let clicks = 0;
    const reported: number[] = [];
    const state = {
      runText: "Run Mission", statusText: "Idle", hasEnabledApproval: false,
      pluginRunning: false, stopReason: "budget", autoContinueReason: "segment_limit",
      canResume: true, continuationCommand: "continue run continuation-limit-fixture",
      acceptanceStatus: "needs_more_work", ledgerStatus: "blocked",
      ledger: { status: "blocked" }, graph: [], diagnostics: [], modelCallPhases: [],
      hasGraphBlocker: false, projectStages: [], durablyCompletedLifecycleTools: [],
      providerUsageScopeId: "usage-fixture", coordinatorModelCalls: 1,
    };
    const page = {
      isClosed: () => false,
      evaluate: async (_callback: unknown, input: any) => {
        if (Array.isArray(input?.allowedToolNames)) return null;
        if (typeof input?.launchBaseline === "string") return "acknowledged";
        return state;
      },
      getByRole: () => ({ isVisible: async () => true, isEnabled: async () => true,
        click: async () => { clicks += 1; if (clicks > 3) throw new Error("Runaway driver"); } }),
      waitForTimeout: async () => {},
    } as unknown as Page;
    await assert.rejects(approveUntilMissionComplete(page, 2000, {
      maxContinuations: limit, onProgress: (progress) => reported.push(progress.continuations),
    }), /continuations/u);
    assert.equal(clicks, limit, "the configured cap must govern actual UI actions");
    assert.ok(reported.every((count) => count <= clicks), "a blocked attempt is not a performed continuation");
  });
}
