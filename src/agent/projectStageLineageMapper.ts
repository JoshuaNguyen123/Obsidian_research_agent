import {
  parseProjectLineageV1,
  type ProjectLifecycleStageCommitV1,
  type ProjectLineageV1,
} from "./projectLifecycle";
import {
  createProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectEvidenceResourceV1,
  type ProjectEventWorkUnitBindingV1,
  type ProjectPhaseV1,
  type ProjectStageEventV1,
} from "./projectRunReport";
import {
  createProjectWorkUnitLinearBindingV1,
  type ProjectWorkUnitLinearBindingV1,
} from "./projectProgressProjection";

/**
 * Project durable lifecycle lineage into the evidence vocabulary used by the
 * Results report. This adapter never infers proof from prose: every event is a
 * deterministic projection of a parsed, fingerprint-verified lineage commit.
 */
export function projectStageEventsFromProjectLineageV1(input: {
  lineage: unknown;
  /** Durable root mission id selected by the host. */
  runId?: string;
}): ProjectStageEventV1[] {
  const lineage = parseProjectLineageV1(input.lineage);
  const runId = input.runId?.trim() || lineage.runId;
  return lineage.commits.flatMap((commit) => eventsForCommit(lineage, commit, runId));
}

export function projectLinearBindingsFromProjectLineageV1(input: {
  lineage: unknown;
  runId?: string;
}): ProjectWorkUnitLinearBindingV1[] {
  const lineage = parseProjectLineageV1(input.lineage);
  const runId = input.runId?.trim() || lineage.runId;
  const linearCommit = lineage.commits.find(
    (commit) => commit.proof.stage === "linear_hierarchy",
  );
  if (
    !linearCommit ||
    linearCommit.proof.stage !== "linear_hierarchy" ||
    !linearCommit.proof.workUnits
  ) {
    return [];
  }
  return linearCommit.proof.workUnits.map((unit) =>
    createProjectWorkUnitLinearBindingV1({
      schemaVersion: 1,
      bindingId: `linear-binding-${unit.providerReadbackFingerprint.slice("sha256:".length, 39)}`,
      runId,
      workUnitId: unit.workUnitId,
      linearIssueId: unit.linearIssueId,
      linearIssueIdentifier: unit.linearIssueIdentifier,
      linearIssueUrl: unit.linearIssueUrl,
      acceptanceCriterionIds: unit.acceptanceCriterionIds,
      providerReadbackFingerprint: unit.providerReadbackFingerprint,
      verifiedAt: linearCommit.committedAt,
    }),
  );
}

/**
 * Attribute otherwise project-level lifecycle proof only when the Linear
 * hierarchy has exactly one possible delivery issue. This is the narrow bridge
 * used by the automatic developer mission: a single implementation/validation
 * and publication cannot be broadcast across several children, while one
 * exact child has no attribution ambiguity.
 *
 * Acceptance-criterion events retain their existing explicit bindings. With
 * zero or multiple bindings this function is an identity operation.
 */
export function bindAggregateProjectEventsToOnlyWorkUnitV1(input: {
  events: readonly ProjectStageEventV1[];
  bindings: readonly ProjectWorkUnitLinearBindingV1[];
}): ProjectStageEventV1[] {
  if (input.bindings.length !== 1) return [...input.events];
  const [binding] = input.bindings;
  if (!binding) return [...input.events];
  const attributableKinds = new Set<ProjectEvidenceKindV1>([
    "workspace_mutation",
    "diff_readback",
    "targeted_validation",
    "full_validation",
    "commit_readback",
    "github_repository_readback",
    "github_draft_pr_readback",
    "reflection_writeback",
  ]);
  return input.events.map((event) => {
    if (
      event.workUnits.length > 0 ||
      !attributableKinds.has(event.evidenceKind)
    ) {
      return event;
    }
    return createProjectStageEventV1({
      schemaVersion: event.schemaVersion,
      runId: event.runId,
      phase: event.phase,
      evidenceKind: event.evidenceKind,
      disposition: event.disposition,
      occurredAt: event.occurredAt,
      sourceReceiptId: event.sourceReceiptId,
      evidenceFingerprint: event.evidenceFingerprint,
      resource: event.resource,
      workUnits: [{
        workUnitId: binding.workUnitId,
        acceptanceCriterionIds: [],
      }],
    });
  });
}

/**
 * Collapse the aggregate and sole-child projections of the same immutable
 * receipt into one report event, preferring the exact work-unit scope. Two
 * independently scoped events are never merged merely because their provider
 * evidence looks alike.
 */
export function mergeProjectStageEventsPreferExactWorkUnitScopeV1(
  events: readonly ProjectStageEventV1[],
): ProjectStageEventV1[] {
  const byEventId = new Map<string, ProjectStageEventV1>();
  const preferredByProof = new Map<string, string>();
  for (const event of events) {
    if (byEventId.has(event.eventId)) continue;
    const proofKey = JSON.stringify([
      event.runId,
      event.phase,
      event.evidenceKind,
      event.disposition,
      event.occurredAt,
      event.sourceReceiptId,
      event.evidenceFingerprint,
      event.resource,
    ]);
    const priorId = preferredByProof.get(proofKey);
    const prior = priorId ? byEventId.get(priorId) : null;
    if (prior) {
      if (prior.workUnits.length === 0 && event.workUnits.length > 0) {
        byEventId.delete(prior.eventId);
        byEventId.set(event.eventId, event);
        preferredByProof.set(proofKey, event.eventId);
        continue;
      }
      if (prior.workUnits.length > 0 && event.workUnits.length === 0) {
        continue;
      }
      // Both events carry explicit scope. Preserve both; their distinct event
      // identities may represent different child-bound receipts.
      byEventId.set(event.eventId, event);
      continue;
    }
    byEventId.set(event.eventId, event);
    preferredByProof.set(proofKey, event.eventId);
  }
  return [...byEventId.values()].sort(
    (left, right) =>
      left.occurredAt.localeCompare(right.occurredAt) ||
      left.eventId.localeCompare(right.eventId),
  );
}

function eventsForCommit(
  lineage: ProjectLineageV1,
  commit: ProjectLifecycleStageCommitV1,
  runId: string,
): ProjectStageEventV1[] {
  const source = (suffix: string) =>
    `lineage-${commit.proofFingerprint.slice("sha256:".length, 31)}-${suffix}`;
  const event = (input: {
    phase: ProjectPhaseV1;
    evidenceKind: ProjectEvidenceKindV1;
    sourceSuffix: string;
    evidenceFingerprint: string;
    resource: ProjectEvidenceResourceV1;
    workUnits?: ProjectEventWorkUnitBindingV1[];
  }): ProjectStageEventV1 =>
    createProjectStageEventV1({
      schemaVersion: 1,
      runId,
      phase: input.phase,
      evidenceKind: input.evidenceKind,
      disposition: "verified",
      occurredAt: commit.committedAt,
      sourceReceiptId: source(input.sourceSuffix),
      evidenceFingerprint: input.evidenceFingerprint,
      resource: input.resource,
      workUnits: input.workUnits ?? [],
    });

  const proof = commit.proof;
  switch (proof.stage) {
    case "accepted_research":
      return [event({
        phase: "research",
        evidenceKind: "research_artifact",
        sourceSuffix: "research",
        evidenceFingerprint: commit.proofFingerprint,
        resource: {
          system: "vault",
          resourceType: "accepted_research_note",
          id: proof.artifactFingerprint,
          url: null,
          path: proof.notePath,
          revision: proof.noteSha256,
        },
      })];
    case "linear_hierarchy":
      return [event({
        phase: "linear_plan",
        evidenceKind: "linear_hierarchy_readback",
        sourceSuffix: "linear",
        evidenceFingerprint: commit.proofFingerprint,
        resource: {
          system: "linear",
          resourceType: "project_hierarchy",
          id: proof.projectId,
          url: null,
          path: null,
          revision: proof.planFingerprint,
        },
      })];
    case "code_execution":
    case "code_validation": {
      const hasSeparateValidation = lineage.commits.some(
        (candidate) => candidate.stage === "code_validation",
      );
      const shared = {
        system: "workspace" as const,
        resourceType: "verified_workspace",
        id: proof.workspaceId,
        url: null,
        path: null,
        revision: proof.diffFingerprint ?? proof.commitSha,
      };
      const events: ProjectStageEventV1[] = [];
      if (proof.stage === "code_execution") {
        events.push(event({
          phase: "implement",
          evidenceKind: "workspace_mutation",
          sourceSuffix: "implementation",
          evidenceFingerprint: commit.proofFingerprint,
          resource: shared,
          // A repository-wide diff does not identify which child issue owns
          // each changed line. Keep aggregate implementation evidence at the
          // project level until an exact receipt names one work unit.
          workUnits: [],
        }));
      }
      if (proof.stage === "code_execution" && proof.diffFingerprint) {
        events.push(event({
          phase: "implement",
          evidenceKind: "diff_readback",
          sourceSuffix: "diff",
          evidenceFingerprint: proof.diffFingerprint,
          resource: shared,
          workUnits: [],
        }));
      }
      if (proof.stage === "code_execution" && hasSeparateValidation) {
        return events;
      }
      const targetedFingerprint =
        proof.validationReceiptFingerprints[0] ?? commit.proofFingerprint;
      const fullFingerprint =
        proof.validationReceiptFingerprints[1] ?? targetedFingerprint;
      events.push(
        event({
          phase: "test",
          evidenceKind: "targeted_validation",
          sourceSuffix: "targeted",
          evidenceFingerprint: targetedFingerprint,
          resource: { ...shared, resourceType: "targeted_validation" },
          workUnits: [],
        }),
        event({
          phase: "test",
          evidenceKind: "full_validation",
          sourceSuffix: "full",
          evidenceFingerprint: fullFingerprint,
          resource: { ...shared, resourceType: "full_validation" },
          workUnits: [],
        }),
        event({
          phase: "test",
          evidenceKind: "commit_readback",
          sourceSuffix: "commit",
          evidenceFingerprint: proof.commitReadbackFingerprint,
          resource: {
            system: "git",
            resourceType: "commit",
            id: proof.commitSha,
            url: null,
            path: null,
            revision: proof.commitSha,
          },
          workUnits: [],
        }),
      );
      // A one-issue developer mission binds its complete validation/commit
      // bundle to that issue's exact criteria. Multi-issue projects remain
      // deliberately unpaid until criterion-specific receipts exist; aggregate
      // validation must not manufacture per-child completion.
      const acceptedWorkUnits = exactSingleWorkUnitAcceptanceForLineage(lineage);
      if (proof.stage === "code_validation" && acceptedWorkUnits.length === 1) {
        events.push(event({
          phase: "test",
          evidenceKind: "acceptance_criterion",
          sourceSuffix: "acceptance",
          evidenceFingerprint: commit.proofFingerprint,
          resource: {
            system: "git",
            resourceType: "verified_acceptance_bundle",
            id: proof.commitSha,
            url: null,
            path: null,
            revision: proof.commitSha,
          },
          workUnits: acceptedWorkUnits,
        }));
      }
      return events;
    }
    case "private_github_publication": {
      const repositoryUrl = `https://github.com/${proof.owner}/${proof.repository}`;
      return [
        event({
          phase: "github",
          evidenceKind: "github_repository_readback",
          sourceSuffix: "repository",
          evidenceFingerprint: proof.repositoryReadbackFingerprint,
          resource: {
            system: "github",
            resourceType: "repository",
            id: `${proof.owner}/${proof.repository}`,
            url: repositoryUrl,
            path: null,
            revision: proof.remoteSha,
          },
          // Repository and pull-request readbacks prove project publication;
          // they do not prove that every child issue's acceptance criteria
          // were implemented.
          workUnits: [],
        }),
        event({
          phase: "github",
          evidenceKind: "github_draft_pr_readback",
          sourceSuffix: "pull-request",
          evidenceFingerprint: proof.pullRequestReadbackFingerprint,
          resource: {
            system: "github",
            resourceType: "draft_pull_request",
            id: `${proof.owner}/${proof.repository}#${proof.pullRequestNumber}`,
            url: `${repositoryUrl}/pull/${proof.pullRequestNumber}`,
            path: null,
            revision: proof.remoteSha,
          },
          workUnits: [],
        }),
      ];
    }
    case "reflection":
      return [event({
        phase: "reflect",
        evidenceKind: "reflection_writeback",
        sourceSuffix: "reflection",
        evidenceFingerprint: proof.writeReceiptFingerprint,
        resource: {
          system: "vault",
          resourceType: proof.resultsPath.toLowerCase().endsWith(".ipynb")
            ? "jupyter_notebook"
            : "markdown_note",
          id: proof.resultsPath,
          url: null,
          path: proof.resultsPath,
          revision: proof.resultsSha256,
        },
        // The report is a project artifact. Per-child completion still needs
        // an exact acceptance receipt rather than inherited project metadata.
        workUnits: [],
      })];
    case "reconciliation_cleanup":
      return [];
  }
}

function exactSingleWorkUnitAcceptanceForLineage(
  lineage: ProjectLineageV1,
): ProjectEventWorkUnitBindingV1[] {
  const linear = lineage.commits.find(
    (commit) => commit.proof.stage === "linear_hierarchy",
  )?.proof;
  if (linear?.stage !== "linear_hierarchy" || !linear.workUnits) return [];
  // The lifecycle's aggregate validation bundle can be attributed only when
  // there is exactly one possible child. Multiple children require explicit
  // criterion-specific receipts and therefore remain visibly unpaid.
  if (linear.workUnits.length !== 1) return [];
  const [unit] = linear.workUnits;
  return unit
    ? [{
        workUnitId: unit.workUnitId,
        acceptanceCriterionIds: [...unit.acceptanceCriterionIds],
      }]
    : [];
}
