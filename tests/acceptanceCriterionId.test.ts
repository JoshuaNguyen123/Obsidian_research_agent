import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1,
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
  isCanonicalAcceptanceCriterionIdV1,
  normalizeAcceptanceCriterionIdV1,
} from "../src/integrations/linear/acceptanceCriterionIdV1";
import { createProjectIdeaBriefTool } from "../src/tools/projectIdeaBriefTool";

test("the id contract is published to the model, not only enforced after the call", () => {
  // The defect this pins: `create_project_idea_brief` declared the criterion id
  // as a bare string with no pattern and no description, while three separate
  // validators rejected anything but `AC-<n>`. A real compound run burned a
  // tool call discovering by failure a rule the schema could have stated.
  // Assert through the tool surface the MODEL actually receives, not a private
  // const -- the point is what the caller can see.
  const schema = createProjectIdeaBriefTool().parameters as unknown as {
    properties: {
      acceptanceCriteria: {
        items: { properties: { id: Record<string, unknown> } };
      };
    };
  };
  const id = schema.properties.acceptanceCriteria.items.properties.id;
  assert.equal(id.pattern, ACCEPTANCE_CRITERION_ID_PATTERN_V1);
  assert.equal(id.description, ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1);
  // The published pattern must actually be the rule the validators apply --
  // a schema advertising a DIFFERENT contract than the one enforced would be
  // worse than advertising none.
  const published = new RegExp(ACCEPTANCE_CRITERION_ID_PATTERN_V1, "u");
  for (const accepted of ["AC-1", "AC-9", "AC-10", "AC-99"]) {
    assert.ok(published.test(accepted), `${accepted} must satisfy the published pattern`);
    assert.ok(isCanonicalAcceptanceCriterionIdV1(accepted));
  }
  for (const rejected of ["AC-0", "AC-100", "AC-01", "ac-1", "AC1", "1"]) {
    assert.ok(!published.test(rejected), `${rejected} must not satisfy the published pattern`);
  }
});

test("the obvious spellings of one intent normalize instead of failing the call", () => {
  // Lenient at the boundary, canonical in storage. Each variant maps to exactly
  // one id, so this cannot merge two distinct criteria.
  for (const [input, expected] of [
    ["AC-7", "AC-7"],
    ["  AC-7  ", "AC-7"],
    ["ac-7", "AC-7"],
    ["Ac-7", "AC-7"],
    ["AC7", "AC-7"],
    ["ac7", "AC-7"],
    ["AC-07", "AC-7"],
    ["7", "AC-7"],
    ["07", "AC-7"],
    ["AC 7", "AC-7"],
    ["AC-99", "AC-99"],
    ["99", "AC-99"],
  ] as const) {
    assert.equal(
      normalizeAcceptanceCriterionIdV1(input),
      expected,
      `${JSON.stringify(input)} should normalize to ${expected}`,
    );
  }
});

test("ambiguous or out-of-range ids still fail closed", () => {
  // Tolerating variant SPELLINGS must not become tolerating variant MEANINGS.
  for (const rejected of [
    "AC-0",
    "0",
    "AC-100",
    "100",
    "AC-",
    "AC",
    "",
    "   ",
    "criterion 1",
    "AC-1: the text",
    "AC--1",
    "XC-1",
    "AC-1a",
    "-1",
    null,
    undefined,
    7,
    { id: "AC-1" },
  ]) {
    assert.equal(
      normalizeAcceptanceCriterionIdV1(rejected as unknown),
      null,
      `${JSON.stringify(rejected)} must be refused`,
    );
  }
});

test("normalization makes a duplicate visible that three separate regexes could not", () => {
  // "AC-1" and "ac-01" are the same criterion. Before normalization each seat
  // compared raw strings, so a caller could submit both and the duplicate check
  // would pass while the rendered issue carried two AC-1 rows.
  assert.equal(normalizeAcceptanceCriterionIdV1("AC-1"), "AC-1");
  assert.equal(normalizeAcceptanceCriterionIdV1("ac-01"), "AC-1");
  assert.equal(
    normalizeAcceptanceCriterionIdV1("AC-1"),
    normalizeAcceptanceCriterionIdV1("ac-01"),
  );
});

test("one definition serves every seat: no validator keeps a private copy", async () => {
  // The rule lived as three separate copies of /^AC-[1-9][0-9]?$/. Three copies
  // of one rule is the precondition of the drift this codebase keeps paying
  // for, so re-inlining it anywhere is blocked here rather than discovered
  // later by a lane.
  const { readFile } = await import("node:fs/promises");
  const seats = [
    "src/integrations/linear/AcceptedResearchArtifactV1.ts",
    "src/integrations/linear/AcceptedResearchNoteWriter.ts",
    "src/integrations/linear/WorkItemSpecV1.ts",
  ];
  const offenders: string[] = [];
  for (const seat of seats) {
    const source = await readFile(new URL(`../${seat}`, import.meta.url), "utf8");
    if (/AC-\[1-9\]/u.test(source)) {
      offenders.push(seat);
    }
    if (!source.includes("normalizeAcceptanceCriterionIdV1")) {
      offenders.push(`${seat} (does not consume the shared normalizer)`);
    }
  }
  assert.deepEqual(offenders, []);
});
