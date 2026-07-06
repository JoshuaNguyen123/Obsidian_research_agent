import type { CreateDesignPackageInput } from "./DesignPackageTypes";

export function buildDesignPackageBrief(
  input: CreateDesignPackageInput,
  canvasPath: string,
): string {
  if (input.briefMarkdown?.trim()) {
    return ensureTrailingNewline(input.briefMarkdown.trim());
  }

  return ensureTrailingNewline([
    `# ${input.title}`,
    "",
    `Design package kind: \`${input.kind}\``,
    "",
    `Canvas: [[${canvasPath}]]`,
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
    "",
    "## Next Steps",
    "",
    "- Review assumptions.",
    "- Convert high-confidence items into implementation tasks.",
    "- Validate dependencies, risks, and metrics with stakeholders or sources.",
  ].join("\n"));
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
