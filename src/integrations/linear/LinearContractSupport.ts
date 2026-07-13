import {
  canonicalJsonStringify,
  fingerprintCanonicalJson,
} from "../../agent/queue/fingerprint";

export class DurableLinearContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurableLinearContractError";
  }
}

export function expectPlainRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new DurableLinearContractError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DurableLinearContractError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

export function assertExactKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new DurableLinearContractError(
      `${label} keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
  for (const key of optional) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] === undefined) {
      throw new DurableLinearContractError(`${label} ${key} must be omitted rather than undefined.`);
    }
  }
}

export function expectString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
  options: { allowNewlines?: boolean; secretFree?: boolean } = {},
): string {
  if (typeof value !== "string") {
    throw new DurableLinearContractError(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new DurableLinearContractError(
      `${label} must contain ${minimumLength}-${maximumLength} characters.`,
    );
  }
  const controls = options.allowNewlines
    ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/
    : /[\u0000-\u001f\u007f]/;
  if (controls.test(normalized)) {
    throw new DurableLinearContractError(`${label} contains unsupported control characters.`);
  }
  if (options.secretFree !== false) {
    assertSecretFree(normalized, label);
  }
  return normalized;
}

export function expectLogicalKey(
  value: unknown,
  label: string,
  maximumLength = 128,
): string {
  const key = expectString(value, label, 1, maximumLength, { secretFree: true });
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) ||
    key === "__proto__" ||
    key === "prototype" ||
    key === "constructor"
  ) {
    throw new DurableLinearContractError(
      `${label} must be a logical binding key without path separators or command syntax.`,
    );
  }
  return key;
}

export function expectOpaqueId(
  value: unknown,
  label: string,
  maximumLength = 160,
): string {
  const identifier = expectString(value, label, 1, maximumLength, { secretFree: true });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(identifier)) {
    throw new DurableLinearContractError(`${label} contains unsupported characters.`);
  }
  return identifier;
}

export function expectSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new DurableLinearContractError(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

export function expectIsoTimestamp(value: unknown, label: string): string {
  const timestamp = expectString(value, label, 20, 30, { secretFree: true });
  const time = Date.parse(timestamp);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== timestamp) {
    throw new DurableLinearContractError(`${label} must be a canonical UTC ISO timestamp.`);
  }
  return timestamp;
}

export function expectInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new DurableLinearContractError(
      `${label} must be an integer from ${minimum} to ${maximum}.`,
    );
  }
  return value as number;
}

export function expectEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new DurableLinearContractError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

export function parseUniqueStrings(
  value: unknown,
  label: string,
  minimumEntries: number,
  maximumEntries: number,
  maximumLength: number,
  validator?: (value: string, label: string) => string,
): string[] {
  if (!Array.isArray(value) || value.length < minimumEntries || value.length > maximumEntries) {
    throw new DurableLinearContractError(
      `${label} list requires ${minimumEntries}-${maximumEntries} entries.`,
    );
  }
  const parsed = value.map((entry, index) => {
    const itemLabel = `${label} ${index + 1}`;
    const string = expectString(entry, itemLabel, 1, maximumLength, {
      allowNewlines: false,
      secretFree: true,
    });
    return validator ? validator(string, itemLabel) : string;
  });
  if (new Set(parsed).size !== parsed.length) {
    throw new DurableLinearContractError(`${label} list must not contain duplicates.`);
  }
  return parsed;
}

export function parseHttpUrl(value: unknown, label: string): string {
  const text = expectString(value, label, 1, 2_000, { secretFree: true });
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new DurableLinearContractError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password
  ) {
    throw new DurableLinearContractError(`${label} must be a credential-free HTTP(S) URL.`);
  }
  for (const key of url.searchParams.keys()) {
    if (/token|secret|password|credential|api[_-]?key|signature/i.test(key)) {
      throw new DurableLinearContractError(`${label} must not contain credential query parameters.`);
    }
  }
  return url.toString();
}

export function parseVaultMarkdownPath(value: unknown, label: string): string {
  const path = expectString(value, label, 1, 500, { secretFree: true });
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    /(^|\/)\.\.?(\/|$)/.test(path) ||
    /^[A-Za-z]:/.test(path) ||
    !path.toLowerCase().endsWith(".md") ||
    /^(?:\.obsidian|\.agent-backups)(?:\/|$)/i.test(path)
  ) {
    throw new DurableLinearContractError(`${label} must be a safe vault-relative Markdown path.`);
  }
  return path;
}

export function assertSecretFree(value: string, label: string): void {
  const secretPatterns = [
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
    /\bsk-[A-Za-z0-9_-]{12,}\b/,
    /\bgithub_pat_[A-Za-z0-9_]{20,}\b/i,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/i,
    /\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password)\s*[:=]\s*\S+/i,
  ];
  if (secretPatterns.some((pattern) => pattern.test(value))) {
    throw new DurableLinearContractError(`${label} must not contain credentials or secrets.`);
  }
}

export function assertNoRawAuthority(value: string, label: string): void {
  const rawAuthorityPatterns = [
    /[A-Za-z]:[\\/]/,
    /(?:^|[\s"'`])\.\.[\\/]/,
    /\\\\[^\s]+/,
    /(?:^|\s)\/(?:etc|home|Users|var|tmp|opt|root|mnt|srv)\//i,
    /(?:^|[\s"'`])(?:\.\/)?(?:src|test|tests|docs|packages|extensions|app|lib|bin|config|scripts)\/[A-Za-z0-9_./-]+/i,
    /```/,
    /(?:^|\n)\s*[$>]\s*\S+/m,
    /(?:^|\n)\s*(?:npm|pnpm|yarn|npx|node|python|python3|pytest|cargo|mvn|gradle|dotnet|git|powershell|pwsh|cmd|bash|sh)(?:\s|$)/im,
    /\b(?:run|execute|invoke)\s+(?:npm|pnpm|yarn|npx|node|python|python3|pytest|cargo|mvn|gradle|dotnet|git|powershell|pwsh|cmd|bash|sh)(?:\s|$)/i,
    /(?:&&|\|\|)/,
  ];
  if (rawAuthorityPatterns.some((pattern) => pattern.test(value))) {
    throw new DurableLinearContractError(
      `${label} must not contain raw filesystem paths, shell commands, or executable authority.`,
    );
  }
}

export function assertCanonicalContract(
  rawUnsigned: unknown,
  parsedUnsigned: unknown,
  label: string,
): void {
  try {
    if (canonicalJsonStringify(rawUnsigned) !== canonicalJsonStringify(parsedUnsigned)) {
      throw new DurableLinearContractError(`${label} values must already be in canonical form.`);
    }
  } catch (error) {
    if (error instanceof DurableLinearContractError) {
      throw error;
    }
    throw new DurableLinearContractError(
      `${label} contains a value that canonical JSON cannot represent.`,
    );
  }
}

export function fingerprintContract(value: unknown): string {
  return fingerprintCanonicalJson(value);
}

export function constantTimeFingerprintEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}
