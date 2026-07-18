import {
  sha256Fingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type JsonValue,
  type PreparedAction,
  type PreparedActionInput,
  type ToolDescriptor,
} from "../agent/actions";
import type { JsonSchemaObject } from "../model/types";
import type { AuthorityGrantV1 } from "../agent/authority";
import {
  ResearchPublicationWorkflow,
  type AcceptedResearchArtifactV1,
  type AcceptedResearchNotePackageV1,
  type AcceptedResearchNoteWriteRequestV1,
  type ResearchPublicationDestinationV1,
  type ResearchPublicationExactApprovalRequestV1,
  type ResearchPublicationLineagePortV1,
  type ResearchPublicationPublisherPortV1,
} from "../integrations/linear";
import { AcceptedResearchNoteWriter } from "../integrations/linear";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME = "publish_research_to_linear";

export interface ResearchPublicationGrantInputV1 {
  runId: string;
  approvalId: string;
  destination: ResearchPublicationDestinationV1;
}

export interface CreateResearchPublicationToolOptionsV1 {
  noteWriter: Pick<AcceptedResearchNoteWriter, "writeAcceptedPackage" | "appendLinearBacklink">;
  publisher: ResearchPublicationPublisherPortV1;
  lineage: ResearchPublicationLineagePortV1;
  destination: ResearchPublicationDestinationV1;
  vaultBindingKey: string;
  resolveNotePath(input: {
    requestedPath?: string;
    originalPrompt: string;
    runId: string;
  }): string;
  validateTrustedBindings(package_: AcceptedResearchNotePackageV1): void;
  mintOneActionGrant(input: ResearchPublicationGrantInputV1): Promise<AuthorityGrantV1>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  persistAcceptedProjectLineage?(input: {
    artifact: AcceptedResearchArtifactV1;
    package: AcceptedResearchNotePackageV1;
  }): Promise<void>;
  loadDurableWebEvidence?(runId: string): Promise<readonly {
    url: string;
    contentHash: string;
    usableSource: boolean;
    title?: string;
    summary?: string;
    parserStatus?: string;
  }[]>;
  isAvailable?: () => boolean;
  now?: () => Date;
}

export function createResearchPublicationTool(
  options: CreateResearchPublicationToolOptionsV1,
): AgentTool {
  const tool: AgentTool = {
    name: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
    description:
      "Write a host-accepted research package to an Obsidian note, show an exact Linear preview for approval, create or reuse the issue, verify readback, persist lineage, and append the backlink. Use only when the user explicitly asks to publish or send accepted research to Linear.",
    parameters: RESEARCH_PUBLICATION_PARAMETERS,
    descriptor: RESEARCH_PUBLICATION_DESCRIPTOR,
    async execute(args, context) {
      if (options.isAvailable?.() === false) {
        throw new ToolExecutionError(
          "research_publication_unavailable",
          "Research publication is unavailable because the integrations extension, credential, or discovered Linear destination is no longer available.",
          { mutationState: "not_applied" },
        );
      }
      if (!hasExplicitResearchPublicationIntent(context.originalPrompt)) {
        throw new ToolExecutionError(
          "research_publication_explicit_user_mission_required",
          "Publishing research to Linear requires an explicit user mission naming Linear publication.",
          { mutationState: "not_applied" },
        );
      }
      const runId = requireIdentity(context.runId, "run id");
      const toolCallId = requireIdentity(context.operationId, "tool call id");
      if (
        options.loadDurableWebEvidence &&
        !hasTrustedWebEvidence(context.runtimeCache)
      ) {
        seedDurableWebEvidence(
          context.runtimeCache,
          await options.loadDurableWebEvidence(runId),
        );
      }
      const parsedNote = await parseToolArguments({
        value: args,
        runId,
        toolCallId,
        originalPrompt: context.originalPrompt,
        vaultBindingKey: options.vaultBindingKey,
        runtimeCache: context.runtimeCache,
        resolveNotePath: options.resolveNotePath,
        validateTrustedBindings: options.validateTrustedBindings,
        nowProvider: options.now ?? context.now,
      });
      const note = stabilizeAcceptedResearchRequest(
        parsedNote,
        context.runtimeCache,
        runId,
      );
      if (!context.requestNestedApproval) {
        throw new ToolExecutionError(
          "research_publication_approval_unavailable",
          "The host approval surface is unavailable for this research publication.",
          { mutationState: "not_applied" },
        );
      }
      const workflow = new ResearchPublicationWorkflow({
        noteWriter: options.noteWriter,
        publisher: options.publisher,
        lineage: options.lineage,
        now: options.now ?? context.now,
        approval: {
          requestExactApproval: async (request) => {
            const action = await buildApprovalPreparedAction(
              request,
              options.now ?? context.now,
            );
            const decision = await context.requestNestedApproval!({
              toolName: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
              action:
                request.proposedAction === "create"
                  ? `Create Linear issue in ${formatLinearDestination(request.destination)}: ${request.title}`
                  : `Reuse verified duplicate Linear issue: ${request.duplicate?.identifier ?? request.title}`,
              reason:
                "Approve the exact research note hash, Linear destination, title, description, machine contract, and duplicate decision shown below.",
              policyTags: [
                "linear_research_publication",
                "exact_preview",
                request.proposedAction,
              ],
              preparedAction: action,
              timeoutMs: 120_000,
              confirmationIndex: 1,
              requiredConfirmations: 1,
            });
            if (!decision.approved) {
              return { approved: false, reason: decision.reason };
            }
            if (decision.approvalFingerprint !== action.payloadFingerprint) {
              return { approved: false, reason: "Approval fingerprint mismatch." };
            }
            if (request.proposedAction === "reuse_duplicate") {
              return {
                approved: true,
                approvalId: decision.approvalId,
                approvalFingerprint: request.approvalFingerprint,
              };
            }
            const grant = await options.mintOneActionGrant({
              runId,
              approvalId: decision.approvalId,
              destination: request.destination,
            });
            return {
              approved: true,
              approvalId: decision.approvalId,
              approvalFingerprint: request.approvalFingerprint,
              activeGrants: [grant],
              preferredGrantId: grant.id,
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
        note,
        destination: options.destination,
      });
      if ("artifact" in result) {
        await options.persistAcceptedProjectLineage?.({
          artifact: result.artifact,
          package: note.package,
        });
      }
      if (!result.ok && result.status !== "waiting_obsidian") {
        throw new ToolExecutionError(
          result.status === "denied" ? "approval_denied" : result.error.code,
          result.error.message,
          {
            mutationState:
              result.status === "reconcile_required"
                ? "may_have_applied"
                : "not_applied",
          },
        );
      }
      return result;
    },
  };
  tool.executeResult = async (args, context) => {
    const output = await tool.execute(args, context) as Awaited<
      ReturnType<ResearchPublicationWorkflow["execute"]>
    >;
    let receipt: ActionReceipt | undefined;
    if ((output.ok && output.status === "complete") || output.status === "waiting_obsidian") {
      receipt = output.receipt ?? createDeduplicatedReadbackReceipt(output);
      await options.persistExternalReceipt(receipt);
    }
    return {
      ok: true,
      toolName: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
      output,
      ...(receipt ? { receipt, mutationState: "applied" as const } : {}),
    };
  };
  return tool;
}

export function hasExplicitResearchPublicationIntent(prompt: string): boolean {
  const normalized = typeof prompt === "string" ? prompt : "";
  return (
    /\b(?:publish|send|create|post|sync|file|open)\b[\s\S]{0,120}\b(?:research|findings|report|note|ticket|issue)\b[\s\S]{0,120}\b(?:to|in|on)\s+linear\b/iu.test(normalized) ||
    /\b(?:research|findings|report|note)\b[\s\S]{0,120}\b(?:publish|send|create|post|sync)\b[\s\S]{0,120}\blinear\b/iu.test(normalized)
  );
}

async function parseToolArguments(input: {
  value: Record<string, unknown>;
  runId: string;
  toolCallId: string;
  originalPrompt: string;
  vaultBindingKey: string;
  runtimeCache: ToolExecutionContext["runtimeCache"];
  resolveNotePath: CreateResearchPublicationToolOptionsV1["resolveNotePath"];
  validateTrustedBindings: CreateResearchPublicationToolOptionsV1["validateTrustedBindings"];
  nowProvider?: () => Date;
}) {
  const { value, runId } = input;
  assertExactKeys(value, ["mode", "package"], ["notePath", "baseHash"]);
  const packageRecord = expectRecord(value.package, "accepted research package");
  assertExactKeys(
    packageRecord,
    [
      "schemaVersion",
      "title",
      "problemImpact",
      "evidence",
      "confidenceLimitations",
      "proposedWork",
      "nonGoals",
      "scope",
      "dependencies",
      "acceptanceCriteria",
      "validationRequirementKeys",
      "riskClass",
      "executionClass",
      "objective",
    ],
    ["repositoryKey"],
  );
  if (
    typeof packageRecord.schemaVersion === "string" &&
    /^(?:v(?:ersion)?[-_ ]*)?1(?:\.0)?$/iu.test(
      packageRecord.schemaVersion.trim(),
    )
  ) {
    packageRecord.schemaVersion = 1;
  }
  packageRecord.riskClass = canonicalizeRiskClass(packageRecord.riskClass);
  packageRecord.executionClass = canonicalizeExecutionClass(
    packageRecord.executionClass,
  );
  if (packageRecord.schemaVersion !== 1) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `The accepted research package must use schema version 1 (received ${describeRedactedValueShape(packageRecord.schemaVersion)}).`,
      { mutationState: "not_applied" },
    );
  }
  if (
    packageRecord.repositoryKey !== undefined &&
    packageRecord.executionClass !== "code"
  ) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      "A package with repositoryKey must use executionClass code.",
      { mutationState: "not_applied" },
    );
  }
  if (
    packageRecord.executionClass === "code" &&
    packageRecord.repositoryKey === undefined
  ) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      "A package with executionClass code must include the trusted repositoryKey named by the mission.",
      { mutationState: "not_applied" },
    );
  }
  hydrateTrustedWebEvidence(packageRecord, input.runtimeCache);
  canonicalizePackageIdentifiers(packageRecord);
  if (value.mode !== "create" && value.mode !== "append") {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      "Research note mode must be create or append.",
      { mutationState: "not_applied" },
    );
  }
  const mode: "create" | "append" = value.mode;
  const baseHash =
    typeof value.baseHash === "string" &&
    value.baseHash.trim() === ""
      ? undefined
      : value.baseHash;
  if (mode === "append" && typeof baseHash !== "string") {
    throw new ToolExecutionError(
      "research_publication_base_hash_required",
      "Appending an accepted research package requires the current note SHA-256 hash.",
      { mutationState: "not_applied" },
    );
  }
  const acceptedAt = canonicalNow(input.nowProvider);
  const requestedPath = value.notePath === undefined
    ? undefined
    : requireText(value.notePath, "note path", 1_000);
  if (mode === "append" && !requestedPath) {
    throw new ToolExecutionError(
      "research_publication_note_path_required",
      "Appending requires a vault-safe Markdown path explicitly present in the user mission.",
      { mutationState: "not_applied" },
    );
  }
  const package_ = {
    ...packageRecord,
    vaultBindingKey: requireLogicalKey(input.vaultBindingKey, "host vault binding key"),
    originRunId: runId,
  } as unknown as AcceptedResearchNotePackageV1;
  input.validateTrustedBindings(package_);
  const path = input.resolveNotePath({
    ...(requestedPath ? { requestedPath } : {}),
    originalPrompt: input.originalPrompt,
    runId,
  });
  const artifactIdentity = await sha256Fingerprint({
    schemaVersion: 1,
    kind: "accepted_research_publication",
    runId,
    path,
  });
  return {
    path,
    mode,
    ...(typeof baseHash === "string"
      ? { baseHash: requireSha256(baseHash, "base hash") }
      : {}),
    artifactId: `accepted-${artifactIdentity.slice("sha256:".length, 39)}`,
    acceptedAt,
    package: package_,
  };
}

function canonicalizeRiskClass(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const match = /^(?:risk[-_ ]*)?(low|medium|high)(?:[-_ ]*risk)?$/iu.exec(
    value.trim(),
  );
  return match?.[1]?.toLowerCase() ?? value;
}

function canonicalizeExecutionClass(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const match = /^(research|vault|code|human)(?:[-_ ]*(?:work|execution))?$/iu.exec(
    value.trim(),
  );
  return match?.[1]?.toLowerCase() ?? value;
}

function stabilizeAcceptedResearchRequest(
  candidate: AcceptedResearchNoteWriteRequestV1,
  runtimeCache: ToolExecutionContext["runtimeCache"],
  runId: string,
): AcceptedResearchNoteWriteRequestV1 {
  if (!runtimeCache) return cloneAcceptedResearchRequest(candidate);
  runtimeCache.acceptedResearchPublicationRequests ??= new Map<string, unknown>();
  const key = `${runId}:${candidate.path}`;
  const stored = runtimeCache.acceptedResearchPublicationRequests.get(key);
  if (stored) {
    return cloneAcceptedResearchRequest(
      stored as AcceptedResearchNoteWriteRequestV1,
    );
  }
  const canonical = cloneAcceptedResearchRequest(candidate);
  runtimeCache.acceptedResearchPublicationRequests.set(
    key,
    cloneAcceptedResearchRequest(canonical),
  );
  return canonical;
}

function cloneAcceptedResearchRequest(
  value: AcceptedResearchNoteWriteRequestV1,
): AcceptedResearchNoteWriteRequestV1 {
  return structuredClone(value);
}

async function buildApprovalPreparedAction(
  request: ResearchPublicationExactApprovalRequestV1,
  nowProvider?: () => Date,
): Promise<PreparedAction> {
  const preparedAt = canonicalNow(nowProvider);
  const duplicateCandidates = request.duplicate
    ? [{
        system: "linear" as const,
        resourceType: "issue",
        id: request.duplicate.id,
        identifier: request.duplicate.identifier,
        url: request.duplicate.url,
        workspaceId: request.destination.workspaceId,
        teamId: request.destination.teamId,
        ...(request.destination.projectId
          ? { projectId: request.destination.projectId }
          : {}),
      }]
    : [];
  const outboundPayload: Record<string, JsonValue> = {
    proposedAction: request.proposedAction,
    title: request.title,
    description: request.description,
    artifactFingerprint: request.artifactFingerprint,
    noteSha256: request.noteSha256,
    workItemFingerprint: request.workItemFingerprint,
  };
  const outboundBytes = new TextEncoder().encode(
    `${request.title}\n${request.description}`,
  ).byteLength;
  const action: PreparedActionInput = {
    version: 1,
    id: `research-publication-preview-${request.approvalFingerprint.slice(7, 31)}`,
    runId: request.runId,
    toolCallId: request.toolCallId,
    toolName: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
    target: {
      system: "linear",
      resourceType: "issue",
      id: request.duplicate?.id ?? `pending-${request.workItemFingerprint.slice(7, 31)}`,
      ...(request.duplicate?.identifier
        ? { identifier: request.duplicate.identifier }
        : {}),
      ...(request.duplicate?.url ? { url: request.duplicate.url } : {}),
      workspaceId: request.destination.workspaceId,
      teamId: request.destination.teamId,
      ...(request.destination.projectId
        ? { projectId: request.destination.projectId }
        : {}),
    },
    relatedResources: [],
    normalizedArgs: {
      approvalFingerprint: request.approvalFingerprint,
      artifactFingerprint: request.artifactFingerprint,
      noteSha256: request.noteSha256,
      workItemFingerprint: request.workItemFingerprint,
      proposedAction: request.proposedAction,
    },
    preview: {
      summary:
        request.proposedAction === "create"
          ? `Create Linear issue: ${request.title}`
          : `Reuse Linear issue: ${request.duplicate?.identifier ?? request.title}`,
      destination:
        `Linear workspace=${request.destination.workspaceId} ` +
        `team=${request.destination.teamId} project=${request.destination.projectId ?? "none"}`,
      outboundPayload,
      duplicateCandidates,
      warnings: request.proposedAction === "reuse_duplicate"
        ? ["No Linear mutation or authority grant will be created for this exact duplicate."]
        : [],
      outboundBytes,
    },
    idempotencyKey: `research-publication:${request.workItemFingerprint}`,
    reconciliationKey: `linear-research-publication:${request.workItemFingerprint}`,
    preparedAt,
    expiresAt: new Date(Date.parse(preparedAt) + 120_000).toISOString(),
    requiredConfirmations: 1,
  };
  return withPreparedActionFingerprint(action);
}

function formatLinearDestination(
  destination: ResearchPublicationDestinationV1,
): string {
  return destination.projectId
    ? `${destination.teamId}/${destination.projectId}`
    : destination.teamId;
}

function createDeduplicatedReadbackReceipt(output: {
  artifact: { originRunId: string };
  approvalFingerprint: string;
  binding: {
    verifiedAt: string;
    workItemFingerprint: string;
  };
  issue: {
    id: string;
    identifier: string;
    url: string;
    updatedAt?: string;
    snapshotHash: string;
    team: { id: string };
    project?: { id: string };
  };
}): ActionReceipt {
  const startedAt = output.issue.updatedAt ?? output.binding.verifiedAt;
  return {
    version: 1,
    id: `linear-research-readback-${output.issue.id}`,
    runId: output.artifact.originRunId,
    actionId: `linear-readback-${output.issue.id}`,
    toolName: "linear_read_issue",
    operation: "read",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: output.issue.id,
      identifier: output.issue.identifier,
      url: output.issue.url,
      teamId: output.issue.team.id,
      ...(output.issue.project?.id ? { projectId: output.issue.project.id } : {}),
      ...(output.issue.updatedAt ? { revision: output.issue.updatedAt } : {}),
    },
    message: `Verified exact duplicate Linear issue ${output.issue.identifier}; no mutation grant was created or consumed.`,
    payloadFingerprint: output.approvalFingerprint,
    grantId: "linear-deduplicated-readback",
    idempotencyKey: `research-publication:${output.binding.workItemFingerprint}`,
    startedAt,
    committedAt: output.binding.verifiedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: output.binding.verifiedAt,
      ...(output.issue.updatedAt ? { observedRevision: output.issue.updatedAt } : {}),
      observedFingerprint: output.issue.snapshotHash,
    },
  };
}

const RESEARCH_PUBLICATION_DESCRIPTOR: ToolDescriptor = {
  version: 1,
  name: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  capability: { system: "linear", resourceType: "issue", action: "publish" },
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
  operationGoals: ["linear_publication"],
};

const STRING: JsonSchemaObject = { type: "string" };
const STRING_ARRAY: JsonSchemaObject = { type: "array", items: STRING, maxItems: 50 };
const NON_EMPTY_STRING_ARRAY: JsonSchemaObject = {
  ...STRING_ARRAY,
  minItems: 1,
};
const RESEARCH_PUBLICATION_PARAMETERS: JsonSchemaObject = {
  type: "object",
  additionalProperties: false,
  properties: {
    notePath: { type: "string", description: "Vault-relative Markdown note path." },
    mode: {
      type: "string",
      enum: ["create", "append"],
      description:
        "Use the exact string create for a new note (create never overwrites). Use append only with notePath and the current baseHash. Never use write, overwrite, upsert, or a combined label.",
    },
    baseHash: {
      type: "string",
      description:
        "Omit entirely for create. Required exact SHA-256 when appending; never send an empty placeholder.",
    },
    package: {
      type: "object",
      description:
        "Accepted-research fields are direct children of this object. Do not nest a research object or include initiative/project/issue plan fields.",
      additionalProperties: false,
      properties: {
        schemaVersion: { type: "integer", enum: [1] },
        title: STRING,
        problemImpact: STRING,
        evidence: {
          type: "array",
          minItems: 1,
          maxItems: 50,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description:
                  "Optional stable evidence id. Omit when unavailable; the host derives it from contentSha256.",
              },
              kind: { type: "string", enum: ["web", "vault", "user"] },
              reference: STRING,
              contentSha256: {
                type: "string",
                description:
                  "Optional exact source hash. Omit when unavailable; the host fills it only from a successful same-run web_fetch readback for this reference.",
              },
              label: STRING,
              summary: STRING,
            },
            required: ["kind", "reference", "label", "summary"],
          },
        },
        confidenceLimitations: STRING,
        proposedWork: NON_EMPTY_STRING_ARRAY,
        nonGoals: STRING_ARRAY,
        scope: NON_EMPTY_STRING_ARRAY,
        dependencies: STRING_ARRAY,
        acceptanceCriteria: {
          type: "array",
          minItems: 1,
          maxItems: 20,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: {
                type: "string",
                description:
                  "Optional stable criterion id. Omit when unavailable; the host derives AC-1, AC-2, and so on from canonical order.",
              },
              text: STRING,
            },
            required: ["text"],
          },
        },
        validationRequirementKeys: NON_EMPTY_STRING_ARRAY,
        riskClass: { type: "string", enum: ["low", "medium", "high"] },
        executionClass: {
          type: "string",
          enum: ["research", "vault", "code", "human"],
          description:
            "Use code when repositoryKey is present; repository-bound implementation research is code work.",
        },
        objective: STRING,
        repositoryKey: {
          type: "string",
          description:
            "Optional trusted repository profile key. If present, executionClass must be code.",
        },
      },
      required: [
        "schemaVersion", "title", "problemImpact", "evidence",
        "confidenceLimitations", "proposedWork", "nonGoals", "scope",
        "dependencies", "acceptanceCriteria", "validationRequirementKeys",
        "riskClass", "executionClass", "objective",
      ],
    },
  },
  required: ["mode", "package"],
};

function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record)
    .filter((key) => !allowed.has(key))
    .sort((left, right) => left.localeCompare(right));
  const missing = required.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknown.length || missing.length) {
    const unknownShapes = unknown.map(
      (key) => `${key}:${describeRedactedValueShape(record[key])}`,
    );
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `Research publication fields are invalid (unknown: ${unknown.join(", ") || "none"}; unknown_shapes: ${unknownShapes.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
      { mutationState: "not_applied" },
    );
  }
}

function canonicalizePackageIdentifiers(
  packageRecord: Record<string, unknown>,
): void {
  if (Array.isArray(packageRecord.evidence)) {
    for (const candidate of packageRecord.evidence) {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        continue;
      }
      const evidence = candidate as Record<string, unknown>;
      const contentSha256 =
        typeof evidence.contentSha256 === "string"
          ? evidence.contentSha256.trim().toLowerCase()
          : "";
      if (
        !isValidEvidenceIdentifier(evidence.id) &&
        /^sha256:[a-f0-9]{64}$/u.test(contentSha256)
      ) {
        evidence.id = `evidence-${contentSha256.slice("sha256:".length)}`;
      }
    }
  }
  if (Array.isArray(packageRecord.acceptanceCriteria)) {
    const criteria = packageRecord.acceptanceCriteria.map((candidate, index) =>
      typeof candidate === "string"
        ? { id: `AC-${index + 1}`, text: candidate.trim() }
        : candidate,
    );
    packageRecord.acceptanceCriteria = criteria;
    criteria.forEach((candidate, index) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        return;
      }
      const criterion = candidate as Record<string, unknown>;
      if (!isValidCriterionIdentifier(criterion.id)) {
        criterion.id = `AC-${index + 1}`;
      }
    });
  }
}

function hydrateTrustedWebEvidence(
  packageRecord: Record<string, unknown>,
  runtimeCache: ToolExecutionContext["runtimeCache"],
): void {
  if (!Array.isArray(packageRecord.evidence) || !runtimeCache) return;
  const candidateResults = [
    ...[...(runtimeCache.trustedWebFetchResults?.values() ?? [])].map(
      (result) => ({ trustedRegistry: true, cacheKey: "", result }),
    ),
    ...[...runtimeCache.toolResults.entries()].map(([cacheKey, result]) => ({
      trustedRegistry: false,
      cacheKey,
      result,
    })),
  ];
  const trustedCandidates = candidateResults.flatMap(
    ({ trustedRegistry, cacheKey, result }) => {
      if ((!trustedRegistry && !cacheKey.startsWith("web_fetch:")) || !result.ok) {
        return [];
      }
      const output = asRecord(result.output);
      if (!output) return [];
      const contentHash =
        typeof output.contentHash === "string"
          ? output.contentHash.trim().toLowerCase()
          : "";
      if (!/^sha256:[a-f0-9]{64}$/u.test(contentHash)) return [];
      const references = [output.normalizedUrl, output.url]
        .filter((value): value is string => typeof value === "string")
        .map(normalizeTrustedWebReference)
        .filter((value): value is string => value !== null);
      if (references.length === 0) return [];
      const reference = references[0];
      const contentHex = contentHash.slice("sha256:".length);
      const urlHash =
        typeof output.urlHash === "string" && /^[a-f0-9]{16}$/u.test(output.urlHash)
          ? output.urlHash
          : "";
      return [{
        references: new Set(references),
        reference,
        contentHash,
        id: urlHash
          ? `evidence-${contentHex.slice(0, 48)}-${urlHash}`
          : `evidence-${contentHex}`,
        label: trustedEvidenceText(output.title, reference, 240),
        summary: trustedEvidenceText(
          output.content,
          `Verified fetched source: ${reference}`,
          1_000,
        ),
      }];
    },
  );
  const trustedByReference = new Map<
    string,
    (typeof trustedCandidates)[number]
  >();
  for (const candidate of trustedCandidates) {
    trustedByReference.set(candidate.reference, candidate);
  }
  const trusted = [...trustedByReference.values()].sort((left, right) =>
    left.reference.localeCompare(right.reference),
  );
  if (trusted.length === 0) return;

  const modelEvidence = packageRecord.evidence;
  for (const candidate of modelEvidence) {
    const evidence = asRecord(candidate);
    if (!evidence) continue;
    const reference = normalizeTrustedWebReference(evidence.reference);
    if (!reference) continue;
    const readback = trusted.find((entry) => entry.references.has(reference));
    if (!readback) continue;
    const suppliedHash =
      typeof evidence.contentSha256 === "string"
        ? evidence.contentSha256.trim().toLowerCase()
        : "";
    if (suppliedHash && suppliedHash !== readback.contentHash) {
      throw new ToolExecutionError(
        "research_publication_evidence_changed",
        "Accepted research evidence hash does not match the successful same-run web readback.",
        { mutationState: "not_applied" },
      );
    }
  }
  const preservedNonWebEvidence = modelEvidence.filter((candidate) => {
    const evidence = asRecord(candidate);
    if (!evidence) return false;
    return (
      normalizeTrustedWebReference(evidence.reference) === null &&
      (evidence.kind === "vault" || evidence.kind === "user") &&
      isPreservableNonWebEvidence(evidence)
    );
  });
  packageRecord.evidence = [
    ...preservedNonWebEvidence,
    ...trusted.map((entry) => ({
      id: entry.id,
      kind: "web",
      reference: entry.reference,
      contentSha256: entry.contentHash,
      label: entry.label,
      summary: entry.summary,
    })),
  ];
}

function hasTrustedWebEvidence(
  runtimeCache: ToolExecutionContext["runtimeCache"],
): boolean {
  return [...(runtimeCache?.trustedWebFetchResults?.values() ?? [])].some(
    (result) => {
      if (!result.ok) return false;
      const output = asRecord(result.output);
      return Boolean(
        output &&
        normalizeTrustedWebReference(output.normalizedUrl ?? output.url) &&
        typeof output.contentHash === "string" &&
        /^sha256:[a-f0-9]{64}$/u.test(output.contentHash.trim().toLowerCase()),
      );
    },
  );
}

function seedDurableWebEvidence(
  runtimeCache: ToolExecutionContext["runtimeCache"],
  evidence: readonly {
    url: string;
    contentHash: string;
    usableSource: boolean;
    title?: string;
    summary?: string;
    parserStatus?: string;
  }[],
): void {
  if (!runtimeCache) return;
  runtimeCache.trustedWebFetchResults ??= new Map();
  for (const item of evidence) {
    const url = normalizeTrustedWebReference(item.url);
    const contentHash = item.contentHash.trim().toLowerCase();
    if (
      item.usableSource !== true ||
      !url ||
      !/^sha256:[a-f0-9]{64}$/u.test(contentHash)
    ) {
      continue;
    }
    runtimeCache.trustedWebFetchResults.set(`${url}:${contentHash}`, {
      ok: true,
      toolName: "web_fetch",
      output: {
        url,
        normalizedUrl: url,
        contentHash,
        title: trustedEvidenceText(item.title, url, 240),
        content: trustedEvidenceText(
          item.summary,
          `Verified fetched source: ${url}`,
          1_000,
        ),
        parserStatus: item.parserStatus ?? "parsed",
      },
    });
  }
}

function trustedEvidenceText(
  value: unknown,
  fallback: string,
  maximum: number,
): string {
  const normalized = (typeof value === "string" ? value : "")
    .replace(/\s+/gu, " ")
    .trim();
  return (normalized || fallback).slice(0, maximum);
}

function normalizeTrustedWebReference(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = new URL(value.trim());
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isValidEvidenceIdentifier(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length <= 80 &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value) &&
    !["__proto__", "prototype", "constructor"].includes(value)
  );
}

function isPreservableNonWebEvidence(
  evidence: Record<string, unknown>,
): boolean {
  const contentSha256 = typeof evidence.contentSha256 === "string"
    ? evidence.contentSha256.trim().toLowerCase()
    : "";
  return (
    /^sha256:[a-f0-9]{64}$/u.test(contentSha256) &&
    isSafeBoundedEvidenceText(evidence.reference, 2_000) &&
    isSafeBoundedEvidenceText(evidence.label, 240) &&
    isSafeBoundedEvidenceText(evidence.summary, 1_000)
  );
}

function isSafeBoundedEvidenceText(value: unknown, maximum: number): boolean {
  const normalized = typeof value === "string" ? value.trim() : "";
  return (
    normalized.length > 0 &&
    normalized.length <= maximum &&
    !/[\0\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(normalized)
  );
}

function isValidCriterionIdentifier(value: unknown): boolean {
  return typeof value === "string" && /^AC-[1-9][0-9]?$/u.test(value);
}

function describeRedactedValueShape(value: unknown): string {
  if (Array.isArray(value)) return `array(${Math.min(value.length, 999)})`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort().slice(0, 20);
    return `object(${keys.join("|") || "empty"})`;
  }
  return value === null ? "null" : typeof value;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `${label} must be an object.`,
      { mutationState: "not_applied" },
    );
  }
  return value as Record<string, unknown>;
}

function requireText(value: unknown, label: string, maximum: number): string {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text || text.length > maximum) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `${label} must contain safe bounded text.`,
      { mutationState: "not_applied" },
    );
  }
  return text;
}

function requireIdentity(value: unknown, label: string): string {
  return requireText(value, label, 256);
}

function requireLogicalKey(value: unknown, label: string): string {
  const text = requireText(value, label, 160);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(text)) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `${label} must be a logical key.`,
      { mutationState: "not_applied" },
    );
  }
  return text;
}

function requireSha256(value: unknown, label: string): string {
  const text = requireText(value, label, 71);
  if (!/^sha256:[a-f0-9]{64}$/u.test(text)) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      `${label} must be a SHA-256 fingerprint.`,
      { mutationState: "not_applied" },
    );
  }
  return text;
}

function canonicalNow(provider?: () => Date): string {
  const now = provider?.() ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new ToolExecutionError(
      "research_publication_invalid_clock",
      "Research publication clock is invalid.",
      { mutationState: "not_applied" },
    );
  }
  return now.toISOString();
}
