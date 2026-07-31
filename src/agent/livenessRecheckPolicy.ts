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
}): LivenessRecheckDecision {
  if (input.enabled === false) {
    return { recheck: false, reason: "disabled_by_setting" };
  }
  if (!input.hasTransport) {
    return { recheck: false, reason: "no_transport" };
  }
  if (input.tier !== "deep" && input.tier !== "extended") {
    return { recheck: false, reason: "tier_below_threshold" };
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
