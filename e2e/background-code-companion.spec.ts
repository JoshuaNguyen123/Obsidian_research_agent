import { expect, test } from "@playwright/test";

import {
  startBackgroundCodeCompanionHarness,
  type BackgroundCodeCompanionHarness,
} from "./fixtures/backgroundCodeCompanionHarness";

test.describe("background Code companion continuation", () => {
  test.skip(process.platform !== "win32", "Native Obsidian E2E runs on Windows.");
  test.describe.configure({ timeout: 600_000 });

  let harness: BackgroundCodeCompanionHarness | null = null;

  test.afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  test("actual no-provider state blocks before POST or local commit", async () => {
    harness = await startBackgroundCodeCompanionHarness("actual-no-provider");
    const active = harness;

    await active.submitMission();
    await active.approveForegroundFixtureActions();

    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          blockerCode: snapshot.blockerCode,
          postCount: snapshot.postCount,
          foregroundExecuteCount: snapshot.foregroundExecuteCount,
          foregroundExecutePreparedCount:
            snapshot.foregroundExecutePreparedCount,
        };
      }, {
        timeout: 120_000,
        message:
          "the production background Code host should surface its exact sandbox blocker without dispatch",
      })
      .toEqual({
        blockerCode: "background_code_sandbox_unavailable",
        postCount: 0,
        foregroundExecuteCount: 0,
        foregroundExecutePreparedCount: 0,
      });

    const blocked = await active.readSnapshot();
    expect(blocked.modelToolCallCount).toBe(1);
    expect(blocked.backgroundToolArguments).toHaveLength(1);
    expect(Object.keys(blocked.backgroundToolArguments[0] ?? {})).toEqual([
      "repairCheckpointId",
    ]);
    expect(blocked.backgroundToolArguments[0]?.repairCheckpointId).toMatch(
      /^code-repair:/u,
    );
    expect(blocked.sandboxMode).toBe("editing_only");
    expect(blocked.sandboxExecutionAvailable).toBe(false);
    expect(blocked.sealCount).toBe(0);
    expect(blocked.commitSha).toBe(blocked.baseSha);
    expect(blocked.worktreeHead).toBe(blocked.baseSha);
    expect(blocked.foregroundNativeExecutionCount).toBe(0);
  });

  test("verified package survives restart and reconciles one commit readback exactly once", async () => {
    harness = await startBackgroundCodeCompanionHarness("verified-ready");
    const active = harness;
    test.skip(
      !(await active.readyFixtureAvailable()),
      "The installed Code extension has no bounded deterministic E2E preparation seam; ready success is not simulated.",
    );

    await active.submitMission();
    await active.approveForegroundFixtureActions();

    const codeApproval = active.activeCodeApproval();
    await expect(codeApproval).toBeVisible({ timeout: 120_000 });
    await expect(codeApproval).toContainText("code_validate_commit_prepared");
    await expect(codeApproval).toContainText("exact_payload_approval");
    await expect(codeApproval).toContainText("confirmation=1/1");
    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          effect: snapshot.graphNodeEffect,
          executionHost: snapshot.graphNodeExecutionHost,
          graphStatus: snapshot.graphNodeStatus,
          graphNodeIdentityPresent: Boolean(snapshot.graphNodeId),
          allowedTools: snapshot.graphNodeAllowedTools,
          dispatchPort: snapshot.backgroundDispatchPortAvailable,
          codeSealer: snapshot.backgroundCodeSealerAvailable,
          portCreatedForRun:
            snapshot.backgroundDispatchPortCreationCount > 0,
        };
      }, {
        timeout: 30_000,
        message:
          "the explicit continuation mission must route the Code node to the headless runtime before approval",
      })
      .toEqual({
        effect: "execution",
        executionHost: "headless_runtime",
        graphStatus: "waiting_approval",
        graphNodeIdentityPresent: true,
        allowedTools: ["code_validate_commit_prepared"],
        dispatchPort: true,
        codeSealer: true,
        portCreatedForRun: true,
      });
    await active.approveCodeAction(codeApproval);

    await active.waitForRemoteSubmission();
    const submitted = await active.readSnapshot();
    expect(submitted.walPresentBeforePost).toBe(true);
    expect(submitted.packageIdentityPresentBeforePost).toBe(true);
    expect(submitted.packageReadbackVerifiedBeforePost).toBe(true);
    expect(submitted.postCount).toBe(1);
    expect(submitted.sealCount).toBe(1);
    expect(submitted.backgroundToolArguments).toHaveLength(1);
    expect(Object.keys(submitted.backgroundToolArguments[0] ?? {})).toEqual([
      "repairCheckpointId",
    ]);
    expect(submitted.foregroundExecuteCount).toBe(0);
    expect(submitted.foregroundExecutePreparedCount).toBe(0);
    expect(submitted.foregroundNativeExecutionCount).toBe(0);

    await active.disconnectAndRestartCoreCode();
    await active.waitForRemoteCompletion();
    const disconnected = await active.readSnapshot();
    expect(disconnected.remoteState).toBe("complete");
    expect(disconnected.runtimeJournalState).not.toBe("committed");

    await active.reconnectCompanion();
    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          journal: snapshot.runtimeJournalState,
          graph: snapshot.graphNodeStatus,
          attempt: snapshot.backgroundAttemptStatus,
        };
      }, {
        timeout: 120_000,
        message:
          "verified commit readback should commit the core WAL and MissionGraph once after reconnect",
      })
      .toEqual({
        journal: "committed",
        graph: "complete",
        attempt: "readback_verified",
      });

    const completed = await active.readSnapshot();
    expect(completed.receiptStatuses).toEqual([
      "dispatched",
      "ambiguous",
      "verified",
    ]);
    expect(completed.commitSha).toMatch(/^[a-f0-9]{40}$/u);
    expect(completed.commitSha).not.toBe(completed.baseSha);
    expect(completed.worktreeHead).toBe(completed.commitSha);
    expect(completed.graphReceiptKinds).toContain(
      "external:code:prepared_code_validation_commit_v1",
    );
    expect(completed.graphEvidenceKinds).toContain("verified_local_commit");
    expect(completed.graphVerifierId).toBe("companion-external-result-v1");

    await active.requestReconciliation();
    await active.requestReconciliation();
    const replayed = await active.readSnapshot();
    expect(replayed.postCount).toBe(1);
    expect(replayed.sealCount).toBe(1);
    expect(replayed.modelToolCallCount).toBe(1);
    expect(replayed.foregroundExecuteCount).toBe(0);
    expect(replayed.foregroundExecutePreparedCount).toBe(0);
    expect(replayed.foregroundNativeExecutionCount).toBe(0);
    expect(replayed.graphCompletionTransitionCount).toBe(1);
  });
});
