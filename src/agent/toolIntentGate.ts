/**
 * Host intent gates: tool sites across vault/code/graph/web-viewer throw
 * "<tool> requires the user to explicitly ask ..." when the mission prompt
 * lacks explicit intent for a side-effecting action. The tool worked as
 * designed by refusing — these are policy skips, not tool or vault failures.
 *
 * Shared here so the Chat timeline (skip badge) and the runner's loop ledger
 * classify the same event the same way. The ledger consequence matters for
 * weaker tool-trained models: a plausible-but-unrequested call that lands in
 * `failedTools` can terminate an otherwise healthy run through
 * `required_tools_failed`, and an opaque policy error invites the recorded
 * wandering failure mode (irrelevant follow-up reads displacing required
 * work) instead of a return to the mission.
 */

const INTENT_GATE_PATTERN = /requires the user to (?:ask|explicitly ask)/i;

/** True when a tool error message is a host intent-gate refusal. */
export function isIntentGateMessage(text: string | null | undefined): boolean {
  return INTENT_GATE_PATTERN.test(text ?? "");
}

/** Event-shaped variant used by the Chat timeline. */
export function isIntentGateFailureEvent(event: {
  message?: string;
  error?: { message?: string } | null;
}): boolean {
  return isIntentGateMessage(
    `${event.message ?? ""} ${event.error?.message ?? ""}`,
  );
}

/**
 * One-shot corrective for the model after an intent-gate skip. Retrying the
 * identical call is pointless (the gate reads the original prompt, which the
 * model cannot change), so the redirect names the banned call and offers the
 * two productive exits: serve the stated mission, or finish and report the
 * skip. Kept compact — this rides inside the existing per-step prompt budget.
 */
export function buildIntentGateCorrective(toolName: string): string {
  return (
    `Host policy skipped ${toolName}: the user's request does not explicitly ask for that action, so it is out of scope for this run. ` +
    `Do not call ${toolName} again. Continue with tools that serve what the user actually asked for; ` +
    `if nothing further is needed, draft the final answer and mention the skipped action in one sentence.`
  );
}
