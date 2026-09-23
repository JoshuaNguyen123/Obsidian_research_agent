import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import zlib from "node:zlib";

import type { HttpTransport } from "../src/model/types";
import {
  createNodePublicFetchTransportV1,
  guardedLookupV1,
  type NodeLookupV1,
} from "../src/tools/nodePublicFetchTransport";
import {
  fetchPublicUrlV1,
  looksBinaryV1,
  PublicFetchErrorV1,
  type PublicFetchHopRequestV1,
  type PublicFetchHopResponseV1,
} from "../src/tools/publicFetch";

/**
 * `requestUrl` followed redirects and hid the final URL, so the host policy
 * judged only the URL the model asked for. A public page answering
 * `302 Location: http://127.0.0.1:8765/` reached the companion. These tests
 * drive every redirect target through `new URL()` resolution, the way the
 * loop receives them, and assert the private host is never requested at all.
 */

const unusedHttp: HttpTransport = async () => {
  throw new Error("the plain transport must not be used when a hop transport is supplied");
};

function scriptedHops(script: Record<string, PublicFetchHopResponseV1 | Error>) {
  const requested: string[] = [];
  const hop = async (request: PublicFetchHopRequestV1): Promise<PublicFetchHopResponseV1> => {
    requested.push(request.url);
    const answer = script[request.url];
    if (!answer) throw new Error(`unscripted hop: ${request.url}`);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { hop, requested };
}

const redirect = (location: string, status = 302): PublicFetchHopResponseV1 => ({
  status,
  headers: { location },
  bytes: new Uint8Array(0),
  truncated: false,
});
const page = (text: string): PublicFetchHopResponseV1 => ({
  status: 200,
  headers: { "content-type": "text/html" },
  bytes: new TextEncoder().encode(text),
  truncated: false,
});

function fetchWith(hop: (r: PublicFetchHopRequestV1) => Promise<PublicFetchHopResponseV1>, url: string) {
  return fetchPublicUrlV1({
    url,
    hopTransport: hop,
    httpTransport: unusedHttp,
    headers: {},
    timeoutMs: 5_000,
    maxBytes: 1_000_000,
    retryDelaysMs: [0, 0],
  });
}

for (const target of [
  "http://127.0.0.1:8765/v1/documents/extract",
  "http://169.254.169.254/latest/meta-data/",
  "http://[::ffff:127.0.0.1]/",
  "http://2130706433/",
  "http://localhost/",
  "http://printer.local/",
  "http://10.0.0.5/admin",
]) {
  test(`a redirect to ${target} is refused before it is requested`, async () => {
    const { hop, requested } = scriptedHops({
      "https://public.example/article": redirect(target),
    });
    await assert.rejects(
      () => fetchWith(hop, "https://public.example/article"),
      (error: unknown) =>
        error instanceof PublicFetchErrorV1 && error.code === "redirect_to_private_host",
    );
    assert.deepEqual(requested, ["https://public.example/article"]);
  });
}

test("a relative redirect to another public path is followed and reported", async () => {
  const { hop, requested } = scriptedHops({
    "https://public.example/old": redirect("/new?x=1", 301),
    "https://public.example/new?x=1": page("<p>moved here</p>"),
  });
  const result = await fetchWith(hop, "https://public.example/old");
  assert.equal(result.status, 200);
  assert.equal(result.finalUrl, "https://public.example/new?x=1");
  assert.deepEqual(result.redirects, ["https://public.example/new?x=1"]);
  assert.equal(result.redirectsChecked, true);
  assert.deepEqual(requested, ["https://public.example/old", "https://public.example/new?x=1"]);
});

test("a chain of redirects ends at the limit", async () => {
  const script: Record<string, PublicFetchHopResponseV1> = {};
  for (let index = 0; index < 10; index += 1) {
    script[`https://public.example/${index}`] = redirect(`/${index + 1}`);
  }
  const { hop, requested } = scriptedHops(script);
  await assert.rejects(
    () => fetchWith(hop, "https://public.example/0"),
    (error: unknown) => error instanceof PublicFetchErrorV1 && error.code === "too_many_redirects",
  );
  assert.equal(requested.length, 6, "the first request plus five redirects");
});

test("a redirect to a non-HTTP scheme is refused", async () => {
  const { hop } = scriptedHops({ "https://public.example/a": redirect("file:///etc/passwd") });
  await assert.rejects(
    () => fetchWith(hop, "https://public.example/a"),
    (error: unknown) =>
      error instanceof PublicFetchErrorV1 && error.code === "unsupported_redirect_scheme",
  );
});

test("a transient status is retried, a refusal is not", async () => {
  let calls = 0;
  const flaky = async (): Promise<PublicFetchHopResponseV1> => {
    calls += 1;
    return calls === 1
      ? { status: 503, headers: {}, bytes: new Uint8Array(0), truncated: false }
      : page("<p>ok</p>");
  };
  const ok = await fetchWith(flaky, "https://public.example/flaky");
  assert.equal(ok.status, 200);
  assert.equal(calls, 2);

  let refusals = 0;
  const refusing = async (): Promise<PublicFetchHopResponseV1> => {
    refusals += 1;
    throw new PublicFetchErrorV1("resolved_private_address", "resolves to 10.0.0.1");
  };
  await assert.rejects(
    () => fetchWith(refusing, "https://public.example/rebind"),
    (error: unknown) =>
      error instanceof PublicFetchErrorV1 && error.code === "resolved_private_address",
  );
  assert.equal(refusals, 1, "a refusal is a verdict, not a transient failure");
});

test("without a hop transport the result admits redirects were not checked", async () => {
  const result = await fetchPublicUrlV1({
    url: "https://public.example/page",
    httpTransport: async () => ({
      status: 200,
      headers: { "Content-Type": "text/plain" },
      text: "x".repeat(50),
    }),
    headers: {},
    timeoutMs: 1_000,
    maxBytes: 10,
  });
  assert.equal(result.redirectsChecked, false);
  assert.equal(result.truncated, true);
  assert.equal(result.bytes.byteLength, 10);
});

test("binary sniffing catches unlabelled PDFs, images and NUL bytes", () => {
  const enc = (text: string) => new TextEncoder().encode(text);
  assert.equal(looksBinaryV1(enc("%PDF-1.7\n...")), true);
  assert.equal(looksBinaryV1(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2])), true);
  assert.equal(looksBinaryV1(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(looksBinaryV1(new Uint8Array([0x61, 0x00, 0x62, 0x63])), true);
  assert.equal(looksBinaryV1(enc("<html><body>plain</body></html>")), false);
});

// --- the resolver guard -----------------------------------------------------

const fixedLookup = (answer: string | { address: string; family: number }[]): NodeLookupV1 =>
  (_hostname, _options, callback) => {
    if (Array.isArray(answer)) callback(null, answer);
    else callback(null, answer, answer.includes(":") ? 6 : 4);
  };

function runLookup(lookup: NodeLookupV1, all = false) {
  return new Promise<{ error: unknown; address: unknown }>((resolve) =>
    lookup("any.example", { all }, (error, address) => resolve({ error, address })),
  );
}

test("the resolver guard refuses a public name that resolves to a private address", async () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "fd00::1", "::ffff:7f00:1"]) {
    const { error } = await runLookup(guardedLookupV1(fixedLookup(address)));
    assert.ok(
      error instanceof PublicFetchErrorV1 && error.code === "resolved_private_address",
      `${address} must be refused`,
    );
  }
  const publicAnswer = await runLookup(guardedLookupV1(fixedLookup("93.184.216.34")));
  assert.equal(publicAnswer.error, null);
  assert.equal(publicAnswer.address, "93.184.216.34");
});

test("the resolver guard refuses a mixed answer when any address is private", async () => {
  const { error } = await runLookup(
    guardedLookupV1(
      fixedLookup([
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ]),
    ),
    true,
  );
  assert.ok(error instanceof PublicFetchErrorV1);
});

// --- the real Node transport, against a real local server ---------------------

async function withServer(
  handler: http.RequestListener,
  run: (port: number, hits: () => number) => Promise<void>,
) {
  let count = 0;
  const server = http.createServer((req, res) => {
    count += 1;
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await run((server.address() as AddressInfo).port, () => count);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("the Node transport never connects when the name resolves to loopback", async () => {
  await withServer(
    (_req, res) => res.end("secret companion response"),
    async (port, hits) => {
      const transport = createNodePublicFetchTransportV1({ lookup: fixedLookup("127.0.0.1") });
      await assert.rejects(
        () =>
          fetchPublicUrlV1({
            url: `http://rebind.example:${port}/`,
            hopTransport: transport,
            httpTransport: unusedHttp,
            headers: {},
            timeoutMs: 5_000,
            maxBytes: 1_000,
            retryDelaysMs: [0, 0],
          }),
        (error: unknown) =>
          error instanceof PublicFetchErrorV1 && error.code === "resolved_private_address",
      );
      assert.equal(hits(), 0, "the loopback server must never receive the request");
    },
  );
});

/**
 * The success-path behaviours (no redirect following, streamed cap, gzip) are
 * exercised against a local server by pinning the connection to it: the
 * injected module rewrites the destination, so the policy guard is not what
 * these tests measure — the guard has its own tests above.
 */
function pinnedTransport(port: number) {
  return createNodePublicFetchTransportV1({
    requireModule: (id: string) => {
      if (id !== "http" && id !== "https") return require(id);
      return {
        request: (options: http.RequestOptions, callback: (res: http.IncomingMessage) => void) =>
          http.request({ ...options, protocol: "http:", hostname: "127.0.0.1", port, lookup: undefined }, callback),
      };
    },
  });
}

test("the Node transport returns a redirect instead of following it", async () => {
  await withServer(
    (req, res) => {
      if (req.url === "/start") {
        res.writeHead(302, { Location: "http://127.0.0.1:1/internal" });
        res.end("redirect body is never read");
        return;
      }
      res.end("should not be reached");
    },
    async (port, hits) => {
      const response = await pinnedTransport(port)({
        url: "http://public.example/start",
        headers: {},
        timeoutMs: 5_000,
        maxBytes: 1_000,
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.location, "http://127.0.0.1:1/internal");
      assert.equal(response.bytes.byteLength, 0);
      assert.equal(hits(), 1);
    },
  );
});

test("the Node transport caps a body while it streams, after decompression", async () => {
  const huge = "a".repeat(2_000_000);
  await withServer(
    (req, res) => {
      if (req.url === "/gzip") {
        res.writeHead(200, { "Content-Type": "text/plain", "Content-Encoding": "gzip" });
        res.end(zlib.gzipSync(huge));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello, plain body");
    },
    async (port) => {
      const transport = pinnedTransport(port);
      const plain = await transport({ url: "http://public.example/plain", headers: {}, timeoutMs: 5_000, maxBytes: 1_000 });
      assert.equal(new TextDecoder().decode(plain.bytes), "hello, plain body");
      assert.equal(plain.truncated, false);

      const bomb = await transport({ url: "http://public.example/gzip", headers: {}, timeoutMs: 5_000, maxBytes: 4_096 });
      assert.equal(bomb.truncated, true);
      assert.equal(bomb.bytes.byteLength, 4_096);
      assert.ok(bomb.bytes.every((byte) => byte === 0x61), "decoded bytes, not compressed ones");
    },
  );
});

test("the Node transport times out a server that never answers", async () => {
  await withServer(
    () => {
      // Never respond.
    },
    async (port) => {
      const started = Date.now();
      await assert.rejects(
        () =>
          pinnedTransport(port)({
            url: "http://public.example/hang",
            headers: {},
            timeoutMs: 200,
            maxBytes: 1_000,
          }),
        /timed out/u,
      );
      assert.ok(Date.now() - started < 3_000);
    },
  );
});
