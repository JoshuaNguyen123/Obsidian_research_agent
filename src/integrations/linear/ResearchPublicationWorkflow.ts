import type { AuthorityGrantV1 } from "../../agent/authority";
import type { ActionReceipt } from "../../agent/actions";
import type { ToolExecutionContext } from "../../tools/types";
import type {
  AcceptedResearchArtifactV1,
} from "./AcceptedResearchArtifactV1";
import type {
  AcceptedResearchNoteWriteRequestV1,
  AcceptedResearchNoteWriteResultV1,
  AcceptedResearchNoteWriter,
  ResearchNoteBacklinkResultV1,
} from "./AcceptedResearchNoteWriter";
import {
  createExternalWorkItemBindingV1,
  type ExternalWorkItemBindingV1,
} from "./ExternalWorkItemBindingV1";
import type { LinearAuthoritySubject } from "./HostLinearActionExecutor";
import {
  appendWorkItemLineageTransitionV1,
  createWorkItemLineageV1,
  type WorkItemLineageEventV1,
  type WorkItemLineageV1,
} from "./WorkItemLineageV1";
import type {
  BuiltResearchTicket,
  ResearchTicketPreviewRequest,
  ResearchTicketPreviewResult,
  ResearchTicketPublishRequest,
  ResearchTicketPublishResult,
  ResearchTicketWorkItemDraftV2,
  SynthesizedResearchTicketSectionsV1,
} from "./ResearchTicketPublisher";
import { sha256LinearValue } from "./client";
import type { LinearIssueRecord } from "./types";

export const RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type ResearchPublicationCheckpointStatusV1 =
  | "note_verified"
  | "approval_denied"
  | "failed"
  | "reconcile_required"
  | "linear_verified"
  | "waiting_obsidian"
  | "complete";

export interface ResearchPublicationDestinationV1 {
  workspaceId: string;
  teamId: string;
  projectId: string;
}

export interface ResearchPublicationRequestV1 {
  /** Must be host-derived from the current user mission, never model output. */
  explicitUserMission: boolean;
  runId: string;
  toolCallId: string;
  subject: LinearAuthoritySubject;
  context: ToolExecutionContext;
  note: AcceptedResearchNoteWriteRequestV1;
  destination: ResearchPublicationDestinationV1;
  generation?: number;
  parentIssueId?: string;
}

export interface ResearchPublicationExactApprovalRequestV1 {
  schemaVersion: 1;
  kind: "linear_research_publication";
  runId: string;
  toolCallId: string;
  approvalFingerprint: string;
  destination: ResearchPublicationDestinationV1;
  artifactFingerprint: string;
  noteSha256: string;
  workItemFingerprint: string;
  title: string;
  description: string;
  proposedAction: "create" | "reuse_duplicate";
  duplicate: ResearchPublicationIssueReferenceV1 | null;
  candidatesExamined: number;
}

export type ResearchPublicationApprovalDecisionV1 =
  | {
      approved: true;
      approvalId: string;
      /** An exact approval must echo the immutable preview fingerprint. */
      approvalFingerprint: string;
      activeGrants?: readonly AuthorityGrantV1[];
      preferredGrantId?: string;
    }
  | {
      approved: false;
      reason?: string;
    };

export interface ResearchPublicationApprovalPortV1 {
  requestExactApproval(
    request: ResearchPublicationExactApprovalRequestV1,
  ): Promise<ResearchPublicationApprovalDecisionV1>;
}

export interface ResearchPublicationIssueReferenceV1 {
  id: string;
  identifier: string;
  url: string;
  updatedAt: string;
  snapshotHash: string;
}

export interface ResearchPublicationPendingActionV1 {
  provider: "linear";
  operation: "publish_research_ticket";
  actionId: string | null;
  issueId: string | null;
  grantId: string | null;
  workItemFingerprint: string;
  error: ResearchPublicationErrorV1;
}

export interface ResearchPublicationErrorV1 {
  code: string;
  message: string;
}

/**
 * One crash-durable snapshot. Implementations should replace a publication ID
 * atomically so a verified Linear issue is never recreated after restart.
 */
export interface ResearchPublicationCheckpointV1 {
  schemaVersion: typeof RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION;
  publicationId: string;
  status: ResearchPublicationCheckpointStatusV1;
  updatedAt: string;
  artifact: AcceptedResearchArtifactV1;
  lineage: WorkItemLineageV1 | null;
  workItemFingerprint: string | null;
  approvalFingerprint: string | null;
  binding: ExternalWorkItemBindingV1 | null;
  issue: ResearchPublicationIssueReferenceV1 | null;
  pendingAction: ResearchPublicationPendingActionV1 | null;
  backlink: ResearchNoteBacklinkResultV1 | null;
  error: ResearchPublicationErrorV1 | null;
}

export interface ResearchPublicationLineagePortV1 {
  persist(checkpoint: ResearchPublicationCheckpointV1): Promise<void>;
}

export type ResearchPublicationTraceStageV1 =
  | "explicit_intent_verified"
  | "note_write_started"
  | "note_verified"
  | "linear_preview_started"
  | "linear_preview_verified"
  | "note_lineage_persisted"
  | "approval_requested"
  | "approval_denied"
  | "approval_verified"
  | "linear_publish_started"
  | "linear_publish_verified"
  | "reconcile_required"
  | "linear_lineage_persisted"
  | "backlink_started"
  | "backlink_verified"
  | "waiting_obsidian"
  | "complete";

export interface ResearchPublicationTraceEventV1 {
  stage: ResearchPublicationTraceStageV1;
  at: string;
  publicationId: string;
  details?: Record<string, string | number | boolean | null>;
}

export interface ResearchPublicationPublisherPortV1 {
  preview(request: ResearchTicketPreviewRequest): Promise<ResearchTicketPreviewResult>;
  publish(request: ResearchTicketPublishRequest): Promise<ResearchTicketPublishResult>;
}

export interface ResearchPublicationWorkflowOptionsV1 {
  noteWriter: Pick<AcceptedResearchNoteWriter, "writeAcceptedPackage" | "appendLinearBacklink">;
  publisher: ResearchPublicationPublisherPortV1;
  approval: ResearchPublicationApprovalPortV1;
  lineage: ResearchPublicationLineagePortV1;
  now?: () => Date;
  trace?: (event: ResearchPublicationTraceEventV1) => void;
}

interface ResearchPublicationResultBaseV1 {
  note: AcceptedResearchNoteWriteResultV1;
  artifact: AcceptedResearchArtifactV1;
  lineage: WorkItemLineageV1 | null;
  approvalFingerprint: string | null;
}

export type ResearchPublicationResultV1 =
  | {
      ok: true;
      status: "complete";
      publication: "created" | "deduplicated";
      note: AcceptedResearchNoteWriteResultV1;
      artifact: AcceptedResearchArtifactV1;
      lineage: WorkItemLineageV1;
      approvalFingerprint: string;
      binding: ExternalWorkItemBindingV1;
      issue: LinearIssueRecord;
      backlink: ResearchNoteBacklinkResultV1;
      /** Canonical provider receipt for a create; exact readback proof is synthesized by the host for dedup. */
      receipt: ActionReceipt | null;
    }
  | (ResearchPublicationResultBaseV1 & {
      ok: false;
      status: "denied" | "rejected" | "not_applied";
      error: ResearchPublicationErrorV1;
    })
  | (ResearchPublicationResultBaseV1 & {
      ok: false;
      status: "reconcile_required";
      error: ResearchPublicationErrorV1;
      pendingAction: ResearchPublicationPendingActionV1;
      issue?: LinearIssueRecord;
    })
  | {
      ok: false;
      status: "waiting_obsidian";
      error: ResearchPublicationErrorV1;
      note: AcceptedResearchNoteWriteResultV1;
      artifact: AcceptedResearchArtifactV1;
      lineage: WorkItemLineageV1;
      approvalFingerprint: string;
      binding: ExternalWorkItemBindingV1;
      issue: LinearIssueRecord;
      receipt: ActionReceipt | null;
    };

/**
 * Host-side, explicit-only research handoff. This service owns ordering and
 * durable lineage, but delegates all Linear mutation and readback to the
 * existing ResearchTicketPublisher.
 */
export class ResearchPublicationWorkflow {
  private readonly now: () => Date;

  constructor(private readonly options: ResearchPublicationWorkflowOptionsV1) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(request: ResearchPublicationRequestV1): Promise<ResearchPublicationResultV1> {
    validateHostIntent(request);
    const publicationId = `publication-${request.note.artifactId}`;
    this.trace("explicit_intent_verified", publicationId);

    this.trace("note_write_started", publicationId);
    const note = await this.options.noteWriter.writeAcceptedPackage(request.note);
    const artifact = note.artifact;
    this.trace("note_verified", publicationId, {
      noteSha256: note.afterSha256,
      noteReceiptId: note.noteReceiptId,
    });

    const sections = sectionsFromAcceptedNote(request.note);
    const draft = draftFromAcceptedArtifact(request, artifact);
    const previewRequest = { context: request.context, sections, draft } as ResearchTicketPreviewRequest;
    this.trace("linear_preview_started", publicationId);
    const preview = await this.options.publisher.preview(previewRequest);
    if (!preview.ok) {
      const error = normalizeError(preview.error, "research_publication_preview_rejected");
      await this.persist({
        publicationId,
        status: "failed",
        artifact,
        lineage: null,
        workItemFingerprint: preview.ticket?.spec.fingerprint ?? null,
        approvalFingerprint: null,
        binding: null,
        issue: null,
        pendingAction: null,
        backlink: null,
        error,
      });
      return {
        ok: false,
        status: "rejected",
        error,
        note,
        artifact,
        lineage: null,
        approvalFingerprint: null,
      };
    }
    this.trace("linear_preview_verified", publicationId, {
      proposedAction: preview.status,
      candidatesExamined: preview.candidatesExamined,
      workItemFingerprint: preview.ticket.spec.fingerprint,
    });

    let lineage = createNoteVerifiedLineage(request, artifact, preview.ticket);
    await this.persist({
      publicationId,
      status: "note_verified",
      artifact,
      lineage,
      workItemFingerprint: preview.ticket.spec.fingerprint,
      approvalFingerprint: null,
      binding: null,
      issue: null,
      pendingAction: null,
      backlink: null,
      error: null,
    });
    this.trace("note_lineage_persisted", publicationId);

    const approvalRequest = await buildExactApprovalRequest(request, artifact, preview);
    this.trace("approval_requested", publicationId, {
      approvalFingerprint: approvalRequest.approvalFingerprint,
    });
    const decision = await this.options.approval.requestExactApproval(approvalRequest);
    if (!decision.approved) {
      const error = {
        code: "research_publication_approval_denied",
        message: decision.reason?.trim() || "Research publication approval was denied.",
      };
      await this.persist({
        publicationId,
        status: "approval_denied",
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding: null,
        issue: null,
        pendingAction: null,
        backlink: null,
        error,
      });
      this.trace("approval_denied", publicationId);
      return {
        ok: false,
        status: "denied",
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
      };
    }
    if (
      !decision.approvalId.trim() ||
      decision.approvalFingerprint !== approvalRequest.approvalFingerprint
    ) {
      const error = {
        code: "research_publication_approval_fingerprint_mismatch",
        message: "The approval did not match the exact research publication preview.",
      };
      await this.persist({
        publicationId,
        status: "failed",
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding: null,
        issue: null,
        pendingAction: null,
        backlink: null,
        error,
      });
      return {
        ok: false,
        status: "rejected",
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
      };
    }
    this.trace("approval_verified", publicationId, {
      approvalId: decision.approvalId,
      approvalFingerprint: approvalRequest.approvalFingerprint,
    });

    this.trace("linear_publish_started", publicationId);
    const published = await this.options.publisher.publish({
      runId: request.runId,
      toolCallId: request.toolCallId,
      subject: request.subject,
      context: request.context,
      sections,
      draft,
      approvedPreview: {
        status: preview.status,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        duplicateId: preview.duplicate?.id ?? null,
        duplicateSnapshotHash: preview.duplicate?.snapshotHash ?? null,
      },
      // Never fall back to executor-global grants. Exact publication approval
      // authorizes only the grants returned by this approval decision.
      activeGrants: decision.activeGrants ?? [],
      ...(decision.preferredGrantId ? { preferredGrantId: decision.preferredGrantId } : {}),
    } as ResearchTicketPublishRequest);
    if (!published.ok) {
      const error = normalizeError(published.error, "research_publication_failed");
      const status = published.status === "reconcile_required"
        ? "reconcile_required"
        : "failed";
      const pendingAction = published.status === "reconcile_required"
        ? pendingFromFailure(published, preview.ticket.spec.fingerprint, error)
        : null;
      await this.persist({
        publicationId,
        status,
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding: null,
        issue: null,
        pendingAction,
        backlink: null,
        error,
      });
      if (pendingAction) {
        this.trace("reconcile_required", publicationId, {
          actionId: pendingAction.actionId,
          issueId: pendingAction.issueId,
        });
        return {
          ok: false,
          status: "reconcile_required",
          error,
          note,
          artifact,
          lineage,
          approvalFingerprint: approvalRequest.approvalFingerprint,
          pendingAction,
        };
      }
      const nonReconcileStatus = published.status === "not_applied"
        ? "not_applied" as const
        : "rejected" as const;
      return {
        ok: false,
        status: nonReconcileStatus,
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
      };
    }

    const drift = publicationDrift(preview.ticket, published.ticket);
    const destinationMismatch = issueDestinationMismatch(published.issue, request.destination);
    if (drift || destinationMismatch) {
      const error = {
        code: drift
          ? "research_publication_preview_drift"
          : "research_publication_destination_mismatch",
        message: drift ?? destinationMismatch ?? "Research publication readback changed.",
      };
      const pendingAction = pendingFromSuccess(
        published,
        preview.ticket.spec.fingerprint,
        error,
      );
      await this.persist({
        publicationId,
        status: "reconcile_required",
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding: null,
        issue: issueReferenceBestEffort(published.issue),
        pendingAction,
        backlink: null,
        error,
      });
      this.trace("reconcile_required", publicationId);
      return {
        ok: false,
        status: "reconcile_required",
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        pendingAction,
        issue: published.issue,
      };
    }

    let binding: ExternalWorkItemBindingV1;
    try {
      const issueUpdatedAt = requireIssueUpdatedAt(published.issue);
      const verifiedAt = this.isoNowAtLeast(
        latestLineageEvent(lineage).occurredAt,
        issueUpdatedAt,
      );
      binding = createExternalWorkItemBindingV1({
        schemaVersion: 1,
        bindingId: `linear-${artifact.artifactId}`,
        provider: "linear",
        originRunId: artifact.originRunId,
        workspaceId: request.destination.workspaceId,
        teamId: published.issue.team.id,
        issueId: published.issue.id,
        issueIdentifier: published.issue.identifier,
        issueUrl: published.issue.url,
        issueUpdatedAt,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
        verifiedAt,
      });
      lineage = appendWorkItemLineageTransitionV1(lineage, {
        state: "linear_verified",
        occurredAt: verifiedAt,
        receiptId: published.status === "created"
          ? published.receipt.id
          : `linear-readback-${published.issue.id}`,
        evidenceFingerprint: binding.bindingFingerprint,
        externalWorkItemBindingFingerprint: binding.bindingFingerprint,
      });
    } catch (cause) {
      const error = normalizeError(cause, "research_publication_binding_invalid");
      const pendingAction = pendingFromSuccess(
        published,
        preview.ticket.spec.fingerprint,
        error,
      );
      await this.persist({
        publicationId,
        status: "reconcile_required",
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding: null,
        issue: issueReferenceBestEffort(published.issue),
        pendingAction,
        backlink: null,
        error,
      });
      this.trace("reconcile_required", publicationId);
      return {
        ok: false,
        status: "reconcile_required",
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        pendingAction,
        issue: published.issue,
      };
    }
    this.trace("linear_publish_verified", publicationId, {
      publication: published.status,
      issueIdentifier: published.issue.identifier,
    });
    await this.persist({
      publicationId,
      status: "linear_verified",
      artifact,
      lineage,
      workItemFingerprint: preview.ticket.spec.fingerprint,
      approvalFingerprint: approvalRequest.approvalFingerprint,
      binding,
      issue: issueReference(published.issue),
      pendingAction: null,
      backlink: null,
      error: null,
    });
    this.trace("linear_lineage_persisted", publicationId);

    this.trace("backlink_started", publicationId);
    let backlink: ResearchNoteBacklinkResultV1;
    try {
      backlink = await this.options.noteWriter.appendLinearBacklink({
        artifact,
        expectedNoteSha256: note.afterSha256,
        issueIdentifier: published.issue.identifier,
        issueUrl: published.issue.url,
      });
    } catch (cause) {
      const error = normalizeError(cause, "research_publication_backlink_waiting_obsidian");
      await this.persist({
        publicationId,
        status: "waiting_obsidian",
        artifact,
        lineage,
        workItemFingerprint: preview.ticket.spec.fingerprint,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding,
        issue: issueReference(published.issue),
        pendingAction: null,
        backlink: null,
        error,
      });
      this.trace("waiting_obsidian", publicationId, { issueIdentifier: published.issue.identifier });
      return {
        ok: false,
        status: "waiting_obsidian",
        error,
        note,
        artifact,
        lineage,
        approvalFingerprint: approvalRequest.approvalFingerprint,
        binding,
        issue: published.issue,
        receipt: published.status === "created" ? published.receipt : null,
      };
    }
    this.trace("backlink_verified", publicationId, { noteSha256: backlink.afterSha256 });
    await this.persist({
      publicationId,
      status: "complete",
      artifact,
      lineage,
      workItemFingerprint: preview.ticket.spec.fingerprint,
      approvalFingerprint: approvalRequest.approvalFingerprint,
      binding,
      issue: issueReference(published.issue),
      pendingAction: null,
      backlink,
      error: null,
    });
    this.trace("complete", publicationId);
    return {
      ok: true,
      status: "complete",
      publication: published.status,
      note,
      artifact,
      lineage,
      approvalFingerprint: approvalRequest.approvalFingerprint,
      binding,
      issue: published.issue,
      backlink,
      receipt: published.status === "created" ? published.receipt : null,
    };
  }

  private async persist(
    value: Omit<ResearchPublicationCheckpointV1, "schemaVersion" | "updatedAt">,
  ): Promise<void> {
    await this.options.lineage.persist({
      schemaVersion: RESEARCH_PUBLICATION_CHECKPOINT_SCHEMA_VERSION,
      ...value,
      updatedAt: this.isoNowAtLeast(value.artifact.acceptedAt),
    });
  }

  private trace(
    stage: ResearchPublicationTraceStageV1,
    publicationId: string,
    details?: ResearchPublicationTraceEventV1["details"],
  ): void {
    if (!this.options.trace) return;
    this.options.trace({
      stage,
      at: this.isoNowAtLeast(),
      publicationId,
      ...(details ? { details } : {}),
    });
  }

  private isoNowAtLeast(...minimums: string[]): string {
    const now = this.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Research publication clock returned an invalid date.");
    }
    const minimum = minimums.reduce(
      (latest, value) => Math.max(latest, Date.parse(value)),
      Number.NEGATIVE_INFINITY,
    );
    return new Date(Math.max(now.getTime(), minimum)).toISOString();
  }
}

function validateHostIntent(request: ResearchPublicationRequestV1): void {
  if (request.explicitUserMission !== true) {
    throw new ResearchPublicationWorkflowError(
      "research_publication_explicit_user_mission_required",
      "Research may be published to Linear only from an explicit user mission.",
    );
  }
  if (!request.runId.trim() || !request.toolCallId.trim()) {
    throw new ResearchPublicationWorkflowError(
      "research_publication_identity_required",
      "Research publication requires run and tool-call identities.",
    );
  }
  if (request.note.package.originRunId !== request.runId) {
    throw new ResearchPublicationWorkflowError(
      "research_publication_origin_mismatch",
      "The accepted research package belongs to a different run.",
    );
  }
  if (
    (request.context.runId !== undefined && request.context.runId !== request.runId) ||
    (request.context.operationId !== undefined &&
      request.context.operationId !== request.toolCallId)
  ) {
    throw new ResearchPublicationWorkflowError(
      "research_publication_context_mismatch",
      "The research publication context belongs to a different operation.",
    );
  }
  for (const [label, value] of Object.entries(request.destination)) {
    if (
      typeof value !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value) ||
      value === "__proto__" ||
      value === "prototype" ||
      value === "constructor"
    ) {
      throw new ResearchPublicationWorkflowError(
        "research_publication_invalid_destination",
        `Linear ${label} is invalid.`,
      );
    }
  }
}

function sectionsFromAcceptedNote(
  note: AcceptedResearchNoteWriteRequestV1,
): SynthesizedResearchTicketSectionsV1 {
  const value = note.package;
  return {
    contentKind: "synthesized",
    title: value.title,
    problemImpact: value.problemImpact,
    confidenceLimitations: value.confidenceLimitations,
    proposedWork: [...value.proposedWork],
    nonGoals: [...value.nonGoals],
    scope: [...value.scope],
    dependencies: [...value.dependencies],
  };
}

function draftFromAcceptedArtifact(
  request: ResearchPublicationRequestV1,
  artifact: AcceptedResearchArtifactV1,
): ResearchTicketWorkItemDraftV2 {
  const value = request.note.package;
  const executionBinding = value.executionClass === "code"
    ? { repositoryKey: value.repositoryKey }
    : value.executionClass === "vault"
      ? { vaultBindingKey: value.vaultBindingKey }
      : {};
  return {
    schemaVersion: 2,
    ready: true,
    executionClass: value.executionClass,
    objective: value.objective,
    ...executionBinding,
    acceptanceCriteria: value.acceptanceCriteria.map((criterion) => ({ ...criterion })),
    validationRequirementKeys: [...value.validationRequirementKeys],
    evidenceRefs: artifact.evidence.map((evidence) =>
      evidence.kind === "web" ? evidence.reference : `research:${evidence.id}`),
    riskClass: value.riskClass,
    originRunId: artifact.originRunId,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    ...(request.parentIssueId ? { parentIssueId: request.parentIssueId } : {}),
    generation: request.generation ?? 0,
  };
}

function createNoteVerifiedLineage(
  request: ResearchPublicationRequestV1,
  artifact: AcceptedResearchArtifactV1,
  ticket: BuiltResearchTicket,
): WorkItemLineageV1 {
  const package_ = request.note.package;
  const acceptedEvent: WorkItemLineageEventV1 = {
    sequence: 1,
    state: "accepted_research",
    domain: "research",
    occurredAt: artifact.acceptedAt,
    receiptId: `accepted-${artifact.artifactId}`,
    evidenceFingerprint: artifact.artifactFingerprint,
  };
  const binding = package_.executionClass === "code"
    ? { repositoryKey: package_.repositoryKey }
    : package_.executionClass === "vault"
      ? { vaultBindingKey: package_.vaultBindingKey }
      : {};
  const accepted = createWorkItemLineageV1({
    schemaVersion: 1,
    lineageId: `publication-${artifact.artifactId}`,
    originRunId: artifact.originRunId,
    executionClass: package_.executionClass,
    workItemFingerprint: ticket.spec.fingerprint,
    researchArtifactFingerprint: artifact.artifactFingerprint,
    ...binding,
    events: [acceptedEvent],
  });
  return appendWorkItemLineageTransitionV1(accepted, {
    state: "note_verified",
    occurredAt: artifact.acceptedAt,
    receiptId: artifact.noteReceiptId,
    evidenceFingerprint: artifact.noteSha256,
  });
}

async function buildExactApprovalRequest(
  request: ResearchPublicationRequestV1,
  artifact: AcceptedResearchArtifactV1,
  preview: Extract<ResearchTicketPreviewResult, { ok: true }>,
): Promise<ResearchPublicationExactApprovalRequestV1> {
  const duplicate = preview.duplicate ? issueReference(preview.duplicate) : null;
  const exact = {
    schemaVersion: 1 as const,
    kind: "linear_research_publication" as const,
    runId: request.runId,
    toolCallId: request.toolCallId,
    destination: { ...request.destination },
    artifactFingerprint: artifact.artifactFingerprint,
    noteSha256: artifact.noteSha256,
    workItemFingerprint: preview.ticket.spec.fingerprint,
    title: preview.ticket.title,
    description: preview.ticket.description,
    proposedAction: preview.status === "deduplicated"
      ? "reuse_duplicate" as const
      : "create" as const,
    duplicate,
    candidatesExamined: preview.candidatesExamined,
  };
  return {
    ...exact,
    approvalFingerprint: await sha256LinearValue(exact),
  };
}

function issueDestinationMismatch(
  issue: LinearIssueRecord,
  destination: ResearchPublicationDestinationV1,
): string | null {
  if (issue.team.id !== destination.teamId) {
    return "Linear issue readback is outside the approved team.";
  }
  if (issue.project?.id !== destination.projectId) {
    return "Linear issue readback is outside the approved project.";
  }
  return null;
}

function publicationDrift(
  preview: BuiltResearchTicket,
  published: BuiltResearchTicket,
): string | null {
  if (
    preview.spec.fingerprint !== published.spec.fingerprint ||
    preview.title !== published.title ||
    preview.description !== published.description
  ) {
    return "The Linear publication changed after exact approval.";
  }
  return null;
}

function requireIssueUpdatedAt(issue: LinearIssueRecord): string {
  if (typeof issue.updatedAt !== "string" || !Number.isFinite(Date.parse(issue.updatedAt))) {
    throw new ResearchPublicationWorkflowError(
      "research_publication_issue_updated_at_required",
      "Verified Linear issue readback did not include an update timestamp.",
    );
  }
  return issue.updatedAt;
}

function issueReference(issue: LinearIssueRecord): ResearchPublicationIssueReferenceV1 {
  return {
    id: issue.id,
    identifier: issue.identifier,
    url: issue.url,
    updatedAt: requireIssueUpdatedAt(issue),
    snapshotHash: issue.snapshotHash,
  };
}

function issueReferenceBestEffort(
  issue: LinearIssueRecord,
): ResearchPublicationIssueReferenceV1 | null {
  try {
    return issueReference(issue);
  } catch {
    return null;
  }
}

function pendingFromFailure(
  result: Extract<ResearchTicketPublishResult, { ok: false }>,
  workItemFingerprint: string,
  error: ResearchPublicationErrorV1,
): ResearchPublicationPendingActionV1 {
  return {
    provider: "linear",
    operation: "publish_research_ticket",
    actionId: result.action?.id ?? null,
    issueId: result.action?.target.id ?? null,
    grantId: result.grantId ?? null,
    workItemFingerprint,
    error,
  };
}

function pendingFromSuccess(
  result: Extract<ResearchTicketPublishResult, { ok: true }>,
  workItemFingerprint: string,
  error: ResearchPublicationErrorV1,
): ResearchPublicationPendingActionV1 {
  return {
    provider: "linear",
    operation: "publish_research_ticket",
    actionId: result.status === "created" ? result.action.id : null,
    issueId: result.issue.id,
    grantId: result.status === "created" ? result.grantId : null,
    workItemFingerprint,
    error,
  };
}

function latestLineageEvent(lineage: WorkItemLineageV1): WorkItemLineageEventV1 {
  const event = lineage.events[lineage.events.length - 1];
  if (!event) throw new Error("Research publication lineage has no events.");
  return event;
}

function normalizeError(
  value: unknown,
  fallbackCode: string,
): ResearchPublicationErrorV1 {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const message = typeof record.message === "string" ? record.message : String(value);
    return {
      code: typeof record.code === "string" && record.code.trim()
        ? record.code
        : fallbackCode,
      message,
    };
  }
  return {
    code: fallbackCode,
    message: value instanceof Error ? value.message : String(value),
  };
}

export class ResearchPublicationWorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ResearchPublicationWorkflowError";
  }
}
