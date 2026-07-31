import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildCapabilityReadinessV2,
  evaluatePinnedGitIdentityReadinessV1,
  githubCleanupAuthorityFromScopesV1,
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
      runtimeUnresolvedProfileCount: 0,
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

  it("treats repository-free scratch validation as ready and never offers a dead repository-binding action", () => {
    const state = inputs();
    state.code.repositoryProfileCount = 0;
    const code = buildCapabilityReadinessV2(state, NOW).find(
      (row) => row.id === "code",
    );
    assert.equal(code?.status, "Ready");
    assert.match(code?.reason ?? "", /without a repository binding/iu);
    assert.match(code?.reason ?? "", /known-folder export/iu);
    assert.equal(code?.nextAction, "Review Code setup");
    assert.doesNotMatch(code?.nextAction ?? "", /bind a repository/iu);
  });

  it("keeps scratch editing and export available when sandbox execution needs a probe", () => {
    const state = inputs();
    state.code.repositoryProfileCount = 0;
    state.code.executionAvailable = false;
    state.code.probeObservedAt = null;
    const code = buildCapabilityReadinessV2(state, NOW).find(
      (row) => row.id === "code",
    );
    assert.equal(code?.status, "Available");
    assert.match(code?.reason ?? "", /editing and known-folder export are available/iu);
    assert.equal(code?.nextAction, "Run sandbox boundary probe");
  });

  it("surfaces the structured sandbox blocker on the scratch/desktop branch", () => {
    // The common desktop flow has no repository binding, and that branch used
    // to drop the blocker entirely: a user without WSL2 saw a generic
    // "requires a fresh attested runtime probe" plus the useless advice to
    // probe again. The blocker names the cause and the concrete fix.
    const state = inputs();
    state.code.repositoryProfileCount = 0;
    state.code.executionAvailable = false;
    state.code.probeObservedAt = null;
    state.code.probeBlocker = {
      code: "sandbox_provider_unavailable",
      message:
        "No sandbox provider has passed its boundary probe. wsl2 rejected: distribution not installed.",
      requiredAction:
        "Install or repair Docker, Podman, the dedicated WSL2 sandbox, or bubblewrap, then run the explicit boundary probe.",
    };
    const code = buildCapabilityReadinessV2(state, NOW).find(
      (row) => row.id === "code",
    );
    assert.match(code?.reason ?? "", /wsl2 rejected: distribution not installed/iu);
    // Editing staying available must still be stated — the blocker explains
    // execution, not the whole capability.
    assert.match(code?.reason ?? "", /editing and known-folder export are available/iu);
    assert.match(code?.nextAction ?? "", /install or repair docker/iu);
    assert.doesNotMatch(code?.nextAction ?? "", /^Run sandbox boundary probe$/u);
  });

  it("uses the structured blocker on the repository branch and accepts a plain string", () => {
    const structured = inputs();
    structured.code.executionAvailable = false;
    structured.code.probeObservedAt = null;
    structured.code.probeBlocker = {
      message: "docker unavailable: daemon not running.",
      requiredAction: "Start Docker Desktop, then run the boundary probe.",
    };
    const structuredRow = buildCapabilityReadinessV2(structured, NOW).find(
      (row) => row.id === "code",
    );
    assert.match(structuredRow?.reason ?? "", /daemon not running/iu);
    assert.equal(
      structuredRow?.nextAction,
      "Start Docker Desktop, then run the boundary probe.",
    );

    // A flattened string (e.g. a sanitized runtime error) still surfaces as
    // the reason, with the generic probe advice as the only available action.
    const flat = inputs();
    flat.code.executionAvailable = false;
    flat.code.probeObservedAt = null;
    flat.code.probeBlocker = "Code runtime threw during status read.";
    const flatRow = buildCapabilityReadinessV2(flat, NOW).find(
      (row) => row.id === "code",
    );
    assert.match(flatRow?.reason ?? "", /threw during status read/iu);
    assert.equal(flatRow?.nextAction, "Run sandbox boundary probe");
  });

  it("gives every capability one stable setup target and plain-language next action", () => {
    const rows = buildCapabilityReadinessV2(inputs(), NOW);
    assert.deepEqual(
      rows.map((row) => [row.id, row.setupTarget]),
      [
        ["model", "model"],
        ["notes", "notes_research"],
        ["code", "code"],
        ["linear", "linear"],
        ["github", "github"],
        ["browser", "browser_web"],
        ["background", "background"],
      ],
    );
    for (const row of rows) {
      assert.match(row.nextAction, /^[A-Z][^\r\n]{2,79}$/u);
      assert.equal(row.nextAction.endsWith("."), false);
    }
  });

  it("degrades a stale sandbox probe and stale provider discovery", () => {
    const stale = inputs();
    stale.code.probeObservedAt = "2026-07-16T10:00:00.000Z";
    stale.linear.snapshotFreshUntil = "2026-07-16T11:59:59.000Z";
    const rows = buildCapabilityReadinessV2(stale, NOW);
    assert.equal(rows.find((row) => row.id === "code")?.status, "Degraded");
    assert.equal(rows.find((row) => row.id === "linear")?.status, "Degraded");
  });

  it("does not report Ready while a trusted profile lacks an immutable runtime binding", () => {
    const unresolved = inputs();
    unresolved.code.runtimeUnresolvedProfileCount = 1;
    const code = buildCapabilityReadinessV2(unresolved, NOW).find(
      (row) => row.id === "code",
    );
    assert.equal(code?.status, "Degraded");
    assert.match(code?.reason ?? "", /require a fresh immutable runtime binding/u);
    assert.equal(code?.nextAction, "Refresh repository runtime binding");
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

  it("keeps public web reads available when supervised browser automation is unhealthy", () => {
    const partial = inputs();
    partial.browser.enabled = true;
    partial.browser.companionHealthy = false;
    const browser = buildCapabilityReadinessV2(partial, NOW).find(
      (row) => row.id === "browser",
    );
    assert.equal(browser?.name, "Web research");
    assert.equal(browser?.status, "Available");
    assert.match(browser?.reason ?? "", /Public web search and fetch are available/u);
    assert.match(browser?.reason ?? "", /Companion passes a healthy runtime probe/u);
    assert.equal(browser?.nextAction, "Use web research");
  });

  it("exposes pinned git identity and cleanup-scope helpers for mission preflight", () => {
    assert.equal(evaluatePinnedGitIdentityReadinessV1(), true);
    assert.equal(githubCleanupAuthorityFromScopesV1(["repo"]), true);
    assert.equal(githubCleanupAuthorityFromScopesV1(["public_repo"]), false);
  });
});
