import { expect, test } from "@playwright/test";

import { startPhase3EffectfulCompanionHarness } from "./fixtures/phase3EffectfulCompanionHarness";

test.describe("phase-3 authenticated companion continuation", () => {
  test("effectful Linear dispatch survives disconnect and completes only from readback", async () => {
    test.skip(process.platform !== "win32", "Native Obsidian E2E runs on Windows.");
    test.setTimeout(300_000);

    const harness = await startPhase3EffectfulCompanionHarness();
    try {
      const prompt = [
        "E2E_EFFECTFUL_LINEAR_BACKGROUND",
        harness.marker,
        "Continue in the background while Obsidian may close.",
        "Update Linear issue issue-42 to state state-done.",
      ].join(" ");
      await harness.submitMission(prompt);

      await harness.page.getByRole("tab", { name: "Run Details" }).click();
      const approval = harness.activeApproval();
      await expect(approval).toBeVisible({ timeout: 60_000 });
      await expect(approval).toContainText("issue-42");
      await expect(approval).toContainText("state-done");
      await harness.approve(approval);

      await harness.waitForRemoteSubmission();
      const submitted = await harness.readSnapshot();
      expect(submitted.walPresentBeforePost).toBe(true);
      expect(submitted.postCount).toBe(1);
      expect(submitted.foregroundMutationCount).toBe(0);

      await harness.disconnectCompanion();
      await harness.waitForRemoteCompletion();

      const disconnected = await harness.readSnapshot();
      expect(disconnected.remoteState).toBe("complete");
      expect(disconnected.providerMutationCount).toBe(1);
      expect(disconnected.foregroundMutationCount).toBe(0);
      expect(disconnected.runtimeJournal?.state).not.toBe("committed");

      await harness.reconnectCompanion();
      await expect
        .poll(async () => {
          const snapshot = await harness.readSnapshot();
          return {
            journal: snapshot.runtimeJournal?.state ?? null,
            graph: snapshot.graphNode?.status ?? null,
            lineage: snapshot.lineage?.state ?? null,
          };
        }, {
          timeout: 90_000,
          message: "reconnect should reconcile verified companion proof into the journal and graph",
        })
        .toEqual({ journal: "committed", graph: "complete", lineage: "complete" });

      const completed = await harness.readSnapshot();
      expect(completed.walPresentBeforePost).toBe(true);
      expect(completed.postCount).toBe(1);
      expect(completed.providerMutationCount).toBe(1);
      expect(completed.foregroundMutationCount).toBe(0);
      expect(completed.modelToolCallCount).toBe(1);
      expect(completed.receiptStatuses).toEqual([
        "dispatched",
        "ambiguous",
        "verified",
      ]);
      expect(completed.verifiedReconciliationMode).toBe("readback_only");
      expect(completed.runtimeJournal?.attemptStatus).toBe("readback_verified");
      expect(completed.runtimeJournal?.jobId).toBeTruthy();
      expect(completed.runtimeJournal?.handoffFingerprint).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(completed.runtimeJournal?.verifiedReceiptFingerprint).toMatch(
        /^sha256:[0-9a-f]{64}$/u,
      );
      expect(completed.runtimeJournal?.transitionStates).toEqual(
        expect.arrayContaining([
          "dispatched",
          "ambiguous",
          "readback_verified",
          "committed",
        ]),
      );
      expect(completed.graphNode?.receiptKinds).toContain(
        "external:linear:linear_issue_state_update_v1",
      );
      expect(completed.graphNode?.evidenceKinds).toContain("linear_readback");
      expect(completed.graphNode?.verifierId).toBe("companion-external-result-v1");
      expect(completed.lineage?.reconcileStatus).toBe("reconciled");
      expect(completed.lineage?.lastObservedEventSequence).toBeGreaterThan(0);
      expect(completed.lineage?.lastAppliedEventSequence).toBe(
        completed.lineage?.lastObservedEventSequence,
      );

      await expect
        .poll(async () => {
          const snapshot = await harness.readSnapshot();
          return {
            posts: snapshot.postCount,
            providerMutations: snapshot.providerMutationCount,
            foregroundMutations: snapshot.foregroundMutationCount,
          };
        }, { timeout: 5_000 })
        .toEqual({ posts: 1, providerMutations: 1, foregroundMutations: 0 });
    } finally {
      await harness.close();
    }
  });
});
