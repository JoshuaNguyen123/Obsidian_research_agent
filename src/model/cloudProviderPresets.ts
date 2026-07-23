/**
 * First-class OpenAI-compatible (and Ollama Cloud) endpoint presets.
 */

export type CloudProviderPresetId =
  | "openai"
  | "openrouter"
  | "azure_openai"
  | "ollama_cloud";

export interface CloudProviderPreset {
  id: CloudProviderPresetId;
  label: string;
  provider: "ollama" | "openai_compatible";
  baseUrl: string;
  suggestedModel: string;
  description: string;
}

export const CLOUD_PROVIDER_PRESETS: readonly CloudProviderPreset[] = [
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    suggestedModel: "gpt-4o-mini",
    description: "Official OpenAI Chat Completions API.",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    provider: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    suggestedModel: "openai/gpt-4o-mini",
    description: "OpenAI-compatible router for many hosted models.",
  },
  {
    id: "azure_openai",
    label: "Azure OpenAI",
    provider: "openai_compatible",
    baseUrl: "https://YOUR_RESOURCE.openai.azure.com/openai/v1",
    suggestedModel: "gpt-4o-mini",
    description: "Replace YOUR_RESOURCE with your Azure OpenAI resource name.",
  },
  {
    id: "ollama_cloud",
    label: "Ollama Cloud",
    provider: "ollama",
    // Must include /api — chat hits `${baseUrl}/chat` → https://ollama.com/api/chat.
    baseUrl: "https://ollama.com/api",
    suggestedModel: "glm-5.2",
    description: "Ollama Cloud BYOK (ollama.com).",
  },
];

export function getCloudProviderPreset(
  id: string,
): CloudProviderPreset | undefined {
  return CLOUD_PROVIDER_PRESETS.find((preset) => preset.id === id);
}

export interface CloudPresetSettingsSlice {
  modelProvider: "ollama" | "openai_compatible";
  model: string;
  ollamaBaseUrl: string;
  openAiCompatibleBaseUrl: string;
}

function normalizePresetBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

/**
 * Heal the broken bare-host preset URL (`https://ollama.com`) that omitted `/api`.
 * Local and custom endpoints are left alone.
 */
export function repairOllamaCloudBaseUrl(baseUrl: string): string {
  const normalized = normalizePresetBaseUrl(baseUrl);
  if (normalized === "https://ollama.com" || normalized === "http://ollama.com") {
    return "https://ollama.com/api";
  }
  return baseUrl.trim() || baseUrl;
}

/**
 * Return the preset that matches the current provider + base URL, if any.
 * Used so the Endpoint preset dropdown stays selected after apply/redisplay.
 */
export function matchCloudProviderPreset(
  settings: CloudPresetSettingsSlice,
): CloudProviderPreset | undefined {
  const currentBase =
    settings.modelProvider === "openai_compatible"
      ? settings.openAiCompatibleBaseUrl
      : settings.ollamaBaseUrl;
  const normalizedCurrent = normalizePresetBaseUrl(currentBase);
  if (!normalizedCurrent) {
    return undefined;
  }
  return CLOUD_PROVIDER_PRESETS.find(
    (preset) =>
      preset.provider === settings.modelProvider &&
      normalizePresetBaseUrl(preset.baseUrl) === normalizedCurrent,
  );
}

/**
 * Apply endpoint defaults from a preset.
 * OpenAI-compatible presets also set a suggested model.
 * Ollama Cloud only sets the base URL — catalog/account availability is
 * authoritative and the model tag is left for the user to choose.
 */
export function applyCloudProviderPreset(
  settings: CloudPresetSettingsSlice,
  preset: CloudProviderPreset,
): void {
  settings.modelProvider = preset.provider;
  if (preset.provider === "openai_compatible") {
    settings.openAiCompatibleBaseUrl = preset.baseUrl;
    settings.model = preset.suggestedModel;
    return;
  }
  settings.ollamaBaseUrl = preset.baseUrl;
}
