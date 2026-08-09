import type {
  SecretDescriptionV1,
  SecretStoreV1,
} from "../../packages/core-api/src/secretStoreV1";
import { isObsidianSecretReferenceV1 } from "./ObsidianSecretStoreV1";
import type { ModelProvider } from "../model/types";
import { normalizeSecureProviderBaseUrlV1 } from "../model/providerEndpointPolicy";

export interface SpecialistCredentialBindingV1 {
  provider: ModelProvider;
  endpointBaseUrl: string;
}

export interface ModelCredentialReferencesV1 {
  version: 1;
  ollama: SecretDescriptionV1 | null;
  openAiCompatible: SecretDescriptionV1 | null;
  specialist: SecretDescriptionV1 | null;
}

export interface ModelCredentialValuesV1 {
  ollama: string;
  openAiCompatible: string;
  specialist: string;
}

type CredentialKey = keyof ModelCredentialValuesV1;

const CREDENTIAL_METADATA: Record<
  CredentialKey,
  {
    label: string;
    provider?: "ollama" | "openai_compatible";
    agentSlot: "lead" | "specialist";
    scope: string;
  }
> = {
  ollama: {
    label: "ollama",
    provider: "ollama",
    agentSlot: "lead",
    scope: "lead_model_requests",
  },
  openAiCompatible: {
    label: "openai_compatible",
    provider: "openai_compatible",
    agentSlot: "lead",
    scope: "lead_model_requests",
  },
  specialist: {
    label: "specialist",
    agentSlot: "specialist",
    scope: "specialist_model_requests",
  },
};

export class ModelCredentialStoreV1 {
  private references: ModelCredentialReferencesV1 = emptyModelCredentialReferencesV1();
  /** Null means an opaque reference exists but could not be leased this session. */
  private readonly knownDigests: Record<CredentialKey, string | null> = {
    ollama: "",
    openAiCompatible: "",
    specialist: "",
  };
  /** Undefined preserves compatibility for non-production unit callers. */
  private specialistBinding: SpecialistCredentialBindingV1 | null | undefined;

  constructor(private readonly store: SecretStoreV1) {}

  async load(
    rawReferences: unknown,
    legacy: Partial<ModelCredentialValuesV1>,
    specialistBinding?: SpecialistCredentialBindingV1 | null,
  ): Promise<{ values: ModelCredentialValuesV1; migrated: boolean }> {
    this.specialistBinding = normalizeSpecialistCredentialBindingV1(
      specialistBinding,
    );
    this.references = parseModelCredentialReferencesV1(rawReferences);
    const values: ModelCredentialValuesV1 = {
      ollama: "",
      openAiCompatible: "",
      specialist: "",
    };
    let migrated = false;
    for (const provider of providerKeys()) {
      const reference = this.references[provider];
      if (reference) {
        try {
          const readback = await this.store.describe(reference.referenceId);
          const verifiedReference = parseDescription(readback, provider);
          if (
            !verifiedReference ||
            verifiedReference.referenceId !== reference.referenceId
          ) {
            throw new Error("Secure model credential slot binding failed.");
          }
          if (
            provider === "specialist" &&
            this.specialistBinding !== undefined &&
            !specialistReferenceMatchesBindingV1(
              verifiedReference,
              this.specialistBinding,
            )
          ) {
            this.references.specialist = null;
            this.knownDigests.specialist = "";
            await this.store.remove(reference.referenceId).catch(() => false);
            migrated = true;
            continue;
          }
          this.references[provider] = verifiedReference;
          const value = await this.leaseVerified(verifiedReference);
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
      if (provider === "specialist" && this.specialistBinding === null) {
        migrated = true;
        continue;
      }
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

  async synchronize(
    values: ModelCredentialValuesV1,
    specialistBinding?: SpecialistCredentialBindingV1 | null,
  ): Promise<string[]> {
    if (specialistBinding !== undefined) {
      this.specialistBinding = normalizeSpecialistCredentialBindingV1(
        specialistBinding,
      );
    }
    const retired: string[] = [];
    for (const provider of providerKeys()) {
      const value = normalizeSecret(values[provider]);
      let reference = this.references[provider];
      if (
        provider === "specialist" &&
        reference &&
        this.specialistBinding !== undefined &&
        !specialistReferenceMatchesBindingV1(reference, this.specialistBinding)
      ) {
        retired.push(reference.referenceId);
        this.references.specialist = null;
        this.knownDigests.specialist = "";
        reference = null;
        if (value) {
          await this.store.remove(retired.at(-1)!).catch(() => false);
          throw new Error(
            "Specialist provider destination changed. Re-enter the dedicated Agent 2 credential for the new endpoint.",
          );
        }
      }
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
      specialist: cloneDescription(this.references.specialist),
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
    credential: CredentialKey,
    value: string,
  ): Promise<SecretDescriptionV1> {
    const descriptor = CREDENTIAL_METADATA[credential];
    if (credential === "specialist" && this.specialistBinding === null) {
      throw new Error(
        "A Specialist credential cannot be stored without a separate provider destination.",
      );
    }
    const health = await this.store.health();
    if (!health.available || !health.persistent) {
      throw new Error("Persistent secure model credential storage is unavailable.");
    }
    const description = await this.store.put({
      value,
      label: `${descriptor.label} model API credential`,
      metadata: {
        ...(descriptor.provider ? { provider: descriptor.provider } : {}),
        ...(credential === "specialist" && this.specialistBinding
          ? {
              provider: this.specialistBinding.provider,
              endpoint: this.specialistBinding.endpointBaseUrl,
            }
          : {}),
        actor: descriptor.agentSlot,
        credentialKind: "model_api_key",
        scope: descriptor.scope,
      },
    });
    const readback = await this.store.describe(description.referenceId);
    const verifiedReadback = parseDescription(readback, credential);
    if (
      !verifiedReadback ||
      verifiedReadback.referenceId !== description.referenceId ||
      (credential === "specialist" &&
        this.specialistBinding !== undefined &&
        !specialistReferenceMatchesBindingV1(
          verifiedReadback,
          this.specialistBinding,
        ))
    ) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Secure model credential metadata readback failed.");
    }
    const leased = await this.leaseVerified(verifiedReadback);
    if (leased !== value) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Secure model credential value readback failed.");
    }
    return verifiedReadback;
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
  return {
    version: 1,
    ollama: null,
    openAiCompatible: null,
    specialist: null,
  };
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
      "openAiCompatible",
    ),
    specialist: parseDescription(value.specialist, "specialist"),
  };
}

function parseDescription(
  value: unknown,
  credential: CredentialKey,
): SecretDescriptionV1 | null {
  if (!isRecord(value) || !isRecord(value.metadata)) return null;
  const descriptor = CREDENTIAL_METADATA[credential];
  const referenceId = value.referenceId;
  if (
    value.version !== 1 ||
    typeof referenceId !== "string" ||
    !isObsidianSecretReferenceV1(referenceId) ||
    value.backend !== "obsidian-secret-storage" ||
    value.persistent !== true ||
    (descriptor.provider
      ? value.metadata.provider !== descriptor.provider
      : value.metadata.actor !== "specialist") ||
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
      ...(descriptor.provider ? { provider: descriptor.provider } : {}),
      ...(credential === "specialist" &&
      (value.metadata.provider === "ollama" ||
        value.metadata.provider === "openai_compatible")
        ? { provider: value.metadata.provider }
        : {}),
      ...(credential === "specialist" &&
      typeof value.metadata.endpoint === "string"
        ? { endpoint: value.metadata.endpoint }
        : {}),
      actor: descriptor.agentSlot,
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

export function createSpecialistCredentialBindingV1(input: {
  provider: ModelProvider;
  baseUrl: string;
}): SpecialistCredentialBindingV1 {
  const endpointBaseUrl = normalizeSecureProviderBaseUrlV1(input.baseUrl);
  if (!endpointBaseUrl) {
    throw new Error("Specialist credential destination is not a secure endpoint.");
  }
  return { provider: input.provider, endpointBaseUrl };
}

function normalizeSpecialistCredentialBindingV1(
  value: SpecialistCredentialBindingV1 | null | undefined,
): SpecialistCredentialBindingV1 | null | undefined {
  if (value === undefined || value === null) return value;
  return createSpecialistCredentialBindingV1({
    provider: value.provider,
    baseUrl: value.endpointBaseUrl,
  });
}

function specialistReferenceMatchesBindingV1(
  reference: SecretDescriptionV1,
  binding: SpecialistCredentialBindingV1 | null,
): boolean {
  return (
    binding !== null &&
    reference.metadata.provider === binding.provider &&
    reference.metadata.endpoint === binding.endpointBaseUrl
  );
}

function cloneDescription(
  value: SecretDescriptionV1 | null,
): SecretDescriptionV1 | null {
  return value ? { ...value, metadata: { ...value.metadata } } : null;
}

function providerKeys(): CredentialKey[] {
  return ["ollama", "openAiCompatible", "specialist"];
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
