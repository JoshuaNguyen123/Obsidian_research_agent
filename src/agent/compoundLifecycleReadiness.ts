import type { CapabilityReadinessV2 } from "./capabilityReadiness";
import type { CapabilitySetupTarget } from "./capabilitySetup";
import {
  detectProjectLifecycleStagesV1,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";

export interface CompoundLifecycleBlockerV1 {
  stage: ProjectLifecycleStageV1;
  capabilityId: CapabilityReadinessV2["id"];
  setupTarget: CapabilitySetupTarget;
  status: CapabilityReadinessV2["status"];
  reason: string;
  nextAction: string;
}

export interface CompoundLifecycleReadinessV1 {
  version: 1;
  stages: ProjectLifecycleStageV1[];
  compound: boolean;
  ok: boolean;
  blockers: CompoundLifecycleBlockerV1[];
}

const STAGE_CAPABILITY: Partial<
  Record<ProjectLifecycleStageV1, CapabilityReadinessV2["id"]>
> = {
  accepted_research: "notes",
  linear_hierarchy: "linear",
  code_execution: "code",
  private_github_publication: "github",
};

/**
 * Compound end-to-end runs may start only when each required capability is
 * past "Setup needed" / "Blocked". Approval-needed and Available remain
 * startable (approvals and binding happen mid-run).
 */
export function isCapabilityStartableForCompound(
  status: CapabilityReadinessV2["status"],
): boolean {
  return (
    status === "Ready" ||
    status === "Approval needed" ||
    status === "Available" ||
    status === "Degraded"
  );
}

/** Code execution requires a bound repo + fresh sandbox (Ready only). */
export function isCodeStartableForCompound(
  status: CapabilityReadinessV2["status"],
): boolean {
  return status === "Ready";
}

/** Linear hierarchy requires verified destination (Ready or Approval needed). */
export function isLinearStartableForCompound(
  status: CapabilityReadinessV2["status"],
): boolean {
  return status === "Ready" || status === "Approval needed";
}

/** GitHub publication requires connected tools (not Setup needed / Blocked). */
export function isGitHubStartableForCompound(
  status: CapabilityReadinessV2["status"],
): boolean {
  return (
    status === "Ready" ||
    status === "Approval needed" ||
    status === "Available" ||
    status === "Degraded"
  );
}

export function evaluateCompoundLifecycleReadinessV1(input: {
  prompt: string;
  readiness: readonly CapabilityReadinessV2[];
}): CompoundLifecycleReadinessV1 {
  let stages: ProjectLifecycleStageV1[] = [];
  try {
    stages = detectProjectLifecycleStagesV1(input.prompt);
  } catch {
    stages = [];
  }
  const compound = stages.length > 1;
  if (!compound) {
    return { version: 1, stages, compound: false, ok: true, blockers: [] };
  }

  const byId = new Map(input.readiness.map((row) => [row.id, row]));
  const blockers: CompoundLifecycleBlockerV1[] = [];

  for (const stage of stages) {
    const capabilityId = STAGE_CAPABILITY[stage];
    if (!capabilityId) continue;
    const row = byId.get(capabilityId);
    if (!row) {
      const setupTarget: CapabilitySetupTarget =
        capabilityId === "notes"
          ? "notes_research"
          : capabilityId === "browser"
            ? "browser_web"
            : capabilityId;
      blockers.push({
        stage,
        capabilityId,
        setupTarget,
        status: "Blocked",
        reason: `Capability ${capabilityId} readiness is unavailable.`,
        nextAction: "Open settings and refresh capability status",
      });
      continue;
    }
    const startable =
      capabilityId === "code"
        ? isCodeStartableForCompound(row.status)
        : capabilityId === "linear"
          ? isLinearStartableForCompound(row.status)
          : capabilityId === "github"
            ? isGitHubStartableForCompound(row.status)
            : isCapabilityStartableForCompound(row.status);
    if (!startable) {
      blockers.push({
        stage,
        capabilityId,
        setupTarget: row.setupTarget,
        status: row.status,
        reason: row.reason,
        nextAction: row.nextAction,
      });
    }
  }

  return {
    version: 1,
    stages,
    compound: true,
    ok: blockers.length === 0,
    blockers,
  };
}

export function compoundLifecycleStageLabel(
  stage: ProjectLifecycleStageV1,
): string {
  switch (stage) {
    case "accepted_research":
      return "Research";
    case "linear_hierarchy":
      return "Linear";
    case "code_execution":
      return "Code";
    case "private_github_publication":
      return "GitHub";
    case "reconciliation_cleanup":
      return "Cleanup";
  }
}

export function formatCompoundLifecycleStageStrip(
  stages: readonly ProjectLifecycleStageV1[],
  activeStage?: ProjectLifecycleStageV1 | null,
): string {
  if (stages.length === 0) return "";
  return stages
    .map((stage) => {
      const label = compoundLifecycleStageLabel(stage);
      return stage === activeStage ? `[${label}]` : label;
    })
    .join(" → ");
}
