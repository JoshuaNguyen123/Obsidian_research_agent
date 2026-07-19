import assert from "node:assert/strict";
import test from "node:test";

import type { SecretDescriptionV1 } from "../packages/core-api/src/secretStoreV1";
import {
  buildRecoveredNativeLinearOAuthStateV1,
  selectNativeLinearOAuthRecoveryPairV1,
} from "../src/integrations/linear/LinearOAuthNativeRecovery";
import { createLinearOAuthRuntimeStateV1 } from "../src/integrations/linear/LinearOAuthRuntimeState";

const CURRENT = createLinearOAuthRuntimeStateV1({
  clientId: "linear-client",
  actor: "user",
  credential: {
    version: 1,
    credentialId: `linear_oauth_credential_${"c".repeat(20)}`,
    actor: "user",
    scopes: ["read", "write"],
    accessTokenReferenceId: `secret-obsidian-${"a".repeat(16)}`,
    refreshTokenReferenceId: `secret-obsidian-${"b".repeat(16)}`,
    tokenType: "Bearer",
    issuedAt: "2026-07-18T00:00:00.000Z",
    accessExpiresAt: "2026-07-19T00:00:00.000Z",
    refreshGeneration: 0,
  },
  updatedAt: "2026-07-18T00:00:00.000Z",
});

test("native OAuth recovery selects only the newest sequential matching pair", () => {
  const descriptions = [
    description("d", "oauth_access_token", "2026-07-18T01:00:00.000Z"),
    description("e", "oauth_refresh_token", "2026-07-18T01:00:00.002Z"),
    description("f", "oauth_access_token", "2026-07-18T02:00:00.000Z"),
    description("g", "oauth_refresh_token", "2026-07-18T02:00:00.003Z"),
    description("h", "oauth_access_token", "2026-07-18T03:00:00.000Z", {
      actor: "app",
    }),
  ];

  const pair = selectNativeLinearOAuthRecoveryPairV1(CURRENT, descriptions);
  assert.ok(pair);
  assert.equal(pair.access.referenceId, `secret-obsidian-${"f".repeat(16)}`);
  assert.equal(pair.refresh.referenceId, `secret-obsidian-${"g".repeat(16)}`);

  const recovered = buildRecoveredNativeLinearOAuthStateV1(
    CURRENT,
    pair,
    "2026-07-18T04:00:00.000Z",
  );
  assert.equal(recovered.credential.accessTokenReferenceId, pair.access.referenceId);
  assert.equal(recovered.credential.refreshTokenReferenceId, pair.refresh.referenceId);
  assert.equal(recovered.credential.credentialId, CURRENT.credential.credentialId);
  assert.equal(recovered.credential.refreshGeneration, 1);
  assert.ok(
    Date.parse(recovered.credential.accessExpiresAt) >
      Date.parse(recovered.credential.issuedAt),
  );
});

test("native OAuth recovery rejects ambiguous or non-sequential candidates", () => {
  assert.equal(
    selectNativeLinearOAuthRecoveryPairV1(CURRENT, [
      description("d", "oauth_access_token", "2026-07-18T01:00:00.000Z"),
      description("e", "oauth_access_token", "2026-07-18T01:00:00.000Z"),
      description("f", "oauth_refresh_token", "2026-07-18T01:00:00.002Z"),
    ]),
    null,
  );
  assert.equal(
    selectNativeLinearOAuthRecoveryPairV1(CURRENT, [
      description("d", "oauth_access_token", "2026-07-18T01:00:00.000Z"),
      description("e", "oauth_refresh_token", "2026-07-18T01:00:31.000Z"),
    ]),
    null,
  );
});

function description(
  idCharacter: string,
  credentialKind: "oauth_access_token" | "oauth_refresh_token",
  createdAt: string,
  metadata: Partial<SecretDescriptionV1["metadata"]> = {},
): SecretDescriptionV1 {
  return {
    version: 1,
    referenceId: `secret-obsidian-${idCharacter.repeat(16)}`,
    label: credentialKind,
    metadata: {
      provider: "linear",
      actor: "user",
      credentialKind,
      scope: "read,write",
      ...metadata,
    },
    backend: "obsidian-secret-storage",
    persistent: true,
    createdAt,
    updatedAt: createdAt,
  };
}
