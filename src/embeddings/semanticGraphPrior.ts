/**
 * The only fields the prior reads. Declared structurally so both the V1
 * (inline-vector) and V2 (sharded) note shapes satisfy it without the prior
 * needing to know which index version it is looking at.
 */
export interface GraphPriorNote {
  path: string;
  title: string;
  links: string[];
}

/**
 * A small graph prior for semantic search, computed from the wikilinks the
 * semantic index already stores per note.
 *
 * The index has carried `links` since it was written, at zero scoring weight,
 * while the graph tools read real backlinks from Obsidian's metadata cache —
 * so the two retrieval tiers never composed. In a vault, "notes near the one
 * I am working in" is a strong relevance signal that pure embedding similarity
 * cannot express, because proximity is a property of the author's structure
 * rather than of the text.
 *
 * The prior is deliberately tiny (5% of the final score). It is a tie-breaker
 * among comparably relevant notes, not a way for a densely-linked hub to
 * outrank a genuinely better match.
 *
 * Pure and Obsidian-free so it is testable without a vault.
 */

/** Score for a note directly linked to (or from) a seed. */
const ONE_HOP_SCORE = 1;
/** Score for a note two links away. */
const TWO_HOP_SCORE = 0.45;

export type SemanticGraphPrior = ReadonlyMap<string, number>;

/**
 * Build a path → proximity map for notes within two hops of `seedPaths`.
 *
 * Links are treated as undirected: a note the seed links to and a note that
 * links to the seed are equally "near" from a reader's point of view, and
 * making backlinks count is most of the value here.
 *
 * Returns an empty map when there are no seeds, which is what keeps scoring
 * byte-identical for every caller that does not opt in.
 */
export function buildSemanticGraphPrior(
  notes: readonly GraphPriorNote[],
  seedPaths: readonly string[],
): SemanticGraphPrior {
  const prior = new Map<string, number>();
  const seeds = seedPaths.map((path) => path.trim()).filter(Boolean);
  if (seeds.length === 0 || notes.length === 0) return prior;

  const adjacency = buildUndirectedAdjacency(notes);
  const seedSet = new Set(seeds);

  const oneHop = new Set<string>();
  for (const seed of seedSet) {
    for (const neighbour of adjacency.get(seed) ?? []) {
      if (!seedSet.has(neighbour)) oneHop.add(neighbour);
    }
  }
  for (const path of oneHop) prior.set(path, ONE_HOP_SCORE);

  for (const path of oneHop) {
    for (const neighbour of adjacency.get(path) ?? []) {
      if (seedSet.has(neighbour) || prior.has(neighbour)) continue;
      prior.set(neighbour, TWO_HOP_SCORE);
    }
  }

  // The seed itself is not "related to" itself; leaving it out avoids trivially
  // ranking the note the user is already reading above everything else.
  for (const seed of seedSet) prior.delete(seed);
  return prior;
}

/**
 * Resolve each note's wikilink targets to indexed paths, then symmetrize.
 *
 * Wikilinks name a note, not a path (`[[Alpha]]`, `[[folder/Alpha]]`), so a
 * target is matched against full path, path-without-extension, basename, and
 * title. Ambiguous basenames resolve to every match: over-linking a rare
 * duplicate name is harmless at a 5% weight, whereas dropping the link loses
 * the signal entirely.
 */
function buildUndirectedAdjacency(
  notes: readonly GraphPriorNote[],
): Map<string, Set<string>> {
  const byKey = new Map<string, string[]>();
  const addKey = (key: string, path: string): void => {
    const normalized = key.trim().toLowerCase();
    if (!normalized) return;
    const existing = byKey.get(normalized);
    if (existing) {
      if (!existing.includes(path)) existing.push(path);
      return;
    }
    byKey.set(normalized, [path]);
  };

  for (const note of notes) {
    addKey(note.path, note.path);
    addKey(note.path.replace(/\.md$/iu, ""), note.path);
    const basename = note.path.split("/").pop() ?? note.path;
    addKey(basename, note.path);
    addKey(basename.replace(/\.md$/iu, ""), note.path);
    if (note.title) addKey(note.title, note.path);
  }

  const adjacency = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    if (from === to) return;
    const existing = adjacency.get(from);
    if (existing) existing.add(to);
    else adjacency.set(from, new Set([to]));
  };

  for (const note of notes) {
    for (const target of note.links ?? []) {
      for (const resolved of byKey.get(target.trim().toLowerCase()) ?? []) {
        // Undirected: this is what makes backlinks count.
        link(note.path, resolved);
        link(resolved, note.path);
      }
    }
  }
  return adjacency;
}
