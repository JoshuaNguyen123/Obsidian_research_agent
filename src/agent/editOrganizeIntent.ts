/**
 * Classifiers for current-note edit/organize vs vault-wide organize,
 * and whole-note vs named-section edit routing.
 */

import { hasExplicitNoNoteWriteIntent } from "./noNoteWriteIntent";

export const WRITE_RECEIPT_MISSING = "write_receipt";

export type EditOrganizeRoute =
  | "current_note_organize"
  | "vault_organize_clarify"
  | "whole_note_edit"
  | "named_section_edit"
  | "other";

export interface WriteReceiptLike {
  toolName?: string;
  operation?: string;
  path?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
  commitKind?: string;
  message?: string;
  resource?: { system?: string };
  effects?: {
    bytesWritten?: number;
    bytesDeleted?: number;
    affectedCount?: number;
    changed?: boolean;
  };
  output?: unknown;
}

const CURRENT_NOTE_TARGET =
  /\b(?:the|this|current|active)\s+(?:page|note|file|document)\b/i;

const VAULT_WIDE_CUES =
  /\b(?:vault|across\s+(?:notes|files|folders?)|all\s+(?:my\s+)?notes|folders?)\b/i;

/**
 * Edit/organize this/the/current page|note|file, or clean up this/the page|note,
 * without vault-wide cues.
 */
export function isCurrentNoteEditOrganizeIntent(prompt: string): boolean {
  if (isVaultWideOrganizeIntent(prompt)) {
    return false;
  }

  const editOrganizeCurrent =
    /\b(edit|organize|restructure|improve|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b[\s\S]{0,48}\b(?:the|this|current|active)\s+(?:page|note|file|document)\b/i.test(
      prompt,
    ) ||
    /\b(?:the|this|current|active)\s+(?:page|note|file|document)\b[\s\S]{0,48}\b(edit|organize|restructure|improve|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b/i.test(
      prompt,
    );

  const cleanUpCurrent =
    /\bclean\s+up\b[\s\S]{0,48}\b(?:the|this|current|active)\s+(?:page|note|file|document)\b/i.test(
      prompt,
    ) ||
    /\bclean\s+up\b[\s\S]{0,24}\b(?:page|note)\b/i.test(prompt);

  return editOrganizeCurrent || cleanUpCurrent;
}

/**
 * Organize vault/notes/folders/across notes without a this/current page scope.
 */
export function isVaultWideOrganizeIntent(prompt: string): boolean {
  const organizeVaultOrNotes =
    /\borganize\b[\s\S]{0,72}\b(?:my\s+)?(?:vault|notes|folders?)\b/i.test(
      prompt,
    ) ||
    /\borganize\b[\s\S]{0,48}\bacross\s+(?:notes|files|folders?)\b/i.test(
      prompt,
    ) ||
    /\bacross\s+(?:notes|files|folders?)\b[\s\S]{0,48}\borganize\b/i.test(
      prompt,
    ) ||
    /\brestructure\b[\s\S]{0,48}\b(?:my\s+)?(?:vault|folders?|notes)\b/i.test(
      prompt,
    );

  if (!organizeVaultOrNotes) {
    return false;
  }

  // "organize this/current note" is current-note scoped unless vault cues remain.
  if (CURRENT_NOTE_TARGET.test(prompt) && !VAULT_WIDE_CUES.test(prompt)) {
    return false;
  }

  // Prefer current-note when the only note target is this/current page.
  if (
    /\borganize\b[\s\S]{0,48}\b(?:the|this|current|active)\s+(?:page|note|file)\b/i.test(
      prompt,
    ) &&
    !/\b(?:vault|across|folders?|all\s+(?:my\s+)?notes)\b/i.test(prompt)
  ) {
    return false;
  }

  return true;
}

/**
 * Edit/revise/rewrite essay|page|note|draft|article|paragraphs without a named
 * section/heading target.
 *
 * Does not match ordinary "write/draft into this note" prompts (e.g. "In this
 * note, write a short project update") where "update" is a noun or write is the
 * primary verb.
 */
export function isWholeNoteEditIntent(prompt: string): boolean {
  if (hasExplicitNoNoteWriteIntent(prompt)) {
    return false;
  }
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }

  const primaryWriteVerb =
    /\b(write|draft|compose|generate|append|add)\b/i.test(prompt) &&
    !/\b(edit|revise|rewrite|improve|reorganize|organize|restructure|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b/i.test(
      prompt,
    );
  if (primaryWriteVerb) {
    return false;
  }

  // Prefer clear revise verbs; treat "update" only as a verb before the target.
  const revisionVerb =
    /\b(edit|revise|rewrite|improve|expand|iterate|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b/i;
  const wholeTextTarget =
    /\b(essay|page|note|draft|article|paragraphs?|content|body)\b|\b(?:whole|entire)\s+(?:page|note|file|document|essay|draft|article)\b/i;

  const reviseThenTarget =
    revisionVerb.test(prompt) && wholeTextTarget.test(prompt) ||
    /\b(correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b[\s\S]{0,80}\b(?:entire|whole)\s+(?:page|note|file|document|essay|draft|article|content|body)\b/i.test(
      prompt,
    ) ||
    /\bupdate\b[\s\S]{0,40}\b(?:the|this|current|active|my|whole|entire)\s+(?:essay|page|note|draft|article|paragraphs?|content|body)\b/i.test(
      prompt,
    );

  const targetThenRevise =
    wholeTextTarget.test(prompt) && revisionVerb.test(prompt) ||
    /\b(?:the|this|current|active|my|whole|entire)\s+(?:essay|page|note|draft|article|paragraphs?|content|body)\b[\s\S]{0,40}\bupdate\b/i.test(
      prompt,
    );

  return reviseThenTarget || targetThenRevise;
}

/**
 * Edit/revise a section|heading that includes an explicit name (quoted or bare).
 */
export function isNamedSectionEditIntent(prompt: string): boolean {
  if (
    !/\b(section|heading)\b/i.test(prompt) ||
    !/\b(edit|revise|update|replace|rewrite|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b/i.test(
      prompt,
    )
  ) {
    return false;
  }

  // Quoted section/heading name.
  if (
    /(?:^|[\s(,])["'`]([^"'`]+)["'`]\s+(?:section|heading)\b/i.test(prompt) ||
    /\b(?:section|heading)\s+["'`]([^"'`]+)["'`]/i.test(prompt)
  ) {
    return true;
  }

  // "edit the Introduction section" / "revise Goals heading"
  if (
    /\b(edit|revise|update|replace|rewrite|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b[\s\S]{0,100}\b(?:the\s+)?(?!(?:the|a|an|this|current|active|whole|entire|named)\b)([A-Za-z][\w-]{0,48})(?:\s+[A-Za-z][\w-]{0,48}){0,5}\s+(?:section|heading)\b/i.test(
      prompt,
    )
  ) {
    return true;
  }

  // "edit section Introduction" / "revise heading Goals"
  if (
    /\b(edit|revise|update|replace|rewrite|correct|fix|proofread|polish|correcting|fixing|proofreading|polishing)\b[\s\S]{0,48}\b(?:section|heading)\s+(?!(?:in|of|on|to|from|with|the|a|an|this|current)\b)([A-Za-z][\w-]{0,48})\b/i.test(
      prompt,
    )
  ) {
    return true;
  }

  return false;
}

export function classifyEditOrganizeRoute(prompt: string): EditOrganizeRoute {
  if (isNamedSectionEditIntent(prompt)) {
    return "named_section_edit";
  }
  if (isVaultWideOrganizeIntent(prompt)) {
    return "vault_organize_clarify";
  }
  if (isCurrentNoteEditOrganizeIntent(prompt)) {
    return "current_note_organize";
  }
  if (isWholeNoteEditIntent(prompt)) {
    return "whole_note_edit";
  }
  return "other";
}

/**
 * True when a write receipt AFFIRMATIVELY reports that the tool changed
 * nothing: `effects.changed === false`, `commitKind: "no_op"`, or every delta
 * field it carries (bytesWritten / bytesDeleted / affectedCount /
 * output.changed) is zero or false. Receipts that carry none of those fields
 * are legacy shapes and are NOT treated as zero-delta — only an affirmative
 * zero-delta signal disqualifies a receipt from proving real work.
 *
 * SHARED PREDICATE: `hasConcreteWriteReceipt` (AgentRunner) and
 * `receiptsSatisfyWriteProof` (below) must both consume this — do not
 * re-inline a private copy of the delta rule.
 */
export function receiptReportsAffirmativeZeroDelta(
  receipt: WriteReceiptLike,
): boolean {
  if (receipt.effects?.changed === false) {
    return true;
  }
  if (receipt.commitKind === "no_op") {
    return true;
  }
  const bytesWritten = receipt.bytesWritten ?? receipt.effects?.bytesWritten;
  const bytesDeleted = receipt.bytesDeleted ?? receipt.effects?.bytesDeleted;
  const affectedCount = receipt.affectedCount ?? receipt.effects?.affectedCount;
  const output =
    typeof receipt.output === "object" && receipt.output !== null
      ? (receipt.output as Record<string, unknown>)
      : null;
  const outputChanged =
    output && typeof output.changed === "boolean" ? output.changed : undefined;
  const carriesDeltaSignal =
    typeof bytesWritten === "number" ||
    typeof bytesDeleted === "number" ||
    typeof affectedCount === "number" ||
    typeof outputChanged === "boolean" ||
    typeof receipt.effects?.changed === "boolean";
  if (!carriesDeltaSignal) {
    // Legacy receipt with no delta fields: not affirmative, still passes.
    return false;
  }
  return !(
    (bytesWritten ?? 0) > 0 ||
    (bytesDeleted ?? 0) > 0 ||
    (affectedCount ?? 0) > 0 ||
    outputChanged === true ||
    receipt.effects?.changed === true
  );
}

/**
 * True when any receipt proves a vault write completed AND did real work.
 * A receipt that affirmatively reports a zero delta (see
 * `receiptReportsAffirmativeZeroDelta`) is not proof of a write.
 */
export function receiptsSatisfyWriteProof(
  receipts: WriteReceiptLike[],
): boolean {
  return receipts.some(
    (receipt) =>
      (!receipt.resource || receipt.resource.system === "vault") &&
      typeof receipt.path === "string" &&
      receipt.path.trim().length > 0 &&
      (typeof receipt.operation === "string" ||
        typeof receipt.toolName === "string" ||
        typeof receipt.message === "string") &&
      !receiptReportsAffirmativeZeroDelta(receipt),
  );
}

export function missingIncludesWriteReceipt(missing: string[]): boolean {
  return missing.includes(WRITE_RECEIPT_MISSING);
}

/** Prefer streamed replace for current-note edit/organize and whole-note edits. */
export function prefersStreamedReplaceForEditOrganize(prompt: string): boolean {
  if (hasExplicitNoNoteWriteIntent(prompt)) {
    return false;
  }
  // Named section edits stay on edit_current_section / prepare_edit — not
  // whole-note streamed replace — even when the prompt also says "this note".
  if (isNamedSectionEditIntent(prompt)) {
    return false;
  }
  return (
    isCurrentNoteEditOrganizeIntent(prompt) ||
    isWholeNoteEditIntent(prompt)
  );
}
