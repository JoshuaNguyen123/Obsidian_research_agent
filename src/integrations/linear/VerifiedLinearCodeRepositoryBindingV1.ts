import type {
  VerifiedLinearCodeRepositoryBindingResolutionV1,
  VerifiedLinearCodeRepositoryBindingV1,
} from "../../tools/types";
import {
  CodePublicationLineageErrorV1,
  resolveQueueCodePublicationOriginV1,
} from "./CodePublicationLineageV1";
import {
  constantTimeFingerprintEqual,
  fingerprintContract,
} from "./LinearContractSupport";
import { parseResearchPublicationCheckpointV1 } from "./ResearchPublicationCheckpointStore";
import type { ResearchPublicationCheckpointV1 } from "./ResearchPublicationWorkflow";
import {
  parseRenderedCompatibleWorkItemSpec,
} from "./WorkItemParser";
import {
  WORK_ITEM_CONTRACT_V2_END,
  WORK_ITEM_CONTRACT_V2_START,
} from "./WorkItemRenderer";
import type { LinearIssueRecord } from "./types";

export interface ResolveVerifiedLinearCodeRepositoryBindingInputV1 {
  issueRecord: LinearIssueRecord | Record<string, unknown>;
  checkpoints: readonly ResearchPublicationCheckpointV1[];
  trustedRepositoryProfileKeys: readonly string[];
}

/**
 * Convert a fresh normalized Linear issue into repository authority only when
 * its signed code contract and the host's durable publication proof agree.
 * Linear prose and model-selected profile keys never cross this boundary.
 */
export function resolveVerifiedLinearCodeRepositoryBindingV1(
  input: ResolveVerifiedLinearCodeRepositoryBindingInputV1,
): VerifiedLinearCodeRepositoryBindingResolutionV1 {
  const issueRecord = input.issueRecord as Record<string, unknown>;
  const description =
    typeof issueRecord.description === "string"
      ? issueRecord.description
      : "";
  const hasV2Marker =
    description.includes(WORK_ITEM_CONTRACT_V2_START) ||
    description.includes(WORK_ITEM_CONTRACT_V2_END);
  if (!hasV2Marker) {
    return notApplicable(
      "linear_code_contract_absent",
      "The Linear issue does not contain a signed V2 work-item contract.",
    );
  }

  let parsed: ReturnType<typeof parseRenderedCompatibleWorkItemSpec>;
  try {
    parsed = parseRenderedCompatibleWorkItemSpec(description);
  } catch {
    return rejected(
      "linear_code_contract_invalid",
      "The Linear issue does not contain exactly one valid signed V2 work-item contract.",
    );
  }
  const workItem = parsed.spec;
  if (workItem.schemaVersion !== 2) {
    return notApplicable(
      "linear_code_contract_absent",
      "The Linear issue does not contain a signed V2 work-item contract.",
    );
  }
  if (workItem.executionClass !== "code") {
    return notApplicable(
      "linear_code_contract_non_code",
      "The signed V2 work item is not code work.",
    );
  }
  const repositoryProfileKey = workItem.repositoryKey;
  if (!repositoryProfileKey) {
    return rejected(
      "linear_code_contract_invalid",
      "The signed V2 code work item is missing its repository key.",
    );
  }

  const issue = parseCurrentIssueIdentity(issueRecord);
  if ("resolution" in issue) {
    return issue.resolution;
  }

  if (
    !input.trustedRepositoryProfileKeys.includes(repositoryProfileKey)
  ) {
    return rejected(
      "linear_code_repository_untrusted",
      "The signed repository key is not present in the host's trusted repository registry.",
    );
  }

  const snapshotResolution = verifyCurrentIssueSnapshot(issueRecord);
  if (snapshotResolution) {
    return snapshotResolution;
  }

  let checkpoints: ResearchPublicationCheckpointV1[];
  try {
    checkpoints = input.checkpoints.map((checkpoint) =>
      parseResearchPublicationCheckpointV1(checkpoint),
    );
  } catch {
    return rejected(
      "linear_code_checkpoint_invalid",
      "A durable research publication checkpoint is invalid.",
    );
  }

  let checkpoint: ResearchPublicationCheckpointV1;
  try {
    checkpoint = resolveQueueCodePublicationOriginV1(checkpoints, {
      issueId: issue.issueId,
      originRunId: workItem.originRunId,
      repositoryKey: repositoryProfileKey,
      workItemFingerprint: workItem.fingerprint,
      acceptedResearchArtifactFingerprint:
        workItem.acceptedResearchArtifactFingerprint,
    });
  } catch (error) {
    if (
      error instanceof CodePublicationLineageErrorV1 &&
      error.code === "code_publication_origin_ambiguous"
    ) {
      return rejected(
        "linear_code_publication_ambiguous",
        "More than one durable publication matches the signed Linear code work item.",
      );
    }
    return rejected(
      "linear_code_publication_unavailable",
      "No durable publication matches the signed Linear code work item.",
    );
  }

  if (
    checkpoint.status !== "complete" ||
    !checkpoint.binding ||
    !checkpoint.issue ||
    !checkpoint.backlink ||
    !checkpoint.lineage ||
    !checkpoint.workItemFingerprint
  ) {
    return rejected(
      "linear_code_publication_incomplete",
      "The matching research publication is missing complete durable proof.",
    );
  }

  const binding = checkpoint.binding;
  const checkpointIssue = checkpoint.issue;
  const lineage = checkpoint.lineage;
  if (
    issue.issueId !== checkpointIssue.id ||
    issue.issueId !== binding.issueId ||
    issue.issueIdentifier !== checkpointIssue.identifier ||
    issue.issueIdentifier !== binding.issueIdentifier ||
    issue.issueUrl !== checkpointIssue.url ||
    issue.issueUrl !== binding.issueUrl ||
    issue.teamId !== binding.teamId ||
    checkpoint.backlink.issueUrl !== issue.issueUrl
  ) {
    return rejected(
      "linear_code_issue_identity_mismatch",
      "The current Linear issue identity does not match its durable publication binding.",
    );
  }

  const issueUpdatedAtMs = Date.parse(issue.updatedAt);
  const checkpointIssueUpdatedAtMs = Date.parse(checkpointIssue.updatedAt);
  if (
    !Number.isFinite(issueUpdatedAtMs) ||
    !Number.isFinite(checkpointIssueUpdatedAtMs) ||
    issueUpdatedAtMs < checkpointIssueUpdatedAtMs
  ) {
    return rejected(
      "linear_code_issue_stale",
      "The current Linear issue predates its durable publication readback.",
    );
  }

  if (
    workItem.fingerprint !== checkpoint.workItemFingerprint ||
    workItem.fingerprint !== binding.workItemFingerprint ||
    workItem.fingerprint !== lineage.workItemFingerprint ||
    workItem.originRunId !== checkpoint.artifact.originRunId ||
    workItem.originRunId !== binding.originRunId ||
    workItem.originRunId !== lineage.originRunId ||
    workItem.acceptedResearchArtifactFingerprint !==
      checkpoint.artifact.artifactFingerprint ||
    workItem.acceptedResearchArtifactFingerprint !==
      binding.acceptedResearchArtifactFingerprint ||
    workItem.acceptedResearchArtifactFingerprint !==
      lineage.researchArtifactFingerprint ||
    repositoryProfileKey !== lineage.repositoryKey ||
    lineage.executionClass !== "code" ||
    lineage.externalWorkItemBindingFingerprint !== binding.bindingFingerprint
  ) {
    return rejected(
      "linear_code_publication_drift",
      "The signed work item no longer matches its accepted-research publication lineage.",
    );
  }

  const verifiedBinding: VerifiedLinearCodeRepositoryBindingV1 = {
    version: 1,
    repositoryProfileKey,
    issueId: issue.issueId,
    issueIdentifier: issue.issueIdentifier,
    publicationId: checkpoint.publicationId,
    workItemFingerprint: workItem.fingerprint,
    acceptedResearchArtifactFingerprint:
      workItem.acceptedResearchArtifactFingerprint,
    originRunId: workItem.originRunId,
  };
  return {
    status: "verified",
    binding: verifiedBinding,
  };
}

type ParsedCurrentIssueIdentity =
  | {
      issueId: string;
      issueIdentifier: string;
      issueUrl: string;
      teamId: string;
      updatedAt: string;
    }
  | {
      resolution: VerifiedLinearCodeRepositoryBindingResolutionV1;
    };

function parseCurrentIssueIdentity(
  issueRecord: Record<string, unknown>,
): ParsedCurrentIssueIdentity {
  if (issueRecord.resourceType !== "issue") {
    return {
      resolution: rejected(
        "linear_code_issue_invalid",
        "The provider readback is not a normalized Linear issue.",
      ),
    };
  }
  if (issueRecord.trashed !== false) {
    return {
      resolution: rejected(
        "linear_code_issue_trashed",
        "The Linear issue is trashed or its active state is unverified.",
      ),
    };
  }
  const issueId = nonEmptyString(issueRecord.id);
  const issueIdentifier = nonEmptyString(issueRecord.identifier);
  const issueUrl = nonEmptyString(issueRecord.url);
  const updatedAt = nonEmptyString(issueRecord.updatedAt);
  const team =
    issueRecord.team !== null &&
    typeof issueRecord.team === "object" &&
    !Array.isArray(issueRecord.team)
      ? issueRecord.team as Record<string, unknown>
      : null;
  const teamId = nonEmptyString(team?.id);
  if (!issueId || !issueIdentifier || !issueUrl || !updatedAt || !teamId) {
    return {
      resolution: rejected(
        "linear_code_issue_invalid",
        "The normalized Linear issue is missing required identity fields.",
      ),
    };
  }
  return {
    issueId,
    issueIdentifier,
    issueUrl,
    teamId,
    updatedAt,
  };
}

function verifyCurrentIssueSnapshot(
  issueRecord: Record<string, unknown>,
): VerifiedLinearCodeRepositoryBindingResolutionV1 | null {
  const snapshotHash = issueRecord.snapshotHash;
  if (
    typeof snapshotHash !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(snapshotHash)
  ) {
    return rejected(
      "linear_code_issue_snapshot_invalid",
      "The normalized Linear issue snapshot hash is invalid.",
    );
  }
  const {
    snapshotHash: _ignored,
    ...withoutSnapshotHash
  } = issueRecord;
  let expectedSnapshotHash: string;
  try {
    expectedSnapshotHash = fingerprintContract(withoutSnapshotHash);
  } catch {
    return rejected(
      "linear_code_issue_snapshot_invalid",
      "The normalized Linear issue cannot be hashed canonically.",
    );
  }
  if (!constantTimeFingerprintEqual(snapshotHash, expectedSnapshotHash)) {
    return rejected(
      "linear_code_issue_snapshot_invalid",
      "The normalized Linear issue snapshot hash does not match its contents.",
    );
  }
  return null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim()
    ? value
    : null;
}

function notApplicable(
  code: string,
  reason: string,
): VerifiedLinearCodeRepositoryBindingResolutionV1 {
  return { status: "not_applicable", code, reason };
}

function rejected(
  code: string,
  reason: string,
): VerifiedLinearCodeRepositoryBindingResolutionV1 {
  return { status: "rejected", code, reason };
}
