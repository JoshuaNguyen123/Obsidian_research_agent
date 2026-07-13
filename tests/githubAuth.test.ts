import assert from "node:assert/strict";
import test from "node:test";

import type { SecretStoreV1 } from "../packages/core-api/src/secretStoreV1";
import { InMemorySecretStoreV1 } from "../packages/headless-runtime/src/secretStoreV1";
import {
  GITHUB_DEVICE_ACCESS_TOKEN_ENDPOINT,
  GITHUB_DEVICE_CODE_ENDPOINT,
  GITHUB_DEVICE_GRANT_TYPE,
  GitHubAuthErrorV1,
  GitHubAuthV1,
  parseGitHubCredentialV1,
} from "../src/integrations/github/GitHubAuth";
import type {
  HttpRequest,
  HttpResponse,
  HttpTransport,
} from "../src/model/types";

const DEVICE_CODE = "github-device-code-that-must-stay-private";
const ACCESS_TOKEN = "gho_access_token_that_must_stay_private";
const PAT = `github_pat_${"A".repeat(40)}`;

test("device flow uses GitHub fixed endpoints and exposes only bounded display state", async () => {
  const requests: HttpRequest[] = [];
  const client = createClient({
    transport: async (request) => {
      requests.push(request);
      return deviceResponse({ interval: 1 });
    },
  }).client;

  const state = await client.beginDeviceFlow(["repo", "read:user"]);

  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.url, GITHUB_DEVICE_CODE_ENDPOINT);
  assert.equal(requests[0]?.method, "POST");
  assert.equal(requests[0]?.contentType, "application/x-www-form-urlencoded");
  assert.deepEqual(requests[0]?.headers, { Accept: "application/json" });
  const form = new URLSearchParams(String(requests[0]?.body));
  assert.equal(form.get("client_id"), "github-client-fixture");
  assert.equal(form.get("scope"), "repo read:user");
  assert.equal(form.has("client_secret"), false);
  assert.equal(state.intervalSeconds, 5);
  assert.equal(state.userCode, "ABCD-1234");
  assert.equal(state.verificationUri, "https://github.com/login/device");
  const serialized = JSON.stringify({ state, client });
  assert.equal(serialized.includes(DEVICE_CODE), false);
  assert.equal(serialized.includes("device_code"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(client)), {
    version: 1,
    redacted: true,
    activeSessions: 1,
  });
});

test("polling enforces the provider interval and slow_down adds five seconds", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const sleeps: number[] = [];
  const requests: HttpRequest[] = [];
  const responses = [
    deviceResponse({ interval: 2 }),
    jsonResponse({ error: "authorization_pending" }),
    jsonResponse({ error: "slow_down" }),
    jsonResponse({ error: "authorization_pending" }),
  ];
  const { client } = createClient({
    transport: async (request) => {
      requests.push(request);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected transport call.");
      return response;
    },
    now: () => new Date(nowMs),
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      nowMs += milliseconds;
    },
  });
  const state = await client.beginDeviceFlow(["repo"]);

  const first = await client.pollDeviceFlow(state.sessionId);
  assert.equal(first.status, "pending");
  if (first.status !== "pending") assert.fail("Expected pending.");
  assert.equal(first.reason, "authorization_pending");
  assert.equal(first.state.intervalSeconds, 5);

  const second = await client.pollDeviceFlow(state.sessionId);
  assert.equal(second.status, "pending");
  if (second.status !== "pending") assert.fail("Expected slow_down.");
  assert.equal(second.reason, "slow_down");
  assert.equal(second.state.intervalSeconds, 10);

  const third = await client.pollDeviceFlow(state.sessionId);
  assert.equal(third.status, "pending");
  assert.deepEqual(sleeps, [5_000, 10_000]);
  assert.equal(requests.length, 4);
  const pollForm = new URLSearchParams(String(requests[1]?.body));
  assert.equal(requests[1]?.url, GITHUB_DEVICE_ACCESS_TOKEN_ENDPOINT);
  assert.equal(pollForm.get("client_id"), "github-client-fixture");
  assert.equal(pollForm.get("device_code"), DEVICE_CODE);
  assert.equal(pollForm.get("grant_type"), GITHUB_DEVICE_GRANT_TYPE);
  assert.equal(pollForm.has("client_secret"), false);
});

test("authorized device tokens are committed by opaque reference and pin /user identity", async () => {
  const seenIdentityTokens: string[] = [];
  const { client, store } = createClient({
    transport: sequenceTransport([
      deviceResponse(),
      jsonResponse({
        access_token: ACCESS_TOKEN,
        token_type: "bearer",
        scope: "repo, read:user",
      }),
    ]),
    validateIdentity: async (token) => {
      seenIdentityTokens.push(token);
      return { id: 123456, login: "octo-user" };
    },
  });
  const state = await client.beginDeviceFlow();
  const result = await client.pollDeviceFlow(state.sessionId);

  assert.equal(result.status, "authorized");
  if (result.status !== "authorized") assert.fail("Expected credential.");
  assert.deepEqual(result.credential.account, { id: 123456, login: "octo-user" });
  assert.deepEqual(result.credential.scopes, ["repo", "read:user"]);
  assert.match(result.credential.tokenReferenceId, /^secret_/);
  assert.deepEqual(
    parseGitHubCredentialV1(JSON.parse(JSON.stringify(result.credential))),
    result.credential,
  );
  assert.deepEqual(seenIdentityTokens, [ACCESS_TOKEN]);
  const description = await store.describe(result.credential.tokenReferenceId);
  assert.equal(description.metadata.provider, "github");
  assert.equal(description.metadata.credentialKind, "oauth_device");
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(ACCESS_TOKEN), false);
  assert.equal(serialized.includes(DEVICE_CODE), false);

  let leased = "";
  await client.withCredentialToken(result.credential, async (token) => {
    leased = token;
  });
  assert.equal(leased, ACCESS_TOKEN);
});

for (const fixture of [
  ["expired_token", "github_auth_expired"],
  ["access_denied", "github_auth_access_denied"],
  ["device_flow_disabled", "github_auth_device_flow_disabled"],
] as const) {
  test(`device flow handles ${fixture[0]} without provider text`, async () => {
    const leaked = `${ACCESS_TOKEN}-${fixture[0]}`;
    const { client } = createClient({
      transport: sequenceTransport([
        deviceResponse(),
        jsonResponse(
          { error: fixture[0], error_description: leaked },
          fixture[0] === "device_flow_disabled" ? 400 : 200,
        ),
      ]),
    });
    const state = await client.beginDeviceFlow();
    await assert.rejects(
      () => client.pollDeviceFlow(state.sessionId),
      (error: unknown) => {
        assert.ok(error instanceof GitHubAuthErrorV1);
        assert.equal(error.code, fixture[1]);
        assert.equal(error.message.includes(leaked), false);
        assert.equal(error.stack?.includes(leaked) ?? false, false);
        return true;
      },
    );
    assert.equal(client.toJSON().activeSessions, 0);
  });
}

test("fine-grained PAT import stores first, verifies identity, and returns no plaintext", async () => {
  let validatedToken = "";
  const { client, store } = createClient({
    validateIdentity: async (token) => {
      validatedToken = token;
      return { id: 42, login: "pat-owner" };
    },
  });
  const credential = await client.importFineGrainedPat(PAT);

  assert.equal(validatedToken, PAT);
  assert.equal(credential.credentialKind, "fine_grained_pat");
  assert.deepEqual(credential.account, { id: 42, login: "pat-owner" });
  assert.equal(JSON.stringify(credential).includes(PAT), false);
  const description = await store.describe(credential.tokenReferenceId);
  assert.equal(description.metadata.credentialKind, "fine_grained_pat");
  assert.equal(await client.removeCredential(credential), true);
  await assert.rejects(() => store.describe(credential.tokenReferenceId));
});

test("invalid PAT input never reaches the secret store", async () => {
  const delegate = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  let puts = 0;
  const store: SecretStoreV1 = {
    version: 1,
    health: () => delegate.health(),
    put: async (input) => {
      puts += 1;
      return delegate.put(input);
    },
    describe: (referenceId) => delegate.describe(referenceId),
    lease: (referenceId, input) => delegate.lease(referenceId, input),
    remove: (referenceId) => delegate.remove(referenceId),
  };
  const { client } = createClient({ store });

  await assert.rejects(
    () => client.importFineGrainedPat(`ghp_${"x".repeat(40)}`),
    hasCode("github_auth_invalid_input"),
  );
  assert.equal(puts, 0);
});

test("identity validation failure removes the just-stored token and redacts callback errors", async () => {
  const leaked = ACCESS_TOKEN;
  const delegate = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  let referenceId = "";
  const store: SecretStoreV1 = {
    version: 1,
    health: () => delegate.health(),
    put: async (input) => {
      const result = await delegate.put(input);
      referenceId = result.referenceId;
      return result;
    },
    describe: (id) => delegate.describe(id),
    lease: (id, input) => delegate.lease(id, input),
    remove: (id) => delegate.remove(id),
  };
  const { client } = createClient({
    store,
    validateIdentity: async () => {
      throw new Error(`provider echoed ${leaked}`);
    },
  });

  await assert.rejects(
    () => client.importFineGrainedPat(PAT),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAuthErrorV1);
      assert.equal(error.code, "github_auth_identity_validation_failed");
      assert.equal(error.message.includes(leaked), false);
      assert.equal(error.stack?.includes(leaked) ?? false, false);
      return true;
    },
  );
  assert.ok(referenceId);
  await assert.rejects(() => store.describe(referenceId));
});

test("device sessions expire and an in-flight interval wait is cancellable", async () => {
  let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const responses = [
    deviceResponse({ expires_in: 60 }),
    jsonResponse({ error: "authorization_pending" }),
  ];
  const { client } = createClient({
    transport: sequenceTransport(responses),
    now: () => new Date(nowMs),
    sleep: (_milliseconds, signal) =>
      new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("cancelled")), {
          once: true,
        });
      }),
  });
  const state = await client.beginDeviceFlow();
  await client.pollDeviceFlow(state.sessionId);

  const waitingPoll = client.pollDeviceFlow(state.sessionId);
  await Promise.resolve();
  assert.equal(client.cancelDeviceFlow(state.sessionId), true);
  await assert.rejects(waitingPoll, hasCode("github_auth_cancelled"));
  assert.equal(client.toJSON().activeSessions, 0);

  const expiring = createClient({
    transport: async () => deviceResponse({ expires_in: 60 }),
    now: () => new Date(nowMs),
  }).client;
  const expiringState = await expiring.beginDeviceFlow();
  nowMs += 60_000;
  await assert.rejects(
    () => expiring.pollDeviceFlow(expiringState.sessionId),
    hasCode("github_auth_expired"),
  );
});

test("cancelling an in-flight provider poll cannot commit a late token response", async () => {
  let releaseToken!: (response: HttpResponse) => void;
  let calls = 0;
  const store = new InMemorySecretStoreV1({ randomBytes: sequenceRandom() });
  const { client } = createClient({
    store,
    transport: async () => {
      calls += 1;
      if (calls === 1) return deviceResponse();
      return new Promise<HttpResponse>((resolve) => {
        releaseToken = resolve;
      });
    },
  });
  const state = await client.beginDeviceFlow();
  const polling = client.pollDeviceFlow(state.sessionId);
  while (!releaseToken) await Promise.resolve();

  assert.equal(client.cancelDeviceFlow(state.sessionId), true);
  releaseToken(jsonResponse({
    access_token: ACCESS_TOKEN,
    token_type: "bearer",
    scope: "repo",
  }));
  await assert.rejects(polling, hasCode("github_auth_cancelled"));
  assert.equal(client.toJSON().activeSessions, 0);
});

test("transport and leased callback failures cannot expose token-shaped errors", async () => {
  const { client } = createClient({
    transport: async () => {
      throw new Error(`socket failed with ${ACCESS_TOKEN}`);
    },
  });
  await assert.rejects(
    () => client.beginDeviceFlow(),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAuthErrorV1);
      assert.equal(error.code, "github_auth_network");
      assert.equal(JSON.stringify(error).includes(ACCESS_TOKEN), false);
      assert.equal(error.stack?.includes(ACCESS_TOKEN) ?? false, false);
      return true;
    },
  );

  const ready = createClient().client;
  const credential = await ready.importFineGrainedPat(PAT);
  await assert.rejects(
    () => ready.withCredentialToken(credential, async (token) => {
      throw new Error(`callback leaked ${token}`);
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubAuthErrorV1);
      assert.equal(error.code, "github_auth_secret_store_failed");
      assert.equal(error.message.includes(PAT), false);
      assert.equal(error.stack?.includes(PAT) ?? false, false);
      return true;
    },
  );
});

function createClient(input: {
  transport?: HttpTransport;
  store?: SecretStoreV1;
  validateIdentity?: (token: string, signal?: AbortSignal) => Promise<unknown>;
  now?: () => Date;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
} = {}) {
  const store = input.store ?? new InMemorySecretStoreV1({
    randomBytes: sequenceRandom(),
    now: input.now,
  });
  const client = new GitHubAuthV1({
    clientId: "github-client-fixture",
    transport: input.transport ?? (async () => deviceResponse()),
    secretStore: store,
    validateIdentity: input.validateIdentity ?? (async () => ({
      id: 1,
      login: "octocat",
    })),
    now: input.now,
    sleep: input.sleep,
    randomBytes: sequenceRandom(),
  });
  return { client, store };
}

function deviceResponse(overrides: Record<string, unknown> = {}): HttpResponse {
  return jsonResponse({
    device_code: DEVICE_CODE,
    user_code: "ABCD-1234",
    verification_uri: "https://github.com/login/device",
    expires_in: 900,
    interval: 5,
    ...overrides,
  });
}

function jsonResponse(json: unknown, status = 200): HttpResponse {
  return { status, headers: {}, json, text: JSON.stringify(json) };
}

function sequenceTransport(responses: HttpResponse[]): HttpTransport {
  return async () => {
    const response = responses.shift();
    if (!response) throw new Error("Unexpected transport call.");
    return response;
  };
}

function sequenceRandom(): (length: number) => Uint8Array {
  let next = 1;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = next % 256;
      next += 1;
    }
    return bytes;
  };
}

function hasCode(
  code: GitHubAuthErrorV1["code"],
): (error: unknown) => boolean {
  return (error) => error instanceof GitHubAuthErrorV1 && error.code === code;
}
