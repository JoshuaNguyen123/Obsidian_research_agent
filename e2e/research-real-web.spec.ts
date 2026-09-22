/**
 * Real-web research quality lane — OPT-IN, MEASUREMENT ONLY.
 *
 * Every other research lane stubs `/web_search` and `/web_fetch` through
 * `installOwnedWebBackend`, so a green research lane says nothing about real
 * web retrieval. This lane deliberately installs no owned backend: the
 * production plugin reaches the configured provider's `/web_search` and
 * `/web_fetch` through its own transport, and the sources it cites are
 * whatever the live web returned that day.
 *
 * Consequences, by design:
 *   - It costs real API budget (two ~15-minute missions). It is not part of
 *     the proof matrix and no package script other than
 *     `npm run test:e2e:research-real-web` runs it.
 *   - It is NON-DETERMINISTIC. Search results, page parsers, and the model's
 *     drafting all vary. Assertions are limited to what the product promises
 *     for a sourced mission — completion with one append receipt, at least
 *     two usable parsed web sources from at least two domains, every cited
 *     passage id bound to a fetched source, a limitations heading — never to
 *     a particular source, wording, or count beyond the prompt's floor.
 *   - Its mission scorecard is emitted like DU-02's so
 *     `npm run scorecards:harvest` can baseline it. Until the first harvest
 *     the scorecard is a DIAGNOSTIC: the first green run ends with the
 *     regression gate reporting "No mission-scorecard baseline exists for:
 *     research-real-web" after Playwright has passed; the run summary is
 *     already on disk at that point, so harvesting it creates the baseline
 *     and the next run compares against it.
 *
 * Read the acceptance tokens in `RESEARCH_WEB_01_ACCEPTANCE_TOKENS`
 * (src/agent/dailyUseAcceptance.ts) before widening any assertion here: a
 * harness pin on a live-web detail is a `harness:*` failure, not a product one.
 */
import { promptPrefixReuseAverageV1 } from "../src/model/modelCallEvidence";
import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import { recordToolCallOutcomesAfterEach } from "./fixtures/toolCallCollector";

recordToolCallOutcomesAfterEach();

const REAL_WEB_PROMPTS: ReadonlyArray<{ label: string; prompt: string }> = [
  {
    label: "STEM",
    prompt:
      "Write a 300-word cited summary of how CRISPR base editing differs from prime editing, with at least 3 sources from at least 2 domains and a limitations section. Append it to the current note.",
  },
  {
    label: "policy-economics",
    prompt:
      "Write a 300-word cited summary of how carbon border adjustment mechanisms are expected to affect trade in steel and cement, with at least 3 sources from at least 2 domains and a limitations section. Append it to the current note.",
  },
];

test.describe("Real-web research quality lane", () => {
  // Sized to the step budget the product actually grants. A three-source cited
  // summary is funded for 14 tool steps plus a finalization reserve, and the
  // 2026-09-14 run measured ~49 s per step, so a mission that spends most of
  // its budget needs roughly a quarter hour. The previous 720 s mission
  // timeout was sized to the old five-step budget and would have cut off a
  // mission that was still making progress.
  test.describe.configure({ mode: "default", timeout: 1_500_000, retries: 0 });

  for (const scenario of REAL_WEB_PROMPTS) {
    test(`RESEARCH-WEB-01 ${scenario.label} cited summary from the live web`, async ({}, testInfo) => {
      let harness: RealAiHarness | null = null;
      try {
        harness = await startRealAiHarness(`research-real-web-${scenario.label}`);
        // Deliberately NO installOwnedWebBackend: the plugin's own transport
        // reaches the real provider search and fetch endpoints.
        const before = await readFile(harness.noteFilePath, "utf8");
        await harness.submitMission(scenario.prompt, { timeoutMs: 1_200_000 });
        const after = await readFile(harness.noteFilePath, "utf8");
        const appended = after.slice(before.length);

        const snapshot = await harness.attestProductionRun({
          requireStructuredRouting: true,
        });
        const graphNodes = Object.values(snapshot.lastMissionGraph?.nodes ?? {}) as any[];
        const fetchedEvidence = snapshot.missionEvidence.filter(
          (item: any) =>
            item.kind === "web_source" &&
            item.usableSource === true &&
            item.parserStatus === "parsed" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.length > 0,
        );
        const fetchedPassageIds = new Set<string>(
          fetchedEvidence.flatMap((item: any) => item.passageIds),
        );
        // The attestation carries a hostname, never a URL; it is computed by
        // the same function the product's distinct-domain check uses.
        const fetchedDomains = new Set(
          fetchedEvidence
            .map((item: any) =>
              typeof item.sourceDomain === "string" && item.sourceDomain
                ? item.sourceDomain
                : null,
            )
            .filter((host: string | null): host is string => Boolean(host)),
        );
        const citedPassageIds = [
          ...appended.matchAll(/source:[a-z0-9-]+:passage:\d+-\d+/gu),
        ].map((match) => match[0]);
        const appendReceipts = snapshot.lastReceipts.filter(
          (receipt: any) => receipt.operation === "append",
        );
        const limitationsHeading =
          /^[ \t]{0,3}#{1,6}[ \t]+limitations?\b/imu.test(appended);

        const safeState = {
          complete: snapshot.lastComplete,
          route: snapshot.lastConfig?.route ?? null,
          allowedToolNames: snapshot.lastConfig?.allowedToolNames ?? [],
          acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
          nodes: graphNodes.map((node) => ({
            id: node.id,
            status: node.status,
            allowedTools: node.allowedTools,
            blockerCode: node.blocker?.code ?? null,
          })),
          receiptOperations: snapshot.lastReceipts.map((receipt: any) => receipt.operation),
          fetchedSourceCount: fetchedEvidence.length,
          fetchedDomains: [...fetchedDomains],
          fetchedPassageCount: fetchedPassageIds.size,
          citedPassageIds: [...new Set(citedPassageIds)],
          limitationsHeading,
          appendedChars: appended.length,
          diagnostics: snapshot.diagnosticAttestations,
          providerUsage: snapshot.providerUsage,
        };
        const state = JSON.stringify(safeState);

        // Product promises for a sourced mission, and nothing narrower.
        expect(after.startsWith(before), state).toBe(true);
        expect(appended.trim().length, state).toBeGreaterThan(0);
        expect(appendReceipts, state).toHaveLength(1);
        expect(
          graphNodes.some((node) => node.allowedTools?.includes("web_search")),
          state,
        ).toBe(true);
        expect(
          graphNodes.some((node) => node.allowedTools?.includes("web_fetch")),
          state,
        ).toBe(true);
        expect(fetchedEvidence.length, state).toBeGreaterThanOrEqual(2);
        expect(fetchedDomains.size, state).toBeGreaterThanOrEqual(2);
        expect(new Set(citedPassageIds).size, state).toBeGreaterThanOrEqual(1);
        expect(
          citedPassageIds.every((id) => fetchedPassageIds.has(id)),
          state,
        ).toBe(true);
        expect(limitationsHeading, state).toBe(true);

        const observed = {
          artifacts: [] as string[],
          proofs: [] as string[],
          approvals: [] as string[],
          bindings: [] as string[],
          cleanup: [] as string[],
        };
        const attest = (target: string[], key: string, condition: boolean) => {
          expect(condition, `Missing observed RESEARCH-WEB-01 evidence: ${key}`).toBe(true);
          if (condition) target.push(key);
        };
        attest(
          observed.artifacts,
          "vault:cited_summary_section",
          appended.trim().length > 0 && new Set(citedPassageIds).size >= 1,
        );
        attest(observed.proofs, "evidence:real_web_fetch", fetchedEvidence.length >= 2);
        attest(observed.proofs, "research:distinct_domains", fetchedDomains.size >= 2);
        attest(observed.proofs, "receipt:single_append", appendReceipts.length === 1);
        attest(observed.proofs, "research:limitations_section", limitationsHeading);
        attest(
          observed.bindings,
          "citation:fetched_source",
          new Set(citedPassageIds).size >= 1 &&
            citedPassageIds.every((id) => fetchedPassageIds.has(id)),
        );
        await recordDailyUseAcceptance(
          testInfo,
          "RESEARCH-WEB-01",
          observed,
          {
            modelCalls: snapshot.modelCallEvidence.length,
            toolCalls: snapshot.missionEvidence.length,
            // The runtime's graded scorecard, so scorecards:harvest can
            // baseline this lane; a diagnostic until it is harvested.
            missionScorecard: snapshot.lastMissionScorecard,
            providerUsage: snapshot.providerUsage ?? null,
            promptPrefixReuseAvg: promptPrefixReuseAverageV1(
              snapshot.providerUsage ?? null,
            ),
          },
          { requireComplete: true },
        );
      } finally {
        await harness?.close();
      }
    });
  }
});
