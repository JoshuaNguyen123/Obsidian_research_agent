import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import assert from "node:assert/strict";
import type { HttpRequest, HttpResponse } from "../src/model/types";
import type { ToolExecutionContext } from "../src/tools/types";
import { webFetchTool } from "../src/tools/webTools";
import { findFreshCachedSource, writeSourceCacheNote } from "../src/tools/sourceCache";
import { resolveRetrievalCachePolicy } from "../src/tools/retrievalCachePolicy";
import { createMissionRuntimeSnapshot, normalizeMissionRuntimeSnapshot } from "../src/agent/runStore";

/**
 * A refresh request means "do not hand me a copy from an earlier mission". It
 * has never meant "re-transport a URL you already pulled seconds ago in this
 * same mission", but that is what it did: the bypass returned no cache entry
 * at all, so a freshness-flavoured mission paid one wire trip per web_fetch
 * call forever. The BYOK lane measured four owned sources pulled 33 times.
 *
 * The first fetch of a mission still goes to the wire, so freshness is intact.
 * `max_age_ms: 0` stays the unconditional bypass for a caller that really does
 * want every call transported.
 */

const SOURCE_URL = "https://owned.example/crdt-gcounter";
const BODY = [
  "A state-based G-Counter assigns each replica its own slot and merges by pointwise maximum.",
  "Convergence follows because the join is idempotent, commutative, and associative.",
  "An observed-remove set records add tags and removes only the tags a replica has observed.",
].join(" ");

for (const policy of [{ max_age_ms: 0 }, { refresh: true }, { max_age_ms: 1 }]) {
  test(`fallback obeys ${JSON.stringify(policy)} across missions`, async () => {
    const app = createSharedVault();
    let alternateHits = 0;
    const context = createContext({ app, rootMissionId: "old-mission", originalPrompt: "CRDT convergence", transport: async (request) => {
      if (request.url.endsWith("/web_fetch") && JSON.parse(String(request.body)).url === SOURCE_URL) alternateHits++;
      return { status: 404, headers: {}, json: {} };
    } });
    context.now = () => new Date("2026-09-04T10:00:00Z");
    const old = await writeSourceCacheNote(context, { url: SOURCE_URL, title: "CRDT", content: BODY });
    context.rootMissionId = "new-mission";
    context.now = () => new Date("2026-09-04T12:00:00Z");
    await assert.rejects(webFetchTool.execute({ url: "https://unreachable.example/linear-issue", alternate_urls: [SOURCE_URL], ...policy }, context));
    assert.ok(alternateHits > 0, "a bypass must attempt transport instead of accepting old bytes");
    const after = await findFreshCachedSource(context, SOURCE_URL);
    assert.equal(after?.fetchedAt, old.fetchedAt);
    assert.equal(after?.fetchedForMission, "old-mission");
  });
}

test("cached substitute preserves transport provenance without rewriting the note", async () => {
  const app = createSharedVault();
  const context = createContext({ app, rootMissionId: "same-mission", originalPrompt: "CRDT convergence", transport: async () => ({ status: 404, headers: {}, json: {} }) });
  context.now = () => new Date("2026-09-04T10:00:00Z");
  const old = await writeSourceCacheNote(context, { url: SOURCE_URL, title: "CRDT", content: BODY });
  context.now = () => new Date("2026-09-04T12:00:00Z");
  const result = await webFetchTool.execute({ url: "https://unreachable.example/linear-issue", alternate_urls: [SOURCE_URL], refresh: true }, context) as Record<string, unknown>;
  assert.equal(result.fromCache, true);
  assert.equal(result.sourceTransport, "cache");
  assert.equal(result.fetchedAt, old.fetchedAt);
  assert.equal(result.contentHash, old.contentHash);
  assert.equal(result.fetchedForMission, old.fetchedForMission);
});

test("host defaults survive snapshots and ignore worker wording; explicit args win", () => {
  const saved = normalizeMissionRuntimeSnapshot(JSON.parse(JSON.stringify(createMissionRuntimeSnapshot({
    runId: "root", originalMission: "Research current CRDT implementations", retrievalCacheDefaults: { refresh: true },
  }))));
  const context = { originalPrompt: "Explain CRDT algebra", retrievalCacheDefaults: saved?.retrievalCacheDefaults, rootMissionId: "root" } as ToolExecutionContext;
  assert.equal(resolveRetrievalCachePolicy({}, context).refresh, true);
  assert.equal(resolveRetrievalCachePolicy({ refresh: false }, context).refresh, false);
  assert.equal(resolveRetrievalCachePolicy({ max_age_ms: 10 }, context).refresh, false);
  assert.equal(resolveRetrievalCachePolicy({ refresh: true, max_age_ms: 0 }, context).maxAgeMs, 0);
  context.originalPrompt = "Get latest CRDT sources";
  context.retrievalCacheDefaults = { refresh: false };
  assert.equal(resolveRetrievalCachePolicy({}, context).refresh, false);
});

function createSharedVault() {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const getFile = (path: string) =>
    content.has(path)
      ? {
          path,
          basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
          extension: path.split(".").pop()?.toLowerCase() ?? "",
        }
      : null;
  return {
    vault: {
      getFileByPath: getFile,
      getFolderByPath: (path: string) =>
        folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        content.set(path, data);
        return getFile(path);
      },
      process: function (file: any, transform: (content: string) => string): Promise<string> {
        return processTestVaultFile(this, file, transform);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
      },
      read: async (file: { path: string }) => {
        const value = content.get(file.path);
        if (value === undefined) throw new Error(`File not found: ${file.path}`);
        return value;
      },
      getFiles: () =>
        [...content.keys()]
          .map((path) => getFile(path))
          .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    },
  };
}

/**
 * A fresh context per call on purpose: hosts build one per tool call, and a
 * cache that only survives inside a single context would not have survived the
 * "Continue Latest Run" segment boundary the measured run crossed.
 */
function createContext(input: {
  app: ReturnType<typeof createSharedVault>;
  transport: (request: HttpRequest) => Promise<HttpResponse>;
  originalPrompt: string;
  rootMissionId?: string;
  runId?: string;
}): ToolExecutionContext {
  return {
    app: input.app as never,
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "test-key",
      requestTimeoutMs: 60_000,
    } as never,
    originalPrompt: input.originalPrompt,
    httpTransport: input.transport,
    ...(input.rootMissionId ? { rootMissionId: input.rootMissionId } : {}),
    ...(input.runId ? { runId: input.runId } : {}),
    now: () => new Date("2026-09-04T12:00:00.000Z"),
  } as unknown as ToolExecutionContext;
}

async function countTransportHits(input: {
  calls: readonly {
    args: Record<string, unknown>;
    originalPrompt?: string;
    rootMissionId?: string;
    runId?: string;
  }[];
}): Promise<{ hits: number; fromCache: (boolean | "error")[] }> {
  const app = createSharedVault();
  let hits = 0;
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    if (String(request.url).endsWith("/web_fetch")) {
      hits += 1;
      return {
        status: 200,
        headers: {},
        json: { title: "Owned CRDT source", content: BODY, links: [] },
      } as unknown as HttpResponse;
    }
    return { status: 404, headers: {}, json: {} } as unknown as HttpResponse;
  };
  const fromCache: (boolean | "error")[] = [];
  for (const call of input.calls) {
    const context = createContext({
      app,
      transport,
      originalPrompt:
        call.originalPrompt ?? "Research dependency-free Python CRDT libraries.",
      ...(call.rootMissionId ? { rootMissionId: call.rootMissionId } : {}),
      ...(call.runId ? { runId: call.runId } : {}),
    });
    try {
      const result = (await webFetchTool.execute(call.args, context)) as {
        fromCache?: boolean;
      };
      fromCache.push(result.fromCache === true);
    } catch {
      fromCache.push("error");
    }
  }
  return { hits, fromCache };
}

function repeat(
  count: number,
  call: {
    args: Record<string, unknown>;
    originalPrompt?: string;
    rootMissionId?: string;
    runId?: string;
  },
) {
  return Array.from({ length: count }, () => call);
}

test("an explicit refresh transports a source once per mission", async () => {
  const { hits, fromCache } = await countTransportHits({
    calls: repeat(4, {
      args: { url: SOURCE_URL, refresh: true },
      rootMissionId: "mission-a",
    }),
  });
  assert.equal(hits, 1, "four refresh calls in one mission must pay one wire trip");
  assert.deepEqual(fromCache, [false, true, true, true]);
});

test("a freshness-sensitive prompt transports a source once per mission", async () => {
  // The research worker sets originalPrompt to the planner's assignment, so
  // this trigger fires on model-written text, not on the user's mission.
  const { hits, fromCache } = await countTransportHits({
    calls: repeat(4, {
      args: { url: SOURCE_URL },
      originalPrompt: "Summarize the latest guidance on observed-remove sets.",
      rootMissionId: "mission-a",
    }),
  });
  assert.equal(hits, 1);
  assert.deepEqual(fromCache, [false, true, true, true]);
});

test("a continuation segment reuses what its own root mission fetched", async () => {
  // Same rootMissionId, different per-segment runId: this is the "Continue
  // Latest Run" boundary the measured Phase A crossed twice.
  const { hits } = await countTransportHits({
    calls: [
      { args: { url: SOURCE_URL, refresh: true }, rootMissionId: "mission-a", runId: "seg-1" },
      { args: { url: SOURCE_URL, refresh: true }, rootMissionId: "mission-a", runId: "seg-2" },
      { args: { url: SOURCE_URL, refresh: true }, rootMissionId: "mission-a", runId: "seg-2" },
    ],
  });
  assert.equal(hits, 1, "a resumed segment must not re-transport its root mission's sources");
});

test("a later mission still refetches what an earlier one cached", async () => {
  const { hits, fromCache } = await countTransportHits({
    calls: [
      { args: { url: SOURCE_URL, refresh: true }, rootMissionId: "mission-a" },
      { args: { url: SOURCE_URL, refresh: true }, rootMissionId: "mission-b" },
    ],
  });
  assert.equal(hits, 2, "refresh must still defeat a copy an earlier mission left behind");
  assert.deepEqual(fromCache, [false, false]);
});

test("max_age_ms 0 stays an unconditional bypass", async () => {
  const { hits } = await countTransportHits({
    calls: repeat(3, {
      args: { url: SOURCE_URL, max_age_ms: 0 },
      rootMissionId: "mission-a",
    }),
  });
  assert.equal(hits, 3, "an explicit zero max age is the escape hatch and must not be run-scoped");
});

test("an ordinary fetch is unchanged and still serves from cache", async () => {
  const { hits, fromCache } = await countTransportHits({
    calls: repeat(4, { args: { url: SOURCE_URL }, rootMissionId: "mission-a" }),
  });
  assert.equal(hits, 1);
  assert.deepEqual(fromCache, [false, true, true, true]);
});

/**
 * A dead primary spends the substitution ladder, and the ladder's
 * `alternate_result` provider is a SECOND transport site that never consulted
 * the source cache. So a run that had already stored a source paid for it
 * again the moment some other URL failed and that source came back as the
 * substitute -- one tool call, one counted request, for bytes already in the
 * vault. Measured on the BYOK lane: a Linear page that the research backend
 * cannot serve 404s, and an owned source already fetched minutes earlier is
 * re-pulled as its replacement.
 */
test("the substitution ladder reuses a stored source instead of re-pulling it", async () => {
  const DEAD_URL = "https://unreachable.example/linear-issue";
  const app = createSharedVault();
  const perUrl = new Map<string, number>();
  const transport = async (request: HttpRequest): Promise<HttpResponse> => {
    if (!String(request.url).endsWith("/web_fetch")) {
      return { status: 404, headers: {}, json: {} } as unknown as HttpResponse;
    }
    const requested = String(
      JSON.parse(String(request.body ?? "{}")).url ?? "",
    );
    perUrl.set(requested, (perUrl.get(requested) ?? 0) + 1);
    if (requested !== SOURCE_URL) {
      return { status: 404, headers: {}, json: {} } as unknown as HttpResponse;
    }
    return {
      status: 200,
      headers: {},
      json: { title: "Owned CRDT source", content: BODY, links: [] },
    } as unknown as HttpResponse;
  };
  const run = async (args: Record<string, unknown>) => {
    const context = createContext({
      app,
      transport,
      originalPrompt: "Research dependency-free Python CRDT libraries.",
      rootMissionId: "mission-a",
    });
    try {
      return await webFetchTool.execute(args, context);
    } catch {
      return null;
    }
  };

  await run({ url: SOURCE_URL });
  assert.equal(perUrl.get(SOURCE_URL), 1, "the first fetch stores the source");

  const substituted = (await run({
    url: DEAD_URL,
    alternate_urls: [SOURCE_URL],
  })) as { fallbackUsed?: boolean; content?: string } | null;

  assert.ok(substituted?.fallbackUsed, "the dead primary must spend the ladder");
  assert.match(String(substituted?.content ?? ""), /pointwise maximum/u);
  assert.equal(
    perUrl.get(SOURCE_URL),
    1,
    "the ladder must answer from the stored copy, not a second request",
  );
});
