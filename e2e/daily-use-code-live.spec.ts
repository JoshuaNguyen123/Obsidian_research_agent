import { execFile } from "node:child_process";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { expect, test, type Page } from "@playwright/test";

import {
  AGENT_GIT_COMMIT_EMAIL_V1,
  AGENT_GIT_COMMIT_NAME_V1,
} from "../packages/core-api/src/agentGitCommitIdentityV1";
import { recordDailyUseAcceptance } from "./fixtures/dailyUseAcceptance";
import { createPhase4TypeScriptProjectFixture } from "./fixtures/phase4GitRepo";
import { PHASE4_CODE_PLUGIN_ID } from "./fixtures/phase4Harness";
import {
  assertProductionAdoptedSandboxV1,
  startRealAiHarness,
} from "./fixtures/realAiHarness";
import type { DailyUseObservedAcceptanceV1 } from "../src/agent/dailyUseAcceptance";
import { laneSelectedV1 } from "./fixtures/laneSelection";

const FINGERPRINT_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const LIVE_CODE_LANE = laneSelectedV1("daily-use-code-live");
const execFileAsync = promisify(execFile);

test.describe("Daily-use Code capability real-model repository delivery", () => {
  test.skip(process.platform !== "win32", "Obsidian desktop e2e requires Windows.");

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
      // The plugin must reach a verified sandbox on its own, exactly as it
      // does for a user: no test-injected provider configuration.
      await assertProductionAdoptedSandboxV1(liveHarness.page, startedAt);
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
      expect(
        await readAgentCommitIdentity(
          handoff.canonicalWorktreeRoot,
          handoff.commitSha,
        ),
      ).toEqual(expectedAgentCommitIdentity());
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
});

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

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} was not a non-empty string.`);
  }
  return value;
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

async function readAgentCommitIdentity(
  cwd: string,
  commitSha: string,
): Promise<{
  authorName: string;
  authorEmail: string;
  committerName: string;
  committerEmail: string;
}> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "show",
      "--no-patch",
      "--format=%an%x00%ae%x00%cn%x00%ce",
      commitSha,
    ],
    { cwd, windowsHide: true, encoding: "utf8" },
  );
  const fields = stdout.replace(/(?:\r?\n)+$/u, "").split("\0");
  if (fields.length !== 4 || fields.some((field) => !field)) {
    throw new Error("Git commit identity readback was invalid.");
  }
  return {
    authorName: fields[0],
    authorEmail: fields[1],
    committerName: fields[2],
    committerEmail: fields[3],
  };
}

function expectedAgentCommitIdentity() {
  return {
    authorName: AGENT_GIT_COMMIT_NAME_V1,
    authorEmail: AGENT_GIT_COMMIT_EMAIL_V1,
    committerName: AGENT_GIT_COMMIT_NAME_V1,
    committerEmail: AGENT_GIT_COMMIT_EMAIL_V1,
  };
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
