export const EXTENSION_OWNED_PLUGIN_DATA_KEYS = Object.freeze([
  "schemaVersion",
  "codeRuntimeState",
  "codeRepairCheckpointsV1",
  "codeValidationReceiptsV1",
  "companionRuntimeState",
  "backgroundGitHubHostStateV1",
] as const);

/**
 * Selects only extension-owned namespaces for a core read-modify-write. Core
 * must not spread arbitrary or legacy credential fields back into data.json.
 */
export function selectExtensionOwnedPluginData(
  value: unknown,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const selected: Record<string, unknown> = {};
  for (const key of EXTENSION_OWNED_PLUGIN_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      selected[key] = record[key];
    }
  }
  return selected;
}
