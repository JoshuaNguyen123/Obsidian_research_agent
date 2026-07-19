import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test, type Page } from "@playwright/test";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";

import {
  createPhase4GitFixture,
  createPhase4TypeScriptProjectFixture,
  type Phase4GitFixture,
} from "./fixtures/phase4GitRepo";
import {
  PHASE4_CODE_PLUGIN_ID,
  PHASE4_REQUIRED_CRUD_TOOLS,
  PHASE4_REQUIRED_REPAIR_TOOLS,
  PHASE4_REQUIRED_SANDBOX_TOOLS,
  type Phase4Harness,
  type Phase4ToolCatalogEntry,
  startPhase4Harness,
} from "./fixtures/phase4Harness";
import { startRealAiHarness } from "./fixtures/realAiHarness";
import { liveProviderConfiguration } from "../scripts/ci-sandbox-boundary";
import type { DailyUseObservedAcceptanceV1 } from "../src/agent/dailyUseAcceptance";

const SUITE_TIMEOUT_MS = 420_000;
const MISSION_TIMEOUT_MS = 240_000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LIVE_CODE_LANE = (process.env.E2E_PLAYWRIGHT_LANE ?? "")
  .split(",")
  .includes("daily-use-code-live");

test.describe("Daily-use Code capability production boundaries", () => {
  test.describe.configure({ timeout: SUITE_TIMEOUT_MS });
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  let harness: Phase4Harness | null = null;

  test.beforeAll(async () => {
    if (LIVE_CODE_LANE) return;
    harness = await startPhase4Harness("phase4-code");
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("DU-03 protected real-model TypeScript project creation, validation, README, commit, and readback", async ({}, testInfo) => {
    test.skip(
      !LIVE_CODE_LANE,
      "The real-model code proof runs only in the targeted protected daily-use-code-live lane.",
    );
    test.setTimeout(45 * 60_000);
    const startedAt = Date.now();
    const marker = `DU03_LIVE_${startedAt}`;
    const fixture = await createPhase4TypeScriptProjectFixture(marker);
    const workspaceId = `du03-live-${startedAt}`;
    let liveHarness: Awaited<ReturnType<typeof startRealAiHarness>> | null = null;
    let verifiedWorktree: { root: string; branch: string } | null = null;
    let acceptanceRecorded = false;
    let runCounters = {
      modelCalls: 0,
      toolCalls: 0,
      continuations: 0,
      approvals: 0,
    };
    const observed = createMutableDailyUseObserved();
    try {
      liveHarness = await startRealAiHarness(
        "du03-protected-real-model-code",
        {
          missionTimeoutMs: 40 * 60_000,
          completionTimeoutMs: 40 * 60_000,
        },
        {
          maxAgentSteps: 80,
          maxRunMinutes: 40,
          orchestratorEnabled: false,
          completionDrivenLoops: true,
        },
      );
      const sandboxConfig = liveProviderConfiguration("wsl2");
      const sandboxProbe = await liveHarness.page.evaluate(
        async ({ codePluginId, config }) => {
          const app = (window as typeof window & { app?: any }).app;
          const code = app?.plugins?.plugins?.["agentic-researcher"]
            ?.getBundledCapability?.(codePluginId);
          if (!code?.configureSandboxProvider || !code?.probeConfiguredSandboxProviders) {
            throw new Error("The built-in Code sandbox configuration API is unavailable.");
          }
          await code.configureSandboxProvider(config);
          const status = await code.probeConfiguredSandboxProviders();
          const persisted = code.readState?.()?.sandbox?.lastProbe ?? null;
          return { status, persisted };
        },
        { codePluginId: PHASE4_CODE_PLUGIN_ID, config: sandboxConfig },
      );
      expect(sandboxProbe.status).toMatchObject({
        executionAvailable: true,
        selectedProvider: "wsl2",
      });
      expect(Date.parse(String(sandboxProbe.persisted?.observedAt ?? ""))).toBeGreaterThanOrEqual(
        startedAt,
      );
      observed.proofs.add("sandbox:boundary_attested");

      const requestId = `du03-request-${startedAt}`;
      const mission = [
        `Implement a complete TypeScript math package in the exact trusted local repository ${fixture.root}.`,
        `Create repository workspace ${workspaceId} and use one repair request id ${requestId} for every validation and commit call.`,
        "First read the exact protected package.json, scripts/import-simple-typescript.mjs, and scripts/verify-project.mjs contracts.",
        "Create exactly src/math.ts, src/index.ts, test/math.test.mjs, and README.md; do not change package.json, either protected script, workflows, hooks, or any other path.",
        `src/math.ts must export a working add(left, right) function and an exported marker equal to ${marker}. src/index.ts must re-export the public API from ./math.js, ./math.ts, or the extensionless ./math specifier.`,
        `The dependency-free Node 18 test must import node:test, node:assert/strict, and importSimpleTypeScript from ../scripts/import-simple-typescript.mjs; call that loader exactly as importSimpleTypeScript("src/math.ts") because it resolves from the repository working directory, test the add behavior, and verify marker ${marker}. Do not use Jest or any third-party package. README.md must document npm test and include ${marker}.`,
        "Detect the repository profile, read back every created file, run targeted validation, then run a distinct fresh full validation, create one local commit with message feat: add protected TypeScript math package, and independently read the exact commit SHA back.",
        "Use the visible exact approval surface whenever required. Stop only after a verified_code_publication_handoff proves the four changed paths, targeted and fresh-full validation, clean worktree, and commit readback.",
      ].join(" ");
      await liveHarness.submitMission(mission, {
        waitForCompletion: false,
        timeoutMs: 40 * 60_000,
      });
      const approvals = await liveHarness.approveUntilMissionComplete(
        40 * 60_000,
        {
          onProgress: (counters) => {
            runCounters = { ...runCounters, ...counters };
            if (counters.approvals > 0) {
              observed.approvals.add("approval:sandbox_execution");
            }
          },
        },
      );
      runCounters.approvals = approvals;
      if (approvals > 0) observed.approvals.add("approval:sandbox_execution");
      const snapshot = await liveHarness.attestProductionRun({
        requireStructuredRouting: true,
      });
      runCounters = {
        ...runCounters,
        modelCalls: snapshot.modelCallEvidence.length,
        toolCalls: snapshot.missionEvidence.length,
      };
      const statusResult = await executeReadOnlyCodeTool(
        liveHarness.page,
        "code_workspace_status",
        { workspaceId },
        `Read back exact workspace ${workspaceId} after the protected mission.`,
      );
      const workspaceStatus = requireRecord(
        toolOutput(statusResult),
        "protected TypeScript workspace status",
      );
      const manifest = requireRecord(
        workspaceStatus.manifest,
        "protected TypeScript workspace manifest",
      );
      const repositoryBinding = requireRecord(
        manifest.repositoryBinding,
        "protected TypeScript repository binding",
      );
      const profileKey = requireString(
        repositoryBinding.profileKey,
        "protected TypeScript profile key",
      );
      const handoff = await liveHarness.page.evaluate(
        async ({ codePluginId, profileKey }) => {
          const app = (window as typeof window & { app?: any }).app;
          const code = app?.plugins?.plugins?.["agentic-researcher"]
            ?.getBundledCapability?.(codePluginId);
          return code?.resolveVerifiedCodePublicationHandoff?.(profileKey) ?? null;
        },
        { codePluginId: PHASE4_CODE_PLUGIN_ID, profileKey },
      );
      expect(handoff?.status, JSON.stringify({
        complete: snapshot.lastComplete,
        acceptance: snapshot.lastMissionLedger?.acceptance ?? null,
        graph: snapshot.lastMissionGraph?.routing ?? null,
      })).toBe("verified");
      if (!handoff) throw new Error("Protected DU-03 did not produce a verified code handoff.");
      expect(handoff.workspaceId).toBe(workspaceId);
      expect(handoff.baseSha).toBe(fixture.baseSha);
      expect(handoff.parentSha).toBe(fixture.baseSha);
      expect(handoff.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(handoff.targetedValidationReceiptId).not.toBe(
        handoff.fullValidationReceiptId,
      );
      expect(handoff.targetedValidationFingerprint).toMatch(FINGERPRINT_PATTERN);
      expect(handoff.fullValidationFingerprint).toMatch(FINGERPRINT_PATTERN);
      expect([...handoff.changedPaths].sort()).toEqual([
        "README.md",
        "src/index.ts",
        "src/math.ts",
        "test/math.test.mjs",
      ]);
      verifiedWorktree = {
        root: handoff.canonicalWorktreeRoot,
        branch: handoff.branch,
      };
      const worktree = await fixture.inspectWorktree(handoff.canonicalWorktreeRoot);
      expect(worktree.head).toBe(handoff.commitSha);
      expect(worktree.status).toBe("");
      expect(worktree.changedPaths).toEqual([...handoff.changedPaths].sort());
      expect(worktree.files["src/math.ts"]).toMatch(/export\s+function\s+add/iu);
      expect(worktree.files["src/math.ts"]).toContain(marker);
      expect(worktree.files["src/index.ts"]).toMatch(/export/iu);
      expect(worktree.files["test/math.test.mjs"]).toMatch(/add/iu);
      expect(worktree.files["README.md"]).toContain(marker);
      expect(await fixture.head()).toBe(fixture.baseSha);
      expect(await fixture.status()).toBe("");

      addObserved(observed.artifacts, [
        "code:source_files",
        "code:tests",
        "code:readme",
        "git:local_commit",
      ]);
      addObserved(observed.proofs, [
        "code:trusted_repository",
        "code:durable_workspace",
        "validation:targeted",
        "validation:fresh_full",
        "git:commit_readback",
      ]);
      observed.bindings.add("git:commit_artifacts");

      await recordDailyUseAcceptance(
        testInfo,
        "DU-03",
        snapshotMutableDailyUseObserved(observed),
        runCounters,
        { requireComplete: true },
      );
      acceptanceRecorded = true;
    } finally {
      if (!acceptanceRecorded) {
        if (liveHarness) {
          runCounters = await readDailyUseRunCounters(
            liveHarness.page,
            runCounters.approvals,
          ).catch(() => runCounters);
        }
        await recordDailyUseAcceptance(
          testInfo,
          "DU-03",
          snapshotMutableDailyUseObserved(observed),
          runCounters,
        ).catch(() => undefined);
      }
      if (!verifiedWorktree && liveHarness) {
        verifiedWorktree = await readOwnedRepositoryWorktreeFromCodeStatus(
          liveHarness.page,
          workspaceId,
        ).catch(() => null);
      }
      if (verifiedWorktree) {
        await fixture
          .removeOwnedWorktree(verifiedWorktree.root, verifiedWorktree.branch)
          .catch(() => undefined);
      }
      await liveHarness?.close().catch(() => undefined);
      await cleanupOwnedWorkspaceMetadata(workspaceId).catch(() => undefined);
      await fixture.cleanup();
    }
  });

  test("LANG-01 creates and reads back eleven supported source languages", async () => {
    test.skip(
      LIVE_CODE_LANE,
      "The deterministic language-creation contract runs in the targeted daily-use-code lane.",
    );
    const active = requireHarness(harness);
    const files = [
      { language: "python", path: "app.py", content: `MARKER = "${active.marker}"\n` },
      { language: "typescript", path: "app.ts", content: `export const marker: string = "${active.marker}";\n` },
      { language: "javascript", path: "app.js", content: `export const marker = "${active.marker}";\n` },
      { language: "c", path: "app.c", content: `const char *marker = "${active.marker}";\n` },
      { language: "cpp", path: "app.cpp", content: `const char* marker = "${active.marker}";\n` },
      { language: "html", path: "index.html", content: `<!doctype html><title>${active.marker}</title>\n` },
      { language: "css", path: "styles.css", content: `/* ${active.marker} */\nbody { color: green; }\n` },
      { language: "rust", path: "app.rs", content: `const MARKER: &str = "${active.marker}";\n` },
      { language: "go", path: "app.go", content: `package main\nconst marker = "${active.marker}"\n` },
      { language: "java", path: "App.java", content: `final class App { static final String MARKER = "${active.marker}"; }\n` },
      { language: "csharp", path: "Program.cs", content: `internal static class Program { internal const string Marker = "${active.marker}"; }\n` },
    ];
    const workspaceIds = new Map<string, string>();
    let completedMissions = 0;
    for (const file of files) {
      const workspaceId = `phase4-${file.language}-${active.marker.toLowerCase()}`;
      workspaceIds.set(file.language, workspaceId);
      await active.configureScenario("language-create", { workspaceId, files: [file] });
      await active.submitMissionWithApprovals(
        [
          `LANG-01 create isolated scratch workspace ${workspaceId}, then create ${file.path}.`,
          "Use exactly code_workspace_create and code_workspace_create_file through the normal prepared approval path.",
          "Do not overwrite any path and stop only after both exact creation receipts are committed.",
        ].join(" "),
        { timeoutMs: MISSION_TIMEOUT_MS },
      );
      completedMissions += 1;
    }
    expect(completedMissions).toBe(files.length);
    expect(workspaceIds.size).toBe(files.length);
    for (const file of files) {
      const workspaceId = workspaceIds.get(file.language);
      if (!workspaceId) throw new Error(`Missing LANG-01 workspace for ${file.language}.`);
      const result = await active.executeTool(
        "code_workspace_read",
        { workspaceId, path: file.path },
        `Read back LANG-01 source file ${file.path}.`,
      );
      expect(
        requireString(
          requireRecord(toolOutput(result), `${file.path} readback`).content,
          `${file.path} content`,
        ),
      ).toBe(file.content);
    }
  });

  test("managed metadata boundary supports durable CRUD and restart with hashes and trash/restore receipts", async () => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const catalog = await active.readToolCatalog();
    const missing = missingTools(catalog, PHASE4_REQUIRED_CRUD_TOOLS);
    expect(
      missing,
      registrationGap(
        "durable workspace CRUD",
        missing,
        "the built-in Code capability did not expose the required production workspace contracts",
      ),
    ).toEqual([]);

    const workspaceId = `phase4-crud-${active.marker.toLowerCase()}`;
    const originalPath = "src/durable-value.txt";
    const movedPath = "src/durable-value-restored.txt";
    let cleanupStatus: Record<string, unknown> | null = null;
    try {
      await active.configureScenario("crud-stage-1", {
        workspaceId,
        originalPath,
        movedPath,
      });
      const stageOneApprovals = await active.submitMissionWithApprovals(
        [
          `Create the isolated scratch workspace ${workspaceId}.`,
          "Use exactly code_workspace_create, code_workspace_mkdir, code_workspace_create_file, code_workspace_read, code_workspace_write_expected, code_workspace_move, code_workspace_trash, and code_workspace_restore.",
          `Create ${originalPath} containing before:${active.marker}, read its hash, replace it with after:${active.marker}, move it to ${movedPath}, trash it, and restore the exact trashId.`,
          "Use the actual approval UI for every prepared action and surface the before/after hashes and trash/restore receipts in Run Details.",
        ].join(" "),
        { timeoutMs: MISSION_TIMEOUT_MS },
      );
      const approvalText = stageOneApprovals.join("\n");
      expect(approvalText).not.toContain("native execution");
      // Explicit prompt grants cover bounded create/write operations. The
      // remaining exact actions must use the visible approval surface.
      for (const name of [
        "code_workspace_move",
        "code_workspace_trash",
        "code_workspace_restore",
      ]) {
        expect(approvalText, `approval UI should bind ${name}`).toContain(name);
      }
      const beforeSha256 = sha256(`before:${active.marker}\n`);
      const expectedAfterSha256 = sha256(`after:${active.marker}\n`);
      expect(approvalText).toContain(expectedAfterSha256);
      const trashApprovals = stageOneApprovals.filter((text) =>
        text.includes("code_workspace_trash"),
      );
      expect(trashApprovals.length).toBeGreaterThanOrEqual(1);
      expect(trashApprovals.length).toBeLessThanOrEqual(2);
      expect(trashApprovals[0]).toContain(
        `confirmation=1/${trashApprovals.length}`,
      );
      expect(trashApprovals[trashApprovals.length - 1]).toContain(
        `confirmation=${trashApprovals.length}/${trashApprovals.length}`,
      );
      const trashFingerprints = trashApprovals.map(
        (text) => text.match(/fingerprint=(sha256:[a-f0-9]{17})/u)?.[1] ?? "",
      );
      expect(trashFingerprints[0]).not.toBe("");
      expect(new Set(trashFingerprints)).toEqual(new Set([trashFingerprints[0]]));

      await active.page.getByRole("tab", { name: "Run Details" }).click();
      const details = active.page.locator(".agentic-researcher-details-panel");
      await expect(details).toContainText("code_workspace_trash");
      await expect(details).toContainText("code_workspace_restore");
      await expect(details).toContainText(beforeSha256);
      await expect(details).toContainText(expectedAfterSha256);
      await expect(active.page.locator(".agentic-researcher-receipt")).toHaveCount(7);

      const initialStatusResult = await active.executeTool(
        "code_workspace_status",
        { workspaceId },
        `Inspect the Phase 4 fixture workspace ${workspaceId}.`,
      );
      cleanupStatus = requireRecord(
        toolOutput(initialStatusResult),
        "workspace status before restart",
      );
      const initialManifest = requireRecord(
        cleanupStatus.manifest,
        "workspace manifest before restart",
      );
      const canonicalRoot = requireString(
        initialManifest.canonicalRoot,
        "workspace canonical root before restart",
      );
      expect(path.basename(canonicalRoot).toLowerCase()).toBe("root");
      expect(path.basename(path.dirname(canonicalRoot))).toBe(workspaceId);
      expect(
        path.basename(path.dirname(path.dirname(canonicalRoot))).toLowerCase(),
      ).toBe("workspaces-v2");

      await active.restartUnifiedPlugin();
      const catalogAfterRestart = await active.readToolCatalog();
      expect(missingTools(catalogAfterRestart, PHASE4_REQUIRED_CRUD_TOOLS)).toEqual([]);

      const resumedResult = await active.executeTool(
        "code_workspace_read",
        { workspaceId, path: movedPath },
        `Resume and read the durable Phase 4 fixture workspace ${workspaceId}.`,
      );
      const resumed = requireRecord(
        toolOutput(resumedResult),
        "workspace read after restart",
      );
      expect(resumed.content).toBe(`after:${active.marker}\n`);
      const afterSha256 = requireSha256(resumed.sha256, "after SHA-256");
      expect(afterSha256).toBe(expectedAfterSha256);
      expect(afterSha256).not.toBe(beforeSha256);
    } finally {
      await cleanupOwnedScratchWorkspace(active, workspaceId, cleanupStatus);
    }
  });

  test("failed sandbox boundary probe leaves editing available and never falls back to native execution", async () => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const catalog = await active.readToolCatalog();
    const missing = missingTools(catalog, PHASE4_REQUIRED_SANDBOX_TOOLS);
    test.skip(
      missing.length > 0,
      registrationGap(
        "sandbox failure proof",
        missing,
        "the built-in Code capability did not expose the required production sandbox contracts",
      ),
    );

    const runCodeDescriptor = catalog.find((entry) => entry.name === "run_code_block")?.descriptor;
    expect(
      nestedString(runCodeDescriptor, "execution", "preparation"),
      "run_code_block must be the sandbox-only prepared descriptor, not a legacy host executor",
    ).toBe("required");

    const probeRoot = await mkdtemp(path.join(tmpdir(), "agentic-phase4-sandbox-"));
    const nativeFallbackProbePath = path.join(probeRoot, "native-fallback-must-not-exist.txt");
    try {
      const persistedProbe = await active.runSandboxBoundaryProbe();
      test.skip(
        persistedProbe === null,
        "The built-in Code boundary-probe seam is unavailable; code_sandbox_status is intentionally read-only and cannot prove a completed boundary probe by itself.",
      );
      if (!persistedProbe) {
        throw new Error("Sandbox probe command did not return persisted status.");
      }
      expect(typeof persistedProbe.observedAt).toBe("string");
      const persistedStatus = requireRecord(
        persistedProbe.status,
        "persisted sandbox probe status",
      );
      expect(persistedStatus.mode).toBe("editing_only");
      expect(persistedStatus.executionAvailable).toBe(false);
      expect(persistedStatus.editingAvailable).toBe(true);

      const attempted = await active.executeTool(
        "run_code_block",
        {
          language: "javascript",
          code: `require('node:fs').writeFileSync(${JSON.stringify(nativeFallbackProbePath)}, 'unsafe')`,
        },
        "Attempt the Phase 4 sandbox-only failure probe. Do not use native execution.",
      );
      expect(attempted.ok).toBe(false);
      expect(attempted.error?.code).toBe("prepared_action_required");
      await expectPathAbsent(nativeFallbackProbePath);

      const statusResult = await active.executeTool(
        "code_sandbox_status",
        {},
        "Read the cached result of the explicit Phase 4 sandbox boundary probe.",
      );
      const status = requireRecord(toolOutput(statusResult), "sandbox status");
      expect(status.mode).toBe("editing_only");
      expect(status.executionAvailable).toBe(false);
      expect(status.editingAvailable).toBe(true);
      expect(status.selectedProvider).toBeNull();
      const blocker = requireRecord(status.blocker, "sandbox blocker");
      expect([
        "sandbox_provider_unavailable",
        "sandbox_boundary_probe_failed",
      ]).toContain(blocker.code);
      expect(blocker.executionAvailable).toBe(false);
      expect(blocker.editingAvailable).toBe(true);
      await expectPathAbsent(nativeFallbackProbePath);
    } finally {
      await cleanupOwnedTempDirectory(probeRoot, "agentic-phase4-sandbox-");
    }
  });

  test("DU-03 fixture Git repair commits only after targeted and fresh-full validation, or exposes a durable production blocker", async ({}, testInfo) => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const fixture = await createPhase4GitFixture(active.marker);
    const workspaceId = `phase4-repair-${active.marker.toLowerCase()}`;
    let workspaceStatus: Record<string, unknown> | null = null;
    try {
      expect(await fixture.head()).toBe(fixture.baseSha);
      expect(await fixture.status()).toBe("");
      expect(await fixture.readSource()).toContain("return left - right");

      const catalog = await active.readToolCatalog();
      const missing = missingTools(catalog, PHASE4_REQUIRED_REPAIR_TOOLS);
      expect(
        missing,
        "The unified plugin must atomically register its Code workspace, sandbox, repair, and verified-commit tools before repair e2e can proceed.",
      ).toEqual([]);

      await active.configureScenario("repository-create", {
        workspaceId,
        repositoryRoot: fixture.root,
      });
      const workspaceApprovals = await active.submitMissionWithApprovals(
        [
          `Create a repository workspace for the exact local fixture ${fixture.root}.`,
          `Use code_workspace_create with workspaceId ${workspaceId}.`,
          "Approve the exact worktree action in Run Details; do not edit the base checkout.",
        ].join(" "),
        { timeoutMs: MISSION_TIMEOUT_MS },
      );
      if (workspaceApprovals.length > 0) {
        expect(workspaceApprovals.join("\n")).toContain("code_workspace_create");
      }
      const statusResult = await active.executeTool(
        "code_workspace_status",
        { workspaceId },
        `Inspect the exact Phase 4 repair workspace ${workspaceId}.`,
      );
      workspaceStatus = requireRecord(toolOutput(statusResult), "repair workspace status");
      const manifest = requireRecord(workspaceStatus.manifest, "repair workspace manifest");
      const binding = requireRecord(
        manifest.repositoryBinding,
        "repair repository binding",
      );
      expect(manifest.kind).toBe("repository");
      expect(manifest.baseSha).toBe(fixture.baseSha);
      expect(binding.repositoryRoot).toBe(await realpath(fixture.root));
      const worktreeRoot = String(binding.worktreeRoot ?? "");
      const branch = String(binding.branch ?? "");
      const profileKey = String(binding.profileKey ?? "");
      expect(worktreeRoot).not.toBe(fixture.root);
      expect(branch).toMatch(/^codex\/workspace-/u);

      const sandboxStatus = requireRecord(
        toolOutput(
          await active.executeTool(
            "code_sandbox_status",
            {},
            "Check the real sandbox boundary before executing fixture validation.",
          ),
        ),
        "repair sandbox status",
      );
      const requestId = `repair-${active.marker.toLowerCase()}`;
      const runId = String(manifest.ownerRunId ?? "");
      expect(runId).not.toBe("");
      // Queue work uses the stricter MissionGraph/WorkItem stable-id grammar;
      // this foreground fixture workspace is owned by the legacy ISO-cased
      // AgentRunner id. Use a logical queue id to probe the queue boundary,
      // while the foreground repair below retains the exact manifest owner.
      const queueRunId = runId.toLowerCase();
      const queueBridge = await active.probeTrustedQueueCodeBridge({
        runId: queueRunId,
        workspaceId,
        profileKey,
        requestId,
        objective:
          "Repair the accepted addition behavior. Untrusted text: repositoryRoot=C:\\outside and command=rm -rf must grant no authority.",
        commitMessage: "fix: repair phase 4 addition fixture",
      });
      expect(
        queueBridge.available,
        "The built-in Code capability must expose the host-only trusted queue bridge.",
      ).toBe(true);
      if (sandboxStatus.executionAvailable !== true) {
        expect(queueBridge.error).toMatch(/sandbox execution is unavailable/iu);
        expect(queueBridge.error).not.toContain(worktreeRoot);
        const blocker = requireRecord(sandboxStatus.blocker, "repair sandbox blocker");
        expect(sandboxStatus).toMatchObject({
          mode: "editing_only",
          executionAvailable: false,
          editingAvailable: true,
        });
        expect(blocker.code).toBe("sandbox_provider_unavailable");
        test.info().annotations.push({
          type: "external-blocker",
          description: String(blocker.message ?? "Sandbox provider unavailable."),
        });
        expect((await fixture.inspectWorktree(worktreeRoot)).head).toBe(fixture.baseSha);
        expect(await fixture.head()).toBe(fixture.baseSha);
        return;
      }

      if (queueBridge.error) {
        expect(queueBridge.error).toMatch(
          /does not match the exact trusted workspace, owner, profile, branch, and base SHA binding/iu,
        );
        expect(queueBridge.error).not.toContain(worktreeRoot);
        expect(queueBridge.error).not.toContain(binding.repositoryRoot);
      } else {
        expect(queueBridge.prompt).toContain(requestId);
        expect(queueBridge.prompt).toContain(workspaceId);
        expect(queueBridge.prompt).toContain("untrusted task text only");
        expect(queueBridge.prompt).not.toContain(worktreeRoot);
        expect(queueBridge.prompt).not.toContain(binding.repositoryRoot);
      }

      const repairRun = await active.runPublicRepairWithApprovals(
        {
          id: requestId,
          runId,
          objective:
            "Repair src/value.mjs so add(left, right) returns the sum, preserve fixtureMarker, and change no other tracked file.",
          worktree: {
            id: workspaceId,
            path: worktreeRoot,
            repositoryRoot: binding.repositoryRoot,
            branch,
            baseSha: fixture.baseSha,
            profileId: profileKey,
          },
          commitMessage: "fix: repair phase 4 addition fixture",
          maxCycles: 3,
          expectedArtifacts: [],
          protectedControlPaths: [],
        },
        { timeoutMs: 360_000 },
      );
      expect(
        repairRun.available,
        "Registered repair tools require a public coordinator route; direct module imports are forbidden in this e2e.",
      ).toBe(true);
      expect(repairRun.error, JSON.stringify(repairRun.error)).toBeUndefined();
      expect(repairRun.approvals.length).toBeGreaterThan(0);
      const verifiedCommit = findRecordByKind(
        repairRun.result,
        "verified_local_commit",
      );
      expect(verifiedCommit).not.toBeNull();
      if (!verifiedCommit) throw new Error("Verified local commit receipt was absent.");
      expect(verifiedCommit.status).toBe("verified");
      expect(verifiedCommit.baseSha).toBe(fixture.baseSha);
      expect(verifiedCommit.parentSha).toBe(fixture.baseSha);
      expect(verifiedCommit.commitSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(verifiedCommit.commitSha).not.toBe(fixture.baseSha);
      expect(verifiedCommit.treeSha).toMatch(/^[a-f0-9]{40}$/u);
      expect(verifiedCommit.diffFingerprint).toMatch(FINGERPRINT_PATTERN);
      expect(verifiedCommit.fingerprint).toMatch(FINGERPRINT_PATTERN);
      expect(verifiedCommit.changedPaths).toEqual(["src/value.mjs"]);
      expect(verifiedCommit.targetedValidationReceiptId).not.toBe(
        verifiedCommit.fullValidationReceiptId,
      );
      expect(verifiedCommit.targetedValidationFingerprint).toMatch(
        FINGERPRINT_PATTERN,
      );
      expect(verifiedCommit.fullValidationFingerprint).toMatch(FINGERPRINT_PATTERN);

      const worktree = await fixture.inspectWorktree(worktreeRoot);
      expect(worktree.head).toBe(verifiedCommit.commitSha);
      expect(worktree.status).toBe("");
      expect(worktree.source).toContain("return left + right");
      expect(await fixture.head()).toBe(fixture.baseSha);
      expect(await fixture.status()).toBe("");
      await recordDailyUseAcceptance(testInfo, "DU-03", {
        artifacts: ["code:source_files", "git:local_commit"],
        proofs: [
          "code:trusted_repository",
          "code:durable_workspace",
          "sandbox:boundary_attested",
          "validation:targeted",
          "validation:fresh_full",
          "git:commit_readback",
        ],
        approvals: ["approval:sandbox_execution"],
        bindings: ["git:commit_artifacts"],
        cleanup: [],
      }, {
        toolCalls: repairRun.approvals.length + 4,
        approvals: repairRun.approvals.length,
      });
    } finally {
      await cleanupOwnedRepositoryWorkspace(active, fixture, workspaceId, workspaceStatus);
      await fixture.cleanup();
    }
  });

  test("Code is an atomic built-in capability of the one installed plugin", async () => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const state = await readExtensionState(active);
    expect(state).toEqual({
      loaded: true,
      registered: true,
      separateManifestInstalled: false,
      separatelyEnabled: false,
    });

    const catalog = await active.readToolCatalog();
    const names = catalog.map((entry) => entry.name);
    expect(names).toContain("read_current_file");
    for (const name of [
      ...PHASE4_REQUIRED_CRUD_TOOLS,
      ...PHASE4_REQUIRED_SANDBOX_TOOLS,
      ...PHASE4_REQUIRED_REPAIR_TOOLS,
    ]) {
      expect(names, `${name} must ship with the unified plugin`).toContain(name);
    }

    await expect(active.page.getByRole("tab", { name: "Chat" })).toBeVisible();
    await expect(active.page.getByRole("tab", { name: "Run Details" })).toBeVisible();
    await expect(active.page.locator("textarea.agentic-researcher-prompt")).toBeEnabled();
    await expect(active.page.locator("button.agentic-researcher-run")).toBeEnabled();
  });
});

function requireHarness(harness: Phase4Harness | null): Phase4Harness {
  if (!harness) throw new Error("Phase 4 harness did not start.");
  return harness;
}

async function executeReadOnlyCodeTool(
  page: Page,
  name: string,
  args: Record<string, unknown>,
  prompt: string,
): Promise<any> {
  return page.evaluate(
    async ({ toolName, toolArgs, originalPrompt }) => {
      const app = (window as typeof window & { app?: any }).app;
      const core = app?.plugins?.plugins?.["agentic-researcher"];
      if (!core?.createToolRegistry || !core?.createToolExecutionContext) {
        throw new Error("Core tool execution API is unavailable.");
      }
      return core.createToolRegistry().execute(
        {
          id: `du03-readback-${toolName}-${Date.now()}`,
          name: toolName,
          arguments: toolArgs,
        },
        core.createToolExecutionContext(originalPrompt),
      );
    },
    { toolName: name, toolArgs: args, originalPrompt: prompt },
  );
}

function missingTools(
  catalog: Phase4ToolCatalogEntry[],
  required: readonly string[],
): string[] {
  const names = new Set(catalog.map((entry) => entry.name));
  return required.filter((name) => !names.has(name));
}

function registrationGap(workflow: string, missing: string[], detail: string): string {
  return `Cannot exercise ${workflow} through the installed production registry. Missing tools: ${missing.join(", ")}. ${detail}. The test intentionally does not simulate success.`;
}

function toolOutput(result: unknown): unknown {
  const record = requireRecord(result, "tool execution result");
  expect(record.ok, JSON.stringify(record)).toBe(true);
  return record.output;
}

function requireRecord(value: unknown, label: string): Record<string, any> {
  if (!isRecord(value)) throw new Error(`${label} was not an object.`);
  return value;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function requireSha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${label} was not a lowercase SHA-256 fingerprint.`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} was not a non-empty string.`);
  }
  return value;
}

function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function nestedString(
  value: unknown,
  first: string,
  second: string,
): string | null {
  if (!isRecord(value) || !isRecord(value[first])) return null;
  return typeof value[first][second] === "string" ? value[first][second] : null;
}

async function readExtensionState(active: Phase4Harness): Promise<{
  loaded: boolean;
  registered: boolean;
  separateManifestInstalled: boolean;
  separatelyEnabled: boolean;
}> {
  return active.page.evaluate(({ codePluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const core = app?.plugins?.plugins?.["agentic-researcher"];
    return {
      loaded: Boolean(core?.getBundledCapability?.(codePluginId)),
      registered: Boolean(
        core?.getRegisteredCapabilityIds?.()
          ?.includes(codePluginId),
      ),
      separateManifestInstalled: Boolean(app?.plugins?.manifests?.[codePluginId]),
      separatelyEnabled: Boolean(
        app?.plugins?.enabledPlugins?.has?.(codePluginId) ||
          app?.plugins?.enabledPlugins?.includes?.(codePluginId),
      ),
    };
  }, { codePluginId: PHASE4_CODE_PLUGIN_ID });
}

function findRecordByKind(
  value: unknown,
  kind: string,
  seen = new Set<unknown>(),
): Record<string, any> | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  if (isRecord(value) && value.kind === kind) return value;
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRecordByKind(nested, kind, seen);
    if (found) return found;
  }
  return null;
}

async function cleanupOwnedScratchWorkspace(
  active: Phase4Harness,
  workspaceId: string,
  knownStatus: Record<string, unknown> | null,
): Promise<void> {
  let status = knownStatus;
  if (!status) {
    const catalog = await active.readToolCatalog().catch(() => []);
    if (catalog.some((entry) => entry.name === "code_workspace_status")) {
      const result = await active
        .executeTool(
          "code_workspace_status",
          { workspaceId },
          `Clean up the test-owned Phase 4 workspace ${workspaceId}.`,
        )
        .catch(() => null);
      if (isRecord(result) && result.ok === true && isRecord(result.output)) {
        status = result.output;
      }
    }
  }
  const manifest = isRecord(status?.manifest) ? status.manifest : null;
  if (!manifest || manifest.kind !== "scratch" || manifest.workspaceId !== workspaceId) return;
  if (typeof manifest.canonicalRoot !== "string") return;
  const canonicalRoot = await realpath(manifest.canonicalRoot).catch(() => null);
  if (!canonicalRoot || path.basename(canonicalRoot).toLowerCase() !== "root") return;
  const container = path.dirname(canonicalRoot);
  const verifiedContainer = await realpath(container).catch(() => null);
  if (!verifiedContainer || path.basename(verifiedContainer) !== workspaceId) return;
  if (path.basename(path.dirname(verifiedContainer)).toLowerCase() !== "workspaces-v2") return;
  if (!(await active.stopActiveMission())) {
    // The harness will terminate the owned Obsidian process before its final
    // artifact cleanup. Do not toggle an extension underneath a runner stuck
    // in a durable checkpoint.
    return;
  }
  const wasEnabled = (await readExtensionState(active)).loaded;
  if (wasEnabled) await active.setUnifiedPluginEnabled(false);
  try {
    await rm(verifiedContainer, { recursive: true, force: true });
  } finally {
    if (wasEnabled) await active.setUnifiedPluginEnabled(true);
  }
}

async function cleanupOwnedRepositoryWorkspace(
  active: Phase4Harness,
  fixture: Phase4GitFixture,
  workspaceId: string,
  knownStatus: Record<string, unknown> | null,
): Promise<void> {
  if (!workspaceId.startsWith("phase4-repair-")) {
    throw new Error(`Refusing to clean unowned repair workspace ${workspaceId}.`);
  }
  let status = knownStatus;
  if (!status) {
    const catalog = await active.readToolCatalog().catch(() => []);
    if (catalog.some((entry) => entry.name === "code_workspace_status")) {
      const result = await active
        .executeTool(
          "code_workspace_status",
          { workspaceId },
          `Clean up the test-owned repository workspace ${workspaceId}.`,
        )
        .catch(() => null);
      if (isRecord(result) && result.ok === true && isRecord(result.output)) {
        status = result.output;
      }
    }
  }
  const manifest = isRecord(status?.manifest) ? status.manifest : null;
  const binding = isRecord(manifest?.repositoryBinding)
    ? manifest.repositoryBinding
    : null;
  if (
    !manifest ||
    manifest.kind !== "repository" ||
    manifest.workspaceId !== workspaceId ||
    !binding ||
    typeof binding.worktreeRoot !== "string" ||
    typeof binding.branch !== "string"
  ) {
    return;
  }

  if (!(await active.stopActiveMission())) {
    return;
  }
  const wasEnabled = (await readExtensionState(active)).loaded;
  if (wasEnabled) await active.setUnifiedPluginEnabled(false);
  try {
    await fixture
      .removeOwnedWorktree(binding.worktreeRoot, binding.branch)
      .catch((error) => {
        if (!/does not recognize|not a working tree|is not a working tree/iu.test(String(error))) {
          throw error;
        }
      });
    if (!process.env.LOCALAPPDATA) {
      throw new Error("LOCALAPPDATA is required for bounded Code workspace cleanup.");
    }
    const metadataRoot = path.resolve(
      process.env.LOCALAPPDATA,
      "AgenticResearcher",
      "code",
      "workspaces-v2",
    );
    const container = path.join(metadataRoot, workspaceId);
    const verifiedContainer = await realpath(container).catch(() => null);
    if (verifiedContainer) {
      const verifiedMetadataRoot = await realpath(metadataRoot);
      if (
        path.dirname(verifiedContainer) !== verifiedMetadataRoot ||
        path.basename(verifiedContainer) !== workspaceId
      ) {
        throw new Error(`Refusing to clean unowned workspace metadata ${verifiedContainer}.`);
      }
      await rm(verifiedContainer, { recursive: true, force: true });
    }
  } finally {
    if (wasEnabled) await active.setUnifiedPluginEnabled(true);
  }
}

async function expectPathAbsent(targetPath: string): Promise<void> {
  await expect
    .poll(() => realpath(targetPath).then(() => false, () => true), { timeout: 5_000 })
    .toBe(true);
}

async function cleanupOwnedTempDirectory(
  directory: string,
  requiredPrefix: string,
): Promise<void> {
  const verified = await realpath(directory).catch(() => null);
  if (!verified) return;
  const expectedParent = await realpath(tmpdir());
  if (path.dirname(verified) !== expectedParent) {
    throw new Error(`Refusing to clean Phase 4 temp directory outside ${expectedParent}.`);
  }
  if (!path.basename(verified).startsWith(requiredPrefix)) {
    throw new Error(`Refusing to clean unowned Phase 4 temp directory ${verified}.`);
  }
  await rm(verified, { recursive: true, force: true });
}

interface MutableDailyUseObservedV1 {
  artifacts: Set<string>;
  proofs: Set<string>;
  approvals: Set<string>;
  bindings: Set<string>;
  cleanup: Set<string>;
}

function createMutableDailyUseObserved(): MutableDailyUseObservedV1 {
  return {
    artifacts: new Set(),
    proofs: new Set(),
    approvals: new Set(),
    bindings: new Set(),
    cleanup: new Set(),
  };
}

function snapshotMutableDailyUseObserved(
  observed: MutableDailyUseObservedV1,
): DailyUseObservedAcceptanceV1 {
  return {
    artifacts: [...observed.artifacts],
    proofs: [...observed.proofs],
    approvals: [...observed.approvals],
    bindings: [...observed.bindings],
    cleanup: [...observed.cleanup],
  };
}

function addObserved(target: Set<string>, values: readonly string[]): void {
  for (const value of values) target.add(value);
}

async function readDailyUseRunCounters(
  page: Page,
  approvals: number,
): Promise<{
  modelCalls: number;
  toolCalls: number;
  continuations: number;
  approvals: number;
}> {
  return page.evaluate(({ approvals }) => {
    const plugin = (window as typeof window & { app?: any }).app
      ?.plugins?.plugins?.["agentic-researcher"];
    const snapshot = plugin?.getMissionRunSnapshot?.() ?? null;
    return {
      modelCalls: Array.isArray(snapshot?.modelCallEvidence)
        ? snapshot.modelCallEvidence.length
        : 0,
      toolCalls: Array.isArray(snapshot?.missionEvidence)
        ? snapshot.missionEvidence.length
        : 0,
      continuations: 0,
      approvals,
    };
  }, { approvals });
}

async function readOwnedRepositoryWorktreeFromCodeStatus(
  page: Page,
  workspaceId: string,
): Promise<{ root: string; branch: string } | null> {
  const result = await executeReadOnlyCodeTool(
    page,
    "code_workspace_status",
    { workspaceId },
    `Read back the test-owned workspace ${workspaceId} for bounded cleanup.`,
  );
  if (!result.ok || !isRecord(result.output)) return null;
  const manifest = isRecord(result.output.manifest)
    ? result.output.manifest
    : null;
  const binding = manifest && isRecord(manifest.repositoryBinding)
    ? manifest.repositoryBinding
    : null;
  if (
    manifest?.workspaceId !== workspaceId ||
    typeof binding?.worktreeRoot !== "string" ||
    typeof binding.branch !== "string"
  ) return null;
  return { root: binding.worktreeRoot, branch: binding.branch };
}

async function cleanupOwnedWorkspaceMetadata(workspaceId: string): Promise<void> {
  if (!/^du03-live-\d{10,}$/u.test(workspaceId) || !process.env.LOCALAPPDATA) {
    throw new Error(`Refusing to clean unowned DU-03 workspace metadata ${workspaceId}.`);
  }
  const metadataRoot = path.resolve(
    process.env.LOCALAPPDATA,
    "AgenticResearcher",
    "code",
    "workspaces-v2",
  );
  const container = path.join(metadataRoot, workspaceId);
  const verifiedContainer = await realpath(container).catch(() => null);
  if (!verifiedContainer) return;
  const verifiedRoot = await realpath(metadataRoot);
  if (
    path.dirname(verifiedContainer) !== verifiedRoot ||
    path.basename(verifiedContainer) !== workspaceId
  ) {
    throw new Error(`Refusing to clean unowned DU-03 workspace metadata ${verifiedContainer}.`);
  }
  await rm(verifiedContainer, { recursive: true, force: true });
}
