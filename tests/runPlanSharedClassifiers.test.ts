import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as sharedClassifiers from "../src/agent/promptIntentClassifiers";

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
    // hasCodeExecutionIntent is a deliberate exception, not a stale copy: the
    // route composes an exact match with a bounded typo rescue and explicit
    // code tool-name tokens, while the shared predicate composes standalone /
    // repository / deliverable intent. Reconciling them changes what the tool
    // frontier admits, so it needs a decision rather than a mechanical merge.
    // hasTitleIntent is excepted for the same reason: the route models
    // organize/restructure phrasing the shared title predicates do not.
    ["hasCodeExecutionIntent", "hasTitleIntent"],
    `runPlan.ts re-declares shared classifiers: ${redefined.join(", ")}. ` +
      "Import them from ./promptIntentClassifiers instead, or extend the " +
      "shared definition so both consumers gain the change.",
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
