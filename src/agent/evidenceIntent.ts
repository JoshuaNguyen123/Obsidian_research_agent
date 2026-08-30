import type { MissionIntent } from "../tools/types";
import { hasWordCountIntent } from "./wordCountIntent";

/**
 * Literary / primary-text citation: "quotes/citations from the text|novel|book".
 * This is close-reading support, not a request for public-web sources.
 */
export function hasPrimaryTextCitationIntent(prompt: string): boolean {
  return (
    /\bfrom the (?:text|novel|book|work|poem|play|story)\b/i.test(prompt) &&
    /\b(?:quote|quotes|quoted|quotation|quotations|cite|cited|citation|citations)\b/i.test(
      prompt,
    )
  );
}

function hasPublicNetworkResearchCue(prompt: string): boolean {
  return /https?:\/\/|\b(?:web|online|internet|latest|current\s+(?:events?|information|data|news)|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?)|deep\s+research)\b/iu.test(
    prompt,
  );
}

/**
 * Close-reading write missions that must not open Soft research_team, force
 * public-web tools, or gate note writeback on Soft-seeded passage conflicts.
 */
export function isLiteraryPrimaryTextWriteMission(prompt: string): boolean {
  return (
    hasPrimaryTextCitationIntent(prompt) &&
    !hasPublicNetworkResearchCue(prompt) &&
    /\b(?:write|draft|compose|generate|essay|analysis|critique|paper)\b/i.test(
      prompt,
    )
  );
}

/**
 * Vault words that name an ADDRESSING CONVENTION rather than a corpus:
 * "the exact vault-relative path Notes/Alpha.md" tells the model how to SPELL a
 * destination, it does not ask for anything to be retrieved.
 */
const VAULT_ADDRESSING_VOCABULARY =
  /\bvault[-\s]?(?:relative|rooted|absolute)\b|\bvault\s+paths?\b/giu;

/**
 * THE one seat that decides which occurrences of vault vocabulary name a
 * SEARCHABLE CORPUS rather than a way of spelling a path.
 *
 * Both vault-signal consumers (`requiresVaultEvidenceProof` here and
 * `hasDeepVaultResearchIntent` in researchPlan) matched a bare `\bvault\b`, so
 * the phrase "vault-relative path" alone made a self-contained note-editing
 * mission research-bearing. `createResearchPlan` then minted rq-1..rq-3,
 * `deriveResearchPhase` parked the run in `gather`, and the research phase gate
 * refused the very mutation the mission graph was planned around — the
 * `planned ⊄ gate-accepted` shape. The refusal was permanent, because a diagram
 * mission has no sources to fetch and gather can therefore never complete.
 *
 * Only addressing vocabulary is removed. "investigate my vault", "across my
 * notes", and "search my vault" are untouched, so every genuine vault-research
 * mission keeps its full evidence contract.
 *
 * Every consumer must call THIS function. A second private "is this word really
 * a vault signal" rule is the two-subsystems-disagree shape that produced the
 * defect — the research-mode gate and the evidence gate would once again answer
 * differently for the same prompt.
 */
export function withoutVaultAddressingVocabularyV1(prompt: string): string {
  return prompt.replace(VAULT_ADDRESSING_VOCABULARY, " ");
}

export function requiresVaultEvidenceProof(
  prompt: string,
  intent: MissionIntent,
): boolean {
  const asksForVaultContext =
    /\b(read|check|inspect|look\s+through|browse|search|find|summari[sz]e|analy[sz]e|what|where|which|related|backlinks?|graph|semantic(?:ally)?|across\s+(?:my\s+)?notes|other\s+folders?|what\s+do\s+my\s+notes\s+say|search\s+my\s+notes)\b/i.test(
      prompt,
    );
  if ((intent.explicitMutation || intent.requireWriteCompletion) && !asksForVaultContext) {
    return false;
  }

  return /\b(vault|my notes|across notes|other folders|related notes|semantic search|what do my notes say|search my notes)\b/i.test(
    withoutVaultAddressingVocabularyV1(prompt),
  );
}

export function requiresWebEvidenceProof(
  prompt: string,
  intent: MissionIntent,
): boolean {
  if (hasExplicitNoWebIntent(prompt)) {
    return false;
  }
  if (
    hasPrimaryTextCitationIntent(prompt) &&
    !hasPublicNetworkResearchCue(prompt)
  ) {
    return false;
  }
  if (
    /\b(web|online|internet|citations?|cited|fact[-\s]?check)\b|https?:\/\//i.test(
      prompt,
    )
  ) {
    return true;
  }
  // Bare "latest/current" without research/source language is note-local by
  // default; require an explicit research/web/source cue before forcing web debt.
  if (
    /\b(?:latest|current)\s+(?:events?|information|data|news)\b/i.test(prompt) &&
    /\b(research|investigate|sources?|verify|web|online|internet)\b/i.test(prompt)
  ) {
    return true;
  }
  // In code missions, "source files", "source code", and "source and test
  // files" name deliverables rather than public-web evidence. Remove only
  // those exact artifact phrases before interpreting a remaining bare
  // "source" as research intent. Explicit web/citation cues were already
  // handled above, so this cannot suppress a real public-network request.
  const promptWithoutCodeSourceArtifacts = prompt.replace(
    /\bsource(?:\s+code|\s+files?|\s+and\s+tests?\s+files?)\b/giu,
    " ",
  );
  const asksForGenericSources =
    /\bsources?\b/i.test(promptWithoutCodeSourceArtifacts) ||
    /^\s*(?:please\s+)?(?:research|investigate)\b/i.test(prompt) ||
    /\bverify\b/i.test(prompt);
  if (!asksForGenericSources) {
    return false;
  }
  // Verification is not synonymous with public-web research. Metadata and
  // local readback requests (especially generated-output word counts) must not
  // manufacture web proof debt merely because the user said "verify".
  // ONE word-count predicate, shared with the route, the loop planner and the
  // claim ledger. This was the fourth private copy: it missed "how many words
  // is this note?" -- the most natural phrasing -- so that prompt was offered
  // count_words by the route while still owing public-web proof it could never
  // pay.
  if (hasWordCountIntent(prompt)) {
    return false;
  }
  // `Sources/Alpha.md` is a vault binding, not public-web authority. A
  // vault-scoped mission needs a separate explicit web signal before this
  // contract can require external evidence.
  const explicitlyVaultScoped =
    requiresVaultEvidenceProof(prompt, intent) ||
    /(?:^|[\s"'`])[^\r\n"'`]+\/[^\r\n"'`]+\.md\b/iu.test(prompt);
  return !explicitlyVaultScoped;
}

/**
 * Signals that unambiguously require public-network evidence even when the
 * prompt also names a vault path. Generic `source`/`verify` language is
 * intentionally excluded: those words also describe local files and
 * readback verification.
 */
export function hasExplicitPublicWebSignal(prompt: string): boolean {
  if (hasExplicitNoWebIntent(prompt)) {
    return false;
  }
  // "citations from the text" is literary quotation, not public-web research.
  if (
    hasPrimaryTextCitationIntent(prompt) &&
    !hasPublicNetworkResearchCue(prompt)
  ) {
    return false;
  }
  return /https?:\/\/|\b(?:web|online|internet|citations?|cited|latest|current\s+(?:events?|information|data|news)|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?))\b/iu.test(
    prompt,
  );
}

/** Explicit local-only scope outranks incidental mentions such as "no web". */
export function hasExplicitNoWebIntent(prompt: string): boolean {
  return /\b(?:do\s+not|don't|never)\s+(?:use|search|browse|access|consult)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:do\s+not|don't|never)\b[^.!?\r\n]{0,120}\bor\s+(?:use|search|browse|access|consult)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:no|without)\s+(?:public\s+)?(?:web|internet|online)(?:\s+(?:tools?|access|research|sources?))?\b|\b(?:vault|local|offline)[-\s]+only\b/iu.test(
    prompt,
  );
}
