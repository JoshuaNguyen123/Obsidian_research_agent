import type { SecretDescriptionV1 } from "../../../packages/core-api/src/secretStoreV1";
import {
  createLinearOAuthRuntimeStateV1,
  type LinearOAuthRuntimeStateV1,
} from "./LinearOAuthRuntimeState";

const OBSIDIAN_SECRET_STORAGE_BACKEND = "obsidian-secret-storage";
const MAX_TOKEN_PAIR_GAP_MS = 30_000;
const RECOVERED_ACCESS_WINDOW_MS = 10 * 60_000;

export interface NativeLinearOAuthRecoveryPairV1 {
  access: SecretDescriptionV1;
  refresh: SecretDescriptionV1;
}

/**
 * Selects only the newest unambiguous native pair emitted by one sequential
 * Linear OAuth token commit. Provider/workspace readback is still mandatory
 * before the caller may persist the returned references.
 */
export function selectNativeLinearOAuthRecoveryPairV1(
  current: LinearOAuthRuntimeStateV1,
  descriptions: readonly SecretDescriptionV1[],
): NativeLinearOAuthRecoveryPairV1 | null {
  const expectedScope = current.credential.scopes.join(",");
  const matching = descriptions
    .filter((description) =>
      description.backend === OBSIDIAN_SECRET_STORAGE_BACKEND &&
      description.persistent === true &&
      description.metadata.provider === "linear" &&
      description.metadata.actor === current.actor &&
      description.metadata.scope === expectedScope &&
      (description.metadata.credentialKind === "oauth_access_token" ||
        description.metadata.credentialKind === "oauth_refresh_token") &&
      description.referenceId !== current.credential.accessTokenReferenceId &&
      description.referenceId !== current.credential.refreshTokenReferenceId)
    .sort((left, right) =>
      Date.parse(left.createdAt) - Date.parse(right.createdAt) ||
      left.referenceId.localeCompare(right.referenceId));
  const accesses = matching.filter(
    (description) => description.metadata.credentialKind === "oauth_access_token",
  );
  const refreshes = matching.filter(
    (description) => description.metadata.credentialKind === "oauth_refresh_token",
  );
  const access = uniqueLatest(accesses);
  const refresh = uniqueLatest(refreshes);
  if (!access || !refresh) return null;
  const accessAt = Date.parse(access.createdAt);
  const refreshAt = Date.parse(refresh.createdAt);
  if (
    !Number.isFinite(accessAt) ||
    !Number.isFinite(refreshAt) ||
    refreshAt < accessAt ||
    refreshAt - accessAt > MAX_TOKEN_PAIR_GAP_MS
  ) {
    return null;
  }
  const eventsAfterAccess = matching.filter(
    (description) => Date.parse(description.createdAt) >= accessAt,
  );
  if (
    eventsAfterAccess.length !== 2 ||
    eventsAfterAccess[0]?.referenceId !== access.referenceId ||
    eventsAfterAccess[1]?.referenceId !== refresh.referenceId
  ) {
    return null;
  }
  return Object.freeze({ access, refresh });
}

export function buildRecoveredNativeLinearOAuthStateV1(
  current: LinearOAuthRuntimeStateV1,
  pair: NativeLinearOAuthRecoveryPairV1,
  recoveredAt = new Date().toISOString(),
): LinearOAuthRuntimeStateV1 {
  const recoveredAtMs = Date.parse(recoveredAt);
  if (!Number.isFinite(recoveredAtMs)) {
    throw new Error("Linear OAuth recovery timestamp is invalid.");
  }
  return createLinearOAuthRuntimeStateV1({
    clientId: current.clientId,
    actor: current.actor,
    credential: {
      ...current.credential,
      accessTokenReferenceId: pair.access.referenceId,
      refreshTokenReferenceId: pair.refresh.referenceId,
      issuedAt: recoveredAt,
      accessExpiresAt: new Date(
        recoveredAtMs + RECOVERED_ACCESS_WINDOW_MS,
      ).toISOString(),
      refreshGeneration: current.credential.refreshGeneration + 1,
    },
    pendingRefresh: null,
    updatedAt: recoveredAt,
  });
}

function uniqueLatest(
  descriptions: readonly SecretDescriptionV1[],
): SecretDescriptionV1 | null {
  const latest = descriptions.at(-1);
  if (!latest) return null;
  const latestAt = Date.parse(latest.createdAt);
  return descriptions.filter(
    (description) => Date.parse(description.createdAt) === latestAt,
  ).length === 1
    ? latest
    : null;
}
