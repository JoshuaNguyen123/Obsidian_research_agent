import {
  getProjectLineageFingerprintHistoryV1,
  parseProjectLineageV1,
  parseResearchProjectPlanV1,
  type LinearHierarchyWorkUnitBindingV1,
  type ProjectLineageV1,
  type ResearchProjectIssueV1,
  type ResearchProjectPlanV1,
} from "./projectLifecycle";
import {
  createProjectStageEventV1,
  type ProjectStageEventV1,
} from "./projectRunReport";
import {
  assertCanonicalContract,
  assertExactKeys,
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
} from "../integrations/linear/LinearContractSupport";
import {
  createWorkItemSpecV2,
  parseWorkItemSpecV2,
  type WorkItemSpecV2,
} from "../integrations/linear/WorkItemSpecV2";
import type { WorkItemRiskClass } from "../integrations/linear/WorkItemSpecV1";

export const PROJECT_WORK_UNIT_EXECUTION_BINDING_SCHEMA_VERSION = 1 as const;

/**
 * Immutable host authority for executing exactly one child of a published
 * research project. The hierarchy fingerprint and the executable WorkItemSpec
 * fingerprint are deliberately separate contracts.
 */
export interface ProjectWorkUnitExecutionBindingV1 {
  schemaVersion: typeof PROJECT_WORK_UNIT_EXECUTION_BINDING_SCHEMA_VERSION;
  kind: "project_work_unit_execution_binding";
  projectRunId: string;
  projectLineageId: string;
  projectLineageFingerprint: string;
  researchProjectPlanFingerprint: string;
  acceptedResearchArtifactFingerprint: string;
  workUnitId: string;
  hierarchyWorkItemFingerprint: string;
  linearIssueId: string;
  linearIssueIdentifier: string;
  linearIssueUrl: string;
  acceptanceCriterionIds: string[];
  providerReadbackFingerprint: string;
  workItemSpec: WorkItemSpecV2;
  workItemSpecFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  validationRequirementKeys: string[];
  fingerprint: string;
}

export type ProjectWorkUnitExecutionBindingUnsignedV1 = Omit<
  ProjectWorkUnitExecutionBindingV1,
  "fingerprint"
>;

export interface ProjectWorkUnitExecutionBindingInputV1 {
  projectLineage: unknown;
  researchProjectPlan: unknown;
  workUnitId: string;
  /** Host-resolved logical RepositoryProfileV2 key. */
  repositoryProfileKey: string;
  /** SHA-256 of the exact trusted RepositoryProfileV2 read by the host. */
  repositoryProfileFingerprint: string;
  /** Host-approved validator profile keys, never commands from issue prose. */
  validationRequirementKeys: readonly string[];
  /** Deterministic code default is medium when host policy does not override it. */
  riskClass?: WorkItemRiskClass;
}

export interface ProjectWorkUnitEventScopeV1 {
  executionBindingFingerprint: string;
  projectRunId: string;
  projectLineageFingerprint: string;
  workUnitId: string;
  workItemSpecFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
}

interface ProjectWorkUnitEventBaseV1 {
  binding: unknown;
  scope: ProjectWorkUnitEventScopeV1;
  occurredAt: string;
  sourceReceiptId: string;
  evidenceFingerprint: string;
}

export interface ProjectWorkUnitImplementationEventInputV1
  extends ProjectWorkUnitEventBaseV1 {
  workspaceId: string;
  path: string | null;
  observedRevision: string;
}

export interface ProjectWorkUnitValidationEventInputV1
  extends ProjectWorkUnitEventBaseV1 {
  validationRequirementKey: string;
  validationScope: "targeted" | "full";
  workspaceId: string;
  observedRevision: string;
}

export interface ProjectWorkUnitCommitEventInputV1
  extends ProjectWorkUnitEventBaseV1 {
  commitSha: string;
}

export interface ProjectWorkUnitAcceptanceEventInputV1
  extends ProjectWorkUnitEventBaseV1 {
  validationRequirementKey: string;
  acceptanceCriterionId: string;
  acceptanceCriterionText: string;
  commitSha: string;
}

export interface ProjectWorkUnitDraftPullRequestEventInputV1
  extends ProjectWorkUnitEventBaseV1 {
  owner: string;
  repository: string;
  pullRequestNumber: number;
  draft: true;
  verifiedCommitSha: string;
  remoteSha: string;
}

interface ResolvedHierarchyChildV1 {
  lineage: ProjectLineageV1;
  plan: ResearchProjectPlanV1;
  issue: ResearchProjectIssueV1;
  workUnit: LinearHierarchyWorkUnitBindingV1;
  projectLineageFingerprint: string;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  validationRequirementKeys: string[];
  riskClass: WorkItemRiskClass;
}

/**
 * Mint an executable binding only from a parsed plan and its provider-read
 * Linear hierarchy commit. No model-authored repository path or command is
 * promoted into authority.
 */
export function createProjectWorkUnitExecutionBindingV1(
  input: ProjectWorkUnitExecutionBindingInputV1,
): ProjectWorkUnitExecutionBindingV1 {
  const resolved = resolveHierarchyChild(input);
  const workItemSpec = buildWorkItemSpec(resolved);
  const unsigned = parseProjectWorkUnitExecutionBindingUnsignedV1({
    schemaVersion: PROJECT_WORK_UNIT_EXECUTION_BINDING_SCHEMA_VERSION,
    kind: "project_work_unit_execution_binding",
    projectRunId: resolved.lineage.runId,
    projectLineageId: resolved.lineage.lineageId,
    projectLineageFingerprint: resolved.projectLineageFingerprint,
    researchProjectPlanFingerprint: resolved.plan.fingerprint,
    acceptedResearchArtifactFingerprint:
      resolved.plan.acceptedResearchArtifactFingerprint,
    workUnitId: resolved.workUnit.workUnitId,
    hierarchyWorkItemFingerprint: resolved.issue.workItemFingerprint,
    linearIssueId: resolved.workUnit.linearIssueId,
    linearIssueIdentifier: resolved.workUnit.linearIssueIdentifier,
    linearIssueUrl: resolved.workUnit.linearIssueUrl,
    acceptanceCriterionIds: [...resolved.workUnit.acceptanceCriterionIds],
    providerReadbackFingerprint:
      resolved.workUnit.providerReadbackFingerprint,
    workItemSpec,
    workItemSpecFingerprint: workItemSpec.fingerprint,
    repositoryProfileKey: resolved.repositoryProfileKey,
    repositoryProfileFingerprint: resolved.repositoryProfileFingerprint,
    validationRequirementKeys: [...resolved.validationRequirementKeys],
  });
  return {
    ...unsigned,
    fingerprint: fingerprintContract(unsigned),
  };
}

/** Build only the independently signed WorkItemSpecV2 for one hierarchy child. */
export function deriveProjectWorkItemSpecV2FromHierarchyChildV1(
  input: ProjectWorkUnitExecutionBindingInputV1,
): WorkItemSpecV2 {
  return buildWorkItemSpec(resolveHierarchyChild(input));
}

export function parseProjectWorkUnitExecutionBindingV1(
  value: unknown,
): ProjectWorkUnitExecutionBindingV1 {
  const record = expectPlainRecord(value, "project work-unit execution binding");
  assertBindingKeys(record, true);
  const { fingerprint: rawFingerprint, ...rawUnsigned } = record;
  const unsigned = parseProjectWorkUnitExecutionBindingUnsignedV1(rawUnsigned);
  assertCanonicalContract(
    rawUnsigned,
    unsigned,
    "Project work-unit execution binding",
  );
  const fingerprint = expectSha256(
    rawFingerprint,
    "project work-unit execution binding fingerprint",
  );
  const expected = fingerprintContract(unsigned);
  if (!constantTimeFingerprintEqual(fingerprint, expected)) {
    throw new DurableLinearContractError(
      "Project work-unit execution binding fingerprint does not match its canonical payload.",
    );
  }
  return { ...unsigned, fingerprint };
}

export function fingerprintProjectWorkUnitExecutionBindingV1(
  value:
    | ProjectWorkUnitExecutionBindingUnsignedV1
    | ProjectWorkUnitExecutionBindingV1,
): string {
  const record = expectPlainRecord(
    value,
    "project work-unit execution binding fingerprint input",
  );
  const { fingerprint: _ignored, ...rawUnsigned } = record;
  return fingerprintContract(
    parseProjectWorkUnitExecutionBindingUnsignedV1(rawUnsigned),
  );
}

/**
 * Re-read current durable inputs before execution. A later lineage is allowed
 * only when the bound hierarchy fingerprint is one of its verified prefixes.
 */
export function assertProjectWorkUnitExecutionBindingCurrentV1(input: {
  binding: unknown;
  projectLineage: unknown;
  researchProjectPlan: unknown;
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  validationRequirementKeys: readonly string[];
}): ProjectWorkUnitExecutionBindingV1 {
  const binding = parseProjectWorkUnitExecutionBindingV1(input.binding);
  const current = createProjectWorkUnitExecutionBindingV1({
    projectLineage: input.projectLineage,
    researchProjectPlan: input.researchProjectPlan,
    workUnitId: binding.workUnitId,
    repositoryProfileKey: input.repositoryProfileKey,
    repositoryProfileFingerprint: input.repositoryProfileFingerprint,
    validationRequirementKeys: input.validationRequirementKeys,
    riskClass: binding.workItemSpec.riskClass,
  });
  if (!constantTimeFingerprintEqual(binding.fingerprint, current.fingerprint)) {
    throw new DurableLinearContractError(
      "Project work-unit execution binding no longer matches current lineage, Linear readback, repository profile, or validation policy.",
    );
  }
  return binding;
}

export function createProjectWorkUnitEventScopeV1(
  value: unknown,
): ProjectWorkUnitEventScopeV1 {
  const binding = parseProjectWorkUnitExecutionBindingV1(value);
  return {
    executionBindingFingerprint: binding.fingerprint,
    projectRunId: binding.projectRunId,
    projectLineageFingerprint: binding.projectLineageFingerprint,
    workUnitId: binding.workUnitId,
    workItemSpecFingerprint: binding.workItemSpecFingerprint,
    repositoryProfileKey: binding.repositoryProfileKey,
    repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
  };
}

export function createProjectWorkUnitImplementationEventV1(
  input: ProjectWorkUnitImplementationEventInputV1,
): ProjectStageEventV1 {
  const binding = bindingForEvent(input.binding, input.scope);
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: binding.projectRunId,
    phase: "implement",
    evidenceKind: "workspace_mutation",
    disposition: "verified",
    occurredAt: input.occurredAt,
    sourceReceiptId: input.sourceReceiptId,
    evidenceFingerprint: input.evidenceFingerprint,
    resource: {
      system: "workspace",
      resourceType: "workspace_mutation",
      id: expectOpaqueId(input.workspaceId, "implementation workspace id"),
      url: null,
      path: input.path,
      revision: expectSha256(
        input.observedRevision,
        "implementation observed revision",
      ),
    },
    workUnits: eventWorkUnit(binding),
  });
}

export function createProjectWorkUnitValidationEventV1(
  input: ProjectWorkUnitValidationEventInputV1,
): ProjectStageEventV1 {
  const binding = bindingForEvent(input.binding, input.scope);
  const validationRequirementKey = expectLogicalKey(
    input.validationRequirementKey,
    "validation requirement key",
  );
  if (!binding.validationRequirementKeys.includes(validationRequirementKey)) {
    throw new DurableLinearContractError(
      "Validation evidence does not use a key approved by this work-unit binding.",
    );
  }
  const validationScope = expectEnum(
    input.validationScope,
    "validation scope",
    ["targeted", "full"] as const,
  );
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: binding.projectRunId,
    phase: "test",
    evidenceKind:
      validationScope === "targeted"
        ? "targeted_validation"
        : "full_validation",
    disposition: "verified",
    occurredAt: input.occurredAt,
    sourceReceiptId: input.sourceReceiptId,
    evidenceFingerprint: input.evidenceFingerprint,
    resource: {
      system: "workspace",
      resourceType: `${validationScope}_validation`,
      id: expectOpaqueId(input.workspaceId, "validation workspace id"),
      url: null,
      path: null,
      revision: expectSha256(
        input.observedRevision,
        "validation observed revision",
      ),
    },
    workUnits: eventWorkUnit(binding),
  });
}

export function createProjectWorkUnitCommitEventV1(
  input: ProjectWorkUnitCommitEventInputV1,
): ProjectStageEventV1 {
  const binding = bindingForEvent(input.binding, input.scope);
  const commitSha = gitSha(input.commitSha, "verified commit SHA");
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: binding.projectRunId,
    phase: "test",
    evidenceKind: "commit_readback",
    disposition: "verified",
    occurredAt: input.occurredAt,
    sourceReceiptId: input.sourceReceiptId,
    evidenceFingerprint: input.evidenceFingerprint,
    resource: {
      system: "git",
      resourceType: "commit",
      id: commitSha,
      url: null,
      path: null,
      revision: commitSha,
    },
    workUnits: eventWorkUnit(binding),
  });
}

export function createProjectWorkUnitAcceptanceEventV1(
  input: ProjectWorkUnitAcceptanceEventInputV1,
): ProjectStageEventV1 {
  const binding = bindingForEvent(input.binding, input.scope);
  const validationRequirementKey = expectLogicalKey(
    input.validationRequirementKey,
    "acceptance validation requirement key",
  );
  if (!binding.validationRequirementKeys.includes(validationRequirementKey)) {
    throw new DurableLinearContractError(
      "Acceptance evidence does not use a key approved by this work-unit binding.",
    );
  }
  const criterionIndex = binding.acceptanceCriterionIds.indexOf(
    input.acceptanceCriterionId,
  );
  if (criterionIndex < 0) {
    throw new DurableLinearContractError(
      "Acceptance evidence names a criterion outside this work unit.",
    );
  }
  const criterion = binding.workItemSpec.acceptanceCriteria[criterionIndex];
  if (!criterion || criterion.text !== input.acceptanceCriterionText) {
    throw new DurableLinearContractError(
      "Acceptance evidence text does not exactly match the bound hierarchy child.",
    );
  }
  const commitSha = gitSha(input.commitSha, "acceptance commit SHA");
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: binding.projectRunId,
    phase: "test",
    evidenceKind: "acceptance_criterion",
    disposition: "verified",
    occurredAt: input.occurredAt,
    sourceReceiptId: input.sourceReceiptId,
    evidenceFingerprint: input.evidenceFingerprint,
    resource: {
      system: "git",
      resourceType: "acceptance_criterion",
      id: input.acceptanceCriterionId,
      url: null,
      path: null,
      revision: commitSha,
    },
    workUnits: eventWorkUnit(binding, [input.acceptanceCriterionId]),
  });
}

export function createProjectWorkUnitDraftPullRequestEventV1(
  input: ProjectWorkUnitDraftPullRequestEventInputV1,
): ProjectStageEventV1 {
  const binding = bindingForEvent(input.binding, input.scope);
  if (input.draft !== true) {
    throw new DurableLinearContractError(
      "Project work-unit publication evidence requires a draft pull request.",
    );
  }
  const verifiedCommitSha = gitSha(
    input.verifiedCommitSha,
    "verified local commit SHA",
  );
  const remoteSha = gitSha(input.remoteSha, "draft pull request remote SHA");
  if (remoteSha !== verifiedCommitSha) {
    throw new DurableLinearContractError(
      "Draft pull request remote SHA must equal the verified local commit SHA.",
    );
  }
  const owner = githubName(input.owner, "GitHub owner");
  const repository = githubName(input.repository, "GitHub repository");
  const pullRequestNumber = expectInteger(
    input.pullRequestNumber,
    "GitHub pull request number",
    1,
    2_147_483_647,
  );
  const repositoryUrl = `https://github.com/${owner}/${repository}`;
  return createProjectStageEventV1({
    schemaVersion: 1,
    runId: binding.projectRunId,
    phase: "github",
    evidenceKind: "github_draft_pr_readback",
    disposition: "verified",
    occurredAt: input.occurredAt,
    sourceReceiptId: input.sourceReceiptId,
    evidenceFingerprint: input.evidenceFingerprint,
    resource: {
      system: "github",
      resourceType: "draft_pull_request",
      id: `${owner}/${repository}#${pullRequestNumber}`,
      url: `${repositoryUrl}/pull/${pullRequestNumber}`,
      path: null,
      revision: remoteSha,
    },
    workUnits: eventWorkUnit(binding),
  });
}

function resolveHierarchyChild(
  input: ProjectWorkUnitExecutionBindingInputV1,
): ResolvedHierarchyChildV1 {
  const lineage = parseProjectLineageV1(input.projectLineage);
  const plan = parseResearchProjectPlanV1(input.researchProjectPlan);
  const workUnitId = expectLogicalKey(input.workUnitId, "project work-unit id", 100);
  if (lineage.runId !== plan.runId) {
    throw new DurableLinearContractError(
      "Research project plan belongs to a different project run.",
    );
  }
  const acceptedCommit = lineage.commits[0];
  if (
    acceptedCommit?.proof.stage !== "accepted_research" ||
    acceptedCommit.proof.artifactFingerprint !==
      plan.acceptedResearchArtifactFingerprint
  ) {
    throw new DurableLinearContractError(
      "Research project plan is not bound to the lineage's accepted artifact.",
    );
  }
  const linearCommitIndex = lineage.commits.findIndex(
    (commit) => commit.proof.stage === "linear_hierarchy",
  );
  const linearCommit = lineage.commits[linearCommitIndex];
  if (!linearCommit || linearCommit.proof.stage !== "linear_hierarchy") {
    throw new DurableLinearContractError(
      "Project work-unit execution requires a verified Linear hierarchy commit.",
    );
  }
  const linearProof = linearCommit.proof;
  if (
    linearProof.planFingerprint !== plan.fingerprint ||
    linearProof.workspaceId !== plan.destination.workspaceId ||
    linearProof.teamId !== plan.destination.teamId
  ) {
    throw new DurableLinearContractError(
      "Linear hierarchy readback does not match the signed research project plan.",
    );
  }
  if (!linearProof.workUnits) {
    throw new DurableLinearContractError(
      "Linear hierarchy lacks exact provider-read child work-unit bindings.",
    );
  }
  const issueIndex = plan.issues.findIndex((issue) => issue.key === workUnitId);
  const workUnitIndex = linearProof.workUnits.findIndex(
    (unit) => unit.workUnitId === workUnitId,
  );
  const issue = plan.issues[issueIndex];
  const workUnit = linearProof.workUnits[workUnitIndex];
  if (!issue || !workUnit || issueIndex !== workUnitIndex) {
    throw new DurableLinearContractError(
      "Project plan child and Linear work-unit readback must align in exact order.",
    );
  }
  if (
    linearProof.issueIds[issueIndex] !== workUnit.linearIssueId ||
    linearProof.workItemFingerprints[issueIndex] !== issue.workItemFingerprint ||
    !linearProof.providerReadbackFingerprints.includes(
      workUnit.providerReadbackFingerprint,
    )
  ) {
    throw new DurableLinearContractError(
      "Linear child issue id, hierarchy fingerprint, or provider readback has drifted.",
    );
  }
  const expectedAcceptanceCriterionIds = issue.acceptanceCriteria.map(
    (_criterion, index) => `${issue.key}:AC-${index + 1}`,
  );
  if (!sameStrings(workUnit.acceptanceCriterionIds, expectedAcceptanceCriterionIds)) {
    throw new DurableLinearContractError(
      "Linear child acceptance criterion ids do not exactly match the hierarchy issue.",
    );
  }
  const projectLineageFingerprint =
    getProjectLineageFingerprintHistoryV1(lineage)[linearCommitIndex];
  if (!projectLineageFingerprint) {
    throw new DurableLinearContractError(
      "Verified Linear hierarchy lineage prefix is unavailable.",
    );
  }
  return {
    lineage,
    plan,
    issue,
    workUnit,
    projectLineageFingerprint,
    repositoryProfileKey: expectLogicalKey(
      input.repositoryProfileKey,
      "repository profile key",
    ),
    repositoryProfileFingerprint: expectSha256(
      input.repositoryProfileFingerprint,
      "repository profile fingerprint",
    ),
    validationRequirementKeys: parseUniqueStrings(
      input.validationRequirementKeys,
      "validation requirement key",
      1,
      20,
      128,
      (entry, label) => expectLogicalKey(entry, label),
    ),
    riskClass: expectEnum(
      input.riskClass ?? "medium",
      "project work-item risk class",
      ["low", "medium", "high"] as const,
    ),
  };
}

function buildWorkItemSpec(resolved: ResolvedHierarchyChildV1): WorkItemSpecV2 {
  const acceptanceCriteria = resolved.issue.acceptanceCriteria.map(
    (text, index) => {
      const scopedId = resolved.workUnit.acceptanceCriterionIds[index];
      const expectedScopedId = `${resolved.issue.key}:AC-${index + 1}`;
      if (scopedId !== expectedScopedId) {
        throw new DurableLinearContractError(
          "Hierarchy acceptance criterion id/text mapping is not exact.",
        );
      }
      return { id: `AC-${index + 1}`, text };
    },
  );
  return createWorkItemSpecV2({
    schemaVersion: 2,
    ready: true,
    executionClass: "code",
    objective: resolved.issue.description,
    repositoryKey: resolved.repositoryProfileKey,
    acceptanceCriteria,
    validationRequirementKeys: [...resolved.validationRequirementKeys],
    evidenceRefs: [`research:${resolved.plan.planId}`],
    riskClass: resolved.riskClass,
    originRunId: resolved.lineage.runId,
    acceptedResearchArtifactFingerprint:
      resolved.plan.acceptedResearchArtifactFingerprint,
    generation: 0,
  });
}

function parseProjectWorkUnitExecutionBindingUnsignedV1(
  value: unknown,
): ProjectWorkUnitExecutionBindingUnsignedV1 {
  const record = expectPlainRecord(value, "project work-unit execution binding");
  assertBindingKeys(record, false);
  if (
    record.schemaVersion !==
      PROJECT_WORK_UNIT_EXECUTION_BINDING_SCHEMA_VERSION ||
    record.kind !== "project_work_unit_execution_binding"
  ) {
    throw new DurableLinearContractError(
      "Unsupported project work-unit execution binding contract.",
    );
  }
  const projectRunId = expectOpaqueId(record.projectRunId, "project run id");
  const workUnitId = expectLogicalKey(record.workUnitId, "project work-unit id", 100);
  const acceptanceCriterionIds = parseUniqueStrings(
    record.acceptanceCriterionIds,
    "project work-unit acceptance criterion id",
    1,
    20,
    160,
    expectOpaqueId,
  );
  const workItemSpec = parseWorkItemSpecV2(record.workItemSpec);
  const workItemSpecFingerprint = expectSha256(
    record.workItemSpecFingerprint,
    "project executable work-item spec fingerprint",
  );
  const hierarchyWorkItemFingerprint = expectSha256(
    record.hierarchyWorkItemFingerprint,
    "hierarchy custom work-item fingerprint",
  );
  const repositoryProfileKey = expectLogicalKey(
    record.repositoryProfileKey,
    "repository profile key",
  );
  const repositoryProfileFingerprint = expectSha256(
    record.repositoryProfileFingerprint,
    "repository profile fingerprint",
  );
  const validationRequirementKeys = parseUniqueStrings(
    record.validationRequirementKeys,
    "validation requirement key",
    1,
    20,
    128,
    (entry, label) => expectLogicalKey(entry, label),
  );
  if (
    !constantTimeFingerprintEqual(
      workItemSpecFingerprint,
      workItemSpec.fingerprint,
    )
  ) {
    throw new DurableLinearContractError(
      "Executable WorkItemSpecV2 fingerprint does not match its signed spec.",
    );
  }
  if (
    constantTimeFingerprintEqual(
      hierarchyWorkItemFingerprint,
      workItemSpecFingerprint,
    )
  ) {
    throw new DurableLinearContractError(
      "Hierarchy custom work-item fingerprint must never be reused as the executable WorkItemSpecV2 fingerprint.",
    );
  }
  if (
    workItemSpec.executionClass !== "code" ||
    workItemSpec.repositoryKey !== repositoryProfileKey ||
    workItemSpec.originRunId !== projectRunId ||
    workItemSpec.acceptedResearchArtifactFingerprint !==
      record.acceptedResearchArtifactFingerprint ||
    workItemSpec.generation !== 0 ||
    workItemSpec.parentIssueId !== undefined ||
    !sameStrings(
      workItemSpec.validationRequirementKeys,
      validationRequirementKeys,
    )
  ) {
    throw new DurableLinearContractError(
      "Executable WorkItemSpecV2 does not match the binding's run, research, repository, generation, or validation policy.",
    );
  }
  const expectedAcceptanceCriterionIds = workItemSpec.acceptanceCriteria.map(
    (criterion) => `${workUnitId}:${criterion.id}`,
  );
  if (!sameStrings(acceptanceCriterionIds, expectedAcceptanceCriterionIds)) {
    throw new DurableLinearContractError(
      "Executable WorkItemSpecV2 acceptance ids do not match the Linear child binding.",
    );
  }
  const linearIssueIdentifier = expectString(
    record.linearIssueIdentifier,
    "Linear issue identifier",
    3,
    80,
    { secretFree: true },
  );
  if (!/^[A-Z][A-Z0-9]{0,19}-[1-9][0-9]{0,9}$/u.test(linearIssueIdentifier)) {
    throw new DurableLinearContractError(
      "Linear issue identifier must use the canonical TEAM-123 form.",
    );
  }
  const linearIssueUrl = parseHttpUrl(record.linearIssueUrl, "Linear issue URL");
  const parsedLinearUrl = new URL(linearIssueUrl);
  const linearHost = parsedLinearUrl.hostname.toLowerCase();
  if (
    parsedLinearUrl.protocol !== "https:" ||
    (linearHost !== "linear.app" && !linearHost.endsWith(".linear.app"))
  ) {
    throw new DurableLinearContractError(
      "Linear issue URL must use the Linear HTTPS host.",
    );
  }
  return {
    schemaVersion: PROJECT_WORK_UNIT_EXECUTION_BINDING_SCHEMA_VERSION,
    kind: "project_work_unit_execution_binding",
    projectRunId,
    projectLineageId: expectLogicalKey(
      record.projectLineageId,
      "project lineage id",
      160,
    ),
    projectLineageFingerprint: expectSha256(
      record.projectLineageFingerprint,
      "project lineage fingerprint",
    ),
    researchProjectPlanFingerprint: expectSha256(
      record.researchProjectPlanFingerprint,
      "research project plan fingerprint",
    ),
    acceptedResearchArtifactFingerprint: expectSha256(
      record.acceptedResearchArtifactFingerprint,
      "accepted research artifact fingerprint",
    ),
    workUnitId,
    hierarchyWorkItemFingerprint,
    linearIssueId: expectOpaqueId(record.linearIssueId, "Linear issue id"),
    linearIssueIdentifier,
    linearIssueUrl,
    acceptanceCriterionIds,
    providerReadbackFingerprint: expectSha256(
      record.providerReadbackFingerprint,
      "Linear provider readback fingerprint",
    ),
    workItemSpec,
    workItemSpecFingerprint,
    repositoryProfileKey,
    repositoryProfileFingerprint,
    validationRequirementKeys,
  };
}

function assertBindingKeys(
  record: Record<string, unknown>,
  signed: boolean,
): void {
  assertExactKeys(
    record,
    [
      "schemaVersion",
      "kind",
      "projectRunId",
      "projectLineageId",
      "projectLineageFingerprint",
      "researchProjectPlanFingerprint",
      "acceptedResearchArtifactFingerprint",
      "workUnitId",
      "hierarchyWorkItemFingerprint",
      "linearIssueId",
      "linearIssueIdentifier",
      "linearIssueUrl",
      "acceptanceCriterionIds",
      "providerReadbackFingerprint",
      "workItemSpec",
      "workItemSpecFingerprint",
      "repositoryProfileKey",
      "repositoryProfileFingerprint",
      "validationRequirementKeys",
      ...(signed ? ["fingerprint"] : []),
    ],
    [],
    "project work-unit execution binding",
  );
}

function bindingForEvent(
  value: unknown,
  rawScope: unknown,
): ProjectWorkUnitExecutionBindingV1 {
  const binding = parseProjectWorkUnitExecutionBindingV1(value);
  const scopeRecord = expectPlainRecord(rawScope, "project work-unit event scope");
  assertExactKeys(
    scopeRecord,
    [
      "executionBindingFingerprint",
      "projectRunId",
      "projectLineageFingerprint",
      "workUnitId",
      "workItemSpecFingerprint",
      "repositoryProfileKey",
      "repositoryProfileFingerprint",
    ],
    [],
    "project work-unit event scope",
  );
  const expected = createProjectWorkUnitEventScopeV1(binding);
  assertCanonicalContract(scopeRecord, expected, "Project work-unit event scope");
  return binding;
}

function eventWorkUnit(
  binding: ProjectWorkUnitExecutionBindingV1,
  acceptanceCriterionIds: string[] = [],
): [{ workUnitId: string; acceptanceCriterionIds: string[] }] {
  return [{ workUnitId: binding.workUnitId, acceptanceCriterionIds }];
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((entry, index) => entry === right[index])
  );
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new DurableLinearContractError(
      `${label} must be a lowercase 40-character Git SHA.`,
    );
  }
  return value;
}

function githubName(value: unknown, label: string): string {
  const name = expectString(value, label, 1, 100, { secretFree: true });
  if (!/^[A-Za-z0-9_.-]+$/u.test(name) || name === "." || name === "..") {
    throw new DurableLinearContractError(`${label} is invalid.`);
  }
  return name;
}
