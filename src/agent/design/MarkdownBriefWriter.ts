import type { CreateDesignPackageInput } from "./DesignPackageTypes";
import { assessDesignPackage } from "./DesignPackageAssessment";

export function buildDesignPackageBrief(
  input: CreateDesignPackageInput,
  canvasPath: string,
  svgPath?: string,
): string {
  if (input.briefMarkdown?.trim()) {
    return ensureTrailingNewline(input.briefMarkdown.trim());
  }

  const assessment = assessDesignPackage(input);
  const domainReview = buildDomainReview(input, assessment);
  return ensureTrailingNewline([
    `# ${input.title}`,
    "",
    `Design package kind: \`${input.kind}\``,
    "",
    `Canvas: [[${canvasPath}]]`,
    ...(svgPath ? ["", `SVG image: ![[${svgPath}]]`] : []),
    "",
    "## Assumptions",
    "",
    "- The package captures the first-pass structure from the mission prompt.",
    "- Details should be refined against user and source evidence before implementation.",
    "",
    "## Items",
    "",
    ...input.items.map((item) => {
      const details = item.details?.length
        ? ` Details: ${item.details.join("; ")}`
        : "";
      return `- **${item.title}** (${item.kind}): ${item.summary}${details}`;
    }),
    "",
    "## Relationships",
    "",
    ...(input.edges.length > 0
      ? input.edges.map((edge) =>
          `- ${edge.from} -> ${edge.to}${edge.label ? `: ${edge.label}` : ""}`,
        )
      : ["- No explicit relationships supplied."]),
    "",
    "## Risks",
    "",
    ...input.items
      .filter((item) => item.kind === "risk")
      .map((item) => `- ${item.title}: ${item.summary}`),
    ...(input.items.some((item) => item.kind === "risk")
      ? []
      : ["- No explicit risk items supplied."]),
    "",
    "## Metrics",
    "",
    ...input.items
      .filter((item) => item.kind === "metric")
      .map((item) => `- ${item.title}: ${item.summary}`),
    ...(input.items.some((item) => item.kind === "metric")
      ? []
      : ["- No explicit metric items supplied."]),
    ...domainReview,
    "",
    "## Next Steps",
    "",
    "- Review assumptions.",
    "- Convert high-confidence items into implementation tasks.",
    "- Validate dependencies, risks, and metrics with stakeholders or sources.",
  ].join("\n"));
}

function buildDomainReview(
  input: CreateDesignPackageInput,
  assessment: ReturnType<typeof assessDesignPackage>,
): string[] {
  if (assessment.coveredConcerns.length === 0 && assessment.warnings.length === 0) {
    return [];
  }

  const heading = input.kind === "distributed_system"
    ? "## Scale, Reliability, Security, and Operations Review"
    : input.kind === "manufacturing_process"
      ? "## Flow, Quality, Safety, and Performance Review"
      : "## Ownership, Controls, Exceptions, and Metrics Review";

  return [
    "",
    heading,
    "",
    "### Covered concerns",
    "",
    ...(assessment.coveredConcerns.length > 0
      ? assessment.coveredConcerns.map((concern) => `- ${concern}`)
      : ["- No domain concern has explicit evidence yet."]),
    "",
    "### Outstanding proof debt",
    "",
    ...(assessment.warnings.length > 0
      ? assessment.warnings.map((warning) => `- ${warning}`)
      : ["- None detected by the structural domain review."]),
    "",
    "> Structural coverage is not a capacity calculation, safety certification, or production-readiness approval. Validate assumptions and source evidence before implementation.",
  ];
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
