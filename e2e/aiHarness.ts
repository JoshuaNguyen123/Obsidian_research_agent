export interface E2EAiConfig {
  mode: "mock" | "real";
  model: string;
  baseUrl: string;
  apiKey: string;
  missionTimeoutMs: number;
  firstChunkTimeoutMs: number;
  completionTimeoutMs: number;
}

export function getE2EAiConfig(): E2EAiConfig {
  const mode = process.env.E2E_AI_MODE === "real" ? "real" : "mock";

  return {
    mode,
    model: process.env.E2E_AI_MODEL?.trim() || "gpt-oss:120b",
    baseUrl: process.env.E2E_OLLAMA_BASE_URL?.trim() || "https://ollama.com/api",
    apiKey: process.env.E2E_OLLAMA_API_KEY?.trim() || "",
    missionTimeoutMs: readTimeout("E2E_MISSION_TIMEOUT_MS", 600_000),
    firstChunkTimeoutMs: readTimeout("E2E_FIRST_CHUNK_TIMEOUT_MS", 180_000),
    completionTimeoutMs: readTimeout("E2E_COMPLETION_TIMEOUT_MS", 600_000),
  };
}

export function shouldRunRealAiE2E(): boolean {
  return (
    process.env.E2E_REAL_AI === "1" &&
    process.env.E2E_AI_MODE === "real" &&
    Boolean(process.env.E2E_OLLAMA_API_KEY?.trim())
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
