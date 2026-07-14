import { fingerprintCanonicalJson } from "../agent/queue/fingerprint";

export const BUNDLED_CAPABILITY_DATA_VERSION = 1 as const;

export const BUNDLED_CAPABILITY_NAMESPACES = [
  "code",
  "integrations",
  "companion",
] as const;

export type BundledCapabilityNamespace =
  (typeof BUNDLED_CAPABILITY_NAMESPACES)[number];

export const LEGACY_CAPABILITY_PLUGIN_IDS: Readonly<
  Record<BundledCapabilityNamespace, string>
> = Object.freeze({
  code: "agentic-researcher-code",
  integrations: "agentic-researcher-integrations",
  companion: "agentic-researcher-companion",
});

export interface BundledCapabilityImportV1 {
  sourcePluginId: string;
  sourceFingerprint: string;
  importedAt: string;
}

export interface BundledCapabilityModuleDataV1 {
  state: Record<string, unknown>;
  legacyImport: BundledCapabilityImportV1 | null;
  updatedAt: string;
}

export interface BundledCapabilityDataV1 {
  version: typeof BUNDLED_CAPABILITY_DATA_VERSION;
  modules: Record<
    BundledCapabilityNamespace,
    BundledCapabilityModuleDataV1
  >;
}

export function createEmptyBundledCapabilityData(
  createdAt: string,
): BundledCapabilityDataV1 {
  const at = expectIsoTimestamp(createdAt, "bundled capability creation time");
  return freezeClone({
    version: BUNDLED_CAPABILITY_DATA_VERSION,
    modules: {
      code: emptyModule(at),
      integrations: emptyModule(at),
      companion: emptyModule(at),
    },
  });
}

export function parseBundledCapabilityData(
  value: unknown,
  createdAt: string,
): BundledCapabilityDataV1 {
  if (value === undefined || value === null) {
    return createEmptyBundledCapabilityData(createdAt);
  }
  const root = expectRecord(value, "bundled capability data");
  assertExactKeys(root, ["version", "modules"]);
  if (root.version !== BUNDLED_CAPABILITY_DATA_VERSION) {
    throw new Error("Unsupported bundled capability data version.");
  }
  const modules = expectRecord(root.modules, "bundled capability modules");
  assertExactKeys(modules, BUNDLED_CAPABILITY_NAMESPACES);
  return freezeClone({
    version: BUNDLED_CAPABILITY_DATA_VERSION,
    modules: {
      code: parseModule(modules.code, "code"),
      integrations: parseModule(modules.integrations, "integrations"),
      companion: parseModule(modules.companion, "companion"),
    },
  });
}

export function importLegacyBundledCapabilityData(input: {
  current: BundledCapabilityDataV1;
  legacy: Partial<Record<BundledCapabilityNamespace, unknown>>;
  importedAt: string;
}): { data: BundledCapabilityDataV1; imported: BundledCapabilityNamespace[] } {
  const importedAt = expectIsoTimestamp(
    input.importedAt,
    "bundled capability import time",
  );
  const current = parseBundledCapabilityData(input.current, importedAt);
  const modules = clone(current.modules);
  const imported: BundledCapabilityNamespace[] = [];

  for (const namespace of BUNDLED_CAPABILITY_NAMESPACES) {
    const source = input.legacy[namespace];
    if (
      source === undefined ||
      source === null ||
      Object.keys(modules[namespace].state).length > 0
    ) {
      continue;
    }
    const state = expectRecord(source, `${namespace} legacy plugin data`);
    if (Object.keys(state).length === 0) continue;
    modules[namespace] = {
      state: clone(state),
      legacyImport: {
        sourcePluginId: LEGACY_CAPABILITY_PLUGIN_IDS[namespace],
        sourceFingerprint: fingerprintCanonicalJson(state),
        importedAt,
      },
      updatedAt: importedAt,
    };
    imported.push(namespace);
  }

  return {
    data: freezeClone({
      version: BUNDLED_CAPABILITY_DATA_VERSION,
      modules,
    }),
    imported,
  };
}

export function readBundledCapabilityState(
  data: BundledCapabilityDataV1,
  namespace: BundledCapabilityNamespace,
): Record<string, unknown> {
  const parsed = parseBundledCapabilityData(
    data,
    data.modules[namespace].updatedAt,
  );
  return clone(parsed.modules[namespace].state);
}

export function writeBundledCapabilityState(input: {
  current: BundledCapabilityDataV1;
  namespace: BundledCapabilityNamespace;
  state: unknown;
  updatedAt: string;
}): BundledCapabilityDataV1 {
  const updatedAt = expectIsoTimestamp(
    input.updatedAt,
    "bundled capability update time",
  );
  const current = parseBundledCapabilityData(input.current, updatedAt);
  const state = expectRecord(
    input.state,
    `${input.namespace} bundled capability state`,
  );
  const modules = clone(current.modules);
  modules[input.namespace] = {
    state: clone(state),
    legacyImport: modules[input.namespace].legacyImport,
    updatedAt,
  };
  return freezeClone({
    version: BUNDLED_CAPABILITY_DATA_VERSION,
    modules,
  });
}

function emptyModule(at: string): BundledCapabilityModuleDataV1 {
  return { state: {}, legacyImport: null, updatedAt: at };
}

function parseModule(
  value: unknown,
  namespace: BundledCapabilityNamespace,
): BundledCapabilityModuleDataV1 {
  const module = expectRecord(value, `${namespace} bundled capability module`);
  assertExactKeys(module, ["state", "legacyImport", "updatedAt"]);
  return {
    state: clone(expectRecord(module.state, `${namespace} capability state`)),
    legacyImport:
      module.legacyImport === null
        ? null
        : parseLegacyImport(module.legacyImport, namespace),
    updatedAt: expectIsoTimestamp(
      module.updatedAt,
      `${namespace} capability update time`,
    ),
  };
}

function parseLegacyImport(
  value: unknown,
  namespace: BundledCapabilityNamespace,
): BundledCapabilityImportV1 {
  const record = expectRecord(value, `${namespace} legacy import`);
  assertExactKeys(record, [
    "sourcePluginId",
    "sourceFingerprint",
    "importedAt",
  ]);
  if (record.sourcePluginId !== LEGACY_CAPABILITY_PLUGIN_IDS[namespace]) {
    throw new Error(`${namespace} legacy import has the wrong source plugin.`);
  }
  if (
    typeof record.sourceFingerprint !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(record.sourceFingerprint)
  ) {
    throw new Error(`${namespace} legacy import fingerprint is invalid.`);
  }
  return {
    sourcePluginId: record.sourcePluginId,
    sourceFingerprint: record.sourceFingerprint,
    importedAt: expectIsoTimestamp(
      record.importedAt,
      `${namespace} legacy import time`,
    ),
  };
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  expected: readonly string[],
): void {
  const allowed = new Set(expected);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = expected.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `Bundled capability data keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}

function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function freezeClone<T>(value: T): T {
  return deepFreeze(clone(value));
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
