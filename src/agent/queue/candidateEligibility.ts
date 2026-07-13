import {
  parseRepositoryProfileRegistry,
  type RepositoryProfileRegistryV1,
} from "../repositories/RepositoryProfile";
import type {
  WorkItemExecutionClass,
  WorkItemRiskClass,
} from "../../integrations/linear/WorkItemSpecV1";
import {
  parseCompatibleWorkItemSpec,
  type ParsedCompatibleWorkItemSpec,
} from "../../integrations/linear/WorkItemSpecV2";
import { fingerprintCanonicalJson } from "./fingerprint";
import type {
  CandidateEligibilityV1,
  CandidateIneligibilityReason,
} from "./types";

export interface CandidateEligibilityPolicyV1 {
  enabled: boolean;
  allowedExecutionClasses: WorkItemExecutionClass[];
  maximumRiskClass: WorkItemRiskClass;
  allowedRepositoryKeys: string[];
  maximumGeneration: number;
  requireEvidence: boolean;
}

export function createCandidateEligibilityPolicy(
  overrides: Partial<CandidateEligibilityPolicyV1> = {},
): CandidateEligibilityPolicyV1 {
  const policy: CandidateEligibilityPolicyV1 = {
    enabled: overrides.enabled ?? true,
    allowedExecutionClasses: overrides.allowedExecutionClasses ?? [
      "research",
      "vault",
      "code",
    ],
    maximumRiskClass: overrides.maximumRiskClass ?? "medium",
    allowedRepositoryKeys: overrides.allowedRepositoryKeys ?? [],
    maximumGeneration: overrides.maximumGeneration ?? 2,
    requireEvidence: overrides.requireEvidence ?? true,
  };
  assertEligibilityPolicy(policy);
  return {
    ...policy,
    allowedExecutionClasses: [...policy.allowedExecutionClasses],
    allowedRepositoryKeys: [...policy.allowedRepositoryKeys],
  };
}

export function evaluateCandidateEligibility(
  value: ParsedCompatibleWorkItemSpec,
  input: {
    policy: CandidateEligibilityPolicyV1;
    repositories: RepositoryProfileRegistryV1;
    at: string;
    /** Host-confirmed vault binding; required for autonomous vault execution. */
    trustedBindingAvailable?: boolean;
  },
): CandidateEligibilityV1 {
  assertEligibilityPolicy(input.policy);
  const repositories = parseRepositoryProfileRegistry(input.repositories);
  const at = expectIsoTimestamp(input.at, "eligibility evaluation time");
  const policyFingerprint = fingerprintCanonicalJson(input.policy);
  const reasons: CandidateIneligibilityReason[] = [];
  let workItem: ParsedCompatibleWorkItemSpec | null = null;
  try {
    workItem = parseCompatibleWorkItemSpec(value);
  } catch {
    reasons.push("invalid_work_item");
  }
  if (!input.policy.enabled) {
    reasons.push("queue_disabled");
  }
  if (!workItem) {
    return buildResult(reasons, null, policyFingerprint, at);
  }
  if (!workItem.ready) {
    reasons.push("work_item_not_ready");
  }
  if (!input.policy.allowedExecutionClasses.includes(workItem.executionClass)) {
    reasons.push("execution_class_not_allowed");
  }
  if (riskRank(workItem.riskClass) > riskRank(input.policy.maximumRiskClass)) {
    reasons.push("risk_not_allowed");
  }
  if (workItem.generation > input.policy.maximumGeneration) {
    reasons.push("generation_exceeded");
  }
  if (workItem.executionClass === "vault" && input.trustedBindingAvailable !== true) {
    reasons.push("missing_trusted_binding");
  }
  if (workItem.executionClass === "code" && !workItem.repositoryKey) {
    reasons.push("missing_repository");
  }
  if (workItem.repositoryKey) {
    if (
      input.policy.allowedRepositoryKeys.length > 0 &&
      !input.policy.allowedRepositoryKeys.includes(workItem.repositoryKey)
    ) {
      reasons.push("repository_not_allowed");
    }
    if (!repositories.profiles[workItem.repositoryKey]) {
      reasons.push("unknown_repository");
    }
  }
  if (workItem.acceptanceCriteria.length === 0) {
    reasons.push("missing_acceptance_criteria");
  }
  const validationRequirementKeys = workItem.schemaVersion === 2
    ? workItem.validationRequirementKeys
    : workItem.validationRequirements;
  if (validationRequirementKeys.length === 0) {
    reasons.push("missing_validation_requirements");
  }
  if (input.policy.requireEvidence && workItem.evidenceRefs.length === 0) {
    reasons.push("missing_evidence");
  }
  return buildResult(
    reasons,
    workItem.repositoryKey ?? null,
    policyFingerprint,
    at,
  );
}

export function assertEligibilityPolicy(policy: CandidateEligibilityPolicyV1): void {
  if (typeof policy.enabled !== "boolean" || typeof policy.requireEvidence !== "boolean") {
    throw new Error("Candidate eligibility policy flags must be booleans.");
  }
  const allowedClasses: WorkItemExecutionClass[] = ["research", "vault", "code", "human"];
  if (
    !Array.isArray(policy.allowedExecutionClasses) ||
    policy.allowedExecutionClasses.length === 0 ||
    policy.allowedExecutionClasses.some((value) => !allowedClasses.includes(value)) ||
    new Set(policy.allowedExecutionClasses).size !== policy.allowedExecutionClasses.length
  ) {
    throw new Error("Candidate eligibility execution classes are invalid.");
  }
  if (!(["low", "medium", "high"] as const).includes(policy.maximumRiskClass)) {
    throw new Error("Candidate eligibility maximum risk class is invalid.");
  }
  if (
    !Array.isArray(policy.allowedRepositoryKeys) ||
    policy.allowedRepositoryKeys.some(
      (key) => typeof key !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(key),
    ) ||
    new Set(policy.allowedRepositoryKeys).size !== policy.allowedRepositoryKeys.length
  ) {
    throw new Error("Candidate eligibility repository allowlist is invalid.");
  }
  if (
    !Number.isInteger(policy.maximumGeneration) ||
    policy.maximumGeneration < 0 ||
    policy.maximumGeneration > 100
  ) {
    throw new Error("Candidate eligibility maximum generation must be from 0 to 100.");
  }
}

function buildResult(
  reasons: CandidateIneligibilityReason[],
  repositoryKey: string | null,
  policyFingerprint: string,
  evaluatedAt: string,
): CandidateEligibilityV1 {
  return {
    eligible: reasons.length === 0,
    reasons: [...new Set(reasons)],
    repositoryKey,
    policyFingerprint,
    evaluatedAt,
  };
}

function riskRank(value: WorkItemRiskClass): number {
  return { low: 0, medium: 1, high: 2 }[value];
}

function expectIsoTimestamp(value: string, label: string): string {
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}
