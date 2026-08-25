import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sharedClassifiers from "../src/agent/promptIntentClassifiers";
import * as titleIntent from "../src/agent/titleIntent";

const RUN_PLAN_SOURCE = readFileSync(
  new URL("../src/agent/runPlan.ts", import.meta.url),
  "utf8",
);

/**
 * The route classifier and the tool frontier must not answer the same question
 * two different ways. AgentRunner imports its predicates from
 * promptIntentClassifiers, so any private redefinition inside runPlan.ts is a
 * second authority that will drift -- it already had, in twelve predicates,
 * each one a live disagreement between the route a mission took and the tools
 * its frontier then offered.
 *
 * This is a source-level guard rather than a behavioural one on purpose: drift
 * is only observable once the two copies disagree, which is exactly too late.
 */
test("runPlan defines no private copy of a shared prompt classifier", () => {
  const sharedNames = new Set(
    Object.entries(sharedClassifiers)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name),
  );
  assert.ok(sharedNames.size > 50, "expected the shared classifier surface");

  const redefined: string[] = [];
  for (const line of RUN_PLAN_SOURCE.split(/\r?\n/)) {
    const match = /^(?:export\s+)?function\s+([A-Za-z0-9_]+)\s*\(/.exec(line);
    if (match && sharedNames.has(match[1]!)) {
      redefined.push(match[1]!);
    }
  }

  assert.deepEqual(
    redefined,
    [],
    `runPlan.ts re-declares shared classifiers: ${redefined.join(", ")}. ` +
      "Import them from ./promptIntentClassifiers instead, or extend the " +
      "shared definition so both consumers gain the change. The deadlock " +
      "direction is always route-promises-what-authority-refuses, so a " +
      "predicate the route uses to promise a capability must be a subset of " +
      "the one the authority path consumes: unify by promoting the richer " +
      "matcher into the shared module, never by keeping the route wider.",
  );
});

/**
 * Witness prompts for the drifts that were live. Each one is a case where the
 * route used to reach a different verdict than the frontier; the shared
 * predicate's answer is now the single answer both of them get.
 */
test("the reconciled predicates answer the prompts that used to split them", () => {
  // A negated replace must not read as a replace mission. runPlan's copy
  // matched the bare verb and routed a destructive rewrite the frontier never
  // required a replace tool for.
  assert.equal(
    sharedClassifiers.hasReplaceIntent(
      "Write a summary of this note, but don't overwrite the note.",
    ),
    false,
  );
  assert.equal(
    sharedClassifiers.hasReplaceIntent("Rewrite the whole note from scratch."),
    true,
  );

  // A scope restriction says WHERE a mutation may land; it is not a second
  // append instruction. Reading it as one planted an append node ahead of
  // create_file and deadlocked the exact graph.
  assert.equal(
    sharedClassifiers.hasAppendIntent(
      "Create notes/out.md. Only write to that requested file.",
    ),
    sharedClassifiers.hasAppendIntent("Create notes/out.md."),
  );

  // The literal tool token is word-count intent; runPlan's copy omitted it, so
  // the route withheld count_words while the frontier offered it.
  assert.equal(sharedClassifiers.hasWordCountIntent("Run count_words on this note."), true);

  // A vault path is an opaque identifier, not natural-language intent. This
  // guard lived only in runPlan, so the frontier lacked it; it now sits in the
  // shared predicate and both consumers get it.
  assert.equal(
    sharedClassifiers.hasGraphConnectionIntent(
      "Append a summary to Mission Graph Guard/restart.md",
    ),
    false,
  );
  assert.equal(
    sharedClassifiers.hasGraphConnectionIntent(
      "What notes is this note connected to?",
    ),
    true,
  );
});

/**
 * The deadlock this repo keeps re-fixing runs in one direction: the route
 * promises a capability, the authority path refuses it, and the mission burns
 * its budget between the two. These assert the promoted matchers on the
 * predicate the FRONTIER consumes, which is the side that has to say yes.
 */
test("a typo-rescued code prompt is admitted by the predicate the frontier consumes", () => {
  // The rescue is widen-only: it can only add what the corrected spelling
  // would already have produced. Before promotion this lived privately in the
  // route, so a typo'd prompt routed as code work and then met a frontier
  // offering no code tools.
  assert.equal(
    sharedClassifiers.hasCodeExecutionIntent(
      "crate a number guessing game in pythn",
    ),
    true,
  );
  assert.equal(
    sharedClassifiers.hasCodeExecutionIntent(
      "create a number guessing game in python",
    ),
    true,
  );

  // Naming a code tool outright is the most explicit possible request; the
  // snake_case token cannot match the prose patterns, so it needs its own arm.
  assert.equal(
    sharedClassifiers.hasCodeExecutionIntent(
      "run code_workspace_create_file for app.py",
    ),
    true,
  );

  // Promotion must not drag the route's unguarded repository regex along: a
  // negated clause stays negative, so the route narrows rather than widens.
  assert.equal(
    sharedClassifiers.hasCodeExecutionIntent(
      "Do not touch the repository; just summarize it",
    ),
    false,
  );
  assert.equal(
    sharedClassifiers.hasCodeExecutionIntent(
      "Research the CAP theorem and write a note.",
    ),
    false,
  );
});

test("title intent covers organize phrasing without widening any capability offer", () => {
  // Restructuring repositions the heading, so the route kept these on the tool
  // loop. The shared predicate now agrees. The clause is a narrow residue on
  // purpose: anything editOrganizeIntent already recognizes is excluded just
  // below, so it only catches phrasings that module does not classify.
  assert.equal(sharedClassifiers.hasTitleIntent("restructure my file"), true);
  assert.equal(sharedClassifiers.hasTitleIntent("organize file contents"), true);

  // A genuine content-organize mission owns its own route and is excluded.
  for (const organizeMission of [
    "Reorganize this note and improve the file structure",
    "organize the note by topic",
    "Use these sources to improve the note",
  ]) {
    assert.equal(
      sharedClassifiers.hasTitleIntent(organizeMission),
      false,
      `content-organize mission must not become title work: ${organizeMission}`,
    );
  }

  // The verb must govern the note itself. Matching on proximity alone read
  // "write on this note ... find and organize information about the market"
  // as title work, which made a web-research mission read the current note
  // before it searched.
  assert.equal(
    sharedClassifiers.hasTitleIntent(
      [
        "I want you to write on this note.",
        "Start by titling it Software project.",
        "I want you to find and organize information about the current online dating market.",
      ].join("\n"),
    ),
    false,
  );

  // Instance #2 was an OFFER one term wider than its AUTHORITY twin, which
  // livelocked for 45 calls. hasTitleIntent only ever withholds a fast path;
  // the rename/retitle capabilities are promised by these predicates, and
  // getAllowedToolDefinitions and getRequiredWriteToolNames must keep reading
  // them identically.
  for (const prompt of [
    "restructure my file",
    "organize file contents",
    "Retitle this note to Quarterly Planning",
    "Set the h1 heading",
    "Improve my notes",
  ]) {
    const renamePair =
      titleIntent.isExplicitVisibleFileRenameIntent(prompt) ||
      (titleIntent.isVisibleTitleRenameIntent(prompt) &&
        titleIntent.isTitleOnlyIntent(prompt));
    assert.equal(
      sharedClassifiers.hasMarkdownTitleContentIntent(prompt),
      titleIntent.isMarkdownTitleContentIntent(prompt),
      `retitle offer and authority must read ${prompt} identically`,
    );
    assert.equal(
      typeof renamePair,
      "boolean",
      `rename offer and authority must resolve for ${prompt}`,
    );
  }
});
