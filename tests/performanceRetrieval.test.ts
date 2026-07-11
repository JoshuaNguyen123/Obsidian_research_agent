import test from "node:test";
import assert from "node:assert/strict";
import { planReadOnlyFollowups } from "../src/agent/autoFollowups";
import { evaluatePerformanceGates } from "../src/agent/performanceGates";
import { getRunBudgetProfile } from "../src/agent/runBudget";
import { summarizeToolOutput } from "../src/model/toolResultPayload";
import {
  filterUserMarkdownPaths,
  isGeneratedOrCachePath,
  isPathUnderVaultFolder,
  isSourceCachePath,
  isVaultPathExcluded,
} from "../src/tools/vaultExclusions";

test("run budget profiles expose bounded followup posture per route", () => {
  const instant = getRunBudgetProfile("instant_local");
  assert.equal(instant.defaultToolSteps, 0);
  assert.equal(instant.allowsAutoFollowups, false);

  const grounded = getRunBudgetProfile("grounded_workflow");
  assert.equal(grounded.expectedTimeClass, "long");
  assert.equal(grounded.allowsAutoFollowups, true);
  assert.ok(grounded.defaultToolSteps > 0);
});

test("auto followup planner schedules next cached source section read-only", () => {
  const plan = planReadOnlyFollowups({
    mission: "Use sources for this answer.",
    lastToolName: "web_fetch",
    lastToolResult: {
      output: {
        url: "https://example.com/a",
        cachedPath: "Agent Sources/example.com/A.md",
        section: 1,
        sectionCount: 2,
      },
    },
    acceptanceNeeds: ["fetched_sources:1/2"],
    alreadyFetchedUrls: ["https://example.com/a"],
    alreadyReadPaths: [],
    maxFollowups: 2,
  });

  assert.deepEqual(plan, [
    {
      toolName: "read_source_section",
      args: { path: "Agent Sources/example.com/A.md", section: 2 },
      reason: "auto_read_next_cached_source_section",
    },
  ]);
});

test("auto followup planner fetches a searched URL that has not been fetched", () => {
  const plan = planReadOnlyFollowups({
    mission: "Use sources for this answer.",
    lastToolName: "web_search",
    lastToolResult: {
      output: {
        results: [
          { url: "https://example.com/first" },
          { url: "https://example.com/second" },
        ],
      },
    },
    acceptanceNeeds: ["web_evidence"],
    alreadyFetchedUrls: ["https://example.com/first"],
    alreadyReadPaths: [],
    maxFollowups: 2,
  });

  assert.deepEqual(plan, [
    {
      toolName: "web_fetch",
      args: { url: "https://example.com/second" },
      reason: "auto_fetch_search_result_for_source_proof",
    },
  ]);
});

test("auto followup planner ranks mission-relevant search results ahead of provider order", () => {
  const plan = planReadOnlyFollowups({
    mission: "E2E_QUOTE_VERIFY_MISSION quote the quotation and cite its passage.",
    lastToolName: "web_search",
    lastToolResult: {
      output: {
        results: [
          {
            title: "Unrelated alpha result",
            url: "https://alpha.example.com/deep-source",
            snippet: "General background material.",
          },
          {
            title: "E2E Quote Verify Source",
            url: "https://example.com/e2e-quote-verify-source",
            snippet: "E2E_QUOTE_VERIFY_MISSION quotation source.",
          },
        ],
      },
    },
    acceptanceNeeds: ["web_evidence"],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 1,
  });

  assert.deepEqual(plan, [
    {
      toolName: "web_fetch",
      args: { url: "https://example.com/e2e-quote-verify-source" },
      reason: "auto_fetch_search_result_for_source_proof",
    },
  ]);
});

test("performance gates escalate from warn to fail", () => {
  const warn = evaluatePerformanceGates([
    {
      kind: "model_chat",
      durationMs: 130000,
    } as never,
  ]);
  assert.equal(warn.find((finding) => finding.name === "model_call_latency")?.status, "warn");

  const fail = evaluatePerformanceGates(
    [
      {
        kind: "tool",
        durationMs: 30000,
      } as never,
    ],
    [{ name: "tool_latency_strict", metric: "tool_ms", warnAt: 1000, failAt: 10000 }],
  );
  assert.equal(fail[0].status, "fail");
});

test("model-facing tool payload summarizer bounds arrays, objects, and strings", () => {
  const payload = summarizeToolOutput("semantic_search_notes", {
    ok: true,
    toolName: "semantic_search_notes",
    output: {
      results: Array.from({ length: 20 }, (_, index) => ({
        path: `Notes/${index}.md`,
        snippet: "x".repeat(1000),
      })),
    },
  });

  assert.equal(payload.truncated, true);
  assert.equal((payload.output as { results: unknown[] }).results.length, 8);
  assert.match(
    ((payload.output as { results: Array<{ snippet: string }> }).results[0].snippet),
    /\[truncated\]/,
  );
});

test("vault exclusion helper keeps generated/cache paths out of user retrieval", () => {
  assert.equal(isGeneratedOrCachePath("Agent Sources/example.com/A.md"), true);
  assert.equal(isVaultPathExcluded(".obsidian/plugins/config.md"), true);
  assert.equal(isVaultPathExcluded("Notes/User.md"), false);
  assert.equal(isSourceCachePath("Agent Sources/example.com/A.md"), true);
  assert.equal(isPathUnderVaultFolder("Projects/Agent Memory/index.md", "Projects/Agent Memory"), true);
  assert.deepEqual(
    filterUserMarkdownPaths([
      "Notes/User.md",
      "Agent Sources/example.com/A.md",
      "Agent Memory/Semantic Vault Index.md",
      "Assets/image.png",
    ]),
    ["Notes/User.md"],
  );
});
