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

test("a route that cannot afford a fan-out does not allow host follow-ups", () => {
  // This used to assert `instant.allowsAutoFollowups === false` -- a constant
  // compared to itself, which passed while the runner ignored the flag
  // entirely. State the rule instead: auto follow-ups spend extra tool calls
  // inside one step, so only a route budgeted for more than a single tool call
  // may have them.
  const routes = [
    "instant_local",
    "direct_writeback",
    "prefetched_vault_answer",
    "prefetched_vault_writeback",
    "single_model_answer",
    "single_model_writeback",
    "tool_required",
    "grounded_workflow",
  ] as const;
  for (const route of routes) {
    const profile = getRunBudgetProfile(route);
    assert.equal(
      profile.allowsAutoFollowups,
      profile.defaultToolSteps > 1,
      `${route} follow-up posture must match its tool budget`,
    );
  }

  const grounded = getRunBudgetProfile("grounded_workflow");
  assert.equal(grounded.expectedTimeClass, "long");
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

test("keyword vault search now schedules body reads of its own results", () => {
  // The regression this pins: `planReadOnlyFollowups` handled only
  // `semantic_search_notes`, so a `search_markdown_files` answer could be
  // written entirely from snippets with no note ever opened.
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "search_markdown_files",
    lastToolResult: {
      output: {
        operation: "search_markdown_files",
        results: [
          { path: "Research/Onboarding.md", score: 12 },
          { path: "Research/Retention.md", score: 8 },
        ],
      },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 2,
  });
  assert.deepEqual(plan, [
    {
      toolName: "read_file",
      args: { path: "Research/Onboarding.md", maxChars: 6000 },
      reason: "auto_read_vault_search_result_for_body_proof",
    },
    {
      toolName: "read_file",
      args: { path: "Research/Retention.md", maxChars: 6000 },
      reason: "auto_read_vault_search_result_for_body_proof",
    },
  ]);
});

test("vault body reads no longer depend on the mission saying 'my notes'", () => {
  // Previously `needsVaultRead` required acceptance to already name vault
  // evidence or the prompt to contain vault vocabulary, so an ordinary
  // question surfaced paths and then answered from snippets.
  const plan = planReadOnlyFollowups({
    mission: "Summarize what I know about controlled onboarding validation.",
    lastToolName: "semantic_search_notes",
    lastToolResult: {
      output: { results: [{ path: "Notes/Alpha.md" }] },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 3,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0]?.args.path, "Notes/Alpha.md");
});

test("a note already read is not re-read when the separator differs", () => {
  const plan = planReadOnlyFollowups({
    mission: "Summarize my onboarding findings.",
    lastToolName: "semantic_search_notes",
    lastToolResult: {
      output: { results: [{ path: "Notes/Alpha.md" }, { path: "Notes/Beta.md" }] },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [["Notes", "Alpha.md"].join(String.fromCharCode(92))],
    maxFollowups: 3,
  });
  assert.deepEqual(
    plan.map((request) => request.args.path),
    ["Notes/Beta.md"],
  );
});

test("a degraded semantic search is corroborated by a full-vault keyword scan", () => {
  // The gap this closes: `classifySemanticRetrievalHealthV1` has always
  // reported `requiresKeywordCorroboration` on a lexical fallback and nothing
  // acted on it, so the answer rested entirely on a ranking produced by
  // chunk scoring over at most the first MAX_LISTED_FILES notes.
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "semantic_search_notes",
    lastToolQuery: "onboarding conclusions",
    requiresKeywordCorroboration: true,
    lastToolResult: {
      output: {
        mode: "lexical_fallback",
        fallbackUsed: true,
        results: [{ path: "Notes/Alpha.md" }, { path: "Notes/Beta.md" }],
      },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 3,
  });
  assert.deepEqual(plan, [
    {
      toolName: "search_markdown_files",
      args: { query: "onboarding conclusions" },
      reason: "auto_keyword_corroboration_for_degraded_semantic_search",
    },
    {
      toolName: "read_file",
      args: { path: "Notes/Alpha.md", maxChars: 6000 },
      reason: "auto_read_vault_search_result_for_body_proof",
    },
    {
      toolName: "read_file",
      args: { path: "Notes/Beta.md", maxChars: 6000 },
      reason: "auto_read_vault_search_result_for_body_proof",
    },
  ]);
});

test("a healthy semantic search is not corroborated", () => {
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "semantic_search_notes",
    lastToolQuery: "onboarding conclusions",
    lastToolResult: {
      output: { mode: "hybrid_semantic", results: [{ path: "Notes/Alpha.md" }] },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 3,
  });
  assert.deepEqual(
    plan.map((request) => request.toolName),
    ["read_file"],
  );
});

test("a keyword search never corroborates itself", () => {
  // The corroborating scan is itself a vault search, so the host re-enters the
  // planner with its result. Without this guard that re-entry would schedule
  // another identical scan.
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "search_markdown_files",
    lastToolQuery: "onboarding conclusions",
    requiresKeywordCorroboration: true,
    lastToolResult: { output: { results: [{ path: "Notes/Alpha.md" }] } },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 3,
  });
  assert.deepEqual(
    plan.map((request) => request.toolName),
    ["read_file"],
  );
});

test("corroboration is dropped rather than guessed when no query is known", () => {
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "semantic_search_notes",
    requiresKeywordCorroboration: true,
    lastToolResult: { output: { results: [{ path: "Notes/Alpha.md" }] } },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 3,
  });
  assert.deepEqual(
    plan.map((request) => request.toolName),
    ["read_file"],
  );
});

test("corroboration takes a follow-up slot rather than raising the budget", () => {
  const plan = planReadOnlyFollowups({
    mission: "What did I conclude about onboarding?",
    lastToolName: "semantic_search_notes",
    lastToolQuery: "onboarding",
    requiresKeywordCorroboration: true,
    lastToolResult: {
      output: {
        results: [
          { path: "Notes/Alpha.md" },
          { path: "Notes/Beta.md" },
          { path: "Notes/Gamma.md" },
        ],
      },
    },
    acceptanceNeeds: [],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 2,
  });
  assert.equal(plan.length, 2);
  assert.deepEqual(
    plan.map((request) => request.toolName),
    ["search_markdown_files", "read_file"],
  );
});
