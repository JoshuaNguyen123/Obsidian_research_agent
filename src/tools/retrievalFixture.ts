import type { ToolExecutionContext } from "./types";

/**
 * A fixture vault and graded query set for measuring retrieval quality.
 *
 * The existing chunking evaluation in `.cache/semantic-eval/` cannot serve this
 * purpose. It scores R@3 = 1.000 and R@5 = 1.000 for every configuration on a
 * ten-note corpus, its live-vault half reports zero usable notes, and it varies
 * only the chunking parameters -- never the retrieval strategy. A change to
 * ranking would move none of its numbers. It is also under `.cache/`, which is
 * gitignored, so it cannot gate anything in CI.
 *
 * This corpus is built to *discriminate*, which means deliberately including
 * the cases the current implementation gets wrong:
 *
 * - a note whose only match sits past the 360-character snippet boundary, which
 *   the indexed lexical half cannot see at all (`MAX_INDEX_SNIPPET_CHARS`);
 * - distractor notes that repeat query vocabulary without answering anything,
 *   so term-frequency alone ranks badly;
 * - more notes than `MAX_LISTED_FILES`, so any silent cap is exercised;
 * - near-duplicate titles, so title matching cannot carry the score alone.
 *
 * Generated rather than checked in as files: deterministic, reviewable as
 * intent, and free to scale past the caps without adding hundreds of fixtures.
 */

export interface RetrievalFixtureNote {
  path: string;
  content: string;
  mtime: number;
}

export interface RetrievalFixtureQuery {
  /** What a user would actually type. */
  text: string;
  /** Paths that genuinely answer it, best first. */
  relevantPaths: string[];
  /** What this query exists to discriminate. */
  probes: string;
}

const TOPICS = [
  { slug: "photosynthesis", term: "chlorophyll", field: "biology" },
  { slug: "monetary-policy", term: "quantitative easing", field: "economics" },
  { slug: "byzantine-fault", term: "consensus quorum", field: "distributed systems" },
  { slug: "baroque-counterpoint", term: "fugue subject", field: "music theory" },
  { slug: "protein-folding", term: "tertiary structure", field: "biochemistry" },
] as const;

/** Filler that shares no vocabulary with any query, so it cannot accidentally rank. */
function filler(seed: string, sentences: number): string {
  const words = [
    "ordinary", "passage", "written", "without", "notable", "vocabulary",
    "kept", "deliberately", "neutral", "so", "ranking", "cannot", "borrow",
    "signal", "from", "padding", "alone",
  ];
  const out: string[] = [];
  for (let index = 0; index < sentences; index += 1) {
    const rotated = words
      .map((word, position) => words[(position + index + seed.length) % words.length])
      .join(" ");
    out.push(`${rotated}.`);
  }
  return out.join(" ");
}

export function buildRetrievalFixture(): {
  notes: RetrievalFixtureNote[];
  queries: RetrievalFixtureQuery[];
} {
  const notes: RetrievalFixtureNote[] = [];

  for (const topic of TOPICS) {
    // The answer note: states the fact plainly, near the top.
    notes.push({
      path: `Research/${topic.slug}.md`,
      content: [
        `# ${topic.slug.replace(/-/gu, " ")}`,
        "",
        `This note explains ${topic.term} in ${topic.field}.`,
        filler(topic.slug, 6),
      ].join("\n"),
      mtime: 5_000,
    });

    // The buried-answer note: the match sits well past the 360-character
    // snippet boundary, so a scorer reading only a snippet cannot see it.
    notes.push({
      path: `Research/${topic.slug}-appendix.md`,
      content: [
        `# ${topic.slug.replace(/-/gu, " ")} appendix`,
        "",
        filler(`${topic.slug}-lead`, 30),
        "",
        `The appendix records that ${topic.term} was measured again in the follow-up study.`,
      ].join("\n"),
      mtime: 4_000,
    });

    // The distractor: heavy query vocabulary, answers nothing.
    notes.push({
      path: `Distractors/${topic.slug}-keywords.md`,
      content: [
        `# assorted ${topic.field} keywords`,
        "",
        `${topic.term} ${topic.term} ${topic.term} ${topic.term} ${topic.term}`,
        "A keyword list kept for search testing. It states no fact.",
      ].join("\n"),
      mtime: 3_000,
    });
  }

  // Bulk filler past MAX_LISTED_FILES so any silent cap is exercised.
  for (let index = 0; index < 320; index += 1) {
    notes.push({
      path: `Archive/entry-${String(index).padStart(4, "0")}.md`,
      content: `# archive ${index}\n\n${filler(`archive-${index}`, 4)}`,
      mtime: 1_000 + index,
    });
  }

  const queries: RetrievalFixtureQuery[] = TOPICS.flatMap((topic) => [
    {
      text: topic.term,
      relevantPaths: [
        `Research/${topic.slug}.md`,
        `Research/${topic.slug}-appendix.md`,
      ],
      probes:
        "plain term match; the distractor repeats the term most often, so raw term frequency ranks wrongly",
    },
    {
      text: `${topic.term} follow-up study`,
      relevantPaths: [`Research/${topic.slug}-appendix.md`],
      probes:
        "the only answer sits past the 360-character snippet boundary; snippet-only scoring cannot see it",
    },
  ]);

  return { notes, queries };
}

/** Minimal execution context over a fixture corpus. Read paths only. */
export function fixtureContext(
  notes: RetrievalFixtureNote[],
): ToolExecutionContext {
  const files = notes.map((note) => ({
    path: note.path,
    basename: note.path.replace(/^.*\//u, "").replace(/\.md$/u, ""),
    extension: "md",
    stat: { mtime: note.mtime, size: note.content.length },
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const bodies = new Map(notes.map((note) => [note.path, note.content]));

  return {
    app: {
      vault: {
        getFiles: () => files,
        getFileByPath: (path: string) => byPath.get(path) ?? null,
        cachedRead: async (file: { path: string }) => bodies.get(file.path) ?? "",
        read: async (file: { path: string }) => bodies.get(file.path) ?? "",
      },
      metadataCache: {
        getFileCache: () => null,
        resolvedLinks: {},
        unresolvedLinks: {},
      },
      workspace: { getActiveFile: () => null },
    },
    runtimeCache: {},
  } as unknown as ToolExecutionContext;
}

export interface RetrievalScore {
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  meanReciprocalRank: number;
  queriesScored: number;
}

/**
 * Recall@k over the graded set, plus MRR. Recall counts a query as hit at k
 * when *any* relevant path appears in the top k; MRR uses the best rank found.
 */
export function scoreRetrieval(
  ranked: Array<{ query: RetrievalFixtureQuery; paths: string[] }>,
): RetrievalScore {
  let at1 = 0;
  let at3 = 0;
  let at5 = 0;
  let reciprocalSum = 0;

  for (const { query, paths } of ranked) {
    let bestRank: number | null = null;
    for (const relevant of query.relevantPaths) {
      const rank = paths.indexOf(relevant);
      if (rank >= 0 && (bestRank === null || rank < bestRank)) bestRank = rank;
    }
    if (bestRank === null) continue;
    if (bestRank < 1) at1 += 1;
    if (bestRank < 3) at3 += 1;
    if (bestRank < 5) at5 += 1;
    reciprocalSum += 1 / (bestRank + 1);
  }

  const total = ranked.length || 1;
  return {
    recallAt1: at1 / total,
    recallAt3: at3 / total,
    recallAt5: at5 / total,
    meanReciprocalRank: reciprocalSum / total,
    queriesScored: ranked.length,
  };
}
