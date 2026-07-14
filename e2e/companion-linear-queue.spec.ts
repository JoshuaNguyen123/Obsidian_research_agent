import { expect, test } from "@playwright/test";

import { startCompanionLinearQueueHarness } from "./fixtures/companionLinearQueueHarness";

test.describe("companion-owned Linear queue polling", () => {
  test("re-enters foreground from verified readback and consumes a terminal blocker once", async () => {
    test.skip(process.platform !== "win32", "Native Obsidian E2E runs on Windows.");
    test.setTimeout(300_000);

    const harness = await startCompanionLinearQueueHarness();
    try {
      const configured = await harness.readSnapshot();
      expect(configured.authorization?.ok).toBe(true);
      expect(configured.configuration).not.toBeNull();
      expect(configured.activeGrant).not.toBeNull();
      expect(configured.configurationDriftCount).toBe(0);
      expect(configured.unexpectedDisableAfterConfigure).toBe(0);
      expect(configured.configuration).toMatchObject({
        version: 1,
        workspaceId: "e2e-workspace",
        queueProjectId: "e2e-project",
        credentialReferenceId: "credential_linearqueuee2e",
        authoritySubjectId: "linear-queue-project:e2e-project",
      });
      expect(configured.configuration?.authority).toEqual({
        version: 1,
        grantId: configured.activeGrant?.id,
        fingerprint: configured.activeGrant?.authorityFingerprint,
        authorizedAt: configured.activeGrant?.issuedAt,
        expiresAt: configured.activeGrant?.expiresAt,
      });
      expect(
        Date.parse(configured.configuration!.authority.expiresAt) -
          Date.parse(configured.configuration!.authority.authorizedAt),
      ).toBe(4 * 60 * 60_000);
      expect(
        configured.configureBodies.every(
          (body) =>
            body.configurationFingerprint ===
            configured.configuration?.configurationFingerprint,
        ),
      ).toBe(true);

      const completedReadback = await harness.runDueScan("complete");
      await expect
        .poll(
          async () => {
            const snapshot = await harness.readSnapshot();
            return {
              acknowledged:
                snapshot.acknowledgedThrough.filter(
                  (sequence) => sequence === completedReadback.eventSequence,
                ).length,
              applied:
                snapshot.runtime.linearQueueLastAppliedEventSequence >=
                completedReadback.eventSequence,
              foregroundLists: snapshot.foregroundListCount,
              foregroundRestarts: snapshot.foregroundRestartCount,
              surfaced: snapshot.statusLines.some((line) =>
                line.includes(
                  `companion_linear_queue_readback=complete; blocker=none; job=${completedReadback.jobId}`,
                ),
              ),
            };
          },
          {
            timeout: 60_000,
            message:
              "verified companion readback should enter the production foreground supervisor",
          },
        )
        .toEqual({
          acknowledged: 1,
          applied: true,
          foregroundLists: 1,
          foregroundRestarts: 1,
          surfaced: true,
        });

      const completed = await harness.readSnapshot();
      expect(completed.scanCount).toBe(1);
      expect(completed.companionProviderReadCount).toBe(1);
      expect(completed.jobGetCounts[completedReadback.jobId]).toBe(2);
      expect(completed.mutationCalls).toEqual([]);
      expect(completed.rescanBodies).toEqual([]);

      const blockedReadback = await harness.runDueScan("blocked");
      await expect
        .poll(
          async () => {
            const snapshot = await harness.readSnapshot();
            return {
              acknowledged:
                snapshot.acknowledgedThrough.filter(
                  (sequence) => sequence === blockedReadback.eventSequence,
                ).length,
              applied:
                snapshot.runtime.linearQueueLastAppliedEventSequence >=
                blockedReadback.eventSequence,
              rescanRequests: snapshot.rescanBodies.length,
              surfaced: snapshot.statusLines.some((line) =>
                line.includes(
                  `companion_linear_queue_readback=blocked; blocker=linear_queue_candidate_changed; job=${blockedReadback.jobId}`,
                ),
              ),
            };
          },
          {
            timeout: 60_000,
            message:
              "terminal readback should be surfaced, consumed, and request one fresh scan",
          },
        )
        .toEqual({
          acknowledged: 1,
          applied: true,
          rescanRequests: 1,
          surfaced: true,
        });

      await harness.requestReconciliation();
      await harness.requestReconciliation();
      const replayed = await harness.readSnapshot();
      expect(replayed.scanCount).toBe(2);
      expect(replayed.companionProviderReadCount).toBe(2);
      expect(replayed.foregroundRestartCount).toBe(1);
      expect(replayed.jobGetCounts[blockedReadback.jobId]).toBe(2);
      expect(
        replayed.acknowledgedThrough.filter(
          (sequence) => sequence === blockedReadback.eventSequence,
        ),
      ).toEqual([blockedReadback.eventSequence]);
      expect(replayed.rescanBodies).toEqual([
        {
          configurationFingerprint:
            replayed.configuration?.configurationFingerprint,
          requestedAt: expect.any(String),
          reason: "terminal_readback",
        },
      ]);
      expect(JSON.stringify(replayed.rescanBodies)).not.toContain(
        blockedReadback.issueId,
      );
      expect(replayed.mutationCalls).toEqual([]);
      expect(
        replayed.linearCalls.filter((call) =>
          /\.(?:create|update|delete|archive)$/u.test(call.operationKey),
        ),
      ).toEqual([]);

      await harness.page.getByRole("tab", { name: "Run Details" }).click();
      await expect(
        harness.page.locator(".agentic-researcher-config-line", {
          hasText:
            "companion_linear_queue_readback=blocked; blocker=linear_queue_candidate_changed",
        }),
      ).toBeVisible({ timeout: 30_000 });
    } finally {
      await harness.close();
    }
  });
});
