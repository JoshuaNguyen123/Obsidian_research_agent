import {
  canonicalJson,
  type JsonValue,
  type ResourceAction,
  type ResourceRef,
  type ResourceSystem,
} from "../../agent/actions";

const RESOURCE_SYSTEMS = new Set<ResourceSystem>([
  "vault",
  "web",
  "browser",
  "workspace",
  "git",
  "linear",
  "github",
]);

export const RESOURCE_ACTIONS = new Set<ResourceAction>([
  "read",
  "list",
  "search",
  "create",
  "append",
  "update",
  "replace",
  "move",
  "archive",
  "unarchive",
  "trash",
  "delete",
  "restore",
  "link",
  "unlink",
  "validate",
  "promote",
  "merge",
  "execute",
  "install",
  "commit",
  "integrate",
  "publish",
]);

const OPTIONAL_RESOURCE_KEYS = [
  "identifier",
  "url",
  "path",
  "accountId",
  "containerId",
  "workspaceId",
  "teamId",
  "projectId",
  "repositoryId",
  "repositoryProfileId",
  "revision",
] as const;

const CREDENTIAL_KEY = /^(?:(?:linear|github|client)?[_-]?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|password|secret|private[_-]?key)|authorization|cookie)$/i;
const CREDENTIAL_VALUE = /\b(?:lin_api_[a-zA-Z0-9_-]{12,}|gh[pousr]_[a-zA-Z0-9]{12,}|github_pat_[a-zA-Z0-9_]{12,}|bearer\s+[a-zA-Z0-9._~+/-]{12,})\b/i;

export function expectRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function assertKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  label = "record",
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  if (missing.length > 0 || unknown.length > 0) {
    throw new Error(
      `${label} keys are invalid (missing: ${missing.join(", ") || "none"}; unknown: ${unknown.join(", ") || "none"}).`,
    );
  }
}

export function expectText(
  value: unknown,
  label: string,
  maximumLength: number,
): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maximumLength ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)
  ) {
    throw new Error(`${label} is empty, too long, or contains control characters.`);
  }
  return value;
}

export function expectIdentifier(
  value: unknown,
  label: string,
  maximumLength = 512,
): string {
  const identifier = expectText(value, label, maximumLength);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(identifier)) {
    throw new Error(`${label} contains unsupported identifier characters.`);
  }
  return identifier;
}

export function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

export function expectIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

export function expectSafeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < minimum ||
    (value as number) > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

export function expectJsonRecord(
  value: unknown,
  label: string,
  maximumBytes = 100_000,
): Record<string, JsonValue> {
  const record = expectRecord(value, label);
  let canonical: string;
  try {
    canonical = canonicalJson(record);
  } catch {
    throw new Error(`${label} must contain JSON values only.`);
  }
  if (new TextEncoder().encode(canonical).length > maximumBytes) {
    throw new Error(`${label} exceeds its ${maximumBytes}-byte bound.`);
  }
  return JSON.parse(canonical) as Record<string, JsonValue>;
}

export function assertNoCredentialKeys(value: JsonValue, label: string): void {
  const visit = (current: JsonValue, path: string, depth: number): void => {
    if (depth > 24) {
      throw new Error(`${label} exceeds the maximum nesting depth.`);
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${path}[${index}]`, depth + 1));
      return;
    }
    if (current !== null && typeof current === "object") {
      for (const [key, child] of Object.entries(current)) {
        if (CREDENTIAL_KEY.test(key)) {
          throw new Error(`${label} may not persist credential field ${path}.${key}.`);
        }
        visit(child, `${path}.${key}`, depth + 1);
      }
    }
  };
  visit(value, "$", 0);
}

export function assertNoCredentialMaterial(value: JsonValue, label: string): void {
  const visit = (current: JsonValue, depth: number): void => {
    if (depth > 24) {
      throw new Error(`${label} exceeds the maximum nesting depth.`);
    }
    if (typeof current === "string" && CREDENTIAL_VALUE.test(current)) {
      throw new Error(`${label} may not persist credential material.`);
    }
    if (Array.isArray(current)) {
      current.forEach((item) => visit(item, depth + 1));
    } else if (current !== null && typeof current === "object") {
      Object.values(current).forEach((item) => visit(item, depth + 1));
    }
  };
  visit(value, 0);
}

export function parseResourceRef(
  value: unknown,
  label: string,
  requiredSystem?: ResourceSystem,
): ResourceRef {
  const record = expectRecord(value, label);
  assertKeys(record, ["system", "resourceType", "id"], OPTIONAL_RESOURCE_KEYS, label);
  if (typeof record.system !== "string" || !RESOURCE_SYSTEMS.has(record.system as ResourceSystem)) {
    throw new Error(`${label} has an unsupported resource system.`);
  }
  const system = record.system as ResourceSystem;
  if (requiredSystem && system !== requiredSystem) {
    throw new Error(`${label} must belong to ${requiredSystem}.`);
  }
  const parsed: ResourceRef = {
    system,
    resourceType: expectIdentifier(record.resourceType, `${label} resource type`, 128),
    id: expectIdentifier(record.id, `${label} id`),
  };
  for (const key of OPTIONAL_RESOURCE_KEYS) {
    const valueAtKey = record[key];
    if (valueAtKey === undefined) continue;
    if (key === "url") {
      parsed.url = expectText(valueAtKey, `${label} URL`, 2_048);
    } else if (key === "path") {
      parsed.path = expectText(valueAtKey, `${label} path`, 2_048);
    } else {
      parsed[key] = expectIdentifier(valueAtKey, `${label} ${key}`);
    }
  }
  return parsed;
}

export function cloneSerializable<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function assertMonotonicTimestamp(
  next: string,
  previous: string,
  label: string,
): void {
  if (Date.parse(next) < Date.parse(previous)) {
    throw new Error(`${label} must not move backwards.`);
  }
}
