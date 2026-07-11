let nodeRequireOverride: NodeRequire | null | undefined;

export function getNodeRequireForObsidian(): NodeRequire | null {
  if (nodeRequireOverride !== undefined) {
    return nodeRequireOverride;
  }

  if (typeof require === "function") {
    return require;
  }

  const windowRequire =
    typeof window !== "undefined"
      ? (window as Window & { require?: NodeRequire }).require
      : undefined;

  return typeof windowRequire === "function" ? windowRequire : null;
}

export function requireNodeModule<T>(specifier: string, feature: string): T {
  const nodeRequire = getNodeRequireForObsidian();
  if (!nodeRequire) {
    throw new Error(
      `${feature} requires Node require, which is unavailable in this Obsidian runtime.`,
    );
  }

  return nodeRequire(specifier) as T;
}

export function __setNodeRequireForTests(
  value: NodeRequire | null | undefined,
) {
  nodeRequireOverride = value;
}
