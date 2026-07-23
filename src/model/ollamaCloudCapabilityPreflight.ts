import { normalizeOllamaBaseUrl } from "./OllamaClient";
import {
  ModelClientError,
  type HttpResponse,
  type HttpTransport,
  type ModelClientDescriptor,
} from "./types";

export const REQUIRED_OLLAMA_CLOUD_AGENT_CAPABILITIES = [
  "tools",
  "thinking",
] as const;

export interface OllamaCloudCapabilityPreflightOptions {
  descriptor: ModelClientDescriptor;
  baseUrl: string;
  apiKey: string;
  model: string;
  transport: HttpTransport;
  requestTimeoutMs?: number;
}

export interface OllamaCloudCapabilityPreflightResult {
  model: string;
  capabilities: string[];
  contextLength: number | null;
}

/**
 * Probe Ollama's official model metadata endpoint before a direct Ollama Cloud
 * connection is allowed to count as Automatic-ready. Non-cloud and custom
 * endpoints intentionally keep their existing chat-only connection behavior.
 */
export async function preflightOllamaCloudAgentCapabilities(
  options: OllamaCloudCapabilityPreflightOptions,
): Promise<OllamaCloudCapabilityPreflightResult | null> {
  if (
    options.descriptor.provider !== "ollama" ||
    options.descriptor.endpointCategory !== "ollama_cloud" ||
    !isDirectOllamaCloudApiBaseUrl(options.baseUrl)
  ) {
    return null;
  }

  const model = options.model.trim();
  if (!model) {
    throw new ModelClientError("api", "Model name is required.");
  }

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new ModelClientError(
      "missing_api_key",
      "Ollama Cloud requires an API key before model capabilities can be verified.",
    );
  }

  let response: HttpResponse;
  try {
    response = await options.transport({
      url: `${normalizeOllamaBaseUrl(options.baseUrl)}/show`,
      method: "POST",
      contentType: "application/json",
      headers: { Authorization: `Bearer ${apiKey}` },
      throw: false,
      timeoutMs: options.requestTimeoutMs,
      body: JSON.stringify({ model }),
    });
  } catch (error) {
    throw new ModelClientError(
      "network",
      `Ollama Cloud capability check failed: ${getUnknownErrorMessage(error)}`,
      { originalError: error },
    );
  }

  const body = getResponseBody(response);
  if (response.status >= 400) {
    throw mapShowHttpError(response.status, body);
  }
  if (!isRecord(body)) {
    throw new ModelClientError(
      "invalid_response",
      "Ollama Cloud /api/show returned invalid model metadata, so Automatic mode remains blocked.",
    );
  }

  assertResponseModelMatches(body, model);
  const capabilities = parseCapabilities(body.capabilities);
  const missing = REQUIRED_OLLAMA_CLOUD_AGENT_CAPABILITIES.filter(
    (capability) => !capabilities.includes(capability),
  );
  if (missing.length > 0) {
    throw new ModelClientError(
      "api",
      `Configured Ollama Cloud model ${model} is not Automatic-ready: /api/show did not report ${missing.join(
        " + ",
      )}. Choose an exact model tag marked Tools + Thinking + Cloud, then Test connection again.`,
      {
        details: {
          code: "ollama_cloud_capabilities_missing",
          model,
          missing,
          capabilities,
        },
      },
    );
  }

  return {
    model,
    capabilities,
    contextLength: parseContextLength(body.model_info),
  };
}

export function isDirectOllamaCloudApiBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(normalizeOllamaBaseUrl(baseUrl));
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "ollama.com" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.replace(/\/+$/u, "") === "/api"
    );
  } catch {
    return false;
  }
}

export function parseOllamaContextLength(modelInfo: unknown): number | null {
  return parseContextLength(modelInfo);
}

function parseCapabilities(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return [
    ...new Set(
      value
        .filter((entry): entry is string => typeof entry === "string")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

function parseContextLength(modelInfo: unknown): number | null {
  if (!isRecord(modelInfo)) {
    return null;
  }

  const candidates = Object.entries(modelInfo)
    .filter(([key]) => key.toLowerCase().endsWith("context_length"))
    .map(([, value]) => value)
    .filter(
      (value): value is number =>
        typeof value === "number" &&
        Number.isSafeInteger(value) &&
        value > 0,
    );

  // When metadata contains more than one architecture context length, expose
  // the conservative minimum rather than overstating usable capacity.
  return candidates.length > 0 ? Math.min(...candidates) : null;
}

function assertResponseModelMatches(
  body: Record<string, unknown>,
  requestedModel: string,
): void {
  const returnedModel =
    typeof body.model === "string"
      ? body.model.trim()
      : typeof body.name === "string"
        ? body.name.trim()
        : "";
  if (returnedModel && returnedModel !== requestedModel) {
    throw new ModelClientError(
      "invalid_response",
      `Ollama Cloud returned metadata for ${returnedModel} instead of the configured model ${requestedModel}; Automatic mode remains blocked.`,
      {
        details: {
          code: "ollama_cloud_model_identity_mismatch",
          requestedModel,
          returnedModel,
        },
      },
    );
  }
}

function mapShowHttpError(status: number, body: unknown): ModelClientError {
  const detail = getErrorDetail(body);
  if (status === 401 || status === 403) {
    return new ModelClientError(
      "auth",
      detail || "Ollama Cloud rejected the capability check. Check the API key.",
      { status },
    );
  }
  if (status === 429) {
    return new ModelClientError(
      "rate_limit",
      detail || "Ollama Cloud rate limited the capability check. Try again later.",
      { status },
    );
  }
  return new ModelClientError(
    "api",
    detail || `Ollama Cloud /api/show failed with status ${status}.`,
    { status },
  );
}

function getResponseBody(response: HttpResponse): unknown {
  if (response.json !== undefined) {
    return response.json;
  }
  if (!response.text) {
    return undefined;
  }
  try {
    return JSON.parse(response.text);
  } catch {
    return response.text;
  }
}

function getErrorDetail(body: unknown): string | null {
  if (typeof body === "string") {
    return body;
  }
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body.error === "string") {
    return body.error;
  }
  if (typeof body.message === "string") {
    return body.message;
  }
  return null;
}

function getUnknownErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
