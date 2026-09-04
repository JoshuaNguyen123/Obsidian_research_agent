import {
  NEW_INSTALL_SEMANTIC_PROFILE,
  SEMANTIC_PROFILE_PRESETS,
} from "../agent/semanticProfile";
import type { AgentSettings } from "../settings";

/**
 * The settings the retrieval stack reads, assembled without loading
 * `src/settings.ts`.
 *
 * That module imports `App`, `Notice`, `PluginSettingTab` and `Setting` from
 * `obsidian` as runtime values, and the `obsidian` package ships types only —
 * there is no module to require outside the app. Importing `DEFAULT_SETTINGS`
 * from it therefore makes any standalone process fail at load with
 * `Cannot find module 'obsidian'`, which is exactly what running the MCP
 * server for the first time did. Every other file in the retrieval chain uses
 * `import type`, which erases, so the settings module is the single thing
 * standing between this stack and running outside the plugin.
 *
 * The fix is not to stub `obsidian`. It is to notice the server needs about
 * fifteen fields, all of them semantic, and that the preset table already
 * holds most of them and imports nothing.
 *
 * Matching the vault's own values matters more than defaulting well: the index
 * manifest records the model and chunking it was built with, and a search
 * configured differently is refused as incompatible rather than answered
 * slightly worse. So a vault's stored `data.json` wins over every default
 * here.
 */

/** Defaults for a vault with no stored plugin settings. */
export const MCP_RETRIEVAL_SETTINGS_DEFAULTS_V1 = Object.freeze({
  ...SEMANTIC_PROFILE_PRESETS[NEW_INSTALL_SEMANTIC_PROFILE],
  semanticSearchEnabled: true,
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticPythonCommand: "",
  semanticModelCacheDir: "",
});

/**
 * Which stored keys are allowed through. An allowlist rather than a spread of
 * the whole file: `data.json` also holds API keys and endpoint URLs, and a
 * search server has no business carrying a credential it will never use into
 * a process it exposes to other software.
 */
export const MCP_RETRIEVAL_SETTINGS_KEYS_V1 = Object.freeze([
  "semanticSearchEnabled",
  "semanticIndexEnabled",
  "semanticIndexFolder",
  "semanticIndexMaxFiles",
  "semanticIndexPersistVectors",
  "semanticIndexDebounceMs",
  "semanticEmbeddingModel",
  "semanticEmbeddingDim",
  "semanticChunkMinTokens",
  "semanticChunkTargetTokens",
  "semanticChunkMaxTokens",
  "semanticChunkOverlapTokens",
  "semanticPythonCommand",
  "semanticModelCacheDir",
  "semanticOnnxProviders",
  "semanticRerankMode",
  "semanticRerankModel",
  "semanticRerankTopK",
] as const);

/**
 * Overlay a vault's stored settings onto the defaults, keeping only the
 * retrieval keys. Anything unreadable yields the defaults: a vault indexed
 * with them is the common case, and refusing to start would be worse than
 * reporting an incompatible index when a search arrives.
 */
export function resolveMcpRetrievalSettingsV1(stored: unknown): AgentSettings {
  const resolved: Record<string, unknown> = { ...MCP_RETRIEVAL_SETTINGS_DEFAULTS_V1 };
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of MCP_RETRIEVAL_SETTINGS_KEYS_V1) {
      const value = (stored as Record<string, unknown>)[key];
      if (value !== undefined) resolved[key] = value;
    }
  }
  return resolved as unknown as AgentSettings;
}

/** Keys a stored settings file may hold that must never be carried over. */
export function withheldMcpSettingKeysV1(stored: unknown): string[] {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return [];
  const allowed = new Set<string>(MCP_RETRIEVAL_SETTINGS_KEYS_V1);
  return Object.keys(stored as Record<string, unknown>).filter(
    (key) => !allowed.has(key),
  );
}
