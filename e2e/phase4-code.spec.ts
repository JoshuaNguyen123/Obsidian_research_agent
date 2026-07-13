import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { expect, test } from "@playwright/test";

import {
  createPhase4GitFixture,
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

const SUITE_TIMEOUT_MS = 420_000;
const MISSION_TIMEOUT_MS = 240_000;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;

test.describe("Phase 4 Code extension production boundaries", () => {
  test.describe.configure({ timeout: SUITE_TIMEOUT_MS });
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

  let harness: Phase4Harness | null = null;

  test.beforeAll(async () => {
    harness = await startPhase4Harness("phase4-code");
  });

  test.afterAll(async () => {
    await harness?.close();
  });

  test("durable folder and file CRUD survives restart with hashes and trash/restore receipts", async () => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const catalog = await active.readToolCatalog();
    const missing = missingTools(catalog, PHASE4_REQUIRED_CRUD_TOOLS);
    expect(
      missing,
      registrationGap(
        "durable workspace CRUD",
        missing,
        "the installed Code extension did not expose the required production workspace contracts",
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

      await active.restartCoreAndCode();
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
        "the installed Code extension did not expose the required production sandbox contracts",
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
        "Missing production command agentic-researcher-code:probe-sandbox-boundaries; code_sandbox_status is intentionally read-only and cannot prove a completed boundary probe by itself.",
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

  test("fixture Git repair commits only after targeted and fresh-full validation, or exposes a durable production blocker", async () => {
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
        "The installed Code extension must atomically register its workspace, sandbox, repair, and verified-commit tools before repair e2e can proceed.",
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
        "The installed Code extension must expose the host-only trusted queue bridge.",
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
    } finally {
      await cleanupOwnedRepositoryWorkspace(active, fixture, workspaceId, workspaceStatus);
      await fixture.cleanup();
    }
  });

  test("disabling the Code extension leaves core Chat and Run Details healthy", async () => {
    test.setTimeout(SUITE_TIMEOUT_MS);
    const active = requireHarness(harness);
    const before = await readExtensionState(active);
    expect(before.loaded).toBe(true);

    await active.setCodeExtensionEnabled(false);
    try {
      await expect
        .poll(async () => readExtensionState(active), { timeout: 30_000 })
        .toMatchObject({ loaded: false, registered: false });

      const catalog = await active.readToolCatalog();
      const names = catalog.map((entry) => entry.name);
      expect(names).toContain("read_current_file");
      for (const name of [
        ...PHASE4_REQUIRED_CRUD_TOOLS,
        ...PHASE4_REQUIRED_SANDBOX_TOOLS,
        ...PHASE4_REQUIRED_REPAIR_TOOLS,
      ]) {
        expect(names, `${name} must disappear with the Code extension`).not.toContain(name);
      }

      await expect(active.page.getByRole("tab", { name: "Chat" })).toBeVisible();
      await expect(active.page.getByRole("tab", { name: "Run Details" })).toBeVisible();
      await expect(active.page.locator("textarea.agentic-researcher-prompt")).toBeEnabled();
      await expect(active.page.locator("button.agentic-researcher-run")).toBeEnabled();

      await active.configureScenario("core-health");
      const approvals = await active.submitMissionWithApprovals(
        `Confirm core Chat health while the Code extension is disabled. Return the fixture marker ${active.marker}.`,
        { timeoutMs: MISSION_TIMEOUT_MS },
      );
      expect(approvals).toEqual([]);
      await active.page.getByRole("tab", { name: "Chat" }).click();
      await expect(
        active.page.locator(
          ".agentic-researcher-log-assistant .agentic-researcher-log-message",
          { hasText: `PHASE4_CORE_HEALTH_OK ${active.marker}` },
        ),
      ).toBeVisible();

      await active.page.getByRole("tab", { name: "Run Details" }).click();
      await expect(active.page.locator(".agentic-researcher-details-panel")).toBeVisible();
      await expect(active.page.locator(".agentic-researcher-run-status-text")).toHaveText(
        "Idle",
      );
      await expect(active.page.locator(".agentic-researcher-tool-item")).toHaveCount(0);
    } finally {
      await active.setCodeExtensionEnabled(true);
      await expect
        .poll(async () => readExtensionState(active), { timeout: 30_000 })
        .toMatchObject({ loaded: true });
    }
  });
});

function requireHarness(harness: Phase4Harness | null): Phase4Harness {
  if (!harness) throw new Error("Phase 4 harness did not start.");
  return harness;
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
}> {
  return active.page.evaluate(({ codePluginId }) => {
    const app = (window as typeof window & { app?: any }).app;
    const core = app?.plugins?.plugins?.["agentic-researcher"];
    return {
      loaded: Boolean(app?.plugins?.plugins?.[codePluginId]),
      registered: Boolean(
        core?.agenticResearcherApi
          ?.getRegisteredExtensionIds?.()
          ?.includes(codePluginId),
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
  if (wasEnabled) await active.setCodeExtensionEnabled(false);
  try {
    await rm(verifiedContainer, { recursive: true, force: true });
  } finally {
    if (wasEnabled) await active.setCodeExtensionEnabled(true);
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
  if (wasEnabled) await active.setCodeExtensionEnabled(false);
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
    if (wasEnabled) await active.setCodeExtensionEnabled(true);
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
