import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  gracefulQuitMayHaveReachedAppV1,
  requestGracefulObsidianQuitV1,
  type GracefulQuitPageLike,
} from "../e2e/fixtures/gracefulObsidianQuit";
import { terminateControlledObsidian } from "../scripts/obsidian-process-lifecycle";

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

test("only a request that provably never reached the app skips the exit wait", () => {
  // "unavailable" is the one outcome a HEALTHY renderer produced: it answered,
  // in full, that @electron/remote is not there to call. Nothing is quitting,
  // so nothing is committing DOMStorage and there is nothing to wait for.
  assert.equal(gracefulQuitMayHaveReachedAppV1("unavailable"), false);
  // Everything else is compatible with a shutdown already in flight. A renderer
  // being unloaded by the very quit we asked for cannot answer the evaluate
  // that asked for it, so its silence is the signature of success.
  for (const outcome of ["dispatched", "failed", "page_closed"] as const) {
    assert.equal(gracefulQuitMayHaveReachedAppV1(outcome), true, outcome);
  }
});

test("the dispatch bound is not the graceful budget — a torn-down dispatch still waits for exit", async () => {
  // THE FORCE-KILL-INTO-SHUTDOWN DEFECT. app.quit() only STARTS the shutdown:
  // before-quit and will-quit run, the renderer unloads, and only then does the
  // browser process commit DOMStorage. The dispatch bound says when to stop
  // waiting for an ANSWER. Reading that timeout as "not delivered" spent the
  // whole graceful budget on the dispatch and fired taskkill /F at ~2s, into
  // the exact commit window that lost a rotated Linear OAuth pair on
  // 2026-09-07. On the unfixed mapping the kill runs here.
  const calls: string[] = [];
  const rendererGoingAway: GracefulQuitPageLike = {
    isClosed: () => false,
    evaluate: (() =>
      new Promise(() => undefined)) as GracefulQuitPageLike["evaluate"],
  };
  await terminateControlledObsidian(
    { pid: 4321, exitCode: null },
    {
      requestGracefulExit: async () =>
        gracefulQuitMayHaveReachedAppV1(
          await requestGracefulObsidianQuitV1(rendererGoingAway, 20),
        ),
      terminateOwnedTree: async () => {
        calls.push("kill");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, ["owned-exit:graceful", "owned-exit:initial"]);
});

test("a renderer that answered 'no bridge' falls straight through to the kill", async () => {
  // The counterpart the fix must not lose: waiting a full owned-exit budget on
  // an app nobody asked to quit is dead time in every teardown of the cohort.
  const calls: string[] = [];
  await terminateControlledObsidian(
    { pid: 4322, exitCode: null },
    {
      requestGracefulExit: async () =>
        gracefulQuitMayHaveReachedAppV1(
          await requestGracefulObsidianQuitV1(
            fakePage({ evaluate: async () => false }),
          ),
        ),
      terminateOwnedTree: async () => {
        calls.push("kill");
      },
      waitForOwnedExit: async (phase) => {
        calls.push(`owned-exit:${phase}`);
        return true;
      },
      waitForNoRunningProcess: async () => true,
      waitForCdpClose: async () => true,
    },
  );
  assert.deepEqual(calls, ["kill", "owned-exit:initial"]);
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

// Both harnesses carried the mapping, and a guard that read only one of them
// is how the sibling seat in this same review survived its own fix. The list
// is derived below rather than written out, so a third harness cannot appear
// without either being checked or making this test fail.
const GRACEFUL_QUIT_CONSUMERS = ["nativeObsidianHarness.ts", "phase4Harness.ts"];

function fixtureSourceWithoutComments(name: string): string {
  return readFileSync(path.join(REPO_ROOT, "e2e", "fixtures", name), "utf8")
    .split(/\r?\n/u)
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
    .join("\n");
}

test("every harness routes the dispatch outcome through the shared predicate", () => {
  // `outcome === "dispatched"` is the mapping that turned the 2s dispatch bound
  // into the whole graceful budget. Neither harness can be unit-driven (both
  // import Playwright), so the mapping is pinned here.
  for (const name of GRACEFUL_QUIT_CONSUMERS) {
    const source = fixtureSourceWithoutComments(name);
    assert.match(source, /gracefulQuitMayHaveReachedAppV1\(/u, name);
    assert.doesNotMatch(source, /=== "dispatched"/u, name);
  }
});

test("the guarded list is every fixture that asks for a graceful quit", () => {
  // A guard is only worth its file list. This derives the list from the
  // fixtures that actually call the dispatcher and demands it match, so a new
  // harness fails here rather than quietly going unchecked.
  const dir = path.join(REPO_ROOT, "e2e", "fixtures");
  const callers = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && name !== "gracefulObsidianQuit.ts")
    .filter((name) =>
      /requestGracefulObsidianQuitV1\(/u.test(fixtureSourceWithoutComments(name)),
    )
    .sort();
  assert.deepEqual(callers, [...GRACEFUL_QUIT_CONSUMERS].sort());
});
