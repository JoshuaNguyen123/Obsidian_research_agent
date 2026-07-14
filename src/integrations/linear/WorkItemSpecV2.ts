import {
  parseWorkItemSpecV1,
  type WorkItemAcceptanceCriterionV1,
  type WorkItemExecutionClass,
  type WorkItemRiskClass,
  type WorkItemSpecV1,
} from "./WorkItemSpecV1";
import {
  assertCanonicalContract,
  assertExactKeys,
  assertNoRawAuthority,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
  parseHttpUrl,
  parseUniqueStrings,
} from "./LinearContractSupport";

export const WORK_ITEM_SPEC_V2_SCHEMA_VERSION = 2 as const;

export interface WorkItemSpecV2 {
  schemaVersion: typeof WORK_ITEM_SPEC_V2_SCHEMA_VERSION;
  ready: true;
  executionClass: WorkItemExecutionClass;
  objective: string;
  repositoryKey?: string;
  vaultBindingKey?: string;
  acceptanceCriteria: WorkItemAcceptanceCriterionV1[];
  validationRequirementKeys: string[];
  evidenceRefs: string[];
  riskClass: WorkItemRiskClass;
  originRunId: string;
  acceptedResearchArtifactFingerprint: string;
  parentIssueId?: string;
  generation: number;
  fingerprint: string;
}

export type WorkItemSpecV2Unsigned = Omit<WorkItemSpecV2, "fingerprint">;

export interface WorkItemSpecV1MigrationOptions {
  /** Host-approved logical profile keys replacing v1's raw validation text. */
  validationRequirementKeys: readonly string[];
  acceptedResearchArtifactFingerprint: string;
  vaultBindingKey?: string;
}

export type ParsedCompatibleWorkItemSpec = WorkItemSpecV1 | WorkItemSpecV2;

export function createWorkItemSpecV2(value: WorkItemSpecV2Unsigned): WorkItemSpecV2 {
  const unsigned = parseUnsigned(value);
  return { ...unsigned, fingerprint: fingerprintWorkItemSpecV2(unsigned) };
}

export function parseWorkItemSpecV2(value: unknown): WorkItemSpecV2 {
  const record = expectPlainRecord(value, "work item v2");
  assertKeys(record, true);
  const { fingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseUnsigned(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Work item v2");
  const fingerprint = expectSha256(rawFingerprint, "work item v2 fingerprint");
  const expected = fingerprintWorkItemSpecV2(unsigned);
  if (!constantTimeFingerprintEqual(fingerprint, expected)) {
    throw new DurableLinearContractError(
      "Work item v2 fingerprint does not match its canonical contract payload.",
    );
  }
  return { ...unsigned, fingerprint };
}

export function fingerprintWorkItemSpecV2(
  value: WorkItemSpecV2Unsigned | WorkItemSpecV2,
): string {
  const record = expectPlainRecord(value, "work item v2 fingerprint input");
  const { fingerprint: _ignored, ...rawUnsigned } = record;
  return fingerprintContract(parseUnsigned(rawUnsigned));
}

/** Parse either contract version without changing existing v1 queue semantics. */
export function parseCompatibleWorkItemSpec(value: unknown): ParsedCompatibleWorkItemSpec {
  const record = expectPlainRecord(value, "work item");
  if (record.schemaVersion === WORK_ITEM_SPEC_V2_SCHEMA_VERSION) {
    return parseWorkItemSpecV2(value);
  }
  if (record.schemaVersion === 1) {
    return parseWorkItemSpecV1(value);
  }
  throw new DurableLinearContractError("Unsupported work item schema version.");
}

/**
 * Explicitly migrate v1 into v2. Raw v1 validation strings are never promoted
 * into executable authority; the host must supply trusted logical profile keys.
 */
export function migrateWorkItemSpecV1ToV2(
  value: unknown,
  options: WorkItemSpecV1MigrationOptions,
): WorkItemSpecV2 {
  const v1 = parseWorkItemSpecV1(value);
  if (!options || !Array.isArray(options.validationRequirementKeys)) {
    throw new DurableLinearContractError(
      "V1 migration requires host-approved validation requirement keys.",
    );
  }
  return createWorkItemSpecV2({
    schemaVersion: WORK_ITEM_SPEC_V2_SCHEMA_VERSION,
    ready: true,
    executionClass: v1.executionClass,
    objective: v1.objective,
    ...(v1.repositoryKey ? { repositoryKey: v1.repositoryKey } : {}),
    ...(options.vaultBindingKey ? { vaultBindingKey: options.vaultBindingKey } : {}),
    acceptanceCriteria: v1.acceptanceCriteria,
    validationRequirementKeys: [...options.validationRequirementKeys],
    evidenceRefs: v1.evidenceRefs,
    riskClass: v1.riskClass,
    originRunId: v1.originRunId,
    acceptedResearchArtifactFingerprint: options.acceptedResearchArtifactFingerprint,
    ...(v1.parentIssueId ? { parentIssueId: v1.parentIssueId } : {}),
    generation: v1.generation,
  });
}

export function parseOrMigrateWorkItemSpecV2(
  value: unknown,
  migration?: WorkItemSpecV1MigrationOptions,
): WorkItemSpecV2 {
  const compatible = parseCompatibleWorkItemSpec(value);
  if (compatible.schemaVersion === WORK_ITEM_SPEC_V2_SCHEMA_VERSION) {
    return compatible;
  }
  if (!migration) {
    throw new DurableLinearContractError(
      "Work item v1 requires an explicit host-approved migration before v2 execution.",
    );
  }
  return migrateWorkItemSpecV1ToV2(compatible, migration);
}

function parseUnsigned(value: unknown): WorkItemSpecV2Unsigned {
  const record = expectPlainRecord(value, "work item v2");
  assertKeys(record, false);
  if (record.schemaVersion !== WORK_ITEM_SPEC_V2_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported work item v2 schema version.");
  }
  if (record.ready !== true) {
    throw new DurableLinearContractError("Work item v2 ready must be the literal true.");
  }
  const executionClass = expectEnum<WorkItemExecutionClass>(
    record.executionClass,
    "execution class",
    ["research", "vault", "code", "human"],
  );
  const objective = expectString(record.objective, "objective", 1, 4_000, {
    allowNewlines: true,
    secretFree: true,
  });
  assertNoRawAuthority(objective, "objective");
  const repositoryKey = record.repositoryKey === undefined
    ? undefined
    : expectLogicalKey(record.repositoryKey, "repository key");
  const vaultBindingKey = record.vaultBindingKey === undefined
    ? undefined
    : expectLogicalKey(record.vaultBindingKey, "vault binding key");
  const acceptanceCriteria = parseAcceptanceCriteria(record.acceptanceCriteria);
  const validationRequirementKeys = parseUniqueStrings(
    record.validationRequirementKeys,
    "validation requirement key",
    1,
    20,
    128,
    (entry, label) => expectLogicalKey(entry, label),
  );
  const evidenceRefs = parseUniqueStrings(
    record.evidenceRefs,
    "evidence reference",
    1,
    50,
    2_000,
    (entry, label) => parseEvidenceReference(entry, label),
  );
  const riskClass = expectEnum<WorkItemRiskClass>(
    record.riskClass,
    "risk class",
    ["low", "medium", "high"],
  );
  const originRunId = expectOpaqueId(record.originRunId, "origin run id");
  const acceptedResearchArtifactFingerprint = expectSha256(
    record.acceptedResearchArtifactFingerprint,
    "accepted research artifact fingerprint",
  );
  const parentIssueId = record.parentIssueId === undefined
    ? undefined
    : expectOpaqueId(record.parentIssueId, "parent issue id");
  const generation = expectInteger(record.generation, "generation", 0, 2);

  assertBindingRules(executionClass, repositoryKey, vaultBindingKey);
  if (generation > 0 && !parentIssueId) {
    throw new DurableLinearContractError(
      "A generated child work item requires a parent issue id.",
    );
  }

  return {
    schemaVersion: WORK_ITEM_SPEC_V2_SCHEMA_VERSION,
    ready: true,
    executionClass,
    objective,
    ...(repositoryKey ? { repositoryKey } : {}),
    ...(vaultBindingKey ? { vaultBindingKey } : {}),
    acceptanceCriteria,
    validationRequirementKeys,
    evidenceRefs,
    riskClass,
    originRunId,
    acceptedResearchArtifactFingerprint,
    ...(parentIssueId ? { parentIssueId } : {}),
    generation,
  };
}

function parseAcceptanceCriteria(value: unknown): WorkItemAcceptanceCriterionV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 20) {
    throw new DurableLinearContractError("Acceptance criteria require 1-20 entries.");
  }
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const record = expectPlainRecord(raw, `acceptance criterion ${index + 1}`);
    assertExactKeys(record, ["id", "text"], [], `acceptance criterion ${index + 1}`);
    if (typeof record.id !== "string" || !/^AC-[1-9][0-9]?$/.test(record.id)) {
      throw new DurableLinearContractError(
        `Acceptance criterion ${index + 1} id must match AC-1 through AC-99.`,
      );
    }
    if (ids.has(record.id)) {
      throw new DurableLinearContractError(`Acceptance criterion id ${record.id} is duplicated.`);
    }
    ids.add(record.id);
    const text = expectString(record.text, `acceptance criterion ${index + 1} text`, 1, 500, {
      allowNewlines: true,
      secretFree: true,
    });
    assertNoRawAuthority(text, `acceptance criterion ${index + 1} text`);
    return { id: record.id, text };
  });
}

function parseEvidenceReference(value: string, label: string): string {
  if (/^https?:\/\//i.test(value)) {
    return parseHttpUrl(value, label);
  }
  if (/^research:[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    return value;
  }
  throw new DurableLinearContractError(
    `${label} must be an HTTP(S) URL or a logical research reference.`,
  );
}

function assertBindingRules(
  executionClass: WorkItemExecutionClass,
  repositoryKey: string | undefined,
  vaultBindingKey: string | undefined,
): void {
  if (executionClass === "code") {
    if (!repositoryKey || vaultBindingKey) {
      throw new DurableLinearContractError(
        "Code work items require exactly one repository key and no vault binding key.",
      );
    }
    return;
  }
  if (executionClass === "vault") {
    if (!vaultBindingKey || repositoryKey) {
      throw new DurableLinearContractError(
        "Vault work items require exactly one vault binding key and no repository key.",
      );
    }
    return;
  }
  if (repositoryKey || vaultBindingKey) {
    throw new DurableLinearContractError(
      `${executionClass} work items must not carry repository or vault authority bindings.`,
    );
  }
}

function assertKeys(record: Record<string, unknown>, signed: boolean): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "ready",
      "executionClass",
      "objective",
      "acceptanceCriteria",
      "validationRequirementKeys",
      "evidenceRefs",
      "riskClass",
      "originRunId",
      "acceptedResearchArtifactFingerprint",
      "generation",
      ...(signed ? ["fingerprint"] : []),
    ],
    ["repositoryKey", "vaultBindingKey", "parentIssueId"],
    "work item v2",
  );
}
