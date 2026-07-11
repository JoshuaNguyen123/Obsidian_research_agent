import test from "node:test";
import assert from "node:assert/strict";
import { createAgentBudget, FINALIZATION_RESERVE_STEPS } from "../src/agent/AgentBudget";
import { CompanionClient } from "../src/agent/CompanionClient";
import { SafetyPolicy } from "../src/agent/SafetyPolicy";
import {
  addMissionMilestone,
  createMissionLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
} from "../src/agent/missionLedger";
import { CanvasWriter } from "../src/agent/design/CanvasWriter";
import type { ToolExecutionContext } from "../src/tools/types";

test("agent budget clamps explicit requests to 100 and preserves reserve", () => {
  const budget = createAgentBudget({
    route: "long_research",
    explicitStepRequest: 999,
  });

  assert.equal(budget.maxSteps, 100);
  assert.equal(budget.finalizationReserve, FINALIZATION_RESERVE_STEPS);
  assert.equal(budget.workingSteps, 96);
});

test("agent budget delegates legacy long routes to runtime grounded cap", () => {
  assert.equal(createAgentBudget({ route: "long_research" }).maxSteps, 100);
  assert.equal(createAgentBudget({ route: "browser_learning" }).maxSteps, 100);
  assert.equal(createAgentBudget({ route: "design_package" }).maxSteps, 100);
});

test("safety policy allows observation and blocks unsafe browser conditions", () => {
  const policy = new SafetyPolicy();
  const base = {
    isDesktop: true,
    browserToolsEnabled: true,
    experienceMemoryEnabled: true,
    companionHealthy: true,
  };

  assert.equal(policy.evaluateLowRiskObservation(base).status, "allow");
  assert.equal(policy.evaluateLowRiskObservation({ ...base, isDesktop: false }).status, "block");
  assert.equal(
    policy.evaluateLowRiskObservation({ ...base, companionHealthy: false }).status,
    "block",
  );
  assert.equal(
    policy.evaluateBrowserOpen({ url: "javascript:alert(1)" }, base).status,
    "block",
  );
  assert.equal(
    policy.evaluateBrowserOpen({ url: "file:///tmp/page.html" }, base).status,
    "block",
  );
  assert.equal(
    policy.evaluateBrowserOpen({ url: "https://example.com" }, base).status,
    "allow",
  );
});

test("safety policy requires approval for reversible high-risk actions and blocks credentials", () => {
  const policy = new SafetyPolicy();
  const base = {
    isDesktop: true,
    browserToolsEnabled: true,
    experienceMemoryEnabled: true,
    companionHealthy: true,
  };

  assert.equal(
    policy.evaluateBrowserClick({}, { ...base, candidateLabel: "Delete account" }).status,
    "require_approval",
  );
  assert.equal(
    policy.evaluateBrowserClick(
      {},
      { ...base, candidateLabel: "Submit draft", explicitUserApproval: true },
    ).status,
    "allow",
  );
  assert.equal(
    policy.evaluateBrowserClick(
      {},
      { ...base, candidateLabel: "Checkout", explicitUserApproval: true },
    ).status,
    "block",
  );
  assert.equal(
    policy.evaluateBrowserType({ text: "my password", selector: "#search" }, base).status,
    "block",
  );
});

test("companion client parses health, browser observation, and memory responses", async () => {
  const fetchImpl: typeof fetch = async (url, init) => {
    const path = String(url).replace("http://127.0.0.1:8765", "");
    if (path === "/health") {
      return jsonResponse({
        ok: true,
        service: "obsidian-research-companion",
        browserReady: true,
        memoryReady: true,
      });
    }
    if (path === "/browser/observe") {
      return jsonResponse({
        url: "https://example.com",
        title: "Example",
        candidates: [],
        pageStateHints: [],
        observedAt: "2026-07-05T00:00:00Z",
      });
    }
    if (path === "/memory/write") {
      assert.equal(init?.method, "POST");
      return jsonResponse({ id: "mem-1" });
    }
    if (path === "/memory/search") {
      return jsonResponse({ results: [] });
    }
    return new Response("missing", { status: 404 });
  };

  const client = new CompanionClient("http://127.0.0.1:8765", 100, fetchImpl);
  assert.equal((await client.health()).ok, true);
  assert.equal((await client.observe()).title, "Example");
  assert.deepEqual(
    await client.writeMemory({
      kind: "episodic",
      content: "Observed a page.",
      confidence: 0.9,
    }),
    { id: "mem-1" },
  );
  assert.deepEqual(await client.searchMemory({ query: "page" }), { results: [] });
});

test("companion client formats HTTP errors and aborts timed out requests", async () => {
  const failing = new CompanionClient("http://127.0.0.1:8765", 100, async () =>
    new Response("bad gateway", { status: 502 }),
  );
  await assert.rejects(() => failing.health(), /Companion request failed: 502 bad gateway/);

  const hanging = new CompanionClient(
    "http://127.0.0.1:8765",
    1,
    (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      }),
  );
  await assert.rejects(() => hanging.health(), /aborted/);
});

test("mission ledger serializes milestones while parsing older ledgers", () => {
  const ledger = createMissionLedger({
    runId: "run:web",
    mission: "Long research mission.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 60,
      toolStepBudget: 56,
      finalizationReserve: 4,
      expectedTools: ["web_search"],
      stopWhenSatisfied: false,
    },
    now: new Date("2026-07-05T00:00:00Z"),
  });
  addMissionMilestone(ledger, {
    step: 1,
    stage: "gather",
    summary: "Fetched first source.",
    toolCalls: ["web_fetch"],
  });

  const parsed = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(ledger));
  assert.equal(parsed?.milestones.length, 2);
  assert.equal(parsed?.milestones[1].stage, "gather");

  const old = JSON.parse(JSON.stringify(ledger));
  delete old.milestones;
  const oldParsed = parseMissionLedgerFromMarkdown([
    "## Mission Ledger",
    "```json",
    JSON.stringify(old),
    "```",
  ].join("\n"));
  assert.deepEqual(oldParsed?.milestones, []);
});

test("design package writer creates unique canvas and markdown brief safely", async () => {
  const mock = createMockVault();
  const writer = new CanvasWriter(mock.vault as never);
  const input = {
    title: "Checkout Service Blueprint",
    kind: "service_blueprint" as const,
    targetFolder: "Design Packages",
    items: [
      {
        id: "persona",
        kind: "persona" as const,
        title: "Buyer",
        summary: "Customer placing an order.",
      },
      {
        id: "screen",
        kind: "screen" as const,
        title: "Checkout",
        summary: "Payment and shipping screen.",
      },
    ],
    edges: [{ id: "edge-1", from: "persona", to: "screen", label: "uses" }],
  };

  const first = await writer.createPackage(input);
  const second = await writer.createPackage(input);

  assert.equal(first.canvasPath, "Design Packages/checkout-service-blueprint.canvas");
  assert.equal(first.briefPath, "Design Packages/checkout-service-blueprint.md");
  assert.equal(second.canvasPath, "Design Packages/checkout-service-blueprint-2.canvas");
  assert.ok(JSON.parse(mock.files.get(first.canvasPath) ?? "").nodes.length >= 2);
  assert.match(mock.files.get(first.briefPath) ?? "", /Checkout Service Blueprint/);
  assert.match(mock.files.get(first.briefPath) ?? "", /persona -> screen: uses/);
  await assert.rejects(
    () => writer.createPackage({ ...input, targetFolder: "../Unsafe" }),
    /parent traversal|Unsafe path/,
  );
});

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function createMockVault() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const vault = {
    getAbstractFileByPath(path: string) {
      if (files.has(path)) {
        return {
          path,
          extension: path.split(".").pop() ?? "",
        };
      }
      if (folders.has(path)) {
        return { path };
      }
      return null;
    },
    createFolder: async (path: string) => {
      folders.add(path);
    },
    create: async (path: string, content: string) => {
      files.set(path, content);
      return {
        path,
        extension: path.split(".").pop() ?? "",
      };
    },
  };
  return { vault, files, folders };
}

void ({} satisfies Partial<ToolExecutionContext>);
