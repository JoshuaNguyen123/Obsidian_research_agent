/** Authenticated service identity, not remote attestation or a source version. */
export interface DocumentExtractionIdentityV1 {
  schemaVersion: 1;
  generation: string;
  loadedEngineSha256: string;
  effectiveConfigurationSha256: string;
  status: "ready" | "unavailable";
}

export function readDocumentExtractionIdentityV1(value: unknown): DocumentExtractionIdentityV1 | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || !["ready", "unavailable"].includes(String(record.status)) ||
      typeof record.generation !== "string" || !/^[a-f0-9]{32}$/u.test(record.generation) ||
      typeof record.loadedEngineSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.loadedEngineSha256) ||
      typeof record.effectiveConfigurationSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(record.effectiveConfigurationSha256)) return null;
  return { schemaVersion: 1, generation: record.generation, loadedEngineSha256: record.loadedEngineSha256,
    effectiveConfigurationSha256: record.effectiveConfigurationSha256, status: record.status as DocumentExtractionIdentityV1["status"] };
}

export function documentExtractionIdentityKeyV1(identity: DocumentExtractionIdentityV1): string {
  return JSON.stringify([identity.schemaVersion, identity.generation, identity.loadedEngineSha256,
    identity.effectiveConfigurationSha256, identity.status]);
}
