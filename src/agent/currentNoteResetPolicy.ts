/**
 * Re-export barrel for current-note reset / page-clear. The authority lives
 * in `replaceIntent.ts` so route, vault gate, generated policy, and note
 * output share one family.
 */
export type { CurrentNoteResetAction } from "./replaceIntent";
export {
  allowsDestructiveShortCurrentNoteReplace,
  analyzeCurrentNoteResetPrompt,
  hasPageContentClearIntent,
  isCurrentNoteReplaceResetPrompt,
  normalizePageClearPrompt,
} from "./replaceIntent";
