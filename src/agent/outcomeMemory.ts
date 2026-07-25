/**
 * Cross-run tool outcome memory (G3).
 *
 * The recovery engine is well built but amnesiac. `planRecovery` reasons over
 * `attemptedActions` and `maxAttemptsPerNode` that are both scoped to the
 * current run's input, and `reflex/actionScorer.ts` ranks candidates from a
 * hardcoded `if (allowedToolNames.has(...))` chain with static rationales and
 * no outcome term. `projectMemory.ts` only resolves where the memory folder
 * lives; `researchMemoryV2` stores research findings, not execution outcomes.
 *
 * So every run rediscovers the same dead ends. The repo's own compound log
 * shows exactly this: a `workspace_exists` spin that had to be fixed by
 * rebinding logic, and `github_offered_unused_steps` climbing across runs while
 * the model retried a path that had never worked.
 *
 * This module records what actually happened to a tool call, keyed tightly
 * enough to be actionable and coarsely enough to generalize: the tuple
 * (toolName, errorCode, targetKind). It answers one question — "has this exact
 * kind of attempt failed here before, and how often?" — and converts the answer
 * into a bounded ranking penalty.
 *
 * Deliberate non-goals, per AGENTS.md: no embeddings, no vector database, no
 * persisted semantic index, no backend service. This is a bounded, vault-local
 * JSON record set with deterministic fingerprints, matching the pattern already
 * used by `researchMemoryV2.ts`.
 *
 * Safety posture: the penalty is bounded and can only ever *deprioritize*. It
 * never removes a tool from the allowed set, never blocks a call, and never
 * grants authority — a tool the user just authorized stays callable no matter
 * how bad its history is. Memory biases ordering, not permission.
 *
 * ## Runtime integration
 *
 * 1. `main.ts` loads `ToolOutcomeMemoryV1` from project memory at run start.
 * 2. `AgentRunner` folds each observed result in with `recordToolOutcome`.
 * 3. `scoreCandidateActions` subtracts the bounded, normalized outcome penalty
 *    before stable sorting.
 * 4. `summarizeOutcomeMemoryForPrompt(memory)` gives the model the same
 *    target-kind history without exposing raw targets.
 */

import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";

/** Hard cap on retained records. Keeps the prompt projection and file bounded. */
export const MAX_OUTCOME_RECORDS = 200;
/** Failures below this count are noise, not a pattern. */
export const PENALTY_FREE_FAILURES = 1;
/** Ceiling on the ranking penalty, so history can never dominate live intent. */
export const MAX_OUTCOME_PENALTY = 3;

/**
 * Coarse classification of what a tool was pointed at. Deliberately not the raw
 * path or URL: the useful generalization is "writes to a vault note keep
 * failing", not "this one note failed". Raw targets would also leak vault
 * structure into any prompt projection.
 */
export type ToolOutcomeTargetKind =
  | "vault_note"
  | "vault_folder"
  | "web_resource"
  | "code_workspace"
  | "external_service"
  | "none";

export interface ToolOutcomeRecordV1 {
  version: 1;
  id: string;
  toolName: string;
  /** Empty string for successes. */
  errorCode: string;
  targetKind: ToolOutcomeTargetKind;
  successes: number;
  failures: number;
  firstSeen: string;
  lastSeen: string;
  fingerprint: string;
}

export interface ToolOutcomeMemoryV1 {
  version: 1;
  records: ToolOutcomeRecordV1[];
}

export interface ToolOutcomeObservation {
  toolName: string;
  ok: boolean;
  errorCode?: string;
  targetKind?: ToolOutcomeTargetKind;
  observedAt: string;
}

export function createToolOutcomeMemory(): ToolOutcomeMemoryV1 {
  return { version: 1, records: [] };
}

/**
 * Coarse target classification from the tool call alone.
 *
 * Deliberately derived from the tool name and argument *shape*, never from the
 * argument values: the record must generalize ("vault writes keep failing")
 * and must not carry paths or URLs that would leak vault structure into the
 * prompt projection.
 */
export function classifyToolTargetKind(
  toolName: string,
  args: Record<string, unknown> = {},
): ToolOutcomeTargetKind {
  const name = toolName.trim().toLowerCase();
  if (!name) return "none";

  if (name.startsWith("code_workspace") || name.startsWith("code_")) {
    return "code_workspace";
  }
  if (
    name.startsWith("github_") ||
    name.startsWith("linear_") ||
    name.startsWith("publish_")
  ) {
    return "external_service";
  }
  if (name.startsWith("web_") || typeof args.url === "string") {
    return "web_resource";
  }
  if (name.includes("folder") || name.includes("directory")) {
    return "vault_folder";
  }
  if (
    name.includes("file") ||
    name.includes("note") ||
    typeof args.path === "string"
  ) {
    return "vault_note";
  }
  return "none";
}

/**
 * Fold one tool result into memory.
 *
 * Successes and failures for the same (tool, target) are tracked on the same
 * record so the penalty can reflect a ratio rather than a raw failure count — a
 * tool that fails twice out of fifty is not the same as one that fails twice
 * out of two.
 */
export function recordToolOutcome(
  memory: ToolOutcomeMemoryV1,
  observation: ToolOutcomeObservation,
): ToolOutcomeMemoryV1 {
  const toolName = observation.toolName.trim();
  if (!toolName) {
    return memory;
  }
  const observedAt = normalizeTimestamp(observation.observedAt);
  if (!observedAt) {
    return memory;
  }

  const targetKind = observation.targetKind ?? "none";
  const errorCode = observation.ok ? "" : (observation.errorCode?.trim() || "unknown");
  const key = outcomeRecordKey(toolName, errorCode, targetKind);

  const records = [...memory.records];
  const index = records.findIndex((record) => record.id === key);
  const existing = index >= 0 ? records[index] : null;

  const merged = finalizeRecord({
    version: 1,
    id: key,
    toolName,
    errorCode,
    targetKind,
    successes: (existing?.successes ?? 0) + (observation.ok ? 1 : 0),
    failures: (existing?.failures ?? 0) + (observation.ok ? 0 : 1),
    // Observations are not guaranteed to arrive in order: a resumed or
    // replayed run can fold in an older outcome after a newer one. Keep the
    // window as the true bracket rather than as insertion order.
    firstSeen: earlierTimestamp(existing?.firstSeen, observedAt),
    lastSeen: laterTimestamp(existing?.lastSeen, observedAt),
  });

  if (index >= 0) {
    records[index] = merged;
  } else {
    records.push(merged);
  }

  return { version: 1, records: evictToCap(records) };
}

/**
 * Bounded ranking penalty for one candidate tool.
 *
 * Grows with the log of the failure count so a long tail of failures cannot run
 * away, is scaled by the observed failure ratio, and is clamped to
 * MAX_OUTCOME_PENALTY. Returns 0 for anything with no failure history.
 */
export function outcomePenaltyForAction(
  memory: ToolOutcomeMemoryV1,
  toolName: string,
  targetKind: ToolOutcomeTargetKind = "none",
): number {
  const name = toolName.trim();
  if (!name) {
    return 0;
  }

  let failures = 0;
  let successes = 0;
  for (const record of memory.records) {
    if (record.toolName !== name) continue;
    // A record for a different target kind still carries signal about the tool
    // itself, but the matching target kind is what we are actually asking about.
    if (record.targetKind !== targetKind && targetKind !== "none") continue;
    failures += record.failures;
    successes += record.successes;
  }

  if (failures <= PENALTY_FREE_FAILURES) {
    return 0;
  }

  const attempts = failures + successes;
  const failureRatio = attempts === 0 ? 0 : failures / attempts;
  const magnitude = Math.log2(failures - PENALTY_FREE_FAILURES + 1);
  return Math.min(MAX_OUTCOME_PENALTY, magnitude * failureRatio);
}

/**
 * The repeatedly-failing attempts, worst first. This is the prompt-facing view:
 * tool names and error codes only, never paths, URLs, or vault structure.
 */
export function summarizeOutcomeMemoryForPrompt(
  memory: ToolOutcomeMemoryV1,
  limit = 8,
): string | null {
  const notable = memory.records
    .filter((record) => record.failures > PENALTY_FREE_FAILURES)
    .sort(
      (left, right) =>
        right.failures - left.failures ||
        right.lastSeen.localeCompare(left.lastSeen),
    )
    .slice(0, Math.max(0, limit));

  if (notable.length === 0) {
    return null;
  }

  return [
    "Known failing approaches from earlier runs in this project (avoid repeating them):",
    ...notable.map(
      (record) =>
        `- ${record.toolName} on ${record.targetKind}: failed ${record.failures}x with ${record.errorCode}` +
        (record.successes > 0 ? ` (succeeded ${record.successes}x)` : ""),
    ),
  ].join("\n");
}

/** Reject a record set whose fingerprints do not verify (tampered/corrupt file). */
export function isValidToolOutcomeMemory(
  value: ToolOutcomeMemoryV1,
): boolean {
  if (value?.version !== 1 || !Array.isArray(value.records)) {
    return false;
  }
  return value.records.every((record) => {
    if (record?.version !== 1 || typeof record.fingerprint !== "string") {
      return false;
    }
    return finalizeRecord(record).fingerprint === record.fingerprint;
  });
}

export function outcomeRecordKey(
  toolName: string,
  errorCode: string,
  targetKind: ToolOutcomeTargetKind,
): string {
  const digest = portableSha256Text(
    canonicalJson({ toolName, errorCode, targetKind }),
  );
  return `tool_outcome_${digest.slice(0, 24)}`;
}

function finalizeRecord(
  record: Omit<ToolOutcomeRecordV1, "fingerprint"> & { fingerprint?: string },
): ToolOutcomeRecordV1 {
  const {
    fingerprint: _ignored,
    // Counters and observation times are the mutable part of the record; the
    // fingerprint covers identity only, so it stays stable as counts grow.
    successes,
    failures,
    firstSeen,
    lastSeen,
    ...identity
  } = record;
  const fingerprint = `sha256:${portableSha256Text(canonicalJson(identity))}`;
  return {
    ...identity,
    successes,
    failures,
    firstSeen,
    lastSeen,
    fingerprint,
  };
}

/** LRU by `lastSeen`: the oldest untouched records fall off first. */
function evictToCap(records: ToolOutcomeRecordV1[]): ToolOutcomeRecordV1[] {
  if (records.length <= MAX_OUTCOME_RECORDS) {
    return records;
  }
  return [...records]
    .sort((left, right) => right.lastSeen.localeCompare(left.lastSeen))
    .slice(0, MAX_OUTCOME_RECORDS);
}

function laterTimestamp(existing: string | undefined, candidate: string): string {
  if (!existing) return candidate;
  return candidate.localeCompare(existing) > 0 ? candidate : existing;
}

function earlierTimestamp(existing: string | undefined, candidate: string): string {
  if (!existing) return candidate;
  return candidate.localeCompare(existing) < 0 ? candidate : existing;
}

function normalizeTimestamp(value: string): string | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
