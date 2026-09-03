import test from "node:test";
import assert from "node:assert/strict";
import {
  createPythonFastEmbedProvider,
  type HelperChildLike,
  type NodeEmbeddingRuntime,
} from "../src/embeddings/pythonFastEmbedProvider";
import type { AgentSettings } from "../src/settings";
import type { SemanticEmbeddingRequest } from "../src/embeddings/types";

const SETTINGS = {
  semanticPythonCommand: "python-primary",
  semanticModelCacheDir: "cache-dir",
} as AgentSettings;

const REQUEST: SemanticEmbeddingRequest = {
  model: "nomic-ai/nomic-embed-text-v1.5-Q",
  // The fake helper answers with two-dimensional vectors; the provider now
  // refuses any response whose width differs from the request.
  dim: 2,
  documents: ["persistent helper doc"],
  queries: ["persistent helper query"],
};

class FakeChild implements HelperChildLike {
  command: string;
  writes: string[] = [];
  killed = false;
  onWrite: ((line: string) => void) | null = null;
  private stdoutListener: ((chunk: Buffer) => void) | null = null;
  private errorListener: ((error: NodeJS.ErrnoException) => void) | null = null;
  private closeListener: (() => void) | null = null;

  constructor(command: string) {
    this.command = command;
  }

  stdin = {
    write: (chunk: string) => {
      this.writes.push(chunk);
      this.onWrite?.(chunk);
      return true;
    },
    end: () => {},
    on: () => {},
  };

  stdout = {
    on: (_event: "data", listener: (chunk: Buffer) => void) => {
      this.stdoutListener = listener;
    },
  };

  stderr = {
    on: (_event: "data", _listener: (chunk: Buffer) => void) => {},
  };

  on(event: "error" | "close", listener: (...args: never[]) => void) {
    if (event === "error") {
      this.errorListener = listener as (error: NodeJS.ErrnoException) => void;
    } else {
      this.closeListener = listener as () => void;
    }
  }

  kill() {
    this.killed = true;
    queueMicrotask(() => this.closeListener?.());
  }

  emitStdout(text: string) {
    this.stdoutListener?.(Buffer.from(text, "utf8"));
  }

  emitClose() {
    this.closeListener?.();
  }

  emitError(code: string, message: string) {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.code = code;
    this.errorListener?.(error);
  }
}

function respondOk(child: FakeChild) {
  child.onWrite = (line: string) => {
    const request = JSON.parse(line) as {
      id: string;
      model: string;
      dim: number;
    };
    child.emitStdout(
      JSON.stringify({
        id: request.id,
        ok: true,
        model: request.model,
        dim: request.dim,
        documents: [[1, 0]],
        queries: [[0, 1]],
      }) + "\n",
    );
  };
}

function createFakeRuntime(
  onSpawn: (child: FakeChild) => void = respondOk,
): { runtime: NodeEmbeddingRuntime; spawned: FakeChild[] } {
  const spawned: FakeChild[] = [];
  const runtime: NodeEmbeddingRuntime = {
    spawn: (command) => {
      const child = new FakeChild(command);
      spawned.push(child);
      onSpawn(child);
      return child;
    },
  };
  return { runtime, spawned };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("persistent FastEmbed provider reuses one helper process across embeds", async () => {
  const { runtime, spawned } = createFakeRuntime();
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    const first = await provider.embed(REQUEST);
    const second = await provider.embed(REQUEST);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(first.documents?.length, 1);
    assert.equal("id" in first, false);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].writes.length, 2);
    assert.match(spawned[0].writes[0], /"cacheDir":"cache-dir"/);
    assert.ok(spawned[0].writes.every((line) => line.endsWith("\n")));
  } finally {
    provider.dispose?.();
  }
  assert.equal(spawned[0].killed, true);
});

test("persistent FastEmbed provider shuts helper down after idle window and respawns", async () => {
  const { runtime, spawned } = createFakeRuntime();
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    idleShutdownMs: 10,
  });
  try {
    await provider.embed(REQUEST);
    assert.equal(spawned[0].killed, false);

    await sleep(40);
    assert.equal(spawned[0].killed, true);

    const afterIdle = await provider.embed(REQUEST);
    assert.equal(afterIdle.ok, true);
    assert.equal(spawned.length, 2);
  } finally {
    provider.dispose?.();
  }
});

test("an oversized helper response fails fast with output_too_large instead of hanging", async () => {
  const { runtime, spawned } = createFakeRuntime((child) => {
    child.onWrite = () => {
      // A response line larger than the transport cap, with the terminating
      // newline arriving only past the cap — the shape that used to be
      // silently truncated and then waited out the full request timeout.
      const oversizedChunk = "x".repeat(6_000_000);
      child.emitStdout(oversizedChunk);
      child.emitStdout(oversizedChunk);
      child.emitStdout("\n");
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    // If the overflow path regressed to the old hang, this test would only
    // fail after the timeout below rather than blocking the suite for 3 min.
    requestTimeoutMs: 5_000,
  });
  try {
    const startedAt = Date.now();
    const result = await provider.embed(REQUEST);
    assert.equal(result.ok, false);
    assert.equal(result.code, "output_too_large");
    assert.ok(
      Date.now() - startedAt < 4_000,
      "overflow must settle immediately, not via the request timeout",
    );
    assert.equal(spawned[0].killed, true);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider recovers with a fresh helper after an overflow", async () => {
  let overflowFirst = true;
  const { runtime, spawned } = createFakeRuntime((child) => {
    child.onWrite = (line: string) => {
      if (overflowFirst && child === spawned[0]) {
        child.emitStdout("y".repeat(11_000_000));
        return;
      }
      const request = JSON.parse(line) as { id: string; model: string; dim: number };
      child.emitStdout(
        JSON.stringify({
          id: request.id,
          ok: true,
          model: request.model,
          dim: request.dim,
          documents: [[1, 0]],
          queries: [[0, 1]],
        }) + "\n",
      );
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    requestTimeoutMs: 5_000,
  });
  try {
    const first = await provider.embed(REQUEST);
    assert.equal(first.ok, false);
    assert.equal(first.code, "output_too_large");

    overflowFirst = false;
    const second = await provider.embed(REQUEST);
    assert.equal(second.ok, true);
    assert.equal(spawned.length, 2);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider respawns once when a reused helper dies mid-request", async () => {
  let crashNextWrite = false;
  const { runtime, spawned } = createFakeRuntime((child) => {
    respondOk(child);
    const respond = child.onWrite;
    child.onWrite = (line) => {
      if (crashNextWrite && child === spawned[0]) {
        child.emitClose();
        return;
      }
      respond?.(line);
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    const first = await provider.embed(REQUEST);
    assert.equal(first.ok, true);

    crashNextWrite = true;
    const second = await provider.embed(REQUEST);
    assert.equal(second.ok, true);
    assert.equal(spawned.length, 2);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider respawns once when a reused helper times out", async () => {
  let hangNextWrite = false;
  const { runtime, spawned } = createFakeRuntime((child) => {
    respondOk(child);
    const respond = child.onWrite;
    child.onWrite = (line) => {
      if (hangNextWrite && child === spawned[0]) {
        return;
      }
      respond?.(line);
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    requestTimeoutMs: 15,
  });
  try {
    const first = await provider.embed(REQUEST);
    assert.equal(first.ok, true);

    hangNextWrite = true;
    const second = await provider.embed(REQUEST);
    assert.equal(second.ok, true);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].killed, true);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider falls back to the next python command on ENOENT", async () => {
  const { runtime, spawned } = createFakeRuntime((child) => {
    if (child.command === "python-primary") {
      child.onWrite = () => {
        queueMicrotask(() => child.emitError("ENOENT", "spawn python-primary ENOENT"));
      };
      return;
    }
    respondOk(child);
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    const result = await provider.embed(REQUEST);

    assert.equal(result.ok, true);
    assert.deepEqual(
      spawned.map((child) => child.command),
      ["python-primary", "python"],
    );
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider retries one timed-out cold helper and succeeds", async () => {
  let first = true;
  const { runtime, spawned } = createFakeRuntime((child) => {
    if (first) {
      first = false;
      child.onWrite = () => {};
      return;
    }
    respondOk(child);
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    requestTimeoutMs: 15,
  });
  try {
    const result = await provider.embed(REQUEST);

    assert.equal(result.ok, true);
    assert.equal(spawned.length, 2);
    assert.equal(spawned[0].killed, true);
    assert.equal(spawned[1].writes.length, 1);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider stops after one timeout recovery", async () => {
  const { runtime, spawned } = createFakeRuntime((child) => {
    child.onWrite = () => {};
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
    requestTimeoutMs: 15,
  });
  try {
    const result = await provider.embed(REQUEST);

    assert.equal(result.ok, false);
    assert.equal(result.code, "timeout");
    assert.equal(spawned.length, 2);
    assert.ok(spawned.every((child) => child.killed));
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider reports helper stderr when the process exits early", async () => {
  const { runtime } = createFakeRuntime((child) => {
    child.onWrite = () => {
      child.emitClose();
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    const result = await provider.embed(REQUEST);

    assert.equal(result.ok, false);
    assert.equal(result.code, "helper_exited");
    assert.match(result.message ?? "", /exited before returning/);
  } finally {
    provider.dispose?.();
  }
});

test("persistent FastEmbed provider refuses work after dispose", async () => {
  const { runtime, spawned } = createFakeRuntime();
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  await provider.embed(REQUEST);
  provider.dispose?.();

  const afterDispose = await provider.embed(REQUEST);

  assert.equal(afterDispose.ok, false);
  assert.equal(afterDispose.code, "disposed");
  assert.equal(spawned.length, 1);
});

test("dispose settles an in-flight embed without respawning a helper", async () => {
  // A silent helper (cold Python start, or a request that never answers):
  // dispose() used to settle the pending request as helper_exited, which the
  // retry path read as a crash worth a fresh helper. That respawned a zombie
  // process after unload and held the caller for the full request timeout,
  // so a stopped mission could not settle.
  const { runtime, spawned } = createFakeRuntime(() => undefined);
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  const startedAt = Date.now();
  const pending = provider.embed(REQUEST);
  await sleep(5);
  assert.equal(spawned.length, 1);
  provider.dispose?.();
  const result = await pending;
  assert.ok(Date.now() - startedAt < 2_000, "dispose did not settle the request");
  assert.equal(result.ok, false);
  assert.ok(
    result.code === "disposed" || result.code === "helper_exited",
    `unexpected code ${result.code}`,
  );
  assert.equal(spawned.length, 1, "no helper was respawned after dispose");
  assert.equal(spawned[0].killed, true);

  const afterDispose = await provider.embed(REQUEST);
  assert.equal(afterDispose.code, "disposed");
  assert.equal(spawned.length, 1);
});

test("a queued embed whose run is already stopped never reaches the helper", async () => {
  // Every embed goes through one queue. A request parked behind a background
  // index batch used to start its own helper call after the run had stopped,
  // holding the caller for the full request timeout.
  const { runtime, spawned } = createFakeRuntime(() => undefined);
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  const controller = new AbortController();
  controller.abort(new Error("Mission was stopped."));
  const result = await provider.embed({ ...REQUEST, signal: controller.signal });
  assert.equal(result.ok, false);
  assert.equal(result.code, "aborted");
  assert.equal(spawned.length, 0, "no helper was spawned for a stopped run");
  provider.dispose?.();
});

test("the provider names itself so an index can record which runtime built it", () => {
  const { runtime } = createFakeRuntime();
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    assert.equal(provider.id, "python-fastembed");
  } finally {
    provider.dispose?.();
  }
});

test("a vector of the wrong width is refused as dim_mismatch instead of reaching the index", async () => {
  // A non-Matryoshka model configured with a dimension other than its native
  // one comes back at its native width. The old helper truncated it into noise
  // or threw; now the mismatch is named so it is fixed in settings.
  const { runtime } = createFakeRuntime((child) => {
    child.onWrite = (line: string) => {
      const request = JSON.parse(line) as { id: string; model: string; dim: number };
      child.emitStdout(
        JSON.stringify({
          id: request.id,
          ok: true,
          model: request.model,
          dim: 384,
          documents: [[0.1, 0.2, 0.3]],
          queries: [[0.3, 0.2, 0.1]],
        }) + "\n",
      );
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    const result = await provider.embed({
      ...REQUEST,
      model: "BAAI/bge-small-en-v1.5",
      dim: 512,
      matryoshka: false,
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, "dim_mismatch");
    assert.equal(result.dim, 3);
    assert.match(result.message ?? "", /returned 3-dimension vectors but 512 was requested/);
  } finally {
    provider.dispose?.();
  }
});

test("the matryoshka flag is forwarded to the helper verbatim", async () => {
  const { runtime, spawned } = createFakeRuntime();
  const provider = createPythonFastEmbedProvider(SETTINGS, {
    loadRuntime: () => runtime,
  });
  try {
    await provider.embed({ ...REQUEST, dim: 2, matryoshka: false });
    await provider.embed({ ...REQUEST, dim: 2, matryoshka: true });
    await provider.embed({ ...REQUEST, dim: 2 });
    const bodies = spawned[0].writes.map((line) => JSON.parse(line) as { matryoshka?: boolean });
    assert.equal(bodies[0].matryoshka, false);
    assert.equal(bodies[1].matryoshka, true);
    // Omitted stays omitted: the helper treats absence as the pre-flag
    // behaviour, which is what every request carried before the flag existed.
    assert.equal("matryoshka" in bodies[2], false);
  } finally {
    provider.dispose?.();
  }
});

test("a queued interactive request runs before queued background batches", async () => {
  // An index rebuild queues dozens of background batches; a search that
  // arrives while one is in flight must run as soon as it settles, not after
  // every batch. Never preempts the request the helper is already executing.
  const order: string[] = [];
  let release: (() => void) | null = null;
  const { runtime } = createFakeRuntime((child) => {
    child.onWrite = (line: string) => {
      const request = JSON.parse(line) as { id: string; model: string; dim: number; documents: string[] };
      const label = request.documents[0];
      const answer = () => {
        order.push(label);
        child.emitStdout(
          JSON.stringify({ id: request.id, ok: true, model: request.model, dim: request.dim, documents: [[1, 0]], queries: [] }) + "\n",
        );
      };
      if (label === "bg-1") {
        // Hold the first background batch so the others queue behind it.
        release = answer;
      } else {
        answer();
      }
    };
  });
  const provider = createPythonFastEmbedProvider(SETTINGS, { loadRuntime: () => runtime });
  try {
    const request = (label: string, priority?: "interactive" | "background") => ({
      ...REQUEST,
      documents: [label],
      queries: [],
      ...(priority ? { priority } : {}),
    });
    const bg1 = provider.embed(request("bg-1", "background"));
    const bg2 = provider.embed(request("bg-2", "background"));
    const bg3 = provider.embed(request("bg-3", "background"));
    // Wait until bg-1 is actually in flight (its write is recorded), then queue
    // the interactive search.
    await sleep(10);
    const search = provider.embed(request("search"));
    const legacy = provider.embed(request("legacy-default-is-interactive"));
    await sleep(10);
    // Read through a fresh binding: the closure assignment above is invisible
    // to control-flow narrowing, which otherwise types `release` as never here.
    const fire = release as (() => void) | null;
    assert.ok(fire, "bg-1 must be in flight");
    fire();
    await Promise.all([bg1, bg2, bg3, search, legacy]);
    assert.deepEqual(order, ["bg-1", "search", "legacy-default-is-interactive", "bg-2", "bg-3"]);
  } finally {
    provider.dispose?.();
  }
});
