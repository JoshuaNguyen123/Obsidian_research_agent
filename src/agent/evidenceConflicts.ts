/**
 * Passage-based evidence conflict detection (S8 / A2).
 *
 * claimLedger is not required: claimIds stay empty unless callers attach them.
 * Detection is high-precision and deterministic (negation polarity + numeric
 * disagreement) and always requires two distinct passage ids.
 */

export type EvidenceConflictStatus =
  | "open"
  | "resolved"
  | "acknowledged_limitation";

export interface EvidenceConflict {
  id: string;
  claimIds: string[];
  passageIds: string[];
  status: EvidenceConflictStatus;
  resolutionNote?: string;
}

/** Passage text input for conflict detection; claimIds reserved for claimLedger. */
export interface ConflictPassageInput {
  id: string;
  text: string;
  claimIds?: string[];
}

export interface EvidenceConflictAcceptanceFinding {
  missing: string[];
  reasons: string[];
  openConflictIds: string[];
}

const NEGATION_MARKERS =
  /\b(?:not|no|never|neither|nor|false|incorrect|untrue|denied|denies|refutes?|contradicts?|disproves?|unlikely|impossible|absent|lacking|without|fails?\s+to|did\s+not|does\s+not|do\s+not|cannot|can't|won't|isn't|aren't|wasn't|weren't)\b/i;

const STOP_TERMS = new Set([
  "about",
  "after",
  "also",
  "been",
  "before",
  "being",
  "could",
  "from",
  "have",
  "into",
  "more",
  "most",
  "other",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "using",
  "with",
  "would",
  "were",
  "when",
  "where",
  "which",
  "while",
  "study",
  "report",
  "source",
  "sources",
  "evidence",
  "according",
  "found",
  "shows",
  "showed",
  "said",
]);

/**
 * Detect open conflicts between passages with opposing polarity or numeric
 * disagreement on shared claim terms. Always emits dual passageIds.
 */
export function detectEvidenceConflicts(
  passages: ConflictPassageInput[],
): EvidenceConflict[] {
  const usable = passages
    .map((passage) => ({
      id: passage.id.trim(),
      text: passage.text.replace(/\s+/g, " ").trim(),
      claimIds: dedupe((passage.claimIds ?? []).filter(Boolean)),
    }))
    .filter((passage) => passage.id.length > 0 && passage.text.length >= 12);

  const conflicts: EvidenceConflict[] = [];
  const seenPairs = new Set<string>();

  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const left = usable[i];
      const right = usable[j];
      if (left.id === right.id) {
        continue;
      }
      const pairKey = [left.id, right.id].sort().join("|");
      if (seenPairs.has(pairKey)) {
        continue;
      }

      const sharedTerms = getSharedClaimTerms(left.text, right.text);
      if (sharedTerms.length < 2) {
        continue;
      }

      const polarityConflict = hasOpposingPolarity(left.text, right.text, sharedTerms);
      const numericConflict = hasNumericDisagreement(left.text, right.text, sharedTerms);
      if (!polarityConflict && !numericConflict) {
        continue;
      }

      seenPairs.add(pairKey);
      const claimIds = dedupe([...left.claimIds, ...right.claimIds]);
      const reason = polarityConflict ? "negation_polarity" : "numeric_disagreement";
      conflicts.push({
        id: `conflict:${hashKey(`${pairKey}:${reason}:${sharedTerms.slice(0, 4).join(",")}`)}`,
        claimIds,
        passageIds: [left.id, right.id].sort(),
        status: "open",
      });
    }
  }

  return conflicts;
}

export function acknowledgeEvidenceConflict(
  conflict: EvidenceConflict,
  resolutionNote: string,
): EvidenceConflict {
  const note = resolutionNote.trim();
  return {
    ...conflict,
    status: "acknowledged_limitation",
    ...(note ? { resolutionNote: note } : {}),
  };
}

export function resolveEvidenceConflict(
  conflict: EvidenceConflict,
  resolutionNote: string,
): EvidenceConflict {
  const note = resolutionNote.trim();
  return {
    ...conflict,
    status: "resolved",
    ...(note ? { resolutionNote: note } : {}),
  };
}

/**
 * Open conflicts block acceptance. acknowledged_limitation passes only when
 * final output includes explicit limitation language (and the resolution note
 * when one was recorded).
 */
export function evaluateEvidenceConflictAcceptance({
  conflicts,
  finalOutput,
}: {
  conflicts: EvidenceConflict[] | null | undefined;
  finalOutput?: string;
}): EvidenceConflictAcceptanceFinding {
  if (!conflicts || conflicts.length === 0) {
    return { missing: [], reasons: [], openConflictIds: [] };
  }

  const missing: string[] = [];
  const reasons: string[] = [];
  const openConflictIds = conflicts
    .filter((item) => item.status === "open")
    .map((item) => item.id);

  if (openConflictIds.length > 0) {
    missing.push(`open_evidence_conflicts:${openConflictIds.join(",")}`);
    reasons.push("open_evidence_conflicts");
  }

  if (finalOutput !== undefined) {
    const output = finalOutput.trim();
    const hasLimitationLanguage =
      /\blimitations?\b|\bopen questions?\b|\bunanswered\b|\buncertainty\b|\bconflicting\b|\bcontradict/i.test(
        output,
      );
    for (const conflict of conflicts.filter(
      (item) => item.status === "acknowledged_limitation",
    )) {
      if (!hasLimitationLanguage) {
        missing.push(`conflict_limitation_text:${conflict.id}`);
        reasons.push("acknowledged_conflict_missing_limitation_text");
      }
    }
  }

  return {
    missing: [...new Set(missing)],
    reasons: [...new Set(reasons)],
    openConflictIds,
  };
}

export function normalizeEvidenceConflict(
  value: unknown,
): EvidenceConflict | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const id = getString(value.id);
  const status = getConflictStatus(value.status);
  const passageIds = getStringArray(value.passageIds);
  if (!id || !status || passageIds.length < 2) {
    return undefined;
  }
  return {
    id,
    claimIds: getStringArray(value.claimIds),
    passageIds: dedupe(passageIds),
    status,
    ...(getString(value.resolutionNote)
      ? { resolutionNote: getString(value.resolutionNote) }
      : {}),
  };
}

export function normalizeEvidenceConflicts(
  value: unknown,
): EvidenceConflict[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeEvidenceConflict)
    .filter((item): item is EvidenceConflict => Boolean(item));
}

export function listOpenEvidenceConflicts(
  conflicts: EvidenceConflict[] | null | undefined,
): EvidenceConflict[] {
  return (conflicts ?? []).filter((item) => item.status === "open");
}

/** Compact rows for proof-debt / resume / Run Details. */
export function evidenceConflictsToProofDebtRows(
  conflicts: EvidenceConflict[] | null | undefined,
): Array<{ id: string; status: EvidenceConflictStatus; summary: string }> {
  return listOpenEvidenceConflicts(conflicts).map((conflict) => ({
    id: conflict.id,
    status: conflict.status,
    summary: `Open conflict ${conflict.id} between ${conflict.passageIds.join(" vs ")}`,
  }));
}

/**
 * Merge freshly detected conflicts with prior durable state, preserving
 * resolved / acknowledged_limitation statuses for the same conflict id.
 */
export function mergeEvidenceConflicts(
  previous: EvidenceConflict[] | null | undefined,
  detected: EvidenceConflict[],
): EvidenceConflict[] {
  const priorById = new Map((previous ?? []).map((item) => [item.id, item]));
  const merged = detected.map((item) => {
    const prior = priorById.get(item.id);
    if (!prior) {
      return item;
    }
    if (prior.status === "resolved" || prior.status === "acknowledged_limitation") {
      return {
        ...item,
        status: prior.status,
        ...(prior.resolutionNote ? { resolutionNote: prior.resolutionNote } : {}),
        claimIds: dedupe([...prior.claimIds, ...item.claimIds]),
      };
    }
    return {
      ...item,
      claimIds: dedupe([...prior.claimIds, ...item.claimIds]),
    };
  });
  // Keep prior resolved/acknowledged conflicts that detection no longer emits.
  for (const prior of previous ?? []) {
    if (
      (prior.status === "resolved" || prior.status === "acknowledged_limitation") &&
      !merged.some((item) => item.id === prior.id)
    ) {
      merged.push(prior);
    }
  }
  return merged;
}

function hasOpposingPolarity(
  leftText: string,
  rightText: string,
  sharedTerms: string[],
): boolean {
  const leftNeg = hasNegationNearTerms(leftText, sharedTerms);
  const rightNeg = hasNegationNearTerms(rightText, sharedTerms);
  return leftNeg !== rightNeg;
}

function hasNegationNearTerms(text: string, terms: string[]): boolean {
  const lower = text.toLowerCase();
  if (!NEGATION_MARKERS.test(text)) {
    return false;
  }
  // Require at least one shared term to appear near a negation window.
  const windows = [...text.matchAll(
    /(?:not|no|never|neither|nor|false|incorrect|denied|refutes?|contradicts?|disproves?|without|lacking|fails?\s+to|does\s+not|do\s+not|did\s+not|cannot|can't)[\s\S]{0,48}/gi,
  )];
  if (windows.length === 0) {
    return NEGATION_MARKERS.test(text) && terms.some((term) => lower.includes(term));
  }
  return windows.some((match) => {
    const window = match[0].toLowerCase();
    return terms.some((term) => window.includes(term));
  });
}

function hasNumericDisagreement(
  leftText: string,
  rightText: string,
  sharedTerms: string[],
): boolean {
  const leftNums = extractContextualNumbers(leftText, sharedTerms);
  const rightNums = extractContextualNumbers(rightText, sharedTerms);
  if (leftNums.length === 0 || rightNums.length === 0) {
    return false;
  }
  for (const left of leftNums) {
    for (const right of rightNums) {
      if (left.contextKey !== right.contextKey) {
        continue;
      }
      if (numbersDisagree(left.value, right.value)) {
        return true;
      }
    }
  }
  return false;
}

const QUANTITY_CUES =
  /\b(?:percent|pct|rate|rates|efficiency|ratio|score|dose|concentration|temperature|celsius|fahrenheit|years?|months?|weeks?|days?|hours?|minutes?|patients?|samples?|participants?|subjects?|trials?|studies|mg|kg|km|ms|ghz|mhz)\b|%/i;

const INDEX_PREFIX =
  /\b(?:note|page|section|chapter|item|file|scaled|line|step|index|id|#)\s*$/i;

function extractContextualNumbers(
  text: string,
  sharedTerms: string[],
): Array<{ value: number; contextKey: string }> {
  const results: Array<{ value: number; contextKey: string }> = [];
  const pattern =
    /(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)(%|x|×|k|m|b|million|billion|percent)?(?![A-Za-z0-9.])/gi;
  for (const match of text.matchAll(pattern)) {
    const raw = match[1];
    const unit = (match[2] ?? "").toLowerCase();
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      continue;
    }
    const index = match.index ?? 0;
    const before = text.slice(Math.max(0, index - 16), index);
    // Ignore note/page/section indices ("note 42", "scaled 003") so similar
    // vault snippets do not look like numeric claim disagreements.
    if (INDEX_PREFIX.test(before)) {
      continue;
    }
    const window = text
      .slice(Math.max(0, index - 40), Math.min(text.length, index + String(match[0]).length + 40))
      .toLowerCase();
    const nearbyShared = sharedTerms.filter((term) => window.includes(term));
    if (nearbyShared.length === 0) {
      continue;
    }
    // High precision: bare integers need an explicit unit or quantity cue.
    if (!unit && !QUANTITY_CUES.test(window)) {
      continue;
    }
    const scaled =
      unit === "k"
        ? value * 1_000
        : unit === "m" || unit === "million"
          ? value * 1_000_000
          : unit === "b" || unit === "billion"
            ? value * 1_000_000_000
            : value;
    results.push({
      value: scaled,
      contextKey: `${nearbyShared.slice(0, 3).sort().join("|")}|${unit === "%" || unit === "percent" ? "pct" : "num"}`,
    });
  }
  return results;
}

function numbersDisagree(left: number, right: number): boolean {
  if (left === right) {
    return false;
  }
  const max = Math.max(Math.abs(left), Math.abs(right), 1);
  // High precision: require clear relative gap (>15%) or absolute gap for small ints.
  if (max <= 20) {
    return Math.abs(left - right) >= 1;
  }
  return Math.abs(left - right) / max >= 0.15;
}

function getSharedClaimTerms(left: string, right: string): string[] {
  const leftTerms = new Set(tokenize(left));
  const rightTerms = tokenize(right);
  return dedupe(rightTerms.filter((term) => leftTerms.has(term))).slice(0, 12);
}

function tokenize(value: string): string[] {
  return dedupe(
    (value.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
      (term) => !STOP_TERMS.has(term) && !NEGATION_MARKERS.test(term),
    ),
  );
}

function getConflictStatus(value: unknown): EvidenceConflictStatus | null {
  return value === "open" ||
    value === "resolved" ||
    value === "acknowledged_limitation"
    ? value
    : null;
}

function hashKey(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}
