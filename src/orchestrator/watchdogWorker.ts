import type {
  ModelChatMessage,
  ModelChatRequest,
  ModelClient,
} from "../model/types";
import {
  createObservableModelClient,
  type ModelCallEvidenceV1,
} from "../model/modelCallEvidence";
import { isMutatingToolName } from "../agent/policyEngine";

/**
 * Adaptive Specialist recovery_verifier mode for a stuck Lead run.
 *
 * Fires when the primary agent repeats a tool without progress, or re-hits one
 * blocker across resumes. It reads the recent transcript and returns a single
 * directive; the primary agent is what acts on it. Keeping the watchdog purely
 * advisory means every write gate — approvals, effect classes, research proof —
 * stays on exactly one path.
 *
 * The watchdog makes NO tool calls at all. That is stronger than a read-only
 * allow-list: with no tool definitions in the request there is no mechanism by
 * which it could mutate anything, however confused it becomes. WATCHDOG_ALLOWED_TOOLS
 * is exported as the empty set so that invariant is assertable rather than
 * merely documented.
 */
export const SPECIALIST_RECOVERY_ALLOWED_TOOLS: ReadonlySet<string> =
  new Set<string>();
/** @deprecated Compatibility alias; this is not a third watchdog identity. */
export const WATCHDOG_ALLOWED_TOOLS = SPECIALIST_RECOVERY_ALLOWED_TOOLS;

const MAX_TRANSCRIPT_CHARS = 8_000;
const MAX_MISSION_PROMPT_CHARS = 2_000;
const SPECIALIST_RECOVERY_MODEL_CALL_CAP = 2;

/**
 * Every action maps onto a LoopDecision the runner already implements, so the
 * verdict steers the existing control flow instead of opening a second one.
 */
export type WatchdogAction =
  | "force_final_no_tools"
  | "replan"
  | "ask_user"
  | "stop";

export interface WatchdogVerdict {
  action: WatchdogAction;
  /** Populated for "replan": what the primary agent should try instead. */
  revisedApproach?: string;
  /** Populated for "ask_user": the single question worth asking. */
  question?: string;
  rationale: string;
}

export interface RunWatchdogWorkerInput {
  runId: string;
  missionPrompt: string;
  /** Recent steps, already redacted by the caller. */
  recentTranscript: string;
  /** e.g. "research_phase_gate:analyze", or null when only repetition is known. */
  blockerSignature: string | null;
  repeatedToolCalls: number;
  modelClient: ModelClient;
  model?: string;
  abortSignal?: AbortSignal;
  onModelCallEvidence?: (event: ModelCallEvidenceV1) => void;
}

/**
 * A stuck run that cannot be diagnosed must still end cleanly, so every failure
 * path here resolves to a verdict rather than throwing. Escalation is a
 * last-resort recovery; it must not become a new source of run failure.
 */
export async function runSpecialistRecoveryVerifier(
  input: RunWatchdogWorkerInput,
): Promise<WatchdogVerdict> {
  const observed = createObservableModelClient({
    client: input.modelClient,
    budget: {
      schemaVersion: 1,
      maxCalls: SPECIALIST_RECOVERY_MODEL_CALL_CAP,
      maxTokens: 64_000,
      maxWallClockMs: 5 * 60_000,
    },
    onEvidence: input.onModelCallEvidence,
  });

  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: [
        "You are the Adaptive Specialist in recovery_verifier mode. The Lead is stuck in a loop.",
        "You did not produce the transcript below and must judge only what it shows.",
        "Decide the single best way to break the loop:",
        '- "force_final_no_tools": it has enough to answer; make it answer now without another tool call.',
        '- "replan": it is attacking the problem the wrong way; say concretely what to do instead.',
        '- "ask_user": it is missing a fact only the user can supply; give the one question.',
        '- "stop": no further progress is possible; it should stop and report honestly.',
        "Prefer force_final_no_tools or replan. Choose stop only when nothing else can work.",
        'Reply with a single JSON object and nothing else: {"action":"...","revisedApproach":"...","question":"...","rationale":"..."}',
      ].join(" "),
    },
    {
      role: "user",
      content: [
        `Mission: ${input.missionPrompt.slice(0, MAX_MISSION_PROMPT_CHARS)}`,
        "",
        `Repeated tool calls without progress: ${input.repeatedToolCalls}`,
        `Blocker: ${input.blockerSignature ?? "none reported"}`,
        "",
        `Recent transcript:\n${input.recentTranscript.slice(-MAX_TRANSCRIPT_CHARS)}`,
      ].join("\n"),
    },
  ];

  try {
    // No `tools` field: the watchdog is structurally incapable of acting.
    const request: ModelChatRequest = {
      messages,
      abortSignal: input.abortSignal,
      evidencePhase: "worker",
      ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    };
    const response = await observed.client.chat(request);
    return (
      parseWatchdogVerdict(response.message.content) ?? {
        action: "force_final_no_tools",
        rationale:
          "Watchdog returned no parsable verdict; answering with what the run already has is safer than looping.",
      }
    );
  } catch (error) {
    return {
      action: "stop",
      rationale: `Watchdog could not be reached (${describeError(error)}); stopping rather than continuing to loop.`,
    };
  }
}

/** @deprecated Use runSpecialistRecoveryVerifier. */
export async function runWatchdogWorker(
  input: RunWatchdogWorkerInput,
): Promise<WatchdogVerdict> {
  return runSpecialistRecoveryVerifier(input);
}

/** Exported for tests: the verdict contract is the whole interface. */
export function parseWatchdogVerdict(raw: string): WatchdogVerdict | null {
  const text = raw?.trim();
  if (!text) {
    return null;
  }
  // Models routinely wrap JSON in prose or fences; take the last object.
  const start = text.lastIndexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  const action = getWatchdogAction(record.action);
  if (!action) {
    return null;
  }
  const rationale =
    typeof record.rationale === "string" && record.rationale.trim()
      ? record.rationale.trim()
      : "No rationale supplied.";
  const revisedApproach =
    typeof record.revisedApproach === "string" && record.revisedApproach.trim()
      ? record.revisedApproach.trim()
      : undefined;
  const question =
    typeof record.question === "string" && record.question.trim()
      ? record.question.trim()
      : undefined;

  // A verdict that names an action but omits its payload cannot be executed.
  // Degrade to the safe action rather than emitting an unusable directive.
  if (action === "replan" && !revisedApproach) {
    return {
      action: "force_final_no_tools",
      rationale: `Replan requested without a concrete alternative; answering instead. (${rationale})`,
    };
  }
  if (action === "ask_user" && !question) {
    return {
      action: "force_final_no_tools",
      rationale: `Clarification requested without a question; answering instead. (${rationale})`,
    };
  }

  return {
    action,
    rationale,
    ...(revisedApproach ? { revisedApproach } : {}),
    ...(question ? { question } : {}),
  };
}

const WATCHDOG_TRANSCRIPT_MESSAGES = 12;
const WATCHDOG_MESSAGE_CHARS = 600;

/**
 * Condense the tail of a run's transcript for the watchdog.
 *
 * Only the last few turns matter — the watchdog is diagnosing a repetition, and
 * the repetition is by definition recent. Each message is truncated so one
 * runaway tool result cannot crowd out the pattern that reveals the loop.
 */
export function summarizeTranscriptForWatchdog(
  messages: ReadonlyArray<ModelChatMessage>,
): string {
  return messages
    .slice(-WATCHDOG_TRANSCRIPT_MESSAGES)
    .map((message) => {
      const content = (message.content ?? "").trim();
      const clipped =
        content.length > WATCHDOG_MESSAGE_CHARS
          ? `${content.slice(0, WATCHDOG_MESSAGE_CHARS)}…`
          : content;
      return `[${message.role}] ${clipped}`;
    })
    .filter((line) => line.trim().length > line.indexOf("]") + 2)
    .join("\n");
}

function getWatchdogAction(value: unknown): WatchdogAction | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === "force_final_no_tools" ||
    normalized === "replan" ||
    normalized === "ask_user" ||
    normalized === "stop"
    ? normalized
    : null;
}

/**
 * Guards the read-only invariant at module load: if someone later adds a tool
 * to the allow-list, a mutating one fails fast here rather than silently
 * granting the watchdog write authority.
 */
export function watchdogAllowListIsReadOnly(): boolean {
  return [...SPECIALIST_RECOVERY_ALLOWED_TOOLS].every(
    (toolName) => !isMutatingToolName(toolName),
  );
}

export const specialistRecoveryAllowListIsReadOnly =
  watchdogAllowListIsReadOnly;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
