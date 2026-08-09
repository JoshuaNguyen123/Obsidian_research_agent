import {
  assertCleanLinearHumanOutputV1,
  renderLinearIssueBodyV1,
  type LinearIssueBodyFieldsV1,
} from "./LinearIssueFormatV1";
import { parseWorkItemSpecV1 } from "./WorkItemSpecV1";
import {
  parseWorkItemSpecV2,
  type ParsedCompatibleWorkItemSpec,
  type WorkItemSpecV2,
} from "./WorkItemSpecV2";

export const WORK_ITEM_CONTRACT_START =
  "<!-- agentic-researcher:work-item:v1:start -->";
export const WORK_ITEM_CONTRACT_END =
  "<!-- agentic-researcher:work-item:v1:end -->";
export const WORK_ITEM_CONTRACT_V2_START =
  "<!-- agentic-researcher:work-item:v2:start -->";
export const WORK_ITEM_CONTRACT_V2_END =
  "<!-- agentic-researcher:work-item:v2:end -->";

export interface WorkItemRenderDetailsV1 {
  problemImpact?: string;
  confidenceLimitations?: string;
  proposedWork?: string[];
  nonGoals?: string[];
  scope?: string[];
  dependencies?: string[];
}

interface NormalizedWorkItemRenderDetailsV1 {
  problemImpact?: string;
  confidenceLimitations?: string;
  proposedWork: string[];
  nonGoals: string[];
  scope: string[];
  dependencies: string[];
}

/**
 * Render clean provider-facing issue prose followed by exactly one signed v2
 * contract. Keeping the contract last lets queue ingestion bind the complete
 * approved Linear description without putting host authority in human fields.
 */
export function renderQueueExecutableHumanWorkItemSpecV2(
  value: WorkItemSpecV2,
  renderDetails: WorkItemRenderDetailsV1 = {},
): string {
  const spec = parseWorkItemSpecV2(value);
  const humanDescription = renderHumanCompatibleWorkItemSpec(spec, renderDetails);
  return [humanDescription, renderWorkItemSpecV2Contract(spec)].join("\n\n");
}

/**
 * Render provider-visible issue prose from the shared section contract, without
 * host fingerprints or machine metadata.
 */
export function renderHumanCompatibleWorkItemSpec(
  value: ParsedCompatibleWorkItemSpec,
  renderDetails: WorkItemRenderDetailsV1 = {},
): string {
  const spec = value.schemaVersion === 1
    ? parseWorkItemSpecV1(value)
    : parseWorkItemSpecV2(value);
  const details = normalizeRenderDetails(renderDetails);
  const fields: LinearIssueBodyFieldsV1 = {
    problemImpact: details.problemImpact ?? spec.objective,
    evidence: spec.evidenceRefs,
    confidenceLimitations: details.confidenceLimitations,
    proposedWork: details.proposedWork.length > 0 ? details.proposedWork : [spec.objective],
    nonGoals: details.nonGoals,
    scope: details.scope,
    dependencies: details.dependencies,
    acceptanceCriteria: spec.acceptanceCriteria,
    validation: spec.schemaVersion === 1
      ? spec.validationRequirements
      : spec.validationRequirementKeys,
  };
  return renderLinearIssueBodyV1(fields);
}

export function renderWorkItemSpecV2Contract(spec: WorkItemSpecV2): string {
  return [
    WORK_ITEM_CONTRACT_V2_START,
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    WORK_ITEM_CONTRACT_V2_END,
  ].join("\n");
}

function normalizeRenderDetails(
  value: WorkItemRenderDetailsV1,
): NormalizedWorkItemRenderDetailsV1 {
  const normalized = {
    problemImpact: normalizeOptionalText(value.problemImpact, "problem / impact", 4_000),
    confidenceLimitations: normalizeOptionalText(
      value.confidenceLimitations,
      "confidence / limitations",
      4_000,
    ),
    proposedWork: normalizeTextList(value.proposedWork, "proposed work"),
    nonGoals: normalizeTextList(value.nonGoals, "non-goal"),
    scope: normalizeTextList(value.scope, "scope item"),
    dependencies: normalizeTextList(value.dependencies, "dependency"),
  };
  // Render details are model-supplied prose. Reject a forged contract marker
  // here rather than letting it reach the provider-visible body.
  assertCleanLinearHumanOutputV1(
    [
      normalized.problemImpact ?? "",
      normalized.confidenceLimitations ?? "",
      ...normalized.proposedWork,
      ...normalized.nonGoals,
      ...normalized.scope,
      ...normalized.dependencies,
    ].join("\n"),
    "Work item render details",
  );
  return normalized;
}

function normalizeOptionalText(
  value: string | undefined,
  label: string,
  maximumLength: number,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new Error(`${label} is empty or too long.`);
  }
  return normalized;
}

function normalizeTextList(value: string[] | undefined, label: string): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${label} list must contain at most 50 entries.`);
  }
  return value.map((entry, index) => {
    const normalized = normalizeOptionalText(entry, `${label} ${index + 1}`, 1_000);
    if (!normalized) {
      throw new Error(`${label} ${index + 1} is empty.`);
    }
    return normalized;
  });
}
