import type {
  LinearCapabilityGate,
  LinearOperationAccess,
  LinearOperationDefinition,
  LinearResourceType,
} from "./types";

const PAGE_INFO_SELECTION = `pageInfo {
  hasNextPage
  endCursor
}`;

const RESOURCE_SELECTIONS: Record<LinearResourceType, string> = {
  workspace: "id name",
  user: "id name url createdAt updatedAt archivedAt",
  team: "id name key description color createdAt updatedAt archivedAt",
  workflow_state:
    "id name type description color position createdAt updatedAt archivedAt team { id name key }",
  issue: `id identifier url title description priority estimate dueDate trashed
    createdAt updatedAt archivedAt completedAt canceledAt
    team { id name key }
    state { id name type }
    project { id name url }
    cycle { id name }
    projectMilestone { id name }
    assignee { id name url }
    parent { id identifier title url }
    labels(first: 50) { nodes { id name color } }`,
  comment: `id url body createdAt updatedAt archivedAt
    user { id name url }
    issue { id identifier title url }
    parent { id url }`,
  project:
    `id name url slugId description content priority startDate targetDate trashed
    createdAt updatedAt archivedAt completedAt canceledAt status { id name type }
    teams(first: 50) { nodes { id name key } }
    labels(first: 50) { nodes { id name color } }`,
  project_status:
    "id name type description color position createdAt updatedAt archivedAt",
  project_update:
    "id body health url createdAt updatedAt archivedAt project { id name url }",
  project_milestone:
    "id name description targetDate status createdAt updatedAt archivedAt project { id name url }",
  cycle:
    "id name description startsAt endsAt completedAt createdAt updatedAt archivedAt team { id name key }",
  initiative:
    "id name url slugId description content targetDate status health trashed createdAt updatedAt archivedAt completedAt owner { id name } parentInitiative { id name url }",
  initiative_update:
    "id body health url slugId createdAt updatedAt archivedAt initiative { id name url }",
  document:
    "id title content url slugId trashed createdAt updatedAt archivedAt project { id name url } initiative { id name url } issue { id identifier url }",
  issue_label:
    "id name description color isGroup createdAt updatedAt archivedAt team { id name key } parent { id name }",
  project_label: "id name description color isGroup createdAt updatedAt archivedAt parent { id name }",
  initiative_label:
    "id name description color isGroup createdAt updatedAt archivedAt parent { id name }",
  issue_relation:
    "id type createdAt updatedAt archivedAt issue { id identifier } relatedIssue { id identifier }",
  project_relation:
    "id type anchorType relatedAnchorType createdAt updatedAt archivedAt project { id name } relatedProject { id name } projectMilestone { id name } relatedProjectMilestone { id name }",
  initiative_relation:
    "id sortOrder createdAt updatedAt archivedAt initiative { id name } relatedInitiative { id name }",
  initiative_project_link:
    "id sortOrder createdAt updatedAt archivedAt initiative { id name } project { id name }",
  customer:
    "id name url slugId domains externalIds logoUrl mainSourceId revenue size createdAt updatedAt archivedAt owner { id name url } status { id name } tier { id name }",
  customer_request:
    "id url body content priority createdAt updatedAt archivedAt customer { id name url } issue { id identifier url } project { id name url }",
  customer_status:
    "id name description color position createdAt updatedAt archivedAt",
  customer_tier:
    "id name description color position createdAt updatedAt archivedAt",
};

const definitions: LinearOperationDefinition[] = [];

definitions.push({
  key: "connection.context",
  gate: 0,
  access: "read",
  operationName: "LinearConnectionContext",
  rootField: "viewer",
  resourceType: "workspace",
  resultKind: "context",
  document: `query LinearConnectionContext {
    viewer { id name }
    organization { id name }
  }`,
  variables: { allowed: [] },
});

addList("teams.list", 0, "teams", "team", "TeamFilter");
addList("users.list", 0, "users", "user", "UserFilter");
addList(
  "workflow_states.list",
  0,
  "workflowStates",
  "workflow_state",
  "WorkflowStateFilter",
);
addList("projects.list", 0, "projects", "project", "ProjectFilter");
addList(
  "project_statuses.list",
  0,
  "projectStatuses",
  "project_status",
);
addList(
  "issue_labels.list",
  0,
  "issueLabels",
  "issue_label",
  "IssueLabelFilter",
);
addList(
  "project_labels.list",
  0,
  "projectLabels",
  "project_label",
  "ProjectLabelFilter",
);
addList(
  "initiative_labels.list",
  0,
  "initiativeLabels",
  "initiative_label",
  "InitiativeLabelFilter",
);
addList(
  "customer_statuses.list",
  0,
  "customerStatuses",
  "customer_status",
);
addList(
  "customer_tiers.list",
  0,
  "customerTiers",
  "customer_tier",
);

addGet("issues.get", 1, "issue", "issue");
addList("issues.list", 1, "issues", "issue", "IssueFilter");
addIssueSearch();
addCreate("issues.create", 1, "issueCreate", "IssueCreateInput", "issue");
addUpdate("issues.update", 1, "issueUpdate", "IssueUpdateInput", "issue");
addIdMutation("issues.archive", 1, "issueArchive", "issue", {
  reversible: true,
  invocation: "issueArchive(id: $id, trash: false)",
});
addIdMutation("issues.unarchive", 1, "issueUnarchive", "issue", {
  reversible: true,
});
addIdMutation("issues.trash", 1, "issueDelete", "issue", {
  reversible: true,
  destructive: true,
  invocation: "issueDelete(id: $id, permanentlyDelete: false)",
});
addIdMutation("issues.delete_permanently", 1, "issueDelete", "issue", {
  destructive: true,
  invocation: "issueDelete(id: $id, permanentlyDelete: true)",
});
addGet("comments.get", 1, "comment", "comment");
addList("comments.list", 1, "comments", "comment", "CommentFilter");
addCreate(
  "comments.create",
  1,
  "commentCreate",
  "CommentCreateInput",
  "comment",
);
addUpdate(
  "comments.update",
  1,
  "commentUpdate",
  "CommentUpdateInput",
  "comment",
);
addIdMutation("comments.delete", 1, "commentDelete", "comment", {
  destructive: true,
});

addGet("projects.get", 2, "project", "project");
addCreate(
  "projects.create",
  2,
  "projectCreate",
  "ProjectCreateInput",
  "project",
);
addUpdate(
  "projects.update",
  2,
  "projectUpdate",
  "ProjectUpdateInput",
  "project",
);
addIdMutation("projects.archive", 2, "projectArchive", "project", {
  reversible: true,
  invocation: "projectArchive(id: $id, trash: false)",
});
addIdMutation("projects.trash", 2, "projectDelete", "project", {
  reversible: true,
  destructive: true,
});
addIdMutation("projects.unarchive", 2, "projectUnarchive", "project", {
  reversible: true,
});

addGet("project_updates.get", 2, "projectUpdate", "project_update");
addList(
  "project_updates.list",
  2,
  "projectUpdates",
  "project_update",
  "ProjectUpdateFilter",
);
addCreate(
  "project_updates.create",
  2,
  "projectUpdateCreate",
  "ProjectUpdateCreateInput",
  "project_update",
);
addUpdate(
  "project_updates.update",
  2,
  "projectUpdateUpdate",
  "ProjectUpdateUpdateInput",
  "project_update",
);
addIdMutation(
  "project_updates.archive",
  2,
  "projectUpdateArchive",
  "project_update",
  { reversible: true },
);
addIdMutation(
  "project_updates.unarchive",
  2,
  "projectUpdateUnarchive",
  "project_update",
  { reversible: true },
);
addIdMutation(
  "project_updates.delete",
  2,
  "projectUpdateDelete",
  "project_update",
  { destructive: true },
);

addGet(
  "project_milestones.get",
  2,
  "projectMilestone",
  "project_milestone",
);
addList(
  "project_milestones.list",
  2,
  "projectMilestones",
  "project_milestone",
  "ProjectMilestoneFilter",
);
addCreate(
  "project_milestones.create",
  2,
  "projectMilestoneCreate",
  "ProjectMilestoneCreateInput",
  "project_milestone",
);
addUpdate(
  "project_milestones.update",
  2,
  "projectMilestoneUpdate",
  "ProjectMilestoneUpdateInput",
  "project_milestone",
);
addIdMutation(
  "project_milestones.delete",
  2,
  "projectMilestoneDelete",
  "project_milestone",
  { destructive: true },
);

addGet("cycles.get", 2, "cycle", "cycle");
addList("cycles.list", 2, "cycles", "cycle", "CycleFilter");
addCreate("cycles.create", 2, "cycleCreate", "CycleCreateInput", "cycle");
addUpdate("cycles.update", 2, "cycleUpdate", "CycleUpdateInput", "cycle");
addIdMutation("cycles.archive", 2, "cycleArchive", "cycle", {
  destructive: true,
});

addGet("initiatives.get", 3, "initiative", "initiative");
addList(
  "initiatives.list",
  3,
  "initiatives",
  "initiative",
  "InitiativeFilter",
);
addCreate(
  "initiatives.create",
  3,
  "initiativeCreate",
  "InitiativeCreateInput",
  "initiative",
);
addUpdate(
  "initiatives.update",
  3,
  "initiativeUpdate",
  "InitiativeUpdateInput",
  "initiative",
);
addIdMutation("initiatives.archive", 3, "initiativeArchive", "initiative", {
  reversible: true,
});
addIdMutation(
  "initiatives.unarchive",
  3,
  "initiativeUnarchive",
  "initiative",
  { reversible: true },
);
addIdMutation("initiatives.trash", 3, "initiativeDelete", "initiative", {
  reversible: true,
  destructive: true,
});

addGet(
  "initiative_updates.get",
  3,
  "initiativeUpdate",
  "initiative_update",
);
addList(
  "initiative_updates.list",
  3,
  "initiativeUpdates",
  "initiative_update",
  "InitiativeUpdateFilter",
);
addCreate(
  "initiative_updates.create",
  3,
  "initiativeUpdateCreate",
  "InitiativeUpdateCreateInput",
  "initiative_update",
);
addUpdate(
  "initiative_updates.update",
  3,
  "initiativeUpdateUpdate",
  "InitiativeUpdateUpdateInput",
  "initiative_update",
);
addIdMutation(
  "initiative_updates.archive",
  3,
  "initiativeUpdateArchive",
  "initiative_update",
  { reversible: true },
);
addIdMutation(
  "initiative_updates.unarchive",
  3,
  "initiativeUpdateUnarchive",
  "initiative_update",
  { reversible: true },
);

addGet("documents.get", 3, "document", "document");
addList("documents.list", 3, "documents", "document", "DocumentFilter");
addCreate(
  "documents.create",
  3,
  "documentCreate",
  "DocumentCreateInput",
  "document",
);
addUpdate(
  "documents.update",
  3,
  "documentUpdate",
  "DocumentUpdateInput",
  "document",
);
addIdMutation("documents.trash", 3, "documentDelete", "document", {
  reversible: true,
  destructive: true,
});
addIdMutation("documents.unarchive", 3, "documentUnarchive", "document", {
  reversible: true,
});

addLabelFamily("issue_labels", "issueLabel", "IssueLabel", "issue_label");
addLabelFamily(
  "project_labels",
  "projectLabel",
  "ProjectLabel",
  "project_label",
);
addLabelFamily(
  "initiative_labels",
  "initiativeLabel",
  "InitiativeLabel",
  "initiative_label",
);
addLabelBinding("issues", "issue", "issue");
addLabelBinding("projects", "project", "project");

addRelationFamily(
  "issue_relations",
  "issueRelation",
  "IssueRelation",
  "issue_relation",
);
addRelationFamily(
  "project_relations",
  "projectRelation",
  "ProjectRelation",
  "project_relation",
);
addRelationFamily(
  "initiative_relations",
  "initiativeRelation",
  "InitiativeRelation",
  "initiative_relation",
);
addList(
  "initiative_project_links.list",
  4,
  "initiativeToProjects",
  "initiative_project_link",
);
addGet(
  "initiative_project_links.get",
  4,
  "initiativeToProject",
  "initiative_project_link",
);
addCreate(
  "initiative_project_links.create",
  4,
  "initiativeToProjectCreate",
  "InitiativeToProjectCreateInput",
  "initiative_project_link",
);
addUpdate(
  "initiative_project_links.update",
  4,
  "initiativeToProjectUpdate",
  "InitiativeToProjectUpdateInput",
  "initiative_project_link",
);
addIdMutation(
  "initiative_project_links.delete",
  4,
  "initiativeToProjectDelete",
  "initiative_project_link",
  { destructive: true },
);

addGet("customers.get", 5, "customer", "customer");
addList("customers.list", 5, "customers", "customer", "CustomerFilter");
addCreate(
  "customers.create",
  5,
  "customerCreate",
  "CustomerCreateInput",
  "customer",
);
addUpdate(
  "customers.update",
  5,
  "customerUpdate",
  "CustomerUpdateInput",
  "customer",
);
addIdMutation("customers.delete", 5, "customerDelete", "customer", {
  destructive: true,
});
addGet(
  "customer_requests.get",
  5,
  "customerNeed",
  "customer_request",
);
addList(
  "customer_requests.list",
  5,
  "customerNeeds",
  "customer_request",
  "CustomerNeedFilter",
);
addCreate(
  "customer_requests.create",
  5,
  "customerNeedCreate",
  "CustomerNeedCreateInput",
  "customer_request",
);
addUpdate(
  "customer_requests.update",
  5,
  "customerNeedUpdate",
  "CustomerNeedUpdateInput",
  "customer_request",
);
addIdMutation(
  "customer_requests.archive",
  5,
  "customerNeedArchive",
  "customer_request",
  { reversible: true },
);
addIdMutation(
  "customer_requests.unarchive",
  5,
  "customerNeedUnarchive",
  "customer_request",
  { reversible: true },
);
addIdMutation(
  "customer_requests.delete",
  5,
  "customerNeedDelete",
  "customer_request",
  { destructive: true },
);

export const LINEAR_OPERATION_CATALOG: Readonly<
  Record<string, LinearOperationDefinition>
> = Object.freeze(
  Object.fromEntries(
    definitions.map((definition) => [definition.key, Object.freeze(definition)]),
  ),
);

export type LinearOperationKey = keyof typeof LINEAR_OPERATION_CATALOG;

export function getLinearOperationDefinition(
  key: string,
): LinearOperationDefinition | undefined {
  return LINEAR_OPERATION_CATALOG[key];
}

export function listLinearOperationDefinitions(options: {
  maxGate?: LinearCapabilityGate;
  access?: LinearOperationAccess;
} = {}): LinearOperationDefinition[] {
  const maxGate = options.maxGate ?? 5;
  return Object.values(LINEAR_OPERATION_CATALOG).filter(
    (definition) =>
      definition.gate <= maxGate &&
      (options.access === undefined || definition.access === options.access),
  );
}

function addGet(
  key: string,
  gate: LinearCapabilityGate,
  rootField: string,
  resourceType: LinearResourceType,
) {
  const operationName = operationNameFor(key);
  definitions.push({
    key,
    gate,
    access: "read",
    operationName,
    rootField,
    resourceType,
    resultKind: "resource",
    document: `query ${operationName}($id: String!) {
      ${rootField}(id: $id) { ${RESOURCE_SELECTIONS[resourceType]} }
    }`,
    variables: { allowed: ["id"], required: ["id"] },
  });
}

function addList(
  key: string,
  gate: LinearCapabilityGate,
  rootField: string,
  resourceType: LinearResourceType,
  filterType?: string,
) {
  const operationName = operationNameFor(key);
  const filterDeclaration = filterType ? `, $filter: ${filterType}` : "";
  const filterArgument = filterType ? ", filter: $filter" : "";
  definitions.push({
    key,
    gate,
    access: "read",
    operationName,
    rootField,
    resourceType,
    resultKind: "connection",
    document: `query ${operationName}(
      $first: Int!
      $after: String
      $includeArchived: Boolean!${filterDeclaration}
    ) {
      ${rootField}(
        first: $first
        after: $after
        includeArchived: $includeArchived${filterArgument}
      ) {
        nodes { ${RESOURCE_SELECTIONS[resourceType]} }
        ${PAGE_INFO_SELECTION}
      }
    }`,
    variables: {
      allowed: filterType
        ? ["first", "after", "includeArchived", "filter"]
        : ["first", "after", "includeArchived"],
      paginated: true,
    },
  });
}

function addIssueSearch() {
  const key = "issues.search";
  const operationName = operationNameFor(key);
  definitions.push({
    key,
    gate: 1,
    access: "read",
    operationName,
    rootField: "issues",
    resourceType: "issue",
    resultKind: "connection",
    document: `query ${operationName}(
      $filter: IssueFilter
      $first: Int!
      $after: String
      $includeArchived: Boolean!
    ) {
      issues(
        filter: $filter
        first: $first
        after: $after
        includeArchived: $includeArchived
      ) {
        nodes { ${RESOURCE_SELECTIONS.issue} }
        ${PAGE_INFO_SELECTION}
      }
    }`,
    variables: {
      allowed: ["query", "filter", "first", "after", "includeArchived"],
      required: ["query"],
      paginated: true,
    },
  });
}

function addCreate(
  key: string,
  gate: LinearCapabilityGate,
  rootField: string,
  inputType: string,
  resourceType: LinearResourceType,
) {
  const operationName = operationNameFor(key);
  definitions.push({
    key,
    gate,
    access: "write",
    operationName,
    rootField,
    resourceType,
    resultKind: "mutation",
    document: `mutation ${operationName}($input: ${inputType}!) {
      ${rootField}(input: $input) { success }
    }`,
    variables: { allowed: ["input"], required: ["input"] },
  });
}

function addUpdate(
  key: string,
  gate: LinearCapabilityGate,
  rootField: string,
  inputType: string,
  resourceType: LinearResourceType,
) {
  const operationName = operationNameFor(key);
  definitions.push({
    key,
    gate,
    access: "write",
    operationName,
    rootField,
    resourceType,
    resultKind: "mutation",
    document: `mutation ${operationName}($id: String!, $input: ${inputType}!) {
      ${rootField}(id: $id, input: $input) { success }
    }`,
    variables: { allowed: ["id", "input"], required: ["id", "input"] },
  });
}

function addIdMutation(
  key: string,
  gate: LinearCapabilityGate,
  rootField: string,
  resourceType: LinearResourceType,
  options: {
    destructive?: boolean;
    reversible?: boolean;
    invocation?: string;
  } = {},
) {
  const operationName = operationNameFor(key);
  definitions.push({
    key,
    gate,
    access: "write",
    operationName,
    rootField,
    resourceType,
    resultKind: "mutation",
    document: `mutation ${operationName}($id: String!) {
      ${options.invocation ?? `${rootField}(id: $id)`} { success }
    }`,
    variables: { allowed: ["id"], required: ["id"] },
    destructive: options.destructive,
    reversible: options.reversible,
  });
}

function addLabelFamily(
  keyPrefix: string,
  graphQlPrefix: string,
  inputPrefix: string,
  resourceType: LinearResourceType,
) {
  addGet(`${keyPrefix}.get`, 4, graphQlPrefix, resourceType);
  addCreate(
    `${keyPrefix}.create`,
    4,
    `${graphQlPrefix}Create`,
    `${inputPrefix}CreateInput`,
    resourceType,
  );
  addUpdate(
    `${keyPrefix}.update`,
    4,
    `${graphQlPrefix}Update`,
    `${inputPrefix}UpdateInput`,
    resourceType,
  );
  addIdMutation(`${keyPrefix}.retire`, 4, `${graphQlPrefix}Retire`, resourceType, {
    reversible: true,
  });
  addIdMutation(`${keyPrefix}.restore`, 4, `${graphQlPrefix}Restore`, resourceType, {
    reversible: true,
  });
  addIdMutation(`${keyPrefix}.delete`, 4, `${graphQlPrefix}Delete`, resourceType, {
    destructive: true,
  });
}

function addLabelBinding(
  keyPrefix: string,
  graphQlPrefix: string,
  resourceType: LinearResourceType,
) {
  for (const verb of ["add", "remove"] as const) {
    const key = `${keyPrefix}.${verb}_label`;
    const rootField = `${graphQlPrefix}${verb === "add" ? "Add" : "Remove"}Label`;
    const operationName = operationNameFor(key);
    definitions.push({
      key,
      gate: 4,
      access: "write",
      operationName,
      rootField,
      resourceType,
      resultKind: "mutation",
      document: `mutation ${operationName}($id: String!, $labelId: String!) {
        ${rootField}(id: $id, labelId: $labelId) { success }
      }`,
      variables: {
        allowed: ["id", "labelId"],
        required: ["id", "labelId"],
      },
    });
  }
}

function addRelationFamily(
  keyPrefix: string,
  graphQlPrefix: string,
  inputPrefix: string,
  resourceType: LinearResourceType,
) {
  addGet(`${keyPrefix}.get`, 4, graphQlPrefix, resourceType);
  addList(`${keyPrefix}.list`, 4, `${graphQlPrefix}s`, resourceType);
  addCreate(
    `${keyPrefix}.create`,
    4,
    `${graphQlPrefix}Create`,
    `${inputPrefix}CreateInput`,
    resourceType,
  );
  addUpdate(
    `${keyPrefix}.update`,
    4,
    `${graphQlPrefix}Update`,
    `${inputPrefix}UpdateInput`,
    resourceType,
  );
  addIdMutation(`${keyPrefix}.delete`, 4, `${graphQlPrefix}Delete`, resourceType, {
    destructive: true,
  });
}

function operationNameFor(key: string): string {
  return `Linear${key
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("")}`;
}
