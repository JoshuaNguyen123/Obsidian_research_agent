/**
 * The compound lane (`compound-flow-real-live`) reached node 22 of its ladder
 * at main `210041d` and stopped at step 4 at main `0403514`, two merges later.
 * These tests are the unit-level bisect: they drive the lane's VERBATIM prompt
 * through every predicate those two merges touched and pin the answers to what
 * `210041d` produced.
 *
 * They PASS at `0403514`. That is the finding, not a gap in the test: the
 * merges are inert on this prompt, so the early stop was not caused by either
 * of them. What these pins buy is that a future edit to the vault-vocabulary
 * seat, the write-scope ceiling, the ordered-write derivation, or the lifecycle
 * stage/allowlist tables cannot quietly re-author this lane's contract without
 * a red test naming the lane.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import {
  requiresVaultEvidenceProof,
  requiresWebEvidenceProof,
  hasExplicitPublicWebSignal,
  withoutVaultAddressingVocabularyV1,
} from "../src/agent/evidenceIntent";
import {
  allowsResearchModeAssistActivation,
  mergeResearchLadderToolNamesV1,
  parseExplicitResearchSourceCount,
  researchLadderToolNamesV1,
} from "../src/agent/researchPlan";
import { getCompoundLifecycleResearchGraphToolNames } from "../src/AgentRunner";
import {
  resolveAuthoritativeWriteScopeV1,
  saferWriteScope,
} from "../src/agent/missionRouter";
import { deriveRepeatedOperationTargetsV1 } from "../src/agent/repeatedOperationTargets";
import { detectProjectLifecycleStagesV1 } from "../src/agent/projectLifecycle";
import { toolsAllowedForLifecycleStage } from "../src/agent/lifecycleStagePolicy";
import {
  setLooseDeliveryComplete,
  toolsOfferedForSetLoosePipeline,
} from "../src/agent/setLooseCompoundAutonomy";
import {
  SUPPRESSED_BUDGET_TERMINAL_BLOCKER_V1,
  suppressedBudgetTerminalBlockerV1,
} from "../src/agent/autoContinuation";
import type { MissionIntent } from "../src/tools/types";

/**
 * The lane's runtime substitutions, pinned. `notePath` deliberately keeps the
 * SPACE the real lane uses ("E2E Agent Tests/..."): the soak merge's
 * ordered-write fix only changes behavior for paths containing a space, so a
 * space-free stand-in would exonerate that fix by accident.
 */
const SUFFIX = "a1b2c3d4e5f6";
const MARKER = `FLOW_REAL_${SUFFIX}`;
const NOTE_PATH = `E2E Agent Tests/FLOW-REAL-${SUFFIX}.md`;
const REPOSITORY = `e2e-flow-real-${SUFFIX}`;
const WORKSPACE_ID = `flow-real-${SUFFIX}`;
const RELATIVE_CODE_PATH = "src/flow_real.ts";
const REQUEST_ID = `flow-real-request-${SUFFIX}`;
const GITHUB_LOGIN = "e2e-agent-bot";
const PROFILE_KEY = "compound-flow-real-ts";
const VALIDATION_PROFILE_KEY = "compound-flow-real-ts-validation";

const COMPOUND_MISSION = [
  `Run the full pipeline for Flow real ${MARKER}: web research, Linear issue, repository workspace, private GitHub, and note reflection.`,
  `First research the Flow real ${MARKER} topic using exactly two public web sources and fetch both sources before accepting findings. Write the accepted findings into the current note ${NOTE_PATH} using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work, citing both fetched source URLs and passages.`,
  `After both fetches, call create_project_idea_brief exactly once. Evaluate at least two project directions, select one option, and set groundingReferences to the exact two fetched web URLs. Treat the returned grounded promotion seed as authoritative: copy every shared title, problem, evidence, proposed-work, non-goal, acceptance-criterion, and risk field exactly into accepted research publication without rewriting it.`,
  `Publish the accepted research note to Linear in the configured destination. The package is code work for repository key ${PROFILE_KEY} and validation requirement ${VALIDATION_PROFILE_KEY}. After publishing, call linear_get_issue for the returned issue and read back its title and URL before opening the code workspace.`,
  `Create repository workspace ${WORKSPACE_ID} and use one repair request id ${REQUEST_ID} for every validation and commit call.`,
  `Use the trusted local repository profile key ${PROFILE_KEY}: call code_sandbox_status, then code_workspace_create (kind repository, repositoryProfileKey ${PROFILE_KEY}, workspaceId ${WORKSPACE_ID}).`,
  `Read the exact existing workspace file ${RELATIVE_CODE_PATH} via code_workspace_read path ${RELATIVE_CODE_PATH}, then code_workspace_write_expected path ${RELATIVE_CODE_PATH} with the exact one-line content export const marker = "${MARKER}"; (double quotes only).`,
  `Then call code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, and code_commit_verified with that same requestId ${REQUEST_ID}.`,
  `Do not rewrite package.json or scripts.`,
  `Create the exact private GitHub repository ${GITHUB_LOGIN}/${REPOSITORY} with github_create_repository visibility private.`,
  `After the verified commit exists, call publish_verified_code_to_github with action publish_draft for trusted profile ${PROFILE_KEY} so a draft pull request URL exists (create-only is not enough).`,
  `Append a Flow real reflection to the current note via append_to_current_file containing marker ${MARKER}, the Linear issue URL, the private GitHub repo URL, the draft PR URL, and workspace ${WORKSPACE_ID}.`,
  `Decide tool order yourself from the set-loose allowed tools. Pause only for the exact prepared approval required by an external mutation. Do not trash or delete. Do not merge. Stay in the tool loop until research, the published Linear issue, verified commit, draft PR, and reflection proofs exist.`,
].join(" ");

function compoundMissionIntent(): MissionIntent {
  return {
    mode: "vault_context_answer",
    vaultContext: true,
    noteOutput: true,
    explicitPersistence: true,
    explicitMutation: true,
    explicitDelete: false,
    allowAutonomousWrite: true,
    requireWriteCompletion: true,
    autonomyScope: {
      read: { currentNote: true, vault: true, folders: [], files: [], web: true },
      write: {
        currentNote: true,
        folders: [],
        files: [],
        artifacts: true,
        researchMemory: true,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
  } as MissionIntent;
}

test("the pinned prompt is still the prompt the compound lane submits", () => {
  const spec = readFileSync(
    new URL("../e2e/compound-flow-real-live.spec.ts", import.meta.url),
    "utf8",
  );
  // Interpolation-free spans of each mission line. If the lane is reworded,
  // this fails first and says the pin below is stale — rather than silently
  // pinning a prompt nobody sends any more.
  const laneSpans = [
    "Run the full pipeline for Flow real ",
    ": web research, Linear issue, repository workspace, private GitHub, and note reflection.",
    " topic using exactly two public web sources and fetch both sources before accepting findings.",
    "using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work",
    "After both fetches, call create_project_idea_brief exactly once.",
    "Publish the accepted research note to Linear in the configured destination.",
    "After publishing, call linear_get_issue for the returned issue",
    "Do not rewrite package.json or scripts.",
    "with github_create_repository visibility private.",
    "call publish_verified_code_to_github with action publish_draft",
    "via append_to_current_file containing marker ",
    "Decide tool order yourself from the set-loose allowed tools.",
    "Stay in the tool loop until research, the published Linear issue, verified commit, draft PR, and reflection proofs exist.",
  ];
  for (const span of laneSpans) {
    assert.ok(
      spec.includes(span),
      `compound-flow-real-live.spec.ts no longer contains ${JSON.stringify(span)}; the prompt pinned in this test is stale.`,
    );
  }
});

test("the compound lane's prompt keeps its research-bearing contract", () => {
  const intent = compoundMissionIntent();
  // This mission does real public-web research, and every seat that decides so
  // must keep saying so. These are the values 210041d produced.
  assert.equal(requiresWebEvidenceProof(COMPOUND_MISSION, intent), true);
  assert.equal(hasExplicitPublicWebSignal(COMPOUND_MISSION), true);
  assert.equal(parseExplicitResearchSourceCount(COMPOUND_MISSION), 2);
  // The research-mode assist must stay reachable: it is what mints the
  // ResearchPlan (and its effort budget) for this mission, and the compound
  // research budget gate is inactive without one.
  assert.equal(
    allowsResearchModeAssistActivation(COMPOUND_MISSION, intent),
    true,
  );
});

test("the vault-addressing seat is inert on the compound prompt", () => {
  // The prime suspect for the regression. It is not merely harmless here — the
  // prompt contains NO vault vocabulary at all, so there is nothing for the
  // seat to strip, and requiresVaultEvidenceProof was ALREADY false at
  // 210041d. A soak-fix regression on this lane was impossible by construction.
  assert.equal(/\bvault\b/iu.test(COMPOUND_MISSION), false);
  assert.equal(
    withoutVaultAddressingVocabularyV1(COMPOUND_MISSION),
    COMPOUND_MISSION,
  );
  assert.equal(
    requiresVaultEvidenceProof(COMPOUND_MISSION, compoundMissionIntent()),
    false,
  );
});

test("naming the vault as a corpus still carries the full research contract", () => {
  // The soak fix's stated boundary, restated against this lane's neighbours:
  // ADDRESSING use is stripped, CORPUS use is not.
  const addressing =
    "Write the summary to the exact vault-relative path Notes/Alpha.md.";
  const corpus = "Search my vault for everything we know about onboarding.";
  assert.notEqual(
    withoutVaultAddressingVocabularyV1(addressing),
    addressing,
    "addressing vocabulary must still be neutralized",
  );
  assert.equal(
    withoutVaultAddressingVocabularyV1(corpus),
    corpus,
    "corpus vocabulary must survive untouched",
  );
});

test("authority may widen but never revoke the host's offered write scope", () => {
  // The soak fix's intent, pinned: the intersection is a CEILING, not a FLOOR.
  assert.equal(
    resolveAuthoritativeWriteScopeV1("none", "vault_files"),
    "vault_files",
    "a model answering none must not revoke a mutation the host is offering",
  );
  assert.equal(
    resolveAuthoritativeWriteScopeV1("none", "none"),
    "none",
    "with nothing exposed the block keeps full force",
  );
  assert.equal(
    resolveAuthoritativeWriteScopeV1("current_note_append", "vault_files"),
    saferWriteScope("current_note_append", "vault_files"),
    "a model may still narrow AMONG write scopes",
  );
});

test("the ordered-write derivation plants no node for the compound prompt", () => {
  // The lane's note path contains a space, which is exactly the shape the soak
  // merge's truncation fix targets. It derives nothing here either way, so that
  // fix cannot have re-authored this lane's plan.
  for (const toolName of [
    "create_file",
    "append_file",
    "replace_file",
    "create_folder",
    "delete_path",
  ]) {
    assert.deepEqual(
      deriveRepeatedOperationTargetsV1({
        toolName,
        objective: COMPOUND_MISSION,
      }),
      [],
      `${toolName} must derive no repeated-operation destination`,
    );
  }
});

test("the compound prompt still detects its full six-stage lifecycle", () => {
  // The lineage merge touched projectLifecycle/lifecycleStagePolicy. Stage
  // detection is what the whole compound ladder and the set-loose delivery gate
  // are built from, so it is pinned exactly.
  assert.deepEqual(detectProjectLifecycleStagesV1(COMPOUND_MISSION), [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "reflection",
  ]);
});

test("an unpaid compound delivery is never vacuously complete", () => {
  const stages = detectProjectLifecycleStagesV1(COMPOUND_MISSION);
  const gate = setLooseDeliveryComplete({ stages, proofs: {} });
  assert.equal(gate.complete, false);
  assert.deepEqual(gate.unpaid, [
    "accepted_research",
    "linear_hierarchy",
    "code_execution",
    "code_validation",
    "private_github_publication",
    "note_reflection",
  ]);
  // The vacuous case is real and is why stage detection above is pinned: an
  // EMPTY stage list reports a fully delivered mission that did nothing.
  assert.equal(
    setLooseDeliveryComplete({ stages: [], proofs: {} }).complete,
    true,
  );
});

test("the linear_hierarchy allowlist reorder does not change the offered menu", () => {
  // The lineage merge replaced two literal tool names with a spread of the
  // shared constant and SWAPPED their order. Order is not load-bearing: both
  // publication tools must be present, and the set-loose menu is a Set union
  // that already carries publish_research_to_linear from accepted_research.
  const hierarchy = [...toolsAllowedForLifecycleStage("linear_hierarchy")];
  assert.deepEqual(
    [...hierarchy].sort(),
    [
      "linear_create_issue",
      "linear_get_connection_context",
      "linear_get_issue",
      "linear_list_workflow_states",
      "linear_search_issues",
      "linear_update_issue",
      "publish_research_project_to_linear",
      "publish_research_to_linear",
    ],
    "both publication tools must discharge the stage",
  );
  const offered = toolsOfferedForSetLoosePipeline({
    stages: detectProjectLifecycleStagesV1(COMPOUND_MISSION),
    currentStage: null,
    passedFastRepairCycle: false,
    codeDeliveryPaid: false,
  });
  for (const required of [
    "web_search",
    "web_fetch",
    "create_project_idea_brief",
    "publish_research_to_linear",
    "read_template",
  ]) {
    assert.ok(
      offered.includes(required),
      `the opening compound menu must still offer ${required}`,
    );
  }
});

/**
 * Compose the two research ladders exactly as the mission-graph planning site
 * does: the proof-debt ladder is folded against the compound-lifecycle ladder,
 * then the lifecycle ladder lands with the rest of the workflow. The
 * source-level guard below pins that the site really is this composition.
 */
function plannedResearchLadderForCompoundMission(
  prompt: string,
  requiredGraphFetchCount: number,
): string[] {
  const compound = getCompoundLifecycleResearchGraphToolNames(prompt, 0);
  const proofDebt = researchLadderToolNamesV1(requiredGraphFetchCount);
  return [
    ...mergeResearchLadderToolNamesV1(compound, proofDebt),
    ...compound,
  ];
}

test("the compound lane plans one web ladder sized to its two-source contract", () => {
  // FAILS on the unfixed tree: both seats size themselves correctly from
  // parseExplicitResearchSourceCount, but the graph CONCATENATED them, so the
  // lane planned 2x web_search + 4x web_fetch (the observed tool-01..tool-06)
  // for a contract that asks for exactly two sources. The surplus fetch nodes
  // are unpayable source debt, and unpaid debt is what left tool-05/tool-06
  // READY when the closure-exhausted terminal armed.
  const requested = parseExplicitResearchSourceCount(COMPOUND_MISSION);
  assert.equal(requested, 2);
  // Which CLAUSE carries the count is load-bearing and not the obvious one:
  // "exactly two public web sources" does NOT parse, because "public" is not an
  // adjective the parser steps over between the number and "sources". The 2 is
  // recovered from "fetch both sources". Anyone tidying that phrase out of the
  // lane's prompt would silently drop the ladder to its default floor.
  assert.equal(
    parseExplicitResearchSourceCount("exactly two public web sources"),
    null,
  );
  assert.equal(parseExplicitResearchSourceCount("fetch both sources"), 2);
  // requiredGraphFetchCount at the planning site is
  // max(plan.minFetchedSources, explicit count) and the plan's floor is the
  // explicit count itself, so both inputs are 2.
  const planned = plannedResearchLadderForCompoundMission(
    COMPOUND_MISSION,
    requested!,
  );
  assert.deepEqual(planned, ["web_search", "web_fetch", "web_fetch"]);
  assert.equal(
    planned.filter((name) => name === "web_fetch").length,
    requested,
    "one fetch node per requested source -- no surplus source debt",
  );
  assert.equal(
    planned.filter((name) => name === "web_search").length,
    1,
    "one discovery search, not one per contributing seat",
  );
  // The unfixed composition, pinned for contrast: a plain concatenation of the
  // two ladders is exactly the six web nodes observed as tool-01..tool-06.
  const compound = getCompoundLifecycleResearchGraphToolNames(
    COMPOUND_MISSION,
    0,
  );
  assert.deepEqual(
    [...researchLadderToolNamesV1(requested!), ...compound],
    [
      "web_search",
      "web_fetch",
      "web_fetch",
      "web_search",
      "web_fetch",
      "web_fetch",
    ],
    "the observed over-plan was the sum of two individually-correct ladders",
  );
  assert.equal(planned.length, 3);
});

test("an explicit larger source count scales the single ladder up", () => {
  const prompt = [
    "Research American checkers using exactly five web sources and fetch every source.",
    "Write the accepted research notebook, create the Linear hierarchy, implement Python in the repository,",
    "run targeted validation, commit it, and publish it to a private GitHub repository.",
  ].join(" ");
  assert.equal(parseExplicitResearchSourceCount(prompt), 5);
  assert.deepEqual(
    plannedResearchLadderForCompoundMission(prompt, 5),
    ["web_search", "web_fetch", "web_fetch", "web_fetch", "web_fetch", "web_fetch"],
    "five requested sources plan five fetch nodes, still behind one search",
  );
});

test("the fold never under-plans the larger of the two ladders", () => {
  // The mirror-image guard from the write-side fix. The seats can disagree
  // (the compound seat discounts sources already verified this run), and the
  // graph must carry the LARGER ladder -- never the smaller, and never the sum.
  assert.deepEqual(
    mergeResearchLadderToolNamesV1(
      ["web_search", "web_fetch"],
      ["web_search", "web_fetch", "web_fetch", "web_fetch"],
    ),
    ["web_fetch", "web_fetch"],
    "the proof-debt ladder contributes only its surplus over the compound one",
  );
  assert.deepEqual(
    mergeResearchLadderToolNamesV1(
      ["web_search", "web_fetch", "web_fetch", "web_fetch"],
      ["web_search", "web_fetch"],
    ),
    [],
    "a ladder wholly covered by the one already planned adds nothing",
  );
  // Retry margin lives INSIDE a node, not in surplus nodes: a node completes
  // only on a successful receipt, so a failed fetch returns it to `ready`.
  assert.deepEqual(researchLadderToolNamesV1(2), [
    "web_search",
    "web_fetch",
    "web_fetch",
  ]);
  assert.deepEqual(researchLadderToolNamesV1(0), []);
  assert.deepEqual(researchLadderToolNamesV1(-3), []);
});

test("a prompt with no stated source count keeps today's ladder exactly", () => {
  // The byte-identical requirement. Nothing here reaches the compound seat, so
  // the fold must be a pass-through and the proof-debt ladder must survive
  // whole -- including the default floor of 1 fetch the site applies.
  const prompt =
    "Look up what the current guidance says about hydration during endurance events and summarize it.";
  assert.equal(parseExplicitResearchSourceCount(prompt), null);
  assert.deepEqual(getCompoundLifecycleResearchGraphToolNames(prompt, 0), []);
  const proofDebt = researchLadderToolNamesV1(1);
  assert.deepEqual(
    mergeResearchLadderToolNamesV1([], proofDebt),
    proofDebt,
    "with no compound ladder the fold returns the ladder unchanged",
  );
  assert.deepEqual(plannedResearchLadderForCompoundMission(prompt, 1), [
    "web_search",
    "web_fetch",
  ]);
});

test("the mission graph folds its two research ladders instead of summing them", () => {
  // Source-level guard. The composition helper above re-derives the site's
  // shape, so it can only stay honest if the site keeps consuming the shared
  // fold. Re-inlining a second ladder here is the exact regression.
  const runner = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const seatIndex = runner.indexOf("...(!seededResearchHandoffSatisfiesReads");
  assert.ok(seatIndex > 0, "the planned-research graph seat moved");
  const seat = runner.slice(seatIndex, seatIndex + 400);
  assert.match(
    seat,
    /mergeResearchLadderToolNamesV1\(\s*explicitCompoundResearchToolNames,\s*plannedResearchGraphToolNames,\s*\)/u,
    "the graph must fold the proof-debt ladder against the compound ladder",
  );
  // Both ladders must keep deriving their shape from the ONE shared helper.
  assert.match(
    runner,
    /const plannedResearchGraphToolNames = researchLadderToolNamesForPromptV1\(/u,
    "the proof-debt ladder must consume the shared prompt-aware ladder derivation",
  );
  assert.match(
    runner,
    /return researchLadderToolNamesV1\(remainingFetchCount\);/u,
    "the compound-lifecycle ladder must consume the shared ladder derivation",
  );
});

test("a budget terminal that forbids its own resume must name a blocker", () => {
  // The early-stop mechanism. A run finishing `budget` with auto-continuation
  // suppressed is terminal in fact (hosts continue only on budget AND
  // recommended) while advertising itself as resumable. Without a durable
  // blocker it left blockedGraph: [], autoContinueReason: "not_budget", ready
  // graph nodes, unspent budget, and no reason at all.
  const blocker = suppressedBudgetTerminalBlockerV1({
    stopReason: "budget",
    suppressAutoContinuation: true,
    reason: "compound_research_closure_exhausted after 1 reserved publication turn(s) at stage accepted_research",
  });
  assert.ok(blocker);
  assert.ok(blocker.startsWith(SUPPRESSED_BUDGET_TERMINAL_BLOCKER_V1));
  assert.match(blocker, /compound_research_closure_exhausted/u);
  // A resumable budget stop and a non-budget terminal are both untouched.
  assert.equal(
    suppressedBudgetTerminalBlockerV1({
      stopReason: "budget",
      suppressAutoContinuation: false,
      reason: "anything",
    }),
    null,
  );
  assert.equal(
    suppressedBudgetTerminalBlockerV1({
      stopReason: "final",
      suppressAutoContinuation: true,
      reason: "anything",
    }),
    null,
  );
});

test("the closure-exhausted terminal records its blocker before finishing", () => {
  // Source-level guard. `events.onStatus` is transient; only a ledger blocker
  // survives into Run Details and the harness report. This seat is the one that
  // matches every symptom of the observed stop, so it may not regress to a
  // status string alone.
  const runner = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const seatIndex = runner.indexOf(
    "Adaptive research budget is spent and its reserved publication turn did not close",
  );
  assert.ok(seatIndex > 0, "the closure-exhausted terminal seat moved");
  const seat = runner.slice(seatIndex, seatIndex + 1600);
  assert.match(
    seat,
    /suppressedBudgetTerminalBlockerV1\(/u,
    "the closure-exhausted terminal must derive its blocker from the shared seat",
  );
  assert.match(
    seat,
    /recordLedgerBlocker\(/u,
    "the closure-exhausted terminal must record a durable blocker",
  );
});
