/**
 * Semantic speech-act rescue: exemplar-similarity proposal for prompts the
 * deterministic classifier let fall through to `ordinary_answer` (or
 * misfiled as direct chat). Contract, mirrored from the research-team
 * dispatch widener:
 *
 * - Rescue-position only: consulted exclusively for miss candidates; a
 *   deterministic execute/persist/continue decision is never re-scored.
 * - Widen-only: it can propose a speech act the deterministic classifier is
 *   itself capable of emitting; it never vetoes, never narrows, and never
 *   overrides `explicitChatOnly`.
 * - Fail-closed and bounded: any embedding error, low confidence, ambiguous
 *   margin, or the 1.5s budget expiring yields null and the deterministic
 *   outcome stands.
 */
import type { AgentSettings } from "../settings";
import type { SemanticEmbeddingProvider } from "../embeddings/types";
import type {
  ExecutionTier,
  MissionSpeechAct,
  MissionSpeechActClassificationV1,
} from "./missionSpeechAct";
import { scorePromptAgainstPrototypes } from "./reflex/intentRouter";

export type SpeechActSemanticRescueMode = "off" | "shadow" | "authority";

export interface SpeechActRescueProposalV1 {
  speechAct: Extract<MissionSpeechAct, "execute" | "persist">;
  executionTier: Extract<ExecutionTier, "bounded_tool">;
  label: SpeechActRescueLabel;
  score: number;
  margin: number;
  reasons: string[];
}

type SpeechActRescueLabel =
  | "execute_code_deliverable"
  | "execute_general"
  | "persist_note"
  | "none";

const RESCUE_CONFIDENCE_THRESHOLD = 0.72;
const RESCUE_WINNING_MARGIN = 0.08;
export const SPEECH_ACT_RESCUE_TIMEOUT_MS = 1_500;
const PROTOTYPE_VERSION = "speech-act-v1";

const SPEECH_ACT_PROTOTYPES: Record<SpeechActRescueLabel, string[]> = {
  execute_code_deliverable: [
    "write a small game in Python and put it on my desktop",
    "create a python script for me and save it to my downloads folder",
    "build a little app and deliver the finished files to my Documents folder",
  ],
  execute_general: [
    "go ahead and do this task for me now",
    "please carry this out using your tools",
    "take care of this action in my vault for me",
  ],
  persist_note: [
    "save this into a note for me",
    "append this text to my current note",
    "record this fact in my research memory",
  ],
  none: [
    "explain how this works",
    "what do you think about this topic?",
    "give me a quick answer here in chat",
  ],
};

export function isSpeechActRescueMissCandidate(
  deterministic: MissionSpeechActClassificationV1,
): boolean {
  if (deterministic.explicitChatOnly) return false;
  return (
    deterministic.reasons[0] === "ordinary_answer" ||
    deterministic.executionTier === "direct_chat"
  );
}

export async function proposeSpeechActRescueV1(input: {
  prompt: string;
  deterministic: MissionSpeechActClassificationV1;
  settings: AgentSettings;
  embeddingProvider: SemanticEmbeddingProvider | undefined;
  /** Narrow override for deterministic timeout tests. */
  timeoutMs?: number;
}): Promise<SpeechActRescueProposalV1 | null> {
  const mode = input.settings.speechActSemanticRescueMode;
  if (mode !== "shadow" && mode !== "authority") return null;
  if (!isSpeechActRescueMissCandidate(input.deterministic)) return null;
  if (!input.embeddingProvider) return null;
  try {
    return await withRescueTimeout(
      scoreRescueProposal(input.prompt, input.settings, input.embeddingProvider),
      input.timeoutMs ?? SPEECH_ACT_RESCUE_TIMEOUT_MS,
    );
  } catch {
    // Fail closed: the deterministic outcome stands.
    return null;
  }
}

async function scoreRescueProposal(
  prompt: string,
  settings: AgentSettings,
  embeddingProvider: SemanticEmbeddingProvider,
): Promise<SpeechActRescueProposalV1 | null> {
  const scored = await scorePromptAgainstPrototypes({
    prompt,
    settings,
    embeddingProvider,
    prototypes: SPEECH_ACT_PROTOTYPES,
    prototypeVersion: PROTOTYPE_VERSION,
    cacheNamespace: "speech-act-rescue",
    fallbackLabel: "none",
  });

  const best = scored[0];
  if (!best || best.label === "none") return null;
  if (best.score < RESCUE_CONFIDENCE_THRESHOLD) return null;
  const margin = best.score - (scored[1]?.score ?? 0);
  if (margin < RESCUE_WINNING_MARGIN) return null;

  const speechAct = best.label === "persist_note" ? "persist" : "execute";
  return {
    speechAct,
    executionTier: "bounded_tool",
    label: best.label,
    score: round(best.score),
    margin: round(margin),
    reasons: [
      `semantic_rescue:${best.label}`,
      `semantic_rescue_score:${round(best.score)}`,
    ],
  };
}

async function withRescueTimeout<TResult>(
  promise: Promise<TResult | null>,
  timeoutMs: number,
): Promise<TResult | null> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise.catch(() => null),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
