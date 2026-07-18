import {
  canonicalJson,
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type ActionReconciliationResult,
  type JsonValue,
  type PreparedAction,
  type PreparedActionResult,
  type ResourceAction,
  type ResourceRef,
  type ToolDescriptor,
} from "../../agent/actions";
import type { JsonSchemaObject } from "../../model/types";
import {
  ToolExecutionError,
  type AgentTool,
  type AgentToolActionExecution,
  type ToolExecutionContext,
} from "../../tools/types";
import {
  getLinearOperationDefinition,
  type LinearOperationKey,
} from "./operations";
import {
  buildLinearOperationId,
  createLinearMutationJournalRecord,
  reconcileLinearMutation,
  transitionLinearMutationJournalRecord,
} from "./reconciliation";
import {
  LinearClientError,
  type LinearBaseRecord,
  type LinearCapabilityGate,
  type LinearCommentRecord,
  type LinearIssueRecord,
  type LinearOperationResult,
  type LinearRequestOptions,
  type LinearResourceType,
} from "./types";
import { sha256LinearValue, stableLinearJson } from "./client";

const PREPARED_ACTION_TTL_MS = 5 * 60 * 1_000;
const MAX_IDENTIFIER_CHARS = 256;
const MAX_TITLE_CHARS = 1_000;
const MAX_BODY_CHARS = 20_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LinearToolClient {
  execute(
    operationKey: LinearOperationKey | string,
    variables?: Record<string, unknown>,
    options?: LinearRequestOptions,
  ): Promise<LinearOperationResult>;
}

export interface CreateLinearToolsOptions {
  client: LinearToolClient;
  gate: LinearCapabilityGate;
  runIdFactory?: () => string;
}

/**
 * Model-facing names are intentionally enumerated. There is no generic query,
 * mutation, or operation-name argument that can escape the fixed catalog.
 */
export const LINEAR_TOOL_OPERATION_MAP: Readonly<Record<string, string>> =
  Object.freeze({
    linear_get_connection_context: "connection.context",
    linear_list_teams: "teams.list",
    linear_list_users: "users.list",
    linear_list_workflow_states: "workflow_states.list",
    linear_list_projects: "projects.list",
    linear_list_project_statuses: "project_statuses.list",
    linear_list_issue_labels: "issue_labels.list",
    linear_list_project_labels: "project_labels.list",
    linear_list_initiative_labels: "initiative_labels.list",
    linear_list_customer_statuses: "customer_statuses.list",
    linear_list_customer_tiers: "customer_tiers.list",
    linear_get_issue: "issues.get",
    linear_list_issues: "issues.list",
    linear_search_issues: "issues.search",
    linear_get_comment: "comments.get",
    linear_list_comments: "comments.list",
    linear_create_issue: "issues.create",
    linear_update_issue: "issues.update",
    linear_archive_issue: "issues.archive",
    linear_unarchive_issue: "issues.unarchive",
    linear_trash_issue: "issues.trash",
    linear_delete_issue_permanently: "issues.delete_permanently",
    linear_create_comment: "comments.create",
    linear_update_comment: "comments.update",
    linear_delete_comment: "comments.delete",
    linear_create_project: "projects.create",
    linear_update_project: "projects.update",
    linear_archive_project: "projects.archive",
    linear_trash_project: "projects.trash",
    linear_unarchive_project: "projects.unarchive",
    linear_create_project_update: "project_updates.create",
    linear_update_project_update: "project_updates.update",
    linear_archive_project_update: "project_updates.archive",
    linear_unarchive_project_update: "project_updates.unarchive",
    linear_delete_project_update: "project_updates.delete",
    linear_create_project_milestone: "project_milestones.create",
    linear_update_project_milestone: "project_milestones.update",
    linear_delete_project_milestone: "project_milestones.delete",
    linear_create_cycle: "cycles.create",
    linear_update_cycle: "cycles.update",
    linear_archive_cycle: "cycles.archive",
    linear_get_project: "projects.get",
    linear_get_project_update: "project_updates.get",
    linear_list_project_updates: "project_updates.list",
    linear_get_project_milestone: "project_milestones.get",
    linear_list_project_milestones: "project_milestones.list",
    linear_get_cycle: "cycles.get",
    linear_list_cycles: "cycles.list",
    linear_create_initiative: "initiatives.create",
    linear_update_initiative: "initiatives.update",
    linear_archive_initiative: "initiatives.archive",
    linear_unarchive_initiative: "initiatives.unarchive",
    linear_trash_initiative: "initiatives.trash",
    linear_create_initiative_update: "initiative_updates.create",
    linear_update_initiative_update: "initiative_updates.update",
    linear_archive_initiative_update: "initiative_updates.archive",
    linear_unarchive_initiative_update: "initiative_updates.unarchive",
    linear_create_document: "documents.create",
    linear_update_document: "documents.update",
    linear_trash_document: "documents.trash",
    linear_unarchive_document: "documents.unarchive",
    linear_get_initiative: "initiatives.get",
    linear_list_initiatives: "initiatives.list",
    linear_get_initiative_update: "initiative_updates.get",
    linear_list_initiative_updates: "initiative_updates.list",
    linear_get_document: "documents.get",
    linear_list_documents: "documents.list",
    linear_create_issue_label: "issue_labels.create",
    linear_update_issue_label: "issue_labels.update",
    linear_retire_issue_label: "issue_labels.retire",
    linear_restore_issue_label: "issue_labels.restore",
    linear_delete_issue_label: "issue_labels.delete",
    linear_create_project_label: "project_labels.create",
    linear_update_project_label: "project_labels.update",
    linear_retire_project_label: "project_labels.retire",
    linear_restore_project_label: "project_labels.restore",
    linear_delete_project_label: "project_labels.delete",
    linear_create_initiative_label: "initiative_labels.create",
    linear_update_initiative_label: "initiative_labels.update",
    linear_retire_initiative_label: "initiative_labels.retire",
    linear_restore_initiative_label: "initiative_labels.restore",
    linear_delete_initiative_label: "initiative_labels.delete",
    linear_add_label_to_issue: "issues.add_label",
    linear_remove_label_from_issue: "issues.remove_label",
    linear_add_label_to_project: "projects.add_label",
    linear_remove_label_from_project: "projects.remove_label",
    linear_create_issue_relation: "issue_relations.create",
    linear_update_issue_relation: "issue_relations.update",
    linear_delete_issue_relation: "issue_relations.delete",
    linear_create_project_relation: "project_relations.create",
    linear_update_project_relation: "project_relations.update",
    linear_delete_project_relation: "project_relations.delete",
    linear_create_initiative_relation: "initiative_relations.create",
    linear_update_initiative_relation: "initiative_relations.update",
    linear_delete_initiative_relation: "initiative_relations.delete",
    linear_create_initiative_project_link: "initiative_project_links.create",
    linear_update_initiative_project_link: "initiative_project_links.update",
    linear_delete_initiative_project_link: "initiative_project_links.delete",
    linear_get_issue_label: "issue_labels.get",
    linear_get_project_label: "project_labels.get",
    linear_get_initiative_label: "initiative_labels.get",
    linear_get_issue_relation: "issue_relations.get",
    linear_list_issue_relations: "issue_relations.list",
    linear_get_project_relation: "project_relations.get",
    linear_list_project_relations: "project_relations.list",
    linear_get_initiative_relation: "initiative_relations.get",
    linear_list_initiative_relations: "initiative_relations.list",
    linear_get_initiative_project_link: "initiative_project_links.get",
    linear_list_initiative_project_links: "initiative_project_links.list",
    linear_create_customer: "customers.create",
    linear_update_customer: "customers.update",
    linear_delete_customer: "customers.delete",
    linear_create_customer_request: "customer_requests.create",
    linear_update_customer_request: "customer_requests.update",
    linear_archive_customer_request: "customer_requests.archive",
    linear_unarchive_customer_request: "customer_requests.unarchive",
    linear_delete_customer_request: "customer_requests.delete",
    linear_get_customer: "customers.get",
    linear_list_customers: "customers.list",
    linear_get_customer_request: "customer_requests.get",
    linear_list_customer_requests: "customer_requests.list",
  });

interface ReadToolConfig {
  name: string;
  operationKey: string;
  gate: LinearCapabilityGate;
  action: "read" | "list" | "search";
}

type MutationKind =
  | "issue_create"
  | "issue_update"
  | "issue_archive"
  | "issue_unarchive"
  | "issue_trash"
  | "issue_delete"
  | "comment_create"
  | "comment_update"
  | "comment_delete"
  | "generic_create"
  | "generic_update"
  | "generic_archive"
  | "generic_unarchive"
  | "generic_trash"
  | "generic_delete"
  | "generic_retire"
  | "generic_restore"
  | "generic_link"
  | "generic_unlink";

interface MutationToolConfig {
  name: string;
  operationKey: string;
  readbackOperationKey: string;
  gate: LinearCapabilityGate;
  resourceType: LinearResourceType;
  action: ResourceAction;
  kind: MutationKind;
  risk: ToolDescriptor["risk"];
  effect: ToolDescriptor["effect"];
  parameters: JsonSchemaObject;
}

interface PreparedLinearPayload {
  operationKey: string;
  readbackOperationKey: string;
  mutationKind: MutationKind;
  variables: Record<string, JsonValue>;
  preconditionHash: string | null;
  expectedAbsent: boolean;
  changedFields: string[];
}

type LinearReadback =
  | { found: true; record: LinearBaseRecord }
  | { found: false };

const READ_TOOL_CONFIGS: readonly ReadToolConfig[] = [
  read("linear_get_connection_context", "connection.context", 0, "read"),
  read("linear_list_teams", "teams.list", 0, "list"),
  read("linear_list_users", "users.list", 0, "list"),
  read("linear_list_workflow_states", "workflow_states.list", 0, "list"),
  read("linear_list_projects", "projects.list", 0, "list"),
  read("linear_list_project_statuses", "project_statuses.list", 0, "list"),
  read("linear_list_issue_labels", "issue_labels.list", 0, "list"),
  read("linear_list_project_labels", "project_labels.list", 0, "list"),
  read("linear_list_initiative_labels", "initiative_labels.list", 0, "list"),
  read("linear_list_customer_statuses", "customer_statuses.list", 0, "list"),
  read("linear_list_customer_tiers", "customer_tiers.list", 0, "list"),
  read("linear_get_issue", "issues.get", 1, "read"),
  read("linear_list_issues", "issues.list", 1, "list"),
  read("linear_search_issues", "issues.search", 1, "search"),
  read("linear_get_comment", "comments.get", 1, "read"),
  read("linear_list_comments", "comments.list", 1, "list"),
  read("linear_get_project", "projects.get", 2, "read"),
  read("linear_get_project_update", "project_updates.get", 2, "read"),
  read("linear_list_project_updates", "project_updates.list", 2, "list"),
  read("linear_get_project_milestone", "project_milestones.get", 2, "read"),
  read("linear_list_project_milestones", "project_milestones.list", 2, "list"),
  read("linear_get_cycle", "cycles.get", 2, "read"),
  read("linear_list_cycles", "cycles.list", 2, "list"),
  read("linear_get_initiative", "initiatives.get", 3, "read"),
  read("linear_list_initiatives", "initiatives.list", 3, "list"),
  read("linear_get_initiative_update", "initiative_updates.get", 3, "read"),
  read("linear_list_initiative_updates", "initiative_updates.list", 3, "list"),
  read("linear_get_document", "documents.get", 3, "read"),
  read("linear_list_documents", "documents.list", 3, "list"),
  read("linear_get_issue_label", "issue_labels.get", 4, "read"),
  read("linear_get_project_label", "project_labels.get", 4, "read"),
  read("linear_get_initiative_label", "initiative_labels.get", 4, "read"),
  read("linear_get_issue_relation", "issue_relations.get", 4, "read"),
  read("linear_list_issue_relations", "issue_relations.list", 4, "list"),
  read("linear_get_project_relation", "project_relations.get", 4, "read"),
  read("linear_list_project_relations", "project_relations.list", 4, "list"),
  read("linear_get_initiative_relation", "initiative_relations.get", 4, "read"),
  read("linear_list_initiative_relations", "initiative_relations.list", 4, "list"),
  read(
    "linear_get_initiative_project_link",
    "initiative_project_links.get",
    4,
    "read",
  ),
  read(
    "linear_list_initiative_project_links",
    "initiative_project_links.list",
    4,
    "list",
  ),
  read("linear_get_customer", "customers.get", 5, "read"),
  read("linear_list_customers", "customers.list", 5, "list"),
  read("linear_get_customer_request", "customer_requests.get", 5, "read"),
  read("linear_list_customer_requests", "customer_requests.list", 5, "list"),
];

const ISSUE_CREATE_PARAMETERS = objectSchema(
  {
    id: stringSchema("Optional client-generated UUID for deterministic creation."),
    teamId: stringSchema("Linear team ID."),
    title: stringSchema("Issue title."),
    description: stringSchema("Issue description in Markdown."),
    stateId: stringSchema("Workflow state ID."),
    projectId: stringSchema("Project ID."),
    cycleId: stringSchema("Cycle ID."),
    projectMilestoneId: stringSchema("Project milestone ID."),
    assigneeId: stringSchema("Assignee user ID."),
    parentId: stringSchema("Parent issue ID."),
    labelIds: stringArraySchema("Issue label IDs."),
    priority: integerSchema("Linear priority from 0 through 4.", 0, 4),
    estimate: numberSchema("Issue estimate."),
    dueDate: stringSchema("Due date in Linear's accepted date format."),
  },
  ["title"],
);

const ISSUE_UPDATE_PARAMETERS = objectSchema({
  id: stringSchema("Issue ID or identifier."),
  title: stringSchema("Issue title."),
  description: nullableStringSchema("Issue description in Markdown, or null to clear."),
  stateId: stringSchema("Workflow state ID."),
  projectId: nullableStringSchema("Project ID, or null to clear."),
  cycleId: nullableStringSchema("Cycle ID, or null to clear."),
  projectMilestoneId: nullableStringSchema("Project milestone ID, or null to clear."),
  assigneeId: nullableStringSchema("Assignee user ID, or null to clear."),
  parentId: nullableStringSchema("Parent issue ID, or null to clear."),
  labelIds: stringArraySchema("Complete desired issue label ID set."),
  priority: integerSchema("Linear priority from 0 through 4.", 0, 4),
  estimate: nullableNumberSchema("Issue estimate, or null to clear."),
  dueDate: nullableStringSchema("Due date, or null to clear."),
}, ["id"]);

const ID_ONLY_PARAMETERS = objectSchema(
  { id: stringSchema("Linear resource ID or identifier.") },
  ["id"],
);

const COMMENT_CREATE_PARAMETERS = objectSchema(
  {
    id: stringSchema("Optional client-generated UUID for deterministic creation."),
    issueId: stringSchema("Issue ID receiving the comment."),
    body: stringSchema("Comment body in Markdown."),
  },
  ["issueId", "body"],
);

const COMMENT_UPDATE_PARAMETERS = objectSchema(
  {
    id: stringSchema("Comment ID."),
    body: stringSchema("Replacement comment body in Markdown."),
  },
  ["id", "body"],
);

const GENERIC_CREATE_PARAMETERS = objectSchema(
  { input: { type: "object", additionalProperties: true } },
  ["input"],
);

const GENERIC_UPDATE_PARAMETERS = objectSchema(
  {
    id: stringSchema("Linear resource ID."),
    input: { type: "object", additionalProperties: true },
  },
  ["id", "input"],
);

const GENERIC_BINDING_PARAMETERS = objectSchema(
  {
    id: stringSchema("Linear resource ID."),
    labelId: stringSchema("Linear label ID."),
  },
  ["id", "labelId"],
);

const MUTATION_TOOL_CONFIGS: readonly MutationToolConfig[] = [
  mutation("linear_create_issue", "issues.create", "issues.get", "issue", "create", "issue_create", "medium", "reversible_mutation", ISSUE_CREATE_PARAMETERS),
  mutation("linear_update_issue", "issues.update", "issues.get", "issue", "update", "issue_update", "medium", "reversible_mutation", ISSUE_UPDATE_PARAMETERS),
  mutation("linear_archive_issue", "issues.archive", "issues.get", "issue", "archive", "issue_archive", "medium", "reversible_mutation", ID_ONLY_PARAMETERS),
  mutation("linear_unarchive_issue", "issues.unarchive", "issues.get", "issue", "unarchive", "issue_unarchive", "medium", "reversible_mutation", ID_ONLY_PARAMETERS),
  mutation("linear_trash_issue", "issues.trash", "issues.get", "issue", "trash", "issue_trash", "high", "destructive_mutation", ID_ONLY_PARAMETERS),
  mutation("linear_delete_issue_permanently", "issues.delete_permanently", "issues.get", "issue", "delete", "issue_delete", "critical", "destructive_mutation", ID_ONLY_PARAMETERS),
  mutation("linear_create_comment", "comments.create", "comments.get", "comment", "create", "comment_create", "medium", "reversible_mutation", COMMENT_CREATE_PARAMETERS),
  mutation("linear_update_comment", "comments.update", "comments.get", "comment", "update", "comment_update", "medium", "reversible_mutation", COMMENT_UPDATE_PARAMETERS),
  mutation("linear_delete_comment", "comments.delete", "comments.get", "comment", "delete", "comment_delete", "high", "destructive_mutation", ID_ONLY_PARAMETERS),
  genericMutation("linear_create_project", "projects.create", "projects.get", "project", "create", "generic_create"),
  genericMutation("linear_update_project", "projects.update", "projects.get", "project", "update", "generic_update"),
  genericMutation("linear_archive_project", "projects.archive", "projects.get", "project", "archive", "generic_archive"),
  genericMutation("linear_trash_project", "projects.trash", "projects.get", "project", "trash", "generic_trash"),
  genericMutation("linear_unarchive_project", "projects.unarchive", "projects.get", "project", "unarchive", "generic_unarchive"),
  genericMutation("linear_create_project_update", "project_updates.create", "project_updates.get", "project_update", "create", "generic_create"),
  genericMutation("linear_update_project_update", "project_updates.update", "project_updates.get", "project_update", "update", "generic_update"),
  genericMutation("linear_archive_project_update", "project_updates.archive", "project_updates.get", "project_update", "archive", "generic_archive"),
  genericMutation("linear_unarchive_project_update", "project_updates.unarchive", "project_updates.get", "project_update", "unarchive", "generic_unarchive"),
  genericMutation("linear_delete_project_update", "project_updates.delete", "project_updates.get", "project_update", "delete", "generic_delete"),
  genericMutation("linear_create_project_milestone", "project_milestones.create", "project_milestones.get", "project_milestone", "create", "generic_create"),
  genericMutation("linear_update_project_milestone", "project_milestones.update", "project_milestones.get", "project_milestone", "update", "generic_update"),
  genericMutation("linear_delete_project_milestone", "project_milestones.delete", "project_milestones.get", "project_milestone", "delete", "generic_delete"),
  genericMutation("linear_create_cycle", "cycles.create", "cycles.get", "cycle", "create", "generic_create"),
  genericMutation("linear_update_cycle", "cycles.update", "cycles.get", "cycle", "update", "generic_update"),
  genericMutation("linear_archive_cycle", "cycles.archive", "cycles.get", "cycle", "archive", "generic_archive"),
  genericMutation("linear_create_initiative", "initiatives.create", "initiatives.get", "initiative", "create", "generic_create"),
  genericMutation("linear_update_initiative", "initiatives.update", "initiatives.get", "initiative", "update", "generic_update"),
  genericMutation("linear_archive_initiative", "initiatives.archive", "initiatives.get", "initiative", "archive", "generic_archive"),
  genericMutation("linear_unarchive_initiative", "initiatives.unarchive", "initiatives.get", "initiative", "unarchive", "generic_unarchive"),
  genericMutation("linear_trash_initiative", "initiatives.trash", "initiatives.get", "initiative", "trash", "generic_trash"),
  genericMutation("linear_create_initiative_update", "initiative_updates.create", "initiative_updates.get", "initiative_update", "create", "generic_create"),
  genericMutation("linear_update_initiative_update", "initiative_updates.update", "initiative_updates.get", "initiative_update", "update", "generic_update"),
  genericMutation("linear_archive_initiative_update", "initiative_updates.archive", "initiative_updates.get", "initiative_update", "archive", "generic_archive"),
  genericMutation("linear_unarchive_initiative_update", "initiative_updates.unarchive", "initiative_updates.get", "initiative_update", "unarchive", "generic_unarchive"),
  genericMutation("linear_create_document", "documents.create", "documents.get", "document", "create", "generic_create"),
  genericMutation("linear_update_document", "documents.update", "documents.get", "document", "update", "generic_update"),
  genericMutation("linear_trash_document", "documents.trash", "documents.get", "document", "trash", "generic_trash"),
  genericMutation("linear_unarchive_document", "documents.unarchive", "documents.get", "document", "unarchive", "generic_unarchive"),
  genericMutation("linear_create_issue_label", "issue_labels.create", "issue_labels.get", "issue_label", "create", "generic_create"),
  genericMutation("linear_update_issue_label", "issue_labels.update", "issue_labels.get", "issue_label", "update", "generic_update"),
  genericMutation("linear_retire_issue_label", "issue_labels.retire", "issue_labels.get", "issue_label", "archive", "generic_retire"),
  genericMutation("linear_restore_issue_label", "issue_labels.restore", "issue_labels.get", "issue_label", "restore", "generic_restore"),
  genericMutation("linear_delete_issue_label", "issue_labels.delete", "issue_labels.get", "issue_label", "delete", "generic_delete"),
  genericMutation("linear_create_project_label", "project_labels.create", "project_labels.get", "project_label", "create", "generic_create"),
  genericMutation("linear_update_project_label", "project_labels.update", "project_labels.get", "project_label", "update", "generic_update"),
  genericMutation("linear_retire_project_label", "project_labels.retire", "project_labels.get", "project_label", "archive", "generic_retire"),
  genericMutation("linear_restore_project_label", "project_labels.restore", "project_labels.get", "project_label", "restore", "generic_restore"),
  genericMutation("linear_delete_project_label", "project_labels.delete", "project_labels.get", "project_label", "delete", "generic_delete"),
  genericMutation("linear_create_initiative_label", "initiative_labels.create", "initiative_labels.get", "initiative_label", "create", "generic_create"),
  genericMutation("linear_update_initiative_label", "initiative_labels.update", "initiative_labels.get", "initiative_label", "update", "generic_update"),
  genericMutation("linear_retire_initiative_label", "initiative_labels.retire", "initiative_labels.get", "initiative_label", "archive", "generic_retire"),
  genericMutation("linear_restore_initiative_label", "initiative_labels.restore", "initiative_labels.get", "initiative_label", "restore", "generic_restore"),
  genericMutation("linear_delete_initiative_label", "initiative_labels.delete", "initiative_labels.get", "initiative_label", "delete", "generic_delete"),
  genericMutation("linear_add_label_to_issue", "issues.add_label", "issues.get", "issue", "link", "generic_link"),
  genericMutation("linear_remove_label_from_issue", "issues.remove_label", "issues.get", "issue", "unlink", "generic_unlink"),
  genericMutation("linear_add_label_to_project", "projects.add_label", "projects.get", "project", "link", "generic_link"),
  genericMutation("linear_remove_label_from_project", "projects.remove_label", "projects.get", "project", "unlink", "generic_unlink"),
  genericMutation("linear_create_issue_relation", "issue_relations.create", "issue_relations.get", "issue_relation", "create", "generic_create"),
  genericMutation("linear_update_issue_relation", "issue_relations.update", "issue_relations.get", "issue_relation", "update", "generic_update"),
  genericMutation("linear_delete_issue_relation", "issue_relations.delete", "issue_relations.get", "issue_relation", "delete", "generic_delete"),
  genericMutation("linear_create_project_relation", "project_relations.create", "project_relations.get", "project_relation", "create", "generic_create"),
  genericMutation("linear_update_project_relation", "project_relations.update", "project_relations.get", "project_relation", "update", "generic_update"),
  genericMutation("linear_delete_project_relation", "project_relations.delete", "project_relations.get", "project_relation", "delete", "generic_delete"),
  genericMutation("linear_create_initiative_relation", "initiative_relations.create", "initiative_relations.get", "initiative_relation", "create", "generic_create"),
  genericMutation("linear_update_initiative_relation", "initiative_relations.update", "initiative_relations.get", "initiative_relation", "update", "generic_update"),
  genericMutation("linear_delete_initiative_relation", "initiative_relations.delete", "initiative_relations.get", "initiative_relation", "delete", "generic_delete"),
  genericMutation("linear_create_initiative_project_link", "initiative_project_links.create", "initiative_project_links.get", "initiative_project_link", "create", "generic_create"),
  genericMutation("linear_update_initiative_project_link", "initiative_project_links.update", "initiative_project_links.get", "initiative_project_link", "update", "generic_update"),
  genericMutation("linear_delete_initiative_project_link", "initiative_project_links.delete", "initiative_project_links.get", "initiative_project_link", "delete", "generic_delete"),
  genericMutation("linear_create_customer", "customers.create", "customers.get", "customer", "create", "generic_create"),
  genericMutation("linear_update_customer", "customers.update", "customers.get", "customer", "update", "generic_update"),
  genericMutation("linear_delete_customer", "customers.delete", "customers.get", "customer", "delete", "generic_delete"),
  genericMutation("linear_create_customer_request", "customer_requests.create", "customer_requests.get", "customer_request", "create", "generic_create"),
  genericMutation("linear_update_customer_request", "customer_requests.update", "customer_requests.get", "customer_request", "update", "generic_update"),
  genericMutation("linear_archive_customer_request", "customer_requests.archive", "customer_requests.get", "customer_request", "archive", "generic_archive"),
  genericMutation("linear_unarchive_customer_request", "customer_requests.unarchive", "customer_requests.get", "customer_request", "unarchive", "generic_unarchive"),
  genericMutation("linear_delete_customer_request", "customer_requests.delete", "customer_requests.get", "customer_request", "delete", "generic_delete"),
];

export function createLinearTools(options: CreateLinearToolsOptions): AgentTool[] {
  const maxGate = normalizeGate(options.gate);
  const runIdFactory = options.runIdFactory ?? defaultRunId;
  const reads = READ_TOOL_CONFIGS
    .filter((config) => config.gate <= maxGate)
    .map((config) => createReadTool(config, options.client));
  const mutations = MUTATION_TOOL_CONFIGS
    .filter((config) => config.gate <= maxGate)
    .map((config) => createMutationTool(config, options.client, runIdFactory));
  return [...reads, ...mutations];
}

function createReadTool(
  config: ReadToolConfig,
  client: LinearToolClient,
): AgentTool {
  const definition = requireMappedDefinition(config.name, config.operationKey, "read");
  return {
    name: config.name,
    description: `Run the fixed Linear ${config.operationKey} read operation.`,
    parameters: schemaForReadOperation(definition.variables.allowed, definition.variables.required),
    descriptor: readDescriptor(config),
    execute: (args, context) =>
      client.execute(config.operationKey, args, requestOptions(context)),
  };
}

function createMutationTool(
  config: MutationToolConfig,
  client: LinearToolClient,
  runIdFactory: () => string,
): AgentTool {
  requireMappedDefinition(config.name, config.operationKey, "write");
  requireReadbackDefinition(config);
  const descriptor = mutationDescriptor(config);
  return {
    name: config.name,
    description:
      `Prepare and execute the fixed Linear ${config.operationKey} mutation with exact authority, independent readback, and reconciliation.`,
    parameters: config.parameters,
    descriptor,
    execute: async () => {
      throw new ToolExecutionError(
        "prepared_action_required",
        `Tool ${config.name} must be prepared and authorized before execution.`,
        { mutationState: "not_applied" },
      );
    },
    prepare: (args, context) =>
      prepareMutation(config, client, runIdFactory, args, context),
    executePrepared: (action, context) =>
      executePreparedMutation(config, client, action, context),
    reconcile: (action, context) =>
      reconcilePreparedMutation(config, client, action, context),
  };
}

async function prepareMutation(
  config: MutationToolConfig,
  client: LinearToolClient,
  runIdFactory: () => string,
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    const preparedAt = now(context);
    const runId = requireIdentity(context.runId ?? runIdFactory(), "run ID");
    const toolCallId = requireIdentity(
      context.operationId ?? `call-${randomToken()}`,
      "tool call ID",
    );
    const operationId = buildLinearOperationId({
      resourceType: config.resourceType,
      verb: config.action,
      runId,
      taskId: toolCallId,
    });
    const effectiveArgs =
      config.kind === "issue_create" &&
      typeof args.teamId !== "string" &&
      context.settings?.linearDefaultTeamId
        ? { ...args, teamId: context.settings.linearDefaultTeamId }
        : args;
    const variables = await normalizeMutationVariables(
      config,
      effectiveArgs,
      operationId,
    );
    const scopeIssue = config.kind === "comment_create"
      ? await readCommentTargetIssue(client, variables, context)
      : undefined;
    const suppliedId = getMutationResourceId(config, variables);
    const before = await readResource(
      client,
      config.readbackOperationKey,
      suppliedId,
      context,
    );

    if (isCreate(config.kind)) {
      if (before.found) {
        throw new ToolExecutionError(
          "linear_duplicate_target",
          `Linear ${config.resourceType} ${suppliedId} already exists.`,
          { mutationState: "not_applied" },
        );
      }
    } else if (!before.found) {
      throw new ToolExecutionError(
        "linear_target_not_found",
        `Linear ${config.resourceType} ${suppliedId} was not found.`,
        { mutationState: "not_applied" },
      );
    }

    const canonicalId = before.found ? before.record.id : suppliedId;
    if (!isCreate(config.kind)) {
      variables.id = canonicalId;
    }
    assertPreparationChangesState(config, variables, before);
    const changedFields = mutationChangedFields(config, variables);
    const target = targetResource(
      config,
      canonicalId,
      variables,
      before,
      scopeIssue,
    );
    const relatedResources = relatedResourcesFor(config, variables, scopeIssue);
    const preconditionHash = before.found ? before.record.snapshotHash : null;
    const normalizedArgs: Record<string, JsonValue> = {
      operationKey: config.operationKey,
      readbackOperationKey: config.readbackOperationKey,
      mutationKind: config.kind,
      variables: variables as Record<string, JsonValue>,
      preconditionHash,
      expectedAbsent: expectsAbsence(config.kind),
      changedFields,
    };
    const outboundPayload = variables as Record<string, JsonValue>;
    const actionIdHash = await sha256Fingerprint({
      runId,
      toolCallId,
      toolName: config.name,
      operationId,
    });
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: `linear-action-${actionIdHash.slice("sha256:".length, 39)}`,
      runId,
      toolCallId,
      toolName: config.name,
      target,
      relatedResources,
      normalizedArgs,
      preview: {
        summary: previewSummary(config, target),
        destination: previewDestination(config, target),
        ...(before.found ? { before: previewRecord(before.record) } : {}),
        after: previewAfter(config, variables),
        outboundPayload,
        warnings:
          config.effect === "destructive_mutation"
            ? ["This Linear mutation is destructive and requires exact approval."]
            : [],
        outboundBytes: new TextEncoder().encode(stableLinearJson(variables)).length,
      },
      ...(preconditionHash ? { expectedTargetRevision: preconditionHash } : {}),
      idempotencyKey: operationId,
      reconciliationKey: operationId,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + PREPARED_ACTION_TTL_MS).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code: error instanceof ToolExecutionError
          ? error.code
          : error instanceof LinearClientError
            ? error.code
            : "linear_preparation_failed",
        message: safeErrorMessage(error),
      },
    };
  }
}

async function executePreparedMutation(
  config: MutationToolConfig,
  client: LinearToolClient,
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedExecutionBinding(config, action, context);
  const payload = parsePreparedPayload(config, action);
  const beforeDispatch = await readResource(
    client,
    config.readbackOperationKey,
    action.target.id,
    context,
    true,
  );
  assertExactPrecondition(config, action, payload, beforeDispatch);
  if (config.kind === "comment_create") {
    await assertCommentScopeUnchanged(client, action, payload, context);
  }

  const payloadHash = await sha256LinearValue(payload.variables);
  let journal = createLinearMutationJournalRecord({
    operationId: action.reconciliationKey ?? action.idempotencyKey ?? action.id,
    operationKey: config.operationKey,
    resourceType: config.resourceType,
    resourceId: action.target.id,
    payloadHash,
    preconditionHash: payload.preconditionHash ?? undefined,
    expectedAbsent: payload.expectedAbsent,
    now: now(context),
  });
  journal = transitionLinearMutationJournalRecord(journal, "applying", {
    now: now(context),
  });
  context.reportProgress?.(`Applying prepared Linear operation ${config.operationKey}.`);
  const startedAt = now(context).toISOString();

  try {
    await client.execute(
      config.operationKey,
      payload.variables,
      requestOptions(context),
    );
    journal = transitionLinearMutationJournalRecord(journal, "applied", {
      mutationMayHaveApplied: true,
      now: now(context),
    });
  } catch (error) {
    if (isDefinitelyNotApplied(error)) {
      throw new ToolExecutionError(
        error instanceof LinearClientError ? error.code : "linear_mutation_failed",
        safeErrorMessage(error),
        { mutationState: "not_applied" },
      );
    }
    journal = transitionLinearMutationJournalRecord(
      journal,
      "reconcile_required",
      { mutationMayHaveApplied: true, now: now(context) },
    );
    throw new ToolExecutionError(
      "linear_mutation_uncertain",
      `Linear mutation outcome is uncertain and requires readback reconciliation: ${safeErrorMessage(error)}`,
      {
        mutationState: "may_have_applied",
        details: {
          reconciliationKey: journal.operationId,
          linearCode:
            error instanceof LinearClientError ? error.code : "linear_network",
        },
      },
    );
  }

  const observation = await readResource(
    client,
    config.readbackOperationKey,
    action.target.id,
    context,
    true,
  );
  const verification = verifyPostcondition(config, payload.variables, observation);
  if (!verification.ok) {
    const mismatchFields = describePostconditionMismatch(
      config,
      payload.variables,
      observation,
    );
    throw new ToolExecutionError(
      "linear_readback_failed",
      `Linear acknowledged ${config.operationKey}, but independent readback did not verify the approved result. Mismatched readback fields: ${mismatchFields.join(", ")}.`,
      {
        mutationState: "may_have_applied",
        details: { reconciliationKey: journal.operationId, mismatchFields },
      },
    );
  }
  journal = transitionLinearMutationJournalRecord(journal, "verified", {
    observedPostHash: observation.found
      ? observation.record.snapshotHash
      : undefined,
    now: now(context),
  });
  journal = transitionLinearMutationJournalRecord(journal, "committed", {
    now: now(context),
  });
  const receipt = await createReceipt({
    config,
    action,
    context,
    observation,
    changedFields: verification.changedFields,
    commitKind: "committed",
    startedAt,
    grantId: context.authorizedAction!.grantId,
  });
  return {
    output: observation.found
      ? observation.record
      : { success: true, deleted: true, id: action.target.id },
    receipt,
    mutationState: "applied",
  };
}

async function reconcilePreparedMutation(
  config: MutationToolConfig,
  client: LinearToolClient,
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<ActionReconciliationResult> {
  let payload: PreparedLinearPayload;
  try {
    payload = parsePreparedPayload(config, action);
  } catch (error) {
    return { outcome: "still_uncertain", message: safeErrorMessage(error) };
  }

  let observation: LinearReadback;
  try {
    observation = await readResource(
      client,
      config.readbackOperationKey,
      action.target.id,
      context,
      true,
    );
  } catch (error) {
    return {
      outcome: "still_uncertain",
      message: `Linear reconciliation readback failed: ${safeErrorMessage(error)}`,
    };
  }

  const verification = verifyPostcondition(config, payload.variables, observation);
  const payloadHash = await sha256LinearValue(payload.variables);
  let journal = createLinearMutationJournalRecord({
    operationId: action.reconciliationKey ?? action.idempotencyKey ?? action.id,
    operationKey: config.operationKey,
    resourceType: config.resourceType,
    resourceId: action.target.id,
    payloadHash,
    preconditionHash: payload.preconditionHash ?? undefined,
    expectedPostHash:
      verification.ok && observation.found
        ? observation.record.snapshotHash
        : undefined,
    expectedAbsent: payload.expectedAbsent,
    now: now(context),
  });
  journal = transitionLinearMutationJournalRecord(journal, "applying", {
    now: now(context),
  });
  journal = transitionLinearMutationJournalRecord(
    journal,
    "reconcile_required",
    { mutationMayHaveApplied: true, now: now(context) },
  );
  const decision = reconcileLinearMutation(journal, {
    found: observation.found,
    snapshotHash: observation.found
      ? observation.record.snapshotHash
      : undefined,
  });

  if (decision.action === "commit_observed_result" && verification.ok) {
    const timestamp = now(context).toISOString();
    const receipt = await createReceipt({
      config,
      action,
      context,
      observation,
      changedFields: verification.changedFields,
      commitKind: "reconciled",
      startedAt: timestamp,
      grantId: context.authorizedAction?.grantId ?? "linear-reconciliation",
    });
    return { outcome: "committed", receipt, message: decision.reason };
  }
  if (
    decision.action === "safe_to_retry" ||
    decision.action === "reapprove_retry"
  ) {
    return { outcome: "not_applied", message: decision.reason };
  }
  return { outcome: "still_uncertain", message: decision.reason };
}

async function assertPreparedExecutionBinding(
  config: MutationToolConfig,
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  if (
    action.toolName !== config.name ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw new ToolExecutionError(
      "fingerprint_mismatch",
      "Prepared Linear action identity or fingerprint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  const authorized = context.authorizedAction;
  if (
    !authorized ||
    authorized.preparedActionId !== action.id ||
    authorized.payloadFingerprint !== action.payloadFingerprint ||
    !authorized.grantId.trim()
  ) {
    throw new ToolExecutionError(
      "authorization_mismatch",
      "Prepared Linear action lacks its exact authority binding.",
      { mutationState: "not_applied" },
    );
  }
}

function assertExactPrecondition(
  config: MutationToolConfig,
  action: PreparedAction,
  payload: PreparedLinearPayload,
  observation: LinearReadback,
): void {
  if (isCreate(config.kind)) {
    if (observation.found) {
      throw new ToolExecutionError(
        "linear_precondition_changed",
        "The prepared Linear create target now exists.",
        { mutationState: "not_applied" },
      );
    }
    return;
  }
  if (
    !observation.found ||
    !payload.preconditionHash ||
    observation.record.snapshotHash !== payload.preconditionHash ||
    action.expectedTargetRevision !== payload.preconditionHash
  ) {
    throw new ToolExecutionError(
      "linear_precondition_changed",
      "The Linear target changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
}

async function createReceipt(input: {
  config: MutationToolConfig;
  action: PreparedAction;
  context: ToolExecutionContext;
  observation: LinearReadback;
  changedFields: string[];
  commitKind: ActionReceipt["commitKind"];
  startedAt: string;
  grantId: string;
}): Promise<ActionReceipt> {
  const checkedAt = now(input.context).toISOString();
  const observedFingerprint = input.observation.found
    ? input.observation.record.snapshotHash
    : await sha256Fingerprint({ absent: true, id: input.action.target.id });
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    commitKind: input.commitKind,
    observedFingerprint,
  });
  return {
    version: 1,
    id: `linear-receipt-${receiptHash.slice("sha256:".length, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: input.config.action,
    resource: receiptResource(input.action.target, input.observation),
    relatedResources: input.action.relatedResources,
    message: receiptMessage(input.config, input.action.target, input.commitKind),
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: checkedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt,
      observedRevision: observedFingerprint,
      observedFingerprint,
    },
    effects: {
      affectedCount: 1,
      changedFields: input.changedFields,
    },
  };
}

async function normalizeMutationVariables(
  config: MutationToolConfig,
  args: Record<string, unknown>,
  operationId: string,
): Promise<Record<string, JsonValue>> {
  switch (config.kind) {
    case "issue_create":
      return { input: await issueCreateInput(args, operationId) };
    case "issue_update":
      return issueUpdateVariables(args);
    case "comment_create":
      return { input: await commentCreateInput(args, operationId) };
    case "comment_update":
      return commentUpdateVariables(args);
    case "generic_create": {
      assertAllowedArgs(args, ["input"]);
      const input = cloneJsonObject(args.input, "input");
      input.id = input.id === undefined
        ? await deterministicUuid(operationId)
        : requireUuid(input.id, "input.id");
      return { input };
    }
    case "generic_update": {
      assertAllowedArgs(args, ["id", "input"]);
      const input = cloneJsonObject(args.input, "input");
      if (Object.keys(input).length === 0) {
        throw invalidArguments("Linear update input must contain at least one field.");
      }
      return {
        id: boundedString(args.id, "id", MAX_IDENTIFIER_CHARS),
        input,
      };
    }
    case "generic_link":
    case "generic_unlink":
      assertAllowedArgs(args, ["id", "labelId"]);
      return {
        id: boundedString(args.id, "id", MAX_IDENTIFIER_CHARS),
        labelId: boundedString(args.labelId, "labelId", MAX_IDENTIFIER_CHARS),
      };
    default:
      assertAllowedArgs(args, ["id"]);
      return { id: boundedString(args.id, "id", MAX_IDENTIFIER_CHARS) };
  }
}

async function issueCreateInput(
  args: Record<string, unknown>,
  operationId: string,
): Promise<Record<string, JsonValue>> {
  const allowed = [
    "id", "teamId", "title", "description", "stateId", "projectId",
    "cycleId", "projectMilestoneId", "assigneeId", "parentId", "labelIds",
    "priority", "estimate", "dueDate",
  ];
  assertAllowedArgs(args, allowed);
  const id = args.id === undefined
    ? await deterministicUuid(operationId)
    : requireUuid(args.id, "id");
  const input: Record<string, JsonValue> = {
    id,
    teamId: boundedString(args.teamId, "teamId", MAX_IDENTIFIER_CHARS),
    title: boundedString(args.title, "title", MAX_TITLE_CHARS),
  };
  copyOptionalStringArg(args, input, "description", MAX_BODY_CHARS, false);
  for (const key of [
    "stateId", "projectId", "cycleId", "projectMilestoneId", "assigneeId",
    "parentId", "dueDate",
  ]) {
    copyOptionalStringArg(args, input, key, MAX_IDENTIFIER_CHARS, false);
  }
  copyOptionalLabelIds(args, input);
  copyOptionalInteger(args, input, "priority", 0, 4, false);
  copyOptionalFiniteNumber(args, input, "estimate", false);
  return input;
}

function issueUpdateVariables(
  args: Record<string, unknown>,
): Record<string, JsonValue> {
  const allowed = [
    "id", "title", "description", "stateId", "projectId", "cycleId",
    "projectMilestoneId", "assigneeId", "parentId", "labelIds", "priority",
    "estimate", "dueDate",
  ];
  assertAllowedArgs(args, allowed);
  const input: Record<string, JsonValue> = {};
  copyOptionalStringArg(args, input, "title", MAX_TITLE_CHARS, false);
  copyOptionalStringArg(args, input, "description", MAX_BODY_CHARS, true);
  copyOptionalStringArg(args, input, "stateId", MAX_IDENTIFIER_CHARS, false);
  for (const key of [
    "projectId", "cycleId", "projectMilestoneId", "assigneeId", "parentId",
    "dueDate",
  ]) {
    copyOptionalStringArg(args, input, key, MAX_IDENTIFIER_CHARS, true);
  }
  copyOptionalLabelIds(args, input);
  copyOptionalInteger(args, input, "priority", 0, 4, false);
  copyOptionalFiniteNumber(args, input, "estimate", true);
  if (Object.keys(input).length === 0) {
    throw new ToolExecutionError(
      "linear_invalid_arguments",
      "Issue update requires at least one changed field.",
      { mutationState: "not_applied" },
    );
  }
  return {
    id: boundedString(args.id, "id", MAX_IDENTIFIER_CHARS),
    input,
  };
}

async function commentCreateInput(
  args: Record<string, unknown>,
  operationId: string,
): Promise<Record<string, JsonValue>> {
  assertAllowedArgs(args, ["id", "issueId", "body"]);
  return {
    id: args.id === undefined
      ? await deterministicUuid(operationId)
      : requireUuid(args.id, "id"),
    issueId: boundedString(args.issueId, "issueId", MAX_IDENTIFIER_CHARS),
    body: boundedString(args.body, "body", MAX_BODY_CHARS),
  };
}

function commentUpdateVariables(
  args: Record<string, unknown>,
): Record<string, JsonValue> {
  assertAllowedArgs(args, ["id", "body"]);
  return {
    id: boundedString(args.id, "id", MAX_IDENTIFIER_CHARS),
    input: { body: boundedString(args.body, "body", MAX_BODY_CHARS) },
  };
}

function assertPreparationChangesState(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
  before: LinearReadback,
): void {
  if (!before.found || isCreate(config.kind) || expectsAbsence(config.kind)) {
    return;
  }
  if (verifyPostcondition(config, variables, before).ok) {
    throw new ToolExecutionError(
      "linear_no_changes",
      "The Linear target already matches the requested state.",
      { mutationState: "not_applied" },
    );
  }
}

function verifyPostcondition(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
  observation: LinearReadback,
): { ok: boolean; changedFields: string[] } {
  const changedFields = mutationChangedFields(config, variables);
  if (expectsAbsence(config.kind)) {
    return { ok: !observation.found, changedFields };
  }
  if (!observation.found || observation.record.resourceType !== config.resourceType) {
    return { ok: false, changedFields };
  }
  if (config.kind === "issue_archive") {
    return {
      ok: observation.record.archivedAt !== undefined &&
        (observation.record as LinearIssueRecord).trashed !== true,
      changedFields,
    };
  }
  if (config.kind === "issue_unarchive") {
    return {
      ok: observation.record.archivedAt === undefined &&
        (observation.record as LinearIssueRecord).trashed !== true,
      changedFields,
    };
  }
  if (config.kind === "issue_trash") {
    return {
      ok: (observation.record as LinearIssueRecord).trashed === true,
      changedFields,
    };
  }
  if (config.kind === "generic_archive" || config.kind === "generic_retire") {
    return {
      ok: observation.record.archivedAt !== undefined &&
        observation.record.trashed !== true,
      changedFields,
    };
  }
  if (config.kind === "generic_unarchive" || config.kind === "generic_restore") {
    return {
      ok: observation.record.archivedAt === undefined &&
        observation.record.trashed !== true,
      changedFields,
    };
  }
  if (config.kind === "generic_trash") {
    return { ok: observation.record.trashed === true, changedFields };
  }
  if (config.kind === "generic_link" || config.kind === "generic_unlink") {
    const labelId = typeof variables.labelId === "string" ? variables.labelId : "";
    const hasLabel = observation.record.labels?.some((label) => label.id === labelId) === true;
    return {
      ok: config.kind === "generic_link" ? hasLabel : !hasLabel,
      changedFields,
    };
  }
  const input = recordValue(variables.input);
  if (config.kind === "generic_create" || config.kind === "generic_update") {
    return {
      ok: matchesGenericInput(observation.record, input),
      changedFields,
    };
  }
  if (config.resourceType === "issue") {
    return {
      ok: matchesIssueInput(observation.record as LinearIssueRecord, input),
      changedFields,
    };
  }
  return {
    ok: matchesCommentInput(observation.record as LinearCommentRecord, input),
    changedFields,
  };
}

function matchesIssueInput(
  issue: LinearIssueRecord,
  input: Record<string, JsonValue>,
): boolean {
  return issueInputMismatchFields(issue, input).length === 0;
}

function issueInputMismatchFields(
  issue: LinearIssueRecord,
  input: Record<string, JsonValue>,
): string[] {
  const mismatchedFields: string[] = [];
  const comparisons: Record<string, unknown> = {
    title: issue.title,
    description: issue.description,
    teamId: issue.team.id,
    stateId: issue.state.id,
    projectId: issue.project?.id,
    cycleId: issue.cycle?.id,
    projectMilestoneId: issue.projectMilestone?.id,
    assigneeId: issue.assignee?.id,
    parentId: issue.parent?.id,
    priority: issue.priority,
    estimate: issue.estimate,
    dueDate: issue.dueDate,
  };
  for (const [key, expected] of Object.entries(input)) {
    if (key === "id") continue;
    if (key === "labelIds") {
      const actualIds = issue.labels.map((label) => label.id).sort();
      const expectedIds = Array.isArray(expected)
        ? expected.map(String).sort()
        : [];
      if (canonicalJson(actualIds) !== canonicalJson(expectedIds)) {
        mismatchedFields.push(key);
      }
      continue;
    }
    const actual = comparisons[key];
    if (expected === null ? actual !== undefined : actual !== expected) {
      mismatchedFields.push(key);
    }
  }
  return mismatchedFields.sort();
}

function describePostconditionMismatch(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
  observation: LinearReadback,
): string[] {
  if (!observation.found) return ["resource_absent"];
  if (observation.record.resourceType !== config.resourceType) {
    return ["resource_type"];
  }
  const input = recordValue(variables.input);
  if (config.resourceType === "issue") {
    const fields = issueInputMismatchFields(
      observation.record as LinearIssueRecord,
      input,
    );
    return fields.length > 0 ? fields : ["issue_postcondition"];
  }
  return ["postcondition"];
}

function matchesCommentInput(
  comment: LinearCommentRecord,
  input: Record<string, JsonValue>,
): boolean {
  if (typeof input.body === "string" && comment.body !== input.body) {
    return false;
  }
  if (typeof input.issueId === "string" && comment.issue?.id !== input.issueId) {
    return false;
  }
  return comment.id.length > 0;
}

function matchesGenericInput(
  record: LinearBaseRecord,
  input: Record<string, JsonValue>,
): boolean {
  for (const [key, expected] of Object.entries(input)) {
    if (key === "id") continue;
    const actual = genericObservedValue(record, key);
    if (actual === undefined && expected !== null) return false;
    if (Array.isArray(expected)) {
      if (!Array.isArray(actual)) return false;
      const expectedValues = expected.map(String).sort();
      const actualValues = actual.map(String).sort();
      if (canonicalJson(expectedValues) !== canonicalJson(actualValues)) return false;
      continue;
    }
    if (typeof expected === "object" && expected !== null) {
      return false;
    }
    if (expected === null ? actual !== null && actual !== undefined : actual !== expected) {
      return false;
    }
  }
  return true;
}

function genericObservedValue(
  record: LinearBaseRecord,
  inputKey: string,
): JsonValue | undefined {
  const direct: Record<string, JsonValue | undefined> = {
    name: record.name,
    title: record.title,
    description: record.description,
    body: record.body,
    content: record.content,
    type: record.type,
    color: record.color,
  };
  if (direct[inputKey] !== undefined) return direct[inputKey];
  if (record.attributes?.[inputKey] !== undefined) {
    return record.attributes[inputKey];
  }
  if (inputKey.endsWith("Ids")) {
    const relation = `${inputKey.slice(0, -3)}s`;
    if (record.attributes?.[relation] !== undefined) {
      return record.attributes[relation];
    }
    if (inputKey === "labelIds" && record.labels) {
      return record.labels.map((label) => label.id);
    }
  }
  if (inputKey.endsWith("Id")) {
    const relation = inputKey.slice(0, -2);
    if (record.attributes?.[relation] !== undefined) {
      return record.attributes[relation];
    }
  }
  return undefined;
}

async function readCommentTargetIssue(
  client: LinearToolClient,
  variables: Record<string, JsonValue>,
  context: ToolExecutionContext,
): Promise<LinearIssueRecord> {
  const input = recordValue(variables.input);
  const requestedIssueId = boundedString(
    input.issueId,
    "issueId",
    MAX_IDENTIFIER_CHARS,
  );
  const observation = await readResource(
    client,
    "issues.get",
    requestedIssueId,
    context,
  );
  if (!observation.found || observation.record.resourceType !== "issue") {
    throw new ToolExecutionError(
      "linear_target_not_found",
      `Linear issue ${requestedIssueId} was not found for comment creation.`,
      { mutationState: "not_applied" },
    );
  }
  const issue = observation.record as LinearIssueRecord;
  input.issueId = issue.id;
  return issue;
}

async function assertCommentScopeUnchanged(
  client: LinearToolClient,
  action: PreparedAction,
  payload: PreparedLinearPayload,
  context: ToolExecutionContext,
): Promise<void> {
  const input = recordValue(payload.variables.input);
  const issueId = boundedString(input.issueId, "issueId", MAX_IDENTIFIER_CHARS);
  const observation = await readResource(
    client,
    "issues.get",
    issueId,
    context,
    true,
  );
  if (
    !observation.found ||
    observation.record.resourceType !== "issue" ||
    (observation.record as LinearIssueRecord).team.id !== action.target.teamId ||
    (observation.record as LinearIssueRecord).project?.id !== action.target.projectId
  ) {
    throw new ToolExecutionError(
      "linear_precondition_changed",
      "The comment target issue moved outside the prepared Linear team or project scope.",
      { mutationState: "not_applied" },
    );
  }
}

async function readResource(
  client: LinearToolClient,
  operationKey: string,
  id: string,
  context: ToolExecutionContext,
  requireExactId = false,
): Promise<LinearReadback> {
  try {
    const result = await client.execute(
      operationKey,
      { id },
      requestOptions(context),
    );
    if (!isLinearRecord(result)) {
      throw new ToolExecutionError(
        "linear_invalid_response",
        `Linear ${operationKey} did not return a normalized resource.`,
      );
    }
    if (requireExactId && result.id !== id) {
      throw new ToolExecutionError(
        "linear_invalid_response",
        `Linear ${operationKey} returned a different resource than ${id}.`,
      );
    }
    return { found: true, record: result };
  } catch (error) {
    if (error instanceof LinearClientError && error.code === "linear_not_found") {
      return { found: false };
    }
    throw error;
  }
}

function parsePreparedPayload(
  config: MutationToolConfig,
  action: PreparedAction,
): PreparedLinearPayload {
  const value = action.normalizedArgs;
  if (
    value.operationKey !== config.operationKey ||
    value.readbackOperationKey !== config.readbackOperationKey ||
    value.mutationKind !== config.kind ||
    typeof value.expectedAbsent !== "boolean" ||
    (value.preconditionHash !== null && typeof value.preconditionHash !== "string") ||
    !isJsonRecord(value.variables) ||
    !Array.isArray(value.changedFields) ||
    !value.changedFields.every((item) => typeof item === "string")
  ) {
    throw new ToolExecutionError(
      "invalid_prepared_action",
      "Prepared Linear action payload does not match its fixed tool.",
      { mutationState: "not_applied" },
    );
  }
  return {
    operationKey: config.operationKey,
    readbackOperationKey: config.readbackOperationKey,
    mutationKind: config.kind,
    variables: value.variables,
    preconditionHash: value.preconditionHash,
    expectedAbsent: value.expectedAbsent,
    changedFields: [...value.changedFields],
  };
}

function getMutationResourceId(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
): string {
  const candidate = isCreate(config.kind)
    ? recordValue(variables.input).id
    : variables.id;
  return boundedString(candidate, "resource id", MAX_IDENTIFIER_CHARS);
}

function targetResource(
  config: MutationToolConfig,
  id: string,
  variables: Record<string, JsonValue>,
  before: LinearReadback,
  scopeIssue?: LinearIssueRecord,
): ResourceRef {
  const input = isJsonRecord(variables.input) ? variables.input : {};
  const record = before.found ? before.record : undefined;
  return {
    system: "linear",
    resourceType: config.resourceType,
    id,
    ...(record?.identifier ? { identifier: record.identifier } : {}),
    ...(record?.url ? { url: record.url } : {}),
    ...(scopeIssue
      ? {
          teamId: scopeIssue.team.id,
          ...(scopeIssue.project?.id ? { projectId: scopeIssue.project.id } : {}),
        }
      : {}),
    ...(typeof input.teamId === "string" ? { teamId: input.teamId } : {}),
    ...(typeof input.projectId === "string" ? { projectId: input.projectId } : {}),
    ...(record?.resourceType === "issue"
      ? {
          teamId: (record as LinearIssueRecord).team.id,
          ...((record as LinearIssueRecord).project?.id
            ? { projectId: (record as LinearIssueRecord).project!.id }
            : {}),
        }
      : {}),
  };
}

function relatedResourcesFor(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
  scopeIssue?: LinearIssueRecord,
): ResourceRef[] {
  const input = isJsonRecord(variables.input) ? variables.input : {};
  const resources: ResourceRef[] = [];
  if (typeof input.teamId === "string") {
    resources.push({ system: "linear", resourceType: "team", id: input.teamId });
  }
  if (typeof input.projectId === "string") {
    resources.push({ system: "linear", resourceType: "project", id: input.projectId });
  }
  if (config.kind === "comment_create" && scopeIssue) {
    resources.push({
      system: "linear",
      resourceType: "issue",
      id: scopeIssue.id,
      identifier: scopeIssue.identifier,
      url: scopeIssue.url,
      teamId: scopeIssue.team.id,
      ...(scopeIssue.project?.id ? { projectId: scopeIssue.project.id } : {}),
    });
    if (scopeIssue.project?.id) {
      resources.push({
        system: "linear",
        resourceType: "project",
        id: scopeIssue.project.id,
        teamId: scopeIssue.team.id,
        projectId: scopeIssue.project.id,
      });
    }
  } else if (config.kind === "comment_create" && typeof input.issueId === "string") {
    resources.push({ system: "linear", resourceType: "issue", id: input.issueId });
  }
  if (typeof variables.labelId === "string") {
    resources.push({
      system: "linear",
      resourceType: config.resourceType === "project" ? "project_label" : "issue_label",
      id: variables.labelId,
    });
  }
  for (const [key, value] of Object.entries(input)) {
    if (
      key !== "id" &&
      key.endsWith("Id") &&
      typeof value === "string" &&
      !resources.some((resource) => resource.id === value)
    ) {
      resources.push({
        system: "linear",
        resourceType: key.slice(0, -2).replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`),
        id: value,
      });
    }
  }
  return resources.filter(
    (resource, index) =>
      resources.findIndex(
        (candidate) =>
          candidate.resourceType === resource.resourceType &&
          candidate.id === resource.id,
      ) === index,
  );
}

function mutationChangedFields(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
): string[] {
  if (expectsAbsence(config.kind)) return ["deleted"];
  if (config.kind === "issue_archive") return ["archivedAt"];
  if (config.kind === "issue_unarchive") return ["archivedAt", "trashed"];
  if (config.kind === "issue_trash") return ["trashed"];
  if (config.kind === "generic_archive" || config.kind === "generic_retire") {
    return ["archivedAt"];
  }
  if (config.kind === "generic_unarchive" || config.kind === "generic_restore") {
    return ["archivedAt", "trashed"];
  }
  if (config.kind === "generic_trash") return ["trashed"];
  if (config.kind === "generic_link" || config.kind === "generic_unlink") {
    return ["labels"];
  }
  return Object.keys(recordValue(variables.input))
    .filter((key) => key !== "id")
    .sort();
}

function previewAfter(
  config: MutationToolConfig,
  variables: Record<string, JsonValue>,
): Record<string, JsonValue> {
  if (expectsAbsence(config.kind)) return { absent: true };
  if (config.kind === "issue_archive") return { archived: true };
  if (config.kind === "issue_unarchive") return { archived: false, trashed: false };
  if (config.kind === "issue_trash") return { trashed: true };
  if (config.kind === "generic_archive" || config.kind === "generic_retire") {
    return { archived: true };
  }
  if (config.kind === "generic_unarchive" || config.kind === "generic_restore") {
    return { archived: false, trashed: false };
  }
  if (config.kind === "generic_trash") return { trashed: true };
  if (config.kind === "generic_link" || config.kind === "generic_unlink") {
    return {
      labelId: String(variables.labelId),
      linked: config.kind === "generic_link",
    };
  }
  return recordValue(variables.input);
}

function previewRecord(record: LinearBaseRecord): Record<string, JsonValue> {
  const output: Record<string, JsonValue> = {
    id: record.id,
    resourceType: record.resourceType,
    snapshotHash: record.snapshotHash,
  };
  for (const key of [
    "identifier", "url", "title", "name", "description", "body", "archivedAt",
  ] as const) {
    if (typeof record[key] === "string") output[key] = record[key] as string;
  }
  if (record.resourceType === "issue") {
    output.trashed = (record as LinearIssueRecord).trashed;
  }
  return output;
}

function receiptResource(
  target: ResourceRef,
  observation: LinearReadback,
): ResourceRef {
  if (!observation.found) return target;
  return {
    ...target,
    id: observation.record.id,
    ...(observation.record.identifier
      ? { identifier: observation.record.identifier }
      : {}),
    ...(observation.record.url ? { url: observation.record.url } : {}),
  };
}

function readDescriptor(config: ReadToolConfig): ToolDescriptor {
  const definition = getLinearOperationDefinition(config.operationKey)!;
  return {
    version: 1,
    name: config.name,
    capability: {
      system: "linear",
      resourceType: definition.resourceType,
      action: config.action,
    },
    effect: "read",
    risk: "low",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "none",
    },
    execution: { preparation: "none", cacheable: true, parallelSafe: true },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
    allowedPrincipals: ["single_agent", "lead", "researcher"],
  };
}

function mutationDescriptor(config: MutationToolConfig): ToolDescriptor {
  const destructive = config.effect === "destructive_mutation";
  return {
    version: 1,
    name: config.name,
    capability: {
      system: "linear",
      resourceType: config.resourceType,
      action: config.action,
    },
    effect: config.effect,
    risk: config.risk,
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: !destructive,
      fallback: config.risk === "critical" ? "double_exact" : "exact",
    },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: destructive
      ? ["single_agent", "lead"]
      : ["single_agent", "lead", "researcher"],
    receiptKind: "external_action",
  };
}

function schemaForReadOperation(
  allowed: readonly string[],
  required: readonly string[] | undefined,
): JsonSchemaObject {
  const properties: Record<string, JsonSchemaObject> = {};
  for (const key of allowed) {
    properties[key] = key === "first"
      ? integerSchema("Maximum records to fetch (bounded to 50).", 1, 50)
      : key === "includeArchived"
        ? { type: "boolean" }
        : key === "filter"
          ? { type: "object", additionalProperties: true }
          : stringSchema(`Linear ${key} value.`);
  }
  return objectSchema(properties, required ? [...required] : []);
}

function requireMappedDefinition(
  toolName: string,
  operationKey: string,
  access: "read" | "write",
) {
  if (LINEAR_TOOL_OPERATION_MAP[toolName] !== operationKey) {
    throw new TypeError(`Linear tool ${toolName} has no exact fixed operation mapping.`);
  }
  const definition = getLinearOperationDefinition(operationKey);
  if (!definition || definition.access !== access) {
    throw new TypeError(`Linear operation ${operationKey} is not a fixed ${access} operation.`);
  }
  return definition;
}

function requireReadbackDefinition(config: MutationToolConfig): void {
  const definition = getLinearOperationDefinition(config.readbackOperationKey);
  if (
    !definition ||
    definition.access !== "read" ||
    definition.resultKind !== "resource" ||
    definition.resourceType !== config.resourceType
  ) {
    throw new TypeError(`Linear tool ${config.name} lacks safe fixed readback.`);
  }
}

function read(
  name: string,
  operationKey: string,
  gate: LinearCapabilityGate,
  action: ReadToolConfig["action"],
): ReadToolConfig {
  return { name, operationKey, gate, action };
}

function mutation(
  name: string,
  operationKey: string,
  readbackOperationKey: string,
  resourceType: MutationToolConfig["resourceType"],
  action: ResourceAction,
  kind: MutationKind,
  risk: ToolDescriptor["risk"],
  effect: ToolDescriptor["effect"],
  parameters: JsonSchemaObject,
): MutationToolConfig {
  const gate = getLinearOperationDefinition(operationKey)?.gate;
  if (gate === undefined) {
    throw new TypeError(`Unknown fixed Linear mutation ${operationKey}.`);
  }
  return {
    name,
    operationKey,
    readbackOperationKey,
    gate,
    resourceType,
    action,
    kind,
    risk,
    effect,
    parameters,
  };
}

function genericMutation(
  name: string,
  operationKey: string,
  readbackOperationKey: string,
  resourceType: LinearResourceType,
  action: ResourceAction,
  kind: Extract<
    MutationKind,
    | "generic_create"
    | "generic_update"
    | "generic_archive"
    | "generic_unarchive"
    | "generic_trash"
    | "generic_delete"
    | "generic_retire"
    | "generic_restore"
    | "generic_link"
    | "generic_unlink"
  >,
): MutationToolConfig {
  const definition = getLinearOperationDefinition(operationKey);
  if (!definition || definition.resourceType !== resourceType) {
    throw new TypeError(`Linear mutation ${operationKey} resource mismatch.`);
  }
  const destructive = definition?.destructive === true;
  const parameters = kind === "generic_create"
    ? GENERIC_CREATE_PARAMETERS
    : kind === "generic_update"
      ? GENERIC_UPDATE_PARAMETERS
      : kind === "generic_link" || kind === "generic_unlink"
        ? GENERIC_BINDING_PARAMETERS
        : ID_ONLY_PARAMETERS;
  return mutation(
    name,
    operationKey,
    readbackOperationKey,
    resourceType,
    action,
    kind,
    destructive ? (kind === "generic_delete" ? "critical" : "high") : "medium",
    destructive ? "destructive_mutation" : "reversible_mutation",
    parameters,
  );
}

function objectSchema(
  properties: Record<string, JsonSchemaObject>,
  required: string[] = [],
): JsonSchemaObject {
  return {
    type: "object",
    properties,
    ...(required.length ? { required } : {}),
    additionalProperties: false,
  };
}

function stringSchema(description: string): JsonSchemaObject {
  return { type: "string", description };
}

function nullableStringSchema(description: string): JsonSchemaObject {
  return { type: ["string", "null"], description };
}

function stringArraySchema(description: string): JsonSchemaObject {
  return { type: "array", description, items: { type: "string" } };
}

function integerSchema(
  description: string,
  minimum?: number,
  maximum?: number,
): JsonSchemaObject {
  return { type: "integer", description, minimum, maximum };
}

function numberSchema(description: string): JsonSchemaObject {
  return { type: "number", description };
}

function nullableNumberSchema(description: string): JsonSchemaObject {
  return { type: ["number", "null"], description };
}

function assertAllowedArgs(
  args: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(args).find((key) => !allowedSet.has(key));
  if (unknown) {
    throw new ToolExecutionError(
      "linear_invalid_arguments",
      `Argument ${unknown} is not allowed for this fixed Linear tool.`,
      { mutationState: "not_applied" },
    );
  }
}

function copyOptionalStringArg(
  source: Record<string, unknown>,
  target: Record<string, JsonValue>,
  key: string,
  maxChars: number,
  nullable: boolean,
): void {
  if (!(key in source) || source[key] === undefined) return;
  if (source[key] === null && nullable) {
    target[key] = null;
    return;
  }
  target[key] = boundedString(source[key], key, maxChars);
}

function copyOptionalLabelIds(
  source: Record<string, unknown>,
  target: Record<string, JsonValue>,
): void {
  if (source.labelIds === undefined) return;
  if (!Array.isArray(source.labelIds) || source.labelIds.length > 50) {
    throw invalidArguments("labelIds must be an array of at most 50 IDs.");
  }
  target.labelIds = source.labelIds.map((value, index) =>
    boundedString(value, `labelIds[${index}]`, MAX_IDENTIFIER_CHARS));
}

function copyOptionalInteger(
  source: Record<string, unknown>,
  target: Record<string, JsonValue>,
  key: string,
  minimum: number,
  maximum: number,
  nullable: boolean,
): void {
  if (source[key] === undefined) return;
  if (source[key] === null && nullable) {
    target[key] = null;
    return;
  }
  if (
    !Number.isInteger(source[key]) ||
    (source[key] as number) < minimum ||
    (source[key] as number) > maximum
  ) {
    throw invalidArguments(`${key} must be an integer from ${minimum} through ${maximum}.`);
  }
  target[key] = source[key] as number;
}

function copyOptionalFiniteNumber(
  source: Record<string, unknown>,
  target: Record<string, JsonValue>,
  key: string,
  nullable: boolean,
): void {
  if (source[key] === undefined) return;
  if (source[key] === null && nullable) {
    target[key] = null;
    return;
  }
  if (typeof source[key] !== "number" || !Number.isFinite(source[key])) {
    throw invalidArguments(`${key} must be a finite number${nullable ? " or null" : ""}.`);
  }
  target[key] = source[key] as number;
}

function boundedString(value: unknown, label: string, maxChars: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxChars) {
    throw invalidArguments(`${label} must be a non-empty string of at most ${maxChars} characters.`);
  }
  if (/[\0\r\n]/.test(value) && label.toLowerCase().includes("id")) {
    throw invalidArguments(`${label} contains unsafe control characters.`);
  }
  return value;
}

function requireUuid(value: unknown, label: string): string {
  const id = boundedString(value, label, 64);
  if (!UUID_PATTERN.test(id)) {
    throw invalidArguments(`${label} must be a UUID when supplied for creation.`);
  }
  return id.toLowerCase();
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 256 || /[\0\r\n]/.test(normalized)) {
    throw invalidArguments(`Linear ${label} is invalid.`);
  }
  return normalized;
}

function recordValue(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!isJsonRecord(value)) {
    throw invalidArguments("Prepared Linear mutation input must be an object.");
  }
  return value;
}

function cloneJsonObject(value: unknown, label: string): Record<string, JsonValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidArguments(`${label} must be a JSON object.`);
  }
  try {
    const canonical = canonicalJson(value);
    if (canonical.length > 100_000) {
      throw invalidArguments(`${label} exceeds the 100000-character bound.`);
    }
    return JSON.parse(canonical) as Record<string, JsonValue>;
  } catch (error) {
    if (error instanceof ToolExecutionError) throw error;
    throw invalidArguments(`${label} must contain bounded JSON values only.`);
  }
}

function isJsonRecord(value: unknown): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLinearRecord(value: LinearOperationResult): value is LinearBaseRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "resourceType" in value &&
    "snapshotHash" in value &&
    typeof (value as { snapshotHash?: unknown }).snapshotHash === "string"
  );
}

function isCreate(kind: MutationKind): boolean {
  return kind === "issue_create" ||
    kind === "comment_create" ||
    kind === "generic_create";
}

function expectsAbsence(kind: MutationKind): boolean {
  return kind === "issue_delete" ||
    kind === "comment_delete" ||
    kind === "generic_delete";
}

function isDefinitelyNotApplied(error: unknown): boolean {
  if (!(error instanceof LinearClientError)) return false;
  if (
    error.code === "linear_missing_api_key" ||
    error.code === "linear_invalid_arguments" ||
    error.code === "linear_unknown_operation" ||
    error.code === "linear_auth" ||
    error.code === "linear_forbidden" ||
    error.code === "linear_not_found" ||
    error.code === "linear_rate_limited" ||
    error.code === "linear_graphql"
  ) {
    return true;
  }
  return error.code === "linear_http" && (error.status ?? 500) < 500;
}

function requestOptions(context: ToolExecutionContext): LinearRequestOptions {
  return {
    ...(context.abortSignal ? { abortSignal: context.abortSignal } : {}),
    ...(context.deadlineAt !== undefined ? { deadlineAt: context.deadlineAt } : {}),
  };
}

function normalizeGate(value: LinearCapabilityGate): LinearCapabilityGate {
  if (!Number.isInteger(value) || value < 0 || value > 5) {
    throw new TypeError("Linear capability gate must be an integer from 0 through 5.");
  }
  return value;
}

function previewSummary(config: MutationToolConfig, target: ResourceRef): string {
  return `${config.action} Linear ${config.resourceType} ${target.identifier ?? target.id}`;
}

function previewDestination(config: MutationToolConfig, target: ResourceRef): string {
  if (target.teamId) return `Linear team ${target.teamId}`;
  return `Linear ${config.resourceType} ${target.identifier ?? target.id}`;
}

function receiptMessage(
  config: MutationToolConfig,
  target: ResourceRef,
  commitKind: ActionReceipt["commitKind"],
): string {
  const verb = commitKind === "reconciled" ? "Reconciled" : "Verified";
  return `${verb} ${config.action} for Linear ${config.resourceType} ${target.identifier ?? target.id}.`;
}

function now(context: ToolExecutionContext): Date {
  return context.now?.() ?? new Date();
}

function defaultRunId(): string {
  return `linear-run-${randomToken()}`;
}

let fallbackSequence = 0;
function randomToken(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) return randomUuid;
  fallbackSequence += 1;
  return `${Date.now().toString(36)}-${fallbackSequence.toString(36)}`;
}

async function deterministicUuid(value: string): Promise<string> {
  const hash = (await sha256Fingerprint(value)).slice("sha256:".length);
  const chars = hash.slice(0, 32).split("");
  // Linear accepts client-supplied idempotency IDs in the UUIDv4 shape used
  // by its native clients. The bits stay fingerprint-derived so a replay of
  // the same prepared operation targets the same provider identity.
  chars[12] = "4";
  chars[16] = ((parseInt(chars[16], 16) & 0x3) | 0x8).toString(16);
  const compact = chars.join("");
  return `${compact.slice(0, 8)}-${compact.slice(8, 12)}-${compact.slice(12, 16)}-${compact.slice(16, 20)}-${compact.slice(20)}`;
}

function invalidArguments(message: string): ToolExecutionError {
  return new ToolExecutionError("linear_invalid_arguments", message, {
    mutationState: "not_applied",
  });
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof LinearClientError && error.operationKey) {
    return `${error.message} (operation ${error.operationKey})`;
  }
  return error instanceof Error ? error.message : String(error);
}
