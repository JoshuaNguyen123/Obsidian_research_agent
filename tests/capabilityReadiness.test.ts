import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCapabilityReadinessV2,
  type CapabilityReadinessInputsV2,
} from "../src/agent/capabilityReadiness";

const NOW = new Date("2026-07-16T12:00:00.000Z");

function inputs(): CapabilityReadinessInputsV2 {
  return {
    observedAt: "2026-07-16T11:00:00.000Z",
    model: {
      status: "ready",
      message: "Provider connection verified.",
      checkedAt: "2026-07-16T11:59:00.000Z",
    },
    notes: { outputProfile: "active_or_new_note", streamingReady: true },
    browser: { enabled: false, companionHealthy: false, checkedAt: null },
    code: {
      registered: true,
      repositoryProfileCount: 1,
      editingAvailable: true,
      executionAvailable: true,
      probeObservedAt: "2026-07-16T11:55:00.000Z",
      probeBlocker: null,
    },
    linear: {
      credentialPresent: true,
      snapshotObservedAt: "2026-07-16T11:55:00.000Z",
      snapshotFreshUntil: "2026-07-16T13:00:00.000Z",
      queueEnabled: false,
      queueApprovalActive: false,
      queueApprovalExpiresAt: null,
    },
    github: {
      enabled: true,
      connected: true,
      waitingForUser: false,
      accountLogin: "verified-user",
      credentialObservedAt: "2026-07-16T11:00:00.000Z",
      repositoryProfileCount: 0,
      trustedPrivateRepositoryCount: 0,
      repositoryReadbackObservedAt: null,
    },
    background: {
      registered: true,
      configured: false,
      healthy: false,
      checkedAt: null,
      blocker: null,
    },
  };
}

describe("CapabilityReadinessV2", () => {
  it("uses runtime proof rather than module registration", () => {
    const rows = buildCapabilityReadinessV2(inputs(), NOW);
    assert.equal(rows.find((row) => row.id === "model")?.status, "Ready");
    assert.equal(rows.find((row) => row.id === "code")?.status, "Ready");
    assert.equal(rows.find((row) => row.id === "github")?.status, "Available");
    assert.equal(rows.find((row) => row.id === "background")?.status, "Setup needed");
    assert.ok(rows.every((row) => row.version === 2));
    assert.ok(rows.every((row) => row.nextAction.length > 0));
  });

  it("degrades a stale sandbox probe and stale provider discovery", () => {
    const stale = inputs();
    stale.code.probeObservedAt = "2026-07-16T10:00:00.000Z";
    stale.linear.snapshotFreshUntil = "2026-07-16T11:59:59.000Z";
    const rows = buildCapabilityReadinessV2(stale, NOW);
    assert.equal(rows.find((row) => row.id === "code")?.status, "Degraded");
    assert.equal(rows.find((row) => row.id === "linear")?.status, "Degraded");
  });

  it("requires fresh private-repository readback instead of treating a profile as publication readiness", () => {
    const state = inputs();
    state.github.repositoryProfileCount = 1;
    assert.equal(
      buildCapabilityReadinessV2(state, NOW).find((row) => row.id === "github")?.status,
      "Degraded",
    );
    state.github.trustedPrivateRepositoryCount = 1;
    state.github.repositoryReadbackObservedAt = "2026-07-16T11:58:00.000Z";
    assert.equal(
      buildCapabilityReadinessV2(state, NOW).find((row) => row.id === "github")?.status,
      "Ready",
    );
    state.github.repositoryReadbackObservedAt = "2026-07-16T11:50:00.000Z";
    assert.equal(
      buildCapabilityReadinessV2(state, NOW).find((row) => row.id === "github")?.status,
      "Degraded",
    );
  });

  it("marks supervised actions and queued mutation as approval-needed", () => {
    const gated = inputs();
    gated.browser.enabled = true;
    gated.browser.companionHealthy = true;
    gated.linear.queueEnabled = true;
    const rows = buildCapabilityReadinessV2(gated, NOW);
    assert.equal(rows.find((row) => row.id === "browser")?.status, "Approval needed");
    assert.equal(rows.find((row) => row.id === "linear")?.status, "Approval needed");
  });
});
