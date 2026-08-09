/**
 * Bound-stage authority envelopes for compound lifecycle missions.
 *
 * Wired from AgentRunner prepared Bound execute: create/refresh on stage entry
 * or approval, gate with envelopeAllowsTool + fingerprint match, then
 * consumeEnvelopeMutation after a successful Bound mutation. Fingerprint
 * mismatch / expiry / budget exhaustion fail closed (resumable blocker; no
 * silent retry).
 */

import {
  PROJECT_LIFECYCLE_STAGES,
  type ProjectLifecycleStageV1,
} from "./projectLifecycle";
import { effectClassForTool } from "./autonomyEffectClass";
import {
  CODE_EXECUTION_ENVELOPE_NOTE_COMPANIONS,
  CODE_EXECUTION_TOOL_ALLOW,
  GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW,
  GITHUB_STAGE_READ_TOOL_ALLOW,
  GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW,
} from "./lifecycleStagePolicy";

export type MissionStageEnvelopeV1 = {
  version: 1;
  runId: string;
  stage: ProjectLifecycleStageV1;
  effectClass: "bound";
  /** Host-resolved destination fingerprints (team/project/repo profile). */
  authorityFingerprint: string;
  budget: { maxMutations: number; maxCreates: number; expiresAt: string };
  grantId?: string;
  mutationsUsed: number;
  createsUsed: number;
};

export const MISSION_STAGE_ENVELOPE_BLOCKER_CODES = Object.freeze({
  fingerprintMismatch: "mission_stage_envelope_fingerprint_mismatch",
  expired: "mission_stage_envelope_expired",
  budgetExhausted: "mission_stage_envelope_budget_exhausted",
  toolDenied: "mission_stage_envelope_tool_denied",
} as const);

const STAGE_TOOL_ALLOW: Record<ProjectLifecycleStageV1, readonly string[]> = {
  accepted_research: [
    "web_search",
    "web_fetch",
    "read_current_file",
    "read_file",
    "read_markdown_files",
    "search_markdown_files",
    "list_markdown_files",
    "semantic_search_notes",
    "find_related_notes",
    "get_note_graph_context",
    "append_to_current_file",
    "replace_current_file",
    "count_words",
    "publish_research_to_linear",
    // Reflection reports back to the issue this run created. The composite is
    // allowlisted; the raw linear_update_issue deliberately stays out so a
    // state change cannot be aimed at an arbitrary state id.
    "report_progress_to_linear",
  ],
  linear_hierarchy: [
    "publish_research_to_linear",
    "publish_research_project_to_linear",
    "linear_create_issue",
    "linear_get_issue",
    "linear_search_issues",
    "report_progress_to_linear",
    "append_to_current_file",
    "read_current_file",
  ],
  code_execution: [
    ...CODE_EXECUTION_TOOL_ALLOW,
    ...CODE_EXECUTION_ENVELOPE_NOTE_COMPANIONS,
  ],
  private_github_publication: [
    "publish_verified_code_to_github",
    "github_publish_verified_branch",
    "github_create_repository",
    ...GITHUB_STAGE_READ_TOOL_ALLOW,
    ...GITHUB_STAGE_SAFE_MUTATION_TOOL_ALLOW,
    "report_progress_to_linear",
    "append_to_current_file",
    "read_current_file",
  ],
  reconciliation_cleanup: [
    "linear_trash_issue",
    "linear_trash_project",
    "linear_trash_initiative",
    "github_delete_private_repository",
    ...GITHUB_CLEANUP_DESTRUCTIVE_TOOL_ALLOW,
  ],
};

export function toolsAllowedForEnvelopeStage(
  stage: ProjectLifecycleStageV1,
): readonly string[] {
  return STAGE_TOOL_ALLOW[stage] ?? [];
}

export function lifecycleStageForEnvelopeTool(
  toolName: string,
): ProjectLifecycleStageV1 | null {
  const name = canonicalEnvelopeToolName(toolName);
  if (!name) return null;
  for (const stage of PROJECT_LIFECYCLE_STAGES) {
    if (STAGE_TOOL_ALLOW[stage].includes(name)) {
      return stage;
    }
  }
  return null;
}

export function isEnvelopeCreateMutation(toolName: string): boolean {
  return /(?:^|_)create(?:_|$)/i.test(toolName.trim());
}

export function createMissionStageEnvelope(input: {
  runId: string;
  stage: ProjectLifecycleStageV1;
  authorityFingerprint: string;
  maxMutations?: number;
  maxCreates?: number;
  expiresAt: string;
  grantId?: string;
}): MissionStageEnvelopeV1 {
  const fingerprint = input.authorityFingerprint.trim();
  if (!fingerprint) {
    throw new TypeError("Mission stage envelope requires authorityFingerprint.");
  }
  if (!input.runId.trim()) {
    throw new TypeError("Mission stage envelope requires runId.");
  }
  return {
    version: 1,
    runId: input.runId.trim(),
    stage: input.stage,
    effectClass: "bound",
    authorityFingerprint: fingerprint,
    budget: {
      maxMutations: Math.max(1, input.maxMutations ?? 8),
      maxCreates: Math.max(0, input.maxCreates ?? 4),
      expiresAt: input.expiresAt,
    },
    ...(input.grantId?.trim() ? { grantId: input.grantId.trim() } : {}),
    mutationsUsed: 0,
    createsUsed: 0,
  };
}

/**
 * Keep usage counters when the same stage + authority is still live; otherwise
 * mint a fresh envelope (stage entry / approval refresh).
 */
export function ensureMissionStageEnvelope(input: {
  existing: MissionStageEnvelopeV1 | null | undefined;
  runId: string;
  stage: ProjectLifecycleStageV1;
  authorityFingerprint: string;
  expiresAt: string;
  grantId?: string;
  maxMutations?: number;
  maxCreates?: number;
}): MissionStageEnvelopeV1 {
  const fingerprint = input.authorityFingerprint.trim();
  const runId = input.runId.trim();
  const existing = input.existing;
  if (
    existing &&
    existing.runId === runId &&
    existing.stage === input.stage &&
    existing.authorityFingerprint === fingerprint &&
    Date.parse(existing.budget.expiresAt) > Date.now()
  ) {
    if (input.grantId?.trim() && !existing.grantId) {
      return { ...existing, grantId: input.grantId.trim() };
    }
    return existing;
  }
  return createMissionStageEnvelope({
    runId,
    stage: input.stage,
    authorityFingerprint: fingerprint,
    expiresAt: input.expiresAt,
    grantId: input.grantId,
    maxMutations: input.maxMutations,
    maxCreates: input.maxCreates,
  });
}

export function envelopeMatchesPreparedAction(
  envelope: MissionStageEnvelopeV1,
  prepared: { authorityFingerprint?: string; runId?: string },
): boolean {
  if (prepared.runId && prepared.runId !== envelope.runId) return false;
  const fp = prepared.authorityFingerprint?.trim();
  if (!fp) return false;
  return fp === envelope.authorityFingerprint;
}

export function envelopeAllowsTool(
  envelope: MissionStageEnvelopeV1,
  toolName: string,
): boolean {
  if (Date.parse(envelope.budget.expiresAt) <= Date.now()) {
    return false;
  }
  if (envelope.mutationsUsed >= envelope.budget.maxMutations) {
    return false;
  }
  const allowed = new Set(toolsAllowedForEnvelopeStage(envelope.stage));
  if (!allowed.has(canonicalEnvelopeToolName(toolName))) return false;
  // Soft tools are always fine inside a Bound envelope; Hard tools never are.
  // Stage allowlists are authoritative even when a descriptor is missing.
  try {
    const cls = effectClassForTool(toolName);
    return cls === "soft" || cls === "bound";
  } catch {
    return true;
  }
}

/** Persisted V1 graph nodes may still carry the old private-only tool name. */
function canonicalEnvelopeToolName(toolName: string): string {
  const name = toolName.trim();
  return name === "github_create_private_repository"
    ? "github_create_repository"
    : name;
}

export type EnvelopeBoundExecuteGate =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function assertEnvelopeAllowsBoundExecute(input: {
  envelope: MissionStageEnvelopeV1;
  toolName: string;
  runId: string;
  authorityFingerprint: string;
}): EnvelopeBoundExecuteGate {
  if (
    !envelopeMatchesPreparedAction(input.envelope, {
      runId: input.runId,
      authorityFingerprint: input.authorityFingerprint,
    })
  ) {
    return {
      ok: false,
      code: MISSION_STAGE_ENVELOPE_BLOCKER_CODES.fingerprintMismatch,
      message:
        "Mission stage envelope authority fingerprint does not match the prepared Bound action. The run is blocked and resumable; the host will not silently retry.",
    };
  }
  const expired = Date.parse(input.envelope.budget.expiresAt) <= Date.now();
  if (expired) {
    return {
      ok: false,
      code: MISSION_STAGE_ENVELOPE_BLOCKER_CODES.expired,
      message:
        "Mission stage envelope expired before Bound execute. The run is blocked and resumable; the host will not silently retry.",
    };
  }
  const mutationBudgetExhausted =
    input.envelope.mutationsUsed >= input.envelope.budget.maxMutations;
  const createBudgetExhausted =
    isEnvelopeCreateMutation(input.toolName) &&
    input.envelope.createsUsed >= input.envelope.budget.maxCreates;
  if (mutationBudgetExhausted || createBudgetExhausted) {
    return {
      ok: false,
      code: MISSION_STAGE_ENVELOPE_BLOCKER_CODES.budgetExhausted,
      message:
        "Mission stage envelope mutation budget is exhausted. The run is blocked and resumable; the host will not silently retry.",
    };
  }
  if (envelopeAllowsTool(input.envelope, input.toolName)) {
    return { ok: true };
  }
  return {
    ok: false,
    code: MISSION_STAGE_ENVELOPE_BLOCKER_CODES.toolDenied,
    message:
      `Mission stage envelope for ${input.envelope.stage} does not allow Bound tool ${input.toolName}. The run is blocked and resumable; the host will not silently retry.`,
  };
}

export function consumeEnvelopeMutation(
  envelope: MissionStageEnvelopeV1,
  options: { isCreate?: boolean } = {},
): MissionStageEnvelopeV1 | { exhausted: true } {
  if (Date.parse(envelope.budget.expiresAt) <= Date.now()) {
    return { exhausted: true };
  }
  if (envelope.mutationsUsed >= envelope.budget.maxMutations) {
    return { exhausted: true };
  }
  const nextCreates = envelope.createsUsed + (options.isCreate ? 1 : 0);
  if (options.isCreate && nextCreates > envelope.budget.maxCreates) {
    return { exhausted: true };
  }
  return {
    ...envelope,
    mutationsUsed: envelope.mutationsUsed + 1,
    createsUsed: nextCreates,
  };
}
