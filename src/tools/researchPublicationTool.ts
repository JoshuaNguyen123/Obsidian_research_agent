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
import { extractMarkdownPathMentions } from "../agent/missionScope";
import { parseExplicitResearchSourceCount } from "../agent/researchPlan";
import { sha256DiagramContent } from "../design/diagramArtifactStore";
import {
  assertNoRawAuthority,
  ResearchPublicationWorkflow,
  type AcceptedResearchArtifactV1,
  type AcceptedResearchNotePackageV1,
  type AcceptedResearchNoteWriteRequestV1,
  type LinearIssueRecord,
  parseAcceptedResearchNotePackageV1,
  parseRenderedCompatibleWorkItemSpec,
  parseResearchPublicationCheckpointV1,
  type ResearchPublicationCheckpointV1,
  type ResearchPublicationDestinationV1,
  type ResearchPublicationExactApprovalRequestV1,
  type ResearchPublicationLineagePortV1,
  type ResearchPublicationPublisherPortV1,
  type ResearchPublicationResultV1,
} from "../integrations/linear";
import { AcceptedResearchNoteWriter } from "../integrations/linear";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";

export const PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME = "publish_research_to_linear";

export function resolveResearchPublicationNotePathV1(input: {
  requestedPath?: string;
  initiatingNotePath?: string;
  originalPrompt: string;
  runId: string;
}): string {
  const initiatingNotePath = input.initiatingNotePath === undefined
    ? undefined
    : requireSafeVaultMarkdownPath(input.initiatingNotePath);
  if (initiatingNotePath) {
    if (
      input.requestedPath &&
      requireSafeVaultMarkdownPath(input.requestedPath).toLowerCase() !==
        initiatingNotePath.toLowerCase()
    ) {
      throw new Error(
        "The requested research note differs from the trusted initiating Obsidian note.",
      );
    }
    return initiatingNotePath;
  }
  const explicitPaths = dedupeVaultPaths(
    extractMarkdownPathMentions(input.originalPrompt).flatMap((candidate) => {
      try {
        return [requireSafeVaultMarkdownPath(candidate)];
      } catch {
        return [];
      }
    }),
  );

  // The original user mission is the authority boundary. A model-provided path
  // is only a transcription hint and cannot redirect an unambiguous write.
  if (explicitPaths.length === 1) {
    return explicitPaths[0]!;
  }

  if (explicitPaths.length > 1) {
    if (!input.requestedPath) {
      throw new Error(
        "The user mission names multiple research publication note paths; one exact path is required.",
      );
    }
    const requestedPath = requireSafeVaultMarkdownPath(input.requestedPath);
    const selected = explicitPaths.find(
      (candidate) => candidate.toLowerCase() === requestedPath.toLowerCase(),
    );
    if (!selected) {
      throw new Error(
        "The requested research publication note path does not exactly match any safe Markdown path in the user mission.",
      );
    }
    return selected;
  }

  if (!input.requestedPath) {
    const suffix = input.runId
      .replace(/[^A-Za-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 96) || "run";
    return `Accepted research ${suffix}.md`;
  }

  const requestedPath = requireSafeVaultMarkdownPath(input.requestedPath);
  const prompt = input.originalPrompt.replace(/\\/gu, "/").toLowerCase();
  if (!prompt.includes(requestedPath.toLowerCase())) {
    throw new Error(
      "The requested research publication note path was not explicitly present in the user mission.",
    );
  }
  return requestedPath;
}

function requireSafeVaultMarkdownPath(value: string): string {
  const normalized = value.replace(/^\/+|\/+$/gu, "");
  if (
    normalized !== value ||
    normalized.includes("\\") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
    !normalized.toLowerCase().endsWith(".md")
  ) {
    throw new Error("Research publication note path must be a safe vault-relative Markdown path.");
  }
  return normalized;
}

function dedupeVaultPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  return paths.filter((path) => {
    const key = path.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

interface InitiatingNoteBindingV1 {
  path: string;
  sha256: string;
  source: "active_note" | "checkpoint";
}

async function captureInitiatingNoteBinding(
  context: ToolExecutionContext,
): Promise<InitiatingNoteBindingV1 | null> {
  const file = context.getCurrentMarkdownFile?.() ?? null;
  if (!file) return null;
  let path: string;
  try {
    path = requireSafeVaultMarkdownPath(file.path);
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_initiating_note_invalid",
      cause instanceof Error ? cause.message : "The initiating Obsidian note path is unsafe.",
      { mutationState: "not_applied" },
    );
  }
  let content: string | null = null;
  const vault = context.app?.vault;
  if (vault && typeof vault.read === "function") {
    try {
      content = await vault.read(file);
    } catch (cause) {
      throw new ToolExecutionError(
        "research_publication_initiating_note_unreadable",
        cause instanceof Error
          ? `The initiating Obsidian note could not be read: ${cause.message}`
          : "The initiating Obsidian note could not be read.",
        { mutationState: "not_applied" },
      );
    }
  } else {
    content = context.getCurrentMarkdownContent?.(file) ?? null;
  }
  if (content === null) {
    throw new ToolExecutionError(
      "research_publication_initiating_note_unreadable",
      "The initiating Obsidian note could not be read.",
      { mutationState: "not_applied" },
    );
  }
  return {
    path,
    sha256: await sha256DiagramContent(content),
    source: "active_note",
  };
}

async function createResearchPublicationArtifactId(
  runId: string,
  vaultBindingKey: string,
): Promise<string> {
  const artifactIdentity = await sha256Fingerprint({
    schemaVersion: 2,
    kind: "accepted_research_publication",
    runId,
    vaultBindingKey,
  });
  return `accepted-${artifactIdentity.slice("sha256:".length, 39)}`;
}

function initiatingNoteFromCheckpoint(input: {
  checkpoint: ResearchPublicationCheckpointV1;
  publicationId: string;
  artifactId: string;
  runId: string;
  vaultBindingKey: string;
}): InitiatingNoteBindingV1 {
  let checkpoint: ResearchPublicationCheckpointV1;
  try {
    checkpoint = parseResearchPublicationCheckpointV1(input.checkpoint);
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_identity_invalid",
      cause instanceof Error
        ? `The research publication checkpoint is invalid: ${cause.message}`
        : "The research publication checkpoint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  if (
    checkpoint.publicationId !== input.publicationId ||
    checkpoint.artifact.artifactId !== input.artifactId ||
    checkpoint.artifact.originRunId !== input.runId ||
    checkpoint.artifact.vaultBindingKey !== input.vaultBindingKey
  ) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_identity_invalid",
      "The research publication checkpoint belongs to a different run or vault binding.",
      { mutationState: "not_applied" },
    );
  }
  try {
    return {
      path: requireSafeVaultMarkdownPath(checkpoint.artifact.notePath),
      sha256: requireSha256(
        checkpoint.backlink?.afterSha256 ?? checkpoint.artifact.noteSha256,
        "checkpoint note hash",
      ),
      source: "checkpoint",
    };
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_identity_invalid",
      cause instanceof Error
        ? `The research publication checkpoint note binding is invalid: ${cause.message}`
        : "The research publication checkpoint note binding is invalid.",
      { mutationState: "not_applied" },
    );
  }
}

async function replayCompletedResearchPublication(input: {
  checkpoint: ResearchPublicationCheckpointV1;
  publicationId: string;
  artifactId: string;
  rootRunId: string;
  vaultBindingKey: string;
  context: ToolExecutionContext;
  publisher: ResearchPublicationPublisherPortV1;
}): Promise<ResearchPublicationResultV1> {
  let checkpoint: ResearchPublicationCheckpointV1;
  try {
    checkpoint = parseResearchPublicationCheckpointV1(input.checkpoint);
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_identity_invalid",
      cause instanceof Error
        ? `The completed research publication checkpoint is invalid: ${cause.message}`
        : "The completed research publication checkpoint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  initiatingNoteFromCheckpoint({
    checkpoint,
    publicationId: input.publicationId,
    artifactId: input.artifactId,
    runId: input.rootRunId,
    vaultBindingKey: input.vaultBindingKey,
  });
  if (
    checkpoint.status !== "complete" ||
    !checkpoint.lineage ||
    !checkpoint.workItemFingerprint ||
    !checkpoint.approvalFingerprint ||
    !checkpoint.binding ||
    !checkpoint.issue ||
    !checkpoint.backlink
  ) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_incomplete",
      "A completed research publication checkpoint is missing durable proof.",
      { mutationState: "not_applied" },
    );
  }
  const lineage = checkpoint.lineage;
  const binding = checkpoint.binding;
  const checkpointIssue = checkpoint.issue;
  const backlink = checkpoint.backlink;

  const file = input.context.app.vault.getFileByPath(
    checkpoint.artifact.notePath,
  );
  if (!file) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_note_missing",
      "The completed research publication note is missing.",
      { mutationState: "not_applied" },
    );
  }
  let noteContent: string;
  try {
    noteContent = await input.context.app.vault.read(file);
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_note_unreadable",
      cause instanceof Error
        ? `The completed research publication note could not be read: ${cause.message}`
        : "The completed research publication note could not be read.",
      { mutationState: "not_applied" },
    );
  }
  const currentNoteSha256 = await sha256DiagramContent(noteContent);
  if (currentNoteSha256 !== backlink.afterSha256) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_note_drift",
      "The completed research publication note changed after its verified Linear backlink.",
      { mutationState: "not_applied" },
    );
  }

  let issue: LinearIssueRecord;
  try {
    issue = await input.publisher.readIssue(checkpointIssue.id, input.context);
  } catch (cause) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_readback_failed",
      cause instanceof Error
        ? `The completed Linear issue could not be read: ${cause.message}`
        : "The completed Linear issue could not be read.",
      { mutationState: "not_applied" },
    );
  }
  let workItem: ReturnType<
    typeof parseRenderedCompatibleWorkItemSpec
  >["spec"];
  try {
    workItem = parseRenderedCompatibleWorkItemSpec(issue.description ?? "").spec;
  } catch {
    throw new ToolExecutionError(
      "research_publication_checkpoint_readback_mismatch",
      "The completed Linear issue no longer contains one valid signed work-item contract.",
      { mutationState: "not_applied" },
    );
  }
  const issueUpdatedAt = typeof issue.updatedAt === "string"
    ? Date.parse(issue.updatedAt)
    : Number.NaN;
  const checkpointIssueUpdatedAt = Date.parse(checkpointIssue.updatedAt);
  const commonContractMismatch =
    issue.resourceType !== "issue" ||
    issue.trashed ||
    issue.id !== checkpointIssue.id ||
    issue.id !== binding.issueId ||
    issue.identifier !== checkpointIssue.identifier ||
    issue.identifier !== binding.issueIdentifier ||
    issue.url !== checkpointIssue.url ||
    issue.url !== binding.issueUrl ||
    issue.team.id !== binding.teamId ||
    !/^sha256:[a-f0-9]{64}$/u.test(issue.snapshotHash) ||
    !Number.isFinite(issueUpdatedAt) ||
    issueUpdatedAt < checkpointIssueUpdatedAt ||
    binding.originRunId !== input.rootRunId ||
    binding.workItemFingerprint !== checkpoint.workItemFingerprint ||
    binding.acceptedResearchArtifactFingerprint !==
      checkpoint.artifact.artifactFingerprint ||
    lineage.originRunId !== input.rootRunId ||
    lineage.workItemFingerprint !== checkpoint.workItemFingerprint ||
    lineage.researchArtifactFingerprint !==
      checkpoint.artifact.artifactFingerprint ||
    lineage.externalWorkItemBindingFingerprint !== binding.bindingFingerprint ||
    workItem.fingerprint !== checkpoint.workItemFingerprint ||
    workItem.originRunId !== input.rootRunId ||
    workItem.executionClass !== lineage.executionClass ||
    (workItem.repositoryKey ?? null) !== (lineage.repositoryKey ?? null);
  const v2ContractMismatch =
    workItem.schemaVersion === 2 &&
    (
      workItem.acceptedResearchArtifactFingerprint !==
        checkpoint.artifact.artifactFingerprint ||
      (workItem.vaultBindingKey ?? null) !==
        (lineage.vaultBindingKey ?? null)
    );
  if (
    commonContractMismatch ||
    v2ContractMismatch
  ) {
    throw new ToolExecutionError(
      "research_publication_checkpoint_readback_mismatch",
      "The completed Linear issue no longer matches its durable publication binding.",
      { mutationState: "not_applied" },
    );
  }

  return {
    ok: true,
    status: "complete",
    publication: "deduplicated",
    note: {
      path: checkpoint.artifact.notePath,
      operation: "no_op",
      beforeSha256: currentNoteSha256,
      afterSha256: currentNoteSha256,
      noteReceiptId: checkpoint.artifact.noteReceiptId,
      artifact: checkpoint.artifact,
      transaction: null,
    },
    artifact: checkpoint.artifact,
    lineage,
    approvalFingerprint: checkpoint.approvalFingerprint,
    binding,
    issue,
    backlink,
    receipt: null,
  };
}

export interface ResearchPublicationGrantInputV1 {
  runId: string;
  approvalId: string;
  destination: ResearchPublicationDestinationV1;
}

export interface CreateResearchPublicationToolOptionsV1 {
  noteWriter: Pick<
    AcceptedResearchNoteWriter,
    "writeAcceptedPackage" | "readAcceptedPackage" | "appendLinearBacklink"
  >;
  publisher: ResearchPublicationPublisherPortV1;
  lineage: ResearchPublicationLineagePortV1;
  destination: ResearchPublicationDestinationV1;
  vaultBindingKey: string;
  resolveNotePath(input: {
    requestedPath?: string;
    initiatingNotePath?: string;
    originalPrompt: string;
    runId: string;
  }): string;
  validateTrustedBindings(package_: AcceptedResearchNotePackageV1): void;
  mintOneActionGrant(input: ResearchPublicationGrantInputV1): Promise<AuthorityGrantV1>;
  persistExternalReceipt(receipt: ActionReceipt): Promise<void>;
  /**
   * Host-owned find-or-create for the Linear project that should own the issue.
   * Called after the accepted package is parsed so association can use the title.
   */
  resolveProjectAssociation?(input: {
    prompt: string;
    associationText: string;
    destination: ResearchPublicationDestinationV1;
    context: ToolExecutionContext;
  }): Promise<{
    destination: ResearchPublicationDestinationV1;
    publisher: ResearchPublicationPublisherPortV1;
  }>;
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
  /**
   * Host-owned view of the trusted repository catalog, used to make package
   * negotiation self-describing: with exactly one trusted profile the
   * repositoryKey defaults to it instead of requiring the model to echo it,
   * and rejection errors enumerate the valid keys so a retry can succeed.
   * Absent, the legacy strict behavior applies unchanged.
   */
  describeTrustedRepositoryCatalog?(): TrustedRepositoryCatalogV1;
}

export interface TrustedRepositoryCatalogV1 {
  repositoryKeys: readonly string[];
  validationKeysByRepository: Readonly<Record<string, readonly string[]>>;
}

/**
 * The exact validation requirement keys a trusted repository profile accepts:
 * its validation profile id plus one `<key>.validation.<n>` entry per
 * configured command. Shared by the fail-closed check and the catalog the
 * tool describes, so the two can never drift apart.
 */
export function trustedValidationKeysForProfileV1(profile: {
  key: string;
  validationProfile: { id: string; validationCommands: readonly unknown[] };
}): string[] {
  return [
    profile.validationProfile.id,
    ...profile.validationProfile.validationCommands.map(
      (_command, index) => `${profile.key}.validation.${index + 1}`,
    ),
  ];
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
      const rootRunId = requireIdentity(
        context.rootMissionId?.trim() || runId,
        "root mission id",
      );
      const toolCallId = requireIdentity(context.operationId, "tool call id");
      const vaultBindingKey = requireLogicalKey(
        options.vaultBindingKey,
        "host vault binding key",
      );
      const artifactId = await createResearchPublicationArtifactId(
        rootRunId,
        vaultBindingKey,
      );
      const publicationId = `publication-${artifactId}`;
      const priorCheckpoint = await options.lineage.get?.(publicationId) ?? null;
      if (priorCheckpoint?.status === "complete") {
        return replayCompletedResearchPublication({
          checkpoint: priorCheckpoint,
          publicationId,
          artifactId,
          rootRunId,
          vaultBindingKey,
          context,
          publisher: options.publisher,
        });
      }
      const initiatingNote = priorCheckpoint
        ? initiatingNoteFromCheckpoint({
            checkpoint: priorCheckpoint,
            publicationId,
            artifactId,
            runId: rootRunId,
            vaultBindingKey,
          })
        : await captureInitiatingNoteBinding(context);
      const proofCache = context.runtimeCache ?? { toolResults: new Map() };
      if (options.loadDurableWebEvidence) {
        seedDurableWebEvidence(
          proofCache,
          await options.loadDurableWebEvidence(rootRunId),
        );
      }
      const parsedNote = priorCheckpoint?.acceptedPackage
        ? acceptedResearchRequestFromCheckpoint(
            priorCheckpoint,
            priorCheckpoint.acceptedPackage,
            options.validateTrustedBindings,
          )
        : await parseToolArguments({
            value: args,
            runId: rootRunId,
            toolCallId,
            originalPrompt: context.originalPrompt,
            vaultBindingKey,
            artifactId,
            runtimeCache: proofCache,
            resolveNotePath: options.resolveNotePath,
            validateTrustedBindings: options.validateTrustedBindings,
            describeTrustedRepositoryCatalog: options.describeTrustedRepositoryCatalog,
            initiatingNote,
            nowProvider: options.now ?? context.now,
          });
      const note = stabilizeAcceptedResearchRequest(
        parsedNote,
        proofCache,
        rootRunId,
        priorCheckpoint?.acceptedPackage ?? null,
      );
      if (!context.requestNestedApproval) {
        throw new ToolExecutionError(
          "research_publication_approval_unavailable",
          "The host approval surface is unavailable for this research publication.",
          { mutationState: "not_applied" },
        );
      }
      let destination = options.destination;
      let publisher = options.publisher;
      if (options.resolveProjectAssociation) {
        try {
          const resolved = await options.resolveProjectAssociation({
            prompt: context.originalPrompt,
            associationText: note.package.title,
            destination: options.destination,
            context,
          });
          destination = resolved.destination;
          publisher = resolved.publisher;
        } catch (error) {
          throw new ToolExecutionError(
            "research_publication_project_association_failed",
            error instanceof Error
              ? error.message
              : "Failed to resolve or create the Linear project for research publication.",
            { mutationState: "not_applied" },
          );
        }
      }
      const workflow = new ResearchPublicationWorkflow({
        noteWriter: options.noteWriter,
        publisher,
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
        destination,
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
      receipt =
        output.receipt ??
        (await createDeduplicatedReadbackReceipt(output, context));
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
  // "Obsidian note … create … Linear issue" is ordinary ticket writeback, not
  // publish_research_to_linear. Require research/findings/report language or an
  // explicit publish/send/sync verb before Linear.
  return normalized
    .split(/(?:[!?;\r\n]+|\.(?=\s|$)|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const publicationIntent =
        /\b(?:publish|send|sync|post)\b[\s\S]{0,120}\b(?:research|findings|report|accepted\s+research)\b[\s\S]{0,120}\b(?:to|in|on)\s+(?:(?:exactly\s+)?(?:one|a|an|the)\s+)?linear\b/iu.test(
          clause,
        ) ||
        /\b(?:research|findings|report|accepted\s+research)\b[\s\S]{0,120}\b(?:publish|send|sync|post)\b[\s\S]{0,120}\blinear\b/iu.test(
          clause,
        ) ||
        /\b(?:publish|send|sync|post|file)\b[\s\S]{0,120}\b(?:research|findings|report)\b[\s\S]{0,80}\b(?:ticket|issue)\b[\s\S]{0,80}\b(?:to|in|on)\s+(?:(?:exactly\s+)?(?:one|a|an|the)\s+)?linear\b/iu.test(
          clause,
        );
      if (!publicationIntent) {
        return false;
      }
      return !/\b(?:do\s+not|don't|never)\s+(?:(?:yet|now|currently)\s+)?(?:publish|send|sync|post|file)\b/iu.test(
        clause,
      );
    });
}

async function parseToolArguments(input: {
  value: Record<string, unknown>;
  runId: string;
  toolCallId: string;
  originalPrompt: string;
  vaultBindingKey: string;
  artifactId: string;
  runtimeCache: ToolExecutionContext["runtimeCache"];
  resolveNotePath: CreateResearchPublicationToolOptionsV1["resolveNotePath"];
  validateTrustedBindings: CreateResearchPublicationToolOptionsV1["validateTrustedBindings"];
  describeTrustedRepositoryCatalog?: CreateResearchPublicationToolOptionsV1["describeTrustedRepositoryCatalog"];
  initiatingNote: InitiatingNoteBindingV1 | null;
  nowProvider?: () => Date;
}) {
  const { value, runId } = input;
  assertExactKeys(value, ["mode", "package"], ["notePath", "baseHash"]);
  const packageRecord = expectRecord(value.package, "accepted research package");
  hydratePackageObjective(packageRecord);
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
  canonicalizeCompatibleProposedWork(packageRecord);
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
    // A model cannot invent a trusted key, and with exactly one registered
    // profile there is nothing to disambiguate — requiring an echo of the key
    // only converts good packages into repeated failures. With several
    // profiles the choice is genuinely the mission's, so still fail closed,
    // but name the candidates so a retry can succeed.
    const catalog = input.describeTrustedRepositoryCatalog?.();
    if (catalog && catalog.repositoryKeys.length === 1) {
      packageRecord.repositoryKey = catalog.repositoryKeys[0];
    } else {
      const known = catalog?.repositoryKeys.length
        ? ` Trusted repository keys: ${[...catalog.repositoryKeys].join(", ")}.`
        : "";
      throw new ToolExecutionError(
        "research_publication_invalid_arguments",
        `A package with executionClass code must include the trusted repositoryKey named by the mission.${known}`,
        { mutationState: "not_applied" },
      );
    }
  }
  bindExplicitTrustedRepositoryContract({
    packageRecord,
    originalPrompt: input.originalPrompt,
    catalog: input.describeTrustedRepositoryCatalog?.(),
  });
  const trustedWebReferences = hydrateTrustedWebEvidence(
    packageRecord,
    input.runtimeCache,
  );
  assertExplicitResearchEvidenceCoverage({
    originalPrompt: input.originalPrompt,
    trustedWebReferences,
  });
  canonicalizePackageIdentifiers(packageRecord);
  canonicalizeProviderSafeWorkItemContract(packageRecord);
  if (value.mode !== "create" && value.mode !== "append") {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      "Research note mode must be create or append.",
      { mutationState: "not_applied" },
    );
  }
  const requestedMode: "create" | "append" = value.mode;
  const requestedBaseHash =
    typeof value.baseHash === "string" &&
    value.baseHash.trim() === ""
      ? undefined
      : value.baseHash;
  const acceptedAt = canonicalNow(input.nowProvider);
  const requestedPath = value.notePath === undefined
    ? undefined
    : requireText(value.notePath, "note path", 1_000);
  if (!input.initiatingNote && requestedMode === "append" && !requestedPath) {
    throw new ToolExecutionError(
      "research_publication_note_path_required",
      "Appending requires a vault-safe Markdown path explicitly present in the user mission.",
      { mutationState: "not_applied" },
    );
  }
  const providerPackage = {
    ...packageRecord,
    vaultBindingKey: requireLogicalKey(input.vaultBindingKey, "host vault binding key"),
    originRunId: runId,
  } as unknown as AcceptedResearchNotePackageV1;
  const package_ = assertAcceptedResearchPackageShape(providerPackage);
  input.validateTrustedBindings(package_);
  const path = input.initiatingNote?.source === "checkpoint"
    ? input.initiatingNote.path
    : requireSafeVaultMarkdownPath(
        input.resolveNotePath({
          // The active initiating note is the host-owned destination. A model
          // may omit or mistranscribe notePath, but it can never redirect the
          // write; only unbound publication falls back to a requested path.
          ...(!input.initiatingNote && requestedPath ? { requestedPath } : {}),
          ...(input.initiatingNote
            ? { initiatingNotePath: input.initiatingNote.path }
            : {}),
          originalPrompt: input.originalPrompt,
          runId,
        }),
      );
  if (
    input.initiatingNote &&
    path.toLowerCase() !== input.initiatingNote.path.toLowerCase()
  ) {
    throw new ToolExecutionError(
      "research_publication_initiating_note_mismatch",
      "Research publication cannot redirect the trusted initiating Obsidian note.",
      { mutationState: "not_applied" },
    );
  }
  const mode: "create" | "append" = input.initiatingNote
    ? "append"
    : requestedMode;
  const baseHash = input.initiatingNote?.sha256 ?? requestedBaseHash;
  if (mode === "append" && typeof baseHash !== "string") {
    throw new ToolExecutionError(
      "research_publication_base_hash_required",
      "Appending an accepted research package requires the current note SHA-256 hash.",
      { mutationState: "not_applied" },
    );
  }
  if (mode === "append" && !path) {
    throw new ToolExecutionError(
      "research_publication_note_path_required",
      "Appending requires a vault-safe Markdown path.",
      { mutationState: "not_applied" },
    );
  }
  return {
    path,
    mode,
    ...(typeof baseHash === "string"
      ? { baseHash: requireSha256(baseHash, "base hash") }
      : {}),
    artifactId: input.artifactId,
    acceptedAt,
    package: package_,
  };
}

function bindExplicitTrustedRepositoryContract(input: {
  packageRecord: Record<string, unknown>;
  originalPrompt: string;
  catalog: TrustedRepositoryCatalogV1 | undefined;
}): void {
  const { packageRecord, catalog } = input;
  if (!catalog) return;
  const promptRepositoryKeys = catalog.repositoryKeys.filter((key) =>
    promptContainsLogicalKey(input.originalPrompt, key)
  );
  if (promptRepositoryKeys.length === 1) {
    packageRecord.repositoryKey = promptRepositoryKeys[0];
  }
  const repositoryKey =
    typeof packageRecord.repositoryKey === "string"
      ? packageRecord.repositoryKey
      : "";
  const trustedValidationKeys =
    catalog.validationKeysByRepository[repositoryKey] ?? [];
  const promptValidationKeys = trustedValidationKeys.filter((key) =>
    promptContainsLogicalKey(input.originalPrompt, key)
  );
  if (promptValidationKeys.length > 0) {
    // Logical repository/validation keys are host controls named by the user,
    // not creative model output. Bind the package to every exact trusted key
    // present in the original mission and discard a mistranscribed echo.
    packageRecord.validationRequirementKeys = [...promptValidationKeys];
  }
}

function promptContainsLogicalKey(prompt: string, key: string): boolean {
  const normalizedPrompt = prompt.toLowerCase();
  const normalizedKey = key.trim().toLowerCase();
  if (!normalizedKey) return false;
  let offset = normalizedPrompt.indexOf(normalizedKey);
  while (offset >= 0) {
    const before = offset === 0 ? "" : normalizedPrompt[offset - 1] ?? "";
    const afterIndex = offset + normalizedKey.length;
    const after =
      afterIndex >= normalizedPrompt.length
        ? ""
        : normalizedPrompt[afterIndex] ?? "";
    const afterNext =
      afterIndex + 1 >= normalizedPrompt.length
        ? ""
        : normalizedPrompt[afterIndex + 1] ?? "";
    const afterContinuesLogicalKey =
      /[a-z0-9_-]/u.test(after) ||
      (after === "." && /[a-z0-9_-]/u.test(afterNext));
    if (
      !/[a-z0-9._-]/u.test(before) &&
      !afterContinuesLogicalKey
    ) {
      return true;
    }
    offset = normalizedPrompt.indexOf(normalizedKey, offset + 1);
  }
  return false;
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
  checkpointPackage: AcceptedResearchNotePackageV1 | null,
): AcceptedResearchNoteWriteRequestV1 {
  const checkpointCanonical = checkpointPackage
    ? {
        ...cloneAcceptedResearchRequest(candidate),
        package: structuredClone(checkpointPackage),
      }
    : null;
  if (!runtimeCache) {
    return checkpointCanonical ?? cloneAcceptedResearchRequest(candidate);
  }
  runtimeCache.acceptedResearchPublicationRequests ??= new Map<string, unknown>();
  // One run has one immutable initiating-note binding. A changed active tab or
  // model-supplied path on retry must not fork the durable publication.
  const key = runId;
  if (checkpointCanonical) {
    runtimeCache.acceptedResearchPublicationRequests.set(
      key,
      cloneAcceptedResearchRequest(checkpointCanonical),
    );
    return checkpointCanonical;
  }
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

function acceptedResearchRequestFromCheckpoint(
  checkpoint: ResearchPublicationCheckpointV1,
  acceptedPackage: AcceptedResearchNotePackageV1,
  validateTrustedBindings: (
    package_: AcceptedResearchNotePackageV1,
  ) => void,
): AcceptedResearchNoteWriteRequestV1 {
  const package_ = structuredClone(acceptedPackage);
  validateTrustedBindings(package_);
  return {
    path: checkpoint.artifact.notePath,
    mode: "append",
    baseHash:
      checkpoint.backlink?.afterSha256 ?? checkpoint.artifact.noteSha256,
    artifactId: checkpoint.artifact.artifactId,
    acceptedAt: checkpoint.artifact.acceptedAt,
    package: package_,
  };
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

async function createDeduplicatedReadbackReceipt(output: {
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
}, context: ToolExecutionContext): Promise<ActionReceipt> {
  const observedAt = canonicalNow(context.now);
  const runId = requireIdentity(context.runId, "run id");
  const operationId = requireIdentity(context.operationId, "tool call id");
  const receiptFingerprint = await sha256Fingerprint({
    runId,
    operationId,
    issueId: output.issue.id,
    issueSnapshotHash: output.issue.snapshotHash,
    workItemFingerprint: output.binding.workItemFingerprint,
    observedAt,
  });
  return {
    version: 1,
    id:
      `linear-research-readback-` +
      receiptFingerprint.slice("sha256:".length),
    runId,
    actionId: `linear-readback-${operationId}`,
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
    startedAt: observedAt,
    committedAt: observedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: observedAt,
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
        proposedWork: {
          ...NON_EMPTY_STRING_ARRAY,
          description:
            "JSON array of 1-50 nonempty strings. Even one proposed work item must use [\"...\"]; never send a bare string, object, null, or empty array.",
        },
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
        validationRequirementKeys: {
          ...NON_EMPTY_STRING_ARRAY,
          description:
            "Keys drawn ONLY from the trusted repository profile's validation catalog: the profile's validation profile id and its <repositoryKey>.validation.<n> command keys. Never invent names; on rejection the error lists the valid keys.",
        },
        riskClass: { type: "string", enum: ["low", "medium", "high"] },
        executionClass: {
          type: "string",
          enum: ["research", "vault", "code", "human"],
          description:
            "Use code when repositoryKey is present; repository-bound implementation research is code work.",
        },
        objective: {
          type: "string",
          description:
            "Optional short objective. Omit when unavailable; the host derives it from title or problemImpact.",
        },
        repositoryKey: {
          type: "string",
          description:
            "Trusted repository profile key. If present, executionClass must be code. When the host has exactly one trusted repository profile it defaults to that profile; omit rather than guessing.",
        },
      },
      required: [
        "schemaVersion", "title", "problemImpact", "evidence",
        "confidenceLimitations", "proposedWork", "nonGoals", "scope",
        "dependencies", "acceptanceCriteria", "validationRequirementKeys",
        "riskClass", "executionClass",
      ],
    },
  },
  required: ["mode", "package"],
};

function hydratePackageObjective(packageRecord: Record<string, unknown>): void {
  if (
    typeof packageRecord.objective === "string" &&
    packageRecord.objective.trim()
  ) {
    packageRecord.objective = packageRecord.objective.trim();
    return;
  }
  const title =
    typeof packageRecord.title === "string" ? packageRecord.title.trim() : "";
  const problemImpact =
    typeof packageRecord.problemImpact === "string"
      ? packageRecord.problemImpact.trim()
      : "";
  if (title) {
    packageRecord.objective = `Deliver the accepted research for: ${title}`.slice(
      0,
      500,
    );
    return;
  }
  if (problemImpact) {
    packageRecord.objective = problemImpact.slice(0, 500);
    return;
  }
  packageRecord.objective = "Deliver the accepted research work item.";
}

/**
 * Some OpenAI-compatible providers emit a single proposed-work value as a
 * scalar despite the array schema. A nonblank scalar can be canonicalized
 * losslessly. Missing, blank, empty, object, and overlong shapes still fail
 * closed at the pre-mutation package validator.
 */
function canonicalizeCompatibleProposedWork(
  packageRecord: Record<string, unknown>,
): void {
  if (typeof packageRecord.proposedWork === "string") {
    const proposedWork = packageRecord.proposedWork.trim();
    if (proposedWork) {
      packageRecord.proposedWork = [proposedWork];
    }
  }
}

function assertAcceptedResearchPackageShape(
  package_: AcceptedResearchNotePackageV1,
): AcceptedResearchNotePackageV1 {
  try {
    return parseAcceptedResearchNotePackageV1(package_);
  } catch (error) {
    throw new ToolExecutionError(
      "research_publication_invalid_arguments",
      error instanceof Error
        ? `The accepted research package is invalid: ${error.message}`
        : "The accepted research package is invalid.",
      { mutationState: "not_applied" },
    );
  }
}

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
    const criteria = packageRecord.acceptanceCriteria.map((candidate, index) => {
      if (typeof candidate === "string") {
        return { id: `AC-${index + 1}`, text: candidate.trim() };
      }
      const record = asRecord(candidate);
      if (
        record &&
        typeof record.text !== "string" &&
        typeof record.$text === "string"
      ) {
        const { $text, ...rest } = record;
        return { ...rest, text: $text };
      }
      return candidate;
    });
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

/**
 * Model prose may describe the requested validator as a shell command or raw
 * path. Those strings are useful planning hints but can never become queue
 * execution authority. Preserve safe behavioral criteria and replace only
 * unsafe entries with host-owned logical validation language.
 */
function canonicalizeProviderSafeWorkItemContract(
  packageRecord: Record<string, unknown>,
): void {
  const validationKeys = Array.isArray(packageRecord.validationRequirementKeys)
    ? packageRecord.validationRequirementKeys.filter(
        (value): value is string =>
          typeof value === "string" &&
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value),
      )
    : [];
  if (Array.isArray(packageRecord.acceptanceCriteria)) {
    packageRecord.acceptanceCriteria = packageRecord.acceptanceCriteria.map(
      (candidate, index) => {
        const criterion = asRecord(candidate);
        if (!criterion || typeof criterion.text !== "string") return candidate;
        try {
          assertNoRawAuthority(
            criterion.text,
            `acceptance criterion ${index + 1} text`,
          );
          return candidate;
        } catch {
          const validationKey =
            validationKeys[index % Math.max(validationKeys.length, 1)];
          return {
            ...criterion,
            text: validationKey
              ? `The trusted validation requirement ${validationKey} passes for the verified repository change.`
              : `The verified implementation satisfies accepted behavioral criterion ${index + 1}.`,
          };
        }
      },
    );
  }
  if (typeof packageRecord.objective === "string") {
    try {
      assertNoRawAuthority(packageRecord.objective, "objective");
    } catch {
      const repositoryKey =
        typeof packageRecord.repositoryKey === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(packageRecord.repositoryKey)
          ? packageRecord.repositoryKey
          : "";
      packageRecord.objective = repositoryKey
        ? `Deliver the accepted research through trusted repository profile ${repositoryKey}.`
        : "Deliver the accepted research work item through trusted host bindings.";
    }
  }
  const scalarFallbacks: Record<string, string> = {
    title: "Accepted research implementation",
    problemImpact:
      "The accepted research identifies an implementation gap that requires a verified repository change.",
    confidenceLimitations:
      "Implementation and provider behavior remain subject to trusted validation readback.",
  };
  for (const [field, fallback] of Object.entries(scalarFallbacks)) {
    const value = packageRecord[field];
    if (typeof value !== "string") continue;
    try {
      assertNoRawAuthority(value, field);
    } catch {
      packageRecord[field] = fallback;
    }
  }
  const listFallbacks: Record<string, (index: number) => string> = {
    proposedWork: (index) =>
      `Implement accepted work item ${index + 1} through the trusted repository profile.`,
    nonGoals: (index) =>
      `Unapproved provider or repository change ${index + 1} remains outside scope.`,
    scope: (index) =>
      `Accepted scope item ${index + 1} remains inside the trusted repository profile.`,
    dependencies: (index) =>
      `Dependency ${index + 1} is resolved through trusted host bindings.`,
  };
  for (const [field, fallback] of Object.entries(listFallbacks)) {
    const values = packageRecord[field];
    if (!Array.isArray(values)) continue;
    packageRecord[field] = values.map((value, index) => {
      if (typeof value !== "string") return value;
      try {
        assertNoRawAuthority(value, `${field} ${index + 1}`);
        return value;
      } catch {
        return fallback(index);
      }
    });
  }
}

function hydrateTrustedWebEvidence(
  packageRecord: Record<string, unknown>,
  runtimeCache: ToolExecutionContext["runtimeCache"],
): string[] {
  if (!Array.isArray(packageRecord.evidence) || !runtimeCache) return [];
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
  if (trusted.length === 0) return [];

  const modelEvidence = packageRecord.evidence;
  for (const candidate of modelEvidence) {
    const evidence = asRecord(candidate);
    if (!evidence) continue;
    const reference = normalizeTrustedWebReference(evidence.reference);
    if (!reference) continue;
    const readback = trusted.find((entry) => entry.references.has(reference));
    if (!readback) continue;
    // The model-supplied hash is never authority. A matching trusted URL is
    // replaced below with the successful same-run/durable host readback.
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
  return trusted.map((entry) => entry.reference);
}

function assertExplicitResearchEvidenceCoverage(input: {
  originalPrompt: string;
  trustedWebReferences: readonly string[];
}): void {
  const required = parseExplicitResearchSourceCount(input.originalPrompt);
  if (required === null) return;
  const references = [...new Set(
    input.trustedWebReferences
      .map(normalizeTrustedWebReference)
      .filter((value): value is string => value !== null),
  )].sort();
  if (references.length >= required) return;

  const represented = references.length > 0
    ? ` Host-verified references already bound: ${references.join(", ")}.`
    : "";
  throw new ToolExecutionError(
    "research_publication_evidence_incomplete",
    `Research publication requires ${required} distinct host-verified web sources, but only ${references.length} ${
      references.length === 1 ? "is" : "are"
    } bound. Fetch ${required - references.length} additional distinct source${
      required - references.length === 1 ? "" : "s"
    } with web_fetch before retrying.${represented}`,
    { mutationState: "not_applied" },
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
