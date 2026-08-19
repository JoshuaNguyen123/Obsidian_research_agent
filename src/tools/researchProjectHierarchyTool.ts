import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
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
  detectProjectLifecycleStagesV1,
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
import type { AgentTool, ToolExecutionContext } from "./types";
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

/**
 * Host-owned accepted-research bytes. The model may narrow the note path or
 * artifact fingerprint, but it cannot supply or replace this binding.
 */
export interface AcceptedResearchHierarchyBindingV1 {
  artifactFingerprint: string;
  notePath: string;
  noteSha256: string;
  noteContent: string;
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
  }): Promise<AcceptedResearchHierarchyBindingV1 | null>;
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
    context: ToolExecutionContext;
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
      assertExecutableDeveloperMissionUsesOneDeliveryIssue(
        context.originalPrompt,
        planInput.issues.length,
      );
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
      assertAcceptedResearchBindingMatchesBytes(acceptedResearchBinding);
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
        assertResearchProjectPlanSemanticallyBoundToAcceptedNote(
          plan,
          acceptedResearchBinding.noteContent,
        );
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
          context,
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
    /\bcreate\b[\s\S]{0,80}\bproject\b[\s\S]{0,80}\bend[- ]to[- ]end\b/iu.test(text) ||
    /\b(?:research|investigate|study|analy[sz]e)\b[\s\S]{0,280}\b(?:create|turn|convert|shape|break|translate|organize|plan)\b[\s\S]{0,160}\b(?:findings|research|design|results?|measurable|actionable|scoped|delivery)?\b[\s\S]{0,80}\blinear\s+(?:work|tasks?|issues?|project|plan)\b/iu.test(text)
  );
}

/**
 * The current foreground code pipeline produces one verified commit/validation
 * bundle. It can truthfully close one Linear delivery ticket with a measurable
 * acceptance checklist, but it cannot attribute that aggregate bundle across
 * several independently completable child tickets. Standalone hierarchy work
 * remains capable of creating 1-20 issues; only a joined six-stage developer
 * mission is narrowed here.
 */
export function assertExecutableDeveloperMissionUsesOneDeliveryIssue(
  prompt: string,
  issueCount: number,
): void {
  const stages = new Set(detectProjectLifecycleStagesV1(prompt));
  const joinedStages = [
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
  ] as const;
  const joinedExecution = joinedStages.every((stage) => stages.has(stage));
  if (joinedExecution && issueCount !== 1) {
    throw notApplied(
      "linear_hierarchy_autonomous_delivery_unit_required",
      "A joined Research-to-Results developer mission currently requires exactly one Linear delivery issue. Put the measurable units into that issue's acceptanceCriteria; create a multi-issue hierarchy independently when each child will be implemented and verified in a separate run.",
    );
  }
}

export async function buildGroupedApprovalAction(
  request: ResearchProjectHierarchyApprovalRequestV1,
  nowProvider?: () => Date,
): Promise<PreparedAction> {
  const preparedAt = (nowProvider?.() ?? new Date()).toISOString();
  const actionFingerprints = request.preparedActions.map(
    (action) => action.payloadFingerprint,
  );
  const inspectablePreparedActions: JsonValue[] = request.preparedActions.map(
    (action): JsonValue => ({
      toolName: action.toolName,
      target: JSON.parse(JSON.stringify(action.target)) as JsonValue,
      payloadFingerprint: action.payloadFingerprint,
      preview: {
        summary: action.preview.summary,
        destination: action.preview.destination,
        // Child previews are produced by the host adapter from its validated
        // provider payload. Including the exact bounded payload lets the user
        // inspect titles, descriptions, and relation endpoints instead of
        // approving an opaque list of hashes.
        outboundPayload:
          action.preview.outboundPayload ?? action.normalizedArgs,
      },
    }),
  );
  const inspectableDeduplicatedResources: JsonValue[] =
    request.deduplicatedResources.map((item): JsonValue => ({
      key: item.key,
      kind: item.kind,
      resourceId: item.resourceId,
      readbackFingerprint: item.readbackFingerprint,
      snapshot: {
        resourceType: item.snapshot.resourceType,
        name: item.snapshot.name,
        title: item.snapshot.title,
        description: item.snapshot.description,
        relationType: item.snapshot.relationType,
        teamIds: item.snapshot.teamIds,
        projectIds: item.snapshot.projectIds,
        relationEndpoints: item.snapshot.relationEndpoints,
      },
    }));
  const outboundPayload: Record<string, JsonValue> = {
    planFingerprint: request.planFingerprint,
    approvalFingerprint: request.approvalFingerprint,
    actionFingerprints,
    preparedActions: inspectablePreparedActions,
    deduplicatedResources: inspectableDeduplicatedResources,
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
      outboundBytes: new TextEncoder().encode(JSON.stringify(outboundPayload)).byteLength,
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
  candidates: AcceptedResearchHierarchyBindingCandidateV1[],
  input: {
    acceptedRunIds: ReadonlySet<string>;
    missionObjective: string;
  },
): AcceptedResearchHierarchyBindingV1 | null {
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
    noteSha256: selected[0].noteSha256,
    noteContent: selected[0].noteContent,
  };
}

export interface AcceptedResearchHierarchyBindingCandidateV1 {
  runId: string;
  artifactFingerprint: string;
  notePath: string;
  noteSha256: string;
  noteContent: string;
}

const MAX_ACCEPTED_RESEARCH_NOTE_CHARS = 250_000;
const SEMANTIC_STOP_WORDS = new Set([
  "accepted", "acceptance", "against", "also", "because", "before", "build",
  "completion", "create", "deliver", "description", "evidence", "from", "have",
  "implementation", "initiative", "issue", "must", "note", "project", "proposed",
  "research", "scope", "should", "that", "their", "these", "this", "through",
  "validation", "verified", "with", "work",
]);

/** Verify that the selected note still contains the exact host-accepted bytes. */
export function assertAcceptedResearchBindingMatchesBytes(
  binding: AcceptedResearchHierarchyBindingV1,
): void {
  requireFingerprint(binding.artifactFingerprint, "accepted research artifact fingerprint");
  requireText(binding.notePath, "accepted research note path", 500);
  const expected = requireFingerprint(binding.noteSha256, "accepted research note hash");
  if (
    typeof binding.noteContent !== "string" ||
    binding.noteContent.length < 1 ||
    binding.noteContent.length > MAX_ACCEPTED_RESEARCH_NOTE_CHARS
  ) {
    throw notApplied(
      "linear_hierarchy_accepted_research_bytes_required",
      "The exact bounded bytes of the host-accepted research note are unavailable.",
    );
  }
  const observed = `sha256:${portableSha256Text(binding.noteContent)}`;
  if (observed !== expected) {
    throw notApplied(
      "linear_hierarchy_accepted_research_drift",
      "The accepted research note changed after host acceptance; re-accept the current note before publishing to Linear.",
    );
  }
}

/**
 * Local, deterministic relevance gate. Every issue must retain at least one
 * distinctive term from the exact accepted note, and the hierarchy as a whole
 * must retain multiple anchors. This is deliberately a fail-closed lexical
 * gate, not an embedding or model judgment.
 */
export function assertResearchProjectPlanSemanticallyBoundToAcceptedNote(
  plan: ReturnType<typeof createResearchProjectPlanV1>,
  acceptedNoteContent: string,
): void {
  const noteTerms = semanticTerms(acceptedNoteContent);
  if (noteTerms.size < 2) {
    throw notApplied(
      "linear_hierarchy_accepted_research_digest_insufficient",
      "The accepted research note does not contain enough distinctive content to validate a Linear hierarchy.",
    );
  }
  const overviewTerms = semanticTerms([
    plan.initiative.title,
    plan.initiative.description,
    plan.project.title,
    plan.project.description,
  ].join("\n"));
  if (sharedTerms(overviewTerms, noteTerms).size < 1) {
    throwSemanticMismatch("The Linear initiative/project does not retain a distinctive anchor from the accepted research note.");
  }

  const allPlanTerms = new Set(overviewTerms);
  for (const issue of plan.issues) {
    const issueTerms = semanticTerms([
      issue.title,
      issue.description,
      issue.problemImpact ?? "",
      issue.confidenceLimitations ?? "",
      ...(issue.proposedWork ?? []),
      ...(issue.nonGoals ?? []),
      ...(issue.scope ?? []),
      ...issue.acceptanceCriteria,
      ...(issue.validation ?? []),
    ].join("\n"));
    for (const term of issueTerms) allPlanTerms.add(term);
    if (sharedTerms(issueTerms, noteTerms).size < 1) {
      throwSemanticMismatch(
        `Linear issue ${issue.key} is not semantically bound to the accepted research note.`,
      );
    }
  }
  const requiredOverallAnchors = Math.min(3, noteTerms.size);
  if (sharedTerms(allPlanTerms, noteTerms).size < requiredOverallAnchors) {
    throwSemanticMismatch(
      `The Linear hierarchy must retain at least ${requiredOverallAnchors} distinctive accepted-research anchors.`,
    );
  }
}

function semanticTerms(value: string): Set<string> {
  const withoutMachineNoise = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/<!--[^]*?-->/gu, " ")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/sha256:[a-f0-9]{64}/gu, " ");
  const terms = withoutMachineNoise.match(/[\p{L}\p{N}][\p{L}\p{N}_-]{3,}/gu) ?? [];
  return new Set(
    terms.filter((term) =>
      !SEMANTIC_STOP_WORDS.has(term) &&
      !/^\d+$/u.test(term) &&
      !/^[a-f0-9]{32,}$/u.test(term),
    ),
  );
}

function sharedTerms(left: ReadonlySet<string>, right: ReadonlySet<string>): Set<string> {
  return new Set([...left].filter((term) => right.has(term)));
}

function throwSemanticMismatch(message: string): never {
  throw notApplied("linear_hierarchy_research_semantic_mismatch", message);
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
      ...optionalIssueNarrative(item.problemImpact, `issue ${index + 1} problemImpact`, "problemImpact"),
      ...optionalIssueNarrative(
        item.confidenceLimitations,
        `issue ${index + 1} confidenceLimitations`,
        "confidenceLimitations",
      ),
      ...optionalIssueNarrativeList(item.proposedWork, `issue ${index + 1} proposedWork`, "proposedWork"),
      ...optionalIssueNarrativeList(item.nonGoals, `issue ${index + 1} nonGoals`, "nonGoals"),
      ...optionalIssueNarrativeList(item.scope, `issue ${index + 1} scope`, "scope"),
      ...optionalIssueNarrativeList(item.validation, `issue ${index + 1} validation`, "validation"),
    };
  });
}

/** Absent optional sections stay absent; the host renders their empty state. */
function isAbsentOptionalSection(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function optionalIssueNarrative(
  value: unknown,
  label: string,
  key: string,
): Record<string, string> {
  if (isAbsentOptionalSection(value)) return {};
  return { [key]: sanitizeHierarchyNarrative(requireText(value, label, 8_000)) };
}

/** Tolerate a scalar where the schema asks for a list, as the sibling canonicalizers do. */
function optionalIssueNarrativeList(
  value: unknown,
  label: string,
  key: string,
): Record<string, string[]> {
  if (isAbsentOptionalSection(value)) return {};
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 20) {
    throw notApplied(
      "linear_hierarchy_invalid_arguments",
      `${label} accepts at most 20 entries.`,
    );
  }
  return {
    [key]: entries.map((entry, entryIndex) =>
      sanitizeHierarchyNarrative(
        requireText(entry, `${label} ${entryIndex + 1}`, 1_000),
      ),
    ),
  };
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
              problemImpact: {
                type: "string",
                description:
                  "Optional. Problem and impact prose; defaults to description.",
              },
              confidenceLimitations: {
                type: "string",
                description: "Optional. Confidence and known limitations.",
              },
              proposedWork: {
                type: "array",
                items: STRING,
                maxItems: 20,
                description: "Optional. Proposed work items; defaults to description.",
              },
              nonGoals: { type: "array", items: STRING, maxItems: 20 },
              scope: { type: "array", items: STRING, maxItems: 20 },
              validation: {
                type: "array",
                items: STRING,
                maxItems: 20,
                description: "Optional. How completion is validated.",
              },
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
