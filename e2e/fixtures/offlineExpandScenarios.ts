import { OFFLINE_EXPAND_SCENARIO_IDS } from "../../scripts/offline-application-attempt.mjs";

export type OfflineExpandScenarioIdV1 =
  (typeof OFFLINE_EXPAND_SCENARIO_IDS)[number];

export interface OfflineExpandScenarioV1 {
  id: OfflineExpandScenarioIdV1;
  markerPrefix: string;
  title: string;
  /**
   * Prompt the installed plugin sees. `{marker}` is replaced with the
   * per-run OFFLINE_* token.
   */
  prompt: string;
  expectedMutation: "replace" | "append";
  requiresBackup: boolean;
  expectedTools: readonly string[];
}

/**
 * Next four highest-value zero-cloud application proofs after chat_only and
 * current_note_append. These are the write paths the foundation pair does
 * not exercise: replace+backup, page-clear, word-count correction, and
 * title-rename-plus-body.
 */
export const OFFLINE_EXPAND_SCENARIOS: readonly OfflineExpandScenarioV1[] = [
  {
    id: "current_note_replace_with_backup",
    markerPrefix: "OFFLINE_REPLACE",
    title: "Replace the current note after backup",
    prompt:
      "Replace this note with a fresh brief containing exactly {marker}. Back up the current content first.",
    expectedMutation: "replace",
    requiresBackup: true,
    expectedTools: ["replace_current_file"],
  },
  {
    id: "page_clear_then_write",
    markerPrefix: "OFFLINE_PAGECLEAR",
    title: "Clear the page, then write",
    prompt:
      "Delete all the notes on the page first. Then write a short replacement containing exactly {marker}.",
    expectedMutation: "replace",
    requiresBackup: true,
    expectedTools: ["replace_current_file"],
  },
  {
    id: "word_count_correction",
    markerPrefix: "OFFLINE_WORDCOUNT",
    title: "Write, count words, correct a shortfall",
    prompt:
      "Write a 40 word note containing exactly {marker} onto this page, then use count_words to verify. If the count is short, append until the note meets the target.",
    expectedMutation: "append",
    requiresBackup: false,
    expectedTools: ["count_words", "append_to_current_file"],
  },
  {
    id: "title_rename_plus_body",
    markerPrefix: "OFFLINE_TITLE",
    title: "Rename the note, then write the body",
    prompt:
      "Write a brief containing exactly {marker} onto this page. Change the title as well to Offline Title Brief.",
    expectedMutation: "append",
    requiresBackup: false,
    expectedTools: ["rename_current_file", "append_to_current_file"],
  },
];

export function renderOfflineExpandPrompt(
  scenario: OfflineExpandScenarioV1,
  marker: string,
): string {
  return scenario.prompt.split("{marker}").join(marker);
}

export function assertOfflineExpandCatalogComplete(): void {
  const defined = new Set(OFFLINE_EXPAND_SCENARIOS.map((item) => item.id));
  for (const id of OFFLINE_EXPAND_SCENARIO_IDS) {
    if (!defined.has(id)) {
      throw new Error(`offline-expand catalog is missing scenario ${id}`);
    }
  }
  if (defined.size !== OFFLINE_EXPAND_SCENARIO_IDS.length) {
    throw new Error("offline-expand catalog has extra or duplicate scenario ids");
  }
}
