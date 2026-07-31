import {
  agentGitCommitIdentityEnvironmentV1,
  isAgentGitCommitIdentityV1,
} from "../../packages/core-api/src/agentGitCommitIdentityV1";
import type { CapabilitySetupTarget } from "./capabilitySetup";

export type CapabilityReadinessStatusV2 =
  | "Available"
  | "Setup needed"
  | "Ready"
  | "Approval needed"
  | "Degraded"
  | "Blocked";

/**
 * True when the host-pinned agent commit identity contract is loadable and
 * matches the attribution-integrity constants used for agent commits.
 */
export function evaluatePinnedGitIdentityReadinessV1(): boolean {
  const env = agentGitCommitIdentityEnvironmentV1();
  return isAgentGitCommitIdentityV1({
    authorName: env.GIT_AUTHOR_NAME ?? "",
    authorEmail: env.GIT_AUTHOR_EMAIL ?? "",
    committerName: env.GIT_COMMITTER_NAME ?? "",
    committerEmail: env.GIT_COMMITTER_EMAIL ?? "",
  });
}

/**
 * Classic OAuth `repo` includes delete for owned repositories; fine-grained
 * tokens need an explicit `delete_repo` grant. Returns null when scopes were
 * not observed so callers can fail closed for cleanup-required missions.
 *
 * `credentialKind` matters because GitHub only returns `X-OAuth-Scopes` for
 * classic tokens. A fine-grained PAT therefore always reports no scopes, and
 * inferring from that string alone declared every such credential incapable of
 * cleanup — including one holding Administration: write. For that kind the
 * scope list carries no signal at all, so authority is reported as unknown
 * (null) and must be settled by an actual attempt rather than by guessing
 * either way.
 */
export function githubCleanupAuthorityFromScopesV1(
  scopes: readonly string[] | null | undefined,
  credentialKind?: string | null,
): boolean | null {
  if (credentialKind === "fine_grained_pat") return null;
  if (!scopes) return null;
  const normalized = scopes
    .map((scope) => scope.trim().toLowerCase())
    .filter((scope) => scope.length > 0);
  if (normalized.length === 0) return null;
  return normalized.some(
    (scope) => scope === "delete_repo" || scope === "repo",
  );
}

/**
 * Copy for the cleanup readiness gate. A fine-grained PAT cannot advertise its
 * permissions, so the operator needs to be told that specifically rather than
 * being sent to re-grant a scope that does not exist for their token type.
 */
export function githubCleanupAuthorityReasonV1(input: {
  authorized: boolean | null;
  credentialKind?: string | null;
}): string {
  if (input.authorized === true) {
    return "GitHub credential includes repository cleanup authority.";
  }
  if (input.authorized === false) {
    return "The connected GitHub credential lacks delete_repo (or classic repo) cleanup authority.";
  }
  if (input.credentialKind === "fine_grained_pat") {
    return "A fine-grained personal access token does not report its permissions, so cleanup authority cannot be read in advance. Grant Administration: write on the target repositories; a cleanup attempt will report the exact failure if it is missing.";
  }
  return "GitHub cleanup authority has not been observed on the connected credential.";
}

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
    /**
     * The sandbox manager's durable blocker. The structured form carries the
     * per-provider diagnostics (`message`) and the concrete fix
     * (`requiredAction`) — flattening it to a bare message is what used to
     * leave the tile advising "run the probe again" when the true state was
     * "WSL2 is not installed". A plain string is still accepted for callers
     * that only have a flattened diagnostic.
     */
    probeBlocker: SandboxProbeBlockerV1 | string | null;
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

export interface SandboxProbeBlockerV1 {
  code?: string;
  message: string;
  requiredAction?: string;
}

function probeBlockerMessage(
  blocker: SandboxProbeBlockerV1 | string | null,
): string | null {
  if (!blocker) return null;
  const message = typeof blocker === "string" ? blocker : blocker.message;
  return message?.trim() ? message.trim() : null;
}

function probeBlockerAction(
  blocker: SandboxProbeBlockerV1 | string | null,
): string | null {
  if (!blocker || typeof blocker === "string") return null;
  return blocker.requiredAction?.trim() ? blocker.requiredAction.trim() : null;
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
      ? input.code.executionAvailable && probeFresh
        ? "Ready"
        : "Available"
      : input.code.runtimeUnresolvedProfileCount > 0
        ? "Degraded"
      : input.code.executionAvailable && probeFresh
        ? "Ready"
        : input.code.probeObservedAt
          ? "Degraded"
          : "Setup needed";
  // The blocker's message names WHY execution is unavailable (per-provider
  // diagnostics) and its requiredAction names the actual fix. Both branches
  // must consult it: the scratch/desktop flow (repositoryProfileCount === 0)
  // is the most common one, and it used to drop the blocker entirely — a user
  // without WSL2 saw a generic "requires a fresh attested runtime probe" and
  // the useless advice to probe again.
  const blockerMessage = probeBlockerMessage(input.code.probeBlocker);
  const blockerAction = probeBlockerAction(input.code.probeBlocker);
  const code = readiness({
    id: "code",
    name: "Code",
    status: codeStatus,
    reason: !input.code.registered
      ? "The Code runtime is not registered."
      : input.code.repositoryProfileCount === 0
        ? input.code.executionAvailable && probeFresh
          ? "Scratch workspace editing, sandbox validation, and known-folder export are ready without a repository binding. A trusted binding is required only for repository work."
          : blockerMessage
            ? `Scratch workspace editing and known-folder export are available; sandbox execution is not: ${blockerMessage}`
            : "Scratch workspace editing and known-folder export are available without a repository binding. Sandbox validation requires a fresh attested runtime probe."
        : input.code.runtimeUnresolvedProfileCount > 0
          ? `${input.code.runtimeUnresolvedProfileCount} trusted repository profile(s) still require a fresh immutable runtime binding.`
        : input.code.executionAvailable && probeFresh
          ? `Trusted repository binding and a fresh attested sandbox probe are ready (${input.code.repositoryProfileCount} profile(s)).`
          : blockerMessage ??
            "Repository editing remains available, but execution requires a fresh attested sandbox probe.",
    evidenceAt: input.code.probeObservedAt ?? input.observedAt,
    nextAction: !input.code.registered
      ? "Reload Code capability"
      : input.code.repositoryProfileCount === 0
        ? codeStatus === "Ready"
          ? "Review Code setup"
          : blockerAction ?? "Run sandbox boundary probe"
        : input.code.runtimeUnresolvedProfileCount > 0
          ? "Refresh repository runtime binding"
        : codeStatus === "Ready"
          ? "Review execution setup"
          : blockerAction ?? "Run sandbox boundary probe",
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
