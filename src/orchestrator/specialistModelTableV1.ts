import type { ResearchEffortTier } from "../agent/researchEffortPolicy";
import type { ModelClientDescriptor } from "../model/types";
import type { SpecialistMode } from "./types";

/**
 * Which model each specialist role asks for.
 *
 * There are five specialist modes and, until this table, two answers to the
 * question — held privately by the two workers that had one, and already
 * disagreeing about their own shape. `codeWorker` swapped the model
 * unconditionally; `researchWorker` swapped it only at deep and extended
 * effort. The other three modes (`linear_planner`, `code_reviewer`,
 * `recovery_verifier`) had no answer at all, which is not the same as having
 * decided they should inherit the configured model — nobody had looked.
 *
 * One table, every mode present, each row saying what it asks for and why.
 * The next role that needs a different model is a row here, not a third
 * private copy in a third worker.
 *
 * Scope is deliberately narrow. The table decides the MODEL only. Thinking
 * stays with the callers, because each resolves it from a different policy
 * (`resolveThinkForCall` with a different role and phase) and folding those
 * into a data table would mean reproducing that policy here — a second copy
 * of exactly the thing this module exists to prevent. A row may pin `think`
 * where the model itself dictates it; otherwise it says `inherit`.
 *
 * Overrides apply only to the direct cloud transport. Against any other
 * provider the user's configured model is what runs, because the named models
 * below are cloud model ids and asking a different endpoint for one is a
 * request for a model it does not have.
 */
export interface SpecialistModelRowV1 {
  mode: SpecialistMode;
  /**
   * Model id to request on the direct cloud transport, or null to keep
   * whatever the user configured.
   */
  cloudModel: string | null;
  /**
   * Research effort tiers this row applies at. Null means every tier, which
   * is also what a mode that does not run under a research effort gets.
   */
  effortTiers: readonly ResearchEffortTier[] | null;
  /** `true`/`false` pin the request; "inherit" leaves it to the caller. */
  think: boolean | "inherit";
  /** Why this row is what it is; read by the next person to change it. */
  rationale: string;
}

/** Canonical model name for direct requests to https://ollama.com/api. */
export const OLLAMA_CLOUD_CODE_WORKER_MODEL_V1 = "kimi-k2.7-code";
/** Canonical model name for direct requests to https://ollama.com/api. */
export const OLLAMA_CLOUD_DEEP_RESEARCH_MODEL_V1 = "nemotron-3-ultra";

export const SPECIALIST_MODEL_TABLE_V1: readonly SpecialistModelRowV1[] =
  Object.freeze([
    {
      mode: "code_builder",
      cloudModel: OLLAMA_CLOUD_CODE_WORKER_MODEL_V1,
      effortTiers: null,
      think: true,
      rationale:
        "Writing a file that must compile is the one job where the strongest available code model earns its latency on every pass, so this is not effort-gated. Thinking is pinned on: the model's tool-call arguments are markedly better with it, and a code worker that emits a malformed call costs a whole repair cycle.",
    },
    {
      mode: "researcher",
      cloudModel: OLLAMA_CLOUD_DEEP_RESEARCH_MODEL_V1,
      effortTiers: ["deep", "extended"],
      think: "inherit",
      rationale:
        "Effort-gated on purpose: quick and standard passes are usually one search and a summary, where the larger model buys accuracy nobody reads and costs latency the user feels. Deep and extended are the passes that synthesise across sources. Thinking is inherited so a configured opt-out is honoured.",
    },
    {
      mode: "code_reviewer",
      cloudModel: null,
      effortTiers: null,
      think: "inherit",
      rationale:
        "Deliberately the configured model. A reviewer that runs on the same model as the builder shares its blind spots, but no measurement has been taken here yet, so this row records the gap rather than guessing at a second model id.",
    },
    {
      mode: "linear_planner",
      cloudModel: null,
      effortTiers: null,
      think: "inherit",
      rationale:
        "Planning is short, structured output against a schema the host validates. The configured model handles it, and a swap would cost a model load for no measured gain.",
    },
    {
      mode: "recovery_verifier",
      cloudModel: null,
      effortTiers: null,
      think: "inherit",
      rationale:
        "The verifier reads a transcript it did not produce and answers a bounded question. It runs read-only with an isolated transcript, so its value comes from independence rather than from capability, and the configured model supplies that.",
    },
  ] satisfies readonly SpecialistModelRowV1[]);

export function specialistModelRowV1(mode: SpecialistMode): SpecialistModelRowV1 {
  const row = SPECIALIST_MODEL_TABLE_V1.find((entry) => entry.mode === mode);
  if (!row) {
    // Unreachable while the table covers the union, which a test pins. A
    // missing row must not silently mean "no override".
    throw new Error(`No specialist model row for mode ${mode}.`);
  }
  return row;
}

/**
 * True only for the transport whose model ids the table names. A type
 * predicate, so a caller that falls through this check keeps the narrowing
 * the inlined form used to give it.
 */
export function isDirectCloudTransportV1(
  descriptor: ModelClientDescriptor | undefined | null,
): descriptor is ModelClientDescriptor {
  return (
    descriptor?.provider === "ollama" &&
    descriptor.endpointCategory === "ollama_cloud"
  );
}

/**
 * The model this role should ask for, or null to keep the configured one.
 * Returns null for every non-cloud transport and for every row whose effort
 * gate does not admit this pass.
 */
export function resolveSpecialistModelV1(input: {
  mode: SpecialistMode;
  descriptor: ModelClientDescriptor | undefined | null;
  researchEffortTier?: ResearchEffortTier | null;
}): { model: string; think: boolean | "inherit" } | null {
  if (!isDirectCloudTransportV1(input.descriptor)) return null;
  const row = specialistModelRowV1(input.mode);
  if (!row.cloudModel) return null;
  if (row.effortTiers !== null) {
    const tier = input.researchEffortTier;
    if (!tier || !row.effortTiers.includes(tier)) return null;
  }
  return { model: row.cloudModel, think: row.think };
}
