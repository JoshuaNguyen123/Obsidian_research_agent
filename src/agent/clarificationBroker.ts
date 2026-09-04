/**
 * Mid-run clarifying questions.
 *
 * The {@link ApprovalBroker} answers a binary "may I do this?"; this answers an
 * open "what did you mean?". When the agent is genuinely unsure — an ambiguous
 * target note, two plausible interpretations, a missing constraint — it can ask
 * instead of guessing, and the run waits for a real answer.
 *
 * Deliberately conservative in two ways:
 *   1. Asking is never free: an unanswered question expires and the run
 *      continues on its best assumption rather than hanging forever.
 *   2. The answer is data, not authority. A clarification can shape *what* the
 *      agent does; it can never grant permission for a Bound/Hard action, which
 *      still requires an explicit approval through the approval broker.
 */

export interface ClarificationRequest {
  id: string;
  runId: string;
  /** The single question to put to the user. */
  question: string;
  /** Optional quick-reply suggestions rendered as chips (bounded, 0-4). */
  options: string[];
  /** Optional one-line reason the agent is unsure, shown under the question. */
  context?: string;
  expiresAtMs: number;
}

export type ClarificationOutcome =
  | { status: "answered"; answer: string }
  | { status: "skipped" | "expired" | "aborted" };

export const MAX_CLARIFICATION_OPTIONS = 4;
export const MAX_CLARIFICATION_QUESTION_CHARS = 400;
export const MAX_CLARIFICATION_ANSWER_CHARS = 2_000;

interface PendingClarification {
  request: ClarificationRequest;
  settle: (outcome: ClarificationOutcome) => void;
  timeout: ReturnType<typeof setTimeout>;
  abortHandler?: () => void;
}

const BARE_CONTINUE_OR_HELP_PROMPT =
  /^(?:please\s+)?(?:continue|go\s+on|help(?:\s+me)?|keep\s+going)[.!?]*$/iu;
const CONTINUE_RUN_PROMPT = /^(?:continue|resume)\s+run\s+\S+/iu;

let stagedOpenClarification: ClarificationRequest | null = null;

/**
 * Bare continue / help me / go on already names the next action. Offering
 * ask_user on those prompts burns a turn asking what to do next.
 */
export function shouldOfferAskUser(prompt: string): boolean {
  const normalized = prompt.trim().replace(/\s+/gu, " ");
  if (!normalized) return true;
  if (
    BARE_CONTINUE_OR_HELP_PROMPT.test(normalized) ||
    CONTINUE_RUN_PROMPT.test(normalized)
  ) {
    return false;
  }
  return true;
}

/** Quantitative gate: 1 if ask_user would still be offered on this prompt. */
export function askUserOfferedOnBareContinue(prompt: string): 0 | 1 {
  return shouldOfferAskUser(prompt) ? 1 : 0;
}

export const OPEN_CLARIFICATION_ACTION_PREFIX = "open_clarification:v1:";

export function encodeOpenClarificationAction(
  request: ClarificationRequest,
): string {
  return `${OPEN_CLARIFICATION_ACTION_PREFIX}${JSON.stringify({
    id: request.id,
    runId: request.runId,
    question: request.question,
    options: request.options,
    ...(request.context ? { context: request.context } : {}),
    expiresAtMs: request.expiresAtMs,
  })}`;
}

export function decodeOpenClarificationAction(
  action: string,
): ClarificationRequest | null {
  if (!action.startsWith(OPEN_CLARIFICATION_ACTION_PREFIX)) return null;
  try {
    const raw = JSON.parse(
      action.slice(OPEN_CLARIFICATION_ACTION_PREFIX.length),
    ) as Partial<ClarificationRequest>;
    if (
      typeof raw.id !== "string" ||
      typeof raw.runId !== "string" ||
      typeof raw.question !== "string" ||
      typeof raw.expiresAtMs !== "number"
    ) {
      return null;
    }
    return {
      id: raw.id,
      runId: raw.runId,
      question: raw.question,
      options: Array.isArray(raw.options)
        ? raw.options.filter((item): item is string => typeof item === "string")
        : [],
      ...(typeof raw.context === "string" ? { context: raw.context } : {}),
      expiresAtMs: raw.expiresAtMs,
    };
  } catch {
    return null;
  }
}

export function stageOpenClarificationForNextBroker(
  request: ClarificationRequest | null,
): void {
  stagedOpenClarification = request
    ? {
        ...request,
        options: [...request.options],
      }
    : null;
}

function takeStagedOpenClarification(): ClarificationRequest | null {
  const staged = stagedOpenClarification;
  stagedOpenClarification = null;
  return staged;
}

export class ClarificationBroker {
  private readonly pending = new Map<string, PendingClarification>();
  private sequence = 0;

  constructor() {
    const staged = takeStagedOpenClarification();
    if (staged) {
      this.hydrateRestoredClarification(staged);
    }
  }

  /** Restore a ledger-persisted question onto a fresh broker after reload. */
  restoreFromLedgerRequest(request: ClarificationRequest): void {
    this.hydrateRestoredClarification(request);
  }

  private hydrateRestoredClarification(request: ClarificationRequest): void {
    if (this.pending.has(request.id)) return;
    let settle: (outcome: ClarificationOutcome) => void = () => undefined;
    const timeoutMs = Math.max(1, request.expiresAtMs - Date.now());
    const restored: ClarificationRequest = {
      ...request,
      options: [...request.options],
      expiresAtMs: Date.now() + timeoutMs,
    };
    new Promise<ClarificationOutcome>((resolve) => {
      settle = (outcome: ClarificationOutcome) => {
        const entry = this.pending.get(request.id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        this.pending.delete(request.id);
        resolve(outcome);
      };
      const timeout = setTimeout(
        () => settle({ status: "expired" }),
        timeoutMs,
      );
      this.pending.set(request.id, {
        request: restored,
        settle,
        timeout,
      });
    });
  }

  async request(
    request: Omit<ClarificationRequest, "id" | "expiresAtMs">,
    options: {
      timeoutMs?: number;
      abortSignal?: AbortSignal;
      onRequest?: (request: ClarificationRequest) => void | Promise<void>;
    } = {},
  ): Promise<ClarificationOutcome> {
    const question = normalizeQuestion(request.question);
    if (!request.runId.trim() || !question) {
      throw new TypeError("A clarification needs a run identity and a question.");
    }
    const timeoutMs = Math.max(1, options.timeoutMs ?? 300_000);
    const id = `clarification-${request.runId}-${++this.sequence}`;
    const clarification: ClarificationRequest = {
      id,
      runId: request.runId,
      question,
      options: normalizeOptions(request.options),
      ...(request.context?.trim()
        ? { context: request.context.replace(/\s+/gu, " ").trim().slice(0, 300) }
        : {}),
      expiresAtMs: Date.now() + timeoutMs,
    };

    let settle: (outcome: ClarificationOutcome) => void = () => undefined;
    const outcomePromise = new Promise<ClarificationOutcome>((resolve) => {
      settle = (outcome: ClarificationOutcome) => {
        const entry = this.pending.get(id);
        if (!entry) return;
        clearTimeout(entry.timeout);
        if (entry.abortHandler) {
          options.abortSignal?.removeEventListener("abort", entry.abortHandler);
        }
        this.pending.delete(id);
        resolve(outcome);
      };
      const timeout = setTimeout(() => settle({ status: "expired" }), timeoutMs);
      const entry: PendingClarification = {
        request: clarification,
        settle,
        timeout,
      };
      if (options.abortSignal) {
        entry.abortHandler = () => settle({ status: "aborted" });
        options.abortSignal.addEventListener("abort", entry.abortHandler, {
          once: true,
        });
      }
      this.pending.set(id, entry);
      if (options.abortSignal?.aborted) {
        settle({ status: "aborted" });
      }
    });

    if (!options.abortSignal?.aborted) {
      try {
        await options.onRequest?.({ ...clarification, options: [...clarification.options] });
      } catch (error) {
        // A UI listener failure is not an answer: settle before surfacing so no
        // live timer leaks and the run can continue on its assumption.
        settle({ status: "aborted" });
        await outcomePromise;
        throw error;
      }
    }

    return outcomePromise;
  }

  /** Resolve a pending question with the user's answer. */
  answer(id: string, answer: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    const normalized = answer.trim().slice(0, MAX_CLARIFICATION_ANSWER_CHARS);
    if (!normalized) return false;
    entry.settle({ status: "answered", answer: normalized });
    return true;
  }

  /** The user declined to answer; the run proceeds on its best assumption. */
  skip(id: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    entry.settle({ status: "skipped" });
    return true;
  }

  getPending(): ClarificationRequest[] {
    return [...this.pending.values()].map((entry) => ({
      ...entry.request,
      options: [...entry.request.options],
    }));
  }
}

function normalizeQuestion(value: string): string {
  return (value ?? "")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, MAX_CLARIFICATION_QUESTION_CHARS);
}

function normalizeOptions(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const value of values ?? []) {
    const option = (value ?? "").replace(/\s+/gu, " ").trim().slice(0, 80);
    const key = option.toLowerCase();
    if (!option || seen.has(key)) continue;
    seen.add(key);
    normalized.push(option);
    if (normalized.length >= MAX_CLARIFICATION_OPTIONS) break;
  }
  return normalized;
}
