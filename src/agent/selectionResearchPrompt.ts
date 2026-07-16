/**
 * Build mission prompts for editor-selection → web research entry points.
 * Default mode streams/appends cited findings onto the current note.
 */

export type SelectionResearchMode = "stream_page" | "chat_only";

export const SELECTION_RESEARCH_MAX_CHARS = 4_000;

export interface BuildSelectionResearchPromptInput {
  selection: string;
  notePath: string;
  mode: SelectionResearchMode;
  maxChars?: number;
}

export interface SelectionResearchPromptResult {
  prompt: string;
  truncated: boolean;
  selectionChars: number;
  mode: SelectionResearchMode;
}

export function normalizeSelectionText(selection: string): string {
  return selection.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

export function buildSelectionResearchPrompt(
  input: BuildSelectionResearchPromptInput,
): SelectionResearchPromptResult {
  const maxChars = Math.max(
    200,
    Math.min(
      SELECTION_RESEARCH_MAX_CHARS,
      Math.trunc(input.maxChars ?? SELECTION_RESEARCH_MAX_CHARS),
    ),
  );
  const normalized = normalizeSelectionText(input.selection);
  const truncated = normalized.length > maxChars;
  const selected = truncated
    ? `${normalized.slice(0, maxChars).trimEnd()}\n…[selection truncated]`
    : normalized;
  const notePath = input.notePath.trim() || "current note";
  const mode = input.mode;

  const prompt =
    mode === "chat_only"
      ? [
          `Research the following selected text from note "${notePath}" using web sources and citations.`,
          "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
          "",
          "Selected text:",
          '"""',
          selected,
          '"""',
        ].join("\n")
      : [
          `Research the following selected text from note "${notePath}" using web sources and citations.`,
          "Write and append a cited findings section into the current note (stream writeback onto the page).",
          "Keep the existing note body; only append the findings section.",
          "",
          "Selected text:",
          '"""',
          selected,
          '"""',
        ].join("\n");

  return {
    prompt,
    truncated,
    selectionChars: normalized.length,
    mode,
  };
}

export function isUsableEditorSelection(selection: string): boolean {
  return normalizeSelectionText(selection).length > 0;
}
