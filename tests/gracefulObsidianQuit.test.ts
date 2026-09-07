import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  requestGracefulObsidianQuitV1,
  type GracefulQuitPageLike,
} from "../e2e/fixtures/gracefulObsidianQuit";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function fakePage(options: {
  closed?: boolean;
  evaluate: (fn: () => unknown) => Promise<unknown>;
}): GracefulQuitPageLike {
  return {
    isClosed: () => options.closed ?? false,
    evaluate: options.evaluate as GracefulQuitPageLike["evaluate"],
  };
}

test("a delivered quit request is reported as dispatched", async () => {
  const outcome = await requestGracefulObsidianQuitV1(
    fakePage({ evaluate: async () => true }),
  );
  assert.equal(outcome, "dispatched");
});

test("a renderer without the remote bridge is reported as unavailable, not failed", async () => {
  const outcome = await requestGracefulObsidianQuitV1(
    fakePage({ evaluate: async () => false }),
  );
  assert.equal(outcome, "unavailable");
});

test("a closed page cannot be asked and never blocks the teardown", async () => {
  assert.equal(await requestGracefulObsidianQuitV1(null), "page_closed");
  assert.equal(
    await requestGracefulObsidianQuitV1(
      fakePage({ closed: true, evaluate: async () => assert.fail("must not evaluate") }),
    ),
    "page_closed",
  );
});

test("an evaluate that hangs is bounded and reported as failed", async () => {
  const outcome = await requestGracefulObsidianQuitV1(
    fakePage({ evaluate: () => new Promise(() => undefined) }),
    20,
  );
  assert.equal(outcome, "failed");
});

test("an evaluate torn down by the quit itself counts as dispatched only once the page is gone", async () => {
  let closed = false;
  const page: GracefulQuitPageLike = {
    isClosed: () => closed,
    evaluate: (async () => {
      closed = true;
      throw new Error("Target page, context or browser has been closed");
    }) as GracefulQuitPageLike["evaluate"],
  };
  assert.equal(await requestGracefulObsidianQuitV1(page), "dispatched");

  const stillOpen = fakePage({
    evaluate: async () => {
      throw new Error("Execution context was destroyed");
    },
  });
  assert.equal(await requestGracefulObsidianQuitV1(stillOpen), "failed");
});

test("the quit request runs through the same bridge the plugin's flusher uses", () => {
  // The renderer-side function must ask for @electron/remote and defer the
  // quit to a macrotask so the evaluate returns before the page dies.
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e", "fixtures", "gracefulObsidianQuit.ts"),
    "utf8",
  );
  assert.match(source, /bridge\("@electron\/remote"\)/u);
  assert.match(source, /setTimeout\(\(\) => quit\.call\(app\), 0\)/u);
});

test("both owned-Obsidian harnesses request a graceful quit before the kill", () => {
  for (const fixture of ["nativeObsidianHarness.ts", "phase4Harness.ts"]) {
    const source = readFileSync(path.join(REPO_ROOT, "e2e", "fixtures", fixture), "utf8")
      .split(/\r?\n/u)
      .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
      .join("\n");
    assert.match(source, /requestGracefulExit:/u, `${fixture} passes requestGracefulExit`);
    assert.match(source, /requestGracefulObsidianQuitV1\(/u, `${fixture} uses the shared request`);
    assert.match(source, /graceful: 10_000/u, `${fixture} bounds the graceful wait`);
  }
});
