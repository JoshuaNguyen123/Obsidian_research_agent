/**
 * Verified-workspace binding: the dependency-injected helpers that bind tool
 * schemas and calls to host-verified workspace identities, remember verified
 * read/write observations in the runtime cache, and constrain corrections to
 * exact receipt-backed paths. Extracted verbatim from AgentRunner.ts
 * (Cluster B of the monolith extraction); bodies are byte-identical.
 */

import { type ModelToolCall, type ModelToolDefinition } from "../model/types";
import { type MissionGraphV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import type {
  AgentRunReceipt,
  OperationGoal,
  OperationGoalState,
} from "../AgentRunner";
import { type AgentRuntimeCache, type CodeValidationDiagnosticObservation, type ToolExecutionContext, type ToolExecutionResult, type VerifiedWorkspaceReadObservation } from "../tools/types";
import { type MissionAcceptanceResult } from "./missionAcceptance";
import { hasCodeDeliverableIntent } from "./codeDeliverableIntent";
import { isAdaptiveCodeWorkspaceMutationToolNameV1 } from "./missionGraphFrontier";
import { getMissionGraphNodeSelector, getSafeMissionCompositeLifecycleSpecV1 } from "./missionGraphSelectors";
import { extractRequiredLiteralAnchors } from "./missionPlan";
import {
  hasExplicitNoHostDirectoryExportIntent,
  hasKnownHostDirectoryExportIntent,
} from "./promptIntentClassifiers";
import { getString, isRecord } from "./recordUtils";

export interface MissionOperationGoals {
  goals: Record<OperationGoal, OperationGoalState>;
  completedTools: string[];
}

export function getSingleVerifiedDurableWorkspaceId(
  durableReceipts: readonly AgentRunReceipt[],
): string | null {
  const workspaceIds = new Set(
    durableReceipts
      .filter(
        (receipt) =>
          receipt.toolName === "code_workspace_create" &&
          (receipt.commitKind === "committed" ||
            receipt.commitKind === "reconciled") &&
          receipt.readback?.status === "verified" &&
          receipt.resource?.system === "workspace",
      )
      .map((receipt) =>
        receipt.resource?.workspaceId?.trim() ||
        receipt.resource?.path?.trim() ||
        "",
      )
      .filter((workspaceId) => workspaceId.length > 0),
  );
  return workspaceIds.size === 1 ? [...workspaceIds][0]! : null;
}

export function hasPendingOperationGoals(operationGoals: MissionOperationGoals): boolean {
  return Object.values(operationGoals.goals).some((state) => state === "pending");
}

/**
 * A recovery gate is paid only by a canonical, independently read-back
 * workspace receipt whose content hash actually changed. Prepared calls that
 * failed, escaped repository scope, or rewrote byte-identical content cannot
 * masquerade as a correction.
 */
export function receiptProvesWorkspaceContentChangeV1(
  receipt: AgentRunReceipt,
): boolean {
  if (
    (receipt.commitKind !== "committed" &&
      receipt.commitKind !== "reconciled") ||
    receipt.readback?.status !== "verified"
  ) {
    return false;
  }
  const output = isRecord(receipt.output) ? receipt.output : null;
  const mutationReceipt =
    output && isRecord(output.receipt) ? output.receipt : null;
  if (!mutationReceipt || mutationReceipt.version !== 2) return false;
  const beforeSha256 = mutationReceipt.beforeSha256;
  const afterSha256 = mutationReceipt.afterSha256;
  const validHash = (value: unknown): value is string =>
    typeof value === "string" && /^sha256:[a-f0-9]{64}$/u.test(value);
  if (
    !(beforeSha256 === null || validHash(beforeSha256)) ||
    !validHash(afterSha256) ||
    receipt.readback.observedRevision !== afterSha256
  ) {
    return false;
  }
  return beforeSha256 !== afterSha256;
}

export function getCanonicalWorkspaceMutationReceiptPathV1(
  receipt: AgentRunReceipt,
): string | null {
  const output = isRecord(receipt.output) ? receipt.output : null;
  const mutationReceipt =
    output && isRecord(output.receipt) ? output.receipt : null;
  const candidates = [
    mutationReceipt && typeof mutationReceipt.path === "string"
      ? mutationReceipt.path
      : null,
    typeof receipt.path === "string" ? receipt.path : null,
    typeof receipt.resource?.path === "string" ? receipt.resource.path : null,
  ]
    .filter((value): value is string => Boolean(value?.trim()))
    .map((value) => value.replace(/\\/gu, "/").replace(/^(?:\.\/)+/u, ""));
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0]! : null;
}

export const MAX_VERIFIED_WORKSPACE_READ_OBSERVATIONS = 64;

export const MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS = 100_000;

export function normalizeWorkspaceObservationId(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .slice(0, 128) || "adhoc"
  );
}

export function verifiedWorkspaceReadKey(workspaceId: string, path: string): string {
  return JSON.stringify([workspaceId, path]);
}

export function rememberVerifiedWorkspaceReadResult(
  runtimeCache: AgentRuntimeCache | undefined,
  toolCall: Pick<ModelToolCall, "name" | "arguments">,
  context: Pick<
    ToolExecutionContext,
    "rootMissionId" | "runId" | "operationId"
  >,
  result: ToolExecutionResult,
): void {
  if (
    toolCall.name !== "code_workspace_read" ||
    !runtimeCache ||
    !result.ok ||
    !isRecord(result.output)
  ) {
    return;
  }
  const path = getString(result.output.path);
  const sha256 = getString(result.output.sha256);
  // A zero-byte source file (for example a package marker such as
  // `__init__.py`) is still a complete, independently verified read. Do not
  // route it through getString(), which intentionally treats an empty string
  // as absent for identifiers and other required scalar fields.
  const content =
    typeof result.output.content === "string"
      ? result.output.content
      : undefined;
  if (
    !path ||
    !sha256 ||
    !/^sha256:[a-f0-9]{64}$/u.test(sha256) ||
    content === undefined ||
    content.length > MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS
  ) {
    return;
  }
  const workspaceId = normalizeWorkspaceObservationId(
    getString(toolCall.arguments.workspaceId) ??
      context.rootMissionId ??
      context.runId ??
      context.operationId ??
      "adhoc",
  );
  runtimeCache.verifiedWorkspaceReads ??= new Map();
  const key = verifiedWorkspaceReadKey(workspaceId, path);
  if (
    !runtimeCache.verifiedWorkspaceReads.has(key) &&
    runtimeCache.verifiedWorkspaceReads.size >=
      MAX_VERIFIED_WORKSPACE_READ_OBSERVATIONS
  ) {
    const oldestKey = runtimeCache.verifiedWorkspaceReads.keys().next().value;
    if (typeof oldestKey === "string") {
      runtimeCache.verifiedWorkspaceReads.delete(oldestKey);
    }
  }
  runtimeCache.verifiedWorkspaceReads.set(key, {
    workspaceId,
    path,
    sha256,
    content,
  });
}

export function rememberVerifiedMermaidReadResult(
  runtimeCache: AgentRuntimeCache | undefined,
  toolCall: Pick<ModelToolCall, "name">,
  result: ToolExecutionResult,
): void {
  if (!runtimeCache || !result.ok) return;
  if (toolCall.name === "upsert_mermaid_block") {
    runtimeCache.verifiedMermaidRead = undefined;
    return;
  }
  if (toolCall.name !== "read_mermaid_block" || !isRecord(result.output)) {
    return;
  }
  const path = getString(result.output.path);
  const sha256 = getString(result.output.sha256);
  const selector = result.output.selector;
  if (
    !path ||
    !sha256 ||
    !/^sha256:[a-f0-9]{64}$/u.test(sha256) ||
    !isRecord(selector)
  ) {
    return;
  }
  runtimeCache.verifiedMermaidRead = {
    path,
    sha256,
    selector: { ...selector },
  };
}

export function getVerifiedWorkspaceReadObservation(
  runtimeCache: AgentRuntimeCache | undefined,
  path: string,
  workspaceId?: string,
): VerifiedWorkspaceReadObservation | null {
  const observations = runtimeCache?.verifiedWorkspaceReads;
  if (!observations) return null;
  if (workspaceId) {
    return (
      observations.get(
        verifiedWorkspaceReadKey(
          normalizeWorkspaceObservationId(workspaceId),
          path,
        ),
      ) ?? null
    );
  }
  const matches = [...observations.values()].filter(
    (observation) => observation.path === path,
  );
  return matches.length === 1 ? matches[0]! : null;
}

/**
 * Resolve a corrective write only against the single durable workspace that
 * the host independently verified. Earlier model-authored reads may omit or
 * vary the workspace label, so a path-only lookup can become ambiguous after
 * the host refreshes sibling files during a multi-file repair.
 */
export function getVerifiedWorkspaceWriteObservation(
  runtimeCache: AgentRuntimeCache | undefined,
  path: string,
  durableReceipts: readonly AgentRunReceipt[],
): VerifiedWorkspaceReadObservation | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  return workspaceId
    ? getVerifiedWorkspaceReadObservation(runtimeCache, path, workspaceId)
    : null;
}

/**
 * A single explicit web_fetch target is a user-owned read boundary. Bind the
 * provider call back to that URL, and preserve an explicit refresh=true/false
 * directive, so a model cannot silently substitute a sibling domain or bypass
 * the user's cache choice.
 */
export function bindExplicitWebFetchContract(
  prompt: string,
  toolCall: ModelToolCall,
): ModelToolCall | null {
  if (
    toolCall.name !== "web_fetch" ||
    !/\bweb_fetch\b/iu.test(prompt)
  ) {
    return null;
  }
  const urls = new Set<string>();
  for (const match of prompt.matchAll(/https?:\/\/[^\s<>"'`]+/giu)) {
    const candidate = match[0]!.replace(/[)\],.;!?]+$/gu, "");
    if (!candidate) continue;
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        parsed.hash = "";
        urls.add(parsed.toString());
      }
    } catch {
      // Invalid prompt URLs remain model text; do not create a host binding.
    }
  }
  if (urls.size !== 1) return null;

  const refreshMatch = /\brefresh\s*=\s*(true|false)\b/iu.exec(prompt);
  const explicitUrl = [...urls][0]!;
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      url: explicitUrl,
      ...(refreshMatch
        ? { refresh: refreshMatch[1]!.toLowerCase() === "true" }
        : {}),
    },
  };
}

export function attachMissingRequiredLiteralAnchors(
  content: string,
  prompt: string,
): { content: string; insertedAnchors: string[] } {
  const normalizedContent = content.toLowerCase();
  const insertedAnchors = extractRequiredLiteralAnchors(prompt).filter(
    (anchor) => !normalizedContent.includes(anchor.toLowerCase()),
  );
  if (insertedAnchors.length === 0) {
    return { content, insertedAnchors: [] };
  }
  const separator = content.endsWith("\n") ? "\n" : "\n\n";
  return {
    content: `${content}${separator}${insertedAnchors.join("\n")}`,
    insertedAnchors,
  };
}

export function bindVerifiedWorkspaceRead(
  toolCall: ModelToolCall,
  exactPath: string,
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolCall | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  if (toolCall.name !== "code_workspace_read" || !workspaceId || !exactPath) {
    return null;
  }
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      workspaceId,
      path: exactPath,
    },
  };
}

export function escapeRepositoryProfileKeyRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * When the mission names exactly one trusted repository profile key, return it.
 * Zero or multiple named trusted keys fail closed (no host broaden).
 */
export function resolveSingleNamedTrustedRepositoryProfileKey(
  prompt: string,
  trustedProfileKeys: readonly string[],
): string | null {
  if (!prompt.trim() || trustedProfileKeys.length === 0) return null;
  const uniqueTrusted = [
    ...new Set(
      trustedProfileKeys
        .map((key) => (typeof key === "string" ? key.trim() : ""))
        .filter((key) => /^[a-z0-9][a-z0-9._-]*$/u.test(key)),
    ),
  ].sort((left, right) => right.length - left.length || left.localeCompare(right));
  const named = new Set<string>();
  for (const key of uniqueTrusted) {
    const pattern = new RegExp(
      `(^|[^a-z0-9._-])${escapeRepositoryProfileKeyRegExp(key)}(?![a-z0-9._-])`,
      "u",
    );
    if (pattern.test(prompt)) {
      named.add(key);
    }
  }
  if (named.size !== 1) return null;
  return [...named][0]!;
}

/**
 * Host-bind `code_workspace_create` onto verified repository authority from an
 * independently read Linear contract, or the single trusted profile explicitly
 * named in an ordinary repository mission, so create cannot silently fall
 * through to scratch.
 * Preserves a model-provided workspaceId; otherwise leaves fallback to the
 * workspace tool's existing owner/run derivation.
 */
export function bindTrustedRepositoryWorkspaceCreate(
  toolCall: ModelToolCall,
  prompt: string,
  trustedProfileKeys: readonly string[],
  verifiedRepositoryProfileKey?: string | null,
): ModelToolCall | null {
  if (toolCall.name !== "code_workspace_create") return null;
  const repositoryProfileKey =
    verifiedRepositoryProfileKey &&
    trustedProfileKeys.includes(verifiedRepositoryProfileKey)
      ? verifiedRepositoryProfileKey
      : resolveSingleNamedTrustedRepositoryProfileKey(
          prompt,
          trustedProfileKeys,
        );
  if (!repositoryProfileKey) return null;
  const workspaceId =
    typeof toolCall.arguments.workspaceId === "string" &&
    toolCall.arguments.workspaceId.trim()
      ? toolCall.arguments.workspaceId
      : null;
  return {
    ...toolCall,
    arguments: {
      ...(workspaceId ? { workspaceId } : {}),
      kind: "repository",
      repositoryProfileKey,
    },
  };
}

export const VERIFIED_WORKSPACE_LIFECYCLE_TOOL_NAMES = new Set([
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_status",
  "code_repair_record_cycle",
  "code_commit_verified",
]);

export const VERIFIED_WORKSPACE_OBSERVATION_TOOL_NAMES = new Set([
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "read_workspace_file",
  "list_workspace_files",
  "preview_workspace_html",
]);

/**
 * Every consumer after code_workspace_create operates on one host-verified
 * durable workspace. The model may choose a prompt-scoped relative path, but
 * it may never select or transcribe a different workspace identity.
 */
export const VERIFIED_DURABLE_WORKSPACE_CONSUMER_TOOL_NAMES = new Set([
  ...VERIFIED_WORKSPACE_LIFECYCLE_TOOL_NAMES,
  ...VERIFIED_WORKSPACE_OBSERVATION_TOOL_NAMES,
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_export_directory",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
  "write_workspace_file",
  "replace_workspace_text",
  "export_workspace_artifact",
]);

/**
 * Project the single verified create-receipt identity into every downstream
 * provider-visible workspace schema, including multi-tool set-loose frontiers.
 * This is a usability constraint only; execution repeats the same host bind.
 */
export function bindVerifiedWorkspaceIdentityToolSchemas(
  tools: readonly ModelToolDefinition[],
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolDefinition[] {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  if (!workspaceId) return [...tools];
  return tools.map((tool) => {
    if (
      !VERIFIED_DURABLE_WORKSPACE_CONSUMER_TOOL_NAMES.has(
        tool.function.name,
      )
    ) {
      return tool;
    }
    const parameters = tool.function.parameters;
    const existingWorkspaceId = parameters.properties?.workspaceId ?? {};
    return {
      ...tool,
      function: {
        ...tool.function,
        parameters: {
          ...parameters,
          properties: {
            ...(parameters.properties ?? {}),
            workspaceId: {
              ...existingWorkspaceId,
              type: "string",
              enum: [workspaceId],
              description:
                "Exact opaque workspace identity from the host-verified durable creation receipt.",
            },
          },
          required: [
            ...new Set([...(parameters.required ?? []), "workspaceId"]),
          ],
        },
      },
    };
  });
}

/**
 * Rebind every downstream workspace consumer at the execution boundary. This
 * prevents an omitted, stale, or model-invented alias from reaching the
 * workspace manager even when a provider ignores the schema enum.
 */
export function bindVerifiedWorkspaceIdentityToolCall(
  toolCall: ModelToolCall,
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolCall | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  if (
    !workspaceId ||
    !VERIFIED_DURABLE_WORKSPACE_CONSUMER_TOOL_NAMES.has(toolCall.name)
  ) {
    return null;
  }
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      workspaceId,
    },
  };
}

export const HOST_DRIVEN_EXACT_CODE_VALIDATION_TOOL_NAMES = new Set([
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
]);

/**
 * Exact validation nodes have no model-authored command or destination: the
 * RepositoryProfile/scratch profile, workspace, command, staging manifest,
 * and artifacts are all rebound by the host. If a model twice refuses the
 * only ready validation schema, the host may request that one graph-bound
 * action with a deterministic per-run receipt scope. Approval and prepared
 * action policy remain unchanged.
 */
export function buildExactCodeValidationFallbackToolCall(
  readyToolNames: readonly string[],
  runId: string,
): ModelToolCall | null {
  if (
    readyToolNames.length !== 1 ||
    !HOST_DRIVEN_EXACT_CODE_VALIDATION_TOOL_NAMES.has(readyToolNames[0] ?? "")
  ) {
    return null;
  }
  const repairRequestId = codeRepairRequestIdForRun(runId);
  if (!repairRequestId) {
    return null;
  }
  return {
    name: readyToolNames[0]!,
    arguments: {
      repairRequestId,
      expectedArtifacts: [],
      environment: {},
    },
  };
}

/**
 * A known-folder delivery must export the verified workspace tree, not a
 * model-selected file or workspace transcription. Bind the one foreground
 * destination named by the user and use a run-scoped absent directory so the
 * export remains exact, approval-gated, and non-overwriting.
 */
/** Request verbs, articles, and pronouns carry no meaning in a folder name. */
export const DELIVERABLE_LABEL_STOPWORDS_V1 = new Set([
  "a",
  "an",
  "the",
  "my",
  "your",
  "our",
  "me",
  "it",
  "this",
  "that",
  "some",
  "new",
  "please",
  "just",
  "can",
  "could",
  "would",
  "you",
  "write",
  "create",
  "make",
  "build",
  "generate",
  "save",
  "add",
  "implement",
  "develop",
  "and",
  "of",
  "for",
  "in",
  "on",
  "to",
  "with",
  "using",
]);

/** Nouns that name the artifact itself. "cli" is a descriptor, not an artifact. */
export const DELIVERABLE_ARTIFACT_NOUNS_V1 =
  /\b(game|app|application|script|tool|program|solver|organizer|library|package|module)\b/gu;

/**
 * A readable folder name for a delivered code artifact, derived from what the
 * user asked for. Previously only the number-guessing e2e prompt got a real
 * name and every other request landed on the Desktop as
 * `code-deliverable-<hex>`, which tells the user nothing about what it is.
 *
 * The result becomes a filesystem path segment, so it is strictly bounded and
 * sanitized to lowercase `[a-z0-9-]` here rather than trusting prompt text.
 */
export function deliverableLabelFromPromptV1(prompt: string): string {
  const fallback = "code-deliverable";
  const text = String(prompt ?? "").toLowerCase();
  // Take the LAST artifact noun: "a cli checkers game" names a game, not a cli.
  const matches = [...text.matchAll(DELIVERABLE_ARTIFACT_NOUNS_V1)];
  const artifact = matches[matches.length - 1];
  if (!artifact || artifact.index === undefined) return fallback;
  const noun = artifact[1]!;
  const preceding = text
    .slice(0, artifact.index)
    .split(/[^a-z0-9]+/u)
    .filter(
      (word) =>
        word.length > 0 &&
        word.length <= 20 &&
        !DELIVERABLE_LABEL_STOPWORDS_V1.has(word),
    )
    .slice(-3);
  const label = [...preceding, noun]
    .join("-")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 48)
    .replace(/-+$/u, "");
  // A label of only the bare noun ("game") is no better than the fallback.
  return label.length > noun.length ? label : fallback;
}

/** The same label as ordinary prose, for a human-facing sentence. */
export function deliverableTitleFromPromptV1(prompt: string): string | null {
  const label = deliverableLabelFromPromptV1(prompt);
  return label === "code-deliverable" ? null : label.replace(/-/gu, " ");
}

export function bindVerifiedWorkspaceDirectoryExport(
  toolCall: ModelToolCall,
  prompt: string,
  runId: string,
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolCall | null {
  if (toolCall.name !== "code_workspace_export_directory") return null;
  if (hasExplicitNoHostDirectoryExportIntent(prompt)) return null;
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  const hasExplicitKnownHostDirectory =
    hasKnownHostDirectoryExportIntent(prompt);
  if (
    !workspaceId ||
    (!hasExplicitKnownHostDirectory && !hasCodeDeliverableIntent(prompt))
  ) {
    return null;
  }

  const destinationRoots = new Set<
    "desktop" | "documents" | "downloads"
  >();
  if (/\bdesktop\b/iu.test(prompt)) destinationRoots.add("desktop");
  if (/\bdocuments?(?:\s+folder)?\b/iu.test(prompt)) {
    destinationRoots.add("documents");
  }
  if (/\bdownloads?(?:\s+folder)?\b/iu.test(prompt)) {
    destinationRoots.add("downloads");
  }
  if (destinationRoots.size > 1) return null;
  const destinationRoot =
    destinationRoots.size === 1
      ? [...destinationRoots][0]!
      : "vault_sibling_projects";

  const normalizedRunId = runId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "");
  const runSuffix = normalizedRunId.slice(-12) || "deliverable";
  const deliverableLabel = deliverableLabelFromPromptV1(prompt);
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      workspaceId,
      sourcePath: "",
      destinationRoot,
      destinationPath: `${deliverableLabel}-${runSuffix}`,
    },
  };
}

/**
 * A receipt-backed host export already owns the terminal delivery projection.
 * Asking the provider for an empty-turn streaming rewrite adds latency and can
 * strand an otherwise completed mission, while its prose is discarded anyway.
 */
export function shouldRequestStreamingFinalProjection(input: {
  enableStreaming: boolean;
  hasDirectFinalContent: boolean;
  verifiedHostExportFinalAnswer: string | null;
}): boolean {
  return (
    input.enableStreaming &&
    !input.hasDirectFinalContent &&
    input.verifiedHostExportFinalAnswer === null
  );
}

/**
 * A receipt-backed answer can itself pay the graph's terminal projection debt.
 * This is intentionally narrow: tool, write, web, and lifecycle proof never
 * qualify here and remain mandatory before finalization.
 */
export function missionAcceptanceHasOnlyFinalProjectionDebt(
  acceptance: Pick<MissionAcceptanceResult, "missing">,
): boolean {
  return (
    acceptance.missing.length > 0 &&
    acceptance.missing.every(
      (item) =>
        item === "final_output" ||
        /(?:^|:)final_relevance$/u.test(item) ||
        /(?:^|:)final_output$/u.test(item),
    )
  );
}

/**
 * A verified host-directory export is already a complete, receipt-backed
 * terminal answer. Once acceptance passes and every explicit proof debt is
 * paid, a controller routing label cannot add authority; another provider turn
 * can only add latency or strand the completed run behind model prose that
 * will be replaced.
 */
export function shouldFinalizeVerifiedHostExportAfterToolUse(input: {
  verifiedHostExportFinalAnswer: string | null;
  acceptanceStatus: MissionAcceptanceResult["status"];
  onlyFinalProjectionProofMissing: boolean;
  pendingRequiredWriteCount: number;
  missingRequiredWebToolCount: number;
  hasPendingOperationGoals: boolean;
  pendingStreamingWriteback: boolean;
  setLooseDeliveryStillUnpaid: boolean;
}): boolean {
  return (
    input.verifiedHostExportFinalAnswer !== null &&
    input.verifiedHostExportFinalAnswer.trim().length > 0 &&
    (input.acceptanceStatus === "pass" ||
      input.onlyFinalProjectionProofMissing) &&
    input.pendingRequiredWriteCount === 0 &&
    input.missingRequiredWebToolCount === 0 &&
    !input.hasPendingOperationGoals &&
    !input.pendingStreamingWriteback &&
    !input.setLooseDeliveryStillUnpaid
  );
}

/**
 * The model may summarize an export, but only the verified host-directory
 * receipt can name where the files landed. Project that receipt into the
 * visible completion message so a plausible but false Desktop path is never
 * shown after a successful delivery.
 */
export function buildVerifiedHostExportFinalAnswer(
  prompt: string,
  durableReceipts: readonly AgentRunReceipt[],
  successfulToolNames: readonly string[],
): string | null {
  const verifiedExportReceipts = durableReceipts.filter(
    (receipt) =>
      receipt.toolName === "code_workspace_export_directory" &&
      receipt.operation === "create" &&
      receipt.readback?.status === "verified",
  );
  if (verifiedExportReceipts.length === 0) return null;
  const exportPaths = new Set(
    verifiedExportReceipts
      .flatMap((receipt) => {
        const output = isRecord(receipt.output) ? receipt.output : null;
        return [
          receipt.resource?.path?.trim() ?? "",
          receipt.path?.trim() ?? "",
          getString(output?.destinationPath)?.trim() ?? "",
        ];
      })
      .filter(
        (exportPath) =>
          /^(?:[A-Za-z]:[\\/]|\/)/u.test(exportPath),
      ),
  );
  if (exportPaths.size !== 1) {
    return [
      "## Delivery completed, but the export path needs review",
      "",
      "The host recorded a verified directory-export receipt, but it could not project one unambiguous absolute path into Chat.",
      "",
      "Open Run Details and use the verified export receipt path; do not rely on a path written by the model.",
    ].join("\n");
  }
  const exportPath = [...exportPaths][0]!;
  const createdPaths = durableReceipts
    .filter(
      (receipt) =>
        receipt.toolName === "code_workspace_create_file" &&
        (receipt.commitKind === "committed" ||
          receipt.commitKind === "reconciled") &&
        receipt.readback?.status === "verified",
    )
    .flatMap((receipt) => {
      const output = isRecord(receipt.output) ? receipt.output : null;
      return [
        receipt.resource?.path?.trim() ?? "",
        receipt.path?.trim() ?? "",
        getString(output?.path)?.trim() ?? "",
      ];
    })
    .filter((createdPath) => createdPath.length > 0);
  const pythonEntryPoint =
    createdPaths.find((createdPath) => /(?:^|\/)main\.py$/iu.test(createdPath)) ??
    createdPaths.find((createdPath) => /\.py$/iu.test(createdPath)) ??
    null;
  const completedValidations = [
    ["code_validate_fast", "fast"],
    ["code_validate_targeted", "targeted"],
    ["code_validate_full", "full"],
  ]
    .filter(([toolName]) => successfulToolNames.includes(toolName!))
    .map(([, label]) => label!);
  // Name what was actually built. This used to read "Python number guessing
  // game" only for that exact e2e prompt and "Code delivered" for everything
  // else, so a delivered checkers game announced itself anonymously.
  const deliverableTitle = deliverableTitleFromPromptV1(prompt);
  const lines = [
    deliverableTitle
      ? `## Done — ${deliverableTitle} delivered`
      : "## Done — Code delivered",
    "",
    deliverableTitle
      ? `I created the requested ${deliverableTitle} and delivered the verified workspace to the requested folder.`
      : "I created the requested code deliverable and delivered the verified workspace to the requested folder.",
    "",
    `- Verified export path: \`${exportPath}\``,
    pythonEntryPoint ? `- Entry point: \`${pythonEntryPoint}\`` : "",
    completedValidations.length > 0
      ? `- Sandbox validation passed: ${completedValidations.join(", ")}`
      : "",
    "",
    pythonEntryPoint
      ? `Run it from the exported directory with \`python ${pythonEntryPoint}\`.`
      : "Open the verified export path above to use the delivered files.",
  ];
  return lines.filter((line, index) => line || lines[index - 1] !== "").join("\n");
}

/**
 * Validate/repair/commit must target the independently verified durable
 * workspace from create receipts and one host-derived request id for the root
 * run. Models often reuse a prompt label or vary requestId/repairRequestId
 * across calls; those values are transcription hints, never authority.
 */
export function bindVerifiedWorkspaceLifecycleTool(
  toolCall: ModelToolCall,
  durableReceipts: readonly AgentRunReceipt[],
  rootRunId: string,
): ModelToolCall | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  const repairRequestId = codeRepairRequestIdForRun(rootRunId);
  if (
    !VERIFIED_WORKSPACE_LIFECYCLE_TOOL_NAMES.has(toolCall.name) ||
    !workspaceId ||
    !repairRequestId
  ) {
    return null;
  }
  const {
    requestId: _modelRequestId,
    repairRequestId: _modelRepairRequestId,
    ...modelArguments
  } = toolCall.arguments;
  const requestBinding = HOST_DRIVEN_EXACT_CODE_VALIDATION_TOOL_NAMES.has(
    toolCall.name,
  )
    ? { repairRequestId }
    : { requestId: repairRequestId };
  return {
    ...toolCall,
    arguments: {
      ...modelArguments,
      workspaceId,
      ...requestBinding,
    },
  };
}

/**
 * Once workspace creation has a single verified durable receipt, read-only
 * workspace observations must inspect that workspace. Model-authored
 * workspace IDs are transcription hints and can become stale across
 * continuation segments or after a provider retries an earlier call.
 */
export function bindVerifiedWorkspaceObservationTool(
  toolCall: ModelToolCall,
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolCall | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  if (
    !VERIFIED_WORKSPACE_OBSERVATION_TOOL_NAMES.has(toolCall.name) ||
    !workspaceId
  ) {
    return null;
  }
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      workspaceId,
    },
  };
}

export function codeRepairRequestIdForRun(runId: string): string | null {
  const normalizedRunId = runId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return normalizedRunId
    ? `repair-${normalizedRunId}`.slice(0, 128)
    : null;
}

/**
 * Empty or explicit placeholder bodies may be rebound onto the ready graph
 * path. Non-empty content for a different path must fail closed so foreign
 * file bodies are never written onto the current selector.
 */
export function isWorkspaceCreateFilePlaceholderContent(
  content: unknown,
): boolean {
  if (content === undefined || content === null) return true;
  if (typeof content !== "string") return false;
  const trimmed = content.trim();
  if (trimmed.length === 0) return true;
  return /^#\s*placeholder\b/i.test(trimmed);
}

export function bindVerifiedWorkspaceCreateFile(
  toolCall: ModelToolCall,
  graphPath: string | null,
  durableReceipts: readonly AgentRunReceipt[],
): ModelToolCall | null {
  const workspaceId = getSingleVerifiedDurableWorkspaceId(durableReceipts);
  if (
    toolCall.name !== "code_workspace_create_file" ||
    !workspaceId
  ) {
    return null;
  }
  const exactPath =
    graphPath && !graphPath.startsWith("prompt-scoped-")
      ? graphPath
      : null;
  const requestedPath =
    typeof toolCall.arguments.path === "string"
      ? toolCall.arguments.path.trim()
      : "";
  if (
    exactPath &&
    requestedPath &&
    requestedPath !== exactPath &&
    !isWorkspaceCreateFilePlaceholderContent(toolCall.arguments.content)
  ) {
    // Fail closed: do not rewrite path while keeping foreign non-placeholder content.
    return null;
  }
  const boundPath = exactPath ?? requestedPath;
  if (!boundPath) return null;
  return {
    ...toolCall,
    arguments: {
      ...toolCall.arguments,
      workspaceId,
      path: boundPath,
    },
  };
}

export function bindVerifiedWorkspaceWriteExpected(
  toolCall: ModelToolCall,
  exactPath: string,
  observation: VerifiedWorkspaceReadObservation,
  exactContent?: string | null,
): ModelToolCall | null {
  if (
    toolCall.name !== "code_workspace_write_expected" ||
    observation.path !== exactPath ||
    !/^sha256:[a-f0-9]{64}$/u.test(observation.sha256)
  ) {
    return null;
  }
  const content =
    typeof exactContent === "string" && exactContent.length > 0
      ? exactContent
      : toolCall.arguments.lineReplacements !== undefined
        ? applyExactWorkspaceLineRangeCorrections(
            observation.content,
            toolCall.arguments.lineReplacements,
          )
        : toolCall.arguments.replacements !== undefined
          ? applyExactWorkspaceCorrectionReplacements(
              observation.content,
              toolCall.arguments.replacements,
            )
          : typeof toolCall.arguments.content === "string"
            ? toolCall.arguments.content
            : null;
  if (content === null) return null;
  return {
    ...toolCall,
    arguments: {
      workspaceId: observation.workspaceId,
      path: exactPath,
      content,
      expectedSha256: observation.sha256,
    },
  };
}

export function applyExactWorkspaceCorrectionReplacements(
  currentContent: string,
  value: unknown,
): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    return null;
  }
  let next = currentContent;
  for (const entry of value) {
    if (!isRecord(entry)) return null;
    if (
      Object.keys(entry).some(
        (key) => !["oldText", "newText", "expectedOccurrences"].includes(key),
      ) ||
      typeof entry.oldText !== "string" ||
      entry.oldText.length === 0 ||
      typeof entry.newText !== "string" ||
      (entry.expectedOccurrences !== undefined &&
        (typeof entry.expectedOccurrences !== "number" ||
          !Number.isInteger(entry.expectedOccurrences) ||
          entry.expectedOccurrences < 1 ||
          entry.expectedOccurrences > 12))
    ) {
      return null;
    }
    const expectedOccurrences = typeof entry.expectedOccurrences === "number"
      ? entry.expectedOccurrences
      : 1;
    const parts = next.split(entry.oldText);
    const observedOccurrences = parts.length - 1;
    if (observedOccurrences !== expectedOccurrences) {
      return null;
    }
    next = parts.join(entry.newText);
    if (next.length > MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS) return null;
  }
  return next;
}

export interface WorkspaceSourceLineRange {
  start: number;
  contentEnd: number;
  separator: string;
}

export function applyExactWorkspaceLineRangeCorrections(
  currentContent: string,
  value: unknown,
): string | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) {
    return null;
  }
  const sourceLines = workspaceSourceLineRanges(currentContent);
  const edits: Array<{
    startLine: number;
    endLine: number;
    start: number;
    end: number;
    replacement: string;
  }> = [];
  let totalSelectedLines = 0;
  let totalReplacementChars = 0;
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      Object.keys(entry).some(
        (key) => !["startLine", "endLine", "newText"].includes(key),
      ) ||
      typeof entry.startLine !== "number" ||
      !Number.isSafeInteger(entry.startLine) ||
      typeof entry.endLine !== "number" ||
      !Number.isSafeInteger(entry.endLine) ||
      typeof entry.newText !== "string" ||
      entry.newText.length === 0 ||
      entry.newText.length > MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS ||
      entry.startLine < 1 ||
      entry.endLine < entry.startLine ||
      entry.endLine > sourceLines.length
    ) {
      return null;
    }
    const selectedLineCount = entry.endLine - entry.startLine + 1;
    totalSelectedLines += selectedLineCount;
    totalReplacementChars += entry.newText.length;
    if (
      selectedLineCount > 400 ||
      totalSelectedLines > 600 ||
      totalReplacementChars > MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS
    ) return null;
    const firstLine = sourceLines[entry.startLine - 1]!;
    const lastLine = sourceLines[entry.endLine - 1]!;
    const separator = lastLine.separator || preferredWorkspaceLineSeparator(
      sourceLines,
    );
    let replacement = normalizeWorkspaceReplacementLineEndings(
      entry.newText,
      separator || "\n",
    );
    if (lastLine.separator) {
      replacement = `${replacement.replace(/(?:\r\n|\r|\n)$/u, "")}${lastLine.separator}`;
    }
    edits.push({
      startLine: entry.startLine,
      endLine: entry.endLine,
      start: firstLine.start,
      end: lastLine.contentEnd + lastLine.separator.length,
      replacement,
    });
  }
  edits.sort((left, right) => left.startLine - right.startLine);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index]!.startLine <= edits[index - 1]!.endLine) return null;
  }
  let next = currentContent;
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    next = `${next.slice(0, edit.start)}${edit.replacement}${next.slice(edit.end)}`;
    if (next.length > MAX_VERIFIED_WORKSPACE_READ_CONTENT_CHARS) return null;
  }
  return next === currentContent ? null : next;
}

export function workspaceSourceLineRanges(content: string): WorkspaceSourceLineRange[] {
  const ranges: WorkspaceSourceLineRange[] = [];
  let start = 0;
  const newline = /\r\n|\r|\n/gu;
  for (let match = newline.exec(content); match; match = newline.exec(content)) {
    ranges.push({
      start,
      contentEnd: match.index,
      separator: match[0],
    });
    start = match.index + match[0].length;
  }
  ranges.push({ start, contentEnd: content.length, separator: "" });
  return ranges;
}

export function preferredWorkspaceLineSeparator(
  lines: readonly WorkspaceSourceLineRange[],
): string {
  return lines.find((line) => line.separator)?.separator ?? "";
}

export function normalizeWorkspaceReplacementLineEndings(
  value: string,
  separator: string,
): string {
  return value.replace(/\r\n|\r|\n/gu, separator);
}

/**
 * Reject model shorthand before it can replace a hash-bound source file.
 * This deliberately targets only whole-payload stubs; legitimate source may
 * contain TODOs or placeholder identifiers inside an otherwise complete file.
 */
export function isIncompleteWorkspaceReplacementContent(
  value: unknown,
): boolean {
  if (typeof value !== "string") return true;
  const normalized = value
    .trim()
    .replace(/^```[^\r\n]*[\r\n]+|[\r\n]+```$/gu, "")
    .trim()
    .toLowerCase();
  if (!normalized) return true;
  return /^(?:(?:\/\/|#|\/\*+|<!--)\s*)?(?:placeholder|todo|fixme|tbd|tbc|pass|stub|same as (?:above|before)|unchanged|content omitted|implementation omitted|\.\.\.)(?:\s*(?:\*\/|-->)\s*)?[.!;]*$/u.test(
    normalized,
  );
}

/**
 * Omitted-content shorthand cannot authorize a destructive replacement. When
 * the exact graph already has a fresh hash/content read, bind the operation to
 * that byte-identical content so the node records a safe no-op and validation
 * remains responsible for deciding whether another file still needs repair.
 */
export function bindIncompleteWorkspaceReplacementToVerifiedNoop(
  toolCall: ModelToolCall,
  observation: VerifiedWorkspaceReadObservation,
): ModelToolCall {
  return {
    ...toolCall,
    arguments: {
      workspaceId: observation.workspaceId,
      path: observation.path,
      content: observation.content,
      expectedSha256: observation.sha256,
    },
  };
}

export function getMissionGraphWorkspaceWriteSelectors(
  graph: MissionGraphV3,
): string[] {
  const selectors = new Set<string>();
  for (const node of Object.values(graph.nodes)) {
    const lifecycle = getSafeMissionCompositeLifecycleSpecV1(node);
    if (lifecycle) {
      for (const action of lifecycle.actions) {
        if (
          isAdaptiveCodeWorkspaceMutationToolNameV1(action.toolName) &&
          action.selector &&
          !action.selector.startsWith("prompt-scoped-")
        ) {
          selectors.add(action.selector);
        }
      }
      continue;
    }
    if (!node.allowedTools.includes("code_workspace_write_expected")) {
      continue;
    }
    const selector = getMissionGraphNodeSelector(node);
    if (selector && !selector.startsWith("prompt-scoped-")) {
      selectors.add(selector);
    }
  }
  return [...selectors].sort();
}

export function normalizeValidationRecoveryCandidatePathV1(
  value: unknown,
): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/^(?:\.\/)+/u, "");
  if (
    !normalized ||
    normalized.length > 512 ||
    normalized.includes("\\") ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    return null;
  }
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return null;
  }
  return normalized;
}

export function validationRecoveryPathAtOrBelowV1(
  allowedPath: string,
  candidatePath: string,
): boolean {
  const allowed = allowedPath.toLowerCase();
  const candidate = candidatePath.toLowerCase();
  return candidate === allowed || candidate.startsWith(`${allowed}/`);
}

export function isConcreteRepositoryRecoveryPathV1(path: string): boolean {
  const basename = path.split("/").at(-1) ?? path;
  return (
    /\.[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(basename) ||
    /^(?:Dockerfile|Jenkinsfile|Makefile|README|LICENSE)$/iu.test(basename)
  );
}

/**
 * Repository-bound set-loose missions intentionally let the provider choose
 * issue-required filenames after the independent Linear read. Those paths may
 * therefore be absent from the initial graph, but the canonical workspace
 * creation receipt still carries the exact trusted repository allowlist.
 * Recover only concrete allowlisted files plus verified mutation paths beneath
 * that same single scope; never infer a new descendant of an allowed directory.
 */
export function getReceiptBackedWorkspaceRecoveryPathsV1(
  durableReceipts: readonly AgentRunReceipt[],
): string[] {
  const scopeVariants = new Map<string, string[]>();
  for (const receipt of durableReceipts) {
    if (
      receipt.toolName !== "code_workspace_create" ||
      (receipt.commitKind !== "committed" &&
        receipt.commitKind !== "reconciled") ||
      receipt.readback?.status !== "verified" ||
      receipt.resource?.system !== "workspace"
    ) {
      continue;
    }
    const output = isRecord(receipt.output) ? receipt.output : null;
    const scope =
      output && isRecord(output.repositoryWriteScope)
        ? output.repositoryWriteScope
        : null;
    if (!scope || !Array.isArray(scope.projects)) continue;
    const allowedPaths = [
      ...new Set(
        scope.projects.flatMap((rawProject) => {
          if (!isRecord(rawProject) || !Array.isArray(rawProject.allowedPaths)) {
            return [];
          }
          return rawProject.allowedPaths
            .map(normalizeValidationRecoveryCandidatePathV1)
            .filter((path): path is string => path !== null);
        }),
      ),
    ].sort();
    if (allowedPaths.length > 0) {
      scopeVariants.set(JSON.stringify(allowedPaths), allowedPaths);
    }
  }
  if (scopeVariants.size !== 1) return [];
  const allowedPaths = [...scopeVariants.values()][0]!;
  const candidates = new Set(
    allowedPaths.filter(isConcreteRepositoryRecoveryPathV1),
  );
  for (const receipt of durableReceipts) {
    if (
      !isAdaptiveCodeWorkspaceMutationToolNameV1(receipt.toolName) ||
      !receiptProvesWorkspaceContentChangeV1(receipt)
    ) {
      continue;
    }
    const path = normalizeValidationRecoveryCandidatePathV1(
      getCanonicalWorkspaceMutationReceiptPathV1(receipt),
    );
    if (
      path &&
      allowedPaths.some((allowedPath) =>
        validationRecoveryPathAtOrBelowV1(allowedPath, path),
      )
    ) {
      candidates.add(path);
    }
  }
  return [...candidates].sort();
}

/**
 * Treat validator output as untrusted narrowing evidence only. When it names
 * one or more exact writable files, later correction nodes may mutate only
 * those files; every other exact path is converted to a SHA-bound no-op. If
 * the diagnostic names no writable file, this returns an empty set and does
 * not invent a target or suppress a potentially necessary repair.
 */
/** True when the red diagnostic is a parse/indent failure that needs a full rewrite. */
export function diagnosticRequestsFullFileReplacement(
  diagnostic: CodeValidationDiagnosticObservation | null,
  path: string,
): boolean {
  if (!diagnostic || !path.trim()) return false;
  const searchable = `${diagnostic.stdout}\n${diagnostic.stderr}`.replace(
    /\\/gu,
    "/",
  );
  if (!searchable.trim()) return false;
  const normalizedPath = path.replace(/\\/gu, "/").toLowerCase();
  const basename = normalizedPath.split("/").at(-1) ?? normalizedPath;
  const mentionsPath =
    searchable.toLowerCase().includes(normalizedPath) ||
    (basename.length > 0 && searchable.toLowerCase().includes(basename));
  if (!mentionsPath) return false;
  return /(?:SyntaxError|IndentationError|TabError|ParseError|unexpected indent|invalid syntax|unindent does not match)/iu
    .test(searchable);
}

export function getDiagnosticSelectedWorkspaceCorrectionPaths(
  graph: MissionGraphV3,
  diagnostic: CodeValidationDiagnosticObservation | null,
  durableReceipts: readonly AgentRunReceipt[] = [],
): string[] {
  if (!diagnostic) return [];
  const searchable = `${diagnostic.stdout}\n${diagnostic.stderr}`
    .replace(/\\/gu, "/")
    .toLowerCase();
  if (!searchable.trim()) return [];
  const writablePaths = [
    ...new Set([
      ...getMissionGraphWorkspaceWriteSelectors(graph),
      ...getReceiptBackedWorkspaceRecoveryPathsV1(durableReceipts),
    ]),
  ].sort();
  const directMatches = writablePaths.filter((path) => {
    const normalizedPath = path.replace(/\\/gu, "/").toLowerCase();
    if (searchable.includes(normalizedPath)) return true;
    const extensionIndex = normalizedPath.lastIndexOf(".");
    const modulePath = (extensionIndex > normalizedPath.lastIndexOf("/")
      ? normalizedPath.slice(0, extensionIndex)
      : normalizedPath
    ).replace(/\//gu, ".");
    return modulePath.includes(".") && searchable.includes(modulePath);
  });
  const assertionLike =
    /(?:assertionerror|\bassert\b|mismatch|expected|actual|test(?:s)? failed|validation failed)/iu
      .test(searchable);
  const protectedContractFailure =
    /(?:^|[/\s])scripts\/verify_[a-z0-9_]+\.py\b|protected\s+contract/iu.test(
      searchable,
    );
  const implementationCandidates = writablePaths.filter(
    isPlausibleWorkspaceImplementationPath,
  );
  if (directMatches.length > 0) {
    if (!assertionLike) return directMatches;

    // Assertion tracebacks normally name the generated test/verifier line
    // that observed the defect. Prefer a directly named implementation module
    // so agents cannot weaken tests when the implementation is clearly named.
    const directImplementationMatches = directMatches.filter(
      isPlausibleWorkspaceImplementationPath,
    );
    if (directImplementationMatches.length > 0) {
      return directImplementationMatches;
    }
    const directTestMatches = directMatches.filter(isPlausibleWorkspaceTestPath);
    // When only self-authored tests appear and the protected scripts/contract
    // did not fail, the protected contract already accepted the implementation.
    // Allow correcting those tests instead of forcing preserveCurrent on them
    // while rewriting a green game module.
    if (directTestMatches.length > 0 && !protectedContractFailure) {
      return directTestMatches;
    }
    return implementationCandidates.length === 1
      ? implementationCandidates
      : [];
  }

  // A protected assertion often reports only its own immutable verifier path
  // (for example scripts/verify_project.py), not the generated module whose
  // behavior was wrong. Narrow only when the declared outputs contain exactly
  // one plausible implementation module. This can reduce authority but never
  // chooses between multiple source candidates.
  if (!assertionLike) {
    return [];
  }
  return implementationCandidates.length === 1
    ? implementationCandidates
    : [];
}

export function isPlausibleWorkspaceTestPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/(?:^|\/)(?:test|tests|spec|specs|__tests__)(?:\/|$)/u.test(normalized)) {
    return true;
  }
  return /(?:^|[._-])(?:test|spec)\.[a-z0-9]+$/u.test(basename);
}

export function isPlausibleWorkspaceImplementationPath(path: string): boolean {
  const normalized = path.replace(/\\/gu, "/").toLowerCase();
  const basename = normalized.split("/").at(-1) ?? normalized;
  if (/\.(?:md|mdx|rst|txt|adoc)$/u.test(basename)) return false;
  if (isPlausibleWorkspaceTestPath(normalized)) {
    return false;
  }
  if (/^(?:__init__|index|main|cli)\.[a-z0-9]+$/u.test(basename)) {
    return false;
  }
  return /\.(?:py|ts|tsx|js|jsx|mjs|cjs|java|c|cc|cpp|cxx|h|hh|hpp|hxx|cs|go|rs|rb|php|swift|kt|kts)$/u.test(
    basename,
  );
}
