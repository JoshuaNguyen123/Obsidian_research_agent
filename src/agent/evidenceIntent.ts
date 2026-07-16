import type { MissionIntent } from "../tools/types";

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
    prompt,
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
  const asksForGenericSources =
    /\bsources?\b/i.test(prompt) ||
    /^\s*(?:please\s+)?(?:research|investigate)\b/i.test(prompt) ||
    /\bverify\b/i.test(prompt);
  if (!asksForGenericSources) {
    return false;
  }
  // Verification is not synonymous with public-web research. Metadata and
  // local readback requests (especially generated-output word counts) must not
  // manufacture web proof debt merely because the user said "verify".
  if (
    /\bcount_words\b|\bword\s*count\b|\bcount(?:ing)?\s+(?:the\s+)?words?\b|\bverify\s+(?:the\s+)?(?:generated\s+)?(?:note\s+)?(?:word\s+)?length\b/iu.test(
      prompt,
    )
  ) {
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
  return /https?:\/\/|\b(?:web|online|internet|citations?|cited|latest|current\s+(?:events?|information|data|news)|fact[-\s]?check(?:ed)?|verify\s+(?:sources?|facts?|claims?))\b/iu.test(
    prompt,
  );
}

/** Explicit local-only scope outranks incidental mentions such as "no web". */
export function hasExplicitNoWebIntent(prompt: string): boolean {
  return /\b(?:do\s+not|don't|never)\s+(?:use|search|browse|access|consult)\s+(?:the\s+)?(?:web|internet|online)\b|\b(?:no|without)\s+(?:public\s+)?(?:web|internet|online)(?:\s+(?:tools?|access|research|sources?))?\b|\b(?:vault|local|offline)[-\s]+only\b/iu.test(
    prompt,
  );
}
