import assert from "node:assert/strict";
import test from "node:test";
import {
  MODEL_CALL_PHASES,
  STRUCTURED_DECISION_PHASES,
  buildStructuredDecisionRouting,
  createModelPhaseRouting,
  resolveModelForPhase,
  summarizePhaseDistribution,
} from "../src/agent/modelPhaseRouting";

const DEFAULT_MODEL = "gpt-oss:120b-cloud";
const CHEAP_MODEL = "minimax-m3:cloud";
const VERIFIED = [DEFAULT_MODEL, CHEAP_MODEL];

test("an unconfigured phase falls back to the default model", () => {
  const routing = createModelPhaseRouting();

  for (const phase of MODEL_CALL_PHASES) {
    const decision = resolveModelForPhase(phase, routing, DEFAULT_MODEL, VERIFIED);
    assert.equal(decision.model, DEFAULT_MODEL);
    assert.equal(decision.routed, false);
    assert.match(decision.rationale, /no_override/);
  }
});

test("an empty routing table is a no-op, so adoption cannot change behavior", () => {
  for (const routing of [null, undefined, createModelPhaseRouting()]) {
    const decision = resolveModelForPhase(
      "router",
      routing,
      DEFAULT_MODEL,
      VERIFIED,
    );
    assert.equal(decision.model, DEFAULT_MODEL);
    assert.equal(decision.routed, false);
  }
});

test("a verified override routes the phase", () => {
  const routing = createModelPhaseRouting({ router: CHEAP_MODEL });
  const decision = resolveModelForPhase("router", routing, DEFAULT_MODEL, VERIFIED);

  assert.equal(decision.model, CHEAP_MODEL);
  assert.equal(decision.routed, true);
  assert.match(decision.rationale, /verified/);
});

test("an unverified model id can never reach a live run", () => {
  const routing = createModelPhaseRouting({ router: "totally-unverified:latest" });
  const decision = resolveModelForPhase("router", routing, DEFAULT_MODEL, VERIFIED);

  assert.equal(decision.model, DEFAULT_MODEL);
  assert.equal(decision.routed, false);
  assert.match(decision.rationale, /override_unverified/);
});

test("omitting the allowlist entirely fails closed rather than open", () => {
  const routing = createModelPhaseRouting({ router: CHEAP_MODEL });
  const decision = resolveModelForPhase("router", routing, DEFAULT_MODEL);

  assert.equal(decision.model, DEFAULT_MODEL);
  assert.equal(decision.routed, false);
  assert.match(decision.rationale, /override_unverified/);
});

test("an override equal to the default is not reported as routed", () => {
  const routing = createModelPhaseRouting({ finalizer: DEFAULT_MODEL });
  const decision = resolveModelForPhase(
    "finalizer",
    routing,
    DEFAULT_MODEL,
    VERIFIED,
  );

  assert.equal(decision.model, DEFAULT_MODEL);
  assert.equal(decision.routed, false);
  assert.match(decision.rationale, /override_matches_default/);
});

test("blank and whitespace overrides are discarded at construction", () => {
  const routing = createModelPhaseRouting({
    router: "   ",
    finalizer: "",
    worker: `  ${CHEAP_MODEL}  `,
  });

  assert.equal(routing.overrides.router, undefined);
  assert.equal(routing.overrides.finalizer, undefined);
  assert.equal(routing.overrides.worker, CHEAP_MODEL);
});

test("an empty default model is a programming error, not a silent fallback", () => {
  assert.throws(
    () => resolveModelForPhase("router", createModelPhaseRouting(), "  ", VERIFIED),
    /non-empty default model/,
  );
});

test("the conservative table routes only structured-decision phases", () => {
  const routing = buildStructuredDecisionRouting(CHEAP_MODEL);

  for (const phase of STRUCTURED_DECISION_PHASES) {
    assert.equal(
      resolveModelForPhase(phase, routing, DEFAULT_MODEL, VERIFIED).model,
      CHEAP_MODEL,
    );
  }

  // Everything that produces user-visible output stays on the primary model.
  for (const phase of ["finalizer", "streaming", "agent_step", "worker"] as const) {
    assert.equal(
      resolveModelForPhase(phase, routing, DEFAULT_MODEL, VERIFIED).model,
      DEFAULT_MODEL,
    );
  }
});

test("phase distribution quantifies the routable share of a run", () => {
  const phases = [
    ...Array.from({ length: 6 }, () => "router" as const),
    ...Array.from({ length: 3 }, () => "graph_planner" as const),
    "finalizer" as const,
  ];

  const summary = summarizePhaseDistribution(phases);

  assert.equal(summary[0]?.phase, "router");
  assert.equal(summary[0]?.calls, 6);
  assert.equal(summary[0]?.share, 0.6);

  const routableShare = summary
    .filter((item) =>
      (STRUCTURED_DECISION_PHASES as readonly string[]).includes(item.phase),
    )
    .reduce((sum, item) => sum + item.share, 0);
  assert.ok(
    Math.abs(routableShare - 0.9) < 1e-9,
    `expected 90% of calls to be routable, got ${routableShare}`,
  );
});

test("an empty distribution does not divide by zero", () => {
  assert.deepEqual(summarizePhaseDistribution([]), []);
});
