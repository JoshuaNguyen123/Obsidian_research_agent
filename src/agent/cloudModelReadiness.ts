/**
 * Cloud BYOK first-run readiness helpers (Ollama Cloud + OpenAI-compatible).
 * Pure/testable without Obsidian.
 */

export type CloudProviderKind = "ollama" | "openai_compatible";

export interface CloudConnectionGateInput {
  verified: boolean;
  provider: CloudProviderKind | string;
  model: string;
  hasApiKey: boolean;
  baseUrl: string;
}

export interface CloudConnectionGateResult {
  ok: boolean;
  what: string;
  why: string;
  next: string;
  chatLine: string;
}

export function evaluateCloudConnectionGate(
  input: CloudConnectionGateInput,
): CloudConnectionGateResult {
  if (input.verified) {
    return {
      ok: true,
      what: "Model connection is ready.",
      why: "Provider, model, and connection test match the current settings.",
      next: "Run Mission when ready.",
      chatLine: "Model connection ready.",
    };
  }

  const provider = input.provider === "openai_compatible" ? "openai_compatible" : "ollama";
  const isCloudish =
    provider === "openai_compatible" || /ollama\.com/i.test(input.baseUrl);
  const missingKey = isCloudish && !input.hasApiKey;

  if (missingKey) {
    const what =
      provider === "openai_compatible"
        ? "OpenAI-compatible API key is missing."
        : "Ollama Cloud API key is missing.";
    const next =
      provider === "openai_compatible"
        ? "Open settings, paste your API key, set the base URL and model, then Test connection."
        : "Open settings, paste your Ollama Cloud API key, set the model tag, then Test connection.";
    return {
      ok: false,
      what,
      why: "Cloud providers require a BYOK credential before missions can start.",
      next,
      chatLine: `What: ${what} Why: Cloud providers require a BYOK credential before missions can start. Next: ${next}`,
    };
  }

  const what = "Model connection has not been verified.";
  const why =
    "Run Mission requires a successful Test connection for the current provider and model.";
  const next =
    provider === "openai_compatible"
      ? "Open settings, confirm base URL and model, then click Test connection."
      : "Open settings, confirm the model tag, then click Test connection.";
  return {
    ok: false,
    what,
    why,
    next,
    chatLine: `What: ${what} Why: ${why} Next: ${next}`,
  };
}

export function cloudProviderNeedsApiKey(
  provider: CloudProviderKind | string,
  baseUrl: string,
): boolean {
  if (provider === "openai_compatible") {
    return !isLocalBaseUrl(baseUrl);
  }
  return /ollama\.com/i.test(baseUrl);
}

function isLocalBaseUrl(baseUrl: string): boolean {
  try {
    const hostname = new URL(baseUrl.trim()).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
  } catch {
    return false;
  }
}
