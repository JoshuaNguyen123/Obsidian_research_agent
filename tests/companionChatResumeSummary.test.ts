import assert from "node:assert/strict";
import test from "node:test";

import {
  buildCompanionChatResumeSummaryV1,
  isTerminalCompanionJobState,
} from "../packages/headless-runtime/src/companionChatResumeSummaryV1";
import {
  CompanionExtensionCoordinatorV1,
  type CompanionRuntimeStateV1,
} from "../extensions/companion/CompanionExtensionCoordinator";
import { createSessionBootstrapTokenLeaseV1 } from "../packages/headless-runtime/src";

const NOW = "2026-07-22T18:00:00.000Z";
const JOB_ID = "chat-resume-job";

test("chat resume summary stays null for non-terminal and waiting_obsidian states", () => {
  assert.equal(isTerminalCompanionJobState("running"), false);
  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "vault",
      domain: "research",
      state: "waiting_obsidian",
      outputs: { summary: "should not surface" },
    }),
    null,
  );
  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "research",
      domain: "research",
      state: "running",
    }),
    null,
  );
});

test("chat resume summary is concise for research, linear, code, and github completions", () => {
  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "research",
      domain: "research",
      state: "complete",
      outputs: {
        summary:
          "Source: https://example.com/a\nPublic text.\n\nSource: https://example.com/b\nMore text.",
        sourceCount: 2,
      },
    }),
    "Background research finished (2 sources).",
  );

  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "linear",
      domain: "linear",
      state: "complete",
      outputs: {
        issueId: "issue-42",
        state: "state-done",
        summary: "Linear issue state update verified by independent readback.",
      },
    }),
    "Background Linear update verified for issue-42 → state-done.",
  );

  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "code",
      domain: "code",
      state: "complete",
      outputs: {
        commitSha: "abcdef0123456789abcdef0123456789abcdef01",
      },
    }),
    "Background code validation/commit finished (abcdef0).",
  );

  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "github",
      domain: "github",
      state: "complete",
      outputs: {
        prNumber: 17,
        prUrl: "https://github.com/acme/demo/pull/17",
      },
    }),
    "Background GitHub work finished: PR #17 — https://github.com/acme/demo/pull/17.",
  );
});

test("chat resume summary reports blockers without vault reconstruction", () => {
  assert.equal(
    buildCompanionChatResumeSummaryV1({
      jobId: JOB_ID,
      missionId: "mission",
      nodeId: "github",
      domain: "github",
      state: "blocked",
      blocker: {
        code: "checks_pending",
        message: "Required CI checks are still pending.",
        requiredAction: "Wait for checks, then resume.",
      },
    }),
    "Background GitHub blocked: Required CI checks are still pending.",
  );
});

test("coordinator drains a terminal chat resume summary once after reconcile", async () => {
  const remote = remoteCompleteLinearJob();
  const coordinator = new CompanionExtensionCoordinatorV1();
  let durable: CompanionRuntimeStateV1 | null = lineageState("queued");
  coordinator.configurePersistence({
    load: async () => durable,
    save: async (state) => {
      durable = structuredClone(state);
    },
  });
  await coordinator.hydratePersistence();
  coordinator.configureSession({
    baseUrl: "http://127.0.0.1:18791",
    credential: createSessionBootstrapTokenLeaseV1(
      "chat-resume-token-0123456789abcdef",
    ),
    fetchImpl: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === `/jobs/${JOB_ID}` && (init?.method ?? "GET") === "GET") {
        return json(remote);
      }
      if (url.pathname.endsWith("/events")) {
        return new Response("", {
          headers: { "Content-Type": "text/event-stream" },
        });
      }
      if (url.pathname.endsWith("/receipts")) {
        // Empty receipts keep this test focused on Chat resume summary drain,
        // not companion receipt fingerprint math.
        return json({ receipts: [] });
      }
      return new Response("not found", { status: 404 });
    },
  });

  const reconciled = await coordinator.reconcilePersistedJobs();
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0]?.lineage.state, "complete");
  assert.equal(
    reconciled[0]?.lineage.chatResumeSummary,
    "Background Linear update verified for issue-42 → state-done.",
  );
  assert.equal(reconciled[0]?.lineage.chatResumeDeliveredAt, null);

  const first = await coordinator.drainPendingChatResumeSummaries(
    new Date(NOW),
  );
  assert.deepEqual(first, [
    {
      jobId: JOB_ID,
      missionId: "persisted-mission",
      nodeId: "linear-node",
      state: "complete",
      line: "Background Linear update verified for issue-42 → state-done.",
    },
  ]);
  assert.equal(
    coordinator.getRuntimeState().jobs[JOB_ID]?.chatResumeDeliveredAt,
    NOW,
  );

  const second = await coordinator.drainPendingChatResumeSummaries(
    new Date("2026-07-22T19:00:00.000Z"),
  );
  assert.deepEqual(second, []);
  coordinator.clearSession();
});

function lineageState(state: string): CompanionRuntimeStateV1 {
  return {
    version: 1,
    serviceInstalled: true,
    baseUrl: "http://127.0.0.1:18791",
    linearQueueLastObservedEventSequence: 0,
    linearQueueLastAppliedEventSequence: 0,
    jobs: {
      [JOB_ID]: {
        version: 1,
        jobId: JOB_ID,
        missionId: "persisted-mission",
        nodeId: "linear-node",
        graphRevision: 3,
        idempotencyKey: fp("a"),
        capabilityEnvelopeFingerprint: fp("b"),
        authorizationFingerprint: fp("c"),
        hostRuntimeRunId: "run-chat-resume-1",
        state,
        lastObservedEventSequence: 0,
        lastAppliedEventSequence: 0,
        receiptFingerprints: [],
        resultFingerprint: null,
        reconcileStatus: "pending",
        reconcileError: null,
        chatResumeSummary: null,
        chatResumeDeliveredAt: null,
        updatedAt: NOW,
      },
    },
  };
}

function remoteCompleteLinearJob() {
  return {
    id: JOB_ID,
    missionId: "persisted-mission",
    nodeId: "linear-node",
    executionHost: "linear",
    state: "complete",
    payload: {
      graphRevision: 3,
      executionHost: "headless_runtime",
      objective: "Update Linear issue issue-42",
      inputs: { issueId: "issue-42" },
      allowedTools: ["linear_get_issue"],
      requiredCapabilities: [],
      bindings: [],
      authorization: {
        version: 1,
        grantId: "grant-1",
        fingerprint: fp("c"),
        authorizedAt: NOW,
        expiresAt: null,
      },
    },
    capabilityEnvelope: {
      fingerprint: fp("b"),
      authorizationFingerprint: fp("c"),
    },
    idempotencyKey: fp("a"),
    ownerCoordinatorId: null,
    leaseExpiresAt: null,
    attempts: 1,
    output: {
      status: "complete",
      outputs: {
        issueId: "issue-42",
        state: "state-done",
        workItemFingerprint: fp("d"),
        summary: "Linear issue state update verified by independent readback.",
      },
      evidence: [],
      receiptIds: ["receipt-1"],
      blocker: null,
      resultFingerprint: fp("e"),
    },
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function fp(seed: string): string {
  return `sha256:${seed.padEnd(64, "0")}`;
}
