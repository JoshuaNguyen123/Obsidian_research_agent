import assert from "node:assert/strict";
import test from "node:test";

import { promptTargetsActiveNoteSectionV1 } from "../src/AgentRunner";
import {
  detectSectionTargetV1,
  listMarkdownHeadingsV1,
  promptTargetsHeadingV1,
} from "../src/agent/sectionTarget";
import { resolveNoteOutputPlan } from "../src/agent/noteOutputPolicy";
import type { ToolExecutionContext } from "../src/tools/types";

/** The shape of the note that reproduced the defect. */
const THREAD_LOCKING_NOTE = `# Passive vs Aggressive Thread Locking

Intro prose.

## Passive Thread Locking

Passive locking is a cooperative model.

## Aggressive Thread Locking

Aggressive locking enforces synchronization at a lower level.

## Side-by-Side Comparison

- Enforcement: passive relies on convention.

## When to Pick Which

Choose passive locking when all participating code is yours.
`;

test("headings are parsed with their level, ignoring fenced code", () => {
  const markdown = [
    "# Title",
    "",
    "```python",
    "# not a heading",
    "```",
    "",
    "## Real Section",
    "### Deeper",
  ].join("\n");
  assert.deepEqual(listMarkdownHeadingsV1(markdown), [
    { text: "Title", level: 1 },
    { text: "Real Section", level: 2 },
    { text: "Deeper", level: 3 },
  ]);
  assert.deepEqual(listMarkdownHeadingsV1(""), []);
});

test("the exact live request targets both named sections despite a typo", () => {
  // Verbatim from the run that appended a whole essay instead: note the
  // misspelled "agressive", which any exact-match scheme would miss.
  const target = detectSectionTargetV1({
    prompt:
      "Can you add more writing detail under passive thread locking and agressive thread locking?",
    markdown: THREAD_LOCKING_NOTE,
  });

  assert.equal(target.confident, true);
  assert.equal(target.ambiguous, false);
  assert.equal(target.mode, "append", "\"add more detail\" adds, it does not rewrite");
  assert.deepEqual(
    target.headings.map((heading) => heading.text),
    ["Passive Thread Locking", "Aggressive Thread Locking"],
  );
});

test("the verb chooses between adding to and rewriting a section", () => {
  const revise = detectSectionTargetV1({
    prompt: "Please rewrite the Side-by-Side Comparison to be sharper.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(revise.mode, "replace");
  assert.deepEqual(revise.headings.map((h) => h.text), ["Side-by-Side Comparison"]);

  const add = detectSectionTargetV1({
    prompt: "Expand When to Pick Which with another example.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(add.mode, "append");
  assert.deepEqual(add.headings.map((h) => h.text), ["When to Pick Which"]);
});

test("negated section names never become mutation targets", () => {
  const onlyNegated = detectSectionTargetV1({
    prompt: "Do not rewrite the Aggressive Thread Locking section.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(onlyNegated.confident, false);
  assert.deepEqual(onlyNegated.headings, []);

  const mixed = detectSectionTargetV1({
    prompt:
      "Leave Aggressive Thread Locking unchanged; expand Passive Thread Locking with one example.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(mixed.confident, true);
  assert.deepEqual(
    mixed.headings.map((heading) => heading.text),
    ["Passive Thread Locking"],
  );
});

test("a request naming no section does not claim a target", () => {
  const target = detectSectionTargetV1({
    prompt: "Add a short summary of everything to the end of this note.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(target.confident, false);
  assert.equal(target.headings.length, 0);
  // No section wording either, so there is nothing to ask about.
  assert.equal(target.ambiguous, false);
});

test("section wording with an unmatched name asks rather than guessing", () => {
  const target = detectSectionTargetV1({
    prompt: "Rewrite the deadlock avoidance section so it is clearer.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(target.confident, false);
  assert.equal(target.ambiguous, true, "must ask instead of appending an essay");
});

test("a question about the topic is never a revision target", () => {
  for (const prompt of [
    "What is passive thread locking?",
    "Explain how aggressive thread locking differs.",
  ]) {
    const target = detectSectionTargetV1({
      prompt,
      markdown: THREAD_LOCKING_NOTE,
    });
    assert.equal(target.confident, false, prompt);
    assert.equal(target.ambiguous, false, prompt);
  }
});

test("a common word in a heading does not hijack an unrelated request", () => {
  const markdown = "# Doc\n\n## Scope\n\nText.\n\n## Dependencies\n\nText.\n";
  // Describing content that happens to use the words, not naming sections.
  const describing = detectSectionTargetV1({
    prompt: "Add a note about the scope of this project and its dependencies.",
    markdown,
  });
  assert.equal(describing.confident, false);
  assert.deepEqual(describing.headings, []);

  // The same words used as a location in the note do target the section.
  const naming = detectSectionTargetV1({
    prompt: "Add two more bullets under Scope.",
    markdown,
  });
  assert.equal(naming.confident, true);
  assert.deepEqual(naming.headings.map((h) => h.text), ["Scope"]);
});

test("the note title is never a section target", () => {
  // Its body is the whole note; rewriting everything is current_note_replace,
  // a different scope with its own gate.
  const target = detectSectionTargetV1({
    prompt: "Add more detail under Passive vs Aggressive Thread Locking.",
    markdown: THREAD_LOCKING_NOTE,
  });
  assert.equal(
    target.headings.some((heading) => heading.level === 1),
    false,
  );
});

test("appending new Markdown sections is not an ambiguous existing-heading edit", () => {
  const target = detectSectionTargetV1({
    prompt:
      "Append a ## Findings section with two cited sentences and a ## Limitations section to the current note.",
    markdown: "# Research seed\n\n## Background\n\nExisting context.",
  });

  assert.deepEqual(target.headings, []);
  assert.equal(target.confident, false);
  assert.equal(target.ambiguous, false);
  assert.equal(target.mode, "append");
});

test("the section tools authorize themselves on a named heading", () => {
  // The tools' own gates call this. The legacy word patterns reject the live
  // prompt, so without it the tool could be offered and still refuse to run.
  const prompt =
    "Can you add more writing detail under passive thread locking and agressive thread locking?";
  assert.equal(promptTargetsHeadingV1(prompt, "Passive Thread Locking"), true);
  assert.equal(promptTargetsHeadingV1(prompt, "Aggressive Thread Locking"), true);

  // A section the request never mentions stays refused: the model cannot
  // rewrite something the user did not name.
  assert.equal(promptTargetsHeadingV1(prompt, "Side-by-Side Comparison"), false);
  assert.equal(promptTargetsHeadingV1(prompt, ""), false);
  assert.equal(
    promptTargetsHeadingV1("What is passive thread locking?", "Passive Thread Locking"),
    false,
    "a question is not a revision request",
  );
});

test("a named section takes the tool loop instead of streaming to the end", () => {
  // The defect: direct writeback streamed a whole essay onto the note. This is
  // the decision that must now decline, so the run reaches the tool loop where
  // append_to_current_section exists.
  const context = {
    getCurrentMarkdownFile: () => ({ path: "Note.md", extension: "md" }),
    app: {
      metadataCache: {
        getFileCache: () => ({
          headings: [
            { heading: "Passive vs Aggressive Thread Locking", level: 1 },
            { heading: "Passive Thread Locking", level: 2 },
            { heading: "Aggressive Thread Locking", level: 2 },
          ],
        }),
      },
    },
  } as unknown as ToolExecutionContext;

  assert.equal(
    promptTargetsActiveNoteSectionV1(
      "Can you add more writing detail under passive thread locking and agressive thread locking?",
      context,
    ),
    true,
  );
  // An ordinary whole-note request keeps the existing streaming path.
  assert.equal(
    promptTargetsActiveNoteSectionV1("Write a summary of this note.", context),
    false,
  );
  // No active note, nothing to target.
  assert.equal(
    promptTargetsActiveNoteSectionV1("Add detail under Passive Thread Locking.", {
      app: {},
    } as unknown as ToolExecutionContext),
    false,
  );
});

test("an unmatched section plans chat, not a write", () => {
  // The whole point of the ambiguous branch: when the named section cannot be
  // found, the note must be left alone. Planning a write here is what produced
  // the duplicated essay in the first place.
  const plan = resolveNoteOutputPlan({
    prompt: "Rewrite the deadlock avoidance section so it is clearer.",
    hasActiveMarkdownNote: true,
    outputProfile: "active_or_new_note",
    enableStreaming: true,
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: false,
    contentProducing: true,
    sectionTargetAmbiguous: true,
  });
  assert.equal(plan.destination, "chat");
  assert.equal(plan.reason, "section_target_ambiguous");

  // A matched section still plans the scoped edit.
  const matched = resolveNoteOutputPlan({
    prompt: "Add more detail under Passive Thread Locking.",
    hasActiveMarkdownNote: true,
    outputProfile: "active_or_new_note",
    enableStreaming: true,
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: false,
    contentProducing: true,
    sectionTarget: { headings: ["Passive Thread Locking"], mode: "append" },
  });
  assert.equal(matched.destination, "active_note");
  assert.equal(matched.mutation, "section_append");
  assert.equal(matched.reason, "section_target_matched");

  // Replace verb reaches the replacing mutation.
  const replacing = resolveNoteOutputPlan({
    prompt: "Rewrite Passive Thread Locking.",
    hasActiveMarkdownNote: true,
    outputProfile: "active_or_new_note",
    enableStreaming: true,
    streamWritebackMode: "all_current_note_content_writes",
    autoTitleOnWrite: false,
    contentProducing: true,
    sectionTarget: { headings: ["Passive Thread Locking"], mode: "replace" },
  });
  assert.equal(replacing.mutation, "section_replace");
});

test("headings are deduplicated when a title repeats at another level", () => {
  const markdown = [
    "# Guide",
    "## Passive Thread Locking",
    "Body.",
    "### Passive Thread Locking",
    "Nested body.",
  ].join("\n");
  const target = detectSectionTargetV1({
    prompt: "Add more detail under Passive Thread Locking.",
    markdown,
  });
  assert.equal(target.headings.length, 1);
});
