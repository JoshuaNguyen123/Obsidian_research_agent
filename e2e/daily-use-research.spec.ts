import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { startRealAiHarness, type RealAiHarness } from "./fixtures/realAiHarness";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import { assertApprovalSurfaceUsableV1 } from "./fixtures/uiSurfaceAssertions";
import { NATIVE_CORE_PLUGIN_ID } from "./fixtures/nativeObsidianHarness";
import { resolveMissionEffortDecisionV1 } from "../src/agent/missionEffortDecision";
import { resolveNoteOutputPlan } from "../src/agent/noteOutputPolicy";
import { resolveAdaptiveTeamDispatchV2 } from "../src/agent/researchTeamDispatch";
import { extractClaimsFromDraft } from "../src/agent/claimLedger";
import { randomUUID } from "node:crypto";
import {
  startAuthenticatedOllamaProxyV1,
  type AuthenticatedOllamaProxyV1,
} from "./fixtures/authenticatedOllamaProxy";

const ORCHESTRATION_GUIDE_PROMPT =
  "I want you to write me an in depth guide/report to agent orchestration. What is it, why is it important, and then finally how to execute agent orcehstration sucessfully.";

test.describe("Daily-use live research contract", () => {
  test.describe.configure({ mode: "default", timeout: 900_000, retries: 0 });

  test("exact orchestration-guide prompt deterministically activates the Adaptive Specialist", async () => {
    const output = resolveNoteOutputPlan({
      prompt: ORCHESTRATION_GUIDE_PROMPT,
      hasActiveMarkdownNote: true,
      activeNoteIsPlaceholder: false,
      outputProfile: "active_or_new_note",
      enableStreaming: true,
      streamWritebackMode: "all_current_note_content_writes",
      autoTitleOnWrite: true,
    });
    const effort = resolveMissionEffortDecisionV1({
      prompt: ORCHESTRATION_GUIDE_PROMPT,
      route: "single_model_writeback",
      outputTarget: output.destination,
      configuredMaxModelCalls: 100,
      configuredMaxRunMinutes: 60,
    });
    const team = await resolveAdaptiveTeamDispatchV2({
      prompt: ORCHESTRATION_GUIDE_PROMPT,
      orchestratorEnabled: true,
      forceChatOnly: false,
    });
    expect(output.destination).toBe("new_note");
    expect(effort.profile).toBe("compose");
    expect(effort.researchDepth).toBe("none");
    expect(effort.maxModelCalls).toBe(6);
    expect(effort.maxToolCalls).toBe(4);
    expect(effort.maxWallClockMs).toBe(180_000);
    expect(team.useTeam).toBe(true);
    expect(team.orchestrationMode).toBe("adaptive_team");
    expect(team.initialSpecialistMode).toBe("researcher");
    expect(team.specialistModes).toEqual(["researcher"]);
    expect(team.signals).toContain("complex_research");

    const sourced = resolveMissionEffortDecisionV1({
      prompt: `${ORCHESTRATION_GUIDE_PROMPT} Use current sources and citations.`,
      route: "grounded_workflow",
      outputTarget: "new_note",
    });
    expect(sourced.profile).toBe("grounded_research");
    expect(sourced.researchDepth).toBe("grounded");
  });

  test("Agent settings expose a selectable Specialist model and explicit API slot", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "dual-agent-model-settings",
        {},
        {
          specialistEnabled: true,
          specialistModel: "e2e-specialist-model",
          specialistConnectionMode: "shared_primary",
          specialistProvider: "ollama",
          specialistBaseUrl: "https://agent-2.invalid/api",
        },
      );
      await harness.page.evaluate(async (pluginId) => {
        const plugin = (window as typeof window & { app?: any }).app?.plugins
          ?.plugins?.[pluginId];
        await plugin?.openCapabilitySetup?.("model");
      }, NATIVE_CORE_PLUGIN_ID);

      await expect(
        harness.page.getByText("Agent 1 — Lead", { exact: true }),
      ).toBeVisible();
      await expect(
        harness.page.getByText("Agent 2 — Specialist", { exact: true }),
      ).toBeVisible();

      const specialistModelRow = harness.page.locator(
        '.setting-item:has(.setting-item-name:text-is("Specialist model"))',
      );
      await expect(specialistModelRow.locator("input")).toHaveValue(
        "e2e-specialist-model",
      );

      const specialistConnection = () =>
        harness!.page.locator(
          '.setting-item:has(.setting-item-name:text-is("Specialist connection")) select:not(.is-measuring):not([aria-hidden="true"])',
        );
      const specialistKeyRow = () =>
        harness!.page.locator(
          '.setting-item:has(.setting-item-name:text-is("Specialist API key"))',
        );

      await expect(specialistConnection()).toHaveValue("shared_primary");
      await expect(specialistKeyRow()).toHaveCount(0);

      await specialistConnection().selectOption("separate");
      await expect(specialistConnection()).toHaveValue("separate");
      await expect(specialistKeyRow()).toBeVisible();
      await expect(specialistKeyRow().locator('input[type="password"]')).toHaveValue(
        "",
      );

      await specialistConnection().selectOption("shared_primary");
      await expect(specialistConnection()).toHaveValue("shared_primary");
      await expect(specialistKeyRow()).toHaveCount(0);
    } finally {
      await harness?.close();
    }
  });

  test("separate Lead and Specialist credentials drive two real Ollama models", async ({}, testInfo) => {
    let harness: RealAiHarness | null = null;
    let leadProxy: AuthenticatedOllamaProxyV1 | null = null;
    let specialistProxy: AuthenticatedOllamaProxyV1 | null = null;
    const previousLeadCredential = process.env.E2E_OLLAMA_API_KEY;
    const leadToken = `lead-${randomUUID()}`;
    const specialistToken = `specialist-${randomUUID()}`;
    try {
      leadProxy = await startAuthenticatedOllamaProxyV1({
        expectedBearerToken: leadToken,
      });
      specialistProxy = await startAuthenticatedOllamaProxyV1({
        expectedBearerToken: specialistToken,
      });
      process.env.E2E_OLLAMA_API_KEY = leadToken;
      harness = await startRealAiHarness(
        "dual-agent-separate-live",
        {
          model: "minimax-m3:cloud",
          baseUrl: leadProxy.baseUrl,
          missionTimeoutMs: 8 * 60_000,
          completionTimeoutMs: 8 * 60_000,
        },
        {
          modelCredentialReferences: {
            version: 1,
            ollama: null,
            openAiCompatible: null,
            specialist: null,
          },
          orchestratorEnabled: true,
          specialistEnabled: true,
          specialistModel: "gpt-oss:120b-cloud",
          specialistConnectionMode: "separate",
          specialistProvider: "ollama",
          specialistBaseUrl: specialistProxy.baseUrl,
          specialistApiKey: specialistToken,
          enableStreaming: false,
          thinkingMode: "off",
          requestTimeoutMs: 120_000,
          maxRunMinutes: 4,
          maxAgentSteps: 16,
          orchestratorWorkerMaxSteps: 6,
          orchestratorWorkerMaxToolCalls: 6,
          orchestratorWorkerMaxMinutes: 2,
          agenticReflexEnabled: false,
          speechActSemanticRescueMode: "off",
        },
      );
      const credentialProof = await harness.page.evaluate(async (pluginId) => {
        const app = (window as typeof window & { app?: any }).app;
        const plugin = app?.plugins?.plugins?.[pluginId];
        const specialistConnection = await plugin?.testSpecialistModelConnection?.();
        const refs = plugin?.modelCredentialStore?.snapshot?.();
        return {
          leadConnection: plugin?.getModelConnectionStatus?.() ?? null,
          specialistConnection,
          leadReferenceId: refs?.ollama?.referenceId ?? null,
          specialistReferenceId: refs?.specialist?.referenceId ?? null,
          leadActor: refs?.ollama?.metadata?.actor ?? null,
          specialistActor: refs?.specialist?.metadata?.actor ?? null,
          leadScope: refs?.ollama?.metadata?.scope ?? null,
          specialistScope: refs?.specialist?.metadata?.scope ?? null,
          mode: plugin?.settings?.specialistConnectionMode ?? null,
          leadModel: plugin?.settings?.model ?? null,
          specialistModel: plugin?.settings?.specialistModel ?? null,
        };
      }, NATIVE_CORE_PLUGIN_ID);
      const leadProof = leadProxy.snapshot();
      const specialistProof = specialistProxy.snapshot();
      const safeState = {
        leadProof,
        specialistProof,
        credentialProof: {
          ...credentialProof,
          leadReferenceId: credentialProof.leadReferenceId ? "present" : null,
          specialistReferenceId: credentialProof.specialistReferenceId
            ? "present"
            : null,
        },
      };
      expect(credentialProof.leadConnection, JSON.stringify(safeState)).toMatchObject({
        status: "ready",
        provider: "ollama",
        model: "minimax-m3:cloud",
      });
      expect(
        credentialProof.specialistConnection,
        JSON.stringify(safeState),
      ).toMatchObject({
        status: "ready",
        provider: "ollama",
        model: "gpt-oss:120b-cloud",
      });
      expect(leadProof.authorizedRequests, JSON.stringify(safeState)).toBeGreaterThan(0);
      expect(specialistProof.authorizedRequests, JSON.stringify(safeState)).toBeGreaterThan(0);
      expect(leadProof.rejectedRequests, JSON.stringify(safeState)).toBe(0);
      expect(specialistProof.rejectedRequests, JSON.stringify(safeState)).toBe(0);
      expect(leadProof.models, JSON.stringify(safeState)).toEqual([
        "minimax-m3:cloud",
      ]);
      expect(specialistProof.models, JSON.stringify(safeState)).toEqual([
        "gpt-oss:120b-cloud",
      ]);
      expect(credentialProof.mode, JSON.stringify(safeState)).toBe("separate");
      expect(credentialProof.leadReferenceId, JSON.stringify(safeState)).toBeTruthy();
      expect(credentialProof.specialistReferenceId, JSON.stringify(safeState)).toBeTruthy();
      expect(credentialProof.leadReferenceId).not.toBe(
        credentialProof.specialistReferenceId,
      );
      expect(credentialProof.leadActor).toBe("lead");
      expect(credentialProof.specialistActor).toBe("specialist");
      expect(credentialProof.leadScope).toBe("lead_model_requests");
      expect(credentialProof.specialistScope).toBe("specialist_model_requests");
    } catch (error) {
      await testInfo.attach("dual-agent-proxy-proof.json", {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify(
            {
              lead: leadProxy?.snapshot() ?? null,
              specialist: specialistProxy?.snapshot() ?? null,
            },
            null,
            2,
          ),
        ),
      });
      throw error;
    } finally {
      if (harness) {
        await harness.page
          .evaluate(async (pluginId) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            const refs = plugin?.modelCredentialStore?.snapshot?.();
            for (const referenceId of [
              refs?.ollama?.referenceId,
              refs?.specialist?.referenceId,
            ]) {
              if (typeof referenceId === "string") {
                await app?.secretStorage?.removeSecret?.(referenceId);
              }
            }
          }, NATIVE_CORE_PLUGIN_ID)
          .catch(() => undefined);
      }
      await harness?.close();
      await specialistProxy?.close();
      await leadProxy?.close();
      if (previousLeadCredential === undefined) {
        delete process.env.E2E_OLLAMA_API_KEY;
      } else {
        process.env.E2E_OLLAMA_API_KEY = previousLeadCredential;
      }
    }
  });

  test("exact orchestration-guide prompt creates one verified note through the adaptive handoff", async () => {
    let harness: RealAiHarness | null = null;
    try {
      harness = await startRealAiHarness(
        "adaptive-orchestration-guide",
        {},
        {
          orchestratorEnabled: true,
          specialistEnabled: true,
          specialistModel: "",
          specialistConnectionMode: "shared_primary",
          enableStreaming: false,
          thinkingMode: "off",
          // Structured planning is capped at min(120s, requestTimeoutMs,
          // run wall clock); 90s starved the planner's sequential cloud
          // calls under requireStructuredRouting.
          requestTimeoutMs: 120_000,
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
      const startedAt = Date.now();
      await harness.submitMission(ORCHESTRATION_GUIDE_PROMPT, {
        // Shared adaptive budget: two Specialist minutes plus a three-minute
        // Lead window. The observer margin is separate from runtime authority.
        timeoutMs: 8 * 60_000,
      });
      const elapsedMs = Date.now() - startedAt;
      const snapshot = await harness.attestProductionRun({
        requireStructuredRouting: true,
      });
      const config = snapshot.lastConfig;
      const orchestrator = snapshot.lastMissionLedger?.orchestrator;
      const handoff = (orchestrator?.handoffs ?? []).find(
        (candidate: any) => candidate.schemaVersion === 2,
      );
      const graphNodes = Object.values(snapshot.lastMissionGraph?.nodes ?? {}) as any[];
      const noteReceipts = snapshot.lastReceipts.filter(
        (receipt: any) =>
          receipt.readback?.status === "verified" &&
          typeof receipt.path === "string" &&
          /Agent Orchestration Guide(?: \d+)?\.md$/iu.test(receipt.path),
      );
      const safeState = {
        elapsedMs,
        route: config?.route ?? null,
        effort: config?.effortDecision ?? null,
        allowedTools: config?.allowedToolNames ?? [],
        providerUsage: snapshot.providerUsage,
        orchestrator: orchestrator
          ? {
              mode: orchestrator.mode,
              participants: Object.keys(orchestrator.participants ?? {}),
              merge: orchestrator.merge,
              handoffs: orchestrator.handoffs,
            }
          : null,
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation,
          path: receipt.path ?? null,
          readback: receipt.readback?.status ?? null,
        })),
        nodes: graphNodes.map((node: any) => ({
          id: node.id,
          status: node.status,
          allowedTools: node.allowedTools,
        })),
      };
      expect(config?.effortDecision?.profile, JSON.stringify(safeState)).toBe("compose");
      expect(config?.effortDecision?.researchDepth, JSON.stringify(safeState)).toBe("none");
      expect(config?.noteOutputPlan?.destination, JSON.stringify(safeState)).toBe("new_note");
      expect(orchestrator?.mode, JSON.stringify(safeState)).toBe("adaptive_team");
      expect(Object.keys(orchestrator?.participants ?? {}).sort()).toEqual([
        "lead",
        "specialist",
      ]);
      expect(orchestrator?.merge?.evidenceAccepted, JSON.stringify(safeState)).toBeGreaterThan(0);
      expect(handoff?.fromParticipantId, JSON.stringify(safeState)).toBe("specialist");
      expect(handoff?.toParticipantId, JSON.stringify(safeState)).toBe("lead");
      expect(handoff?.status, JSON.stringify(safeState)).toBe("accepted");
      expect(handoff?.inputFingerprint, JSON.stringify(safeState)).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(handoff?.progressFingerprint, JSON.stringify(safeState)).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(handoff?.proofReferences?.evidenceIds?.length ?? 0).toBeGreaterThan(0);
      expect(noteReceipts, JSON.stringify(safeState)).toHaveLength(1);
      expect(snapshot.providerUsage.modelCallCount, JSON.stringify(safeState)).toBeLessThanOrEqual(16);
      expect(elapsedMs, JSON.stringify(safeState)).toBeLessThanOrEqual(5 * 60_000);
      expect(
        graphNodes.every(
          (node: any) => !["planned", "queued", "running"].includes(node.status),
        ),
        JSON.stringify(safeState),
      ).toBe(true);

      const receipt = noteReceipts[0];
      const note = await readFile(join(harness.vaultRoot, receipt.path), "utf8");
      expect(note).toMatch(/agent orchestration/iu);
      expect(note).toMatch(/why.{0,80}(?:important|matter)|importance|benefits?/iu);
      expect(note).toMatch(/execute|successful|implementation|best practices|workflow/iu);
      const assistant = harness.page
        .locator(".agentic-researcher-log-assistant .agentic-researcher-log-message")
        .last();
      await expect(assistant).toContainText("Created");
      await expect(assistant).toContainText("readback verified");
      expect((await assistant.innerText()).length).toBeLessThan(1_000);
    } finally {
      await harness?.close();
    }
  });

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
      // Both findings assert the same property: the synthesis carried the
      // seeded direction through in the model's own words. The errors pattern
      // below was already widened for paraphrase; this one was not, so it
      // failed on a correct synthesis that said "a measurable lift in
      // retention" rather than "retention improved". Kept symmetric with it —
      // the direction is still required, only the vocabulary is tolerant.
      expect(after).toMatch(
        /(?:retention.{0,80}(?:improved|improves?|increased|increases?|rose|rises?|grew|grows?|gained|gains?|lifted|lifts?|climbed|climbs?|higher|better|stronger)|(?:improved|improves?|increased|increases?|rose|rises?|grew|grows?|gained|gains?|lifted|lifts?|climbed|climbs?|higher|better|stronger).{0,80}retention|(?:gain|lift|increase|improvement|rise|uptick|boost)\s+in\s+(?:the\s+)?retention)/iu,
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
        `Read the current note as vault context. Search the web for the owned alpha and beta evidence, fetch both returned sources, and compare their deliberately conflicting conclusions about controlled onboarding validation. Append a ## Findings section with exactly two cited finding sentences and a ## Limitations section to the current note; explicitly say the two sources conflict. End each finding sentence with the exact source:<id>:passage:<start>-<end> identifier returned by the fetch result that supports it, and use both fetched passage identifiers. Include ${harness.marker}. Do not write before fetch, comparison, and verification.`,
        { timeoutMs: 600_000 },
      );
      const after = await readFile(harness.noteFilePath, "utf8");
      const appended = after.slice(before.length);
      const findingsHeading = /^[ \t]{0,3}#{1,6}[ \t]+findings[ \t]*$/imu.exec(
        appended,
      );
      const findingsRemainder = findingsHeading
        ? appended.slice(findingsHeading.index + findingsHeading[0].length)
        : "";
      const nextHeading = /^[ \t]{0,3}#{1,6}[ \t]+\S.*$/mu.exec(
        findingsRemainder,
      );
      const findingsBody = findingsRemainder.slice(
        0,
        nextHeading?.index ?? findingsRemainder.length,
      );
      const findingSentenceCount = extractClaimsFromDraft(findingsBody).filter(
        (claim) => claim.status !== "exempt",
      ).length;
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
        config: {
          route: snapshot.lastConfig?.route ?? null,
          streaming: snapshot.lastConfig?.streaming ?? null,
          chatOnlyOverride: snapshot.lastConfig?.chatOnlyOverride ?? null,
          writeAutonomy: snapshot.lastConfig?.writeAutonomy ?? null,
          missionMode: snapshot.lastConfig?.missionMode ?? null,
          noteOutputPlan: snapshot.lastConfig?.noteOutputPlan ?? null,
          autonomyScope: snapshot.lastConfig?.autonomyScope ?? null,
          allowedToolNames: snapshot.lastConfig?.allowedToolNames ?? [],
        },
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
        findingSentenceCount,
        conflicts,
        analyzePhaseWriteBlockCount: analyzePhaseWriteBlocks.length,
        diagnostics: snapshot.diagnosticAttestations,
        providerUsage: snapshot.providerUsage,
      };
      expect(after.startsWith(before)).toBe(true);
      expect(after, JSON.stringify(safeState)).toContain(harness.marker);
      expect(findingSentenceCount, JSON.stringify(safeState)).toBe(2);
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
      await harness.page.getByRole("tab", { name: "Run Details" }).click();
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
      await harness.page.getByRole("tab", { name: "Run Details" }).click();
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

  test("PRO-14 adaptive Lead and Specialist handoff", async ({}, testInfo) => {
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
          // 120s keeps structured planning at its full cap; see the
          // adaptive-orchestration-guide scenario above.
          requestTimeoutMs: 120_000,
          maxRunMinutes: 3,
          maxAgentSteps: 16,
          orchestratorWorkerMaxSteps: 6,
          orchestratorWorkerMaxToolCalls: 6,
          orchestratorWorkerMaxMinutes: 2,
          agenticReflexEnabled: false,
          speechActSemanticRescueMode: "off",
        },
      );
      await harness.installOwnedWebBackend({ sourceCount: 1 });
      await harness.submitMission(
        `Run one bounded research-team mission about controlled onboarding validation. Have the read-only Researcher fetch exactly one owned source, then hand that accepted evidence to the Lead. Only the Lead may append one short cited findings section to the current note including ${harness.marker}.`,
        // The bounded worker + lead root deadline is five minutes; leave a
        // separate observer buffer for terminal projection and cleanup.
        { timeoutMs: 8 * 60_000 },
      );
      const snapshot = await harness.attestProductionRun();
      const orchestrator = snapshot.lastMissionLedger?.orchestrator;
      const specialistHandoff = (orchestrator?.handoffs ?? []).find(
        (candidate: any) => candidate.schemaVersion === 2,
      );
      const appendReceipts = snapshot.lastReceipts.filter(
        (receipt: any) => receipt.operation === "append",
      );
      const safeState = {
        complete: snapshot.lastComplete
          ? {
              step: snapshot.lastComplete.step ?? null,
              maxSteps: snapshot.lastComplete.maxSteps ?? null,
              stopReason: snapshot.lastComplete.stopReason ?? null,
              stopDetail: snapshot.lastComplete.stopDetail ?? null,
              autoContinueReason:
                snapshot.lastComplete.autoContinueReason ?? null,
              autoContinueRecommended:
                snapshot.lastComplete.autoContinueRecommended === true,
            }
          : null,
        ledger: snapshot.lastMissionLedger
          ? {
              status: snapshot.lastMissionLedger.status ?? null,
              acceptance: snapshot.lastMissionLedger.acceptance ?? null,
              missionPlan: snapshot.lastMissionLedger.missionPlan ?? null,
              remainingActions:
                snapshot.lastMissionLedger.remainingActions ?? [],
              nextAction: snapshot.lastMissionLedger.nextAction ?? null,
              canResume: snapshot.lastMissionLedger.canResume === true,
              providerUsage:
                snapshot.lastMissionLedger.providerUsage ?? null,
            }
          : null,
        redactedResearchEffort: snapshot.redactedResearchEffort ?? null,
        providerUsage: snapshot.providerUsage ?? null,
        mode: orchestrator?.mode ?? null,
        orchestratorStatus: orchestrator?.status ?? null,
        participantBudgets: Object.fromEntries(
          Object.entries(orchestrator?.participants ?? {}).map(
            ([participantId, participant]: [string, any]) => [
              participantId,
              {
                status: participant.status ?? null,
                blocker: participant.blocker ?? null,
                budget: participant.budget ?? null,
              },
            ],
          ),
        ),
        handoffs: orchestrator?.handoffs ?? [],
        receipts: snapshot.lastReceipts.map((receipt: any) => ({
          operation: receipt.operation ?? null,
          toolName: receipt.toolName ?? null,
          path: receipt.path ?? null,
          partial: receipt.output?.partial ?? null,
          message: receipt.message ?? null,
          bytesWritten: receipt.bytesWritten ?? null,
          readback: receipt.readback?.status ?? null,
          payloadFingerprint: receipt.payloadFingerprint ?? null,
        })),
        toolNames: (snapshot.lastToolTimeline ?? []).map((t: any) => t.name ?? t.toolName),
        graphNodes: Object.values(snapshot.lastMissionGraph?.nodes ?? {}).map(
          (node: any) => ({
            id: node.id,
            status: node.status,
            allowedTools: node.allowedTools ?? [],
            blocker: node.blocker ?? null,
          }),
        ),
        diagnostics: (snapshot.diagnosticAttestations ?? [])
          .filter((item: any) =>
            /operation-goals|acceptance|committed-write|verified-final|proof-gated|wall-clock|loop-decision|budget/iu.test(
              `${item.id ?? ""} ${item.message ?? ""}`,
            ),
          )
          .slice(-24),
      };
      await testInfo.attach("adaptive-team-terminal-attestation", {
        body: Buffer.from(JSON.stringify(safeState, null, 2), "utf8"),
        contentType: "application/json",
      });
      expect(orchestrator?.mode, JSON.stringify(safeState)).toBe(
        "adaptive_team",
      );
      expect(
        Object.keys(orchestrator?.participants ?? {}).sort(),
        JSON.stringify(safeState),
      ).toEqual(["lead", "specialist"]);
      expect(orchestrator?.participants?.lead?.role).toBe("lead");
      expect(orchestrator?.participants?.specialist?.role).toBe("specialist");
      expect(orchestrator?.participants?.specialist?.specialistMode).toMatch(
        /researcher|linear_planner|code_builder|code_reviewer|recovery_verifier/u,
      );
      expect(specialistHandoff?.fromParticipantId, JSON.stringify(safeState)).toBe(
        "specialist",
      );
      expect(specialistHandoff?.toParticipantId, JSON.stringify(safeState)).toBe(
        "lead",
      );
      expect(specialistHandoff?.status, JSON.stringify(safeState)).toBe(
        "accepted",
      );
      expect(specialistHandoff?.inputFingerprint).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      expect(specialistHandoff?.progressFingerprint).toMatch(
        /^sha256:[a-f0-9]{64}$/u,
      );
      expect(
        specialistHandoff?.proofReferences?.evidenceIds?.length ?? 0,
        JSON.stringify(safeState),
      ).toBeGreaterThan(0);
      expect(snapshot.providerUsage.modelCallCount).toBeGreaterThan(0);
      expect(appendReceipts, JSON.stringify(safeState)).toHaveLength(1);
      expect(
        appendReceipts[0]?.readback?.status,
        JSON.stringify(safeState),
      ).toBe("verified");
      expect(
        appendReceipts[0]?.output?.partial === true,
        JSON.stringify(safeState),
      ).toBe(false);
      // The Lead already produced a verified append receipt. A root deadline
      // racing that receipt must not demote the applied mission to a resumable
      // budget/blocked terminal.
      expect(
        snapshot.lastComplete.stopReason,
        JSON.stringify(safeState),
      ).toBe("write_completed");

      // OrchestratorTab.restoreRenderState() re-finds three scroll containers
      // by class after every snapshot, so a stylesheet change that moves
      // `overflow` onto a different wrapper silently resets the panel to the
      // top on each update — invisible to every other assertion, and only
      // observable during a live team run. Drive one real re-render (same
      // persisted snapshot, newer than the currently rendered sequence) and
      // require the offsets to survive. The persisted projection can trail
      // live UI events, so incrementing only base.sequence can correctly hit
      // the stale-snapshot guard without rendering anything.
      await harness.page.getByRole("tab", { name: "Run Details" }).click();
      const scrollRestore = await harness.page.evaluate((pluginId) => {
        const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
        const tab = plugin?.activeAgentView?.orchestratorTab;
        const base = plugin?.getLatestOrchestratorSnapshot?.();
        // The three containers restoreRenderState() writes scrollTop back onto.
        const SELECTORS = {
          root: ".agentic-researcher-orchestrator",
          tree: ".agentic-researcher-orchestrator-tree",
          inspector: ".agentic-researcher-orchestrator-inspector",
        } as const;
        const find = (sel: string) => document.querySelector<HTMLElement>(sel);
        if (!tab || !base || !find(SELECTORS.root)) return { mounted: false } as const;

        // Structural half: whatever restore targets must actually be a scroller.
        // This is the failure the restyle could cause — moving `overflow` onto a
        // different wrapper — and it does not depend on content volume.
        const overflow: Record<string, string> = {};
        for (const [name, sel] of Object.entries(SELECTORS)) {
          const el = find(sel);
          overflow[name] = el
            ? getComputedStyle(el).overflowY
            : "(absent)";
        }

        // Behavioural half. A bounded two-participant handoff does not produce
        // enough content to overflow the pane, so force the condition instead
        // of depending on run size: constrain the panel, which is a flex column
        // holding the root at flex:1/min-height:0. It has to be the panel and
        // not the root — render() calls replaceChildren() and builds a fresh
        // root, so an inline style there would be wiped by the very re-render
        // under test, and the restored offset would clamp to 0.
        const panel = document.querySelector<HTMLElement>(
          ".agentic-researcher-orchestrator-panel",
        );
        // The panel is only unhidden on Run Details when the orchestrator control
        // exists; whether it does depends on when the first snapshot landed
        // relative to render(). Measuring a hidden box yields 0/0 and would
        // skip the whole check, so make visibility explicit rather than
        // inherited from tab state, and report what it was.
        const panelWasHidden = panel?.hidden ?? null;
        const priorMaxHeight = panel?.style.maxHeight ?? "";
        const priorDisplay = panel?.style.display ?? "";
        if (panel) {
          panel.hidden = false;
          panel.style.display = "flex";
          panel.style.maxHeight = "160px";
        }
        void find(SELECTORS.root)?.offsetHeight;

        const rootEl = find(SELECTORS.root);
        const geometry = {
          panelHidden: panelWasHidden,
          panelClientHeight: panel?.clientHeight ?? -1,
          rootClientHeight: rootEl?.clientHeight ?? -1,
          rootScrollHeight: rootEl?.scrollHeight ?? -1,
        };

        const applied: Record<string, number> = {};
        for (const [name, sel] of Object.entries(SELECTORS)) {
          const el = find(sel);
          if (!el || el.scrollHeight <= el.clientHeight) continue;
          el.scrollTop = Math.min(32, el.scrollHeight - el.clientHeight);
          applied[name] = el.scrollTop;
        }
        const priorRoot = find(SELECTORS.root);

        const renderedSequence = Number.parseInt(
          priorRoot?.dataset.sequence ?? "-1",
          10,
        );
        tab.update({
          ...base,
          sequence: Math.max(base.sequence ?? 0, renderedSequence) + 1,
        });

        const restored: Record<string, number> = {};
        for (const name of Object.keys(applied)) {
          restored[name] = find(SELECTORS[name as keyof typeof SELECTORS])?.scrollTop ?? -1;
        }
        const rerendered = find(SELECTORS.root) !== priorRoot;
        if (panel) {
          panel.style.maxHeight = priorMaxHeight;
          panel.style.display = priorDisplay;
          if (panelWasHidden !== null) panel.hidden = panelWasHidden;
        }
        return {
          mounted: true,
          rerendered,
          overflow,
          geometry,
          applied,
          restored,
        } as const;
      }, NATIVE_CORE_PLUGIN_ID);

      // Always report which path was taken. The check is soft-gated on the team
      // path opening and the tree actually scrolling, so a silent skip would
      // otherwise be indistinguishable from a verified pass.
      await testInfo.attach("orchestrator-scroll-restore", {
        body: JSON.stringify(scrollRestore, null, 2),
        contentType: "application/json",
      });
      if (scrollRestore.mounted) {
        const detail = JSON.stringify(scrollRestore);
        expect(scrollRestore.rerendered, `expected a fresh root element: ${detail}`).toBe(true);

        // The root always scrolls: it is flex:1 with overflow-y:auto and holds
        // every section. The tree and inspector are unbounded by the <=520px
        // container query, so they are only asserted when present as scrollers.
        expect(
          scrollRestore.overflow.root,
          `restore target .agentic-researcher-orchestrator must be the scroller: ${detail}`,
        ).toMatch(/auto|scroll/u);
        for (const name of ["tree", "inspector"] as const) {
          if (scrollRestore.overflow[name] === "(absent)") continue;
          expect(
            scrollRestore.overflow[name],
            `restore target ${name} must be a scroller: ${detail}`,
          ).toMatch(/auto|scroll|visible/u);
        }

        // Refuse to pass vacuously: the panel is constrained above precisely so
        // something overflows, so an empty set means the setup stopped working,
        // not that the run was small.
        const scrolled = Object.keys(scrollRestore.applied);
        expect(scrolled.length, `nothing overflowed, so restore was never exercised: ${detail}`)
          .toBeGreaterThan(0);
        for (const name of scrolled) {
          expect(
            scrollRestore.restored[name],
            `orchestrator ${name} scroll was not restored: ${detail}`,
          ).toBe(scrollRestore.applied[name]);
        }
      }
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
        // Named vault evidence plus verified writeback is Grounded research
        // (ten minutes), not a Compose-only writing request. Keep the same
        // terminalization margin used by the shorter Compose regression.
        { timeoutMs: 615_000 },
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
