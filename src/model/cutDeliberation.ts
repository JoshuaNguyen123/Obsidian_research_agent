/**
 * A reply that ran out of room while it was still deliberating holds no answer.
 *
 * Observed live (Research Agent Platform, ATR-15 comparison V5, 2026-10-26,
 * glm-5.3-flash:cloud on Ollama Cloud): a team Lead's first agent step spent
 * its whole 16,384-token output limit on "Let me analyze what's being asked
 * here. The mission is ...", with no tool call and no closing reasoning tag.
 * The step loop kept those 60,000 characters as the reply's words, the next
 * request was compacted, the compaction dropped the source passages, and
 * every later draft said the figures were unavailable until the run's budget
 * ran out.
 *
 * Such a reply is moved to `thinking` with empty content. It never reaches the
 * conversation as the reply's words, and `classifyUnproductiveModelResponseV1`
 * reads it as `thinking_only`: the step loop's existing remedy for a model
 * that deliberated and delivered nothing. The rule is narrow on purpose: only
 * a reply the provider cut off at its length limit, with no tool call, no
 * reasoning tag, and an opening that narrates the ask instead of answering it.
 * A long answer cut off at the limit keeps what it wrote, and a reply that
 * ended on its own is never touched.
 */

import type { ModelChatResponse } from "./types";

/** The provider's words for "stopped because the output limit was reached". */
const LENGTH_DONE_REASONS = new Set(["length", "max_tokens"]);

/** A reasoning tag means another reader splits the reply; this rule stays out of its way. */
const REASONING_TAG = /<\/?think(?:ing)?>/iu;

/** "Okay, so", "Alright," "Hmm." before the words that say what the reply is. */
const LEAD_IN = String.raw`(?:(?:okay|ok|alright|all right|so|hmm+|well)[,.!]?\s+)`;
/** First-person openings that are deliberation only after a lead-in: "Okay, let me…", not "Let me explain…". */
const AFTER_LEAD_IN = String.raw`(?:let me|let's|i'll|i will|first,? (?:i|let me|we))\b`;
/** Openings that are deliberation about the ask however they start. */
const ABOUT_THE_ASK = [
  String.raw`(?:the )?user(?:'s)? (?:asks?|asked|wants?|wanted|is asking|requests?|requested|says|said|would like|needs?|question|request|message)\b`,
  String.raw`let me (?:think|count|check|see|figure|plan|reason|work out|draft|analy[sz]e)\b`,
  String.raw`(?:(?:first,? )?(?:i|we) need to|we should|we must)\b`,
  String.raw`(?:we are|i am|i'm) (?:asked|being asked|told|given)\b`,
  String.raw`(?:the|this) (?:task|request|mission|ask) (?:is|asks|wants|says)\b`,
].join("|");
const DELIBERATION_LEAD = new RegExp(
  `^(?:${LEAD_IN}{1,2}${AFTER_LEAD_IN}|${LEAD_IN}{0,2}(?:${ABOUT_THE_ASK}))`,
  "iu",
);

/** Whether a reply opens like reasoning about the ask rather than the answer to it. */
export function readsAsDeliberationLeadV1(text: string): boolean {
  return DELIBERATION_LEAD.test(text.trimStart());
}

/** Whether this reply ran out of room while it was still deliberating. */
export function isCutDeliberationV1(response: ModelChatResponse): boolean {
  const content = response.message.content ?? "";
  return (
    LENGTH_DONE_REASONS.has(response.doneReason ?? "") &&
    response.toolCalls.length === 0 &&
    !REASONING_TAG.test(content) &&
    readsAsDeliberationLeadV1(content)
  );
}

/**
 * The reply with a cut-off deliberation moved to its thinking; the same object
 * when the rule does not apply.
 */
export function settleCutDeliberationV1(
  response: ModelChatResponse,
): ModelChatResponse {
  if (!isCutDeliberationV1(response)) return response;
  const thinking = [response.message.thinking, response.message.content]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join("\n\n");
  return { ...response, message: { ...response.message, content: "", thinking } };
}
