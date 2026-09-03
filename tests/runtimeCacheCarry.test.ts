import assert from "node:assert/strict";
import test from "node:test";
import {
  createCarriedRuntimeCacheV1,
  isCarriedToolResultKeyV1,
} from "../src/agent/runtimeCacheCarry";
import type { AgentRuntimeCache, ToolExecutionResult } from "../src/tools/types";

/*
 * Cross-segment runtime cache carry.
 *
 * A continuation segment of the same root mission starts with the previous
 * segment's immutable web results instead of an empty cache, and with nothing
 * else: vault and workspace observations may be stale by the next segment.
 */

const ok = (toolName: string, output: unknown): ToolExecutionResult => ({
  ok: true,
  toolName,
  output,
});

test("only web_fetch and web_search cache keys are carried", () => {
  assert.equal(isCarriedToolResultKeyV1('web_fetch:{"url":"https://a"}'), true);
  assert.equal(isCarriedToolResultKeyV1('web_search:{"query":"x"}'), true);
  assert.equal(isCarriedToolResultKeyV1('read_current_file:{"maxChars":1}'), false);
  assert.equal(isCarriedToolResultKeyV1('search_markdown_files:{"query":"x"}'), false);
});

test("a carried cache keeps immutable web results and drops everything segment-scoped", () => {
  const previous: AgentRuntimeCache = {
    toolResults: new Map<string, ToolExecutionResult>([
      ['web_fetch:{"url":"https://a"}', ok("web_fetch", { url: "https://a" })],
      ['web_search:{"query":"q"}', ok("web_search", { results: [] })],
      ['read_current_file:{}', ok("read_current_file", { content: "stale" })],
      [
        'web_fetch:{"url":"https://broken"}',
        { ok: false, toolName: "web_fetch", output: null, error: { code: "x", message: "x" } },
      ],
    ]),
    trustedWebFetchResults: new Map([
      ["https://a:sha256:" + "a".repeat(64), ok("web_fetch", { url: "https://a" })],
    ]),
    verifiedWorkspaceReads: new Map([["ws:file", {} as never]]),
    verifiedMermaidRead: {} as never,
    latestFastValidationDiagnostic: {} as never,
    passedFastRepairCycle: true,
    projectIdeaBrief: {} as never,
  };

  const next = createCarriedRuntimeCacheV1(previous);

  assert.deepEqual(
    [...next.toolResults.keys()].sort(),
    ['web_fetch:{"url":"https://a"}', 'web_search:{"query":"q"}'],
    "vault reads and failed fetches do not carry",
  );
  assert.equal(next.trustedWebFetchResults?.size, 1);
  assert.equal(next.verifiedWorkspaceReads?.size, 0);
  assert.equal(next.verifiedMermaidRead, undefined);
  assert.equal(next.latestFastValidationDiagnostic, undefined);
  assert.equal(next.passedFastRepairCycle, undefined);
  assert.equal(next.projectIdeaBrief, undefined);
  // Fresh containers: mutating the carried cache leaves the old one alone.
  next.toolResults.clear();
  assert.equal(previous.toolResults.size, 4);
});

test("no previous cache yields an empty cache with every container present", () => {
  const fresh = createCarriedRuntimeCacheV1(null);
  assert.equal(fresh.toolResults.size, 0);
  assert.equal(fresh.trustedWebFetchResults?.size, 0);
  assert.equal(fresh.verifiedWorkspaceReads?.size, 0);
});
