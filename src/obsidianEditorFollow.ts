/**
 * Obsidian Editor subset used to keep the visible note pinned to streaming
 * writeback. Callers pass the live editor; this module never imports Obsidian.
 *
 * Streaming writeback used to replace the whole editor buffer 7-13 times per
 * second, which destroyed the caret and yanked the viewport back to the tail on
 * every flush. Both are now avoided: the smallest differing span is written
 * with `replaceRange`, the caret/selection is restored when the editor did not
 * map it itself, and viewport following gives up for the rest of the stream
 * once the reader scrolls away from the tail.
 */
export type EditorPosition = { line: number; ch: number };

export type EditorScrollInfo = { top: number; left: number };

export type StreamingFollowEditor = {
  getValue?: () => string;
  setValue?: (value: string) => void;
  replaceRange?: (
    replacement: string,
    from: EditorPosition,
    to?: EditorPosition,
  ) => void;
  getCursor?: (which?: "from" | "to" | "head" | "anchor") => EditorPosition;
  setCursor?: (pos: EditorPosition) => void;
  setSelection?: (anchor: EditorPosition, head?: EditorPosition) => void;
  posToOffset?: (pos: EditorPosition) => number;
  offsetToPos?: (offset: number) => EditorPosition;
  getScrollInfo?: () => EditorScrollInfo;
  lastLine?: () => number;
  getLine?: (line: number) => string;
  scrollIntoView?: (
    range: {
      from: EditorPosition;
      to: EditorPosition;
    },
    center?: boolean,
  ) => void;
};

export type SetCurrentMarkdownContentOptions = {
  /** Keep the visible editor viewport on the newest streamed bytes. */
  followStreamingEnd?: boolean;
  /**
   * Identifies one streaming session. Follow state (including "the reader
   * scrolled away, stop yanking them back") is scoped to this key, so the next
   * stream starts attached again without any explicit reset call.
   */
  streamKey?: string;
};

export type StreamingEditorWriteMode =
  | "unchanged"
  | "ranged"
  | "full_replace"
  | "unsupported";

export type MinimalEditRange = {
  /** Offset in the previous document where the replaced span starts. */
  from: number;
  /** Offset in the previous document where the replaced span ends. */
  to: number;
  /** Text that replaces `[from, to)`. */
  text: string;
};

/**
 * How far the viewport may drift back from where the last follow left it before
 * we read it as the reader deliberately scrolling away from the tail.
 */
const STREAM_FOLLOW_SCROLL_TOLERANCE_PX = 8;

type StreamFollowState = {
  detached: boolean;
  lastScrollTop: number | null;
  streamKey: string | null;
};

const STREAM_FOLLOW_STATES = new WeakMap<object, StreamFollowState>();

/**
 * Smallest single replacement turning `previous` into `next`, or null when the
 * two are already identical. Common prefix and suffix are trimmed, so an
 * append-only stream produces a pure insertion at the tail and a section edit
 * that keeps a trailing suffix produces an insertion in the middle.
 */
export function computeMinimalEditRange(
  previous: string,
  next: string,
): MinimalEditRange | null {
  if (previous === next) {
    return null;
  }

  const maxPrefix = Math.min(previous.length, next.length);
  let prefix = 0;
  while (
    prefix < maxPrefix &&
    previous.charCodeAt(prefix) === next.charCodeAt(prefix)
  ) {
    prefix += 1;
  }
  // A boundary inside a surrogate pair is not a valid document position.
  if (prefix > 0 && isHighSurrogate(previous.charCodeAt(prefix - 1))) {
    prefix -= 1;
  }

  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;
  while (
    suffix < maxSuffix &&
    previous.charCodeAt(previous.length - 1 - suffix) ===
      next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }
  while (
    suffix > 0 &&
    isLowSurrogate(previous.charCodeAt(previous.length - suffix))
  ) {
    suffix -= 1;
  }

  return {
    from: prefix,
    to: previous.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Where an offset in the previous document lands after `edit` is applied.
 * `assoc` decides which side of an insertion an offset sitting exactly on the
 * insertion point ends up on — the two mappings an editor may legitimately pick.
 */
export function mapOffsetThroughEdit(
  offset: number,
  edit: MinimalEditRange,
  assoc: -1 | 1 = -1,
): number {
  if (offset < edit.from) {
    return offset;
  }
  if (offset > edit.to) {
    return offset + edit.text.length - (edit.to - edit.from);
  }
  if (offset === edit.from && assoc < 0) {
    return edit.from;
  }
  return edit.from + edit.text.length;
}

/**
 * Write `content` into the editor and, when requested, keep the viewport on the
 * newest streamed bytes.
 */
export function setEditorValueFollowingStreamEnd(
  editor: StreamingFollowEditor,
  content: string,
  options: SetCurrentMarkdownContentOptions = {},
): StreamingEditorWriteMode {
  const mode = applyStreamingEditorContent(editor, content);
  if (options.followStreamingEnd) {
    followEditorStreamingEnd(editor, content, options);
  }
  return mode;
}

/**
 * Apply `content` with the smallest possible edit so the reader's caret and
 * selection survive. Editors exposing no ranged write fall back to the old
 * whole-buffer replace, with the caret restored by hand afterwards.
 */
export function applyStreamingEditorContent(
  editor: StreamingFollowEditor,
  content: string,
): StreamingEditorWriteMode {
  const previous =
    typeof editor.getValue === "function" ? editor.getValue() : null;
  if (typeof previous === "string" && previous === content) {
    return "unchanged";
  }

  if (
    typeof previous === "string" &&
    typeof editor.replaceRange === "function" &&
    typeof editor.offsetToPos === "function"
  ) {
    const edit = computeMinimalEditRange(previous, content);
    if (!edit) {
      return "unchanged";
    }
    const selection = readSelectionOffsets(editor);
    editor.replaceRange(
      edit.text,
      editor.offsetToPos(edit.from),
      editor.offsetToPos(edit.to),
    );
    restoreSelectionAfterEdit(editor, selection, edit, false);
    return "ranged";
  }

  if (typeof editor.setValue !== "function") {
    return "unsupported";
  }

  const selection =
    typeof previous === "string" ? readSelectionOffsets(editor) : null;
  editor.setValue(content);
  if (selection && typeof previous === "string") {
    // setValue always drops the caret, so restore unconditionally here.
    restoreSelectionAfterEdit(
      editor,
      selection,
      computeMinimalEditRange(previous, content),
      true,
    );
  }
  return "full_replace";
}

type SelectionOffsets = { anchor: number; head: number };

function readCursorOffset(
  editor: StreamingFollowEditor,
  which: "anchor" | "head",
): number | null {
  if (
    typeof editor.getCursor !== "function" ||
    typeof editor.posToOffset !== "function"
  ) {
    return null;
  }
  try {
    const offset = editor.posToOffset(editor.getCursor(which));
    return Number.isFinite(offset) ? offset : null;
  } catch {
    return null;
  }
}

function readSelectionOffsets(
  editor: StreamingFollowEditor,
): SelectionOffsets | null {
  const anchor = readCursorOffset(editor, "anchor");
  const head = readCursorOffset(editor, "head");
  if (anchor === null || head === null) {
    return null;
  }
  return { anchor, head };
}

function restoreSelectionAfterEdit(
  editor: StreamingFollowEditor,
  selection: SelectionOffsets | null,
  edit: MinimalEditRange | null,
  force: boolean,
): void {
  if (!selection || !edit || typeof editor.offsetToPos !== "function") {
    return;
  }

  if (!force && selectionAlreadyMapped(editor, selection, edit)) {
    // The editor mapped the caret itself. Touching it again would risk taking
    // focus back from whatever pane the reader is actually in.
    return;
  }

  const anchor = mapOffsetThroughEdit(selection.anchor, edit);
  const head = mapOffsetThroughEdit(selection.head, edit);
  if (anchor !== head && typeof editor.setSelection === "function") {
    editor.setSelection(editor.offsetToPos(anchor), editor.offsetToPos(head));
    return;
  }
  if (typeof editor.setCursor === "function") {
    editor.setCursor(editor.offsetToPos(head));
  }
}

function selectionAlreadyMapped(
  editor: StreamingFollowEditor,
  selection: SelectionOffsets,
  edit: MinimalEditRange,
): boolean {
  const actual = readSelectionOffsets(editor);
  if (!actual) {
    return false;
  }
  return (
    offsetMatchesEitherMapping(actual.anchor, selection.anchor, edit) &&
    offsetMatchesEitherMapping(actual.head, selection.head, edit)
  );
}

function offsetMatchesEitherMapping(
  actual: number,
  before: number,
  edit: MinimalEditRange,
): boolean {
  return (
    actual === mapOffsetThroughEdit(before, edit, -1) ||
    actual === mapOffsetThroughEdit(before, edit, 1)
  );
}

/**
 * Scroll the newest streamed bytes into view, unless the reader has scrolled
 * back from the tail during this stream. Following is sticky-off: once the
 * reader takes the viewport, the rest of the stream leaves it alone.
 */
export function followEditorStreamingEnd(
  editor: StreamingFollowEditor,
  content: string,
  options: SetCurrentMarkdownContentOptions = {},
): void {
  const state = getStreamFollowState(editor, options.streamKey ?? null);
  if (state.detached) {
    return;
  }

  const before = readScrollTop(editor);
  if (
    before !== null &&
    state.lastScrollTop !== null &&
    before < state.lastScrollTop - STREAM_FOLLOW_SCROLL_TOLERANCE_PX
  ) {
    // The viewport moved back up between flushes, and the only thing that moves
    // it up is the reader. Stop fighting them for the rest of the stream.
    state.detached = true;
    return;
  }

  const end = resolveEditorEndPosition(editor, content);
  if (!end || typeof editor.scrollIntoView !== "function") {
    return;
  }
  editor.scrollIntoView({ from: end, to: end }, false);
  const after = readScrollTop(editor);
  if (after !== null) {
    state.lastScrollTop = after;
  }
}

/** Whether viewport following has given up for the named stream. */
export function hasStreamFollowDetached(
  editor: StreamingFollowEditor,
  streamKey?: string,
): boolean {
  const state = STREAM_FOLLOW_STATES.get(editor);
  if (!state) {
    return false;
  }
  if (streamKey !== undefined && state.streamKey !== streamKey) {
    return false;
  }
  return state.detached;
}

function getStreamFollowState(
  editor: StreamingFollowEditor,
  streamKey: string | null,
): StreamFollowState {
  const existing = STREAM_FOLLOW_STATES.get(editor);
  if (existing && existing.streamKey === streamKey) {
    return existing;
  }
  const state: StreamFollowState = {
    detached: false,
    lastScrollTop: null,
    streamKey,
  };
  STREAM_FOLLOW_STATES.set(editor, state);
  return state;
}

function readScrollTop(editor: StreamingFollowEditor): number | null {
  if (typeof editor.getScrollInfo !== "function") {
    return null;
  }
  try {
    const info = editor.getScrollInfo();
    return info && Number.isFinite(info.top) ? info.top : null;
  } catch {
    return null;
  }
}

function resolveEditorEndPosition(
  editor: StreamingFollowEditor,
  content: string,
): EditorPosition | null {
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
