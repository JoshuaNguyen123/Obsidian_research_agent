import type { TFile } from "obsidian";

/**
 * Run-note status frontmatter.
 *
 * `Agent Runs/<runId>.md` carries its runtime status as a frontmatter
 * property written in the SAME rewrite as the Runtime Snapshot fence, so the
 * property can never disagree with the fence it summarizes. Plugin load reads
 * the property through Obsidian's metadata cache and skips terminal notes
 * without reading them: with the default retention of 200 terminal runs, the
 * immediate-phase scan used to read and JSON-parse every one of them on every
 * launch before the view could render. A note without the property (written
 * before this field existed, or not yet indexed) simply falls back to being
 * read, and a stale cache entry can only cost one extra read, never a wrong
 * skip: a run never returns from `complete` to a resumable status.
 */
export const RUN_NOTE_STATUS_FRONTMATTER_KEY = "agentic_run_status";

/** The runtime status vocabulary; `runStore.ts` derives its type from this tuple. */
export const MISSION_RUNTIME_STATUSES = [
  "running",
  "paused",
  "blocked",
  "complete",
  "stopped",
  "failed",
] as const;

export type MissionRuntimeStatus = (typeof MISSION_RUNTIME_STATUSES)[number];

const STATUS_SET: ReadonlySet<string> = new Set(MISSION_RUNTIME_STATUSES);
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

export function isMissionRuntimeStatus(
  value: unknown,
): value is MissionRuntimeStatus {
  return typeof value === "string" && STATUS_SET.has(value);
}

/**
 * The one answer to "can this run still be resumed?", read by the snapshot
 * writer (frontmatter), the load-path skip (metadata cache), and the
 * hydration consumer (parsed snapshot). Keep it a single predicate.
 */
export function isIncompleteRuntimeStatus(status: MissionRuntimeStatus): boolean {
  return status !== "complete";
}

/**
 * Insert or update the status property at the top of a run note, preserving
 * any other frontmatter keys and every byte after the closing fence.
 */
export function applyRunNoteStatusFrontmatter(
  markdown: string,
  status: MissionRuntimeStatus,
): string {
  const line = `${RUN_NOTE_STATUS_FRONTMATTER_KEY}: ${status}`;
  const match = FRONTMATTER_PATTERN.exec(markdown);
  if (!match) {
    return `---\n${line}\n---\n${markdown}`;
  }
  const lines = match[1].split(/\r?\n/);
  const index = lines.findIndex((entry) =>
    entry.startsWith(`${RUN_NOTE_STATUS_FRONTMATTER_KEY}:`),
  );
  if (index >= 0) {
    if (lines[index] === line) {
      return markdown;
    }
    lines[index] = line;
  } else {
    lines.push(line);
  }
  return `---\n${lines.join("\n")}\n---\n${markdown.slice(match[0].length)}`;
}

/** Read the status property from a parsed frontmatter object (metadata cache shape). */
export function readRunNoteStatusFromFrontmatter(
  frontmatter: unknown,
): MissionRuntimeStatus | null {
  if (!frontmatter || typeof frontmatter !== "object") {
    return null;
  }
  const value = (frontmatter as Record<string, unknown>)[
    RUN_NOTE_STATUS_FRONTMATTER_KEY
  ];
  return isMissionRuntimeStatus(value) ? value : null;
}

interface MetadataCacheLike {
  getFileCache?: (file: TFile) => { frontmatter?: unknown } | null | undefined;
}

/**
 * Status of a run note as Obsidian's metadata cache last indexed it, or null
 * when the host has no cache, the note is unindexed, or the property is
 * absent. Callers treat null as "read the note".
 */
export function readRunNoteStatusFromMetadataCache(
  app: unknown,
  file: TFile,
): MissionRuntimeStatus | null {
  const cache = (app as { metadataCache?: MetadataCacheLike } | null | undefined)
    ?.metadataCache;
  if (!cache || typeof cache.getFileCache !== "function") {
    return null;
  }
  try {
    return readRunNoteStatusFromFrontmatter(cache.getFileCache(file)?.frontmatter);
  } catch {
    return null;
  }
}
