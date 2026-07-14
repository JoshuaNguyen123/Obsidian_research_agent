export interface E2EAiConfig {
  mode: "mock" | "real";
  model: string;
  baseUrl: string;
  apiKey: string;
  missionTimeoutMs: number;
  firstChunkTimeoutMs: number;
  completionTimeoutMs: number;
  interCallPauseMs: number;
  reasoningEffort?: string;
}

export interface E2ESemanticEmbeddingConfig {
  mode: "mock" | "ollama";
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export function getE2EAiConfig(): E2EAiConfig {
  // The default `test:e2e` lane is deterministic and passes --mock-ai.
  // Opt-in `test:e2e:real*` lanes pass --real-ai (gpt-oss:120b-cloud).
  const mode = process.env.E2E_AI_MODE === "real" ? "real" : "mock";

  return {
    mode,
    model: process.env.E2E_AI_MODEL?.trim() || "gpt-oss:120b-cloud",
    baseUrl: process.env.E2E_OLLAMA_BASE_URL?.trim() || "https://ollama.com/api",
    apiKey: process.env.E2E_OLLAMA_API_KEY?.trim() || "",
    missionTimeoutMs: readTimeout("E2E_MISSION_TIMEOUT_MS", 600_000),
    firstChunkTimeoutMs: readTimeout("E2E_FIRST_CHUNK_TIMEOUT_MS", 180_000),
    completionTimeoutMs: readTimeout("E2E_COMPLETION_TIMEOUT_MS", 600_000),
    interCallPauseMs: readTimeout("E2E_AI_CALL_PAUSE_MS", 30_000),
    reasoningEffort: process.env.E2E_REASONING_EFFORT?.trim() || undefined,
  };
}

export function getE2ESemanticEmbeddingConfig(): E2ESemanticEmbeddingConfig {
  return {
    mode:
      process.env.E2E_SEMANTIC_EMBEDDING_MODE === "ollama"
        ? "ollama"
        : "mock",
    model:
      process.env.E2E_SEMANTIC_EMBEDDING_MODEL?.trim() ||
      "nomic-embed-text:v1.5",
    baseUrl:
      process.env.E2E_SEMANTIC_EMBEDDING_BASE_URL?.trim() ||
      "http://127.0.0.1:11434",
    timeoutMs: readTimeout("E2E_SEMANTIC_EMBEDDING_TIMEOUT_MS", 120_000),
  };
}

export function shouldRunRealAiE2E(): boolean {
  return (
    process.env.E2E_REAL_AI === "1" &&
    process.env.E2E_AI_MODE === "real"
  );
}

function readTimeout(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}
