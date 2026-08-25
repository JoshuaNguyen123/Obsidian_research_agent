import assert from "node:assert/strict";
import test from "node:test";
import {
  currentNoteAppendCatalogEligible,
  currentNoteReplaceCatalogEligible,
  deriveAutonomyScope,
  type AutonomyScope,
} from "../src/agent/missionScope";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../src/agent/replaceIntent";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { constrainSetLooseCompanionsToAutonomyScope } from "../src/AgentRunner";
import type { MissionIntent, ToolExecutionContext } from "../src/tools/types";

/**
 * Regression corpus for the revision dead-end.
 *
 * A user wrote an essay into the current note, then said "rewrite it with some
 * more details". Nothing was written: `hasAuthorizedCurrentNoteReplaceIntent`
 * (which the host uses to authorize its streamed replace) said yes on the bare
 * verb, while `scope.destructive.replaceCurrentNote` demanded a noun such as
 * "note"/"document" and said no — so `replace_current_file` was filtered out of
 * the catalog while streaming had already suppressed `append_to_current_file`.
 * Zero write paths remained.
 *
 * These two predicates gate the same capability and must never disagree.
 */

function scopeFor(prompt: string) {
  return deriveAutonomyScope(prompt, {
    noteOutput: true,
    vaultContext: true,
    hasActiveMarkdownNote: true,
  });
}

const REVISION_PROMPTS = [
  // The exact phrasing that shipped broken — bare verb, pronoun referent.
  "rewrite it with some more details",
  "rewrite it",
  "revise it and go deeper on the engineering side",
  "expand it with real examples",
  // Noun-bearing forms that already worked; they must keep working.
  "Edit the essay you gave me with more details.",
  "Rewrite this note from scratch.",
];

for (const prompt of REVISION_PROMPTS) {
  test(`revision authority agrees for: "${prompt}"`, () => {
    const authorized = hasAuthorizedCurrentNoteReplaceIntent(prompt);
    const scoped = scopeFor(prompt).destructive.replaceCurrentNote;
    assert.equal(
      scoped,
      authorized,
      `replaceCurrentNote=${scoped} but hasAuthorizedCurrentNoteReplaceIntent=${authorized}. ` +
        "These gate the same capability; disagreement leaves the run with no write path.",
    );
    assert.equal(
      authorized,
      true,
      "this phrasing should authorize a current-note revision",
    );
  });
}

test("a plain question never authorizes replacing the note", () => {
  for (const prompt of [
    "What is passive thread locking?",
    "Summarize the differences for me in chat.",
    "Append a short note about mutexes.",
  ]) {
    assert.equal(
      scopeFor(prompt).destructive.replaceCurrentNote,
      false,
      `"${prompt}" must not authorize a whole-note replace`,
    );
  }
});

test("an explicit refusal is not replace authority", () => {
  // The negated-clause guard in replaceIntent.ts must survive the alignment.
  const prompt = "Do not rewrite the note; just answer in chat.";
  assert.equal(hasAuthorizedCurrentNoteReplaceIntent(prompt), false);
  assert.equal(scopeFor(prompt).destructive.replaceCurrentNote, false);
});

test("revision authority requires an active markdown note", () => {
  const scope = deriveAutonomyScope("rewrite it with some more details", {
    noteOutput: false,
    vaultContext: false,
    hasActiveMarkdownNote: false,
  });
  assert.equal(
    scope.destructive.replaceCurrentNote,
    false,
    "with no active note there is nothing to replace",
  );
});

// ---------------------------------------------------------------------------
// The append cross-gate must never open the second revision dead-end: it
// blocks append telling the model to use replace_current_file, so replace
// must actually be catalog-eligible under the same scope predicate whenever
// the gate fires. Otherwise the mission has ZERO write paths.
// ---------------------------------------------------------------------------

const LONG_NOTE = [
  "# Essay",
  "",
  `${"A substantive paragraph about thread locking. ".repeat(12)}`,
  "",
  `${"More prose so the note clears the 400-character revision floor. ".repeat(8)}`,
].join("\n");

function createAppendContext(options: {
  prompt: string;
  missionIntent?: MissionIntent;
}): { context: ToolExecutionContext; content: Map<string, string> } {
  const content = new Map<string, string>([["Current.md", LONG_NOTE]]);
  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.replace(/\.md$/iu, ""),
          extension: "md",
        }
      : null;
  const context = {
    app: {
      workspace: { getActiveFile: () => getFile("Current.md") },
      vault: {
        read: async (file: { path: string }) => content.get(file.path) ?? "",
        modify: async (file: { path: string }, data: string) => {
          content.set(file.path, data);
        },
        getFileByPath: getFile,
        getAbstractFileByPath: getFile,
      },
    },
    settings: {},
    originalPrompt: options.prompt,
    writeAutonomy: true,
    missionIntent: options.missionIntent,
    now: () => new Date(500),
  } as unknown as ToolExecutionContext;
  return { context, content };
}

function revisionMissionIntent(prompt: string, scope: AutonomyScope): MissionIntent {
  return {
    mode: "explicit_file_mutation",
    vaultContext: true,
    noteOutput: true,
    explicitPersistence: true,
    explicitMutation: true,
    explicitDelete: false,
    allowAutonomousWrite: true,
    requireWriteCompletion: true,
    autonomyScope: scope,
  } as MissionIntent;
}

const CROSS_GATE_PROMPTS = [
  "rewrite it with some more details",
  "Rewrite this note from scratch.",
  "revise it and go deeper on the engineering side",
  "Please replace the note with a clean revised draft.",
];

test("wherever the append cross-gate blocks, replace is catalog-eligible under the same predicate", async () => {
  const registry = createDefaultToolRegistry();
  for (const prompt of CROSS_GATE_PROMPTS) {
    assert.equal(
      hasAuthorizedCurrentNoteReplaceIntent(prompt),
      true,
      `corpus prompt must carry replace intent: "${prompt}"`,
    );
    // Scope where replace IS eligible: the gate may block append, and the
    // catalog offers replace.
    const eligibleScope = scopeFor(prompt);
    assert.equal(currentNoteReplaceCatalogEligible(eligibleScope), true);
    const blockedRun = await registry.execute(
      { name: "append_to_current_file", arguments: { text: "An appended paragraph of real content." } },
      createAppendContext({
        prompt,
        missionIntent: revisionMissionIntent(prompt, eligibleScope),
      }).context,
    );
    assert.equal(blockedRun.ok, false, `gate should defer to replace for "${prompt}"`);
    assert.match(
      blockedRun.error?.message ?? "",
      /replace_current_file/,
      "GOVERNING RULE: for every prompt where the cross-gate blocks append, " +
        "replace_current_file must be offered — the gate and the catalog must " +
        "consult the same currentNoteReplaceCatalogEligible predicate.",
    );
    assert.equal(
      constrainSetLooseCompanionsToAutonomyScope(
        ["replace_current_file"],
        eligibleScope,
      ).includes("replace_current_file"),
      true,
      "GOVERNING RULE: for every prompt where the cross-gate blocks append, " +
        "replace_current_file must be offered — the gate and the catalog must " +
        "consult the same currentNoteReplaceCatalogEligible predicate.",
    );

    // Scope where replace is NOT eligible: the gate must NOT block append,
    // because deferring to a tool the catalog will never offer leaves the
    // mission with zero write paths. Noun-bearing prompts keep replace
    // authority from the prompt text alone, so only the bare-verb forms
    // reach this ineligible configuration.
    const ineligibleScope = deriveAutonomyScope(prompt, {
      noteOutput: false,
      vaultContext: false,
      hasActiveMarkdownNote: false,
    });
    if (currentNoteReplaceCatalogEligible(ineligibleScope)) {
      continue;
    }
    const fallbackRun = await registry.execute(
      { name: "append_to_current_file", arguments: { text: "An appended paragraph of real content." } },
      createAppendContext({
        prompt,
        missionIntent: revisionMissionIntent(prompt, ineligibleScope),
      }).context,
    );
    assert.equal(
      fallbackRun.ok,
      true,
      `GOVERNING RULE violated for "${prompt}": the cross-gate blocked append ` +
        "while replace_current_file is not catalog-eligible under the same " +
        "scope predicate — that leaves the mission with ZERO write paths. " +
        `error=${JSON.stringify(fallbackRun.error ?? null)}`,
    );
  }
});

test("append catalog eligibility is subsumed by destructive authority (shared predicate pins)", () => {
  const base = scopeFor("rewrite it with some more details");
  assert.equal(currentNoteAppendCatalogEligible(base), true);
  // Destructive replace authority without write.currentNote still keeps
  // append available as the non-destructive fallback at BOTH catalog sites.
  const destructiveOnly: AutonomyScope = {
    ...base,
    write: { ...base.write, currentNote: false },
    destructive: { ...base.destructive, replaceCurrentNote: true },
  };
  assert.equal(currentNoteAppendCatalogEligible(destructiveOnly), true);
  assert.deepEqual(
    constrainSetLooseCompanionsToAutonomyScope(
      ["append_to_current_file", "replace_current_file"],
      destructiveOnly,
    ),
    ["append_to_current_file", "replace_current_file"],
  );
  const noAuthority: AutonomyScope = {
    ...base,
    write: { ...base.write, currentNote: false },
    destructive: {
      replaceCurrentNote: false,
      deleteCurrentNote: false,
      deletePaths: false,
    },
  };
  assert.equal(currentNoteAppendCatalogEligible(noAuthority), false);
  assert.deepEqual(
    constrainSetLooseCompanionsToAutonomyScope(
      ["append_to_current_file", "replace_current_file"],
      noAuthority,
    ),
    [],
  );
});
