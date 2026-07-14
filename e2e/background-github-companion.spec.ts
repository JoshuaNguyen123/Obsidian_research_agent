import { expect, test } from "@playwright/test";

import {
  startBackgroundGitHubCompanionHarness,
  type BackgroundGitHubCompanionHarness,
} from "./fixtures/backgroundGitHubCompanionHarness";

test.describe("background GitHub companion continuation", () => {
  test.skip(process.platform !== "win32", "Native Obsidian E2E runs on Windows.");
  test.describe.configure({ timeout: 600_000 });

  let harness: BackgroundGitHubCompanionHarness | null = null;

  test.afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  test("signed package survives restart and gates completion on full provider proof", async () => {
    harness = await startBackgroundGitHubCompanionHarness();
    const active = harness;

    await active.submitMission();
    await active.page.getByRole("tab", { name: "Run Details" }).click();

    const approval = active.activeApproval();
    await expect(approval).toBeVisible({ timeout: 120_000 });
    await expect(approval).toContainText("github_create_draft_pull_request");
    await expect(approval).toContainText("exact_payload_approval");
    await expect(approval).toContainText("confirmation=1/1");
    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          effect: snapshot.graphNodeEffect,
          executionHost: snapshot.graphNodeExecutionHost,
          graphStatus: snapshot.graphNodeStatus,
          allowedTools: snapshot.graphNodeAllowedTools,
        };
      }, {
        timeout: 30_000,
        message:
          "the authoritative GitHub node should be headless and approval-gated",
      })
      .toEqual({
        effect: "external_action",
        executionHost: "headless_runtime",
        graphStatus: "waiting_approval",
        allowedTools: ["github_create_draft_pull_request"],
      });
    await active.approve(approval);

    await active.waitForRemoteSubmission();
    const submitted = await active.readSnapshot();
    expect(submitted.modelToolCallCount).toBe(1);
    expect(submitted.backgroundToolArguments).toHaveLength(1);
    expect(Object.keys(submitted.backgroundToolArguments[0] ?? {}).sort()).toEqual([
      "body",
      "profileKey",
      "publicationId",
      "title",
    ]);
    expect(submitted.backgroundToolArguments[0]).toEqual({
      profileKey: active.fixture.profile.key,
      publicationId: active.fixture.publicationId,
      title: active.fixture.title,
      body: active.fixture.body,
    });
    expect(submitted.signerReceiptCount).toBe(1);
    expect(submitted.actionSignerReceiptCount).toBe(1);
    expect(submitted.walPresentBeforePost).toBe(true);
    expect(submitted.packageIdentityPresentBeforePost).toBe(true);
    expect(submitted.packageReadbackVerifiedBeforePost).toBe(true);
    expect(submitted.signerReceiptPresentBeforePost).toBe(true);
    expect(submitted.postCount).toBe(1);
    expect(submitted.sealCount).toBe(1);
    expect(submitted.foregroundExecuteCount).toBe(0);
    expect(submitted.foregroundExecutePreparedCount).toBe(0);
    expect(submitted.providerFallbackCount).toBe(0);

    await active.disconnectAndRestartCoreIntegrations();
    await active.waitForRemoteCompletion();
    const disconnected = await active.readSnapshot();
    expect(disconnected.remoteState).toBe("complete");
    expect(disconnected.runtimeJournalState).not.toBe("committed");
    expect(disconnected.integrationsCheckpointStatus).toBe("pushed_verified");

    // A result fingerprint without the full output proof may advance the core
    // WAL from the independently verified receipt, but cannot touch either
    // checkpoint owner or complete the MissionGraph node.
    await active.useFingerprintOnlyOutput();
    await active.reconnectCompanion();
    await active.requestReconciliation();
    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          journal: snapshot.runtimeJournalState,
          attempt: snapshot.backgroundAttemptStatus,
          graph: snapshot.graphNodeStatus,
          integrations: snapshot.integrationsCheckpointStatus,
          core: snapshot.coreCheckpointStatus,
          integrationsApplyCount: snapshot.integrationsApplyCount,
          coreCheckpointUpsertCount: snapshot.coreCheckpointUpsertCount,
          outputHasFullProof: snapshot.remoteOutputHasFullProof,
          receiptHasFullProof: snapshot.receiptHasFullProof,
        };
      }, {
        timeout: 120_000,
        message:
          "fingerprint-only completion must stop after exact core WAL receipt readback",
      })
      .toEqual({
        journal: "readback_verified",
        attempt: "readback_verified",
        graph: expect.not.stringMatching(/^complete$/u),
        integrations: "pushed_verified",
        core: null,
        integrationsApplyCount: 0,
        coreCheckpointUpsertCount: 0,
        outputHasFullProof: false,
        receiptHasFullProof: true,
      });

    await active.restoreFullOutput();
    await active.requestReconciliation();
    await expect
      .poll(async () => {
        const snapshot = await active.readSnapshot();
        return {
          journal: snapshot.runtimeJournalState,
          attempt: snapshot.backgroundAttemptStatus,
          graph: snapshot.graphNodeStatus,
          integrations: snapshot.integrationsCheckpointStatus,
          core: snapshot.coreCheckpointStatus,
          integrationsApplyCount: snapshot.integrationsApplyCount,
          coreCheckpointUpsertCount: snapshot.coreCheckpointUpsertCount,
        };
      }, {
        timeout: 120_000,
        message:
          "full output and receipt proof should persist Integrations then core checkpoints before graph completion",
      })
      .toEqual({
        journal: "committed",
        attempt: "readback_verified",
        graph: "complete",
        integrations: "draft_pr_verified",
        core: "draft_pr_verified",
        integrationsApplyCount: 1,
        coreCheckpointUpsertCount: 1,
      });

    const completed = await active.readSnapshot();
    expect(completed.remoteOutputHasFullProof).toBe(true);
    expect(completed.receiptHasFullProof).toBe(true);
    expect(completed.outputReceiptProofMatch).toBe(true);
    expect(completed.receiptStatuses).toEqual(["ambiguous", "verified"]);
    expect(completed.integrationsCheckpointReceiptIds).toHaveLength(2);
    expect(completed.graphReceiptKinds).toContain(
      "external:github:github_draft_pull_request_v1",
    );
    expect(completed.graphEvidenceKinds).toContain("github_background_readback");
    expect(completed.graphVerifierId).toBe("companion-external-result-v1");
    expect(completed.reconciliationOrder).toEqual([
      "integrations_checkpoint",
      "core_checkpoint",
      "graph_complete",
      "journal_committed",
    ]);
    const checkpointRevision = completed.integrationsCheckpointRevision;

    await active.requestReconciliation();
    await active.requestReconciliation();
    const replayed = await active.readSnapshot();
    expect(replayed.postCount).toBe(1);
    expect(replayed.sealCount).toBe(1);
    expect(replayed.signerReceiptCount).toBe(1);
    expect(replayed.integrationsApplyCount).toBe(1);
    expect(replayed.coreCheckpointUpsertCount).toBe(1);
    expect(replayed.integrationsCheckpointRevision).toBe(checkpointRevision);
    expect(replayed.graphCompletionTransitionCount).toBe(1);
    expect(replayed.foregroundExecuteCount).toBe(0);
    expect(replayed.foregroundExecutePreparedCount).toBe(0);
    expect(replayed.providerFallbackCount).toBe(0);
  });
});
