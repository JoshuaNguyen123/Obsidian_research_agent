import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DEFINITION_BONUS_V1,
  WorkspaceManagerV2,
  isDefinitionLineV1,
  isWholeIdentifierMatchV1,
  rankWorkspaceSearchCandidatesV1,
  scoreWorkspaceSearchCandidateV1,
  workspaceQueryTermsV1,
  type WorkspaceSearchCandidateV1,
} from "../extensions/code/workspaces";

/*
 * `code_workspace_search` used to walk the tree and return the first `limit`
 * matches it tripped over, so the answer to "where is this defined" was
 * whatever sorted first -- typically a call site in a build artefact or a
 * fixture. These tests pin the two properties that fixes it: the limit selects
 * the best matches rather than the earliest, and a declaration outranks a
 * mention of the same identifier.
 */

async function fixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `workspace-search-${name}-`));
  let milliseconds = Date.parse("2026-09-04T03:00:00.000Z");
  let sequence = 0;
  return {
    root,
    manager: new WorkspaceManagerV2({
      applicationDataRoot: root,
      now: () => new Date((milliseconds += 1)),
      randomId: () => `search-${++sequence}`,
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

const CORPUS = {
  documentCount: 10,
  documentFrequencies: new Map([
    ["rare", 1],
    ["common", 10],
  ]),
  queryTerms: ["rare"],
};

function candidate(
  overrides: Partial<WorkspaceSearchCandidateV1> & Pick<WorkspaceSearchCandidateV1, "path" | "text">,
): WorkspaceSearchCandidateV1 {
  return {
    line: 1,
    column: overrides.text.indexOf(overrides.needle ?? "rare") + 1,
    needle: "rare",
    matchedTerms: ["rare"],
    phrase: true,
    ...overrides,
  };
}

test("a declaration outranks every mention of the same identifier", async () => {
  const created = await fixture("definition");
  try {
    await created.manager.createScratchWorkspace({
      workspaceId: "ws",
      ownerRunId: "run-1",
    });
    const lease = (await created.manager.acquireLease("ws", "worker"))!.lease!.id;
    // Sorted first by every tree walk, and full of matches: exactly what used
    // to fill the whole result page.
    await created.manager.createFile(
      "ws",
      lease,
      "build/bundle.js",
      Array.from({ length: 40 }, (_, index) => `  resolveTicket(order${index});`).join("\n"),
    );
    await created.manager.createFile(
      "ws",
      lease,
      "src/tickets.ts",
      [
        "import { load } from './io';",
        "",
        "export function resolveTicket(id: string): Ticket {",
        "  return load(id);",
        "}",
      ].join("\n"),
    );
    await created.manager.createFile(
      "ws",
      lease,
      "tests/tickets.test.ts",
      ["// resolveTicket is covered here", "resolveTicket('t-1');"].join("\n"),
    );

    const results = await created.manager.search("ws", "resolveTicket");
    const top = results[0]!;
    assert.equal(top.path, "src/tickets.ts", `expected the declaration first, got ${results.slice(0, 3).map((hit) => `${hit.path}:${hit.line}`).join(", ")}`);
    assert.equal(top.line, 3);
    assert.equal(top.matchKind, "definition");
    // The old scan returned 40 build hits before reaching src at all; the
    // declaration must now beat them by more than a rounding margin.
    const bestBundle = results.find((hit) => hit.path === "build/bundle.js");
    assert.ok(bestBundle, "the build matches must still be reachable, only demoted");
    assert.ok(
      top.score - bestBundle.score > DEFINITION_BONUS_V1 / 2,
      `declaration ${top.score} vs bundle ${bestBundle.score}`,
    );
    // Nothing is dropped: 40 bundle call sites, the declaration, and the two
    // lines of the test file are all still available under the limit.
    assert.equal(results.length, 43);
  } finally {
    await created.cleanup();
  }
});

test("a small limit takes the best matches, not the first ones on disk", async () => {
  const created = await fixture("limit");
  try {
    await created.manager.createScratchWorkspace({ workspaceId: "ws", ownerRunId: "run-2" });
    const lease = (await created.manager.acquireLease("ws", "worker"))!.lease!.id;
    await created.manager.createFile(
      "ws",
      lease,
      "a-generated/output.js",
      Array.from({ length: 30 }, () => "  useLedger();").join("\n"),
    );
    await created.manager.createFile(
      "ws",
      lease,
      "z-src/ledger.ts",
      "export const useLedger = () => 1;",
    );
    const results = await created.manager.search("ws", "useLedger", { limit: 3 });
    assert.equal(results.length, 3);
    assert.equal(
      results[0]!.path,
      "z-src/ledger.ts",
      "the declaration sorts last on disk and must still be first in the results",
    );
  } finally {
    await created.cleanup();
  }
});

test("a multi-word query with no literal match falls back to its terms", async () => {
  const created = await fixture("fallback");
  try {
    await created.manager.createScratchWorkspace({ workspaceId: "ws", ownerRunId: "run-3" });
    const lease = (await created.manager.acquireLease("ws", "worker"))!.lease!.id;
    await created.manager.createFile(
      "ws",
      lease,
      "src/retry.ts",
      ["export function scheduleRetry(backoff: number) {", "  return backoff * 2;", "}"].join("\n"),
    );
    await created.manager.createFile("ws", lease, "src/other.ts", "export const unrelated = 1;");

    // No line contains this string; the old scan returned nothing at all.
    const results = await created.manager.search("ws", "retry backoff");
    assert.ok(results.length > 0, "term fallback must find the line covering both terms");
    assert.equal(results[0]!.path, "src/retry.ts");
    assert.equal(results[0]!.line, 1);
  } finally {
    await created.cleanup();
  }
});

test("a literal match suppresses the term fallback entirely", async () => {
  const created = await fixture("phrase");
  try {
    await created.manager.createScratchWorkspace({ workspaceId: "ws", ownerRunId: "run-4" });
    const lease = (await created.manager.acquireLease("ws", "worker"))!.lease!.id;
    await created.manager.createFile("ws", lease, "src/exact.ts", "const retry backoff = 1;");
    await created.manager.createFile(
      "ws",
      lease,
      "src/loose.ts",
      ["const retry = 1;", "const backoff = 2;"].join("\n"),
    );
    const results = await created.manager.search("ws", "retry backoff");
    assert.deepEqual(
      results.map((hit) => hit.path),
      ["src/exact.ts"],
      "widening a query that already matched would bury the exact hit",
    );
  } finally {
    await created.cleanup();
  }
});

test("declaration shapes are recognised across the languages a workspace holds", () => {
  const declares = [
    ["export function resolveTicket(id: string) {", "resolveTicket"],
    ["  async resolveTicket(id) {", "resolveTicket"],
    ["def resolve_ticket(self, id):", "resolve_ticket"],
    ["class TicketStore extends Base {", "TicketStore"],
    ["export const useLedger = () => 1;", "useLedger"],
    ["type TicketId = string;", "TicketId"],
    ["interface Ledger {", "Ledger"],
    ["pub fn resolve_ticket(id: u32) -> Ticket {", "resolve_ticket"],
    ["  private readonly ledger: Ledger = new Ledger();", "ledger"],
    ["resolveTicket: async (id) => load(id),", "resolveTicket"],
  ] as const;
  for (const [line, needle] of declares) {
    assert.ok(isDefinitionLineV1(line, needle, false), `should declare: ${line}`);
  }
  const mentions = [
    ["  return resolveTicket(id);", "resolveTicket"],
    ["import { resolveTicket } from './tickets';", "resolveTicket"],
    ["// resolveTicket is covered here", "resolveTicket"],
    ["const value = ledger.resolveTicket(id);", "resolveTicket"],
  ] as const;
  for (const [line, needle] of mentions) {
    assert.ok(!isDefinitionLineV1(line, needle, false), `should not declare: ${line}`);
  }
});

test("a whole-identifier match beats the same needle inside a longer name", () => {
  assert.ok(isWholeIdentifierMatchV1("const rare = 1;", 7, "rare"));
  assert.ok(!isWholeIdentifierMatchV1("const rarefied = 1;", 7, "rare"));
  const whole = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "src/a.ts", text: "const rare = 1;" }),
    CORPUS,
  );
  const fragment = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "src/a.ts", text: "const rarefied = 1;" }),
    CORPUS,
  );
  assert.ok(whole.score > fragment.score, `${whole.score} vs ${fragment.score}`);
});

test("generated and test paths are demoted but never dropped", () => {
  const source = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "src/a.ts", text: "call(rare);" }),
    CORPUS,
  );
  const spec = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "tests/a.test.ts", text: "call(rare);" }),
    CORPUS,
  );
  const generated = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "dist/a.js", text: "call(rare);" }),
    CORPUS,
  );
  assert.ok(source.score > spec.score, "a source hit outranks a test hit");
  assert.ok(spec.score > generated.score, "a test hit outranks a build artefact");
});

test("a rare term outweighs a term that is in every file", () => {
  const corpus = {
    documentCount: 10,
    documentFrequencies: new Map([
      ["rare", 1],
      ["common", 10],
    ]),
    queryTerms: ["rare", "common"],
  };
  const rare = scoreWorkspaceSearchCandidateV1(
    candidate({ path: "src/a.ts", text: "call(rare);", matchedTerms: ["rare"], phrase: false }),
    corpus,
  );
  const common = scoreWorkspaceSearchCandidateV1(
    candidate({
      path: "src/a.ts",
      text: "call(common);",
      needle: "common",
      matchedTerms: ["common"],
      phrase: false,
    }),
    corpus,
  );
  assert.ok(rare.score > common.score, `${rare.score} vs ${common.score}`);
});

test("ranking is a total order, so the same query always returns the same page", () => {
  const corpus = { documentCount: 4, documentFrequencies: new Map([["rare", 2]]), queryTerms: ["rare"] };
  const candidates = [
    candidate({ path: "src/b.ts", text: "call(rare);", line: 9 }),
    candidate({ path: "src/a.ts", text: "call(rare);", line: 4 }),
    candidate({ path: "src/a.ts", text: "call(rare);", line: 2 }),
    candidate({ path: "src/a.ts", text: "call(rare, rare);", line: 2, column: 12 }),
  ];
  const once = rankWorkspaceSearchCandidatesV1(candidates, corpus);
  const again = rankWorkspaceSearchCandidatesV1([...candidates].reverse(), corpus);
  assert.deepEqual(
    once.map((hit) => `${hit.path}:${hit.line}:${hit.column}`),
    again.map((hit) => `${hit.path}:${hit.line}:${hit.column}`),
  );
});

test("query terms drop punctuation and single characters", () => {
  assert.deepEqual(workspaceQueryTermsV1("resolveTicket(id)", false), ["resolveticket", "id"]);
  assert.deepEqual(workspaceQueryTermsV1("a + b", false), []);
  assert.deepEqual(workspaceQueryTermsV1("Foo Bar", true), ["Foo", "Bar"]);
});
