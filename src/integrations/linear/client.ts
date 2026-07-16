import type { HttpResponse, HttpTransport } from "../../model/types";
import {
  getLinearOperationDefinition,
  type LinearOperationKey,
} from "./operations";
import {
  LINEAR_DEFAULT_PAGE_SIZE,
  LINEAR_GRAPHQL_ENDPOINT,
  LINEAR_MAX_CURSOR_CHARS,
  LINEAR_MAX_PAGE_SIZE,
  LINEAR_MAX_QUERY_CHARS,
  LINEAR_MAX_TEXT_CHARS,
  LinearClientError,
  type LinearBaseRecord,
  type LinearAttributeValue,
  type LinearClientOptions,
  type LinearCommentRecord,
  type LinearConnectionContext,
  type LinearIssueRecord,
  type LinearMutationAck,
  type LinearOperationDefinition,
  type LinearOperationResult,
  type LinearPage,
  type LinearReference,
  type LinearRequestOptions,
  type LinearResourceType,
  type SanitizedLinearGraphqlError,
} from "./types";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MAX_REQUEST_BODY_CHARS = 100_000;
const MAX_GRAPHQL_ERRORS = 10;
const MAX_ERROR_MESSAGE_CHARS = 600;

interface GraphqlEnvelope {
  data?: unknown;
  errors?: unknown;
}

export class LinearGraphqlClient {
  private readonly transport: HttpTransport;
  private readonly apiKey: string;
  private readonly timeoutMs: number;

  constructor(options: LinearClientOptions) {
    this.transport = options.transport;
    this.apiKey = options.apiKey.trim();
    this.timeoutMs = clampInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      1,
      MAX_TIMEOUT_MS,
    );
  }

  async execute(
    operationKey: LinearOperationKey | string,
    variables: Record<string, unknown> = {},
    options: LinearRequestOptions = {},
  ): Promise<LinearOperationResult> {
    const definition = getLinearOperationDefinition(operationKey);
    if (!definition) {
      throw new LinearClientError(
        "linear_unknown_operation",
        `Unknown fixed Linear operation: ${sanitizeLabel(operationKey)}.`,
        { operationKey },
      );
    }
    if (!this.apiKey) {
      throw new LinearClientError(
        "linear_missing_api_key",
        "Linear API key is required.",
        { operationKey },
      );
    }
    if (options.abortSignal?.aborted) {
      throw new LinearClientError(
        "linear_cancelled",
        "Linear request was cancelled before dispatch.",
        { operationKey },
      );
    }

    const normalizedVariables = normalizeVariables(definition, variables);
    const transportVariables = normalizeTransportVariables(
      definition,
      normalizedVariables,
    );
    const body = JSON.stringify({
      operationName: definition.operationName,
      query: definition.document,
      variables: transportVariables,
    });
    if (body.length > MAX_REQUEST_BODY_CHARS) {
      throw new LinearClientError(
        "linear_invalid_arguments",
        `Linear request exceeds the ${MAX_REQUEST_BODY_CHARS}-character bound.`,
        { operationKey },
      );
    }

    const timeoutMs = getEffectiveTimeout(this.timeoutMs, options.deadlineAt);
    let response: HttpResponse;
    try {
      response = await this.transport({
        url: LINEAR_GRAPHQL_ENDPOINT,
        method: "POST",
        contentType: "application/json",
        headers: { Authorization: this.apiKey },
        throw: false,
        timeoutMs,
        abortSignal: options.abortSignal,
        body,
      });
    } catch (error) {
      throw mapTransportError(
        error,
        definition,
        this.apiKey,
        options.abortSignal,
      );
    }

    return parseLinearResponse(definition, response, this.apiKey);
  }

  async getConnectionContext(
    options: LinearRequestOptions = {},
  ): Promise<LinearConnectionContext> {
    const result = await this.execute("connection.context", {}, options);
    if (!isConnectionContext(result)) {
      throw new LinearClientError(
        "linear_invalid_response",
        "Linear connection operation returned an unexpected result.",
        { operationKey: "connection.context" },
      );
    }
    return result;
  }
}

export function createLinearGraphqlClient(
  options: LinearClientOptions,
): LinearGraphqlClient {
  return new LinearGraphqlClient(options);
}

export async function parseLinearResponse(
  definition: LinearOperationDefinition,
  response: HttpResponse,
  apiKey = "",
): Promise<LinearOperationResult> {
  const operationKey = definition.key;
  const envelope = parseEnvelope(response, operationKey);
  const errors = sanitizeGraphqlErrors(envelope.errors, apiKey);
  const hasPartialData = hasUsablePartialData(definition, envelope.data);

  if (response.status === 401) {
    throw new LinearClientError("linear_auth", "Linear authentication failed.", {
      operationKey,
      status: response.status,
      details: errors,
    });
  }
  if (response.status === 403) {
    throw new LinearClientError(
      "linear_forbidden",
      "Linear denied access to this resource.",
      { operationKey, status: response.status, details: errors },
    );
  }
  if (response.status === 404) {
    throw new LinearClientError(
      "linear_not_found",
      "Linear resource was not found.",
      { operationKey, status: response.status, details: errors },
    );
  }
  if (
    response.status === 429 ||
    hasGraphqlErrorCode(errors, "RATELIMITED", "RATE_LIMITED")
  ) {
    throw new LinearClientError(
      "linear_rate_limited",
      "Linear rate limit was reached.",
      {
        operationKey,
        status: response.status,
        retryAtMs: getRateLimitReset(response.headers),
        retryable: definition.access === "read",
        details: errors,
      },
    );
  }
  if (response.status === 408) {
    throw new LinearClientError("linear_timeout", "Linear request timed out.", {
      operationKey,
      status: response.status,
      retryable: definition.access === "read",
      details: errors,
    });
  }
  if (
    !hasPartialData &&
    hasGraphqlErrorCode(
      errors,
      "AUTHENTICATION_ERROR",
      "AUTHENTICATION_REQUIRED",
      "UNAUTHENTICATED",
    )
  ) {
    throw new LinearClientError("linear_auth", "Linear authentication failed.", {
      operationKey,
      status: response.status,
      details: errors,
    });
  }
  if (
    !hasPartialData &&
    hasGraphqlErrorCode(errors, "FORBIDDEN", "PERMISSION_DENIED")
  ) {
    throw new LinearClientError(
      "linear_forbidden",
      "Linear denied access to this resource.",
      { operationKey, status: response.status, details: errors },
    );
  }
  if (
    !hasPartialData &&
    hasGraphqlNotFoundError(errors)
  ) {
    throw new LinearClientError(
      "linear_not_found",
      "Linear resource was not found.",
      { operationKey, status: response.status, details: errors },
    );
  }
  if (
    !hasPartialData &&
    hasGraphqlErrorCode(errors, "BAD_USER_INPUT", "INVALID_INPUT")
  ) {
    throw new LinearClientError(
      "linear_invalid_arguments",
      "Linear rejected the fixed operation variables.",
      { operationKey, status: response.status, details: errors },
    );
  }
  if (response.status >= 400) {
    throw new LinearClientError(
      "linear_http",
      `Linear returned HTTP ${response.status}.`,
      {
        operationKey,
        status: response.status,
        retryable: definition.access === "read" && response.status >= 500,
        details: errors,
      },
    );
  }
  if (errors.length > 0) {
    throw new LinearClientError(
      hasPartialData ? "linear_partial_response" : "linear_graphql",
      hasPartialData
        ? "Linear returned partial data with GraphQL errors; no result was accepted."
        : "Linear returned GraphQL errors.",
      { operationKey, details: errors },
    );
  }
  if (!isRecord(envelope.data)) {
    throw new LinearClientError(
      "linear_invalid_response",
      "Linear response did not contain a data object.",
      { operationKey },
    );
  }

  return normalizeOperationResult(definition, envelope.data);
}

export function redactLinearSecrets(value: string, secrets: string[] = []): string {
  let output = value;
  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join("[REDACTED]");
    }
  }
  return output
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\blin_api_[A-Za-z0-9_-]+\b/g, "[REDACTED]")
    .replace(
      /(authorization|api[_-]?key)(["'\s:=]+)[^\s,"'}]+/gi,
      "$1$2[REDACTED]",
    );
}

export function stableLinearJson(value: unknown): string {
  return JSON.stringify(sortJsonValue(value)) ?? "null";
}

export async function sha256LinearValue(value: unknown): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new LinearClientError(
      "linear_invalid_response",
      "SHA-256 is unavailable in this runtime.",
    );
  }
  const digest = await subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableLinearJson(value)),
  );
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

async function normalizeOperationResult(
  definition: LinearOperationDefinition,
  data: Record<string, unknown>,
): Promise<LinearOperationResult> {
  if (definition.resultKind === "context") {
    return normalizeConnectionContext(data);
  }

  const root = data[definition.rootField];
  if (definition.resultKind === "mutation") {
    if (!isRecord(root) || root.success !== true) {
      throw new LinearClientError(
        "linear_invalid_response",
        `Linear mutation ${definition.operationName} was not acknowledged.`,
        { operationKey: definition.key },
      );
    }
    const result: LinearMutationAck = {
      success: true,
      operationKey: definition.key,
      operationName: definition.operationName,
      resourceType: definition.resourceType,
      acknowledgedAt: new Date().toISOString(),
    };
    return result;
  }

  if (definition.resultKind === "connection") {
    if (!isRecord(root) || !Array.isArray(root.nodes) || !isRecord(root.pageInfo)) {
      throw new LinearClientError(
        "linear_invalid_response",
        `Linear connection ${definition.rootField} was malformed.`,
        { operationKey: definition.key },
      );
    }
    if (typeof root.pageInfo.hasNextPage !== "boolean") {
      throw new LinearClientError(
        "linear_invalid_response",
        `Linear connection ${definition.rootField} omitted pageInfo.hasNextPage.`,
        { operationKey: definition.key },
      );
    }
    const items = await Promise.all(
      root.nodes.map((item) => normalizeLinearRecord(definition.resourceType, item)),
    );
    const page: LinearPage<LinearBaseRecord> = {
      items,
      pageInfo: {
        hasNextPage: root.pageInfo.hasNextPage,
        ...(typeof root.pageInfo.endCursor === "string"
          ? { endCursor: root.pageInfo.endCursor }
          : {}),
      },
      fetchedAt: new Date().toISOString(),
    };
    return page;
  }

  return normalizeLinearRecord(definition.resourceType, root);
}

async function normalizeConnectionContext(
  data: Record<string, unknown>,
): Promise<LinearConnectionContext> {
  const viewer = normalizeReference(data.viewer, "viewer");
  const workspace = normalizeReference(data.organization, "organization");
  return {
    viewer,
    workspace,
    fetchedAt: new Date().toISOString(),
  };
}

export async function normalizeLinearRecord(
  resourceType: LinearResourceType,
  value: unknown,
): Promise<LinearBaseRecord> {
  if (!isRecord(value)) {
    throw new LinearClientError(
      "linear_invalid_response",
      `Linear ${resourceType} record was not an object.`,
    );
  }
  if (resourceType === "issue") {
    return normalizeIssue(value);
  }
  if (resourceType === "comment") {
    return normalizeComment(value);
  }

  const id = requireString(value.id, `${resourceType}.id`);
  const labels = normalizeOptionalLabels(value.labels, `${resourceType}.label`);
  const attributes = normalizeAttributes(value);
  const baseWithoutHash: Omit<LinearBaseRecord, "snapshotHash"> = {
    resourceType,
    id,
    ...(typeof value.trashed === "boolean" ? { trashed: value.trashed } : {}),
    ...(labels ? { labels } : {}),
    ...(Object.keys(attributes).length ? { attributes } : {}),
    ...copyOptionalString(value, "name"),
    ...copyOptionalString(value, "key"),
    ...copyOptionalString(value, "identifier"),
    ...copyOptionalString(value, "url"),
    ...copyOptionalString(value, "title"),
    ...copyBoundedText(value, "description"),
    ...copyBoundedText(value, "body"),
    ...copyBoundedText(value, "content"),
    ...copyOptionalString(value, "type"),
    ...copyOptionalString(value, "color"),
    ...copyOptionalString(value, "createdAt"),
    ...copyOptionalString(value, "updatedAt"),
    ...copyOptionalString(value, "archivedAt"),
  };
  return {
    ...baseWithoutHash,
    snapshotHash: await sha256LinearValue(baseWithoutHash),
  };
}

async function normalizeIssue(value: Record<string, unknown>): Promise<LinearIssueRecord> {
  const id = requireString(value.id, "issue.id");
  const title = requireString(value.title, "issue.title");
  const identifier = requireString(value.identifier, "issue.identifier");
  const url = requireString(value.url, "issue.url");
  const priority = requireFiniteNumber(value.priority, "issue.priority");
  const team = normalizeReference(value.team, "issue.team");
  const state = normalizeReference(value.state, "issue.state");
  const stateRecord = isRecord(value.state) ? value.state : {};
  const labelsRecord = isRecord(value.labels) ? value.labels : {};
  const labelNodes = Array.isArray(labelsRecord.nodes) ? labelsRecord.nodes : [];
  const labels = labelNodes
    .slice(0, LINEAR_MAX_PAGE_SIZE)
    .map((label) => normalizeReference(label, "issue.label"));

  const withoutHash: Omit<LinearIssueRecord, "snapshotHash"> = {
    resourceType: "issue",
    id,
    trashed: value.trashed === true,
    identifier,
    url,
    title,
    priority,
    team,
    state: {
      ...state,
      ...(typeof stateRecord.type === "string" ? { type: stateRecord.type } : {}),
    },
    labels,
    ...copyBoundedText(value, "description"),
    ...copyOptionalNumber(value, "estimate"),
    ...copyOptionalString(value, "dueDate"),
    ...copyOptionalString(value, "createdAt"),
    ...copyOptionalString(value, "updatedAt"),
    ...copyOptionalString(value, "archivedAt"),
    ...copyOptionalString(value, "completedAt"),
    ...copyOptionalString(value, "canceledAt"),
    ...copyOptionalReference(value, "project"),
    ...copyOptionalReference(value, "cycle"),
    ...copyOptionalReference(value, "projectMilestone"),
    ...copyOptionalReference(value, "assignee"),
    ...copyOptionalReference(value, "parent"),
  };
  return { ...withoutHash, snapshotHash: await sha256LinearValue(withoutHash) };
}

async function normalizeComment(
  value: Record<string, unknown>,
): Promise<LinearCommentRecord> {
  const withoutHash: Omit<LinearCommentRecord, "snapshotHash"> = {
    resourceType: "comment",
    id: requireString(value.id, "comment.id"),
    url: requireString(value.url, "comment.url"),
    body: boundText(requireString(value.body, "comment.body")),
    ...copyOptionalString(value, "createdAt"),
    ...copyOptionalString(value, "updatedAt"),
    ...copyOptionalString(value, "archivedAt"),
    ...copyOptionalReference(value, "user"),
    ...copyOptionalReference(value, "issue"),
    ...copyOptionalReference(value, "parent"),
  };
  return { ...withoutHash, snapshotHash: await sha256LinearValue(withoutHash) };
}

function normalizeVariables(
  definition: LinearOperationDefinition,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  if (!isRecord(variables)) {
    throw invalidArguments(definition.key, "Variables must be an object.");
  }
  const allowed = new Set(definition.variables.allowed);
  for (const key of Object.keys(variables)) {
    if (!allowed.has(key)) {
      throw invalidArguments(
        definition.key,
        `Variable ${sanitizeLabel(key)} is not allowed for this fixed operation.`,
      );
    }
  }
  for (const required of definition.variables.required ?? []) {
    if (variables[required] === undefined || variables[required] === null) {
      throw invalidArguments(
        definition.key,
        `Variable ${sanitizeLabel(required)} is required.`,
      );
    }
  }

  const output: Record<string, unknown> = { ...variables };
  if (definition.variables.paginated) {
    output.first = normalizePageSize(variables.first);
    output.includeArchived = normalizeBoolean(
      variables.includeArchived,
      "includeArchived",
      false,
      definition.key,
    );
    if (variables.after !== undefined && variables.after !== null) {
      output.after = normalizeCursor(variables.after, definition.key);
    } else if (variables.after === null) {
      delete output.after;
    }
  }
  if (variables.query !== undefined) {
    const query = requireBoundedString(
      variables.query,
      "query",
      LINEAR_MAX_QUERY_CHARS,
      definition.key,
    );
    output.query = query;
  }
  for (const key of ["id", "labelId"]) {
    if (variables[key] !== undefined) {
      output[key] = requireBoundedString(variables[key], key, 256, definition.key);
    }
  }
  for (const key of ["input", "filter"]) {
    if (variables[key] !== undefined) {
      if (!isRecord(variables[key])) {
        throw invalidArguments(definition.key, `Variable ${key} must be an object.`);
      }
      assertBoundedJson(variables[key], definition.key, key);
    }
  }
  return output;
}

function normalizeTransportVariables(
  definition: LinearOperationDefinition,
  variables: Record<string, unknown>,
): Record<string, unknown> {
  if (definition.key !== "issues.search") return variables;
  const query = requireBoundedString(
    variables.query,
    "query",
    LINEAR_MAX_QUERY_CHARS,
    definition.key,
  );
  const existingFilter = isRecord(variables.filter) ? variables.filter : {};
  if (Object.prototype.hasOwnProperty.call(existingFilter, "or")) {
    throw invalidArguments(
      definition.key,
      "Issue search cannot combine its text match with a caller-supplied top-level or filter.",
    );
  }
  const { query: _query, filter: _filter, ...transportVariables } = variables;
  return {
    ...transportVariables,
    filter: {
      ...existingFilter,
      // The former issueSearch field is now a non-functioning deprecated
      // stub. Linear's supported issues filter provides equivalent bounded
      // duplicate lookup over the fields used by our signed work items.
      or: [
        { title: { containsIgnoreCase: query } },
        { description: { containsIgnoreCase: query } },
      ],
    },
  };
}

function parseEnvelope(
  response: HttpResponse,
  operationKey: string,
): GraphqlEnvelope {
  let body: unknown = response.json;
  if (body === undefined && typeof response.text === "string") {
    try {
      body = JSON.parse(response.text);
    } catch {
      if (response.status >= 400) {
        return {};
      }
      throw new LinearClientError(
        "linear_invalid_response",
        "Linear returned a non-JSON response.",
        { operationKey, status: response.status },
      );
    }
  }
  if (!isRecord(body)) {
    if (response.status >= 400) {
      return {};
    }
    throw new LinearClientError(
      "linear_invalid_response",
      "Linear returned an invalid response envelope.",
      { operationKey, status: response.status },
    );
  }
  return body;
}

function hasGraphqlErrorCode(
  errors: SanitizedLinearGraphqlError[],
  ...codes: string[]
): boolean {
  const expected = new Set(codes.map((code) => code.toUpperCase()));
  return errors.some(
    (error) =>
      typeof error.code === "string" && expected.has(error.code.toUpperCase()),
  );
}

function hasGraphqlNotFoundError(
  errors: SanitizedLinearGraphqlError[],
): boolean {
  if (hasGraphqlErrorCode(errors, "NOT_FOUND", "ENTITY_NOT_FOUND")) {
    return true;
  }
  // Linear's current production API can report an absent entity as the
  // generic INPUT_ERROR code while retaining an unambiguous provider message.
  // Keep this match deliberately narrow so unrelated input failures are not
  // mistaken for the safe absence required by prepared creates.
  return errors.some(
    (error) =>
      error.code?.toUpperCase() === "INPUT_ERROR" &&
      /^Entity not found(?:\s*:|\s*$)/iu.test(error.message.trim()),
  );
}

function hasUsablePartialData(
  definition: LinearOperationDefinition,
  value: unknown,
): boolean {
  if (!isRecord(value)) {
    return false;
  }
  if (definition.resultKind === "context") {
    return Object.values(value).some((item) => item !== null && item !== undefined);
  }
  return value[definition.rootField] !== null &&
    value[definition.rootField] !== undefined;
}

function sanitizeGraphqlErrors(
  value: unknown,
  apiKey: string,
): SanitizedLinearGraphqlError[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    return [{ message: "Linear returned a malformed GraphQL errors value." }];
  }
  return value.slice(0, MAX_GRAPHQL_ERRORS).map((item) => {
    const record = isRecord(item) ? item : {};
    const extensions = isRecord(record.extensions) ? record.extensions : {};
    const message = redactLinearSecrets(
      typeof record.message === "string" ? record.message : "Linear GraphQL error.",
      [apiKey],
    ).slice(0, MAX_ERROR_MESSAGE_CHARS);
    const path = Array.isArray(record.path)
      ? record.path
          .filter((part): part is string | number =>
            typeof part === "string" || typeof part === "number",
          )
          .slice(0, 12)
          .map(String)
      : undefined;
    return {
      message,
      ...(typeof extensions.code === "string"
        ? { code: extensions.code.slice(0, 80) }
        : {}),
      ...(path?.length ? { path } : {}),
    };
  });
}

function mapTransportError(
  error: unknown,
  definition: LinearOperationDefinition,
  apiKey: string,
  abortSignal?: AbortSignal,
): LinearClientError {
  const operationKey = definition.key;
  if (error instanceof LinearClientError) {
    return error;
  }
  const raw = error instanceof Error ? error.message : String(error);
  const message = redactLinearSecrets(raw, [apiKey]).slice(0, MAX_ERROR_MESSAGE_CHARS);
  if (abortSignal?.aborted || /\bcancel(?:led|ed)|\babort(?:ed)?\b/i.test(message)) {
    return new LinearClientError(
      "linear_cancelled",
      "Linear request was cancelled.",
      { operationKey },
    );
  }
  if (/\btime(?:d)?\s*out|timeout/i.test(message)) {
    return new LinearClientError("linear_timeout", "Linear request timed out.", {
      operationKey,
      retryable: definition.access === "read",
    });
  }
  return new LinearClientError(
    "linear_network",
    `Linear network request failed: ${message || "unknown network error"}`,
    { operationKey, retryable: definition.access === "read" },
  );
}

function normalizeReference(value: unknown, label: string): LinearReference {
  if (!isRecord(value)) {
    throw new LinearClientError(
      "linear_invalid_response",
      `Linear ${label} reference was missing.`,
    );
  }
  return {
    id: requireString(value.id, `${label}.id`),
    ...copyOptionalString(value, "name"),
    ...copyOptionalString(value, "key"),
    ...copyOptionalString(value, "identifier"),
    ...copyOptionalString(value, "url"),
  };
}

function normalizeOptionalLabels(
  value: unknown,
  label: string,
): LinearReference[] | undefined {
  if (!isRecord(value) || !Array.isArray(value.nodes)) {
    return undefined;
  }
  return value.nodes
    .slice(0, LINEAR_MAX_PAGE_SIZE)
    .map((item) => normalizeReference(item, label));
}

function normalizeAttributes(
  value: Record<string, unknown>,
): Record<string, LinearAttributeValue> {
  const attributes: Record<string, LinearAttributeValue> = {};
  for (const [key, candidate] of Object.entries(value)) {
    if (candidate === null || typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))) {
      attributes[key] = candidate;
      continue;
    }
    if (typeof candidate === "string") {
      attributes[key] = boundText(candidate);
      continue;
    }
    if (
      Array.isArray(candidate) &&
      candidate.length <= 100 &&
      candidate.every((item) => typeof item === "string")
    ) {
      attributes[key] = candidate.map((item) => boundText(item as string));
      continue;
    }
    if (isRecord(candidate) && typeof candidate.id === "string") {
      attributes[key] = candidate.id;
      continue;
    }
    if (isRecord(candidate) && Array.isArray(candidate.nodes)) {
      const ids = candidate.nodes
        .slice(0, LINEAR_MAX_PAGE_SIZE)
        .map((node) => isRecord(node) && typeof node.id === "string" ? node.id : null)
        .filter((id): id is string => id !== null);
      attributes[key] = ids;
    }
  }
  return attributes;
}

function copyOptionalReference(
  value: Record<string, unknown>,
  key: string,
): Record<string, LinearReference> {
  const candidate = value[key];
  return candidate === null || candidate === undefined
    ? {}
    : { [key]: normalizeReference(candidate, key) };
}

function copyOptionalString(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

function copyBoundedText(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: boundText(value[key]) } : {};
}

function copyOptionalNumber(
  value: Record<string, unknown>,
  key: string,
): Record<string, number> {
  return typeof value[key] === "number" && Number.isFinite(value[key])
    ? { [key]: value[key] }
    : {};
}

function boundText(value: string): string {
  return value.length <= LINEAR_MAX_TEXT_CHARS
    ? value
    : `${value.slice(0, LINEAR_MAX_TEXT_CHARS)}\n[truncated]`;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new LinearClientError(
      "linear_invalid_response",
      `Linear response omitted ${label}.`,
    );
  }
  return value;
}

function requireFiniteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new LinearClientError(
      "linear_invalid_response",
      `Linear response omitted ${label}.`,
    );
  }
  return value;
}

function normalizePageSize(value: unknown): number {
  if (value === undefined || value === null) {
    return LINEAR_DEFAULT_PAGE_SIZE;
  }
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new LinearClientError(
      "linear_invalid_arguments",
      "Pagination first must be a positive integer.",
    );
  }
  return Math.min(value as number, LINEAR_MAX_PAGE_SIZE);
}

function normalizeCursor(value: unknown, operationKey: string): string {
  return requireBoundedString(
    value,
    "after",
    LINEAR_MAX_CURSOR_CHARS,
    operationKey,
  );
}

function normalizeBoolean(
  value: unknown,
  label: string,
  fallback: boolean,
  operationKey: string,
): boolean {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw invalidArguments(operationKey, `${label} must be a boolean.`);
  }
  return value;
}

function requireBoundedString(
  value: unknown,
  label: string,
  maxChars: number,
  operationKey: string,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw invalidArguments(operationKey, `${label} must be a non-empty string.`);
  }
  if (value.length > maxChars) {
    throw invalidArguments(
      operationKey,
      `${label} exceeds the ${maxChars}-character bound.`,
    );
  }
  return value;
}

function assertBoundedJson(
  value: unknown,
  operationKey: string,
  label: string,
  depth = 0,
): void {
  if (depth > 8) {
    throw invalidArguments(operationKey, `${label} exceeds the nesting bound.`);
  }
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (typeof value === "string") {
    if (value.length > LINEAR_MAX_TEXT_CHARS) {
      throw invalidArguments(
        operationKey,
        `${label} contains a string over ${LINEAR_MAX_TEXT_CHARS} characters.`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      throw invalidArguments(operationKey, `${label} contains too many items.`);
    }
    value.forEach((item) => assertBoundedJson(item, operationKey, label, depth + 1));
    return;
  }
  if (!isRecord(value)) {
    throw invalidArguments(operationKey, `${label} contains a non-JSON value.`);
  }
  const entries = Object.entries(value);
  if (entries.length > 100) {
    throw invalidArguments(operationKey, `${label} contains too many fields.`);
  }
  for (const [key, item] of entries) {
    if (key === "__proto__" || key === "prototype" || key === "constructor") {
      throw invalidArguments(operationKey, `${label} contains a blocked field.`);
    }
    assertBoundedJson(item, operationKey, label, depth + 1);
  }
}

function invalidArguments(operationKey: string, message: string): LinearClientError {
  return new LinearClientError("linear_invalid_arguments", message, {
    operationKey,
  });
}

function getEffectiveTimeout(timeoutMs: number, deadlineAt?: number): number {
  if (deadlineAt === undefined) {
    return timeoutMs;
  }
  if (!Number.isFinite(deadlineAt)) {
    throw new LinearClientError(
      "linear_invalid_arguments",
      "Linear request deadline must be a finite timestamp.",
    );
  }
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) {
    throw new LinearClientError(
      "linear_timeout",
      "Linear request deadline elapsed before dispatch.",
    );
  }
  return Math.max(1, Math.min(timeoutMs, remaining));
}

function getRateLimitReset(headers: Record<string, string>): number | undefined {
  const value = getHeader(headers, "x-ratelimit-requests-reset") ??
    getHeader(headers, "x-ratelimit-endpoint-requests-reset");
  if (!value) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function getHeader(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase();
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === lower);
  return match?.[1];
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, sortJsonValue(value[key])]),
    );
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isConnectionContext(
  value: LinearOperationResult,
): value is LinearConnectionContext {
  return isRecord(value) && isRecord(value.viewer) && isRecord(value.workspace);
}

function sanitizeLabel(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "?").slice(0, 100) || "unknown";
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
