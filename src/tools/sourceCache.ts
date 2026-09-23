import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "./types";
import { sha256Fingerprint } from "../agent/actions";
import { normalizeVaultPath, truncateText } from "./validation";
import { isSourceCachePath } from "./vaultExclusions";

export const SOURCE_CACHE_FOLDER = "Agent Sources";
export const SOURCE_CACHE_MANIFEST_PATH = `${SOURCE_CACHE_FOLDER}/source-cache-manifest.json`;
export const SOURCE_CACHE_SECTION_CHARS = 6000;
export const SOURCE_CACHE_MAX_CHARS = 60000;
export const SOURCE_CACHE_FRESH_MS = 24 * 60 * 60 * 1000;
export const SOURCE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export type SourceParserStatus =
  | "parsed"
  | "empty"
  | "missing_content"
  | "legacy_unknown";

export interface CachedSource {
  vaultPath: string;
  url: string;
  normalizedUrl: string;
  urlHash: string;
  title: string;
  fetchedAt: string;
  sourceChars: number;
  totalChars: number;
  contentHash: string;
  truncated: boolean;
  parserStatus: SourceParserStatus;
  sectionCount: number;
  /**
   * Root mission that last transported this source. Absent on notes written
   * before the field existed, which read as "belongs to no current mission"
   * and so never satisfy a refresh.
   */
  fetchedForMission?: string;
}

export interface SourceCacheReadOptions {
  maxAgeMs?: number;
  refresh?: boolean;
  /**
   * Root mission asking. A refresh means "do not serve me a copy from an
   * earlier mission", so a copy this mission transported itself still
   * satisfies it; without an identity the refresh stays unconditional.
   */
  missionId?: string;
}

export interface CachedSourceSection extends CachedSource {
  section: number;
  sourceStartChar: number;
  content: string;
}

export interface SourceCacheManifest {
  version: 1;
  updatedAt: string;
  entries: CachedSource[];
}

const manifestWriteQueues = new WeakMap<object, Promise<void>>();
const sourceWriteQueues = new WeakMap<object, Map<string, Promise<void>>>();
const sourceSectionReadCaches = new WeakMap<
  object,
  Map<
    string,
    {
      stamp: string;
      parsed: CachedSource;
      sourceContent: string;
    }
  >
>();
const SOURCE_SECTION_READ_CACHE_ENTRIES = 32;

/**
 * The mission a tool call belongs to, for cache scoping.
 *
 * `rootMissionId` and not `runId`: a resumed segment gets a fresh runId, and
 * the research worker suffixes runId per participant, so keying on it would
 * re-transport every source at each segment boundary and once per worker.
 * Evidence belongs to the mission that is gathering it, and this is the same
 * span the mission ledger's provider usage telescopes over. (A prepared
 * action deliberately keys the other way, on the segment that will execute
 * it -- that is a different question with a different answer.)
 */
export function resolveSourceCacheMissionId(
  ctx: ToolExecutionContext,
): string | undefined {
  return ctx.rootMissionId?.trim() || ctx.runId?.trim() || undefined;
}

export async function writeSourceCacheNote(
  ctx: ToolExecutionContext,
  source: {
    url: string;
    title: string;
    content: string;
    parserStatus?: Exclude<SourceParserStatus, "legacy_unknown">;
  },
): Promise<CachedSource> {
  const fetchedAt = (ctx.now?.() ?? new Date()).toISOString();
  const normalizedUrl = normalizeSourceUrl(source.url);
  const urlHash = hashSourceText(normalizedUrl);
  const title = normalizeSourceTitle(source.title || normalizedUrl);
  const content = truncateText(source.content, SOURCE_CACHE_MAX_CHARS);
  const sourceChars = source.content.length;
  const truncated = sourceChars > SOURCE_CACHE_MAX_CHARS;
  const parserStatus = source.parserStatus ?? (
    source.content.trim() ? "parsed" : "empty"
  );
  const contentHash = await sha256Fingerprint(content);
  const readableBody = [`# ${title}`, "", content].join("\n");
  const sectionCount = Math.max(
    1,
    Math.ceil(content.length / SOURCE_CACHE_SECTION_CHARS),
  );
  const vaultPath = normalizeVaultPath(
    `${SOURCE_CACHE_FOLDER}/${safeDomain(normalizedUrl)}/${safeSlug(title)}-${urlHash}.md`,
    { requireMarkdown: true },
  );
  const fetchedForMission = resolveSourceCacheMissionId(ctx);
  const note = [
    "---",
    `url: ${JSON.stringify(normalizedUrl)}`,
    `normalizedUrl: ${JSON.stringify(normalizedUrl)}`,
    `urlHash: ${JSON.stringify(urlHash)}`,
    `title: ${JSON.stringify(title)}`,
    `fetchedAt: ${JSON.stringify(fetchedAt)}`,
    `sourceChars: ${sourceChars}`,
    `totalChars: ${content.length}`,
    `contentHash: ${JSON.stringify(contentHash)}`,
    `truncated: ${truncated}`,
    `parserStatus: ${JSON.stringify(parserStatus)}`,
    `sectionCount: ${sectionCount}`,
    ...(fetchedForMission
      ? [`fetchedForMission: ${JSON.stringify(fetchedForMission)}`]
      : []),
    "---",
    "",
    readableBody,
  ].join("\n");
  await ensureVaultFolderPath(ctx, parentPath(vaultPath));
  await enqueueSourceWrite(ctx, vaultPath, async () => {
    const file = ctx.app.vault.getFileByPath(vaultPath);
    if (file) {
      await ctx.app.vault.modify(file, note);
    } else {
      await ctx.app.vault.create(vaultPath, note);
    }
    invalidateSourceSectionReadCache(ctx, vaultPath);
  });
  const cached = {
    vaultPath,
    url: normalizedUrl,
    normalizedUrl,
    urlHash,
    title,
    fetchedAt,
    sourceChars,
    totalChars: content.length,
    contentHash,
    truncated,
    parserStatus,
    sectionCount,
    ...(fetchedForMission ? { fetchedForMission } : {}),
  } satisfies CachedSource;
  await upsertSourceCacheManifest(ctx, cached, fetchedAt);
  return cached;
}

export async function findFreshCachedSource(
  ctx: ToolExecutionContext,
  url: string,
  options: SourceCacheReadOptions = {},
): Promise<CachedSource | null> {
  const maxAgeMs = normalizeMaxAgeMs(options.maxAgeMs);
  if (maxAgeMs <= 0) {
    return null;
  }
  // A refresh drops the cache to this mission's own transports rather than
  // discarding it outright. The first fetch of a source still pays a wire
  // trip, so the freshness the caller asked for is the freshness it gets; what
  // it no longer gets is a second wire trip for bytes this same mission
  // already pulled. `max_age_ms` above stays the unconditional bypass, and is
  // also how a caller bounds how stale a same-mission copy may be.
  const missionScope = options.refresh === true
    ? options.missionId?.trim()
    : undefined;
  if (options.refresh === true && !missionScope) {
    return null;
  }
  const normalizedUrl = normalizeSourceUrl(url);
  const manifestHit = await findFreshManifestEntry(
    ctx,
    normalizedUrl,
    maxAgeMs,
    missionScope,
  );
  if (manifestHit) {
    return manifestHit;
  }
  if (typeof ctx.app.vault.getFiles !== "function") {
    return null;
  }
  const now = ctx.now?.().getTime() ?? Date.now();
  for (const file of ctx.app.vault.getFiles()) {
    if (!isSourceCachePath(file.path) || file.extension !== "md") {
      continue;
    }
    await awaitPendingSourceWrite(ctx, file.path);
    const parsed = parseCachedSourceNote(file.path, await ctx.app.vault.read(file));
    if (!parsed || parsed.normalizedUrl !== normalizedUrl) {
      continue;
    }
    if (!isStrongContentHash(parsed.contentHash)) {
      continue;
    }
    if (missionScope && parsed.fetchedForMission !== missionScope) {
      continue;
    }
    const age = now - Date.parse(parsed.fetchedAt);
    if (Number.isFinite(age) && age >= 0 && age <= maxAgeMs) {
      return parsed;
    }
  }
  return null;
}

export async function readSourceSection(
  ctx: ToolExecutionContext,
  ref: { url?: string; path?: string },
  section: number,
): Promise<CachedSourceSection> {
  const file = ref.path
    ? ctx.app.vault.getFileByPath(normalizeVaultPath(ref.path, { requireMarkdown: true }))
    : await findCachedFileByUrl(ctx, ref.url ?? "");
  if (!file) {
    throw new Error("Cached source was not found.");
  }
  const payload = await readCachedSourcePayload(ctx, file);
  const { parsed, sourceContent } = payload;
  if (
    ref.url &&
    parsed.normalizedUrl !== normalizeSourceUrl(ref.url)
  ) {
    throw new Error("Cached source was not found.");
  }
  const sectionCount = Math.max(
    1,
    Math.ceil(sourceContent.length / SOURCE_CACHE_SECTION_CHARS),
  );
  const zeroIndex = Math.max(0, Math.min(sectionCount - 1, section - 1));
  const sourceStartChar = zeroIndex * SOURCE_CACHE_SECTION_CHARS;
  return {
    ...parsed,
    sectionCount,
    section: zeroIndex + 1,
    sourceStartChar,
    content: sourceContent.slice(
      sourceStartChar,
      sourceStartChar + SOURCE_CACHE_SECTION_CHARS,
    ),
  };
}

/**
 * Whole stored text of a cached source, for callers that need the source
 * rather than one bounded section. Returns null when the note is gone or
 * unparseable, so a retrieval provider can fall through to the wire instead of
 * failing the attempt.
 */
export async function readCachedSourceContent(
  ctx: ToolExecutionContext,
  vaultPath: string,
): Promise<string | null> {
  let file: TFile | null = null;
  try {
    file = ctx.app.vault.getFileByPath(
      normalizeVaultPath(vaultPath, { requireMarkdown: true }),
    );
  } catch {
    return null;
  }
  if (!file) return null;
  const payload = await readCachedSourcePayload(ctx, file).catch(() => null);
  return payload?.sourceContent ?? null;
}

async function findCachedFileByUrl(ctx: ToolExecutionContext, url: string) {
  if (!url || typeof ctx.app.vault.getFiles !== "function") {
    return null;
  }
  const normalizedUrl = normalizeSourceUrl(url);
  const manifest = await readSourceCacheManifest(ctx);
  const direct = manifest.entries.find(
    (entry) => entry.normalizedUrl === normalizedUrl,
  );
  if (direct) {
    const file = ctx.app.vault.getFileByPath(direct.vaultPath);
    if (file) return file;
  }
  for (const file of ctx.app.vault.getFiles()) {
    if (!isSourceCachePath(file.path) || file.extension !== "md") {
      continue;
    }
    const payload = await readCachedSourcePayload(ctx, file).catch(() => null);
    if (payload?.parsed.normalizedUrl === normalizedUrl) {
      return file;
    }
  }
  return null;
}

async function readCachedSourcePayload(
  ctx: ToolExecutionContext,
  file: TFile,
): Promise<{ parsed: CachedSource; sourceContent: string }> {
  await awaitPendingSourceWrite(ctx, file.path);
  const stamp = sourceFileStamp(file);
  const key = getVaultQueueKey(ctx);
  const cache = sourceSectionReadCaches.get(key);
  const cached = stamp ? cache?.get(file.path) : null;
  if (cached?.stamp === stamp) {
    cache!.delete(file.path);
    cache!.set(file.path, cached);
    return {
      parsed: cached.parsed,
      sourceContent: cached.sourceContent,
    };
  }

  const markdown = await ctx.app.vault.read(file);
  const parsed = parseCachedSourceNote(file.path, markdown);
  if (!parsed) {
    throw new Error("Cached source note is invalid.");
  }
  const sourceContent = getCachedSourceContent(markdown, parsed);
  if (stamp) {
    const next = cache ?? new Map();
    next.delete(file.path);
    next.set(file.path, { stamp, parsed, sourceContent });
    while (next.size > SOURCE_SECTION_READ_CACHE_ENTRIES) {
      const oldest = next.keys().next().value as string | undefined;
      if (!oldest) break;
      next.delete(oldest);
    }
    sourceSectionReadCaches.set(key, next);
  }
  return { parsed, sourceContent };
}

function sourceFileStamp(file: TFile): string | null {
  const mtime = file.stat?.mtime;
  const size = file.stat?.size;
  return Number.isFinite(mtime) && Number.isFinite(size)
    ? `${mtime}:${size}`
    : null;
}

function invalidateSourceSectionReadCache(
  ctx: ToolExecutionContext,
  path: string,
): void {
  sourceSectionReadCaches.get(getVaultQueueKey(ctx))?.delete(path);
}

async function upsertSourceCacheManifest(
  ctx: ToolExecutionContext,
  cached: CachedSource,
  updatedAt: string,
) {
  await enqueueManifestWrite(ctx, async () => {
    const manifest = await readSourceCacheManifestUnlocked(ctx);
    const entries = [
      cached,
      ...manifest.entries.filter(
        (entry) => entry.normalizedUrl !== cached.normalizedUrl,
      ),
    ].sort(
      (left, right) =>
        right.fetchedAt.localeCompare(left.fetchedAt) ||
        left.normalizedUrl.localeCompare(right.normalizedUrl),
    );
    const next: SourceCacheManifest = {
      version: 1,
      updatedAt,
      entries,
    };
    await ensureVaultFolderPath(ctx, SOURCE_CACHE_FOLDER);
    const file = ctx.app.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH);
    const text = `${JSON.stringify(next, null, 2)}\n`;
    if (file) {
      await ctx.app.vault.modify(file, text);
    } else {
      await ctx.app.vault.create(SOURCE_CACHE_MANIFEST_PATH, text);
    }
  });
}

/**
 * Write one auxiliary JSON file under the source-cache folder through the same
 * serialized, folder-ensuring path the manifest uses. The search-result cache
 * rides this so its writes share the manifest queue (no interleaved
 * read-modify-write) and the same exemptions: a file under
 * `Agent Sources/` is cache, never a note write or a mutation receipt.
 *
 * `mutate` receives the current file text (null when absent) and returns the
 * text to write, or null to leave the file untouched.
 */
export async function updateSourceCacheJsonFile(
  ctx: ToolExecutionContext,
  path: string,
  mutate: (current: string | null) => string | null,
): Promise<void> {
  await enqueueManifestWrite(ctx, async () => {
    await ensureVaultFolderPath(ctx, parentPath(path));
    const file = ctx.app.vault.getFileByPath(path);
    const current = file ? await ctx.app.vault.read(file) : null;
    const next = mutate(current);
    if (next === null) {
      return;
    }
    if (file) {
      await ctx.app.vault.modify(file, next);
    } else {
      await ctx.app.vault.create(path, next);
    }
  });
}

/** Read an auxiliary source-cache file after any queued write has landed. */
export async function readSourceCacheJsonFile(
  ctx: ToolExecutionContext,
  path: string,
): Promise<string | null> {
  const pendingWrite = manifestWriteQueues.get(getVaultQueueKey(ctx));
  if (pendingWrite) {
    await pendingWrite.catch(() => undefined);
  }
  const file = ctx.app.vault.getFileByPath(path);
  if (!file) {
    return null;
  }
  try {
    return await ctx.app.vault.read(file);
  } catch {
    return null;
  }
}

export async function readSourceCacheManifest(
  ctx: ToolExecutionContext,
): Promise<SourceCacheManifest> {
  const pendingWrite = manifestWriteQueues.get(getVaultQueueKey(ctx));
  if (pendingWrite) {
    await pendingWrite.catch(() => undefined);
  }
  return readSourceCacheManifestUnlocked(ctx);
}

async function readSourceCacheManifestUnlocked(
  ctx: ToolExecutionContext,
): Promise<SourceCacheManifest> {
  const file = ctx.app.vault.getFileByPath(SOURCE_CACHE_MANIFEST_PATH);
  if (!file) {
    return { version: 1, updatedAt: "", entries: [] };
  }
  try {
    const parsed = JSON.parse(await ctx.app.vault.read(file));
    const manifest = parseSourceCacheManifest(parsed);
    if (!manifest) {
      return { version: 1, updatedAt: "", entries: [] };
    }
    return manifest;
  } catch {
    return { version: 1, updatedAt: "", entries: [] };
  }
}

async function findFreshManifestEntry(
  ctx: ToolExecutionContext,
  normalizedUrl: string,
  maxAgeMs: number,
  missionScope?: string,
): Promise<CachedSource | null> {
  const manifest = await readSourceCacheManifest(ctx);
  const entry = manifest.entries.find(
    (candidate) => candidate.normalizedUrl === normalizedUrl,
  );
  if (!entry) {
    return null;
  }
  if (!isStrongContentHash(entry.contentHash)) {
    return null;
  }
  if (missionScope && entry.fetchedForMission !== missionScope) {
    return null;
  }
  const age = (ctx.now?.().getTime() ?? Date.now()) - Date.parse(entry.fetchedAt);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) {
    return null;
  }
  return ctx.app.vault.getFileByPath(entry.vaultPath) ? entry : null;
}

function parseCachedSourceNote(path: string, markdown: string): CachedSource | null {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(markdown)?.[1];
  if (!frontmatter) {
    return null;
  }
  const fields = new Map<string, string>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(line);
    if (match) {
      fields.set(match[1], parseScalar(match[2]));
    }
  }
  const url = fields.get("url");
  const title = fields.get("title") ?? url;
  const fetchedAt = fields.get("fetchedAt");
  const totalChars = Number(fields.get("totalChars"));
  const sourceChars = Number(fields.get("sourceChars"));
  const sectionCount = Number(fields.get("sectionCount"));
  if (!url || !title || !fetchedAt || !Number.isFinite(totalChars)) {
    return null;
  }
  const normalizedUrl = fields.get("normalizedUrl") ?? normalizeSourceUrl(url);
  const urlHash = fields.get("urlHash") ?? hashSourceText(normalizedUrl);
  const fetchedForMission = fields.get("fetchedForMission")?.trim();
  const parsedSourceChars = Number.isFinite(sourceChars) ? sourceChars : totalChars;
  return {
    vaultPath: path,
    url,
    normalizedUrl,
    urlHash,
    title,
    fetchedAt,
    sourceChars: parsedSourceChars,
    totalChars,
    contentHash: fields.get("contentHash") ?? "",
    truncated:
      parseBoolean(fields.get("truncated")) ?? parsedSourceChars > totalChars,
    parserStatus: parseParserStatus(fields.get("parserStatus")),
    sectionCount: Number.isFinite(sectionCount) ? Math.max(1, sectionCount) : 1,
    ...(fetchedForMission ? { fetchedForMission } : {}),
  };
}

function parseSourceCacheManifest(value: unknown): SourceCacheManifest | null {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.entries)) {
    return null;
  }
  const entries = value.entries
    .map(normalizeCachedSourceRecord)
    .filter((entry): entry is CachedSource => entry !== null);
  if (entries.length !== value.entries.length) {
    return null;
  }
  return {
    version: 1,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    entries,
  };
}

function normalizeCachedSourceRecord(value: unknown): CachedSource | null {
  if (
    !isRecord(value) ||
    typeof value.vaultPath !== "string" ||
    typeof value.url !== "string" ||
    typeof value.title !== "string" ||
    typeof value.fetchedAt !== "string" ||
    typeof value.totalChars !== "number" ||
    typeof value.sectionCount !== "number"
  ) {
    return null;
  }
  const normalizedUrl = typeof value.normalizedUrl === "string"
    ? value.normalizedUrl
    : normalizeSourceUrl(value.url);
  const sourceChars = typeof value.sourceChars === "number"
    ? value.sourceChars
    : value.totalChars;
  return {
    vaultPath: value.vaultPath,
    url: value.url,
    normalizedUrl,
    urlHash: typeof value.urlHash === "string"
      ? value.urlHash
      : hashSourceText(normalizedUrl),
    title: value.title,
    fetchedAt: value.fetchedAt,
    sourceChars,
    totalChars: value.totalChars,
    contentHash: typeof value.contentHash === "string" ? value.contentHash : "",
    truncated: typeof value.truncated === "boolean"
      ? value.truncated
      : sourceChars > value.totalChars,
    parserStatus: parseParserStatus(value.parserStatus),
    sectionCount: Math.max(1, value.sectionCount),
    ...(typeof value.fetchedForMission === "string" &&
    value.fetchedForMission.trim()
      ? { fetchedForMission: value.fetchedForMission }
      : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrongContentHash(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/u.test(value);
}

function stripFrontmatter(markdown: string): string {
  return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n+/, "");
}

function getCachedSourceContent(
  markdown: string,
  cached: CachedSource,
): string {
  const body = stripFrontmatter(markdown);
  // Cache notes have always carried a generated H1 for human readability.
  // It is note chrome, not source content, so legacy and current notes must
  // remove it before sectioning to preserve source-relative character offsets.
  const generatedHeading = new RegExp(
    `^# ${escapeRegExp(cached.title)}\\r?\\n\\r?\\n`,
  );
  const sourceContent = body.replace(generatedHeading, "");
  return sourceContent.slice(0, cached.totalChars);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseScalar(value: string): string {
  const trimmed = value.trim();
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return trimmed;
  }
}

function parseBoolean(value: unknown): boolean | undefined {
  if (value === true || value === "true") {
    return true;
  }
  if (value === false || value === "false") {
    return false;
  }
  return undefined;
}

function parseParserStatus(value: unknown): SourceParserStatus {
  return value === "parsed" || value === "empty" || value === "missing_content"
    ? value
    : "legacy_unknown";
}

async function ensureVaultFolderPath(ctx: ToolExecutionContext, path: string) {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current = current ? `${current}/${part}` : part;
    if (!ctx.app.vault.getFolderByPath(current)) {
      try {
        await ctx.app.vault.createFolder(current);
      } catch (error) {
        if (!ctx.app.vault.getFolderByPath(current)) {
          throw error;
        }
      }
    }
  }
}

async function enqueueManifestWrite(
  ctx: ToolExecutionContext,
  operation: () => Promise<void>,
): Promise<void> {
  const key = getVaultQueueKey(ctx);
  const previous = manifestWriteQueues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  manifestWriteQueues.set(key, next);
  try {
    await next;
  } finally {
    if (manifestWriteQueues.get(key) === next) {
      manifestWriteQueues.delete(key);
    }
  }
}

async function enqueueSourceWrite(
  ctx: ToolExecutionContext,
  path: string,
  operation: () => Promise<void>,
): Promise<void> {
  const key = getVaultQueueKey(ctx);
  const queues = sourceWriteQueues.get(key) ?? new Map<string, Promise<void>>();
  sourceWriteQueues.set(key, queues);
  const previous = queues.get(path) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation);
  queues.set(path, next);
  try {
    await next;
  } finally {
    if (queues.get(path) === next) {
      queues.delete(path);
    }
    if (queues.size === 0) {
      sourceWriteQueues.delete(key);
    }
  }
}

/**
 * Wait for any queued write to this source note before reading it.
 *
 * Writes to one note are serialised through `enqueueSourceWrite`, but the
 * readers went straight to `vault.read`. A desktop `vault.modify` is a
 * truncate-then-write, so a read that lands mid-write sees a partial note.
 * `parseCachedSourceNote` then returns null, `read_source_section` throws
 * "Cached source note is invalid.", and because that tool is often required,
 * the failure suppresses auto-continuation. Read-only tool batches run
 * concurrently, so a `web_fetch` refreshing a source and a section read of
 * the same source can overlap. The manifest readers already wait on their
 * queue (`readSourceCacheManifest`); this gives the note readers the same rule.
 */
async function awaitPendingSourceWrite(
  ctx: ToolExecutionContext,
  path: string,
): Promise<void> {
  const pending = sourceWriteQueues.get(getVaultQueueKey(ctx))?.get(path);
  if (pending) {
    await pending.catch(() => undefined);
  }
}

function getVaultQueueKey(ctx: ToolExecutionContext): object {
  return ctx.app.vault as unknown as object;
}

function parentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? "" : path.slice(0, slash);
}

function safeDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/[^A-Za-z0-9.-]+/g, "-") || "source";
  } catch {
    return "source";
  }
}

function normalizeSourceUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = "";
    return url.toString();
  } catch {
    return trimmed.replace(/#.*$/, "");
  }
}

function normalizeSourceTitle(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "Source";
}

function normalizeMaxAgeMs(value: number | undefined): number {
  if (value === undefined) {
    return SOURCE_CACHE_FRESH_MS;
  }
  if (!Number.isFinite(value)) {
    return SOURCE_CACHE_FRESH_MS;
  }
  return Math.min(SOURCE_CACHE_MAX_AGE_MS, Math.max(0, Math.trunc(value)));
}

function hashSourceText(value: string): string {
  let first = 2166136261;
  let second = 0x9e3779b9;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first ^= code;
    first = Math.imul(first, 16777619);
    second ^= code + index;
    second = Math.imul(second, 2246822519);
  }
  return `${(first >>> 0).toString(16).padStart(8, "0")}${
    (second >>> 0).toString(16).padStart(8, "0")
  }`;
}

function safeSlug(value: string): string {
  return (
    value
      .trim()
      .replace(/https?:\/\//i, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      // Dot runs from hostile titles would otherwise survive as `..` path
      // segments and fail vault path validation.
      .replace(/\.{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 80) || "source"
  );
}
