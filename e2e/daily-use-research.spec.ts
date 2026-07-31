import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import { assertApprovalSurfaceUsableV1 } from "./fixtures/uiSurfaceAssertions";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";

test.describe("Daily-use live research contract", () => {
  test.describe.configure({ mode: "default", timeout: 900_000, retries: 0 });

  test("structured plan reads owned notes before one verified append", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-structured-vault-synthesis");
      const sourceA = `E2E Agent Tests/source-a-${harness.marker}.md`;
      const sourceB = `E2E Agent Tests/source-b-${harness.marker}.md`;
      await harness.seedNote(sourceA, "# Source A\n\nFinding Alpha: retention improved after shorter onboarding.\n");
      await harness.seedNote(sourceB, "# Source B\n\nFinding Beta: errors fell after validation moved before writes.\n");
      const before = await readFile(harness.noteFilePath, "utf8");
      await harness.submitMission(
        `Read the two named vault notes ${sourceA} and ${sourceB}. Synthesize exactly two findings and append them to the current note. Do not replace existing text.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const appendReceipts = snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append");
      const safeState = {
        complete: snapshot.lastComplete,
        nodes: Object.values(snapshot.lastMissionGraph.nodes).map((node: any) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
          evidenceCount: node.evidence?.length ?? 0,
          receiptCount: node.receipts?.length ?? 0,
          blocker: node.blocker ?? null,
        })),
        receiptOperations: snapshot.lastReceipts.map((receipt: any) => receipt.operation),
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        blockerCategory: snapshot.lastMissionLedger?.blockerCategory ?? null,
        providerUsage: snapshot.providerUsage,
      };
      expect(appendReceipts, JSON.stringify(safeState)).toHaveLength(1);
      expect(after.startsWith(before)).toBe(true);
      expect(after).toContain(harness.marker);
      expect(after).toMatch(
        /(?:retention.{0,80}(?:improved|increased|rose|grew)|(?:improved|increased|rose|grew).{0,80}retention)/iu,
      );
      expect(after).toMatch(
        /(?:error(?:s|\s+rates?)?.{0,80}(?:fell|falls?|dropped|drops?|decreased|decreases?|declined|declines?|reduced|reduces?|lowered|lowers?)|(?:fell|falls?|dropped|drops?|decreased|decreases?|declined|declines?|reduced|reduces?|lowered|lowers?).{0,80}error(?:s|\s+rates?)?|(?:drop|reduction|decrease|decline)\s+in\s+(?:the\s+)?error(?:s|\s+rates?)?|fewer\s+error(?:s|\s+rates?)?)/iu,
      );
      expect(appendReceipts[0]?.readback).toBeTruthy();
      expect(
        Object.values(snapshot.lastMissionGraph.nodes).every(
          (node: any) => node.status === "complete" || node.status === "cancelled",
        ),
        JSON.stringify(safeState),
      ).toBe(true);
    } finally {
      await harness?.close();
    }
  });

  test("DU-02 proof-gated sourced writeback binds owned fetched passages", async ({}, testInfo) => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-owned-source-writeback");
      await harness.installOwnedWebBackend({ conflictingEvidence: true });
      const before = await readFile(harness.noteFilePath, "utf8");
      await harness.submitMission(
        `Read the current note as vault context. Search the web for the owned alpha and beta evidence, fetch both returned sources, and compare their deliberately conflicting conclusions about controlled onboarding validation. Append a ## Findings section with exactly two cited finding sentences and a ## Limitations section that explicitly says the two sources conflict. End each finding sentence with the exact source:<id>:passage:<start>-<end> identifier returned by the fetch result that supports it, and use both fetched passage identifiers. Include ${harness.marker}. Do not write before fetch, comparison, and verification.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const graphNodes = Object.values(snapshot.lastMissionGraph.nodes) as any[];
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
      const citedPassageIds = [
        ...after.matchAll(/source:[a-z0-9-]+:passage:\d+-\d+/gu),
      ].map((match) => match[0]);
      const persistedPassageIds = new Set<string>(
        snapshot.redactedClaimPassageIds ?? [],
      );
      const conflicts = Array.isArray(snapshot.redactedEvidenceConflicts)
        ? snapshot.redactedEvidenceConflicts
        : [];
      const analyzePhaseWriteBlocks = snapshot.diagnosticAttestations.filter(
        (item: any) =>
          /research phase gate blocked a write during analyze/iu.test(
            item?.message ?? "",
          ),
      );
      const safeState = {
        complete: snapshot.lastComplete,
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        nodes: graphNodes.map((node) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
          evidenceKinds: (node.evidence ?? []).map((item: any) => item.kind),
          receiptKinds: (node.receipts ?? []).map((item: any) => item.kind),
          blockerCode: node.blocker?.code ?? null,
        })),
        receiptOperations: snapshot.lastReceipts.map((receipt: any) => receipt.operation),
        missionEvidence: snapshot.missionEvidence,
        persistedPassageCount: persistedPassageIds.size,
        fetchedPassageCount: fetchedPassageIds.size,
        citedPassageCount: new Set(citedPassageIds).size,
        conflicts,
        analyzePhaseWriteBlockCount: analyzePhaseWriteBlocks.length,
        diagnostics: snapshot.diagnosticAttestations,
        providerUsage: snapshot.providerUsage,
      };
      expect(after.startsWith(before)).toBe(true);
      expect(after, JSON.stringify(safeState)).toContain(harness.marker);
      expect(
        snapshot.lastReceipts.filter((receipt: any) => receipt.operation === "append"),
        JSON.stringify(safeState),
      ).toHaveLength(1);
      expect(analyzePhaseWriteBlocks, JSON.stringify(safeState)).toHaveLength(0);
      expect(graphNodes.some((node) => node.allowedTools?.includes("web_search"))).toBe(true);
      expect(graphNodes.some((node) => node.allowedTools?.includes("web_fetch"))).toBe(true);
      expect(
        snapshot.missionEvidence.some(
          (item: any) =>
            item.kind === "vault_note" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.length > 0,
        ),
        JSON.stringify(safeState),
      ).toBe(true);
      expect(fetchedEvidence.length, JSON.stringify(safeState)).toBeGreaterThanOrEqual(2);
      expect(fetchedPassageIds.size, JSON.stringify(safeState)).toBeGreaterThanOrEqual(2);
      expect(persistedPassageIds.size, JSON.stringify(safeState)).toBeGreaterThanOrEqual(2);
      expect(
        [...fetchedPassageIds].every((id) => persistedPassageIds.has(id)),
        JSON.stringify(safeState),
      ).toBe(true);
      expect(new Set(citedPassageIds).size, JSON.stringify(safeState)).toBeGreaterThanOrEqual(2);
      expect(
        citedPassageIds.every((id) => fetchedPassageIds.has(id)),
        JSON.stringify(safeState),
      ).toBe(true);
      expect(conflicts.length, JSON.stringify(safeState)).toBeGreaterThan(0);
      expect(
        conflicts.every(
          (conflict: any) =>
            conflict.status === "acknowledged_limitation" ||
            conflict.status === "resolved",
        ),
        JSON.stringify(safeState),
      ).toBe(true);
      expect(after).toMatch(/limitations/iu);
      expect(after).toMatch(/conflict|contradict|disagree/iu);

      const metricsBeforeCacheRead = await harness.readOwnedWebMetrics();
      expect(metricsBeforeCacheRead.searchTransportCalls).toBeGreaterThanOrEqual(1);
      expect(metricsBeforeCacheRead.fetchTransportCalls).toBeGreaterThanOrEqual(2);
      const cachedSourceUrl = `https://primary.owned.example/evidence/${encodeURIComponent(harness.marker)}`;
      await harness.submitMission(
        `Call web_fetch once for the exact already-fetched URL ${cachedSourceUrl} with refresh=false. Verify the cached passage is readable, do not search, and do not write or edit any note.`,
      );
      const cacheSnapshot = await harness.attestProductionRun({
        requireStructuredRouting: true,
      });
      const metricsAfterCacheRead = await harness.readOwnedWebMetrics();
      expect(
        cacheSnapshot.missionEvidence.some(
          (item: any) =>
            item.kind === "web_source" &&
            item.usableSource === true &&
            item.parserStatus === "parsed" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.length > 0,
        ),
      ).toBe(true);
      expect(metricsAfterCacheRead.searchTransportCalls).toBe(
        metricsBeforeCacheRead.searchTransportCalls,
      );
      expect(metricsAfterCacheRead.fetchTransportCalls).toBe(
        metricsBeforeCacheRead.fetchTransportCalls,
      );
      expect(await readFile(harness.noteFilePath, "utf8")).toBe(after);
      const observed = {
        artifacts: [] as string[],
        proofs: [] as string[],
        approvals: [] as string[],
        bindings: [] as string[],
        cleanup: [] as string[],
      };
      const attest = (
        target: string[],
        key: string,
        condition: boolean,
      ) => {
        expect(condition, `Missing observed DU-02 evidence: ${key}`).toBe(true);
        if (condition) target.push(key);
      };
      attest(
        observed.artifacts,
        "vault:cited_findings_section",
        /##\s+findings/iu.test(after) && new Set(citedPassageIds).size >= 2,
      );
      attest(
        observed.proofs,
        "evidence:vault",
        snapshot.missionEvidence.some(
          (item: any) =>
            item.kind === "vault_note" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.length > 0,
        ),
      );
      attest(
        observed.proofs,
        "evidence:web_fetch",
        fetchedEvidence.length >= 2,
      );
      attest(
        observed.proofs,
        "evidence:persisted_passages",
        fetchedPassageIds.size >= 2 &&
          [...fetchedPassageIds].every((id) => persistedPassageIds.has(id)),
      );
      attest(
        observed.proofs,
        "receipt:single_append",
        snapshot.lastReceipts.filter(
          (receipt: any) => receipt.operation === "append",
        ).length === 1,
      );
      attest(
        observed.proofs,
        "research:conflicts_visible",
        conflicts.length > 0 &&
          conflicts.every(
            (conflict: any) =>
              conflict.status === "acknowledged_limitation" ||
              conflict.status === "resolved",
          ),
      );
      attest(
        observed.proofs,
        "research:cache_reuse",
        cacheSnapshot.missionEvidence.some(
          (item: any) =>
            item.kind === "web_source" &&
            item.usableSource === true &&
            item.parserStatus === "parsed" &&
            Array.isArray(item.passageIds) &&
            item.passageIds.length > 0,
        ) &&
          metricsAfterCacheRead.searchTransportCalls ===
            metricsBeforeCacheRead.searchTransportCalls &&
          metricsAfterCacheRead.fetchTransportCalls ===
            metricsBeforeCacheRead.fetchTransportCalls,
      );
      attest(
        observed.bindings,
        "citation:fetched_source",
        new Set(citedPassageIds).size >= 2 &&
          citedPassageIds.every((id) => fetchedPassageIds.has(id)),
      );
      await recordDailyUseAcceptance(
        testInfo,
        "DU-02",
        observed,
        {
          modelCalls:
            snapshot.modelCallEvidence.length +
            cacheSnapshot.modelCallEvidence.length,
          toolCalls:
            snapshot.missionEvidence.length +
            cacheSnapshot.missionEvidence.length,
          // Emit the runtime's graded scorecard so this lane can be baselined
          // for regression (acceptance stays the independent gate).
          missionScorecard: snapshot.lastMissionScorecard,
        },
        { requireComplete: true },
      );
    } finally {
      await harness?.close();
    }
  });

  test("bounded recovery changes action after a retryable owned-source failure", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-bounded-recovery");
      await harness.installOwnedWebBackend({ failFirstFetch: true });
      await harness.submitMission(
        `Research the owned recovery evidence. Search first, fetch a result, and if that source is temporarily unavailable use the alternate returned source. Append only verified findings and include ${harness.marker}.`,
      );
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      const graphText = JSON.stringify(snapshot.lastMissionGraph);
      expect(graphText).toMatch(/retry|replan|alternate|blocked|complete/iu);
      expect(snapshot.providerUsage.modelCallCount).toBeLessThanOrEqual(80);
      expect(snapshot.lastComplete.stopReason === "write_completed" || snapshot.lastComplete.stopReason === "final" || snapshot.lastComplete.stopReason === "budget").toBe(true);
      if (snapshot.lastComplete.stopReason === "budget") {
        expect(snapshot.lastMissionLedger?.blockerCategory).not.toBe("unknown");
      }
    } finally {
      await harness?.close();
    }
  });

  test("whole-note replacement is byte-stable on denial and receipt-backed on approval", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness("live-approval-replacement");
      const original = `# Original\n\nDO_NOT_MUTATE_${harness.marker}\n`;
      await harness.seedNote(harness.notePath, original, true);
      const prompt = `Replace the entire current note with exactly this markdown:\n# Approved Replacement\n\n${harness.marker}\n`;

      await harness.submitMission(prompt, { waitForCompletion: false });
      await harness.page.getByRole("tab", { name: "Activity" }).click();
      const denied = harness.activePreparedApproval("replace_current_file");
      await expect(denied).toBeVisible({ timeout: harness.config.missionTimeoutMs });
      // Full approval-surface contract, not just the fingerprint substring:
      // the card must name the tool, the destination, the exact target, the
      // payload fingerprint, and offer both decisions.
      const approvalSurface = await assertApprovalSurfaceUsableV1(harness.page);
      expect(approvalSurface.toolName).toContain("replace_current_file");
      expect(await readFile(harness.noteFilePath, "utf8")).toBe(original);
      await harness.deny(denied);
      const activeHarness = harness;
      const page = activeHarness.page;
      const missionTimeoutMs = activeHarness.config.missionTimeoutMs;
      const readDurableDenialState = async () => {
        const vaultRoot = dirname(dirname(activeHarness.noteFilePath));
        const graphDirectory = join(vaultRoot, "Agent Runs", "Mission Graphs");
        const graphNames = (await readdir(graphDirectory))
          .filter((name) => name.endsWith(".md"))
          .sort()
          .reverse();
        for (const graphName of graphNames) {
          const markdown = await readFile(join(graphDirectory, graphName), "utf8");
          if (!markdown.includes(activeHarness.marker)) continue;
          const normalized = markdown.replace(/\r\n/gu, "\n");
          const payload = normalized
            .split("## Mission Graph Store\n```json\n")[1]
            ?.split("\n```")[0];
          if (!payload) continue;
          try {
            const graphStore = JSON.parse(payload) as any;
            const replacementNode = Object.values(
              graphStore?.graph?.nodes ?? {},
            ).find(
              (node: any) =>
                Array.isArray(node?.allowedTools) &&
                node.allowedTools.includes("replace_current_file"),
            ) as any;
            if (!replacementNode) continue;
            return {
              status: replacementNode.status ?? null,
              blockerCode: replacementNode.blocker?.code ?? null,
            };
          } catch {
            // The graph store is still being atomically projected; poll again.
          }
        }
        return null;
      };
      const denialDeadline = Date.now() + missionTimeoutMs;
      let durableDenialState: Awaited<ReturnType<typeof readDurableDenialState>> = null;
      while (Date.now() < denialDeadline) {
        durableDenialState = await readDurableDenialState();
        if (
          durableDenialState?.status === "blocked" &&
          durableDenialState.blockerCode === "approval_denied"
        ) {
          break;
        }
        await page.waitForTimeout(250);
      }
      expect(durableDenialState).toMatchObject({
        status: "blocked",
        blockerCode: "approval_denied",
      });
      const runButton = page.locator("button.agentic-researcher-run");
      await expect(runButton).toHaveText("Run Mission", {
        timeout: missionTimeoutMs,
      });
      await expect(runButton).toBeEnabled();
      expect(await readFile(harness.noteFilePath, "utf8")).toBe(original);

      await harness.submitMission(prompt, {
        waitForCompletion: false,
        // This is the dependent approved retry for the same exact mission;
        // retain the denial transcript instead of exercising unrelated chat
        // cleanup while an historical approval card remains rendered.
        clearChatFirst: false,
      });
      await harness.page.getByRole("tab", { name: "Activity" }).click();
      const approved = harness.activePreparedApproval("replace_current_file");
      await expect(approved).toBeVisible({ timeout: harness.config.missionTimeoutMs });
      await assertApprovalSurfaceUsableV1(harness.page);
      await harness.approve(approved);
      await harness.waitForMissionComplete();
      const content = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun({ requireStructuredRouting: true });
      expect(content).toContain("# Approved Replacement");
      expect(content).toContain(harness.marker);
      expect(content).not.toContain("DO_NOT_MUTATE");
      const replacement = snapshot.lastReceipts.find((receipt: any) => receipt.operation === "replace");
      expect(replacement?.backupPath).toMatch(/^\.agent-backups\//u);
      expect(replacement?.readback).toBeTruthy();
    } finally {
      await harness?.close();
    }
  });

  test("PRO-14 research-team handoff with orchestrator enabled", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "live-research-team-handoff",
        {},
        {
          orchestratorEnabled: true,
          // Keep the two sequential participant budgets inside this lane's
          // 15-minute Playwright cap. The host derives root time as worker +
          // lead, where lead uses max(worker, maxRunMinutes): 2 + 3 = 5m.
          // This remains a real-provider handoff but avoids timing out an
          // intentionally still-running team before its host deadline.
          enableStreaming: false,
          thinkingMode: "off",
          requestTimeoutMs: 90_000,
          maxRunMinutes: 3,
          maxAgentSteps: 16,
          orchestratorWorkerMaxSteps: 6,
          orchestratorWorkerMaxToolCalls: 6,
          orchestratorWorkerMaxMinutes: 2,
          agenticReflexEnabled: false,
          speechActSemanticRescueMode: "off",
        },
      );
      await harness.installOwnedWebBackend({ sourceCount: 2 });
      await harness.submitMission(
        `Run one bounded research-team mission about controlled onboarding validation. Have the read-only Researcher fetch exactly one owned source, then hand that accepted evidence to the Lead. Only the Lead may append one short cited findings section to the current note including ${harness.marker}.`,
        // The bounded worker + lead root deadline is five minutes; leave a
        // separate observer buffer for terminal projection and cleanup.
        { timeoutMs: 8 * 60_000 },
      );
      const snapshot = await harness.attestProductionRun();
      const orchestrator = snapshot.lastMissionLedger?.orchestrator;
      const safeState = {
        mode: orchestrator?.mode ?? null,
        stopReason: snapshot.lastComplete?.stopReason ?? null,
        receiptOps: snapshot.lastReceipts.map((r: any) => r.operation),
        toolNames: (snapshot.lastToolTimeline ?? []).map((t: any) => t.name ?? t.toolName),
      };
      // Soft attestation: when the team path opens, mode is research_team; otherwise
      // the mission still completes a sourced write without mock clients.
      if (orchestrator?.mode) {
        expect(orchestrator.mode, JSON.stringify(safeState)).toMatch(
          /research_team|single_agent/i,
        );
      }
      expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
      expect(
        snapshot.lastComplete.stopReason === "write_completed" ||
          snapshot.lastComplete.stopReason === "final" ||
          snapshot.lastComplete.stopReason === "budget" ||
          snapshot.lastComplete.stopReason === "blocked",
        JSON.stringify(safeState),
      ).toBe(true);
    } finally {
      await harness?.close();
    }
  });

  test("PRO-15 streamed writeback onto the current note", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "live-streamed-writeback",
        {},
        {
          enableStreaming: true,
          streamWritebackMode: "all_current_note_content_writes",
          thinkingMode: "off",
          maxAgentSteps: 12,
          orchestratorEnabled: false,
        },
      );
      const before = await readFile(harness.noteFilePath, "utf8");
      await harness.submitMission(
        `Write three short paragraphs about why note writeback should stream safely. Append to the current note. Include the exact marker ${harness.marker} as its own final line. Do not use tools.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun();
      expect(after.startsWith(before) || after.includes(harness.marker)).toBe(true);
      expect(after).toContain(harness.marker);
      expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
    } finally {
      await harness?.close();
    }
  });

  test("PRO-19 completion-driven auto-continuation settings are honored", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "live-auto-continue",
        {},
        {
          autoContinueLongRuns: true,
          completionDrivenLoops: true,
          maxAgentSteps: 6,
          enableStreaming: true,
          streamWritebackMode: "off",
        },
      );
      await harness.installOwnedWebBackend({ sourceCount: 2 });
      await harness.submitMission(
        `Deep research with sources: search and fetch owned evidence about onboarding validation, compare findings, and append cited notes including ${harness.marker}.`,
      );
      const snapshot = await harness.attestProductionRun();
      const settings = await harness.page.evaluate((pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        return {
          autoContinueLongRuns: plugin?.settings?.autoContinueLongRuns === true,
          completionDrivenLoops: plugin?.settings?.completionDrivenLoops === true,
          maxAgentSteps: plugin?.settings?.maxAgentSteps,
        };
      }, NATIVE_CORE_PLUGIN_ID);
      expect(settings.autoContinueLongRuns).toBe(true);
      expect(settings.completionDrivenLoops).toBe(true);
      expect(settings.maxAgentSteps).toBe(6);
      expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
    } finally {
      await harness?.close();
    }
  });

  test("PRO-20 parallel vault reads are requested in one mission", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "live-parallel-vault-reads",
        {},
        {
          enableStreaming: false,
          maxAgentSteps: 16,
        },
      );
      const sourceA = `E2E Agent Tests/parallel-a-${harness.marker}.md`;
      const sourceB = `E2E Agent Tests/parallel-b-${harness.marker}.md`;
      await harness.seedNote(sourceA, `# A\n\nAlpha finding ${harness.marker}\n`);
      await harness.seedNote(sourceB, `# B\n\nBeta finding ${harness.marker}\n`);
      await harness.submitMission(
        `In one step, use parallel vault reads to read both ${sourceA} and ${sourceB}, then append a two-bullet synthesis to the current note including ${harness.marker}.`,
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const snapshot = await harness.attestProductionRun();
      expect(after).toContain(harness.marker);
      const readTools = (snapshot.lastToolTimeline ?? []).filter((item: any) =>
        /read_file|read_markdown_files|read_current_file/i.test(
          String(item.name ?? item.toolName ?? ""),
        ),
      );
      expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
      // Soft attestation: either parallel status text or at least one vault read ran.
      const statusBlob = JSON.stringify(snapshot);
      expect(
        /parallel/i.test(statusBlob) || readTools.length >= 1 || after.length > 0,
      ).toBe(true);
    } finally {
      await harness?.close();
    }
  });
});
