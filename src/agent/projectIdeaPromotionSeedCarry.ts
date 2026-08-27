import {
  deriveAcceptedResearchSeedFromProjectIdeaBriefV1,
  parseProjectIdeaAcceptedResearchSeedV1,
  parseProjectIdeaBriefV1,
} from "../../packages/core-api/src/projectIdeaBriefV1";
import type {
  MissionGraphV3,
  MissionJsonValueV1,
} from "./missionGraphV3";
import { CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME } from "../tools/projectIdeaBriefTool";
import type { AgentRuntimeCache } from "../tools/types";

/**
 * Durable node-outputs key holding the exact ideation brief and its signed
 * promotion seed.
 *
 * `create_project_idea_brief` writes its brief/seed into `runtimeCache`
 * (projectIdeaBriefTool.ts), and `publish_research_to_linear` is the only
 * consumer (researchPublicationTool.ts:1087 hydrates the package's
 * `projectIdeaSeed` from exactly that cache, and nothing else ever writes it).
 * But `runtimeCache` is created once per `runAgentMission` call
 * (AgentRunner.ts:2287) and every continuation SEGMENT is a separate
 * `runAgentMission` call, so the cache dies at each segment boundary.
 *
 * When a compound mission crosses a segment boundary between the brief and the
 * publish, the consumer therefore finds an empty cache. Because the graph's
 * completed nodes are immutable (`completed_node_immutable`), the already
 * complete `create_project_idea_brief` node can never run again, and
 * `assertProjectIdeaSeedPublicationBindingV1` refuses the publish with
 * `research_publication_project_idea_seed_required` on every remaining attempt.
 * That is an unpayable obligation: the mission is required to present a seed
 * whose only producer the graph has permanently retired.
 *
 * Three sibling run-local cache fields already solve this by rehydrating from
 * durable resume state (`restoreTrustedWebFetchResultsFromEvidence`,
 * `restoreLatestFastValidationDiagnosticFromReceipts`,
 * `restorePassedFastRepairCycleFromReceipts`). The ideation seed is the one
 * that was never given the same treatment. Mission evidence cannot carry it —
 * `evidenceFromToolResult` projects the brief down to a summary line and drops
 * the payload — so the carry rides the producing node's own durable `outputs`,
 * which the mission graph store already persists and restores verbatim.
 */
export const PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY =
  "projectIdeaPromotionCarryV1";

export interface ProjectIdeaPromotionCarryV1 {
  version: 1;
  brief: unknown;
  seed: unknown;
}

/**
 * Project a successful `create_project_idea_brief` result into the durable
 * node outputs that survive the segment boundary.
 *
 * Returns null for every other tool, for failures, and for a brief that has no
 * promotion seed. An unpromotable brief (unverified evidence, or no selected
 * option) deliberately carries nothing: the publish seat treats a cached brief
 * WITHOUT a seed as `research_publication_project_idea_not_promotable`, and
 * resurrecting that half-state across a segment would convert a recoverable
 * "select an option" into a hard refusal.
 */
export function projectIdeaPromotionCarryOutputsV1(
  toolName: string,
  result: { ok?: boolean; output?: unknown },
): Record<string, MissionJsonValueV1> | null {
  if (toolName !== CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME) return null;
  if (result.ok === false) return null;
  const output = asRecord(result.output);
  const brief = asRecord(output?.brief);
  const promotion = asRecord(output?.promotion);
  const seed = asRecord(promotion?.seed);
  if (!brief || !seed || promotion?.eligible !== true) return null;
  // Store only what re-derives and re-verifies below. A carry that cannot be
  // re-proved on the far side is worse than no carry at all.
  if (!verifiesExactly(brief, seed)) return null;
  const carry = {
    version: 1,
    brief,
    seed,
  } as unknown as MissionJsonValueV1;
  return { [PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY]: carry };
}

export type ProjectIdeaPromotionCarryRestoreReasonV1 =
  | "restored"
  | "cache_already_bound"
  | "no_carry_found"
  | "carry_unverifiable";

export interface ProjectIdeaPromotionCarryRestoreResultV1 {
  restored: boolean;
  reason: ProjectIdeaPromotionCarryRestoreReasonV1;
  nodeId?: string;
}

/**
 * Rehydrate the run-local ideation bridge for a resumed segment from the
 * completed producer node's durable outputs.
 *
 * The carry is re-proved here exactly as the publish seat proves it
 * (`resolveCachedProjectIdeaSeedV1`): the seed is re-derived from the brief and
 * must match the stored seed byte-for-byte. A tampered, truncated, or
 * schema-drifted carry restores NOTHING and leaves the publish seat's refusal
 * standing, so this can only ever return the mission to the state it would have
 * been in had it never been segmented — never widen its authority.
 */
export function restoreProjectIdeaPromotionSeedFromMissionGraphV1(
  runtimeCache: Pick<
    AgentRuntimeCache,
    "projectIdeaBrief" | "projectIdeaAcceptedResearchSeed"
  >,
  graph: Pick<MissionGraphV3, "nodes"> | null | undefined,
): ProjectIdeaPromotionCarryRestoreResultV1 {
  if (runtimeCache.projectIdeaBrief && runtimeCache.projectIdeaAcceptedResearchSeed) {
    return { restored: false, reason: "cache_already_bound" };
  }
  const candidates = Object.values(graph?.nodes ?? {}).filter(
    (node) =>
      node.status === "complete" &&
      node.allowedTools.includes(CREATE_PROJECT_IDEA_BRIEF_TOOL_NAME) &&
      asRecord(
        (node.outputs as Record<string, unknown> | undefined)?.[
          PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY
        ],
      ) !== null,
  );
  if (candidates.length === 0) {
    return { restored: false, reason: "no_carry_found" };
  }
  // Later graph order wins when a mission legitimately produced more than one
  // brief; the publish seat binds to the newest promotion seed either way.
  const node = candidates[candidates.length - 1]!;
  const carry = asRecord(
    (node.outputs as Record<string, unknown>)[
      PROJECT_IDEA_PROMOTION_CARRY_OUTPUT_KEY
    ],
  )!;
  const brief = asRecord(carry.brief);
  const seed = asRecord(carry.seed);
  if (carry.version !== 1 || !brief || !seed || !verifiesExactly(brief, seed)) {
    return { restored: false, reason: "carry_unverifiable", nodeId: node.id };
  }
  let parsedBrief;
  let parsedSeed;
  try {
    parsedBrief = parseProjectIdeaBriefV1(brief);
    parsedSeed = parseProjectIdeaAcceptedResearchSeedV1(seed);
  } catch {
    return { restored: false, reason: "carry_unverifiable", nodeId: node.id };
  }
  runtimeCache.projectIdeaBrief = parsedBrief;
  runtimeCache.projectIdeaAcceptedResearchSeed = parsedSeed;
  return { restored: true, reason: "restored", nodeId: node.id };
}

/**
 * The one shared proof both directions of the carry use: the seed must be the
 * exact derivation of the brief it claims to come from. Written once so the
 * writer can never store something the reader would reject.
 */
function verifiesExactly(brief: unknown, seed: unknown): boolean {
  try {
    const parsedBrief = parseProjectIdeaBriefV1(brief);
    const derived = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(parsedBrief);
    const observed = parseProjectIdeaAcceptedResearchSeedV1(seed);
    return canonicalJson(derived) === canonicalJson(observed);
  } catch {
    return false;
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(null);
  return `{${Object.keys(value as Record<string, unknown>)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(
          (value as Record<string, unknown>)[key],
        )}`,
    )
    .join(",")}}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
