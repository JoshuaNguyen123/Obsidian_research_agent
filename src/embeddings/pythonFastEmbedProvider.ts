import type { AgentSettings } from "../settings";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticEmbeddingResponse,
} from "./types";
import { getNodeRequireForObsidian } from "../platform/nodeRequire";

const REQUEST_TIMEOUT_MS = 180000;
const IDLE_SHUTDOWN_MS = 120000;
const MAX_OUTPUT_CHARS = 10_000_000;
const MAX_STDERR_CHARS = 20_000;

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
 * window and on dispose; it is respawned transparently on the next request.
 */
export function createPythonFastEmbedProvider(
  settings: AgentSettings | (() => AgentSettings),
  options: PythonFastEmbedProviderOptions = {},
): SemanticEmbeddingProvider {
  const getSettings = typeof settings === "function" ? settings : () => settings;
  const requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  const idleShutdownMs = options.idleShutdownMs ?? IDLE_SHUTDOWN_MS;
  const loadRuntime = options.loadRuntime ?? loadNodeEmbeddingRuntime;

  let session: HelperSession | null = null;
  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  let requestSeq = 0;
  let queueTail: Promise<unknown> = Promise.resolve();

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
      if (created.stdoutBuffer.length < MAX_OUTPUT_CHARS) {
        created.stdoutBuffer += chunk.toString("utf8");
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
        }) + "\n";
      try {
        target.child.stdin.write(body, "utf8");
      } catch {
        settlePending(target, helperExitedResponse(target));
        destroySession(target);
      }
    });
  };

  const embedNow = async (
    request: SemanticEmbeddingRequest,
  ): Promise<SemanticEmbeddingResponse> => {
    if (disposed) {
      return {
        ok: false,
        model: request.model,
        dim: request.dim,
        code: "disposed",
        message: "FastEmbed provider is disposed.",
      };
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

      if (session?.alive && commands.includes(session.command)) {
        const result = await sendRequest(session, request, activeSettings);
        // A previously-working helper that died mid-request falls through to
        // one fresh respawn attempt below instead of failing the embed.
        if (result.code !== "helper_exited") {
          return result;
        }
      } else if (session) {
        destroySession(session);
      }

      const errors: string[] = [];
      for (const command of commands) {
        const fresh = spawnSession(runtime, command);
        session = fresh;
        const result = await sendRequest(fresh, request, activeSettings);
        if (result.ok || result.code !== "missing_python") {
          return result;
        }
        errors.push(`${command}: ${result.message ?? result.code}`);
        destroySession(fresh);
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

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const run = queueTail.then(task, task);
    queueTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  return {
    embed: (request) => enqueue(() => embedNow(request)),
    dispose: () => {
      disposed = true;
      clearIdleTimer();
      if (session) {
        destroySession(session);
      }
    },
  };
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

MODELS = {}

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
    normalized = layer_norm(as_vector(values))
    if len(normalized) < dim:
        raise ValueError("embedding dimension %d is smaller than requested dim %d" % (len(normalized), dim))
    return l2_norm(normalized[:dim])

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

def get_model(model_name, cache_dir):
    key = (model_name, cache_dir)
    cached = MODELS.get(key)
    if cached is not None:
        return cached
    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        os.environ["FASTEMBED_CACHE_PATH"] = cache_dir
    from fastembed import TextEmbedding
    try:
        instance = TextEmbedding(model_name=model_name, cache_dir=cache_dir or None)
    except TypeError:
        instance = TextEmbedding(model_name=model_name)
    list(instance.embed(["search_query: warmup"], batch_size=1))
    MODELS[key] = instance
    return instance

def handle(request):
    rid = str(request.get("id") or "")
    model = str(request.get("model") or "nomic-ai/nomic-embed-text-v1.5-Q")
    dim = int(request.get("dim") or 512)
    cache_dir = str(request.get("cacheDir") or "").strip()
    documents = request.get("documents") or []
    queries = request.get("queries") or []

    if dim not in (256, 512):
        fail(rid, "invalid_dim", "dim must be 256 or 512", model, dim)
        return

    try:
        embedding_model = get_model(model, cache_dir)
    except ImportError:
        fail(rid, "missing_fastembed", "Install FastEmbed with: python -m pip install fastembed", model, dim)
        return
    except Exception as error:
        fail(rid, "embed_failed", str(error), model, dim)
        return

    try:
        document_inputs = ["search_document: " + str(item) for item in documents]
        query_inputs = ["search_query: " + str(item) for item in queries]
        document_vectors = []
        query_vectors = []
        if document_inputs:
            for vector in iter_vectors(embedding_model.embed(document_inputs, batch_size=16)):
                document_vectors.append(matryoshka(vector, dim))
        if query_inputs:
            for vector in iter_vectors(embedding_model.embed(query_inputs, batch_size=16)):
                query_vectors.append(matryoshka(vector, dim))
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
