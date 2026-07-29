import type { MissionEvidence } from "../agent/missionLedger";
import {
  claimPassagesFromToolResult,
  evidenceFromToolResult,
} from "../agent/missionEvidence";
import type { ClaimPassageRef } from "../agent/claimLedger";
import { appendToolTranscript } from "../model/toolTranscript";
import { serializeToolResultForModel } from "../model/toolResultPayload";
import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelChatResponse,
  ModelClient,
  ModelThink,
  ModelToolCall,
  ModelToolDefinition,
} from "../model/types";
import {
  createObservableModelClient,
  type ModelCallEvidenceV1,
} from "../model/modelCallEvidence";
import { MAX_AGENT_STEPS } from "../tools/constants";
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRegistry,
} from "../tools/types";
import type { WorkerHandoff } from "./types";
import { parseExplicitResearchSourceCount } from "../agent/researchPlan";
import {
  selectInitialResearchEffort,
  type ResearchEffortTier,
} from "../agent/researchEffortPolicy";
import { resolveThinkForCall } from "../agent/thinkPolicy";
import {
  RESEARCHER_SOFT_TOOL_NAMES,
  filterResearcherToolNames,
} from "./researcherSoftCatalog";

/** Align with settings default (40) and MAX_AGENT_STEPS hard ceiling. */
const RESEARCH_WORKER_MAX_STEPS = MAX_AGENT_STEPS;
/** Match orchestrator worker tool-call normalize / code worker ceiling. */
const RESEARCH_WORKER_MAX_TOOL_CALLS = 80;
/** Canonical model name for direct requests to https://ollama.com/api. */
export const OLLAMA_CLOUD_DEEP_RESEARCH_MODEL = "nemotron-3-ultra";
import {
  addSourceCandidate,
  claimNextSourceCandidate,
  claimSourceCandidate,
  computeSourceProofDebt,
  createSourceCandidateLedger,
  recordSourceCandidateOutcome,
  type ResearchSourceType,
  type SourceCandidateLedgerV1,
} from "./sourceCandidateLedger";

/**
 * The Researcher's read-only tool authority, derived structurally from the
 * single Soft catalog so the two views can never drift.
 */
export const RESEARCH_WORKER_ALLOWED_TOOLS: ReadonlySet<string> = new Set(
  RESEARCHER_SOFT_TOOL_NAMES,
);

/** Tools that must stay sequential (leases, browser session, or mutations). */
const RESEARCH_WORKER_SERIAL_ONLY = new Set([
  "web_fetch",
  "browser_open_page",
  "browser_observe",
  "browser_extract_markdown",
]);

const MAX_RESEARCH_WORKER_PARALLEL_READS = 4;

export function isResearchWorkerParallelSafe(toolName: string): boolean {
  return (
    RESEARCH_WORKER_ALLOWED_TOOLS.has(toolName) &&
    !RESEARCH_WORKER_SERIAL_ONLY.has(toolName)
  );
}

export interface ResearchWorkerResult {
  handoff: WorkerHandoff;
  evidence: MissionEvidence[];
  claimPassages: ClaimPassageRef[];
  finalSummary: string;
  modelSteps: number;
  toolCalls: number;
  alternativeSourceReads?: number;
  sourceLedger: SourceCandidateLedgerV1;
}

export interface ResearchWorkerEvents {
  onModelCallEvidence?: (event: ModelCallEvidenceV1) => void;
  onStatus?: (status: string) => void | Promise<void>;
  onToolStart?: (event: {
    id: string;
    name: string;
    step: number;
  }) => void | Promise<void>;
  onToolDone?: (event: {
    id: string;
    name: string;
    step: number;
    result: ToolExecutionResult;
  }) => void | Promise<void>;
}

export async function runResearchWorker(input: {
  runId: string;
  participantId: string;
  leadParticipantId: string;
  taskId: string;
  assignment: string;
  originalMission: string;
  modelClient: ModelClient;
  toolRegistry: ToolRegistry;
  toolContext: ToolExecutionContext;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  maxToolCalls?: number;
  /** Optional host-selected tier; otherwise the worker classifies its mission. */
  researchEffortTier?: ResearchEffortTier;
  events?: ResearchWorkerEvents;
  now?: () => Date;
}): Promise<ResearchWorkerResult> {
  const maxSteps = clamp(
    input.maxSteps ?? 40,
    1,
    RESEARCH_WORKER_MAX_STEPS,
  );
  const maxToolCalls = clamp(
    input.maxToolCalls ?? 40,
    1,
    RESEARCH_WORKER_MAX_TOOL_CALLS,
  );
  const modelCallCap = Math.max(4, maxSteps * 3 + 8);
  const contextTokens = Math.max(
    4_096,
    input.toolContext.settings?.numCtx ?? 48_000,
  );
  const observedModel = createObservableModelClient({
    client: input.modelClient,
    budget: {
      schemaVersion: 1,
      maxCalls: modelCallCap,
      maxTokens: Math.max(32_768, modelCallCap * contextTokens),
      maxWallClockMs: 60 * 60_000,
    },
    onEvidence: input.events?.onModelCallEvidence,
  });
  const registry = createReadOnlyWorkerRegistry(input.toolRegistry);
  const researchEffortTier = input.researchEffortTier ??
    classifyResearchWorkerEffort(input.originalMission, input.assignment);
  const modelRequestProfile = resolveResearchWorkerModelRequestProfile({
    modelClient: input.modelClient,
    toolContext: input.toolContext,
    researchEffortTier,
  });
  const evidence: MissionEvidence[] = [];
  const claimPassages: ClaimPassageRef[] = [];
  const minimumUsableSources = clamp(
    parseExplicitResearchSourceCount(input.originalMission) ??
      (/\bdeep\s+research\b/iu.test(input.originalMission) ? 3 : 1),
    1,
    5,
  );
  let sourceLedger = createSourceCandidateLedger({
    runId: input.runId,
    query: input.assignment,
    now: input.now?.() ?? new Date(),
    proofRequirements: [
      {
        claimId: "mission",
        description: input.assignment,
        minUsableSources: minimumUsableSources,
        // At least one primary source is a hard quality floor. Requiring both
        // primary and official types made a complete three-source handoff
        // impossible for bounded owned fixtures and many legitimate topics.
        preferredSourceTypes: ["primary"],
      },
    ],
  });
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the read-only Researcher in a two-agent Obsidian mission.",
        "Work only on the assigned research task.",
        "Use the available read-only web and vault tools before answering.",
        "Never request a write, delete, code, dependency, approval, browser-action, or memory-mutation tool.",
        "Return a concise evidence handoff: findings, source URLs or vault paths, conflicts, limitations, and unresolved questions.",
        "Do not claim that a search snippet is fetched proof; fetch or read the underlying content.",
        `Gather at least ${minimumUsableSources} distinct usable source${minimumUsableSources === 1 ? "" : "s"} before declaring the handoff ready.`,
        "If provider fetch returns unusable content, try a cached section, safe browser extraction, a document-native result, or an alternate search result before reporting failure.",
        `Start with distinct source candidates and avoid duplicate work. Suggested query variants: ${sourceLedger.queryVariants.join(" | ")}.`,
      ].join(" "),
    },
    {
      role: "user",
      content: `Original mission: ${input.originalMission}\nAssigned task: ${input.assignment}`,
    },
  ];
  let modelSteps = 0;
  let toolCalls = 0;
  let alternativeSourceReads = 0;
  let finalSummary = "";

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(input.abortSignal);
    modelSteps = step;
    await input.events?.onStatus?.(`Researcher step ${step}/${maxSteps}`);
    const request: ModelChatRequest = {
      ...modelRequestProfile,
      messages,
      tools: registry.getDefinitions(),
      abortSignal: input.abortSignal,
      evidencePhase: "worker",
    };
    // Prefer streamChat when streaming is enabled so graded think travels with
    // tools on the same Ollama-compatible turn (think + tools together).
    const response = await chatResearcherTurn(observedModel.client, request, {
      enableStreaming: input.toolContext.settings?.enableStreaming !== false,
    });
    messages.push(response.message);
    if (response.toolCalls.length === 0) {
      finalSummary = response.message.content.trim();
      const remainingProofDebt = computeSourceProofDebt(sourceLedger);
      if (finalSummary && remainingProofDebt.length === 0) break;
      if (finalSummary && step < maxSteps) {
        finalSummary = "";
        messages.push({
          role: "user",
          content:
            `The handoff still lacks ${remainingProofDebt.map((item) => item.missing).reduce((sum, value) => sum + value, 0)} required usable source(s). Fetch distinct candidates before returning the final handoff.`,
        });
        continue;
      }
      messages.push({
        role: "user",
        content: "Provide the structured evidence handoff now. Do not request unavailable tools.",
      });
      continue;
    }

    let callCursor = 0;
    while (callCursor < response.toolCalls.length) {
      if (toolCalls >= maxToolCalls) {
        finalSummary = "Researcher stopped at the shared tool-call budget.";
        break;
      }

      let batchEnd = callCursor;
      while (
        batchEnd < response.toolCalls.length &&
        toolCalls + (batchEnd - callCursor) < maxToolCalls &&
        batchEnd - callCursor < MAX_RESEARCH_WORKER_PARALLEL_READS &&
        isResearchWorkerParallelSafe(response.toolCalls[batchEnd]!.name)
      ) {
        batchEnd += 1;
      }
      const parallelCount = batchEnd - callCursor;
      if (parallelCount > 1) {
        await input.events?.onStatus?.(
          `Running ${parallelCount} research reads in parallel...`,
        );
        const prepared: Array<{ call: ModelToolCall; eventId: string }> = [];
        for (let offset = 0; offset < parallelCount; offset += 1) {
          toolCalls += 1;
          const call = ensureWorkerCallId(
            response.toolCalls[callCursor + offset]!,
            input.runId,
            toolCalls,
          );
          const eventId = `${input.participantId}-tool-${toolCalls}`;
          await input.events?.onToolStart?.({
            id: eventId,
            name: call.name,
            step,
          });
          prepared.push({ call, eventId });
        }
        throwIfAborted(input.abortSignal);
        const parallelResults = await Promise.all(
          prepared.map(({ call }) =>
            registry.execute(call, {
              ...input.toolContext,
              runId: `${input.runId}-${input.participantId}`,
              originalPrompt: input.assignment,
              abortSignal: input.abortSignal,
              writeAutonomy: false,
              userApprovalGranted: false,
            }),
          ),
        );
        throwIfAborted(input.abortSignal);
        for (let offset = 0; offset < prepared.length; offset += 1) {
          const { call, eventId } = prepared[offset]!;
          const result = parallelResults[offset]!;
          await input.events?.onToolDone?.({
            id: eventId,
            name: call.name,
            step,
            result,
          });
          const nextEvidence = evidenceFromToolResult(call.name, result);
          if (
            nextEvidence &&
            !evidence.some((item) => item.id === nextEvidence.id)
          ) {
            evidence.push(nextEvidence);
          }
          for (const passage of claimPassagesFromToolResult(call.name, result)) {
            if (!claimPassages.some((item) => item.id === passage.id)) {
              claimPassages.push(passage);
            }
          }
          if (call.name === "web_search" && result.ok) {
            sourceLedger = addSearchResultsToLedger(
              sourceLedger,
              result.output,
              input.assignment,
              input.now?.() ?? new Date(),
            );
          }
          appendToolTranscript({
            messages,
            toolCall: call,
            resultContent: serializeToolResultForModel(result),
            origin: "model",
            fallbackId: call.id ?? eventId,
          });
        }
        callCursor = batchEnd;
        continue;
      }

      const rawCall = response.toolCalls[callCursor]!;
      callCursor += 1;
      const call = ensureWorkerCallId(rawCall, input.runId, toolCalls + 1);
      toolCalls += 1;
      const eventId = `${input.participantId}-tool-${toolCalls}`;
      await input.events?.onToolStart?.({ id: eventId, name: call.name, step });
      throwIfAborted(input.abortSignal);
      let claimedCandidateId: string | null = null;
      if (call.name === "web_fetch" && typeof call.arguments.url === "string") {
        const registered = addSourceCandidate(sourceLedger, {
          query: input.assignment,
          title: call.arguments.url,
          url: call.arguments.url,
          provider: "worker",
          sourceType: inferSourceType(call.arguments.url, call.arguments.url),
          signals: { quality: 0.55, freshness: 0.6, fetchability: 0.8 },
          claimIds: ["mission"],
        }, input.now?.() ?? new Date());
        sourceLedger = registered.ledger;
        const claimed = claimSourceCandidate(
          sourceLedger,
          registered.candidate.id,
          input.participantId,
          { now: input.now?.() ?? new Date() },
        );
        sourceLedger = claimed.ledger;
        if (claimed.accepted) claimedCandidateId = registered.candidate.id;
      }
      const result =
        call.name === "web_fetch" && claimedCandidateId === null
          ? {
              ok: false,
              toolName: call.name,
              error: {
                code: "duplicate_source_candidate",
                message: "This source candidate was already attempted or is leased; choose a different result.",
              },
            }
          : await registry.execute(call, {
              ...input.toolContext,
              runId: `${input.runId}-${input.participantId}`,
              originalPrompt: input.assignment,
              abortSignal: input.abortSignal,
              writeAutonomy: false,
              userApprovalGranted: false,
            });
      throwIfAborted(input.abortSignal);
      await input.events?.onToolDone?.({
        id: eventId,
        name: call.name,
        step,
        result,
      });
      const nextEvidence = evidenceFromToolResult(call.name, result);
      if (nextEvidence && !evidence.some((item) => item.id === nextEvidence.id)) {
        evidence.push(nextEvidence);
      }
      for (const passage of claimPassagesFromToolResult(call.name, result)) {
        if (!claimPassages.some((item) => item.id === passage.id)) {
          claimPassages.push(passage);
        }
      }
      if (call.name === "web_search" && result.ok) {
        sourceLedger = addSearchResultsToLedger(
          sourceLedger,
          result.output,
          input.assignment,
          input.now?.() ?? new Date(),
        );
      }
      if (claimedCandidateId) {
        sourceLedger = recordSourceCandidateOutcome(
          sourceLedger,
          claimedCandidateId,
          nextEvidence
            ? { status: "usable", evidenceIds: [nextEvidence.id] }
            : {
                status: "unusable",
                failure: result.error?.message ?? "No passage-backed evidence was extracted.",
              },
          input.now?.() ?? new Date(),
        );
      }
      appendToolTranscript({
        messages,
        toolCall: call,
        resultContent: serializeToolResultForModel(result),
        origin: "model",
        fallbackId: call.id ?? eventId,
      });
      if (
        call.name === "web_fetch" &&
        claimedCandidateId !== null &&
        nextEvidence === null &&
        alternativeSourceReads < 1 &&
        toolCalls < maxToolCalls
      ) {
        const alternativeClaim = claimNextSourceCandidate(
          sourceLedger,
          input.participantId,
          {
            now: input.now?.() ?? new Date(),
            claimId: "mission",
          },
        );
        const candidate = alternativeClaim.candidate;
        if (
          alternativeClaim.accepted &&
          candidate &&
          typeof candidate.url === "string" &&
          candidate.url.trim()
        ) {
          sourceLedger = alternativeClaim.ledger;
          alternativeSourceReads += 1;
          toolCalls += 1;
          const alternativeCall: ModelToolCall = {
            id: `${input.runId}-worker-alternative-${alternativeSourceReads}`,
            name: "web_fetch",
            arguments: { url: candidate.url },
          };
          const alternativeEventId =
            `${input.participantId}-tool-${toolCalls}`;
          await input.events?.onStatus?.(
            "The first public source was unusable; reading one bounded alternative source.",
          );
          await input.events?.onToolStart?.({
            id: alternativeEventId,
            name: alternativeCall.name,
            step,
          });
          const alternativeResult = await registry.execute(alternativeCall, {
            ...input.toolContext,
            runId: `${input.runId}-${input.participantId}`,
            originalPrompt: input.assignment,
            abortSignal: input.abortSignal,
            writeAutonomy: false,
            userApprovalGranted: false,
          });
          await input.events?.onToolDone?.({
            id: alternativeEventId,
            name: alternativeCall.name,
            step,
            result: alternativeResult,
          });
          const alternativeEvidence = evidenceFromToolResult(
            alternativeCall.name,
            alternativeResult,
          );
          if (
            alternativeEvidence &&
            !evidence.some((item) => item.id === alternativeEvidence.id)
          ) {
            evidence.push(alternativeEvidence);
          }
          for (const passage of claimPassagesFromToolResult(
            alternativeCall.name,
            alternativeResult,
          )) {
            if (!claimPassages.some((item) => item.id === passage.id)) {
              claimPassages.push(passage);
            }
          }
          sourceLedger = recordSourceCandidateOutcome(
            sourceLedger,
            candidate.id,
            alternativeEvidence
              ? { status: "usable", evidenceIds: [alternativeEvidence.id] }
              : {
                  status: "unusable",
                  failure:
                    alternativeResult.error?.message ??
                    "The bounded alternative source did not yield passage-backed evidence.",
                },
            input.now?.() ?? new Date(),
          );
          appendToolTranscript({
            messages,
            toolCall: alternativeCall,
            resultContent: serializeToolResultForModel(alternativeResult),
            origin: "runner",
            fallbackId: alternativeEventId,
          });
        }
      }
    }
    if (finalSummary) break;
  }

  if (!finalSummary) {
    finalSummary = evidence.length > 0
      ? `Researcher gathered ${evidence.length} evidence record(s) but reached its bounded step budget before prose synthesis.`
      : "Researcher could not gather usable evidence within the bounded worker budget.";
  }
  const now = (input.now?.() ?? new Date()).toISOString();
  const proofDebt = computeSourceProofDebt(sourceLedger);
  const sourceIds = unique(
    evidence.flatMap((item) => [item.sourceId, item.url, item.path].filter(isString)),
  );
  return {
    handoff: {
      id: `${input.runId}:handoff:${input.taskId}`,
      fromParticipantId: input.participantId,
      toParticipantId: input.leadParticipantId,
      taskId: input.taskId,
      status:
        evidence.length > 0 && proofDebt.length === 0 ? "ready" : "rejected",
      summary: finalSummary,
      sourceIds,
      evidenceIds: evidence.map((item) => item.id),
      unresolvedQuestions:
        proofDebt.length > 0
          ? proofDebt.map(
              (item) =>
                `${item.description}: ${item.missing} usable source(s) still missing`,
            )
          : [],
      confidence: evidence.some((item) => item.confidence === "high")
        ? "high"
        : evidence.length > 0
          ? "medium"
          : "low",
      stopReason:
        evidence.length > 0 && proofDebt.length === 0
          ? "handoff_ready"
          : "no_usable_evidence",
      createdAt: now,
      updatedAt: now,
    },
    evidence,
    claimPassages,
    finalSummary,
    modelSteps,
    toolCalls,
    alternativeSourceReads,
    sourceLedger,
  };
}

export function createReadOnlyWorkerRegistry(registry: ToolRegistry): ToolRegistry {
  const allowedNames = new Set(
    filterResearcherToolNames([...RESEARCH_WORKER_ALLOWED_TOOLS]),
  );
  const allowedDefinitions = registry.getDefinitions().filter((definition) =>
    allowedNames.has(definition.function.name),
  );
  return {
    getDefinitions(): ModelToolDefinition[] {
      return allowedDefinitions;
    },
    async execute(call, context) {
      if (!RESEARCH_WORKER_ALLOWED_TOOLS.has(call.name)) {
        return {
          ok: false,
          toolName: call.name,
          error: {
            code: "orchestrator_worker_policy_blocked",
            message: `Researcher cannot execute ${call.name}; the worker is read-only.`,
          },
        };
      }
      return registry.execute(call, {
        ...context,
        writeAutonomy: false,
        userApprovalGranted: false,
      });
    },
  };
}

function resolveResearcherThink(input: {
  modelClient: ModelClient;
  toolContext: ToolExecutionContext;
}): ModelThink | undefined {
  const settings = input.toolContext.settings;
  const model =
    input.modelClient.descriptor?.model ?? settings?.model ?? undefined;
  return resolveThinkForCall({
    role: "researcher",
    // Tool turns use the worker phase so role stays researcher (think: low).
    phase: "worker",
    settings,
    model,
  });
}

/**
 * Apply stage-specific overrides only to the direct Ollama Cloud transport.
 * Deep and extended research use the stronger research model. Quick and
 * standard passes retain the configured model and resolve thinking from the
 * configured policy instead of unconditionally forcing the researcher low.
 */
export function resolveResearchWorkerModelRequestProfile(input: {
  modelClient: ModelClient;
  toolContext: ToolExecutionContext;
  researchEffortTier: ResearchEffortTier;
}): Pick<ModelChatRequest, "model" | "think"> {
  const descriptor = input.modelClient.descriptor;
  const directOllamaCloud =
    descriptor?.provider === "ollama" &&
    descriptor.endpointCategory === "ollama_cloud";
  if (!directOllamaCloud) {
    return { think: resolveResearcherThink(input) };
  }

  const deepResearch =
    input.researchEffortTier === "deep" ||
    input.researchEffortTier === "extended";
  if (deepResearch) {
    return {
      model: OLLAMA_CLOUD_DEEP_RESEARCH_MODEL,
      // Nemotron's direct Ollama thinking contract is safely enabled as a
      // boolean. Preserve an explicit user opt-out when one is configured.
      think: input.toolContext.settings?.thinkingMode === "off" ? false : true,
    };
  }

  const model =
    descriptor.model ?? input.toolContext.settings?.model ?? undefined;
  return {
    think: resolveThinkForCall({
      role: "lead",
      expectedTimeClass:
        input.researchEffortTier === "quick" ? "quick" : "normal",
      settings: input.toolContext.settings,
      model,
    }),
  };
}

function classifyResearchWorkerEffort(
  originalMission: string,
  assignment: string,
): ResearchEffortTier {
  const prompt = `${originalMission}\n${assignment}`;
  const route = /\b(?:extended|overnight|exhaustive|systematic review)\b/iu.test(
    prompt,
  )
    ? "extended research"
    : /\b(?:deep research|in[- ]depth research|deep dive|long research)\b/iu.test(
          prompt,
        )
      ? "deep research"
      : "research";
  return selectInitialResearchEffort({ prompt, route }).tier;
}

async function chatResearcherTurn(
  modelClient: ModelClient,
  request: ModelChatRequest,
  options: { enableStreaming: boolean },
): Promise<ModelChatResponse> {
  if (options.enableStreaming && typeof modelClient.streamChat === "function") {
    return modelClient.streamChat(request);
  }
  return modelClient.chat(request);
}

function ensureWorkerCallId(
  call: ModelToolCall,
  runId: string,
  index: number,
): ModelToolCall {
  return call.id ? call : { ...call, id: `${runId}-worker-call-${index}` };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("Researcher was cancelled.");
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function addSearchResultsToLedger(
  initial: SourceCandidateLedgerV1,
  output: unknown,
  query: string,
  now: Date,
): SourceCandidateLedgerV1 {
  if (!isRecord(output) || !Array.isArray(output.results)) return initial;
  let ledger = initial;
  for (const item of output.results.slice(0, 10)) {
    if (!isRecord(item) || typeof item.url !== "string" || !item.url.trim()) continue;
    const title = typeof item.title === "string" ? item.title : item.url;
    const registered = addSourceCandidate(
      ledger,
      {
        query,
        title,
        url: item.url,
        provider: "web_search",
        sourceType: inferSourceType(item.url, title),
        signals: {
          quality: inferQuality(item.url, title),
          freshness: 0.65,
          fetchability: 0.75,
        },
        claimIds: ["mission"],
      },
      now,
    );
    ledger = registered.ledger;
  }
  return ledger;
}

function inferSourceType(urlValue: string, title: string): ResearchSourceType {
  const lower = `${urlValue} ${title}`.toLowerCase();
  if (/\.pdf(?:$|[?#])/.test(lower)) return "pdf";
  if (/arxiv\.org|doi\.org|\b(journal|study|paper|research)\b/.test(lower)) return "paper";
  if (/\.gov(?:\/|$)|\b(official|documentation|docs)\b/.test(lower)) return "official";
  if (/\b(primary source|transcript|dataset)\b/.test(lower)) return "primary";
  if (/\b(news|press|reuters|associated press)\b/.test(lower)) return "news";
  return "web";
}

function inferQuality(urlValue: string, title: string): number {
  const type = inferSourceType(urlValue, title);
  if (type === "primary" || type === "official") return 0.9;
  if (type === "paper") return 0.85;
  if (type === "pdf" || type === "document") return 0.7;
  if (type === "news") return 0.62;
  return 0.5;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
