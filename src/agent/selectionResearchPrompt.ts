/**
 * Build mission prompts for the editor/note quick actions — the daily surface
 * a researcher reaches for without composing a mission prompt.
 *
 * Every action here is one `SelectionResearchMode`. The mode decides three
 * things at once: what text the host has to collect (`scope`), whether the
 * answer may touch the note (`chatOnly`), and the prompt shape below. Keeping
 * all three in one table is what lets `main.ts` register the command palette
 * entry and the context-menu item from the same record, so the two can never
 * drift apart.
 *
 * The prompt wording is load-bearing, not decoration. `noteOutputPolicy` and
 * `sectionTarget` read these strings to decide destination/mutation, so:
 *   - note-targeted prompts must say "this note" / "the current note", and
 *   - any append that names a section must read "append a <Name> section",
 *     which is what keeps `detectSectionTargetFromHeadingsV1` from classifying
 *     it as an unresolved reference to an existing heading and answering in
 *     chat instead of writing.
 * `tests/selectionResearchPrompt.test.ts` pins both for every mode.
 */

export type SelectionResearchMode =
  | "stream_page"
  | "chat_only"
  | "continue_writing"
  | "cite_selection"
  | "audit_note_citations"
  | "extract_note_structure"
  | "ask_vault"
  | "publish_note_to_linear";

/**
 * What the host must collect before it can build the prompt.
 * - `selection`: highlighted editor text; the action is about that text.
 * - `cursor`: the note text immediately before the caret, as a lead-in.
 * - `note`: nothing from the editor; the action is about the whole note.
 */
export type SelectionResearchScope = "selection" | "cursor" | "note";

export const SELECTION_RESEARCH_MAX_CHARS = 4_000;

/** Stable marker so the runner can bind selection research to DU-02 proofs. */
export const SELECTION_RESEARCH_DAILY_USE_ID = "DU-02" as const;

export const SELECTION_RESEARCH_CONTRACT_MARKER =
  "[agentic-daily-use:DU-02]";

/**
 * Quick actions that are not the DU-02 web-research lane get their own marker.
 * Reusing the DU-02 id would bind unrelated runs to a proof contract they were
 * never meant to satisfy.
 */
export function quickActionContractMarker(mode: SelectionResearchMode): string {
  return `[agentic-researcher:quick-action:${mode}]`;
}

export interface SelectionResearchActionV1 {
  mode: SelectionResearchMode;
  /** Obsidian command id. Stable — renaming one orphans a user hotkey. */
  commandId: string;
  /** Visible label in the command palette and the context menu. */
  label: string;
  icon: string;
  scope: SelectionResearchScope;
  /** Offer in the editor right-click menu. */
  inEditorMenu: boolean;
  /** Offer in the note (file) context menu. */
  inFileMenu: boolean;
  /** Answer must stay in chat; the host also sets forceChatOnly. */
  chatOnly: boolean;
  /** Hide the entry unless a Linear credential is configured. */
  requiresLinear?: boolean;
}

/**
 * Menu section id, so every quick action clusters in one block of Obsidian's
 * context menu instead of scattering through the core items.
 */
export const SELECTION_RESEARCH_MENU_SECTION = "agentic-researcher";

/**
 * The daily surface, ordered by how often a researcher actually reaches for it.
 *
 * Selection actions live in the editor menu; whole-note actions live in the
 * file menu, so neither menu grows past four entries. Every action is in the
 * command palette regardless.
 */
export const SELECTION_RESEARCH_ACTIONS: readonly SelectionResearchActionV1[] = [
  {
    mode: "continue_writing",
    commandId: "continue-writing-here",
    label: "Continue writing here",
    icon: "pencil",
    scope: "cursor",
    inEditorMenu: true,
    inFileMenu: false,
    chatOnly: false,
  },
  {
    mode: "stream_page",
    commandId: "research-selection-web",
    label: "Research selection (web)",
    icon: "search",
    scope: "selection",
    inEditorMenu: true,
    inFileMenu: false,
    chatOnly: false,
  },
  {
    mode: "chat_only",
    commandId: "research-selection-chat-only",
    label: "Research selection (chat only)",
    icon: "message-square",
    scope: "selection",
    inEditorMenu: true,
    inFileMenu: false,
    chatOnly: true,
  },
  {
    mode: "cite_selection",
    commandId: "cite-selection",
    label: "Cite this selection",
    icon: "quote",
    scope: "selection",
    inEditorMenu: true,
    inFileMenu: false,
    chatOnly: false,
  },
  {
    mode: "ask_vault",
    commandId: "ask-vault-about-selection",
    label: "Ask my vault about this selection",
    icon: "library",
    scope: "selection",
    inEditorMenu: true,
    inFileMenu: false,
    chatOnly: true,
  },
  {
    mode: "audit_note_citations",
    commandId: "check-note-citations",
    label: "Check citations in this note",
    icon: "badge-check",
    scope: "note",
    inEditorMenu: false,
    inFileMenu: true,
    chatOnly: true,
  },
  {
    mode: "extract_note_structure",
    commandId: "extract-note-key-points",
    label: "Extract key points from this note",
    icon: "list",
    scope: "note",
    inEditorMenu: false,
    inFileMenu: true,
    chatOnly: false,
  },
  {
    mode: "publish_note_to_linear",
    commandId: "publish-note-to-linear",
    label: "Turn this note into Linear issues",
    icon: "list-checks",
    scope: "note",
    inEditorMenu: false,
    inFileMenu: true,
    chatOnly: false,
    requiresLinear: true,
  },
];

const ACTIONS_BY_MODE = new Map<SelectionResearchMode, SelectionResearchActionV1>(
  SELECTION_RESEARCH_ACTIONS.map((action) => [action.mode, action]),
);

export function getSelectionResearchAction(
  mode: SelectionResearchMode,
): SelectionResearchActionV1 {
  const action = ACTIONS_BY_MODE.get(mode);
  if (!action) {
    throw new Error(`Unknown selection research mode: ${mode}`);
  }
  return action;
}

export function selectionResearchModeScope(
  mode: SelectionResearchMode,
): SelectionResearchScope {
  return getSelectionResearchAction(mode).scope;
}

export function selectionResearchModeIsChatOnly(
  mode: SelectionResearchMode,
): boolean {
  return getSelectionResearchAction(mode).chatOnly;
}

export interface BuildSelectionResearchPromptInput {
  /**
   * Text the action is about: the editor selection, the lead-in before the
   * caret, or "" for whole-note actions.
   */
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
  scope: SelectionResearchScope;
  chatOnly: boolean;
  /** Only the DU-02 web-research lane carries a daily-use proof id. */
  dailyUseId: typeof SELECTION_RESEARCH_DAILY_USE_ID | null;
}

export function normalizeSelectionText(selection: string): string {
  return selection.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ").trim();
}

/**
 * Cursor lead-in keeps its *tail*: the sentences right before the caret are
 * what the continuation has to join onto. Truncating from the front would hand
 * the model the top of the note and drop the join point.
 */
function clampLeadIn(text: string, maxChars: number): {
  clamped: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return { clamped: text, truncated: false };
  }
  return {
    clamped: `…[earlier text omitted]\n${text.slice(text.length - maxChars).trimStart()}`,
    truncated: true,
  };
}

function clampSelection(text: string, maxChars: number): {
  clamped: string;
  truncated: boolean;
} {
  if (text.length <= maxChars) {
    return { clamped: text, truncated: false };
  }
  return {
    clamped: `${text.slice(0, maxChars).trimEnd()}\n…[selection truncated]`,
    truncated: true,
  };
}

function quoted(text: string): string[] {
  return ['"""', text, '"""'];
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
  const mode = input.mode;
  const action = getSelectionResearchAction(mode);
  const { clamped: selected, truncated } =
    action.scope === "cursor"
      ? clampLeadIn(normalized, maxChars)
      : clampSelection(normalized, maxChars);
  const notePath = input.notePath.trim() || "current note";

  const prompt = buildPromptBody({ mode, notePath, selected });

  return {
    prompt,
    truncated,
    selectionChars: normalized.length,
    mode,
    scope: action.scope,
    chatOnly: action.chatOnly,
    dailyUseId:
      mode === "stream_page" || mode === "chat_only"
        ? SELECTION_RESEARCH_DAILY_USE_ID
        : null,
  };
}

function buildPromptBody(input: {
  mode: SelectionResearchMode;
  notePath: string;
  selected: string;
}): string {
  const { mode, notePath, selected } = input;
  switch (mode) {
    case "chat_only":
      return [
        SELECTION_RESEARCH_CONTRACT_MARKER,
        `Research the following selected text from note "${notePath}" using web sources and citations.`,
        "Use web_search then web_fetch before answering. Include source URLs, limitations, and confidence.",
        "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
        "",
        "Selected text:",
        ...quoted(selected),
      ].join("\n");

    case "stream_page":
      return [
        SELECTION_RESEARCH_CONTRACT_MARKER,
        `Research the following selected text from note "${notePath}" using web sources and citations.`,
        "Use web_search then web_fetch, then append a single cited findings section into the current note (stream writeback onto the page).",
        "Include source URLs, limitations, and confidence. Reuse cached sources when available.",
        "Keep the existing note body; only append the findings section. One correction pass max for word-count if requested.",
        "",
        "Selected text:",
        ...quoted(selected),
      ].join("\n");

    case "continue_writing":
      // Deliberately free of append/revise verbs ("add", "more", "expand",
      // "revise", …): those make sectionTarget treat the prompt as a scoped
      // revision, and with no heading named it answers in chat instead of
      // writing. "this note" + "onto this page" is what routes it to a
      // streamed active-note append.
      return [
        quickActionContractMarker(mode),
        `Continue writing this note from the point where the text stops, in "${notePath}".`,
        "Match the voice, tense, terminology, and formatting already on the page. Do not repeat what is already written, and do not summarize it back to me.",
        "Stream the continuation onto this page. Keep the existing body and title unchanged.",
        "Write two to four paragraphs of substantive prose that carry the argument forward.",
        "If a factual claim needs a source, use web_search then web_fetch and cite it inline. Never invent a citation.",
        "",
        "Text immediately before my cursor:",
        ...quoted(selected),
      ].join("\n");

    case "cite_selection":
      return [
        quickActionContractMarker(mode),
        `Find and check sources for the claim selected in note "${notePath}".`,
        "Use web_search then web_fetch to locate the primary sources, then verify the citations with verify_citation and resolve_citation before you rely on any of them.",
        "Append a Sources section to the current note listing each checked citation with its title, its URL, and the exact quoted line that supports the claim. Keep the existing note body and title.",
        "Say plainly which parts of the claim you could not source. A missing source is a finding, not a gap to fill with a plausible-looking reference.",
        "",
        "Selected claim:",
        ...quoted(selected),
      ].join("\n");

    case "audit_note_citations":
      return [
        quickActionContractMarker(mode),
        `Audit every citation and link in note "${notePath}" and tell me what does not hold up.`,
        `Read "${notePath}" with read_file, then verify the citations in it: use resolve_citation and verify_citation to confirm each source exists, that its URL still resolves, and that the quoted wording actually appears in the source. Use web_fetch when you have to open one.`,
        "Give every citation one verdict: verified, unreachable, or not supported by the source. Then name the claims in the note that carry no citation at all.",
        "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
      ].join("\n");

    case "extract_note_structure":
      return [
        quickActionContractMarker(mode),
        `Read note "${notePath}" with read_file and pull out what it actually claims.`,
        "Append a Key points section to the current note with three short lists: the claims the note makes, the method or evidence each claim rests on, and the open questions it leaves. Keep the existing note body and title.",
        "Quote the note's own wording for each claim so the pull-out stays checkable against the source text.",
        "Do not introduce anything the note does not say. If the note is too thin to support a list, say so instead of padding it.",
      ].join("\n");

    case "ask_vault":
      return [
        quickActionContractMarker(mode),
        "Answer this question from my notes, not from the open web:",
        ...quoted(selected),
        "",
        `The question came from note "${notePath}".`,
        "Search my notes with semantic_search_notes and search_markdown_files, read the ones that look relevant with read_markdown_files, and answer only from what those notes actually say.",
        "Cite every note you used by its vault path. Say plainly what my notes do not cover rather than filling the gap from general knowledge.",
        "Keep the answer in chat only. Do not write, append, or save into the note unless I explicitly ask.",
      ].join("\n");

    case "publish_note_to_linear":
      return [
        quickActionContractMarker(mode),
        `Publish the research findings in note "${notePath}" to Linear as scoped issues.`,
        `Read "${notePath}" with read_file first, then publish the accepted research to Linear with publish_research_to_linear so every issue carries the finding it came from.`,
        "Append a Linear issues section to the current note listing the issue identifiers and URLs you created. Keep the existing note body and title.",
        "Do not fabricate work items the note does not support.",
      ].join("\n");

    default: {
      const exhaustive: never = mode;
      throw new Error(`Unknown selection research mode: ${String(exhaustive)}`);
    }
  }
}

export function isSelectionResearchDailyUsePrompt(prompt: string): boolean {
  return prompt.includes(SELECTION_RESEARCH_CONTRACT_MARKER);
}

export function isUsableEditorSelection(selection: string): boolean {
  return normalizeSelectionText(selection).length > 0;
}

/**
 * Cursor lead-in has to be long enough to imitate. A caret on an empty note is
 * a request to write from nothing, which is what Run Mission is for.
 */
export const CONTINUE_WRITING_MIN_LEAD_IN_CHARS = 40;

export function isUsableContinuationLeadIn(leadIn: string): boolean {
  return normalizeSelectionText(leadIn).length >= CONTINUE_WRITING_MIN_LEAD_IN_CHARS;
}
