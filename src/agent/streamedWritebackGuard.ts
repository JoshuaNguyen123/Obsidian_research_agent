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

function normalizeLineEndings(value: string): string {
  return value.replace(/\r\n/gu, "\n");
}
