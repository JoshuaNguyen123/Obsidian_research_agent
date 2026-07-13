import {
  LINEAR_MAX_PAGE_SIZE,
  LinearClientError,
  type LinearBaseRecord,
  type LinearConnectionContext,
  type LinearOperationResult,
  type LinearPage,
  type LinearRequestOptions,
} from "./types";
import { sha256LinearValue } from "./client";

export const LINEAR_CAPABILITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const LINEAR_CAPABILITY_SNAPSHOT_DEFAULT_TTL_MS = 15 * 60 * 1_000;
export const LINEAR_CAPABILITY_SNAPSHOT_MAX_TTL_MS = 24 * 60 * 60 * 1_000;

const DISCOVERY_OPERATIONS = Object.freeze([
  "connection.context",
  "teams.list",
  "projects.list",
  "workflow_states.list",
] as const);

const CAPABILITY_IDS = Object.freeze([
  "authenticated_connection",
  "team_selection",
  "project_selection",
  "workflow_state_selection",
  "read_only_discovery",
  "mutation_authority",
] as const);

type LinearDiscoveryOperation = (typeof DISCOVERY_OPERATIONS)[number];
export type LinearDiscoveredCapabilityId = (typeof CAPABILITY_IDS)[number];
export type LinearCapabilitySnapshotFreshness =
  | "not_yet_valid"
  | "fresh"
  | "stale";

export interface LinearCapabilityDiscoveryClient {
  execute(
    operationKey: LinearDiscoveryOperation | string,
    variables?: Record<string, unknown>,
    options?: LinearRequestOptions,
  ): Promise<LinearOperationResult>;
}

export interface LinearDiscoveredIdentityV1 {
  id: string;
  name: string | null;
}

export interface LinearDiscoveredTeamV1 extends LinearDiscoveredIdentityV1 {
  key: string | null;
}

export interface LinearDiscoveredProjectV1 extends LinearDiscoveredIdentityV1 {
  url: string | null;
  teamIds: string[];
}

export interface LinearDiscoveredWorkflowStateV1
  extends LinearDiscoveredIdentityV1 {
  type: string | null;
  teamId: string | null;
}

export interface LinearDiscoverySourceStatusV1 {
  operation: LinearDiscoveryOperation;
  enabled: boolean;
  itemCount: number;
  truncated: boolean;
  errorCode: string | null;
}

export interface LinearDiscoveredCapabilityV1 {
  id: LinearDiscoveredCapabilityId;
  enabled: boolean;
  summary: string;
}

export interface LinearCapabilitySnapshotV1 {
  schemaVersion: typeof LINEAR_CAPABILITY_SNAPSHOT_SCHEMA_VERSION;
  sourceOperations: LinearDiscoveryOperation[];
  viewer: LinearDiscoveredIdentityV1;
  workspace: LinearDiscoveredIdentityV1;
  teams: LinearDiscoveredTeamV1[];
  projects: LinearDiscoveredProjectV1[];
  workflowStates: LinearDiscoveredWorkflowStateV1[];
  sources: LinearDiscoverySourceStatusV1[];
  capabilities: LinearDiscoveredCapabilityV1[];
  discoveredAt: string;
  freshUntil: string;
  snapshotHash: string;
}

export interface DiscoverLinearCapabilitiesOptions extends LinearRequestOptions {
  at?: string;
  maxItemsPerCollection?: number;
  freshnessTtlMs?: number;
}

interface CollectionDiscovery<T> {
  items: T[];
  status: LinearDiscoverySourceStatusV1;
}

/**
 * Reads only the fixed connection and catalog operations required to populate
 * connection-derived selectors. This function cannot dispatch a mutation and
 * the resulting snapshot explicitly records that no mutation authority exists.
 */
export async function discoverLinearCapabilities(
  client: LinearCapabilityDiscoveryClient,
  options: DiscoverLinearCapabilitiesOptions = {},
): Promise<LinearCapabilitySnapshotV1> {
  const discoveredAt = options.at !== undefined
    ? expectCanonicalTimestamp(options.at, "Linear discovery time")
    : new Date().toISOString();
  const maxItems = normalizeItemLimit(options.maxItemsPerCollection);
  const freshnessTtlMs = normalizeFreshnessTtl(options.freshnessTtlMs);
  const requestOptions: LinearRequestOptions = {
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    ...(options.deadlineAt !== undefined ? { deadlineAt: options.deadlineAt } : {}),
  };

  const contextResult = await client.execute(
    "connection.context",
    {},
    requestOptions,
  );
  const context = parseConnectionContextResult(contextResult);

  const [teams, projects, workflowStates] = await Promise.all([
    discoverCollection(
      client,
      "teams.list",
      maxItems,
      requestOptions,
      toTeam,
    ),
    discoverCollection(
      client,
      "projects.list",
      maxItems,
      requestOptions,
      toProject,
    ),
    discoverCollection(
      client,
      "workflow_states.list",
      maxItems,
      requestOptions,
      toWorkflowState,
    ),
  ]);

  const sources: LinearDiscoverySourceStatusV1[] = [
    {
      operation: "connection.context",
      enabled: true,
      itemCount: 1,
      truncated: false,
      errorCode: null,
    },
    teams.status,
    projects.status,
    workflowStates.status,
  ];
  const withoutHash: Omit<LinearCapabilitySnapshotV1, "snapshotHash"> = {
    schemaVersion: LINEAR_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    sourceOperations: [...DISCOVERY_OPERATIONS],
    viewer: toIdentity(context.viewer, "Linear viewer"),
    workspace: toIdentity(context.workspace, "Linear workspace"),
    teams: teams.items,
    projects: projects.items,
    workflowStates: workflowStates.items,
    sources,
    capabilities: buildCapabilityReport({
      context,
      teams,
      projects,
      workflowStates,
    }),
    discoveredAt,
    freshUntil: new Date(Date.parse(discoveredAt) + freshnessTtlMs).toISOString(),
  };
  return parseLinearCapabilitySnapshot({
    ...withoutHash,
    snapshotHash: await sha256LinearValue(withoutHash),
  });
}

export async function parseLinearCapabilitySnapshot(
  value: unknown,
): Promise<LinearCapabilitySnapshotV1> {
  const record = expectRecord(value, "Linear capability snapshot");
  assertExactKeys(record, [
    "schemaVersion",
    "sourceOperations",
    "viewer",
    "workspace",
    "teams",
    "projects",
    "workflowStates",
    "sources",
    "capabilities",
    "discoveredAt",
    "freshUntil",
    "snapshotHash",
  ], "Linear capability snapshot");
  if (record.schemaVersion !== LINEAR_CAPABILITY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error("Unsupported Linear capability snapshot schema version.");
  }

  const sourceOperations = parseExactStringSequence(
    record.sourceOperations,
    DISCOVERY_OPERATIONS,
    "Linear capability source operations",
  );
  const viewer = parseIdentity(record.viewer, "Linear capability viewer");
  const workspace = parseIdentity(record.workspace, "Linear capability workspace");
  const teams = parseBoundedArray(record.teams, "Linear capability teams", parseTeam);
  const projects = parseBoundedArray(
    record.projects,
    "Linear capability projects",
    parseProject,
  );
  const workflowStates = parseBoundedArray(
    record.workflowStates,
    "Linear capability workflow states",
    parseWorkflowState,
  );
  assertUniqueIds(teams, "Linear capability teams");
  assertUniqueIds(projects, "Linear capability projects");
  assertUniqueIds(workflowStates, "Linear capability workflow states");

  const sources = parseBoundedArray(
    record.sources,
    "Linear capability sources",
    parseSourceStatus,
    DISCOVERY_OPERATIONS.length,
  );
  if (
    sources.length !== DISCOVERY_OPERATIONS.length ||
    sources.some((source, index) => source.operation !== DISCOVERY_OPERATIONS[index])
  ) {
    throw new Error("Linear capability sources must match the fixed discovery operations.");
  }
  if (!sources[0].enabled || sources[0].errorCode !== null) {
    throw new Error("Linear capability connection source must be enabled.");
  }
  if (sources[0].itemCount !== 1 || sources[0].truncated) {
    throw new Error("Linear capability connection source metadata is invalid.");
  }
  assertSourceCount(sources[1], teams.length, "teams");
  assertSourceCount(sources[2], projects.length, "projects");
  assertSourceCount(sources[3], workflowStates.length, "workflow states");

  const capabilities = parseBoundedArray(
    record.capabilities,
    "Linear capability report",
    parseCapability,
    CAPABILITY_IDS.length,
  );
  if (
    capabilities.length !== CAPABILITY_IDS.length ||
    capabilities.some((capability, index) => capability.id !== CAPABILITY_IDS[index])
  ) {
    throw new Error("Linear capability report must contain each fixed capability once.");
  }
  const discoveredAt = expectCanonicalTimestamp(
    record.discoveredAt,
    "Linear capability discovery time",
  );
  const freshUntil = expectCanonicalTimestamp(
    record.freshUntil,
    "Linear capability freshness deadline",
  );
  const lifetimeMs = Date.parse(freshUntil) - Date.parse(discoveredAt);
  if (lifetimeMs <= 0 || lifetimeMs > LINEAR_CAPABILITY_SNAPSHOT_MAX_TTL_MS) {
    throw new Error("Linear capability snapshot freshness window is invalid.");
  }
  const snapshotHash = expectFingerprint(
    record.snapshotHash,
    "Linear capability snapshot hash",
  );
  const withoutHash: Omit<LinearCapabilitySnapshotV1, "snapshotHash"> = {
    schemaVersion: LINEAR_CAPABILITY_SNAPSHOT_SCHEMA_VERSION,
    sourceOperations,
    viewer,
    workspace,
    teams,
    projects,
    workflowStates,
    sources,
    capabilities,
    discoveredAt,
    freshUntil,
  };
  const expectedCapabilities = buildCapabilityReport({
    context: {
      viewer: identityToReference(viewer),
      workspace: identityToReference(workspace),
      fetchedAt: discoveredAt,
    },
    teams: { items: teams, status: sources[1] },
    projects: { items: projects, status: sources[2] },
    workflowStates: { items: workflowStates, status: sources[3] },
  });
  if (JSON.stringify(capabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error("Linear capability report does not match the discovered sources.");
  }
  if (await sha256LinearValue(withoutHash) !== snapshotHash) {
    throw new Error("Linear capability snapshot hash does not match its contents.");
  }
  return { ...withoutHash, snapshotHash };
}

export function getLinearCapabilitySnapshotFreshness(
  snapshot: Pick<LinearCapabilitySnapshotV1, "discoveredAt" | "freshUntil">,
  at = new Date().toISOString(),
): LinearCapabilitySnapshotFreshness {
  const checkedAt = Date.parse(expectCanonicalTimestamp(at, "Freshness check time"));
  const discoveredAt = Date.parse(
    expectCanonicalTimestamp(snapshot.discoveredAt, "Linear capability discovery time"),
  );
  const freshUntil = Date.parse(
    expectCanonicalTimestamp(snapshot.freshUntil, "Linear capability freshness deadline"),
  );
  if (checkedAt < discoveredAt) return "not_yet_valid";
  return checkedAt <= freshUntil ? "fresh" : "stale";
}

async function discoverCollection<T>(
  client: LinearCapabilityDiscoveryClient,
  operation: Exclude<LinearDiscoveryOperation, "connection.context">,
  maxItems: number,
  requestOptions: LinearRequestOptions,
  convert: (record: LinearBaseRecord) => T,
): Promise<CollectionDiscovery<T>> {
  try {
    const result = await client.execute(
      operation,
      { first: maxItems, includeArchived: false },
      requestOptions,
    );
    const page = parsePageResult(result, operation);
    if (page.items.length > maxItems) {
      throw new Error(`Linear ${operation} exceeded the requested item bound.`);
    }
    const items = page.items.map(convert);
    return {
      items,
      status: {
        operation,
        enabled: true,
        itemCount: items.length,
        truncated: page.pageInfo.hasNextPage,
        errorCode: null,
      },
    };
  } catch (error) {
    if (error instanceof LinearClientError && error.code === "linear_cancelled") {
      throw error;
    }
    return {
      items: [],
      status: {
        operation,
        enabled: false,
        itemCount: 0,
        truncated: false,
        errorCode: safeDiscoveryErrorCode(error),
      },
    };
  }
}

function parseConnectionContextResult(
  result: LinearOperationResult,
): LinearConnectionContext {
  const record = expectRecord(result, "Linear connection context result");
  assertExactKeys(
    record,
    ["viewer", "workspace", "fetchedAt"],
    "Linear connection context result",
  );
  return {
    viewer: parseReference(record.viewer, "Linear viewer"),
    workspace: parseReference(record.workspace, "Linear workspace"),
    fetchedAt: expectCanonicalTimestamp(record.fetchedAt, "Linear connection fetch time"),
  };
}

function parsePageResult(
  result: LinearOperationResult,
  operation: string,
): LinearPage<LinearBaseRecord> {
  const record = expectRecord(result, `Linear ${operation} result`);
  if (!Array.isArray(record.items)) {
    throw new Error(`Linear ${operation} result did not contain an items array.`);
  }
  const pageInfo = expectRecord(record.pageInfo, `Linear ${operation} page info`);
  if (typeof pageInfo.hasNextPage !== "boolean") {
    throw new Error(`Linear ${operation} page info omitted hasNextPage.`);
  }
  return {
    items: record.items.map((item, index) =>
      parseBaseRecord(item, `Linear ${operation} item ${index}`)),
    pageInfo: {
      hasNextPage: pageInfo.hasNextPage,
      ...(typeof pageInfo.endCursor === "string"
        ? { endCursor: expectText(pageInfo.endCursor, "Linear page cursor", 512) }
        : {}),
    },
    fetchedAt: expectCanonicalTimestamp(record.fetchedAt, `Linear ${operation} fetch time`),
  };
}

function parseBaseRecord(value: unknown, label: string): LinearBaseRecord {
  const record = expectRecord(value, label);
  return record as unknown as LinearBaseRecord;
}

function toTeam(record: LinearBaseRecord): LinearDiscoveredTeamV1 {
  assertResourceType(record, "team");
  return {
    ...toIdentity(record, "Linear team"),
    key: optionalText(record.key, "Linear team key", 64),
  };
}

function toProject(record: LinearBaseRecord): LinearDiscoveredProjectV1 {
  assertResourceType(record, "project");
  return {
    ...toIdentity(record, "Linear project"),
    url: optionalText(record.url, "Linear project URL", 2_000),
    teamIds: parseIdentifierList(record.attributes?.teams, "Linear project team ids"),
  };
}

function toWorkflowState(record: LinearBaseRecord): LinearDiscoveredWorkflowStateV1 {
  assertResourceType(record, "workflow_state");
  return {
    ...toIdentity(record, "Linear workflow state"),
    type: optionalText(record.type, "Linear workflow state type", 64),
    teamId: optionalIdentifier(record.attributes?.team, "Linear workflow state team id"),
  };
}

function buildCapabilityReport(input: {
  context: LinearConnectionContext;
  teams: CollectionDiscovery<LinearDiscoveredTeamV1>;
  projects: CollectionDiscovery<LinearDiscoveredProjectV1>;
  workflowStates: CollectionDiscovery<LinearDiscoveredWorkflowStateV1>;
}): LinearDiscoveredCapabilityV1[] {
  const connectionLabel = [input.context.viewer.name, input.context.workspace.name]
    .filter((part): part is string => typeof part === "string")
    .map((part) => part.slice(0, 120))
    .join(" in ");
  return [
    {
      id: "authenticated_connection",
      enabled: true,
      summary: connectionLabel
        ? `Authenticated Linear connection: ${connectionLabel}.`
        : "Authenticated Linear connection is available.",
    },
    collectionCapability("team_selection", "team", input.teams),
    collectionCapability("project_selection", "project", input.projects),
    collectionCapability(
      "workflow_state_selection",
      "workflow state",
      input.workflowStates,
    ),
    {
      id: "read_only_discovery",
      enabled: true,
      summary: "Fixed, bounded Linear discovery reads are enabled.",
    },
    {
      id: "mutation_authority",
      enabled: false,
      summary: "Discovery grants no mutation authority; host policy and exact action approval remain required.",
    },
  ];
}

function collectionCapability<T>(
  id: Extract<
    LinearDiscoveredCapabilityId,
    "team_selection" | "project_selection" | "workflow_state_selection"
  >,
  label: string,
  discovery: CollectionDiscovery<T>,
): LinearDiscoveredCapabilityV1 {
  if (!discovery.status.enabled) {
    return {
      id,
      enabled: false,
      summary: `Linear ${label} discovery is unavailable (${discovery.status.errorCode}).`,
    };
  }
  if (discovery.items.length === 0) {
    return {
      id,
      enabled: false,
      summary: `No Linear ${label} choices were returned by the connection.`,
    };
  }
  return {
    id,
    enabled: true,
    summary: `${discovery.items.length} connection-derived Linear ${label} choice${discovery.items.length === 1 ? "" : "s"} available${discovery.status.truncated ? " (bounded result is truncated)" : ""}.`,
  };
}

function parseIdentity(value: unknown, label: string): LinearDiscoveredIdentityV1 {
  const record = expectRecord(value, label);
  assertExactKeys(record, ["id", "name"], label);
  return {
    id: expectIdentifier(record.id, `${label} id`),
    name: optionalText(record.name, `${label} name`, 500),
  };
}

function parseTeam(value: unknown, index: number): LinearDiscoveredTeamV1 {
  const label = `Linear capability team ${index}`;
  const record = expectRecord(value, label);
  assertExactKeys(record, ["id", "name", "key"], label);
  return {
    id: expectIdentifier(record.id, `${label} id`),
    name: optionalText(record.name, `${label} name`, 500),
    key: optionalText(record.key, `${label} key`, 64),
  };
}

function parseProject(value: unknown, index: number): LinearDiscoveredProjectV1 {
  const label = `Linear capability project ${index}`;
  const record = expectRecord(value, label);
  assertExactKeys(record, ["id", "name", "url", "teamIds"], label);
  return {
    id: expectIdentifier(record.id, `${label} id`),
    name: optionalText(record.name, `${label} name`, 500),
    url: optionalText(record.url, `${label} URL`, 2_000),
    teamIds: parseIdentifierList(record.teamIds, `${label} team ids`),
  };
}

function parseWorkflowState(
  value: unknown,
  index: number,
): LinearDiscoveredWorkflowStateV1 {
  const label = `Linear capability workflow state ${index}`;
  const record = expectRecord(value, label);
  assertExactKeys(record, ["id", "name", "type", "teamId"], label);
  return {
    id: expectIdentifier(record.id, `${label} id`),
    name: optionalText(record.name, `${label} name`, 500),
    type: optionalText(record.type, `${label} type`, 64),
    teamId: optionalIdentifier(record.teamId, `${label} team id`),
  };
}

function parseSourceStatus(
  value: unknown,
  index: number,
): LinearDiscoverySourceStatusV1 {
  const label = `Linear capability source ${index}`;
  const record = expectRecord(value, label);
  assertExactKeys(
    record,
    ["operation", "enabled", "itemCount", "truncated", "errorCode"],
    label,
  );
  const operation = expectEnum(
    record.operation,
    DISCOVERY_OPERATIONS,
    `${label} operation`,
  );
  if (typeof record.enabled !== "boolean" || typeof record.truncated !== "boolean") {
    throw new Error(`${label} enabled and truncated flags must be booleans.`);
  }
  const itemCount = expectBoundedInteger(record.itemCount, `${label} item count`, 0, LINEAR_MAX_PAGE_SIZE);
  const errorCode = optionalIdentifier(record.errorCode, `${label} error code`);
  if (record.enabled === (errorCode !== null)) {
    throw new Error(`${label} error code must be null exactly when the source is enabled.`);
  }
  if (!record.enabled && (itemCount !== 0 || record.truncated)) {
    throw new Error(`${label} disabled sources cannot report items or truncation.`);
  }
  return {
    operation,
    enabled: record.enabled,
    itemCount,
    truncated: record.truncated,
    errorCode,
  };
}

function parseCapability(
  value: unknown,
  index: number,
): LinearDiscoveredCapabilityV1 {
  const label = `Linear capability report entry ${index}`;
  const record = expectRecord(value, label);
  assertExactKeys(record, ["id", "enabled", "summary"], label);
  if (typeof record.enabled !== "boolean") {
    throw new Error(`${label} enabled must be a boolean.`);
  }
  return {
    id: expectEnum(record.id, CAPABILITY_IDS, `${label} id`),
    enabled: record.enabled,
    summary: expectText(record.summary, `${label} summary`, 1_000),
  };
}

function toIdentity(
  value: { id: string; name?: string },
  label: string,
): LinearDiscoveredIdentityV1 {
  return {
    id: expectIdentifier(value.id, `${label} id`),
    name: optionalText(value.name, `${label} name`, 500),
  };
}

function identityToReference(
  value: LinearDiscoveredIdentityV1,
): { id: string; name?: string } {
  return {
    id: value.id,
    ...(value.name !== null ? { name: value.name } : {}),
  };
}

function parseReference(value: unknown, label: string): { id: string; name?: string } {
  const record = expectRecord(value, label);
  return {
    id: expectIdentifier(record.id, `${label} id`),
    ...(typeof record.name === "string"
      ? { name: expectText(record.name, `${label} name`, 500) }
      : {}),
  };
}

function assertResourceType(
  record: LinearBaseRecord,
  expected: "team" | "project" | "workflow_state",
): void {
  if (record.resourceType !== expected) {
    throw new Error(`Linear discovery expected ${expected} but received ${String(record.resourceType)}.`);
  }
}

function safeDiscoveryErrorCode(error: unknown): string {
  if (error instanceof LinearClientError) return error.code;
  return "linear_discovery_failed";
}

function normalizeItemLimit(value: unknown): number {
  return value === undefined
    ? LINEAR_MAX_PAGE_SIZE
    : expectBoundedInteger(
        value,
        "Linear discovery item limit",
        1,
        LINEAR_MAX_PAGE_SIZE,
      );
}

function normalizeFreshnessTtl(value: unknown): number {
  return value === undefined
    ? LINEAR_CAPABILITY_SNAPSHOT_DEFAULT_TTL_MS
    : expectBoundedInteger(
        value,
        "Linear capability freshness TTL",
        1_000,
        LINEAR_CAPABILITY_SNAPSHOT_MAX_TTL_MS,
      );
}

function parseBoundedArray<T>(
  value: unknown,
  label: string,
  parse: (item: unknown, index: number) => T,
  maximum = LINEAR_MAX_PAGE_SIZE,
): T[] {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new Error(`${label} must be an array with at most ${maximum} entries.`);
  }
  return value.map(parse);
}

function parseIdentifierList(value: unknown, label: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > LINEAR_MAX_PAGE_SIZE) {
    throw new Error(`${label} must be a bounded identifier array.`);
  }
  const result = value.map((item, index) =>
    expectIdentifier(item, `${label} ${index}`));
  if (new Set(result).size !== result.length) {
    throw new Error(`${label} contains duplicate identifiers.`);
  }
  return result;
}

function parseExactStringSequence<T extends string>(
  value: unknown,
  expected: readonly T[],
  label: string,
): T[] {
  if (
    !Array.isArray(value) ||
    value.length !== expected.length ||
    value.some((item, index) => item !== expected[index])
  ) {
    throw new Error(`${label} must match the fixed operation sequence.`);
  }
  return [...expected];
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    throw new Error(`${label} contains duplicate ids.`);
  }
}

function assertSourceCount(
  source: LinearDiscoverySourceStatusV1,
  actualCount: number,
  label: string,
): void {
  if (source.itemCount !== actualCount) {
    throw new Error(`Linear capability ${label} source count does not match its items.`);
  }
}

function optionalText(
  value: unknown,
  label: string,
  maximumLength: number,
): string | null {
  return value === undefined || value === null
    ? null
    : expectText(value, label, maximumLength);
}

function optionalIdentifier(value: unknown, label: string): string | null {
  return value === undefined || value === null
    ? null
    : expectIdentifier(value, label);
}

function expectIdentifier(value: unknown, label: string): string {
  const result = expectText(value, label, 256);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(result)) {
    throw new Error(`${label} contains unsupported identifier characters.`);
  }
  return result;
}

function expectText(value: unknown, label: string, maximumLength: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string.`);
  const normalized = value.trim();
  if (
    !normalized ||
    normalized.length > maximumLength ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`${label} is empty, too long, or contains control characters.`);
  }
  return normalized;
}

function expectCanonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function expectFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function expectBoundedInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function expectEnum<T extends string>(
  value: unknown,
  values: readonly T[],
  label: string,
): T {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value as T;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
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
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`,
    );
  }
}
