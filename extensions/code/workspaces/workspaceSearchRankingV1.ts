import { inverseDocumentFrequencyV1 } from "../../../src/tools/lexicalRanking";

/**
 * Ranking for `code_workspace_search`.
 *
 * The scan it replaced returned matches in directory-walk order and stopped
 * the instant it had `limit` of them, so on any workspace with more than a
 * couple of hundred hits the agent saw whichever files the tree walk reached
 * first and never learned the rest existed. Asking where a symbol is *defined*
 * reliably returned the places it is used, because a call site in
 * `build/bundle.js` sorts before the declaration in `src/`.
 *
 * Every match is now scored and the limit selects the best ones rather than
 * the earliest. Four signals, in the order they matter for code:
 *
 * 1. **Shape.** A line that declares the matched identifier -- `class X`,
 *    `function X`, `const X =`, `def X(`, `type X =`, a method head -- is what
 *    someone searching a repository almost always wants, so it outweighs every
 *    other signal combined ({@link DEFINITION_BONUS_V1}). A match inside an
 *    `import` line is the opposite: a pointer somewhere else.
 * 2. **Rarity.** Terms are weighted by how many of the scanned files contain
 *    them (BM25 IDF, shared with the note scorer), so a match on a distinctive
 *    identifier beats a match on a word that is in every file.
 * 3. **Location.** Test, fixture, vendored, and build-output paths carry real
 *    matches but rarely the one being looked for, so they are demoted rather
 *    than dropped -- a search for a symbol that only exists in tests must still
 *    find it.
 * 4. **Precision.** A whole-identifier match beats the same needle embedded in
 *    a longer name, and a literal match on the whole query beats a line that
 *    merely covers its terms.
 *
 * Term matching is a *fallback*, never a widening: when the literal query
 * string occurs anywhere in the workspace, only literal matches are returned.
 * A multi-word query that previously found nothing at all now falls back to
 * lines covering the most query terms.
 *
 * Pure and dependency-free apart from the shared IDF helper, so the weights
 * can be pinned by unit test without a workspace on disk.
 */

/** A declaration is what a repository search is usually looking for. */
export const DEFINITION_BONUS_V1 = 40;
/** The whole query matched literally, not just its terms. */
export const PHRASE_BONUS_V1 = 25;
/** Ceiling on the summed IDF contribution, so rarity cannot swamp shape. */
export const MAX_RARITY_SCORE_V1 = 30;
export const RARITY_SCALE_V1 = 6;
/** A multi-term query whose terms all land on one line. */
export const FULL_COVERAGE_BONUS_V1 = 12;
/** The needle is a whole identifier here, not a fragment of a longer one. */
export const WORD_BOUNDARY_BONUS_V1 = 8;
/** `import`/`require`/`use` lines point at a definition; they are not one. */
export const REFERENCE_PENALTY_V1 = 8;
export const COMMENT_PENALTY_V1 = 6;
export const TEST_PATH_PENALTY_V1 = 18;
export const GENERATED_PATH_PENALTY_V1 = 25;
export const DECLARATION_FILE_PENALTY_V1 = 10;
export const MAX_DEPTH_PENALTY_V1 = 6;
export const DEPTH_PENALTY_PER_SEGMENT_V1 = 1.5;
export const BASE_SCORE_V1 = 10;

/**
 * Hard ceiling on collected matches. Well above any sane `limit`, so it never
 * decides the ranking; it exists so a generated file with a million hits
 * cannot exhaust memory before the sort.
 */
export const MAX_SEARCH_CANDIDATES_V1 = 5_000;

export type WorkspaceSearchMatchKindV1 =
  | "definition"
  | "reference"
  | "comment"
  | "text";

export interface WorkspaceSearchCandidateV1 {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The full line the match sits on, before preview truncation. */
  text: string;
  /** The needle as matched: the whole query for a phrase hit, else one term. */
  needle: string;
  /** Distinct query terms present on this line (lower-cased unless exact). */
  matchedTerms: readonly string[];
  /** True when the literal whole query matched here. */
  phrase: boolean;
}

export interface WorkspaceSearchCorpusV1 {
  /** Files actually scanned, the IDF document count. */
  documentCount: number;
  /** Files containing each query term at least once. */
  documentFrequencies: ReadonlyMap<string, number>;
  /** Distinct informative terms in the query. */
  queryTerms: readonly string[];
}

export interface WorkspaceSearchScoreV1 {
  score: number;
  matchKind: WorkspaceSearchMatchKindV1;
}

const TEST_PATH_SEGMENT_V1 =
  /^(?:tests?|spec|specs|__tests__|__mocks__|mocks?|fixtures?|e2e|testdata)$/u;
const GENERATED_PATH_SEGMENT_V1 =
  /^(?:dist|build|out|output|vendor|node_modules|coverage|\.next|target|bin|obj)$/u;
const TEST_BASENAME_V1 = /\.(?:test|spec)\.[a-z0-9]+$/u;
const GENERATED_BASENAME_V1 = /\.(?:min|bundle|generated)\.[a-z0-9]+$/u;
const DECLARATION_BASENAME_V1 = /\.d\.[cm]?ts$/u;

const COMMENT_LINE_V1 = /^\s*(?:\/\/|\/\*|\*(?!\/)|#(?![0-9a-f]{3,8}\b)|--|<!--|%|;)/u;
const REFERENCE_LINE_V1 =
  /^\s*(?:import\b|export\s+(?:\*|\{)|from\s+["']|#include\b|using\b|use\s+[a-z_]|require\s*\()/u;

/** Escape a needle for embedding in a definition pattern. */
export function escapeRegExpV1(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

/**
 * Does this line declare `needle`, rather than merely mention it?
 *
 * Deliberately syntax-agnostic: the workspace holds whatever language the
 * mission is working in, and a parser per language is not on the table. These
 * are the declaration shapes shared by the C-family, Python, Rust, Go, and
 * TypeScript.
 */
export function isDefinitionLineV1(
  text: string,
  needle: string,
  caseSensitive: boolean,
): boolean {
  const escaped = escapeRegExpV1(needle);
  const flags = caseSensitive ? "u" : "iu";
  const keyword =
    "class|interface|type|enum|struct|trait|impl|record|protocol|module|namespace|package";
  const binder = "const|let|var|val|static|readonly|public|private|protected|final|def|fn|func";
  const patterns = [
    // `class Foo`, `type Foo =`, `enum Foo {`
    new RegExp(`\\b(?:${keyword})\\s+${escaped}\\b`, flags),
    // `function foo(`, `async function foo(`, `def foo(`, `fn foo(`
    new RegExp(`\\b(?:async\\s+)?(?:${binder}|function)\\s+${escaped}\\s*[(<:=]`, flags),
    // `const foo =`, `let foo:`, `readonly foo =`
    new RegExp(`\\b(?:${binder})\\s+${escaped}\\s*[:=]`, flags),
    // `foo = function`, `foo = (a) =>`, `foo: (a) =>`
    new RegExp(`\\b${escaped}\\s*[:=]\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[a-z_$][\\w$]*\\s*=>)`, flags),
    // A method head at the start of a line: `  foo(a, b) {`
    new RegExp(`^\\s*(?:(?:${binder}|export|async|override)\\s+)*${escaped}\\s*\\([^)]*\\)\\s*(?::[^{;]+)?\\{`, flags),
    // Go/Rust receiver methods and Python decorated defs land on the shapes above.
  ];
  return patterns.some((pattern) => pattern.test(text));
}

/** Is the needle a whole identifier here, not a fragment of a longer name? */
export function isWholeIdentifierMatchV1(
  text: string,
  column: number,
  needle: string,
): boolean {
  const start = column - 1;
  const before = start > 0 ? text[start - 1]! : "";
  const after = text[start + needle.length] ?? "";
  const isWordChar = (character: string) => /[\w$]/u.test(character);
  const startsWithWord = /[\w$]/u.test(needle[0] ?? "");
  const endsWithWord = /[\w$]/u.test(needle.at(-1) ?? "");
  return (
    (!startsWithWord || before === "" || !isWordChar(before)) &&
    (!endsWithWord || after === "" || !isWordChar(after))
  );
}

function pathPenaltyV1(filePath: string): number {
  const segments = filePath.split("/");
  const basename = (segments.at(-1) ?? "").toLowerCase();
  const directories = segments.slice(0, -1).map((segment) => segment.toLowerCase());
  let penalty = 0;
  if (directories.some((segment) => GENERATED_PATH_SEGMENT_V1.test(segment)) ||
    GENERATED_BASENAME_V1.test(basename)) {
    penalty += GENERATED_PATH_PENALTY_V1;
  } else if (
    directories.some((segment) => TEST_PATH_SEGMENT_V1.test(segment)) ||
    TEST_BASENAME_V1.test(basename)
  ) {
    penalty += TEST_PATH_PENALTY_V1;
  }
  if (DECLARATION_BASENAME_V1.test(basename)) penalty += DECLARATION_FILE_PENALTY_V1;
  penalty += Math.min(
    MAX_DEPTH_PENALTY_V1,
    DEPTH_PENALTY_PER_SEGMENT_V1 * Math.max(0, directories.length - 1),
  );
  return penalty;
}

/**
 * Score one match. The returned `matchKind` is the same judgement the score
 * uses, surfaced so the agent reading the results can tell a declaration from
 * a mention without re-deriving it.
 */
export function scoreWorkspaceSearchCandidateV1(
  candidate: WorkspaceSearchCandidateV1,
  corpus: WorkspaceSearchCorpusV1,
  options: { caseSensitive?: boolean } = {},
): WorkspaceSearchScoreV1 {
  const caseSensitive = options.caseSensitive === true;
  const definition = isDefinitionLineV1(candidate.text, candidate.needle, caseSensitive);
  const comment = COMMENT_LINE_V1.test(candidate.text);
  const reference = !definition && REFERENCE_LINE_V1.test(candidate.text);
  const matchKind: WorkspaceSearchMatchKindV1 = definition
    ? "definition"
    : reference
      ? "reference"
      : comment
        ? "comment"
        : "text";

  let score = BASE_SCORE_V1;
  if (candidate.phrase) score += PHRASE_BONUS_V1;
  if (definition) score += DEFINITION_BONUS_V1;

  let rarity = 0;
  for (const term of candidate.matchedTerms) {
    rarity += inverseDocumentFrequencyV1(
      {
        documentCount: corpus.documentCount,
        averageLength: 0,
        documentFrequencies: corpus.documentFrequencies,
      },
      term,
    );
  }
  score += Math.min(MAX_RARITY_SCORE_V1, rarity * RARITY_SCALE_V1);

  if (
    corpus.queryTerms.length > 1 &&
    candidate.matchedTerms.length >= corpus.queryTerms.length
  ) {
    score += FULL_COVERAGE_BONUS_V1;
  }
  if (isWholeIdentifierMatchV1(candidate.text, candidate.column, candidate.needle)) {
    score += WORD_BOUNDARY_BONUS_V1;
  }
  if (reference) score -= REFERENCE_PENALTY_V1;
  if (comment && !definition) score -= COMMENT_PENALTY_V1;
  score -= pathPenaltyV1(candidate.path);

  return { score: Math.round(score * 100) / 100, matchKind };
}

/**
 * Order candidates best-first. Ties break on path, then line, then column, so
 * the same workspace and query always produce the same list -- a search whose
 * order wobbles between runs is unusable as a citation.
 */
export function rankWorkspaceSearchCandidatesV1(
  candidates: readonly WorkspaceSearchCandidateV1[],
  corpus: WorkspaceSearchCorpusV1,
  options: { caseSensitive?: boolean } = {},
): (WorkspaceSearchCandidateV1 & WorkspaceSearchScoreV1)[] {
  return candidates
    .map((candidate) => ({
      ...candidate,
      ...scoreWorkspaceSearchCandidateV1(candidate, corpus, options),
    }))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (left.path !== right.path) return left.path < right.path ? -1 : 1;
      if (left.line !== right.line) return left.line - right.line;
      return left.column - right.column;
    });
}

const QUERY_TERM_RE_V1 = /[A-Za-z0-9][A-Za-z0-9_$-]+/gu;

/**
 * Informative terms of a query. Short and purely punctuation fragments are
 * dropped: they match everywhere and rank nothing.
 */
export function workspaceQueryTermsV1(query: string, caseSensitive: boolean): string[] {
  const source = caseSensitive ? query : query.toLowerCase();
  const seen = new Set<string>();
  for (const match of source.matchAll(QUERY_TERM_RE_V1)) {
    const term = match[0];
    if (term.length >= 2) seen.add(term);
  }
  return [...seen];
}
