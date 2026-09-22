/**
 * Plain-prose account of a finished mission: what the agent did, what it
 * changed, and what it could not do. Built only from facts the run already
 * recorded (tool outcomes, receipts, acceptance gaps, blockers) — never from
 * model prose — so the same builder serves the Chat completion row, the run
 * note's summary bullets, and the completion notice.
 */

import { stopReasonChatLine, type MissionStopReason } from "./missionStopReason";

/** Items per section before the remainder collapses into "+N more". */
export const MAX_COMPLETION_SUMMARY_ITEMS = 3;

export interface MissionCompletionReceiptLikeV1 {
  toolName: string;
  operation: string;
  path?: string;
  toPath?: string;
}

export interface MissionCompletionToolOutcomeV1 {
  name: string;
  ok: number;
  failed: number;
}

export type MissionCompletionLedgerStatusV1 =
  | "running"
  | "complete"
  | "blocked"
  | "stopped"
  | "budget";

export interface MissionCompletionSummaryInputV1 {
  /** Chat-facing stop taxonomy when the run's terminal event is known. */
  stopReason?: MissionStopReason | null;
  stopDetail?: string | null;
  /** Persisted ledger status; used when no terminal event is at hand. */
  ledgerStatus?: MissionCompletionLedgerStatusV1 | null;
  receipts?: readonly MissionCompletionReceiptLikeV1[];
  /** Fallback when only a count survived (the run note keeps receipt ids only). */
  receiptCount?: number;
  evidenceCount?: number;
  tools?: readonly MissionCompletionToolOutcomeV1[];
  acceptance?: { status: string; missing: readonly string[] } | null;
  blockers?: readonly string[];
  remainingActions?: readonly string[];
  milestones?: readonly string[];
}

export interface MissionCompletionSummaryV1 {
  did: string[];
  changed: string[];
  couldNot: string[];
  /** Nothing was left undone: acceptance passed (or was never demanded) and no blocker remains. */
  complete: boolean;
}

export function buildMissionCompletionSummaryV1(
  input: MissionCompletionSummaryInputV1,
): MissionCompletionSummaryV1 {
  const did = boundedList(describeWork(input));
  const changed = boundedList(describeChanges(input));
  const couldNotRaw = describeGaps(input);
  const complete = couldNotRaw.length === 0;
  const couldNot = complete ? ["Nothing was left undone."] : boundedList(couldNotRaw);
  return { did, changed, couldNot, complete };
}

/** Three short lines for Chat: one per section, sentences joined by spaces. */
export function formatMissionCompletionSummaryProseV1(
  summary: MissionCompletionSummaryV1,
): string {
  return [
    `What I did: ${joinSentences(summary.did)}`,
    `What changed: ${joinSentences(summary.changed)}`,
    `What I could not do: ${joinSentences(summary.couldNot)}`,
  ].join("\n");
}

/**
 * Single-line bullets for the run note. They must stay one line each so the
 * ledger writer's generated-summary pattern still owns (and de-duplicates)
 * the whole section on every checkpoint.
 */
export function formatMissionCompletionSummaryBulletsV1(
  summary: MissionCompletionSummaryV1,
): string[] {
  return [
    `- What I did: ${joinSentences(summary.did)}`,
    `- What changed: ${joinSentences(summary.changed)}`,
    `- What I could not do: ${joinSentences(summary.couldNot)}`,
  ].map((line) => line.replace(/\s*[\r\n]+\s*/g, " "));
}

/** One sentence for a toast: the outcome and the first material change. */
export function missionCompletionHeadlineV1(
  summary: MissionCompletionSummaryV1,
  stopReason?: MissionStopReason | null,
): string {
  const blocked =
    stopReason === "graph_blocked" ||
    stopReason === "provider_error" ||
    stopReason === "orchestration_deadlock" ||
    stopReason === "approval_denied" ||
    stopReason === "required_tools_failed";
  if (stopReason === "approval_pending") {
    return "Mission parked: an approval expired unanswered; Continue to be asked again";
  }
  const paused =
    stopReason === "step_budget" ||
    stopReason === "model_budget" ||
    stopReason === "wall_clock" ||
    stopReason === "repeated_tool_no_progress";
  const lead = blocked
    ? "Mission blocked"
    : paused
      ? "Mission paused"
      : summary.complete
        ? "Mission done"
        : "Mission finished with gaps";
  const detail =
    blocked || paused
      ? summary.couldNot[0]
      : summary.changed[0] && summary.changed[0] !== NO_CHANGES
        ? summary.changed[0]
        : summary.did[0];
  return detail ? `${lead}: ${trimSentence(detail)}` : lead;
}

const NO_CHANGES = "No notes were changed.";

function describeWork(input: MissionCompletionSummaryInputV1): string[] {
  const lines: string[] = [];
  const tools = (input.tools ?? [])
    .filter((tool) => tool.name.trim() && tool.ok + tool.failed > 0)
    .sort((a, b) => b.ok + b.failed - (a.ok + a.failed));
  if (tools.length > 0) {
    const named = tools.slice(0, 5).map((tool) => {
      const total = tool.ok + tool.failed;
      const count = total > 1 ? ` ×${total}` : "";
      const failed = tool.failed > 0 ? ` (${tool.failed} failed)` : "";
      return `${tool.name}${count}${failed}`;
    });
    const rest = tools.length > 5 ? `, +${tools.length - 5} more` : "";
    lines.push(`Ran ${named.join(", ")}${rest}.`);
  }
  const evidence = Math.max(0, Math.trunc(input.evidenceCount ?? 0));
  if (evidence > 0) {
    lines.push(
      `Gathered evidence from ${evidence} ${evidence === 1 ? "source" : "sources"}.`,
    );
  }
  for (const milestone of input.milestones ?? []) {
    const text = milestone.trim();
    if (text) lines.push(ensurePeriod(text));
  }
  if (lines.length === 0) {
    lines.push("Answered directly without running tools.");
  }
  return lines;
}

function describeChanges(input: MissionCompletionSummaryInputV1): string[] {
  const receipts = input.receipts ?? [];
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const receipt of receipts) {
    const line = describeReceipt(receipt);
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  if (lines.length > 0) return lines;
  const count = Math.max(0, Math.trunc(input.receiptCount ?? 0));
  if (count > 0) {
    return [`${count} verified ${count === 1 ? "write" : "writes"} (see receipts).`];
  }
  return [NO_CHANGES];
}

function describeGaps(input: MissionCompletionSummaryInputV1): string[] {
  const lines: string[] = [];
  const acceptance = input.acceptance;
  if (acceptance && acceptance.status !== "pass") {
    for (const item of acceptance.missing) {
      const text = humanizeProofKey(item);
      if (text) lines.push(`Missing proof: ${text}.`);
    }
    if (acceptance.missing.length === 0) {
      lines.push(`Acceptance was ${acceptance.status.replace(/_/g, " ")}.`);
    }
  }
  for (const blocker of input.blockers ?? []) {
    const text = blocker.trim();
    if (text) lines.push(ensurePeriod(text));
  }
  const stopReason = input.stopReason ?? null;
  if (stopReason) {
    if (
      stopReason !== "verified_complete" &&
      stopReason !== "write_completed" &&
      stopReason !== "unknown"
    ) {
      lines.push(stopReasonChatLine(stopReason, input.stopDetail));
    }
  } else if (input.ledgerStatus && input.ledgerStatus !== "complete") {
    lines.push(describeLedgerStatus(input.ledgerStatus));
  }
  for (const action of input.remainingActions ?? []) {
    const text = action.trim();
    if (text && !/^none$/i.test(text)) lines.push(`Still owed: ${ensurePeriod(text)}`);
  }
  return dedupe(lines);
}

function describeReceipt(receipt: MissionCompletionReceiptLikeV1): string | null {
  const target = (receipt.toPath ?? receipt.path ?? "").trim();
  const verb = receiptVerb(receipt.operation);
  if (!verb) return null;
  if (!target) return `${capitalize(verb)} via ${receipt.toolName}.`;
  if (receipt.operation === "move" && receipt.path && receipt.toPath) {
    return `Moved ${receipt.path} to ${receipt.toPath}.`;
  }
  return `${capitalize(verb)} ${target}.`;
}

function receiptVerb(operation: string): string | null {
  switch (operation) {
    case "append":
      return "appended to";
    case "create":
      return "created";
    case "create_folder":
      return "created folder";
    case "replace":
    case "edit":
      return "rewrote";
    case "retitle":
      return "retitled";
    case "move":
      return "moved";
    case "trash":
    case "delete":
      return "trashed";
    default:
      return operation.trim() ? operation.replace(/_/g, " ") : null;
  }
}

function describeLedgerStatus(status: MissionCompletionLedgerStatusV1): string {
  switch (status) {
    case "blocked":
      return "Stopped on a blocker; see the blocker category above.";
    case "budget":
      return "Paused at a budget limit; the run is resumable.";
    case "stopped":
      return "Stopped before the mission finished.";
    case "running":
      return "Still running when this summary was written.";
    default:
      return "";
  }
}

function humanizeProofKey(value: string): string {
  return value
    .trim()
    .replace(/^tool:/i, "tool call ")
    .replace(/[_:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function boundedList(values: readonly string[]): string[] {
  const unique = dedupe(values);
  if (unique.length <= MAX_COMPLETION_SUMMARY_ITEMS) return unique;
  return [
    ...unique.slice(0, MAX_COMPLETION_SUMMARY_ITEMS),
    `+${unique.length - MAX_COMPLETION_SUMMARY_ITEMS} more.`,
  ];
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const text = value.replace(/\s+/g, " ").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function joinSentences(values: readonly string[]): string {
  return values.map(ensurePeriod).join(" ");
}

function ensurePeriod(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return trimmed;
  return /[.!?…]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function trimSentence(text: string): string {
  return text.trim().replace(/[.!?]+$/, "");
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
