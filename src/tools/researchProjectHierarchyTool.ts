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
  validateAcceptedResearchBinding(input: {
    artifactFingerprint: string;
    notePath: string;
  }): Promise<boolean>;
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
          "Linear hierarchy publication requires a verified gate-3 Linear connection and destination.",
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
      const plan = createResearchProjectPlanV1({
        ...planInput,
        runId,
        destination: options.destination,
        createdAt: (options.now ?? context.now ?? (() => new Date()))().toISOString(),
      });
      if (!(await options.validateAcceptedResearchBinding({
        artifactFingerprint: plan.acceptedResearchArtifactFingerprint,
        notePath: plan.sourceNotePath,
      }))) {
        throw notApplied(
          "linear_hierarchy_accepted_research_required",
          "The project plan is not bound to a host-accepted research artifact at the supplied note path.",
        );
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
  return {
    planId: requireLogicalKey(plan.planId, "plan id"),
    acceptedResearchArtifactFingerprint: requireFingerprint(
      plan.acceptedResearchArtifactFingerprint,
      "accepted research artifact fingerprint",
    ),
    sourceNotePath: requireText(plan.sourceNotePath, "source note path", 500),
    initiative: parseHierarchyItem(plan.initiative, "initiative"),
    project: parseHierarchyItem(plan.project, "project"),
    issues: parseIssues(plan.issues),
  };
}

function parseHierarchyItem(value: unknown, label: string) {
  const item = expectRecord(value, label);
  return {
    key: requireLogicalKey(item.key, `${label} key`),
    title: requireText(item.title, `${label} title`, 240),
    description: requireText(item.description, `${label} description`, 8_000),
  };
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
    if (!Array.isArray(item.dependencyKeys) || !Array.isArray(item.acceptanceCriteria)) {
      throw notApplied(
        "linear_hierarchy_invalid_arguments",
        `Issue ${index + 1} dependencyKeys and acceptanceCriteria must be arrays.`,
      );
    }
    return {
      key: requireLogicalKey(item.key, `issue ${index + 1} key`),
      title: requireText(item.title, `issue ${index + 1} title`, 240),
      description: requireText(item.description, `issue ${index + 1} description`, 8_000),
      dependencyKeys: item.dependencyKeys.map((key) =>
        requireLogicalKey(key, `issue ${index + 1} dependency key`),
      ),
      acceptanceCriteria: item.acceptanceCriteria.map((criterion) =>
        requireText(criterion, `issue ${index + 1} acceptance criterion`, 500),
      ),
      workItemFingerprint: requireFingerprint(
        item.workItemFingerprint,
        `issue ${index + 1} work item fingerprint`,
      ),
    };
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
  properties: { key: STRING, title: STRING, description: STRING },
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
        planId: STRING,
        acceptedResearchArtifactFingerprint: STRING,
        sourceNotePath: STRING,
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
              workItemFingerprint: STRING,
            },
            required: [
              "key", "title", "description", "dependencyKeys",
              "acceptanceCriteria", "workItemFingerprint",
            ],
          },
        },
      },
      required: [
        "planId", "acceptedResearchArtifactFingerprint", "sourceNotePath",
        "initiative", "project", "issues",
      ],
    },
  },
  required: ["plan"],
};
