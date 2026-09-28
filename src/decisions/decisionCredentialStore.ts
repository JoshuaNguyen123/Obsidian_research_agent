import type {
  SecretDescriptionV1,
  SecretStoreV1,
} from "../../packages/core-api/src/secretStoreV1";
import { isObsidianSecretReferenceV1 } from "../integrations/ObsidianSecretStoreV1";

/**
 * The decision model's own OpenRouter credential. It is independent of the
 * main model's provider (a vault on Ollama can still use Jev) and it is never
 * a fallback for, or fallen back to from, any other credential. Only the
 * SecretStorage reference is persisted in plugin data; the value lives in
 * Obsidian SecretStorage and is leased into runtime settings at load.
 */
const CREDENTIAL_KIND = "decision_api_key";
const PROVIDER = "openrouter";
const SCOPE = "decision_model_requests";
const ACTOR = "decision";

export class DecisionCredentialStoreV1 {
  private reference: SecretDescriptionV1 | null = null;
  /** "" = no value; null = a reference exists but could not be leased. */
  private knownDigest: string | null = "";

  constructor(private readonly store: SecretStoreV1) {}

  /**
   * Resolve the stored reference into a runtime value. A legacy plaintext
   * value (never written by this plugin, but tolerated from hand-edited data)
   * is migrated into SecretStorage and stripped on the next save.
   */
  async load(
    rawReference: unknown,
    legacyPlaintext?: unknown,
  ): Promise<{ value: string; migrated: boolean }> {
    this.reference = parseDecisionCredentialReferenceV1(rawReference);
    if (this.reference) {
      try {
        const readback = parseDecisionCredentialReferenceV1(
          await this.store.describe(this.reference.referenceId),
        );
        if (!readback || readback.referenceId !== this.reference.referenceId) {
          throw new Error("Decision credential slot binding failed.");
        }
        this.reference = readback;
        const value = await this.lease(readback);
        this.knownDigest = await digest(value);
        return { value, migrated: false };
      } catch {
        this.knownDigest = null;
        return { value: "", migrated: false };
      }
    }
    const legacy = normalizeSecret(legacyPlaintext);
    if (!legacy) return { value: "", migrated: false };
    try {
      this.reference = await this.putVerified(legacy);
      this.knownDigest = await digest(legacy);
      return { value: legacy, migrated: true };
    } catch {
      // SecretStorage refused it: usable for this session, but not migrated,
      // so the load must not rewrite data.json as if it had been.
      this.knownDigest = null;
      return { value: legacy, migrated: false };
    }
  }

  /**
   * Make SecretStorage match the runtime value. Returns reference ids that
   * were replaced or cleared, for the caller to remove after its own data
   * write succeeded (the same retire-after-save order the model keys use).
   */
  async synchronize(value: unknown): Promise<string[]> {
    const normalized = normalizeSecret(value);
    const retired: string[] = [];
    const nextDigest = normalized ? await digest(normalized) : "";
    if (this.reference && this.knownDigest === null && !normalized) return retired;
    if (this.knownDigest === nextDigest && (this.reference || !normalized)) return retired;
    if (!normalized) {
      if (this.reference) retired.push(this.reference.referenceId);
      this.reference = null;
      this.knownDigest = "";
      return retired;
    }
    const replacement = await this.putVerified(normalized);
    if (this.reference) retired.push(this.reference.referenceId);
    this.reference = replacement;
    this.knownDigest = nextDigest;
    return retired;
  }

  snapshot(): SecretDescriptionV1 | null {
    return this.reference
      ? { ...this.reference, metadata: { ...this.reference.metadata } }
      : null;
  }

  async removeRetired(referenceIds: readonly string[]): Promise<void> {
    for (const referenceId of [...new Set(referenceIds)]) {
      await this.store.remove(referenceId).catch(() => false);
    }
  }

  private async putVerified(value: string): Promise<SecretDescriptionV1> {
    const health = await this.store.health();
    if (!health.available || !health.persistent) {
      throw new Error("Persistent secure credential storage is unavailable.");
    }
    const description = await this.store.put({
      value,
      label: "OpenRouter decision model credential",
      metadata: {
        provider: PROVIDER,
        actor: ACTOR,
        credentialKind: CREDENTIAL_KIND,
        scope: SCOPE,
      },
    });
    const readback = parseDecisionCredentialReferenceV1(
      await this.store.describe(description.referenceId),
    );
    if (!readback || readback.referenceId !== description.referenceId) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Decision credential metadata readback failed.");
    }
    if ((await this.lease(readback)) !== value) {
      await this.store.remove(description.referenceId).catch(() => false);
      throw new Error("Decision credential value readback failed.");
    }
    return readback;
  }

  private async lease(reference: SecretDescriptionV1): Promise<string> {
    const lease = await this.store.lease(reference.referenceId, { ttlSeconds: 30 });
    try {
      return await lease.withSecret(async (secret) => {
        const normalized = normalizeSecret(secret);
        if (!normalized) throw new Error("Decision credential is empty.");
        return normalized;
      });
    } finally {
      lease.dispose();
    }
  }
}

/** Validates a persisted reference; anything else reads as "no credential". */
export function parseDecisionCredentialReferenceV1(value: unknown): SecretDescriptionV1 | null {
  if (!isRecord(value) || !isRecord(value.metadata)) return null;
  const referenceId = value.referenceId;
  if (
    value.version !== 1 ||
    typeof referenceId !== "string" ||
    !isObsidianSecretReferenceV1(referenceId) ||
    value.backend !== "obsidian-secret-storage" ||
    value.persistent !== true ||
    value.metadata.credentialKind !== CREDENTIAL_KIND ||
    value.metadata.provider !== PROVIDER ||
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
      provider: PROVIDER,
      actor: ACTOR,
      credentialKind: CREDENTIAL_KIND,
      scope: SCOPE,
    },
    backend: "obsidian-secret-storage",
    persistent: true,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function normalizeSecret(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

async function digest(value: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable for credential comparison.");
  const bytes = await subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
