export type RetrievalCoverageMode = "exact" | "sampled" | "indexed" | "fallback";
export type RetrievalCoverageConfidence = "high" | "medium" | "low";

export interface RetrievalCoverage {
  mode: RetrievalCoverageMode;
  considered: number;
  read: number;
  skipped: number;
  truncated: boolean;
  fallbackUsed?: boolean;
  confidence: RetrievalCoverageConfidence;
  reasons: string[];
}

export function buildRetrievalCoverage({
  mode,
  considered,
  read,
  skipped,
  truncated,
  fallbackUsed = false,
  reasons = [],
}: {
  mode: RetrievalCoverageMode;
  considered: number;
  read: number;
  skipped: number;
  truncated: boolean;
  fallbackUsed?: boolean;
  reasons?: string[];
}): RetrievalCoverage {
  const confidence = getCoverageConfidence({
    considered,
    read,
    skipped,
    truncated,
    fallbackUsed,
  });

  return {
    mode,
    considered,
    read,
    skipped,
    truncated,
    fallbackUsed,
    confidence,
    reasons: reasons.length > 0 ? reasons : getDefaultCoverageReasons(confidence),
  };
}

function getCoverageConfidence({
  considered,
  read,
  skipped,
  truncated,
  fallbackUsed,
}: {
  considered: number;
  read: number;
  skipped: number;
  truncated: boolean;
  fallbackUsed: boolean;
}): RetrievalCoverageConfidence {
  if (read <= 0 || fallbackUsed || skipped > read || (truncated && read < considered / 2)) {
    return "low";
  }

  if (truncated || skipped > 0 || read < considered) {
    return "medium";
  }

  return "high";
}

function getDefaultCoverageReasons(
  confidence: RetrievalCoverageConfidence,
): string[] {
  if (confidence === "high") {
    return ["retrieval_complete_within_caps"];
  }

  if (confidence === "medium") {
    return ["retrieval_sampled_or_truncated"];
  }

  return ["retrieval_limited_or_fallback"];
}
