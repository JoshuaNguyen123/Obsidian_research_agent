/**
 * Secret-free plugin build stamp for persisted run records.
 *
 * Only `manifest.version` and `manifest.minAppVersion` belong here. The
 * helper rejects paths, tokens, note text, and any other payload so a
 * bug report can name a build without leaking vault or credential data.
 */

export const PLUGIN_VERSION_STAMP_MAX_LENGTH = 32;

const PLUGIN_VERSION_PATTERN =
  /^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[0-9A-Za-z](?:[0-9A-Za-z.-]{0,18}[0-9A-Za-z])?)?$/u;

export interface PluginVersionStamp {
  pluginVersion?: string;
  minAppVersion?: string;
}

export function normalizePluginVersion(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > PLUGIN_VERSION_STAMP_MAX_LENGTH ||
    !PLUGIN_VERSION_PATTERN.test(trimmed)
  ) {
    return undefined;
  }
  return trimmed;
}

export function normalizePluginVersionStamp(
  input:
    | {
        pluginVersion?: unknown;
        minAppVersion?: unknown;
      }
    | null
    | undefined,
): PluginVersionStamp {
  if (!input) {
    return {};
  }
  const pluginVersion = normalizePluginVersion(input.pluginVersion);
  const minAppVersion = normalizePluginVersion(input.minAppVersion);
  return {
    ...(pluginVersion ? { pluginVersion } : {}),
    ...(minAppVersion ? { minAppVersion } : {}),
  };
}

/** Read a host-supplied stamp from tool context or any similar bag. */
export function readPluginVersionStampFromHost(
  host: unknown,
): PluginVersionStamp {
  if (!host || typeof host !== "object") {
    return {};
  }
  const record = host as Record<string, unknown>;
  return normalizePluginVersionStamp({
    pluginVersion: record.pluginVersion,
    minAppVersion: record.minAppVersion,
  });
}

/**
 * Fill missing stamp fields only. An existing create-time version is kept so
 * a resumed run still reports the build that first persisted it.
 */
export function applyPluginVersionStampIfMissing<T extends PluginVersionStamp>(
  target: T,
  stamp: PluginVersionStamp,
): T {
  if (!target.pluginVersion && stamp.pluginVersion) {
    target.pluginVersion = stamp.pluginVersion;
  }
  if (!target.minAppVersion && stamp.minAppVersion) {
    target.minAppVersion = stamp.minAppVersion;
  }
  return target;
}
