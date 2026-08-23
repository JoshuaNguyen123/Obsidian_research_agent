import assert from "node:assert/strict";
import test from "node:test";

import {
  evaluateVaultBodyReadDebtV1,
  extractRequestedVaultReadPathsV1,
  extractVaultBodyReadPathsV1,
  extractVaultSearchResultPathsV1,
  isVaultBodyReadToolNameV1,
  isVaultSearchToolNameV1,
  normalizeVaultPathV1,
  VAULT_BODY_READ_PROOF_V1,
} from "../src/agent/researchRetrievalGate";

/** A backslash, without tripping over escaping in this file. */
const BACKSLASH = String.fromCharCode(92);

test("reads ranked markdown paths out of a semantic search payload", () => {
  const paths = extractVaultSearchResultPathsV1({
    operation: "semantic_search_notes",
    results: [
      { path: "Notes/Alpha.md", score: 0.9 },
      { path: "Notes/Beta.md", score: 0.4 },
    ],
  });
  assert.deepEqual(paths, ["Notes/Alpha.md", "Notes/Beta.md"]);
});

test("reads the same shape out of a keyword search payload", () => {
  // The regression this pins: keyword search had no followup branch at all, so
  // a `search_markdown_files` answer could be written entirely from snippets.
  const paths = extractVaultSearchResultPathsV1({
    output: {
      operation: "search_markdown_files",
      results: [
        { path: "Research/Onboarding.md", basename: "Onboarding", score: 12 },
      ],
    },
  });
  assert.deepEqual(paths, ["Research/Onboarding.md"]);
});

test("non-markdown, duplicate, and malformed results are dropped", () => {
  const paths = extractVaultSearchResultPathsV1({
    results: [
      { path: "Notes/Alpha.md" },
      { path: "Notes/alpha.md" },
      { path: "Attachments/diagram.png" },
      { path: "   " },
      { notAPath: true },
      "Notes/Gamma.md",
    ],
  });
  assert.deepEqual(paths, ["Notes/Alpha.md"]);
});

test("a payload with no results yields no paths rather than throwing", () => {
  assert.deepEqual(extractVaultSearchResultPathsV1(null), []);
  assert.deepEqual(extractVaultSearchResultPathsV1({ results: "none" }), []);
  assert.deepEqual(extractVaultSearchResultPathsV1({}), []);
});

test("surfaced but never opened is unpaid and names the proof token", () => {
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md", "Notes/Beta.md"],
    readPaths: [],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "unpaid");
  assert.equal(debt.satisfied, false);
  assert.deepEqual(debt.missing, [VAULT_BODY_READ_PROOF_V1]);
  assert.equal(debt.reason, "vault_search_results_never_opened");
  assert.equal(debt.countsAsVaultEvidence, false);
  assert.deepEqual(debt.unreadPaths, ["Notes/Alpha.md", "Notes/Beta.md"]);
});

test("opening one surfaced note pays the default debt", () => {
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md", "Notes/Beta.md"],
    readPaths: ["Notes/Alpha.md"],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "paid");
  assert.equal(debt.countsAsVaultEvidence, true);
  assert.equal(debt.readCount, 1);
  assert.deepEqual(debt.unreadPaths, ["Notes/Beta.md"]);
});

test("reading an unrelated note does not pay the debt", () => {
  // Only a note the search actually surfaced counts; otherwise reading the
  // active note would discharge the grounding requirement for free.
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md"],
    readPaths: ["Inbox/Scratch.md"],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "unpaid");
  assert.equal(debt.readCount, 0);
});

test("a higher minimum is honored but never exceeds what was surfaced", () => {
  const short = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md", "Notes/Beta.md", "Notes/Gamma.md"],
    readPaths: ["Notes/Alpha.md", "Notes/Beta.md"],
    requiresBodyRead: true,
    minimumReads: 3,
  });
  assert.equal(short.status, "unpaid");
  assert.equal(short.reason, "vault_body_reads_below_minimum");

  // Only one note exists; demanding three cannot make the mission unsatisfiable.
  const clamped = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md"],
    readPaths: ["Notes/Alpha.md"],
    requiresBodyRead: true,
    minimumReads: 3,
  });
  assert.equal(clamped.status, "paid");
});

test("an empty vault result is non-blocking but is not vault evidence", () => {
  // The vacuous-perfect-score hole: "nothing matched" must stay writable while
  // never counting as grounding.
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: [],
    readPaths: [],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "vacuous");
  assert.equal(debt.satisfied, true);
  assert.deepEqual(debt.missing, []);
  assert.equal(debt.countsAsVaultEvidence, false);
  assert.equal(debt.reason, "no_vault_results_surfaced");
});

test("a mission that owes no vault grounding is never blocked", () => {
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md"],
    readPaths: [],
    requiresBodyRead: false,
  });
  assert.equal(debt.status, "paid");
  assert.equal(debt.satisfied, true);
  assert.equal(debt.countsAsVaultEvidence, false);
});

test("the same note reached two ways is one note", () => {
  const windowsPath = ["Notes", "Alpha.md"].join(BACKSLASH);
  assert.equal(normalizeVaultPathV1(windowsPath), "notes/alpha.md");
  assert.equal(normalizeVaultPathV1("./Notes/Alpha.md"), "notes/alpha.md");
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md"],
    readPaths: [windowsPath],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "paid", "separator drift must not strand the debt");
});

test("every vault search tool is recognized and nothing else is", () => {
  assert.equal(isVaultSearchToolNameV1("semantic_search_notes"), true);
  assert.equal(isVaultSearchToolNameV1("search_markdown_files"), true);
  assert.equal(isVaultSearchToolNameV1("find_related_notes"), true);
  assert.equal(isVaultSearchToolNameV1("web_search"), false);
  assert.equal(isVaultSearchToolNameV1("read_file"), false);
});

test("a single-note read reports the note whose body came back", () => {
  assert.deepEqual(
    extractVaultBodyReadPathsV1({
      path: "Research/Onboarding.md",
      content: "We concluded that activation, not signup, is the metric.",
    }),
    ["Research/Onboarding.md"],
  );
});

test("a batch read reports what it opened and not what it skipped", () => {
  // `read_markdown_files` names every requested path, including the ones it
  // could not open. Counting a skipped path as read is the same vacuous
  // grounding the debt exists to prevent, one layer down.
  assert.deepEqual(
    extractVaultBodyReadPathsV1({
      output: {
        requestedCount: 3,
        returnedCount: 2,
        files: [
          { path: "Notes/Alpha.md", content: "alpha body" },
          { path: "Notes/Beta.md", content: "beta body" },
        ],
        skipped: [{ path: "Notes/Gone.md", reason: "not_found_or_not_markdown" }],
      },
    }),
    ["Notes/Alpha.md", "Notes/Beta.md"],
  );
});

test("an opened but empty note still counts as read", () => {
  // Requiring non-empty text would leave a mission whose only surfaced match is
  // an empty note owing a debt that nothing can ever pay.
  assert.deepEqual(
    extractVaultBodyReadPathsV1({ path: "Notes/Empty.md", content: "" }),
    ["Notes/Empty.md"],
  );
});

test("a search result is never mistaken for a read", () => {
  // The defect this pins: a vault search payload names paths and snippets, and
  // anything that treats "a path appeared" as "a body was read" lets the search
  // pay the debt it just created.
  assert.deepEqual(
    extractVaultBodyReadPathsV1({
      operation: "semantic_search_notes",
      results: [
        { path: "Research/Onboarding.md", snippet: "we concluded...", score: 12 },
      ],
    }),
    [],
  );
});

test("non-markdown and duplicate reads are dropped", () => {
  assert.deepEqual(
    extractVaultBodyReadPathsV1({
      files: [
        { path: "Notes/Alpha.md", content: "one" },
        { path: ["Notes", "Alpha.md"].join(BACKSLASH), content: "one again" },
        { path: "Assets/diagram.png", content: "binary" },
        { path: "Notes/NoBody.md" },
      ],
    }),
    ["Notes/Alpha.md"],
  );
});

test("every vault body-read tool is recognized and no search tool is", () => {
  for (const name of [
    "read_file",
    "read_current_file",
    "read_markdown_files",
    "inspect_vault_context",
  ]) {
    assert.equal(isVaultBodyReadToolNameV1(name), true, name);
  }
  for (const name of [
    "semantic_search_notes",
    "search_markdown_files",
    "find_related_notes",
    "web_fetch",
  ]) {
    assert.equal(isVaultBodyReadToolNameV1(name), false, name);
  }
});

test("a surfaced note that was tried and could not be opened stops owing", () => {
  // Without this the debt has no way to discharge: acceptance keeps naming
  // `vault_note_body_read`, the write stays held, and the run burns its whole
  // step budget being told to open a note that does not open.
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Ghost.md"],
    readPaths: [],
    attemptedPaths: ["Notes/Ghost.md"],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "vacuous");
  assert.equal(debt.satisfied, true);
  assert.deepEqual(debt.missing, []);
  assert.equal(debt.countsAsVaultEvidence, false);
  assert.equal(debt.reason, "vault_search_results_unreadable");
});

test("a surfaced note nobody tried is still an unpaid debt", () => {
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md", "Notes/Beta.md"],
    readPaths: [],
    attemptedPaths: ["Notes/Alpha.md"],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "unpaid");
  assert.equal(debt.satisfied, false);
  assert.deepEqual(debt.missing, [VAULT_BODY_READ_PROOF_V1]);
  assert.deepEqual(debt.unreadPaths, ["Notes/Alpha.md", "Notes/Beta.md"]);
});

test("omitting attemptedPaths keeps the previous behaviour exactly", () => {
  const debt = evaluateVaultBodyReadDebtV1({
    surfacedPaths: ["Notes/Alpha.md"],
    readPaths: [],
    requiresBodyRead: true,
  });
  assert.equal(debt.status, "unpaid");
  assert.deepEqual(debt.missing, [VAULT_BODY_READ_PROOF_V1]);
});

test("requested read paths are read off the call arguments, not the result", () => {
  assert.deepEqual(
    extractRequestedVaultReadPathsV1({ path: "Notes/Alpha.md" }),
    ["Notes/Alpha.md"],
  );
  assert.deepEqual(
    extractRequestedVaultReadPathsV1({
      paths: ["Notes/Alpha.md", "Notes/Beta.md", "Assets/x.png", 7],
    }),
    ["Notes/Alpha.md", "Notes/Beta.md"],
  );
  assert.deepEqual(extractRequestedVaultReadPathsV1(undefined), []);
});
