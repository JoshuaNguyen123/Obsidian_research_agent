/**
 * Obsidian Editor subset used to keep the visible note pinned to streaming
 * writeback. Callers pass the live editor; this module never imports Obsidian.
 */
export type StreamingFollowEditor = {
  setValue?: (value: string) => void;
  offsetToPos?: (offset: number) => { line: number; ch: number };
  lastLine?: () => number;
  getLine?: (line: number) => string;
  scrollIntoView?: (
    range: {
      from: { line: number; ch: number };
      to: { line: number; ch: number };
    },
    center?: boolean,
  ) => void;
};

export type SetCurrentMarkdownContentOptions = {
  /** Keep the visible editor viewport on the newest streamed bytes. */
  followStreamingEnd?: boolean;
};

/**
 * Replace editor contents and, when requested, scroll so the latest streamed
 * bytes stay in view. Avoids setCursor so the agent panel keeps focus.
 */
export function setEditorValueFollowingStreamEnd(
  editor: StreamingFollowEditor,
  content: string,
  options: SetCurrentMarkdownContentOptions = {},
): void {
  editor.setValue?.(content);
  if (options.followStreamingEnd) {
    followEditorStreamingEnd(editor, content);
  }
}

export function followEditorStreamingEnd(
  editor: StreamingFollowEditor,
  content: string,
): void {
  const end = resolveEditorEndPosition(editor, content);
  if (!end || typeof editor.scrollIntoView !== "function") {
    return;
  }
  editor.scrollIntoView({ from: end, to: end }, false);
}

function resolveEditorEndPosition(
  editor: StreamingFollowEditor,
  content: string,
): { line: number; ch: number } | null {
  if (typeof editor.offsetToPos === "function") {
    try {
      return editor.offsetToPos(Math.max(0, content.length));
    } catch {
      // Fall through to lastLine when the editor rejects an out-of-range offset
      // during a transitional layout update.
    }
  }

  if (typeof editor.lastLine !== "function") {
    return null;
  }

  const line = editor.lastLine();
  if (!Number.isFinite(line) || line < 0) {
    return null;
  }
  const text =
    typeof editor.getLine === "function" ? editor.getLine(line) ?? "" : "";
  return { line, ch: text.length };
}
