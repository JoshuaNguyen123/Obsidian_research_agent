import {
  withPreparedActionFingerprint,
  type ActionReceipt,
  type JsonValue,
  type PreparedAction,
  type ToolDescriptor,
} from "../agent/actions";
import type { AuthorityGrantV1 } from "../agent/authority";
import {
  createResearchProjectPlanV1,
  type ResearchProjectDestinationV1,
} from "../agent/projectLifecycle";
import {
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  ResearchProjectHierarchyWorkflowV1,
  type ResearchProjectHierarchyApprovalRequestV1,
  type ResearchProjectHierarchyCheckpointV1,
  type ResearchProjectHierarchyCheckpointPortV1,
} from "../integrations/linear/ResearchProjectHierarchyWorkflowV1";
import type { HostLinearActionExecutor } from "../integrations/linear/HostLinearActionExecutor";
import {
  DurableLinearContractError,
  fingerprintContract,
} from "../integrations/linear/LinearContractSupport";
import type { LinearToolClient } from "../integrations/linear/LinearTools";
import type { JsonSchemaObject } from "../model/types";
import type { AgentTool } from "./types";
import { ToolExecutionError } from "./types";

export { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME };

export interface ResearchProjectHierarchyGrantInputV1 {
  runId: string;
  approvalId: string;
  destination: ResearchProjectDestinationV1;
  actionCount: number;
  resourceIds: string[];
  resourceTypes: string[];
}

export interface CreateResearchProjectHierarchyToolOptionsV1 {
  readClient: LinearToolClient;
  actionExecutor: Pick<
    HostLinearActionExecutor,
    "prepare" | "executePrepared" | "reconcile"
  >;
  checkpoints: ResearchProjectHierarchyCheckpointPortV1;
  destination: ResearchProjectDestinationV1;
  resolveAcceptedResearchBinding(input: {
    runId: string;
    notePath: string | null;
  }): Promise<{ artifactFingerprint: string; notePath: string } | null>;
  mintHierarchyGrant(
    input: ResearchProjectHierarchyGrantInputV1,
  ): Promise<AuthorityGrantV1>;
  resolvePersistedGrant(grantId: string): Promise<AuthorityGrantV1 | null>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  persistHierarchyBacklink?(input: {
    plan: ReturnType<typeof createResearchProjectPlanV1>;
    initiativeId: string;
    projectId: string;
    issueIds: string[];
    hierarchyReceipt: ActionReceipt;
  }): Promise<ActionReceipt>;
  persistProjectLineage?(input: {
    plan: ReturnType<typeof createResearchProjectPlanV1>;
    checkpoint: ResearchProjectHierarchyCheckpointV1;
    initiativeId: string;
    projectId: string;
    issueIds: string[];
  }): Promise<void>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export function createResearchProjectHierarchyTool(
  options: CreateResearchProjectHierarchyToolOptionsV1,
): AgentTool {
  const tool: AgentTool = {
    name: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
    description:
      "Convert one host-accepted research note into exactly one Linear initiative, one project, and at most 20 dependency-aware issues. The host binds the exact Linear destination, checkpoints every action before mutation, requests one grouped exact approval, deduplicates, independently reads every resource back, and resumes partial success without replay.",
    parameters: RESEARCH_PROJECT_HIERARCHY_PARAMETERS,
    descriptor: RESEARCH_PROJECT_HIERARCHY_DESCRIPTOR,
    async execute(args, context) {
      if (options.isAvailable?.() === false) {
        throw notApplied(
          "linear_hierarchy_unavailable",
          "Linear hierarchy publication requires a verified Linear connection and team destination.",
        );
      }
      if (!hasExplicitResearchProjectHierarchyIntent(context.originalPrompt)) {
        throw notApplied(
          "linear_hierarchy_explicit_intent_required",
          "Creating a Linear hierarchy requires an explicit user request to shape accepted research into an initiative, project, and issues.",
        );
      }
      if (!context.requestNestedApproval) {
        throw notApplied(
          "linear_hierarchy_approval_unavailable",
          "The exact grouped approval surface is unavailable.",
        );
      }
      const runId = requireIdentity(context.runId, "run id");
      const toolCallId = requireIdentity(context.operationId, "tool call id");
      const planInput = parsePlanArguments(args);
      const acceptedResearchBinding =
        await options.resolveAcceptedResearchBinding({
          runId,
          // Resolve the one host-owned current-run lineage first. A model
          // supplied path is checked below only as a narrowing assertion; it
          // must never choose which accepted artifact the host loads.
          notePath: null,
        });
      if (!acceptedResearchBinding) {
        throw notApplied(
          "linear_hierarchy_accepted_research_required",
          "The project plan is not bound to one host-accepted research artifact at the supplied note path.",
        );
      }
      const suppliedArtifactFingerprint = planInput.suppliedArtifactFingerprint;
      const acceptedResearchArtifactFingerprint =
        resolveCanonicalAcceptedResearchFingerprint(
          suppliedArtifactFingerprint,
          acceptedResearchBinding.artifactFingerprint,
        );
      const sourceNotePath = resolveCanonicalAcceptedResearchNotePath(
        planInput.suppliedSourceNotePath,
        acceptedResearchBinding.notePath,
      );
      const {
        suppliedArtifactFingerprint: _suppliedArtifactFingerprint,
        suppliedSourceNotePath: _suppliedSourceNotePath,
        ...canonicalPlanInput
      } = planInput;
      let plan: ReturnType<typeof createResearchProjectPlanV1>;
      try {
        plan = createResearchProjectPlanV1({
          ...canonicalPlanInput,
          issues: canonicalPlanInput.issues.map((issue) => ({
            ...issue,
            workItemFingerprint: deriveResearchProjectWorkItemFingerprint({
              acceptedResearchArtifactFingerprint,
              key: issue.key,
              title: issue.title,
              description: issue.description,
              dependencyKeys: issue.dependencyKeys,
              acceptanceCriteria: issue.acceptanceCriteria,
            }),
          })),
          planId: deriveResearchProjectPlanIdForAcceptedArtifact(
            acceptedResearchArtifactFingerprint,
          ),
          acceptedResearchArtifactFingerprint:
            acceptedResearchArtifactFingerprint,
          sourceNotePath,
          runId,
          destination: options.destination,
          createdAt: (options.now ?? context.now ?? (() => new Date()))().toISOString(),
        });
      } catch (error) {
        if (error instanceof DurableLinearContractError) {
          throw notApplied(
            "linear_hierarchy_invalid_arguments",
            error.message,
          );
        }
        throw error;
      }
      const workflow = new ResearchProjectHierarchyWorkflowV1({
        readClient: options.readClient,
        actionExecutor: options.actionExecutor,
        checkpoints: options.checkpoints,
        persistExternalReceipt: options.persistExternalReceipt,
        now: options.now ?? context.now,
        approval: {
          resolvePersistedGrant: options.resolvePersistedGrant,
          requestExactGroupedApproval: async (request) => {
            const action = await buildGroupedApprovalAction(
              request,
              options.now ?? context.now,
            );
            const decision = await context.requestNestedApproval!({
              toolName: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
              action:
                `Create or reuse one Linear initiative, one project, and the approved issue hierarchy in team ${request.teamId}.`,
              reason:
                "Approve the exact host-bound destination and the complete immutable group of prepared actions. Partial success will resume from provider readback without replay.",
              policyTags: [
                "linear_research_project_hierarchy",
                "exact_grouped_approval",
                "checkpoint_before_mutation",
              ],
              preparedAction: action,
              timeoutMs: 120_000,
              confirmationIndex: 1,
              requiredConfirmations: 1,
            });
            if (
              !decision.approved ||
              decision.approvalFingerprint !== action.payloadFingerprint
            ) {
              return {
                approved: false as const,
                reason: decision.approved
                  ? "Approval fingerprint mismatch."
                  : decision.reason,
              };
            }
            const grant = await options.mintHierarchyGrant({
              runId,
              approvalId: decision.approvalId,
              destination: options.destination,
              actionCount: request.preparedActions.length,
              resourceIds: request.preparedActions.map((action) => action.target.id),
              resourceTypes: [
                ...new Set(
                  request.preparedActions.map(
                    (action) => action.target.resourceType,
                  ),
                ),
              ],
            });
            return {
              approved: true as const,
              approvalId: decision.approvalId,
              approvalFingerprint: request.approvalFingerprint,
              grant,
            };
          },
        },
      });
      const result = await workflow.execute({
        explicitUserMission: true,
        runId,
        toolCallId,
        subject: { type: "run", id: runId },
        context,
        plan,
      });
      if (!result.ok) {
        throw new ToolExecutionError(result.error.code, result.error.message, {
          mutationState:
            result.status === "reconcile_required"
              ? "may_have_applied"
              : "not_applied",
        });
      }
      const backlinkReceipt = options.persistHierarchyBacklink
        ? await options.persistHierarchyBacklink({
            plan,
            initiativeId: result.initiativeId,
            projectId: result.projectId,
            issueIds: result.issueIds,
            hierarchyReceipt: result.receipt,
          })
        : null;
      if (options.persistProjectLineage) {
        const checkpoint = await options.checkpoints.get(plan.fingerprint);
        if (!checkpoint || checkpoint.status !== "complete") {
          throw notApplied(
            "linear_hierarchy_lineage_checkpoint_missing",
            "The verified Linear hierarchy could not be bound to its durable complete checkpoint.",
          );
        }
        await options.persistProjectLineage({
          plan,
          checkpoint,
          initiativeId: result.initiativeId,
          projectId: result.projectId,
          issueIds: result.issueIds,
        });
      }
      return { ...result, backlinkReceipt };
    },
  };
  tool.executeResult = async (args, context) => {
    const output = await tool.execute(args, context) as Extract<
      Awaited<ReturnType<ResearchProjectHierarchyWorkflowV1["execute"]>>,
      { ok: true }
    > & { backlinkReceipt: ActionReceipt | null };
    return {
      ok: true,
      toolName: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
      output,
      receipt: output.backlinkReceipt ?? output.receipt,
      mutationState: "applied" as const,
    };
  };
  return tool;
}

export function hasExplicitResearchProjectHierarchyIntent(prompt: string): boolean {
  const text = typeof prompt === "string" ? prompt : "";
  if (/\b(?:do not|don't|without|skip|exclude|no)\b[^.\n]{0,100}\blinear\b/iu.test(text)) {
    return false;
  }
  return (
    /\b(?:shape|turn|convert|create|build|publish|send)\b[\s\S]{0,180}\b(?:accepted\s+)?research\b[\s\S]{0,180}\blinear\b[\s\S]{0,160}\b(?:initiative|project|hierarchy)\b/iu.test(text) ||
    /\bcreate\b[\s\S]{0,80}\bproject\b[\s\S]{0,80}\bend[- ]to[- ]end\b/iu.test(text)
  );
}

async function buildGroupedApprovalAction(
  request: ResearchProjectHierarchyApprovalRequestV1,
  nowProvider?: () => Date,
): Promise<PreparedAction> {
  const preparedAt = (nowProvider?.() ?? new Date()).toISOString();
  const actionFingerprints = request.preparedActions.map(
    (action) => action.payloadFingerprint,
  );
  const outboundPayload: Record<string, JsonValue> = {
    planFingerprint: request.planFingerprint,
    approvalFingerprint: request.approvalFingerprint,
    actionFingerprints,
    deduplicatedResources: request.deduplicatedResources.map((item) => ({
      key: item.key,
      kind: item.kind,
      resourceId: item.resourceId,
      readbackFingerprint: item.readbackFingerprint,
    })),
  };
  return withPreparedActionFingerprint({
    version: 1,
    id: `linear-hierarchy-preview-${request.planFingerprint.slice(7, 31)}`,
    runId: request.runId,
    toolCallId: request.toolCallId,
    toolName: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
    target: {
      system: "linear",
      resourceType: "project_hierarchy",
      id: `pending-${request.planFingerprint.slice(7, 31)}`,
      workspaceId: request.workspaceId,
      teamId: request.teamId,
    },
    relatedResources: request.preparedActions.map((action) => action.target),
    normalizedArgs: outboundPayload,
    preview: {
      summary:
        `Create/reuse a Linear hierarchy with ${request.preparedActions.length} prepared mutation(s) and ${request.deduplicatedResources.length} exact duplicate(s).`,
      destination:
        `Linear workspace=${request.workspaceId} team=${request.teamId}`,
      outboundPayload,
      duplicateCandidates: request.deduplicatedResources.map((item) => ({
        system: "linear" as const,
        resourceType: item.kind,
        id: item.resourceId,
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        revision: item.readbackFingerprint,
      })),
      warnings: [],
      outboundBytes: request.preparedActions.reduce(
        (total, action) => total + action.preview.outboundBytes,
        0,
      ),
    },
    idempotencyKey: `linear-research-project:${request.planFingerprint}`,
    reconciliationKey: `linear-research-project:${request.planFingerprint}`,
    preparedAt,
    expiresAt: new Date(Date.parse(preparedAt) + 120_000).toISOString(),
    requiredConfirmations: 1,
  });
}

function parsePlanArguments(args: Record<string, unknown>) {
  const plan = expectRecord(args.plan, "research project plan");
  const suppliedArtifactFingerprint =
    typeof plan.acceptedResearchArtifactFingerprint === "string" &&
    /^sha256:[a-f0-9]{64}$/u.test(plan.acceptedResearchArtifactFingerprint)
      ? plan.acceptedResearchArtifactFingerprint
      : null;
  const suppliedSourceNotePath =
    typeof plan.sourceNotePath === "string" && plan.sourceNotePath.trim()
      ? plan.sourceNotePath.trim()
      : null;
  return {
    suppliedArtifactFingerprint,
    suppliedSourceNotePath,
    initiative: parseHierarchyItem(plan.initiative, "initiative"),
    project: parseHierarchyItem(plan.project, "project"),
    issues: parseIssues(plan.issues),
  };
}

export function deriveResearchProjectPlanIdForAcceptedArtifact(
  artifactFingerprint: string,
): string {
  const fingerprint = requireFingerprint(
    artifactFingerprint,
    "accepted research artifact fingerprint",
  );
  return `research-plan-${fingerprint.slice("sha256:".length, "sha256:".length + 32)}`;
}

export function resolveCanonicalAcceptedResearchFingerprint(
  suppliedFingerprint: string | null,
  durableFingerprint: string,
): string {
  const durable = requireFingerprint(
    durableFingerprint,
    "durable accepted research artifact fingerprint",
  );
  if (suppliedFingerprint && suppliedFingerprint !== durable) {
    throw notApplied(
      "linear_hierarchy_accepted_research_mismatch",
      "The supplied accepted-research fingerprint conflicts with the durable note binding.",
    );
  }
  return durable;
}

export function resolveCanonicalAcceptedResearchNotePath(
  suppliedNotePath: string | null,
  durableNotePath: string,
): string {
  const durable = requireText(durableNotePath, "durable accepted research note path", 500);
  if (suppliedNotePath && suppliedNotePath !== durable) {
    throw notApplied(
      "linear_hierarchy_accepted_research_mismatch",
      "The supplied source note path conflicts with the durable accepted-research binding.",
    );
  }
  return durable;
}

export function selectAcceptedResearchBindingForCurrentMission(
  candidates: Array<{
    runId: string;
    artifactFingerprint: string;
    notePath: string;
  }>,
  input: {
    acceptedRunIds: ReadonlySet<string>;
    missionObjective: string;
  },
): { artifactFingerprint: string; notePath: string } | null {
  const exactRunMatches = candidates.filter((candidate) =>
    input.acceptedRunIds.has(candidate.runId),
  );
  const selected =
    exactRunMatches.length > 0
      ? exactRunMatches
      : candidates.filter(
          (candidate) =>
            candidate.notePath.length > 0 &&
            input.missionObjective.includes(candidate.notePath),
        );
  if (selected.length !== 1) return null;
  return {
    artifactFingerprint: selected[0].artifactFingerprint,
    notePath: selected[0].notePath,
  };
}

function parseHierarchyItem(value: unknown, label: string) {
  const item = expectRecord(value, label);
  return {
    key: requireLogicalKey(item.key, `${label} key`),
    title: canonicalizeHierarchyItemTitle(item, label),
    description: sanitizeHierarchyNarrative(
      requireText(item.description, `${label} description`, 8_000),
    ),
  };
}

export function canonicalizeHierarchyItemTitle(
  item: Record<string, unknown>,
  label: string,
): string {
  const title = typeof item.title === "string" ? item.title.trim() : "";
  const name = typeof item.name === "string" ? item.name.trim() : "";
  if (title && name && title !== name) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} title conflicts with its compatible name alias.`,
    );
  }
  return requireText(title || name, `${label} title`, 240);
}

function parseIssues(value: unknown) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      "Research project plan requires 1-20 issues.",
    );
  }
  return value.map((raw, index) => {
    const item = expectRecord(raw, `issue ${index + 1}`);
    const dependencyKeys = canonicalizeHierarchyDependencyKeys(
      item.dependencyKeys,
      index,
    );
    const acceptanceCriteria = canonicalizeHierarchyAcceptanceCriteria(
      item.acceptanceCriteria,
      index,
    );
    return {
      key: requireLogicalKey(item.key, `issue ${index + 1} key`),
      title: requireText(item.title, `issue ${index + 1} title`, 240),
      description: sanitizeHierarchyNarrative(
        requireText(item.description, `issue ${index + 1} description`, 8_000),
      ),
      dependencyKeys: dependencyKeys.map((key) =>
        requireLogicalKey(key, `issue ${index + 1} dependency key`),
      ),
      acceptanceCriteria: acceptanceCriteria.map((criterion) =>
        sanitizeHierarchyNarrative(
          requireText(
            criterion,
            `issue ${index + 1} acceptance criterion`,
            500,
          ),
        ),
      ),
    };
  });
}

/**
 * Model-authored Linear prose must never disclose a raw local host path. The
 * replacement is intentionally content-only; it grants no repository binding
 * or command authority. Vault-relative and repository-relative paths remain
 * intact because the issue needs durable Obsidian/code traceability.
 */
export function sanitizeHierarchyNarrative(value: string): string {
  return value
    .replace(/[A-Za-z]:[\\/][^,\r\n]+/gu, "[host-bound local path]")
    .replace(/\\\\[^,\r\n]+/gu, "[host-bound local path]")
    .replace(
      /(^|[\s(])\/(?:etc|home|Users|var|tmp|opt|root|mnt|srv)\/[^,\r\n]+/gimu,
      "$1[host-bound local path]",
    )
    .trim();
}

export function deriveResearchProjectWorkItemFingerprint(input: {
  acceptedResearchArtifactFingerprint: string;
  key: string;
  title: string;
  description: string;
  dependencyKeys: unknown[];
  acceptanceCriteria: unknown[];
}): string {
  return fingerprintContract({
    version: 1,
    acceptedResearchArtifactFingerprint: requireFingerprint(
      input.acceptedResearchArtifactFingerprint,
      "accepted research artifact fingerprint",
    ),
    key: requireLogicalKey(input.key, "work item key"),
    title: requireText(input.title, "work item title", 240),
    description: requireText(input.description, "work item description", 8_000),
    dependencyKeys: input.dependencyKeys.map((value, index) =>
      requireLogicalKey(value, `work item dependency ${index + 1}`),
    ),
    acceptanceCriteria: input.acceptanceCriteria.map((value, index) =>
      requireText(value, `work item acceptance criterion ${index + 1}`, 500),
    ),
  });
}

export function canonicalizeHierarchyDependencyKeys(
  value: unknown,
  issueIndex = 0,
): unknown[] {
  if (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    return [value];
  }
  throw notApplied(
    "linear_hierarchy_invalid_arguments",
    `Issue ${issueIndex + 1} dependencyKeys must be an array or one logical issue key.`,
  );
}

export function canonicalizeHierarchyAcceptanceCriteria(
  value: unknown,
  issueIndex = 0,
): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((criterion) => {
    if (typeof criterion === "string") {
      return criterion;
    }
    const record = expectRecord(
      criterion,
      `issue ${issueIndex + 1} acceptance criterion`,
    );
    const keys = Object.keys(record).sort();
    if (
      !keys.every((key) => key === "id" || key === "text") ||
      !keys.includes("text")
    ) {
      throw notApplied(
        "linear_hierarchy_invalid_arguments",
        `Issue ${issueIndex + 1} acceptance criterion object may contain only id and text.`,
      );
    }
    return record.text;
  });
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} must be an object.`,
    );
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} must contain 1-${maximum} characters.`,
    );
  }
  return text;
}

function requireIdentity(value: unknown, label: string): string {
  return requireText(value, label, 256);
}

function requireLogicalKey(value: unknown, label: string): string {
  const key = requireText(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(key)) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} must be a logical key.`,
    );
  }
  return key;
}

function requireFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} must be a SHA-256 fingerprint.`,
    );
  }
  return value;
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

const RESEARCH_PROJECT_HIERARCHY_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  capability: {
    system: "linear",
    resourceType: "project_hierarchy",
    action: "publish",
  },
  effect: "publish",
  risk: "high",
  approval: {
    allowPromptGrant: false,
    allowPersistentGrant: false,
    fallback: "exact",
  },
  execution: {
    preparation: "none",
    cacheable: false,
    parallelSafe: false,
  },
  durability: {
    journal: true,
    receipt: true,
    readback: "required",
    reconciliation: "required",
  },
  allowedPrincipals: ["single_agent"],
  receiptKind: "external_action",
  operationGoals: ["linear_research_project_hierarchy"],
};

const STRING: JsonSchemaObject = { type: "string" };
const HIERARCHY_ITEM: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    key: STRING,
    title: STRING,
    name: {
      type: "string",
      description:
        "Optional provider-compatibility alias for title; omit it when title is present.",
    },
    description: STRING,
  },
  required: ["key", "title", "description"],
};
const RESEARCH_PROJECT_HIERARCHY_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    plan: {
      type: "object",
      additionalProperties: false,
      properties: {
        planId: {
          type: "string",
          description:
            "Optional compatibility field. The host derives the canonical plan identity from the accepted research artifact fingerprint.",
        },
        acceptedResearchArtifactFingerprint: {
          type: "string",
          description:
            "Optional compatibility field. The host resolves the accepted artifact fingerprint from the durable source-note binding and rejects a conflicting valid fingerprint.",
        },
        sourceNotePath: {
          type: "string",
          description:
            "Optional compatibility field. The host resolves the canonical note path from the current run's durable accepted-research lineage and rejects a conflicting nonempty path.",
        },
        initiative: HIERARCHY_ITEM,
        project: HIERARCHY_ITEM,
        issues: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              key: STRING,
              title: STRING,
              description: STRING,
              dependencyKeys: { type: "array", items: STRING, maxItems: 19 },
              acceptanceCriteria: { type: "array", items: STRING, minItems: 1, maxItems: 20 },
              workItemFingerprint: {
                type: "string",
                description:
                  "Deprecated compatibility field. The host derives the stable work-item fingerprint from the accepted research binding and canonical issue content.",
              },
            },
            required: [
              "key", "title", "description", "dependencyKeys",
              "acceptanceCriteria",
            ],
          },
        },
      },
      required: [
        "initiative", "project", "issues",
      ],
    },
  },
  required: ["plan"],
};
