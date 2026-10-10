import assert from "node:assert/strict";
import test from "node:test";
import { createDocumentExtractProvider } from "../src/tools/documentExtract";
import type { ToolExecutionContext } from "../src/tools/types";
import type { HttpRequest, HttpResponse } from "../src/model/types";
import { clearCompanionBootstrapSessionV1, createSessionBootstrapTokenLeaseV1,
  installCompanionBootstrapSessionV1 } from "../packages/headless-runtime/src";

const origin = "http://127.0.0.1:18792";
const token = "owned-engine-control-token-0123456789ab";
const source = { id: "one", url: "https://reports.example/one.pdf", strategy: "document_extract" as const };
const identity = () => ({ schemaVersion: 1, generation: "a".repeat(32), loadedEngineSha256: "b".repeat(64),
  effectiveConfigurationSha256: "c".repeat(64), status: "ready" });
function fixture() {
  clearCompanionBootstrapSessionV1(origin);
  const disconnect = installCompanionBootstrapSessionV1({ version: 1, baseUrl: origin,
    credential: createSessionBootstrapTokenLeaseV1(token), connectedAt: new Date().toISOString() });
  const state = { engine: identity() as Record<string, unknown> | null, echo: null as Record<string, unknown> | null,
    noStore: true, healthStatus: 200, reads: 0, requests: [] as HttpRequest[], healthHook: null as (() => Promise<void>) | null };
  const context = { settings: { companionBaseUrl: origin, requestTimeoutMs: 30000 },
    httpTransport: async (request: HttpRequest): Promise<HttpResponse> => {
      state.requests.push(request);
      assert.equal(request.headers?.Authorization, "Bearer " + token);
      if (request.url.endsWith("/health")) {
        await state.healthHook?.();
        return { status: state.healthStatus, headers: state.noStore ? { "cache-control": "no-store" } : {}, json: {
          ok: true, service: "obsidian-research-companion", pdfReady: state.engine?.status === "ready",
          ...(state.engine ? { documentExtractionIdentity: state.engine } : {}) } };
      }
      assert.ok(request.url.endsWith("/document/extract_text"));
      return { status: 200, headers: { "cache-control": "no-store" }, json: { status: "parsed", text: "## Page 1\n\nMeasured -0.05 mg/L.",
        pageCount: 1, pagesExtracted: 1, pagesSkipped: 0, truncated: false,
        ...(state.echo ?? state.engine ? { documentExtractionIdentity: state.echo ?? state.engine } : {}) } };
    },
  } as unknown as ToolExecutionContext;
  const provider = createDocumentExtractProvider(context, { fetchDocument: async () => {
    state.reads++;
    return { bytes: new TextEncoder().encode("%PDF-1.4 owned document input").buffer as ArrayBuffer };
  } });
  return { state, context, disconnect, run: () => provider.retrieve(source),
    posts: () => state.requests.filter(request => request.method === "POST").length,
    health: () => state.requests.filter(request => request.url.endsWith("/health")).length };
}

test("each unchanged derived reuse observes fresh authenticated no-store engine identity", async () => {
  const f = fixture();
  try {
    const first = await f.run();
    first!.content = "caller mutation";
    assert.match((await f.run())!.content, /-0\.05 mg\/L/u);
    assert.equal(f.posts(), 1);
    assert.equal(f.health(), 2);
    assert.equal(f.state.reads, 2, "source acquisition optimization is a separate lane");
    for (const request of f.state.requests) assert.equal(request.headers?.["Cache-Control"], "no-store");
  } finally { f.disconnect(); }
});

test("same-session engine artifact configuration and generation changes each invalidate reuse", async () => {
  const f = fixture();
  try {
    await f.run(); await f.run(); assert.equal(f.posts(), 1);
    for (const [field, value] of [["loadedEngineSha256", "d".repeat(64)],
      ["effectiveConfigurationSha256", "e".repeat(64)], ["generation", "f".repeat(32)]]) {
      f.state.engine![field!] = value;
      await f.run(); assert.equal(f.posts(), f.health() - 1);
    }
    assert.equal(f.posts(), 4);
  } finally { f.disconnect(); }
});

test("legacy missing malformed unavailable and cacheable health never authorize derived reuse", async () => {
  for (const kind of ["missing", "malformed", "unavailable", "cacheable"] as const) {
    const f = fixture();
    try {
      if (kind === "missing") f.state.engine = null;
      if (kind === "malformed") f.state.engine!.loadedEngineSha256 = "service-version-0.3.0";
      if (kind === "unavailable") f.state.engine!.status = "unavailable";
      if (kind === "cacheable") f.state.noStore = false;
      await f.run(); await f.run();
      assert.equal(f.posts(), 2, kind);
      assert.equal(f.health(), 2, kind);
    } finally { f.disconnect(); }
  }
});

test("authenticated preflight and response must echo the same effective engine", async () => {
  const f = fixture();
  try {
    f.state.echo = { ...identity(), loadedEngineSha256: "e".repeat(64) };
    await assert.rejects(f.run(), /engine identity changed|not echoed/iu);
    f.state.echo = null;
    await f.run(); await f.run();
    assert.equal(f.posts(), 2, "rejected response never populated the derived cache");
  } finally { f.disconnect(); }
});

test("revoked health authentication cannot reuse cached output or publish a fresh extract", async () => {
  const f = fixture();
  try {
    await f.run(); f.state.healthStatus = 401;
    await assert.rejects(f.run(), /not authenticated/iu);
    assert.equal(f.posts(), 1);
    assert.equal(f.health(), 2);
  } finally { f.disconnect(); }
});

test("cancellation and expired deadline during fresh engine observation prevent reuse", async () => {
  for (const kind of ["cancel", "deadline"] as const) {
    const f = fixture();
    try {
      await f.run();
      const controller = new AbortController(); f.context.abortSignal = controller.signal;
      f.state.healthHook = async () => {
        if (kind === "cancel") controller.abort();
        else f.context.deadlineAt = Date.now() - 1;
      };
      await assert.rejects(f.run(), /cancel|deadline/iu);
      assert.equal(f.posts(), 1);
    } finally { f.disconnect(); }
  }
});


test("source snapshots receive only the freshly verified actual engine identity", async () => {
  const f = fixture();
  f.context.app = { vault: {} } as ToolExecutionContext["app"];
  const received: unknown[] = [];
  f.context.captureSourceSnapshot = async source => { received.push(source.evidence); return { snapshotSha256: "a".repeat(64) }; };
  try {
    await f.run(); await f.run();
    assert.equal(received.length, 2);
    for (const evidence of received) assert.deepEqual((evidence as Record<string, unknown>).documentExtractionIdentity, f.state.engine);
    f.state.noStore = false;
    await f.run();
    assert.equal((received.at(-1) as Record<string, unknown>).documentExtractionIdentity, undefined, "unverified health cannot supply evidence identity");
  } finally { f.disconnect(); }
});
