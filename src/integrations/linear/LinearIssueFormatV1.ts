/**
 * The one Linear issue body contract.
 *
 * Every host-rendered Linear issue description is generated from
 * `LINEAR_ISSUE_SECTIONS_V1`, and every model-authored research ticket is
 * validated against it. The managed vault template is generated from the same
 * constant, so the shape an agent is told to fill and the shape the host emits
 * cannot drift apart.
 *
 * Bullets are deliberately plain. Linear's markdown round-trip rewrites
 * task-list checkboxes (`- [ ]`), which breaks exact create readback, so no
 * host-rendered body may contain them.
 */

export type LinearIssueSectionKind = "text" | "list" | "criteria";

export interface LinearIssueSectionV1 {
  /** The literal `##` heading, and the ordering key for validation. */
  readonly heading: string;
  /** `{{placeholder}}` name used by the managed vault template. */
  readonly placeholder: string;
  /** Key on `LinearIssueBodyFieldsV1`. */
  readonly field: keyof LinearIssueBodyFieldsV1;
  readonly kind: LinearIssueSectionKind;
  /** Italicised filler when the section has no content. */
  readonly emptyText: string;
}

export interface LinearIssueAcceptanceCriterionV1 {
  id?: string;
  text: string;
}

export interface LinearIssueBodyFieldsV1 {
  problemImpact?: string;
  evidence?: readonly string[];
  confidenceLimitations?: string;
  proposedWork?: readonly string[];
  nonGoals?: readonly string[];
  scope?: readonly string[];
  dependencies?: readonly string[];
  acceptanceCriteria?: readonly LinearIssueAcceptanceCriterionV1[];
  validation?: readonly string[];
}

/**
 * Ordered source of truth. The empty texts match what the publication renderer
 * emitted before this contract existed, so folding the existing renderers onto
 * it changes no provider-visible bytes other than the criteria bullet style.
 */
export const LINEAR_ISSUE_SECTIONS_V1: readonly LinearIssueSectionV1[] = Object.freeze([
  {
    heading: "Problem / impact",
    placeholder: "problem_impact",
    field: "problemImpact",
    kind: "text",
    emptyText: "No problem or impact recorded.",
  },
  {
    heading: "Evidence / source links",
    placeholder: "evidence",
    field: "evidence",
    kind: "list",
    emptyText: "No evidence references recorded.",
  },
  {
    heading: "Confidence / limitations",
    placeholder: "confidence_limitations",
    field: "confidenceLimitations",
    kind: "text",
    emptyText: "No additional confidence or limitation note recorded.",
  },
  {
    heading: "Proposed work",
    placeholder: "proposed_work",
    field: "proposedWork",
    kind: "list",
    emptyText: "No proposed work recorded.",
  },
  {
    heading: "Non-goals",
    placeholder: "non_goals",
    field: "nonGoals",
    kind: "list",
    emptyText: "No non-goals recorded.",
  },
  {
    heading: "Scope",
    placeholder: "scope",
    field: "scope",
    kind: "list",
    emptyText: "No scope recorded.",
  },
  {
    heading: "Dependencies",
    placeholder: "dependencies",
    field: "dependencies",
    kind: "list",
    emptyText: "No dependencies recorded.",
  },
  {
    heading: "Acceptance criteria",
    placeholder: "acceptance_criteria",
    field: "acceptanceCriteria",
    kind: "criteria",
    emptyText: "No acceptance criteria recorded.",
  },
  {
    heading: "Validation",
    placeholder: "validation",
    field: "validation",
    kind: "list",
    emptyText: "No validation requirements recorded.",
  },
] as const satisfies readonly LinearIssueSectionV1[]);

export const LINEAR_ISSUE_SECTION_HEADINGS_V1: readonly string[] = Object.freeze(
  LINEAR_ISSUE_SECTIONS_V1.map((section) => section.heading),
);

/** Shared with `canonicalizeHierarchyItemTitle`, so one cap governs the surface. */
export const LINEAR_ISSUE_TITLE_MAX_CHARS = 240;

/** Render the canonical provider-visible issue body. */
export function renderLinearIssueBodyV1(fields: LinearIssueBodyFieldsV1): string {
  const body = LINEAR_ISSUE_SECTIONS_V1.flatMap((section) => [
    `## ${section.heading}`,
    renderSection(section, fields),
  ]).join("\n\n");
  assertCleanLinearHumanOutputV1(body, "Linear issue description");
  return body;
}

/**
 * Structural gate for a provider-visible body. Throws naming the sections that
 * are missing, so the caller can hand the model an actionable correction.
 */
export function assertLinearIssueBodyV1(value: string, label: string): void {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  const headings = [...value.matchAll(/^[^\S\r\n]*##[^\S\r\n]+(.+?)[^\S\r\n]*$/gmu)].map(
    (match) => match[1],
  );
  const present = new Set(headings);
  const missing = LINEAR_ISSUE_SECTION_HEADINGS_V1.filter(
    (heading) => !present.has(heading),
  );
  if (missing.length > 0) {
    throw new Error(
      `${label} is missing required section${missing.length === 1 ? "" : "s"}: ${missing
        .map((heading) => `## ${heading}`)
        .join(", ")}.`,
    );
  }
  const unexpected = headings.filter(
    (heading) => !LINEAR_ISSUE_SECTION_HEADINGS_V1.includes(heading),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `${label} contains unsupported section${unexpected.length === 1 ? "" : "s"}: ${unexpected
        .map((heading) => `## ${heading}`)
        .join(", ")}. Use only the managed template sections.`,
    );
  }
  const order = headings.filter((heading) =>
    LINEAR_ISSUE_SECTION_HEADINGS_V1.includes(heading),
  );
  const outOfOrder = order.some(
    (heading, index) => heading !== LINEAR_ISSUE_SECTION_HEADINGS_V1[index],
  );
  if (outOfOrder) {
    throw new Error(
      `${label} sections are out of order. Expected: ${LINEAR_ISSUE_SECTION_HEADINGS_V1.join(
        ", ",
      )}.`,
    );
  }
  if (/^[^\S\r\n]*[-*][^\S\r\n]+\[[ xX]\]/mu.test(value)) {
    throw new Error(
      `${label} contains task-list checkboxes. Linear rewrites them on round-trip, which breaks exact readback; use plain "- " bullets.`,
    );
  }
  assertCleanLinearHumanOutputV1(value, label);
}

/** Reject provider-visible text carrying host-internal metadata. */
export function assertCleanLinearHumanOutputV1(value: string, label: string): void {
  if (
    /sha256:[a-f0-9]{64}|<!--\s*agentic-[^>]*-->|##\s*Machine contract|\bWork item:\s*sha256:/iu.test(
      value,
    )
  ) {
    throw new Error(`${label} contains internal agent metadata.`);
  }
  if (/\{\{[^{}\r\n]{1,200}\}\}/u.test(value)) {
    throw new Error(`${label} contains an unresolved template placeholder.`);
  }
}

/**
 * Collapse a title to its stable form. Dedupe and hierarchy reconciliation both
 * match on exact title, so incidental whitespace or a trailing period is the
 * difference between reusing an issue and creating a duplicate.
 */
export function normalizeLinearIssueTitleV1(value: string): string {
  if (typeof value !== "string") {
    throw new Error("Linear issue title must be a string.");
  }
  const normalized = value.replace(/\s+/gu, " ").trim().replace(/\.+$/u, "").trim();
  if (!normalized) {
    throw new Error("Linear issue title is empty.");
  }
  if (normalized.length > LINEAR_ISSUE_TITLE_MAX_CHARS) {
    throw new Error(
      `Linear issue title exceeds ${LINEAR_ISSUE_TITLE_MAX_CHARS} characters.`,
    );
  }
  return normalized;
}

/**
 * Non-throwing title gate for model-authored arguments. The host validates
 * rather than silently rewriting, so a rejected title is corrected by the model.
 */
export function getLinearIssueTitleProblemV1(value: string): string | null {
  try {
    normalizeLinearIssueTitleV1(value);
  } catch (error) {
    return error instanceof Error ? error.message : "Linear issue title is invalid.";
  }
  if (/^\s*#{1,6}\s/u.test(value)) {
    return "Linear issue title must be plain text without a markdown heading marker.";
  }
  if (/[\r\n]/u.test(value)) {
    return "Linear issue title must be a single line.";
  }
  return null;
}

/** Generate the managed vault template from the same ordered contract. */
export function buildLinearIssueTemplateV1(): string {
  return `${[
    "# {{title}}",
    ...LINEAR_ISSUE_SECTIONS_V1.flatMap((section) => [
      `## ${section.heading}`,
      `{{${section.placeholder}}}`,
    ]),
  ].join("\n\n")}\n`;
}

function renderSection(
  section: LinearIssueSectionV1,
  fields: LinearIssueBodyFieldsV1,
): string {
  const value = fields[section.field];
  if (section.kind === "text") {
    const text = typeof value === "string" ? value.trim() : "";
    return text || `_${section.emptyText}_`;
  }
  if (section.kind === "criteria") {
    const criteria = Array.isArray(value)
      ? (value as readonly LinearIssueAcceptanceCriterionV1[])
      : [];
    const rendered = criteria
      .map((criterion) => {
        const text = String(criterion?.text ?? "").trim();
        const id = typeof criterion?.id === "string" ? criterion.id.trim() : "";
        return id ? `- **${escapeInline(id)}** - ${text}` : `- ${text}`;
      })
      .filter((line) => line !== "- ");
    return rendered.length > 0 ? rendered.join("\n") : `_${section.emptyText}_`;
  }
  const entries = Array.isArray(value)
    ? (value as readonly string[])
        .map((entry) => String(entry ?? "").trim())
        .filter(Boolean)
    : [];
  return entries.length > 0
    ? entries.map((entry) => `- ${entry}`).join("\n")
    : `_${section.emptyText}_`;
}

export function escapeInline(value: string): string {
  return value.replace(/([`*_\\])/g, "\\$1");
}
