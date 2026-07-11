import {
  canonicalJsonStringify,
  fingerprintCanonicalJson,
} from "../../agent/queue/fingerprint";

export const WORK_ITEM_SPEC_SCHEMA_VERSION = 1 as const;

export type WorkItemExecutionClass = "research" | "vault" | "code" | "human";
export type WorkItemRiskClass = "low" | "medium" | "high";

export interface WorkItemAcceptanceCriterionV1 {
  id: string;
  text: string;
}

/**
 * The machine contract embedded in an executable Linear issue description.
 * `fingerprint` covers every other field and is never trusted without parsing.
 */
export interface WorkItemSpecV1 {
  schemaVersion: typeof WORK_ITEM_SPEC_SCHEMA_VERSION;
  ready: true;
  executionClass: WorkItemExecutionClass;
  objective: string;
  repositoryKey?: string;
  acceptanceCriteria: WorkItemAcceptanceCriterionV1[];
  validationRequirements: string[];
  evidenceRefs: string[];
  riskClass: WorkItemRiskClass;
  originRunId: string;
  parentIssueId?: string;
  generation: number;
  fingerprint: string;
}

export type WorkItemSpecV1Unsigned = Omit<WorkItemSpecV1, "fingerprint">;

export class WorkItemContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemContractError";
  }
}

export function createWorkItemSpecV1(input: WorkItemSpecV1Unsigned): WorkItemSpecV1 {
  const unsigned = parseUnsignedWorkItemSpecV1(input);
  return {
    ...unsigned,
    fingerprint: fingerprintWorkItemSpecV1(unsigned),
  };
}

export function parseWorkItemSpecV1(value: unknown): WorkItemSpecV1 {
  const record = expectRecord(value, "work item");
  assertContractKeys(record, true);
  const { fingerprint: rawFingerprint, ...unsignedValue } = record;
  const unsigned = parseUnsignedWorkItemSpecV1(unsignedValue);
  try {
    if (canonicalJsonStringify(unsignedValue) !== canonicalJsonStringify(unsigned)) {
      throw new WorkItemContractError(
        "Work item contract values must already be in canonical form.",
      );
    }
  } catch (error) {
    if (error instanceof WorkItemContractError) {
      throw error;
    }
    throw new WorkItemContractError(
      "Work item contract contains a value that canonical JSON cannot represent.",
    );
  }
  const fingerprint = expectFingerprint(rawFingerprint);
  const expected = fingerprintWorkItemSpecV1(unsigned);
  if (!constantTimeTextEqual(fingerprint, expected)) {
    throw new WorkItemContractError(
      "Work item fingerprint does not match its canonical contract payload.",
    );
  }
  return { ...unsigned, fingerprint };
}

export function fingerprintWorkItemSpecV1(
  value: WorkItemSpecV1Unsigned | WorkItemSpecV1,
): string {
  const record = expectRecord(value, "work item fingerprint input");
  const { fingerprint: _ignored, ...unsignedValue } = record;
  const unsigned = parseUnsignedWorkItemSpecV1(unsignedValue);
  return fingerprintCanonicalJson(unsigned);
}

export function verifyWorkItemSpecV1(value: unknown): value is WorkItemSpecV1 {
  try {
    parseWorkItemSpecV1(value);
    return true;
  } catch {
    return false;
  }
}

function parseUnsignedWorkItemSpecV1(value: unknown): WorkItemSpecV1Unsigned {
  const record = expectRecord(value, "work item");
  assertContractKeys(record, false);
  if (record.schemaVersion !== WORK_ITEM_SPEC_SCHEMA_VERSION) {
    throw new WorkItemContractError("Unsupported work item schema version.");
  }
  if (record.ready !== true) {
    throw new WorkItemContractError("Work item ready must be the literal true.");
  }
  const executionClass = expectEnum<WorkItemExecutionClass>(
    record.executionClass,
    "execution class",
    ["research", "vault", "code", "human"],
  );
  const objective = expectString(record.objective, "objective", 1, 4_000, true);
  if (hasOwn(record, "repositoryKey") && record.repositoryKey === undefined) {
    throw new WorkItemContractError("Repository key must be omitted rather than undefined.");
  }
  const repositoryKey = optionalIdentifier(record.repositoryKey, "repository key");
  const acceptanceCriteria = parseAcceptanceCriteria(record.acceptanceCriteria);
  const validationRequirements = parseUniqueStrings(
    record.validationRequirements,
    "validation requirement",
    1,
    20,
    500,
  );
  const evidenceRefs = parseUniqueStrings(
    record.evidenceRefs,
    "evidence reference",
    1,
    50,
    500,
  );
  const riskClass = expectEnum<WorkItemRiskClass>(
    record.riskClass,
    "risk class",
    ["low", "medium", "high"],
  );
  const originRunId = expectIdentifier(record.originRunId, "origin run id", 160);
  if (hasOwn(record, "parentIssueId") && record.parentIssueId === undefined) {
    throw new WorkItemContractError("Parent issue id must be omitted rather than undefined.");
  }
  const parentIssueId = optionalIdentifier(record.parentIssueId, "parent issue id", 160);
  const generation = expectInteger(record.generation, "generation", 0, 2);

  if (executionClass === "code" && !repositoryKey) {
    throw new WorkItemContractError(
      "A ready code work item requires a repository key.",
    );
  }
  if (generation > 0 && !parentIssueId) {
    throw new WorkItemContractError(
      "A generated child work item requires a parent issue id.",
    );
  }

  return {
    schemaVersion: WORK_ITEM_SPEC_SCHEMA_VERSION,
    ready: true,
    executionClass,
    objective,
    ...(repositoryKey ? { repositoryKey } : {}),
    acceptanceCriteria,
    validationRequirements,
    evidenceRefs,
    riskClass,
    originRunId,
    ...(parentIssueId ? { parentIssueId } : {}),
    generation,
  };
}

function parseAcceptanceCriteria(value: unknown): WorkItemAcceptanceCriterionV1[] {
  if (!Array.isArray(value)) {
    throw new WorkItemContractError("Acceptance criteria must be an array.");
  }
  if (value.length < 1 || value.length > 20) {
    throw new WorkItemContractError("Acceptance criteria require 1-20 entries.");
  }
  const ids = new Set<string>();
  return value.map((rawCriterion, index) => {
    const criterion = expectRecord(rawCriterion, `acceptance criterion ${index + 1}`);
    assertExactKeys(criterion, ["id", "text"], `acceptance criterion ${index + 1}`);
    if (typeof criterion.id !== "string" || !/^AC-[1-9][0-9]?$/.test(criterion.id)) {
      throw new WorkItemContractError(
        `Acceptance criterion ${index + 1} id must match AC-1 through AC-99.`,
      );
    }
    const id = criterion.id;
    if (ids.has(id)) {
      throw new WorkItemContractError(`Acceptance criterion id ${id} is duplicated.`);
    }
    ids.add(id);
    return {
      id,
      text: expectString(
        criterion.text,
        `acceptance criterion ${index + 1} text`,
        1,
        500,
        true,
      ),
    };
  });
}

function parseUniqueStrings(
  value: unknown,
  label: string,
  minimumEntries: number,
  maximumEntries: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value)) {
    throw new WorkItemContractError(`${label} list must be an array.`);
  }
  if (value.length < minimumEntries || value.length > maximumEntries) {
    throw new WorkItemContractError(
      `${label} list requires ${minimumEntries}-${maximumEntries} entries.`,
    );
  }
  const parsed = value.map((entry, index) =>
    expectString(entry, `${label} ${index + 1}`, 1, maximumLength, true),
  );
  if (new Set(parsed).size !== parsed.length) {
    throw new WorkItemContractError(`${label} list must not contain duplicates.`);
  }
  return parsed;
}

function assertContractKeys(record: Record<string, unknown>, signed: boolean): void {
  const required = [
    "schemaVersion",
    "ready",
    "executionClass",
    "objective",
    "acceptanceCriteria",
    "validationRequirements",
    "evidenceRefs",
    "riskClass",
    "originRunId",
    "generation",
    ...(signed ? ["fingerprint"] : []),
  ];
  const optional = ["repositoryKey", "parentIssueId"];
  const allowed = new Set([...required, ...optional]);
  const unknown = Object.keys(record).filter((key) => !allowed.has(key));
  const missing = required.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new WorkItemContractError(
      `Work item keys do not match the v1 contract (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}

function expectFingerprint(value: unknown): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new WorkItemContractError("Work item fingerprint must be a SHA-256 fingerprint.");
  }
  return value;
}

function constantTimeTextEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function optionalIdentifier(
  value: unknown,
  label: string,
  maximumLength = 128,
): string | undefined {
  return value === undefined ? undefined : expectIdentifier(value, label, maximumLength);
}

function expectIdentifier(value: unknown, label: string, maximumLength = 128): string {
  const identifier = expectString(value, label, 1, maximumLength, false);
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(identifier) ||
    isReservedObjectKey(identifier)
  ) {
    throw new WorkItemContractError(`${label} contains unsupported identifier characters.`);
  }
  return identifier;
}

function isReservedObjectKey(value: string): boolean {
  return value === "__proto__" || value === "prototype" || value === "constructor";
}

function expectInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WorkItemContractError(`${label} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value as number;
}

function expectEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new WorkItemContractError(`${label} must be one of: ${allowed.join(", ")}.`);
  }
  return value as T;
}

function expectString(
  value: unknown,
  label: string,
  minimumLength: number,
  maximumLength: number,
  allowNewlines: boolean,
): string {
  if (typeof value !== "string") {
    throw new WorkItemContractError(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length < minimumLength || normalized.length > maximumLength) {
    throw new WorkItemContractError(
      `${label} must contain ${minimumLength}-${maximumLength} characters.`,
    );
  }
  const controlPattern = allowNewlines ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  if (controlPattern.test(normalized)) {
    throw new WorkItemContractError(`${label} contains unsupported control characters.`);
  }
  return normalized;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkItemContractError(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new WorkItemContractError(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  record: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter(
    (key) => !Object.prototype.hasOwnProperty.call(record, key),
  );
  if (unknown.length > 0 || missing.length > 0) {
    throw new WorkItemContractError(
      `${label} keys do not match the v1 contract (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
