import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_REPEATED_OPERATION_TARGETS_V1,
  deriveOrderedWriteLiteralContractsV1,
  deriveRepeatedOperationNodesV1,
  deriveRepeatedOperationTargetsV1,
  repeatedOperationNodeObjectiveV1,
} from "../src/agent/repeatedOperationTargets";
import { getRequiredLiteralAnchorsMissingFromTextV1 } from "../src/agent/missionPlan";
import { ROUTING_GOLDEN_CORPUS } from "./fixtures/routingGoldenCorpus";

/**
 * The live interrupted-continuation mission, verbatim. Two ordered appends to
 * ONE note: the shape a multi-DESTINATION sweep scores as zero by
 * construction, which is why the first measurement of this defect reported no
 * prize at all.
 */
const TWO_ORDERED_APPENDS =
  "Perform exactly two ordered durable appends to the current note, then finish. " +
  "First append exactly one line containing MARKER_A1 and verify that write. " +
  "Then append exactly one separate line containing MARKER_B2 and verify that write. " +
  "Two appends total, in that order. This task needs no web, memory, or vault research.";

const DESTINATION_TOOL_NAMES = [
  "create_folder",
  "create_file",
  "append_file",
  "replace_file",
  "delete_path",
] as const;

test("two named folders in one request are two distinct destinations", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_folder",
      objective:
        "Create a folder Projects/Alpha and a folder Projects/Beta, then create a note Projects/Alpha/Index.md summarizing them.",
    }),
    ["Projects/Alpha", "Projects/Beta"],
  );
});

test("a coordinated create claims both named notes even with one verb", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_file",
      objective:
        "Create Projects/One.md and Projects/Two.md with a short brief in each.",
    }),
    ["Projects/One.md", "Projects/Two.md"],
  );
});

test("quoted folder names survive as exact destinations", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_folder",
      objective:
        'Make a new directory named "Reading List" and another folder called "Archive 2026".',
    }),
    ["Reading List", "Archive 2026"],
  );
});

test("append and delete families expand on the same shared rule", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "append_file",
      objective:
        "Append this summary to Projects/Brief.md and to Projects/Notes.md.",
    }),
    ["Projects/Brief.md", "Projects/Notes.md"],
  );
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "delete_path",
      objective: "Delete Projects/Old.md and Projects/Older.md from the vault.",
    }),
    ["Projects/Old.md", "Projects/Older.md"],
  );
});

test("a single named destination expands nothing so its plan is unchanged", () => {
  for (const objective of [
    "Create a folder Projects/Alpha.",
    "Create a new markdown file at Projects/Brief.md.",
    "Delete the folder Projects/Archive.",
  ]) {
    for (const toolName of DESTINATION_TOOL_NAMES) {
      assert.deepEqual(
        deriveRepeatedOperationTargetsV1({ toolName, objective }),
        [],
        `${toolName} must not expand: ${objective}`,
      );
    }
  }
});

test("plural nouns and numerals never manufacture unpayable nodes", () => {
  // The host cannot name these destinations, so it cannot prove extra nodes
  // are payable. Expanding here is the product:unpayable_debt failure class.
  for (const objective of [
    "Create several folders for my projects.",
    "Make two new folders in my vault.",
    "Create a few notes about the release.",
    "Add multiple sections to my vault notes.",
  ]) {
    for (const toolName of DESTINATION_TOOL_NAMES) {
      assert.deepEqual(
        deriveRepeatedOperationTargetsV1({ toolName, objective }),
        [],
        `${toolName} must not expand: ${objective}`,
      );
    }
  }
});

test("a source or content path is never counted as a second destination", () => {
  // Each of these names ONE destination and one or more sources. Counting the
  // source plants a node nothing will ever pay: the product:unpayable_debt
  // failure class. Every case here over-provisioned before the
  // source/content marker cut the clause at its destination head.
  const cases: Array<[string, string]> = [
    ["create_file", "Create Projects/Summary.md from Projects/Source.md."],
    [
      "create_file",
      "Create Projects/Summary.md summarizing Projects/Source.md and Projects/Other.md.",
    ],
    [
      "create_file",
      "Create a note at Projects/Brief.md with links to Archive/Old.md.",
    ],
    [
      "replace_file",
      "Replace Projects/Brief.md with a clean brief based on Projects/Draft.md.",
    ],
    [
      "delete_path",
      "Delete Projects/Old.md after copying it to Archive/Old.md.",
    ],
    [
      "create_file",
      "Read Projects/A.md and Projects/B.md, then create Projects/Digest.md.",
    ],
    ["create_folder", "Create a folder Projects/Alpha inside Projects/Root."],
    [
      "create_folder",
      "Make a folder Projects/Alpha and move Notes/A.md into it.",
    ],
  ];
  for (const [toolName, objective] of cases) {
    assert.deepEqual(
      deriveRepeatedOperationTargetsV1({ toolName, objective }),
      [],
      `${toolName} must not expand: ${objective}`,
    );
  }
});

test("a comma-separated destination list expands to every named path", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_file",
      objective: "Create Projects/One.md, Projects/Two.md, and Projects/Three.md.",
    }),
    ["Projects/One.md", "Projects/Two.md", "Projects/Three.md"],
  );
});

test("a destination preposition is not a source marker", () => {
  // "to"/"at"/"into" introduce the target itself, so an append addressed to
  // two notes must still expand.
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "delete_path",
      objective: "Delete Projects/Old.md and Projects/Older.md from the vault.",
    }),
    ["Projects/Old.md", "Projects/Older.md"],
  );
});

test("a competing verb stops governance eliding into the next clause", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_folder",
      objective:
        "Create a folder Projects/Alpha and read the folder Reference/Notes.",
    }),
    [],
  );
  // A move names two paths but performs one operation on them.
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_file",
      objective: "Rename the file Projects/Brief.md to Projects/Renamed.md.",
    }),
    [],
  );
});

test("current-note appends are never expanded by literal markers alone", () => {
  // Two markers named in ONE clause are payable by ONE append, so a second
  // plan-time node would be unpayable debt. Only a request that PROVES it
  // wants separate writes earns separate nodes (see the ordered-append tests
  // below) — marker count on its own never does.
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "append_to_current_file",
      objective: "Append MARKER_A1 and MARKER_B2 to this note.",
    }),
    [],
  );
  assert.deepEqual(
    deriveRepeatedOperationNodesV1({
      toolName: "append_to_current_file",
      objective: "Append MARKER_A1 and MARKER_B2 to this note.",
    }),
    [],
  );
});

test("two ordered appends to ONE note owe one literal contract each", () => {
  // THE corrected shape. Dedupe-by-tool-name collapsed this to a single
  // append_to_current_file node: the live mission paid marker one and the
  // frontier then had nothing to offer for marker two. Same defect as the
  // two-folder case, different geometry — one destination, two ordered writes.
  assert.deepEqual(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_to_current_file",
      objective: TWO_ORDERED_APPENDS,
    }),
    ["MARKER_A1", "MARKER_B2"],
  );
  const nodes = deriveRepeatedOperationNodesV1({
    toolName: "append_to_current_file",
    objective: TWO_ORDERED_APPENDS,
  });
  assert.equal(nodes.length, 2);
  // Distinct literal contracts, in the stated order.
  assert.deepEqual(nodes.map((node) => node.objective), [
    "Append to the current note exactly one separate line containing MARKER_A1.",
    "Append to the current note exactly one separate line containing MARKER_B2.",
  ]);
  // No node names a marker as its DESTINATION. Binding an ordered append to
  // its literal would make the node unsatisfiable at the exact-path guard —
  // unpayable debt by another route.
  assert.deepEqual(nodes.map((node) => node.selector), [undefined, undefined]);
});

test("the ordered-write count reads the EMPTY artifact, never a null one", () => {
  // API trap worth a dedicated pin. The shared authority answers "which
  // required literals are missing from THIS TEXT". At plan time no artifact
  // exists, so the artifact argument must be "" — an empty artifact is missing
  // every anchor, which is exactly the ordered-write count. `null` returns []
  // BY DESIGN (the helper fails open on an unreadable artifact) and would
  // silently plan ONE node again.
  assert.deepEqual(
    getRequiredLiteralAnchorsMissingFromTextV1(TWO_ORDERED_APPENDS, ""),
    ["MARKER_A1", "MARKER_B2"],
  );
  assert.deepEqual(
    getRequiredLiteralAnchorsMissingFromTextV1(TWO_ORDERED_APPENDS, null),
    [],
  );
  // Exactly N, not "at least one": a refactor to null must not be able to pass
  // this by provisioning a single node.
  assert.equal(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_to_current_file",
      objective: TWO_ORDERED_APPENDS,
    }).length,
    2,
  );
});

test("a one-marker append mission expands nothing at all", () => {
  // Byte-identical plans for every single-write mission. Note the "then":
  // ordering language alone must never expand a one-marker contract.
  for (const objective of [
    "Append one line containing MARKER_A1 to the current note.",
    "Search my vault, then append exactly one line containing MARKER_A1 to the current note.",
  ]) {
    assert.deepEqual(
      deriveRepeatedOperationNodesV1({
        toolName: "append_to_current_file",
        objective,
      }),
      [],
      objective,
    );
  }
});

test("a sourced writeback that commits its literals at finalization is untouched", () => {
  // These missions HOLD the write for passage verification and commit the
  // content — and therefore all of its literals — in ONE write at the end.
  // Levying a second write node pre-emptively adds a turn they cannot spend;
  // the acceptance seat makes the same distinction by levying literal debt
  // only where a write receipt already exists.
  for (const objective of [
    "Research the topic on the web, then rewrite the current note with a sourced synthesis containing MARKER_A1 and containing MARKER_B2, citing each passage.",
    "Summarize the fetched sources and append the verified writeback containing MARKER_A1 and containing MARKER_B2 to the current note in one pass.",
  ]) {
    assert.deepEqual(
      deriveRepeatedOperationNodesV1({
        toolName: "append_to_current_file",
        objective,
      }),
      [],
      objective,
    );
  }
});

test("only appends accumulate, so only appends expand to one target", () => {
  // A second replace node would ERASE what the first one wrote, and a second
  // create_file node is unpayable by construction. Neither is a repeated
  // operation against one destination however the request is phrased.
  for (const toolName of ["replace_current_file", "replace_file", "create_file"]) {
    assert.deepEqual(
      deriveOrderedWriteLiteralContractsV1({
        toolName,
        objective: TWO_ORDERED_APPENDS,
      }),
      [],
      toolName,
    );
  }
});

test("ordered appends to two DIFFERENT named notes are not same-target expanded", () => {
  // Caught as a real over-provisioning regression in this branch's first
  // draft. `append_file` resolves its destination from the prompt's named
  // paths and the host takes the FIRST one, so expanding this by literal count
  // handed BOTH nodes the selector Projects/One.md — the second could never be
  // paid past the exact-path guard. `product:unpayable_debt`, exactly.
  const objective =
    "Append exactly one line containing MARKER_A1 to Projects/One.md. " +
    "Then append exactly one separate line containing MARKER_B2 to Projects/Two.md.";
  assert.deepEqual(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_file",
      objective,
    }),
    [],
  );
  // One named destination is provably shared, so that one still expands.
  assert.deepEqual(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_file",
      objective:
        "Append exactly one line containing MARKER_A1 to Projects/Brief.md. " +
        "Then append exactly one separate line containing MARKER_B2 to Projects/Brief.md.",
    }),
    ["MARKER_A1", "MARKER_B2"],
  );
  // The current-note family is single-destination by construction, so a note
  // mentioned as a SOURCE never suppresses its expansion.
  assert.equal(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_to_current_file",
      objective:
        "Using Reference/One.md and Reference/Two.md, first append exactly one line containing MARKER_A1. " +
        "Then append exactly one separate line containing MARKER_B2.",
    }).length,
    2,
  );
});

test("a partially accounted literal contract expands nothing", () => {
  // Guard against the subtler drift: if the clauses account for only two of
  // three owed literals, planning two nodes would leave acceptance demanding a
  // third with nothing to pay it. The plan must owe exactly what the contract
  // owes, or keep its single node and fail honestly.
  const objective =
    "Perform ordered durable appends to the current note. " +
    "First append exactly one line containing MARKER_A1. " +
    "Then append exactly one separate line containing MARKER_B2. " +
    "The final answer must include MARKER_C3 as well.";
  assert.equal(
    getRequiredLiteralAnchorsMissingFromTextV1(objective, "").length,
    3,
  );
  assert.deepEqual(
    deriveOrderedWriteLiteralContractsV1({
      toolName: "append_to_current_file",
      objective,
    }),
    [],
  );
});

test("an ordered-append expansion is bounded like every other expansion", () => {
  const objective =
    "Perform ordered durable appends to the current note, one at a time. " +
    Array.from(
      { length: 12 },
      (_, index) =>
        `Then append exactly one separate line containing MARKER_ORDERED_${index}.`,
    ).join(" ");
  const contracts = deriveOrderedWriteLiteralContractsV1({
    toolName: "append_to_current_file",
    objective,
  });
  assert.ok(contracts.length <= MAX_REPEATED_OPERATION_TARGETS_V1);
});

test("expansion is bounded so a pathological prompt cannot blow the graph", () => {
  const objective = `Create ${Array.from(
    { length: 40 },
    (_, index) => `Bulk/File${index}.md`,
  ).join(" and ")}.`;
  const targets = deriveRepeatedOperationTargetsV1({
    toolName: "create_file",
    objective,
  });
  assert.equal(targets.length, MAX_REPEATED_OPERATION_TARGETS_V1);
});

test("unknown tools and empty objectives expand nothing", () => {
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "web_search",
      objective: "Create Projects/One.md and Projects/Two.md.",
    }),
    [],
  );
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "create_file",
      objective: "   ",
    }),
    [],
  );
});

test("every routing golden corpus prompt keeps its single-node plan", () => {
  const expansions: string[] = [];
  for (const entry of ROUTING_GOLDEN_CORPUS) {
    for (const toolName of DESTINATION_TOOL_NAMES) {
      const targets = deriveRepeatedOperationTargetsV1({
        toolName,
        objective: entry.prompt,
      });
      if (targets.length > 0) {
        expansions.push(`${entry.id}/${toolName} -> ${targets.join(",")}`);
      }
    }
  }
  assert.deepEqual(
    expansions,
    [],
    "No golden-corpus prompt names two destinations, so none may gain a node.",
  );
});

test("per-instance objectives name the exact destination", () => {
  assert.equal(
    repeatedOperationNodeObjectiveV1("create_folder", "Projects/Alpha"),
    "Create the exact named vault folder Projects/Alpha.",
  );
  assert.equal(
    repeatedOperationNodeObjectiveV1("create_file", "Projects/One.md"),
    "Create the exact new vault note Projects/One.md without overwrite.",
  );
});

test("the repeated-operation derivation is never re-inlined by a second seat", () => {
  // Guard idiom (see the route/frontier predicate split): a private copy of
  // "how many instances does this request imply" is precisely the
  // two-subsystems-disagree shape this derivation exists to end.
  const sourceUrl = new URL(
    "../src/agent/repeatedOperationTargets.ts",
    import.meta.url,
  );
  const source = readFileSync(fileURLToPath(sourceUrl), "utf8");
  assert.ok(
    source.includes("OPERATION_KIND_BY_TOOL_NAME"),
    "The tool -> operation-kind table must stay in the shared module.",
  );
  const hostSource = readFileSync(
    fileURLToPath(new URL("../src/agent/missionGraphHost.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    hostSource.includes("deriveRepeatedOperationNodesV1"),
    "The host planner must consume the shared derivation.",
  );
  // Stronger than name-presence: the host consumes the single ENTRY POINT, not
  // either branch. Reaching past it for one shape is how the planner ends up
  // answering "how many nodes" differently from the seat that pays them.
  assert.equal(
    /deriveRepeatedOperationTargetsV1|deriveOrderedWriteLiteralContractsV1/u.test(
      hostSource,
    ),
    false,
    "The host planner must call the single seat, never an individual branch.",
  );
  assert.equal(
    /OPERATION_KIND_BY_TOOL_NAME|GOVERNING_VERBS|ORDERED_WRITE_TOOL_NAMES/u.test(
      hostSource,
    ),
    false,
    "The host planner must not re-inline the derivation's classification tables.",
  );
  // The ordered-write count is delegated to the acceptance authority, never
  // re-derived. A local anchor regex here would be the same defect in a new
  // costume: the planner and acceptance would count different contracts.
  assert.ok(
    source.includes("getRequiredLiteralAnchorsMissingFromTextV1"),
    "The ordered-write branch must consume the shared literal-anchor authority.",
  );
  assert.equal(
    /const\s+\w*ANCHOR\w*\s*=\s*\//u.test(source),
    false,
    "The shared module must not grow its own literal-anchor pattern.",
  );
});
