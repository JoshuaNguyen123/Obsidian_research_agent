import assert from "node:assert/strict";
import test from "node:test";
import {
  buildSemanticGraphPrior,
  type GraphPriorNote,
} from "../src/embeddings/semanticGraphPrior";

function note(path: string, links: string[] = [], title?: string): GraphPriorNote {
  return {
    path,
    title: title ?? (path.split("/").pop() ?? path).replace(/\.md$/u, ""),
    links,
  };
}

const VAULT: GraphPriorNote[] = [
  note("Notes/Seed.md", ["Alpha", "Beta"]),
  note("Notes/Alpha.md", ["Gamma"]),
  note("Notes/Beta.md"),
  note("Notes/Gamma.md"),
  note("Notes/Unrelated.md"),
  note("Notes/Inbound.md", ["Seed"]),
];

test("no seeds yields an empty prior, which keeps scoring unchanged", () => {
  // This is the guarantee that makes the graph tier strictly opt-in.
  assert.equal(buildSemanticGraphPrior(VAULT, []).size, 0);
  assert.equal(buildSemanticGraphPrior(VAULT, ["", "  "]).size, 0);
  assert.equal(buildSemanticGraphPrior([], ["Notes/Seed.md"]).size, 0);
});

test("outbound links are one hop and their neighbours are two hops", () => {
  const prior = buildSemanticGraphPrior(VAULT, ["Notes/Seed.md"]);
  assert.equal(prior.get("Notes/Alpha.md"), 1);
  assert.equal(prior.get("Notes/Beta.md"), 1);
  assert.equal(prior.get("Notes/Gamma.md"), 0.45);
  assert.equal(prior.get("Notes/Unrelated.md"), undefined);
});

test("backlinks count as one hop, which is most of the point", () => {
  // Inbound.md links TO the seed and is never linked FROM it. Treating links
  // as directed would miss it, and backlink awareness is the signal the
  // semantic tier was missing.
  const prior = buildSemanticGraphPrior(VAULT, ["Notes/Seed.md"]);
  assert.equal(prior.get("Notes/Inbound.md"), 1);
});

test("the seed itself never appears in its own prior", () => {
  const prior = buildSemanticGraphPrior(VAULT, ["Notes/Seed.md"]);
  assert.equal(prior.has("Notes/Seed.md"), false);
});

test("wikilink targets resolve by basename, path, and title", () => {
  const vault: GraphPriorNote[] = [
    note("Seed.md", ["folder/Target", "Renamed", "Other.md"]),
    note("folder/Target.md"),
    note("Notes/Actual.md", [], "Renamed"),
    note("Other.md"),
  ];
  const prior = buildSemanticGraphPrior(vault, ["Seed.md"]);
  assert.equal(prior.get("folder/Target.md"), 1);
  assert.equal(prior.get("Notes/Actual.md"), 1);
  assert.equal(prior.get("Other.md"), 1);
});

test("an unresolved wikilink is ignored rather than throwing", () => {
  const vault: GraphPriorNote[] = [note("Seed.md", ["Nonexistent"]), note("Other.md")];
  const prior = buildSemanticGraphPrior(vault, ["Seed.md"]);
  assert.equal(prior.size, 0);
});

test("a link cycle terminates instead of looping", () => {
  const vault: GraphPriorNote[] = [
    note("A.md", ["B"]),
    note("B.md", ["C"]),
    note("C.md", ["A"]),
  ];
  const prior = buildSemanticGraphPrior(vault, ["A.md"]);
  // B and C are each one hop from A (C via the backlink C→A).
  assert.equal(prior.get("B.md"), 1);
  assert.equal(prior.get("C.md"), 1);
  assert.equal(prior.has("A.md"), false);
});

test("multiple seeds union their neighbourhoods and exclude each other", () => {
  const prior = buildSemanticGraphPrior(VAULT, ["Notes/Seed.md", "Notes/Alpha.md"]);
  assert.equal(prior.has("Notes/Seed.md"), false);
  assert.equal(prior.has("Notes/Alpha.md"), false);
  // Gamma is one hop from Alpha, so it is promoted above its two-hop value.
  assert.equal(prior.get("Notes/Gamma.md"), 1);
  assert.equal(prior.get("Notes/Beta.md"), 1);
});

test("notes with no links produce an empty prior without throwing", () => {
  const vault: GraphPriorNote[] = [note("A.md"), note("B.md")];
  assert.equal(buildSemanticGraphPrior(vault, ["A.md"]).size, 0);
});
