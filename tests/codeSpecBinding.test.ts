import assert from "node:assert/strict";
import test from "node:test";
import {
  CODE_SPEC_GATED_MUTATION_TOOLS,
  buildCodeSpecBindingV1,
  buildCodeSpecLinearSliceFromIssueRecord,
  evaluateCodeSpecSufficiency,
  extractBoundedNoteExcerpt,
  filterToolsUntilCodeSpecSufficient,
  formatCodeSpecBindingTurnContext,
  resolveSetLooseCodeSpecSufficiencyForSoftUnion,
} from "../src/agent/codeSpecBinding";

test("prefers Acceptance / Implementation sections for excerpts", () => {
  const markdown = [
    "# Title",
    "",
    "Intro fluff that should not dominate.",
    "",
    "## Acceptance",
    "- Must write hello.txt",
    "",
    "## Implementation",
    "Use Python.",
  ].join("\n");
  const excerpt = extractBoundedNoteExcerpt(markdown);
  assert.match(excerpt, /## Acceptance/);
  assert.match(excerpt, /## Implementation/);
  assert.match(excerpt, /hello\.txt/);
});

test("builds linear slice from freeform description", () => {
  const slice = buildCodeSpecLinearSliceFromIssueRecord({
    id: "issue-1",
    identifier: "ENG-1",
    url: "https://linear.app/team/issue/ENG-1",
    title: "Add hello",
    description: "Write hello.txt with marker FLOW",
  });
  assert.equal(slice?.identifier, "ENG-1");
  assert.match(String(slice?.descriptionExcerpt), /hello\.txt/);
  assert.equal(slice?.title, "Add hello");
});

test("requires both note and linear when both are required", () => {
  const binding = buildCodeSpecBindingV1({
    notePath: "Research/note.md",
    noteSha256: "a".repeat(64),
    noteMarkdown: "## Summary\nDone.",
  });
  const both = evaluateCodeSpecSufficiency({
    binding,
    requireNote: true,
    requireLinear: true,
  });
  assert.equal(both.sufficient, false);
  assert.match(both.reason, /linear/);

  const withLinear = buildCodeSpecBindingV1({
    notePath: "Research/note.md",
    noteSha256: "a".repeat(64),
    noteMarkdown: "## Summary\nDone.",
    linearRecord: {
      identifier: "ENG-1",
      url: "https://linear.app/team/issue/ENG-1",
      title: "Work",
    },
  });
  assert.equal(
    evaluateCodeSpecSufficiency({
      binding: withLinear,
      requireNote: true,
      requireLinear: true,
    }).sufficient,
    true,
  );
});

test("filters gated mutation tools when insufficient", () => {
  const filtered = filterToolsUntilCodeSpecSufficient({
    offeredToolNames: [
      "code_workspace_read",
      "code_workspace_create_file",
      "code_validate_fast",
      "code_workspace_write_expected",
    ],
    sufficiency: {
      sufficient: false,
      hasNote: false,
      hasLinear: true,
      reason: "code_spec_binding_insufficient=note",
    },
  });
  assert.deepEqual(filtered, ["code_workspace_read", "code_validate_fast"]);
  for (const tool of CODE_SPEC_GATED_MUTATION_TOOLS) {
    assert.equal(filtered.includes(tool), false);
  }
});

test("set-loose Soft-union waives note+linear parse after Linear delivery proof", () => {
  const base = evaluateCodeSpecSufficiency({
    binding: null,
    requireNote: true,
    requireLinear: true,
  });
  const waived = resolveSetLooseCodeSpecSufficiencyForSoftUnion({
    sufficiency: base,
    requireNote: true,
    requireLinear: true,
    linearDeliveryPaid: true,
  });
  assert.equal(waived.sufficient, true);
  assert.equal(waived.hasLinear, true);
  assert.ok(
    filterToolsUntilCodeSpecSufficient({
      offeredToolNames: ["code_workspace_write_expected", "code_validate_fast"],
      sufficiency: waived,
    }).includes("code_workspace_write_expected"),
  );
});

test("formats CODE SPEC BINDING header", () => {
  const binding = buildCodeSpecBindingV1({
    notePath: "Research/note.md",
    noteMarkdown: "## Acceptance\n- Ship it",
    linearRecord: {
      identifier: "ENG-2",
      url: "https://linear.app/x/issue/ENG-2",
      title: "Ship",
      description: "Do the thing",
    },
  });
  assert.ok(binding);
  const text = formatCodeSpecBindingTurnContext(binding!);
  assert.ok(text.startsWith("CODE SPEC BINDING (host-authoritative"));
  assert.match(text, /notePath=Research\/note\.md/);
  assert.match(text, /linearIssueIdentifier=ENG-2/);
});
