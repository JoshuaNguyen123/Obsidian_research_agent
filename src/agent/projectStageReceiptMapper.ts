import type { ActionReceipt, ResourceRef } from "./actions";
import {
  assertExactKeys,
  DurableLinearContractError,
  expectEnum,
  expectIsoTimestamp,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
} from "../integrations/linear/LinearContractSupport";
import {
  canonicalGitCommitShaV1,
  createProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectEvidenceResourceV1,
  type ProjectEventWorkUnitBindingV1,
  type ProjectPhaseV1,
  type ProjectStageEventV1,
} from "./projectRunReport";

export const PROJECT_RECEIPT_OBSERVATION_SCHEMA_VERSION = 1 as const;

export interface ProjectReceiptObservationV1 {
  schemaVersion: typeof PROJECT_RECEIPT_OBSERVATION_SCHEMA_VERSION;
  runId: string;
  receiptId: string;
  toolName: string;
  committedAt: string;
  payloadFingerprint: string;
  readbackStatus: "verified" | "unverified";
  observedFingerprint: string | null;
  outcome: "committed" | "blocked";
  resource: ProjectEvidenceResourceV1;
  workUnits: ProjectEventWorkUnitBindingV1[];
}

export interface ProjectReceiptToolEvidenceMappingV1 {
  phase: ProjectPhaseV1;
  evidenceKind: ProjectEvidenceKindV1;
}

/**
 * Closed host mapping. A provider or model cannot name an arbitrary phase;
 * only these known receipt-producing operations can mint stage evidence.
 */
export const PROJECT_RECEIPT_TOOL_EVIDENCE_MAP_V1: Readonly<
  Record<string, ProjectReceiptToolEvidenceMappingV1>
> = Object.freeze({
  accept_research_artifact: {
    phase: "research",
    evidenceKind: "research_artifact",
  },
  write_accepted_research_artifact: {
    phase: "research",
    evidenceKind: "research_artifact",
  },
  create_research_pack: {
    phase: "research",
    evidenceKind: "research_artifact",
  },
  publish_research_to_linear: {
    phase: "linear_plan",
    evidenceKind: "linear_hierarchy_readback",
  },
  publish_research_project_to_linear: {
    phase: "linear_plan",
    evidenceKind: "linear_hierarchy_readback",
  },
  code_workspace_create_file: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_write_expected: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_append: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_patch: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_copy: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_move: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_mkdir: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_workspace_restore: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_replace_text: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_write_file: {
    phase: "implement",
    evidenceKind: "workspace_mutation",
  },
  code_diff_readback: {
    phase: "implement",
    evidenceKind: "diff_readback",
  },
  code_validate_targeted: {
    phase: "test",
    evidenceKind: "targeted_validation",
  },
  code_workspace_validate_targeted: {
    phase: "test",
    evidenceKind: "targeted_validation",
  },
  code_validate_full: {
    phase: "test",
    evidenceKind: "full_validation",
  },
  code_workspace_validate_full: {
    phase: "test",
    evidenceKind: "full_validation",
  },
  code_commit_verified: {
    phase: "test",
    evidenceKind: "commit_readback",
  },
  github_create_repository: {
    phase: "github",
    evidenceKind: "github_repository_readback",
  },
  github_create_private_repository: {
    phase: "github",
    evidenceKind: "github_repository_readback",
  },
  github_repository_readback: {
    phase: "github",
    evidenceKind: "github_repository_readback",
  },
  github_create_draft_pull_request: {
    phase: "github",
    evidenceKind: "github_draft_pr_readback",
  },
  github_draft_pr_readback: {
    phase: "github",
    evidenceKind: "github_draft_pr_readback",
  },
  publish_verified_code_to_github: {
    phase: "github",
    evidenceKind: "github_draft_pr_readback",
  },
  append_jupyter_reflection: {
    phase: "reflect",
    evidenceKind: "reflection_writeback",
  },
  write_project_results: {
    phase: "reflect",
    evidenceKind: "reflection_writeback",
  },
  append_project_results: {
    phase: "reflect",
    evidenceKind: "reflection_writeback",
  },
  verify_acceptance_criterion: {
    phase: "test",
    evidenceKind: "acceptance_criterion",
  },
});

/**
 * Turn one already-validated action receipt into zero or one stage event.
 * Mutation receipts without verified readback, unknown tools, and unsupported
 * resource systems are deliberately ignored.
 */
export function projectStageEventFromActionReceiptV1(input: {
  receipt: ActionReceipt;
  /**
   * Optional root mission selected by the host after it verifies the receipt's
   * child-run relationship. The receipt itself is never rewritten.
   */
  runId?: string;
  workUnits?: readonly ProjectEventWorkUnitBindingV1[];
}): ProjectStageEventV1 | null {
  const receipt = input.receipt;
  if (
    receipt.version !== 1 ||
    receipt.readback.status !== "verified" ||
    !PROJECT_RECEIPT_TOOL_EVIDENCE_MAP_V1[receipt.toolName]
  ) {
    return null;
  }
  const resource = projectResourceFromReceiptResourcesV1(receipt);
  if (!resource) return null;
  return projectStageEventFromReceiptObservationV1({
    schemaVersion: PROJECT_RECEIPT_OBSERVATION_SCHEMA_VERSION,
    runId: input.runId?.trim() || receipt.runId,
    receiptId: receipt.id,
    toolName: receipt.toolName,
    committedAt: receipt.committedAt,
    payloadFingerprint: receipt.payloadFingerprint,
    readbackStatus: "verified",
    observedFingerprint: receipt.readback.observedFingerprint ?? null,
    outcome: "committed",
    resource,
    workUnits: [...(input.workUnits ?? [])],
  });
}

/**
 * Receipt-like host observation mapper, also used for independently verified
 * blockers that correctly have no committed ActionReceipt.
 */
export function projectStageEventFromReceiptObservationV1(
  value: ProjectReceiptObservationV1,
): ProjectStageEventV1 | null {
  const observation = parseProjectReceiptObservationV1(value);
  if (observation.readbackStatus !== "verified") return null;
  const mapping = PROJECT_RECEIPT_TOOL_EVIDENCE_MAP_V1[observation.toolName];
  if (!mapping) return null;
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: observation.runId,
    phase: mapping.phase,
    evidenceKind:
      observation.outcome === "blocked"
        ? "actionable_blocker"
        : mapping.evidenceKind,
    disposition: observation.outcome === "blocked" ? "blocked" : "verified",
    occurredAt: observation.committedAt,
    sourceReceiptId: observation.receiptId,
    evidenceFingerprint:
      observation.observedFingerprint ?? observation.payloadFingerprint,
    resource: observation.resource,
    workUnits: observation.workUnits,
  });
}

export function parseProjectReceiptObservationV1(
  value: unknown,
): ProjectReceiptObservationV1 {
  const record = expectPlainRecord(value, "project receipt observation");
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "runId",
      "receiptId",
      "toolName",
      "committedAt",
      "payloadFingerprint",
      "readbackStatus",
      "observedFingerprint",
      "outcome",
      "resource",
      "workUnits",
    ],
    [],
    "project receipt observation",
  );
  if (record.schemaVersion !== PROJECT_RECEIPT_OBSERVATION_SCHEMA_VERSION) {
    throw new DurableLinearContractError(
      "Unsupported project receipt observation version.",
    );
  }
  if (!Array.isArray(record.workUnits)) {
    throw new DurableLinearContractError(
      "Project receipt observation work units must be a list.",
    );
  }
  // createProjectStageEventV1 is the single canonical validator for resource
  // and work-unit subcontracts. Use a known inert evidence kind, then retain
  // its normalized nested values without accepting the synthetic event.
  const runId = expectOpaqueId(record.runId, "project run id");
  const receiptId = expectOpaqueId(record.receiptId, "project source receipt id");
  const committedAt = expectIsoTimestamp(record.committedAt, "project receipt time");
  const payloadFingerprint = expectSha256(
    record.payloadFingerprint,
    "project receipt payload fingerprint",
  );
  const normalized = createProjectStageEventV1({
    schemaVersion: 1,
    runId,
    phase: "research",
    evidenceKind: "research_artifact",
    disposition: "verified",
    occurredAt: committedAt,
    sourceReceiptId: receiptId,
    evidenceFingerprint: payloadFingerprint,
    resource: record.resource as ProjectEvidenceResourceV1,
    workUnits: record.workUnits as ProjectEventWorkUnitBindingV1[],
  });
  return {
    schemaVersion: PROJECT_RECEIPT_OBSERVATION_SCHEMA_VERSION,
    runId,
    receiptId,
    toolName: expectOpaqueId(record.toolName, "project receipt tool name", 160),
    committedAt,
    payloadFingerprint,
    readbackStatus: expectEnum(
      record.readbackStatus,
      "project receipt readback status",
      ["verified", "unverified"] as const,
    ),
    observedFingerprint:
      record.observedFingerprint === null
        ? null
        : expectSha256(
            record.observedFingerprint,
            "project receipt observed fingerprint",
          ),
    outcome: expectEnum(
      record.outcome,
      "project receipt outcome",
      ["committed", "blocked"] as const,
    ),
    resource: normalized.resource,
    workUnits: normalized.workUnits,
  };
}

/**
 * The receipt-shaped input this projection needs. Deliberately structural, so
 * the canonical `ActionReceipt` and the persisted `AgentRunReceipt` replay of
 * the same immutable receipt run through ONE implementation. Two copies of
 * this mapping is how a durable ledger and its live projection start naming
 * different resources for one commit.
 */
export interface ProjectReceiptResourceEvidenceV1 {
  resource: ResourceRef;
  relatedResources?: readonly ResourceRef[] | undefined;
  readback?: { observedRevision?: string | undefined } | undefined;
}

/**
 * A receipt whose own resource addresses something other than a Git object may
 * still NAME the commit it verified, as a related resource. `code_commit_verified`
 * is exactly that case: its `resource` is the durable repair checkpoint (with
 * the checkpoint SEQUENCE as its revision) because reconciliation keys on the
 * checkpoint, while the commit SHA rides along in `relatedResources`.
 *
 * Only a value that IS a canonical Git object id qualifies, and a related
 * resource that disagrees with itself (revision present but not equal to the
 * id) is refused rather than trusted.
 */
function verifiedGitCommitResource(
  related: readonly ResourceRef[] | undefined,
): { resource: ResourceRef; commitSha: string } | null {
  for (const candidate of related ?? []) {
    if (candidate.system !== "git" || candidate.resourceType !== "commit") {
      continue;
    }
    const commitSha = canonicalGitCommitShaV1(candidate.id);
    if (!commitSha) continue;
    if (candidate.revision !== undefined && candidate.revision !== commitSha) {
      continue;
    }
    return { resource: candidate, commitSha };
  }
  return null;
}

/**
 * Single host answer to "which resource does this receipt's stage evidence
 * address?". Prefer the related Git commit only when the receipt's own
 * resource does not already name a Git object id, so a receipt that addresses
 * the commit directly keeps addressing it, and never invent a resource: a
 * receipt that names no Git object id anywhere still projects its own
 * checkpoint identity and remains unable to pay a commit-SHA consumer.
 */
export function projectResourceFromReceiptResourcesV1(
  input: ProjectReceiptResourceEvidenceV1,
): ProjectEvidenceResourceV1 | null {
  const own = input.resource;
  const ownCommitSha = canonicalGitCommitShaV1(own.revision ?? own.id);
  const named = ownCommitSha ? null : verifiedGitCommitResource(input.relatedResources);
  if (named) {
    if (!isProjectResourceSystem(named.resource.system)) return null;
    return {
      system: named.resource.system,
      resourceType: named.resource.resourceType,
      id: named.resource.id,
      url: named.resource.url ?? null,
      path: named.resource.path ?? null,
      // The observed revision belongs to the receipt's own target (the
      // checkpoint sequence number). Never stamp it onto the commit.
      revision: named.commitSha,
    };
  }
  if (!isProjectResourceSystem(own.system)) return null;
  return {
    system: own.system,
    resourceType: own.resourceType,
    id: own.id,
    url: own.url ?? null,
    path: own.path ?? null,
    revision: input.readback?.observedRevision ?? own.revision ?? null,
  };
}

function isProjectResourceSystem(
  system: ResourceRef["system"],
): system is ProjectEvidenceResourceV1["system"] {
  return (
    system === "vault" ||
    system === "linear" ||
    system === "workspace" ||
    system === "git" ||
    system === "github"
  );
}
