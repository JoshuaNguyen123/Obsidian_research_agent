import assert from "node:assert/strict";
import test from "node:test";

import {
  createLinearOAuthRuntimeStateV1,
  normalizeLinearOAuthClientIdV1,
  normalizeLinearOAuthCallbackPortV1,
  LINEAR_OAUTH_DEFAULT_CALLBACK_PORT,
  normalizeLinearOAuthRuntimeStateV1,
  parseLinearOAuthRuntimeStateV1,
} from "../src/integrations/linear/LinearOAuthRuntimeState";
import type { LinearOAuthCredentialV1 } from "../src/integrations/linear/LinearOAuth";

const CREDENTIAL: LinearOAuthCredentialV1 = {
  version: 1,
  credentialId: "linear_oauth_credential_abcdefghijklmnopqrstuvwxyz",
  actor: "app",
  scopes: ["read", "write"],
  accessTokenReferenceId: "secret_access-reference-12345678",
  refreshTokenReferenceId: "secret_refresh-reference-12345678",
  tokenType: "Bearer",
  issuedAt: "2026-01-01T00:00:00.000Z",
  accessExpiresAt: "2026-01-02T00:00:00.000Z",
  refreshGeneration: 0,
};

test("Linear OAuth runtime state round-trips only non-secret client metadata and references", () => {
  const state = createLinearOAuthRuntimeStateV1({
    clientId: "linear-client-id",
    actor: "app",
    credential: CREDENTIAL,
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.deepEqual(parseLinearOAuthRuntimeStateV1(JSON.parse(JSON.stringify(state))), state);
  assert.equal(JSON.stringify(state).includes("access_token"), false);
  assert.equal(JSON.stringify(state).includes("refresh_token"), false);
});

test("runtime state rejects authority drift and mismatched pending refresh references", () => {
  const state = createLinearOAuthRuntimeStateV1({
    clientId: "linear-client-id",
    actor: "app",
    credential: CREDENTIAL,
    updatedAt: "2026-01-01T00:00:01.000Z",
  });
  assert.equal(normalizeLinearOAuthRuntimeStateV1({ ...state, actor: "user" }), null);
  assert.equal(
    normalizeLinearOAuthRuntimeStateV1({
      ...state,
      pendingRefresh: {
        version: 1,
        pendingId: "linear_oauth_refresh_abcdefghijklmnopqrstuvwxyz",
        credentialId: CREDENTIAL.credentialId,
        refreshTokenReferenceId: "secret_different-reference-12345678",
        actor: "app",
        scopes: ["read", "write"],
        status: "reconcile_required",
        attempts: 1,
        firstAttemptAt: "2026-01-01T00:00:01.000Z",
        lastAttemptAt: "2026-01-01T00:00:01.000Z",
        replayGraceExpiresAt: "2026-01-01T00:30:01.000Z",
        lastError: {
          code: "linear_oauth_refresh_ambiguous",
          message: "Refresh requires reconciliation.",
        },
      },
    }),
    null,
  );
});

test("OAuth client IDs are bounded non-secret identifiers", () => {
  assert.equal(normalizeLinearOAuthClientIdV1("  linear-client.id_1  "), "linear-client.id_1");
  assert.equal(normalizeLinearOAuthClientIdV1("https://linear.app/client"), "");
  assert.equal(normalizeLinearOAuthClientIdV1("ab"), "");
});

test("OAuth callback port is stable and bounded to non-privileged TCP ports", () => {
  assert.equal(normalizeLinearOAuthCallbackPortV1(43_210), 43_210);
  assert.equal(normalizeLinearOAuthCallbackPortV1(0), LINEAR_OAUTH_DEFAULT_CALLBACK_PORT);
  assert.equal(normalizeLinearOAuthCallbackPortV1(65_536), LINEAR_OAUTH_DEFAULT_CALLBACK_PORT);
  assert.equal(normalizeLinearOAuthCallbackPortV1("43210"), LINEAR_OAUTH_DEFAULT_CALLBACK_PORT);
});
