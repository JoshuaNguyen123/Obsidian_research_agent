/**
 * Host-owned streaming writeback safety: rolling mid-stream tool-markup
 * detection and idempotent retry policy after partial note apply.
 */

const TOOL_MARKUP_PATTERNS = [
  /<requested_tool_call\b/i,
  /<\/requested_tool_call>/i,
  /"tool_calls"\s*:/,
  /```\s*(json|tool|tool_call|function)\b/i,
];

export interface StreamWriteSession {
  released: boolean;
  bytesApplied: number;
  rollingTail: string;
  aborted: boolean;
  skippedCorruptRetries: number;
}

export function createStreamWriteSession(): StreamWriteSession {
  return {
    released: false,
    bytesApplied: 0,
    rollingTail: "",
    aborted: false,
    skippedCorruptRetries: 0,
  };
}

export function recordAppliedBytes(
  session: StreamWriteSession,
  chunk: string,
): void {
  session.bytesApplied += chunk.length;
  session.released = true;
  session.rollingTail = (session.rollingTail + chunk).slice(-512);
}

export function containsToolCallMarkup(content: string): boolean {
  return TOOL_MARKUP_PATTERNS.some((pattern) => pattern.test(content));
}

/**
 * After live release, abort when a rolling window (not only chunk start)
 * shows tool-call markup so mid-paragraph leaks are caught.
 */
export function shouldAbortReleasedChunk(
  session: StreamWriteSession,
  chunk: string,
): boolean {
  if (!chunk || session.aborted) {
    return session.aborted;
  }
  session.rollingTail = (session.rollingTail + chunk).slice(-512);
  if (containsToolCallMarkup(session.rollingTail)) {
    session.aborted = true;
    return true;
  }
  return false;
}

export function shouldKeepPostReleaseBuffer(content: string): boolean {
  const trimmed = content.trimStart();
  const lower = trimmed.toLowerCase();
  return (
    lower.startsWith("<requested_tool_call") ||
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    /^\\?`\\?`?\\?`?\s*(json|tool|tool_call|function)\b/i.test(trimmed)
  );
}

export interface StreamRetryPolicy {
  skipBytes: number;
  allowRetry: boolean;
  reason: string;
}

/**
 * After any note bytes were applied, do not re-emit from the start on
 * transient provider retry — either resume from offset or fail clean.
 */
export function createIdempotentStreamRetryPolicy(
  session: StreamWriteSession,
): StreamRetryPolicy {
  if (session.aborted) {
    return {
      skipBytes: session.bytesApplied,
      allowRetry: false,
      reason: "stream_aborted_tool_markup",
    };
  }
  if (session.bytesApplied === 0) {
    return {
      skipBytes: 0,
      allowRetry: true,
      reason: "no_bytes_applied",
    };
  }
  return {
    skipBytes: session.bytesApplied,
    allowRetry: false,
    reason: "partial_write_no_safe_retry",
  };
}

/**
 * A concurrent writer — almost always the reader typing in the open note —
 * changed the target between two flushes of an in-flight stream.
 */
export interface ExternalStreamEdit {
  reason: "external_note_edit";
  expectedChars: number;
  observedChars: number;
}

/**
 * Compare the live note against the exact bytes this stream last committed.
 *
 * Line endings are normalized because an editor buffer holds LF for a note
 * stored with CRLF. Nothing else is forgiven: an otherwise unexplained
 * difference means someone else owns those bytes now, and the next
 * whole-document flush would silently destroy them.
 */
export function detectExternalStreamEdit({
  expected,
  observed,
}: {
  expected: string;
  observed: string;
}): ExternalStreamEdit | null {
  if (normalizeLineEndings(expected) === normalizeLineEndings(observed)) {
    return null;
  }
  return {
    reason: "external_note_edit",
    expectedChars: expected.length,
    observedChars: observed.length,
  };
}

/**
 * Same shape as `createIdempotentStreamRetryPolicy`'s failure: say what
 * stopped, say what was kept, and do not offer a retry that would overwrite.
 */
export function formatExternalStreamEditMessage(
  path: string | null | undefined,
  appliedChars: number,
): string {
  const target = path ? ` (${path})` : "";
  return (
    `Stopped streamed writeback: the note${target} changed outside this run ` +
    `after ${appliedChars} streamed characters were applied. The edit was kept ` +
    "and nothing was overwritten; re-run the mission to continue writing."
  );
}

export interface WritebackPreambleStrip {
  content: string;
  strippedPreamble: string | null;
}

const PREAMBLE_SCAN_CHARS = 1200;
const PREAMBLE_MAX_CHARS = 400;
const PREAMBLE_MAX_LINES = 4;
const PREAMBLE_DIALOGUE_OPENER =
  /^(?:here(?:'|’)?s\b|here is\b|below is\b|sure\b|certainly\b|of course\b|okay\b|ok[,.!]|as requested\b|i(?:'|’)?ve\b|i have\b|i (?:corrected|updated|revised|rewrote|fixed|addressed)\b|this is the\b|the (?:corrected|revised|updated) \b)/iu;

/**
 * Drop conversational dialogue the model emitted above the note's opening
 * heading in a staged writeback candidate.
 *
 * The writeback prompt forbids preambles, but under a verification-correction
 * exchange the model sometimes answers the correction conversationally
 * ("I've fixed the quoted passage — here is the corrected note:") before the
 * markdown, and the staged commit would write that dialogue into the vault
 * above the H1 (observed in a committed Math note, 2026-08-24).
 *
 * Deliberately conservative — a legitimate note may open with prose before
 * its first heading, so the prefix is removed only when every signal agrees
 * it is dialogue: the candidate does not open with YAML frontmatter, a `#`
 * heading appears early, the prefix is short plain prose with no markdown
 * structure of its own, and it either opens with a dialogue phrase or ends
 * with the colon of a lead-in. Anything ambiguous is kept verbatim.
 */
export function stripWritebackDialoguePreamble(
  candidate: string,
): WritebackPreambleStrip {
  const keep: WritebackPreambleStrip = {
    content: candidate,
    strippedPreamble: null,
  };
  const normalized = normalizeLineEndings(candidate);
  if (normalized.startsWith("---\n") || normalized.startsWith("#")) {
    return keep;
  }
  const headingMatch = /^#{1,6} \S/mu.exec(normalized);
  if (!headingMatch || headingMatch.index > PREAMBLE_SCAN_CHARS) {
    return keep;
  }
  const prefix = normalized.slice(0, headingMatch.index);
  const prefixLines = prefix
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (
    prefixLines.length === 0 ||
    prefixLines.length > PREAMBLE_MAX_LINES ||
    prefix.trim().length > PREAMBLE_MAX_CHARS
  ) {
    return keep;
  }
  const hasMarkdownStructure = prefixLines.some((line) =>
    /^(?:#{1,6} |[-*+] |\d+[.)] |> |```|\||---)/u.test(line),
  );
  if (hasMarkdownStructure) {
    return keep;
  }
  const opensAsDialogue = PREAMBLE_DIALOGUE_OPENER.test(prefixLines[0]);
  const endsAsLeadIn = /:\s*$/u.test(prefixLines[prefixLines.length - 1]);
  if (!opensAsDialogue && !endsAsLeadIn) {
    return keep;
  }
  // Re-locate the heading in the un-normalized candidate so the kept slice
  // preserves the original bytes (a CRLF candidate shifts every index).
  const originalHeading = /^#{1,6} \S/mu.exec(candidate);
  if (!originalHeading) {
    return keep;
  }
  return {
    content: candidate.slice(originalHeading.index),
    strippedPreamble: prefix.trim(),
  };
}

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}
