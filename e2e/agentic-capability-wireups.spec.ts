/**
 * Proves the five agentic-capability modules are reachable from the live run
 * loop and observably change behavior. Each test asserts a signal the runner
 * only emits when the module actually ran, not merely that it compiled.
 *
 * See docs/plans/agentic-capability-gaps.md for the gap each one closes.
 */
import { expect, test, type Page } from "@playwright/test";

import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
} from "./fixtures/nativeObsidianHarness";

const MOCK_MODEL = "playwright-capability-mock";
const UTILITY_MODEL = "playwright-capability-utility-mock";

/**
 * G1: the calibration must be live in the run loop and fed by real provider
 * token usage. Numeric convergence and the [2,6] clamp are exhaustively covered
 * by tests/contextCalibration.test.ts; a mock run cannot organically sustain
 * enough loop steps to display the "active" transition, so this asserts the two
 * things the live loop uniquely proves: the projection is emitted, and the
 * evidence it consumes carries reported usage.
 */
test("CAP-01 context calibration is live and fed by reported token usage", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-context-calibration",
      corePluginDataOverrides: capabilityCoreSettings(),
      setup: async ({ page, notePath }) => {
        await installCapabilityHarness(page, { notePath, charsPerToken: 2.5 });
      },
    });

    await submitMission(harness.page, `Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_5`);

    // The calibration projection is emitted from inside the live loop, proving
    // observeModelCallEvidence + formatContextCalibrationForRunDetails run.
    const details = await readRunDetailsText(harness.page);
    expect(details).toMatch(/context_calibration=(pending|active)/u);
    expect(details).toMatch(/chars_per_token=\d+\.\d+/u);
    expect(details).toContain("context_budget_chars=");

    // The evidence the calibration consumes is real: the live model calls
    // reported provider token usage. (With usage absent, CAP-02 proves the
    // budget is left untouched.)
    const calls = await readObservedModelCalls(harness.page);
    expect(calls.some((call) => call.reportedUsage)).toBe(true);
  } finally {
    await harness?.close();
  }
});

/** G1 fail-safe: a provider that reports no usage must change nothing. */
test("CAP-02 a provider without token usage keeps the assumed budget", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-context-calibration-absent",
      corePluginDataOverrides: capabilityCoreSettings(),
      setup: async ({ page, notePath }) => {
        await installCapabilityHarness(page, {
          notePath,
          charsPerToken: null, // omit usage from every response
        });
      },
    });

    await submitMission(harness.page, `Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_5`);

    const details = await readRunDetailsText(harness.page);
    expect(details).toContain("context_calibration=pending");
    expect(details).toContain("chars_per_token=4.00 (assumed)");
    expect(details).not.toContain("context_calibration=active");
  } finally {
    await harness?.close();
  }
});

/** G4: the graded scorecard must appear alongside the pass/fail gate. */
test("CAP-03 mission acceptance emits a graded scorecard", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-mission-scorecard",
      corePluginDataOverrides: capabilityCoreSettings(),
      setup: async ({ page, notePath }) => {
        await installCapabilityHarness(page, { notePath, charsPerToken: 4 });
      },
    });

    await submitMission(harness.page, `Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_3`);

    const details = await readRunDetailsText(harness.page);
    const score = /mission_score=(\d\.\d{3})/u.exec(details);
    expect(score, `no mission_score in Run Details:\n${details}`).not.toBeNull();

    const total = Number.parseFloat(score![1]!);
    expect(total).toBeGreaterThanOrEqual(0);
    expect(total).toBeLessThanOrEqual(1);

    // The graded score is reported next to — and never as a replacement for —
    // the binary acceptance gate. The individual weighted dimensions are
    // covered by tests/missionScorecard.test.ts.
    expect(details).toMatch(/acceptance=(pass|needs_more_work)/u);
  } finally {
    await harness?.close();
  }
});

/** G3: a failure in run one must be visible to run two. */
test("CAP-04 tool failures are remembered across runs", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-outcome-memory",
      corePluginDataOverrides: capabilityCoreSettings(),
      setup: async ({ page, notePath }) => {
        // No injected failure needed: the runner's mission-graph authority
        // layer blocks the repeated graph read on its own, which is exactly the
        // kind of real, recurring failure the outcome ledger is meant to learn.
        await installCapabilityHarness(page, { notePath, charsPerToken: 4 });
      },
    });

    // RUN ONE — the graph read fails repeatedly and is recorded.
    await submitMission(harness.page, `Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_5`);

    const record = await readFailingGraphRecord(harness.page);
    if (!record) {
      const diagnostic = await harness.page.evaluate(
        ({ pluginId }) => {
          const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
          return {
            allRecords: plugin?.toolOutcomeMemory?.records ?? [],
            modelCalls: (window as any).__e2eCapabilityModelCalls?.length ?? 0,
          };
        },
        { pluginId: NATIVE_CORE_PLUGIN_ID },
      );
      throw new Error(
        `Run one recorded no repeated graph failure. Live state: ${JSON.stringify(diagnostic)}`,
      );
    }
    expect(record.toolName).toBe("get_note_graph_context");
    expect(record.failures).toBeGreaterThanOrEqual(2);

    // RUN TWO — a fresh run must start already knowing about run one's failure.
    // Clear the captured projection, then run again; the runner injects the
    // "Known failing approaches" system message from the persisted ledger.
    await harness.page.evaluate(() => {
      (window as any).__e2eCapabilityOutcomeProjection = "";
    });
    const page = harness.page;
    const secondPrompt =
      "Use the vault graph context for the current note, map how it connects to related notes, " +
      "and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_5";
    await page.getByRole("tab", { name: "Chat" }).click();
    const prompt = page.locator("textarea.agentic-researcher-prompt");
    const run = page.locator("button.agentic-researcher-run");
    await prompt.fill(secondPrompt);
    await run.click();
    await expect(
      page
        .locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
          hasText: secondPrompt,
        })
        .last(),
    ).toBeVisible({ timeout: 10_000 });

    // Assert the live ranking trace while this segment is active. Long
    // auto-continuation runs intentionally compact older Run Details rows.
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(page.locator(".agentic-researcher-details-panel")).toContainText(
      "outcome_penalty_max=",
      { timeout: 20_000 },
    );
    await expect(run).toHaveText("Run Mission", { timeout: 180_000 });
    await expect(run).toBeEnabled();

    const projected = await readOutcomeMemoryProjection(harness.page);
    expect(
      projected,
      "run two did not receive the learned-failures projection",
    ).toContain("Known failing approaches");
    // Carries the tool name and target kind — never a vault path.
    expect(projected).toContain("get_note_graph_context");
    expect(projected).not.toContain(harness.notePath);
    expect(projected).not.toMatch(/\.md\b/u);
  } finally {
    await harness?.close();
  }
});

/** G5: a run must be correctable mid-flight, not only killable. */
test("CAP-05 a running mission accepts narrowing steering", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-run-steering",
      corePluginDataOverrides: capabilityCoreSettings(),
      setup: async ({ page, notePath }) => {
        await installCapabilityHarness(page, { notePath, charsPerToken: 4 });
      },
    });

    const page = harness.page;
    await page.getByRole("tab", { name: "Chat" }).click();
    await page
      .locator("textarea.agentic-researcher-prompt")
      .fill(`Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_8`);
    await page.locator("button.agentic-researcher-run").click();

    // Exercise the actual native Chat control rather than reaching into the
    // coordinator for the narrowing path.
    const steering = page.getByTestId("run-steering");
    await expect(steering).toBeVisible();
    await page.getByTestId("run-steering-kind").selectOption("drop_tool");
    await page
      .getByTestId("run-steering-tool")
      .selectOption("get_note_graph_context");
    await page
      .getByTestId("run-steering-text")
      .fill("graph context is no longer needed");
    await page.getByTestId("run-steering-submit").click();
    await expect(page.getByTestId("run-steering-status")).toContainText(
      "Steering queued for the next step",
    );
    await page.getByRole("tab", { name: "Run Details" }).click();
    await expect(page.locator(".agentic-researcher-details-panel")).toContainText(
      "Applied 1 steering directive(s)",
      { timeout: 30_000 },
    );

    // Widening remains impossible through the UI and is refused at the
    // coordinator boundary even if an untrusted caller tries it directly.
    const widening = await page.evaluate(({ pluginId }) => {
      const plugin = (window as any).app?.plugins?.plugins?.[pluginId];
      const result = plugin?.runCoordinator?.steerActiveRun?.({
        kind: "add_tool",
        text: "enable a tool the user never approved",
        toolName: "web_fetch",
      });
      return { ok: result?.ok ?? false, code: result?.code ?? null };
    }, { pluginId: NATIVE_CORE_PLUGIN_ID });
    expect(widening.ok).toBe(false);
    expect(widening.code).toBe("would_widen_authority");

    const run = page.locator("button.agentic-researcher-run");
    await expect(run).toHaveText("Run Mission", { timeout: 180_000 });
    await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
      "Idle",
    );
    await expect(steering).toBeHidden();
  } finally {
    await harness?.close();
  }
});

/** G2: cheap phases must be routable away from the primary model. */
test("CAP-06 structured-decision phases route to the utility model", async () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e is Windows-only.");
  let harness: NativeObsidianHarness | null = null;
  try {
    harness = await startNativeObsidianHarness({
      label: "capability-phase-routing",
      corePluginDataOverrides: capabilityCoreSettings({
        utilityModel: UTILITY_MODEL,
        utilityModelProvider: "ollama",
        // The router phase only runs when routing is enabled.
        modelRouterMode: "authority",
        modelRouterEnabled: true,
      }),
      setup: async ({ page, notePath }) => {
        await installCapabilityHarness(page, {
          notePath,
          charsPerToken: 4,
          utilityModel: UTILITY_MODEL,
        });
      },
    });

    await submitMission(harness.page, `Use the vault graph context for the current note, map how it connects to related notes, and summarize the supporting evidence. E2E_CAP_LOOP_STEPS_3`);

    const calls = await readObservedModelCalls(harness.page);
    expect(calls.length).toBeGreaterThan(0);

    const routerCalls = calls.filter((call) => call.phase === "router");
    const agentStepCalls = calls.filter((call) => call.phase === "agent_step");

    // Structured-decision phases moved to the cheaper model...
    expect(routerCalls.length).toBeGreaterThan(0);
    for (const call of routerCalls) {
      expect(call.model).toBe(UTILITY_MODEL);
    }
    // ...and everything producing user-visible output stayed on the primary.
    expect(agentStepCalls.length).toBeGreaterThan(0);
    for (const call of agentStepCalls) {
      expect(call.model).toBe(MOCK_MODEL);
    }
  } finally {
    await harness?.close();
  }
});

function capabilityCoreSettings(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  const verifiedAt = new Date().toISOString();
  return {
    workingMode: "custom",
    outputProfile: "chat_first",
    enableStreaming: false,
    streamWritebackMode: "off",
    thinkingMode: "off",
    model: MOCK_MODEL,
    ollamaBaseUrl: "http://127.0.0.1:11434",
    ollamaApiKey: "",
    modelConnectionVerifiedAt: verifiedAt,
    modelConnectionVerifiedProvider: "ollama",
    modelConnectionVerifiedModel: MOCK_MODEL,
    modelConnectionVerifiedBaseUrl: "http://127.0.0.1:11434",
    orchestratorEnabled: false,
    orchestratorPreviewEnabled: false,
    modelRouterMode: "off",
    modelRouterEnabled: false,
    maxAgentSteps: 100,
    ...overrides,
  };
}

interface CapabilityHarnessInput {
  notePath: string;
  /** Chars per prompt token the mock provider reports. null omits usage. */
  charsPerToken: number | null;
  utilityModel?: string;
}

async function installCapabilityHarness(
  page: Page,
  input: CapabilityHarnessInput,
): Promise<void> {
  await page.evaluate(
    async ({ pluginId, notePath, charsPerToken, mockModel }) => {
      const obsidianWindow = window as typeof window & {
        app?: any;
        __e2eCapabilityModelCalls?: { phase: string; model: string; reportedUsage: boolean }[];
        __e2eCapabilityOutcomeProjection?: string;
      };
      const app = obsidianWindow.app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      if (!app?.vault || !plugin) {
        throw new Error("Capability harness could not access Obsidian services.");
      }

      obsidianWindow.__e2eCapabilityModelCalls = [];

      const ensureFolder = async (folderPath: string) => {
        let current = "";
        for (const part of folderPath.split("/").filter(Boolean)) {
          current = current ? `${current}/${part}` : part;
          if (app.vault.getAbstractFileByPath(current)) continue;
          try {
            await app.vault.createFolder(current);
          } catch (error) {
            if (!/already exists/iu.test(String(error))) throw error;
          }
        }
      };
      const writeText = async (targetPath: string, content: string) => {
        await ensureFolder(targetPath.split("/").slice(0, -1).join("/"));
        const existing = app.vault.getAbstractFileByPath(targetPath);
        if (existing) {
          await app.vault.modify(existing, content);
          return existing;
        }
        return app.vault.create(targetPath, content);
      };

      const baseName =
        notePath.split("/").pop()?.replace(/\.md$/iu, "") ?? "capability";
      const noteFolder = notePath.split("/").slice(0, -1).join("/");
      // Distinct loop-context notes so each step reads a NEW path. Reading the
      // same path every step would trip the runner's no-progress guard and end
      // the run after step 1.
      const loopContextPaths = Array.from(
        { length: 12 },
        (_, index) =>
          `${noteFolder}/loop-context-${baseName}-${index + 1}.md`,
      );
      await writeText(
        notePath,
        `# Capability wire-up fixture\n\n${loopContextPaths
          .map((_, index) => `Related to [[loop-context-${baseName}-${index + 1}]].`)
          .join("\n")}\n`,
      );
      for (const [index, loopPath] of loopContextPaths.entries()) {
        await writeText(
          loopPath,
          `# Loop Context ${index + 1}\n\nRelated to [[${baseName}]]. ` +
            `Bounded evidence for step ${index + 1}.\n`,
        );
      }
      // Open the fixture note so current-note graph context can bind.
      const noteFile = app.vault.getAbstractFileByPath(notePath);
      if (noteFile) {
        const leaf = app.workspace.getLeaf?.(false) ?? app.workspace.getLeaf?.();
        await leaf?.openFile?.(noteFile);
      }

      const loopSteps = new Map<string, number>();

      // Must mirror estimatePromptChars in src/agent/runContext.ts. The runner
      // pairs the provider's token count with *its* character estimate, so a
      // mock measuring characters differently would report an implied ratio
      // that falls outside the plausible band and be correctly discarded.
      const estimatePromptChars = (messages: any[]): number =>
        messages.reduce(
          (sum: number, message: any) =>
            sum +
            String(message.role ?? "").length +
            String(message.content ?? "").length +
            (message.thinking?.length ?? 0) +
            (message.toolName?.length ?? 0) +
            (message.toolCallId?.length ?? 0) +
            (message.toolCalls ? JSON.stringify(message.toolCalls).length : 0) +
            32,
          0,
        );

      const usageFor = (promptChars: number) =>
        charsPerToken === null
          ? { playwrightE2E: true }
          : {
              playwrightE2E: true,
              prompt_eval_count: Math.max(
                1,
                Math.round(promptChars / charsPerToken),
              ),
              eval_count: 32,
            };

      const respond = (request: any, body: any) => {
        const raw = usageFor(estimatePromptChars(request?.messages ?? []));
        obsidianWindow.__e2eCapabilityModelCalls!.push({
          phase: String(request?.evidencePhase ?? "unknown"),
          model: String(request?.model ?? mockModel),
          reportedUsage: "prompt_eval_count" in raw,
        });
        return { ...body, raw };
      };

      const modelResponse = (request: any, content: string) =>
        respond(request, {
          message: { role: "assistant", content },
          toolCalls: [],
        });

      const modelToolResponse = (request: any, id: string, call: any) =>
        respond(request, {
          message: {
            role: "assistant",
            content: "",
            toolCalls: [{ ...call, id }],
          },
          toolCalls: [{ ...call, id }],
        });

      const chat = async (request: any) => {
        const messages = request?.messages ?? [];
        const latestUserText = String(
          [...messages].reverse().find((m: any) => m.role === "user")?.content ??
            "",
        );
        const toolNames: string[] = (request?.tools ?? []).map(
          (tool: any) => tool.function.name,
        );

        // Capture what the runner projected about learned failures.
        const learned = messages.find(
          (m: any) =>
            m.role === "system" &&
            String(m.content).startsWith("Known failing approaches"),
        );
        if (learned) {
          obsidianWindow.__e2eCapabilityOutcomeProjection = String(
            learned.content,
          );
        }

        const loopMatch = /E2E_CAP_LOOP_STEPS_(\d+)/u.exec(latestUserText);
        if (loopMatch) {
          const targetSteps = Math.max(1, Number.parseInt(loopMatch[1]!, 10));
          if (targetSteps >= 5) {
            await new Promise((resolve) =>
              setTimeout(resolve, targetSteps >= 8 ? 250 : 120),
            );
          }
          const key = loopMatch[0];
          const completed = loopSteps.get(key) ?? 0;
          if (
            completed < targetSteps - 1 &&
            toolNames.includes("get_note_graph_context")
          ) {
            loopSteps.set(key, completed + 1);
            return modelToolResponse(request, `cap-loop-${completed + 1}`, {
              name: "get_note_graph_context",
              arguments: {
                path: loopContextPaths[completed % loopContextPaths.length],
              },
            });
          }
          return modelResponse(
            request,
            `E2E_CAP_LOOP_DONE_${targetSteps} Completed the requested synthesis.`,
          );
        }

        return modelResponse(request, `Capability response for ${latestUserText}.`);
      };

      const createModelClient = () => ({
        descriptor: {
          provider: "ollama",
          model: mockModel,
          endpointCategory: "local",
          transportKind: "test_mock",
        },
        chat,
        streamChat: chat,
      });

      const install = (target: any) => {
        if (!target) return;
        target.createModelClient = createModelClient;
        target.__playwrightE2EMockInstalled = true;
        const prototype = Object.getPrototypeOf(target);
        if (prototype) {
          prototype.createModelClient = createModelClient;
        }
      };

      install(plugin);
      for (const leaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        install(leaf.view?.plugin);
      }
    },
    {
      pluginId: NATIVE_CORE_PLUGIN_ID,
      notePath: input.notePath,
      charsPerToken: input.charsPerToken,
      mockModel: MOCK_MODEL,
    },
  );
}

async function readObservedModelCalls(
  page: Page,
): Promise<{ phase: string; model: string; reportedUsage: boolean }[]> {
  return page.evaluate(
    () =>
      (window as typeof window & {
        __e2eCapabilityModelCalls?: { phase: string; model: string; reportedUsage: boolean }[];
      }).__e2eCapabilityModelCalls ?? [],
  );
}

async function readFailingGraphRecord(
  page: Page,
): Promise<{ toolName: string; errorCode: string; failures: number } | null> {
  return page.evaluate(
    async ({ pluginId }) => {
      const app = (window as any).app;
      const plugin = app?.plugins?.plugins?.[pluginId];
      // The ledger is flushed at run completion; poll briefly for it to settle.
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const records = plugin?.toolOutcomeMemory?.records ?? [];
        // Any recurring get_note_graph_context failure — the specific error
        // code is the runner's to choose, not the test's to dictate.
        const match = records.find(
          (entry: any) =>
            entry.toolName === "get_note_graph_context" && entry.failures >= 2,
        );
        if (match) {
          return {
            toolName: String(match.toolName),
            errorCode: String(match.errorCode),
            failures: Number(match.failures),
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return null;
    },
    { pluginId: NATIVE_CORE_PLUGIN_ID },
  );
}

async function readOutcomeMemoryProjection(page: Page): Promise<string> {
  return page.evaluate(
    () =>
      (window as typeof window & {
        __e2eCapabilityOutcomeProjection?: string;
      }).__e2eCapabilityOutcomeProjection ?? "",
  );
}

async function submitMission(
  page: Page,
  prompt: string,
  timeout = 180_000,
): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  const run = page.locator("button.agentic-researcher-run");
  await input.fill(prompt);
  await run.click();
  await expect(
    page
      .locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
        hasText: prompt,
      })
      .last(),
  ).toBeVisible({ timeout: 10_000 });
  await expect(run).toHaveText("Run Mission", { timeout });
  await expect(run).toBeEnabled();
  await expect(page.locator(".agentic-researcher-run-status-text")).toHaveText(
    "Idle",
  );
}

async function readRunDetailsText(page: Page): Promise<string> {
  await page.getByRole("tab", { name: "Run Details" }).click();
  return page.locator(".agentic-researcher-details-panel").innerText();
}
