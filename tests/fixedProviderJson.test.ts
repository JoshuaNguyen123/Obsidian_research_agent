import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ClientRequest } from "node:http";
import type https from "node:https";
import test from "node:test";

import { createFixedProviderJsonRequesterV1 } from "../extensions/companion/FixedProviderJsonV1";
import { createFixedGitHubNodeTransportV1 } from "../extensions/integrations/background/FixedGitHubNodeTransportV1";

test("standalone fixed-provider JSON helper rejects a pre-aborted signal before request creation", async () => {
  let requestCalls = 0;
  const requester = createFixedProviderJsonRequesterV1({
    request: (() => {
      requestCalls += 1;
      throw new Error("request creation must not run");
    }) as typeof https.request,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    requester(
      new URL("https://api.github.com/user"),
      { method: "GET", headers: { Authorization: "Bearer opaque" } },
      controller.signal,
    ),
    /aborted before dispatch/iu,
  );
  assert.equal(requestCalls, 0);
});

test("standalone fixed-provider JSON helper bounds a request that never produces headers", async () => {
  const observed: { destroyedWith: Error | null } = { destroyedWith: null };
  const fakeRequest = new EventEmitter() as ClientRequest;
  fakeRequest.write = (() => true) as ClientRequest["write"];
  fakeRequest.end = (() => fakeRequest) as ClientRequest["end"];
  fakeRequest.destroy = ((error?: Error) => {
    observed.destroyedWith = error ?? new Error("destroyed");
    queueMicrotask(() => fakeRequest.emit("error", observed.destroyedWith));
    return fakeRequest;
  }) as ClientRequest["destroy"];
  const requester = createFixedProviderJsonRequesterV1({
    timeoutMs: 10,
    request: (() => fakeRequest) as typeof https.request,
  });

  await assert.rejects(
    requester(
      new URL("https://api.linear.app/graphql"),
      { method: "POST", headers: {}, body: "{}" },
      new AbortController().signal,
    ),
    /bounded timeout/iu,
  );
  assert.match(observed.destroyedWith?.message ?? "", /bounded timeout/iu);
});

test("fixed GitHub transport rejects a pre-aborted signal before creating a request", async () => {
  let requestCalls = 0;
  const transport = createFixedGitHubNodeTransportV1({
    request: (() => {
      requestCalls += 1;
      throw new Error("request creation must not run");
    }) as typeof https.request,
  });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(transport({
    url: "https://api.github.com/user",
    method: "GET",
    headers: { Authorization: "Bearer opaque-test-token" },
    abortSignal: controller.signal,
    throw: false,
  }), /cancelled before dispatch/iu);
  assert.equal(requestCalls, 0);
});
