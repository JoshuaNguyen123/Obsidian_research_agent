import { detectChatOnlyIntent } from "./noteOutputPolicy";
import type {
  PipelineLineageV1,
  PipelineStageStateV1,
  ReflectionContextV1,
} from "./pipelineLineage";
import {
  buildGitHubPullRequestUrlV1,
  buildGitHubRepositoryUrlV1,
  extractPipelineCiteFactsV1,
  type PipelineCiteFactsV1,
} from "./pipelineLineage";

/**
 * Host-owned initiating-note reflection for compound completion.
 *
 * Prose cites ledger/lineage facts (Linear issue, validation status, commit SHA,
 * draft PR / repo URLs). Raw receipt IDs and fingerprints stay in Run Details via
 * ReflectionContextV1.receiptIds — never dumped into the note.
 *
 * Coordinator call site (Wave-2 wire-up; do not bury logic in AgentRunner):
 *
 * ```ts
 * const pipeline = buildPipelineLineageV1({ lineage, reflection });
 * const context = buildReflectionContextV1({ runId, ledger, pipeline, persistence });
 * const completion = reflectMissionCompletion({ ..., reflectionContext: context });
 * const plan = buildInitiatingNoteReflectionV1({
 *   runId,
 *   context,
 *   pipeline,
 *   initiatingNotePath,
 *   prompt,
 *   forceChatOnly,
 *   chatOnlyOverride,
 *   workingMode,
 *   explicitChatOnly,
 *   linearIssueUrls, // optional provider readbacks
 * });
 * if (plan.shouldWriteNote) {
 *   // append plan.markdown to initiating note (marker-idempotent)
 * } else {
 *   // surface plan.chatSummary in Chat only
 * }
 * // receipts: context.receiptIds / Run Details only
 * ```
 */

export type InitiatingNoteChatOnlyReasonV1 =
  | "force_chat_only"
  | "chat_only_override"
  | "working_mode_chat_only"
  | "explicit_chat_only"
  | "prompt_chat_only"
  | "reflection_not_requested"
  | "persistence_chat_only_not_persisted"
  | "completion_incomplete"
  | "no_initiating_note";

export type InitiatingNoteReflectionDestinationV1 =
  | { kind: "initiating_note"; notePath: string }
  | { kind: "chat_only"; reason: InitiatingNoteChatOnlyReasonV1 };

export interface InitiatingNoteReflectionCitesV1 {
  runId: string;
  notePath?: string;
  linearIssueIds: string[];
  linearIssueUrls: string[];
  commitSha?: string;
  pullRequestNumber?: number;
  pullRequestUrl?: string;
  repositoryUrl?: string;
  branch?: string;
  validation: {
    targetedPassed: boolean;
    fullPassed: boolean;
    state: PipelineStageStateV1;
  };
  gaps: string[];
  /** True when lineage/pipeline verification is complete. */
  pipelineVerified: boolean;
}

export interface InitiatingNoteReflectionPlanV1 {
  version: 1;
  /** Append `markdown` to the initiating note when true. */
  shouldWriteNote: boolean;
  destination: InitiatingNoteReflectionDestinationV1;
  /** Stable HTML comment for append-once idempotency. */
  marker: string;
  /** Ledger-grounded prose section (no raw receipt dump). */
  markdown: string;
  /** Same facts for Chat when note write is suppressed. */
  chatSummary: string;
  cites: InitiatingNoteReflectionCitesV1;
}

export interface InitiatingNoteReflectionInputV1 {
  runId: string;
  context?: ReflectionContextV1 | null;
  pipeline?: PipelineLineageV1 | null;
  /** Bound initiating / source note path. */
  initiatingNotePath?: string | null;
  /** Optional Linear issue URLs from provider readback (lineage may only have IDs). */
  linearIssueUrls?: readonly string[];
  /** Optional marker suffix; defaults to runId. */
  markerId?: string;
  prompt?: string;
  forceChatOnly?: boolean;
  chatOnlyOverride?: boolean;
  workingMode?: "automatic" | "chat_only" | "custom";
  /** From classifyMissionSpeechAct(...).explicitChatOnly */
  explicitChatOnly?: boolean;
  /**
   * When persistence is chat_only_not_persisted, suppress note write even if
   * the mission otherwise looks note-bound.
   */
  persistence?: ReflectionContextV1["persistence"];
}

export interface InitiatingNoteReflectionSuppressionV1 {
  suppress: boolean;
  reason?: InitiatingNoteChatOnlyReasonV1;
}

/**
 * Chat-only / no-note suppression for initiating-note reflection writeback.
 * Explicit Chat-only always wins over compound delivery defaults.
 */
export function resolveInitiatingNoteReflectionSuppression(
  input: Pick<
    InitiatingNoteReflectionInputV1,
    | "prompt"
    | "forceChatOnly"
    | "chatOnlyOverride"
    | "workingMode"
    | "explicitChatOnly"
    | "persistence"
    | "initiatingNotePath"
    | "context"
  >,
): InitiatingNoteReflectionSuppressionV1 {
  if (input.forceChatOnly === true) {
    return { suppress: true, reason: "force_chat_only" };
  }
  if (input.chatOnlyOverride === true) {
    return { suppress: true, reason: "chat_only_override" };
  }
  if (input.workingMode === "chat_only") {
    return { suppress: true, reason: "working_mode_chat_only" };
  }
  if (input.explicitChatOnly === true) {
    return { suppress: true, reason: "explicit_chat_only" };
  }
  if (detectChatOnlyIntent(input.prompt ?? "")) {
    return { suppress: true, reason: "prompt_chat_only" };
  }
  const persistence =
    input.persistence ?? input.context?.persistence ?? undefined;
  if (persistence === "not_requested") {
    return { suppress: true, reason: "reflection_not_requested" };
  }
  if (persistence === "chat_only_not_persisted") {
    return { suppress: true, reason: "persistence_chat_only_not_persisted" };
  }
  const notePath = resolveInitiatingNotePath(input);
  if (!notePath) {
    return { suppress: true, reason: "no_initiating_note" };
  }
  return { suppress: false };
}

/** True when the host must keep reflection in Chat and skip note append. */
export function shouldSuppressInitiatingNoteReflection(
  input: Parameters<typeof resolveInitiatingNoteReflectionSuppression>[0],
): boolean {
  return resolveInitiatingNoteReflectionSuppression(input).suppress;
}

export function buildInitiatingNoteReflectionMarker(markerId: string): string {
  const id = sanitizeMarkerId(markerId);
  return `<!-- agentic-initiating-reflection:${id} -->`;
}

export function initiatingNoteAlreadyHasReflection(
  content: string,
  marker: string,
): boolean {
  const needle = marker.trim();
  return Boolean(needle) && content.includes(needle);
}

/**
 * Append reflection markdown once. If the marker is already present, returns
 * the current content unchanged.
 */
export function appendInitiatingNoteReflectionMarkdown(
  currentContent: string,
  plan: Pick<InitiatingNoteReflectionPlanV1, "marker" | "markdown">,
): string {
  if (!plan.markdown.trim()) {
    return currentContent;
  }
  if (initiatingNoteAlreadyHasReflection(currentContent, plan.marker)) {
    return currentContent;
  }
  const base = currentContent.replace(/\s*$/u, "");
  const body = plan.markdown.replace(/^\s+/u, "").replace(/\s+$/u, "");
  return `${base}\n\n${body}\n`;
}

/**
 * Build ledger-cited initiating-note (or Chat-only) reflection prose.
 * Never includes ReflectionContext receipt IDs or validation receipt fingerprints.
 */
export function buildInitiatingNoteReflectionV1(
  input: InitiatingNoteReflectionInputV1,
): InitiatingNoteReflectionPlanV1 {
  const runId = input.runId.trim() || "unknown-run";
  const pipeline = input.pipeline ?? input.context?.pipeline ?? null;
  const citeFacts = extractPipelineCiteFactsV1(pipeline);
  const linearIssueUrls = uniqueHttpsUrls([
    ...(input.linearIssueUrls ?? []),
    ...inferLinearUrlsFromContext(input.context),
  ]);
  const notePath = resolveInitiatingNotePath(input) ?? citeFacts.notePath;
  const cites = buildCites({
    runId,
    notePath,
    citeFacts,
    linearIssueUrls,
    pipeline,
  });
  const markerId = input.markerId?.trim() || runId;
  const marker = buildInitiatingNoteReflectionMarker(markerId);
  const markdown = formatReflectionMarkdown({ cites, marker });
  const chatSummary = formatChatSummary(cites);

  const suppression = resolveInitiatingNoteReflectionSuppression({
    ...input,
    initiatingNotePath: notePath,
  });
  if (suppression.suppress) {
    return {
      version: 1,
      shouldWriteNote: false,
      destination: {
        kind: "chat_only",
        reason: suppression.reason ?? "explicit_chat_only",
      },
      marker,
      markdown: "",
      chatSummary,
      cites,
    };
  }

  return {
    version: 1,
    shouldWriteNote: true,
    destination: {
      kind: "initiating_note",
      notePath: notePath!,
    },
    marker,
    markdown,
    chatSummary,
    cites,
  };
}

/**
 * Guard used by tests and writers: note markdown must not dump raw receipts.
 * Returns the first offending snippet, or null when clean.
 */
export function findRawReceiptDumpInReflectionMarkdown(
  markdown: string,
): string | null {
  const patterns: RegExp[] = [
    /\breceiptIds?\b/iu,
    /\breceiptFingerprints?\b/iu,
    /\bvalidationReceiptFingerprints?\b/iu,
    /\bsha256:[a-f0-9]{64}\b/iu,
    /```(?:json)?\s*[\s\S]*?"receipts"\s*:/iu,
    /###\s*Verification receipts\b/iu,
  ];
  for (const pattern of patterns) {
    const match = markdown.match(pattern);
    if (match?.[0]) {
      return match[0];
    }
  }
  return null;
}

function resolveInitiatingNotePath(
  input: Pick<
    InitiatingNoteReflectionInputV1,
    "initiatingNotePath" | "pipeline" | "context"
  >,
): string | undefined {
  const explicit = input.initiatingNotePath?.trim();
  if (explicit) return explicit;
  const fromPipeline =
    input.pipeline?.source.notePath?.trim() ||
    input.context?.pipeline?.source.notePath?.trim();
  return fromPipeline || undefined;
}

function buildCites(input: {
  runId: string;
  notePath?: string;
  citeFacts: PipelineCiteFactsV1;
  linearIssueUrls: string[];
  pipeline: PipelineLineageV1 | null;
}): InitiatingNoteReflectionCitesV1 {
  const owner = input.citeFacts.owner;
  const repository = input.citeFacts.repository;
  const pullRequestNumber = input.citeFacts.pullRequestNumber;
  const repositoryUrl =
    owner && repository
      ? buildGitHubRepositoryUrlV1(owner, repository)
      : undefined;
  const pullRequestUrl =
    owner && repository && typeof pullRequestNumber === "number"
      ? buildGitHubPullRequestUrlV1(owner, repository, pullRequestNumber)
      : undefined;

  return {
    runId: input.runId,
    ...(input.notePath ? { notePath: input.notePath } : {}),
    linearIssueIds: [...input.citeFacts.linearIssueIds],
    linearIssueUrls: input.linearIssueUrls,
    ...(input.citeFacts.commitSha
      ? { commitSha: input.citeFacts.commitSha }
      : {}),
    ...(typeof pullRequestNumber === "number" ? { pullRequestNumber } : {}),
    ...(pullRequestUrl ? { pullRequestUrl } : {}),
    ...(repositoryUrl ? { repositoryUrl } : {}),
    ...(input.citeFacts.branch ? { branch: input.citeFacts.branch } : {}),
    validation: { ...input.citeFacts.validation },
    gaps: [...input.citeFacts.gaps],
    pipelineVerified: input.pipeline?.verified === true,
  };
}

function formatReflectionMarkdown(input: {
  cites: InitiatingNoteReflectionCitesV1;
  marker: string;
}): string {
  const { cites, marker } = input;
  const lines: string[] = [
    "## Mission completion reflection",
    marker,
    "",
  ];
  lines.push(formatReflectionJourneySentence(cites));
  lines.push(formatReflectionValidationSentence(cites));
  const publication = formatReflectionPublicationSentence(cites);
  if (publication) lines.push(publication);
  lines.push(formatReflectionClosureSentence(cites));
  return lines.join("\n");
}

function formatReflectionJourneySentence(
  cites: InitiatingNoteReflectionCitesV1,
): string {
  const issueId = cites.linearIssueIds[0]?.trim();
  const issueUrl = cites.linearIssueUrls[0]?.trim();
  const implementationPresent = Boolean(
    cites.commitSha || cites.pullRequestUrl || cites.repositoryUrl,
  );
  if (issueUrl) {
    const label = issueId
      ? `Linear issue ${escapeInline(issueId)}`
      : "the Linear issue";
    return implementationPresent
      ? `The research became [${label}](${issueUrl}) and a code change.`
      : `The research is recorded in [${label}](${issueUrl}); implementation is still in progress.`;
  }
  if (issueId) {
    return implementationPresent
      ? `The research became Linear issue \`${escapeInline(issueId)}\` and a code change.`
      : `The research is recorded in Linear issue \`${escapeInline(issueId)}\`; implementation is still in progress.`;
  }
  return implementationPresent
    ? "The research was carried through to an implementation."
    : "The research is complete; implementation is still in progress.";
}

function formatReflectionValidationSentence(
  cites: InitiatingNoteReflectionCitesV1,
): string {
  const { targetedPassed, fullPassed, state } = cites.validation;
  if (targetedPassed && fullPassed) {
    return "Targeted and full validation passed.";
  }
  if (targetedPassed) {
    return "Targeted validation passed; full validation is still open.";
  }
  if (fullPassed) {
    return "Full validation passed; the targeted check is still open.";
  }
  if (state === "not_requested" || state === "chat_only_not_persisted") {
    return "No code validation was requested for this work.";
  }
  return "The code change is not yet fully validated.";
}

function formatReflectionPublicationSentence(
  cites: InitiatingNoteReflectionCitesV1,
): string | null {
  const commit = cites.commitSha
    ? ` at commit \`${escapeInline(shortSha(cites.commitSha))}\``
    : "";
  const repository = cites.repositoryUrl
    ? `[the repository](${cites.repositoryUrl})`
    : "the repository";
  const subject =
    cites.validation.targetedPassed && cites.validation.fullPassed
      ? "The tested change"
      : "The current change";
  if (cites.pullRequestUrl && cites.pullRequestNumber != null) {
    return `${subject} is available in ${repository} as [draft PR #${cites.pullRequestNumber}](${cites.pullRequestUrl})${commit}.`;
  }
  if (cites.pullRequestNumber != null) {
    return `${subject} is available in ${repository} as draft PR #${cites.pullRequestNumber}${commit}.`;
  }
  if (cites.repositoryUrl) {
    return `${subject} is available in ${repository}${commit}.`;
  }
  if (cites.commitSha) {
    return `${subject} was recorded at commit \`${escapeInline(shortSha(cites.commitSha))}\`.`;
  }
  return null;
}

function formatReflectionClosureSentence(
  cites: InitiatingNoteReflectionCitesV1,
): string {
  if (cites.gaps.length > 0) {
    const visible = cites.gaps.slice(0, 3).map(humanizeReflectionGap);
    const remainder = cites.gaps.length - visible.length;
    const joined =
      visible.length <= 1
        ? visible[0] ?? "follow-up work"
        : `${visible.slice(0, -1).join(", ")}, and ${visible[visible.length - 1]}`;
    return `Still open: ${joined}${remainder > 0 ? `, plus ${remainder} other follow-up item${remainder === 1 ? "" : "s"}` : ""}.`;
  }
  return cites.pipelineVerified
    ? "The evidence chain is complete, with no remaining follow-up."
    : "The available evidence is linked above; any unfinished work remains open.";
}

function humanizeReflectionGap(gap: string): string {
  const normalized = gap.trim().toLowerCase();
  const known: Record<string, string> = {
    linear_work_item_readback: "Linear issue verification",
    workspace_validation_and_commit: "workspace validation and commit",
    draft_pull_request_readback: "draft pull request verification",
    reflection_artifact_proof: "reflection verification",
  };
  const fallback = normalized
    .replace(/^tool:/u, "")
    .replace(/[_:]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return (known[normalized] ?? fallback) || "follow-up work";
}

function formatChatSummary(cites: InitiatingNoteReflectionCitesV1): string {
  const parts: string[] = [`Run ${cites.runId}`];
  const linear = formatLinearCite(cites);
  if (linear) parts.push(linear);
  parts.push(formatValidationCite(cites));
  if (cites.commitSha) parts.push(`commit ${shortSha(cites.commitSha)}`);
  if (cites.pullRequestUrl) {
    parts.push(`PR ${cites.pullRequestUrl}`);
  } else if (cites.pullRequestNumber != null) {
    parts.push(`PR #${cites.pullRequestNumber}`);
  }
  if (cites.repositoryUrl) parts.push(cites.repositoryUrl);
  if (cites.gaps.length > 0) {
    parts.push(`gaps: ${cites.gaps.join(", ")}`);
  }
  return parts.join(" · ");
}

function formatLinearCite(cites: InitiatingNoteReflectionCitesV1): string | null {
  if (cites.linearIssueUrls.length > 0) {
    const primary = cites.linearIssueUrls[0]!;
    const idHint =
      cites.linearIssueIds[0] != null
        ? ` (${escapeInline(cites.linearIssueIds[0])})`
        : "";
    return `Linear issue: ${primary}${idHint}`;
  }
  if (cites.linearIssueIds.length > 0) {
    return `Linear issue: ${cites.linearIssueIds.map((id) => `\`${escapeInline(id)}\``).join(", ")}`;
  }
  return null;
}

function formatValidationCite(cites: InitiatingNoteReflectionCitesV1): string {
  const { targetedPassed, fullPassed, state } = cites.validation;
  if (targetedPassed && fullPassed) {
    return "Validation: targeted and full checks passed";
  }
  if (targetedPassed && !fullPassed) {
    return "Validation: targeted passed; full still open";
  }
  if (!targetedPassed && fullPassed) {
    return "Validation: full passed; targeted still open";
  }
  if (state === "not_requested" || state === "chat_only_not_persisted") {
    return `Validation: ${state.split("_").join(" ")}`;
  }
  return "Validation: not yet verified";
}

function inferLinearUrlsFromContext(
  context: ReflectionContextV1 | null | undefined,
): string[] {
  if (!context) return [];
  const urls: string[] = [];
  const haystacks = [
    ...context.observedFacts,
    ...context.failedAttempts,
    ...context.retries,
  ];
  for (const line of haystacks) {
    for (const match of line.matchAll(/https:\/\/linear\.app\/[^\s)\]"'<>]+/giu)) {
      urls.push(match[0]!.replace(/[.,;:]+$/u, ""));
    }
  }
  return urls;
}

function uniqueHttpsUrls(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (!/^https:\/\//iu.test(trimmed)) continue;
    if (!out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

function sanitizeMarkerId(value: string): string {
  const cleaned = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
  return cleaned || "run";
}

function shortSha(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}

function escapeInline(value: string): string {
  return value.replace(/`/gu, "'");
}
