import type {
  SecretDescriptionV1,
  SecretLeaseDescriptionV1,
  SecretLeaseInputV1,
  SecretLeaseV1,
  SecretMetadataV1,
  SecretPutInputV1,
  SecretStoreHealthV1,
  SecretStoreV1,
} from "../../core-api/src/secretStoreV1";
import { SECRET_STORE_API_VERSION } from "../../core-api/src/secretStoreV1";
import type { BootstrapTokenLeaseV1 } from "./backgroundContinuation";
import {
  normalizeCompanionBaseUrlV1,
  resolveCompanionBootstrapSessionV1,
} from "./companionCredentialSession";

const MAX_SECRET_BYTES = 65_536;
const MAX_RESPONSE_BYTES = 1_048_576;
const METADATA_KEY_BY_NORMALIZED = new Map<string, keyof SecretMetadataV1>([
  ["account", "account"],
  ["actor", "actor"],
  ["credentialkind", "credentialKind"],
  ["provider", "provider"],
  ["scope", "scope"],
]);
const REFERENCE_PATTERN = /^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/;
const LEASE_PATTERN = /^lease_[A-Za-z0-9_-]{8,256}$/;

export class SecretStoreBoundaryErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_secret_input"
      | "secret_reference_not_found"
      | "secret_store_unavailable"
      | "secret_lease_expired"
      | "secret_lease_disposed"
      | "invalid_secret_response"
      | "secure_persistent_credential_backend_required",
    message: string,
  ) {
    super(message);
    this.name = "SecretStoreBoundaryErrorV1";
  }
}

export interface InMemorySecretStoreV1Options {
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

interface InMemorySecretRecordV1 {
  value: string;
  description: SecretDescriptionV1;
  leases: Set<SecretLeaseV1>;
}

/** Foreground-only fallback. No reference or value survives process restart. */
export class InMemorySecretStoreV1 implements SecretStoreV1 {
  readonly version = SECRET_STORE_API_VERSION;
  private readonly records = new Map<string, InMemorySecretRecordV1>();
  private readonly now: () => Date;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(options: InMemorySecretStoreV1Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
  }

  async health(): Promise<SecretStoreHealthV1> {
    return foregroundOnlyHealth();
  }

  async put(input: SecretPutInputV1): Promise<SecretDescriptionV1> {
    const normalized = normalizePutInput(input);
    const referenceId = `secret_${hex(this.randomBytes(18))}`;
    const timestamp = this.now().toISOString();
    const description = freezeDescription({
      version: SECRET_STORE_API_VERSION,
      referenceId,
      label: normalized.label,
      metadata: normalized.metadata,
      backend: "session-memory",
      persistent: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    this.records.set(referenceId, {
      value: normalized.value,
      description,
      leases: new Set(),
    });
    return description;
  }

  async describe(referenceId: string): Promise<SecretDescriptionV1> {
    const record = this.records.get(requireReferenceId(referenceId));
    if (!record) throw referenceNotFound();
    return record.description;
  }

  async lease(
    referenceId: string,
    input: SecretLeaseInputV1 = {},
  ): Promise<SecretLeaseV1> {
    const normalizedReference = requireReferenceId(referenceId);
    const record = this.records.get(normalizedReference);
    if (!record) throw referenceNotFound();
    const ttlSeconds = normalizeTtl(input.ttlSeconds);
    const expiresAt = new Date(this.now().getTime() + ttlSeconds * 1_000).toISOString();
    let lease!: SecretLeaseV1;
    lease = createSecretLeaseV1(
      record.value,
      {
        version: SECRET_STORE_API_VERSION,
        leaseId: `lease_${hex(this.randomBytes(18))}`,
        referenceId: normalizedReference,
        source: "session_memory",
        persistent: false,
        expiresAt,
      },
      {
        now: this.now,
        onDispose: () => record.leases.delete(lease),
      },
    );
    record.leases.add(lease);
    return lease;
  }

  async remove(referenceId: string): Promise<boolean> {
    const normalizedReference = requireReferenceId(referenceId);
    const record = this.records.get(normalizedReference);
    if (!record) return false;
    for (const lease of [...record.leases]) lease.dispose();
    record.value = "";
    this.records.delete(normalizedReference);
    return true;
  }

  toJSON(): { version: 1; backend: "session-memory"; persistent: false; redacted: true } {
    return {
      version: SECRET_STORE_API_VERSION,
      backend: "session-memory",
      persistent: false,
      redacted: true,
    };
  }
}

export interface CompanionSecretStoreClientV1Options {
  baseUrl: string;
  credential?: BootstrapTokenLeaseV1;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
}

/** Authenticated loopback adapter for the companion keyring-backed store. */
export class CompanionSecretStoreClientV1 implements SecretStoreV1 {
  readonly version = SECRET_STORE_API_VERSION;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly leases = new Map<string, Set<SecretLeaseV1>>();

  constructor(private readonly options: CompanionSecretStoreClientV1Options) {
    this.baseUrl = normalizeCompanionBaseUrlV1(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = clampInteger(options.timeoutMs ?? 15_000, 250, 120_000);
    this.now = options.now ?? (() => new Date());
  }

  async health(): Promise<SecretStoreHealthV1> {
    try {
      const status = await this.requestJson<Record<string, unknown>>("/status", {
        method: "GET",
      });
      const persistent = status.secureStorePersistent === true;
      const backend = boundedString(status.secureStoreBackend, "secureStoreBackend", 256);
      return Object.freeze({
        version: SECRET_STORE_API_VERSION,
        available: true,
        persistent,
        backend,
        backgroundEligible: persistent,
        blocker: persistent ? null : "secure_persistent_credential_backend_required",
      });
    } catch {
      return Object.freeze({
        version: SECRET_STORE_API_VERSION,
        available: false,
        persistent: false,
        backend: "unavailable",
        backgroundEligible: false,
        blocker: "secret_store_unavailable",
      });
    }
  }

  async put(input: SecretPutInputV1): Promise<SecretDescriptionV1> {
    const normalized = normalizePutInput(input);
    const response = await this.requestJson<Record<string, unknown>>(
      "/secrets",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: boundedJsonBody(normalized),
      },
      true,
    );
    return parseDescription(response);
  }

  async describe(referenceId: string): Promise<SecretDescriptionV1> {
    const normalizedReference = requireReferenceId(referenceId);
    const response = await this.requestJson<Record<string, unknown>>(
      `/secrets/${encodeURIComponent(normalizedReference)}`,
      { method: "GET" },
      true,
    );
    return parseDescription(response);
  }

  async lease(
    referenceId: string,
    input: SecretLeaseInputV1 = {},
  ): Promise<SecretLeaseV1> {
    const normalizedReference = requireReferenceId(referenceId);
    const description = await this.describe(normalizedReference);
    const response = await this.requestJson<Record<string, unknown>>(
      `/secrets/${encodeURIComponent(normalizedReference)}/lease`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: boundedJsonBody({ ttlSeconds: normalizeTtl(input.ttlSeconds) }),
      },
      true,
    );
    const leaseId = boundedString(response.leaseId, "leaseId", 256);
    if (!LEASE_PATTERN.test(leaseId)) invalidResponse("leaseId is malformed.");
    const returnedReference = requireReferenceId(
      boundedString(response.referenceId, "referenceId", 256),
      "invalid_secret_response",
    );
    if (returnedReference !== normalizedReference) {
      invalidResponse("Lease reference does not match the requested secret.");
    }
    const expiresAt = requireIsoTimestamp(response.expiresAt, "expiresAt");
    const value = boundedString(response.value, "value", MAX_SECRET_BYTES, true);
    response.value = "[REDACTED]";
    let lease!: SecretLeaseV1;
    const leases = this.leases.get(normalizedReference) ?? new Set<SecretLeaseV1>();
    this.leases.set(normalizedReference, leases);
    lease = createSecretLeaseV1(
      value,
      {
        version: SECRET_STORE_API_VERSION,
        leaseId,
        referenceId: normalizedReference,
        source: description.persistent ? "secure_store_lease" : "session_memory",
        persistent: description.persistent,
        expiresAt,
      },
      {
        now: this.now,
        onDispose: () => {
          leases.delete(lease);
          if (leases.size === 0) this.leases.delete(normalizedReference);
        },
      },
    );
    leases.add(lease);
    return lease;
  }

  async remove(referenceId: string): Promise<boolean> {
    const normalizedReference = requireReferenceId(referenceId);
    const response = await this.requestJson<Record<string, unknown>>(
      `/secrets/${encodeURIComponent(normalizedReference)}`,
      { method: "DELETE" },
      true,
    );
    if (typeof response.removed !== "boolean") {
      invalidResponse("Secret removal response is malformed.");
    }
    if (response.removed) {
      for (const lease of [...(this.leases.get(normalizedReference) ?? [])]) {
        lease.dispose();
      }
      this.leases.delete(normalizedReference);
    }
    return response.removed;
  }

  toJSON(): { version: 1; baseUrl: string; redacted: true } {
    return { version: SECRET_STORE_API_VERSION, baseUrl: this.baseUrl, redacted: true };
  }

  private requireCredential(): BootstrapTokenLeaseV1 {
    const credential =
      this.options.credential ?? resolveCompanionBootstrapSessionV1(this.baseUrl)?.credential;
    if (!credential) {
      throw new SecretStoreBoundaryErrorV1(
        "secret_store_unavailable",
        "Companion authentication is not configured for this process session.",
      );
    }
    return credential;
  }

  private async requestJson<TResponse>(
    path: string,
    init: RequestInit,
    requireNoStore = false,
  ): Promise<TResponse> {
    const controller = new AbortController();
    const timer = globalThis.setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.requireCredential().withToken((token) =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          cache: "no-store",
          credentials: "omit",
          headers: {
            ...headersToRecord(init.headers),
            Authorization: `Bearer ${token}`,
            "Cache-Control": "no-store",
          },
          signal: controller.signal,
        }),
      );
      if (!response.ok) {
        if (response.status === 404) throw referenceNotFound();
        if (response.status === 401 || response.status === 403) {
          throw new SecretStoreBoundaryErrorV1(
            "secret_store_unavailable",
            "Companion authentication failed.",
          );
        }
        const detail = sanitizeError(await readResponseTextBounded(response, 16_384));
        throw new SecretStoreBoundaryErrorV1(
          "secret_store_unavailable",
          `Companion secret store request failed (${response.status}): ${detail}`,
        );
      }
      if (requireNoStore && !hasNoStore(response.headers.get("Cache-Control"))) {
        throw new SecretStoreBoundaryErrorV1(
          "invalid_secret_response",
          "Companion secret response is missing Cache-Control: no-store.",
        );
      }
      const text = await readResponseTextBounded(response, MAX_RESPONSE_BYTES);
      try {
        return JSON.parse(text) as TResponse;
      } catch {
        throw new SecretStoreBoundaryErrorV1(
          "invalid_secret_response",
          "Companion secret response is not valid JSON.",
        );
      }
    } finally {
      globalThis.clearTimeout(timer);
    }
  }
}

export function createSecretLeaseV1(
  value: string,
  input: SecretLeaseDescriptionV1,
  options: { now?: () => Date; onDispose?: () => void } = {},
): SecretLeaseV1 {
  requireSecretValue(value);
  const now = options.now ?? (() => new Date());
  const description = freezeLeaseDescription(input);
  let secret: string | null = value;
  let disposeNotified = false;

  const dispose = () => {
    secret = null;
    if (!disposeNotified) {
      disposeNotified = true;
      options.onDispose?.();
    }
  };

  return Object.freeze({
    description,
    get disposed() {
      return secret === null;
    },
    async withSecret<TResult>(
      use: (secret: string) => Promise<TResult>,
    ): Promise<TResult> {
      if (secret === null) {
        throw new SecretStoreBoundaryErrorV1(
          "secret_lease_disposed",
          "The secret lease is unavailable.",
        );
      }
      if (Date.parse(description.expiresAt) <= now().getTime()) {
        dispose();
        throw new SecretStoreBoundaryErrorV1(
          "secret_lease_expired",
          "The secret lease has expired.",
        );
      }
      return use(secret);
    },
    dispose,
    toJSON() {
      return { redacted: true as const, description };
    },
  });
}

export async function requireBackgroundSecretStoreV1(
  store: Pick<SecretStoreV1, "health">,
): Promise<SecretStoreHealthV1> {
  const health = await store.health();
  if (!health.available) {
    throw new SecretStoreBoundaryErrorV1(
      "secret_store_unavailable",
      "Background execution is disabled because the secret store is unavailable.",
    );
  }
  if (!health.persistent || !health.backgroundEligible) {
    throw new SecretStoreBoundaryErrorV1(
      "secure_persistent_credential_backend_required",
      "Background execution requires a proven secure persistent credential backend.",
    );
  }
  return health;
}

function foregroundOnlyHealth(): SecretStoreHealthV1 {
  return Object.freeze({
    version: SECRET_STORE_API_VERSION,
    available: true,
    persistent: false,
    backend: "session-memory",
    backgroundEligible: false,
    blocker: "secure_persistent_credential_backend_required",
  });
}

function normalizePutInput(input: SecretPutInputV1): Required<SecretPutInputV1> {
  if (!input || typeof input !== "object") invalidInput("Secret put input is required.");
  const value = requireSecretValue(input.value);
  const label = boundedString(input.label, "label", 256, false, "invalid_secret_input").trim();
  if (!label) invalidInput("Secret label is required.");
  const metadata: SecretMetadataV1 = {};
  for (const [key, entry] of Object.entries(input.metadata ?? {})) {
    const canonicalKey = metadataKey(key);
    if (!canonicalKey) {
      invalidInput("Secret metadata has a closed non-secret field set.");
    }
    metadata[canonicalKey] = boundedString(
      entry,
      `metadata.${canonicalKey}`,
      512,
      false,
      "invalid_secret_input",
    );
  }
  return { value, label, metadata: Object.freeze({ ...metadata }) };
}

function parseDescription(value: Record<string, unknown>): SecretDescriptionV1 {
  const referenceId = requireReferenceId(
    boundedString(value.referenceId, "referenceId", 256),
    "invalid_secret_response",
  );
  const label = boundedString(value.label, "label", 256);
  const backend = boundedString(value.backend, "backend", 256);
  if (typeof value.persistent !== "boolean") invalidResponse("persistent is malformed.");
  if (!value.metadata || typeof value.metadata !== "object" || Array.isArray(value.metadata)) {
    invalidResponse("metadata is malformed.");
  }
  const metadata: SecretMetadataV1 = {};
  for (const [key, entry] of Object.entries(value.metadata as Record<string, unknown>)) {
    const canonicalKey = metadataKey(key);
    if (!canonicalKey) invalidResponse("metadata contains an unsafe key.");
    metadata[canonicalKey] = boundedString(entry, `metadata.${canonicalKey}`, 512);
  }
  return freezeDescription({
    version: SECRET_STORE_API_VERSION,
    referenceId,
    label,
    metadata,
    backend,
    persistent: value.persistent,
    createdAt: requireIsoTimestamp(value.createdAt, "createdAt"),
    updatedAt: requireIsoTimestamp(value.updatedAt, "updatedAt"),
  });
}

function freezeDescription(input: SecretDescriptionV1): SecretDescriptionV1 {
  return Object.freeze({ ...input, metadata: Object.freeze({ ...input.metadata }) });
}

function freezeLeaseDescription(input: SecretLeaseDescriptionV1): SecretLeaseDescriptionV1 {
  if (input.version !== SECRET_STORE_API_VERSION) invalidResponse("Lease version is invalid.");
  if (!LEASE_PATTERN.test(input.leaseId)) invalidResponse("Lease id is malformed.");
  requireReferenceId(input.referenceId, "invalid_secret_response");
  requireIsoTimestamp(input.expiresAt, "expiresAt");
  return Object.freeze({ ...input });
}

function requireSecretValue(value: unknown): string {
  const normalized = boundedString(
    value,
    "value",
    MAX_SECRET_BYTES,
    false,
    "invalid_secret_input",
  );
  if (new TextEncoder().encode(normalized).byteLength > MAX_SECRET_BYTES) {
    invalidInput("Secret value exceeded its byte limit.");
  }
  return normalized;
}

function requireReferenceId(
  value: string,
  code: "invalid_secret_input" | "invalid_secret_response" = "invalid_secret_input",
): string {
  const normalized = value.trim();
  if (!REFERENCE_PATTERN.test(normalized)) {
    throw new SecretStoreBoundaryErrorV1(code, "Secret reference id is malformed.");
  }
  return normalized;
}

function normalizeTtl(value: number | undefined): number {
  const ttl = value ?? 60;
  if (!Number.isInteger(ttl) || ttl < 1 || ttl > 300) {
    invalidInput("Secret lease ttlSeconds must be an integer from 1 through 300.");
  }
  return ttl;
}

function metadataKey(value: string): keyof SecretMetadataV1 | null {
  return METADATA_KEY_BY_NORMALIZED.get(value.replace(/[^a-z0-9]/gi, "").toLowerCase()) ?? null;
}

function boundedString(
  value: unknown,
  field: string,
  maxLength: number,
  allowEmpty = false,
  code: "invalid_secret_input" | "invalid_secret_response" = "invalid_secret_response",
): string {
  if (typeof value !== "string" || (!allowEmpty && !value.length) || value.length > maxLength) {
    if (code === "invalid_secret_input") invalidInput(`${field} is malformed.`);
    invalidResponse(`${field} is malformed.`);
  }
  return value;
}

function requireIsoTimestamp(value: unknown, field: string): string {
  const normalized = boundedString(value, field, 128);
  if (Number.isNaN(Date.parse(normalized))) invalidResponse(`${field} is not an ISO timestamp.`);
  return normalized;
}

function boundedJsonBody(value: unknown): string {
  const body = JSON.stringify(value);
  if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
    invalidInput("Companion secret request exceeded its byte limit.");
  }
  return body;
}

function secureRandomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new SecretStoreBoundaryErrorV1(
      "secret_store_unavailable",
      "A cryptographically secure random source is required.",
    );
  }
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const output: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    output[key] = value;
  });
  return output;
}

async function readResponseTextBounded(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new SecretStoreBoundaryErrorV1(
          "invalid_secret_response",
          "Companion secret response exceeded its byte limit.",
        );
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function hasNoStore(value: string | null): boolean {
  return value
    ?.split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store") ?? false;
}

function sanitizeError(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password|api[_-]?key)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 4_096);
}

function referenceNotFound(): SecretStoreBoundaryErrorV1 {
  return new SecretStoreBoundaryErrorV1(
    "secret_reference_not_found",
    "Secret reference not found.",
  );
}

function invalidInput(message: string): never {
  throw new SecretStoreBoundaryErrorV1("invalid_secret_input", message);
}

function invalidResponse(message: string): never {
  throw new SecretStoreBoundaryErrorV1("invalid_secret_response", message);
}
