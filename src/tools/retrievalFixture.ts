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
  {
    slug: "photosynthesis",
    // The hard case: a question whose words are all in two notes that do
    // not answer it. Only a model that reads the query and the passage
    // together can put the answer note first.
    question: 'which pigment inside a leaf captures sunlight for photosynthesis',
    adjacentTitle: 'why do leaves change colour in autumn',
    adjacentBody: 'In autumn the pigment breaks down and carotenoids show through, which is why leaves turn yellow and red. This note is about leaf colour, not about how light is captured.',
    term: "chlorophyll",
    field: "biology",
    // A second sentence in the answer note that says the same thing without
    // the query term, so a paraphrased question has something to land on.
    gloss: "It is the green pigment that lets leaves turn sunlight into sugar.",
    paraphrases: [
      "which pigment makes leaves green and captures sunlight",
      "how do plants turn light into food",
      "what absorbs sunlight inside a leaf",
      "green molecule behind plant energy production",
    ],
  },
  {
    slug: "monetary-policy",
    // The hard case: a question whose words are all in two notes that do
    // not answer it. Only a model that reads the query and the passage
    // together can put the answer note first.
    question: 'what does a central bank buy when it wants to lower long-term interest rates',
    adjacentTitle: 'how does a central bank unwind its balance sheet',
    adjacentBody: 'Selling the accumulated portfolio back into the market, or letting it mature without reinvestment, gradually shrinks the balance sheet. This note is about the unwind, not about the purchases.',
    term: "quantitative easing",
    field: "economics",
    gloss: "A central bank buys long-dated bonds to push down interest rates when cutting the policy rate is no longer possible.",
    paraphrases: [
      "central bank buying government bonds to lower borrowing costs",
      "what does a central bank do when rates are already near zero",
      "bond purchases as a stimulus tool",
      "how do reserve banks expand their balance sheet to support the economy",
    ],
  },
  {
    slug: "byzantine-fault",
    // The hard case: a question whose words are all in two notes that do
    // not answer it. Only a model that reads the query and the passage
    // together can put the answer note first.
    question: 'how many replicas must agree before a value is safely committed',
    adjacentTitle: 'how a replicated log is compacted with snapshots',
    adjacentBody: 'Old entries are replaced by a snapshot of the state machine so the log does not grow without bound. This note is about compaction, not about agreement.',
    term: "consensus quorum",
    field: "distributed systems",
    gloss: "Enough honest nodes must agree before a value is committed, so a minority of lying replicas cannot fork the log.",
    paraphrases: [
      "how many nodes must agree before a distributed system commits a value",
      "tolerating replicas that lie in a replicated log",
      "why a majority of honest servers is needed to agree",
      "agreement among machines when some of them are faulty",
    ],
  },
  {
    slug: "baroque-counterpoint",
    // The hard case: a question whose words are all in two notes that do
    // not answer it. Only a model that reads the query and the passage
    // together can put the answer note first.
    question: 'what is the short opening melody of a fugue called',
    adjacentTitle: 'how equal temperament changed keyboard tuning',
    adjacentBody: 'Dividing the octave into twelve equal steps let a keyboard play in every key at the cost of pure intervals. This note is about tuning, not about melodic structure.',
    term: "fugue subject",
    field: "music theory",
    gloss: "The short opening melody that each voice imitates in turn as the piece unfolds.",
    paraphrases: [
      "the opening theme that every voice copies in a fugue",
      "melody imitated by successive voices in baroque music",
      "what is the main tune of a fugue called",
      "theme stated first and then answered by other voices",
    ],
  },
  {
    slug: "protein-folding",
    // The hard case: a question whose words are all in two notes that do
    // not answer it. Only a model that reads the query and the passage
    // together can put the answer note first.
    question: 'what is the overall three dimensional shape of a folded polypeptide called',
    adjacentTitle: 'how proteins are separated by mass in the laboratory',
    adjacentBody: 'Gel electrophoresis pulls denatured chains through a matrix so they separate by size. This note is about separation, not about folded shape.',
    term: "tertiary structure",
    field: "biochemistry",
    gloss: "The overall three-dimensional shape a single polypeptide chain settles into.",
    paraphrases: [
      "the 3D shape a protein chain folds into",
      "how a polypeptide arranges itself in space",
      "overall three dimensional form of an enzyme",
      "what determines the folded shape of a protein",
    ],
  },
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
  /** Exact-vocabulary queries; the lexical ratchet scores these. */
  queries: RetrievalFixtureQuery[];
  /**
   * Paraphrases that share no words with the answer note's term. Only an
   * embedder can answer these; the lexical path is expected to miss them,
   * so they are kept out of the lexical ratchet and scored separately by
   * `scripts/benchmark-embedders.ts`.
   */
  semanticQueries: RetrievalFixtureQuery[];
  /**
   * Question-shaped queries whose vocabulary is fully present in two notes
   * that do not answer them: one that states the question and leaves it open,
   * one about a neighbouring aspect of the same topic. A bi-encoder ranks
   * those near the top because it never sees query and passage together; a
   * cross-encoder rerank is what separates them. This set exists because the
   * paraphrase set saturates at MRR 1.00 on the shipped embedders and so can
   * no longer discriminate between ranking strategies.
   */
  hardQueries: RetrievalFixtureQuery[];
} {
  const notes: RetrievalFixtureNote[] = [];

  for (const topic of TOPICS) {
    // The answer note: states the fact plainly, near the top.
    notes.push({
      path: `Research/${topic.slug}.md`,
      content: [
        `# ${topic.slug.replace(/-/gu, " ")}`,
        "",
        `This note explains ${topic.term} in ${topic.field}. ${topic.gloss}`,
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

    // Near-miss 1: the question itself, stated and left open. Its embedding
    // sits closer to a question-shaped query than the answer note does, which
    // is exactly the failure a single-vector ranking cannot see.
    notes.push({
      path: `Distractors/${topic.slug}-open-question.md`,
      content: [
        `# ${topic.question}?`,
        "",
        `Someone asked: ${topic.question}? The answer is not recorded in this note; it is filed here as an open question for later.`,
        filler(`${topic.slug}-open`, 4),
      ].join("\n"),
      mtime: 3_500,
    });

    // Near-miss 2: same topic, same vocabulary, a different aspect of it.
    notes.push({
      path: `Research/${topic.slug}-adjacent.md`,
      content: [
        `# ${topic.adjacentTitle}`,
        "",
        `This note explains ${topic.field}: ${topic.adjacentBody}`,
        filler(`${topic.slug}-adjacent`, 5),
      ].join("\n"),
      mtime: 3_800,
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

  const semanticQueries: RetrievalFixtureQuery[] = TOPICS.flatMap((topic) =>
    topic.paraphrases.map((text) => ({
      text,
      relevantPaths: [`Research/${topic.slug}.md`],
      probes: "paraphrase with none of the answer's vocabulary; only an embedder can rank it",
    })),
  );

  const hardQueries: RetrievalFixtureQuery[] = TOPICS.flatMap((topic) => [
    {
      text: `${topic.question}?`,
      relevantPaths: [`Research/${topic.slug}.md`],
      probes:
        "a note that states this exact question without answering it, and a same-topic note about a different aspect, both outrank the answer on embedding similarity alone",
    },
    {
      text: topic.question,
      relevantPaths: [`Research/${topic.slug}.md`],
      probes:
        "same question without the question mark: the open-question note still matches it almost word for word",
    },
  ]);

  return { notes, queries, semanticQueries, hardQueries };
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
