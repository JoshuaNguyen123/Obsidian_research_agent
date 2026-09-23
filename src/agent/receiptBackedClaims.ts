/**
 * Which draft sentences report the run's own receipts rather than a fact
 * about the world.
 *
 * The claim ledger treated every sentence of the final answer as a claim owed
 * a web passage. A BYOK journey's answer says things like "Created Linear
 * issue APP-507", "Appended 4,217 bytes to Battery Notes.md" and
 * "create_project_idea_brief was called exactly once". No web passage can
 * ground those, while the research frontier offers only
 * web_search/web_fetch/verify_citation/read_source_section and the proof debt
 * said "next action: web_fetch". The model re-fetched, re-verified, rewrote,
 * got a fresh set of ungrounded ids, and repeated until the continuation limit
 * (two-subsystems-disagree #20). What grounds such a sentence is a receipt,
 * and the verifier already holds the run's receipts.
 *
 * The test is deliberately narrow, because an exemption that is too wide lets
 * an unsourced factual claim ride through on a receipt:
 *
 * 1. The sentence reports an action: one of a fixed set of past-tense verbs.
 * 2. It names something a receipt actually records: an issue identifier, a
 *    note path, a tool name, a URL, or a byte/word count with its unit that
 *    matches a receipt's own count. A note's bare TITLE is not enough: a
 *    research note is usually titled after its topic, so "The EU published
 *    carbon border adjustment rules" would anchor on a note called "Carbon
 *    border adjustment". A title counts only when the sentence writes it as a
 *    note reference: `[[title]]`, quoted, or in backticks.
 * 3. Once those anchors, the verbs and the receipt vocabulary are removed,
 *    at most {@link MAX_RESIDUAL_CONTENT_WORDS_V1} content words remain. "Created
 *    APP-507 to track the follow-up" passes; "Created APP-507 because
 *    sodium-ion cells cost 30% less" does not, and still owes a passage.
 *
 * One predicate, read by the one place that builds the claim ledger
 * (`verifiers.ts` → `buildClaimLedger`), so the claim set, the missing set,
 * the proof debt and the per-claim repair all see the same exemption.
 */

export const MAX_RESIDUAL_CONTENT_WORDS_V1 = 3;

/** The receipt fields this predicate reads; AgentRunReceipt satisfies it. */
export interface ReceiptForClaimAnchorsV1 {
  toolName?: string;
  path?: string;
  toPath?: string;
  bytesWritten?: number;
  bytesDeleted?: number;
  affectedCount?: number;
  effects?: {
    bytesWritten?: number;
    bytesDeleted?: number;
    affectedCount?: number;
  };
  resource?: ResourceForClaimAnchorsV1;
  relatedResources?: ResourceForClaimAnchorsV1[];
}

interface ResourceForClaimAnchorsV1 {
  id?: string;
  identifier?: string;
  url?: string;
  path?: string;
}

export interface ClaimReceiptAnchorsV1 {
  /** Lowercased literal anchors: identifiers, paths, file names, tool names, URLs. */
  literals: string[];
  /** Lowercased note titles; they anchor only when written as a note reference. */
  titles: string[];
  /** Counts a receipt recorded (bytes written, items affected). */
  counts: number[];
}

const ACTION_VERB =
  /\b(?:created|appended|wrote|written|saved|updated|filed|opened|committed|pushed|called|invoked|ran|executed|renamed|moved|linked|replaced|edited|recorded|posted|added|inserted|published|logged|trashed|closed|restored|retitled)\b/iu;

const COUNT_WITH_UNIT =
  /\b(\d{1,3}(?:[,_ ]\d{3})+|\d+)\s*(?:bytes?|characters?|chars?|words?|lines?|entries|entry|items?|notes?|files?|issues?|rows?)\b/giu;

/**
 * Words that describe the act of writing or the receipt itself, never a fact
 * about the world. They do not count toward the residual.
 */
const RECEIPT_VOCABULARY = new Set(
  (
    "created appended wrote written saved updated filed opened committed pushed called " +
    "invoked executed renamed moved linked replaced edited recorded posted added inserted " +
    "published logged trashed closed restored retitled " +
    "bytes byte characters chars words word lines line issue issues note notes file files " +
    "section sections heading headings tool tools call calls once exactly twice times time " +
    "linear github vault workspace repository repo commit branch pull request receipt receipts " +
    "readback verified verification current research memory brief project idea mission missions " +
    "append write path folder entry entries item items team with this that into from then also " +
    "have been were which their there successfully draft markdown canvas document page pages " +
    "report summary titled named under below above following same single only both each " +
    "done completed complete track tracking tracked follow followup follow-up link links " +
    "result results output outputs artifact artifacts delivery delivered"
  ).split(/\s+/u),
);

export function buildClaimReceiptAnchorsV1(
  receipts: readonly ReceiptForClaimAnchorsV1[] | undefined,
): ClaimReceiptAnchorsV1 {
  const literals = new Set<string>();
  const titles = new Set<string>();
  const counts = new Set<number>();
  const addLiteral = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || trimmed.length < 4) return;
    literals.add(trimmed.toLowerCase());
  };
  const addPath = (value: string | undefined) => {
    if (!value) return;
    addLiteral(value);
    const base = value.split("/").pop() ?? value;
    addLiteral(base);
    const title = base.replace(/\.[a-z0-9]{1,8}$/iu, "").trim().toLowerCase();
    if (title.length >= 4 && title !== base.toLowerCase()) titles.add(title);
  };
  const addCount = (value: number | undefined) => {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) counts.add(value);
  };
  const addResource = (resource: ResourceForClaimAnchorsV1 | undefined) => {
    if (!resource) return;
    addLiteral(resource.identifier);
    addLiteral(resource.id);
    addLiteral(resource.url);
    addPath(resource.path);
  };
  for (const receipt of receipts ?? []) {
    addLiteral(receipt.toolName);
    addPath(receipt.path);
    addPath(receipt.toPath);
    addCount(receipt.bytesWritten);
    addCount(receipt.bytesDeleted);
    addCount(receipt.affectedCount);
    addCount(receipt.effects?.bytesWritten);
    addCount(receipt.effects?.bytesDeleted);
    addCount(receipt.effects?.affectedCount);
    addResource(receipt.resource);
    for (const related of receipt.relatedResources ?? []) addResource(related);
  }
  return {
    // Longest first, so removing "notes/battery notes.md" happens before
    // "battery notes" and the residual is not left with fragments.
    literals: [...literals].sort((a, b) => b.length - a.length),
    titles: [...titles].sort((a, b) => b.length - a.length),
    counts: [...counts],
  };
}

export function isReceiptBackedClaimSentenceV1(
  text: string,
  anchors: ClaimReceiptAnchorsV1 | undefined,
): boolean {
  if (
    !anchors ||
    (anchors.literals.length === 0 && anchors.titles.length === 0 && anchors.counts.length === 0)
  ) {
    return false;
  }
  if (!ACTION_VERB.test(text)) return false;

  let residual = text.toLowerCase();
  let anchored = false;
  for (const literal of anchors.literals) {
    if (residual.includes(literal)) {
      anchored = true;
      residual = residual.split(literal).join(" ");
    }
  }
  for (const title of anchors.titles) {
    const reference = new RegExp(
      `\\[\\[${escapeRegExp(title)}(?:\\|[^\\]]*)?\\]\\]|["“'\`]${escapeRegExp(title)}["”'\`]`,
      "gu",
    );
    residual = residual.replace(reference, () => {
      anchored = true;
      return " ";
    });
  }
  residual = residual.replace(COUNT_WITH_UNIT, (match, digits: string) => {
    const value = Number(digits.replace(/[,_ ]/gu, ""));
    if (anchors.counts.includes(value)) anchored = true;
    return " ";
  });
  if (!anchored) return false;

  const contentWords = (residual.match(/[a-z][a-z'-]{3,}/gu) ?? []).filter(
    (word) => !RECEIPT_VOCABULARY.has(word.replace(/^'+|'+$/gu, "")),
  );
  return contentWords.length <= MAX_RESIDUAL_CONTENT_WORDS_V1;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
