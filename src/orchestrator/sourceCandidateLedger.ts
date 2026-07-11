export const SOURCE_CANDIDATE_LEDGER_VERSION = 1 as const;

export type ResearchSourceType =
  | "primary"
  | "official"
  | "paper"
  | "pdf"
  | "document"
  | "news"
  | "web"
  | "vault";

export type SourceCandidateStatus =
  | "candidate"
  | "claimed"
  | "usable"
  | "unusable"
  | "rejected";

export interface SourceQualitySignals {
  /** Provider-neutral content/authority estimate in the inclusive range 0..1. */
  quality: number;
  /** Freshness estimate in the inclusive range 0..1. */
  freshness: number;
  /** Probability that the source can be fetched and parsed, in the range 0..1. */
  fetchability: number;
}

export interface SourceCandidateInput {
  id?: string;
  query: string;
  title: string;
  url?: string;
  provider?: string;
  sourceType: ResearchSourceType;
  signals: SourceQualitySignals;
  claimIds?: string[];
  publishedAt?: string;
}

export interface SourceCandidate extends SourceCandidateInput {
  id: string;
  canonicalKey: string;
  status: SourceCandidateStatus;
  score: number;
  ownerId: string | null;
  leaseExpiresAt: string | null;
  evidenceIds: string[];
  attemptedAt?: string;
  resolvedAt?: string;
  failure?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SourceProofRequirement {
  claimId: string;
  description: string;
  minUsableSources: number;
  preferredSourceTypes?: ResearchSourceType[];
}

export interface SourceCandidateLedgerV1 {
  version: typeof SOURCE_CANDIDATE_LEDGER_VERSION;
  runId: string;
  queryVariants: string[];
  candidates: Record<string, SourceCandidate>;
  canonicalCandidateIds: Record<string, string>;
  proofRequirements: SourceProofRequirement[];
  duplicateCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceProofDebtItem {
  claimId: string;
  description: string;
  required: number;
  accepted: number;
  missing: number;
  acceptedCandidateIds: string[];
  preferredTypesMissing: ResearchSourceType[];
}

export interface CandidateClaimResult {
  accepted: boolean;
  reason?: "missing" | "resolved" | "leased";
  ledger: SourceCandidateLedgerV1;
  candidate?: SourceCandidate;
}

export interface CandidateOutcome {
  status: Extract<SourceCandidateStatus, "usable" | "unusable" | "rejected">;
  evidenceIds?: string[];
  failure?: string;
}

const TYPE_AUTHORITY_SCORE: Record<ResearchSourceType, number> = {
  primary: 10,
  official: 9,
  paper: 8,
  pdf: 6,
  document: 6,
  vault: 5,
  news: 4,
  web: 2,
};

export function buildResearchQueryVariants(
  query: string,
  options: {
    preferredDomains?: string[];
    includePdf?: boolean;
    maxVariants?: number;
  } = {},
): string[] {
  const normalized = normalizeWhitespace(query);
  if (!normalized) {
    return [];
  }
  const candidates = [
    normalized,
    `${normalized} primary source`,
    `${normalized} official documentation`,
    ...(options.includePdf === false ? [] : [`${normalized} filetype:pdf`]),
    ...(options.preferredDomains ?? []).map((domain) => {
      const safeDomain = domain
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/[^a-z0-9.-].*$/, "");
      return safeDomain ? `${normalized} site:${safeDomain}` : "";
    }),
  ];
  return uniqueStrings(candidates).slice(
    0,
    clampInteger(options.maxVariants ?? 8, 1, 20),
  );
}

export function createSourceCandidateLedger(input: {
  runId: string;
  query: string;
  now?: Date;
  preferredDomains?: string[];
  proofRequirements?: SourceProofRequirement[];
}): SourceCandidateLedgerV1 {
  const now = (input.now ?? new Date()).toISOString();
  return {
    version: SOURCE_CANDIDATE_LEDGER_VERSION,
    runId: input.runId,
    queryVariants: buildResearchQueryVariants(input.query, {
      preferredDomains: input.preferredDomains,
    }),
    candidates: Object.create(null) as Record<string, SourceCandidate>,
    canonicalCandidateIds: Object.create(null) as Record<string, string>,
    proofRequirements: normalizeProofRequirements(input.proofRequirements ?? []),
    duplicateCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

export function scoreSourceCandidate(
  input: Pick<SourceCandidateInput, "signals" | "sourceType">,
): number {
  const quality = clampUnit(input.signals.quality);
  const freshness = clampUnit(input.signals.freshness);
  const fetchability = clampUnit(input.signals.fetchability);
  const score =
    quality * 45 +
    freshness * 20 +
    fetchability * 25 +
    TYPE_AUTHORITY_SCORE[input.sourceType];
  return Math.round(score * 100) / 100;
}

export function addSourceCandidate(
  ledger: SourceCandidateLedgerV1,
  input: SourceCandidateInput,
  now = new Date(),
): { ledger: SourceCandidateLedgerV1; candidate: SourceCandidate; deduplicated: boolean } {
  const canonicalKey = canonicalizeSourceCandidate(input);
  const existingId = ledger.canonicalCandidateIds[canonicalKey];
  if (existingId && ledger.candidates[existingId]) {
    const existing = ledger.candidates[existingId];
    const incomingScore = scoreSourceCandidate(input);
    const updated: SourceCandidate = {
      ...existing,
      query: existing.query || input.query,
      title:
        incomingScore > existing.score && input.title.trim()
          ? input.title.trim()
          : existing.title,
      provider: existing.provider ?? input.provider,
      publishedAt: existing.publishedAt ?? input.publishedAt,
      signals:
        incomingScore > existing.score ? normalizeSignals(input.signals) : existing.signals,
      sourceType:
        incomingScore > existing.score ? input.sourceType : existing.sourceType,
      score: Math.max(existing.score, incomingScore),
      claimIds: uniqueStrings([...(existing.claimIds ?? []), ...(input.claimIds ?? [])]),
      updatedAt: now.toISOString(),
    };
    return {
      ledger: {
        ...ledger,
        candidates: { ...ledger.candidates, [existingId]: updated },
        duplicateCount: ledger.duplicateCount + 1,
        updatedAt: now.toISOString(),
      },
      candidate: updated,
      deduplicated: true,
    };
  }

  const id = ensureUniqueCandidateId(
    input.id?.trim() || stableCandidateId(canonicalKey),
    ledger.candidates,
  );
  const created: SourceCandidate = {
    ...input,
    id,
    query: normalizeWhitespace(input.query),
    title: normalizeWhitespace(input.title),
    signals: normalizeSignals(input.signals),
    claimIds: uniqueStrings(input.claimIds ?? []),
    canonicalKey,
    status: "candidate",
    score: scoreSourceCandidate(input),
    ownerId: null,
    leaseExpiresAt: null,
    evidenceIds: [],
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    ledger: {
      ...ledger,
      candidates: { ...ledger.candidates, [created.id]: created },
      canonicalCandidateIds: {
        ...ledger.canonicalCandidateIds,
        [canonicalKey]: created.id,
      },
      updatedAt: now.toISOString(),
    },
    candidate: created,
    deduplicated: false,
  };
}

export function claimSourceCandidate(
  ledger: SourceCandidateLedgerV1,
  candidateId: string,
  ownerId: string,
  options: { now?: Date; leaseMs?: number } = {},
): CandidateClaimResult {
  const candidate = ledger.candidates[candidateId];
  if (!candidate) {
    return { accepted: false, reason: "missing", ledger };
  }
  if (candidate.status === "usable" || candidate.status === "unusable" || candidate.status === "rejected") {
    return { accepted: false, reason: "resolved", ledger, candidate };
  }
  const now = options.now ?? new Date();
  const leaseActive =
    candidate.ownerId !== null &&
    candidate.ownerId !== ownerId &&
    candidate.leaseExpiresAt !== null &&
    Date.parse(candidate.leaseExpiresAt) > now.getTime();
  if (leaseActive) {
    return { accepted: false, reason: "leased", ledger, candidate };
  }
  const leaseMs = clampInteger(options.leaseMs ?? 5 * 60_000, 1_000, 60 * 60_000);
  const updated: SourceCandidate = {
    ...candidate,
    status: "claimed",
    ownerId,
    leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    attemptedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    accepted: true,
    candidate: updated,
    ledger: {
      ...ledger,
      candidates: { ...ledger.candidates, [candidateId]: updated },
      updatedAt: now.toISOString(),
    },
  };
}

export function claimNextSourceCandidate(
  ledger: SourceCandidateLedgerV1,
  ownerId: string,
  options: { now?: Date; leaseMs?: number; claimId?: string } = {},
): CandidateClaimResult {
  const now = options.now ?? new Date();
  const ordered = Object.values(ledger.candidates)
    .filter((candidate) => {
      if (candidate.status === "usable" || candidate.status === "unusable" || candidate.status === "rejected") {
        return false;
      }
      if (options.claimId && !(candidate.claimIds ?? []).includes(options.claimId)) {
        return false;
      }
      return (
        !candidate.ownerId ||
        candidate.ownerId === ownerId ||
        !candidate.leaseExpiresAt ||
        Date.parse(candidate.leaseExpiresAt) <= now.getTime()
      );
    })
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  if (ordered.length === 0) {
    return { accepted: false, reason: "missing", ledger };
  }
  return claimSourceCandidate(ledger, ordered[0].id, ownerId, {
    now,
    leaseMs: options.leaseMs,
  });
}

export function recordSourceCandidateOutcome(
  ledger: SourceCandidateLedgerV1,
  candidateId: string,
  outcome: CandidateOutcome,
  now = new Date(),
): SourceCandidateLedgerV1 {
  const candidate = ledger.candidates[candidateId];
  if (!candidate) {
    return ledger;
  }
  const updated: SourceCandidate = {
    ...candidate,
    status: outcome.status,
    evidenceIds:
      outcome.status === "usable"
        ? uniqueStrings([...(candidate.evidenceIds ?? []), ...(outcome.evidenceIds ?? [])])
        : [],
    failure:
      outcome.status === "usable"
        ? undefined
        : normalizeWhitespace(outcome.failure ?? "Source did not satisfy the proof contract."),
    ownerId: null,
    leaseExpiresAt: null,
    resolvedAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  return {
    ...ledger,
    candidates: { ...ledger.candidates, [candidateId]: updated },
    updatedAt: now.toISOString(),
  };
}

export function computeSourceProofDebt(
  ledger: SourceCandidateLedgerV1,
): SourceProofDebtItem[] {
  return ledger.proofRequirements
    .map((requirement) => {
      const accepted = Object.values(ledger.candidates)
        .filter(
          (candidate) =>
            candidate.status === "usable" &&
            (candidate.claimIds ?? []).includes(requirement.claimId) &&
            candidate.evidenceIds.length > 0,
        )
        .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
      const acceptedTypes = new Set(accepted.map((candidate) => candidate.sourceType));
      return {
        claimId: requirement.claimId,
        description: requirement.description,
        required: requirement.minUsableSources,
        accepted: accepted.length,
        missing: Math.max(0, requirement.minUsableSources - accepted.length),
        acceptedCandidateIds: accepted.map((candidate) => candidate.id),
        preferredTypesMissing: (requirement.preferredSourceTypes ?? []).filter(
          (sourceType) => !acceptedTypes.has(sourceType),
        ),
      };
    })
    .filter((item) => item.missing > 0 || item.preferredTypesMissing.length > 0);
}

export function canonicalizeSourceCandidate(
  input: Pick<SourceCandidateInput, "url" | "title" | "provider">,
): string {
  if (input.url?.trim()) {
    try {
      const url = new URL(input.url.trim());
      url.hash = "";
      url.hostname = url.hostname.toLowerCase();
      for (const key of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$|mc_)/i.test(key)) {
          url.searchParams.delete(key);
        }
      }
      url.searchParams.sort();
      if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
        url.port = "";
      }
      url.pathname = url.pathname.replace(/\/{2,}/g, "/").replace(/\/$/, "") || "/";
      return `url:${url.toString()}`;
    } catch {
      // Provider-neutral results sometimes supply non-URL identifiers.
    }
  }
  return `title:${normalizeWhitespace(input.provider ?? "unknown").toLowerCase()}:${normalizeWhitespace(input.title).toLowerCase()}`;
}

function normalizeProofRequirements(
  requirements: SourceProofRequirement[],
): SourceProofRequirement[] {
  const seen = new Set<string>();
  const normalized: SourceProofRequirement[] = [];
  for (const requirement of requirements) {
    const claimId = requirement.claimId.trim();
    if (!claimId || seen.has(claimId)) continue;
    seen.add(claimId);
    normalized.push({
      claimId,
      description: normalizeWhitespace(requirement.description),
      minUsableSources: clampInteger(requirement.minUsableSources, 1, 20),
      preferredSourceTypes: Array.from(new Set(requirement.preferredSourceTypes ?? [])),
    });
  }
  return normalized;
}

function normalizeSignals(signals: SourceQualitySignals): SourceQualitySignals {
  return {
    quality: clampUnit(signals.quality),
    freshness: clampUnit(signals.freshness),
    fetchability: clampUnit(signals.fetchability),
  };
}

function stableCandidateId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `source-${(hash >>> 0).toString(36)}`;
}

function ensureUniqueCandidateId(
  preferred: string,
  candidates: Record<string, SourceCandidate>,
): string {
  const safe = preferred.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 120) || "source";
  if (!candidates[safe]) return safe;
  let suffix = 2;
  while (candidates[`${safe}-${suffix}`]) suffix += 1;
  return `${safe}-${suffix}`;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = normalizeWhitespace(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function clampUnit(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value)
    ? Math.max(minimum, Math.min(maximum, Math.trunc(value)))
    : minimum;
}
