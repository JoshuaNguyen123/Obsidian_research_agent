import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  CAPABILITY_RATCHET_MAX_TIER,
  CAPABILITY_RATCHET_PROMOTION_STREAK,
  classifyCapabilityRatchetEvidence,
  createCapabilityRatchetState,
  deriveRatchetedLinearCapabilityGate,
  earnedLinearGateExtension,
  normalizeCapabilityRatchetState,
  observeCapabilityRatchetScorecard,
  type CapabilityRatchetStateV1,
} from "../src/agent/capabilityRatchet";
import {
  scoreMissionV1,
  type MissionScorecardInput,
  type MissionScorecardV1,
} from "../src/agent/missionScorecard";
import {
  createLinearTools,
  type LinearCapabilitySnapshotV1,
  type LinearToolClient,
} from "../src/integrations/linear";

const T0 = "2026-08-24T10:00:00.000Z";

function scorecard(overrides: Partial<MissionScorecardInput> = {}): MissionScorecardV1 {
  return scoreMissionV1({
    acceptanceCriteriaTotal: 3,
    acceptanceCriteriaMissing: 0,
    acceptancePassed: true,
    claimsRequiringEvidence: 4,
    claimsWithEvidence: 4,
    mutationsPerformed: 2,
    mutationsWithReceipts: 2,
    recoveryAttempts: 0,
    modelCalls: 5,
    modelCallBudget: 10,
    wallClockMs: 1_000,
    wallClockBudgetMs: 10_000,
    ...overrides,
  });
}

function at(step: number): string {
  return new Date(Date.parse(T0) + step * 60_000).toISOString();
}

function observeGreens(
  state: CapabilityRatchetStateV1,
  runIds: string[],
  startStep = 0,
): CapabilityRatchetStateV1 {
  let current = state;
  runIds.forEach((runId, index) => {
    current = observeCapabilityRatchetScorecard(current, {
      runId,
      at: at(startStep + index),
      scorecard: scorecard(),
    }).state;
  });
  return current;
}

const linearSnapshot = {
  schemaVersion: 1,
  sourceOperations: [
    "connection.context",
    "teams.list",
    "projects.list",
    "workflow_states.list",
  ],
  viewer: { id: "viewer-1", name: "Researcher" },
  workspace: { id: "workspace-1", name: "Acme" },
  teams: [{ id: "team-1", name: "Platform", key: "PLAT" }],
  projects: [
    {
      id: "project-1",
      name: "Agent queue",
      url: "https://linear.app/acme/project/queue",
      teamIds: ["team-1"],
    },
  ],
  workflowStates: [
    { id: "ready-1", name: "Ready", type: "unstarted", teamId: "team-1" },
  ],
  sources: [
    { operation: "connection.context", enabled: true, itemCount: 1, truncated: false, errorCode: null },
  ],
  capabilities: [
    { id: "authenticated_connection", enabled: true, summary: "Connected." },
    { id: "team_selection", enabled: true, summary: "Teams available." },
    { id: "project_selection", enabled: true, summary: "Projects available." },
  ],
  discoveredAt: "2026-08-24T09:00:00.000Z",
  freshUntil: "2026-08-24T09:15:00.000Z",
  snapshotHash: `sha256:${"a".repeat(64)}`,
} as LinearCapabilitySnapshotV1;

test("evidence classification: green needs a passing, applicable, high-total card", () => {
  assert.equal(classifyCapabilityRatchetEvidence(scorecard()), "green");
  // Failed acceptance is a regression regardless of the weighted total.
  assert.equal(
    classifyCapabilityRatchetEvidence(scorecard({ acceptancePassed: false })),
    "regression",
  );
  // Passing but mediocre (between the regression and green thresholds) is
  // neutral: it neither buys trust nor withdraws it, but it breaks a streak.
  const mediocre = scorecard({ claimsWithEvidence: 1, recoveryAttempts: 3 });
  assert.ok(mediocre.total > 0.6 && mediocre.total < 0.8, `total=${mediocre.total}`);
  assert.equal(classifyCapabilityRatchetEvidence(mediocre), "neutral");
  // A card whose every dimension was inapplicable carries a vacuous total of
  // 1 and must not count as green evidence.
  const vacuous: MissionScorecardV1 = {
    version: 1,
    acceptancePassed: true,
    dimensions: [
      {
        id: "acceptance_coverage",
        score: 1,
        weight: 0.3,
        detail: "0/0 criteria met",
        applicable: false,
      },
    ],
    total: 1,
  };
  assert.equal(classifyCapabilityRatchetEvidence(vacuous), "neutral");
});

test("ratchet loosens slowly: one tier per sustained distinct-run green streak", () => {
  let state = createCapabilityRatchetState(T0);
  state = observeGreens(state, ["r1", "r2", "r3", "r4"]);
  assert.equal(state.tier, 0);
  assert.equal(state.streak.length, 4);

  state = observeGreens(state, ["r5"], 4);
  assert.equal(state.tier, 1);
  assert.equal(state.streak.length, 0, "promotion consumes the streak");
  assert.equal(state.transitions.length, 1);
  const promotion = state.transitions[0];
  assert.equal(promotion.reason, "promotion");
  assert.equal(promotion.fromTier, 0);
  assert.equal(promotion.toTier, 1);
  assert.deepEqual(
    promotion.evidence.map((entry) => entry.runId),
    ["r1", "r2", "r3", "r4", "r5"],
    "the transition records the exact evidence that justified it",
  );
  assert.ok(promotion.evidence.every((entry) => entry.acceptancePassed));
  assert.ok(promotion.evidence.every((entry) => entry.total >= 0.8));

  // A second full streak earns the second (and final) tier.
  state = observeGreens(state, ["r6", "r7", "r8", "r9", "r10"], 5);
  assert.equal(state.tier, CAPABILITY_RATCHET_MAX_TIER);
  assert.equal(state.transitions.length, 2);

  // At the maximum tier further greens never mint another transition, and the
  // retained streak stays bounded.
  state = observeGreens(state, ["r11", "r12", "r13", "r14", "r15", "r16"], 10);
  assert.equal(state.tier, CAPABILITY_RATCHET_MAX_TIER);
  assert.equal(state.transitions.length, 2);
  assert.ok(state.streak.length <= CAPABILITY_RATCHET_PROMOTION_STREAK);
});

test("green evidence is counted per run, not per scorecard emission", () => {
  let state = createCapabilityRatchetState(T0);
  // A compound run re-emits its merged scorecard once per segment. Five
  // emissions from one run refresh a single streak entry.
  for (let step = 0; step < CAPABILITY_RATCHET_PROMOTION_STREAK; step += 1) {
    state = observeCapabilityRatchetScorecard(state, {
      runId: "run-compound",
      at: at(step),
      scorecard: scorecard(),
    }).state;
  }
  assert.equal(state.tier, 0);
  assert.equal(state.streak.length, 1);

  // Unattributed evidence can never loosen.
  const unattributed = observeCapabilityRatchetScorecard(state, {
    runId: null,
    at: at(9),
    scorecard: scorecard(),
  });
  assert.equal(unattributed.changed, false);
  assert.equal(unattributed.state.streak.length, 1);
});

test("a neutral card breaks the streak without moving the tier", () => {
  let state = observeGreens(createCapabilityRatchetState(T0), [
    "r1",
    "r2",
    "r3",
    "r4",
  ]);
  const neutral = observeCapabilityRatchetScorecard(state, {
    runId: "r5",
    at: at(4),
    scorecard: scorecard({ claimsWithEvidence: 1, recoveryAttempts: 3 }),
  });
  assert.equal(neutral.changed, true);
  assert.equal(neutral.state.tier, 0);
  assert.equal(neutral.state.streak.length, 0);
  assert.equal(neutral.state.transitions.length, 0);
});

test("ratchet tightens fast: one regression drops straight back to tier 0", () => {
  let state = observeGreens(
    createCapabilityRatchetState(T0),
    ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"],
  );
  assert.equal(state.tier, CAPABILITY_RATCHET_MAX_TIER);

  const regressed = observeCapabilityRatchetScorecard(state, {
    runId: "r11",
    at: at(10),
    scorecard: scorecard({ acceptancePassed: false, acceptanceCriteriaMissing: 2 }),
  });
  assert.equal(regressed.changed, true);
  assert.equal(regressed.state.tier, 0, "straight back down, not one step");
  const drop = regressed.state.transitions.at(-1);
  assert.equal(drop?.reason, "regression");
  assert.equal(drop?.fromTier, CAPABILITY_RATCHET_MAX_TIER);
  assert.equal(drop?.toTier, 0);
  assert.equal(drop?.evidence.length, 1);
  assert.equal(drop?.evidence[0].runId, "r11");
  assert.equal(drop?.evidence[0].acceptancePassed, false);

  // Rebuilding trust starts over from an empty streak.
  const rebuilt = observeGreens(regressed.state, ["r12", "r13", "r14", "r15"], 11);
  assert.equal(rebuilt.tier, 0);
});

test("a resumed mission does not lose the tier it earned to a scope mismatch", () => {
  // The ratchet reads only `scorecard.total`, and the two efficiency
  // dimensions carry 0.05 each. While the scorecard divided a run-scoped
  // `providerUsage` numerator by a segment-scoped execution budget, a mission
  // that had been continued a few times paid that weight for nothing but
  // being resumed -- enough, at these thresholds, to turn the same work from
  // a streak-breaking neutral into a tier-clearing regression.
  const continued = {
    acceptanceCriteriaTotal: 5,
    acceptanceCriteriaMissing: 2,
    acceptancePassed: true,
    claimsRequiringEvidence: 8,
    claimsWithEvidence: 5,
    mutationsPerformed: 2,
    mutationsWithReceipts: 1,
    recoveryAttempts: 2,
    // 60 calls and 20 minutes across the whole resume chain, of which this
    // segment spent 12 calls and 5 minutes against the 20 and 10 it was
    // granted. Every figure below is one mission; only the declaration of
    // what it inherited differs.
    modelCalls: 60,
    modelCallBudget: 20,
    wallClockMs: 1_200_000,
    wallClockBudgetMs: 600_000,
  } satisfies MissionScorecardInput;
  const inherited = { inheritedModelCalls: 48, inheritedWallClockMs: 900_000 };

  const conflated = scoreMissionV1(continued);
  const scoped = scoreMissionV1({ ...continued, ...inherited });

  assert.equal(classifyCapabilityRatchetEvidence(conflated), "regression");
  assert.equal(classifyCapabilityRatchetEvidence(scoped), "neutral");
  assert.ok(
    conflated.total < 0.6 && scoped.total >= 0.6,
    `totals=${conflated.total}/${scoped.total}`,
  );

  // The product consequence: an earned tier survives the continuation.
  const earned = observeGreens(createCapabilityRatchetState(T0), [
    "r1",
    "r2",
    "r3",
    "r4",
    "r5",
  ]);
  assert.equal(earned.tier, 1);
  assert.equal(
    observeCapabilityRatchetScorecard(earned, {
      runId: "r6",
      at: at(5),
      scorecard: conflated,
    }).state.tier,
    0,
    "the scope mismatch cleared a tier the mission had not actually lost",
  );
  assert.equal(
    observeCapabilityRatchetScorecard(earned, {
      runId: "r6",
      at: at(5),
      scorecard: scoped,
    }).state.tier,
    1,
    "a mediocre-but-not-regressed continuation only breaks the streak",
  );
});

test("persisted record round-trips exactly and malformed records fail closed", () => {
  const state = observeGreens(
    createCapabilityRatchetState(T0),
    ["r1", "r2", "r3", "r4", "r5", "r6", "r7"],
  );
  const parsed = normalizeCapabilityRatchetState(
    JSON.parse(JSON.stringify(state)),
  );
  assert.deepEqual(parsed, state);

  assert.equal(normalizeCapabilityRatchetState(null), null);
  assert.equal(normalizeCapabilityRatchetState("tier 2 please"), null);
  assert.equal(
    normalizeCapabilityRatchetState({ ...state, version: 2 }),
    null,
  );
  assert.equal(
    normalizeCapabilityRatchetState({ ...state, capabilityId: "everything" }),
    null,
  );
  assert.equal(
    normalizeCapabilityRatchetState({
      ...state,
      tier: CAPABILITY_RATCHET_MAX_TIER + 1,
    }),
    null,
    "an out-of-range tier cannot be smuggled in through plugin data",
  );
  assert.equal(normalizeCapabilityRatchetState({ ...state, tier: -1 }), null);
  assert.equal(
    normalizeCapabilityRatchetState({
      ...state,
      streak: [
        { runId: "dup", at: T0, total: 1, acceptancePassed: true },
        { runId: "dup", at: T0, total: 1, acceptancePassed: true },
      ],
    }),
    null,
  );
  assert.equal(
    normalizeCapabilityRatchetState({
      ...state,
      transitions: [
        {
          at: T0,
          fromTier: 0,
          toTier: 2,
          reason: "promotion",
          evidence: [{ runId: "r1", at: T0, total: 1, acceptancePassed: true }],
        },
      ],
    }),
    null,
    "a promotion may only ever raise one tier at a time",
  );
  assert.equal(
    normalizeCapabilityRatchetState({ ...state, updatedAt: "yesterday" }),
    null,
  );
});

test("the ratchet extends only a fully-bound Linear connection, never replaces it", () => {
  const promoted = observeGreens(
    createCapabilityRatchetState(T0),
    ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8", "r9", "r10"],
  );
  const fresh = createCapabilityRatchetState(T0);
  const tierOne = observeGreens(fresh, ["r1", "r2", "r3", "r4", "r5"]);

  assert.equal(earnedLinearGateExtension(null), 0);
  assert.equal(earnedLinearGateExtension(fresh), 0);
  assert.equal(earnedLinearGateExtension(tierOne), 1);
  assert.equal(earnedLinearGateExtension(promoted), 2);

  assert.equal(deriveRatchetedLinearCapabilityGate(linearSnapshot, fresh), 3);
  assert.equal(deriveRatchetedLinearCapabilityGate(linearSnapshot, tierOne), 4);
  assert.equal(deriveRatchetedLinearCapabilityGate(linearSnapshot, promoted), 5);

  // Connection evidence stays the floor the ratchet can never substitute for:
  // without a project binding the earned extension is ignored entirely.
  const unboundSnapshot = {
    ...linearSnapshot,
    capabilities: linearSnapshot.capabilities.map((capability) =>
      capability.id === "project_selection"
        ? { ...capability, enabled: false }
        : capability,
    ),
  };
  assert.equal(deriveRatchetedLinearCapabilityGate(unboundSnapshot, promoted), 2);
  assert.equal(deriveRatchetedLinearCapabilityGate(null, promoted), 0);
});

test("the earned tier actually widens the model-facing Linear tool catalog", () => {
  const client = {
    execute: async () => {
      throw new Error("not exercised by this test");
    },
  } as unknown as LinearToolClient;
  const toolNames = (state: CapabilityRatchetStateV1) =>
    new Set(
      createLinearTools({
        client,
        gate: deriveRatchetedLinearCapabilityGate(linearSnapshot, state),
      }).map((tool) => tool.name),
    );

  const fresh = createCapabilityRatchetState(T0);
  const tierOne = observeGreens(fresh, ["r1", "r2", "r3", "r4", "r5"]);
  const tierTwo = observeGreens(tierOne, ["r6", "r7", "r8", "r9", "r10"], 5);

  const base = toolNames(fresh);
  assert.ok(base.has("linear_create_issue"), "gate 1 catalog stays reachable");
  assert.ok(!base.has("linear_create_issue_relation"), "gate 4 stays locked at tier 0");
  assert.ok(!base.has("linear_create_customer"), "gate 5 stays locked at tier 0");

  const relationTier = toolNames(tierOne);
  assert.ok(relationTier.has("linear_create_issue_relation"));
  assert.ok(relationTier.has("linear_create_initiative_project_link"));
  assert.ok(relationTier.has("linear_add_label_to_issue"));
  assert.ok(!relationTier.has("linear_create_customer"), "customers need tier 2");

  const customerTier = toolNames(tierTwo);
  assert.ok(customerTier.has("linear_create_customer"));
  assert.ok(customerTier.has("linear_create_customer_request"));
});

test("main.ts consumes the ratcheted gate for the model-facing registry and persists the record", () => {
  const mainSource = readFileSync(new URL("../main.ts", import.meta.url), "utf8");
  assert.match(
    mainSource,
    /gate:\s*deriveRatchetedLinearCapabilityGate\(/,
    "the model-facing Linear tool registry must derive its gate through the ratchet",
  );
  assert.match(
    mainSource,
    /capabilityRatchetState:\s*this\.capabilityRatchetState/,
    "the ratchet record must be persisted with plugin data",
  );
  assert.match(
    mainSource,
    /normalizeCapabilityRatchetState\(rawCapabilityRatchetState\)\s*\?\?\s*createCapabilityRatchetState\(/,
    "a malformed persisted record must fail closed to a fresh tier-0 record",
  );
});

test("NEVER-RATCHET: safety boundaries cannot be influenced by the ratchet", () => {
  // These are safety boundaries, not reliability barriers. The ratchet module
  // must be unable to reach them: none of them may reference the ratchet, and
  // the ratchet may import nothing beyond scorecards and the Linear gate
  // derivation it extends.
  const ratchetIdentifier =
    /capabilityRatchet|CapabilityRatchet|earnedLinearGateExtension|deriveRatchetedLinearCapabilityGate/;
  const guardedSources = [
    "../src/tools/ToolRegistry.ts", // approval scoping (run-id comparison)
    "../src/agent/runStore.ts", // getReconciliationAction conservatism
    "../src/integrations/github/VerifiedGitPushGateway.ts", // the single audited push site
    "../src/tools/githubPrivateRepositoryTool.ts", // private-only repository authority
    "../src/tools/githubPrivateRepositoryCleanupTool.ts", // deletion double-confirmation
    "../src/integrations/linear/reconciliation.ts", // mutation reconciliation
  ];
  for (const source of guardedSources) {
    const content = readFileSync(new URL(source, import.meta.url), "utf8");
    assert.ok(
      !ratchetIdentifier.test(content),
      `${source} must not reference the capability ratchet`,
    );
  }

  const ratchetSource = readFileSync(
    new URL("../src/agent/capabilityRatchet.ts", import.meta.url),
    "utf8",
  );
  const allowedImports = new Set([
    "./missionScorecard",
    "../integrations/linear/LinearSettingsState",
    "../integrations/linear/LinearCapabilityDiscovery",
    "../integrations/linear/types",
  ]);
  const imports = [...ratchetSource.matchAll(/from\s+"([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.ok(imports.length > 0);
  for (const specifier of imports) {
    assert.ok(
      allowedImports.has(specifier),
      `capabilityRatchet.ts may not import ${specifier}`,
    );
  }
});
