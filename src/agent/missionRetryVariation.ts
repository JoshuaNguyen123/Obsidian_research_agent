/**
 * Make the second attempt at a mission node different from the first.
 *
 * The graph has always carried a per-node retry budget of up to three
 * attempts, and it was dead capacity: a failed node returns to `ready`
 * unchanged — same objective, same tool menu, same arguments the model chose
 * last time — so the model reliably reproduced its own failure, and the
 * identical-fingerprint rule terminated the node at attempt two. Across the
 * whole eval corpus a third attempt has never occurred. Raising the budget
 * would change nothing; only varying the attempt can.
 *
 * So this module builds the variation: guidance naming the specific failure,
 * the tools the node actually authorizes, and — for failures a repeat cannot
 * fix — a refusal to re-run byte-identical arguments. The node's second
 * attempt then differs from its first, which is the whole point: the budget
 * was never the constraint, sameness was.
 *
 * The offered menu itself is left alone. `constrainToolsToMissionGraphFrontier`
 * already narrows it to the frontier before the turn is composed, so a second
 * narrowing here would restate that decision in a place with less context.
 *
 * What this module does NOT do is change models. Provider outages already
 * substitute the specialist at the model-call site (`runModelFallbackOnce`),
 * on eligibility limited to timeouts, network drops, and 5xx, so a tool-level
 * retry has no business making a model-quality decision on the user's behalf.
 *
 * Nor does it buy extra attempts. The graph still ends a node after two
 * identical failures, and that ceiling stays: the fix for a wasted retry is to
 * make it different, and raising the ceiling would hand an effectful node an
 * extra attempt while the append path still has no idempotency key.
 */

import type { MissionNodeV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import {
  missionFailureRepeatsUsefullyV1,
  type MissionFailureClassV1,
} from "./missionFailureClass";

export interface MissionRetryVariationPlanV1 {
  nodeId: string;
  /** The attempt this plan is for: 2 means one attempt has already failed. */
  attempt: number;
  failureClass: MissionFailureClassV1;
  /** Host guidance injected once, as a system message, before the retry. */
  guidance: string;
  /** Whether repeating byte-identical arguments should be refused once. */
  requireDifferentApproach: boolean;
}

export interface MissionRetryVariationInputV1 {
  node: Pick<MissionNodeV3, "id" | "objective" | "allowedTools" | "retries" | "status">;
  failureClass: MissionFailureClassV1;
  failureMessage?: string;
}

/**
 * Build the variation for a node that failed and is queued to run again.
 * Returns null for a node on its first attempt, or one that is not ready —
 * there is nothing to vary yet.
 */
export function buildMissionRetryVariationPlanV1(
  input: MissionRetryVariationInputV1,
): MissionRetryVariationPlanV1 | null {
  const { node } = input;
  if (node.status !== "ready") return null;
  const priorAttempts = Math.max(0, Math.floor(node.retries?.attempts ?? 0));
  if (priorAttempts < 1) return null;

  const attempt = priorAttempts + 1;
  const maxAttempts = Math.max(1, Math.floor(node.retries?.maxAttempts ?? 1));
  const repeatsUsefully = missionFailureRepeatsUsefullyV1(input.failureClass);
  const allowedTools = [...new Set(node.allowedTools ?? [])].filter(Boolean);

  return {
    nodeId: node.id,
    attempt,
    failureClass: input.failureClass,
    guidance: buildGuidance({
      nodeId: node.id,
      objective: node.objective,
      attempt,
      maxAttempts,
      failureClass: input.failureClass,
      failureMessage: input.failureMessage,
      allowedTools,
    }),
    requireDifferentApproach: !repeatsUsefully,
  };
}

/**
 * Decide whether a repeat of the same tool with the same arguments should be
 * refused. Two conditions, both required.
 *
 * First, only failures a repeat cannot fix earn a refusal: retrying an
 * identical fetch against a flaky endpoint is a legitimate thing to do, and
 * blocking it would convert a recoverable blip into a dead node.
 *
 * Second, the call must be genuinely identical after normalization. The
 * orchestrator's `approachesMateriallyDiffer` is deliberately not used here:
 * it drops tokens under three characters, so `{"section": 2}` and
 * `{"section": 3}` reduce to the same single token and a real correction
 * reads as a repeat. It was written to compare prose descriptions of an
 * approach, and a JSON argument list is not that. Refusing only an exact
 * repeat keeps this gate free of false positives, which matters because a
 * false positive here blocks the very correction the guidance asked for.
 */
export function shouldRefuseUnchangedRetryV1(input: {
  plan: MissionRetryVariationPlanV1 | null;
  previousArguments: string | undefined;
  nextArguments: string;
}): boolean {
  const { plan } = input;
  if (!plan?.requireDifferentApproach) return false;
  if (!input.previousArguments) return false;
  return (
    normalizeArguments(input.previousArguments) ===
    normalizeArguments(input.nextArguments)
  );
}

/** Stable key for "this node, this attempt", so guidance is injected once. */
export function missionRetryVariationKeyV1(
  nodeId: string,
  attempt: number,
): string {
  return `${nodeId}:${attempt}`;
}

function buildGuidance(input: {
  nodeId: string;
  objective: string;
  attempt: number;
  maxAttempts: number;
  failureClass: MissionFailureClassV1;
  failureMessage?: string;
  allowedTools: string[];
}): string {
  const failure = (input.failureMessage ?? "").replace(/\s+/gu, " ").trim();
  const lines = [
    `RETRY GUIDANCE (host-enforced) for ${input.nodeId} — attempt ${input.attempt} of ${input.maxAttempts}.`,
    `Objective: ${input.objective}`,
    failure
      ? `The previous attempt failed: ${truncate(failure, 400)}`
      : "The previous attempt failed without a usable error message.",
    classGuidance(input.failureClass),
  ];
  if (input.allowedTools.length > 0) {
    lines.push(
      `Tools available for this attempt: ${input.allowedTools.join(", ")}.`,
    );
  }
  lines.push(
    "Repeating the previous call unchanged spends the last attempt for nothing.",
  );
  return lines.join("\n");
}

function classGuidance(failureClass: MissionFailureClassV1): string {
  switch (failureClass) {
    case "external":
      return "That failure came from a remote source, not from your request. Prefer a different source, mirror, or edition; the same call against the same endpoint is unlikely to answer differently.";
    case "model_transient":
      return "The provider answered with an unusable shape. Reissue the same intent as a single well-formed call.";
    case "model_content":
      return "The arguments or content of the previous call were rejected. Correct them specifically — a different path, different parameters, or a narrower request — rather than resending them.";
    case "product":
      return "The host refused that call by contract, so it will refuse it again. Take a route this node actually authorizes.";
    default:
      return "The cause was not attributable. Change something observable about the approach before spending the next attempt.";
  }
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function normalizeArguments(value: string): string {
  return value.replace(/\s+/gu, " ").trim().toLowerCase();
}
