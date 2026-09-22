/**
 * Vault-native mission triggers.
 *
 * A note whose frontmatter carries `agent_mission: <prompt>` and
 * `agent_mission_status: pending` launches that prompt against itself as the
 * current note, without the chat panel. The status property is the
 * idempotency key: the host flips it to `running` before the mission starts,
 * so the note's own change events (the flip, the agent's writes, the final
 * status) never re-trigger, and only a human setting it back to `pending`
 * runs it again.
 *
 * This module is the pure decision; the host owns the metadata-cache event,
 * the frontmatter writes, and the launch.
 */

import { isGeneratedOrCachePath } from "../tools/vaultExclusions";

export const VAULT_TRIGGER_MISSION_KEY = "agent_mission";
export const VAULT_TRIGGER_STATUS_KEY = "agent_mission_status";
export const VAULT_TRIGGER_RUN_ID_KEY = "agent_mission_run_id";

export const VAULT_TRIGGER_STATUSES = [
  "pending",
  "running",
  "done",
  "blocked",
  "failed",
] as const;
export type VaultTriggerStatus = (typeof VAULT_TRIGGER_STATUSES)[number];

/** Shorter than this is a stray key, not a mission. */
export const MIN_VAULT_TRIGGER_PROMPT_CHARS = 8;
/** Prompts longer than this are cut: frontmatter is not a place for essays. */
export const MAX_VAULT_TRIGGER_PROMPT_CHARS = 2_000;
/**
 * A trigger older than this is ignored so a note that arrives through sync
 * while the app is idle does not start work nobody is present for.
 */
export const MAX_VAULT_TRIGGER_AGE_MS = 5 * 60_000;
/** Debounce so a user typing the prompt does not launch it half-written. */
export const VAULT_TRIGGER_DEBOUNCE_MS = 1_500;

const STATUS_SET: ReadonlySet<string> = new Set(VAULT_TRIGGER_STATUSES);

export interface VaultTriggerV1 {
  prompt: string;
  /** Parsed status, or null when absent or not in the vocabulary. */
  status: VaultTriggerStatus | null;
  rawStatus: string | null;
}

export function isVaultTriggerStatus(value: unknown): value is VaultTriggerStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/** Read the trigger from a parsed frontmatter object (metadata-cache shape). */
export function readVaultTrigger(frontmatter: unknown): VaultTriggerV1 | null {
  if (!frontmatter || typeof frontmatter !== "object") return null;
  const record = frontmatter as Record<string, unknown>;
  const rawPrompt = record[VAULT_TRIGGER_MISSION_KEY];
  if (typeof rawPrompt !== "string") return null;
  const prompt = rawPrompt.replace(/\s+/g, " ").trim().slice(0, MAX_VAULT_TRIGGER_PROMPT_CHARS);
  if (!prompt) return null;
  const rawStatusValue = record[VAULT_TRIGGER_STATUS_KEY];
  const rawStatus =
    typeof rawStatusValue === "string" ? rawStatusValue.trim().toLowerCase() : null;
  return {
    prompt,
    status: isVaultTriggerStatus(rawStatus) ? rawStatus : null,
    rawStatus,
  };
}

export type VaultTriggerRefusal =
  | "disabled"
  | "not_markdown"
  | "no_trigger"
  | "prompt_too_short"
  | "status_not_pending"
  | "excluded_path"
  | "mission_running"
  | "stale"
  | "unattended";

export type VaultTriggerDecision =
  | { dispatch: true; prompt: string }
  | { dispatch: false; reason: VaultTriggerRefusal };

export interface VaultTriggerDecisionInput {
  path: string;
  frontmatter: unknown;
  enabled: boolean;
  /** Folders the agent writes for itself (memory, index); never triggers. */
  exclusionRoots: readonly string[];
  /** A mission is already running or being dispatched. */
  running: boolean;
  modifiedAtMs: number | null;
  nowMs: number;
  /** The note is open in the active editor. */
  noteIsActive: boolean;
  /** The Obsidian window has focus. */
  windowFocused: boolean;
}

/**
 * Whether a change to `path` should launch its frontmatter mission now.
 *
 * Attended by construction: the trigger must be recent and the user must be
 * present (the note is active, or the window is focused). Both refusals name
 * themselves so a silent non-launch is diagnosable.
 */
export function shouldDispatchVaultTrigger(
  input: VaultTriggerDecisionInput,
): VaultTriggerDecision {
  if (!input.enabled) return { dispatch: false, reason: "disabled" };
  if (!/\.md$/i.test(input.path)) return { dispatch: false, reason: "not_markdown" };
  const trigger = readVaultTrigger(input.frontmatter);
  if (!trigger) return { dispatch: false, reason: "no_trigger" };
  if (trigger.prompt.length < MIN_VAULT_TRIGGER_PROMPT_CHARS) {
    return { dispatch: false, reason: "prompt_too_short" };
  }
  // Absent status counts as pending (the user just wrote the key); anything
  // else — running, done, blocked, failed, or an unknown word — does not.
  if (trigger.rawStatus !== null && trigger.status !== "pending") {
    return { dispatch: false, reason: "status_not_pending" };
  }
  if (isGeneratedOrCachePath(input.path, [...input.exclusionRoots])) {
    return { dispatch: false, reason: "excluded_path" };
  }
  if (input.running) return { dispatch: false, reason: "mission_running" };
  if (
    input.modifiedAtMs === null ||
    !Number.isFinite(input.modifiedAtMs) ||
    input.nowMs - input.modifiedAtMs > MAX_VAULT_TRIGGER_AGE_MS
  ) {
    return { dispatch: false, reason: "stale" };
  }
  if (!input.noteIsActive && !input.windowFocused) {
    return { dispatch: false, reason: "unattended" };
  }
  return { dispatch: true, prompt: trigger.prompt };
}

/** The status the note ends with, from the runner's terminal stop reason. */
export function vaultTriggerStatusFromStopReason(
  stopReason: string | null | undefined,
): VaultTriggerStatus {
  switch (stopReason) {
    case "final":
    case "write_completed":
      return "done";
    case "budget":
    case "clarifying_question":
    case "user_stopped":
      return "blocked";
    default:
      return "failed";
  }
}
