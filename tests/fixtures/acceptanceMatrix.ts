import type { MissionGraphV3 } from "../../packages/headless-runtime/src/missionGraphV3";
import { isMissionGraphAcceptablyComplete } from "../../src/agent/missionGraphAuthority";
import type { MissionStopReason } from "../../src/agent/missionStopReason";

/**
 * Golden matrix: turns MISTAKES lessons into executable acceptance contracts.
 * Extend when a new budget/blocker/optional-graph regression appears.
 */
export interface AcceptanceMatrixCase {
  name: string;
  graph: MissionGraphV3 | null;
  expectAcceptable: boolean;
  expectStop?: MissionStopReason;
}

function node(
  status: string,
  deps: string[],
  tools: string[],
  evidence: string[] = [],
  objective = "task",
) {
  return {
    status,
    dependencyIds: deps,
    allowedTools: tools,
    objective,
    completionContract: { requiredEvidenceKinds: evidence },
  };
}

export const ACCEPTANCE_MATRIX_CASES: AcceptanceMatrixCase[] = [
  {
    name: "optional_read_pending_after_write",
    graph: {
      nodes: {
        "optional-web_search": node("ready", [], ["web_search"], [], "optional"),
        write: node("complete", [], ["replace_current_file"]),
        final: node("complete", ["write"], [], ["final-output"], "final"),
      },
    } as never,
    expectAcceptable: true,
    expectStop: "write_completed",
  },
  {
    name: "required_write_incomplete",
    graph: {
      nodes: {
        write: node("ready", [], ["replace_current_file"]),
        final: node("queued", ["write"], [], ["final-output"], "final"),
      },
    } as never,
    expectAcceptable: false,
    expectStop: "step_budget",
  },
  {
    name: "final_complete_with_required_deps",
    graph: {
      nodes: {
        context: node("complete", [], ["read_current_file"]),
        write: node("complete", ["context"], ["replace_current_file"]),
        final: node(
          "complete",
          ["context", "write"],
          [],
          ["final-output"],
          "final",
        ),
      },
    } as never,
    expectAcceptable: true,
    expectStop: "verified_complete",
  },
  {
    name: "no_graph_is_acceptable",
    graph: null,
    expectAcceptable: true,
    expectStop: "verified_complete",
  },
];

export function runAcceptanceMatrix(
  cases: AcceptanceMatrixCase[] = ACCEPTANCE_MATRIX_CASES,
): Array<{ name: string; ok: boolean; detail?: string }> {
  return cases.map((testCase) => {
    const actual = isMissionGraphAcceptablyComplete(testCase.graph);
    if (actual !== testCase.expectAcceptable) {
      return {
        name: testCase.name,
        ok: false,
        detail: `expected acceptable=${testCase.expectAcceptable}, got ${actual}`,
      };
    }
    return { name: testCase.name, ok: true };
  });
}
