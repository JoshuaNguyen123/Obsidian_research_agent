import {
  parseWorkItemSpecV1,
  type WorkItemSpecV1,
} from "./WorkItemSpecV1";

export const WORK_ITEM_CONTRACT_START =
  "<!-- agentic-researcher:work-item:v1:start -->";
export const WORK_ITEM_CONTRACT_END =
  "<!-- agentic-researcher:work-item:v1:end -->";

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

/** Render a human-readable Linear description with the signed machine contract last. */
export function renderWorkItemSpecV1(
  value: WorkItemSpecV1,
  renderDetails: WorkItemRenderDetailsV1 = {},
): string {
  const spec = parseWorkItemSpecV1(value);
  const details = normalizeRenderDetails(renderDetails);
  assertNoReservedMarkers(spec, details);
  const contract = [
    WORK_ITEM_CONTRACT_START,
    "```json",
    JSON.stringify(spec, null, 2),
    "```",
    WORK_ITEM_CONTRACT_END,
  ].join("\n");
  const acceptanceCriteria = spec.acceptanceCriteria
    .map((criterion) => `- [ ] **${escapeInline(criterion.id)}** - ${criterion.text}`)
    .join("\n");
  const validation = renderStringList(
    spec.validationRequirements,
    "No validation requirements recorded.",
  );
  const evidence = renderStringList(spec.evidenceRefs, "No evidence references recorded.");
  const repository = spec.repositoryKey ? `\`${escapeInline(spec.repositoryKey)}\`` : "_None_";
  const parent = spec.parentIssueId ? `\`${escapeInline(spec.parentIssueId)}\`` : "_None_";
  const scope = details.scope.length > 0
    ? details.scope
    : [
        `Execution class: \`${spec.executionClass}\``,
        ...(spec.repositoryKey ? [`Repository: \`${escapeInline(spec.repositoryKey)}\``] : []),
      ];
  const dependencies = details.dependencies.length > 0
    ? details.dependencies
    : spec.parentIssueId
      ? [`Parent Linear issue: \`${escapeInline(spec.parentIssueId)}\``]
      : [];

  return [
    "## Problem / impact",
    details.problemImpact ?? spec.objective,
    "## Evidence / source links",
    evidence,
    "## Confidence / limitations",
    details.confidenceLimitations ?? "_No additional confidence or limitation note recorded._",
    "## Proposed work / non-goals",
    "### Proposed work",
    renderStringList(
      details.proposedWork.length > 0 ? details.proposedWork : [spec.objective],
      "No proposed work recorded.",
    ),
    "### Non-goals",
    renderStringList(details.nonGoals, "No non-goals recorded."),
    "## Scope / dependencies",
    "### Scope",
    renderStringList(scope, "No scope recorded."),
    "### Dependencies",
    renderStringList(dependencies, "No dependencies recorded."),
    "## Acceptance criteria",
    acceptanceCriteria,
    "## Validation requirements",
    validation,
    "## Risk and execution",
    "- Ready: yes",
    `- Execution class: \`${spec.executionClass}\``,
    `- Risk class: \`${spec.riskClass}\``,
    `- Repository: ${repository}`,
    `- Origin run: \`${escapeInline(spec.originRunId)}\``,
    `- Parent issue: ${parent}`,
    `- Generation: ${spec.generation}`,
    "## Machine contract",
    contract,
  ].join("\n\n");
}

function renderStringList(values: readonly string[], emptyText: string): string {
  return values.length > 0
    ? values.map((value) => `- ${value}`).join("\n")
    : `_${emptyText}_`;
}

function escapeInline(value: string): string {
  return value.replace(/([`*_\\])/g, "\\$1");
}

function normalizeRenderDetails(
  value: WorkItemRenderDetailsV1,
): NormalizedWorkItemRenderDetailsV1 {
  return {
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

function assertNoReservedMarkers(
  spec: WorkItemSpecV1,
  details: NormalizedWorkItemRenderDetailsV1,
): void {
  const text = [
    spec.objective,
    ...spec.acceptanceCriteria.flatMap((criterion) => [criterion.id, criterion.text]),
    ...spec.validationRequirements,
    ...spec.evidenceRefs,
    details.problemImpact ?? "",
    details.confidenceLimitations ?? "",
    ...details.proposedWork,
    ...details.nonGoals,
    ...details.scope,
    ...details.dependencies,
  ].join("\n");
  if (text.includes(WORK_ITEM_CONTRACT_START) || text.includes(WORK_ITEM_CONTRACT_END)) {
    throw new Error("Work item content contains a reserved contract marker.");
  }
}
