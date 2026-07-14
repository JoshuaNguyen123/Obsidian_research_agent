import type { ResearchPublicationCheckpointV1 } from "./ResearchPublicationWorkflow";
import {
  appendWorkItemLineageTransitionV1,
  type AppendWorkItemLineageTransitionV1Input,
  type WorkItemLineageStateV1,
} from "./WorkItemLineageV1";

export interface QueueCodePublicationOriginIdentityV1 {
  issueId: string;
  originRunId: string;
  repositoryKey: string;
  workItemFingerprint: string;
  acceptedResearchArtifactFingerprint: string;
}

export interface VerifiedCodePublicationOriginIdentityV1 {
  repositoryKey: string;
  handoffRunId: string;
  handoffFingerprint: string;
  localCommitReceiptId: string;
  allowOriginRunFallback: boolean;
}

export type CodePublicationLineageTransitionV1 =
  AppendWorkItemLineageTransitionV1Input;

export class CodePublicationLineageErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodePublicationLineageErrorV1";
  }
}

/**
 * Resolve the only host-verified research publication that produced a queued
 * Linear code item. The signed work-item text is not sufficient: the durable
 * issue readback, external binding, accepted note artifact, and logical
 * repository binding must all agree.
 */
export function resolveQueueCodePublicationOriginV1(
  checkpoints: readonly ResearchPublicationCheckpointV1[],
  identity: QueueCodePublicationOriginIdentityV1,
): ResearchPublicationCheckpointV1 {
  const matches = checkpoints.filter((checkpoint) => {
    if (!isBoundCodeCheckpoint(checkpoint, identity.repositoryKey)) return false;
    return (
      checkpoint.issue?.id === identity.issueId &&
      checkpoint.binding?.issueId === identity.issueId &&
      checkpoint.artifact.originRunId === identity.originRunId &&
      checkpoint.lineage?.originRunId === identity.originRunId &&
      checkpoint.workItemFingerprint === identity.workItemFingerprint &&
      checkpoint.lineage?.workItemFingerprint === identity.workItemFingerprint &&
      checkpoint.binding?.workItemFingerprint === identity.workItemFingerprint &&
      checkpoint.artifact.artifactFingerprint ===
        identity.acceptedResearchArtifactFingerprint &&
      checkpoint.lineage?.researchArtifactFingerprint ===
        identity.acceptedResearchArtifactFingerprint &&
      checkpoint.binding?.acceptedResearchArtifactFingerprint ===
        identity.acceptedResearchArtifactFingerprint
    );
  });
  return requireUnique(matches, "queue_code_origin_unavailable", "queued Linear code item");
}

/**
 * Resolve publication finalization from the durable local_verified lineage
 * evidence. Foreground repairs created by the originating research run retain
 * a compatibility fallback; synthetic queue run/request ids never do.
 */
export function resolveVerifiedCodePublicationOriginV1(
  checkpoints: readonly ResearchPublicationCheckpointV1[],
  identity: VerifiedCodePublicationOriginIdentityV1,
): ResearchPublicationCheckpointV1 {
  const candidates = checkpoints.filter((checkpoint) =>
    isBoundCodeCheckpoint(checkpoint, identity.repositoryKey),
  );
  const exact = candidates.filter((checkpoint) => {
    const local = checkpoint.lineage?.events.find(
      (event) => event.state === "local_verified",
    );
    return (
      local?.receiptId === identity.localCommitReceiptId &&
      local.evidenceFingerprint === identity.handoffFingerprint
    );
  });
  if (exact.length > 0) {
    return requireUnique(
      exact,
      "verified_code_origin_ambiguous",
      "verified local commit lineage",
    );
  }
  if (identity.allowOriginRunFallback) {
    const foreground = candidates.filter(
      (checkpoint) => checkpoint.lineage?.originRunId === identity.handoffRunId,
    );
    if (foreground.length > 0) {
      return requireUnique(
        foreground,
        "verified_code_origin_ambiguous",
        "foreground code lineage",
      );
    }
  }
  throw new CodePublicationLineageErrorV1(
    "verified_code_origin_unavailable",
    "No durable Linear and Obsidian lineage matches the verified local commit.",
  );
}

/**
 * Append one or more route-ordered events without rewriting completed proof.
 * Replaying a transition after restart is a no-op; skipping an unpersisted
 * route state remains invalid.
 */
export function advanceCodePublicationLineageV1(
  checkpoint: ResearchPublicationCheckpointV1,
  transitions: readonly CodePublicationLineageTransitionV1[],
): ResearchPublicationCheckpointV1 {
  if (!isBoundCodeCheckpoint(checkpoint, checkpoint.lineage?.repositoryKey ?? "")) {
    throw new CodePublicationLineageErrorV1(
      "code_lineage_unbound",
      "Code publication lineage requires a verified Linear issue and external binding.",
    );
  }
  let lineage = checkpoint.lineage!;
  let updatedAt = checkpoint.updatedAt;
  for (const transition of transitions) {
    const reached = lineage.events.find((event) => event.state === transition.state);
    if (reached) {
      if (
        reached.receiptId !== transition.receiptId ||
        reached.evidenceFingerprint !== transition.evidenceFingerprint
      ) {
        throw new CodePublicationLineageErrorV1(
          "code_lineage_replay_mismatch",
          `Completed code publication proof for ${transition.state} cannot be rewritten.`,
        );
      }
      continue;
    }
    const latest = lineage.events[lineage.events.length - 1];
    // Repository policy may declare a verified draft PR as the terminal proof.
    // In that route, do not fabricate checks, review, merge, or merge receipts.
    const expected =
      latest.state === "draft_pr_verified" && transition.state === "finalized"
        ? "finalized"
        : nextCodeState(latest.state);
    if (expected !== transition.state) {
      throw new CodePublicationLineageErrorV1(
        "code_lineage_transition_gap",
        `Code publication lineage expected ${expected ?? "no further state"}, not ${transition.state}.`,
      );
    }
    lineage = appendWorkItemLineageTransitionV1(lineage, transition);
    if (Date.parse(transition.occurredAt) > Date.parse(updatedAt)) {
      updatedAt = transition.occurredAt;
    }
  }
  return lineage === checkpoint.lineage
    ? checkpoint
    : { ...checkpoint, lineage, updatedAt };
}

export function latestCodePublicationLineageStateV1(
  checkpoint: ResearchPublicationCheckpointV1,
): WorkItemLineageStateV1 | null {
  return checkpoint.lineage?.events.at(-1)?.state ?? null;
}

function isBoundCodeCheckpoint(
  checkpoint: ResearchPublicationCheckpointV1,
  repositoryKey: string,
): boolean {
  return Boolean(
    checkpoint.lineage?.executionClass === "code" &&
      checkpoint.lineage.repositoryKey === repositoryKey &&
      checkpoint.lineage.externalWorkItemBindingFingerprint &&
      checkpoint.binding &&
      checkpoint.issue &&
      checkpoint.workItemFingerprint &&
      checkpoint.binding.bindingFingerprint ===
        checkpoint.lineage.externalWorkItemBindingFingerprint &&
      checkpoint.binding.issueId === checkpoint.issue.id,
  );
}

function requireUnique(
  matches: readonly ResearchPublicationCheckpointV1[],
  missingCode: string,
  label: string,
): ResearchPublicationCheckpointV1 {
  if (matches.length !== 1) {
    throw new CodePublicationLineageErrorV1(
      matches.length > 1 ? "code_publication_origin_ambiguous" : missingCode,
      matches.length > 1
        ? `More than one durable publication matches the ${label}.`
        : `No durable publication matches the ${label}.`,
    );
  }
  return matches[0];
}

const CODE_ROUTE: readonly WorkItemLineageStateV1[] = [
  "accepted_research",
  "note_verified",
  "linear_verified",
  "claimed",
  "workspace_ready",
  "local_verified",
  "push_prepared",
  "pushed_verified",
  "draft_pr_verified",
  "checks_pending",
  "review_or_merge_ready",
  "merge_prepared",
  "merged_verified",
  "finalized",
];

function nextCodeState(
  current: WorkItemLineageStateV1,
): WorkItemLineageStateV1 | null {
  const index = CODE_ROUTE.indexOf(current);
  return index < 0 ? null : CODE_ROUTE[index + 1] ?? null;
}
