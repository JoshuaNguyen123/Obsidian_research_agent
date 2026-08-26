/**
 * The one Linear Markdown canonical form.
 *
 * Linear re-serializes issue bodies on ingest, so the text a faithful publish
 * reads back is rarely byte-identical to the text it submitted. Every seat that
 * compares a submitted description against a provider readback must fold the
 * same set of provider rewrites, or a correct publish is reported as a failure.
 *
 * This module is that single set. It previously existed as two independent
 * copies -- `canonicalizeLinearDescription` (LinearTools mutation readback) and
 * `normalizeComparableTicketText` (ResearchTicketPublisher dedupe/readback) --
 * which drifted: only the publisher copy learned that Linear rewrites a
 * whole-line `_text_` emphasis span as `*text*`. Because
 * `renderLinearIssueBodyV1` renders every empty section as `_No ... recorded._`,
 * every host-rendered publication carries at least one such line, so the
 * mutation-readback copy rejected the first Linear publication of every
 * compound run with `linear_readback_failed` on `description`.
 *
 * Rules here absorb PRESENTATION ONLY. Each one folds a spelling Linear is
 * observed to rewrite while preserving the visible text. Anything that changes
 * what the body says -- different words, a dropped or added line, a retargeted
 * link, a truncated body -- still differs after canonicalization and still
 * fails closed.
 *
 * The single deliberate variation is {@link LinearTaskListPolicyV1}. The two
 * seats need different task-list semantics and each is pinned by its own test:
 * mutation readback must catch a check-state flip, while ticket dedupe must
 * still adopt issues created under the retired checkbox render instead of
 * duplicating them. Everything else is shared.
 */

export type LinearTaskListPolicyV1 =
  /**
   * `- [x]` and `- [ ]` normalize to stable spellings but stay DISTINCT, so a
   * provider check-state flip is a genuine mismatch. Mutation readback.
   */
  | "preserve_check_state"
  /**
   * `- [x]`, `- [ ]` and `- ` all fold together, so an issue rendered under the
   * retired checkbox style is recognized as the same ticket. Dedupe/adoption.
   */
  | "fold_legacy_checkboxes";

export interface LinearMarkdownCanonicalOptionsV1 {
  readonly taskList?: LinearTaskListPolicyV1;
}

/** Fold Linear's observed presentation rewrites; keep every content byte. */
export function canonicalizeLinearMarkdownV1(
  value: unknown,
  options: LinearMarkdownCanonicalOptionsV1 = {},
): string {
  const taskList = options.taskList ?? "preserve_check_state";
  const unified = String(value ?? "")
    .replace(/\r\n?/gu, "\n")
    // Strip per-line trailing whitespace before the block rules, so a fence or
    // marker line padded with spaces still anchors them.
    .replace(/[ \t]+$/gmu, "");
  return reflowBlocks(unified)
    .split("\n")
    .map((line) => canonicalizeLine(line, taskList))
    .join("\n")
    .trim();
}

/**
 * Block-level rewrites. Linear reflows the blank lines between an HTML comment
 * marker and an adjacent fenced block, which is exactly the shape of the signed
 * work-item contract appended to queue-executable descriptions.
 */
function reflowBlocks(value: string): string {
  return value
    .replace(/(<!--[^>\r\n]*-->)\n(?:[ \t]*\n)+(?=```)/gu, "$1\n")
    .replace(/(```)\n(?:[ \t]*\n)+(?=<!--)/gu, "$1\n");
}

function canonicalizeLine(line: string, taskList: LinearTaskListPolicyV1): string {
  let normalized = line;
  // Linear serializes a bare URL back as a self-link, usually with an
  // angle-bracket destination: "[url](<url>)". Collapse ONLY a true self-link,
  // so a deliberate "[text](url)" -- or a silently retargeted destination --
  // still fails verification.
  normalized = normalized.replace(
    /\[([^\]\n]+)\]\(<?([^)>\s]+)>?\)/gu,
    (match, text: string, destination: string) =>
      text === destination ? text : match,
  );
  // The same bare URL can also come back as an angle-bracket autolink.
  normalized = normalized.replace(/<(https?:\/\/[^>\s]+)>/gu, "$1");
  // Inline `__strong__` is rewritten as `**strong**` anywhere in a line
  // (observed live: `__init__(replica_id)` came back as `**init**(replica_id)`).
  normalized = normalized.replace(
    /__([^\s_](?:[^_\r\n]*?[^\s_])?)__/gu,
    "**$1**",
  );
  // A span that occupies the WHOLE line is re-spelled between `_text_` and
  // `*text*`. Converge both on the underscore form. Anchoring to the whole line
  // keeps this away from bullets (`- *x*`), asterisk bullets (`* item`) and
  // `**bold**`, so a partial-line emphasis change still fails closed.
  normalized = normalized.replace(
    /^([*_])([^\s*_](?:[^\r\n]*?[^\s*_])?)\1$/u,
    "_$2_",
  );
  // Heading depth is presentation; the heading TEXT still has to match.
  normalized = normalized.replace(/^([ \t]*)#{1,6}[ \t]+/u, "$1");
  if (taskList === "fold_legacy_checkboxes") {
    normalized = normalized.replace(
      /^([ \t]*)[-*+][ \t]+\[[ xX]\][ \t]+/u,
      "$1- ",
    );
  } else {
    normalized = normalized.replace(
      /^([ \t]*)[-*+][ \t]+\[[xX]\][ \t]+/u,
      "$1- [x] ",
    );
    normalized = normalized.replace(
      /^([ \t]*)[-*+][ \t]+\[ \][ \t]+/u,
      "$1- [ ] ",
    );
  }
  normalized = normalized.replace(/^([ \t]*)[-*+][ \t]+/u, "$1- ");
  if (!/^[ \t]*- /u.test(normalized)) {
    normalized = normalized.replace(/:[ \t]*$/u, "");
  }
  return normalized;
}

/**
 * Bounded line-level preview of the first canonical divergence. Local triage
 * only -- it names which provider rewrite the canonical form does not yet
 * absorb, without shipping whole descriptions into error payloads.
 */
export function firstLinearMarkdownDivergenceV1(
  actual: unknown,
  expected: unknown,
  options: LinearMarkdownCanonicalOptionsV1 = {},
): { line: number; actual: string; expected: string } | undefined {
  const actualLines = canonicalizeLinearMarkdownV1(actual, options).split("\n");
  const expectedLines = canonicalizeLinearMarkdownV1(expected, options).split("\n");
  const max = Math.max(actualLines.length, expectedLines.length);
  for (let index = 0; index < max; index += 1) {
    if ((actualLines[index] ?? "") !== (expectedLines[index] ?? "")) {
      return {
        line: index + 1,
        actual: (actualLines[index] ?? "").slice(0, 160),
        expected: (expectedLines[index] ?? "").slice(0, 160),
      };
    }
  }
  return undefined;
}
