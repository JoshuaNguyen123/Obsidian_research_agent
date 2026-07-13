import { expect, type Locator, type Page } from "@playwright/test";
import {
  lstat,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { createPhase4GitFixture, type Phase4GitFixture } from "./phase4GitRepo";
import {
  PHASE4_CODE_PLUGIN_ID,
  PHASE4_CORE_PLUGIN_ID,
  startPhase4Harness,
  type Phase4Harness,
} from "./phase4Harness";

const COMPANION_PLUGIN_ID = "agentic-researcher-companion";
const BACKGROUND_TOOL = "code_validate_commit_prepared";

type HarnessMode = "actual-no-provider" | "verified-ready";

export interface BackgroundCodeCompanionSnapshot {
  blockerCode: string | null;
  sandboxMode: string | null;
  sandboxExecutionAvailable: boolean | null;
  postCount: number;
  sealCount: number;
  sealResult: unknown;
  sealError: string | null;
  modelToolCallCount: number;
  backgroundToolArguments: Array<Record<string, unknown>>;
  foregroundExecuteCount: number;
  foregroundExecutePreparedCount: number;
  foregroundExecutePreparedGrantIds: string[];
  foregroundExecutePreparedResultCodes: string[];
  foregroundExecutePreparedOperationIds: Array<string | null>;
  foregroundExecutePreparedRuntimeApiAvailable: boolean[];
  foregroundExecutePreparedRuntimeSnapshotReadable: boolean[];
  backgroundDescriptorJournal: boolean | null;
  foregroundNativeExecutionCount: number;
  walPresentBeforePost: boolean;
  packageIdentityPresentBeforePost: boolean;
  packageReadbackVerifiedBeforePost: boolean;
  remoteState: string | null;
  receiptStatuses: string[];
  runtimeJournalState: string | null;
  backgroundAttemptStatus: string | null;
  graphNodeStatus: string | null;
  graphNodeId: string | null;
  graphNodeAllowedTools: string[];
  graphNodeEffect: string | null;
  graphNodeExecutionHost: string | null;
  graphNodeDestination: unknown;
  graphNodeResourceLocks: unknown[];
  graphBinding: unknown;
  workspaceBinding: unknown;
  bindingResolveCallCount: number;
  bindingResolveResult: unknown;
  backgroundDispatchPortAvailable: boolean;
  backgroundCodeSealerAvailable: boolean;
  backgroundDispatchPortCreationCount: number;
  backgroundSubmitCallCount: number;
  backgroundSubmitResult: unknown;
  backgroundSubmitError: string | null;
  graphReceiptKinds: string[];
  graphEvidenceKinds: string[];
  graphVerifierId: string | null;
  graphCompletionTransitionCount: number;
  baseSha: string;
  commitSha: string;
  worktreeHead: string;
  worktreeRoot: string | null;
  branch: string | null;
}

export interface BackgroundCodeCompanionHarness {
  page: Page;
  submitMission(): Promise<void>;
  approveForegroundFixtureActions(): Promise<void>;
  activeCodeApproval(): Locator;
  approveCodeAction(approval: Locator): Promise<void>;
  readyFixtureAvailable(): Promise<boolean>;
  waitForRemoteSubmission(): Promise<void>;
  disconnectAndRestartCoreCode(): Promise<void>;
  waitForRemoteCompletion(): Promise<void>;
  reconnectCompanion(): Promise<void>;
  requestReconciliation(): Promise<void>;
  readSnapshot(): Promise<BackgroundCodeCompanionSnapshot>;
  close(): Promise<void>;
}

interface DirectoryBaseline {
  root: string;
  existingNames: Set<string>;
}

export async function startBackgroundCodeCompanionHarness(
  mode: HarnessMode,
): Promise<BackgroundCodeCompanionHarness> {
  await removeStaleBackgroundCodeFixtures();
  const native = await startPhase4Harness(`background-code-${mode}`);
  let fixture: Phase4GitFixture | null = null;
  let storeBaselines: DirectoryBaseline[] = [];
  let closed = false;
  try {
    fixture = await createPhase4GitFixture(native.marker);
    storeBaselines = await snapshotBackgroundCodeStores();
    await installBackgroundCodePageHarness(native.page, {
      mode,
      marker: native.marker,
      notePath: native.notePath,
      repositoryRoot: fixture.root,
      baseSha: fixture.baseSha,
    });
  } catch (error) {
    await native.close().catch(() => undefined);
    await fixture?.cleanup().catch(() => undefined);
    await restoreBackgroundCodeStores(storeBaselines).catch(() => undefined);
    throw error;
  }

  const activeFixture = fixture;
  const workspaceId = `phase4-repair-${native.marker.toLowerCase()}`;
  const repairRequestId = "bg1";
  const prompt = [
    mode === "verified-ready"
      ? "E2E_BACKGROUND_CODE_VERIFIED_READY"
      : "E2E_BACKGROUND_CODE_ACTUAL_NO_PROVIDER",
    native.marker,
    `Execute explicit code repair request ${repairRequestId} in trusted workspace ${workspaceId}.`,
    `Use repairRequestId ${repairRequestId} for every validation, repair-cycle, status, and commit call.`,
    "The exact diff-preview checkpoint and fresh fast validation already exist in trusted Code state.",
    "Invoke only code_validate_commit_prepared with its logical repairCheckpointId; do not create, read, edit, validate, execute, or commit in the foreground.",
    "Continue this in the background after I close Obsidian; dispatch the prepared package to the authenticated companion.",
  ].join(" ");

  return {
    page: native.page,
    submitMission: () => submitMission(native.page, prompt),
    approveForegroundFixtureActions: () =>
      approveForegroundFixtureActions(native.page),
    activeCodeApproval: () => activeCodeApproval(native.page),
    approveCodeAction: (approval) => approveCodeAction(approval),
    readyFixtureAvailable: () => readyFixtureAvailable(native.page),
    waitForRemoteSubmission: () => waitForRemoteSubmission(native.page),
    disconnectAndRestartCoreCode: () =>
      disconnectAndRestartCoreCode(native.page),
    waitForRemoteCompletion: () =>
      expect
        .poll(() => readRemoteState(native.page), {
          timeout: 90_000,
          message: "the fake Code companion should reach verified completion",
        })
        .toBe("complete"),
    reconnectCompanion: () => reconnectCompanion(native.page),
    requestReconciliation: () => requestReconciliation(native.page),
    readSnapshot: async () => {
      const pageSnapshot = await readPageSnapshot(native.page);
      let worktreeHead = activeFixture.baseSha;
      if (pageSnapshot.worktreeRoot) {
        worktreeHead = (
          await activeFixture.inspectWorktree(pageSnapshot.worktreeRoot)
        ).head;
      }
      return {
        ...pageSnapshot,
        baseSha: activeFixture.baseSha,
        commitSha: pageSnapshot.commitSha ?? worktreeHead,
        worktreeHead,
      };
    },
    async close() {
      if (closed) return;
      closed = true;
      let teardownError: unknown = null;
      let binding: { worktreeRoot: string; branch: string } | null = null;
      if (!native.page.isClosed()) {
        binding = await readWorkspaceBinding(native.page).catch(() => null);
        await native.stopActiveMission(10_000).catch(() => false);
        if (binding) {
          await native.setCodeExtensionEnabled(false).catch(() => undefined);
        }
      }
      if (binding) {
        await activeFixture
          .removeOwnedWorktree(binding.worktreeRoot, binding.branch)
          .catch((error) => {
            teardownError ??= error;
          });
      }
      await native.close().catch((error) => {
        teardownError ??= error;
      });
      await restoreBackgroundCodeStores(storeBaselines).catch((error) => {
        teardownError ??= error;
      });
      await activeFixture.cleanup().catch((error) => {
        teardownError ??= error;
      });
      if (teardownError) throw teardownError;
    },
  };
}

async function installBackgroundCodePageHarness(
  page: Page,
  input: {
    mode: HarnessMode;
    marker: string;
    notePath: string;
    repositoryRoot: string;
    baseSha: string;
  },
): Promise<void> {
  await page.evaluate(
    async ({
      mode,
      marker,
      repositoryRoot,
      baseSha,
      corePluginId,
      codePluginId,
      companionPluginId,
      backgroundTool,
    }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        require?: (id: string) => any;
        __e2eBackgroundCode?: any;
      };
      const app = harnessWindow.app;
      if (!app?.plugins || !app?.vault || !app?.workspace) {
        throw new Error("Obsidian app APIs are unavailable.");
      }
      const waitForPlugin = async (pluginId: string) => {
        for (let attempt = 0; attempt < 240; attempt += 1) {
          const plugin = app.plugins.plugins?.[pluginId];
          if (plugin) return plugin;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        throw new Error(`Plugin did not become ready: ${pluginId}`);
      };
      const core = await waitForPlugin(corePluginId);
      const code = await waitForPlugin(codePluginId);
      const companion = await waitForPlugin(companionPluginId);
      if (!code.runtime?.workspaceManager || !companion.pairForegroundCompanion) {
        throw new Error("Code or Companion production runtime is unavailable.");
      }

      const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
      const canonicalJson = (value: any): string => {
        if (
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean"
        ) {
          return JSON.stringify(value);
        }
        if (typeof value === "number") {
          if (!Number.isFinite(value)) throw new Error("Unsafe canonical number.");
          return Object.is(value, -0) ? "0" : JSON.stringify(value);
        }
        if (Array.isArray(value)) {
          return `[${value.map(canonicalJson).join(",")}]`;
        }
        if (!value || typeof value !== "object") {
          throw new Error("Unsupported canonical value.");
        }
        return `{${Object.keys(value)
          .sort()
          .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
          .join(",")}}`;
      };
      const sha256 = async (value: any) => {
        const bytes = new TextEncoder().encode(
          typeof value === "string" ? value : canonicalJson(value),
        );
        const digest = await crypto.subtle.digest("SHA-256", bytes);
        return `sha256:${[...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`;
      };
      const fp = (character: string) =>
        `sha256:${character.repeat(64).slice(0, 64)}`;
      const workspaceId = `phase4-repair-${marker.toLowerCase()}`;
      const repairRequestId = "bg1";
      const repairedSource = [
        `export const fixtureMarker = ${JSON.stringify(marker)};`,
        "export function add(left, right) {",
        "  return left + right; // repaired by the foreground workspace edit",
        "}",
        "",
      ].join("\n");
      const state: any = {
        mode,
        marker,
        repositoryRoot,
        baseSha,
        workspaceId,
        repairRequestId,
        repairedSource,
        toolCallSequence: 0,
        modelToolCallCount: 0,
        backgroundToolArguments: [],
        postCount: 0,
        sealCount: 0,
        sealResult: null,
        sealError: null,
        foregroundExecuteCount: 0,
        foregroundExecutePreparedCount: 0,
        foregroundExecutePreparedGrantIds: [],
        foregroundExecutePreparedResultCodes: [],
        foregroundExecutePreparedOperationIds: [],
        foregroundExecutePreparedRuntimeApiAvailable: [],
        foregroundExecutePreparedRuntimeSnapshotReadable: [],
        backgroundDescriptorJournal: null,
        foregroundNativeExecutionCount: 0,
        blockerCode: null,
        sandboxMode: null,
        sandboxExecutionAvailable: null,
        checkpointId: null,
        worktreeRoot: null,
        branch: null,
        backgroundDispatchPortAvailable: false,
        backgroundCodeSealerAvailable: false,
        backgroundDispatchPortCreationCount: 0,
        backgroundSubmitCallCount: 0,
        backgroundSubmitResult: null,
        backgroundSubmitError: null,
        bindingResolveCallCount: 0,
        bindingResolveResult: null,
        gitRunner: code.runtime.repairGit,
        jobs: {},
        receipts: {},
        events: {},
        requestLog: [],
        walPresentBeforePost: false,
        packageIdentityPresentBeforePost: false,
        packageReadbackVerifiedBeforePost: false,
        backgroundCommitSha: null,
        readyFixtureAvailable: false,
        fixturePromise: null as Promise<string> | null,
      };

      const parseRuntimeSnapshot = (markdown: string) => {
        const match =
          /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
            markdown,
          );
        return match ? JSON.parse(match[1]) : null;
      };
      const findRuntimeByJobId = async (jobId: string) => {
        for (const file of app.vault.getMarkdownFiles()) {
          if (!/^Agent Runs\/[^/]+\.md$/iu.test(file.path)) continue;
          const runtime = parseRuntimeSnapshot(await app.vault.cachedRead(file));
          if (
            runtime?.operationJournal?.some(
              (record: any) =>
                record.backgroundCodeDispatchAttempt?.jobId === jobId,
            )
          ) {
            return runtime;
          }
        }
        return null;
      };
      state.readRuntime = async () => {
        const jobId = Object.keys(state.jobs)[0] ?? "";
        if (jobId) return findRuntimeByJobId(jobId);
        for (const file of app.vault.getMarkdownFiles()) {
          if (!/^Agent Runs\/[^/]+\.md$/iu.test(file.path)) continue;
          const markdown = await app.vault.cachedRead(file);
          if (!markdown.includes(marker)) continue;
          const runtime = parseRuntimeSnapshot(markdown);
          if (runtime) return runtime;
        }
        return null;
      };

      const instrumentRegistry = (target: any) => {
        if (!target || target.__e2eBackgroundCodeRegistryInstrumented) return;
        const originalCreate = target.createToolRegistry?.bind(target);
        if (!originalCreate) return;
        target.createToolRegistry = (...args: any[]) => {
          const registry = originalCreate(...args);
          if (registry.__e2eBackgroundCodeInstrumented) return registry;
          registry.__e2eBackgroundCodeInstrumented = true;
          const originalPrepare = registry.prepare.bind(registry);
          const originalExecute = registry.execute.bind(registry);
          const originalExecutePrepared = registry.executePrepared.bind(registry);
          const backgroundDescriptor = registry.getDescriptor?.(backgroundTool);
          state.backgroundDescriptorJournal =
            backgroundDescriptor?.durability?.journal === true;
          registry.prepare = async (call: any, context: any) => {
            const result = await originalPrepare(call, context);
            if (call?.name === backgroundTool) {
              state.modelToolCallCount += 1;
              state.backgroundToolArguments.push(clone(call.arguments ?? {}));
              if (result?.ok === false) {
                state.blockerCode = result.error?.code ?? "unknown";
              }
            }
            return result;
          };
          registry.execute = async (call: any, context: any) => {
            if (call?.name === backgroundTool) {
              state.foregroundExecuteCount += 1;
            }
            return originalExecute(call, context);
          };
          registry.executePrepared = async (
            action: any,
            context: any,
            authorization: any,
          ) => {
            if (action?.toolName === backgroundTool) {
              state.foregroundExecutePreparedCount += 1;
              state.foregroundExecutePreparedGrantIds.push(
                authorization?.grantId ??
                  context?.authorizedAction?.grantId ??
                  "missing",
              );
              state.foregroundExecutePreparedOperationIds.push(
                context?.operationId ?? null,
              );
              const vault = context?.app?.vault;
              state.foregroundExecutePreparedRuntimeApiAvailable.push(
                Boolean(
                  vault &&
                    typeof vault.getFileByPath === "function" &&
                    typeof vault.create === "function" &&
                    typeof vault.modify === "function" &&
                    typeof vault.read === "function" &&
                    typeof vault.getFolderByPath === "function" &&
                    typeof vault.createFolder === "function",
                ),
              );
              state.foregroundExecutePreparedRuntimeSnapshotReadable.push(
                Boolean(await state.readRuntime().catch(() => null)),
              );
            }
            const result = await originalExecutePrepared(
              action,
              context,
              authorization,
            );
            if (action?.toolName === backgroundTool) {
              state.foregroundExecutePreparedResultCodes.push(
                result?.error?.code ?? "ok",
              );
            }
            return result;
          };
          return registry;
        };
        target.__e2eBackgroundCodeRegistryInstrumented = true;
      };
      const instrumentCodePlugin = (plugin: any) => {
        if (!plugin || plugin.__e2eBackgroundCodeInstrumented) return;
        const originalPrepare =
          plugin.prepareBackgroundValidationCommitApproval?.bind(plugin);
        if (originalPrepare) {
          plugin.prepareBackgroundValidationCommitApproval = async (value: any) => {
            const result = await originalPrepare(value);
            if (result?.status === "blocked") state.blockerCode = result.code;
            return result;
          };
        }
        const originalResolveBinding =
          plugin.resolveBackgroundMissionBinding?.bind(plugin);
        if (originalResolveBinding) {
          plugin.resolveBackgroundMissionBinding = async (value: any) => {
            state.bindingResolveCallCount += 1;
            const result = await originalResolveBinding(value);
            state.bindingResolveResult = clone(result);
            return result;
          };
        }
        const originalSeal =
          plugin.sealBackgroundValidationCommitPackage?.bind(plugin);
        if (originalSeal) {
          plugin.sealBackgroundValidationCommitPackage = async (value: any) => {
            state.sealCount += 1;
            try {
              const result = await originalSeal(value);
              state.sealResult = clone(result);
              if (result?.status === "blocked") state.blockerCode = result.code;
              return result;
            } catch (error) {
              state.sealError =
                error instanceof Error ? error.message : String(error);
              throw error;
            }
          };
        }
        plugin.__e2eBackgroundCodeInstrumented = true;
      };

      const installRuntimeInstrumentation = () => {
        const activeCore = app.plugins.plugins?.[corePluginId];
        instrumentRegistry(activeCore);
        instrumentCodePlugin(app.plugins.plugins?.[codePluginId]);
        for (const leaf of app.workspace.getLeavesOfType?.(
          "agentic-researcher-view",
        ) ?? []) {
          instrumentRegistry(leaf.view?.plugin);
        }
      };

      const verifiedSandboxStatus = () => ({
        version: 1,
        mode: "sandbox_verified",
        executionAvailable: true,
        editingAvailable: true,
        selectedProvider: "docker",
        providers: [
          {
            provider: "docker",
            state: "verified",
            diagnostic: "Deterministic E2E boundary probe passed.",
            probeFingerprint: fp("c"),
            checkedAt: new Date().toISOString(),
          },
        ],
        blocker: null,
      });
      const installVerifiedSandboxDependency = async (runtime: any) => {
        const status = verifiedSandboxStatus();
        const provider = {
          version: 1,
          kind: "docker",
          executable: "docker",
          priority: 1,
          runtimeReference: "agentic-background-code-e2e",
          runtimeDigest: fp("d"),
          wslDistribution: null,
          runtimeRoot: null,
        };
        const manager = {
          readStatus: () => clone(status),
          async probeProviders() {
            return clone(status);
          },
          async prepareExecution(preparedInput: any) {
            const command = preparedInput.profile.validationCatalog.find(
              (candidate: any) =>
                candidate.id === preparedInput.commandId &&
                candidate.projectId === preparedInput.projectId,
            );
            if (!command) {
              throw new Error("E2E sandbox received an unknown validation command.");
            }
            const preparedAt = new Date().toISOString();
            const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
            const coreAction = {
              version: 1,
              purpose: preparedInput.purpose,
              provider: "docker",
              profileKey: preparedInput.profile.key,
              projectId: preparedInput.projectId,
              commandId: preparedInput.commandId,
              workspaceId: preparedInput.workspaceId,
              repairRequestId: preparedInput.repairRequestId,
              workspaceManifestFingerprint:
                preparedInput.workspaceManifestFingerprint,
              runtimeDigest: fp("d"),
              probeFingerprint: fp("c"),
              command: {
                executable: command.executable,
                args: [...command.args],
                cwd: command.cwd,
                timeoutMs: command.timeoutMs,
              },
              network: {
                mode: command.network,
                credentialPolicy: "none",
              },
              resources: {
                cpuCount: 2,
                memoryMb: 1024,
                pidLimit: 128,
                timeoutMs: command.timeoutMs,
              },
              environment: clone(preparedInput.environment ?? {}),
              stagingManifest: clone(preparedInput.stagingManifest),
              expectedArtifacts: clone(preparedInput.expectedArtifacts ?? []),
              preparedAt,
              expiresAt,
            };
            const payloadFingerprint = await sha256(coreAction);
            return {
              status: "prepared",
              action: {
                ...coreAction,
                id: `sandbox-action-${payloadFingerprint.slice(7, 39)}`,
                payloadFingerprint,
              },
            };
          },
          async executePrepared() {
            state.foregroundNativeExecutionCount += 1;
            throw new Error(
              "The background package preparation test must never execute a sandbox action in foreground.",
            );
          },
        };
        runtime.sandboxManager = manager;
        runtime.state = {
          ...runtime.state,
          sandbox: {
            ...runtime.state.sandbox,
            providerConfigs: [provider],
            lastProbe: {
              version: 1,
              observedAt: new Date().toISOString(),
              status,
            },
          },
        };
      };

      const seedRepairCheckpoint = async () => {
        const activeCode = app.plugins.plugins?.[codePluginId];
        const runtime = activeCode?.runtime;
        if (!runtime?.workspaceManager) {
          throw new Error("Code runtime disappeared before checkpoint seeding.");
        }
        const manifest = await runtime.workspaceManager.loadManifest(workspaceId);
        const binding = manifest.repositoryBinding;
        if (!binding) throw new Error("Repository workspace binding is absent.");
        state.worktreeRoot = binding.worktreeRoot;
        state.branch = binding.branch;
        state.gitRunner = runtime.repairGit;

        const originalProfile = await runtime.getRepositoryProfile(binding.profileKey);
        if (!originalProfile) throw new Error("Trusted repository profile is absent.");
        const project = originalProfile.projects[0];
        const runtimeDigest = fp("d");
        const profile = {
          ...clone(originalProfile),
          pinnedRuntimes: originalProfile.pinnedRuntimes.map((item: any) => ({
            ...item,
            source: "repository_pin",
            version: "e2e-pinned-node",
            digest: runtimeDigest,
            approval: "none",
          })),
          validationCatalog: [
            {
              id: "e2e-targeted",
              phase: "targeted",
              projectId: project.id,
              executable: "node",
              args: ["--test", "test/value.test.mjs"],
              cwd: project.root,
              timeoutMs: 60_000,
              network: "disabled",
              credentialPolicy: "none",
              lockfile: null,
            },
            {
              id: "e2e-full",
              phase: "full",
              projectId: project.id,
              executable: "node",
              args: ["--test"],
              cwd: project.root,
              timeoutMs: 60_000,
              network: "disabled",
              credentialPolicy: "none",
              lockfile: null,
            },
          ],
        };
        const originalProfileRecord = runtime.state.repositoryProfiles[profile.key];
        if (!originalProfileRecord?.profile) {
          throw new Error("Trusted repository profile record is absent.");
        }
        const profileRecord = {
          ...clone(originalProfileRecord),
          profile,
        };
        runtime.state.repositoryProfiles = {
          ...runtime.state.repositoryProfiles,
          [profile.key]: profileRecord,
        };
        if (mode === "verified-ready") {
          await installVerifiedSandboxDependency(runtime);
        }
        const sandbox = runtime.sandboxManager.readStatus();
        state.sandboxMode = sandbox.mode;
        state.sandboxExecutionAvailable = sandbox.executionAvailable;

        const source = await runtime.workspaceManager.read(
          workspaceId,
          "src/value.mjs",
        );
        const stagingManifest = await Promise.all(
          Object.keys(manifest.hashes.files)
            .sort()
            .map((relativePath) =>
              runtime.workspaceManager.read(workspaceId, relativePath),
            ),
        ).then((files) => files
          .map((file: any) => ({
            path: file.path,
            sha256: file.sha256,
            bytes: file.bytes,
          }))
          .sort((left: any, right: any) => left.path.localeCompare(right.path)));
        const stagingManifestFingerprint = await sha256(stagingManifest);
        const now = new Date().toISOString();
        const request = {
          id: repairRequestId,
          runId: manifest.ownerRunId,
          objective: "Repair addition and create one verified local commit.",
          worktree: {
            id: workspaceId,
            path: binding.worktreeRoot,
            repositoryRoot: binding.repositoryRoot,
            branch: binding.branch,
            baseSha: manifest.baseSha,
            profileId: binding.profileKey,
          },
          commitMessage: "fix: background Code E2E addition",
          maxCycles: 3,
          expectedArtifacts: [],
          protectedControlPaths: [],
        };
        const requestFingerprint = await sha256(request);
        const fastEvidence = {
          operationId: `code-repair:${repairRequestId}:validation-fast-1`,
          kind: "fast",
          sandboxId: `sandbox-e2e-fast-${marker.toLowerCase()}`,
          freshSandbox: true,
          startedAt: now,
          completedAt: now,
          checks: [
            {
              label: `${project.id}:e2e-fast`,
              exitCode: 0,
              stdout: "sha256=e2e;bytes=0",
              stderr: "sha256=e2e;bytes=0",
              durationMs: 1,
            },
          ],
          status: "passed",
          failureFingerprint: null,
          binding: {
            requestId: repairRequestId,
            workspaceId,
            profileKey: binding.profileKey,
            inputWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
            validatedWorkspaceManifestFingerprint:
              manifest.hashes.indexFingerprint,
            workspaceChangedPaths: [...manifest.budget.changedPaths].sort(),
            stagingManifestFingerprint,
            stagedFiles: stagingManifest,
            importedArtifacts: [],
          },
        };
        const fastValidation = {
          version: 1,
          kindName: "code_validation",
          id: fastEvidence.operationId,
          ...fastEvidence,
          fingerprint: await sha256(fastEvidence),
        };
        const cycleEvidence = {
          requestId: repairRequestId,
          runId: manifest.ownerRunId,
          workspaceId,
          cycle: 1,
          outcome: "passed",
          validationReceiptId: fastValidation.id,
          validationFingerprint: fastValidation.fingerprint,
          diagnosisOperationId: null,
          repairOperationId: null,
          recordedAt: now,
        };
        const cycleReceipt = {
          version: 1,
          kind: "code_repair_cycle",
          id: `code-repair:${repairRequestId}:cycle-1`,
          ...cycleEvidence,
          fingerprint: await sha256(cycleEvidence),
        };
        const diffResult = await state.gitRunner.run({
          cwd: binding.worktreeRoot,
          args: ["diff", "--no-ext-diff", "--binary", "--", "src/value.mjs"],
        });
        if (diffResult.exitCode !== 0 || !diffResult.stdout) {
          throw new Error("Production fixed-argv Git diff did not observe the fixture edit.");
        }
        const baseSource = [
          `export const fixtureMarker = ${JSON.stringify(marker)};`,
          "export function add(left, right) {",
          "  return left - right; // intentionally broken for the repair cycle",
          "}",
          "",
        ].join("\n");
        const files = [
          {
            path: "src/value.mjs",
            status: "modified",
            previousPath: null,
            beforeSha256: await sha256(baseSource),
            afterSha256: source.sha256,
          },
        ];
        const diffEvidence = {
          baseSha: manifest.baseSha,
          patch: diffResult.stdout.replace(/\r\n/gu, "\n"),
          files,
        };
        const previewDiff = {
          version: 1,
          kindName: "code_diff_readback",
          id: `code-repair:${repairRequestId}:diff-preview`,
          operationId: `code-repair:${repairRequestId}:diff-preview`,
          ...diffEvidence,
          readAt: now,
          changedPaths: ["src/value.mjs"],
          fingerprint: await sha256(diffEvidence),
        };
        const checkpointId = `code-repair:${manifest.ownerRunId}:${workspaceId}:${repairRequestId}`;
        const checkpoint = {
          version: 1,
          id: checkpointId,
          request,
          requestFingerprint,
          sequence: 3,
          stage: "diff_preview",
          createdAt: now,
          updatedAt: now,
          initialEdit: {
            operationId: `code-repair:${repairRequestId}:initial-edit`,
            summary: "Repaired addition through expected-hash workspace write.",
            changedPaths: ["src/value.mjs"],
            expectedArtifacts: [],
            appliedAt: now,
          },
          attempts: [{ cycle: 1, fastValidation, cycleReceipt }],
          failureHistory: [],
          validationHistory: [fastValidation],
          approvalHistory: [],
          previewDiff,
        };
        const data = clone((await activeCode.loadData()) ?? {});
        const namespace = data.codeRepairCheckpointsV1 ?? {
          version: 1,
          revision: 0,
          checkpoints: {},
        };
        await activeCode.saveData({
          ...data,
          // Persist the exact live runtime snapshot, including the deterministic
          // verified provider binding. A repository-profile-only merge would
          // restore the pre-harness sandbox state during the core registration
          // refresh and correctly make package preparation fail closed.
          codeRuntimeState: clone(runtime.state),
          codeRepairCheckpointsV1: {
            version: 1,
            revision: Number(namespace.revision ?? 0) + 1,
            checkpoints: {
              ...(namespace.checkpoints ?? {}),
              [checkpointId]: checkpoint,
            },
          },
        });
        state.checkpointId = checkpointId;
        return checkpointId;
      };

      const currentRunId = (text: string): string | null => {
        const config = Array.from(
          document.querySelectorAll(".agentic-researcher-config-line"),
        )
          .map((element) => element.textContent?.trim() ?? "")
          .find((value) => value.startsWith("run_id=run-"));
        if (config) return config.slice("run_id=".length);
        const matches = [...text.matchAll(/\brun-[A-Za-z0-9:._-]{16,256}/gu)];
        return matches.at(-1)?.[0] ?? null;
      };
      const ensurePreparedFixture = async (runId: string): Promise<string> => {
        if (state.checkpointId) return state.checkpointId;
        if (state.fixturePromise) return state.fixturePromise;
        state.fixturePromise = (async () => {
          const activeCode = app.plugins.plugins?.[codePluginId];
          const runtime = activeCode?.runtime;
          const manager = runtime?.workspaceManager;
          if (!runtime || !manager) {
            throw new Error("Code runtime disappeared before fixture preparation.");
          }
          const contribution = runtime
            .getContributions()
            .find((item: any) => item?.tool?.name === "code_workspace_create");
          if (!contribution?.tool?.prepare || !contribution.tool.executePrepared) {
            throw new Error("Production repository-workspace preparation is unavailable.");
          }
          const abort = new AbortController();
          const baseContext = {
            version: 1,
            extensionId: codePluginId,
            missionId: runId,
            operationId: `background-code-fixture-${marker.toLowerCase()}`,
            originalPrompt: `Explicit E2E repository fixture ${repositoryRoot}`,
            deadlineAt: Date.now() + 120_000,
            abortSignal: abort.signal,
            now: () => new Date(),
            reportProgress: () => undefined,
          };
          const prepared = await contribution.tool.prepare(
            {
              workspaceId,
              kind: "repository",
              repositoryRoot,
            },
            baseContext,
          );
          if (!prepared?.ok) {
            throw new Error(
              `Production workspace fixture preparation failed: ${prepared?.error?.code ?? "unknown"}`,
            );
          }
          await contribution.tool.executePrepared(prepared.action, {
            ...baseContext,
            authorizedAction: {
              preparedActionId: prepared.action.id,
              payloadFingerprint: prepared.action.payloadFingerprint,
              grantId: `background-code-e2e-${marker.toLowerCase()}`,
            },
          });
          const leased = await manager.loadManifest(workspaceId);
          const leaseId = leased.lease?.id;
          if (!leaseId || leased.ownerRunId !== runId) {
            throw new Error("Production workspace fixture lacks its exact run-bound lease.");
          }
          const source = await manager.read(workspaceId, "src/value.mjs");
          await manager.writeExpected(
            workspaceId,
            leaseId,
            "src/value.mjs",
            repairedSource,
            source.sha256,
          );
          await manager.releaseLease(workspaceId, leaseId);
          return seedRepairCheckpoint();
        })();
        try {
          return await state.fixturePromise;
        } finally {
          state.fixturePromise = null;
        }
      };

      const toolCall = (name: string, args: Record<string, unknown>) => {
        const call = {
          id: `background-code-${marker}-${state.toolCallSequence}-${name}`,
          index: 0,
          name,
          arguments: args,
        };
        state.toolCallSequence += 1;
        return {
          message: { role: "assistant", content: "", toolCalls: [call] },
          toolCalls: [call],
          raw: { playwrightBackgroundCode: true },
        };
      };
      const final = (content: string) => ({
        message: { role: "assistant", content },
        toolCalls: [],
        raw: { playwrightBackgroundCode: true },
      });
      const createModelClient = () => ({
        playwrightBackgroundCodeMock: true,
        async chat(request: any) {
          const text = (request.messages ?? [])
            .map((message: any) => String(message.content ?? ""))
            .join("\n");
          const runId = currentRunId(text);
          if (request.format !== undefined) {
            if (runId) await ensurePreparedFixture(runId);
            return final("{}");
          }
          const tools = new Set(
            (request.tools ?? [])
              .map((tool: any) => tool.function?.name)
              .filter((name: unknown): name is string => typeof name === "string"),
          );
          const required = (name: string) => {
            if (!tools.has(name)) {
              throw new Error(`Background Code mission omitted ${name}.`);
            }
            return name;
          };
          if (!runId) throw new Error("Current mission run id is unavailable.");
          const checkpointId = await ensurePreparedFixture(runId);
          if (state.modelToolCallCount > 0) {
            return final(
              state.blockerCode
                ? `Background Code remains blocked: ${state.blockerCode}.`
                : "The exact background Code package is pending verified commit readback.",
            );
          }
          return toolCall(required(backgroundTool), {
            repairCheckpointId: checkpointId,
          });
        },
        async streamChat() {
          throw new Error("Background Code E2E disables model streaming.");
        },
      });
      const installModel = (target: any) => {
        if (!target) return;
        target.settings = {
          ...target.settings,
          enableStreaming: false,
          streamWritebackMode: "off",
          thinkingMode: "off",
          modelRouterMode: "off",
          orchestratorEnabled: false,
          orchestratorPreviewEnabled: false,
          agenticReflexEnabled: false,
          semanticIndexEnabled: false,
          completionDrivenLoops: false,
          maxAgentSteps: 16,
          model: "playwright-background-code",
        };
        target.saveSettings = async () => undefined;
        target.createModelClient = createModelClient;
        const prototype = Object.getPrototypeOf(target);
        if (prototype) prototype.createModelClient = createModelClient;
      };
      state.installMocks = () => {
        const activeCore = app.plugins.plugins?.[corePluginId];
        installModel(activeCore);
        installRuntimeInstrumentation();
        for (const leaf of app.workspace.getLeavesOfType?.(
          "agentic-researcher-view",
        ) ?? []) {
          installModel(leaf.view?.plugin);
        }
      };
      state.installMocks();
      await core.activateView?.();
      state.installMocks();

      const receiptFingerprint = async (
        remote: any,
        status: string,
        payload: Record<string, unknown>,
      ) =>
        sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint: remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint:
              remote.payload.authorization.fingerprint,
          },
          provider: "code",
          operation: "prepared_code_validation_commit_v1",
          status,
          payload,
        });
      const appendEvent = (jobId: string, type: string, payload: any = {}) => {
        const events = state.events[jobId] ?? [];
        events.push({
          sequence: events.length + 1,
          jobId,
          type,
          payload,
          createdAt: new Date().toISOString(),
        });
        state.events[jobId] = events;
      };
      const transitionAmbiguous = async (jobId: string) => {
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        const handoff = remote.payload.preparedBackgroundCodeAction;
        if (!handoff) throw new Error("Remote Code job omitted its exact handoff.");
        if (!(state.receipts[jobId] ?? []).length) {
          const attemptId = await sha256({
            version: 1,
            jobId,
            handoffFingerprint: handoff.fingerprint,
            repairCheckpointId: handoff.payload.repairCheckpointId,
            reconciliationKey: handoff.reconciliationKey,
          });
          const dispatchedPayload = {
            attemptId,
            handoffFingerprint: handoff.fingerprint,
            repairCheckpointId: handoff.payload.repairCheckpointId,
            checkpointSequence: handoff.payload.preparedCheckpointSequence,
            repairRequestFingerprint: handoff.payload.repairRequestFingerprint,
          };
          const dispatched = {
            id: `receipt-${jobId}-dispatched`,
            jobId,
            provider: "code",
            operation: "prepared_code_validation_commit_v1",
            status: "dispatched",
            fingerprint: await receiptFingerprint(
              remote,
              "dispatched",
              dispatchedPayload,
            ),
            payload: dispatchedPayload,
            createdAt: new Date().toISOString(),
          };
          const add = await state.gitRunner.run({
            cwd: state.worktreeRoot,
            args: ["add", "--", "src/value.mjs"],
          });
          if (add.exitCode !== 0) throw new Error("Fake companion could not stage fixture bytes.");
          const commit = await state.gitRunner.run({
            cwd: state.worktreeRoot,
            args: ["commit", "-m", "fix: background Code E2E addition"],
          });
          if (commit.exitCode !== 0) throw new Error("Fake companion could not commit fixture bytes.");
          const head = await state.gitRunner.run({
            cwd: state.worktreeRoot,
            args: ["rev-parse", "HEAD"],
          });
          state.backgroundCommitSha = head.stdout.trim();
          const ambiguousPayload = {
            attemptId,
            handoffFingerprint: handoff.fingerprint,
            repairCheckpointId: handoff.payload.repairCheckpointId,
            checkpointSequence:
              handoff.payload.preparedCheckpointSequence + 1,
            failureFingerprint: fp("e"),
          };
          const ambiguous = {
            id: `receipt-${jobId}-ambiguous`,
            jobId,
            provider: "code",
            operation: "prepared_code_validation_commit_v1",
            status: "ambiguous",
            fingerprint: await receiptFingerprint(
              remote,
              "ambiguous",
              ambiguousPayload,
            ),
            payload: ambiguousPayload,
            createdAt: new Date().toISOString(),
          };
          state.receipts[jobId] = [dispatched, ambiguous];
          appendEvent(jobId, "receipt_committed", {
            status: "dispatched",
            fingerprint: dispatched.fingerprint,
          });
          appendEvent(jobId, "receipt_committed", {
            status: "ambiguous",
            fingerprint: ambiguous.fingerprint,
          });
        }
      };
      const transitionComplete = async (jobId: string) => {
        await transitionAmbiguous(jobId);
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        const handoff = remote.payload.preparedBackgroundCodeAction;
        const dispatched = state.receipts[jobId][0];
        const verifiedCommitReceiptFingerprint = await sha256({
          version: 1,
          kind: "verified_local_commit",
          commitSha: state.backgroundCommitSha,
          handoffFingerprint: handoff.fingerprint,
        });
        const verifiedPayload = {
          attemptId: dispatched.payload.attemptId,
          handoffFingerprint: handoff.fingerprint,
          repairCheckpointId: handoff.payload.repairCheckpointId,
          checkpointSequence: handoff.payload.preparedCheckpointSequence + 2,
          verifiedCommitReceiptFingerprint,
          commitSha: state.backgroundCommitSha,
          workspaceBindingFingerprint:
            handoff.payload.workspaceBindingFingerprint,
          repositoryProfileFingerprint:
            handoff.payload.repositoryProfileFingerprint,
          sandboxCapabilityFingerprint:
            handoff.payload.sandboxCapabilityFingerprint,
        };
        const verified = {
          id: `receipt-${jobId}-verified`,
          jobId,
          provider: "code",
          operation: "prepared_code_validation_commit_v1",
          status: "verified",
          fingerprint: await receiptFingerprint(
            remote,
            "verified",
            verifiedPayload,
          ),
          payload: verifiedPayload,
          createdAt: new Date().toISOString(),
        };
        state.receipts[jobId].push(verified);
        const completion = {
          status: "complete",
          outputs: {
            repairRequestId: state.repairRequestId,
            workspaceId: handoff.binding.workspaceId,
            commitSha: state.backgroundCommitSha,
            verifiedCommitReceiptFingerprint,
          },
          evidence: [
            {
              kind: "verified_local_commit",
              fingerprint: verifiedCommitReceiptFingerprint,
              commitSha: state.backgroundCommitSha,
            },
          ],
          receiptIds: [verified.id],
          blocker: null,
        };
        const resultFingerprint = await sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint: remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint:
              remote.payload.authorization.fingerprint,
          },
          result: completion,
        });
        remote.state = "complete";
        remote.output = { ...completion, resultFingerprint };
        remote.updatedAt = new Date().toISOString();
        appendEvent(jobId, "receipt_committed", {
          status: "verified",
          fingerprint: verified.fingerprint,
        });
        appendEvent(jobId, "job_completed", { status: "complete" });
      };
      const jsonResponse = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
      const persistedPackageMatches = (identity: any): boolean => {
        try {
          const nodeRequire = harnessWindow.require;
          if (!nodeRequire) return false;
          const fs = nodeRequire("node:fs") as typeof import("node:fs");
          const nodePath = nodeRequire("node:path") as typeof import("node:path");
          const processModule = nodeRequire("node:process") as typeof import("node:process");
          const localAppData = processModule.env.LOCALAPPDATA;
          if (!localAppData) return false;
          const filePath = nodePath.join(
            localAppData,
            "AgenticResearcher",
            "code",
            "prepared-background-code-v1",
            `${identity.packageId}.json`,
          );
          const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
          return (
            persisted.id === identity.packageId &&
            persisted.fingerprint === identity.packageFingerprint
          );
        } catch {
          return false;
        }
      };
      const companionFetch = async (
        rawInput: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = new URL(String(rawInput));
        state.requestLog.push({
          method: String(init?.method ?? "GET").toUpperCase(),
          path: `${url.pathname}${url.search}`,
          at: new Date().toISOString(),
        });
        if (url.pathname === "/health") {
          return jsonResponse({
            ok: true,
            service: "agentic-researcher-companion",
            browserReady: false,
            memoryReady: false,
            coordinatorReady: true,
            workerReady: true,
            workerDiagnostic: null,
            installedExecutorDomains: ["code"],
            executorCatalogVersion: 1,
            secureStorePersistent: true,
            backgroundEnabled: true,
            backgroundBlocker: null,
            version: "background-code-e2e",
          });
        }
        const linearQueueCursor = Number(
          companion.companionCoordinator?.getRuntimeState?.()
            ?.linearQueueLastAppliedEventSequence ?? 0,
        );
        const disabledLinearQueueStatus = {
          enabled: false,
          configurationFingerprint: null,
          queueProjectId: null,
          authorityExpiresAt: null,
          cursor: null,
          nextScanAt: null,
          lastScanStartedAt: null,
          lastScanCompletedAt: null,
          lastErrorCode: null,
          candidateCount: 0,
          scheduledReadbackCount: 0,
          latestEventSequence: linearQueueCursor,
        };
        if (
          url.pathname === "/linear-queue/configuration" &&
          init?.method === "DELETE"
        ) {
          return jsonResponse(disabledLinearQueueStatus);
        }
        if (url.pathname === "/linear-queue/status") {
          return jsonResponse(disabledLinearQueueStatus);
        }
        if (url.pathname === "/linear-queue/events") {
          return jsonResponse({ events: [] });
        }
        if (url.pathname === "/jobs" && init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          state.postCount += 1;
          const runtime = await findRuntimeByJobId(body.id);
          const journal = runtime?.operationJournal?.find(
            (record: any) =>
              record.backgroundCodeDispatchAttempt?.jobId === body.id,
          );
          const identity = body.payload.preparedBackgroundCodePackage;
          state.walPresentBeforePost = Boolean(journal);
          state.packageIdentityPresentBeforePost = Boolean(
            identity &&
              journal?.preparedBackgroundCodePackage?.fingerprint ===
                identity.fingerprint,
          );
          state.packageReadbackVerifiedBeforePost =
            persistedPackageMatches(identity);
          if (state.jobs[body.id]) return jsonResponse(state.jobs[body.id]);
          const now = new Date().toISOString();
          const remote = {
            id: body.id,
            missionId: body.missionId,
            nodeId: body.nodeId,
            executionHost: body.executionHost,
            state: "running",
            payload: body.payload,
            capabilityEnvelope: body.capabilityEnvelope,
            idempotencyKey: body.idempotencyKey,
            ownerCoordinatorId: "background-code-e2e-worker",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          };
          state.jobs[body.id] = remote;
          state.receipts[body.id] = [];
          state.events[body.id] = [];
          appendEvent(body.id, "job_accepted", {});
          appendEvent(body.id, "job_started", {});
          setTimeout(() => void transitionAmbiguous(body.id), 800);
          setTimeout(() => void transitionComplete(body.id), 2_000);
          return jsonResponse(remote);
        }
        const segments = url.pathname.split("/").filter(Boolean);
        const jobId = decodeURIComponent(segments[1] ?? "");
        const remote = state.jobs[jobId];
        if (!remote) return jsonResponse({ detail: "not found" }, 404);
        if (segments.length === 2) return jsonResponse(remote);
        if (segments[2] === "receipts") {
          return jsonResponse({ receipts: state.receipts[jobId] ?? [] });
        }
        if (segments[2] === "events") {
          const after = Number(url.searchParams.get("after") ?? 0);
          const frames = (state.events[jobId] ?? [])
            .filter((event: any) => event.sequence > after)
            .map(
              (event: any) =>
                `id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join("");
          return new Response(frames, {
            headers: { "Content-Type": "text/event-stream" },
          });
        }
        return jsonResponse({ detail: "unsupported" }, 404);
      };
      state.fetchImpl = companionFetch;
      harnessWindow.__e2eBackgroundCode = state;

      const definitions = core
        .createToolRegistry()
        .getDefinitions()
        .find((item: any) => item.function?.name === backgroundTool);
      state.readyFixtureAvailable = Boolean(
        definitions?.function?.parameters?.properties?.repairCheckpointId &&
          typeof code.prepareBackgroundValidationCommitApproval === "function" &&
          typeof code.sealBackgroundValidationCommitPackage === "function",
      );
      await companion.pairForegroundCompanion({
        baseUrl: "http://127.0.0.1:18789",
        acquireBootstrapToken: async () =>
          "background-code-companion-bootstrap-token-0123456789abcdef",
        fetchImpl: companionFetch,
      });
      const instrumentBackgroundPort = (target: any) => {
        if (
          !target?.createBackgroundMissionDispatchPort ||
          target.__e2eBackgroundCodePortInstrumented
        ) {
          return;
        }
        const original =
          target.createBackgroundMissionDispatchPort.bind(target);
        const observe = (port: any) => {
          state.backgroundDispatchPortAvailable = Boolean(port);
          state.backgroundCodeSealerAvailable =
            typeof port?.sealBackgroundValidationCommitPackage === "function";
          if (
            port?.submitAuthorizedNode &&
            !port.__e2eBackgroundCodeSubmitInstrumented
          ) {
            const originalSubmit = port.submitAuthorizedNode.bind(port);
            port.submitAuthorizedNode = async (input: any) => {
              state.backgroundSubmitCallCount += 1;
              try {
                const result = await originalSubmit(input);
                state.backgroundSubmitResult = clone(result);
                return result;
              } catch (error) {
                state.backgroundSubmitError =
                  error instanceof Error ? error.message : String(error);
                throw error;
              }
            };
            port.__e2eBackgroundCodeSubmitInstrumented = true;
          }
          return port;
        };
        observe(original());
        target.createBackgroundMissionDispatchPort = (...args: any[]) => {
          state.backgroundDispatchPortCreationCount += 1;
          return observe(original(...args));
        };
        target.__e2eBackgroundCodePortInstrumented = true;
      };
      instrumentBackgroundPort(core);
      for (const leaf of app.workspace.getLeavesOfType?.(
        "agentic-researcher-view",
      ) ?? []) {
        instrumentBackgroundPort(leaf.view?.plugin);
      }

      // Model the real continuation lifecycle: a completed foreground edit and
      // diff-preview checkpoint already belong to an earlier run before the
      // user starts this separately authorized background mission.
      state.sourceRunId =
        `run-background-code-source-${marker.toLowerCase()}`;
      await ensurePreparedFixture(state.sourceRunId);
    },
    {
      ...input,
      corePluginId: PHASE4_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
      backgroundTool: BACKGROUND_TOOL,
    },
  );
}

async function submitMission(page: Page, prompt: string): Promise<void> {
  await page.getByRole("tab", { name: "Chat" }).click();
  const input = page.locator("textarea.agentic-researcher-prompt");
  await expect(input).toBeEnabled({ timeout: 15_000 });
  await input.fill(prompt);
  await page.locator("button.agentic-researcher-run").click();
  await expect(
    page.locator(".agentic-researcher-log-user .agentic-researcher-log-message", {
      hasText: prompt,
    }),
  ).toBeVisible({ timeout: 15_000 });
}

async function approveForegroundFixtureActions(page: Page): Promise<void> {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await page.getByRole("tab", { name: "Run Details" }).click();
    const code = activeCodeApproval(page);
    if (await code.isVisible().catch(() => false)) return;
    const snapshot = await readPageSnapshot(page);
    if (snapshot.blockerCode) return;
    const card = page
      .locator(".agentic-researcher-approval-card")
      .filter({
        has: page.locator("button.agentic-researcher-approval-approve:enabled"),
      })
      .last();
    const button = card.locator(
      "button.agentic-researcher-approval-approve:enabled",
    );
    if (await button.isVisible().catch(() => false)) {
      const text = (await card.textContent()) ?? "";
      if (text.includes(BACKGROUND_TOOL)) return;
      await expect(card).toContainText("exact_payload_approval");
      await button.click();
      await page.waitForTimeout(100);
      continue;
    }
    await page.waitForTimeout(150);
  }
  throw new Error("Timed out preparing the foreground Code fixture.");
}

function activeCodeApproval(page: Page): Locator {
  return page
    .locator(".agentic-researcher-approval-card", { hasText: BACKGROUND_TOOL })
    .filter({
      has: page.locator("button.agentic-researcher-approval-approve:enabled"),
    })
    .last();
}

async function approveCodeAction(approval: Locator): Promise<void> {
  await approval
    .locator("button.agentic-researcher-approval-approve:enabled")
    .click();
  await expect(approval).toHaveCount(0, { timeout: 15_000 });
}

async function readyFixtureAvailable(page: Page): Promise<boolean> {
  return page.evaluate(() =>
    Boolean(
      (window as typeof window & { __e2eBackgroundCode?: any })
        .__e2eBackgroundCode?.readyFixtureAvailable,
    ),
  );
}

async function waitForRemoteSubmission(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readPageSnapshot(page);
        if (snapshot.foregroundExecutePreparedCount > 0) {
          throw new Error(
            `Forbidden foreground Code execution observed: ${JSON.stringify({
              grantIds: snapshot.foregroundExecutePreparedGrantIds,
              resultCodes: snapshot.foregroundExecutePreparedResultCodes,
              operationIds: snapshot.foregroundExecutePreparedOperationIds,
              runtimeApi:
                snapshot.foregroundExecutePreparedRuntimeApiAvailable,
              runtimeSnapshot:
                snapshot.foregroundExecutePreparedRuntimeSnapshotReadable,
              descriptorJournal: snapshot.backgroundDescriptorJournal,
              graphNodeId: snapshot.graphNodeId,
              graphNodeDestination: snapshot.graphNodeDestination,
              graphNodeResourceLocks: snapshot.graphNodeResourceLocks,
              graphBinding: snapshot.graphBinding,
              workspaceBinding: snapshot.workspaceBinding,
              bindingResolveCallCount: snapshot.bindingResolveCallCount,
              bindingResolveResult: snapshot.bindingResolveResult,
              submitCalls: snapshot.backgroundSubmitCallCount,
              submitResult: snapshot.backgroundSubmitResult,
              submitError: snapshot.backgroundSubmitError,
            })}`,
          );
        }
        if (
          snapshot.sealResult &&
          typeof snapshot.sealResult === "object" &&
          "status" in snapshot.sealResult &&
          snapshot.sealResult.status === "blocked"
        ) {
          throw new Error(
            `Background Code package sealing blocked: ${JSON.stringify({
              blockerCode: snapshot.blockerCode,
              sealResult: snapshot.sealResult,
              sealError: snapshot.sealError,
              graphNodeId: snapshot.graphNodeId,
              graphNodeDestination: snapshot.graphNodeDestination,
              graphNodeResourceLocks: snapshot.graphNodeResourceLocks,
              graphBinding: snapshot.graphBinding,
              workspaceBinding: snapshot.workspaceBinding,
              bindingResolveCallCount: snapshot.bindingResolveCallCount,
              bindingResolveResult: snapshot.bindingResolveResult,
            })}`,
          );
        }
        return {
          postCount: snapshot.postCount,
          sealCount: snapshot.sealCount,
          sealResultStatus:
            snapshot.sealResult && typeof snapshot.sealResult === "object" &&
            "status" in snapshot.sealResult
              ? snapshot.sealResult.status
              : null,
          sealError: snapshot.sealError,
          foregroundExecutePreparedCount:
            snapshot.foregroundExecutePreparedCount,
          grantIds: snapshot.foregroundExecutePreparedGrantIds,
          resultCodes: snapshot.foregroundExecutePreparedResultCodes,
          operationIds: snapshot.foregroundExecutePreparedOperationIds,
          runtimeApi: snapshot.foregroundExecutePreparedRuntimeApiAvailable,
          runtimeSnapshot:
            snapshot.foregroundExecutePreparedRuntimeSnapshotReadable,
          descriptorJournal: snapshot.backgroundDescriptorJournal,
          submitCalls: snapshot.backgroundSubmitCallCount,
          submitResult: snapshot.backgroundSubmitResult,
          submitError: snapshot.backgroundSubmitError,
        };
      },
      {
        timeout: 60_000,
        message: "the exact Code package should POST once",
      },
    )
    .toEqual({
      postCount: 1,
      sealCount: 1,
      sealResultStatus: "ready",
      sealError: null,
      foregroundExecutePreparedCount: 0,
      grantIds: [],
      resultCodes: [],
      operationIds: [],
      runtimeApi: [],
      runtimeSnapshot: [],
      descriptorJournal: true,
      submitCalls: 1,
      submitResult: expect.objectContaining({ status: "submitted" }),
      submitError: null,
    });
}

async function disconnectAndRestartCoreCode(page: Page): Promise<void> {
  await page.evaluate(
    async ({ corePluginId, codePluginId, companionPluginId }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        __e2eBackgroundCode?: any;
      };
      const app = harnessWindow.app;
      const state = harnessWindow.__e2eBackgroundCode;
      const companion = app?.plugins?.plugins?.[companionPluginId];
      companion?.companionCoordinator?.clearSession?.();
      await app.plugins.disablePlugin(codePluginId);
      await app.plugins.disablePlugin(corePluginId);
      await app.plugins.enablePlugin(corePluginId);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if (app.plugins.plugins?.[corePluginId]?.agenticResearcherApi?.state === "ready") {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      state.installMocks?.();
      await app.plugins.plugins?.[corePluginId]?.activateView?.();
      state.installMocks?.();
      await app.plugins.enablePlugin(codePluginId);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const core = app.plugins.plugins?.[corePluginId];
        if (
          app.plugins.plugins?.[codePluginId] &&
          core?.agenticResearcherApi
            ?.getRegisteredExtensionIds?.()
            ?.includes(codePluginId)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      state.installMocks?.();
    },
    {
      corePluginId: PHASE4_CORE_PLUGIN_ID,
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
    },
  );
  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
}

async function reconnectCompanion(page: Page): Promise<void> {
  await page.evaluate(async ({ companionPluginId }) => {
    const harnessWindow = window as typeof window & {
      app?: any;
      __e2eBackgroundCode?: any;
    };
    const companion = harnessWindow.app?.plugins?.plugins?.[companionPluginId];
    const state = harnessWindow.__e2eBackgroundCode;
    if (!companion?.pairForegroundCompanion || !state?.fetchImpl) {
      throw new Error("Companion reconnect fixture is unavailable.");
    }
    await companion.pairForegroundCompanion({
      baseUrl: "http://127.0.0.1:18789",
      acquireBootstrapToken: async () =>
        "background-code-companion-bootstrap-token-0123456789abcdef",
      fetchImpl: state.fetchImpl,
    });
  }, { companionPluginId: COMPANION_PLUGIN_ID });
}

async function requestReconciliation(page: Page): Promise<void> {
  await page.evaluate(async ({ corePluginId }) => {
    const core = (window as typeof window & { app?: any }).app?.plugins?.plugins?.[
      corePluginId
    ];
    if (typeof core?.reconcileCompanionMissionGraphs !== "function") {
      throw new Error("Core companion reconciliation entry point is unavailable.");
    }
    await core.reconcileCompanionMissionGraphs();
  }, { corePluginId: PHASE4_CORE_PLUGIN_ID });
}

async function readRemoteState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & { __e2eBackgroundCode?: any }
    ).__e2eBackgroundCode;
    const jobId = Object.keys(state?.jobs ?? {})[0];
    return jobId ? String(state.jobs[jobId]?.state ?? "") : null;
  });
}

async function readPageSnapshot(
  page: Page,
): Promise<Omit<BackgroundCodeCompanionSnapshot, "baseSha" | "worktreeHead"> & {
  commitSha: string | null;
}> {
  return page.evaluate(
    async ({ codePluginId, companionPluginId }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        __e2eBackgroundCode?: any;
      };
      const app = harnessWindow.app;
      const state = harnessWindow.__e2eBackgroundCode;
      const jobId = Object.keys(state?.jobs ?? {})[0] ?? "";
      const runtime = await state?.readRuntime?.();
      const journal = runtime?.operationJournal?.find(
        (record: any) =>
          record.toolName === "code_validate_commit_prepared",
      );
      let graphNode: any = null;
      let graphRecord: any = null;
      if (runtime?.missionGraphRef?.path) {
        const graphFile = app.vault.getAbstractFileByPath(
          runtime.missionGraphRef.path,
        );
        if (graphFile) {
          const markdown = await app.vault.cachedRead(graphFile);
          const match =
            /## Mission Graph Store\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(
              markdown,
            );
          const record = match ? JSON.parse(match[1]) : null;
          graphRecord = record;
          graphNode = journal?.nodeId
            ? record?.graph?.nodes?.[journal.nodeId] ?? null
            : Object.values(record?.graph?.nodes ?? {}).find((node: any) =>
                node?.allowedTools?.includes(
                  "code_validate_commit_prepared",
                ),
              ) ?? null;
        }
      }
      const graphBindingId = graphNode?.destination?.bindingId ?? null;
      const graphBinding = graphBindingId
        ? graphRecord?.graph?.capabilityEnvelope?.bindings?.[graphBindingId] ?? null
        : null;
      const workspaceManifest = state?.workspaceId
        ? await app.plugins.plugins?.[codePluginId]?.runtime?.workspaceManager
            ?.loadManifest?.(state.workspaceId)
            .catch(() => null)
        : null;
      const status = app.plugins.plugins?.[codePluginId]?.runtime
        ?.sandboxManager?.readStatus?.();
      return {
        blockerCode: state?.blockerCode ?? null,
        sandboxMode: state?.sandboxMode ?? status?.mode ?? null,
        sandboxExecutionAvailable:
          state?.sandboxExecutionAvailable ?? status?.executionAvailable ?? null,
        postCount: Number(state?.postCount ?? 0),
        sealCount: Number(state?.sealCount ?? 0),
        sealResult: JSON.parse(JSON.stringify(state?.sealResult ?? null)),
        sealError: state?.sealError ?? null,
        modelToolCallCount: Number(state?.modelToolCallCount ?? 0),
        backgroundToolArguments: JSON.parse(
          JSON.stringify(state?.backgroundToolArguments ?? []),
        ),
        foregroundExecuteCount: Number(state?.foregroundExecuteCount ?? 0),
        foregroundExecutePreparedCount: Number(
          state?.foregroundExecutePreparedCount ?? 0,
        ),
        foregroundExecutePreparedGrantIds: JSON.parse(
          JSON.stringify(state?.foregroundExecutePreparedGrantIds ?? []),
        ),
        foregroundExecutePreparedResultCodes: JSON.parse(
          JSON.stringify(state?.foregroundExecutePreparedResultCodes ?? []),
        ),
        foregroundExecutePreparedOperationIds: JSON.parse(
          JSON.stringify(state?.foregroundExecutePreparedOperationIds ?? []),
        ),
        foregroundExecutePreparedRuntimeApiAvailable: JSON.parse(
          JSON.stringify(
            state?.foregroundExecutePreparedRuntimeApiAvailable ?? [],
          ),
        ),
        foregroundExecutePreparedRuntimeSnapshotReadable: JSON.parse(
          JSON.stringify(
            state?.foregroundExecutePreparedRuntimeSnapshotReadable ?? [],
          ),
        ),
        backgroundDescriptorJournal:
          typeof state?.backgroundDescriptorJournal === "boolean"
            ? state.backgroundDescriptorJournal
            : null,
        foregroundNativeExecutionCount: Number(
          state?.foregroundNativeExecutionCount ?? 0,
        ),
        walPresentBeforePost: state?.walPresentBeforePost === true,
        packageIdentityPresentBeforePost:
          state?.packageIdentityPresentBeforePost === true,
        packageReadbackVerifiedBeforePost:
          state?.packageReadbackVerifiedBeforePost === true,
        remoteState: jobId ? state.jobs[jobId]?.state ?? null : null,
        receiptStatuses: jobId
          ? (state.receipts[jobId] ?? []).map((item: any) => item.status)
          : [],
        runtimeJournalState: journal?.state ?? null,
        backgroundAttemptStatus:
          journal?.backgroundCodeDispatchAttempt?.status ?? null,
        graphNodeStatus: graphNode?.status ?? null,
        graphNodeId: graphNode?.id ?? null,
        graphNodeAllowedTools: JSON.parse(
          JSON.stringify(graphNode?.allowedTools ?? []),
        ),
        graphNodeEffect: graphNode?.effect ?? null,
        graphNodeExecutionHost: graphNode?.executionHost ?? null,
        graphNodeDestination: JSON.parse(
          JSON.stringify(graphNode?.destination ?? null),
        ),
        graphNodeResourceLocks: JSON.parse(
          JSON.stringify(graphNode?.resourceLocks ?? []),
        ),
        graphBinding: JSON.parse(JSON.stringify(graphBinding)),
        workspaceBinding: JSON.parse(
          JSON.stringify(workspaceManifest?.repositoryBinding ?? null),
        ),
        bindingResolveCallCount: Number(state?.bindingResolveCallCount ?? 0),
        bindingResolveResult: JSON.parse(
          JSON.stringify(state?.bindingResolveResult ?? null),
        ),
        backgroundDispatchPortAvailable:
          state?.backgroundDispatchPortAvailable === true,
        backgroundCodeSealerAvailable:
          state?.backgroundCodeSealerAvailable === true,
        backgroundDispatchPortCreationCount: Number(
          state?.backgroundDispatchPortCreationCount ?? 0,
        ),
        backgroundSubmitCallCount: Number(
          state?.backgroundSubmitCallCount ?? 0,
        ),
        backgroundSubmitResult: JSON.parse(
          JSON.stringify(state?.backgroundSubmitResult ?? null),
        ),
        backgroundSubmitError: state?.backgroundSubmitError ?? null,
        graphReceiptKinds: (graphNode?.receipts ?? []).map((item: any) =>
          String(item.kind),
        ),
        graphEvidenceKinds: (graphNode?.evidence ?? []).map((item: any) =>
          String(item.kind),
        ),
        graphVerifierId: graphNode?.verification?.verifierId ?? null,
        graphCompletionTransitionCount: (graphNode?.transitions ?? []).filter(
          (item: any) => item?.status === "complete" || item?.state === "complete",
        ).length || (graphNode?.status === "complete" ? 1 : 0),
        commitSha: state?.backgroundCommitSha ?? null,
        worktreeRoot: state?.worktreeRoot ?? null,
        branch: state?.branch ?? null,
      };
    },
    {
      codePluginId: PHASE4_CODE_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
    },
  );
}

async function readWorkspaceBinding(
  page: Page,
): Promise<{ worktreeRoot: string; branch: string } | null> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & { __e2eBackgroundCode?: any }
    ).__e2eBackgroundCode;
    return state?.worktreeRoot && state?.branch
      ? { worktreeRoot: state.worktreeRoot, branch: state.branch }
      : null;
  });
}

async function snapshotBackgroundCodeStores(): Promise<DirectoryBaseline[]> {
  if (!process.env.LOCALAPPDATA) return [];
  const root = path.join(process.env.LOCALAPPDATA, "AgenticResearcher", "code");
  return Promise.all(
    ["prepared-background-code-v1", "prepared-background-code-execution-v1"].map(
      async (name) => {
        const directory = path.join(root, name);
        const stat = await lstat(directory).catch(
          (error: NodeJS.ErrnoException) =>
            error.code === "ENOENT" ? null : Promise.reject(error),
        );
        if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
          throw new Error(`Background Code store is unsafe: ${directory}`);
        }
        return {
          root: stat ? await realpath(directory) : directory,
          existingNames: new Set(
            stat
              ? (await readdir(directory, { withFileTypes: true })).map(
                  (entry) => entry.name,
                )
              : [],
          ),
        };
      },
    ),
  );
}

async function restoreBackgroundCodeStores(
  baselines: DirectoryBaseline[],
): Promise<void> {
  for (const baseline of baselines) {
    const stat = await lstat(baseline.root).catch(
      (error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Background Code cleanup root is unsafe: ${baseline.root}`);
    }
    const canonicalRoot = await realpath(baseline.root);
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (baseline.existingNames.has(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || !/^[A-Za-z0-9._:-]+\.json$/u.test(entry.name)) {
        throw new Error(
          `Refusing to remove unexpected Background Code store entry ${entry.name}.`,
        );
      }
      const candidate = path.join(canonicalRoot, entry.name);
      const canonicalCandidate = await realpath(candidate);
      if (path.dirname(canonicalCandidate) !== canonicalRoot) {
        throw new Error(`Background Code store entry escaped cleanup root.`);
      }
      await rm(canonicalCandidate, { force: true });
    }
  }
}

const OWNED_BACKGROUND_WORKSPACE =
  /^phase4-repair-e2e_phase4_\d+-\d+$/u;

/**
 * Interrupted desktop runs can end before Phase4Harness restores its byte
 * snapshot. Remove only this harness's exact marker namespace before Obsidian
 * loads the Code extension; a malformed owned checkpoint must not make every
 * later native launch fail. User profiles, checkpoints, settings, and history
 * remain byte-for-byte represented in the rewritten object.
 */
async function removeStaleBackgroundCodeFixtures(): Promise<void> {
  const userProfile = process.env.USERPROFILE;
  const localAppData = process.env.LOCALAPPDATA;
  if (!userProfile || !localAppData) return;
  const vaultRoot = path.resolve(
    process.env.OBSIDIAN_VAULT ??
      path.join(userProfile, "OneDrive", "Desktop", "test_vault_obsidian_ai"),
  );
  const dataPath = path.join(
    vaultRoot,
    ".obsidian",
    "plugins",
    PHASE4_CODE_PLUGIN_ID,
    "data.json",
  );
  const dataStat = await lstat(dataPath).catch(
    (error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (dataStat) {
    if (!dataStat.isFile() || dataStat.isSymbolicLink()) {
      throw new Error("Code plugin data must be a real file before E2E cleanup.");
    }
    const data = JSON.parse(await readFile(dataPath, "utf8")) as Record<
      string,
      any
    >;
    let changed = false;
    const profiles = data.codeRuntimeState?.repositoryProfiles;
    if (profiles && typeof profiles === "object" && !Array.isArray(profiles)) {
      for (const key of Object.keys(profiles)) {
        const workspaceId = key.startsWith("raw-") ? key.slice(4) : "";
        if (OWNED_BACKGROUND_WORKSPACE.test(workspaceId)) {
          delete profiles[key];
          changed = true;
        }
      }
    }
    const namespace = data.codeRepairCheckpointsV1;
    const checkpoints = namespace?.checkpoints;
    if (
      namespace &&
      checkpoints &&
      typeof checkpoints === "object" &&
      !Array.isArray(checkpoints)
    ) {
      let removedCheckpoint = false;
      for (const [key, value] of Object.entries(checkpoints)) {
        const workspaceId = String(
          (value as any)?.request?.worktree?.id ?? "",
        );
        if (OWNED_BACKGROUND_WORKSPACE.test(workspaceId)) {
          delete checkpoints[key];
          removedCheckpoint = true;
          changed = true;
        }
      }
      if (removedCheckpoint) {
        namespace.revision = Number(namespace.revision ?? 0) + 1;
      }
    }
    if (changed) {
      await writeFile(dataPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    }
  }

  const applicationRoot = path.resolve(localAppData, "AgenticResearcher", "code");
  for (const directory of ["repository-worktrees", "workspaces-v2"]) {
    await removeOwnedWorkspaceChildren(path.join(applicationRoot, directory));
  }
}

async function removeOwnedWorkspaceChildren(root: string): Promise<void> {
  const rootStat = await lstat(root).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error));
  if (!rootStat) return;
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Owned background-Code cleanup root is unsafe: ${root}`);
  }
  const canonicalRoot = await realpath(root);
  for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
    if (!OWNED_BACKGROUND_WORKSPACE.test(entry.name)) continue;
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Owned background-Code artifact is unsafe: ${entry.name}`);
    }
    const candidate = path.join(canonicalRoot, entry.name);
    const canonicalCandidate = await realpath(candidate);
    if (
      path.dirname(canonicalCandidate) !== canonicalRoot ||
      path.basename(canonicalCandidate) !== entry.name
    ) {
      throw new Error(`Owned background-Code artifact escaped cleanup: ${entry.name}`);
    }
    await rm(canonicalCandidate, { recursive: true, force: true });
  }
}
