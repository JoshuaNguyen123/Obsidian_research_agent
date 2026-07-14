import assert from "node:assert/strict";
import test from "node:test";
import {
  createPublicResearchFetchExecutorV1,
  type CompanionJobV1,
  type PublicResearchFetchDependenciesV1,
} from "../packages/headless-runtime/src";

test("public research fetch pins the validated address and revalidates redirects", async () => {
  const pinned: Array<{ url: string; address: string }> = [];
  const executor = createPublicResearchFetchExecutorV1({
    resolveHost: async (hostname) =>
      hostname === "source.example"
        ? ["93.184.216.35", "93.184.216.34"]
        : ["127.0.0.1"],
    requestPinned: async (url, address) => {
      pinned.push({ url: url.href, address });
      return new Response(null, {
        status: 302,
        headers: { Location: "https://private.example/secret" },
      });
    },
  });

  await assert.rejects(
    executor(job({ url: "https://source.example/start" }), context()),
    /private or non-public destination/u,
  );
  assert.deepEqual(pinned, [
    { url: "https://source.example/start", address: "93.184.216.34" },
  ]);
});

test("public research fetch accepts public IPv6/6to4 and rejects embedded or special ranges", async () => {
  const requested: string[] = [];
  const dependencies: PublicResearchFetchDependenciesV1 = {
    resolveHost: async () => {
      throw new Error("literal addresses must not use DNS");
    },
    requestPinned: async (_url, address) => {
      requested.push(address);
      return new Response("verified source", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    },
  };
  const executor = createPublicResearchFetchExecutorV1(dependencies);

  for (const address of ["2606:4700:4700::1111", "2002:0808:0808::"]) {
    const result = await executor(job({ url: `https://[${address}]/source` }), context());
    assert.equal(result.status, "complete", address);
  }
  assert.deepEqual(requested, ["2606:4700:4700::1111", "2002:808:808::"]);

  for (const address of [
    "::",
    "::1",
    "::ffff:8.8.8.8",
    "::8.8.8.8",
    "64:ff9b::808:808",
    "64:ff9b:1::808:808",
    "2002:0a00:0001::",
    "2001::1",
    "2001:db8::1",
    "fc00::1",
    "fe80::1",
    "ff02::1",
    "3fff::1",
  ]) {
    await assert.rejects(
      executor(job({ url: `https://[${address}]/source` }), context()),
      /private or non-public destination/u,
      address,
    );
  }
});

test("public research fetch rejects secret queries and oversized or binary bodies", async () => {
  let requests = 0;
  const executor = createPublicResearchFetchExecutorV1({
    resolveHost: async () => ["93.184.216.34"],
    requestPinned: async () => {
      requests += 1;
      return new Response(new Uint8Array(1_048_577), {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    },
  });

  for (const key of ["token", "api_key", "password", "authorization", "code"]) {
    await assert.rejects(
      executor(job({ url: `https://source.example/?${key}=sensitive` }), context()),
      /secret-bearing query/u,
    );
  }
  assert.equal(requests, 0);
  await assert.rejects(
    executor(job({ url: "https://source.example/large" }), context()),
    /1 MiB response limit/u,
  );

  const binary = createPublicResearchFetchExecutorV1({
    resolveHost: async () => ["93.184.216.34"],
    requestPinned: async () =>
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
  });
  await assert.rejects(
    binary(job({ url: "https://source.example/binary" }), context()),
    /content type is not text/u,
  );
});

function job(inputs: CompanionJobV1["inputs"]): CompanionJobV1 {
  const now = "2026-07-12T18:00:00.000Z";
  return {
    version: 1,
    id: "public-fetch-job",
    missionId: "public-fetch-mission",
    nodeId: "public-fetch-node",
    graphRevision: 1,
    domain: "research",
    executionHost: "headless_runtime",
    state: "running",
    objective: "Fetch bounded public sources.",
    inputs,
    allowedTools: ["web_fetch"],
    requiredCapabilities: ["web.read"],
    bindings: [],
    capabilityEnvelopeFingerprint: fp("a"),
    authorization: {
      version: 1,
      grantId: "fetch-grant",
      fingerprint: fp("b"),
      authorizedAt: now,
      expiresAt: null,
    },
    idempotencyKey: fp("c"),
    attempts: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function context() {
  return {
    signal: new AbortController().signal,
    now: () => new Date("2026-07-12T18:00:00.000Z"),
    reportProgress: async () => undefined,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
