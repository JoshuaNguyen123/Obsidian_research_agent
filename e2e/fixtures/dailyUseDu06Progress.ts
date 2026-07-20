import { createHash } from "node:crypto";

const FULL_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const LIFECYCLE_STAGES = [
  "accepted_research",
  "linear_hierarchy",
  "code_execution",
  "private_github_publication",
  "reconciliation_cleanup",
] as const;

export interface DailyUseDu06SafeLifecycleState {
  lineages: any[];
  researchPublications: any[];
  linearHierarchies: any[];
  privateRepositories: any[];
  githubPublications: any[];
  repositoryCleanups: any[];
  privateBindings: any[];
  codeHandoff: any | null;
}

export interface DailyUseDu06ProgressInput {
  state: DailyUseDu06SafeLifecycleState | null;
  expected: {
    notePath: string;
    repositoryProfileKey: string;
    baseSha: string;
    githubOwner: string;
    githubRepository: string;
  };
  researchNotebookVerified: boolean;
  cleanup: {
    linearOwnedResourceCount: number;
    linearAbsenceVerified: boolean;
    githubOwnedResourceObserved: boolean;
    githubAbsenceVerified: boolean;
    localOwnedResourceObserved: boolean;
    localAbsenceVerified: boolean;
    independentVerified: boolean;
  };
}

export interface DailyUseDu06ProgressObservations {
  artifacts: string[];
  proofs: string[];
  approvals: string[];
  bindings: string[];
  cleanup: string[];
}

export interface DailyUseDu06RetainedLinearEvidenceV1 {
  version: 1;
  scenarioId: "DU-06";
  releaseSha: string;
  providerIssueFingerprint: string;
  providerReadbackVerified: true;
}

export function createDu06RetainedLinearEvidenceProof(input: {
  releaseSha: string;
  providerIssueId: string;
}): DailyUseDu06RetainedLinearEvidenceV1 {
  const releaseSha = input.releaseSha.trim().toLowerCase();
  const providerIssueId = input.providerIssueId.trim().toLowerCase();
  if (!FULL_SHA.test(releaseSha)) {
    throw new Error("DU-06 retained Linear evidence requires one exact release SHA.");
  }
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(providerIssueId)) {
    throw new Error("DU-06 retained Linear evidence requires one opaque provider issue ID.");
  }
  return {
    version: 1,
    scenarioId: "DU-06",
    releaseSha,
    providerIssueFingerprint: sha256(providerIssueId),
    providerReadbackVerified: true,
  };
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

/**
 * Projects only one exact DU-06 lineage into failed-run acceptance tokens.
 * Persisted namespaces may contain older runs, so no stage can borrow a
 * checkpoint from a different note, profile, commit, owner, or repository.
 */
export function buildProgressiveDu06Observations(
  input: DailyUseDu06ProgressInput,
): DailyUseDu06ProgressObservations {
  const artifacts = new Set<string>();
  const proofs = new Set<string>();
  const approvals = new Set<string>();
  const bindings = new Set<string>();
  const cleanup = new Set<string>();
  const state = input.state;

  const lineage = state
    ? exactlyOne(state.lineages.filter((candidate) =>
        isCurrentLineage(candidate, input.expected.notePath)))
    : null;
  const commits = lineage?.commits as any[] | undefined;
  const acceptedCommit = commits?.find(
    (commit) => commit?.stage === "accepted_research",
  ) ?? null;
  const acceptedProof = acceptedCommit?.proof ?? null;
  const research = state && acceptedProof
    ? exactlyOne(state.researchPublications.filter(
        (item) =>
          item?.status === "complete" &&
          item?.notePath === input.expected.notePath &&
          item?.artifactFingerprint === acceptedProof.artifactFingerprint &&
          SHA256.test(String(item?.artifactFingerprint ?? "")) &&
          Boolean(item?.issueId) &&
          item?.backlinkVerified === true,
      ))
    : null;
  if (lineage && acceptedCommit && research) {
    artifacts.add("vault:research_note");
    if (input.researchNotebookVerified) {
      artifacts.add("vault:checkers_rules_notebook");
    }
    proofs.add("research:accepted");
    approvals.add("approval:linear_issue_create");
    bindings.add("binding:note_linear_issue");
    bindings.add("binding:project_lineage");
  }

  const linearCommit = research
    ? commits?.find((commit) => commit?.stage === "linear_hierarchy") ?? null
    : null;
  const linearProof = linearCommit?.proof ?? null;
  const hierarchy = state && linearProof
    ? exactlyOne(state.linearHierarchies.filter((item) =>
        isMatchingLinearHierarchy(item, linearProof)))
    : null;
  if (hierarchy) {
    artifacts.add("linear:initiative");
    artifacts.add("linear:project");
    artifacts.add("linear:issue");
    artifacts.add("linear:checkers_implementation_issue");
    artifacts.add("linear:issue_readback");
    proofs.add("linear:hierarchy_readback");
    proofs.add("linear:provider_readback");
    approvals.add("approval:linear_hierarchy_group");
  }

  const codeCommit = hierarchy
    ? commits?.find((commit) => commit?.stage === "code_execution") ?? null
    : null;
  const codeProof = codeCommit?.proof ?? null;
  const codeHandoff = state?.codeHandoff ?? null;
  const codeVerified = Boolean(
    codeProof &&
      codeProof.stage === "code_execution" &&
      codeProof.repositoryProfileKey === input.expected.repositoryProfileKey &&
      codeProof.targetedValidationPassed === true &&
      codeProof.freshFullValidationPassed === true &&
      FULL_SHA.test(String(codeProof.commitSha ?? "")) &&
      codeHandoff?.status === "verified" &&
      codeHandoff.repositoryProfileKey === input.expected.repositoryProfileKey &&
      codeHandoff.repositoryProfileFingerprint ===
        codeProof.repositoryProfileFingerprint &&
      codeHandoff.workspaceId === codeProof.workspaceId &&
      codeHandoff.baseSha === input.expected.baseSha &&
      codeHandoff.commitSha === codeProof.commitSha &&
      Boolean(codeHandoff.targetedValidationReceiptId) &&
      Boolean(codeHandoff.fullValidationReceiptId) &&
      codeHandoff.targetedValidationReceiptId !==
        codeHandoff.fullValidationReceiptId &&
      SHA256.test(String(codeHandoff.targetedValidationFingerprint ?? "")) &&
      SHA256.test(String(codeHandoff.fullValidationFingerprint ?? "")) &&
      Array.isArray(codeProof.validationReceiptFingerprints) &&
      codeProof.validationReceiptFingerprints.includes(
        codeHandoff.targetedValidationFingerprint,
      ) &&
      codeProof.validationReceiptFingerprints.includes(
        codeHandoff.fullValidationFingerprint,
      ) &&
      SHA256.test(String(codeProof.commitReadbackFingerprint ?? "")),
  );
  if (codeVerified) {
    artifacts.add("code:python_checkers");
    artifacts.add("git:local_commit");
    proofs.add("code:checkers_rules_contract");
    proofs.add("code:workspace_validated");
    proofs.add("validation:fresh_full");
    proofs.add("git:exact_commit_sha");
    proofs.add("git:commit_readback");
    approvals.add("approval:sandbox_execution");
    bindings.add("binding:notebook_linear_code");
  }

  const githubCommit = codeVerified
    ? commits?.find(
        (commit) => commit?.stage === "private_github_publication",
      ) ?? null
    : null;
  const githubProof = githubCommit?.proof ?? null;
  const privateRepository = state && githubProof
    ? exactlyOne(state.privateRepositories.filter((item) =>
        isMatchingPrivateRepository(item, githubProof, input.expected)))
    : null;
  const publication = state && githubProof && privateRepository
    ? exactlyOne(state.githubPublications.filter((item) =>
        isMatchingGitHubPublication(
          item,
          githubProof,
          codeHandoff,
          privateRepository,
        )))
    : null;
  if (privateRepository && publication) {
    artifacts.add("github:private_repository");
    artifacts.add("github:draft_pr");
    proofs.add("github:private_visibility_readback");
    proofs.add("github:remote_sha_readback");
    proofs.add("github:draft_pr_readback");
    approvals.add("approval:github_private_repository_create");
    approvals.add("approval:github_publish");
    bindings.add("binding:note_commit_pr");
    bindings.add("binding:linear_commit_pr");
  }

  const linearOwned = Number.isSafeInteger(
    input.cleanup.linearOwnedResourceCount,
  ) && input.cleanup.linearOwnedResourceCount > 0;
  if (linearOwned && input.cleanup.linearAbsenceVerified) {
    cleanup.add("cleanup:linear_fixture");
  }
  if (
    input.cleanup.githubOwnedResourceObserved &&
    input.cleanup.githubAbsenceVerified
  ) {
    cleanup.add("cleanup:github_fixture");
  }
  const anyOwned =
    linearOwned ||
    input.cleanup.githubOwnedResourceObserved ||
    input.cleanup.localOwnedResourceObserved;
  const everyOwnedCategoryAbsent =
    (!linearOwned || input.cleanup.linearAbsenceVerified) &&
    (!input.cleanup.githubOwnedResourceObserved ||
      input.cleanup.githubAbsenceVerified) &&
    (!input.cleanup.localOwnedResourceObserved ||
      input.cleanup.localAbsenceVerified);
  if (
    anyOwned &&
    everyOwnedCategoryAbsent &&
    input.cleanup.independentVerified
  ) {
    cleanup.add("cleanup:independent_readback");
  }

  return {
    artifacts: [...artifacts].sort(),
    proofs: [...proofs].sort(),
    approvals: [...approvals].sort(),
    bindings: [...bindings].sort(),
    cleanup: [...cleanup].sort(),
  };
}

function isCurrentLineage(lineage: any, notePath: string): boolean {
  if (
    !lineage ||
    !SHA256.test(String(lineage.fingerprint ?? "")) ||
    !Array.isArray(lineage.commits) ||
    lineage.commits.length < 1 ||
    lineage.commits.length > LIFECYCLE_STAGES.length
  ) {
    return false;
  }
  if (!lineage.commits.every((commit: any, index: number) =>
    commit?.stage === LIFECYCLE_STAGES[index] &&
    commit?.proof?.stage === commit.stage &&
    SHA256.test(String(commit?.proofFingerprint ?? "")))) {
    return false;
  }
  const accepted = lineage.commits[0]?.proof;
  return accepted?.notePath === notePath &&
    SHA256.test(String(accepted?.artifactFingerprint ?? "")) &&
    SHA256.test(String(accepted?.noteSha256 ?? ""));
}

function isMatchingLinearHierarchy(item: any, proof: any): boolean {
  if (
    !item ||
    item.status !== "complete" ||
    item.planFingerprint !== proof?.planFingerprint ||
    !Boolean(item.approvalId) ||
    !Boolean(item.grantId) ||
    !Array.isArray(item.items) ||
    item.items.length < 4 ||
    !Array.isArray(proof?.issueIds) ||
    !Array.isArray(proof?.providerReadbackFingerprints)
  ) {
    return false;
  }
  if (!item.items.every((child: any) =>
    ["committed", "deduplicated"].includes(String(child?.status ?? "")) &&
    Boolean(child?.resourceId) &&
    SHA256.test(String(child?.readbackFingerprint ?? "")) &&
    proof.providerReadbackFingerprints.includes(child.readbackFingerprint))) {
    return false;
  }
  const initiatives = item.items.filter((child: any) => child.kind === "initiative");
  const projects = item.items.filter((child: any) => child.kind === "project");
  const links = item.items.filter(
    (child: any) => child.kind === "initiative_project_link",
  );
  const issues = item.items.filter((child: any) => child.kind === "issue");
  return initiatives.length === 1 &&
    projects.length === 1 &&
    links.length === 1 &&
    issues.length === 1 &&
    initiatives[0].resourceId === proof.initiativeId &&
    projects[0].resourceId === proof.projectId &&
    sameStrings(
      issues.map((child: any) => child.resourceId),
      proof.issueIds,
    );
}

function isMatchingPrivateRepository(
  item: any,
  proof: any,
  expected: DailyUseDu06ProgressInput["expected"],
): boolean {
  return item?.status === "verified" &&
    item?.profileKey === expected.repositoryProfileKey &&
    item?.owner === expected.githubOwner &&
    item?.repository === expected.githubRepository &&
    Boolean(item?.approvalId) &&
    Boolean(item?.receiptId) &&
    item?.binding?.owner === proof?.owner &&
    item?.binding?.repository === proof?.repository &&
    item?.binding?.verifiedPrivate === true &&
    item?.binding?.fingerprint === proof?.trustedBindingFingerprint &&
    item?.binding?.repositoryProfileKey === expected.repositoryProfileKey &&
    item?.binding?.repositoryReadbackFingerprint ===
      proof?.repositoryReadbackFingerprint &&
    SHA256.test(String(item?.binding?.repositoryReadbackFingerprint ?? "")) &&
    proof?.owner === expected.githubOwner &&
    proof?.repository === expected.githubRepository &&
    proof?.verifiedPrivate === true &&
    proof?.draft === true &&
    SHA256.test(String(proof?.pullRequestReadbackFingerprint ?? ""));
}

function isMatchingGitHubPublication(
  item: any,
  proof: any,
  codeHandoff: any,
  privateRepository: any,
): boolean {
  return item?.status === "finalized" &&
    item?.handoffFingerprint === codeHandoff?.fingerprint &&
    item?.bindingFingerprint === privateRepository?.binding?.fingerprint &&
    Boolean(item?.publishApprovalFingerprint) &&
    item?.branch === proof?.branch &&
    String(item?.branch ?? "").startsWith("codex/") &&
    item?.remoteSha === proof?.remoteSha &&
    item?.remoteSha === codeHandoff?.commitSha &&
    FULL_SHA.test(String(item?.remoteSha ?? "")) &&
    item?.pullRequest?.number === proof?.pullRequestNumber &&
    item?.pullRequest?.draft === true &&
    item?.pullRequest?.state === "open" &&
    item?.pullRequest?.merged === false &&
    item?.pullRequest?.head?.sha === item.remoteSha &&
    item?.pullRequest?.head?.ref === item.branch &&
    Boolean(item?.linearLinkReceiptId) &&
    Boolean(item?.obsidianReceiptId);
}

function exactlyOne<T>(items: readonly T[]): T | null {
  return items.length === 1 ? items[0]! : null;
}

function sameStrings(left: readonly unknown[], right: readonly unknown[]): boolean {
  const normalize = (values: readonly unknown[]) =>
    values.map((value) => String(value)).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}
