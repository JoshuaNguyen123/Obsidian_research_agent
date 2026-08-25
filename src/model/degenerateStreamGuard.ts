/**
 * Detects a degenerate model stream: the tail of the output is one short
 * unit repeated without interruption for thousands of characters.
 *
 * Observed live (2026-08-25, deepseek-v4-pro): mid-mission the model fell
 * into an unbounded "000000..." emission. Nothing stopped it — the stream
 * burned provider budget and wall clock until the reader killed the run by
 * hand. A stream whose last ~3k characters are a pure cycle of length <= 24
 * is never a real answer, a real tool call, or real markdown; cutting it off
 * converts an unbounded hang into an ordinary retryable model error.
 *
 * The detector is deliberately conservative and cheap: it keeps only a
 * bounded tail, re-checks at most once per CHECK_STRIDE new characters, and
 * trips only when the ENTIRE window is periodic — long runs embedded in
 * otherwise-progressing output never fire, because fresh non-cyclic text
 * keeps entering the window.
 */

/** The window that must be wholly periodic before the stream is condemned. */
const DEGENERATE_WINDOW_CHARS = 3_000;
/** Longest repeating unit considered degenerate ("0", " .", "let me look"…). */
const MAX_CYCLE_CHARS = 24;
/** Re-check cadence: at most one periodicity scan per this many new chars. */
const CHECK_STRIDE_CHARS = 256;
/** Bounded tail retention (>= window; extra slack avoids resize churn). */
const TAIL_RETAIN_CHARS = 4_096;

export interface DegenerateStreamVerdict {
  unit: string;
  windowChars: number;
}

export interface DegenerateStreamDetector {
  /** Feed one streamed delta (thinking or content); returns a verdict once
   * the tail window degenerates, and keeps returning it thereafter. */
  feed(delta: string): DegenerateStreamVerdict | null;
}

export function createDegenerateStreamDetector(): DegenerateStreamDetector {
  let tail = "";
  let sinceLastCheck = 0;
  let verdict: DegenerateStreamVerdict | null = null;
  return {
    feed(delta: string): DegenerateStreamVerdict | null {
      if (verdict) return verdict;
      if (!delta) return null;
      tail += delta;
      if (tail.length > TAIL_RETAIN_CHARS) {
        tail = tail.slice(tail.length - TAIL_RETAIN_CHARS);
      }
      sinceLastCheck += delta.length;
      if (sinceLastCheck < CHECK_STRIDE_CHARS || tail.length < DEGENERATE_WINDOW_CHARS) {
        return null;
      }
      sinceLastCheck = 0;
      const window = tail.slice(tail.length - DEGENERATE_WINDOW_CHARS);
      const unit = findFullWindowCycle(window);
      if (unit !== null) {
        verdict = { unit, windowChars: DEGENERATE_WINDOW_CHARS };
      }
      return verdict;
    },
  };
}

/** Human-readable message for the thrown ModelClientError; the runner's
 * message-based sub-classification (cf. isOffTopicModelOutputError) can key
 * on "degenerate stream". */
export function formatDegenerateStreamMessage(
  verdict: DegenerateStreamVerdict,
): string {
  const shown = verdict.unit.length > 16 ? `${verdict.unit.slice(0, 16)}…` : verdict.unit;
  return (
    `Model output collapsed into a degenerate stream: the last ${verdict.windowChars} ` +
    `characters repeat the unit ${JSON.stringify(shown)} without interruption. ` +
    "The stream was cut off instead of letting it run unbounded."
  );
}

/**
 * Returns the smallest repeating unit (length <= MAX_CYCLE_CHARS) that the
 * whole window consists of, or null. The final repetition may be partial
 * (the stream was cut mid-unit).
 */
function findFullWindowCycle(window: string): string | null {
  for (let period = 1; period <= MAX_CYCLE_CHARS; period += 1) {
    let periodic = true;
    for (let i = period; i < window.length; i += 1) {
      if (window[i] !== window[i - period]) {
        periodic = false;
        break;
      }
    }
    if (periodic) {
      return window.slice(0, period);
    }
  }
  return null;
}
