/**
 * The Linear-side view of the one acceptance-criterion id definition.
 *
 * The rule itself moved to `@agentic-researcher/core-api` because a fourth
 * seat needed it: `ProjectIdeaBriefV1` lives in core-api, and core-api
 * deliberately imports nothing from the plugin source tree, so the definition
 * had to sink to the lowest layer every seat can reach. The three Linear
 * validators keep importing `./acceptanceCriterionIdV1` exactly as before --
 * this file is a re-export, not a second copy, and the source-level guard in
 * `tests/acceptanceCriterionId.test.ts` derives that fact rather than trusting
 * it.
 */

export {
  ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1,
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
  isCanonicalAcceptanceCriterionIdV1,
  normalizeAcceptanceCriterionIdV1,
} from "@agentic-researcher/core-api";
