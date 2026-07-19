import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import type {
  ResearchMemoryIndexEntry,
  ResearchMemoryRecordV2,
  ResearchMemorySourceLabelV2,
} from "../tools/types";

const VAULT_SCOPE_PATTERN = /^vault_[a-f0-9]{64}$/;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/;

export function isVaultScopeId(value: unknown): value is string {
  return typeof value === "string" && VAULT_SCOPE_PATTERN.test(value);
}

export function ensureVaultScopeId(value: unknown): string {
  if (isVaultScopeId(value)) return value;
  const random = globalThis.crypto?.randomUUID?.() ??
    `${Date.now()}:${Math.random()}:${Math.random()}`;
  return `vault_${portableSha256Text(random)}`;
}

export function migrateResearchMemoryIndexV2(
  entries: ResearchMemoryIndexEntry[],
  vaultScopeId: string,
  observedAt = new Date().toISOString(),
): ResearchMemoryRecordV2[] {
  if (!isVaultScopeId(vaultScopeId)) {
    throw new Error("Research memory migration requires a valid vault scope.");
  }
  return entries.slice(0, 200).map((entry) => {
    const isCurrentV2Record =
      entry.version === 2 &&
      entry.vaultScopeId === vaultScopeId &&
      typeof entry.id === "string" &&
      /^research_memory_[a-f0-9]{24}$/.test(entry.id);
    const sourceLabels = normalizeSourceLabels(entry);
    const core = {
      version: 2 as const,
      id: stableRecordId(entry, vaultScopeId),
      vaultScopeId,
      origin: "vault_local" as const,
      topic: entry.topic,
      path: entry.path,
      keywords: [...entry.keywords],
      confidence: entry.confidence,
      sourcePaths: entry.sourcePaths ? [...entry.sourcePaths] : undefined,
      sourceUrls: entry.sourceUrls ? [...entry.sourceUrls] : undefined,
      contentHash: entry.contentHash,
      updateCount: entry.updateCount,
      targetId: entry.targetId,
      // Legacy entries are useful source-note pointers, not verified authority.
      // Only an already-valid V2 record in this exact vault may retain its
      // verification lifecycle during normalization/readback.
      verificationState: isCurrentV2Record
        ? normalizeVerification(entry.verificationState)
        : "unverified" as const,
      verifiedAt: isCurrentV2Record ? entry.verifiedAt : undefined,
      staleAt: isCurrentV2Record ? entry.staleAt : undefined,
      supersededAt: isCurrentV2Record ? entry.supersededAt : undefined,
      supersededById: isCurrentV2Record ? entry.supersededById : undefined,
      sourceHashes: entry.sourceHashes ? { ...entry.sourceHashes } : undefined,
      sourceLabels,
    };
    const fingerprint = fingerprintResearchMemoryCore(core);
    return {
      ...core,
      lastUpdated: entry.lastUpdated,
      createdAt: isIsoTimestamp(entry.createdAt) ? entry.createdAt! : observedAt,
      fingerprint,
    };
  });
}

export function isResearchMemoryRecordV2(
  value: ResearchMemoryIndexEntry,
  vaultScopeId: string,
): value is ResearchMemoryRecordV2 {
  if (
    value.version !== 2 ||
    value.vaultScopeId !== vaultScopeId ||
    typeof value.id !== "string" ||
    !value.id.startsWith("research_memory_") ||
    !Array.isArray(value.sourceLabels) ||
    !isIsoTimestamp(value.createdAt) ||
    typeof value.fingerprint !== "string" ||
    !FINGERPRINT_PATTERN.test(value.fingerprint)
  ) {
    return false;
  }
  const [migrated] = migrateResearchMemoryIndexV2([value], vaultScopeId, value.createdAt);
  return migrated.fingerprint === value.fingerprint;
}

function stableRecordId(entry: ResearchMemoryIndexEntry, vaultScopeId: string): string {
  if (
    entry.version === 2 &&
    entry.vaultScopeId === vaultScopeId &&
    typeof entry.id === "string" &&
    /^research_memory_[a-f0-9]{24}$/.test(entry.id)
  ) {
    return entry.id;
  }
  const digest = portableSha256Text(canonicalJson({
    vaultScopeId,
    path: entry.path,
    topic: entry.topic.trim().toLowerCase(),
  }));
  return `research_memory_${digest.slice(0, 24)}`;
}

function normalizeSourceLabels(entry: ResearchMemoryIndexEntry): ResearchMemorySourceLabelV2[] {
  const labels: ResearchMemorySourceLabelV2[] = [];
  const seen = new Set<string>();
  const add = (label: ResearchMemorySourceLabelV2) => {
    const key = `${label.kind}:${label.reference}`;
    if (!seen.has(key)) {
      seen.add(key);
      labels.push(label);
    }
  };
  for (const label of entry.sourceLabels ?? []) {
    if (
      (label.kind === "note" || label.kind === "public_url" || label.kind === "receipt") &&
      typeof label.reference === "string" &&
      label.reference.trim()
    ) {
      add({ kind: label.kind, reference: label.reference.trim(), label: label.label?.trim() || undefined });
    }
  }
  add({ kind: "note", reference: entry.path, label: "research memory note" });
  for (const path of entry.sourcePaths ?? []) add({ kind: "note", reference: path });
  for (const url of entry.sourceUrls ?? []) add({ kind: "public_url", reference: url });
  return labels.slice(0, 100);
}

function normalizeVerification(
  value: ResearchMemoryIndexEntry["verificationState"],
): ResearchMemoryRecordV2["verificationState"] {
  return value === "verified" || value === "stale" || value === "superseded"
    ? value
    : "unverified";
}

function fingerprintOf(value: unknown): string {
  // Canonical contracts omit absent optional fields rather than serializing
  // JavaScript's non-JSON `undefined` value.
  const jsonValue = JSON.parse(JSON.stringify(value)) as unknown;
  return `sha256:${portableSha256Text(canonicalJson(jsonValue))}`;
}

function fingerprintResearchMemoryCore(
  value: Record<string, unknown>,
): string {
  // Verification times are observations, not record identity. Excluding them
  // keeps retry/migration idempotency stable while verificationState and the
  // actual source/content fields remain authoritative.
  const {
    verifiedAt: _verifiedAt,
    staleAt: _staleAt,
    supersededAt: _supersededAt,
    ...stable
  } = value;
  return fingerprintOf(stable);
}

function isIsoTimestamp(value: unknown): value is string {
  return typeof value === "string" && Boolean(value) && Number.isFinite(Date.parse(value));
}
