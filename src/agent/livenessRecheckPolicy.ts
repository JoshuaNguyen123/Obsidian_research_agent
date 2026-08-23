import type { LinkLivenessResult } from "./deadLinkCheck";

/**
 * When the single-agent path should re-probe its cited sources.
 *
 * The worker path has always done this; the single-agent path never did, so an
 * ordinary research run could cite a URL that had 404'd since it was fetched.
 * Enabling it everywhere would be wrong for two reasons, both encoded here:
 *
 *  - **Cost.** Every probe is an extra outbound request. A quick or standard
 *    mission does not warrant it; a deep or extended one, whose whole claim is
 *    thoroughness, does.
 *  - **Determinism.** The proof lanes count transport calls to prove cache
 *    reuse. Extra probes on a `standard`-tier lane would change those counts,
 *    so the tier gate is load-bearing, not a preference.
 *
 * `deadLinkRecheckEnabled` remains the kill switch on top of both.
 *
 * Pure and Obsidian-free so the decision is testable without a vault.
 */

export interface LivenessRecheckDecision {
  recheck: boolean;
  reason:
    | "disabled_by_setting"
    | "no_transport"
    | "tier_below_threshold"
    | "no_committed_note"
    | "no_cited_urls"
    | "recheck";
}

export function decideSingleAgentLivenessRecheck(input: {
  /** Research effort tier of the active plan, if any. */
  tier: string | undefined;
  /** `settings.deadLinkRecheckEnabled`; undefined means the default (on). */
  enabled: boolean | undefined;
  hasTransport: boolean;
  citedUrlCount: number;
  /**
   * The run committed a note. This is what lets `standard` probe: a caveat is
   * only worth an outbound request when there is a durable artifact to write it
   * into and a reader who will come back to it later.
   */
  committedNote?: boolean;
}): LivenessRecheckDecision {
  if (input.enabled === false) {
    return { recheck: false, reason: "disabled_by_setting" };
  }
  if (!input.hasTransport) {
    return { recheck: false, reason: "no_transport" };
  }
  const deepOrExtended = input.tier === "deep" || input.tier === "extended";
  // `quick` stays out: a quick answer makes no claim of thoroughness, and its
  // sources were usually fetched seconds ago in the same session.
  if (input.tier === "quick") {
    return { recheck: false, reason: "tier_below_threshold" };
  }
  // Everything below deep earns the probe only by producing a note. That is
  // the honest trigger: the caveat exists so a reader who comes back to a
  // durable artifact learns one of its citations has since died. It is also
  // what keeps the cache-reuse proof lanes deterministic -- they drive a
  // chat-only mission that explicitly writes nothing, so their transport
  // counts are unchanged.
  if (!deepOrExtended && !input.committedNote) {
    return { recheck: false, reason: "no_committed_note" };
  }
  if (input.citedUrlCount <= 0) {
    return { recheck: false, reason: "no_cited_urls" };
  }
  return { recheck: true, reason: "recheck" };
}

/**
 * One-line, user-facing summary of a liveness recheck, or null when every
 * cited source is fine.
 *
 * Only definitive 404/410 results appear. A bot wall or a transient 5xx stays
 * silent, because telling a user their source is dead when it is merely
 * rate-limited is worse than saying nothing.
 */
export function formatLivenessCaveat(
  results: readonly LinkLivenessResult[],
): string | null {
  const dead = results.filter((result) => result.liveness === "dead");
  if (dead.length === 0) return null;
  const noun = dead.length === 1 ? "source" : "sources";
  return [
    `Liveness recheck: ${dead.length} cited ${noun} no longer resolve and may need replacing before you rely on this.`,
    ...dead.map((result) => `- ${result.url} (HTTP ${result.status ?? "unknown"})`),
  ].join("\n");
}

/**
 * Heading the caveat section is written under, and the marker that keeps the
 * append idempotent across a resumed or re-finalized run.
 */
export const LIVENESS_CAVEAT_HEADING = "## Liveness caveats";

/**
 * The same caveat as a markdown section for the note itself.
 *
 * A dead citation reported only to the sidebar is a warning the reader never
 * sees again: the status line scrolls away, the note does not. The note is
 * already committed and a dead link is a caveat, not grounds to retract
 * verified work, so this appends and never rewrites.
 */
export function formatLivenessCaveatSection(
  results: readonly LinkLivenessResult[],
  options: { checkedAt?: string } = {},
): string | null {
  const caveat = formatLivenessCaveat(results);
  if (!caveat) return null;
  const [summary, ...rows] = caveat.split("\n");
  return [
    LIVENESS_CAVEAT_HEADING,
    "",
    options.checkedAt ? `${summary} (rechecked ${options.checkedAt})` : summary,
    "",
    ...rows,
    "",
  ].join("\n");
}
