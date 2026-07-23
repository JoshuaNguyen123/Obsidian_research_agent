import type { MissionLedger } from "./missionLedger";
import type {
  AcceptedResearchLineageProofV1,
  CodeExecutionLineageProofV1,
  LinearHierarchyLineageProofV1,
  PrivateGitHubPublicationLineageProofV1,
  ProjectLineageV1,
} from "./projectLifecycle";

export type PipelineStageStateV1 =
  | "verified"
  | "missing"
  | "not_requested"
  | "chat_only_not_persisted";

export interface PipelineLineageReflectionV1 {
  state:
    | "verified"
    | "missing"
    | "not_requested"
    | "chat_only_not_persisted";
  path?: string;
  contentHash?: string;
}

export interface PipelineLineageV1 {
  version: 1;
  lineageId: string;
  runId: string;
  source: {
    state: PipelineStageStateV1;
    notePath?: string;
    contentHash?: string;
    researchArtifactFingerprint?: string;
  };
  linear: {
    state: PipelineStageStateV1;
    planFingerprint?: string;
    issueIds: string[];
    workItemSpecFingerprints: string[];
    providerReadbackFingerprints: string[];
  };
  workspace: {
    state: PipelineStageStateV1;
    repositoryProfileKey?: string;
    repositoryProfileFingerprint?: string;
    workspaceId?: string;
  };
  validation: {
    state: PipelineStageStateV1;
    diffFingerprint?: string;
    receiptFingerprints: string[];
    targetedPassed: boolean;
    fullPassed: boolean;
  };
  commit: {
    state: PipelineStageStateV1;
    sha?: string;
    readbackFingerprint?: string;
  };
  github: {
    state: PipelineStageStateV1;
    owner?: string;
    repository?: string;
    branch?: string;
    draftPullRequestNumber?: number;
    headSha?: string;
    repositoryReadbackFingerprint?: string;
    pullRequestReadbackFingerprint?: string;
  };
  reflection: PipelineLineageReflectionV1;
  gaps: string[];
  verified: boolean;
}

export interface ReflectionContextV1 {
  version: 1;
  runId: string;
  observedFacts: string[];
  interpretations: string[];
  failedAttempts: string[];
  retries: string[];
  receiptIds: string[];
  unresolvedGaps: string[];
  persistence: PipelineLineageReflectionV1["state"];
  pipeline: PipelineLineageV1 | null;
}

export function buildPipelineLineageV1(input: {
  lineage: ProjectLineageV1;
  reflection?: PipelineLineageReflectionV1;
}): PipelineLineageV1 {
  const research = findProof<AcceptedResearchLineageProofV1>(
    input.lineage,
    "accepted_research",
  );
  const linear = findProof<LinearHierarchyLineageProofV1>(
    input.lineage,
    "linear_hierarchy",
  );
  const code = findProof<CodeExecutionLineageProofV1>(
    input.lineage,
    "code_execution",
  );
  const github = findProof<PrivateGitHubPublicationLineageProofV1>(
    input.lineage,
    "private_github_publication",
  );
  const reflection = input.reflection ?? { state: "not_requested" };
  const gaps: string[] = [];
  if (!research) gaps.push("source_note_and_research_artifact");
  if (!linear) gaps.push("linear_work_item_readback");
  if (!code) {
    gaps.push("workspace_validation_and_commit");
  } else if (!code.diffFingerprint) {
    gaps.push("code_diff_fingerprint");
  }
  if (!github) {
    gaps.push("draft_pull_request_readback");
  } else if (code && github.remoteSha !== code.commitSha) {
    gaps.push("commit_pr_head_sha_mismatch");
  }
  if (
    reflection.state === "verified" &&
    (!reflection.path || !reflection.contentHash)
  ) {
    gaps.push("reflection_artifact_proof");
  } else if (reflection.state === "missing") {
    gaps.push("reflection_artifact_proof");
  }

  return {
    version: 1,
    lineageId: input.lineage.lineageId,
    runId: input.lineage.runId,
    source: research
      ? {
          state: "verified",
          notePath: research.notePath,
          contentHash: research.noteSha256,
          researchArtifactFingerprint: research.artifactFingerprint,
        }
      : { state: "missing" },
    linear: linear
      ? {
          state: "verified",
          planFingerprint: linear.planFingerprint,
          issueIds: [...linear.issueIds],
          workItemSpecFingerprints: [...linear.workItemFingerprints],
          providerReadbackFingerprints: [
            ...linear.providerReadbackFingerprints,
          ],
        }
      : {
          state: "missing",
          issueIds: [],
          workItemSpecFingerprints: [],
          providerReadbackFingerprints: [],
        },
    workspace: code
      ? {
          state: "verified",
          repositoryProfileKey: code.repositoryProfileKey,
          repositoryProfileFingerprint: code.repositoryProfileFingerprint,
          workspaceId: code.workspaceId,
        }
      : { state: "missing" },
    validation: code
      ? {
          state:
            code.targetedValidationPassed && code.freshFullValidationPassed
              ? "verified"
              : "missing",
          ...(code.diffFingerprint
            ? { diffFingerprint: code.diffFingerprint }
            : {}),
          receiptFingerprints: [...code.validationReceiptFingerprints],
          targetedPassed: code.targetedValidationPassed,
          fullPassed: code.freshFullValidationPassed,
        }
      : {
          state: "missing",
          receiptFingerprints: [],
          targetedPassed: false,
          fullPassed: false,
        },
    commit: code
      ? {
          state: "verified",
          sha: code.commitSha,
          readbackFingerprint: code.commitReadbackFingerprint,
        }
      : { state: "missing" },
    github: github
      ? {
          state:
            code && github.remoteSha === code.commitSha
              ? "verified"
              : "missing",
          owner: github.owner,
          repository: github.repository,
          branch: github.branch,
          draftPullRequestNumber: github.pullRequestNumber,
          headSha: github.remoteSha,
          repositoryReadbackFingerprint:
            github.repositoryReadbackFingerprint,
          pullRequestReadbackFingerprint:
            github.pullRequestReadbackFingerprint,
        }
      : { state: "missing" },
    reflection: { ...reflection },
    gaps,
    verified: gaps.length === 0,
  };
}

export function buildReflectionContextV1(input: {
  runId: string;
  ledger: MissionLedger | null;
  pipeline: PipelineLineageV1 | null;
  persistence: PipelineLineageReflectionV1["state"];
}): ReflectionContextV1 {
  const ledger = input.ledger;
  const milestones = ledger?.milestones ?? [];
  const observedFacts = milestones
    .filter((item) => !item.error)
    .map(
      (item) =>
        `${item.stage}: ${item.summary}${
          item.toolCalls?.length
            ? ` [tools: ${item.toolCalls.join(", ")}]`
            : ""
        }`,
    );
  const failedAttempts = milestones
    .filter((item) => Boolean(item.error))
    .map((item) => `${item.stage}: ${item.error}`);
  const retries = milestones
    .filter(
      (item) =>
        /\b(?:retry|repair|reconcile|correct)\b/iu.test(item.summary) ||
        /\b(?:retry|repair|reconcile|correct)\b/iu.test(item.decision ?? ""),
    )
    .map((item) => `${item.stage}: ${item.summary}`);
  const unresolvedGaps = [
    ...(input.pipeline?.gaps ?? []),
    ...(ledger?.remainingActions ?? []),
    ...(ledger?.blockers ?? []),
  ].filter((value, index, all) => value && all.indexOf(value) === index);

  return {
    version: 1,
    runId: input.runId,
    observedFacts,
    interpretations: [],
    failedAttempts,
    retries,
    receiptIds: [...(ledger?.receipts ?? [])],
    unresolvedGaps,
    persistence: input.persistence,
    pipeline: input.pipeline,
  };
}

export function formatPipelineTimelineV1(
  pipeline: PipelineLineageV1,
): string {
  return [
    ["Note", pipeline.source.state, pipeline.source.notePath],
    [
      "Research",
      pipeline.source.state,
      pipeline.source.researchArtifactFingerprint,
    ],
    ["Linear", pipeline.linear.state, pipeline.linear.issueIds.join(", ")],
    ["Workspace", pipeline.workspace.state, pipeline.workspace.workspaceId],
    [
      "Validation",
      pipeline.validation.state,
      // Timeline keeps fingerprints in Run Details; note prose uses status only.
      pipeline.validation.state === "verified"
        ? "targeted+full"
        : pipeline.validation.targetedPassed
          ? "targeted"
          : undefined,
    ],
    ["Commit", pipeline.commit.state, pipeline.commit.sha],
    [
      "Draft PR",
      pipeline.github.state,
      pipeline.github.draftPullRequestNumber
        ? `#${pipeline.github.draftPullRequestNumber} @ ${pipeline.github.headSha}`
        : undefined,
    ],
    ["Reflection", pipeline.reflection.state, pipeline.reflection.path],
  ]
    .map(
      ([label, state, identifier]) =>
        `${label}: ${state}${identifier ? ` (${identifier})` : ""}`,
    )
    .join(" -> ");
}

/** Deterministic public GitHub repository URL from lineage owner/repo. */
export function buildGitHubRepositoryUrlV1(
  owner: string,
  repository: string,
): string {
  return `https://github.com/${owner.trim()}/${repository.trim()}`;
}

/** Deterministic public GitHub pull-request URL from lineage fields. */
export function buildGitHubPullRequestUrlV1(
  owner: string,
  repository: string,
  pullRequestNumber: number,
): string {
  return `${buildGitHubRepositoryUrlV1(owner, repository)}/pull/${pullRequestNumber}`;
}

/**
 * Citeable pipeline facts for initiating-note prose.
 * Excludes receipt fingerprints and other Run Details-only material.
 */
export interface PipelineCiteFactsV1 {
  notePath?: string;
  linearIssueIds: string[];
  owner?: string;
  repository?: string;
  branch?: string;
  pullRequestNumber?: number;
  commitSha?: string;
  headSha?: string;
  validation: {
    targetedPassed: boolean;
    fullPassed: boolean;
    state: PipelineStageStateV1;
  };
  gaps: string[];
}

export function extractPipelineCiteFactsV1(
  pipeline: PipelineLineageV1 | null | undefined,
): PipelineCiteFactsV1 {
  if (!pipeline) {
    return {
      linearIssueIds: [],
      validation: {
        targetedPassed: false,
        fullPassed: false,
        state: "not_requested",
      },
      gaps: [],
    };
  }
  return {
    ...(pipeline.source.notePath
      ? { notePath: pipeline.source.notePath }
      : {}),
    linearIssueIds: [...pipeline.linear.issueIds],
    ...(pipeline.github.owner ? { owner: pipeline.github.owner } : {}),
    ...(pipeline.github.repository
      ? { repository: pipeline.github.repository }
      : {}),
    ...(pipeline.github.branch ? { branch: pipeline.github.branch } : {}),
    ...(typeof pipeline.github.draftPullRequestNumber === "number"
      ? { pullRequestNumber: pipeline.github.draftPullRequestNumber }
      : {}),
    ...(pipeline.commit.sha ? { commitSha: pipeline.commit.sha } : {}),
    ...(pipeline.github.headSha ? { headSha: pipeline.github.headSha } : {}),
    validation: {
      targetedPassed: pipeline.validation.targetedPassed,
      fullPassed: pipeline.validation.fullPassed,
      state: pipeline.validation.state,
    },
    gaps: [...pipeline.gaps],
  };
}

function findProof<T extends { stage: string }>(
  lineage: ProjectLineageV1,
  stage: T["stage"],
): T | null {
  const commit = lineage.commits.find((item) => item.stage === stage);
  return commit?.proof.stage === stage
    ? (commit.proof as unknown as T)
    : null;
}
