import type {
  SecretDescriptionV1,
  SecretLeaseDescriptionV1,
  SecretLeaseInputV1,
  SecretLeaseV1,
  SecretPutInputV1,
  SecretStoreHealthV1,
  SecretStoreV1,
} from "../../packages/core-api/src/secretStoreV1";

const BACKEND = "obsidian-secret-storage";
const REFERENCE_PATTERN = /^secret-obsidian-[a-z0-9-]{16,48}$/u;
const MAX_SECRET_CHARS = 65_536;
const MAX_LEASE_SECONDS = 300;
const METADATA_KEYS = new Set([
  "account",
  "actor",
  "credentialKind",
  "provider",
  "scope",
]);

export interface ObsidianSecretStoragePortV1 {
  getSecret(id: string): string | null;
  setSecret(id: string, value: string): void;
}

interface StoredSecretEnvelopeV1 {
  version: 1;
  value: string;
  description: SecretDescriptionV1;
}

/**
 * Foreground-only SecretStoreV1 adapter over Obsidian's native SecretStorage.
 * It is persistent but deliberately not backgroundEligible because a detached
 * companion process cannot lease values owned by the Obsidian runtime.
 */
export class ObsidianSecretStoreV1 implements SecretStoreV1 {
  readonly version = 1 as const;

  constructor(
    private readonly storage: ObsidianSecretStoragePortV1,
    private readonly options: {
      now?: () => Date;
      randomId?: () => string;
    } = {},
  ) {}

  async health(): Promise<SecretStoreHealthV1> {
    return Object.freeze({
      version: 1,
      available: true,
      persistent: true,
      backend: BACKEND,
      backgroundEligible: false,
      blocker: "secure_persistent_credential_backend_required",
    });
  }

  async put(input: SecretPutInputV1): Promise<SecretDescriptionV1> {
    const value = requireSecret(input.value);
    const label = requireText(input.label, "Secret label", 256);
    const metadata = normalizeMetadata(input.metadata ?? {});
    const now = this.now().toISOString();
    const referenceId = `secret-obsidian-${this.randomId()}`;
    requireReferenceId(referenceId);
    const description = freezeDescription({
      version: 1,
      referenceId,
      label,
      metadata,
      backend: BACKEND,
      persistent: true,
      createdAt: now,
      updatedAt: now,
    });
    const envelope: StoredSecretEnvelopeV1 = {
      version: 1,
      value,
      description,
    };
    const serialized = JSON.stringify(envelope);
    this.storage.setSecret(referenceId, serialized);
    const readback = this.storage.getSecret(referenceId);
    if (readback !== serialized) {
      this.storage.setSecret(referenceId, "");
      throw new Error("Obsidian SecretStorage write readback failed.");
    }
    return description;
  }

  async describe(referenceId: string): Promise<SecretDescriptionV1> {
    return this.readEnvelope(referenceId).description;
  }

  async lease(
    referenceId: string,
    input: SecretLeaseInputV1 = {},
  ): Promise<SecretLeaseV1> {
    const envelope = this.readEnvelope(referenceId);
    const ttlSeconds = input.ttlSeconds ?? 60;
    if (
      !Number.isInteger(ttlSeconds) ||
      ttlSeconds < 1 ||
      ttlSeconds > MAX_LEASE_SECONDS
    ) {
      throw new Error("Secret lease TTL must be an integer from 1 through 300.");
    }
    const description: SecretLeaseDescriptionV1 = Object.freeze({
      version: 1,
      leaseId: `lease_obsidian_${this.randomId()}`,
      referenceId: envelope.description.referenceId,
      source: "secure_store_lease",
      persistent: true,
      expiresAt: new Date(this.now().getTime() + ttlSeconds * 1_000).toISOString(),
    });
    const now = this.options.now ?? (() => new Date());
    let value: string | null = envelope.value;
    return Object.freeze({
      description,
      get disposed() {
        return value === null;
      },
      async withSecret<TResult>(
        use: (secret: string) => Promise<TResult>,
      ): Promise<TResult> {
        if (value === null) throw new Error("Secret lease is disposed.");
        if (Date.parse(description.expiresAt) <= now().getTime()) {
          value = null;
          throw new Error("Secret lease expired.");
        }
        return use(value);
      },
      dispose(): void {
        value = null;
      },
      toJSON(): { redacted: true; description: SecretLeaseDescriptionV1 } {
        return { redacted: true, description };
      },
    });
  }

  async remove(referenceId: string): Promise<boolean> {
    requireReferenceId(referenceId);
    if (!this.storage.getSecret(referenceId)) return false;
    this.storage.setSecret(referenceId, "");
    return this.storage.getSecret(referenceId) === "";
  }

  private readEnvelope(referenceId: string): StoredSecretEnvelopeV1 {
    requireReferenceId(referenceId);
    const serialized = this.storage.getSecret(referenceId);
    if (!serialized) throw new Error("Secret reference was not found.");
    let value: unknown;
    try {
      value = JSON.parse(serialized);
    } catch {
      throw new Error("Obsidian SecretStorage entry is malformed.");
    }
    if (!isRecord(value) || value.version !== 1) {
      throw new Error("Obsidian SecretStorage entry is malformed.");
    }
    const description = parseDescription(value.description, referenceId);
    return {
      version: 1,
      value: requireSecret(value.value),
      description,
    };
  }

  private now(): Date {
    const value = this.options.now?.() ?? new Date();
    if (Number.isNaN(value.getTime())) throw new Error("Secret store time is invalid.");
    return value;
  }

  private randomId(): string {
    const supplied = this.options.randomId?.();
    if (supplied) return requireRandomId(supplied);
    const bytes = new Uint8Array(18);
    const crypto = globalThis.crypto;
    if (!crypto?.getRandomValues) {
      throw new Error("Secure randomness is unavailable for SecretStorage references.");
    }
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export function isObsidianSecretReferenceV1(referenceId: unknown): boolean {
  return typeof referenceId === "string" && REFERENCE_PATTERN.test(referenceId);
}

function parseDescription(
  value: unknown,
  expectedReferenceId: string,
): SecretDescriptionV1 {
  if (!isRecord(value)) throw new Error("Secret description is malformed.");
  if (
    value.version !== 1 ||
    value.referenceId !== expectedReferenceId ||
    value.backend !== BACKEND ||
    value.persistent !== true ||
    !isRecord(value.metadata)
  ) {
    throw new Error("Secret description is malformed.");
  }
  return freezeDescription({
    version: 1,
    referenceId: requireReferenceId(value.referenceId),
    label: requireText(value.label, "Secret label", 256),
    metadata: normalizeMetadata(value.metadata),
    backend: BACKEND,
    persistent: true,
    createdAt: requireIso(value.createdAt),
    updatedAt: requireIso(value.updatedAt),
  });
}

function freezeDescription(value: SecretDescriptionV1): SecretDescriptionV1 {
  return Object.freeze({
    ...value,
    metadata: Object.freeze({ ...value.metadata }),
  });
}

function requireReferenceId(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) {
    throw new Error("Secret reference ID is malformed.");
  }
  return value;
}

function requireRandomId(value: string): string {
  const normalized = value.trim();
  if (!/^[a-z0-9-]{16,48}$/u.test(normalized)) {
    throw new Error("Secret random ID is malformed.");
  }
  return normalized;
}

function requireSecret(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > MAX_SECRET_CHARS
  ) {
    throw new Error("Secret value is malformed.");
  }
  return value;
}

function requireText(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`${label} is malformed.`);
  }
  return value;
}

function requireIso(value: unknown): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new Error("Secret timestamp is malformed.");
  }
  return value;
}

function normalizeMetadata(
  value: Record<string, unknown>,
): SecretDescriptionV1["metadata"] {
  const metadata: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (
      !METADATA_KEYS.has(key) ||
      typeof item !== "string" ||
      !item.trim() ||
      item.length > 512
    ) {
      throw new Error("Secret metadata is malformed.");
    }
    metadata[key] = item;
  }
  return Object.freeze(metadata) as SecretDescriptionV1["metadata"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
