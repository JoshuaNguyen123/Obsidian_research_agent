import { JEV_DECISION_ENDPOINT_V1 } from "./decisionClient";

/**
 * The one integration setting. Off makes no decision requests and constructs
 * no client; Shadow asks and records comparisons without changing routing,
 * research plans, or writeback; Enabled lets a component act — but only a
 * component that has passed its promotion gate (see
 * {@link DECISION_PROMOTION_MANIFEST_V1}). An unpromoted component keeps
 * running in Shadow however the setting reads.
 */
export type DecisionModelModeV1 = "off" | "shadow" | "enabled";

export const DEFAULT_DECISION_MODEL_MODE_V1: DecisionModelModeV1 = "off";

export function normalizeDecisionModelModeV1(value: unknown): DecisionModelModeV1 {
  return value === "shadow" || value === "enabled" || value === "off"
    ? value
    : DEFAULT_DECISION_MODEL_MODE_V1;
}

/** The two independently promoted integrations. */
export type DecisionComponentV1 = "mission_routing" | "claim_support";

export interface DecisionComponentPromotionV1 {
  promoted: boolean;
  /** ISO date of the frozen held-out evaluation that decided this entry. */
  evaluatedAt: string | null;
  /** Where the evaluation report lives (local, gitignored). */
  report: string | null;
  /** Why the component is (not) promoted, in words for Run Details. */
  reason: string;
}

/**
 * Promotion is a code change backed by an evaluation report, never a runtime
 * toggle: templates and thresholds are frozen before the held-out run, and a
 * component moves to `promoted: true` only when every gate in
 * `scripts/decision-eval.ts` passes for it. A failed or missing evaluation
 * leaves it in Shadow and the report says why.
 */
export const DECISION_PROMOTION_MANIFEST_V1: Readonly<
  Record<DecisionComponentV1, DecisionComponentPromotionV1>
> = Object.freeze({
  mission_routing: Object.freeze({
    promoted: false,
    evaluatedAt: null,
    report: null,
    reason:
      "No held-out comparison against a live decision model has passed the routing and evidence gates yet.",
  }),
  claim_support: Object.freeze({
    promoted: false,
    evaluatedAt: "2026-09-28",
    report: "docs/eval/decisions/live-heldout-2026-09-28T19-23-56-585Z.md; docs/eval/decisions/live-e2e-comparison-2026-09-28.md",
    reason:
      "Passed the frozen held-out gates, but in the end-to-end comparison one of two Enabled drafts that reached the check was held over the note's own limitations sentence (\"Could not verify: …\"). Held in Shadow until limitation and process sentences cannot hold a draft.",
  }),
});

export type DecisionPromotionManifestV1 = Readonly<
  Record<DecisionComponentV1, Pick<DecisionComponentPromotionV1, "promoted" | "reason">>
>;

export interface DecisionComponentResolutionV1 {
  component: DecisionComponentV1;
  configured: DecisionModelModeV1;
  effective: DecisionModelModeV1;
  /** Present when Enabled was configured but the component runs in Shadow. */
  heldInShadowBecause: string | null;
}

export function resolveDecisionComponentModeV1(
  configured: DecisionModelModeV1,
  component: DecisionComponentV1,
  manifest: DecisionPromotionManifestV1 = DECISION_PROMOTION_MANIFEST_V1,
): DecisionComponentResolutionV1 {
  if (configured !== "enabled") {
    return { component, configured, effective: configured, heldInShadowBecause: null };
  }
  const entry = manifest[component];
  if (entry.promoted) {
    return { component, configured, effective: "enabled", heldInShadowBecause: null };
  }
  return {
    component,
    configured,
    effective: "shadow",
    heldInShadowBecause: entry.reason,
  };
}

/**
 * The disposable-vault e2e harness may treat every component as promoted so a
 * journey can exercise Enabled behavior end to end. Honored only together
 * with the hidden harness attestation flag, which a normal install never sets.
 */
export function promotionManifestForSettingsV1(settings: {
  e2eHarnessAttestationEnabled?: boolean;
  decisionE2EHarnessPromotion?: boolean;
} | null | undefined): DecisionPromotionManifestV1 {
  if (
    settings?.e2eHarnessAttestationEnabled === true &&
    settings.decisionE2EHarnessPromotion === true
  ) {
    return {
      mission_routing: { promoted: true, reason: "Promoted by the disposable e2e harness." },
      claim_support: { promoted: true, reason: "Promoted by the disposable e2e harness." },
    };
  }
  return DECISION_PROMOTION_MANIFEST_V1;
}

/**
 * The decision endpoint. Production always uses OpenRouter; an override is
 * accepted only for a loopback address, because the request carries the
 * OpenRouter credential and a test double must never be a remote host.
 */
export function resolveDecisionEndpointV1(override: unknown): string {
  if (typeof override !== "string" || !override.trim()) {
    return JEV_DECISION_ENDPOINT_V1;
  }
  try {
    const url = new URL(override.trim());
    const host = url.hostname.toLowerCase();
    const loopback =
      host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
    if (loopback && (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password) {
      return url.toString();
    }
  } catch {
    // A malformed override is ignored, never guessed at.
  }
  return JEV_DECISION_ENDPOINT_V1;
}
