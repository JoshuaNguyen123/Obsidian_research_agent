export type DailyUseScenarioId =
  | "DU-01"
  | "DU-02"
  | "DU-03"
  | "DU-04"
  | "DU-05"
  | "DU-06";

export interface DailyUseAcceptanceV1 {
  version: 1;
  scenarioId: DailyUseScenarioId;
  requestedArtifacts: readonly string[];
  requiredProofs: readonly string[];
  approvalBoundaries: readonly string[];
  finalBindings: readonly string[];
  cleanupObligations: readonly string[];
}

export interface DailyUseObservedAcceptanceV1 {
  artifacts: readonly string[];
  proofs: readonly string[];
  approvals: readonly string[];
  bindings: readonly string[];
  cleanup: readonly string[];
}

export interface DailyUseAcceptanceResultV1 {
  status: "pass" | "needs_more_work";
  missing: readonly string[];
}

/**
 * Stable acceptance contracts for the six release journeys. These keys are
 * intentionally provider-neutral so deterministic, live-model, sandbox, and
 * protected external lanes can report against the same completion contract.
 */
export const DAILY_USE_ACCEPTANCE_V1: Readonly<
  Record<DailyUseScenarioId, DailyUseAcceptanceV1>
> = Object.freeze({
  "DU-01": contract("DU-01", {
    requestedArtifacts: ["vault:markdown_note"],
    requiredProofs: [
      "vault:collision_free_target",
      "stream:complete",
      "receipt:vault_write",
      "restart:no_replay",
    ],
  }),
  "DU-02": contract("DU-02", {
    requestedArtifacts: ["vault:cited_findings_section"],
    requiredProofs: [
      "evidence:vault",
      "evidence:web_fetch",
      "evidence:persisted_passages",
      "receipt:single_append",
      "research:conflicts_visible",
    ],
    finalBindings: ["citation:fetched_source"],
  }),
  "DU-03": contract("DU-03", {
    requestedArtifacts: [
      "code:source_files",
      "code:tests",
      "code:readme",
      "git:local_commit",
    ],
    requiredProofs: [
      "code:trusted_repository",
      "code:durable_workspace",
      "sandbox:boundary_attested",
      "validation:targeted",
      "validation:fresh_full",
      "git:commit_readback",
    ],
    approvalBoundaries: ["approval:sandbox_execution"],
    finalBindings: ["git:commit_artifacts"],
  }),
  "DU-04": contract("DU-04", {
    requestedArtifacts: ["linear:issue", "vault:linear_lineage"],
    requiredProofs: [
      "vault:accepted_note",
      "linear:provider_readback",
      "linear:idempotency",
      "receipt:external_action",
    ],
    approvalBoundaries: ["approval:linear_issue_create"],
    finalBindings: ["binding:note_linear_issue"],
    cleanupObligations: ["cleanup:linear_fixture"],
  }),
  "DU-05": contract("DU-05", {
    requestedArtifacts: ["github:pr_update"],
    requiredProofs: [
      "github:trusted_repository",
      "validation:fresh_full",
      "github:remote_sha_readback",
      "github:pr_readback",
      "receipt:external_action",
    ],
    approvalBoundaries: ["approval:github_publish"],
    finalBindings: ["binding:approval_local_remote_sha"],
    cleanupObligations: ["cleanup:github_fixture"],
  }),
  "DU-06": contract("DU-06", {
    requestedArtifacts: [
      "vault:research_note",
      "linear:issue",
      "git:local_commit",
      "github:draft_pr",
    ],
    requiredProofs: [
      "graph:authoritative",
      "research:accepted",
      "linear:provider_readback",
      "validation:fresh_full",
      "github:remote_sha_readback",
      "resume:no_duplicates",
    ],
    approvalBoundaries: [
      "approval:linear_issue_create",
      "approval:sandbox_execution",
      "approval:github_publish",
    ],
    finalBindings: [
      "binding:note_linear_issue",
      "binding:note_commit_pr",
      "binding:linear_commit_pr",
    ],
    cleanupObligations: ["cleanup:linear_fixture", "cleanup:github_fixture"],
  }),
});

export function evaluateDailyUseAcceptanceV1(
  contractInput: DailyUseAcceptanceV1,
  observed: DailyUseObservedAcceptanceV1,
): DailyUseAcceptanceResultV1 {
  const missing = [
    ...missingKeys(contractInput.requestedArtifacts, observed.artifacts),
    ...missingKeys(contractInput.requiredProofs, observed.proofs),
    ...missingKeys(contractInput.approvalBoundaries, observed.approvals),
    ...missingKeys(contractInput.finalBindings, observed.bindings),
    ...missingKeys(contractInput.cleanupObligations, observed.cleanup),
  ];
  return {
    status: missing.length === 0 ? "pass" : "needs_more_work",
    missing,
  };
}

function contract(
  scenarioId: DailyUseScenarioId,
  input: Omit<
    DailyUseAcceptanceV1,
    "version" | "scenarioId" | "approvalBoundaries" | "finalBindings" | "cleanupObligations"
  > &
    Partial<
      Pick<
        DailyUseAcceptanceV1,
        "approvalBoundaries" | "finalBindings" | "cleanupObligations"
      >
    >,
): DailyUseAcceptanceV1 {
  return Object.freeze({
    version: 1,
    scenarioId,
    requestedArtifacts: Object.freeze([...input.requestedArtifacts]),
    requiredProofs: Object.freeze([...input.requiredProofs]),
    approvalBoundaries: Object.freeze([...(input.approvalBoundaries ?? [])]),
    finalBindings: Object.freeze([...(input.finalBindings ?? [])]),
    cleanupObligations: Object.freeze([...(input.cleanupObligations ?? [])]),
  });
}

function missingKeys(
  required: readonly string[],
  observed: readonly string[],
): string[] {
  const available = new Set(observed);
  return required.filter((key) => !available.has(key));
}
