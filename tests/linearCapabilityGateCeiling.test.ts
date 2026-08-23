import assert from "node:assert/strict";
import test from "node:test";

import {
  LINEAR_TOOL_OPERATION_MAP,
  createLinearTools,
} from "../src/integrations/linear/LinearTools";
import { deriveLinearCapabilityGate } from "../src/integrations/linear/LinearSettingsState";
import type { LinearCapabilityGate } from "../src/integrations/linear/types";

/**
 * How much of the Linear catalog the model can actually reach.
 *
 * `docs/capabilities.md` describes 121 fixed Linear tools "across issues,
 * comments, projects, milestones, cycles, initiatives, documents, labels,
 * relations, and customers". The catalog does contain all of those. The model
 * cannot reach all of them: `deriveLinearCapabilityGate` returns at most 3, and
 * labels-as-entities, every issue/project/initiative relation, initiative<->
 * project links, and the whole customer domain sit at gates 4 and 5.
 *
 * That is not necessarily wrong — reachability should be earned — but it was
 * undocumented and unasserted, so nothing failed when the docs and the code
 * disagreed. These tests state the ceiling with a number, so raising it is a
 * deliberate act that updates a test rather than a silent drift.
 */

const ALL_GATES: readonly LinearCapabilityGate[] = [0, 1, 2, 3, 4, 5];

function toolNamesAtGate(gate: LinearCapabilityGate): Set<string> {
  const client = {} as never;
  return new Set(
    createLinearTools({ gate, client }).map((tool) => tool.name),
  );
}

test("the connection-derived gate cannot exceed 3, whatever the connection proves", () => {
  const everyCapability = {
    version: 1 as const,
    capabilities: [
      "authenticated_connection",
      "team_selection",
      "project_selection",
      "workflow_state_selection",
      "read_only_discovery",
      "mutation_authority",
    ].map((id) => ({ id, enabled: true })),
  };
  assert.equal(
    deriveLinearCapabilityGate(everyCapability as never),
    3,
    "a fully capable connection is the ceiling of the derived gate",
  );
  assert.equal(deriveLinearCapabilityGate(null), 0);
});

test("gate 3 leaves a measured share of the fixed catalog unreachable", () => {
  const total = Object.keys(LINEAR_TOOL_OPERATION_MAP).length;
  const reachable = toolNamesAtGate(3);
  const everything = toolNamesAtGate(5);
  assert.equal(everything.size, total, "gate 5 exposes the whole catalog");

  const unreachable = [...everything].filter((name) => !reachable.has(name));
  assert.equal(
    total - reachable.size,
    unreachable.length,
    "reachability accounting must be exact",
  );
  // Update these two numbers when the ceiling moves; do not delete the test.
  assert.equal(total, 121);
  assert.equal(unreachable.length, 54);

  // Naming the shape of what is out of reach, so a reader of a failing run
  // knows which capability is missing rather than only that a count changed.
  for (const pattern of [
    /^linear_(create|update|delete|retire|restore)_(issue|project|initiative)_label$/u,
    /^linear_(add|remove)_label_(to|from)_(issue|project)$/u,
    /^linear_(create|update|delete)_issue_relation$/u,
    /^linear_(create|update|delete)_initiative_project_link$/u,
    /^linear_(create|update|delete)_customer$/u,
  ]) {
    assert.ok(
      unreachable.some((name) => pattern.test(name)),
      `expected an unreachable tool matching ${pattern}`,
    );
  }

  // Issue relations are the specific gap that matters for research work: they
  // are how a plan encodes real experiment dependencies.
  assert.ok(!reachable.has("linear_create_issue_relation"));
  assert.ok(reachable.has("linear_create_issue"));
  assert.ok(reachable.has("linear_update_issue"));
});

test("gate filtering is monotonic, so raising the ceiling only ever adds tools", () => {
  let previous = new Set<string>();
  for (const gate of ALL_GATES) {
    const current = toolNamesAtGate(gate);
    for (const name of previous) {
      assert.ok(
        current.has(name),
        `gate ${gate} dropped ${name}, which a lower gate exposed`,
      );
    }
    previous = current;
  }
});
