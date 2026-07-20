/**
 * Build mission prompts for editor-selection → web research entry points.
 * Default mode streams/appends cited findings onto the current note (DU-02).
 */

export type SelectionResearchMode = "stream_page" | "chat_only";

export const SELECTION_RESEARCH_MAX_CHARS = 4_000;

/** Stable marker so the runner can bind selection research to DU-02 proofs. */
export const SELECTION_RESEARCH_DAILY_USE_ID = "DU-02" as const;

export const SELECTION_RESEARCH_CONTRACT_MARKER =
  "[agentic-daily-use:DU-02]";

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
  dailyUseId: typeof SELECTION_RESEARCH_DAILY_USE_ID;
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
          SELECTION_RESEARCH_CONTRACT_MARKER,
          `Research the following selected text from note "${notePath}" using web sources and citations.`,
          "Use web_search then web_fetch before answering. Include source URLs, limitations, and confidence.",
          "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
          "",
          "Selected text:",
          '"""',
          selected,
          '"""',
        ].join("\n")
      : [
          SELECTION_RESEARCH_CONTRACT_MARKER,
          `Research the following selected text from note "${notePath}" using web sources and citations.`,
          "Use web_search then web_fetch, then append a single cited findings section into the current note (stream writeback onto the page).",
          "Include source URLs, limitations, and confidence. Reuse cached sources when available.",
          "Keep the existing note body; only append the findings section. One correction pass max for word-count if requested.",
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
    dailyUseId: SELECTION_RESEARCH_DAILY_USE_ID,
  };
}

export function isSelectionResearchDailyUsePrompt(prompt: string): boolean {
  return prompt.includes(SELECTION_RESEARCH_CONTRACT_MARKER);
}

export function isUsableEditorSelection(selection: string): boolean {
  return normalizeSelectionText(selection).length > 0;
}
