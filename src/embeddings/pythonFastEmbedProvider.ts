import type { AgentSettings } from "../settings";
import type {
  SemanticEmbeddingProvider,
  SemanticEmbeddingRequest,
  SemanticEmbeddingResponse,
} from "./types";

const HELPER_TIMEOUT_MS = 180000;
const MAX_OUTPUT_CHARS = 10_000_000;

interface NodeEmbeddingRuntime {
  spawn: typeof import("child_process").spawn;
}

export function createPythonFastEmbedProvider(
  settings: AgentSettings,
): SemanticEmbeddingProvider {
  return {
    embed: (request) => embedWithPythonFastEmbed(request, settings),
  };
}

async function embedWithPythonFastEmbed(
  request: SemanticEmbeddingRequest,
  settings: AgentSettings,
): Promise<SemanticEmbeddingResponse> {
  const runtime = await loadNodeEmbeddingRuntime();
  const commands = getPythonCommands(settings.semanticPythonCommand);
  const body = JSON.stringify({
    ...request,
    cacheDir: request.cacheDir ?? settings.semanticModelCacheDir,
  });
  const errors: string[] = [];

  for (const command of commands) {
    const result = await runPythonHelper(runtime, command, body);
    if (result.ok || result.code !== "missing_python") {
      return result;
    }
    errors.push(`${command}: ${result.message ?? result.code}`);
  }

  return {
    ok: false,
    model: request.model,
    dim: request.dim,
    code: "missing_python",
    message: errors.join(" "),
  };
}

function getPythonCommands(configuredCommand: string): string[] {
  const commands = [
    configuredCommand.trim(),
    "python",
    "py",
  ].filter(Boolean);
  return [...new Set(commands)];
}

async function runPythonHelper(
  runtime: NodeEmbeddingRuntime,
  command: string,
  body: string,
): Promise<SemanticEmbeddingResponse> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = runtime.spawn(command, ["-c", PYTHON_FASTEMBED_HELPER], {
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({
        ok: false,
        model: "",
        dim: 0,
        code: "timeout",
        message: `FastEmbed helper timed out after ${HELPER_TIMEOUT_MS}ms.`,
      });
    }, HELPER_TIMEOUT_MS);

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve({
        ok: false,
        model: "",
        dim: 0,
        code: error.code === "ENOENT" ? "missing_python" : "spawn_error",
        message: error.message,
      });
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_CHARS) {
        stdout += chunk.toString("utf8");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_CHARS) {
        stderr += chunk.toString("utf8");
      }
    });

    child.on("close", () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      const parsed = parseHelperResponse(stdout);
      if (parsed) {
        resolve(parsed);
        return;
      }
      resolve({
        ok: false,
        model: "",
        dim: 0,
        code: "invalid_response",
        message: stderr.trim() || "FastEmbed helper returned invalid JSON.",
      });
    });

    child.stdin.end(body, "utf8");
  });
}

function parseHelperResponse(stdout: string): SemanticEmbeddingResponse | null {
  try {
    const parsed = JSON.parse(stdout.trim()) as SemanticEmbeddingResponse;
    if (typeof parsed?.ok === "boolean") {
      return parsed;
    }
  } catch {
    return null;
  }

  return null;
}

async function loadNodeEmbeddingRuntime(): Promise<NodeEmbeddingRuntime> {
  const childProcess = await import("child_process");
  return {
    spawn: childProcess.spawn,
  };
}

const PYTHON_FASTEMBED_HELPER = String.raw`
import json
import math
import os
import sys

def emit(payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=True, separators=(",", ":")))
    sys.stdout.flush()

def fail(code, message, model="", dim=0):
    emit({"ok": False, "model": model, "dim": dim, "code": code, "message": message})

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

def main():
    try:
        request = json.loads(sys.stdin.read())
    except Exception as error:
        fail("invalid_json", str(error))
        return

    model = str(request.get("model") or "nomic-ai/nomic-embed-text-v1.5-Q")
    dim = int(request.get("dim") or 512)
    cache_dir = str(request.get("cacheDir") or "").strip()
    documents = request.get("documents") or []
    queries = request.get("queries") or []

    if dim not in (256, 512):
        fail("invalid_dim", "dim must be 256 or 512", model, dim)
        return

    if cache_dir:
        os.makedirs(cache_dir, exist_ok=True)
        os.environ["FASTEMBED_CACHE_PATH"] = cache_dir

    try:
        from fastembed import TextEmbedding
    except ImportError:
        fail("missing_fastembed", "Install FastEmbed with: python -m pip install fastembed", model, dim)
        return

    try:
        try:
            embedding_model = TextEmbedding(model_name=model, cache_dir=cache_dir or None)
        except TypeError:
            embedding_model = TextEmbedding(model_name=model)

        list(embedding_model.embed(["search_query: warmup"], batch_size=1))
        document_inputs = ["search_document: " + str(item) for item in documents]
        query_inputs = ["search_query: " + str(item) for item in queries]
        document_vectors = []
        query_vectors = []
        if document_inputs:
            for batch in embedding_model.embed(document_inputs, batch_size=16):
                for vector in batch:
                    document_vectors.append(matryoshka(vector, dim))
        if query_inputs:
            for batch in embedding_model.embed(query_inputs, batch_size=16):
                for vector in batch:
                    query_vectors.append(matryoshka(vector, dim))
    except Exception as error:
        fail("embed_failed", str(error), model, dim)
        return

    emit({
        "ok": True,
        "model": model,
        "dim": dim,
        "documents": document_vectors,
        "queries": query_vectors,
        "downloadedOrVerified": True,
        "cacheDir": cache_dir,
    })

main()
`;
