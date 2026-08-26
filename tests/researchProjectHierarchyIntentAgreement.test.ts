import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { getRequiredWriteToolNamesForTests } from "../src/AgentRunner";
import {
  missionAuthorizesResearchProjectHierarchyV1,
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
} from "../src/tools/researchProjectHierarchyTool";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "../src/tools/researchPublicationTool";
import { hasAffirmativeJoinedDeveloperLifecycleIntent } from "../src/agent/promptIntentClassifiers";
import { CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME } from "../src/tools/githubPrivateRepositoryTool";

const RUNNER_SOURCE = readFileSync(
  new URL("../src/AgentRunner.ts", import.meta.url),
  "utf8",
);

/**
 * The tools a compound Linear/code/GitHub mission may be offered. Both missions
 * below are planned against the same catalog so the only variable is the
 * mission's own request.
 */
const ALLOWED = [
  PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
  PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
  "linear_create_issue",
  "linear_get_issue",
  "code_sandbox_status",
  "code_workspace_create",
  "code_workspace_create_file",
  "code_workspace_write_expected",
  "code_validate_fast",
  "code_repair_record_cycle",
  "code_validate_targeted",
  "code_validate_full",
  "code_workspace_init_repository",
  "code_commit_verified",
  CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
  "publish_verified_code_to_github",
  "append_to_current_file",
  "write_project_results",
];

/**
 * The exact shape of the compound-flow-real-live lane mission (identifiers
 * stubbed). It asks for "web research, Linear issue, repository workspace,
 * private GitHub, and note reflection" and publishes ONE accepted-research
 * issue. It never asks for an initiative, a project, or a set of issues.
 */
const COMPOUND_LANE_MISSION = [
  "Run the full pipeline for Flow real FLOW_REAL_0001: web research, Linear issue, repository workspace, private GitHub, and note reflection.",
  "First research the Flow real FLOW_REAL_0001 topic using exactly two public web sources and fetch both sources before accepting findings. Write the accepted findings into the current note E2E Agent Tests/FLOW-REAL-0001.md using the canonical headings ## Problem and impact, ## Evidence and source links, and ## Proposed work, citing both fetched source URLs and passages.",
  "After both fetches, call create_project_idea_brief exactly once. Evaluate at least two project directions, select one option, and set groundingReferences to the exact two fetched web URLs.",
  "Publish the accepted research note to Linear in the configured destination. The package is code work for repository key compound-flow-real-ts and validation requirement compound-flow-real-ts-validation. After publishing, call linear_get_issue for the returned issue and read back its title and URL before opening the code workspace.",
  "Create repository workspace flow-real-0001 and use one repair request id flow-real-request-0001 for every validation and commit call.",
  "Then call code_validate_fast, code_repair_record_cycle, code_validate_targeted, code_validate_full, and code_commit_verified with that same requestId flow-real-request-0001.",
  "Create the exact private GitHub repository octocat/e2e-flow-real-0001 with github_create_repository visibility private.",
  "After the verified commit exists, call publish_verified_code_to_github with action publish_draft for trusted profile compound-flow-real-ts so a draft pull request URL exists.",
  "Append a Flow real reflection to the current note via append_to_current_file containing marker FLOW_REAL_0001, the Linear issue URL, the private GitHub repo URL, the draft PR URL, and workspace flow-real-0001.",
  "Decide tool order yourself from the set-loose allowed tools. Pause only for the exact prepared approval required by an external mutation. Do not trash or delete. Do not merge.",
].join(" ");

/** The canonical developer mission that DOES ask for a Linear hierarchy. */
const HIERARCHY_MISSION = [
  "Research a conflict-free counter and create measurable Linear work.",
  "Implement and test it on desktop, then push a private draft PR to GitHub.",
].join(" ");

/**
 * The planner and the tool's own execution gate must answer "should this
 * mission build a Linear hierarchy?" exactly once.
 *
 * They did not. The planner accepted an extra
 * `hasAffirmativeJoinedDeveloperLifecycleIntent` disjunct that the gate never
 * honored, so the compound lane — whose prompt unlocks all five joined delivery
 * stages but requests a single Linear issue — planned
 * `tool-10-publish_research_project_to_linear`, offered it on the frontier, and
 * watched the model call it correctly twice before the gate refused it with
 * `linear_hierarchy_explicit_intent_required` and the node died
 * `tool_failure_repeated`.
 */
test("planner and hierarchy tool gate give one answer about building a Linear hierarchy", () => {
  const cases = [
    {
      label: "compound lane mission (one published Linear issue, no hierarchy)",
      prompt: COMPOUND_LANE_MISSION,
      authorized: false,
    },
    {
      label: "developer mission that asks for measurable Linear work",
      prompt: HIERARCHY_MISSION,
      authorized: true,
    },
  ];

  for (const { label, prompt, authorized } of cases) {
    // Both missions are joined developer lifecycles. That signal is exactly
    // what used to widen the planner past the gate, so it must NOT be what
    // decides the hierarchy.
    assert.equal(
      hasAffirmativeJoinedDeveloperLifecycleIntent(prompt),
      true,
      `${label}: expected a joined developer lifecycle`,
    );

    const gateAccepts = missionAuthorizesResearchProjectHierarchyV1(prompt);
    assert.equal(gateAccepts, authorized, `${label}: gate verdict`);

    const planned = getRequiredWriteToolNamesForTests(prompt, ALLOWED);
    assert.equal(
      planned.includes(PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME),
      gateAccepts,
      `${label}: the planner must never plan a hierarchy node the tool gate ` +
        `refuses, and must never drop one it would accept. planned=${planned.join(", ")}`,
    );
  }
});

/**
 * Failing closed is the point. The compound lane still publishes its single
 * accepted-research issue; only the unrequested hierarchy leaves the ladder.
 */
test("dropping the unrequested hierarchy leaves the compound lane's real Linear work intact", () => {
  const planned = getRequiredWriteToolNamesForTests(
    COMPOUND_LANE_MISSION,
    ALLOWED,
  );
  assert.equal(
    planned.includes(PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME),
    true,
    `compound lane must still plan its accepted-research publication: ${planned.join(", ")}`,
  );
  assert.equal(
    planned.includes(PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME),
    false,
  );
  assert.equal(
    planned.includes("publish_verified_code_to_github"),
    true,
    `compound lane must still plan its GitHub publication: ${planned.join(", ")}`,
  );

  // A mission that names no Linear work at all still gets no hierarchy.
  const noLinear =
    "Research two sources on conflict-free counters and append a summary to the current note.";
  assert.equal(missionAuthorizesResearchProjectHierarchyV1(noLinear), false);
  assert.equal(
    getRequiredWriteToolNamesForTests(noLinear, ALLOWED).includes(
      PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
    ),
    false,
  );

  // An explicit refusal stays refused.
  const negated =
    "Research a conflict-free counter, but do not turn the findings into Linear work. Implement and test it, then push a private draft PR to GitHub.";
  assert.equal(missionAuthorizesResearchProjectHierarchyV1(negated), false);
  assert.equal(
    getRequiredWriteToolNamesForTests(negated, ALLOWED).includes(
      PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
    ),
    false,
  );
});

/**
 * Source-level ratchet, in the shape `runPlanSharedClassifiers.test.ts` uses.
 * Drift is only observable once the two seats disagree, which is exactly too
 * late — so forbid the re-widening textually. The joined-lifecycle disjunct is
 * the specific shape that broke: it must never sit next to a hierarchy intent
 * question again.
 */
test("no seat re-widens the hierarchy question past the shared predicate", () => {
  const offenders: string[] = [];
  const lines = RUNNER_SOURCE.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (!/ResearchProjectHierarchy/u.test(line)) continue;
    // Look at the predicate expression this line participates in.
    const window = lines.slice(Math.max(0, index - 3), index + 4).join(" ");
    if (
      /joinedDeveloperLifecycle/u.test(window) &&
      /\|\|/u.test(window) &&
      !/^\s*\*/u.test(line)
    ) {
      offenders.push(`${index + 1}: ${line.trim()}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "AgentRunner.ts disjoins a hierarchy intent question with " +
      "joinedDeveloperLifecycle again:\n" +
      offenders.join("\n") +
      "\nThe planner, the frontier offer, and the tool's execution gate must " +
      "all read missionAuthorizesResearchProjectHierarchyV1. A joined " +
      "developer lifecycle describes the delivery pipeline's shape, not a " +
      "request for an initiative + project + issues; widening the planner " +
      "past the gate plans a node the gate then refuses. Narrow the offer " +
      "further if you must, but never widen it here.",
  );
});
