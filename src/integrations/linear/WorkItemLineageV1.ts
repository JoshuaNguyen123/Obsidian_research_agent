import type { WorkItemExecutionClass } from "./WorkItemSpecV1";
import {
  assertCanonicalContract,
  assertExactKeys,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectIsoTimestamp,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  fingerprintContract,
} from "./LinearContractSupport";

export const WORK_ITEM_LINEAGE_SCHEMA_VERSION = 1 as const;

export type WorkItemLineageStateV1 =
  | "accepted_research"
  | "note_verified"
  | "linear_verified"
  | "claimed"
  | "domain_verified"
  | "workspace_ready"
  | "local_verified"
  | "push_prepared"
  | "pushed_verified"
  | "draft_pr_verified"
  | "checks_pending"
  | "review_or_merge_ready"
  | "merge_prepared"
  | "merged_verified"
  | "finalized";

export type WorkItemLineageDomainV1 =
  | "research"
  | "obsidian"
  | "linear"
  | "code"
  | "validation"
  | "github"
  | "completion";

export interface WorkItemLineageEventV1 {
  sequence: number;
  state: WorkItemLineageStateV1;
  domain: WorkItemLineageDomainV1;
  occurredAt: string;
  receiptId: string;
  evidenceFingerprint: string;
}

export interface WorkItemLineageV1 {
  schemaVersion: typeof WORK_ITEM_LINEAGE_SCHEMA_VERSION;
  lineageId: string;
  originRunId: string;
  executionClass: WorkItemExecutionClass;
  workItemFingerprint: string;
  researchArtifactFingerprint: string;
  externalWorkItemBindingFingerprint?: string;
  repositoryKey?: string;
  vaultBindingKey?: string;
  events: WorkItemLineageEventV1[];
  lineageFingerprint: string;
}

export type WorkItemLineageV1Unsigned = Omit<WorkItemLineageV1, "lineageFingerprint">;

export interface AppendWorkItemLineageTransitionV1Input {
  state: WorkItemLineageStateV1;
  occurredAt: string;
  receiptId: string;
  evidenceFingerprint: string;
  /** Required exactly when transitioning into linear_verified. */
  externalWorkItemBindingFingerprint?: string;
}

const CODE_ROUTE: readonly WorkItemLineageStateV1[] = [
  "accepted_research",
  "note_verified",
  "linear_verified",
  "claimed",
  "workspace_ready",
  "local_verified",
  "push_prepared",
  "pushed_verified",
  "draft_pr_verified",
  "checks_pending",
  "review_or_merge_ready",
  "merge_prepared",
  "merged_verified",
  "finalized",
];

const DOMAIN_ROUTE: readonly WorkItemLineageStateV1[] = [
  "accepted_research",
  "note_verified",
  "linear_verified",
  "claimed",
  "domain_verified",
  "finalized",
];

const HUMAN_ROUTE: readonly WorkItemLineageStateV1[] = [
  "accepted_research",
  "note_verified",
  "linear_verified",
];

const STATE_DOMAIN: Readonly<Record<WorkItemLineageStateV1, WorkItemLineageDomainV1>> = {
  accepted_research: "research",
  note_verified: "obsidian",
  linear_verified: "linear",
  claimed: "linear",
  domain_verified: "validation",
  workspace_ready: "code",
  local_verified: "validation",
  push_prepared: "github",
  pushed_verified: "github",
  draft_pr_verified: "github",
  checks_pending: "github",
  review_or_merge_ready: "github",
  merge_prepared: "github",
  merged_verified: "github",
  finalized: "completion",
};

export function createWorkItemLineageV1(
  value: WorkItemLineageV1Unsigned,
): WorkItemLineageV1 {
  const unsigned = parseUnsigned(value);
  return { ...unsigned, lineageFingerprint: fingerprintWorkItemLineageV1(unsigned) };
}

export function parseWorkItemLineageV1(value: unknown): WorkItemLineageV1 {
  const record = expectPlainRecord(value, "work item lineage");
  assertKeys(record, true);
  const { lineageFingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseUnsigned(rawUnsigned);
  assertCanonicalContract(rawUnsigned, unsigned, "Work item lineage");
  const lineageFingerprint = expectSha256(rawFingerprint, "work item lineage fingerprint");
  const expected = fingerprintWorkItemLineageV1(unsigned);
  if (!constantTimeFingerprintEqual(lineageFingerprint, expected)) {
    throw new DurableLinearContractError(
      "Work item lineage fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, lineageFingerprint };
}

export function fingerprintWorkItemLineageV1(
  value: WorkItemLineageV1Unsigned | WorkItemLineageV1,
): string {
  const record = expectPlainRecord(value, "work item lineage fingerprint input");
  const { lineageFingerprint: _ignored, ...rawUnsigned } = record;
  return fingerprintContract(parseUnsigned(rawUnsigned));
}

export function appendWorkItemLineageTransitionV1(
  currentValue: unknown,
  input: AppendWorkItemLineageTransitionV1Input,
): WorkItemLineageV1 {
  const current = parseWorkItemLineageV1(currentValue);
  const route = routeFor(current.executionClass);
  const previous = current.events[current.events.length - 1];
  const nextState =
    current.executionClass === "code" &&
    previous.state === "draft_pr_verified" &&
    input.state === "finalized"
      ? "finalized"
      : route[previous.sequence];
  if (!nextState || input.state !== nextState) {
    throw new DurableLinearContractError(
      `Invalid lineage transition from ${previous.state}; expected ${nextState ?? "no further state"}.`,
    );
  }
  if (Date.parse(input.occurredAt) < Date.parse(previous.occurredAt)) {
    throw new DurableLinearContractError("Lineage transition timestamps must not move backwards.");
  }
  const externalBinding = input.externalWorkItemBindingFingerprint === undefined
    ? current.externalWorkItemBindingFingerprint
    : expectSha256(
        input.externalWorkItemBindingFingerprint,
        "external work item binding fingerprint",
      );
  if (input.state === "linear_verified") {
    if (!input.externalWorkItemBindingFingerprint) {
      throw new DurableLinearContractError(
        "The linear_verified transition requires an external work item binding fingerprint.",
      );
    }
    if (input.evidenceFingerprint !== input.externalWorkItemBindingFingerprint) {
      throw new DurableLinearContractError(
        "The linear_verified transition must be evidenced by the external binding fingerprint.",
      );
    }
  } else if (input.externalWorkItemBindingFingerprint !== undefined) {
    throw new DurableLinearContractError(
      "External work item binding may only be attached by linear_verified.",
    );
  }
  return createWorkItemLineageV1({
    schemaVersion: WORK_ITEM_LINEAGE_SCHEMA_VERSION,
    lineageId: current.lineageId,
    originRunId: current.originRunId,
    executionClass: current.executionClass,
    workItemFingerprint: current.workItemFingerprint,
    researchArtifactFingerprint: current.researchArtifactFingerprint,
    ...(externalBinding
      ? { externalWorkItemBindingFingerprint: externalBinding }
      : {}),
    ...(current.repositoryKey ? { repositoryKey: current.repositoryKey } : {}),
    ...(current.vaultBindingKey ? { vaultBindingKey: current.vaultBindingKey } : {}),
    events: [
      ...current.events,
      {
        sequence: previous.sequence + 1,
        state: input.state,
        domain: STATE_DOMAIN[input.state],
        occurredAt: input.occurredAt,
        receiptId: input.receiptId,
        evidenceFingerprint: input.evidenceFingerprint,
      },
    ],
  });
}

function parseUnsigned(value: unknown): WorkItemLineageV1Unsigned {
  const record = expectPlainRecord(value, "work item lineage");
  assertKeys(record, false);
  if (record.schemaVersion !== WORK_ITEM_LINEAGE_SCHEMA_VERSION) {
    throw new DurableLinearContractError("Unsupported work item lineage version.");
  }
  const executionClass = expectEnum<WorkItemExecutionClass>(
    record.executionClass,
    "lineage execution class",
    ["research", "vault", "code", "human"],
  );
  const workItemFingerprint = expectSha256(record.workItemFingerprint, "work item fingerprint");
  const researchArtifactFingerprint = expectSha256(
    record.researchArtifactFingerprint,
    "research artifact fingerprint",
  );
  const externalWorkItemBindingFingerprint = record.externalWorkItemBindingFingerprint === undefined
    ? undefined
    : expectSha256(
        record.externalWorkItemBindingFingerprint,
        "external work item binding fingerprint",
      );
  const repositoryKey = record.repositoryKey === undefined
    ? undefined
    : expectLogicalKey(record.repositoryKey, "lineage repository key");
  const vaultBindingKey = record.vaultBindingKey === undefined
    ? undefined
    : expectLogicalKey(record.vaultBindingKey, "lineage vault binding key");
  assertBindings(executionClass, repositoryKey, vaultBindingKey);
  const events = parseEvents(
    record.events,
    executionClass,
    researchArtifactFingerprint,
    externalWorkItemBindingFingerprint,
  );
  return {
    schemaVersion: WORK_ITEM_LINEAGE_SCHEMA_VERSION,
    lineageId: expectLogicalKey(record.lineageId, "lineage id", 160),
    originRunId: expectOpaqueId(record.originRunId, "lineage origin run id"),
    executionClass,
    workItemFingerprint,
    researchArtifactFingerprint,
    ...(externalWorkItemBindingFingerprint
      ? { externalWorkItemBindingFingerprint }
      : {}),
    ...(repositoryKey ? { repositoryKey } : {}),
    ...(vaultBindingKey ? { vaultBindingKey } : {}),
    events,
  };
}

function parseEvents(
  value: unknown,
  executionClass: WorkItemExecutionClass,
  researchArtifactFingerprint: string,
  externalBindingFingerprint: string | undefined,
): WorkItemLineageEventV1[] {
  const route = routeFor(executionClass);
  if (!Array.isArray(value) || value.length < 1 || value.length > route.length) {
    throw new DurableLinearContractError(
      `Work item lineage requires 1-${route.length} ordered events for ${executionClass}.`,
    );
  }
  const receiptIds = new Set<string>();
  let previousAt = 0;
  const events = value.map((raw, index) => {
    const record = expectPlainRecord(raw, `lineage event ${index + 1}`);
    assertExactKeys(
      record,
      ["sequence", "state", "domain", "occurredAt", "receiptId", "evidenceFingerprint"],
      [],
      `lineage event ${index + 1}`,
    );
    if (record.sequence !== index + 1) {
      throw new DurableLinearContractError("Lineage event sequences must be contiguous from 1.");
    }
    const directDraftFinalization =
      executionClass === "code" &&
      index > 0 &&
      value[index - 1] !== undefined &&
      expectPlainRecord(value[index - 1], `lineage event ${index}`).state === "draft_pr_verified" &&
      record.state === "finalized";
    if (directDraftFinalization && index !== value.length - 1) {
      throw new DurableLinearContractError(
        "Draft-proof finalization must be the terminal lineage event.",
      );
    }
    if (record.state !== route[index] && !directDraftFinalization) {
      throw new DurableLinearContractError(
        `Lineage event ${index + 1} must be ${route[index]} for ${executionClass}.`,
      );
    }
    const state = record.state as WorkItemLineageStateV1;
    if (record.domain !== STATE_DOMAIN[state]) {
      throw new DurableLinearContractError(
        `Lineage event ${state} must use the ${STATE_DOMAIN[state]} receipt domain.`,
      );
    }
    const occurredAt = expectIsoTimestamp(record.occurredAt, `lineage event ${index + 1} time`);
    const occurredAtMs = Date.parse(occurredAt);
    if (occurredAtMs < previousAt) {
      throw new DurableLinearContractError("Lineage event timestamps must not move backwards.");
    }
    previousAt = occurredAtMs;
    const receiptId = expectOpaqueId(record.receiptId, `lineage event ${index + 1} receipt id`);
    if (receiptIds.has(receiptId)) {
      throw new DurableLinearContractError(`Lineage receipt id ${receiptId} is duplicated.`);
    }
    receiptIds.add(receiptId);
    const evidenceFingerprint = expectSha256(
      record.evidenceFingerprint,
      `lineage event ${index + 1} evidence fingerprint`,
    );
    if (state === "accepted_research" && evidenceFingerprint !== researchArtifactFingerprint) {
      throw new DurableLinearContractError(
        "The first lineage event must be evidenced by the accepted research artifact.",
      );
    }
    if (state === "linear_verified" && evidenceFingerprint !== externalBindingFingerprint) {
      throw new DurableLinearContractError(
        "The linear_verified event must be evidenced by the external binding fingerprint.",
      );
    }
    return {
      sequence: index + 1,
      state,
      domain: STATE_DOMAIN[state],
      occurredAt,
      receiptId,
      evidenceFingerprint,
    };
  });
  const reachedLinear = events.some((event) => event.state === "linear_verified");
  if (reachedLinear !== Boolean(externalBindingFingerprint)) {
    throw new DurableLinearContractError(
      "External work item binding presence must match the linear_verified transition.",
    );
  }
  return events;
}

function routeFor(executionClass: WorkItemExecutionClass): readonly WorkItemLineageStateV1[] {
  if (executionClass === "code") {
    return CODE_ROUTE;
  }
  if (executionClass === "human") {
    return HUMAN_ROUTE;
  }
  return DOMAIN_ROUTE;
}

function assertBindings(
  executionClass: WorkItemExecutionClass,
  repositoryKey: string | undefined,
  vaultBindingKey: string | undefined,
): void {
  if (executionClass === "code" && (!repositoryKey || vaultBindingKey)) {
    throw new DurableLinearContractError(
      "Code lineage requires exactly one logical repository key.",
    );
  }
  if (executionClass === "vault" && (!vaultBindingKey || repositoryKey)) {
    throw new DurableLinearContractError(
      "Vault lineage requires exactly one logical vault binding key.",
    );
  }
  if ((executionClass === "research" || executionClass === "human") && (repositoryKey || vaultBindingKey)) {
    throw new DurableLinearContractError(
      `${executionClass} lineage must not carry repository or vault authority bindings.`,
    );
  }
}

function assertKeys(record: Record<string, unknown>, signed: boolean): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "lineageId",
      "originRunId",
      "executionClass",
      "workItemFingerprint",
      "researchArtifactFingerprint",
      "events",
      ...(signed ? ["lineageFingerprint"] : []),
    ],
    ["externalWorkItemBindingFingerprint", "repositoryKey", "vaultBindingKey"],
    "work item lineage",
  );
}
