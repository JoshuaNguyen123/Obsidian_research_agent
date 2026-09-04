import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  PREFETCH_RETRIEVAL_LIMIT_V1,
  PREFETCH_RETRIEVAL_SNIPPET_CHARS_V1,
  buildSemanticVaultPrefetchArgsV1,
  semanticVaultPrefetchIsUsableV1,
} from "../src/agent/vaultPrefetchRetrieval";

/*
 * The prefetched-vault-answer route answers from the vault in one turn, with
 * context the host reads for it. That context was twelve markdown files chosen
 * by folder scope and truncated at 1200 characters each — a selection with no
 * relationship to the question, while the vault index that ranks chunks
 * against exactly that question sat unused. These tests pin the retrieval pass
 * and, more importantly, the conditions under which it must stand aside.
 */

test("the retrieval pass asks for a deep, ranked shortlist", () => {
  const args = buildSemanticVaultPrefetchArgsV1("  What did I conclude about sharding?  ");
  assert.equal(args.query, "What did I conclude about sharding?");
  assert.equal(args.limit, PREFETCH_RETRIEVAL_LIMIT_V1);
  assert.equal(args.maxSnippetChars, PREFETCH_RETRIEVAL_SNIPPET_CHARS_V1);
  // Stated, not inferred: this is a question being answered from the vault,
  // which is what the deep shortlist and the rerank stage are for.
  assert.equal(args.mode, "deep");
  // Fewer spans than the scan's twelve files, and every one of them chosen by
  // the question.
  assert.ok(PREFETCH_RETRIEVAL_LIMIT_V1 < 12);
  assert.ok(
    PREFETCH_RETRIEVAL_LIMIT_V1 * PREFETCH_RETRIEVAL_SNIPPET_CHARS_V1 < 12 * 1200,
    "the retrieved context must not be larger than the scan it replaces",
  );
});

test("a usable result needs substance, not just shape", () => {
  assert.equal(
    semanticVaultPrefetchIsUsableV1({
      results: [{ path: "Notes/sharding.md", snippet: "The conclusion was..." }],
    }),
    true,
  );
  // An empty-snippet payload is a successful call and a useless context.
  // Handing it to the model in place of the scan is a regression wearing the
  // costume of a feature.
  assert.equal(
    semanticVaultPrefetchIsUsableV1({ results: [{ path: "Notes/a.md", snippet: "   " }] }),
    false,
  );
  assert.equal(semanticVaultPrefetchIsUsableV1({ results: [] }), false);
  assert.equal(
    semanticVaultPrefetchIsUsableV1({ results: [{ path: "Notes/a.md" }] }),
    false,
  );
  // One good hit among unusable ones is still worth answering from.
  assert.equal(
    semanticVaultPrefetchIsUsableV1({
      results: [{ path: "" }, { path: "Notes/b.md", snippet: "real text" }],
    }),
    true,
  );
});

test("anything unrecognised falls back rather than answering from nothing", () => {
  for (const payload of [
    null,
    undefined,
    "",
    42,
    {},
    { results: null },
    { results: "not an array" },
    { hits: [{ path: "Notes/a.md", snippet: "text" }] },
    { results: [null, undefined, 7] },
  ]) {
    assert.equal(
      semanticVaultPrefetchIsUsableV1(payload),
      false,
      `${JSON.stringify(payload)} must degrade to the folder scan`,
    );
  }
});

test("the route keeps the folder scan for vaults without a usable index", () => {
  // A vault with the index disabled must answer exactly as it does today, so
  // the fallback has to remain reachable in the runner, not just in this
  // module's contract.
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const runner = readFileSync(path.join(root, "src", "AgentRunner.ts"), "utf8");
  const route = runner.slice(
    runner.indexOf('if (runPlan.route === "prefetched_vault_answer") {'),
  );
  const body = route.slice(0, route.indexOf("Prefetched vault context:"));
  assert.ok(
    body.includes('name: "inspect_vault_context"'),
    "the folder scan must still be reachable on this route",
  );
  assert.ok(
    body.includes("semanticIndexEnabled === true"),
    "the retrieval pass must be gated on the index being enabled",
  );
  assert.ok(
    body.includes("semanticVaultPrefetchIsUsableV1"),
    "an unusable retrieval must fall through to the scan",
  );
});
