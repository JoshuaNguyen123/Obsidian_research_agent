import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { InMemorySecretStoreV1 } from "../packages/headless-runtime/src/secretStoreV1";
import type {
  SecretDescriptionV1,
  SecretLeaseInputV1,
  SecretLeaseV1,
  SecretPutInputV1,
  SecretStoreHealthV1,
  SecretStoreV1,
} from "../packages/core-api/src/secretStoreV1";
import {
  LINEAR_OAUTH_AUTHORIZE_ENDPOINT,
  LINEAR_OAUTH_DEFAULT_ACCESS_TOKEN_SECONDS,
  LINEAR_OAUTH_MAX_ACTIVE_SESSIONS,
  LINEAR_OAUTH_REFRESH_REPLAY_GRACE_MS,
  LINEAR_OAUTH_REVOKE_ENDPOINT,
  LINEAR_OAUTH_TOKEN_ENDPOINT,
  LinearOAuthClientV1,
  LinearOAuthErrorV1,
  LinearOAuthSessionManagerV1,
  parseLinearOAuthCredentialV1,
  parsePendingLinearOAuthRefreshV1,
} from "../src/integrations/linear";
import type { HttpRequest, HttpResponse, HttpTransport } from "../src/model/types";

const CALLBACK = {
  host: "127.0.0.1" as const,
  port: 43_219,
  path: "/oauth/linear/callback" as const,
};

test("Linear OAuth authorization uses strict loopback PKCE, state, scopes, and app actor", async () => {
  const random = sequenceRandom();
  const manager = new LinearOAuthSessionManagerV1({ randomBytes: random });
  const request = await manager.begin({
    clientId: "linear-client-fixture",
    actor: "app",
    scopes: ["read", "write"],
    callback: CALLBACK,
  });
  const url = new URL(request.authorizationUrl);

  assert.equal(url.origin + url.pathname, LINEAR_OAUTH_AUTHORIZE_ENDPOINT);
  assert.equal(url.searchParams.get("response_type"), "code");
  assert.equal(url.searchParams.get("scope"), "read,write");
  assert.equal(url.searchParams.get("actor"), "app");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), request.redirectUri);
  assert.equal(request.redirectUri, "http://127.0.0.1:43219/oauth/linear/callback");
  assert.match(url.searchParams.get("state") ?? "", /^[A-Za-z0-9_-]{40,}$/);
  assert.match(url.searchParams.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Object.prototype.hasOwnProperty.call(request, "state"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(manager)), {
    version: 1,
    redacted: true,
    activeSessions: 1,
  });

  await assert.rejects(
    () => manager.begin({
      clientId: "linear-client-fixture",
      actor: "user",
      callback: { ...CALLBACK, host: "0.0.0.0" as never },
    }),
    hasOAuthCode("linear_oauth_invalid_input"),
  );
});

test("OAuth session count is bounded", async () => {
  const manager = new LinearOAuthSessionManagerV1({ randomBytes: sequenceRandom() });
  for (let index = 0; index < LINEAR_OAUTH_MAX_ACTIVE_SESSIONS; index += 1) {
    await manager.begin({
      clientId: "linear-client-fixture",
      actor: "user",
      callback: { ...CALLBACK, port: CALLBACK.port + index },
    });
  }
  await assert.rejects(
    () => manager.begin({
      clientId: "linear-client-fixture",
      actor: "user",
      callback: { ...CALLBACK, port: CALLBACK.port + 20 },
    }),
    hasOAuthCode("linear_oauth_session_limit"),
  );
});

test("callback state and endpoint are exact, then the closure-backed grant is one-time", async () => {
  const manager = new LinearOAuthSessionManagerV1({ randomBytes: sequenceRandom() });
  const request = await manager.begin({
    clientId: "linear-client-fixture",
    actor: "user",
    callback: CALLBACK,
  });
  const state = new URL(request.authorizationUrl).searchParams.get("state") ?? "";

  assert.throws(
    () => manager.completeCallback({
      sessionId: request.sessionId,
      callbackUrl: `${request.redirectUri}?code=authorization-code-fixture&state=wrong-state-value`,
    }),
    hasOAuthCode("linear_oauth_state_mismatch"),
  );
  assert.throws(
    () => manager.completeCallback({
      sessionId: request.sessionId,
      callbackUrl: `http://localhost:${CALLBACK.port}${CALLBACK.path}?code=authorization-code-fixture&state=${state}`,
    }),
    hasOAuthCode("linear_oauth_invalid_callback"),
  );
  assert.throws(
    () => manager.completeCallback({
      sessionId: request.sessionId,
      callbackUrl: `${request.redirectUri}?code=authorization-code-fixture&state=${state}&state=${state}`,
    }),
    hasOAuthCode("linear_oauth_invalid_callback"),
  );

  const grant = manager.completeCallback({
    sessionId: request.sessionId,
    callbackUrl: `${request.redirectUri}?code=authorization-code-fixture&state=${state}`,
  });
  assert.equal(JSON.stringify(grant).includes("authorization-code-fixture"), false);
  assert.equal(JSON.stringify(grant).includes("codeVerifier"), false);
  assert.throws(
    () => manager.completeCallback({
      sessionId: request.sessionId,
      callbackUrl: `${request.redirectUri}?code=authorization-code-fixture&state=${state}`,
    }),
    hasOAuthCode("linear_oauth_session_not_found"),
  );
  grant.dispose();
  await assert.rejects(
    () => grant.withGrant(async () => undefined),
    hasOAuthCode("linear_oauth_session_not_found"),
  );
});

test("authorization-code exchange sends PKCE form data and stores only opaque references", async () => {
  const requests: HttpRequest[] = [];
  const accessToken = "linear-access-token-plaintext-fixture";
  const refreshToken = "linear-refresh-token-plaintext-fixture";
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    return jsonResponse({
      access_token: accessToken,
      refresh_token: refreshToken,
      token_type: "Bearer",
    });
  };
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const { request: authorization, grant } = await authorize(client);
  const credential = await client.exchangeCode(grant);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, LINEAR_OAUTH_TOKEN_ENDPOINT);
  assert.equal(requests[0]?.contentType, "application/x-www-form-urlencoded");
  const form = new URLSearchParams(String(requests[0]?.body));
  assert.equal(form.get("grant_type"), "authorization_code");
  assert.equal(form.get("client_id"), "linear-client-fixture");
  assert.equal(form.get("code"), "authorization-code-fixture");
  assert.equal(form.get("redirect_uri"), "http://127.0.0.1:43219/oauth/linear/callback");
  const verifier = form.get("code_verifier") ?? "";
  assert.ok(verifier.length >= 43 && verifier.length <= 128);
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  assert.equal(
    new URL(authorization.authorizationUrl).searchParams.get("code_challenge"),
    challenge,
  );

  assert.equal(credential.refreshGeneration, 0);
  assert.equal(
    Date.parse(credential.accessExpiresAt) - Date.parse(credential.issuedAt),
    LINEAR_OAUTH_DEFAULT_ACCESS_TOKEN_SECONDS * 1_000,
  );
  assert.equal(JSON.stringify(credential).includes(accessToken), false);
  assert.equal(JSON.stringify(credential).includes(refreshToken), false);
  assert.deepEqual(parseLinearOAuthCredentialV1(JSON.parse(JSON.stringify(credential))), credential);
  const accessLease = await client.leaseAccessToken(credential);
  assert.equal(await accessLease.withSecret(async (secret) => secret), accessToken);
  accessLease.dispose();
  assert.equal(JSON.stringify(store).includes(accessToken), false);
});

test("successful refresh rotation commits both new references before retiring old references", async () => {
  const oldAccess = "linear-old-access-token-fixture";
  const oldRefresh = "linear-old-refresh-token-fixture";
  const newAccess = "linear-new-access-token-fixture";
  const newRefresh = "linear-new-refresh-token-fixture";
  const requests: HttpRequest[] = [];
  const responses = [
    tokenResponse(oldAccess, oldRefresh),
    tokenResponse(newAccess, newRefresh, 7_200),
  ];
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    return responses.shift() ?? jsonResponse({});
  };
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const credential = await exchangeFixture(client);
  const oldAccessReference = credential.accessTokenReferenceId;
  const oldRefreshReference = credential.refreshTokenReferenceId;
  const result = await client.refresh(credential);

  assert.equal(result.status, "rotated");
  if (result.status !== "rotated") assert.fail("Expected rotated result.");
  assert.equal(result.credential.refreshGeneration, 1);
  assert.notEqual(result.credential.accessTokenReferenceId, oldAccessReference);
  assert.notEqual(result.credential.refreshTokenReferenceId, oldRefreshReference);
  assert.deepEqual(result.cleanupRequiredReferenceIds, []);
  const form = new URLSearchParams(String(requests[1]?.body));
  assert.equal(form.get("grant_type"), "refresh_token");
  assert.equal(form.get("refresh_token"), oldRefresh);
  await assert.rejects(() => store.describe(oldAccessReference));
  await assert.rejects(() => store.describe(oldRefreshReference));
  const lease = await client.leaseAccessToken(result.credential);
  assert.equal(await lease.withSecret(async (secret) => secret), newAccess);
  lease.dispose();
});

test("host may defer old-reference retirement until durable rotation state is persisted", async () => {
  let call = 0;
  const transport: HttpTransport = async () => {
    call += 1;
    return call === 1
      ? tokenResponse("linear-old-access-deferred", "linear-old-refresh-deferred")
      : tokenResponse("linear-new-access-deferred", "linear-new-refresh-deferred");
  };
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const credential = await exchangeFixture(client);
  const result = await client.refresh(credential, { deferRetirement: true });

  assert.equal(result.status, "rotated");
  if (result.status !== "rotated") assert.fail("Expected rotated result.");
  assert.deepEqual(result.cleanupRequiredReferenceIds, [
    credential.accessTokenReferenceId,
    credential.refreshTokenReferenceId,
  ]);
  assert.ok(await store.describe(credential.accessTokenReferenceId));
  assert.ok(await store.describe(credential.refreshTokenReferenceId));
  assert.ok(await store.describe(result.credential.accessTokenReferenceId));
  assert.ok(await store.describe(result.credential.refreshTokenReferenceId));
});

test("ambiguous refresh persists only redacted reconciliation state and replays within 30 minutes", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  const oldRefresh = "linear-old-refresh-token-for-replay";
  const requests: HttpRequest[] = [];
  let call = 0;
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    call += 1;
    if (call === 1) return tokenResponse("linear-old-access-for-replay", oldRefresh);
    if (call === 2) throw new Error(`socket failed after ${oldRefresh}`);
    return tokenResponse("linear-reconciled-access-token", "linear-reconciled-refresh-token");
  };
  const store = new InMemorySecretStoreV1({
    now: () => now,
    randomBytes: sequenceRandom(),
  });
  const client = createClient({ transport, store, now: () => now });
  const credential = await exchangeFixture(client);
  const uncertain = await client.refresh(credential);

  assert.equal(uncertain.status, "reconcile_required");
  if (uncertain.status !== "reconcile_required") assert.fail("Expected pending refresh.");
  assert.equal(uncertain.pending.attempts, 1);
  assert.equal(
    Date.parse(uncertain.pending.replayGraceExpiresAt) -
      Date.parse(uncertain.pending.firstAttemptAt),
    LINEAR_OAUTH_REFRESH_REPLAY_GRACE_MS,
  );
  const serialized = JSON.stringify(uncertain.pending);
  assert.equal(serialized.includes(oldRefresh), false);
  assert.equal(serialized.includes("socket failed"), false);
  assert.deepEqual(
    parsePendingLinearOAuthRefreshV1(JSON.parse(serialized)),
    uncertain.pending,
  );

  now = new Date("2026-01-01T00:29:59.000Z");
  const reconciled = await client.reconcileRefresh(credential, uncertain.pending);
  assert.equal(reconciled.status, "rotated");
  assert.equal(
    new URLSearchParams(String(requests[2]?.body)).get("refresh_token"),
    oldRefresh,
  );
});

test("refresh replay is blocked at the 30-minute grace boundary", async () => {
  let now = new Date("2026-01-01T00:00:00.000Z");
  let call = 0;
  const transport: HttpTransport = async () => {
    call += 1;
    if (call === 1) {
      return tokenResponse("linear-old-access-expiry", "linear-old-refresh-expiry");
    }
    throw new Error("ambiguous timeout");
  };
  const store = new InMemorySecretStoreV1({ now: () => now, randomBytes: sequenceRandom() });
  const client = createClient({ transport, store, now: () => now });
  const credential = await exchangeFixture(client);
  const uncertain = await client.refresh(credential);
  if (uncertain.status !== "reconcile_required") assert.fail("Expected pending refresh.");

  now = new Date("2026-01-01T00:30:00.000Z");
  await assert.rejects(
    () => client.reconcileRefresh(credential, uncertain.pending),
    hasOAuthCode("linear_oauth_refresh_grace_expired"),
  );
  assert.equal(call, 2);
});

test("a successful but malformed refresh response enters replay reconciliation", async () => {
  let call = 0;
  const transport: HttpTransport = async () => {
    call += 1;
    if (call === 1) {
      return tokenResponse("linear-old-access-malformed", "linear-old-refresh-malformed");
    }
    return jsonResponse({
      access_token: "linear-provider-may-have-rotated",
      token_type: "Bearer",
      expires_in: 86_400,
    });
  };
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const credential = await exchangeFixture(client);
  const result = await client.refresh(credential);

  assert.equal(result.status, "reconcile_required");
  if (result.status !== "reconcile_required") assert.fail("Expected reconciliation.");
  assert.equal(result.pending.lastError.code, "linear_oauth_refresh_ambiguous");
  assert.ok(await store.describe(credential.refreshTokenReferenceId));
  assert.equal(JSON.stringify(result).includes("linear-provider-may-have-rotated"), false);
});

test("refresh token-pair commit is atomic and retains the old reference on secure-store failure", async () => {
  let call = 0;
  const transport: HttpTransport = async () => {
    call += 1;
    return call === 1
      ? tokenResponse("linear-old-access-commit", "linear-old-refresh-commit")
      : tokenResponse("linear-new-access-commit", "linear-new-refresh-commit");
  };
  const delegate = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const store = new FailNthPutSecretStore(delegate, 4);
  const client = createClient({ transport, store });
  const credential = await exchangeFixture(client);
  const result = await client.refresh(credential);

  assert.equal(result.status, "reconcile_required");
  if (result.status !== "reconcile_required") assert.fail("Expected reconciliation.");
  assert.equal(result.pending.lastError.code, "linear_oauth_secret_commit_failed");
  assert.ok(await store.describe(credential.accessTokenReferenceId));
  assert.ok(await store.describe(credential.refreshTokenReferenceId));
  assert.ok(store.lastSuccessfulReferenceId);
  await assert.rejects(() => store.describe(store.lastSuccessfulReferenceId));
});

test("revoke sends only the leased token field and removes the confirmed local reference", async () => {
  const access = "linear-access-token-for-revoke";
  const refresh = "linear-refresh-token-for-revoke";
  const requests: HttpRequest[] = [];
  let call = 0;
  const transport: HttpTransport = async (request) => {
    requests.push(request);
    call += 1;
    return call === 1 ? tokenResponse(access, refresh) : { status: 204, headers: {} };
  };
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const credential = await exchangeFixture(client);
  const result = await client.revoke(credential, "refresh");

  assert.deepEqual(result, { revoked: ["refresh"] });
  assert.equal(requests[1]?.url, LINEAR_OAUTH_REVOKE_ENDPOINT);
  assert.deepEqual(
    [...new URLSearchParams(String(requests[1]?.body)).entries()],
    [["token", refresh]],
  );
  await assert.rejects(() => store.describe(credential.refreshTokenReferenceId));
  assert.ok(await store.describe(credential.accessTokenReferenceId));
});

test("OAuth failures redact provider bodies and token-shaped transport errors", async () => {
  const leaked = "linear-secret-must-not-escape-error";
  const transport: HttpTransport = async () => ({
    status: 400,
    headers: {},
    json: { error: "invalid_grant", error_description: leaked },
    text: JSON.stringify({ token: leaked }),
  });
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const client = createClient({ transport, store });
  const { grant } = await authorize(client);

  await assert.rejects(
    () => client.exchangeCode(grant),
    (error: unknown) => {
      assert.ok(error instanceof LinearOAuthErrorV1);
      assert.equal(error.code, "linear_oauth_http");
      assert.equal(JSON.stringify(error).includes(leaked), false);
      assert.equal(error.stack?.includes(leaked) ?? false, false);
      return true;
    },
  );
});

function createClient(input: {
  transport: HttpTransport;
  store: SecretStoreV1;
  now?: () => Date;
}): LinearOAuthClientV1 {
  const random = sequenceRandom();
  const sessionManager = new LinearOAuthSessionManagerV1({
    randomBytes: random,
    now: input.now,
  });
  return new LinearOAuthClientV1({
    clientId: "linear-client-fixture",
    transport: input.transport,
    secretStore: input.store,
    sessionManager,
    randomBytes: random,
    now: input.now,
  });
}

async function authorize(client: LinearOAuthClientV1) {
  const request = await client.beginAuthorization({
    actor: "user",
    scopes: ["read", "write"],
    callback: CALLBACK,
  });
  const state = new URL(request.authorizationUrl).searchParams.get("state") ?? "";
  const grant = client.completeCallback({
    sessionId: request.sessionId,
    callbackUrl: `${request.redirectUri}?code=authorization-code-fixture&state=${state}`,
  });
  return { request, grant };
}

async function exchangeFixture(client: LinearOAuthClientV1) {
  const { grant } = await authorize(client);
  return client.exchangeCode(grant);
}

function tokenResponse(
  accessToken: string,
  refreshToken: string,
  expiresIn = 86_400,
): HttpResponse {
  return jsonResponse({
    access_token: accessToken,
    refresh_token: refreshToken,
    token_type: "Bearer",
    expires_in: expiresIn,
  });
}

function jsonResponse(json: unknown): HttpResponse {
  return { status: 200, headers: { "cache-control": "no-store" }, json };
}

function sequenceRandom(): (length: number) => Uint8Array {
  let cursor = 0;
  return (length) => Uint8Array.from(
    { length },
    (_, index) => (cursor + index + 1) % 251,
  ).map((value) => {
    cursor = (cursor + 1) % 251;
    return value;
  });
}

function hasOAuthCode(
  code: LinearOAuthErrorV1["code"],
): (error: unknown) => boolean {
  return (error) => error instanceof LinearOAuthErrorV1 && error.code === code;
}

class FailNthPutSecretStore implements SecretStoreV1 {
  readonly version = 1 as const;
  private putCount = 0;
  lastSuccessfulReferenceId = "";

  constructor(
    private readonly delegate: SecretStoreV1,
    private readonly failAt: number,
  ) {}

  health(): Promise<SecretStoreHealthV1> {
    return this.delegate.health();
  }

  async put(input: SecretPutInputV1): Promise<SecretDescriptionV1> {
    this.putCount += 1;
    if (this.putCount === this.failAt) throw new Error("secure backend unavailable");
    const description = await this.delegate.put(input);
    this.lastSuccessfulReferenceId = description.referenceId;
    return description;
  }

  describe(referenceId: string): Promise<SecretDescriptionV1> {
    return this.delegate.describe(referenceId);
  }

  lease(referenceId: string, input?: SecretLeaseInputV1): Promise<SecretLeaseV1> {
    return this.delegate.lease(referenceId, input);
  }

  remove(referenceId: string): Promise<boolean> {
    return this.delegate.remove(referenceId);
  }
}
