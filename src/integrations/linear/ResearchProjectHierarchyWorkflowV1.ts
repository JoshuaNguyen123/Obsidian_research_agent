import type { ActionReceipt, PreparedAction, ResourceRef } from "../../agent/actions";
import type { AuthorityGrantV1 } from "../../agent/authority";
import type { ToolExecutionContext } from "../../tools/types";
import {
  parseResearchProjectPlanV1,
  type ResearchProjectPlanV1,
} from "../../agent/projectLifecycle";
import type {
  HostLinearActionExecution,
  HostLinearActionExecutor,
  LinearAuthoritySubject,
} from "./HostLinearActionExecutor";
import type { LinearToolClient } from "./LinearTools";
import {
  DurableLinearContractError,
  expectIsoTimestamp,
  expectSha256,
  fingerprintContract,
} from "./LinearContractSupport";
import type { LinearBaseRecord, LinearPage } from "./types";

export const RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_VERSION = 1 as const;
export const PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME =
  "publish_research_project_to_linear" as const;
export const LINEAR_RESEARCH_PROJECT_HIERARCHY_RECEIPT_TOOL_NAME =
  "linear_create_research_project_hierarchy" as const;

export type ResearchProjectHierarchyItemKindV1 =
  | "initiative"
  | "project"
  | "initiative_project_link"
  | "issue"
  | "issue_relation";

export type ResearchProjectHierarchyItemStatusV1 =
  | "deduplicated"
  | "prepared"
  | "committed"
  | "reconcile_required";

export interface ResearchProjectHierarchyCheckpointItemV1 {
  key: string;
  kind: ResearchProjectHierarchyItemKindV1;
  status: ResearchProjectHierarchyItemStatusV1;
  toolCallId: string;
  action: PreparedAction | null;
  resourceId: string;
  readbackFingerprint: string | null;
  receipt: ActionReceipt | null;
}

export interface ResearchProjectHierarchyCheckpointV1 {
  version: typeof RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_VERSION;
  planFingerprint: string;
  status:
    | "prepared"
    | "approval_denied"
    | "approved"
    | "partial"
    | "reconcile_required"
    | "complete";
  approvalFingerprint: string;
  approvalId: string | null;
  grantId: string | null;
  items: ResearchProjectHierarchyCheckpointItemV1[];
  updatedAt: string;
}

export interface ResearchProjectHierarchyCheckpointPortV1 {
  get(planFingerprint: string): Promise<ResearchProjectHierarchyCheckpointV1 | null>;
  persist(checkpoint: ResearchProjectHierarchyCheckpointV1): Promise<void>;
}

export const RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_NAMESPACE_VERSION = 1 as const;
export const RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_LIMIT = 200;

export interface ResearchProjectHierarchyCheckpointNamespaceV1 {
  version: typeof RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_NAMESPACE_VERSION;
  revision: number;
  checkpoints: Record<string, ResearchProjectHierarchyCheckpointV1>;
}

export interface ResearchProjectHierarchyCheckpointPersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: ResearchProjectHierarchyCheckpointNamespaceV1,
    expectedRevision: number,
  ): Promise<void | boolean>;
}

export class ResearchProjectHierarchyCheckpointStoreV1
  implements ResearchProjectHierarchyCheckpointPortV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly persistence: ResearchProjectHierarchyCheckpointPersistenceV1,
  ) {}

  async get(planFingerprint: string): Promise<ResearchProjectHierarchyCheckpointV1 | null> {
    await this.mutationTail;
    const fingerprint = expectSha256(planFingerprint, "research project plan fingerprint");
    const namespace = parseResearchProjectHierarchyCheckpointNamespaceV1(
      await this.persistence.read(),
    );
    return clone(namespace.checkpoints[fingerprint] ?? null);
  }

  async persist(checkpoint: ResearchProjectHierarchyCheckpointV1): Promise<void> {
    const operation = this.mutationTail.then(async () => {
      const normalized = parseResearchProjectHierarchyCheckpointV1(checkpoint);
      const current = parseResearchProjectHierarchyCheckpointNamespaceV1(
        await this.persistence.read(),
      );
      const previous = current.checkpoints[normalized.planFingerprint];
      if (previous) assertCheckpointTransition(previous, normalized);
      if (!previous && Object.keys(current.checkpoints).length >= RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_LIMIT) {
        throw new DurableLinearContractError(
          `Research project hierarchy checkpoint storage is limited to ${RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_LIMIT} entries.`,
        );
      }
      const next: ResearchProjectHierarchyCheckpointNamespaceV1 = {
        version: RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_NAMESPACE_VERSION,
        revision: current.revision + 1,
        checkpoints: {
          ...current.checkpoints,
          [normalized.planFingerprint]: normalized,
        },
      };
      const written = await this.persistence.write(clone(next), current.revision);
      if (written === false) {
        throw new DurableLinearContractError(
          "Research project hierarchy checkpoint changed before it could be saved.",
        );
      }
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
  }
}

export function parseResearchProjectHierarchyCheckpointNamespaceV1(
  value: unknown,
): ResearchProjectHierarchyCheckpointNamespaceV1 {
  if (value === null || value === undefined) {
    return { version: 1, revision: 0, checkpoints: {} };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint namespace must be an object.");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    !Number.isInteger(record.revision) ||
    (record.revision as number) < 0 ||
    !record.checkpoints ||
    typeof record.checkpoints !== "object" ||
    Array.isArray(record.checkpoints)
  ) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint namespace is invalid.");
  }
  const entries = Object.entries(record.checkpoints as Record<string, unknown>);
  if (entries.length > RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_LIMIT) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint limit is exceeded.");
  }
  const checkpoints: Record<string, ResearchProjectHierarchyCheckpointV1> = {};
  for (const [key, raw] of entries) {
    const fingerprint = expectSha256(key, "research project hierarchy checkpoint key");
    const checkpoint = parseResearchProjectHierarchyCheckpointV1(raw);
    if (checkpoint.planFingerprint !== fingerprint) {
      throw new DurableLinearContractError("Research project hierarchy checkpoint key does not match its plan fingerprint.");
    }
    checkpoints[fingerprint] = checkpoint;
  }
  return { version: 1, revision: record.revision as number, checkpoints };
}

export function parseResearchProjectHierarchyCheckpointV1(
  value: unknown,
): ResearchProjectHierarchyCheckpointV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint must be an object.");
  }
  const record = value as ResearchProjectHierarchyCheckpointV1;
  if (
    record.version !== 1 ||
    !["prepared", "approval_denied", "approved", "partial", "reconcile_required", "complete"].includes(record.status) ||
    !Array.isArray(record.items) ||
    record.items.length < 4 ||
    record.items.length > 212
  ) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint is invalid.");
  }
  expectSha256(record.planFingerprint, "research project hierarchy plan fingerprint");
  expectSha256(record.approvalFingerprint, "research project hierarchy approval fingerprint");
  expectIsoTimestamp(record.updatedAt, "research project hierarchy checkpoint time");
  const keys = new Set<string>();
  for (const item of record.items) {
    if (
      !item ||
      typeof item.key !== "string" ||
      !item.key.trim() ||
      keys.has(item.key) ||
      !["initiative", "project", "initiative_project_link", "issue", "issue_relation"].includes(item.kind) ||
      !["deduplicated", "prepared", "committed", "reconcile_required"].includes(item.status) ||
      typeof item.toolCallId !== "string" ||
      typeof item.resourceId !== "string"
    ) {
      throw new DurableLinearContractError("Research project hierarchy checkpoint item is invalid.");
    }
    keys.add(item.key);
    if (item.readbackFingerprint !== null) {
      expectSha256(item.readbackFingerprint, `${item.key} readback fingerprint`);
    }
    if (item.status === "deduplicated" && (item.action !== null || !item.readbackFingerprint)) {
      throw new DurableLinearContractError("Deduplicated hierarchy items require readback and no prepared action.");
    }
    if (item.status !== "deduplicated" && !item.action) {
      throw new DurableLinearContractError("Non-deduplicated hierarchy items require a prepared action.");
    }
  }
  return clone(record)!;
}

export interface ResearchProjectHierarchyApprovalRequestV1 {
  kind: "linear_research_project_hierarchy";
  runId: string;
  toolCallId: string;
  planFingerprint: string;
  approvalFingerprint: string;
  workspaceId: string;
  teamId: string;
  preparedActions: PreparedAction[];
  deduplicatedResources: Array<{
    key: string;
    kind: ResearchProjectHierarchyItemKindV1;
    resourceId: string;
    readbackFingerprint: string;
  }>;
}

export type ResearchProjectHierarchyApprovalDecisionV1 =
  | {
      approved: true;
      approvalId: string;
      approvalFingerprint: string;
      grant: AuthorityGrantV1;
    }
  | { approved: false; reason?: string };

export interface ResearchProjectHierarchyApprovalPortV1 {
  requestExactGroupedApproval(
    request: ResearchProjectHierarchyApprovalRequestV1,
  ): Promise<ResearchProjectHierarchyApprovalDecisionV1>;
  resolvePersistedGrant?(grantId: string): Promise<AuthorityGrantV1 | null>;
}

export interface ResearchProjectHierarchyWorkflowOptionsV1 {
  readClient: LinearToolClient;
  actionExecutor: Pick<
    HostLinearActionExecutor,
    "prepare" | "executePrepared" | "reconcile"
  >;
  approval: ResearchProjectHierarchyApprovalPortV1;
  checkpoints: ResearchProjectHierarchyCheckpointPortV1;
  persistExternalReceipt?: (receipt: ActionReceipt) => Promise<void>;
  now?: () => Date;
}

export interface ResearchProjectHierarchyRequestV1 {
  explicitUserMission: boolean;
  runId: string;
  toolCallId: string;
  subject: LinearAuthoritySubject;
  context: ToolExecutionContext;
  plan: ResearchProjectPlanV1;
}

export type ResearchProjectHierarchyResultV1 =
  | {
      ok: true;
      status: "complete";
      plan: ResearchProjectPlanV1;
      checkpoint: ResearchProjectHierarchyCheckpointV1;
      receipt: ActionReceipt;
      initiativeId: string;
      projectId: string;
      issueIds: string[];
    }
  | {
      ok: false;
      status: "denied" | "rejected" | "not_applied" | "reconcile_required";
      plan: ResearchProjectPlanV1;
      checkpoint: ResearchProjectHierarchyCheckpointV1 | null;
      error: { code: string; message: string };
    };

interface HierarchyOperationV1 {
  key: string;
  kind: ResearchProjectHierarchyItemKindV1;
  toolName: string;
  toolCallId: string;
  arguments: Record<string, unknown>;
  duplicate?: LinearBaseRecord;
}

type HierarchyExecutionResolutionV1 =
  | { ok: true; receipt: ActionReceipt }
  | Extract<HostLinearActionExecution, { ok: false }>;

/**
 * One host-owned, crash-resumable hierarchy transaction. All fixed Linear
 * actions are prepared and checkpointed before the first mutation, then one
 * exact grouped approval covers only those immutable prepared actions.
 */
export class ResearchProjectHierarchyWorkflowV1 {
  private readonly now: () => Date;

  constructor(private readonly options: ResearchProjectHierarchyWorkflowOptionsV1) {
    this.now = options.now ?? (() => new Date());
  }

  async execute(
    request: ResearchProjectHierarchyRequestV1,
  ): Promise<ResearchProjectHierarchyResultV1> {
    const plan = parseResearchProjectPlanV1(request.plan);
    if (!request.explicitUserMission) {
      return rejected(plan, null, "linear_hierarchy_explicit_intent_required", "Creating a Linear hierarchy requires an explicit user mission.");
    }
    if (!request.runId.trim() || !request.toolCallId.trim()) {
      return rejected(plan, null, "linear_hierarchy_identity_required", "Linear hierarchy run identity is missing.");
    }
    if (
      (request.context.runId !== undefined && request.context.runId !== request.runId) ||
      (request.context.operationId !== undefined &&
        request.context.operationId !== request.toolCallId)
    ) {
      return rejected(
        plan,
        null,
        "linear_hierarchy_identity_mismatch",
        "Linear hierarchy context belongs to a different outer run or tool call.",
      );
    }

    let checkpoint = await this.options.checkpoints.get(plan.fingerprint);
    if (checkpoint?.status === "complete") {
      try {
        checkpoint = await this.reverifyCommittedCheckpoint(plan, checkpoint, request.context);
        await this.options.checkpoints.persist(checkpoint);
        const receipt = createHierarchyReceipt(plan, checkpoint, request.runId);
        await this.persistCheckpointReceipts(checkpoint, receipt);
        return completeResult(plan, checkpoint, receipt);
      } catch (error) {
        return rejected(plan, checkpoint, "linear_hierarchy_resume_readback_failed", safeMessage(error));
      }
    }

    if (!checkpoint || checkpoint.status === "approval_denied") {
      let operations: HierarchyOperationV1[];
      try {
        operations = await this.buildOperations(plan, request);
      } catch (error) {
        return rejected(plan, checkpoint, "linear_hierarchy_dedupe_failed", safeMessage(error));
      }
      const preparedItems: ResearchProjectHierarchyCheckpointItemV1[] = [];
      for (const operation of operations) {
        if (operation.duplicate) {
          preparedItems.push({
            key: operation.key,
            kind: operation.kind,
            status: "deduplicated",
            toolCallId: operation.toolCallId,
            action: null,
            resourceId: operation.duplicate.id,
            readbackFingerprint: operation.duplicate.snapshotHash,
            receipt: null,
          });
          continue;
        }
        const preparation = await this.options.actionExecutor.prepare({
          toolName: operation.toolName,
          arguments: operation.arguments,
          runId: request.runId,
          toolCallId: operation.toolCallId,
          context: hierarchyChildContext(
            request.context,
            request.runId,
            operation.toolCallId,
          ),
        });
        if (!preparation.ok) {
          return rejected(plan, checkpoint, preparation.error.code, preparation.error.message);
        }
        preparedItems.push({
          key: operation.key,
          kind: operation.kind,
          status: "prepared",
          toolCallId: operation.toolCallId,
          action: preparation.action,
          resourceId: preparation.action.target.id,
          readbackFingerprint: null,
          receipt: null,
        });
      }
      const approvalFingerprint = fingerprintHierarchyApproval(plan, preparedItems);
      checkpoint = {
        version: RESEARCH_PROJECT_HIERARCHY_CHECKPOINT_VERSION,
        planFingerprint: plan.fingerprint,
        status: "prepared",
        approvalFingerprint,
        approvalId: null,
        grantId: null,
        items: preparedItems,
        updatedAt: this.now().toISOString(),
      };
      // Required crash boundary: no mutation occurs before this resolves.
      await this.options.checkpoints.persist(checkpoint);
    }

    // A prior attempt may have committed a provider mutation and its readback
    // before the external receipt ledger became durable. Rehydrate that
    // idempotent ledger from the authoritative checkpoint before proceeding.
    await this.persistCheckpointReceipts(checkpoint);

    let grant: AuthorityGrantV1 | null = null;
    if (checkpoint.grantId && this.options.approval.resolvePersistedGrant) {
      grant = await this.options.approval.resolvePersistedGrant(checkpoint.grantId);
    }
    if (!grant) {
      const decision = await this.options.approval.requestExactGroupedApproval({
        kind: "linear_research_project_hierarchy",
        runId: request.runId,
        toolCallId: request.toolCallId,
        planFingerprint: plan.fingerprint,
        approvalFingerprint: checkpoint.approvalFingerprint,
        workspaceId: plan.destination.workspaceId,
        teamId: plan.destination.teamId,
        preparedActions: checkpoint.items.flatMap((item) => item.action ? [item.action] : []),
        deduplicatedResources: checkpoint.items.flatMap((item) =>
          item.status === "deduplicated" && item.readbackFingerprint
            ? [{
                key: item.key,
                kind: item.kind,
                resourceId: item.resourceId,
                readbackFingerprint: item.readbackFingerprint,
              }]
            : [],
        ),
      });
      if (!decision.approved) {
        checkpoint = { ...checkpoint, status: "approval_denied", updatedAt: this.now().toISOString() };
        await this.options.checkpoints.persist(checkpoint);
        return rejected(plan, checkpoint, "approval_denied", decision.reason ?? "Linear hierarchy approval was denied.", "denied");
      }
      if (decision.approvalFingerprint !== checkpoint.approvalFingerprint) {
        return rejected(plan, checkpoint, "linear_hierarchy_approval_stale", "Linear hierarchy approval fingerprint is stale.");
      }
      grant = decision.grant;
      checkpoint = {
        ...checkpoint,
        status: "approved",
        approvalId: decision.approvalId,
        grantId: grant.id,
        updatedAt: this.now().toISOString(),
      };
      await this.options.checkpoints.persist(checkpoint);
    }

    for (let index = 0; index < checkpoint.items.length; index += 1) {
      const item: ResearchProjectHierarchyCheckpointItemV1 = checkpoint.items[index]!;
      if (item.status === "committed" || item.status === "deduplicated") continue;
      if (!item.action) {
        return rejected(plan, checkpoint, "linear_hierarchy_checkpoint_invalid", `Prepared hierarchy item ${item.key} lost its action.`);
      }
      let resolved: HierarchyExecutionResolutionV1;
      if (item.status === "reconcile_required") {
        const reconciled = await this.options.actionExecutor.reconcile({
          action: item.action,
          runId: request.runId,
          toolCallId: item.toolCallId,
          grantId: grant.id,
          context: hierarchyChildContext(
            request.context,
            request.runId,
            item.toolCallId,
          ),
        });
        resolved = reconciled.outcome === "committed" && reconciled.receipt
          ? { ok: true, receipt: reconciled.receipt }
          : {
              ok: false,
              status: "reconcile_required",
              error: {
                code: "linear_hierarchy_reconcile_inconclusive",
                message: reconciled.message,
              },
              action: item.action,
              grantId: grant.id,
            };
      } else {
        const execution = await this.options.actionExecutor.executePrepared({
          action: item.action,
          runId: request.runId,
          toolCallId: item.toolCallId,
          context: hierarchyChildContext(
            request.context,
            request.runId,
            item.toolCallId,
          ),
          subject: request.subject,
          activeGrants: [grant],
          preferredGrantId: grant.id,
        });
        resolved = execution.ok
          ? { ok: true, receipt: execution.receipt }
          : await this.tryReconcile(execution, item, request, grant.id);
      }
      if (!resolved.ok) {
        const status = resolved.status === "reconcile_required"
          ? "reconcile_required"
          : checkpoint.items.some((candidate) => candidate.status === "committed")
            ? "partial"
            : "approved";
        const items = checkpoint.items.map((candidate, candidateIndex) =>
          candidateIndex === index
            ? { ...candidate, status: resolved.status === "reconcile_required" ? "reconcile_required" as const : candidate.status }
            : candidate,
        );
        checkpoint = { ...checkpoint, status, items, updatedAt: this.now().toISOString() };
        await this.options.checkpoints.persist(checkpoint);
        return rejected(
          plan,
          checkpoint,
          resolved.error.code,
          resolved.error.message,
          resolved.status === "reconcile_required" ? "reconcile_required" : "not_applied",
        );
      }
      const readback = await this.readItem(item.kind, item.resourceId, request.context);
      if (!readback || readback.id !== item.resourceId) {
        checkpoint = {
          ...checkpoint,
          status: "reconcile_required",
          items: checkpoint.items.map((candidate, candidateIndex) =>
            candidateIndex === index
              ? { ...candidate, status: "reconcile_required" as const }
              : candidate,
          ),
          updatedAt: this.now().toISOString(),
        };
        await this.options.checkpoints.persist(checkpoint);
        return rejected(plan, checkpoint, "linear_hierarchy_independent_readback_failed", `Independent Linear readback failed for ${item.key}.`, "reconcile_required");
      }
      const nextItems: ResearchProjectHierarchyCheckpointItemV1[] = checkpoint.items.map(
        (candidate, candidateIndex): ResearchProjectHierarchyCheckpointItemV1 =>
          candidateIndex === index
            ? {
                ...candidate,
                status: "committed",
                readbackFingerprint: readback.snapshotHash,
                receipt: resolved.receipt,
              }
            : candidate,
      );
      checkpoint = {
        ...checkpoint,
        status: index === checkpoint.items.length - 1 ? "complete" : "partial",
        items: nextItems,
        updatedAt: this.now().toISOString(),
      };
      // Provider truth and its receipt must become durable in the checkpoint
      // before the separately persisted receipt ledger is allowed to fail.
      // Otherwise resume would replay an already-applied provider mutation.
      await this.options.checkpoints.persist(checkpoint);
      await this.options.persistExternalReceipt?.(resolved.receipt);
    }

    checkpoint = await this.reverifyCommittedCheckpoint(
      plan,
      { ...checkpoint, status: "complete", updatedAt: this.now().toISOString() },
      request.context,
    );
    await this.options.checkpoints.persist(checkpoint);
    const receipt = createHierarchyReceipt(plan, checkpoint, request.runId);
    await this.persistCheckpointReceipts(checkpoint, receipt);
    return completeResult(plan, checkpoint, receipt);
  }

  private async persistCheckpointReceipts(
    checkpoint: ResearchProjectHierarchyCheckpointV1,
    hierarchyReceipt?: ActionReceipt,
  ): Promise<void> {
    if (!this.options.persistExternalReceipt) return;
    for (const item of checkpoint.items) {
      if (item.receipt) await this.options.persistExternalReceipt(item.receipt);
    }
    if (hierarchyReceipt) await this.options.persistExternalReceipt(hierarchyReceipt);
  }

  private async buildOperations(
    plan: ResearchProjectPlanV1,
    request: ResearchProjectHierarchyRequestV1,
  ): Promise<HierarchyOperationV1[]> {
    const duplicates = await this.findDuplicates(plan, request.context);
    const operations: HierarchyOperationV1[] = [];
    const initiative = operation({
      key: `initiative:${plan.initiative.key}`,
      kind: "initiative",
      toolName: "linear_create_initiative",
      runId: request.runId,
      plan,
      arguments: {
        input: {
          name: plan.initiative.title,
          description: providerSummary(plan.initiative.description),
          content: taggedDescription(
            plan.initiative.description,
            plan.initiative.idempotencyKey,
          ),
        },
      },
      duplicate: duplicates.get(plan.initiative.idempotencyKey),
    });
    operations.push(initiative);

    const initiativeId = initiative.duplicate?.id ?? await this.previewTargetId(initiative, request);
    const project = operation({
      key: `project:${plan.project.key}`,
      kind: "project",
      toolName: "linear_create_project",
      runId: request.runId,
      plan,
      arguments: {
        input: {
          name: plan.project.title,
          description: providerSummary(plan.project.description),
          content: taggedDescription(
            plan.project.description,
            plan.project.idempotencyKey,
          ),
          teamIds: [plan.destination.teamId],
        },
      },
      duplicate: duplicates.get(plan.project.idempotencyKey),
    });
    operations.push(project);
    const projectId = project.duplicate?.id ?? await this.previewTargetId(project, request);

    const existingInitiativeProjectLink = await this.findUniqueRelation(
      "initiative_project_links.list",
      (record) =>
        record.attributes?.initiative === initiativeId &&
        record.attributes?.project === projectId,
      `initiative ${initiativeId} and project ${projectId}`,
      request.context,
    );
    operations.push(operation({
      key: "initiative-project-link",
      kind: "initiative_project_link",
      toolName: "linear_create_initiative_project_link",
      runId: request.runId,
      plan,
      arguments: { input: { initiativeId, projectId } },
      duplicate: existingInitiativeProjectLink,
    }));

    const issueIds = new Map<string, string>();
    for (const issue of plan.issues) {
      const issueOperation = operation({
        key: `issue:${issue.key}`,
        kind: "issue",
        toolName: "linear_create_issue",
        runId: request.runId,
        plan,
        arguments: {
          teamId: plan.destination.teamId,
          projectId,
          title: issue.title,
          description: taggedDescription(
            `${issue.description}\n\nAcceptance criteria:\n${issue.acceptanceCriteria.map((criterion) => `- ${criterion}`).join("\n")}\n\nWork item: ${issue.workItemFingerprint}`,
            issue.idempotencyKey,
          ),
        },
        duplicate: duplicates.get(issue.idempotencyKey),
      });
      operations.push(issueOperation);
      issueIds.set(
        issue.key,
        issueOperation.duplicate?.id ?? await this.previewTargetId(issueOperation, request),
      );
    }
    const hasDependencies = plan.issues.some((issue) => issue.dependencyKeys.length > 0);
    const existingIssueRelations = hasDependencies
      ? await this.list("issue_relations.list", request.context)
      : [];
    for (const issue of plan.issues) {
      for (const dependencyKey of issue.dependencyKeys) {
        const issueId = issueIds.get(dependencyKey);
        const relatedIssueId = issueIds.get(issue.key);
        const matches = existingIssueRelations.filter((record) =>
          record.attributes?.issue === issueId &&
          record.attributes?.relatedIssue === relatedIssueId &&
          record.type === "blocks"
        );
        if (matches.length > 1) {
          throw new Error(
            `Linear issue relation ${dependencyKey} blocks ${issue.key} matches multiple resources.`,
          );
        }
        operations.push(operation({
          key: `relation:${dependencyKey}:blocks:${issue.key}`,
          kind: "issue_relation",
          toolName: "linear_create_issue_relation",
          runId: request.runId,
          plan,
          arguments: {
            input: {
              issueId,
              relatedIssueId,
              type: "blocks",
            },
          },
          duplicate: matches[0],
        }));
      }
    }
    return operations;
  }

  /** Prepare-only probe used to derive deterministic resource IDs for links. */
  private async previewTargetId(
    operationInput: HierarchyOperationV1,
    request: ResearchProjectHierarchyRequestV1,
  ): Promise<string> {
    const prepared = await this.options.actionExecutor.prepare({
      toolName: operationInput.toolName,
      arguments: operationInput.arguments,
      runId: request.runId,
      toolCallId: operationInput.toolCallId,
      context: hierarchyChildContext(
        request.context,
        request.runId,
        operationInput.toolCallId,
      ),
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    return prepared.action.target.id;
  }

  private async findDuplicates(
    plan: ResearchProjectPlanV1,
    context: ToolExecutionContext,
  ): Promise<Map<string, LinearBaseRecord>> {
    const result = new Map<string, LinearBaseRecord>();
    const catalogs = await Promise.all([
      this.list("initiatives.list", context),
      this.list("projects.list", context),
      this.list("issues.list", context),
    ]);
    const expectedKeys = new Set([
      plan.initiative.idempotencyKey,
      plan.project.idempotencyKey,
      ...plan.issues.map((issue) => issue.idempotencyKey),
    ]);
    for (const record of catalogs.flat()) {
      const content = [record.description, record.content, record.body]
        .filter((value): value is string => typeof value === "string")
        .join("\n");
      for (const key of expectedKeys) {
        if (content.includes(idempotencyMarker(key))) {
          const previous = result.get(key);
          if (previous && previous.id !== record.id) {
            throw new Error(`Linear idempotency key ${key} matches multiple resources.`);
          }
          result.set(key, record);
        }
      }
    }
    return result;
  }

  private async list(operationKey: string, context: ToolExecutionContext): Promise<LinearBaseRecord[]> {
    const output = await this.options.readClient.execute(operationKey, { first: 50 }, requestOptions(context));
    return isLinearPage(output) ? output.items : [];
  }

  private async findUniqueRelation(
    operationKey: string,
    matches: (record: LinearBaseRecord) => boolean,
    label: string,
    context: ToolExecutionContext,
  ): Promise<LinearBaseRecord | undefined> {
    const candidates = (await this.list(operationKey, context)).filter(matches);
    if (candidates.length > 1) {
      throw new Error(`Linear relation ${label} matches multiple resources.`);
    }
    return candidates[0];
  }

  private async readItem(
    kind: ResearchProjectHierarchyItemKindV1,
    id: string,
    context: ToolExecutionContext,
  ): Promise<LinearBaseRecord | null> {
    const operationKey = {
      initiative: "initiatives.get",
      project: "projects.get",
      initiative_project_link: "initiative_project_links.get",
      issue: "issues.get",
      issue_relation: "issue_relations.get",
    }[kind];
    try {
      const output = await this.options.readClient.execute(operationKey, { id }, requestOptions(context));
      return isLinearRecord(output) ? output : null;
    } catch {
      return null;
    }
  }

  private async tryReconcile(
    execution: Exclude<HostLinearActionExecution, { ok: true }>,
    item: ResearchProjectHierarchyCheckpointItemV1,
    request: ResearchProjectHierarchyRequestV1,
    grantId: string,
  ): Promise<HierarchyExecutionResolutionV1> {
    if (execution.status !== "reconcile_required" || !item.action) return execution;
    const reconciled = await this.options.actionExecutor.reconcile({
      action: item.action,
      runId: request.runId,
      toolCallId: item.toolCallId,
      grantId,
      context: hierarchyChildContext(
        request.context,
        request.runId,
        item.toolCallId,
      ),
    });
    if (reconciled.outcome !== "committed" || !reconciled.receipt) return execution;
    return { ok: true, receipt: reconciled.receipt };
  }

  private async reverifyCommittedCheckpoint(
    plan: ResearchProjectPlanV1,
    checkpoint: ResearchProjectHierarchyCheckpointV1,
    context: ToolExecutionContext,
  ): Promise<ResearchProjectHierarchyCheckpointV1> {
    const items: ResearchProjectHierarchyCheckpointItemV1[] = [];
    for (const item of checkpoint.items) {
      const readback = await this.readItem(item.kind, item.resourceId, context);
      if (!readback) throw new Error(`Linear hierarchy resource ${item.key} is missing during resume readback.`);
      items.push({ ...item, readbackFingerprint: readback.snapshotHash });
    }
    const next = {
      ...checkpoint,
      status: "complete" as const,
      items,
      updatedAt: this.now().toISOString(),
    };
    validateCheckpoint(next, plan);
    return next;
  }
}

function operation(input: {
  key: string;
  kind: ResearchProjectHierarchyItemKindV1;
  toolName: string;
  runId: string;
  plan: ResearchProjectPlanV1;
  arguments: Record<string, unknown>;
  duplicate?: LinearBaseRecord;
}): HierarchyOperationV1 {
  return {
    key: input.key,
    kind: input.kind,
    toolName: input.toolName,
    toolCallId: stableToolCallId(input.plan.fingerprint, input.key),
    arguments: input.arguments,
    ...(input.duplicate ? { duplicate: input.duplicate } : {}),
  };
}

function hierarchyChildContext(
  context: ToolExecutionContext,
  runId: string,
  toolCallId: string,
): ToolExecutionContext {
  return { ...context, runId, operationId: toolCallId };
}

function stableToolCallId(planFingerprint: string, key: string): string {
  return `hierarchy-${planFingerprint.slice(7, 23)}-${key}`
    .replace(/[^A-Za-z0-9._:-]+/gu, "-")
    .slice(0, 150);
}

function taggedDescription(description: string, idempotencyKey: string): string {
  return `${description}\n\n${idempotencyMarker(idempotencyKey)}`;
}

/**
 * Linear's project and initiative `description` is the bounded list synopsis;
 * their full markdown belongs in `content`. Keep the synopsis comfortably
 * below the provider boundary while preserving the complete source text and
 * idempotency marker in content.
 */
export function providerSummary(description: string): string {
  const compact = description.replace(/\s+/gu, " ").trim();
  if (compact.length <= 240) return compact;
  return `${compact.slice(0, 237).trimEnd()}...`;
}

function idempotencyMarker(key: string): string {
  return `<!-- agentic-idempotency:${key} -->`;
}

function fingerprintHierarchyApproval(
  plan: ResearchProjectPlanV1,
  items: ResearchProjectHierarchyCheckpointItemV1[],
): string {
  return fingerprintContract({
    kind: "linear_research_project_hierarchy",
    planFingerprint: plan.fingerprint,
    destination: plan.destination,
    actions: items.map((item) => ({
      key: item.key,
      kind: item.kind,
      status: item.status,
      resourceId: item.resourceId,
      payloadFingerprint: item.action?.payloadFingerprint ?? null,
      readbackFingerprint: item.readbackFingerprint,
    })),
  });
}

function validateCheckpoint(
  checkpoint: ResearchProjectHierarchyCheckpointV1,
  plan: ResearchProjectPlanV1,
): void {
  if (checkpoint.version !== 1 || checkpoint.planFingerprint !== plan.fingerprint) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint does not match its plan.");
  }
  expectSha256(checkpoint.approvalFingerprint, "hierarchy approval fingerprint");
  expectIsoTimestamp(checkpoint.updatedAt, "hierarchy checkpoint updated at");
  if (checkpoint.status === "complete") {
    if (
      checkpoint.items.length < 4 ||
      checkpoint.items.some((item) =>
        !["committed", "deduplicated"].includes(item.status) || !item.readbackFingerprint,
      )
    ) {
      throw new DurableLinearContractError("Complete hierarchy checkpoint lacks provider readback for every resource.");
    }
  }
}

function createHierarchyReceipt(
  plan: ResearchProjectPlanV1,
  checkpoint: ResearchProjectHierarchyCheckpointV1,
  runId: string,
): ActionReceipt {
  validateCheckpoint(checkpoint, plan);
  const initiative = checkpoint.items.find((item) => item.kind === "initiative")!;
  const project = checkpoint.items.find((item) => item.kind === "project")!;
  const issues = checkpoint.items.filter((item) => item.kind === "issue");
  const observedFingerprint = fingerprintContract(
    checkpoint.items.map((item) => ({
      key: item.key,
      resourceId: item.resourceId,
      readbackFingerprint: item.readbackFingerprint,
    })),
  );
  return {
    version: 1,
    id: `linear-hierarchy-${plan.fingerprint.slice(7, 31)}`,
    runId,
    actionId: `linear-hierarchy-${checkpoint.approvalFingerprint.slice(7, 31)}`,
    toolName: LINEAR_RESEARCH_PROJECT_HIERARCHY_RECEIPT_TOOL_NAME,
    operation: "create",
    resource: linearResource("project", project.resourceId, plan.destination, project.readbackFingerprint!),
    relatedResources: [
      linearResource("initiative", initiative.resourceId, plan.destination, initiative.readbackFingerprint!),
      ...issues.map((item) => linearResource("issue", item.resourceId, plan.destination, item.readbackFingerprint!)),
    ],
    message: `Verified one Linear initiative, one project, and ${issues.length} dependency-aware issue(s).`,
    payloadFingerprint: checkpoint.approvalFingerprint,
    grantId: checkpoint.grantId ?? "linear-hierarchy-deduplicated",
    idempotencyKey: `linear-research-project:${plan.fingerprint}`,
    startedAt: plan.createdAt,
    committedAt: checkpoint.updatedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: checkpoint.updatedAt,
      observedFingerprint,
    },
    effects: {
      affectedCount: checkpoint.items.filter((item) => item.status === "committed").length,
      changedFields: ["initiative", "project", "issues", "dependencies"],
    },
  };
}

function linearResource(
  resourceType: string,
  id: string,
  destination: ResearchProjectPlanV1["destination"],
  revision: string,
): ResourceRef {
  return {
    system: "linear",
    resourceType,
    id,
    workspaceId: destination.workspaceId,
    teamId: destination.teamId,
    revision,
  };
}

function completeResult(
  plan: ResearchProjectPlanV1,
  checkpoint: ResearchProjectHierarchyCheckpointV1,
  receipt: ActionReceipt,
): Extract<ResearchProjectHierarchyResultV1, { ok: true }> {
  return {
    ok: true,
    status: "complete",
    plan,
    checkpoint,
    receipt,
    initiativeId: checkpoint.items.find((item) => item.kind === "initiative")!.resourceId,
    projectId: checkpoint.items.find((item) => item.kind === "project")!.resourceId,
    issueIds: checkpoint.items.filter((item) => item.kind === "issue").map((item) => item.resourceId),
  };
}

function rejected(
  plan: ResearchProjectPlanV1,
  checkpoint: ResearchProjectHierarchyCheckpointV1 | null,
  code: string,
  message: string,
  status: Extract<ResearchProjectHierarchyResultV1, { ok: false }>["status"] = "rejected",
): Extract<ResearchProjectHierarchyResultV1, { ok: false }> {
  return { ok: false, status, plan, checkpoint, error: { code, message } };
}

function isLinearPage(value: unknown): value is LinearPage<LinearBaseRecord> {
  return Boolean(
    value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items),
  );
}

function isLinearRecord(value: unknown): value is LinearBaseRecord {
  return Boolean(
    value && typeof value === "object" &&
      typeof (value as { id?: unknown }).id === "string" &&
      typeof (value as { snapshotHash?: unknown }).snapshotHash === "string",
  );
}

function requestOptions(context: ToolExecutionContext) {
  return {
    abortSignal: context.abortSignal,
    deadlineAt: context.deadlineAt,
  };
}

function safeMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertCheckpointTransition(
  previous: ResearchProjectHierarchyCheckpointV1,
  next: ResearchProjectHierarchyCheckpointV1,
): void {
  if (
    previous.planFingerprint !== next.planFingerprint ||
    previous.approvalFingerprint !== next.approvalFingerprint ||
    previous.items.length !== next.items.length ||
    Date.parse(next.updatedAt) < Date.parse(previous.updatedAt)
  ) {
    throw new DurableLinearContractError("Research project hierarchy checkpoint identity cannot change.");
  }
  const nextByKey = new Map(next.items.map((item) => [item.key, item]));
  for (const item of previous.items) {
    const candidate = nextByKey.get(item.key);
    if (
      !candidate ||
      candidate.kind !== item.kind ||
      candidate.toolCallId !== item.toolCallId ||
      candidate.resourceId !== item.resourceId ||
      candidate.action?.payloadFingerprint !== item.action?.payloadFingerprint
    ) {
      throw new DurableLinearContractError("Research project hierarchy checkpoint item identity cannot change.");
    }
    if (
      ["committed", "deduplicated"].includes(item.status) &&
      candidate.status !== item.status
    ) {
      throw new DurableLinearContractError("Verified hierarchy items cannot regress or change disposition.");
    }
  }
  if (previous.status === "complete" && next.status !== "complete") {
    throw new DurableLinearContractError("Complete research project hierarchy cannot regress.");
  }
}

function clone<T>(value: T): T {
  return value === null || value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T;
}
