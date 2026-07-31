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

export class ClarificationBroker {
  private readonly pending = new Map<string, PendingClarification>();
  private sequence = 0;

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
