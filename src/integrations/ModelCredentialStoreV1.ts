import type {
  SecretDescriptionV1,
  SecretStoreV1,
} from "../../packages/core-api/src/secretStoreV1";
import { isObsidianSecretReferenceV1 } from "./ObsidianSecretStoreV1";

export interface ModelCredentialReferencesV1 {
  version: 1;
  ollama: SecretDescriptionV1 | null;
  openAiCompatible: SecretDescriptionV1 | null;
}

export interface ModelCredentialValuesV1 {
  ollama: string;
  openAiCompatible: string;
}

type ProviderKey = keyof ModelCredentialValuesV1;

const PROVIDER_METADATA: Record<ProviderKey, "ollama" | "openai_compatible"> = {
  ollama: "ollama",
  openAiCompatible: "openai_compatible",
};

export class ModelCredentialStoreV1 {
  private references: ModelCredentialReferencesV1 = emptyModelCredentialReferencesV1();
  /** Null means an opaque reference exists but could not be leased this session. */
  private readonly knownDigests: Record<ProviderKey, string | null> = {
    ollama: "",
    openAiCompatible: "",
  };

  constructor(private readonly store: SecretStoreV1) {}

  async load(
    rawReferences: unknown,
    legacy: Partial<ModelCredentialValuesV1>,
  ): Promise<{ values: ModelCredentialValuesV1; migrated: boolean }> {
    this.references = parseModelCredentialReferencesV1(rawReferences);
    const values: ModelCredentialValuesV1 = { ollama: "", openAiCompatible: "" };
    let migrated = false;
    for (const provider of providerKeys()) {
      const reference = this.references[provider];
      if (reference) {
        try {
          const value = await this.leaseVerified(reference);
          values[provider] = value;
          this.knownDigests[provider] = await secretDigest(value);
          continue;
        } catch {
          this.knownDigests[provider] = null;
          continue;
        }
      }
      const legacyValue = normalizeSecret(legacy[provider]);
      if (!legacyValue) continue;
      values[provider] = legacyValue;
      try {
        this.references[provider] = await this.putVerified(provider, legacyValue);
        this.knownDigests[provider] = await secretDigest(legacyValue);
        migrated = true;
      } catch {
        // Keep the credential session-only. The persistence projection still
        // strips the legacy plaintext on the next save.
        this.knownDigests[provider] = await secretDigest(legacyValue);
      }
    }
    return { values, migrated };
  }

  async synchronize(values: ModelCredentialValuesV1): Promise<string[]> {
    const retired: string[] = [];
    for (const provider of providerKeys()) {
      const value = normalizeSecret(values[provider]);
      const reference = this.references[provider];
      const knownDigest = this.knownDigests[provider];
      if (reference && knownDigest === null && !value) continue;
      const digest = value ? await secretDigest(value) : "";
      if (reference && knownDigest === digest) continue;
      if (!reference && knownDigest === digest) continue;
      if (!reference && !value) continue;
      if (!value) {
        if (reference) retired.push(reference.referenceId);
        this.references[provider] = null;
        this.knownDigests[provider] = "";
        continue;
      }
      const replacement = await this.putVerified(provider, value);
      if (reference) retired.push(reference.referenceId);
      this.references[provider] = replacement;
      this.knownDigests[provider] = digest;
    }
    return retired;
  }

  snapshot(): ModelCredentialReferencesV1 {
    return {
      version: 1,
      ollama: cloneDescription(this.references.ollama),
      openAiCompatible: cloneDescription(this.references.openAiCompatible),
    };
  }

  async removeRetired(referenceIds: readonly string[]): Promise<void> {
    for (const referenceId of [...new Set(referenceIds)]) {
      await this.store.remove(referenceId).catch(() => false);
    }
  }

  toJSON(): ModelCredentialReferencesV1 {
    return this.snapshot();
  }

  private async putVerified(
    provider: ProviderKey,
    value: string,
  ): Promise<SecretDescriptionV1> {
    const health = await this.store.health();
    if (!health.available || !health.persistent) {
      throw new Error("Persistent secure model credential storage is unavailable.");
    }
    const description = await this.store.put({
      value,
      label: `${PROVIDER_METADATA[provider]} model API credential`,
      metadata: {
        provider: PROVIDER_METADATA[provider],
        credentialKind: "model_api_key",
        scope: "foreground_model_requests",
      },
    });
    const readback = await this.store.describe(description.referenceId);
    if (
      readback.referenceId !== description.referenceId ||
      readback.backend !== description.backend ||
      readback.persistent !== true
    ) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Secure model credential metadata readback failed.");
    }
    const leased = await this.leaseVerified(readback);
    if (leased !== value) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Secure model credential value readback failed.");
    }
    return readback;
  }

  private async leaseVerified(reference: SecretDescriptionV1): Promise<string> {
    const lease = await this.store.lease(reference.referenceId, { ttlSeconds: 30 });
    try {
      return await lease.withSecret(async (value) => {
        const normalized = normalizeSecret(value);
        if (!normalized) throw new Error("Secure model credential is empty.");
        return normalized;
      });
    } finally {
      lease.dispose();
    }
  }
}

export function emptyModelCredentialReferencesV1(): ModelCredentialReferencesV1 {
  return { version: 1, ollama: null, openAiCompatible: null };
}

export function parseModelCredentialReferencesV1(
  value: unknown,
): ModelCredentialReferencesV1 {
  if (!isRecord(value) || value.version !== 1) {
    return emptyModelCredentialReferencesV1();
  }
  return {
    version: 1,
    ollama: parseDescription(value.ollama, "ollama"),
    openAiCompatible: parseDescription(
      value.openAiCompatible,
      "openai_compatible",
    ),
  };
}

function parseDescription(
  value: unknown,
  provider: "ollama" | "openai_compatible",
): SecretDescriptionV1 | null {
  if (!isRecord(value) || !isRecord(value.metadata)) return null;
  const referenceId = value.referenceId;
  if (
    value.version !== 1 ||
    typeof referenceId !== "string" ||
    !isObsidianSecretReferenceV1(referenceId) ||
    value.backend !== "obsidian-secret-storage" ||
    value.persistent !== true ||
    value.metadata.provider !== provider ||
    value.metadata.credentialKind !== "model_api_key" ||
    typeof value.label !== "string" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  return {
    version: 1,
    referenceId,
    label: value.label,
    metadata: {
      provider,
      credentialKind: "model_api_key",
      ...(typeof value.metadata.scope === "string"
        ? { scope: value.metadata.scope }
        : {}),
    },
    backend: "obsidian-secret-storage",
    persistent: true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function cloneDescription(
  value: SecretDescriptionV1 | null,
): SecretDescriptionV1 | null {
  return value ? { ...value, metadata: { ...value.metadata } } : null;
}

function providerKeys(): ProviderKey[] {
  return ["ollama", "openAiCompatible"];
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function secretDigest(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable for credential comparison.");
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
