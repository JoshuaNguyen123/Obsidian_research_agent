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
  dim: 512,
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

test("persistent FastEmbed provider times out and kills a hung helper", async () => {
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
    assert.equal(spawned[0].killed, true);
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
