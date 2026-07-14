import {
  parseLinearOAuthCredentialV1,
  parsePendingLinearOAuthRefreshV1,
  type LinearOAuthActorV1,
  type LinearOAuthCredentialV1,
  type PendingLinearOAuthRefreshV1,
} from "./LinearOAuth";

export const LINEAR_OAUTH_DEFAULT_CALLBACK_PORT = 43_119;

export interface LinearOAuthRuntimeStateV1 {
  version: 1;
  clientId: string;
  actor: LinearOAuthActorV1;
  credential: LinearOAuthCredentialV1;
  pendingRefresh: PendingLinearOAuthRefreshV1 | null;
  updatedAt: string;
}

/** Strict, secret-free plugin-data boundary for Linear OAuth runtime state. */
export function parseLinearOAuthRuntimeStateV1(
  value: unknown,
): LinearOAuthRuntimeStateV1 {
  if (!isRecord(value)) throw new Error("Linear OAuth runtime state must be an object.");
  const expected = [
    "version",
    "clientId",
    "actor",
    "credential",
    "pendingRefresh",
    "updatedAt",
  ].sort();
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error("Linear OAuth runtime state has unexpected or missing fields.");
  }
  if (value.version !== 1) throw new Error("Unsupported Linear OAuth runtime state version.");
  const clientId = normalizeLinearOAuthClientIdV1(value.clientId);
  if (!clientId) throw new Error("Linear OAuth runtime client id is invalid.");
  if (value.actor !== "user" && value.actor !== "app") {
    throw new Error("Linear OAuth runtime actor must be user or app.");
  }
  const credential = parseLinearOAuthCredentialV1(value.credential);
  if (credential.actor !== value.actor) {
    throw new Error("Linear OAuth runtime actor does not match its credential.");
  }
  const pendingRefresh = value.pendingRefresh === null
    ? null
    : parsePendingLinearOAuthRefreshV1(value.pendingRefresh);
  if (
    pendingRefresh &&
    (pendingRefresh.credentialId !== credential.credentialId ||
      pendingRefresh.refreshTokenReferenceId !==
        credential.refreshTokenReferenceId ||
      pendingRefresh.actor !== credential.actor ||
      pendingRefresh.scopes.join(",") !== credential.scopes.join(","))
  ) {
    throw new Error("Pending Linear OAuth refresh does not match its credential.");
  }
  const updatedAt = canonicalTimestamp(value.updatedAt);
  return {
    version: 1,
    clientId,
    actor: value.actor,
    credential,
    pendingRefresh,
    updatedAt,
  };
}

export function normalizeLinearOAuthRuntimeStateV1(
  value: unknown,
): LinearOAuthRuntimeStateV1 | null {
  try {
    return parseLinearOAuthRuntimeStateV1(value);
  } catch {
    return null;
  }
}

export function normalizeLinearOAuthClientIdV1(value: unknown): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim();
  return /^[A-Za-z0-9._-]{3,256}$/.test(normalized) ? normalized : "";
}

export function normalizeLinearOAuthCallbackPortV1(value: unknown): number {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 1_024 &&
    value <= 65_535
    ? value
    : LINEAR_OAUTH_DEFAULT_CALLBACK_PORT;
}

export function createLinearOAuthRuntimeStateV1(input: {
  clientId: string;
  actor: LinearOAuthActorV1;
  credential: LinearOAuthCredentialV1;
  pendingRefresh?: PendingLinearOAuthRefreshV1 | null;
  updatedAt?: string;
}): LinearOAuthRuntimeStateV1 {
  return parseLinearOAuthRuntimeStateV1({
    version: 1,
    clientId: input.clientId,
    actor: input.actor,
    credential: input.credential,
    pendingRefresh: input.pendingRefresh ?? null,
    updatedAt: input.updatedAt ?? new Date().toISOString(),
  });
}

function canonicalTimestamp(value: unknown): string {
  if (typeof value !== "string") throw new Error("Linear OAuth runtime timestamp is invalid.");
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error("Linear OAuth runtime timestamp is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
