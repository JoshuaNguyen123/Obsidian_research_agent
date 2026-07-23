import {
  evaluatePinnedGitIdentityReadinessV1,
  type CapabilityReadinessV2,
} from "./capabilityReadiness";
import type { CapabilitySetupTarget } from "./capabilitySetup";
import {
  compoundLifecycleStageLabel,
  evaluateCompoundLifecycleReadinessV1,
  isCodeStartableForCompound,
  isGitHubStartableForCompound,
  isLinearStartableForCompound,
} from "./compoundLifecycleReadiness";
import type { ProjectLifecycleStageV1 } from "./projectLifecycle";

export type MissionReadinessCheckIdV1 =
  | "linear"
  | "sandbox"
  | "github"
  | "git_identity"
  | "cleanup_authority"
  | "active_note";

export interface MissionReadinessCheckV1 {
  id: MissionReadinessCheckIdV1;
  label: string;
  required: boolean;
  ok: boolean;
  reason: string;
  nextAction: string;
  setupTarget: CapabilitySetupTarget;
}

export interface MissionReadinessMissingItemV1 {
  id: MissionReadinessCheckIdV1;
  label: string;
  reason: string;
  nextAction: string;
  setupTarget: CapabilitySetupTarget;
}

export interface MissionReadinessPreflightV1 {
  version: 1;
  compound: boolean;
  ok: boolean;
  stages: ProjectLifecycleStageV1[];
  checks: MissionReadinessCheckV1[];
  missing: MissionReadinessMissingItemV1[];
  /** First missing item in stable check order — the single next action. */
  primary: MissionReadinessMissingItemV1 | null;
}

export interface MissionReadinessPreflightInputV1 {
  prompt: string;
  readiness: readonly CapabilityReadinessV2[];
  activeNote?: {
    hasActiveMarkdown: boolean;
    path?: string | null;
  };
  cleanupAuthority?: {
    /** null = scopes not observed; fail closed when cleanup is required. */
    deleteRepoAuthorized: boolean | null;
  };
  /** Override for tests; defaults to host-pinned identity contract. */
  gitIdentityPinnedReady?: boolean;
}

const CHECK_ORDER: readonly MissionReadinessCheckIdV1[] = [
  "linear",
  "sandbox",
  "github",
  "git_identity",
  "cleanup_authority",
  "active_note",
] as const;

/**
 * One consolidated readiness gate for compound-shaped missions. Non-compound
 * prompts always pass so ordinary chat/note work is not blocked.
 */
export function evaluateMissionReadinessPreflightV1(
  input: MissionReadinessPreflightInputV1,
): MissionReadinessPreflightV1 {
  const lifecycle = evaluateCompoundLifecycleReadinessV1({
    prompt: input.prompt,
    readiness: input.readiness,
  });
  if (!lifecycle.compound) {
    return {
      version: 1,
      compound: false,
      ok: true,
      stages: lifecycle.stages,
      checks: [],
      missing: [],
      primary: null,
    };
  }

  const stages = new Set(lifecycle.stages);
  const byId = new Map(input.readiness.map((row) => [row.id, row]));
  const gitIdentityReady =
    typeof input.gitIdentityPinnedReady === "boolean"
      ? input.gitIdentityPinnedReady
      : evaluatePinnedGitIdentityReadinessV1();
  const deleteRepoAuthorized =
    input.cleanupAuthority?.deleteRepoAuthorized ?? null;
  const hasActiveMarkdown = input.activeNote?.hasActiveMarkdown === true;

  const checks: MissionReadinessCheckV1[] = CHECK_ORDER.map((id) => {
    switch (id) {
      case "linear":
        return linearCheck(stages.has("linear_hierarchy"), byId.get("linear"));
      case "sandbox":
        return sandboxCheck(stages.has("code_execution"), byId.get("code"));
      case "github":
        return githubCheck(
          stages.has("private_github_publication") ||
            stages.has("reconciliation_cleanup"),
          byId.get("github"),
        );
      case "git_identity":
        return gitIdentityCheck(
          stages.has("code_execution") ||
            stages.has("private_github_publication"),
          gitIdentityReady,
        );
      case "cleanup_authority":
        return cleanupAuthorityCheck(
          stages.has("reconciliation_cleanup"),
          deleteRepoAuthorized,
        );
      case "active_note":
        return activeNoteCheck(
          stages.has("accepted_research"),
          hasActiveMarkdown,
          input.activeNote?.path ?? null,
        );
    }
  });

  const missing = checks
    .filter((check) => check.required && !check.ok)
    .map(
      (check): MissionReadinessMissingItemV1 => ({
        id: check.id,
        label: check.label,
        reason: check.reason,
        nextAction: check.nextAction,
        setupTarget: check.setupTarget,
      }),
    );

  return {
    version: 1,
    compound: true,
    ok: missing.length === 0,
    stages: lifecycle.stages,
    checks,
    missing,
    primary: missing[0] ?? null,
  };
}

export function missionReadinessMissingSummaries(
  missing: readonly MissionReadinessMissingItemV1[],
): string[] {
  return missing.map((item) => `${item.label}: ${item.nextAction}`);
}

export function missionReadinessStageStripLabels(
  stages: readonly ProjectLifecycleStageV1[],
): string[] {
  return stages.map((stage) => compoundLifecycleStageLabel(stage));
}

function linearCheck(
  required: boolean,
  row: CapabilityReadinessV2 | undefined,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("linear", "Linear", "linear");
  }
  if (!row) {
    return {
      id: "linear",
      label: "Linear",
      required: true,
      ok: false,
      reason: "Linear readiness is unavailable.",
      nextAction: "Connect Linear",
      setupTarget: "linear",
    };
  }
  const ok = isLinearStartableForCompound(row.status);
  return {
    id: "linear",
    label: "Linear",
    required: true,
    ok,
    reason: ok ? row.reason : row.reason,
    nextAction: ok ? "Review Linear setup" : row.nextAction,
    setupTarget: row.setupTarget,
  };
}

function sandboxCheck(
  required: boolean,
  row: CapabilityReadinessV2 | undefined,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("sandbox", "Sandbox", "code");
  }
  if (!row) {
    return {
      id: "sandbox",
      label: "Sandbox",
      required: true,
      ok: false,
      reason: "Sandbox readiness is unavailable.",
      nextAction: "Run sandbox boundary probe",
      setupTarget: "code",
    };
  }
  const ok = isCodeStartableForCompound(row.status);
  return {
    id: "sandbox",
    label: "Sandbox",
    required: true,
    ok,
    reason: ok
      ? row.reason
      : row.reason ||
        "Code execution needs a bound repository and a fresh attested sandbox probe.",
    nextAction: ok ? "Review execution setup" : row.nextAction,
    setupTarget: row.setupTarget,
  };
}

function githubCheck(
  required: boolean,
  row: CapabilityReadinessV2 | undefined,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("github", "GitHub", "github");
  }
  if (!row) {
    return {
      id: "github",
      label: "GitHub",
      required: true,
      ok: false,
      reason: "GitHub readiness is unavailable.",
      nextAction: "Connect GitHub",
      setupTarget: "github",
    };
  }
  const ok = isGitHubStartableForCompound(row.status);
  return {
    id: "github",
    label: "GitHub",
    required: true,
    ok,
    reason: row.reason,
    nextAction: ok ? "Review GitHub setup" : row.nextAction,
    setupTarget: row.setupTarget,
  };
}

function gitIdentityCheck(
  required: boolean,
  pinnedReady: boolean,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("git_identity", "Git identity", "code");
  }
  return {
    id: "git_identity",
    label: "Git identity",
    required: true,
    ok: pinnedReady,
    reason: pinnedReady
      ? "Host-pinned agent commit identity is ready."
      : "The host-pinned agent commit identity contract is missing or invalid.",
    nextAction: pinnedReady
      ? "Review Git identity"
      : "Reload Code capability",
    setupTarget: "code",
  };
}

function cleanupAuthorityCheck(
  required: boolean,
  deleteRepoAuthorized: boolean | null,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("cleanup_authority", "Cleanup authority", "github");
  }
  const ok = deleteRepoAuthorized === true;
  return {
    id: "cleanup_authority",
    label: "Cleanup authority",
    required: true,
    ok,
    reason: ok
      ? "GitHub credential includes repository cleanup authority."
      : deleteRepoAuthorized === false
        ? "The connected GitHub credential lacks delete_repo (or classic repo) cleanup authority."
        : "GitHub cleanup authority has not been observed on the connected credential.",
    nextAction: ok
      ? "Review cleanup authority"
      : "Reconnect GitHub with cleanup scope",
    setupTarget: "github",
  };
}

function activeNoteCheck(
  required: boolean,
  hasActiveMarkdown: boolean,
  path: string | null,
): MissionReadinessCheckV1 {
  if (!required) {
    return optionalOk("active_note", "Active note", "notes_research");
  }
  return {
    id: "active_note",
    label: "Active note",
    required: true,
    ok: hasActiveMarkdown,
    reason: hasActiveMarkdown
      ? `Active markdown note is ready${path ? ` (${path})` : ""}.`
      : "Compound research writeback needs an open markdown note in Obsidian.",
    nextAction: hasActiveMarkdown
      ? "Review note setup"
      : "Open a markdown note",
    setupTarget: "notes_research",
  };
}

function optionalOk(
  id: MissionReadinessCheckIdV1,
  label: string,
  setupTarget: CapabilitySetupTarget,
): MissionReadinessCheckV1 {
  return {
    id,
    label,
    required: false,
    ok: true,
    reason: `${label} is not required for this mission.`,
    nextAction: `Review ${label.toLowerCase()} setup`,
    setupTarget,
  };
}
