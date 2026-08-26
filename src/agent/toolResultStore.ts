/**
 * Full tool payloads set aside when compaction shrinks them.
 *
 * Compaction is a one-way door today: `shrinkToolMessageForCompaction` rewrites
 * an oversized tool result down to a whitelist of chaining keys and the original
 * is gone from the run. The agent cannot reopen evidence it already paid a tool
 * call to fetch, so it refetches -- which grows the prompt again and triggers
 * more compaction. Keeping the full text here makes compaction lossless *by
 * reference*: the loop still gets small, and the content is still reachable.
 *
 * Run-scoped and in memory on purpose. Recall only ever happens inside the run
 * that stashed the payload, so durability would buy nothing a resumed run could
 * use -- a resumed run rebuilds its loop from the ledger, not from these. The
 * cost of that choice is explicit: after a crash the keys are gone, and
 * `recallToolResult` says so rather than pretending the content never existed.
 *
 * Bounded by total bytes, evicting oldest first, so a long mission cannot grow
 * this without limit. Eviction is visible to the caller for the same reason: a
 * key that once worked and now does not is a fact the model needs, not a
 * silence to paper over.
 */

/** Total characters retained per run before the oldest entries are evicted. */
export const TOOL_RESULT_STORE_MAX_CHARS = 2_000_000;

export interface StashedToolResultV1 {
  key: string;
  toolName: string;
  step: number;
  content: string;
}

export type ToolResultRecallStatusV1 = "found" | "evicted" | "unknown";

export interface ToolResultRecallV1 {
  status: ToolResultRecallStatusV1;
  key: string;
  toolName: string | null;
  step: number | null;
  /** Full or sliced content when found; null otherwise. */
  content: string | null;
  totalChars: number | null;
  truncated: boolean;
  /** Matching line numbers when a query was given. */
  matchLines: number[];
  message: string;
}

export interface ToolResultStoreV1 {
  stash(input: { toolName: string; step: number; content: string }): string;
  recall(
    key: string,
    options?: { query?: string; maxChars?: number },
  ): ToolResultRecallV1;
  size(): { entries: number; chars: number };
}

export function createToolResultStoreV1(
  runId: string,
  { maxChars = TOOL_RESULT_STORE_MAX_CHARS }: { maxChars?: number } = {},
): ToolResultStoreV1 {
  const entries = new Map<string, StashedToolResultV1>();
  // Keys evicted for space, kept so recall can distinguish "this never existed"
  // from "this existed and was dropped". They are different problems: one is a
  // hallucinated key, the other is a real limit the model should route around.
  const evicted = new Set<string>();
  let sequence = 0;
  let chars = 0;

  const evictOldestUntilFits = () => {
    for (const [key, entry] of entries) {
      if (chars <= maxChars) break;
      entries.delete(key);
      evicted.add(key);
      chars -= entry.content.length;
    }
  };

  return {
    stash({ toolName, step, content }) {
      sequence += 1;
      const key = `tr_${runId}_${sequence}`;
      entries.set(key, { key, toolName, step, content });
      chars += content.length;
      evictOldestUntilFits();
      return key;
    },

    recall(key, { query, maxChars: sliceChars } = {}) {
      const trimmedKey = key.trim();
      const entry = entries.get(trimmedKey);
      if (!entry) {
        const wasEvicted = evicted.has(trimmedKey);
        return {
          status: wasEvicted ? "evicted" : "unknown",
          key: trimmedKey,
          toolName: null,
          step: null,
          content: null,
          totalChars: null,
          truncated: false,
          matchLines: [],
          message: wasEvicted
            ? "That result was dropped to stay within the run's retained-output limit. Re-run the tool if you still need it."
            : "No stashed tool result has that key in this run.",
        };
      }

      const totalChars = entry.content.length;
      const term = query?.trim().toLowerCase() ?? "";

      if (term) {
        const lines = entry.content.split("\n");
        const matchLines: number[] = [];
        const kept: string[] = [];
        for (let index = 0; index < lines.length; index += 1) {
          if (!lines[index].toLowerCase().includes(term)) continue;
          matchLines.push(index + 1);
          kept.push(`${index + 1}: ${lines[index]}`);
        }
        const joined = kept.join("\n");
        const limit = normalizeSliceChars(sliceChars);
        return {
          status: "found",
          key: trimmedKey,
          toolName: entry.toolName,
          step: entry.step,
          content: joined.length > limit ? joined.slice(0, limit) : joined,
          totalChars,
          truncated: joined.length > limit,
          matchLines,
          message:
            matchLines.length > 0
              ? `Found ${matchLines.length} matching line(s) in the stashed result.`
              : "The stashed result contains no line matching that query.",
        };
      }

      const limit = normalizeSliceChars(sliceChars);
      return {
        status: "found",
        key: trimmedKey,
        toolName: entry.toolName,
        step: entry.step,
        content:
          totalChars > limit ? entry.content.slice(0, limit) : entry.content,
        totalChars,
        truncated: totalChars > limit,
        matchLines: [],
        message:
          totalChars > limit
            ? "Returned the first part of the stashed result. Pass a query to search it instead."
            : "Returned the full stashed result.",
      };
    },

    size: () => ({ entries: entries.size, chars }),
  };
}

/** Default slice is generous but bounded; recall exists to reopen, not to reflood. */
const DEFAULT_RECALL_CHARS = 6_000;
const MAX_RECALL_CHARS = 40_000;

function normalizeSliceChars(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_RECALL_CHARS;
  }
  return Math.min(MAX_RECALL_CHARS, Math.max(200, Math.trunc(value)));
}
