import type { ActionReceipt, PreparedAction } from "../../agent/actions";
import type { AuthorityGrantV1 } from "../../agent/authority";
import type { ToolExecutionContext } from "../../tools/types";
import type {
  HostLinearActionExecution,
  HostLinearActionExecutor,
  LinearAuthoritySubject,
} from "./HostLinearActionExecutor";
import type { LinearToolClient } from "./LinearTools";
import { parseRenderedCompatibleWorkItemSpec } from "./WorkItemParser";
import {
  renderCompatibleWorkItemSpec,
  type WorkItemRenderDetailsV1,
} from "./WorkItemRenderer";
import {
  createWorkItemSpecV1,
  parseWorkItemSpecV1,
  type WorkItemSpecV1,
  type WorkItemSpecV1Unsigned,
} from "./WorkItemSpecV1";
import {
  createWorkItemSpecV2,
  parseCompatibleWorkItemSpec,
  type ParsedCompatibleWorkItemSpec,
  type WorkItemSpecV2,
  type WorkItemSpecV2Unsigned,
} from "./WorkItemSpecV2";
import {
  LinearClientError,
  type LinearIssueRecord,
  type LinearOperationResult,
  type LinearPage,
} from "./types";

const DEFAULT_DUPLICATE_CANDIDATE_LIMIT = 10;
const MAX_DUPLICATE_CANDIDATE_LIMIT = 10;
const MAX_TITLE_CHARS = 240;
const MAX_SECTION_CHARS = 4_000;
const MAX_LIST_ENTRIES = 20;
const MAX_LIST_ENTRY_CHARS = 1_000;
const MAX_RENDERED_DESCRIPTION_CHARS = 18_000;
const IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;

/**
 * Only accepted, synthesized research output crosses this boundary. There is
 * intentionally no generic note/content/payload property through which raw
 * vault material can be forwarded to Linear.
 */
export interface SynthesizedResearchTicketSectionsV1 {
  contentKind: "synthesized";
  title: string;
  problemImpact: string;
  confidenceLimitations: string;
  proposedWork: string[];
  nonGoals: string[];
  scope: string[];
  dependencies: string[];
}

/** A caller-supplied fingerprint is accepted only so it can be discarded. */
export type ResearchTicketWorkItemDraftV1 = WorkItemSpecV1Unsigned & {
  fingerprint?: unknown;
};

export type ResearchTicketWorkItemDraftV2 = WorkItemSpecV2Unsigned & {
  fingerprint?: unknown;
};

export type ResearchTicketWorkItemDraft =
  | ResearchTicketWorkItemDraftV1
  | ResearchTicketWorkItemDraftV2;

export interface BuiltResearchTicketV1 {
  spec: WorkItemSpecV1;
  title: string;
  description: string;
  deterministicIssueId: string;
}

export interface BuiltResearchTicketV2 {
  spec: WorkItemSpecV2;
  title: string;
  description: string;
  deterministicIssueId: string;
}

export type BuiltResearchTicket = BuiltResearchTicketV1 | BuiltResearchTicketV2;

export interface ResearchTicketPublishRequest {
  runId: string;
  toolCallId: string;
  subject: LinearAuthoritySubject;
  context: ToolExecutionContext;
  sections: SynthesizedResearchTicketSectionsV1;
  draft: ResearchTicketWorkItemDraft;
  /** Exact duplicate/create decision approved before this fresh provider read. */
  approvedPreview: ResearchTicketApprovedPreviewV1;
  activeGrants?: readonly AuthorityGrantV1[];
  preferredGrantId?: string;
}

export interface ResearchTicketApprovedPreviewV1 {
  status: "create" | "deduplicated";
  workItemFingerprint: string;
  duplicateId: string | null;
  duplicateSnapshotHash: string | null;
}

export interface ResearchTicketPreviewRequest {
  context: ToolExecutionContext;
  sections: SynthesizedResearchTicketSectionsV1;
  draft: ResearchTicketWorkItemDraft;
}

export type ResearchTicketPreviewResult =
  | {
      ok: true;
      status: "create" | "deduplicated";
      ticket: BuiltResearchTicket;
      duplicate: LinearIssueRecord | null;
      candidatesExamined: number;
    }
  | {
      ok: false;
      status: "rejected";
      error: { code: string; message: string; details?: Record<string, unknown> };
      ticket?: BuiltResearchTicket;
      candidatesExamined: number;
    };

export interface ResearchTicketPublisherOptions {
  readClient: LinearToolClient;
  /** Must be the host-owned executor; workers never receive this object. */
  actionExecutor: Pick<
    HostLinearActionExecutor,
    "prepare" | "executePrepared"
  >;
  queueTeamId: string;
  queueProjectId: string;
  duplicateCandidateLimit?: number;
}

export type ResearchTicketPublishResult =
  | {
      ok: true;
      status: "deduplicated";
      ticket: BuiltResearchTicket;
      issue: LinearIssueRecord;
      candidatesExamined: number;
    }
  | {
      ok: true;
      status: "created";
      ticket: BuiltResearchTicket;
      issue: LinearIssueRecord;
      action: PreparedAction;
      receipt: ActionReceipt;
      grantId: string;
      candidatesExamined: number;
    }
  | {
      ok: false;
      status: "rejected" | "not_applied" | "reconcile_required";
      error: {
        code: string;
        message: string;
        details?: Record<string, unknown>;
      };
      ticket?: BuiltResearchTicket;
      action?: PreparedAction;
      grantId?: string;
      candidatesExamined: number;
    };

interface DuplicateSearchResult {
  issue: LinearIssueRecord | null;
  candidatesExamined: number;
}

/**
 * Host-side bridge from accepted research output to one executable Linear
 * issue. It has no generic GraphQL or raw-vault-content escape hatch.
 */
export class ResearchTicketPublisher {
  private readonly queueTeamId: string;
  private readonly queueProjectId: string;
  private readonly duplicateCandidateLimit: number;

  constructor(private readonly options: ResearchTicketPublisherOptions) {
    this.queueTeamId = requireIdentifier(options.queueTeamId, "queue team ID");
    this.queueProjectId = requireIdentifier(
      options.queueProjectId,
      "queue project ID",
    );
    this.duplicateCandidateLimit = normalizeDuplicateCandidateLimit(
      options.duplicateCandidateLimit,
    );
  }

  build(
    sections: SynthesizedResearchTicketSectionsV1,
    draft: ResearchTicketWorkItemDraftV1,
  ): BuiltResearchTicketV1;
  build(
    sections: SynthesizedResearchTicketSectionsV1,
    draft: ResearchTicketWorkItemDraftV2,
  ): BuiltResearchTicketV2;
  build(
    sections: SynthesizedResearchTicketSectionsV1,
    draft: ResearchTicketWorkItemDraft,
  ): BuiltResearchTicket;
  build(
    sections: SynthesizedResearchTicketSectionsV1,
    draft: ResearchTicketWorkItemDraft,
  ): BuiltResearchTicket {
    const normalizedSections = normalizeSections(sections);
    const spec = createSpecWithoutTrustingFingerprint(draft);
    const renderDetails: WorkItemRenderDetailsV1 = {
      problemImpact: normalizedSections.problemImpact,
      confidenceLimitations: normalizedSections.confidenceLimitations,
      proposedWork: normalizedSections.proposedWork,
      nonGoals: normalizedSections.nonGoals,
      scope: normalizedSections.scope,
      dependencies: normalizedSections.dependencies,
    };
    const description = renderCompatibleWorkItemSpec(spec, renderDetails);
    if (description.length > MAX_RENDERED_DESCRIPTION_CHARS) {
      throw new ResearchTicketPublisherError(
        "research_ticket_description_too_large",
        `Rendered research ticket exceeds ${MAX_RENDERED_DESCRIPTION_CHARS} characters.`,
      );
    }
    // Validate the exact serialized contract before it can reach an adapter.
    const parsed = parseRenderedCompatibleWorkItemSpec(description);
    if (parsed.spec.fingerprint !== spec.fingerprint) {
      throw new ResearchTicketPublisherError(
        "research_ticket_contract_mismatch",
        "Rendered research ticket changed its machine-contract fingerprint.",
      );
    }
    const parsedSpec = parseCompatibleWorkItemSpec(parsed.spec);
    const built = {
      title: normalizedSections.title,
      description,
      deterministicIssueId: deterministicIssueUuid(spec.fingerprint),
    };
    return parsedSpec.schemaVersion === 1
      ? { ...built, spec: parsedSpec }
      : { ...built, spec: parsedSpec };
  }

  /**
   * Builds the exact outbound description and completes bounded duplicate
   * search without preparing or dispatching any Linear mutation. The host can
   * therefore show this preview before requesting exact approval.
   */
  async preview(
    request: ResearchTicketPreviewRequest,
  ): Promise<ResearchTicketPreviewResult> {
    let ticket: BuiltResearchTicket;
    try {
      ticket = this.build(request.sections, request.draft);
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: publisherError(error, "research_ticket_invalid"),
        candidatesExamined: 0,
      };
    }
    try {
      const duplicate = await this.findDuplicate(ticket.spec, request.context);
      return {
        ok: true,
        status: duplicate.issue ? "deduplicated" : "create",
        ticket,
        duplicate: duplicate.issue,
        candidatesExamined: duplicate.candidatesExamined,
      };
    } catch (error) {
      return {
        ok: false,
        status: "rejected",
        error: publisherError(error, "research_ticket_duplicate_search_failed"),
        ticket,
        candidatesExamined: 0,
      };
    }
  }

  async publish(
    request: ResearchTicketPublishRequest,
  ): Promise<ResearchTicketPublishResult> {
    const identity = validatePublishIdentity(request);
    if (!identity.ok) {
      return {
        ok: false,
        status: "rejected",
        error: identity.error,
        candidatesExamined: 0,
      };
    }

    const preview = await this.preview(request);
    if (!preview.ok) return preview;
    const approvedPreviewMismatch = compareApprovedPreview(
      request.approvedPreview,
      preview,
    );
    if (approvedPreviewMismatch) {
      return {
        ok: false,
        status: "rejected",
        error: {
          code: "research_ticket_approved_preview_changed",
          message: approvedPreviewMismatch,
        },
        ticket: preview.ticket,
        candidatesExamined: preview.candidatesExamined,
      };
    }
    const { ticket } = preview;
    if (preview.duplicate) {
      return {
        ok: true,
        status: "deduplicated",
        ticket,
        issue: preview.duplicate,
        candidatesExamined: preview.candidatesExamined,
      };
    }

    const prepared = await this.options.actionExecutor.prepare({
      toolName: "linear_create_issue",
      arguments: {
        id: ticket.deterministicIssueId,
        teamId: this.queueTeamId,
        projectId: this.queueProjectId,
        title: ticket.title,
        description: ticket.description,
      },
      runId: identity.runId,
      toolCallId: identity.toolCallId,
      context: request.context,
    });
    if (!prepared.ok) {
      return {
        ok: false,
        status: "rejected",
        error: prepared.error,
        ticket,
        candidatesExamined: preview.candidatesExamined,
      };
    }

    const execution = await this.options.actionExecutor.executePrepared({
      action: prepared.action,
      runId: identity.runId,
      toolCallId: identity.toolCallId,
      context: request.context,
      subject: request.subject,
      activeGrants: request.activeGrants,
      preferredGrantId: request.preferredGrantId,
    });
    if (!execution.ok) {
      return executionFailure(execution, ticket, preview.candidatesExamined);
    }

    // The adapter's mutation readback proves its field-level postcondition. A
    // separate fixed read then proves the embedded ticket contract and pinned
    // queue project before publication is reported as successful.
    let readback: LinearIssueRecord;
    try {
      readback = await this.readIssue(execution.action.target.id, request.context);
    } catch (error) {
      return {
        ok: false,
        status: "reconcile_required",
        error: publisherError(error, "research_ticket_readback_failed"),
        ticket,
        action: execution.action,
        grantId: execution.grantId,
        candidatesExamined: preview.candidatesExamined,
      };
    }
    const mismatch = ticketReadbackMismatch(
      readback,
      ticket.spec,
      this.queueProjectId,
    );
    if (mismatch) {
      return {
        ok: false,
        status: "reconcile_required",
        error: {
          code: "research_ticket_readback_mismatch",
          message: mismatch,
        },
        ticket,
        action: execution.action,
        grantId: execution.grantId,
        candidatesExamined: preview.candidatesExamined,
      };
    }

    return {
      ok: true,
      status: "created",
      ticket,
      issue: readback,
      action: execution.action,
      receipt: execution.receipt,
      grantId: execution.grantId,
      candidatesExamined: preview.candidatesExamined,
    };
  }

  private async findDuplicate(
    spec: ParsedCompatibleWorkItemSpec,
    context: ToolExecutionContext,
  ): Promise<DuplicateSearchResult> {
    const candidates = new Map<string, LinearIssueRecord>();
    // Search both the signed contract fingerprint and the trusted origin run
    // identifier. Exact deduplication is still decided by the parsed signed
    // contract, never by search ranking or title similarity.
    for (const query of uniqueStrings([spec.fingerprint, spec.originRunId])) {
      const remaining = this.duplicateCandidateLimit - candidates.size;
      if (remaining <= 0) break;
      const result = await this.options.readClient.execute(
        "issues.search",
        {
          query,
          filter: { project: { id: { eq: this.queueProjectId } } },
          first: remaining,
          includeArchived: false,
        },
        requestOptions(context),
      );
      const page = expectIssuePage(result, "duplicate search");
      for (const issue of page.items) {
        if (candidates.size >= this.duplicateCandidateLimit) break;
        // Never follow or read a candidate returned outside the pinned queue.
        if (issue.project?.id !== this.queueProjectId) continue;
        candidates.set(issue.id, issue);
      }
    }

    for (const candidate of candidates.values()) {
      if (!hasExactContractFingerprint(candidate, spec.fingerprint)) continue;
      let readback: LinearIssueRecord;
      try {
        readback = await this.readIssue(candidate.id, context);
      } catch (error) {
        if (error instanceof LinearClientError && error.code === "linear_not_found") {
          continue;
        }
        throw error;
      }
      if (!ticketReadbackMismatch(readback, spec, this.queueProjectId)) {
        return { issue: readback, candidatesExamined: candidates.size };
      }
    }
    return { issue: null, candidatesExamined: candidates.size };
  }

  private async readIssue(
    id: string,
    context: ToolExecutionContext,
  ): Promise<LinearIssueRecord> {
    const result = await this.options.readClient.execute(
      "issues.get",
      { id },
      requestOptions(context),
    );
    if (!isLinearIssueRecord(result)) {
      throw new ResearchTicketPublisherError(
        "research_ticket_invalid_readback",
        "Linear issue readback returned an unexpected resource.",
      );
    }
    return result;
  }
}

function compareApprovedPreview(
  approved: ResearchTicketApprovedPreviewV1,
  current: Extract<ResearchTicketPreviewResult, { ok: true }>,
): string | null {
  const duplicateId = current.duplicate?.id ?? null;
  const duplicateSnapshotHash = current.duplicate?.snapshotHash ?? null;
  if (
    approved.status !== current.status ||
    approved.workItemFingerprint !== current.ticket.spec.fingerprint ||
    approved.duplicateId !== duplicateId ||
    approved.duplicateSnapshotHash !== duplicateSnapshotHash
  ) {
    return "The Linear create/deduplicate decision changed after exact approval; prepare and approve a fresh preview.";
  }
  return null;
}

export class ResearchTicketPublisherError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ResearchTicketPublisherError";
  }
}

function createSpecWithoutTrustingFingerprint(
  value: ResearchTicketWorkItemDraft,
): ParsedCompatibleWorkItemSpec {
  const record = expectPlainRecord(value, "work item draft");
  if (record.schemaVersion === 2) {
    return createSpecV2WithoutTrustingFingerprint(record);
  }
  assertAllowedKeys(
    record,
    [
      "schemaVersion",
      "ready",
      "executionClass",
      "objective",
      "repositoryKey",
      "acceptanceCriteria",
      "validationRequirements",
      "evidenceRefs",
      "riskClass",
      "originRunId",
      "parentIssueId",
      "generation",
      "fingerprint",
    ],
    "work item draft",
  );
  const unsigned: WorkItemSpecV1Unsigned = {
    schemaVersion: record.schemaVersion as WorkItemSpecV1Unsigned["schemaVersion"],
    ready: record.ready as WorkItemSpecV1Unsigned["ready"],
    executionClass:
      record.executionClass as WorkItemSpecV1Unsigned["executionClass"],
    objective: record.objective as string,
    acceptanceCriteria:
      record.acceptanceCriteria as WorkItemSpecV1Unsigned["acceptanceCriteria"],
    validationRequirements: record.validationRequirements as string[],
    evidenceRefs: record.evidenceRefs as string[],
    riskClass: record.riskClass as WorkItemSpecV1Unsigned["riskClass"],
    originRunId: record.originRunId as string,
    generation: record.generation as number,
    ...(Object.prototype.hasOwnProperty.call(record, "repositoryKey")
      ? { repositoryKey: record.repositoryKey as string }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "parentIssueId")
      ? { parentIssueId: record.parentIssueId as string }
      : {}),
  };
  return createWorkItemSpecV1(unsigned);
}

function createSpecV2WithoutTrustingFingerprint(
  record: Record<string, unknown>,
): WorkItemSpecV2 {
  assertAllowedKeys(
    record,
    [
      "schemaVersion",
      "ready",
      "executionClass",
      "objective",
      "repositoryKey",
      "vaultBindingKey",
      "acceptanceCriteria",
      "validationRequirementKeys",
      "evidenceRefs",
      "riskClass",
      "originRunId",
      "acceptedResearchArtifactFingerprint",
      "parentIssueId",
      "generation",
      "fingerprint",
    ],
    "work item v2 draft",
  );
  const unsigned: WorkItemSpecV2Unsigned = {
    schemaVersion: record.schemaVersion as WorkItemSpecV2Unsigned["schemaVersion"],
    ready: record.ready as WorkItemSpecV2Unsigned["ready"],
    executionClass: record.executionClass as WorkItemSpecV2Unsigned["executionClass"],
    objective: record.objective as string,
    acceptanceCriteria:
      record.acceptanceCriteria as WorkItemSpecV2Unsigned["acceptanceCriteria"],
    validationRequirementKeys: record.validationRequirementKeys as string[],
    evidenceRefs: record.evidenceRefs as string[],
    riskClass: record.riskClass as WorkItemSpecV2Unsigned["riskClass"],
    originRunId: record.originRunId as string,
    acceptedResearchArtifactFingerprint:
      record.acceptedResearchArtifactFingerprint as string,
    generation: record.generation as number,
    ...(Object.prototype.hasOwnProperty.call(record, "repositoryKey")
      ? { repositoryKey: record.repositoryKey as string }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "vaultBindingKey")
      ? { vaultBindingKey: record.vaultBindingKey as string }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(record, "parentIssueId")
      ? { parentIssueId: record.parentIssueId as string }
      : {}),
  };
  return createWorkItemSpecV2(unsigned);
}

function normalizeSections(
  value: SynthesizedResearchTicketSectionsV1,
): SynthesizedResearchTicketSectionsV1 {
  const record = expectPlainRecord(value, "research ticket sections");
  assertAllowedKeys(
    record,
    [
      "contentKind",
      "title",
      "problemImpact",
      "confidenceLimitations",
      "proposedWork",
      "nonGoals",
      "scope",
      "dependencies",
    ],
    "research ticket sections",
  );
  if (record.contentKind !== "synthesized") {
    throw new ResearchTicketPublisherError(
      "research_ticket_synthesized_content_required",
      "Research tickets accept synthesized content only.",
    );
  }
  return {
    contentKind: "synthesized",
    title: boundedText(record.title, "title", MAX_TITLE_CHARS),
    problemImpact: boundedText(
      record.problemImpact,
      "problem / impact",
      MAX_SECTION_CHARS,
    ),
    confidenceLimitations: boundedText(
      record.confidenceLimitations,
      "confidence / limitations",
      MAX_SECTION_CHARS,
    ),
    proposedWork: boundedTextList(record.proposedWork, "proposed work", 1),
    nonGoals: boundedTextList(record.nonGoals, "non-goal", 0),
    scope: boundedTextList(record.scope, "scope", 1),
    dependencies: boundedTextList(record.dependencies, "dependency", 0),
  };
}

function boundedTextList(
  value: unknown,
  label: string,
  minimum: number,
): string[] {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_LIST_ENTRIES
  ) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_sections",
      `${label} must contain ${minimum}-${MAX_LIST_ENTRIES} synthesized entries.`,
    );
  }
  return value.map((entry, index) =>
    boundedText(entry, `${label} ${index + 1}`, MAX_LIST_ENTRY_CHARS),
  );
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_sections",
      `${label} must be synthesized text.`,
    );
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximum) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_sections",
      `${label} must contain 1-${maximum} characters.`,
    );
  }
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(normalized)) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_sections",
      `${label} contains unsupported control characters.`,
    );
  }
  return normalized;
}

function validatePublishIdentity(
  value: ResearchTicketPublishRequest,
):
  | { ok: true; runId: string; toolCallId: string }
  | {
      ok: false;
      error: { code: string; message: string };
    } {
  const runId = typeof value.runId === "string" ? value.runId.trim() : "";
  const toolCallId =
    typeof value.toolCallId === "string" ? value.toolCallId.trim() : "";
  if (!runId || !toolCallId) {
    return {
      ok: false,
      error: {
        code: "research_ticket_execution_identity_required",
        message: "Research ticket publication requires explicit run and tool-call IDs.",
      },
    };
  }
  if (
    (value.context.runId !== undefined && value.context.runId !== runId) ||
    (value.context.operationId !== undefined &&
      value.context.operationId !== toolCallId)
  ) {
    return {
      ok: false,
      error: {
        code: "research_ticket_execution_identity_mismatch",
        message: "Research ticket execution context has a different identity.",
      },
    };
  }
  if (
    !value.subject ||
    typeof value.subject.type !== "string" ||
    typeof value.subject.id !== "string" ||
    !value.subject.id.trim()
  ) {
    return {
      ok: false,
      error: {
        code: "research_ticket_authority_subject_required",
        message: "Research ticket publication requires an explicit authority subject.",
      },
    };
  }
  return { ok: true, runId, toolCallId };
}

function deterministicIssueUuid(fingerprint: string): string {
  const hex = fingerprint.slice("sha256:".length, "sha256:".length + 32);
  if (!/^[a-f0-9]{32}$/.test(hex)) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_fingerprint",
      "Research ticket fingerprint cannot produce a deterministic issue ID.",
    );
  }
  const variant = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `5${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function ticketReadbackMismatch(
  issue: LinearIssueRecord,
  expected: ParsedCompatibleWorkItemSpec,
  queueProjectId: string,
): string | null {
  if (issue.project?.id !== queueProjectId) {
    return "Linear issue readback is outside the pinned queue project.";
  }
  if (typeof issue.description !== "string") {
    return "Linear issue readback does not contain the rendered ticket contract.";
  }
  try {
    const parsed = parseRenderedCompatibleWorkItemSpec(issue.description);
    if (parsed.spec.fingerprint !== expected.fingerprint) {
      return "Linear issue readback contains a different contract fingerprint.";
    }
    if (parsed.spec.originRunId !== expected.originRunId) {
      return "Linear issue readback contains a different origin run.";
    }
  } catch {
    return "Linear issue readback contains an invalid ticket contract.";
  }
  return null;
}

function hasExactContractFingerprint(
  issue: LinearIssueRecord,
  fingerprint: string,
): boolean {
  if (typeof issue.description !== "string") return false;
  try {
    return (
      parseRenderedCompatibleWorkItemSpec(issue.description).spec.fingerprint === fingerprint
    );
  } catch {
    return false;
  }
}

function expectIssuePage(
  value: LinearOperationResult,
  label: string,
): LinearPage<LinearIssueRecord> {
  if (
    !isPlainRecord(value) ||
    !Array.isArray(value.items) ||
    !isPlainRecord(value.pageInfo) ||
    typeof value.fetchedAt !== "string" ||
    !value.items.every(isLinearIssueRecord)
  ) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_search_response",
      `Linear ${label} returned an unexpected response.`,
    );
  }
  return value as unknown as LinearPage<LinearIssueRecord>;
}

function isLinearIssueRecord(value: unknown): value is LinearIssueRecord {
  return (
    isPlainRecord(value) &&
    value.resourceType === "issue" &&
    typeof value.id === "string" &&
    typeof value.identifier === "string" &&
    typeof value.title === "string" &&
    typeof value.url === "string" &&
    isPlainRecord(value.team) &&
    isPlainRecord(value.state) &&
    Array.isArray(value.labels) &&
    typeof value.snapshotHash === "string"
  );
}

function executionFailure(
  execution: Extract<HostLinearActionExecution, { ok: false }>,
  ticket: BuiltResearchTicket,
  candidatesExamined: number,
): ResearchTicketPublishResult {
  return {
    ok: false,
    status: execution.status,
    error: execution.error,
    ticket,
    action: execution.action,
    grantId: execution.grantId,
    candidatesExamined,
  };
}

function requestOptions(context: ToolExecutionContext): {
  abortSignal?: AbortSignal;
  deadlineAt?: number;
} {
  return {
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    ...(context.deadlineAt !== undefined
      ? { deadlineAt: context.deadlineAt }
      : {}),
  };
}

function publisherError(
  error: unknown,
  fallbackCode: string,
): { code: string; message: string; details?: Record<string, unknown> } {
  if (error instanceof ResearchTicketPublisherError) {
    return { code: error.code, message: error.message };
  }
  if (error instanceof LinearClientError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details ? { details: { graphqlErrors: error.details } } : {}),
    };
  }
  return {
    code: fallbackCode,
    message: error instanceof Error ? error.message : String(error),
  };
}

function normalizeDuplicateCandidateLimit(value: number | undefined): number {
  const normalized = value ?? DEFAULT_DUPLICATE_CANDIDATE_LIMIT;
  if (
    !Number.isInteger(normalized) ||
    normalized < 1 ||
    normalized > MAX_DUPLICATE_CANDIDATE_LIMIT
  ) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_duplicate_limit",
      `Duplicate candidate limit must be an integer from 1 to ${MAX_DUPLICATE_CANDIDATE_LIMIT}.`,
    );
  }
  return normalized;
}

function requireIdentifier(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (
    !normalized ||
    normalized.length > 256 ||
    !IDENTIFIER_PATTERN.test(normalized) ||
    normalized === "__proto__" ||
    normalized === "prototype" ||
    normalized === "constructor"
  ) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_binding",
      `${label} is invalid.`,
    );
  }
  return normalized;
}

function expectPlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new ResearchTicketPublisherError(
      "research_ticket_invalid_input",
      `${label} must be a plain object.`,
    );
  }
  return value;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertAllowedKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ResearchTicketPublisherError(
      "research_ticket_unknown_field",
      `${label} contains unsupported fields: ${unknown.join(", ")}.`,
    );
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}
