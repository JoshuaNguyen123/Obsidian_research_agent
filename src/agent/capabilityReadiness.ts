import type { CapabilitySetupTarget } from "./capabilitySetup";

export type CapabilityReadinessStatusV2 =
  | "Available"
  | "Setup needed"
  | "Ready"
  | "Approval needed"
  | "Degraded"
  | "Blocked";

export interface CapabilityReadinessV2 {
  version: 2;
  id: "model" | "notes" | "browser" | "code" | "linear" | "github" | "background";
  name: string;
  status: CapabilityReadinessStatusV2;
  reason: string;
  evidenceAt: string | null;
  nextAction: string;
  setupTarget: CapabilitySetupTarget;
}

export interface CapabilityReadinessInputsV2 {
  observedAt: string;
  model: {
    status: "untested" | "testing" | "ready" | "error";
    message: string;
    checkedAt: string | null;
  };
  notes: { outputProfile: string; streamingReady: boolean };
  browser: {
    enabled: boolean;
    companionHealthy: boolean;
    checkedAt: string | null;
  };
  code: {
    registered: boolean;
    repositoryProfileCount: number;
    runtimeUnresolvedProfileCount: number;
    editingAvailable: boolean;
    executionAvailable: boolean;
    probeObservedAt: string | null;
    probeBlocker: string | null;
  };
  linear: {
    credentialPresent: boolean;
    snapshotObservedAt: string | null;
    snapshotFreshUntil: string | null;
    queueEnabled: boolean;
    queueApprovalActive: boolean;
    queueApprovalExpiresAt: string | null;
  };
  github: {
    enabled: boolean;
    connected: boolean;
    waitingForUser: boolean;
    accountLogin: string | null;
    credentialObservedAt: string | null;
    repositoryProfileCount: number;
    trustedPrivateRepositoryCount: number;
    repositoryReadbackObservedAt: string | null;
  };
  background: {
    registered: boolean;
    configured: boolean;
    healthy: boolean;
    checkedAt: string | null;
    blocker: string | null;
  };
}

export function buildCapabilityReadinessV2(
  input: CapabilityReadinessInputsV2,
  now = new Date(),
): CapabilityReadinessV2[] {
  const model = readiness({
    id: "model",
    name: "Model connection",
    status:
      input.model.status === "ready"
        ? "Ready"
        : input.model.status === "error"
          ? "Blocked"
          : "Setup needed",
    reason: input.model.message,
    evidenceAt: input.model.checkedAt,
    nextAction:
      input.model.status === "ready" ? "Review model setup" : "Test model connection",
    setupTarget: "model",
  });

  const notes = readiness({
    id: "notes",
    name: "Notes & research",
    status: input.notes.streamingReady ? "Ready" : "Degraded",
    reason: input.notes.streamingReady
      ? `Output profile ${input.notes.outputProfile} is available with guarded note streaming.`
      : `Output profile ${input.notes.outputProfile} is available, but guarded streaming is disabled.`,
    evidenceAt: input.observedAt,
    nextAction: input.notes.streamingReady ? "Review note setup" : "Enable guarded streaming",
    setupTarget: "notes_research",
  });

  const browser = readiness({
    id: "browser",
    name: "Web research",
    status: !input.browser.enabled
      ? "Available"
      : !input.browser.companionHealthy
        ? "Available"
        : "Approval needed",
    reason: !input.browser.enabled
      ? "Public web search and fetch are available; optional supervised browser automation is off."
      : !input.browser.companionHealthy
        ? "Public web search and fetch are available. Optional supervised browser automation is unavailable until the authenticated Companion passes a healthy runtime probe."
        : "Public web search and fetch are available. Supervised browser reads are also available; click, type, and submit remain SafetyPolicy and approval gated.",
    evidenceAt: input.browser.checkedAt ?? input.observedAt,
    nextAction: !input.browser.enabled
      ? "Enable browser tools if needed"
      : !input.browser.companionHealthy
        ? "Use web research"
        : "Review browser approvals",
    setupTarget: "browser_web",
  });

  const probeFresh = Boolean(
    input.code.probeObservedAt &&
      Number.isFinite(Date.parse(input.code.probeObservedAt)) &&
      now.getTime() - Date.parse(input.code.probeObservedAt) <= 15 * 60_000,
  );
  const codeStatus: CapabilityReadinessStatusV2 = !input.code.registered
    ? "Blocked"
    : input.code.repositoryProfileCount === 0
      ? "Available"
      : input.code.runtimeUnresolvedProfileCount > 0
        ? "Degraded"
      : input.code.executionAvailable && probeFresh
        ? "Ready"
        : input.code.probeObservedAt
          ? "Degraded"
          : "Setup needed";
  const code = readiness({
    id: "code",
    name: "Code",
    status: codeStatus,
    reason: !input.code.registered
      ? "The Code runtime is not registered."
      : input.code.repositoryProfileCount === 0
        ? "Durable editing is available; bind a trusted repository before repository work."
        : input.code.runtimeUnresolvedProfileCount > 0
          ? `${input.code.runtimeUnresolvedProfileCount} trusted repository profile(s) still require a fresh immutable runtime binding.`
        : input.code.executionAvailable && probeFresh
          ? `Trusted repository binding and a fresh attested sandbox probe are ready (${input.code.repositoryProfileCount} profile(s)).`
          : input.code.probeBlocker ??
            "Repository editing remains available, but execution requires a fresh attested sandbox probe.",
    evidenceAt: input.code.probeObservedAt ?? input.observedAt,
    nextAction: !input.code.registered
      ? "Reload Code capability"
      : input.code.repositoryProfileCount === 0
        ? "Bind a repository"
        : input.code.runtimeUnresolvedProfileCount > 0
          ? "Refresh repository runtime binding"
        : codeStatus === "Ready"
          ? "Review execution setup"
          : "Run sandbox boundary probe",
    setupTarget: "code",
  });

  const linearSnapshotFresh = Boolean(
    input.linear.snapshotFreshUntil &&
      Date.parse(input.linear.snapshotFreshUntil) >= now.getTime(),
  );
  const linearStatus: CapabilityReadinessStatusV2 = !input.linear.credentialPresent
    ? "Setup needed"
    : !input.linear.snapshotObservedAt || !linearSnapshotFresh
      ? "Degraded"
      : input.linear.queueEnabled && !input.linear.queueApprovalActive
        ? "Approval needed"
        : "Ready";
  const linear = readiness({
    id: "linear",
    name: "Linear",
    status: linearStatus,
    reason: !input.linear.credentialPresent
      ? "No verified Linear credential is available."
      : !input.linear.snapshotObservedAt || !linearSnapshotFresh
        ? "A credential exists, but fresh independent workspace discovery is required."
        : input.linear.queueEnabled && !input.linear.queueApprovalActive
          ? "The hierarchy destination is verified; bounded queue mutation authority still needs approval."
          : input.linear.queueApprovalActive
            ? `Workspace discovery and bounded queue authority are ready until ${input.linear.queueApprovalExpiresAt}.`
            : "Fresh independent workspace discovery is ready; mutation approval is requested only when needed.",
    evidenceAt: input.linear.snapshotObservedAt,
    nextAction: !input.linear.credentialPresent
      ? "Connect Linear"
      : !input.linear.snapshotObservedAt || !linearSnapshotFresh
        ? "Test Linear connection"
        : input.linear.queueEnabled && !input.linear.queueApprovalActive
          ? "Review Linear approval"
          : "Review Linear setup",
    setupTarget: "linear",
  });

  const githubRepositoryProbeFresh = Boolean(
    input.github.repositoryReadbackObservedAt &&
      Number.isFinite(Date.parse(input.github.repositoryReadbackObservedAt)) &&
      now.getTime() - Date.parse(input.github.repositoryReadbackObservedAt) <=
        5 * 60_000,
  );
  const githubStatus: CapabilityReadinessStatusV2 = input.github.waitingForUser
    ? "Approval needed"
    : !input.github.connected
      ? "Setup needed"
      : !input.github.enabled
        ? "Blocked"
        : input.github.repositoryProfileCount === 0
          ? "Available"
          : input.github.trustedPrivateRepositoryCount === 0 ||
              !githubRepositoryProbeFresh
            ? "Degraded"
            : "Ready";
  const github = readiness({
    id: "github",
    name: "GitHub",
    status: githubStatus,
    reason: input.github.waitingForUser
      ? "GitHub device authorization is waiting for the user."
      : !input.github.connected
        ? "No verified GitHub credential is available."
        : !input.github.enabled
          ? "A credential exists, but GitHub tools are disabled."
          : input.github.repositoryProfileCount === 0
            ? `Connected as ${input.github.accountLogin ?? "verified account"}; bind and independently read back a repository before publication.`
            : input.github.trustedPrivateRepositoryCount === 0
              ? "A repository profile exists, but no independently verified private-repository binding is available."
              : !githubRepositoryProbeFresh
                ? "The private-repository binding exists, but its visibility readback is stale."
                : `Connected as ${input.github.accountLogin ?? "verified account"} with ${input.github.trustedPrivateRepositoryCount} freshly verified private repository binding(s).`,
    evidenceAt:
      input.github.repositoryReadbackObservedAt ??
      input.github.credentialObservedAt,
    nextAction: input.github.waitingForUser
      ? "Finish GitHub authorization"
      : !input.github.connected
        ? "Connect GitHub"
        : input.github.repositoryProfileCount === 0
          ? "Bind a private repository"
          : input.github.trustedPrivateRepositoryCount === 0 ||
              !githubRepositoryProbeFresh
            ? "Verify private repository"
            : "Review GitHub setup",
    setupTarget: "github",
  });

  const background = readiness({
    id: "background",
    name: "Background work",
    status: !input.background.registered
      ? "Blocked"
      : !input.background.configured
        ? "Setup needed"
        : input.background.healthy
          ? "Ready"
          : "Degraded",
    reason: !input.background.registered
      ? "The Companion runtime is not registered."
      : !input.background.configured
        ? "The authenticated Companion session is not configured."
        : input.background.healthy
          ? "Authenticated coordinator, worker, background execution, and persistent secure storage passed the runtime probe."
          : input.background.blocker ?? "The latest Companion runtime probe is degraded.",
    evidenceAt: input.background.checkedAt,
    nextAction: input.background.healthy
      ? "Review background setup"
      : "Connect and test Companion",
    setupTarget: "background",
  });

  return [model, notes, code, linear, github, browser, background];
}

function readiness(
  value: Omit<CapabilityReadinessV2, "version">,
): CapabilityReadinessV2 {
  return { version: 2, ...value };
}
