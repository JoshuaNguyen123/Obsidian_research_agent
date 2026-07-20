/**
 * Host-owned mission receipt markdown for compound lifecycle completion.
 * Deterministic; never includes model thinking or secrets.
 */

export interface MissionReceiptArtifactLinkV1 {
  system: "linear" | "github" | "obsidian" | "other";
  label: string;
  url: string;
}

export interface MissionReceiptNoteInputV1 {
  runId: string;
  completedAt: string;
  stages: string[];
  notePath?: string | null;
  linearIssueIds?: string[];
  validationShas?: string[];
  commitSha?: string | null;
  artifacts: MissionReceiptArtifactLinkV1[];
  summary?: string | null;
}

export const MISSION_RECEIPT_FOLDER = "Agent Work/Mission Receipts";

export function missionReceiptNotePath(runId: string): string {
  const safe = runId.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  return `${MISSION_RECEIPT_FOLDER}/${safe || "mission"}.md`;
}

export function formatMissionReceiptMarkdown(
  input: MissionReceiptNoteInputV1,
): string {
  const stages =
    input.stages.length > 0 ? input.stages.join(" → ") : "(none recorded)";
  const lines = [
    `# Mission receipt — ${input.runId}`,
    "",
    `- Completed: ${input.completedAt}`,
    `- Stages: ${stages}`,
  ];
  if (input.notePath?.trim()) {
    lines.push(`- Research note: \`${input.notePath.trim()}\``);
  }
  if (input.commitSha?.trim()) {
    lines.push(`- Verified commit: \`${input.commitSha.trim()}\``);
  }
  if (input.validationShas && input.validationShas.length > 0) {
    lines.push("- Validation receipts:");
    for (const sha of input.validationShas) {
      lines.push(`  - \`${sha}\``);
    }
  }
  if (input.linearIssueIds && input.linearIssueIds.length > 0) {
    lines.push("- Linear issue IDs:");
    for (const id of input.linearIssueIds) {
      lines.push(`  - \`${id}\``);
    }
  }
  if (input.artifacts.length > 0) {
    lines.push("", "## Artifacts", "");
    for (const artifact of input.artifacts) {
      lines.push(`- ${artifact.system}: [${artifact.label}](${artifact.url})`);
    }
  }
  if (input.summary?.trim()) {
    lines.push("", "## Summary", "", input.summary.trim());
  }
  lines.push("");
  return lines.join("\n");
}

/** Extract https artifact URL from a receipt-like resource bag. */
export function extractReceiptArtifactUrl(resource: unknown): string | null {
  if (!resource || typeof resource !== "object") return null;
  const record = resource as Record<string, unknown>;
  for (const key of ["url", "htmlUrl", "issueUrl", "pullRequestUrl"] as const) {
    const value = record[key];
    if (typeof value === "string" && /^https:\/\//i.test(value.trim())) {
      return value.trim();
    }
  }
  return null;
}

export function inferArtifactSystem(
  toolName: string | undefined,
  resourceSystem: string | undefined,
): MissionReceiptArtifactLinkV1["system"] {
  const haystack = `${toolName ?? ""} ${resourceSystem ?? ""}`.toLowerCase();
  if (haystack.includes("linear")) return "linear";
  if (haystack.includes("github")) return "github";
  if (haystack.includes("vault") || haystack.includes("obsidian")) {
    return "obsidian";
  }
  return "other";
}
