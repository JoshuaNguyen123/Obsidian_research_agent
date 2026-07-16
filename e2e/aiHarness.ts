export interface E2EAiConfig {
  mode: "mock" | "real";
  model: string;
  baseUrl: string;
  missionTimeoutMs: number;
  firstChunkTimeoutMs: number;
  completionTimeoutMs: number;
  /** Legacy monolith compatibility only; live contract specs never use this. */
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
  // Default `npm run test:e2e` is the live real-ai-contract pack (credentials).
  // Deterministic matrix uses `npm run test:e2e:mock` / `--mock-ai`.
  const mode = process.env.E2E_AI_MODE === "real" ? "real" : "mock";

  return {
    mode,
    model: process.env.E2E_AI_MODEL?.trim() || "gpt-oss:120b-cloud",
    baseUrl: process.env.E2E_OLLAMA_BASE_URL?.trim() || "https://ollama.com/api",
    missionTimeoutMs: readTimeout("E2E_MISSION_TIMEOUT_MS", 600_000),
    firstChunkTimeoutMs: readTimeout("E2E_FIRST_CHUNK_TIMEOUT_MS", 180_000),
    completionTimeoutMs: readTimeout("E2E_COMPLETION_TIMEOUT_MS", 600_000),
    interCallPauseMs: readTimeout("E2E_AI_CALL_PAUSE_MS", 0),
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

/** Node-only credential source. Never pass this value to page.evaluate. */
export function getE2EAiCredential(
  provider: "ollama" | "openai_compatible" = "ollama",
): string {
  return (
    (provider === "openai_compatible"
      ? process.env.E2E_OPENAI_COMPATIBLE_API_KEY?.trim()
      : process.env.E2E_OLLAMA_API_KEY?.trim()) ||
    ""
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
