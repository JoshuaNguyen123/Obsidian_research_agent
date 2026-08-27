import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as sharedClassifiers from "../src/agent/promptIntentClassifiers";
import * as titleIntent from "../src/agent/titleIntent";
import { isPlaceholderToolNameV1 } from "../src/AgentRunner";
import { looksLikeUnfilledToolNamePlaceholderV1 } from "../src/agent/toolRejectEval";
import * as codeDesignIntent from "../src/agent/codeDesignIntent";
import * as researchDepthIntent from "../src/agent/researchDepthIntent";
import * as wordCountIntent from "../src/agent/wordCountIntent";

const SRC_ROOT = fileURLToPath(new URL("../src/", import.meta.url));

/**
 * Every module that can hold a prompt classifier: all of `src/agent/**` plus
 * `src/AgentRunner.ts`, which lives one level up but consumes the whole
 * surface.
 */
function collectClassifierSourceFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = `${dir}/${entry}`;
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith(".ts")) files.push(full);
    }
  };
  walk(`${SRC_ROOT}agent`);
  files.push(`${SRC_ROOT}AgentRunner.ts`);
  return files;
}

/**
 * The route classifier and the tool frontier must not answer the same question
 * two different ways. This guard used to scan runPlan.ts ALONE, which is
 * exactly how five more drifted copies escaped it -- word-count intent had
 * grown to FOUR definitions (loopPlanner, claimLedger, evidenceIntent and the
 * shared one) with six of nine witness prompts splitting them, deep-research
 * to two, html-preview to two that INVERTED each other, and long-research plus
 * the placeholder-tool-name predicate sat byte-identical and latent.
 *
 * So the scan now covers every file under src/agent/ plus AgentRunner.
 *
 * The rule is absolute: a shared classifier name may be DECLARED in exactly
 * one file. `promptIntentClassifiers` may re-export a definition that lives in
 * a lower-level module (`export { x } from "./y"`), but it may not wrap it in
 * a local `function x()`. A wrapper looks harmless -- `hasDesignIntent` was
 * one, and it only delegated -- but it is a second declaration site, and a
 * second declaration site only has to grow one extra condition to become the
 * next private copy.
 *
 * Source-level rather than behavioural on purpose: drift is only observable
 * once the copies disagree, which is exactly too late.
 */
test("no module under src/agent re-declares a shared prompt classifier", () => {
  const sharedNames = new Set(
    Object.entries(sharedClassifiers)
      .filter(([, value]) => typeof value === "function")
      .map(([name]) => name),
  );
  assert.ok(sharedNames.size > 50, "expected the shared classifier surface");

  const declaredIn = new Map<string, string[]>();
  for (const file of collectClassifierSourceFiles()) {
    const relative = file.slice(SRC_ROOT.length);
    for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
      const match =
        /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*[(<]/.exec(line);
      if (!match || !sharedNames.has(match[1]!)) continue;
      const seen = declaredIn.get(match[1]!) ?? [];
      if (!seen.includes(relative)) declaredIn.set(match[1]!, [...seen, relative]);
    }
  }

  const duplicated = [...declaredIn.entries()]
    .filter(([, files]) => files.length > 1)
    .map(([name, files]) => `${name} (${files.join(", ")})`)
    .sort();

  assert.deepEqual(
    duplicated,
    [],
    `shared classifiers declared in more than one module:\n  ${duplicated.join("\n  ")}\n\n` +
      "Delete every copy but one and import the survivor, or re-export it " +
      "from promptIntentClassifiers. Do not add a third guard to reconcile " +
      "two copies -- this codebase's cure for 'two subsystems disagree' is " +
      "always one definition. The deadlock direction is always " +
      "route-promises-what-authority-refuses, so unify by promoting the " +
      "richer matcher into the shared module, never by keeping the route " +
      "wider. Any classifier you touch must also strip negated phrasings " +
      "BEFORE testing.",
  );
});

/**
 * The name-based scan above only sees a copy that took the SHARED NAME. Three
 * of the word-count copies were anonymous -- an inline regex inside an `if`
 * (missionPlan), a differently-named private function (missionAcceptance's
 * `requiresWordCountEvidence`, the reflex path's `requiresWordCount`) -- so
 * that scan could never have found them, and the audit's name census did not
 * either. Word-count intent had SEVEN implementations in total.
 *
 * This closes that hole for the collapsed idea with the most seats: the
 * vocabulary below is specific enough to word counting that any occurrence
 * outside the defining module is a re-implementation.
 */
test("no module re-implements the word-count regex inline", () => {
  // missionScope extracts a PATH out of "count the words in X.md". It matches
  // the same words to strip a prefix, not to classify intent -- a different
  // question, deliberately separate, in the spirit of shouldRequireQuoteSpans
  // vs shouldVerifyQuoteSpansV1.
  const allowed = new Set(["agent/wordCountIntent.ts", "agent/missionScope.ts"]);
  const wordCountVocabulary =
    /word\\s\*counts?|word\\s\+counts?|count(?:\(\?:ing\)\?)?\\s\+\(\?:the\\s\+\)\?words|how\\s\+many\\s\+words/;

  const offenders: string[] = [];
  for (const file of collectClassifierSourceFiles()) {
    const relative = file.slice(SRC_ROOT.length).replace(/\\/g, "/");
    if (allowed.has(relative)) continue;
    for (const [index, line] of readFileSync(file, "utf8").split(/\r?\n/).entries()) {
      if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) continue;
      if (wordCountVocabulary.test(line)) offenders.push(`${relative}:${index + 1}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `word-count intent re-implemented inline at:\n  ${offenders.join("\n  ")}\n\n` +
      "Import hasWordCountIntent from ./wordCountIntent instead. The seat that " +
      "OFFERS count_words, the seat that plants the graph node, the seat that " +
      "adds the word_count proof obligation, the seat that checks it and the " +
      "reflex seat that decides completion must all read one predicate.",
  );
});

/**
 * The placeholder-tool-name dedup the merge note in toolRejectEval.ts asked
 * for. Identity, not equivalence: two functions that merely agree today are
 * the state this whole file exists to prevent.
 */
test("the placeholder-tool-name predicate is one function, not two that agree", () => {
  assert.equal(
    isPlaceholderToolNameV1,
    looksLikeUnfilledToolNamePlaceholderV1,
    "AgentRunner.isPlaceholderToolNameV1 must BE " +
      "toolRejectEval.looksLikeUnfilledToolNamePlaceholderV1, not a copy of it. " +
      "toolRejectEval is the correct home -- AgentRunner already imports it.",
  );

  for (const placeholder of [
    "$TOOL_NAME",
    "${toolName}",
    "<tool_name>",
    "{{tool}}",
    "your_tool_name",
  ]) {
    assert.equal(isPlaceholderToolNameV1(placeholder), true, placeholder);
  }
  for (const real of ["read_template", "count_words", "append_to_current_file"]) {
    assert.equal(isPlaceholderToolNameV1(real), false, real);
  }
  // The surviving body is the null-tolerant one; that was the only difference.
  assert.equal(looksLikeUnfilledToolNamePlaceholderV1(null), false);
  assert.equal(looksLikeUnfilledToolNamePlaceholderV1(undefined), false);
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

/**
 * The five collapsed classifiers, asserted on the exact prompts that split
 * them. Each `assert.equal(seatA, seatB)` is written as a comparison between
 * SEATS rather than against a literal, so the test fails the moment any seat
 * grows a private opinion again -- which is the failure being prevented, not
 * merely the current answer being recorded.
 */
test("word-count intent is one answer across all four former seats", () => {
  // Every seat now reads this function. loopPlanner imports it to plant the
  // count_words graph node, claimLedger to waive passage-id debt, evidenceIntent
  // to waive public-web debt, runPlan/AgentRunner to offer the tool.
  assert.equal(sharedClassifiers.hasWordCountIntent, wordCountIntent.hasWordCountIntent);

  // The witness that split three seats from the shared one. This is the most
  // natural phrasing of the request; the route said TRUE and offered
  // count_words while loopPlanner said FALSE and planted no node to call it.
  assert.equal(wordCountIntent.hasWordCountIntent("How many words is this note?"), true);

  // The reverse split: the gerund was true in loopPlanner and evidenceIntent
  // and false in the shared predicate and claimLedger.
  assert.equal(wordCountIntent.hasWordCountIntent("counting the words"), true);

  for (const prompt of [
    "Run count_words on this note.",
    "word count please",
    "count the words in the note",
    "length check",
    "verify the word length",
    "verify the generated note length",
  ]) {
    assert.equal(
      wordCountIntent.hasWordCountIntent(prompt),
      true,
      `word-count phrasing must be recognized: ${prompt}`,
    );
  }

  // STRIP-THEN-TEST. Every one of the four copies answered TRUE to "do not
  // count words", and two to "without counting words" -- a lexical trigger
  // arming the obligation the sentence forbids.
  for (const negated of [
    "do not count words",
    "don't count the words",
    "without counting words",
    "never give me a word count",
    "skip the length check",
    "do not tell me how many words it is",
    "no word count in the note",
  ]) {
    assert.equal(
      wordCountIntent.hasWordCountIntent(negated),
      false,
      `negated phrasing must not arm word-count intent: ${negated}`,
    );
  }

  // OWN-WRITE CONTRACT. A length TARGET the model must hit is not a request to
  // COUNT anything -- the number is an instruction to the writer, not a
  // question from the user. Reading it as word-count intent would plant a
  // count_words node and a word_count proof obligation on every ordinary
  // "write me N words" mission.
  for (const ownContract of [
    "Write a 500-word essay about tides.",
    "Draft a 1000 word report.",
    "Summarize this note in 200 words.",
  ]) {
    assert.equal(
      wordCountIntent.hasWordCountIntent(ownContract),
      false,
      `a length target is not a count request: ${ownContract}`,
    );
  }
  // Naming the metric outright is a request, and stays one.
  assert.equal(
    wordCountIntent.hasWordCountIntent("Write an essay with a word count of 500."),
    true,
  );

  // ...but stripping must not swallow a real request that merely FOLLOWS a
  // negated clause, which is why the strip uses closed-class fillers rather
  // than a character window.
  assert.equal(
    wordCountIntent.hasWordCountIntent("do not summarize, count the words"),
    true,
  );
  assert.equal(
    wordCountIntent.hasWordCountIntent(
      "Write a 500-word essay. Do not include a word count in the note, but tell me how many words it ended up being.",
    ),
    true,
  );
});

test("deep-research intent is one answer for the route and the research plan", () => {
  assert.equal(
    sharedClassifiers.hasDeepResearchIntent,
    researchDepthIntent.hasDeepResearchIntent,
  );

  // researchPlan's copy was WIDER here: it selected a deep research MODE for
  // these while the shared predicate told the route they were not deep
  // research at all. The route is now the one that widened.
  for (const prompt of [
    "long research on X",
    "compare sources on Z",
    "evidence ledger for W",
    "multi-source review of the topic",
    "long-running research project",
  ]) {
    assert.equal(
      researchDepthIntent.hasDeepResearchIntent(prompt),
      true,
      `sustained-research phrasing must be deep research: ${prompt}`,
    );
  }

  // The one term the shared copy had and researchPlan's lacked.
  assert.equal(researchDepthIntent.hasDeepResearchIntent("serious research on this"), true);

  for (const prompt of [
    "deep research on quantum computing",
    "in-depth analysis of the market",
    "thorough research",
  ]) {
    assert.equal(researchDepthIntent.hasDeepResearchIntent(prompt), true, prompt);
  }

  // STRIP-THEN-TEST: both copies answered TRUE to the negated form.
  for (const negated of [
    "do not do deep research",
    "without a deep dive",
    "never compare sources",
    "skip the investigation",
    "no long-running research",
  ]) {
    assert.equal(
      researchDepthIntent.hasDeepResearchIntent(negated),
      false,
      `negated phrasing must not arm deep research: ${negated}`,
    );
  }

  // A note revision is not research. This is the regression researchPlan's
  // own comment warns about (a bare "in-depth" routing an edit to deep_web),
  // and the union must not have reintroduced it.
  assert.equal(
    researchDepthIntent.hasDeepResearchIntent("Rewrite this note to be clearer."),
    false,
  );
});

test("long-research intent is one answer for the route and the loop planner", () => {
  // Byte-identical and latent: the two copies agreed on every probe, which is
  // exactly the state the other four were in until they did not.
  assert.equal(
    sharedClassifiers.hasLongResearchIntent,
    researchDepthIntent.hasLongResearchIntent,
  );

  for (const prompt of [
    "long research on X",
    "investigate the topic",
    "compare sources",
    "checkpoint the run",
  ]) {
    assert.equal(researchDepthIntent.hasLongResearchIntent(prompt), true, prompt);
  }
  assert.equal(researchDepthIntent.hasLongResearchIntent("do not investigate"), false);

  // Long-research and deep-research stay DIFFERENT questions: a budget signal
  // carries operational vocabulary that says nothing about research depth.
  // Feeding "checkpoint" to the depth predicate would route a resume prompt to
  // deep_web, which is the failure researchPlan's copy avoided.
  assert.equal(researchDepthIntent.hasLongResearchIntent("checkpoint the run"), true);
  assert.equal(researchDepthIntent.hasDeepResearchIntent("checkpoint the run"), false);
});

test("html-preview intent is one answer for the route and the design module", () => {
  assert.equal(
    sharedClassifiers.hasHtmlPreviewIntent,
    codeDesignIntent.hasHtmlPreviewIntent,
  );

  // The two copies INVERTED each other on exactly these two prompts.
  assert.equal(codeDesignIntent.hasHtmlPreviewIntent("open the html file"), true);
  assert.equal(codeDesignIntent.hasHtmlPreviewIntent("show me the mockup"), true);

  for (const prompt of [
    "preview the html page",
    "render the css",
    "display the webpage",
    "show the prototype",
  ]) {
    assert.equal(codeDesignIntent.hasHtmlPreviewIntent(prompt), true, prompt);
  }

  // The old local copy tested for a viewing verb and an artifact noun
  // INDEPENDENTLY, with `preview` in both lists -- so a bare "preview it",
  // naming no artifact at all, claimed HTML-preview capability. The shared
  // copy's proximity structure is what fixes this.
  assert.equal(codeDesignIntent.hasHtmlPreviewIntent("preview it"), false);
  assert.equal(
    codeDesignIntent.hasHtmlPreviewIntent("Summarize this note about css frameworks."),
    false,
  );

  // STRIP-THEN-TEST: both copies answered TRUE to the negated form.
  for (const negated of [
    "do not preview the html",
    "without rendering the web page",
    "never open the mockup",
  ]) {
    assert.equal(
      codeDesignIntent.hasHtmlPreviewIntent(negated),
      false,
      `negated phrasing must not arm html preview: ${negated}`,
    );
  }
  assert.equal(
    codeDesignIntent.hasHtmlPreviewIntent("do not edit it, just show the mockup"),
    true,
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
