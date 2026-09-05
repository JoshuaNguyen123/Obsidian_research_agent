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

// This read-only mission has its own transport fixture and assertions; the
// four write scenarios above continue through their shared mutation driver.
export const OFFLINE_CITATION_REPAIR_SCENARIO = {
  id: "citation_finalization_repair",
  markerPrefix: "OFFLINE_CITATION_REPAIR",
  prompt: "Search the web for MCP servers and fetch exactly two independent sources. Answer in chat with passage citations. Mission marker {marker}.",
} as const;

export function renderOfflineExpandPrompt(
  scenario: OfflineExpandScenarioV1,
  marker: string,
): string {
  return scenario.prompt.split("{marker}").join(marker);
}

export function assertOfflineExpandCatalogComplete(): void {
  const ids = [
    ...OFFLINE_EXPAND_SCENARIOS.map((item) => item.id),
    OFFLINE_CITATION_REPAIR_SCENARIO.id,
  ];
  const defined = new Set(ids);
  for (const id of OFFLINE_EXPAND_SCENARIO_IDS) {
    if (!defined.has(id)) {
      throw new Error(`offline-expand catalog is missing scenario ${id}`);
    }
  }
  if (defined.size !== ids.length || defined.size !== OFFLINE_EXPAND_SCENARIO_IDS.length) {
    throw new Error("offline-expand catalog has extra or duplicate scenario ids");
  }
}

/**
 * Installed-plugin catalog probes for extract / citation / dataset / mermaid.
 * The scripted backend records offered tools and executes native prerequisite
 * reads. Flowchart creation also exercises prepared approval and writeback;
 * extract, citation and dataset availability require no live web or PDF fetch.
 */
export const OFFLINE_RESEARCH_CATALOG_PROBES: readonly {
  id: string;
  markerPrefix: string;
  expectedTool: string;
  prompt: string;
}[] = [
  {
    id: "extract_document_pdf",
    markerPrefix: "OFFLINE_CATALOG_EXTRACT",
    expectedTool: "extract_document",
    prompt:
      "Open this Nature paper https://example.org/paper.pdf and extract the abstract. Answer in chat only with exactly {marker}. Do not write or edit any note.",
  },
  {
    id: "verify_citation",
    markerPrefix: "OFFLINE_CATALOG_CITE",
    expectedTool: "verify_citation",
    prompt:
      "Verify the citations in this note against their source passages. Answer in chat only with exactly {marker}. Do not write or edit any note.",
  },
  {
    id: "analyze_dataset_json",
    markerPrefix: "OFFLINE_CATALOG_DATASET",
    expectedTool: "analyze_dataset",
    prompt:
      "Analyze Results.json and describe the columns. Answer in chat only with exactly {marker}. Do not write or edit any note.",
  },
  {
    id: "mermaid_flowchart_without_word",
    markerPrefix: "OFFLINE_CATALOG_FLOWCHART",
    expectedTool: "upsert_mermaid_block",
    prompt:
      "Add a flowchart to this note. Then reply in chat with exactly {marker}.",
  },
];
