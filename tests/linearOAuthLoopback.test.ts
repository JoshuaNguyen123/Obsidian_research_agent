import assert from "node:assert/strict";
import { createRequire } from "node:module";
import net from "node:net";
import test from "node:test";

import {
  LINEAR_OAUTH_LOOPBACK_HOST,
  LINEAR_OAUTH_LOOPBACK_PATH,
  LinearOAuthLoopbackErrorV1,
  beginLinearOAuthLoopbackV1,
} from "../src/integrations/linear";

const runtimeRequire = createRequire(import.meta.url);

test("Linear OAuth loopback binds an ephemeral IPv4 listener and returns a secret-free response", async () => {
  const listener = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    timeoutMs: 2_000,
  });
  assert.deepEqual(listener.callback, {
    host: LINEAR_OAUTH_LOOPBACK_HOST,
    port: listener.callback.port,
    path: LINEAR_OAUTH_LOOPBACK_PATH,
  });
  assert.ok(listener.callback.port > 0);
  assert.equal(
    listener.redirectUri,
    `http://127.0.0.1:${listener.callback.port}/oauth/linear/callback`,
  );

  const code = "oauth-secret-code-fixture";
  const state = "oauth-secret-state-fixture";
  const response = await request({
    port: listener.callback.port,
    path: `${LINEAR_OAUTH_LOOPBACK_PATH}?code=${code}&state=${state}`,
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.equal(response.headers["cache-control"], "no-store");
  assert.equal(response.headers["referrer-policy"], "no-referrer");
  assert.doesNotMatch(response.body, /oauth-secret/u);
  assert.match(response.body, /return to Obsidian/u);

  assert.equal(
    await listener.callbackUrl,
    `${listener.redirectUri}?code=${code}&state=${state}`,
  );
  await listener.close();
  await assert.rejects(
    request({ port: listener.callback.port, path: `${LINEAR_OAUTH_LOOPBACK_PATH}?code=x&state=y` }),
  );
});

test("Linear OAuth loopback binds the exact configured application callback port", async () => {
  const port = await findAvailableLoopbackPort();
  const listener = await beginLinearOAuthLoopbackV1({
    port,
    requireImpl: runtimeRequire,
    timeoutMs: 2_000,
  });
  assert.equal(listener.callback.port, port);
  assert.equal(
    listener.redirectUri,
    `http://127.0.0.1:${port}${LINEAR_OAUTH_LOOPBACK_PATH}`,
  );

  const path = `${LINEAR_OAUTH_LOOPBACK_PATH}?code=fixed-port-code&state=fixed-port-state`;
  assert.equal((await request({ port, path })).status, 200);
  assert.equal(await listener.callbackUrl, `${listener.redirectUri}?code=fixed-port-code&state=fixed-port-state`);

  await assert.rejects(
    beginLinearOAuthLoopbackV1({ port: 1_023, requireImpl: runtimeRequire }),
    hasCode("linear_oauth_loopback_invalid_input"),
  );
  await assert.rejects(
    beginLinearOAuthLoopbackV1({ port: 65_536, requireImpl: runtimeRequire }),
    hasCode("linear_oauth_loopback_invalid_input"),
  );
});

test("Linear OAuth loopback fails closed when the configured port is already occupied", async () => {
  const occupied = net.createServer();
  await new Promise<void>((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, LINEAR_OAUTH_LOOPBACK_HOST, resolve);
  });
  const address = occupied.address();
  assert.ok(address && typeof address !== "string");
  try {
    await assert.rejects(
      beginLinearOAuthLoopbackV1({
        port: address.port,
        requireImpl: runtimeRequire,
        timeoutMs: 2_000,
      }),
      hasCode("linear_oauth_loopback_listen_failed"),
    );
  } finally {
    await new Promise<void>((resolve, reject) => occupied.close((error) => {
      if (error) reject(error);
      else resolve();
    }));
  }
});

test("invalid host, method, path, and bounded-query traffic does not consume the callback", async () => {
  const listener = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    timeoutMs: 3_000,
  });
  const port = listener.callback.port;

  assert.equal((await request({
    port,
    path: `${LINEAR_OAUTH_LOOPBACK_PATH}?code=valid-code&state=valid-state`,
    hostHeader: `localhost:${port}`,
  })).status, 400);
  assert.equal((await request({
    port,
    method: "POST",
    path: `${LINEAR_OAUTH_LOOPBACK_PATH}?code=valid-code&state=valid-state`,
  })).status, 405);
  assert.equal((await request({
    port,
    path: `/oauth/linear/wrong?code=valid-code&state=valid-state`,
  })).status, 404);
  assert.equal((await request({
    port,
    path: LINEAR_OAUTH_LOOPBACK_PATH,
  })).status, 400);
  assert.equal((await request({
    port,
    path: `${LINEAR_OAUTH_LOOPBACK_PATH}?${new URLSearchParams(
      Array.from({ length: 9 }, (_, index) => [`field${index}`, "x"]),
    )}`,
  })).status, 400);

  const validPath = `${LINEAR_OAUTH_LOOPBACK_PATH}?code=valid-code&state=valid-state`;
  assert.equal((await request({ port, path: validPath })).status, 200);
  assert.equal(await listener.callbackUrl, `${listener.redirectUri}?code=valid-code&state=valid-state`);
});

test("the first exact callback wins and a pipelined duplicate is rejected", async () => {
  const listener = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    timeoutMs: 2_000,
  });
  const port = listener.callback.port;
  const host = `127.0.0.1:${port}`;
  const first = `${LINEAR_OAUTH_LOOPBACK_PATH}?code=first-code&state=first-state`;
  const duplicate = `${LINEAR_OAUTH_LOOPBACK_PATH}?code=second-code&state=second-state`;
  const rawResponse = await pipelinedRequests(port, [
    `GET ${first} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\n\r\n`,
    `GET ${duplicate} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`,
  ]);

  assert.match(rawResponse, /HTTP\/1\.1 200 OK/u);
  assert.match(rawResponse, /HTTP\/1\.1 409 Conflict/u);
  assert.equal(await listener.callbackUrl, `${listener.redirectUri}?code=first-code&state=first-state`);
});

test("timeout, abort, explicit close, and missing desktop runtime fail closed", async () => {
  const preAbortedController = new AbortController();
  preAbortedController.abort();
  await assert.rejects(
    beginLinearOAuthLoopbackV1({
      requireImpl: runtimeRequire,
      signal: preAbortedController.signal,
    }),
    hasCode("linear_oauth_loopback_aborted"),
  );

  const timedOut = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    timeoutMs: 15,
  });
  await assert.rejects(
    timedOut.callbackUrl,
    hasCode("linear_oauth_loopback_timeout"),
  );
  await timedOut.close();

  const controller = new AbortController();
  const aborted = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    signal: controller.signal,
    timeoutMs: 2_000,
  });
  controller.abort();
  await assert.rejects(
    aborted.callbackUrl,
    hasCode("linear_oauth_loopback_aborted"),
  );
  await aborted.close();

  const closed = await beginLinearOAuthLoopbackV1({
    requireImpl: runtimeRequire,
    timeoutMs: 2_000,
  });
  const closedResult = assert.rejects(
    closed.callbackUrl,
    hasCode("linear_oauth_loopback_closed"),
  );
  await closed.close();
  await closedResult;

  await assert.rejects(
    beginLinearOAuthLoopbackV1({
      requireImpl: () => {
        throw new Error("runtime unavailable");
      },
    }),
    hasCode("linear_oauth_loopback_unavailable"),
  );
});

function request(input: {
  port: number;
  path: string;
  method?: string;
  hostHeader?: string;
}): Promise<{
  status: number | undefined;
  headers: import("node:http").IncomingHttpHeaders;
  body: string;
}> {
  const http = runtimeRequire("node:http") as typeof import("node:http");
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: LINEAR_OAUTH_LOOPBACK_HOST,
      port: input.port,
      path: input.path,
      method: input.method ?? "GET",
      headers: {
        Host: input.hostHeader ?? `${LINEAR_OAUTH_LOOPBACK_HOST}:${input.port}`,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("error", reject);
      response.once("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function pipelinedRequests(port: number, requests: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: LINEAR_OAUTH_LOOPBACK_HOST, port });
    const chunks: Buffer[] = [];
    socket.once("connect", () => socket.write(requests.join("")));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function findAvailableLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, LINEAR_OAUTH_LOOPBACK_HOST, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not reserve a loopback test port."));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

function hasCode(code: LinearOAuthLoopbackErrorV1["code"]): (error: unknown) => boolean {
  return (error) => error instanceof LinearOAuthLoopbackErrorV1 && error.code === code;
}
