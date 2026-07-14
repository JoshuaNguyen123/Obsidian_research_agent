export const SECRET_STORE_API_VERSION = 1 as const;

export type SecretMetadataKeyV1 =
  | "account"
  | "actor"
  | "credentialKind"
  | "provider"
  | "scope";

export type SecretMetadataV1 = Partial<Record<SecretMetadataKeyV1, string>>;

/**
 * Persistable, non-secret metadata for an opaque credential reference. There
 * is deliberately no value, token, password, or credential field.
 */
export interface SecretDescriptionV1 {
  version: typeof SECRET_STORE_API_VERSION;
  referenceId: string;
  label: string;
  metadata: SecretMetadataV1;
  backend: string;
  persistent: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SecretLeaseDescriptionV1 {
  version: typeof SECRET_STORE_API_VERSION;
  leaseId: string;
  referenceId: string;
  source: "session_memory" | "secure_store_lease";
  persistent: boolean;
  expiresAt: string;
}

/**
 * A closure-backed secret capability. Implementations must not expose a value
 * getter, string conversion, or JSON representation containing plaintext.
 */
export interface SecretLeaseV1 {
  readonly description: SecretLeaseDescriptionV1;
  readonly disposed: boolean;
  withSecret<TResult>(use: (secret: string) => Promise<TResult>): Promise<TResult>;
  dispose(): void;
  toJSON(): { redacted: true; description: SecretLeaseDescriptionV1 };
}

export interface SecretStoreHealthV1 {
  version: typeof SECRET_STORE_API_VERSION;
  available: boolean;
  persistent: boolean;
  backend: string;
  backgroundEligible: boolean;
  blocker: "secure_persistent_credential_backend_required" | "secret_store_unavailable" | null;
}

export interface SecretPutInputV1 {
  value: string;
  label: string;
  metadata?: SecretMetadataV1;
}

export interface SecretLeaseInputV1 {
  ttlSeconds?: number;
}

/**
 * SecretStoreV1 exchanges only opaque references and redacted lease handles.
 * Plaintext is accepted only at the put boundary and inside withSecret.
 */
export interface SecretStoreV1 {
  readonly version: typeof SECRET_STORE_API_VERSION;
  health(): Promise<SecretStoreHealthV1>;
  put(input: SecretPutInputV1): Promise<SecretDescriptionV1>;
  describe(referenceId: string): Promise<SecretDescriptionV1>;
  lease(referenceId: string, input?: SecretLeaseInputV1): Promise<SecretLeaseV1>;
  remove(referenceId: string): Promise<boolean>;
}
