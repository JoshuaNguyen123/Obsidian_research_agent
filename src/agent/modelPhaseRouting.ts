/**
 * Per-phase model routing (G2 scaffolding).
 *
 * The runtime already distinguishes seven kinds of model call —
 * `ModelCallPhase` is router | graph_planner | agent_step | finalizer |
 * streaming | retry | worker — and it already tags every call site with
 * `evidencePhase` (missionRouter, missionGraphPlanner, AgentRunner's step /
 * finalizer / streaming paths, codeWorker, researchWorker). `ModelChatRequest`
 * already accepts a per-request `model` override.
 *
 * Nothing sets it. `createConfiguredModelClient` binds one `settings.model` and
 * every phase pays the same price: a one-line route classification costs
 * exactly what a long synthesis costs. The repo's own compound log records a
 * run reaching modelCallCount=294 before a 45.8m timeout; the bulk of those are
 * cheap phases running on the heavyweight model.
 *
 * The seam exists. This module supplies only the decision.
 *
 * Safety posture: fail-closed toward the configured default. A phase with no
 * mapping returns the default. A mapped model that is not in the caller's
 * verified-model allowlist returns the default. That allowlist requirement is
 * the point — model identity is proven at connection time (see
 * `modelContextWindow.ts`, which refuses to trust a context length unless the
 * verified provider and model still match the active ones), so routing must
 * never be able to smuggle an unverified model id into a live run.
 *
 * ## Public API (wire-up seam, not yet called from AgentRunner)
 *
 * 1. Build a `ModelPhaseRoutingV1` from settings once per run.
 * 2. Where a request is assembled with `evidencePhase`, add
 *    `model: resolveModelForPhase(phase, routing, defaultModel, allowlist).model`.
 *    Requests that omit `model` already fall through to the client's configured
 *    model, so an empty routing table is a no-op.
 * 3. Surface `decision.rationale` in Run Details next to the existing
 *    per-phase model-call evidence.
 */

import type { ModelCallPhase } from "../model/types";

export const MODEL_CALL_PHASES: readonly ModelCallPhase[] = [
  "router",
  "graph_planner",
  "agent_step",
  "finalizer",
  "streaming",
  "retry",
  "worker",
  "unknown",
] as const;

/**
 * Phases whose output is a short, structured, schema-constrained decision
 * rather than user-facing prose. These are the safe candidates for a cheaper
 * model: they are validated by the host on the way back (the router and graph
 * planner both parse into typed contracts and retry on mismatch), so a weaker
 * model degrades into a retry rather than into silent low-quality output.
 */
export const STRUCTURED_DECISION_PHASES: readonly ModelCallPhase[] = [
  "router",
  "graph_planner",
] as const;

export interface ModelPhaseRoutingV1 {
  schemaVersion: 1;
  /** Sparse: only phases that deliberately differ from the default appear. */
  overrides: Partial<Record<ModelCallPhase, string>>;
}

export interface ModelPhaseRoutingDecision {
  phase: ModelCallPhase;
  /** The model id to put on the request. Never empty. */
  model: string;
  /** True when `model` differs from the run's configured default. */
  routed: boolean;
  /** Human-readable justification for Run Details. Never includes prompts. */
  rationale: string;
}

export function createModelPhaseRouting(
  overrides: Partial<Record<ModelCallPhase, string>> = {},
): ModelPhaseRoutingV1 {
  const normalized: Partial<Record<ModelCallPhase, string>> = {};
  for (const phase of MODEL_CALL_PHASES) {
    const candidate = overrides[phase]?.trim();
    if (candidate) {
      normalized[phase] = candidate;
    }
  }
  return { schemaVersion: 1, overrides: normalized };
}

/**
 * Resolve the model for one phase.
 *
 * `verifiedModels` is the set of model ids whose connection has actually been
 * proven for the active provider. When it is omitted the routing table is
 * treated as unverifiable and every phase falls back to `defaultModel` — an
 * unconfigured caller cannot accidentally opt into unproven routing.
 */
export function resolveModelForPhase(
  phase: ModelCallPhase,
  routing: ModelPhaseRoutingV1 | null | undefined,
  defaultModel: string,
  verifiedModels?: Iterable<string>,
): ModelPhaseRoutingDecision {
  const fallback = defaultModel.trim();
  if (!fallback) {
    throw new TypeError("Phase routing requires a non-empty default model.");
  }

  const override = routing?.overrides?.[phase]?.trim();
  if (!override) {
    return {
      phase,
      model: fallback,
      routed: false,
      rationale: `phase=${phase} model=default no_override`,
    };
  }
  if (override === fallback) {
    return {
      phase,
      model: fallback,
      routed: false,
      rationale: `phase=${phase} model=default override_matches_default`,
    };
  }

  const verified = new Set(
    [...(verifiedModels ?? [])].map((value) => value.trim()).filter(Boolean),
  );
  if (!verified.has(override)) {
    // Fail closed. An unverified id here would mean a live run silently talking
    // to a model whose availability and context window were never proven.
    return {
      phase,
      model: fallback,
      routed: false,
      rationale: `phase=${phase} model=default override_unverified`,
    };
  }

  return {
    phase,
    model: override,
    routed: true,
    rationale: `phase=${phase} model=override verified`,
  };
}

/**
 * A conservative default table: route only the two structured-decision phases
 * to the cheaper model and leave everything that produces user-visible output
 * on the primary. Callers opt in explicitly; this is not applied anywhere yet.
 */
export function buildStructuredDecisionRouting(
  cheapModel: string,
): ModelPhaseRoutingV1 {
  const model = cheapModel.trim();
  if (!model) {
    return createModelPhaseRouting();
  }
  const overrides: Partial<Record<ModelCallPhase, string>> = {};
  for (const phase of STRUCTURED_DECISION_PHASES) {
    overrides[phase] = model;
  }
  return createModelPhaseRouting(overrides);
}

/**
 * Per-phase call counts, so the saving from a routing table can be stated from
 * recorded evidence instead of asserted. Feed it the `phase` field of the
 * `ModelCallEvidenceV1` records a run already emits.
 */
export function summarizePhaseDistribution(
  phases: readonly ModelCallPhase[],
): { phase: ModelCallPhase; calls: number; share: number }[] {
  const counts = new Map<ModelCallPhase, number>();
  for (const phase of phases) {
    counts.set(phase, (counts.get(phase) ?? 0) + 1);
  }
  const total = phases.length;
  return [...counts.entries()]
    .map(([phase, calls]) => ({
      phase,
      calls,
      share: total === 0 ? 0 : calls / total,
    }))
    .sort((left, right) => right.calls - left.calls);
}
