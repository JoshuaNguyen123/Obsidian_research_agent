import type { HttpTransport } from "../../model/types";

export const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";
export const LINEAR_DEFAULT_PAGE_SIZE = 25;
export const LINEAR_MAX_PAGE_SIZE = 50;
export const LINEAR_MAX_CURSOR_CHARS = 512;
export const LINEAR_MAX_QUERY_CHARS = 500;
export const LINEAR_MAX_TEXT_CHARS = 20_000;

export type LinearCapabilityGate = 0 | 1 | 2 | 3 | 4 | 5;
export type LinearOperationAccess = "read" | "write";
export type LinearOperationResultKind =
  | "context"
  | "connection"
  | "resource"
  | "mutation";

export type LinearResourceType =
  | "workspace"
  | "user"
  | "team"
  | "workflow_state"
  | "issue"
  | "comment"
  | "project"
  | "project_status"
  | "project_update"
  | "project_milestone"
  | "cycle"
  | "initiative"
  | "initiative_update"
  | "document"
  | "issue_label"
  | "project_label"
  | "initiative_label"
  | "issue_relation"
  | "project_relation"
  | "initiative_relation"
  | "initiative_project_link"
  | "customer"
  | "customer_request"
  | "customer_status"
  | "customer_tier";

export interface LinearVariableContract {
  allowed: readonly string[];
  required?: readonly string[];
  paginated?: boolean;
}

export interface LinearOperationDefinition {
  key: string;
  gate: LinearCapabilityGate;
  access: LinearOperationAccess;
  operationName: string;
  rootField: string;
  resourceType: LinearResourceType;
  resultKind: LinearOperationResultKind;
  document: string;
  variables: LinearVariableContract;
  destructive?: boolean;
  reversible?: boolean;
}

export interface LinearClientOptions {
  transport: HttpTransport;
  apiKey: string;
  timeoutMs?: number;
}

export interface LinearRequestOptions {
  abortSignal?: AbortSignal;
  deadlineAt?: number;
}

export interface LinearPageInput {
  first?: number;
  after?: string;
  includeArchived?: boolean;
}

export interface LinearPageInfo {
  hasNextPage: boolean;
  endCursor?: string;
}

export interface LinearPage<T> {
  items: T[];
  pageInfo: LinearPageInfo;
  fetchedAt: string;
}

export interface LinearReference {
  id: string;
  name?: string;
  key?: string;
  identifier?: string;
  url?: string;
}

export type LinearAttributeValue =
  | null
  | boolean
  | number
  | string
  | string[];

export interface LinearBaseRecord extends LinearReference {
  resourceType: LinearResourceType;
  trashed?: boolean;
  labels?: LinearReference[];
  attributes?: Record<string, LinearAttributeValue>;
  title?: string;
  description?: string;
  body?: string;
  content?: string;
  type?: string;
  color?: string;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string;
  snapshotHash: string;
}

export interface LinearIssueRecord extends LinearBaseRecord {
  resourceType: "issue";
  trashed: boolean;
  identifier: string;
  url: string;
  title: string;
  priority: number;
  estimate?: number;
  dueDate?: string;
  completedAt?: string;
  canceledAt?: string;
  team: LinearReference;
  state: LinearReference & { type?: string };
  project?: LinearReference;
  cycle?: LinearReference;
  projectMilestone?: LinearReference;
  assignee?: LinearReference;
  parent?: LinearReference;
  labels: LinearReference[];
}

export interface LinearCommentRecord extends LinearBaseRecord {
  resourceType: "comment";
  url: string;
  body: string;
  user?: LinearReference;
  issue?: LinearReference;
  parent?: LinearReference;
}

export interface LinearConnectionContext {
  viewer: LinearReference;
  workspace: LinearReference;
  fetchedAt: string;
}

export interface LinearMutationAck {
  success: true;
  operationKey: string;
  operationName: string;
  resourceType: LinearResourceType;
  acknowledgedAt: string;
}

export type LinearOperationResult =
  | LinearConnectionContext
  | LinearPage<LinearBaseRecord>
  | LinearBaseRecord
  | LinearMutationAck;

export type LinearClientErrorCode =
  | "linear_missing_api_key"
  | "linear_invalid_arguments"
  | "linear_unknown_operation"
  | "linear_auth"
  | "linear_forbidden"
  | "linear_not_found"
  | "linear_rate_limited"
  | "linear_timeout"
  | "linear_cancelled"
  | "linear_network"
  | "linear_http"
  | "linear_graphql"
  | "linear_partial_response"
  | "linear_invalid_response";

export interface SanitizedLinearGraphqlError {
  message: string;
  code?: string;
  path?: string[];
}

export class LinearClientError extends Error {
  readonly code: LinearClientErrorCode;
  readonly operationKey?: string;
  readonly status?: number;
  readonly retryAtMs?: number;
  readonly retryable: boolean;
  readonly details?: SanitizedLinearGraphqlError[];

  constructor(
    code: LinearClientErrorCode,
    message: string,
    options: {
      operationKey?: string;
      status?: number;
      retryAtMs?: number;
      retryable?: boolean;
      details?: SanitizedLinearGraphqlError[];
    } = {},
  ) {
    super(message);
    this.name = "LinearClientError";
    this.code = code;
    this.operationKey = options.operationKey;
    this.status = options.status;
    this.retryAtMs = options.retryAtMs;
    this.retryable = options.retryable === true;
    this.details = options.details;
  }
}

export type LinearMutationJournalState =
  | "intent_recorded"
  | "applying"
  | "applied"
  | "verified"
  | "committed"
  | "failed"
  | "reconcile_required";

export interface LinearMutationJournalRecord {
  version: 1;
  operationId: string;
  operationKey: string;
  resourceType: LinearResourceType;
  resourceId?: string;
  clientResourceId?: string;
  payloadHash: string;
  preconditionHash?: string;
  expectedPostHash?: string;
  observedPostHash?: string;
  expectedAbsent?: boolean;
  state: LinearMutationJournalState;
  mutationMayHaveApplied: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LinearReconciliationObservation {
  found: boolean;
  snapshotHash?: string;
}

export type LinearReconciliationAction =
  | "already_committed"
  | "commit_observed_result"
  | "safe_to_retry"
  | "reapprove_retry"
  | "wait_and_recheck"
  | "manual_review";

export interface LinearReconciliationDecision {
  action: LinearReconciliationAction;
  reason: string;
}
