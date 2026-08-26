import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_REPEATED_OPERATION_TARGETS_V1,
  deriveRepeatedOperationTargetsV1,
  repeatedOperationNodeObjectiveV1,
} from "../src/agent/repeatedOperationTargets";
import { ROUTING_GOLDEN_CORPUS } from "./fixtures/routingGoldenCorpus";

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

test("current-note appends are never expanded from literal markers", () => {
  // Two markers can land in ONE append, so a second plan-time node would be
  // unpayable. Still-missing markers are spliced at resume against the live
  // note instead, where the count is observed rather than guessed.
  assert.deepEqual(
    deriveRepeatedOperationTargetsV1({
      toolName: "append_to_current_file",
      objective: "Append MARKER_A1 and MARKER_B2 to this note.",
    }),
    [],
  );
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
    hostSource.includes("deriveRepeatedOperationTargetsV1"),
    "The host planner must consume the shared derivation.",
  );
  assert.equal(
    /OPERATION_KIND_BY_TOOL_NAME|GOVERNING_VERBS/u.test(hostSource),
    false,
    "The host planner must not re-inline the derivation's classification tables.",
  );
});
