import assert from "node:assert/strict";
import test from "node:test";
import { findRelatedNotesTool, suggestNoteLinksTool } from "../src/tools/graphTools";
import { searchMarkdownFilesTool } from "../src/tools/vaultTools";
import { isVaultPathExcluded } from "../src/tools/vaultExclusions";
import type { ToolExecutionContext } from "../src/tools/types";

/*
 * Metric A.
 *
 * On old main, search_markdown_files and find_related_notes / suggest_note_links
 * filtered with isBlockedSystemPath (.agent-backups / .obsidian / trash only).
 * Agent Sources/, Agent Memory/, and Agent Runs/ therefore ranked in the top
 * 10 whenever they shared vocabulary with a real note. After this change both
 * tools call isVaultPathExcluded, so those folders must be 0 in the top 10.
 *
 * These assertions fail on old main: the same fixture yields
 * pct_excluded_folder_hits_in_keyword_top10 > 0 and
 * pct_excluded_folder_hits_in_related_top10 > 0.
 */

const SHARED =
  "The chlorophyll pigment captures sunlight for photosynthesis in green leaves.";

interface FakeNote {
  path: string;
  body: string;
}

function contextFor(notes: FakeNote[], activePath: string): ToolExecutionContext {
  const files = notes.map((note) => ({
    path: note.path,
    basename: note.path.replace(/^.*\//u, "").replace(/\.md$/u, ""),
    extension: "md",
    stat: { mtime: 1_000, size: note.body.length },
  }));
  const byPath = new Map(files.map((file) => [file.path, file]));
  const bodies = new Map(notes.map((note) => [note.path, note.body]));
  const active = byPath.get(activePath) ?? null;

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
      workspace: { getActiveFile: () => active },
    },
    runtimeCache: {},
    settings: { semanticIndexEnabled: false },
  } as unknown as ToolExecutionContext;
}

function exclusionFixture(): { notes: FakeNote[]; context: ToolExecutionContext } {
  const notes: FakeNote[] = [
    { path: "Research/chlorophyll.md", body: `# chlorophyll\n\n${SHARED}` },
    {
      path: "Agent Sources/web-cache.md",
      body: `# cached source\n\n${SHARED}\n\nCached web dump.`,
    },
    {
      path: "Agent Memory/semantic-vault-index.md",
      body: `# index dump\n\n${SHARED}\n\nDerived index text.`,
    },
    {
      path: "Agent Runs/run-search.md",
      body: `# run log\n\n${SHARED}\n\nMission transcript.`,
    },
    { path: "Journal/unrelated.md", body: "# walk\n\nOrdinary passage about weather." },
  ];
  return { notes, context: contextFor(notes, "Research/chlorophyll.md") };
}

function excludedHitRate(paths: string[]): number {
  const top = paths.slice(0, 10);
  if (top.length === 0) return 0;
  return top.filter((path) => isVaultPathExcluded(path)).length / top.length;
}

test("Metric A: keyword and related top-10 exclude Agent Sources and sibling cache folders", async () => {
  const { context } = exclusionFixture();
  const query = "chlorophyll pigment captures sunlight";

  const keyword = (await searchMarkdownFilesTool.execute(
    { query, limit: 10 },
    context,
  )) as { results: Array<{ path: string }> };
  const keywordPaths = keyword.results.map((item) => item.path);
  const pctExcludedKeyword = excludedHitRate(keywordPaths);

  const related = (await findRelatedNotesTool.execute(
    { path: "Research/chlorophyll.md", query, limit: 10 },
    context,
  )) as { results: Array<{ path: string }> };
  const relatedPaths = related.results.map((item) => item.path);
  const pctExcludedRelated = excludedHitRate(relatedPaths);

  const suggestions = (await suggestNoteLinksTool.execute(
    { path: "Research/chlorophyll.md", limit: 10 },
    context,
  )) as { suggestions: Array<{ targetPath: string }> };

  assert.ok(
    keywordPaths.includes("Research/chlorophyll.md"),
    `expected the real note in keyword results, got ${JSON.stringify(keywordPaths)}`,
  );
  assert.equal(
    pctExcludedKeyword,
    0,
    `pct_excluded_folder_hits_in_keyword_top10 must be 0, got ${pctExcludedKeyword} from ${JSON.stringify(keywordPaths)}`,
  );
  assert.equal(
    pctExcludedRelated,
    0,
    `pct_excluded_folder_hits_in_related_top10 must be 0, got ${pctExcludedRelated} from ${JSON.stringify(relatedPaths)}`,
  );
  assert.ok(
    suggestions.suggestions.every((item) => !isVaultPathExcluded(item.targetPath)),
    `suggest_note_links leaked an excluded path: ${JSON.stringify(suggestions.suggestions)}`,
  );
});
