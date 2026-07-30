import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  assertDemoFrameCleanV1,
  assertDemoPresentationObserverSettlesV1,
  prepareDemoFinaleV1,
  prepareDemoPresentationV1,
  recordDemoMomentV1,
} from "./fixtures/demoPresentation";
import {
  installDemoPublicSourceBoundaryV1,
  readDemoPublicSourceMetricsV1,
  restoreDemoPublicSourceBoundaryV1,
} from "./fixtures/demoPublicSources";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
  type RealAiHarness,
} from "./fixtures/realAiHarness";

/**
 * RESEARCHER DEMO RECORDING DRIVER — not a proof lane.
 *
 * This lane records a concise, genuine source-to-note mission using the same
 * production model, public web tools, vault write path, receipt readback, and
 * completion attestation as the proof lanes. It changes presentation only.
 */

const LANE = "demo-journey-recording";
const DEMO_NOTE_TITLE = "Choosing a note-search index";
const DEMO_NOTE_PATH = `${DEMO_NOTE_TITLE}.md`;
const DEMO_SOURCE_URLS = [
  "https://nlp.stanford.edu/IR-book/html/htmledition/k-gram-indexes-for-spelling-correction-1.html",
  "https://nlp.stanford.edu/IR-book/html/htmledition/search-structures-for-dictionaries-1.html",
] as const;
const DEMO_PROMPT =
  "Open the two source URLs under Reading list in this note and use only those two public pages. Then append a compact result: ## Recommendation, two one-sentence bullets with one source URL each formatted as [source name](URL), one Trade-off: sentence, ## Limitations, and one brief sentence noting that the pages cover different parts of the decision. Use six non-empty Markdown lines, stay under 1200 characters, do not repeat any existing note text, and omit internal evidence IDs.";

test("DEMO researcher mission appends a cited recommendation with verified sources", async (
  {},
  testInfo,
) => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(
    !laneSelectedV1(LANE),
    `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`,
  );
  test.skip(
    process.env.E2E_AI_MODE !== "real" || process.env.E2E_REAL_AI !== "1",
    "Requires E2E_REAL_AI=1 and E2E_AI_MODE=real.",
  );
  test.setTimeout(18 * 60_000);

  const startedAt = Date.now();
  let harness: RealAiHarness | null = null;

  try {
    harness = await startRealAiHarness(
      `demo-researcher-${startedAt}`,
      {
        missionTimeoutMs: 12 * 60_000,
        completionTimeoutMs: 12 * 60_000,
      },
      {
        maxAgentSteps: 32,
        maxRunMinutes: 12,
        requestTimeoutMs: 4 * 60_000,
        completionDrivenLoops: true,
        autoContinueLongRuns: true,
        workingMode: "automatic",
        autonomyProfile: "automatic",
        thinkingMode: "medium",
        orchestratorEnabled: false,
        githubEnabled: false,
        linearEnabled: false,
        linearCapabilityGate: 0,
      },
    );

    await assertProductionAdoptedSandboxV1(harness.page, startedAt);
    await installDemoPublicSourceBoundaryV1(
      harness.page,
      DEMO_SOURCE_URLS,
    );
    const original = [
      "Search in an 8,000-note vault is beginning to feel slow when a query only matches part of a word.",
      "",
      "## Decision criteria",
      "",
      "- Fast prefix lookup for commands, tags, and note titles.",
      "- Useful fallback when a query contains a misspelling.",
      "- Predictable local updates as notes change.",
      "",
      "## Question",
      "",
      "Should prefix search use the primary index, with fuzzy matching as a fallback?",
      "",
      "## Reading list",
      "",
      `- [Prefix search structures](${DEMO_SOURCE_URLS[1]})`,
      `- [Fuzzy matching with k-grams](${DEMO_SOURCE_URLS[0]})`,
      "",
    ].join("\n");
    await harness.seedNote(DEMO_NOTE_PATH, original, true);
    await harness.clearChat();
    await prepareDemoPresentationV1(harness.page, DEMO_NOTE_PATH);
    await assertDemoPresentationObserverSettlesV1(harness.page);
    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE, {
      requireSingleTitle: true,
    });
    await recordDemoMomentV1("researcher-ready", { notePath: DEMO_NOTE_PATH });
    await harness.page.waitForTimeout(1_500);

    await recordDemoMomentV1("researcher-submit", { prompt: DEMO_PROMPT });
    await harness.submitMission(DEMO_PROMPT, {
      clearChatFirst: false,
      waitForCompletion: false,
      timeoutMs: 12 * 60_000,
    });
    await harness.approveUntilMissionComplete(12 * 60_000, {
      maxContinuations: 4,
    });

    const after = await harness.readNote(
      path.join(harness.vaultRoot, ...DEMO_NOTE_PATH.split("/")),
    );
    const snapshot = await harness.attestProductionRun({
      requireStructuredRouting: true,
    });
    const publicSourceMetrics = await readDemoPublicSourceMetricsV1(
      harness.page,
    );
    const graphNodes = Object.values(snapshot.lastMissionGraph.nodes) as any[];
    const appendReceipts = snapshot.lastReceipts.filter(
      (receipt: any) => receipt.operation === "append",
    );
    const fetchedEvidence = snapshot.missionEvidence.filter(
      (item: any) =>
        item.kind === "web_source" &&
        item.usableSource === true &&
        item.parserStatus === "parsed",
    );
    const fetchedEvidenceIds = new Set<string>(
      fetchedEvidence.map((item: any) => String(item.id ?? "")).filter(Boolean),
    );
    const noteUrls = new Set(
      [...after.matchAll(/https?:\/\/[^\s)>\]"']+/gu)].map(
        (match) => match[0],
      ),
    );
    const appended = after.slice(original.length);
    const appendedWords = appended.trim().split(/\s+/u).filter(Boolean).length;
    const appendedNonEmptyLines = appended
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
    const recommendationBullets = appendedNonEmptyLines.slice(1, 3);
    const tradeOffLines = appendedNonEmptyLines.filter((line) =>
      /^(?:-\s*)?Trade-off:\s+/iu.test(line),
    );
    const appendedMarkdownUrls = new Set(
      [...appended.matchAll(/\[[^\]\r\n]+\]\((https?:\/\/[^)\s]+)\)/gu)].map(
        (match) => match[1],
      ),
    );
    const visiblePassageIds = [
      ...appended.matchAll(/source:[a-z0-9-]+:passage:\d+-\d+/gu),
    ].map((match) => match[0]);
    const safeState = {
      complete: snapshot.lastComplete,
      receiptOperations: snapshot.lastReceipts.map(
        (receipt: any) => receipt.operation,
      ),
      fetchedEvidence: snapshot.missionEvidence,
      noteUrls: [...noteUrls],
      appendedMarkdownUrls: [...appendedMarkdownUrls],
      visiblePassageIds,
      appendedChars: appended.length,
      appendedWords,
      appendedNonEmptyLines,
      publicSourceMetrics,
      graphTools: graphNodes.flatMap(
        (node: any) => node.allowedTools ?? [],
      ),
    };

    expect(after.startsWith(original), JSON.stringify(safeState)).toBe(true);
    expect(after, JSON.stringify(safeState)).toContain("## Recommendation");
    expect(after, JSON.stringify(safeState)).toMatch(/\btrade-off\b/iu);
    expect(fetchedEvidenceIds.size, JSON.stringify(safeState)).toBe(2);
    expect(noteUrls.size, JSON.stringify(safeState)).toBe(2);
    expect([...noteUrls].sort(), JSON.stringify(safeState)).toEqual(
      [...DEMO_SOURCE_URLS].sort(),
    );
    expect([...appendedMarkdownUrls].sort(), JSON.stringify(safeState)).toEqual(
      [...DEMO_SOURCE_URLS].sort(),
    );
    expect(visiblePassageIds, JSON.stringify(safeState)).toHaveLength(0);
    expect(appended.length, JSON.stringify(safeState)).toBeLessThanOrEqual(1200);
    expect(appendedNonEmptyLines, JSON.stringify(safeState)).toHaveLength(6);
    expect(appendedNonEmptyLines[0], JSON.stringify(safeState)).toBe(
      "## Recommendation",
    );
    expect(recommendationBullets, JSON.stringify(safeState)).toHaveLength(2);
    expect(
      recommendationBullets.every((line) => /^-\s+/u.test(line)),
      JSON.stringify(safeState),
    ).toBe(true);
    expect(tradeOffLines, JSON.stringify(safeState)).toHaveLength(1);
    expect(appendedNonEmptyLines[4], JSON.stringify(safeState)).toBe(
      "## Limitations",
    );
    expect(appendedNonEmptyLines[5], JSON.stringify(safeState)).toMatch(
      /\b(?:pages?|sources?)\b/iu,
    );
    for (const bullet of recommendationBullets) {
      expect(
        [...bullet.matchAll(/\[[^\]\r\n]+\]\((https?:\/\/[^)\s]+)\)/gu)],
        JSON.stringify(safeState),
      ).toHaveLength(1);
    }
    expect(
      new Set(publicSourceMetrics.fetchedUrls).size,
      JSON.stringify(safeState),
    ).toBe(2);
    expect(
      [...new Set(publicSourceMetrics.fetchedUrls)].sort(),
      JSON.stringify(safeState),
    ).toEqual([...noteUrls].sort());
    expect(
      publicSourceMetrics.allowedFetchTransportCalls,
      JSON.stringify(safeState),
    ).toBeGreaterThanOrEqual(2);
    expect(
      publicSourceMetrics.allowedFetchTransportCalls,
      JSON.stringify(safeState),
    ).toBeLessThanOrEqual(4);
    expect(
      publicSourceMetrics.searchTransportCalls,
      JSON.stringify(safeState),
    ).toBeLessThanOrEqual(3);
    expect(
      publicSourceMetrics.blockedFetchAttempts,
      JSON.stringify(safeState),
    ).toBe(0);
    expect(appendReceipts, JSON.stringify(safeState)).toHaveLength(1);
    expect(
      snapshot.lastReceipts.map((receipt: any) => receipt.operation),
      JSON.stringify(safeState),
    ).toEqual(["append"]);
    expect(
      appendReceipts[0]?.readback?.status,
      JSON.stringify(safeState),
    ).toBe("verified");
    expect(
      graphNodes.some((node: any) =>
        node.allowedTools?.includes("web_fetch"),
      ),
    ).toBe(true);
    await testInfo.attach("demo-researcher-proof", {
      body: JSON.stringify(safeState, null, 2),
      contentType: "application/json",
    });

    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE);
    await recordDemoMomentV1("researcher-note-verified", {
      sources: fetchedEvidenceIds.size,
      receipt: appendReceipts[0]?.readback?.status ?? "missing",
    });
    await harness.page.waitForTimeout(3_000);
    await prepareDemoFinaleV1(harness.page);
    await assertDemoFrameCleanV1(harness.page, DEMO_NOTE_TITLE);
    await recordDemoMomentV1("researcher-finale", { view: "run-details" });
  } finally {
    if (harness) {
      await restoreDemoPublicSourceBoundaryV1(harness.page).catch(
        () => undefined,
      );
    }
    await harness?.close().catch(() => undefined);
  }
});
