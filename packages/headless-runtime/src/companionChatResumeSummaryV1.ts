import type {
  BackgroundExecutionDomainV1,
  CompanionJobStateV1,
  CompanionReceiptV1,
} from "./backgroundContinuation";
import type { MissionJsonValueV1 } from "./missionGraphV3";

const MAX_CHAT_RESUME_CHARS = 280;

export interface CompanionChatResumeSummaryInputV1 {
  jobId: string;
  missionId: string;
  nodeId: string;
  domain: BackgroundExecutionDomainV1;
  state: CompanionJobStateV1 | string;
  objective?: string | null;
  outputs?: Record<string, MissionJsonValueV1> | null;
  blocker?: {
    code?: string | null;
    message?: string | null;
    requiredAction?: string | null;
  } | null;
  receipts?: CompanionReceiptV1[];
}

/**
 * Concise Chat line for a terminal companion job so reopening Obsidian does not
 * force the operator to reconstruct background validation/CI/PR outcomes.
 * Vault work stays out of scope (waiting_obsidian is never Chat-completed here).
 */
export function buildCompanionChatResumeSummaryV1(
  input: CompanionChatResumeSummaryInputV1,
): string | null {
  const state = String(input.state ?? "").trim();
  if (!isTerminalCompanionJobState(state)) {
    return null;
  }
  if (state === "waiting_obsidian") {
    return null;
  }

  const domain = input.domain;
  const outputs = asRecord(input.outputs);
  const blockerMessage = compactText(
    input.blocker?.message ??
      textField(outputs, "message") ??
      textField(asRecord(input.blocker), "message"),
  );

  if (state === "complete") {
    return clampChatLine(completeLine(domain, outputs, input.receipts));
  }
  if (state === "cancelled") {
    return clampChatLine(`Background ${domainLabel(domain)} was cancelled.`);
  }
  const detail = blockerMessage || textField(outputs, "summary") || "see Run Details";
  return clampChatLine(
    `Background ${domainLabel(domain)} ${state === "blocked" ? "blocked" : "failed"}: ${detail}`,
  );
}

export function isTerminalCompanionJobState(state: string): boolean {
  return ["complete", "blocked", "failed", "cancelled"].includes(state);
}

function completeLine(
  domain: BackgroundExecutionDomainV1,
  outputs: Record<string, unknown>,
  receipts: CompanionReceiptV1[] | undefined,
): string {
  const conciseSummary = preferredConciseSummary(outputs);
  switch (domain) {
    case "research": {
      const sourceCount = numberField(outputs, "sourceCount");
      if (sourceCount !== null) {
        return `Background research finished (${sourceCount} source${sourceCount === 1 ? "" : "s"}).`;
      }
      return conciseSummary ?? "Background research finished.";
    }
    case "linear": {
      const issueId =
        textField(outputs, "issueId") ??
        textField(asRecord(outputs.issue), "id") ??
        textField(asRecord(outputs.issue), "identifier");
      const state = textField(outputs, "state");
      if (issueId && state) {
        return `Background Linear update verified for ${issueId} → ${state}.`;
      }
      if (issueId) {
        return `Background Linear update verified for ${issueId}.`;
      }
      return conciseSummary ?? "Background Linear update verified.";
    }
    case "code": {
      const commitSha = shortSha(
        textField(outputs, "commitSha") ??
          textField(asRecord(outputs.githubVerifiedResult), "commitSha"),
      );
      if (commitSha) {
        return `Background code validation/commit finished (${commitSha}).`;
      }
      const workspaceId = textField(outputs, "workspaceId");
      if (workspaceId) {
        return `Background code validation finished for workspace ${truncateId(workspaceId)}.`;
      }
      return conciseSummary ?? "Background code validation/commit finished.";
    }
    case "github": {
      const prNumber =
        numberField(outputs, "prNumber") ??
        numberField(asRecord(outputs.githubVerifiedResult), "prNumber") ??
        numberField(asRecord(outputs.githubVerifiedResult), "number");
      const prUrl =
        textField(outputs, "prUrl") ??
        textField(asRecord(outputs.githubVerifiedResult), "prUrl") ??
        textField(asRecord(outputs.githubVerifiedResult), "url") ??
        textField(asRecord(outputs.githubVerifiedResult), "htmlUrl");
      const headSha = shortSha(
        textField(outputs, "headSha") ??
          textField(asRecord(outputs.githubVerifiedResult), "headSha"),
      );
      const checkFingerprint = textField(outputs, "checkSnapshotFingerprint");
      if (prNumber !== null && prUrl) {
        return `Background GitHub work finished: PR #${prNumber} — ${prUrl}.`;
      }
      if (prNumber !== null) {
        return `Background GitHub work finished: PR #${prNumber}.`;
      }
      if (prUrl) {
        return `Background GitHub work finished: ${prUrl}.`;
      }
      if (headSha) {
        return `Background GitHub work finished (head ${headSha}).`;
      }
      if (checkFingerprint) {
        return "Background GitHub CI/PR watch finished with verified checks.";
      }
      if (receipts?.some((receipt) => receipt.provider === "github")) {
        return "Background GitHub work finished with verified provider readback.";
      }
      return conciseSummary ?? "Background GitHub work finished.";
    }
    default:
      return conciseSummary ?? `Background ${domainLabel(domain)} finished.`;
  }
}

/**
 * Prefer an explicit short summary. Reject research-style source dumps that
 * would overwhelm Chat on resume.
 */
function preferredConciseSummary(
  outputs: Record<string, unknown>,
): string | null {
  const summary = compactText(textField(outputs, "summary"));
  if (!summary) return null;
  if (summary.length > 160) return null;
  if (/^Source:\s/i.test(summary) || summary.includes("\n\nSource:")) {
    return null;
  }
  return summary;
}

function domainLabel(domain: BackgroundExecutionDomainV1): string {
  switch (domain) {
    case "research":
      return "research";
    case "linear":
      return "Linear";
    case "code":
      return "code";
    case "github":
      return "GitHub";
    default:
      return domain;
  }
}

function shortSha(value: string | null): string | null {
  if (!value) return null;
  const sha = value.trim();
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) return null;
  return sha.slice(0, 7).toLowerCase();
}

function truncateId(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > 36 ? `${trimmed.slice(0, 33)}…` : trimmed;
}

function clampChatLine(line: string): string {
  const cleaned = compactText(line) ?? "";
  if (cleaned.length <= MAX_CHAT_RESUME_CHARS) return cleaned;
  return `${cleaned.slice(0, MAX_CHAT_RESUME_CHARS - 1)}…`;
}

function compactText(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/\s+/gu, " ").trim();
  return cleaned ? cleaned : null;
}

function textField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  if (!source) return null;
  const value = source[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberField(
  source: Record<string, unknown> | null | undefined,
  key: string,
): number | null {
  if (!source) return null;
  const value = source[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^-?\d+$/u.test(value.trim())) {
    return Number(value.trim());
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
