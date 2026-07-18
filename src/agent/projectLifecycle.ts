import {
  assertCanonicalContract,
  assertExactKeys,
  assertNoRawAuthority,
  constantTimeFingerprintEqual,
  DurableLinearContractError,
  expectEnum,
  expectInteger,
  expectIsoTimestamp,
  expectLogicalKey,
  expectOpaqueId,
  expectPlainRecord,
  expectSha256,
  expectString,
  fingerprintContract,
  parseUniqueStrings,
  parseVaultMarkdownPath,
} from "../integrations/linear/LinearContractSupport";
import {
  parseAcceptedResearchArtifactV1,
  type AcceptedResearchArtifactV1,
} from "../integrations/linear/AcceptedResearchArtifactV1";

export const RESEARCHER_HANDOFF_SCHEMA_VERSION = 1 as const;
export const RESEARCH_PROJECT_PLAN_SCHEMA_VERSION = 1 as const;
export const PROJECT_LIFECYCLE_INTENT_SCHEMA_VERSION = 1 as const;
export const PROJECT_LINEAGE_SCHEMA_VERSION = 1 as const;

export const PROJECT_LIFECYCLE_STAGES = Object.freeze([
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
  "reconciliation_cleanup",
] as const);

export type ProjectLifecycleStageV1 = (typeof PROJECT_LIFECYCLE_STAGES)[number];

export interface ProjectLifecycleStageEstimateV1 {
  stage: ProjectLifecycleStageV1;
  label: string;
  activeMinutesMin: number;
  activeMinutesMax: number;
  approvalMayPause: boolean;
}

export interface ProjectLifecycleEstimateV1 {
  version: 1;
  stages: ProjectLifecycleStageEstimateV1[];
  activeMinutesMin: number;
  activeMinutesMax: number;
  excludesProviderAndApprovalWaits: true;
}

export interface ResearcherHandoffV1 {
  schemaVersion: typeof RESEARCHER_HANDOFF_SCHEMA_VERSION;
  kind: "researcher_to_lead";
  runId: string;
  taskId: string;
  acceptedResearchArtifactFingerprint: string;
  notePath: string;
  noteSha256: string;
  evidenceIds: string[];
  summary: string;
  unresolvedQuestions: string[];
  status: "accepted";
  acceptedBy: "lead";
  acceptedAt: string;
  fingerprint: string;
}

export type ResearcherHandoffUnsignedV1 = Omit<
  ResearcherHandoffV1,
  "schemaVersion" | "kind" | "status" | "acceptedBy" | "fingerprint"
>;

export interface ResearchProjectDestinationV1 {
  workspaceId: string;
  teamId: string;
}

export interface ResearchProjectHierarchyItemV1 {
  key: string;
  title: string;
  description: string;
  idempotencyKey: string;
}

export interface ResearchProjectIssueV1
  extends ResearchProjectHierarchyItemV1 {
  dependencyKeys: string[];
  acceptanceCriteria: string[];
  workItemFingerprint: string;
}

export interface ResearchProjectPlanV1 {
  schemaVersion: typeof RESEARCH_PROJECT_PLAN_SCHEMA_VERSION;
  kind: "research_project_plan";
  planId: string;
  runId: string;
  acceptedResearchArtifactFingerprint: string;
  sourceNotePath: string;
  destination: ResearchProjectDestinationV1;
  initiative: ResearchProjectHierarchyItemV1;
  project: ResearchProjectHierarchyItemV1;
  issues: ResearchProjectIssueV1[];
  createdAt: string;
  fingerprint: string;
}

export type ResearchProjectPlanUnsignedV1 = Omit<
  ResearchProjectPlanV1,
  "schemaVersion" | "kind" | "fingerprint" | "initiative" | "project" | "issues"
> & {
  initiative: Omit<ResearchProjectHierarchyItemV1, "idempotencyKey"> & {
    idempotencyKey?: string;
  };
  project: Omit<ResearchProjectHierarchyItemV1, "idempotencyKey"> & {
    idempotencyKey?: string;
  };
  issues: Array<
    Omit<ResearchProjectIssueV1, "idempotencyKey"> & {
      idempotencyKey?: string;
    }
  >;
};

export interface ProjectLifecycleIntentV1 {
  schemaVersion: typeof PROJECT_LIFECYCLE_INTENT_SCHEMA_VERSION;
  kind: "project_lifecycle_intent";
  runId: string;
  exactUserCommand: string;
  stages: ProjectLifecycleStageV1[];
  requestedAt: string;
  fingerprint: string;
}

export type ProjectLifecycleIntentUnsignedV1 = Omit<
  ProjectLifecycleIntentV1,
  "schemaVersion" | "kind" | "fingerprint"
>;

export interface AcceptedResearchLineageProofV1 {
  stage: "accepted_research";
  artifactFingerprint: string;
  notePath: string;
  noteSha256: string;
  researcherHandoffFingerprint: string;
}

export interface LinearHierarchyLineageProofV1 {
  stage: "linear_hierarchy";
  planFingerprint: string;
  workspaceId: string;
  teamId: string;
  initiativeId: string;
  projectId: string;
  issueIds: string[];
  workItemFingerprints: string[];
  providerReadbackFingerprints: string[];
}

export interface CodeExecutionLineageProofV1 {
  stage: "code_execution";
  repositoryProfileKey: string;
  repositoryProfileFingerprint: string;
  workspaceId: string;
  validationReceiptFingerprints: string[];
  targetedValidationPassed: true;
  freshFullValidationPassed: true;
  commitSha: string;
  commitReadbackFingerprint: string;
}

export interface PrivateGitHubPublicationLineageProofV1 {
  stage: "private_github_publication";
  trustedBindingFingerprint: string;
  owner: string;
  repository: string;
  verifiedPrivate: true;
  branch: string;
  pullRequestNumber: number;
  draft: true;
  remoteSha: string;
  repositoryReadbackFingerprint: string;
  pullRequestReadbackFingerprint: string;
}

export interface ReconciliationCleanupLineageProofV1 {
  stage: "reconciliation_cleanup";
  backlinkReceiptFingerprints: string[];
  providerStatusReadbackFingerprints: string[];
  cleanupReceiptFingerprints: string[];
  noUnapprovedMutations: true;
}

export type ProjectLifecycleStageProofV1 =
  | AcceptedResearchLineageProofV1
  | LinearHierarchyLineageProofV1
  | CodeExecutionLineageProofV1
  | PrivateGitHubPublicationLineageProofV1
  | ReconciliationCleanupLineageProofV1;

export interface ProjectLifecycleStageCommitV1 {
  stage: ProjectLifecycleStageV1;
  committedAt: string;
  proof: ProjectLifecycleStageProofV1;
  proofFingerprint: string;
}

export interface ProjectLineageV1 {
  schemaVersion: typeof PROJECT_LINEAGE_SCHEMA_VERSION;
  kind: "project_lineage";
  lineageId: string;
  runId: string;
  vaultBindingKey: string;
  commits: ProjectLifecycleStageCommitV1[];
  updatedAt: string;
  fingerprint: string;
}

export const PROJECT_LINEAGE_NAMESPACE_VERSION = 1 as const;
export const PROJECT_LINEAGE_LIMIT = 100;

export interface ProjectLineageNamespaceV1 {
  version: typeof PROJECT_LINEAGE_NAMESPACE_VERSION;
  revision: number;
  lineages: Record<string, ProjectLineageV1>;
}

export interface ProjectLineagePersistenceV1 {
  read(): Promise<unknown | null | undefined>;
  write(
    namespace: ProjectLineageNamespaceV1,
    expectedRevision: number,
  ): Promise<void | boolean>;
}

export interface ProjectLifecycleStageNodeV1 {
  id: `lifecycle-${ProjectLifecycleStageV1}`;
  stage: ProjectLifecycleStageV1;
  dependencyIds: string[];
  objective: string;
  composite: true;
}

export function createResearcherHandoffV1(
  input: Omit<
    ResearcherHandoffUnsignedV1,
    "acceptedResearchArtifactFingerprint" | "notePath" | "noteSha256"
  > & {
    artifact: AcceptedResearchArtifactV1;
  },
): ResearcherHandoffV1 {
  const artifact = parseAcceptedResearchArtifactV1(input.artifact);
  const unsigned = parseResearcherHandoffUnsigned({
    runId: input.runId,
    taskId: input.taskId,
    acceptedResearchArtifactFingerprint: artifact.artifactFingerprint,
    notePath: artifact.notePath,
    noteSha256: artifact.noteSha256,
    evidenceIds: input.evidenceIds,
    summary: input.summary,
    unresolvedQuestions: input.unresolvedQuestions,
    acceptedAt: input.acceptedAt,
  });
  const fixed = fixedResearcherHandoff(unsigned);
  return { ...fixed, fingerprint: fingerprintResearcherHandoffV1(fixed) };
}

export function parseResearcherHandoffV1(value: unknown): ResearcherHandoffV1 {
  const record = expectPlainRecord(value, "researcher handoff");
  assertExactKeys(
    record,
    [
      "schemaVersion", "kind", "runId", "taskId",
      "acceptedResearchArtifactFingerprint", "notePath", "noteSha256",
      "evidenceIds", "summary", "unresolvedQuestions", "status",
      "acceptedBy", "acceptedAt", "fingerprint",
    ],
    [],
    "researcher handoff",
  );
  if (
    record.schemaVersion !== RESEARCHER_HANDOFF_SCHEMA_VERSION ||
    record.kind !== "researcher_to_lead" ||
    record.status !== "accepted" ||
    record.acceptedBy !== "lead"
  ) {
    throw new DurableLinearContractError("Unsupported researcher handoff contract.");
  }
  const unsigned = parseResearcherHandoffUnsigned(record);
  const fixed = fixedResearcherHandoff(unsigned);
  const fingerprint = expectSha256(record.fingerprint, "researcher handoff fingerprint");
  if (!constantTimeFingerprintEqual(fingerprint, fingerprintResearcherHandoffV1(fixed))) {
    throw new DurableLinearContractError("Researcher handoff fingerprint does not match its canonical payload.");
  }
  return { ...fixed, fingerprint };
}

/** The accepted handoff is authoritative even if an executor projection is stale. */
export function resolveResearcherHandoffForLeadV1(input: {
  handoff: unknown;
  executorStatus: string | null;
}): { proceed: true; handoff: ResearcherHandoffV1; ignoredStaleExecutorStatus: boolean } {
  const handoff = parseResearcherHandoffV1(input.handoff);
  return {
    proceed: true,
    handoff,
    ignoredStaleExecutorStatus:
      input.executorStatus !== null &&
      !["complete", "handoff", "accepted"].includes(input.executorStatus),
  };
}

export function createResearchProjectPlanV1(
  input: ResearchProjectPlanUnsignedV1,
): ResearchProjectPlanV1 {
  const normalized = normalizeResearchProjectPlanInput(input);
  const fixed = fixedResearchProjectPlan(normalized);
  return { ...fixed, fingerprint: fingerprintResearchProjectPlanV1(fixed) };
}

export function parseResearchProjectPlanV1(value: unknown): ResearchProjectPlanV1 {
  const record = expectPlainRecord(value, "research project plan");
  assertExactKeys(
    record,
    [
      "schemaVersion", "kind", "planId", "runId",
      "acceptedResearchArtifactFingerprint", "sourceNotePath", "destination",
      "initiative", "project", "issues", "createdAt", "fingerprint",
    ],
    [],
    "research project plan",
  );
  if (
    record.schemaVersion !== RESEARCH_PROJECT_PLAN_SCHEMA_VERSION ||
    record.kind !== "research_project_plan"
  ) {
    throw new DurableLinearContractError("Unsupported research project plan contract.");
  }
  const normalized = normalizeResearchProjectPlanInput(record as unknown as ResearchProjectPlanUnsignedV1);
  const fixed = fixedResearchProjectPlan(normalized);
  const fingerprint = expectSha256(record.fingerprint, "research project plan fingerprint");
  if (!constantTimeFingerprintEqual(fingerprint, fingerprintResearchProjectPlanV1(fixed))) {
    throw new DurableLinearContractError("Research project plan fingerprint does not match its canonical payload.");
  }
  return { ...fixed, fingerprint };
}

export function fingerprintResearchProjectPlanV1(
  plan: Omit<ResearchProjectPlanV1, "fingerprint"> | ResearchProjectPlanV1,
): string {
  const { fingerprint: _fingerprint, createdAt: _createdAt, ...stable } = plan as ResearchProjectPlanV1;
  return fingerprintContract(stable);
}

export function createProjectLifecycleIntentV1(
  input: ProjectLifecycleIntentUnsignedV1,
): ProjectLifecycleIntentV1 {
  const normalized = normalizeProjectLifecycleIntent(input);
  const fixed = fixedProjectLifecycleIntent(normalized);
  return { ...fixed, fingerprint: fingerprintProjectLifecycleIntentV1(fixed) };
}

export function parseProjectLifecycleIntentV1(value: unknown): ProjectLifecycleIntentV1 {
  const record = expectPlainRecord(value, "project lifecycle intent");
  assertExactKeys(
    record,
    ["schemaVersion", "kind", "runId", "exactUserCommand", "stages", "requestedAt", "fingerprint"],
    [],
    "project lifecycle intent",
  );
  if (
    record.schemaVersion !== PROJECT_LIFECYCLE_INTENT_SCHEMA_VERSION ||
    record.kind !== "project_lifecycle_intent"
  ) {
    throw new DurableLinearContractError("Unsupported project lifecycle intent contract.");
  }
  const normalized = normalizeProjectLifecycleIntent(record as unknown as ProjectLifecycleIntentUnsignedV1);
  const fixed = fixedProjectLifecycleIntent(normalized);
  const fingerprint = expectSha256(record.fingerprint, "project lifecycle intent fingerprint");
  if (!constantTimeFingerprintEqual(fingerprint, fingerprintProjectLifecycleIntentV1(fixed))) {
    throw new DurableLinearContractError("Project lifecycle intent fingerprint does not match its canonical payload.");
  }
  return { ...fixed, fingerprint };
}

export function fingerprintProjectLifecycleIntentV1(
  intent: Omit<ProjectLifecycleIntentV1, "fingerprint"> | ProjectLifecycleIntentV1,
): string {
  const { fingerprint: _fingerprint, requestedAt: _requestedAt, ...stable } = intent as ProjectLifecycleIntentV1;
  return fingerprintContract(stable);
}

/**
 * Deterministic stage classification. Action verbs are required so provider
 * names in source text cannot widen the mission. Explicit negation wins.
 */
export function detectProjectLifecycleStagesV1(command: string): ProjectLifecycleStageV1[] {
  const text = expectString(command, "project lifecycle command", 1, 8_000, {
    allowNewlines: true,
    secretFree: true,
  });
  const normalized = text.toLowerCase();
  const isNegated = (targetPattern: string) =>
    new RegExp(
      `\\b(?:do not|don't|without|skip|exclude|no)\\b[^.\\n]{0,100}\\b(?:${targetPattern})\\b`,
      "u",
    ).test(normalized);
  if (
    /\b(?:end[- ]to[- ]end|complete\s+(?:the\s+)?(?:project|lifecycle)|create\s+(?:the\s+)?project\s+from\s+research)\b/u.test(normalized)
  ) {
    return PROJECT_LIFECYCLE_STAGES.filter((stage) => {
      switch (stage) {
        case "accepted_research":
          return !isNegated("research|investigat(?:e|ion)");
        case "linear_hierarchy":
          return !isNegated("linear|initiative|project|issues?|hierarchy");
        case "code_execution":
          return !isNegated("code|implement(?:ation)?|repository|repo|workspace");
        case "private_github_publication":
          return !isNegated("github|publish(?:ing|ation)?|push|pull request|draft pr|private repository");
        case "reconciliation_cleanup":
          return !isNegated("cleanup|clean\\s*up|reconcil(?:e|iation)|backlinks?|close");
      }
    });
  }
  const stages: ProjectLifecycleStageV1[] = [];
  const positive = (pattern: RegExp, targetPattern: string) =>
    pattern.test(normalized) &&
    !isNegated(targetPattern);
  if (positive(/\b(?:research|investigate|study|analy[sz]e)\b[^.\n]{0,120}\b(?:topic|product|problem|idea|market|vault|web|sources?)\b/u, "research|investigat(?:e|ion)")) {
    stages.push("accepted_research");
  }
  if (positive(/\b(?:prepare|format|shape|turn|send|publish|create|build)\b[^.\n]{0,140}\blinear\b[^.\n]{0,100}\b(?:initiative|project|issues?|hierarchy|plan)\b/u, "linear|initiative|hierarchy")) {
    stages.push("linear_hierarchy");
  }
  if (positive(/\b(?:implement|code|execute|work|build|fix)\b[^.\n]{0,140}\b(?:code|repository|repo|workspace|linear\s+issues?)\b/u, "code|implement(?:ation)?|repository|repo|workspace")) {
    stages.push("code_execution");
  }
  if (positive(/\b(?:publish|push|open|create)\b[^.\n]{0,140}\b(?:github|draft\s+(?:pr|pull request)|pull request|private\s+repository)\b/u, "github|publish(?:ing|ation)?|push|pull request|draft pr|private repository")) {
    stages.push("private_github_publication");
  }
  if (positive(/\b(?:reconcile|finalize|finish|clean\s*up|backlink|close)\b[^.\n]{0,140}\b(?:project|lifecycle|linear|github|issues?|branches?|links?)\b/u, "cleanup|clean\\s*up|reconcil(?:e|iation)|backlinks?|close")) {
    stages.push("reconciliation_cleanup");
  }
  return PROJECT_LIFECYCLE_STAGES.filter((stage) => stages.includes(stage));
}

/**
 * User-facing active-work estimate for a detected project lifecycle. These are
 * intentionally broad deterministic ranges, not promises: provider latency
 * and time spent waiting for an approval are reported separately.
 */
export function estimateProjectLifecycleV1(
  command: string,
): ProjectLifecycleEstimateV1 | null {
  const stages = detectProjectLifecycleStagesV1(command);
  if (stages.length === 0) return null;
  const estimates = stages.map(projectLifecycleStageEstimate);
  return {
    version: 1,
    stages: estimates,
    activeMinutesMin: estimates.reduce(
      (total, estimate) => total + estimate.activeMinutesMin,
      0,
    ),
    activeMinutesMax: estimates.reduce(
      (total, estimate) => total + estimate.activeMinutesMax,
      0,
    ),
    excludesProviderAndApprovalWaits: true,
  };
}

function projectLifecycleStageEstimate(
  stage: ProjectLifecycleStageV1,
): ProjectLifecycleStageEstimateV1 {
  switch (stage) {
    case "accepted_research":
      return {
        stage,
        label: "Research and Obsidian note",
        activeMinutesMin: 4,
        activeMinutesMax: 12,
        approvalMayPause: false,
      };
    case "linear_hierarchy":
      return {
        stage,
        label: "Linear prepare, approval, create, and readback",
        activeMinutesMin: 2,
        activeMinutesMax: 6,
        approvalMayPause: true,
      };
    case "code_execution":
      return {
        stage,
        label: "Code implementation, validation, and commit",
        activeMinutesMin: 5,
        activeMinutesMax: 20,
        approvalMayPause: true,
      };
    case "private_github_publication":
      return {
        stage,
        label: "Private GitHub publication and readback",
        activeMinutesMin: 2,
        activeMinutesMax: 7,
        approvalMayPause: true,
      };
    case "reconciliation_cleanup":
      return {
        stage,
        label: "Backlinks, status reconciliation, and cleanup proof",
        activeMinutesMin: 2,
        activeMinutesMax: 6,
        approvalMayPause: true,
      };
  }
}

export function buildProjectLifecycleStageNodesV1(
  intentInput: unknown,
): ProjectLifecycleStageNodeV1[] {
  const intent = parseProjectLifecycleIntentV1(intentInput);
  return intent.stages.map((stage, index) => ({
    id: `lifecycle-${stage}`,
    stage,
    dependencyIds: index === 0 ? [] : [`lifecycle-${intent.stages[index - 1]}`],
    objective: stageObjective(stage),
    composite: true,
  }));
}

export function createProjectLineageV1(input: {
  lineageId: string;
  runId: string;
  vaultBindingKey: string;
  handoff: ResearcherHandoffV1;
  updatedAt: string;
}): ProjectLineageV1 {
  const handoff = parseResearcherHandoffV1(input.handoff);
  return buildProjectLineage({
    lineageId: input.lineageId,
    runId: input.runId,
    vaultBindingKey: input.vaultBindingKey,
    commits: [{
      stage: "accepted_research",
      committedAt: input.updatedAt,
      proof: {
        stage: "accepted_research",
        artifactFingerprint: handoff.acceptedResearchArtifactFingerprint,
        notePath: handoff.notePath,
        noteSha256: handoff.noteSha256,
        researcherHandoffFingerprint: handoff.fingerprint,
      },
    }],
    updatedAt: input.updatedAt,
  });
}

export function advanceProjectLineageV1(input: {
  lineage: unknown;
  proof: ProjectLifecycleStageProofV1;
  committedAt: string;
}): ProjectLineageV1 {
  const lineage = parseProjectLineageV1(input.lineage);
  const proof = parseStageProof(input.proof);
  const expected = PROJECT_LIFECYCLE_STAGES[lineage.commits.length];
  if (!expected) {
    throw new DurableLinearContractError("Project lineage is already complete.");
  }
  if (proof.stage !== expected) {
    throw new DurableLinearContractError(
      `Project lineage expected ${expected} before ${proof.stage}.`,
    );
  }
  assertLineageContinuity(lineage, proof);
  return buildProjectLineage({
    lineageId: lineage.lineageId,
    runId: lineage.runId,
    vaultBindingKey: lineage.vaultBindingKey,
    commits: [
      ...lineage.commits.map((commit) => ({
        stage: commit.stage,
        committedAt: commit.committedAt,
        proof: commit.proof,
      })),
      { stage: proof.stage, committedAt: input.committedAt, proof },
    ],
    updatedAt: input.committedAt,
  });
}

export function parseProjectLineageV1(value: unknown): ProjectLineageV1 {
  const record = expectPlainRecord(value, "project lineage");
  assertExactKeys(
    record,
    ["schemaVersion", "kind", "lineageId", "runId", "vaultBindingKey", "commits", "updatedAt", "fingerprint"],
    [],
    "project lineage",
  );
  if (
    record.schemaVersion !== PROJECT_LINEAGE_SCHEMA_VERSION ||
    record.kind !== "project_lineage"
  ) {
    throw new DurableLinearContractError("Unsupported project lineage contract.");
  }
  const lineage = buildProjectLineage({
    lineageId: record.lineageId as string,
    runId: record.runId as string,
    vaultBindingKey: record.vaultBindingKey as string,
    commits: parseCommits(record.commits).map((commit) => ({
      stage: commit.stage,
      committedAt: commit.committedAt,
      proof: commit.proof,
    })),
    updatedAt: record.updatedAt as string,
  });
  const observed = expectSha256(record.fingerprint, "project lineage fingerprint");
  if (!constantTimeFingerprintEqual(observed, lineage.fingerprint)) {
    throw new DurableLinearContractError("Project lineage fingerprint does not match its canonical payload.");
  }
  return lineage;
}

export function parseProjectLineageNamespaceV1(
  value: unknown,
): ProjectLineageNamespaceV1 {
  if (value === null || value === undefined) {
    return { version: 1, revision: 0, lineages: {} };
  }
  const record = expectPlainRecord(value, "project lineage namespace");
  assertExactKeys(
    record,
    ["version", "revision", "lineages"],
    [],
    "project lineage namespace",
  );
  if (
    record.version !== PROJECT_LINEAGE_NAMESPACE_VERSION ||
    !Number.isInteger(record.revision) ||
    (record.revision as number) < 0
  ) {
    throw new DurableLinearContractError("Project lineage namespace is invalid.");
  }
  const rawLineages = expectPlainRecord(
    record.lineages,
    "project lineage namespace entries",
  );
  const entries = Object.entries(rawLineages);
  if (entries.length > PROJECT_LINEAGE_LIMIT) {
    throw new DurableLinearContractError("Project lineage storage limit is exceeded.");
  }
  const lineages: Record<string, ProjectLineageV1> = {};
  for (const [key, raw] of entries) {
    const lineage = parseProjectLineageV1(raw);
    if (lineage.lineageId !== key) {
      throw new DurableLinearContractError(
        "Project lineage namespace key does not match its lineage ID.",
      );
    }
    lineages[key] = lineage;
  }
  return {
    version: PROJECT_LINEAGE_NAMESPACE_VERSION,
    revision: record.revision as number,
    lineages,
  };
}

export class ProjectLineageStoreV1 {
  private mutationTail: Promise<void> = Promise.resolve();

  constructor(private readonly persistence: ProjectLineagePersistenceV1) {}

  async get(lineageId: string): Promise<ProjectLineageV1 | null> {
    await this.mutationTail;
    const key = expectLogicalKey(lineageId, "project lineage id", 160);
    const namespace = parseProjectLineageNamespaceV1(
      await this.persistence.read(),
    );
    return clone(namespace.lineages[key] ?? null);
  }

  async list(): Promise<ProjectLineageV1[]> {
    await this.mutationTail;
    const namespace = parseProjectLineageNamespaceV1(
      await this.persistence.read(),
    );
    return Object.values(namespace.lineages)
      .sort((left, right) => left.lineageId.localeCompare(right.lineageId))
      .map((lineage) => clone(lineage)!);
  }

  async upsert(value: unknown): Promise<ProjectLineageV1> {
    let persisted: ProjectLineageV1 | null = null;
    const operation = this.mutationTail.then(async () => {
      const lineage = parseProjectLineageV1(value);
      const current = parseProjectLineageNamespaceV1(
        await this.persistence.read(),
      );
      const previous = current.lineages[lineage.lineageId];
      if (previous) assertProjectLineageTransition(previous, lineage);
      if (!previous && Object.keys(current.lineages).length >= PROJECT_LINEAGE_LIMIT) {
        throw new DurableLinearContractError(
          `Project lineage storage is limited to ${PROJECT_LINEAGE_LIMIT} entries.`,
        );
      }
      const next: ProjectLineageNamespaceV1 = {
        version: PROJECT_LINEAGE_NAMESPACE_VERSION,
        revision: current.revision + 1,
        lineages: {
          ...current.lineages,
          [lineage.lineageId]: lineage,
        },
      };
      const written = await this.persistence.write(clone(next)!, current.revision);
      if (written === false) {
        throw new DurableLinearContractError(
          "Project lineage changed before it could be saved.",
        );
      }
      persisted = lineage;
    });
    this.mutationTail = operation.then(() => undefined, () => undefined);
    await operation;
    return clone(persisted)!;
  }
}

function assertProjectLineageTransition(
  previous: ProjectLineageV1,
  next: ProjectLineageV1,
): void {
  if (
    previous.runId !== next.runId ||
    previous.vaultBindingKey !== next.vaultBindingKey ||
    next.commits.length < previous.commits.length ||
    next.commits.length > previous.commits.length + 1
  ) {
    throw new DurableLinearContractError(
      "Project lineage transition may only append one verified stage.",
    );
  }
  const prior = JSON.stringify(previous.commits);
  const retained = JSON.stringify(next.commits.slice(0, previous.commits.length));
  if (prior !== retained) {
    throw new DurableLinearContractError(
      "Project lineage transition cannot rewrite committed stage proof.",
    );
  }
  if (
    next.commits.length === previous.commits.length &&
    next.fingerprint !== previous.fingerprint
  ) {
    throw new DurableLinearContractError(
      "Project lineage transition without a new stage must be idempotent.",
    );
  }
}

function parseResearcherHandoffUnsigned(value: unknown): ResearcherHandoffUnsignedV1 {
  const record = expectPlainRecord(value, "researcher handoff");
  return {
    runId: expectOpaqueId(record.runId, "researcher handoff run id"),
    taskId: expectLogicalKey(record.taskId, "researcher handoff task id"),
    acceptedResearchArtifactFingerprint: expectSha256(
      record.acceptedResearchArtifactFingerprint,
      "accepted research artifact fingerprint",
    ),
    notePath: parseVaultMarkdownPath(record.notePath, "researcher handoff note path"),
    noteSha256: expectSha256(record.noteSha256, "researcher handoff note hash"),
    evidenceIds: parseUniqueStrings(record.evidenceIds, "researcher handoff evidence id", 1, 50, 160, expectOpaqueId),
    summary: cleanNarrative(record.summary, "researcher handoff summary", 8_000),
    unresolvedQuestions: parseNarrativeList(record.unresolvedQuestions, "unresolved question", 0, 20, 1_000),
    acceptedAt: expectIsoTimestamp(record.acceptedAt, "researcher handoff accepted at"),
  };
}

function fixedResearcherHandoff(
  unsigned: ResearcherHandoffUnsignedV1,
): Omit<ResearcherHandoffV1, "fingerprint"> {
  return {
    schemaVersion: RESEARCHER_HANDOFF_SCHEMA_VERSION,
    kind: "researcher_to_lead",
    ...unsigned,
    status: "accepted",
    acceptedBy: "lead",
  };
}

function fingerprintResearcherHandoffV1(
  value: Omit<ResearcherHandoffV1, "fingerprint">,
): string {
  const { acceptedAt: _acceptedAt, ...stable } = value;
  return fingerprintContract(stable);
}

function normalizeResearchProjectPlanInput(
  input: ResearchProjectPlanUnsignedV1,
): ResearchProjectPlanUnsignedV1 {
  const record = expectPlainRecord(input, "research project plan");
  const destination = expectPlainRecord(record.destination, "research project destination");
  assertExactKeys(destination, ["workspaceId", "teamId"], [], "research project destination");
  const planBase = {
    planId: expectLogicalKey(record.planId, "research project plan id", 160),
    runId: expectOpaqueId(record.runId, "research project plan run id"),
    acceptedResearchArtifactFingerprint: expectSha256(
      record.acceptedResearchArtifactFingerprint,
      "research project accepted artifact fingerprint",
    ),
    sourceNotePath: parseVaultMarkdownPath(record.sourceNotePath, "research project source note path"),
    destination: {
      workspaceId: expectOpaqueId(destination.workspaceId, "Linear workspace id"),
      teamId: expectOpaqueId(destination.teamId, "Linear team id"),
    },
    createdAt: expectIsoTimestamp(record.createdAt, "research project plan created at"),
  };
  const initiative = parseHierarchyItem(record.initiative, "research project initiative");
  const project = parseHierarchyItem(record.project, "research project project");
  if (!Array.isArray(record.issues) || record.issues.length < 1 || record.issues.length > 20) {
    throw new DurableLinearContractError("Research project plan requires 1-20 issues.");
  }
  const issueKeys = new Set<string>();
  const issues = record.issues.map((raw, index) => {
    const item = parseIssue(raw, index);
    if (issueKeys.has(item.key)) {
      throw new DurableLinearContractError(`Research project issue key ${item.key} is duplicated.`);
    }
    issueKeys.add(item.key);
    return item;
  });
  assertAcyclicIssueDependencies(issues);
  return { ...planBase, initiative, project, issues };
}

function fixedResearchProjectPlan(
  input: ResearchProjectPlanUnsignedV1,
): Omit<ResearchProjectPlanV1, "fingerprint"> {
  const stablePrefix = `research-project:${input.acceptedResearchArtifactFingerprint}`;
  return {
    schemaVersion: RESEARCH_PROJECT_PLAN_SCHEMA_VERSION,
    kind: "research_project_plan",
    planId: input.planId,
    runId: input.runId,
    acceptedResearchArtifactFingerprint: input.acceptedResearchArtifactFingerprint,
    sourceNotePath: input.sourceNotePath,
    destination: input.destination,
    initiative: {
      ...input.initiative,
      idempotencyKey: input.initiative.idempotencyKey ?? `${stablePrefix}:initiative:${input.initiative.key}`,
    },
    project: {
      ...input.project,
      idempotencyKey: input.project.idempotencyKey ?? `${stablePrefix}:project:${input.project.key}`,
    },
    issues: input.issues.map((issue) => ({
      ...issue,
      idempotencyKey: issue.idempotencyKey ?? `${stablePrefix}:issue:${issue.key}`,
    })),
    createdAt: input.createdAt,
  };
}

function parseHierarchyItem(
  value: unknown,
  label: string,
): ResearchProjectPlanUnsignedV1["initiative"] {
  const record = expectPlainRecord(value, label);
  assertExactKeys(record, ["key", "title", "description"], ["idempotencyKey"], label);
  return {
    key: expectLogicalKey(record.key, `${label} key`, 100),
    title: expectString(record.title, `${label} title`, 1, 240, { secretFree: true }),
    description: cleanNarrative(record.description, `${label} description`, 8_000),
    ...(record.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: expectString(record.idempotencyKey, `${label} idempotency key`, 1, 500, { secretFree: true }) }),
  };
}

function parseIssue(value: unknown, index: number): ResearchProjectPlanUnsignedV1["issues"][number] {
  const label = `research project issue ${index + 1}`;
  const record = expectPlainRecord(value, label);
  assertExactKeys(
    record,
    ["key", "title", "description", "dependencyKeys", "acceptanceCriteria", "workItemFingerprint"],
    ["idempotencyKey"],
    label,
  );
  return {
    key: expectLogicalKey(record.key, `${label} key`, 100),
    title: expectString(record.title, `${label} title`, 1, 240, { secretFree: true }),
    description: cleanNarrative(record.description, `${label} description`, 8_000),
    dependencyKeys: parseUniqueStrings(record.dependencyKeys, `${label} dependency key`, 0, 19, 100, expectLogicalKey),
    acceptanceCriteria: parseNarrativeList(record.acceptanceCriteria, `${label} acceptance criterion`, 1, 20, 500),
    workItemFingerprint: expectSha256(record.workItemFingerprint, `${label} work item fingerprint`),
    ...(record.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: expectString(record.idempotencyKey, `${label} idempotency key`, 1, 500, { secretFree: true }) }),
  };
}

function assertAcyclicIssueDependencies(issues: ResearchProjectPlanUnsignedV1["issues"]): void {
  const byKey = new Map(issues.map((issue) => [issue.key, issue]));
  for (const issue of issues) {
    for (const dependency of issue.dependencyKeys) {
      if (dependency === issue.key || !byKey.has(dependency)) {
        throw new DurableLinearContractError(
          `Issue ${issue.key} has an unknown or self dependency ${dependency}.`,
        );
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (key: string) => {
    if (visiting.has(key)) {
      throw new DurableLinearContractError("Research project issue dependencies contain a cycle.");
    }
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependencyKeys ?? []) visit(dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const issue of issues) visit(issue.key);
}

function normalizeProjectLifecycleIntent(
  input: ProjectLifecycleIntentUnsignedV1,
): ProjectLifecycleIntentUnsignedV1 {
  const record = expectPlainRecord(input, "project lifecycle intent");
  const stages = parseUniqueStrings(
    record.stages,
    "project lifecycle stage",
    1,
    PROJECT_LIFECYCLE_STAGES.length,
    64,
    (value, label) => expectEnum(value, label, PROJECT_LIFECYCLE_STAGES),
  ) as ProjectLifecycleStageV1[];
  const ordered = PROJECT_LIFECYCLE_STAGES.filter((stage) => stages.includes(stage));
  if (ordered.join("\0") !== stages.join("\0")) {
    throw new DurableLinearContractError("Project lifecycle stages must use canonical lifecycle order.");
  }
  return {
    runId: expectOpaqueId(record.runId, "project lifecycle run id"),
    exactUserCommand: expectString(record.exactUserCommand, "project lifecycle exact user command", 1, 8_000, {
      allowNewlines: true,
      secretFree: true,
    }),
    stages,
    requestedAt: expectIsoTimestamp(record.requestedAt, "project lifecycle requested at"),
  };
}

function fixedProjectLifecycleIntent(
  input: ProjectLifecycleIntentUnsignedV1,
): Omit<ProjectLifecycleIntentV1, "fingerprint"> {
  return {
    schemaVersion: PROJECT_LIFECYCLE_INTENT_SCHEMA_VERSION,
    kind: "project_lifecycle_intent",
    ...input,
  };
}

function buildProjectLineage(input: {
  lineageId: unknown;
  runId: unknown;
  vaultBindingKey: unknown;
  commits: Array<{
    stage: ProjectLifecycleStageV1;
    committedAt: unknown;
    proof: ProjectLifecycleStageProofV1;
  }>;
  updatedAt: unknown;
}): ProjectLineageV1 {
  if (input.commits.length < 1 || input.commits.length > PROJECT_LIFECYCLE_STAGES.length) {
    throw new DurableLinearContractError("Project lineage requires 1-5 committed stages.");
  }
  const commits = input.commits.map((commit, index) => {
    const proof = parseStageProof(commit.proof);
    const expected = PROJECT_LIFECYCLE_STAGES[index];
    if (commit.stage !== expected || proof.stage !== expected) {
      throw new DurableLinearContractError("Project lineage stages must be complete, unique, and in canonical order.");
    }
    return {
      stage: expected,
      committedAt: expectIsoTimestamp(commit.committedAt, `${expected} committed at`),
      proof,
      proofFingerprint: fingerprintContract(proof),
    } satisfies ProjectLifecycleStageCommitV1;
  });
  const updatedAt = expectIsoTimestamp(input.updatedAt, "project lineage updated at");
  if (updatedAt !== commits.at(-1)!.committedAt) {
    throw new DurableLinearContractError("Project lineage updatedAt must equal its latest committed stage time.");
  }
  for (let index = 1; index < commits.length; index += 1) {
    if (Date.parse(commits[index].committedAt) < Date.parse(commits[index - 1].committedAt)) {
      throw new DurableLinearContractError("Project lineage commit timestamps must be monotonic.");
    }
  }
  const fixed = {
    schemaVersion: PROJECT_LINEAGE_SCHEMA_VERSION,
    kind: "project_lineage" as const,
    lineageId: expectLogicalKey(input.lineageId, "project lineage id", 160),
    runId: expectOpaqueId(input.runId, "project lineage run id"),
    vaultBindingKey: expectLogicalKey(input.vaultBindingKey, "project lineage vault binding key"),
    commits,
    updatedAt,
  };
  const { updatedAt: _updatedAt, ...stableFixed } = fixed;
  const stable = {
    ...stableFixed,
    commits: commits.map(({ committedAt: _committedAt, ...commit }) => commit),
  };
  return { ...fixed, fingerprint: fingerprintContract(stable) };
}

function clone<T>(value: T): T {
  return value === undefined
    ? value
    : (JSON.parse(JSON.stringify(value)) as T);
}

function parseCommits(value: unknown): ProjectLifecycleStageCommitV1[] {
  if (!Array.isArray(value)) {
    throw new DurableLinearContractError("Project lineage commits must be an array.");
  }
  return value.map((raw, index) => {
    const record = expectPlainRecord(raw, `project lineage commit ${index + 1}`);
    assertExactKeys(record, ["stage", "committedAt", "proof", "proofFingerprint"], [], `project lineage commit ${index + 1}`);
    const stage = expectEnum(record.stage, `project lineage commit ${index + 1} stage`, PROJECT_LIFECYCLE_STAGES);
    const proof = parseStageProof(record.proof);
    const proofFingerprint = expectSha256(record.proofFingerprint, `project lineage commit ${index + 1} proof fingerprint`);
    const expected = fingerprintContract(proof);
    if (!constantTimeFingerprintEqual(proofFingerprint, expected)) {
      throw new DurableLinearContractError(`Project lineage commit ${index + 1} proof fingerprint is invalid.`);
    }
    return {
      stage,
      committedAt: expectIsoTimestamp(record.committedAt, `project lineage commit ${index + 1} committed at`),
      proof,
      proofFingerprint,
    };
  });
}

function parseStageProof(value: unknown): ProjectLifecycleStageProofV1 {
  const record = expectPlainRecord(value, "project lifecycle stage proof");
  const stage = expectEnum(record.stage, "project lifecycle stage proof stage", PROJECT_LIFECYCLE_STAGES);
  switch (stage) {
    case "accepted_research":
      assertExactKeys(record, ["stage", "artifactFingerprint", "notePath", "noteSha256", "researcherHandoffFingerprint"], [], "accepted research lineage proof");
      return {
        stage,
        artifactFingerprint: expectSha256(record.artifactFingerprint, "accepted research artifact fingerprint"),
        notePath: parseVaultMarkdownPath(record.notePath, "accepted research note path"),
        noteSha256: expectSha256(record.noteSha256, "accepted research note hash"),
        researcherHandoffFingerprint: expectSha256(record.researcherHandoffFingerprint, "researcher handoff fingerprint"),
      };
    case "linear_hierarchy":
      assertExactKeys(record, ["stage", "planFingerprint", "workspaceId", "teamId", "initiativeId", "projectId", "issueIds", "workItemFingerprints", "providerReadbackFingerprints"], [], "Linear hierarchy lineage proof");
      return {
        stage,
        planFingerprint: expectSha256(record.planFingerprint, "research project plan fingerprint"),
        workspaceId: expectOpaqueId(record.workspaceId, "Linear workspace id"),
        teamId: expectOpaqueId(record.teamId, "Linear team id"),
        initiativeId: expectOpaqueId(record.initiativeId, "Linear initiative id"),
        projectId: expectOpaqueId(record.projectId, "Linear project id"),
        issueIds: parseUniqueStrings(record.issueIds, "Linear issue id", 1, 20, 160, expectOpaqueId),
        workItemFingerprints: parseUniqueStrings(record.workItemFingerprints, "work item fingerprint", 1, 20, 72, expectSha256),
        providerReadbackFingerprints: parseUniqueStrings(record.providerReadbackFingerprints, "Linear readback fingerprint", 3, 22, 72, expectSha256),
      };
    case "code_execution":
      assertExactKeys(record, ["stage", "repositoryProfileKey", "repositoryProfileFingerprint", "workspaceId", "validationReceiptFingerprints", "targetedValidationPassed", "freshFullValidationPassed", "commitSha", "commitReadbackFingerprint"], [], "code execution lineage proof");
      if (record.targetedValidationPassed !== true || record.freshFullValidationPassed !== true) {
        throw new DurableLinearContractError("Code lineage requires targeted and fresh-full validation proof.");
      }
      return {
        stage,
        repositoryProfileKey: expectLogicalKey(record.repositoryProfileKey, "repository profile key"),
        repositoryProfileFingerprint: expectSha256(record.repositoryProfileFingerprint, "repository profile fingerprint"),
        workspaceId: expectOpaqueId(record.workspaceId, "code workspace id"),
        validationReceiptFingerprints: parseUniqueStrings(record.validationReceiptFingerprints, "validation receipt fingerprint", 2, 20, 72, expectSha256),
        targetedValidationPassed: true,
        freshFullValidationPassed: true,
        commitSha: gitSha(record.commitSha, "local commit SHA"),
        commitReadbackFingerprint: expectSha256(record.commitReadbackFingerprint, "commit readback fingerprint"),
      };
    case "private_github_publication":
      assertExactKeys(record, ["stage", "trustedBindingFingerprint", "owner", "repository", "verifiedPrivate", "branch", "pullRequestNumber", "draft", "remoteSha", "repositoryReadbackFingerprint", "pullRequestReadbackFingerprint"], [], "private GitHub publication lineage proof");
      if (record.verifiedPrivate !== true || record.draft !== true) {
        throw new DurableLinearContractError("GitHub publication lineage requires private visibility and a draft pull request.");
      }
      return {
        stage,
        trustedBindingFingerprint: expectSha256(record.trustedBindingFingerprint, "trusted GitHub binding fingerprint"),
        owner: githubName(record.owner, "GitHub owner"),
        repository: githubName(record.repository, "GitHub repository"),
        verifiedPrivate: true,
        branch: gitBranch(record.branch),
        pullRequestNumber: expectInteger(record.pullRequestNumber, "GitHub pull request number", 1, 2_147_483_647),
        draft: true,
        remoteSha: gitSha(record.remoteSha, "remote GitHub SHA"),
        repositoryReadbackFingerprint: expectSha256(record.repositoryReadbackFingerprint, "GitHub repository readback fingerprint"),
        pullRequestReadbackFingerprint: expectSha256(record.pullRequestReadbackFingerprint, "GitHub pull request readback fingerprint"),
      };
    case "reconciliation_cleanup":
      assertExactKeys(record, ["stage", "backlinkReceiptFingerprints", "providerStatusReadbackFingerprints", "cleanupReceiptFingerprints", "noUnapprovedMutations"], [], "reconciliation cleanup lineage proof");
      if (record.noUnapprovedMutations !== true) {
        throw new DurableLinearContractError("Lifecycle completion requires proof of no unapproved mutations.");
      }
      return {
        stage,
        backlinkReceiptFingerprints: parseUniqueStrings(record.backlinkReceiptFingerprints, "backlink receipt fingerprint", 1, 20, 72, expectSha256),
        providerStatusReadbackFingerprints: parseUniqueStrings(record.providerStatusReadbackFingerprints, "provider status readback fingerprint", 1, 40, 72, expectSha256),
        cleanupReceiptFingerprints: parseUniqueStrings(record.cleanupReceiptFingerprints, "cleanup receipt fingerprint", 1, 40, 72, expectSha256),
        noUnapprovedMutations: true,
      };
  }
}

function assertLineageContinuity(
  lineage: ProjectLineageV1,
  proof: ProjectLifecycleStageProofV1,
): void {
  const accepted = lineage.commits[0].proof as AcceptedResearchLineageProofV1;
  if (proof.stage === "linear_hierarchy") {
    // The plan is separately fingerprint-bound to the accepted artifact. Its
    // readback proof must be independent of the plan fingerprint itself.
    if (new Set(proof.providerReadbackFingerprints).size < 3) {
      throw new DurableLinearContractError("Linear hierarchy requires independent initiative, project, and issue readbacks.");
    }
  }
  if (proof.stage === "private_github_publication") {
    const code = lineage.commits.find((commit) => commit.stage === "code_execution")
      ?.proof as CodeExecutionLineageProofV1 | undefined;
    if (!code || proof.remoteSha !== code.commitSha) {
      throw new DurableLinearContractError("GitHub publication remote SHA must equal the verified local commit SHA.");
    }
  }
  if (!accepted.artifactFingerprint || !accepted.notePath) {
    throw new DurableLinearContractError("Project lineage lost its accepted research binding.");
  }
}

function cleanNarrative(value: unknown, label: string, maximumLength: number): string {
  const text = expectString(value, label, 1, maximumLength, {
    allowNewlines: true,
    secretFree: true,
  });
  assertNoRawAuthority(text, label);
  return text;
}

function parseNarrativeList(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  maximumLength: number,
): string[] {
  if (!Array.isArray(value) || value.length < minimum || value.length > maximum) {
    throw new DurableLinearContractError(`${label} list requires ${minimum}-${maximum} entries.`);
  }
  const parsed = value.map((entry, index) => cleanNarrative(entry, `${label} ${index + 1}`, maximumLength));
  if (new Set(parsed).size !== parsed.length) {
    throw new DurableLinearContractError(`${label} list must not contain duplicates.`);
  }
  return parsed;
}

function stageObjective(stage: ProjectLifecycleStageV1): string {
  switch (stage) {
    case "accepted_research":
      return "Produce and host-accept one evidence-bound research package.";
    case "linear_hierarchy":
      return "Prepare, approve once, create or deduplicate, and independently read back one Linear initiative/project/issues hierarchy.";
    case "code_execution":
      return "Resume one trusted workspace, implement the approved work, validate targeted and fresh-full, commit, and read the commit back.";
    case "private_github_publication":
      return "Verify private repository visibility, publish the exact verified commit, and independently read back the draft pull request.";
    case "reconciliation_cleanup":
      return "Reconcile backlinks and provider state, then independently verify approved cleanup without replay.";
  }
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/u.test(value)) {
    throw new DurableLinearContractError(`${label} must be a lowercase 40-character Git SHA.`);
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

function gitBranch(value: unknown): string {
  const branch = expectString(value, "GitHub branch", 1, 255, { secretFree: true });
  if (
    branch.startsWith("-") || branch.startsWith("/") || branch.endsWith("/") ||
    branch.endsWith(".") || branch.includes("..") || branch.includes("@{") ||
    /[~^:?*[\\\s\]]/u.test(branch)
  ) {
    throw new DurableLinearContractError("GitHub branch is invalid.");
  }
  return branch;
}
