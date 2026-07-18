import test from "node:test";
import assert from "node:assert/strict";
import {
  serializeToolResultForModel,
  summarizeToolOutput,
} from "../src/model/toolResultPayload";
import { evidenceFromToolResult } from "../src/agent/missionEvidence";
import {
  createMissionLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
} from "../src/agent/missionLedger";
import {
  createResearchPlan,
  parseExplicitResearchSourceCount,
  decomposePromptIntoResearchQuestions,
} from "../src/agent/researchPlan";
import {
  SOURCE_CACHE_SECTION_CHARS,
  readSourceSection,
  writeSourceCacheNote,
} from "../src/tools/sourceCache";
import type { ToolExecutionContext } from "../src/tools/types";
import { webFetchTool } from "../src/tools/webTools";
import {
  createSessionBootstrapTokenLeaseV1,
  installCompanionBootstrapSessionV1,
} from "../packages/headless-runtime/src";

test("model payload selects bounded query-relevant passages beyond the prefix", () => {
  const content = [
    "Background material. ".repeat(400),
    "The decisive finding is that the solid-state battery electrolyte remained stable for 2,000 cycles.",
    "Additional appendix material. ".repeat(250),
  ].join("\n");
  const result = {
    ok: true,
    toolName: "web_fetch",
    output: {
      title: "Battery study",
      url: "https://example.com/study",
      query: "solid-state battery electrolyte stability",
      content,
    },
  } as const;

  const payload = summarizeToolOutput("web_fetch", result);
  const evidence = (payload.output as {
    contentEvidence: {
      includedChars: number;
      passages: Array<{
        startChar: number;
        text: string;
        selection: string;
      }>;
    };
  }).contentEvidence;

  assert.ok(evidence.includedChars > 600);
  assert.ok(evidence.includedChars <= 4800);
  assert.ok(evidence.passages.some((passage) =>
    passage.startChar > 600 &&
    passage.selection === "query_match" &&
    passage.text.includes("remained stable for 2,000 cycles")
  ));

  const serialized = serializeToolResultForModel(result);
  assert.ok(serialized.length <= 8000);
  assert.doesNotThrow(() => JSON.parse(serialized));
});

test("model payload preserves bounded workspace hashes and trash receipts", () => {
  const hashA = `sha256:${"a".repeat(64)}`;
  const hashB = `sha256:${"b".repeat(64)}`;
  const readPayload = summarizeToolOutput("code_workspace_read", {
    ok: true,
    toolName: "code_workspace_read",
    output: {
      path: "src/value.txt",
      sha256: hashA,
      content: "before\n",
    },
  });
  assert.equal(
    (readPayload.output as { sha256: string }).sha256,
    hashA,
  );

  const mutationPayload = summarizeToolOutput("code_workspace_trash", {
    ok: true,
    toolName: "code_workspace_trash",
    output: {
      operation: "trash",
      path: "src/value.txt",
      receipt: {
        id: "workspace-receipt-1",
        workspaceId: "workspace-1",
        operation: "trash",
        path: "src/value.txt",
        beforeSha256: hashB,
        afterSha256: null,
        trashId: "trash-1",
        manifestSha256: hashA,
        ignoredSecret: "must-not-reach-model",
      },
    },
  });
  assert.deepEqual(
    (mutationPayload.output as { receipt: Record<string, unknown> }).receipt,
    {
      id: "workspace-receipt-1",
      workspaceId: "workspace-1",
      operation: "trash",
      path: "src/value.txt",
      beforeSha256: hashB,
      afterSha256: null,
      trashId: "trash-1",
      manifestSha256: hashA,
    },
  );
});

test("web evidence persists the same source-scoped passage ids shown to the model", () => {
  const result = {
    ok: true,
    toolName: "web_fetch",
    output: {
      title: "Passage proof source",
      url: "https://example.com/passage-proof",
      normalizedUrl: "https://example.com/passage-proof",
      query: "passage proof claim",
      content:
        "The passage proof claim is supported by this bounded source text. " +
        "Additional context explains limitations and confidence.",
    },
  } as const;
  const payload = summarizeToolOutput("web_fetch", result);
  const payloadPassageIds = (payload.output as {
    contentEvidence: { passages: Array<{ id: string }> };
  }).contentEvidence.passages.map((passage) => passage.id);
  const evidence = evidenceFromToolResult("web_fetch", result);

  assert.ok(evidence);
  assert.deepEqual(evidence.passageIds, payloadPassageIds);
  assert.ok(
    payloadPassageIds.every((id) =>
      id.startsWith(`${evidence.sourceId}:passage:`),
    ),
  );

  const ledger = createMissionLedger({
    runId: "run-passage-proof",
    mission: "Verify a claim with passage proof.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 10,
      toolStepBudget: 6,
      finalizationReserve: 4,
      expectedTools: ["web_fetch"],
      stopWhenSatisfied: true,
    },
  });
  ledger.evidence = [evidence];
  const restored = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(ledger));
  assert.deepEqual(restored?.evidence[0]?.passageIds, payloadPassageIds);
  assert.equal(restored?.evidence[0]?.sourceId, evidence.sourceId);
});

test("cached source sections expose disjoint absolute passage ids to model and ledger", async () => {
  const { context } = createWebContext(
    () => new Date("2026-07-10T12:00:00.000Z"),
    async () => {
      throw new Error("network should not be used");
    },
  );
  const url = "https://example.com/section-passages";
  const cached = await writeSourceCacheNote(context, {
    url,
    title: "Section passages",
    content:
      "A".repeat(SOURCE_CACHE_SECTION_CHARS) +
      "SECTION_TWO_TARGET evidence and limitations. ".repeat(80),
  });
  const first = await readSourceSection(context, { path: cached.vaultPath }, 1);
  const second = await readSourceSection(context, { path: cached.vaultPath }, 2);
  const firstResult = {
    ok: true,
    toolName: "read_source_section",
    output: { ...first, query: "section two target" },
  } as const;
  const secondResult = {
    ok: true,
    toolName: "read_source_section",
    output: { ...second, query: "section two target" },
  } as const;
  const firstPassages = ((summarizeToolOutput(
    "read_source_section",
    firstResult,
  ).output as {
    contentEvidence: {
      passages: Array<{ id: string; startChar: number; endChar: number }>;
    };
  }).contentEvidence.passages);
  const secondPassages = ((summarizeToolOutput(
    "read_source_section",
    secondResult,
  ).output as {
    contentEvidence: {
      passages: Array<{ id: string; startChar: number; endChar: number }>;
    };
  }).contentEvidence.passages);

  assert.ok(firstPassages.every((passage) =>
    passage.endChar <= SOURCE_CACHE_SECTION_CHARS
  ));
  assert.ok(secondPassages.every((passage) =>
    passage.startChar >= SOURCE_CACHE_SECTION_CHARS
  ));
  const firstIds = new Set(firstPassages.map((passage) => passage.id));
  assert.ok(secondPassages.every((passage) => !firstIds.has(passage.id)));

  const persistedEvidence = evidenceFromToolResult(
    "read_source_section",
    secondResult,
  );
  assert.ok(persistedEvidence);
  const secondIds = secondPassages.map((passage) => passage.id);
  assert.deepEqual(persistedEvidence.passageIds, secondIds);
  const ledger = createMissionLedger({
    runId: "run-section-passages",
    mission: "Read a later source section with stable passage proof.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 10,
      toolStepBudget: 6,
      finalizationReserve: 4,
      expectedTools: ["read_source_section"],
      stopWhenSatisfied: true,
    },
  });
  ledger.evidence = [persistedEvidence];
  const restored = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(ledger));
  assert.deepEqual(restored?.evidence[0]?.passageIds, secondIds);
});

test("fresh and cached fetches expose identical passage ids", async () => {
  let transportCalls = 0;
  const body = [
    "Stable source context. ".repeat(40),
    "The cache identity anchor supports the same claim after retrieval.",
    "Additional limitations. ".repeat(40),
  ].join("\n");
  const { context } = createWebContext(
    () => new Date("2026-07-10T12:00:00.000Z"),
    async () => {
      transportCalls += 1;
      return {
        status: 200,
        headers: {},
        json: { title: "Stable identity", content: body, links: [] },
      };
    },
  );
  const args = {
    url: "https://example.com/stable-identity",
    query: "cache identity anchor",
  };
  const fresh = await webFetchTool.execute(
    { ...args, refresh: true },
    context,
  );
  const cached = await webFetchTool.execute(
    { ...args, refresh: false, max_age_ms: 60_000 },
    context,
  );
  assert.equal(transportCalls, 1);
  assert.equal(
    (cached as { content: string }).content,
    (fresh as { content: string }).content,
  );

  const freshPayload = summarizeToolOutput("web_fetch", {
    ok: true,
    toolName: "web_fetch",
    output: fresh,
  });
  const cachedPayload = summarizeToolOutput("web_fetch", {
    ok: true,
    toolName: "web_fetch",
    output: cached,
  });
  const payloadIds = (payload: typeof freshPayload) =>
    ((payload.output as {
      contentEvidence: { passages: Array<{ id: string }> };
    }).contentEvidence.passages.map((passage) => passage.id));
  assert.deepEqual(payloadIds(cachedPayload), payloadIds(freshPayload));

  const freshEvidence = evidenceFromToolResult("web_fetch", {
    ok: true,
    toolName: "web_fetch",
    output: fresh,
  });
  const cachedEvidence = evidenceFromToolResult("web_fetch", {
    ok: true,
    toolName: "web_fetch",
    output: cached,
  });
  assert.deepEqual(cachedEvidence?.passageIds, freshEvidence?.passageIds);
  assert.deepEqual(freshEvidence?.passageIds, payloadIds(freshPayload));
});

test("model payload distributes read coverage so tail evidence is retained", () => {
  const content = `${"A".repeat(12000)}\nTAIL_EVIDENCE_FOR_RESEARCH`;
  const payload = summarizeToolOutput("read_file", {
    ok: true,
    toolName: "read_file",
    output: {
      path: "Notes/long.md",
      content,
    },
  });
  const evidence = (payload.output as {
    contentEvidence: {
      passages: Array<{ startChar: number; text: string }>;
    };
  }).contentEvidence;

  assert.ok(evidence.passages.length >= 2);
  assert.ok(evidence.passages.some((passage) =>
    passage.startChar > 600 && passage.text.includes("TAIL_EVIDENCE_FOR_RESEARCH")
  ));
});

test("web_fetch exposes freshness controls and auto-refreshes latest missions", async () => {
  let now = new Date("2026-07-10T12:00:00.000Z");
  let transportCalls = 0;
  const { context } = createWebContext(() => now, async () => {
    transportCalls += 1;
    return {
      status: 200,
      headers: {},
      json: {
        title: "Fresh source",
        content: `fresh response ${transportCalls}`,
        links: [],
      },
    };
  });
  await writeSourceCacheNote(context, {
    url: "https://example.com/current",
    title: "Cached source",
    content: "cached response",
  });

  const properties = webFetchTool.parameters.properties ?? {};
  assert.ok(properties.refresh);
  assert.ok(properties.max_age_ms);
  assert.ok(properties.query);

  context.originalPrompt = "What is the latest status of this project?";
  const refreshed = await webFetchTool.execute(
    { url: "https://example.com/current" },
    context,
  ) as { fromCache: boolean; content: string; parserStatus: string };
  assert.equal(refreshed.fromCache, false);
  assert.equal(refreshed.content, "fresh response 1");
  assert.equal(refreshed.parserStatus, "parsed");
  assert.equal(transportCalls, 1);

  context.originalPrompt = "Use the stable cached source.";
  const cached = await webFetchTool.execute(
    {
      url: "https://example.com/current",
      refresh: false,
      max_age_ms: 60_000,
    },
    context,
  ) as { fromCache: boolean; contentHash: string };
  assert.equal(cached.fromCache, true);
  assert.match(cached.contentHash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(transportCalls, 1);

  now = new Date(now.getTime() + 61_000);
  const stale = await webFetchTool.execute(
    {
      url: "https://example.com/current",
      refresh: false,
      max_age_ms: 60_000,
    },
    context,
  ) as { fromCache: boolean; content: string };
  assert.equal(stale.fromCache, false);
  assert.equal(stale.content, "fresh response 2");
  assert.equal(transportCalls, 2);
});

test("web_fetch uses the provider-neutral companion fallback for an unparsed page", async () => {
  const originalFetch = globalThis.fetch;
  const bootstrapToken = "research-fallback-bootstrap-token-0123456789abcdef";
  const disconnectCompanion = installCompanionBootstrapSessionV1({
    version: 1,
    baseUrl: "http://127.0.0.1:8765",
    credential: createSessionBootstrapTokenLeaseV1(bootstrapToken),
    connectedAt: "2026-07-10T12:00:00.000Z",
  });
  const companionCalls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    companionCalls.push(url);
    assert.equal(
      new Headers(init?.headers).get("authorization"),
      `Bearer ${bootstrapToken}`,
    );
    if (url.endsWith("/health")) {
      return new Response(
        JSON.stringify({
          ok: true,
          service: "test",
          browserReady: true,
          memoryReady: false,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/browser/open")) {
      assertSignedBrowserRequest(init, "navigate");
      return new Response(
        JSON.stringify({
          url: "https://example.com/unparsed",
          title: "Fallback source",
          text: "",
          candidates: [],
          pageStateHints: [],
          observedAt: "2026-07-10T12:00:00.000Z",
          observationFingerprint: `sha256:${"d".repeat(64)}`,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    if (url.endsWith("/browser/extract_markdown")) {
      assertSignedBrowserRequest(init, "extract");
      return new Response(
        JSON.stringify({
          url: "https://example.com/unparsed",
          title: "Fallback source",
          markdown:
            "The companion browser extracted a detailed primary passage with enough concrete context to verify the requested claim and cite it truthfully in the final synthesis.",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  try {
    const { context } = createWebContext(
      () => new Date("2026-07-10T12:00:00.000Z"),
      async (request) => {
        if (request.url.endsWith("/web_search")) {
          return { status: 200, headers: {}, json: { results: [] } };
        }
        return {
          status: 200,
          headers: {},
          json: { title: "Unparsed", content: "", links: [] },
        };
      },
    );
    Object.assign(context.settings, {
      companionBaseUrl: "http://127.0.0.1:8765",
      browserToolsEnabled: true,
      experienceMemoryEnabled: false,
      defaultBrowserMissionMode: "extract_only",
    });
    const result = (await webFetchTool.execute(
      {
        url: "https://example.com/unparsed",
        refresh: true,
        query: "requested claim",
      },
      context,
    )) as {
      fallbackUsed: boolean;
      retrievalStrategy: string;
      content: string;
    };

    assert.equal(result.fallbackUsed, true);
    assert.equal(result.retrievalStrategy, "browser_extract");
    assert.match(result.content, /companion browser extracted/i);
    assert.ok(companionCalls.some((url) => url.endsWith("/browser/extract_markdown")));
  } finally {
    disconnectCompanion();
    globalThis.fetch = originalFetch;
  }
});

function assertSignedBrowserRequest(init: RequestInit | undefined, action: string): void {
  const body = JSON.parse(String(init?.body ?? "{}")) as {
    safetyDecision?: {
      action?: string;
      payloadFingerprint?: string;
      policyFingerprint?: string;
      signature?: string;
    };
  };
  assert.equal(body.safetyDecision?.action, action);
  assert.match(body.safetyDecision?.payloadFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(body.safetyDecision?.policyFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
  assert.match(body.safetyDecision?.signature ?? "", /^hmac-sha256:[a-f0-9]{64}$/u);
}

function createWebContext(
  now: () => Date,
  httpTransport: ToolExecutionContext["httpTransport"],
) {
  const content = new Map<string, string>();
  const folders = new Set<string>();
  const getFile = (path: string) => content.has(path)
    ? {
        path,
        basename: path.split("/").pop()?.replace(/\.[^.]+$/i, "") ?? path,
        extension: path.split(".").pop()?.toLowerCase() ?? "",
      }
    : null;
  const app = {
    vault: {
      getFileByPath: getFile,
      getFolderByPath: (path: string) => folders.has(path)
        ? { path, name: path.split("/").pop() ?? path }
        : null,
      createFolder: async (path: string) => {
        folders.add(path);
      },
      create: async (path: string, data: string) => {
        content.set(path, data);
        return getFile(path);
      },
      modify: async (file: { path: string }, data: string) => {
        content.set(file.path, data);
      },
      read: async (file: { path: string }) => {
        const value = content.get(file.path);
        if (value === undefined) {
          throw new Error(`File not found: ${file.path}`);
        }
        return value;
      },
      getFiles: () => [...content.keys()]
        .map((path) => getFile(path))
        .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    },
  };
  const context = {
    app: app as never,
    settings: {
      ollamaBaseUrl: "https://ollama.com/api",
      ollamaApiKey: "test-key",
      requestTimeoutMs: 60_000,
    } as never,
    originalPrompt: "Use the cached source.",
    httpTransport,
    now,
  } as unknown as ToolExecutionContext;
  return { context, content, folders };
}

test("mission-specific decomposition splits compare and risks with limitations", () => {
  const plan = createResearchPlan({
    prompt: "Compare A vs B and list risks?",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });

  assert.ok(plan);
  assert.equal(plan.mode, "deep_web");
  const questions = plan.subquestions.map((item) => item.question.toLowerCase());
  assert.ok(
    questions.some((item) => item.includes("compare") && item.includes("a") && item.includes("b")),
    `expected compare subquestion, got: ${questions.join(" | ")}`,
  );
  assert.ok(
    questions.some((item) => item.includes("risk")),
    `expected risks subquestion, got: ${questions.join(" | ")}`,
  );
  assert.ok(
    questions.some((item) => item.includes("limitation") || item.includes("confidence")),
    `expected limitations/confidence subquestion, got: ${questions.join(" | ")}`,
  );
  assert.ok(plan.subquestions.length >= 3 && plan.subquestions.length <= 8);
  assert.ok(
    plan.subquestions.every((item) => item.evidenceIds.length === 0),
    "evidence binding APIs remain empty until applyResearchEvidence",
  );
});

test("plain deep research topic still produces bounded useful defaults", () => {
  const plan = createResearchPlan({
    prompt: "deep research topic solid-state batteries",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });

  assert.ok(plan);
  assert.equal(plan.mode, "deep_web");
  assert.ok(plan.subquestions.length >= 2 && plan.subquestions.length <= 8);
  assert.ok(
    plan.subquestions.some((item) =>
      /solid-state batteries/i.test(item.question),
    ),
  );
  assert.ok(
    plan.subquestions.some((item) =>
      /\blimitations?\b|\bconfidence\b/i.test(item.question),
    ),
  );
  const decomposed = decomposePromptIntoResearchQuestions(
    "deep research topic solid-state batteries",
  );
  assert.equal(decomposed.length, 0);
});

test("deep research explicitly scoped across the vault stays vault-only", () => {
  const plan = createResearchPlan({
    prompt:
      "Take 16 model steps at most to do deep research across my vault. Use semantic retrieval, batch-read only returned paths, and append a grounded synthesis to the current note. Do not use web or memory tools.",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_vault_context",
    },
  });

  assert.ok(plan);
  assert.equal(plan.mode, "deep_vault");
  assert.equal(plan.sourceRequirements.minFetchedSources, 0);
  assert.equal(plan.sourceRequirements.minDistinctDomains, 0);
});

test("explicit source cardinality overrides the deep-research default without reading claim counts", () => {
  assert.equal(
    parseExplicitResearchSourceCount(
      "Fetch both returned sources and verify exactly two finding sentences.",
    ),
    2,
  );
  assert.equal(
    parseExplicitResearchSourceCount(
      "Verify exactly two finding sentences against the available evidence.",
    ),
    null,
  );
  const plan = createResearchPlan({
    prompt:
      "Do deep research using exactly two owned sources and cite their passages.",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });
  assert.ok(plan);
  assert.equal(plan.sourceRequirements.minFetchedSources, 2);
  assert.equal(plan.sourceRequirements.minDistinctDomains, 2);
});

test("bounded two-claim verification does not inherit the deep-research three-source floor", () => {
  const plan = createResearchPlan({
    prompt:
      "Search the web, fetch the returned owned sources, and verify two claims against their passages.",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });

  assert.equal(plan, null);
});

test("current-note sourced writeback is not misclassified as current-events deep research", () => {
  const plan = createResearchPlan({
    prompt:
      "Search the web, fetch both returned sources, verify exactly two finding sentences against their fetched passages, then append a short cited synthesis to the current note. End each sentence with the exact source passage identifier.",
    missionIntent: researchIntent(),
    runPlan: {
      route: "grounded_workflow",
      slowPathReason: "needs_web_sources",
    },
  });

  assert.equal(plan, null);
});

function researchIntent() {
  return {
    mode: "vault_context_answer" as const,
    vaultContext: true,
    noteOutput: false,
    explicitPersistence: false,
    explicitMutation: false,
    explicitDelete: false,
    allowAutonomousWrite: false,
    requireWriteCompletion: false,
    autonomyScope: {
      read: { currentNote: false, vault: false, folders: [], files: [], web: true },
      write: {
        currentNote: false,
        folders: [],
        files: [],
        artifacts: false,
        researchMemory: false,
      },
      destructive: {
        replaceCurrentNote: false,
        deleteCurrentNote: false,
        deletePaths: false,
      },
    },
  };
}
