import type { AgentSettings } from "../settings";
import type {
  SemanticRerankRequest,
  SemanticRerankResponse,
  SemanticEmbeddingPriority,
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticEmbeddingResponse,
} from "./types";
import { getNodeRequireForObsidian } from "../platform/nodeRequire";

/** Recorded in every index this provider builds; see `SemanticEmbeddingProvider.id`. */
export const PYTHON_FASTEMBED_PROVIDER_ID = "python-fastembed";

/**
 * Read the execution-provider setting. Comma separated, order preserved,
 * blanks dropped: the helper tries them in order and falls back to the
 * runtime's own default if the list does not load.
 */
export function parseOnnxProviderListV1(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 4);
}

const REQUEST_TIMEOUT_MS = 180000;
/**
 * Reranking produces no vectors, but the wire request carries the embedding
 * request's shape so both ops share one transport. The width is never read on
 * the rerank path; it only has to pass the helper's positive-integer guard.
 */
const RERANK_WIRE_DIM = 1;
/**
 * Keep the helper (and its loaded model) alive across a typical editing
 * session so the first search after plugin load is not a cold Python spawn.
 * Cap is one hour: longer than that is a leaked interpreter, not a warm cache.
 */
export const DEFAULT_FASTEMBED_IDLE_SHUTDOWN_MS = 30 * 60 * 1000;
export const MAX_FASTEMBED_IDLE_SHUTDOWN_MS = 60 * 60 * 1000;
const MAX_OUTPUT_CHARS = 10_000_000;
const MAX_STDERR_CHARS = 20_000;
const MAX_HELPER_RECOVERIES_PER_REQUEST = 1;

export interface HelperChildLike {
  stdin: {
    write(chunk: string, encoding?: BufferEncoding): unknown;
    end(): void;
    on?(event: "error", listener: (error: Error) => void): unknown;
  };
  stdout: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  };
  stderr: {
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
  };
  on(event: "error", listener: (error: NodeJS.ErrnoException) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  kill(): void;
}

export type HelperSpawn = (
  command: string,
  args: string[],
  options: {
    shell: boolean;
    windowsHide: boolean;
    stdio: ["pipe", "pipe", "pipe"];
  },
) => HelperChildLike;

export interface NodeEmbeddingRuntime {
  spawn: HelperSpawn;
}

export interface PythonFastEmbedProviderOptions {
  requestTimeoutMs?: number;
  idleShutdownMs?: number;
  /**
   * Spawn the helper and load the configured model as soon as the provider
   * is created (plugin onload). Tests that count helper processes pass
   * `false`. Default is on so the first search of a session is warm.
   */
  eagerWarm?: boolean;
  loadRuntime?: () => NodeEmbeddingRuntime;
}

interface PendingHelperRequest {
  id: string;
  settled: boolean;
  timeout: ReturnType<typeof setTimeout>;
  resolve: (response: SemanticEmbeddingResponse) => void;
}

interface HelperSession {
  command: string;
  child: HelperChildLike;
  alive: boolean;
  stdoutBuffer: string;
  stderrTail: string;
  spawnErrorResponse: SemanticEmbeddingResponse | null;
  pending: PendingHelperRequest | null;
}

/**
 * Creates the FastEmbed semantic embedding provider backed by one long-lived
 * Python helper process. The helper keeps loaded FastEmbed models in memory and
 * answers line-delimited JSON requests over stdin/stdout, so repeated embeds
 * skip interpreter startup and model reload. The child is killed after an idle
 * window (default 30 minutes, capped at 60) and on dispose; it is respawned
 * transparently on the next request. Creation eagerly warms the helper so the
 * first search of a session is not a cold spawn.
 */
export function createPythonFastEmbedProvider(
  settings: AgentSettings | (() => AgentSettings),
  options: PythonFastEmbedProviderOptions = {},
): SemanticEmbeddingProvider {
  const getSettings = typeof settings === "function" ? settings : () => settings;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const idleShutdownMs = resolveIdleShutdownMs(options.idleShutdownMs);
  const loadRuntime = options.loadRuntime ?? loadNodeEmbeddingRuntime;

  let session: HelperSession | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let requestSeq = 0;
  // Serial queue with two classes. The helper answers one request at a time,
  // so an index rebuild that queued 40 batches used to hold every search behind
  // them; now a queued interactive request runs as soon as the in-flight
  // request settles, ahead of any queued background batch.
  const pendingTasks: Array<{
    priority: SemanticEmbeddingPriority;
    seq: number;
    start: () => Promise<unknown>;
  }> = [];
  let queueSeq = 0;
  let activeTask: Promise<unknown> | null = null;

  const clearIdleTimer = () => {
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
  };

  const destroySession = (target: HelperSession) => {
    target.alive = false;
    try {
      target.child.stdin.end();
    } catch {
      // Child stdin may already be closed.
    }
    try {
      target.child.kill();
    } catch {
      // Child may already be gone.
    }
    settlePending(target, helperExitedResponse(target));
    if (session === target) {
      session = null;
    }
  };

  const armIdleTimer = () => {
    clearIdleTimer();
    if (!session?.alive || disposed) {
      return;
    }
    idleTimer = setTimeout(() => {
      idleTimer = null;
      if (session) {
        destroySession(session);
      }
    }, idleShutdownMs);
    // Do not keep a test process (or a dying host) alive for the idle window.
    // Obsidian's renderer is already running; unref only matters when the
    // event loop would otherwise have nothing left to do.
    idleTimer.unref?.();
  };

  const spawnSession = (
    runtime: NodeEmbeddingRuntime,
    command: string,
  ): HelperSession => {
    const child = runtime.spawn(command, ["-c", PYTHON_FASTEMBED_HELPER], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const created: HelperSession = {
      command,
      child,
      alive: true,
      stdoutBuffer: "",
      stderrTail: "",
      spawnErrorResponse: null,
      pending: null,
    };

    // Failed spawns can surface async EPIPE errors on stdin; without a
    // listener those become uncaught stream exceptions in the renderer.
    child.stdin.on?.("error", () => {});

    child.stdout.on("data", (chunk: Buffer) => {
      if (!created.alive) {
        return;
      }
      created.stdoutBuffer += chunk.toString("utf8");
      if (created.stdoutBuffer.length > MAX_OUTPUT_CHARS) {
        // Silently dropping bytes here used to also drop the response's
        // trailing newline, so the request could never parse and sat until
        // the 3-minute timeout — then the caller retried the identical
        // oversized request forever. Fail fast with a diagnosable code.
        settlePending(created, {
          ok: false,
          model: "",
          dim: 0,
          code: "output_too_large",
          message:
            `FastEmbed helper response exceeded ${MAX_OUTPUT_CHARS} characters; ` +
            "send fewer documents per embed request.",
        });
        destroySession(created);
        return;
      }
      drainStdoutLines(created);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      created.stderrTail = (created.stderrTail + chunk.toString("utf8")).slice(
        -MAX_STDERR_CHARS,
      );
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      created.alive = false;
      created.spawnErrorResponse = {
        ok: false,
        model: "",
        dim: 0,
        code: error.code === "ENOENT" ? "missing_python" : "spawn_error",
        message: error.message,
      };
      settlePending(created, created.spawnErrorResponse);
      if (session === created) {
        session = null;
      }
    });

    child.on("close", () => {
      created.alive = false;
      settlePending(created, helperExitedResponse(created));
      if (session === created) {
        session = null;
      }
    });

    return created;
  };

  const drainStdoutLines = (target: HelperSession) => {
    while (true) {
      const newlineIndex = target.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = target.stdoutBuffer.slice(0, newlineIndex).trim();
      target.stdoutBuffer = target.stdoutBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }
      const parsed = parseHelperLine(line);
      if (!parsed) {
        continue;
      }
      const pending = target.pending;
      if (!pending || pending.settled || parsed.id !== pending.id) {
        continue;
      }
      settlePending(target, parsed.response);
    }
  };

  const sendRequest = (
    target: HelperSession,
    request: SemanticEmbeddingRequest,
    activeSettings: AgentSettings,
  ): Promise<SemanticEmbeddingResponse> => {
    return new Promise((resolve) => {
      const id = `req-${++requestSeq}`;
      const pending: PendingHelperRequest = {
        id,
        settled: false,
        resolve,
        timeout: setTimeout(() => {
          settlePending(target, {
            ok: false,
            model: request.model,
            dim: request.dim,
            code: "timeout",
            message: `FastEmbed helper timed out after ${requestTimeoutMs}ms.`,
          });
          destroySession(target);
        }, requestTimeoutMs),
      };
      target.pending = pending;

      if (target.spawnErrorResponse) {
        settlePending(target, target.spawnErrorResponse);
        return;
      }
      if (!target.alive) {
        settlePending(target, helperExitedResponse(target));
        return;
      }

      const body =
        JSON.stringify({
          id,
          ...request,
          cacheDir: request.cacheDir ?? activeSettings.semanticModelCacheDir,
          providers:
            request.providers ??
            parseOnnxProviderListV1(activeSettings.semanticOnnxProviders),
        }) + "\n";
      try {
        target.child.stdin.write(body, "utf8");
      } catch {
        settlePending(target, helperExitedResponse(target));
        destroySession(target);
      }
    });
  };

  const disposedResponse = (
    request: SemanticEmbeddingRequest,
  ): SemanticEmbeddingResponse => ({
    ok: false,
    model: request.model,
    dim: request.dim,
    code: "disposed",
    message: "FastEmbed provider is disposed.",
  });

  const abortedResponse = (
    request: SemanticEmbeddingRequest,
  ): SemanticEmbeddingResponse => ({
    ok: false,
    model: request.model,
    dim: request.dim,
    code: "aborted",
    message: "The run was stopped before the embedding request started.",
  });

  const embedNow = async (
    request: SemanticEmbeddingRequest,
  ): Promise<SemanticEmbeddingResponse> => {
    if (disposed) {
      return disposedResponse(request);
    }
    clearIdleTimer();
    try {
      let runtime: NodeEmbeddingRuntime;
      try {
        runtime = loadRuntime();
      } catch (error) {
        return {
          ok: false,
          model: request.model,
          dim: request.dim,
          code: "node_runtime_unavailable",
          message: getErrorMessage(error),
        };
      }

      const activeSettings = getSettings();
      const commands = getPythonCommands(activeSettings.semanticPythonCommand);
      let helperRecoveriesRemaining = MAX_HELPER_RECOVERIES_PER_REQUEST;

      if (session?.alive && commands.includes(session.command)) {
        const result = await sendRequest(session, request, activeSettings);
        // A previously-working helper that died or timed out mid-request falls
        // through to one fresh respawn attempt below instead of failing the
        // embed. The same single recovery budget is shared with a cold helper,
        // so no request can loop beyond two actual helper attempts.
        if (!isRetryableHelperFailure(result) || helperRecoveriesRemaining <= 0) {
          return result;
        }
        // dispose() settles the in-flight request as helper_exited; that
        // must not read as a crash worth a fresh helper. Respawning here
        // after unload used to start a zombie Python process and hold the
        // caller for the full request timeout, so a stopped mission could
        // not settle.
        if (disposed) {
          return disposedResponse(request);
        }
        helperRecoveriesRemaining -= 1;
      } else if (session) {
        destroySession(session);
      }

      const errors: string[] = [];
      for (const command of commands) {
        while (true) {
          if (disposed) {
            return disposedResponse(request);
          }
          const fresh = spawnSession(runtime, command);
          session = fresh;
          const result = await sendRequest(fresh, request, activeSettings);
          if (result.ok) {
            return result;
          }
          if (result.code === "missing_python") {
            errors.push(`${command}: ${result.message ?? result.code}`);
            if (fresh.alive) {
              destroySession(fresh);
            }
            break;
          }
          if (
            isRetryableHelperFailure(result) &&
            helperRecoveriesRemaining > 0
          ) {
            helperRecoveriesRemaining -= 1;
            if (fresh.alive) {
              destroySession(fresh);
            }
            continue;
          }
          return result;
        }
      }

      return {
        ok: false,
        model: request.model,
        dim: request.dim,
        code: "missing_python",
        message: errors.join(" "),
      };
    } finally {
      armIdleTimer();
    }
  };

  const pumpQueue = () => {
    if (activeTask || pendingTasks.length === 0) {
      return;
    }
    pendingTasks.sort(
      (left, right) =>
        priorityRank(left.priority) - priorityRank(right.priority) ||
        left.seq - right.seq,
    );
    const next = pendingTasks.shift()!;
    activeTask = next.start().then(
      () => undefined,
      () => undefined,
    );
    void activeTask.then(() => {
      activeTask = null;
      pumpQueue();
    });
  };

  const enqueue = <T>(
    task: () => Promise<T>,
    priority: SemanticEmbeddingPriority = "interactive",
  ): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      pendingTasks.push({
        priority,
        seq: ++queueSeq,
        start: () => {
          const run = task();
          run.then(resolve, reject);
          return run;
        },
      });
      pumpQueue();
    });

  const provider: SemanticEmbeddingProvider = {
    id: PYTHON_FASTEMBED_PROVIDER_ID,
    rerank: (request: SemanticRerankRequest): Promise<SemanticRerankResponse> => {
      if (request.documents.length === 0) {
        return Promise.resolve({ ok: true, model: request.model, scores: [] });
      }
      // The rerank op rides the same helper session, the same serial queue and
      // the same recovery budget as embedding: one Python process holds both
      // model caches, so a search that reranks costs one extra round trip, not
      // a second interpreter.
      const wire: SemanticEmbeddingRequest = {
        op: "rerank",
        model: request.model,
        dim: RERANK_WIRE_DIM,
        cacheDir: request.cacheDir,
        query: request.query,
        documents: request.documents,
        queries: [],
        priority: request.priority ?? "interactive",
        signal: request.signal,
      };
      return enqueue(
        () =>
          request.signal?.aborted
            ? Promise.resolve({
                ok: false,
                model: request.model,
                code: "aborted",
                message: "The run was stopped before the rerank request started.",
              } satisfies SemanticRerankResponse)
            : embedNow(wire).then((result) => toRerankResponse(request, result)),
        request.priority ?? "interactive",
      );
    },
    embed: (request) =>
      enqueue(
        () =>
          request.signal?.aborted
            ? Promise.resolve(abortedResponse(request))
            : embedNow(request).then((result) => verifyResponseDim(request, result)),
        request.priority ?? "interactive",
      ),
    dispose: () => {
      disposed = true;
      clearIdleTimer();
      if (session) {
        destroySession(session);
      }
    },
  };

  if (options.eagerWarm !== false) {
    queueMicrotask(() => {
      if (disposed) {
        return;
      }
      const active = getSettings();
      void enqueue(
        () =>
          embedNow({
            model: active.semanticEmbeddingModel || "jinaai/jina-embeddings-v2-small-en",
            dim: active.semanticEmbeddingDim || 512,
            documents: ["warmup"],
            queries: [],
            priority: "background",
          }),
        "background",
      );
    });
  }

  return provider;
}

function resolveIdleShutdownMs(value: number | undefined): number {
  const requested = value ?? DEFAULT_FASTEMBED_IDLE_SHUTDOWN_MS;
  if (!Number.isFinite(requested) || requested < 0) {
    return DEFAULT_FASTEMBED_IDLE_SHUTDOWN_MS;
  }
  return Math.min(Math.trunc(requested), MAX_FASTEMBED_IDLE_SHUTDOWN_MS);
}

/**
 * Map the shared wire response onto the rerank contract. A helper that is too
 * old to know the op, or a Python without the reranking extra, comes back as
 * `ok: false` with a code the caller can show; the caller's contract is that
 * this leaves the ranking alone rather than failing the search.
 */
function toRerankResponse(
  request: SemanticRerankRequest,
  response: SemanticEmbeddingResponse,
): SemanticRerankResponse {
  if (!response.ok) {
    return {
      ok: false,
      model: request.model,
      code: response.code ?? "rerank_failed",
      message: response.message,
    };
  }
  const scores = response.scores;
  if (!Array.isArray(scores) || scores.length !== request.documents.length) {
    return {
      ok: false,
      model: request.model,
      code: "rerank_length_mismatch",
      message: `Reranker returned ${Array.isArray(scores) ? scores.length : 0} scores for ${request.documents.length} documents.`,
    };
  }
  return { ok: true, model: request.model, scores };
}

/**
 * A vector of the wrong width must never reach the index. The helper only
 * truncates Matryoshka models, so a non-Matryoshka model configured with a
 * dimension other than its native one comes back at its native width; naming
 * that width here turns a silent shape mismatch into a settings fix.
 */
function verifyResponseDim(
  request: SemanticEmbeddingRequest,
  response: SemanticEmbeddingResponse,
): SemanticEmbeddingResponse {
  if (!response.ok) {
    return response;
  }
  const vectors = [...(response.documents ?? []), ...(response.queries ?? [])];
  const mismatched = vectors.find((vector) => vector.length !== request.dim);
  if (!mismatched) {
    return response;
  }
  return {
    ok: false,
    model: request.model,
    dim: mismatched.length,
    code: "dim_mismatch",
    message: `${request.model} returned ${mismatched.length}-dimension vectors but ${request.dim} was requested. Set the semantic embedding dimension to ${mismatched.length}, or choose a catalogued model so the plugin can resolve it.`,
  };
}

function priorityRank(priority: SemanticEmbeddingPriority): number {
  return priority === "interactive" ? 0 : 1;
}

function isRetryableHelperFailure(response: SemanticEmbeddingResponse): boolean {
  return response.code === "helper_exited" || response.code === "timeout";
}

function settlePending(
  target: HelperSession,
  response: SemanticEmbeddingResponse,
) {
  const pending = target.pending;
  if (!pending || pending.settled) {
    return;
  }
  pending.settled = true;
  clearTimeout(pending.timeout);
  target.pending = null;
  pending.resolve(response);
}

function helperExitedResponse(target: HelperSession): SemanticEmbeddingResponse {
  return {
    ok: false,
    model: "",
    dim: 0,
    code: "helper_exited",
    message:
      target.stderrTail.trim() ||
      "FastEmbed helper exited before returning a response.",
  };
}

function parseHelperLine(
  line: string,
): { id: string; response: SemanticEmbeddingResponse } | null {
  try {
    const parsed = JSON.parse(line) as SemanticEmbeddingResponse & {
      id?: unknown;
    };
    if (typeof parsed?.ok !== "boolean") {
      return null;
    }
    const id = typeof parsed.id === "string" ? parsed.id : "";
    const response = { ...parsed };
    delete (response as { id?: unknown }).id;
    return { id, response };
  } catch {
    return null;
  }
}

function getPythonCommands(configuredCommand: string): string[] {
  const commands = [
    configuredCommand.trim(),
    "python",
    "py",
  ].filter(Boolean);
  return [...new Set(commands)];
}

function loadNodeEmbeddingRuntime(): NodeEmbeddingRuntime {
  const nodeRequire = getNodeRequireForObsidian();
  if (!nodeRequire) {
    throw new Error("Node require is unavailable for FastEmbed semantic search.");
  }

  const childProcess = nodeRequire("child_process") as typeof import("child_process");
  if (typeof childProcess.spawn !== "function") {
    throw new Error("Node child_process.spawn is unavailable for FastEmbed semantic search.");
  }

  return {
    spawn: childProcess.spawn as unknown as HelperSpawn,
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const PYTHON_FASTEMBED_HELPER = String.raw`
import json
import math
import os
import sys

from collections import OrderedDict

try:
    import numpy as np
except Exception:
    np = None

# The helper outlives any single request (it idles up to an hour before shutdown),
# so an unbounded cache means peak memory grows with the number of distinct models
# a session touches, not with the number it uses at once. A loaded embedding model
# plus a cross-encoder is gigabytes; four rerankers are selectable in settings.
# Cap both caches and evict least-recently-used so residency stays proportional to
# what is actually in play. Two keeps a model swap from reloading on every request.
MAX_CACHED_MODELS = 2
MAX_CACHED_RERANKERS = 2

MODELS = OrderedDict()
RERANKERS = OrderedDict()
PROVIDERS_USED = {}

def remember_bounded(cache, key, instance, limit):
    cache[key] = instance
    cache.move_to_end(key)
    while len(cache) > limit:
        evicted_key, _ = cache.popitem(last=False)
        PROVIDERS_USED.pop(evicted_key, None)
    return instance

def load_with_providers(factory, model_name, cache_dir, providers):
    # An execution-provider list the local onnxruntime cannot satisfy must not
    # break embedding: try the requested providers, then fall back to whatever
    # the runtime picks for itself, and report which of the two happened.
    if providers:
        try:
            instance = factory(model_name=model_name, cache_dir=cache_dir or None, providers=providers)
            return instance, list(providers)
        except Exception:
            pass
    try:
        instance = factory(model_name=model_name, cache_dir=cache_dir or None)
    except TypeError:
        instance = factory(model_name=model_name)
    used = []
    try:
        import onnxruntime
        used = list(onnxruntime.get_available_providers())[:1]
    except Exception:
        used = []
    return instance, used

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")) + "\n")
    sys.stdout.flush()

def fail(rid, code, message, model="", dim=0):
    emit({"id": rid, "ok": False, "model": model, "dim": dim, "code": code, "message": message})

def as_vector(value):
    if hasattr(value, "tolist"):
        value = value.tolist()
    return [float(item) for item in value]

def layer_norm(values):
    if not values:
        return values
    mean = sum(values) / len(values)
    variance = sum((item - mean) ** 2 for item in values) / len(values)
    scale = math.sqrt(variance + 1e-12)
    return [(item - mean) / scale for item in values]

def l2_norm(values):
    magnitude = math.sqrt(sum(item * item for item in values))
    if magnitude <= 0:
        return values
    return [item / magnitude for item in values]

def matryoshka(values, dim):
    # nomic's recipe: layer-norm, truncate, L2-normalise. Only meaningful for a
    # model trained with Matryoshka Representation Learning; the caller decides
    # (see postprocess) and every other model keeps its native vectors.
    if np is not None:
        arr = np.asarray(values, dtype=np.float64).reshape(-1)
        if arr.shape[0] < dim:
            raise ValueError("embedding dimension %d is smaller than requested dim %d" % (arr.shape[0], dim))
        arr = (arr - arr.mean()) / math.sqrt(float(arr.var()) + 1e-12)
        arr = arr[:dim]
        magnitude = float(np.linalg.norm(arr))
        if magnitude > 0:
            arr = arr / magnitude
        return arr.tolist()
    normalized = layer_norm(as_vector(values))
    if len(normalized) < dim:
        raise ValueError("embedding dimension %d is smaller than requested dim %d" % (len(normalized), dim))
    return l2_norm(normalized[:dim])

def native_normalized(values):
    # Non-Matryoshka models: keep every dimension, only guarantee unit length so
    # cosine similarity reduces to a dot product like it does for the recipe.
    if np is not None:
        arr = np.asarray(values, dtype=np.float64).reshape(-1)
        magnitude = float(np.linalg.norm(arr))
        if magnitude > 0:
            arr = arr / magnitude
        return arr.tolist()
    return l2_norm(as_vector(values))

def postprocess(values, dim, use_matryoshka):
    if use_matryoshka:
        return matryoshka(values, dim)
    return native_normalized(values)

def iter_vectors(values):
    for item in values:
        raw = item.tolist() if hasattr(item, "tolist") else item
        if raw is None:
            continue
        raw = list(raw)
        if not raw:
            continue
        if isinstance(raw[0], (int, float)):
            yield raw
            continue
        for vector in raw:
            yield vector

def get_model(model_name, cache_dir, providers=None):
    key = (model_name, cache_dir, tuple(providers or ()))
    cached = MODELS.get(key)
    if cached is not None:
        MODELS.move_to_end(key)
        return cached
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        os.environ["FASTEMBED_CACHE_PATH"] = cache_dir
    from fastembed import TextEmbedding
    instance, used = load_with_providers(TextEmbedding, model_name, cache_dir, providers)
    list(instance.embed(["warmup"], batch_size=1))
    PROVIDERS_USED[key] = used
    return remember_bounded(MODELS, key, instance, MAX_CACHED_MODELS)

def get_reranker(model_name, cache_dir):
    key = (model_name, cache_dir)
    cached = RERANKERS.get(key)
    if cached is not None:
        RERANKERS.move_to_end(key)
        return cached
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        os.environ["FASTEMBED_CACHE_PATH"] = cache_dir
    from fastembed.rerank.cross_encoder import TextCrossEncoder
    try:
        instance = TextCrossEncoder(model_name=model_name, cache_dir=cache_dir or None)
    except TypeError:
        instance = TextCrossEncoder(model_name=model_name)
    list(instance.rerank("warmup", ["warmup"]))
    return remember_bounded(RERANKERS, key, instance, MAX_CACHED_RERANKERS)

def handle_rerank(request):
    rid = str(request.get("id") or "")
    model = str(request.get("model") or "")
    cache_dir = str(request.get("cacheDir") or "").strip()
    query = str(request.get("query") or "")
    documents = [str(item) for item in (request.get("documents") or [])]
    if not model:
        fail(rid, "invalid_rerank_model", "rerank requires a model name")
        return
    if not query or not documents:
        emit({"id": rid, "ok": True, "model": model, "dim": 0, "scores": []})
        return
    try:
        reranker = get_reranker(model, cache_dir)
    except ImportError as error:
        fail(rid, "missing_reranker", "This FastEmbed build has no cross-encoder reranker: " + str(error), model)
        return
    except Exception as error:
        fail(rid, "rerank_failed", str(error), model)
        return
    try:
        scores = [float(score) for score in reranker.rerank(query, documents)]
    except Exception as error:
        fail(rid, "rerank_failed", str(error), model)
        return
    if len(scores) != len(documents):
        fail(rid, "rerank_length_mismatch", "reranker returned " + str(len(scores)) + " scores for " + str(len(documents)) + " documents", model)
        return
    emit({"id": rid, "ok": True, "model": model, "dim": 0, "scores": scores})

def handle(request):
    if str(request.get("op") or "embed") == "rerank":
        handle_rerank(request)
        return
    rid = str(request.get("id") or "")
    model = str(request.get("model") or "nomic-ai/nomic-embed-text-v1.5-Q")
    # Supplied per request from the caller's model table. Absent means no
    # prefix, which is the correct default for every model that was not trained
    # with one.
    query_prefix = str(request.get("queryPrefix") or "")
    document_prefix = str(request.get("documentPrefix") or "")
    dim = int(request.get("dim") or 512)
    # Absent means the pre-flag behaviour (truncate), which only nomic ever saw.
    use_matryoshka = bool(request.get("matryoshka", True))
    cache_dir = str(request.get("cacheDir") or "").strip()
    providers = [str(item) for item in (request.get("providers") or []) if str(item).strip()]
    documents = request.get("documents") or []
    queries = request.get("queries") or []

    if dim < 1:

        fail(rid, "invalid_dim", "dim must be a positive integer", model, dim)

        return

    try:
        embedding_model = get_model(model, cache_dir, providers)
    except ImportError:
        fail(rid, "missing_fastembed", "Install FastEmbed with: python -m pip install fastembed", model, dim)
        return
    except Exception as error:
        fail(rid, "embed_failed", str(error), model, dim)
        return

    try:
        document_inputs = [document_prefix + str(item) for item in documents]
        query_inputs = [query_prefix + str(item) for item in queries]
        document_vectors = []
        query_vectors = []
        if document_inputs:
            for vector in iter_vectors(embedding_model.embed(document_inputs, batch_size=16)):
                document_vectors.append(postprocess(vector, dim, use_matryoshka))
        if query_inputs:
            for vector in iter_vectors(embedding_model.embed(query_inputs, batch_size=16)):
                query_vectors.append(postprocess(vector, dim, use_matryoshka))
    except Exception as error:
        fail(rid, "embed_failed", str(error), model, dim)
        return

    emit({
        "id": rid,
        "ok": True,
        "model": model,
        "dim": dim,
        "documents": document_vectors,
        "queries": query_vectors,
        "downloadedOrVerified": True,
        "cacheDir": cache_dir,
        "providersUsed": PROVIDERS_USED.get((model, cache_dir, tuple(providers)), []),
    })

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except Exception as error:
            fail("", "invalid_json", str(error))
            continue
        handle(request)

main()
`;
