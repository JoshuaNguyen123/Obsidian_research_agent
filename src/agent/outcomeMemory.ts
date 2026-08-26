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
 * Half-life, in days, for weighting an observation by how recently it was seen.
 *
 * Counters are monotonic and the ledger is an exact record of what happened, so
 * ageing is applied when the ledger is *read*, never by rewriting stored counts.
 * That keeps `mergeToolOutcomeMemoryV1` exact and leaves every fingerprint
 * valid. Without this a failure stays as damning the day a fix lands as it was
 * the day it was observed: after the create-file collision repair landed, the
 * ledger still carried every pre-fix failure and clearing them cost roughly one
 * success per historical failure.
 */
export const OUTCOME_RECENCY_HALF_LIFE_DAYS = 30;
/**
 * Minimum share of attempts that must have failed before a record is described
 * to the model as a failing approach.
 *
 * The ranking penalty has always scaled by failure ratio, but the prompt
 * projection filtered on the raw failure count alone -- so a tool that failed
 * three times and succeeded three hundred was still announced as an approach to
 * avoid. Both readers now derive their counts from `weightedOutcomeCounts`.
 */
export const MIN_NOTABLE_FAILURE_RATIO = 0.34;

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
 * Fold two ledgers into one, summing counters per identity.
 *
 * Needed because the ledger moved from folder scope to vault scope. Existing
 * vaults hold a `tool-outcome-memory.json` under each project folder the agent
 * ever ran in, and each one is real observed history -- discarding it would
 * make the promotion cost the user everything the agent had learned so far.
 * Records are keyed by tool name, error code, and target kind, and the
 * timestamps bracket rather than order, so folding is exact: two ledgers that
 * saw the same failure twice each report four failures, not two.
 */
export function mergeToolOutcomeMemoryV1(
  left: ToolOutcomeMemoryV1,
  right: ToolOutcomeMemoryV1,
): ToolOutcomeMemoryV1 {
  const byId = new Map<string, ToolOutcomeRecordV1>();
  for (const record of [...left.records, ...right.records]) {
    const existing = byId.get(record.id);
    byId.set(
      record.id,
      finalizeRecord({
        version: 1,
        id: record.id,
        toolName: record.toolName,
        errorCode: record.errorCode,
        targetKind: record.targetKind,
        successes: (existing?.successes ?? 0) + record.successes,
        failures: (existing?.failures ?? 0) + record.failures,
        firstSeen: earlierTimestamp(existing?.firstSeen, record.firstSeen),
        lastSeen: laterTimestamp(existing?.lastSeen, record.lastSeen),
      }),
    );
  }
  return { version: 1, records: evictToCap([...byId.values()]) };
}

/** Milliseconds in a day, for recency weighting. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Weight of an observation given how long ago it was last seen. 1 at the moment
 * of observation, 0.5 after one half-life, never negative. An unparseable or
 * future timestamp weighs 1: the ledger should not silently discount a record
 * because a clock disagreed.
 */
export function outcomeRecencyWeight(lastSeen: string, now: Date): number {
  const seenMs = Date.parse(lastSeen);
  if (!Number.isFinite(seenMs)) return 1;
  const ageMs = now.getTime() - seenMs;
  if (!(ageMs > 0)) return 1;
  return 0.5 ** (ageMs / DAY_MS / OUTCOME_RECENCY_HALF_LIFE_DAYS);
}

export interface WeightedOutcomeCounts {
  failures: number;
  successes: number;
  attempts: number;
  failureRatio: number;
}

/** Recency-weighted counts for a single record. */
export function weightedOutcomeCounts(
  record: ToolOutcomeRecordV1,
  now: Date,
): WeightedOutcomeCounts {
  const weight = outcomeRecencyWeight(record.lastSeen, now);
  const failures = record.failures * weight;
  const successes = record.successes * weight;
  const attempts = failures + successes;
  return {
    failures,
    successes,
    attempts,
    failureRatio: attempts === 0 ? 0 : failures / attempts,
  };
}

/**
 * Recency-weighted counts for a whole tool, summed across its records.
 *
 * The failure ratio has to be computed here rather than per record. A record's
 * identity includes its error code and a success is recorded with an empty one,
 * so successes and failures for the same tool always land in *different*
 * records -- which makes any single failure record's ratio vacuously 1. Only
 * the tool-level aggregate can tell "this mostly works" from "this is broken".
 *
 * This is the single place both readers get their counts: the ranking penalty
 * scores the aggregate, and the prompt projection gates each record on it. They
 * previously disagreed -- the penalty scaled by ratio while the prompt filtered
 * on raw failure count -- so an approach that failed three times and succeeded
 * three hundred was still announced to the model as one to avoid.
 */
export function aggregateWeightedOutcomeCounts(
  memory: ToolOutcomeMemoryV1,
  toolName: string,
  targetKind: ToolOutcomeTargetKind = "none",
  now: Date = new Date(),
): WeightedOutcomeCounts {
  let failures = 0;
  let successes = 0;
  for (const record of memory.records) {
    if (record.toolName !== toolName) continue;
    // A record for a different target kind still carries signal about the tool
    // itself, but the matching target kind is what we are actually asking about.
    if (record.targetKind !== targetKind && targetKind !== "none") continue;
    const counts = weightedOutcomeCounts(record, now);
    failures += counts.failures;
    successes += counts.successes;
  }
  const attempts = failures + successes;
  return {
    failures,
    successes,
    attempts,
    failureRatio: attempts === 0 ? 0 : failures / attempts,
  };
}

/**
 * Whether a record is worth telling the model to avoid: enough recent failures
 * of this exact shape to be a pattern, and a tool whose overall record is bad
 * enough that the approach is not just the occasional miss of one that works.
 */
export function isNotablyFailing(
  memory: ToolOutcomeMemoryV1,
  record: ToolOutcomeRecordV1,
  now: Date,
): boolean {
  if (weightedOutcomeCounts(record, now).failures <= PENALTY_FREE_FAILURES) {
    return false;
  }
  const aggregate = aggregateWeightedOutcomeCounts(
    memory,
    record.toolName,
    record.targetKind,
    now,
  );
  return aggregate.failureRatio >= MIN_NOTABLE_FAILURE_RATIO;
}

/**
 * Bounded ranking penalty for one candidate tool.
 *
 * Grows with the log of the failure count so a long tail of failures cannot run
 * away, is scaled by the observed failure ratio, and is clamped to
 * MAX_OUTCOME_PENALTY. Returns 0 for anything with no failure history.
 *
 * Counts are aggregated across every matching record rather than gated record
 * by record: a tool that fails three different ways is a worse bet than the
 * three records suggest individually, and that aggregate signal is the point of
 * the penalty. The prompt projection gates per record instead, because it is
 * naming specific approaches rather than scoring a tool.
 */
export function outcomePenaltyForAction(
  memory: ToolOutcomeMemoryV1,
  toolName: string,
  targetKind: ToolOutcomeTargetKind = "none",
  now: Date = new Date(),
): number {
  const name = toolName.trim();
  if (!name) {
    return 0;
  }

  const { failures, failureRatio } = aggregateWeightedOutcomeCounts(
    memory,
    name,
    targetKind,
    now,
  );

  if (failures <= PENALTY_FREE_FAILURES) {
    return 0;
  }

  const magnitude = Math.log2(failures - PENALTY_FREE_FAILURES + 1);
  return Math.min(MAX_OUTCOME_PENALTY, magnitude * failureRatio);
}

/**
 * The repeatedly-failing attempts, worst first. This is the prompt-facing view:
 * tool names and error codes only, never paths, URLs, or vault structure.
 *
 * Reported counts are the raw observed ones -- the model is being told what
 * actually happened -- while selection and ordering use the recency-weighted
 * counts, so a stale failure stops being announced without the record lying
 * about its own history.
 */
export function summarizeOutcomeMemoryForPrompt(
  memory: ToolOutcomeMemoryV1,
  limit = 8,
  now: Date = new Date(),
): string | null {
  const notable = memory.records
    .filter((record) => isNotablyFailing(memory, record, now))
    .sort(
      (left, right) =>
        weightedOutcomeCounts(right, now).failures -
          weightedOutcomeCounts(left, now).failures ||
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
