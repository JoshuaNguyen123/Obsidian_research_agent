import { expect, type Locator, type Page } from "@playwright/test";
import {
  lstat,
  readdir,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  createVerifiedCodePublicationHandoffV1,
  fingerprintBackgroundGitHubValueV1,
  type VerifiedCodePublicationHandoffV1,
} from "../../packages/core-api/src";
import {
  detectRepositoryProfileV2,
  type RepositoryProfileV2,
} from "../../extensions/code/repositories";
import {
  createTrustedGitHubRepositoryBindingV1,
  type TrustedGitHubRepositoryBindingV1,
} from "../../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  parseGitHubPublicationCheckpointV1,
  type GitHubPublicationCheckpointNamespaceV1,
} from "../../src/integrations/github/GitHubPublicationCheckpointStore";
import type { GitHubPublicationCheckpointV1 } from "../../src/integrations/github/GitHubPublicationWorkflow";
import type { GitHubCredentialV1 } from "../../src/integrations/github/GitHubAuth";
import {
  NATIVE_CORE_PLUGIN_ID,
  startNativeObsidianHarness,
  type NativeObsidianHarness,
  type NativeObsidianSetupContext,
} from "./nativeObsidianHarness";

const CODE_PLUGIN_ID = "agentic-researcher-code";
const INTEGRATIONS_PLUGIN_ID = "agentic-researcher-integrations";
const COMPANION_PLUGIN_ID = "agentic-researcher-companion";
const BACKGROUND_TOOL = "github_create_draft_pull_request";

interface TrustedGitHubFixtureV1 {
  profile: RepositoryProfileV2;
  binding: TrustedGitHubRepositoryBindingV1;
  handoff: VerifiedCodePublicationHandoffV1;
  credential: GitHubCredentialV1;
  checkpoint: GitHubPublicationCheckpointV1;
  checkpoints: GitHubPublicationCheckpointNamespaceV1;
  publicationId: string;
  title: string;
  body: string;
  branch: string;
  baseSha: string;
  headSha: string;
  remoteBranchObservedAt: string;
}

export interface BackgroundGitHubCompanionSnapshot {
  modelToolCallCount: number;
  backgroundToolArguments: Array<Record<string, unknown>>;
  signerReceiptCount: number;
  actionSignerReceiptCount: number;
  hostSyncCount: number;
  bindingResolveCount: number;
  sealCount: number;
  sealResultStatus: string | null;
  sealError: string | null;
  submitCount: number;
  postCount: number;
  foregroundExecuteCount: number;
  foregroundExecutePreparedCount: number;
  providerFallbackCount: number;
  walPresentBeforePost: boolean;
  packageIdentityPresentBeforePost: boolean;
  packageReadbackVerifiedBeforePost: boolean;
  signerReceiptPresentBeforePost: boolean;
  remoteState: string | null;
  remoteOutputHasFullProof: boolean;
  receiptHasFullProof: boolean;
  outputReceiptProofMatch: boolean;
  receiptStatuses: string[];
  runtimeJournalState: string | null;
  backgroundAttemptStatus: string | null;
  graphNodeStatus: string | null;
  graphNodeAllowedTools: string[];
  graphNodeExecutionHost: string | null;
  graphNodeEffect: string | null;
  graphReceiptKinds: string[];
  graphEvidenceKinds: string[];
  graphVerifierId: string | null;
  graphCompletionTransitionCount: number;
  integrationsCheckpointStatus: string | null;
  integrationsCheckpointReceiptIds: string[];
  integrationsCheckpointRevision: number | null;
  coreCheckpointStatus: string | null;
  integrationsApplyCount: number;
  coreCheckpointUpsertCount: number;
  reconciliationOrder: string[];
  lineageState: string | null;
  lineageReconcileStatus: string | null;
  proofMode: "full" | "fingerprint-only";
}

export interface BackgroundGitHubCompanionHarness extends NativeObsidianHarness {
  fixture: TrustedGitHubFixtureV1;
  submitMission(): Promise<void>;
  activeApproval(): Locator;
  approve(approval: Locator): Promise<void>;
  waitForRemoteSubmission(): Promise<void>;
  disconnectAndRestartCoreIntegrations(): Promise<void>;
  waitForRemoteCompletion(): Promise<void>;
  useFingerprintOnlyOutput(): Promise<void>;
  restoreFullOutput(): Promise<void>;
  reconnectCompanion(): Promise<void>;
  requestReconciliation(): Promise<void>;
  readSnapshot(): Promise<BackgroundGitHubCompanionSnapshot>;
}

interface DirectoryBaseline {
  root: string;
  existingNames: Set<string>;
}

export async function startBackgroundGitHubCompanionHarness(): Promise<BackgroundGitHubCompanionHarness> {
  const packageBaselines = await snapshotBackgroundGitHubStores();
  let fixture: TrustedGitHubFixtureV1 | null = null;
  let native: NativeObsidianHarness | null = null;
  try {
    native = await startNativeObsidianHarness({
      label: "background-github-companion",
      setup: async (context) => {
        fixture = createTrustedFixture(context.marker);
        await installBackgroundGitHubPageHarness(context, fixture);
      },
    });
    await expect(native.page.locator(".agentic-researcher-view")).toHaveCount(1, {
      timeout: 30_000,
    });
    await expect(native.page.getByRole("tab", { name: "Chat" })).toBeVisible();
  } catch (error) {
    await native?.close().catch(() => undefined);
    await restoreBackgroundGitHubStores(packageBaselines).catch(() => undefined);
    throw error;
  }
  if (!fixture) {
    await native.close().catch(() => undefined);
    await restoreBackgroundGitHubStores(packageBaselines).catch(() => undefined);
    throw new Error("The trusted GitHub fixture was not initialized.");
  }

  // These values are initialized inside the native harness setup callback.
  // TypeScript cannot prove that callback assignment across the async call,
  // while the null guard above provides the runtime proof.
  const activeNative = native as NativeObsidianHarness;
  const activeFixture = fixture as TrustedGitHubFixtureV1;
  let closed = false;
  const prompt = [
    "E2E_BACKGROUND_GITHUB_DRAFT_CONTINUATION",
    activeNative.marker,
    `Create the exact draft pull request for trusted profile ${activeFixture.profile.key} and publication ${activeFixture.publicationId}.`,
    `Use only ${BACKGROUND_TOOL} with profileKey, publicationId, title, and body.`,
    "Continue the already-authorized external action in the background after Obsidian closes; never execute a foreground GitHub provider fallback.",
  ].join(" ");

  return {
    ...activeNative,
    fixture: activeFixture,
    submitMission: () => submitMission(activeNative.page, prompt),
    activeApproval: () => activeApproval(activeNative.page),
    approve: (approval) => approve(approval),
    waitForRemoteSubmission: () => waitForRemoteSubmission(activeNative.page),
    disconnectAndRestartCoreIntegrations: () =>
      disconnectAndRestartCoreIntegrations(activeNative.page),
    waitForRemoteCompletion: () =>
      expect
        .poll(() => readRemoteState(activeNative.page), {
          timeout: 90_000,
          message: "the deterministic GitHub companion should reach verified completion",
        })
        .toBe("complete"),
    useFingerprintOnlyOutput: () => setProofMode(activeNative.page, "fingerprint-only"),
    restoreFullOutput: () => setProofMode(activeNative.page, "full"),
    reconnectCompanion: () => reconnectCompanion(activeNative.page),
    requestReconciliation: () => requestReconciliation(activeNative.page),
    readSnapshot: () => readSnapshot(activeNative.page, activeFixture.publicationId),
    async close() {
      if (closed) return;
      closed = true;
      let teardownError: unknown = null;
      await activeNative.close().catch((error) => {
        teardownError = error;
      });
      await restoreBackgroundGitHubStores(packageBaselines).catch((error) => {
        teardownError ??= error;
      });
      if (teardownError) throw teardownError;
    },
  };
}

function createTrustedFixture(marker: string): TrustedGitHubFixtureV1 {
  const suffix = marker.toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(-48);
  const profileKey = `github-e2e-${suffix}`.slice(0, 120).replace(/-+$/u, "");
  const publicationId = `github-publication-${suffix}`.slice(0, 170).replace(/-+$/u, "");
  const root = `C:\\AgenticResearcherE2E\\${suffix}`;
  const branch = `codex/background-github-${suffix}`.slice(0, 240).replace(/-+$/u, "");
  const baseSha = "a".repeat(40);
  const headSha = "b".repeat(40);
  const treeSha = "c".repeat(40);
  const now = Date.now();
  const issuedAt = new Date(now - 10 * 60_000).toISOString();
  const committedAt = new Date(now - 8 * 60_000).toISOString();
  const preparedAt = new Date(now - 7 * 60_000).toISOString();
  const checkpointAt = new Date(now - 6 * 60_000).toISOString();
  const remoteBranchObservedAt = new Date(now - 5 * 60_000).toISOString();
  const profile = detectRepositoryProfileV2({
    key: profileKey,
    displayName: `Background GitHub E2E ${suffix}`,
    repositoryRoot: root,
    defaultBranch: "main",
    files: ["package.json", "package-lock.json", "src/value.ts"],
    fileContents: {
      "package.json": JSON.stringify({ name: profileKey, private: true }),
      "package-lock.json": JSON.stringify({ name: profileKey, lockfileVersion: 3 }),
    },
    requiredGitHubChecks: ["ci"],
  });
  const binding = createTrustedGitHubRepositoryBindingV1({
    key: `github-${profileKey}`,
    profile,
    owner: "agentic-e2e",
    repository: "research-agent-fixture",
    repositoryId: 101,
    verifiedAccountId: 202,
    verifiedAccountLogin: "agentic-e2e",
    trustedAt: issuedAt,
  });
  const changedHash = fingerprintBackgroundGitHubValueV1({ marker, path: "src/value.ts" });
  const commitEvidence = {
    requestId: `request-${suffix}`.slice(0, 240),
    runId: `code-run-${suffix}`.slice(0, 240),
    worktreeId: `worktree-${suffix}`.slice(0, 240),
    workspaceId: `workspace-${suffix}`.slice(0, 240),
    branch,
    baseSha,
    commitSha: headSha,
    parentSha: baseSha,
    treeSha,
    diffFingerprint: fingerprintBackgroundGitHubValueV1({ marker, kind: "diff" }),
    changedPaths: ["src/value.ts"],
    artifactHashes: [{ path: "src/value.ts", sha256: changedHash, bytes: 42 }],
    changedArtifacts: [{ path: "src/value.ts", sha256: changedHash }],
    targetedValidationReceiptId: `targeted-${suffix}`.slice(0, 240),
    fullValidationReceiptId: `full-${suffix}`.slice(0, 240),
    targetedValidationFingerprint: fingerprintBackgroundGitHubValueV1({ marker, kind: "targeted" }),
    fullValidationFingerprint: fingerprintBackgroundGitHubValueV1({ marker, kind: "full" }),
    committedAt,
  };
  const handoff = createVerifiedCodePublicationHandoffV1({
    id: `handoff-${suffix}`.slice(0, 240),
    repositoryProfileKey: profile.key,
    repositoryProfileFingerprint: binding.repositoryProfileFingerprint,
    canonicalWorktreeRoot: root,
    baseBranch: "main",
    localCommit: {
      version: 1,
      kind: "verified_local_commit",
      id: `commit-receipt-${suffix}`.slice(0, 240),
      status: "verified",
      ...commitEvidence,
      fingerprint: fingerprintBackgroundGitHubValueV1(commitEvidence),
    },
    preparedAt,
  });
  const checkpoint = parseGitHubPublicationCheckpointV1({
    version: 1,
    publicationId,
    status: "pushed_verified",
    updatedAt: checkpointAt,
    handoffFingerprint: handoff.fingerprint,
    bindingFingerprint: binding.fingerprint,
    headSha,
    branch,
    remoteSha: headSha,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: fingerprintBackgroundGitHubValueV1({ marker, kind: "push-approval" }),
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: "draft_pr",
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [`push-receipt-${suffix}`.slice(0, 240)],
    pendingAction: null,
    blocker: null,
  });
  return {
    profile,
    binding,
    handoff,
    credential: {
      version: 1,
      credentialId: `github_credential_${suffix.replace(/-/gu, "_").padEnd(24, "x")}`.slice(0, 100),
      credentialKind: "oauth_device",
      tokenReferenceId: `secret_github-${suffix}`.slice(0, 120),
      account: { id: 202, login: "agentic-e2e" },
      scopes: ["repo"],
      issuedAt,
    },
    checkpoint,
    checkpoints: {
      version: 1,
      revision: 1,
      checkpoints: { [publicationId]: checkpoint },
    },
    publicationId,
    title: `Draft PR ${suffix}`.slice(0, 160),
    body: `Verified background GitHub E2E publication ${publicationId}.`,
    branch,
    baseSha,
    headSha,
    remoteBranchObservedAt,
  };
}

async function installBackgroundGitHubPageHarness(
  context: NativeObsidianSetupContext,
  fixture: TrustedGitHubFixtureV1,
): Promise<void> {
  await context.page.evaluate(
    async ({
      corePluginId,
      codePluginId,
      integrationsPluginId,
      companionPluginId,
      backgroundTool,
      marker,
      notePath,
      fixtureValue,
    }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        require?: (id: string) => any;
        __e2eBackgroundGitHub?: any;
      };
      const app = harnessWindow.app;
      if (!app?.plugins || !app?.vault || !app?.workspace) {
        throw new Error("Obsidian app APIs are unavailable.");
      }
      if (typeof app.workspace.onLayoutReady === "function") {
        await new Promise<void>((resolve) => app.workspace.onLayoutReady(resolve));
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
      const integrations = await waitForPlugin(integrationsPluginId);
      const companion = await waitForPlugin(companionPluginId);
      if (
        core?.agenticResearcherApi?.state !== "ready" ||
        typeof integrations.synchronizeBackgroundGitHubHostState !== "function" ||
        typeof integrations.resolveBackgroundGitHubMissionBinding !== "function" ||
        typeof integrations.sealBackgroundGitHubPackage !== "function" ||
        typeof companion.pairForegroundCompanion !== "function"
      ) {
        throw new Error("Production core, Integrations, or Companion GitHub surfaces are unavailable.");
      }

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
      await ensureFolder(notePath.split("/").slice(0, -1).join("/"));
      const existingNote = app.vault.getAbstractFileByPath(notePath);
      if (existingNote) await app.vault.delete(existingNote, true);
      const note = await app.vault.create(
        notePath,
        `# Background GitHub companion E2E\n\n${marker}\n`,
      );
      const noteLeaf =
        (app.workspace.getLeavesOfType?.("markdown") ?? [])[0] ??
        (app.workspace.getLeavesOfType?.("empty") ?? [])[0] ??
        app.workspace.getLeaf("tab");
      await noteLeaf.openFile(note);
      app.workspace.setActiveLeaf(noteLeaf, { focus: true });

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
        const digest = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(canonicalJson(value)),
        );
        return `sha256:${[...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("")}`;
      };
      const fp = (character: string) =>
        `sha256:${character.repeat(64).slice(0, 64)}`;
      const state: any = {
        marker,
        fixture: clone(fixtureValue),
        toolCallSequence: 0,
        modelToolCallCount: 0,
        backgroundToolArguments: [],
        signerReceiptCount: 0,
        hostSyncCount: 0,
        hostSynchronized: false,
        bindingResolveCount: 0,
        sealCount: 0,
        sealResult: null,
        sealError: null,
        submitCount: 0,
        submitResult: null,
        submitError: null,
        postCount: 0,
        foregroundExecuteCount: 0,
        foregroundExecutePreparedCount: 0,
        providerFallbackCount: 0,
        walPresentBeforePost: false,
        packageIdentityPresentBeforePost: false,
        packageReadbackVerifiedBeforePost: false,
        signerReceiptPresentBeforePost: false,
        integrationsApplyCount: 0,
        coreCheckpointUpsertCount: 0,
        reconciliationOrder: [],
        graphCompletionRecorded: false,
        journalCommitRecorded: false,
        jobs: {},
        packages: {},
        receipts: {},
        events: {},
        attempts: {},
        requestLog: [],
        fullOutputs: {},
        proofMode: "full" as "full" | "fingerprint-only",
      };

      const parseRuntimeSnapshot = (markdown: string) => {
        const match =
          /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
        return match ? JSON.parse(match[1]) : null;
      };
      const parseGraphRecord = (markdown: string) => {
        const match =
          /## Mission Graph Store\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
        return match ? JSON.parse(match[1]) : null;
      };
      const findRuntimeByJobId = async (jobId: string) => {
        for (const file of app.vault.getMarkdownFiles()) {
          if (!/^Agent Runs\/[^/]+\.md$/iu.test(file.path)) continue;
          const runtime = parseRuntimeSnapshot(await app.vault.cachedRead(file));
          if (
            runtime?.operationJournal?.some(
              (record: any) =>
                record.backgroundGitHubDispatchAttempt?.jobId === jobId,
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
      state.readGraphNode = async (runtime: any) => {
        if (!runtime?.missionGraphRef?.path) return null;
        const file = app.vault.getAbstractFileByPath(runtime.missionGraphRef.path);
        if (!file) return null;
        const record = parseGraphRecord(await app.vault.cachedRead(file));
        const journal = runtime.operationJournal?.find(
          (item: any) => item.toolName === backgroundTool,
        );
        return journal?.nodeId
          ? record?.graph?.nodes?.[journal.nodeId] ?? null
          : Object.values(record?.graph?.nodes ?? {}).find((node: any) =>
              node?.allowedTools?.includes(backgroundTool),
            ) ?? null;
      };

      const installCodeFixtureBridge = (target: any) => {
        if (!target || target.__e2eBackgroundGitHubCodeBridge) return;
        const originalProfile = target.resolveTrustedRepositoryProfile?.bind(target);
        const originalHandoff = target.resolveVerifiedCodePublicationHandoff?.bind(target);
        target.resolveTrustedRepositoryProfile = async (profileKey: string) =>
          profileKey === fixtureValue.profile.key
            ? clone(fixtureValue.profile)
            : originalProfile?.(profileKey) ?? null;
        target.resolveVerifiedCodePublicationHandoff = async (profileKey: string) =>
          profileKey === fixtureValue.profile.key
            ? clone(fixtureValue.handoff)
            : originalHandoff?.(profileKey) ?? null;
        target.__e2eBackgroundGitHubCodeBridge = true;
      };
      installCodeFixtureBridge(code);

      const synchronizeHostOnce = async () => {
        const activeIntegrations = app.plugins.plugins?.[integrationsPluginId];
        if (!activeIntegrations) {
          throw new Error("Integrations disappeared before GitHub host synchronization.");
        }
        if (!state.hostSynchronized) {
          state.hostSyncCount += 1;
          await activeIntegrations.synchronizeBackgroundGitHubHostState({
            credential: clone(fixtureValue.credential),
            binding: clone(fixtureValue.binding),
            completionProof: "draft_pr",
            remoteBranch: {
              branch: fixtureValue.branch,
              remoteSha: fixtureValue.headSha,
              handoffFingerprint: fixtureValue.handoff.fingerprint,
              localHeadSha: fixtureValue.headSha,
              observedAt: fixtureValue.remoteBranchObservedAt,
            },
            checkpoints: clone(fixtureValue.checkpoints),
          });
          state.hostSynchronized = true;
        }
        return activeIntegrations;
      };
      await synchronizeHostOnce();

      const installIntegrationsInstrumentation = (target: any) => {
        if (!target || target.__e2eBackgroundGitHubInstrumented) return;
        const originalResolve =
          target.resolveBackgroundGitHubMissionBinding?.bind(target);
        if (originalResolve) {
          target.resolveBackgroundGitHubMissionBinding = async (input: any) => {
            state.bindingResolveCount += 1;
            return originalResolve(input);
          };
        }
        const originalSeal = target.sealBackgroundGitHubPackage?.bind(target);
        if (originalSeal) {
          target.sealBackgroundGitHubPackage = async (input: any) => {
            state.sealCount += 1;
            try {
              const result = await originalSeal(input);
              state.sealResult = clone(result);
              if (result?.status === "blocked") {
                state.sealError = `${String(result.code ?? "background_github_blocked")}: ${String(result.message ?? "Package sealing was blocked.")}`;
              }
              return result;
            } catch (error) {
              state.sealError = error instanceof Error ? error.message : String(error);
              throw error;
            }
          };
        }
        const originalApply =
          target.applyVerifiedBackgroundGitHubResult?.bind(target);
        if (originalApply) {
          target.applyVerifiedBackgroundGitHubResult = async (input: any) => {
            const before = target.readBackgroundGitHubHostState().checkpoints.revision;
            const result = await originalApply(input);
            const after = target.readBackgroundGitHubHostState().checkpoints.revision;
            if (after > before) {
              state.integrationsApplyCount += 1;
              state.reconciliationOrder.push("integrations_checkpoint");
            }
            return result;
          };
        }
        target.__e2eBackgroundGitHubInstrumented = true;
      };

      const legacyProfile = {
        schemaVersion: 1,
        key: fixtureValue.profile.key,
        displayName: fixtureValue.profile.displayName,
        repositoryRoot: fixtureValue.profile.repositoryRoot,
        defaultBranch: fixtureValue.profile.defaultBranch,
        allowedPathPrefixes: ["src"],
        validationProfile: {
          id: `validation-${fixtureValue.profile.key}`,
          bootstrapCommands: [],
          validationCommands: [
            {
              name: "test",
              executable: "node",
              args: ["--test"],
              timeoutMs: 60_000,
              allowFailure: false,
            },
          ],
          protectedPaths: [],
          allowedGeneratedPaths: [],
        },
        promotionPolicy: {
          localBasePromotion: "guarded_fast_forward",
          completionProof: "draft_pr",
          githubRepository: `${fixtureValue.binding.owner}/${fixtureValue.binding.repository}`,
          requiredChecks: ["ci"],
        },
      };

      const installCoreDependencies = (target: any) => {
        if (!target) return;
        target.repositoryProfileRegistry = {
          schemaVersion: 1,
          profiles: { [fixtureValue.profile.key]: clone(legacyProfile) },
        };
        target.synchronizeBackgroundGitHubProfile = async (profileKey: string) => {
          if (profileKey !== fixtureValue.profile.key) {
            throw new Error("Unexpected E2E GitHub profile selection.");
          }
          const bridge = await synchronizeHostOnce();
          return { bridge, handoff: clone(fixtureValue.handoff) };
        };
      };

      const installRegistryInstrumentation = (target: any) => {
        if (!target || target.__e2eBackgroundGitHubRegistryInstrumented) return;
        const originalCreate = target.createToolRegistry?.bind(target);
        if (!originalCreate) return;
        target.createToolRegistry = (...args: any[]) => {
          const registry = originalCreate(...args);
          if (registry.__e2eBackgroundGitHubInstrumented) return registry;
          registry.__e2eBackgroundGitHubInstrumented = true;
          const originalPrepare = registry.prepare.bind(registry);
          const originalExecute = registry.execute.bind(registry);
          const originalExecutePrepared = registry.executePrepared.bind(registry);
          registry.prepare = async (call: any, toolContext: any) => {
            if (call?.name === backgroundTool) {
              state.modelToolCallCount += 1;
              state.backgroundToolArguments.push(clone(call.arguments ?? {}));
            }
            return originalPrepare(call, toolContext);
          };
          registry.execute = async (call: any, toolContext: any) => {
            if (call?.name === backgroundTool) {
              state.foregroundExecuteCount += 1;
              state.providerFallbackCount += 1;
            }
            return originalExecute(call, toolContext);
          };
          registry.executePrepared = async (
            action: any,
            toolContext: any,
            authorization: any,
          ) => {
            if (action?.toolName === backgroundTool) {
              state.foregroundExecutePreparedCount += 1;
              state.providerFallbackCount += 1;
            }
            return originalExecutePrepared(action, toolContext, authorization);
          };
          return registry;
        };
        target.__e2eBackgroundGitHubRegistryInstrumented = true;
      };

      const installCheckpointInstrumentation = (target: any) => {
        const store = target?.githubPublicationCheckpointStore;
        if (!store || store.__e2eBackgroundGitHubInstrumented) return;
        const originalUpsert = store.upsert?.bind(store);
        if (!originalUpsert) return;
        store.upsert = async (checkpoint: any) => {
          const result = await originalUpsert(checkpoint);
          state.coreCheckpointUpsertCount += 1;
          state.reconciliationOrder.push("core_checkpoint");
          return result;
        };
        store.__e2eBackgroundGitHubInstrumented = true;
      };

      const recordCompletionOrder = async () => {
        const runtime = await state.readRuntime();
        const graphNode = await state.readGraphNode(runtime);
        const journal = runtime?.operationJournal?.find(
          (item: any) => item.toolName === backgroundTool,
        );
        if (graphNode?.status === "complete" && !state.graphCompletionRecorded) {
          state.graphCompletionRecorded = true;
          state.reconciliationOrder.push("graph_complete");
        }
        if (journal?.state === "committed" && !state.journalCommitRecorded) {
          state.journalCommitRecorded = true;
          state.reconciliationOrder.push("journal_committed");
        }
      };
      const installReconciliationInstrumentation = (target: any) => {
        if (!target || target.__e2eBackgroundGitHubReconcileInstrumented) return;
        const original = target.reconcileCompanionMissionGraphs?.bind(target);
        if (!original) return;
        target.reconcileCompanionMissionGraphs = async (...args: any[]) => {
          const result = await original(...args);
          await recordCompletionOrder();
          return result;
        };
        target.__e2eBackgroundGitHubReconcileInstrumented = true;
      };

      const toolCall = (args: Record<string, unknown>) => {
        const call = {
          id: `background-github-${marker}-${state.toolCallSequence}`,
          index: 0,
          name: backgroundTool,
          arguments: args,
        };
        state.toolCallSequence += 1;
        return {
          message: { role: "assistant", content: "", toolCalls: [call] },
          toolCalls: [call],
          raw: { playwrightBackgroundGitHub: true },
        };
      };
      const final = (content: string) => ({
        message: { role: "assistant", content },
        toolCalls: [],
        raw: { playwrightBackgroundGitHub: true },
      });
      const createModelClient = () => ({
        playwrightBackgroundGitHubMock: true,
        async chat(request: any) {
          if (request.format !== undefined) return final("{}");
          const tools = new Set(
            (request.tools ?? [])
              .map((tool: any) => tool.function?.name)
              .filter((name: unknown): name is string => typeof name === "string"),
          );
          if (!tools.has(backgroundTool)) {
            throw new Error("Background GitHub mission omitted its exact tool.");
          }
          if (state.modelToolCallCount > 0) {
            return final("The exact draft pull request is awaiting verified companion readback.");
          }
          return toolCall({
            profileKey: fixtureValue.profile.key,
            publicationId: fixtureValue.publicationId,
            title: fixtureValue.title,
            body: fixtureValue.body,
          });
        },
        async streamChat() {
          throw new Error("Background GitHub E2E disables model streaming.");
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
          model: "playwright-background-github",
        };
        target.saveSettings = async () => undefined;
        target.createModelClient = createModelClient;
        const prototype = Object.getPrototypeOf(target);
        if (prototype) prototype.createModelClient = createModelClient;
      };

      state.installMocks = () => {
        const activeCore = app.plugins.plugins?.[corePluginId];
        const activeCode = app.plugins.plugins?.[codePluginId];
        const activeIntegrations = app.plugins.plugins?.[integrationsPluginId];
        installCodeFixtureBridge(activeCode);
        installCoreDependencies(activeCore);
        installModel(activeCore);
        installRegistryInstrumentation(activeCore);
        installCheckpointInstrumentation(activeCore);
        installReconciliationInstrumentation(activeCore);
        installIntegrationsInstrumentation(activeIntegrations);
        for (const leaf of app.workspace.getLeavesOfType?.(
          "agentic-researcher-view",
        ) ?? []) {
          installCoreDependencies(leaf.view?.plugin);
          installModel(leaf.view?.plugin);
          installRegistryInstrumentation(leaf.view?.plugin);
        }
      };
      state.installMocks();
      await core.activateView?.();
      state.installMocks();

      const appendEvent = (
        jobId: string,
        type: string,
        payload: Record<string, unknown>,
      ) => {
        const remote = state.jobs[jobId];
        const events = state.events[jobId] ?? (state.events[jobId] = []);
        events.push({
          sequence: events.length + 1,
          jobId,
          type,
          payload,
          createdAt: new Date().toISOString(),
        });
        if (remote) remote.updatedAt = new Date().toISOString();
      };
      const receiptFingerprint = async (
        remote: any,
        status: "ambiguous" | "verified",
        payload: Record<string, unknown>,
      ) =>
        sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint:
              remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint:
              remote.payload.authorization.fingerprint,
          },
          provider: "github",
          operation:
            remote.payload.preparedBackgroundGitHubAction.operation,
          status,
          payload,
        });
      const attemptIdFor = async (jobId: string, action: any) =>
        sha256({
          version: 1,
          jobId,
          operation: action.operation,
          actionFingerprint: action.fingerprint,
          preparedActionFingerprint: action.preparedActionFingerprint,
          reconciliationKey: action.reconciliationKey,
        });
      const readPersistedPackage = (identity: any): any | null => {
        try {
          const nodeRequire = harnessWindow.require;
          if (!nodeRequire) return null;
          const fs = nodeRequire("node:fs");
          const nodePath = nodeRequire("node:path");
          const processModule = nodeRequire("node:process");
          const localAppData = processModule.env.LOCALAPPDATA;
          if (!localAppData) return null;
          const filePath = nodePath.join(
            localAppData,
            "AgenticResearcher",
            "integrations",
            "prepared-background-github-v1",
            `${identity.packageId}.json`,
          );
          const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
          return value.id === identity.packageId &&
            value.fingerprint === identity.packageFingerprint
            ? value
            : null;
        } catch {
          return null;
        }
      };
      const transitionAmbiguous = async (jobId: string) => {
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        if ((state.receipts[jobId] ?? []).some((item: any) => item.status === "ambiguous")) {
          return;
        }
        const action = remote.payload.preparedBackgroundGitHubAction;
        const identity = remote.payload.preparedBackgroundGitHubPackage;
        const attemptId = await attemptIdFor(jobId, action);
        state.attempts[jobId] = attemptId;
        const payload = {
          attemptId,
          actionFingerprint: action.fingerprint,
          packageFingerprint: identity.packageFingerprint,
        };
        const receipt = {
          id: `github-${jobId.slice(-32)}-ambiguous`,
          jobId,
          provider: "github",
          operation: action.operation,
          status: "ambiguous",
          fingerprint: await receiptFingerprint(remote, "ambiguous", payload),
          payload,
          createdAt: new Date().toISOString(),
        };
        state.receipts[jobId] = [receipt];
        appendEvent(jobId, "receipt_committed", {
          status: "ambiguous",
          fingerprint: receipt.fingerprint,
        });
      };
      const transitionComplete = async (jobId: string) => {
        await transitionAmbiguous(jobId);
        const remote = state.jobs[jobId];
        if (!remote || remote.state === "complete") return;
        const action = remote.payload.preparedBackgroundGitHubAction;
        const identity = remote.payload.preparedBackgroundGitHubPackage;
        const preparedPackage = state.packages[jobId];
        if (!preparedPackage) {
          throw new Error("The fake companion lost the persisted GitHub package readback.");
        }
        const verifiedAt = new Date().toISOString();
        const verifiedReceiptId = `github-${jobId.slice(-32)}-verified`;
        const currentCheckpoint = clone(preparedPackage.localPlan.checkpoint);
        const projectedCheckpoint = {
          ...currentCheckpoint,
          status: "draft_pr_verified",
          updatedAt: verifiedAt,
          remoteSha: action.payload.headSha,
          pullRequest: {
            number: 73,
            htmlUrl: `https://github.com/${action.binding.owner}/${action.binding.repository}/pull/73`,
            state: "open",
            draft: true,
            merged: false,
            head: {
              ref: action.payload.branch,
              sha: action.payload.headSha,
            },
            base: {
              ref: action.payload.baseBranch,
              sha: action.payload.baseSha,
            },
            updatedAt: verifiedAt,
          },
          receiptIds: currentCheckpoint.receiptIds.includes(verifiedReceiptId)
            ? currentCheckpoint.receiptIds
            : [...currentCheckpoint.receiptIds, verifiedReceiptId],
          pendingAction: null,
          blocker: null,
        };
        const verifiedEvidence = {
          version: 1,
          kind: "verified_background_github_action",
          operation: action.operation,
          publicationId: action.payload.publicationId,
          repositoryBindingFingerprint:
            action.binding.repositoryBindingFingerprint,
          verifiedAccountId: action.binding.verifiedAccountId,
          checkpointFingerprint: await sha256(projectedCheckpoint),
          headSha: action.payload.headSha,
          pullRequestNumber: 73,
          mergeSha: null,
          autoMergeEnabled: false,
          verifiedAt,
        };
        const verifiedResult = {
          ...verifiedEvidence,
          fingerprint: await sha256(verifiedEvidence),
        };
        const payload = {
          attemptId: state.attempts[jobId] ??
            (await attemptIdFor(jobId, action)),
          actionFingerprint: action.fingerprint,
          packageFingerprint: identity.packageFingerprint,
          resultFingerprint: verifiedResult.fingerprint,
          verifiedResult,
        };
        const receipt = {
          id: verifiedReceiptId,
          jobId,
          provider: "github",
          operation: action.operation,
          status: "verified",
          fingerprint: await receiptFingerprint(remote, "verified", payload),
          payload,
          createdAt: verifiedAt,
        };
        state.receipts[jobId].push(receipt);
        const completion = {
          status: "complete",
          outputs: {
            resultFingerprint: verifiedResult.fingerprint,
            githubVerifiedResult: verifiedResult,
          },
          evidence: [
            {
              kind: "github_background_readback",
              fingerprint: verifiedResult.fingerprint,
            },
          ],
          receiptIds: [receipt.id],
          blocker: null,
        };
        const resultFingerprint = await sha256({
          version: 1,
          job: {
            id: remote.id,
            missionId: remote.missionId,
            nodeId: remote.nodeId,
            idempotencyKey: remote.idempotencyKey,
            capabilityEnvelopeFingerprint:
              remote.capabilityEnvelope.fingerprint,
            authorizationFingerprint:
              remote.payload.authorization.fingerprint,
          },
          result: completion,
        });
        remote.state = "complete";
        remote.output = { ...completion, resultFingerprint };
        remote.updatedAt = verifiedAt;
        state.fullOutputs[jobId] = clone(remote.output);
        appendEvent(jobId, "receipt_committed", {
          status: "verified",
          fingerprint: receipt.fingerprint,
        });
        appendEvent(jobId, "job_completed", { status: "complete" });
      };
      const projectRemote = async (remote: any) => {
        const projected = clone(remote);
        if (
          projected?.state !== "complete" ||
          state.proofMode !== "fingerprint-only"
        ) {
          return projected;
        }
        const fullOutput = state.fullOutputs[projected.id];
        const proof = fullOutput?.outputs?.githubVerifiedResult;
        if (!proof) return projected;
        const degradedCompletion = {
          status: "complete",
          outputs: { resultFingerprint: proof.fingerprint },
          evidence: clone(fullOutput.evidence),
          receiptIds: clone(fullOutput.receiptIds),
          blocker: null,
        };
        projected.output = {
          ...degradedCompletion,
          resultFingerprint: await sha256({
            version: 1,
            job: {
              id: remote.id,
              missionId: remote.missionId,
              nodeId: remote.nodeId,
              idempotencyKey: remote.idempotencyKey,
              capabilityEnvelopeFingerprint:
                remote.capabilityEnvelope.fingerprint,
              authorizationFingerprint:
                remote.payload.authorization.fingerprint,
            },
            result: degradedCompletion,
          }),
        };
        return projected;
      };
      const jsonResponse = (value: unknown, status = 200) =>
        new Response(JSON.stringify(value), {
          status,
          headers: { "Content-Type": "application/json" },
        });
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
        latestEventSequence: 0,
      };
      const nodeCrypto = harnessWindow.require?.("node:crypto");
      const signingKey = `background-github-e2e-key-${marker}`;
      const signingKeyFingerprint = nodeCrypto
        ? `sha256:${nodeCrypto
            .createHash("sha256")
            .update(signingKey, "utf8")
            .digest("hex")}`
        : fp("2");
      state.signingKeyFingerprint = signingKeyFingerprint;
      const companionFetch = async (
        rawInput: RequestInfo | URL,
        init?: RequestInit,
      ) => {
        const url = new URL(String(rawInput));
        const method = String(init?.method ?? "GET").toUpperCase();
        state.requestLog.push({
          method,
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
            installedExecutorDomains: ["github"],
            executorCatalogVersion: 1,
            secureStorePersistent: true,
            backgroundEnabled: true,
            backgroundBlocker: null,
            version: "background-github-e2e",
          });
        }
        if (url.pathname === "/host-approval-signer" && method === "GET") {
          return jsonResponse({
            version: 1,
            kind: "host_approval_signer",
            persistent: true,
            provisioned: true,
            backend: "e2e-persistent-keyring",
            signingKeyFingerprint,
          });
        }
        if (url.pathname === "/host-approval-signer/sign" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const evidence = body.evidence;
          state.signerReceiptCount += 1;
          const authenticator = nodeCrypto
            ? nodeCrypto
                .createHmac("sha256", signingKey)
                .update(evidence.evidenceFingerprint, "ascii")
                .digest("base64url")
            : "a".repeat(43);
          const unsigned = {
            ...evidence,
            kind: "host_approval_receipt",
            signingKeyFingerprint,
            authenticator,
          };
          return jsonResponse({
            ...unsigned,
            fingerprint: await sha256(unsigned),
          });
        }
        if (url.pathname === "/host-approval-signer/verify" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          const receipt = body.receipt;
          const expectedAuthenticator = nodeCrypto
            ? nodeCrypto
                .createHmac("sha256", signingKey)
                .update(receipt.evidenceFingerprint, "ascii")
                .digest("base64url")
            : "a".repeat(43);
          const verified =
            receipt.signingKeyFingerprint === signingKeyFingerprint &&
            receipt.authenticator === expectedAuthenticator &&
            receipt.decision === "approved";
          return jsonResponse({
            version: 1,
            verified,
            reason: verified ? "verified" : "authenticator_mismatch",
            signingKeyFingerprint,
          });
        }
        if (
          url.pathname === "/linear-queue/configuration" &&
          method === "DELETE"
        ) {
          return jsonResponse(disabledLinearQueueStatus);
        }
        if (url.pathname === "/linear-queue/status") {
          return jsonResponse(disabledLinearQueueStatus);
        }
        if (url.pathname === "/linear-queue/events") {
          return jsonResponse({ events: [] });
        }
        if (url.pathname === "/jobs" && method === "POST") {
          const body = JSON.parse(String(init?.body ?? "{}"));
          state.postCount += 1;
          state.submitCount += 1;
          const runtime = await findRuntimeByJobId(body.id);
          const journal = runtime?.operationJournal?.find(
            (record: any) =>
              record.backgroundGitHubDispatchAttempt?.jobId === body.id,
          );
          const action = body.payload.preparedBackgroundGitHubAction;
          const identity = body.payload.preparedBackgroundGitHubPackage;
          const preparedPackage = readPersistedPackage(identity);
          const approvalReceipts = action?.authority?.confirmationReceipts ?? [];
          state.walPresentBeforePost = Boolean(journal);
          state.packageIdentityPresentBeforePost = Boolean(
            journal?.preparedBackgroundGitHubPackage?.fingerprint ===
              identity?.fingerprint &&
              journal?.preparedBackgroundGitHubAction?.fingerprint ===
                action?.fingerprint,
          );
          state.packageReadbackVerifiedBeforePost = Boolean(
            preparedPackage &&
              preparedPackage.jobId === body.id &&
              preparedPackage.actionFingerprint === action?.fingerprint &&
              preparedPackage.backgroundAuthorizationFingerprint ===
                body.payload.authorization?.fingerprint,
          );
          state.signerReceiptPresentBeforePost = Boolean(
            approvalReceipts.length === 1 &&
              approvalReceipts[0]?.decision === "approved" &&
              approvalReceipts[0]?.signingKeyFingerprint ===
                signingKeyFingerprint,
          );
          state.actionSignerReceiptCount = approvalReceipts.length;
          if (state.jobs[body.id]) {
            return jsonResponse(await projectRemote(state.jobs[body.id]));
          }
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
            ownerCoordinatorId: "background-github-e2e-worker",
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            attempts: 1,
            createdAt: now,
            updatedAt: now,
          };
          state.jobs[body.id] = remote;
          state.packages[body.id] = preparedPackage;
          state.receipts[body.id] = [];
          state.events[body.id] = [];
          appendEvent(body.id, "job_accepted", {});
          appendEvent(body.id, "job_started", {});
          setTimeout(() => void transitionAmbiguous(body.id), 500);
          setTimeout(() => void transitionComplete(body.id), 1_500);
          return jsonResponse(remote);
        }
        if (url.pathname === "/jobs" && method === "GET") {
          return jsonResponse({
            jobs: await Promise.all(
              Object.values(state.jobs).map((job) => projectRemote(job)),
            ),
          });
        }
        const segments = url.pathname.split("/").filter(Boolean);
        if (segments[0] !== "jobs") {
          return jsonResponse({ detail: "unsupported" }, 404);
        }
        const jobId = decodeURIComponent(segments[1] ?? "");
        const remote = state.jobs[jobId];
        if (!remote) return jsonResponse({ detail: "not found" }, 404);
        if (segments.length === 2) {
          return jsonResponse(await projectRemote(remote));
        }
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

      // Keep page-owned transport state alive across core and Integrations
      // reloads while the fake companion independently completes its job.
      harnessWindow.__e2eBackgroundGitHub = state;
      await companion.pairForegroundCompanion({
        baseUrl: "http://127.0.0.1:18789",
        acquireBootstrapToken: async () =>
          "background-github-companion-bootstrap-token-0123456789abcdef",
        fetchImpl: companionFetch,
      });
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      codePluginId: CODE_PLUGIN_ID,
      integrationsPluginId: INTEGRATIONS_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
      backgroundTool: BACKGROUND_TOOL,
      marker: context.marker,
      notePath: context.notePath,
      fixtureValue: fixture,
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

function activeApproval(page: Page): Locator {
  return page
    .locator(".agentic-researcher-approval-card", { hasText: BACKGROUND_TOOL })
    .filter({
      has: page.locator("button.agentic-researcher-approval-approve:enabled"),
    })
    .last();
}

async function approve(approval: Locator): Promise<void> {
  await approval
    .locator("button.agentic-researcher-approval-approve:enabled")
    .click();
  await expect(approval).toHaveCount(0, { timeout: 15_000 });
}

async function waitForRemoteSubmission(page: Page): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await readSnapshot(page, "");
        if (
          snapshot.foregroundExecuteCount > 0 ||
          snapshot.foregroundExecutePreparedCount > 0 ||
          snapshot.providerFallbackCount > 0
        ) {
          throw new Error(
            `Forbidden foreground GitHub execution observed: ${JSON.stringify(snapshot)}`,
          );
        }
        if (snapshot.sealError || snapshot.sealResultStatus === "blocked") {
          throw new Error(
            `Background GitHub package sealing failed: ${JSON.stringify(snapshot)}`,
          );
        }
        return {
          postCount: snapshot.postCount,
          submitCount: snapshot.submitCount,
          sealCount: snapshot.sealCount,
          sealResultStatus: snapshot.sealResultStatus,
        };
      },
      {
        timeout: 60_000,
        message: "the exact GitHub package should be sealed and POST once",
      },
    )
    .toEqual({
      postCount: 1,
      submitCount: 1,
      sealCount: 1,
      sealResultStatus: "ready",
    });
}

async function disconnectAndRestartCoreIntegrations(page: Page): Promise<void> {
  await page.evaluate(
    async ({ corePluginId, integrationsPluginId, companionPluginId }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        __e2eBackgroundGitHub?: any;
      };
      const app = harnessWindow.app;
      const state = harnessWindow.__e2eBackgroundGitHub;
      app?.plugins?.plugins?.[companionPluginId]?.companionCoordinator?.clearSession?.();
      await app.plugins.disablePlugin(integrationsPluginId);
      await app.plugins.disablePlugin(corePluginId);
      await app.plugins.enablePlugin(corePluginId);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        if (
          app.plugins.plugins?.[corePluginId]?.agenticResearcherApi?.state ===
          "ready"
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      state?.installMocks?.();
      await app.plugins.plugins?.[corePluginId]?.activateView?.();
      state?.installMocks?.();
      await app.plugins.enablePlugin(integrationsPluginId);
      for (let attempt = 0; attempt < 240; attempt += 1) {
        const activeCore = app.plugins.plugins?.[corePluginId];
        if (
          app.plugins.plugins?.[integrationsPluginId] &&
          activeCore?.agenticResearcherApi
            ?.getRegisteredExtensionIds?.()
            ?.includes(integrationsPluginId)
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      state?.installMocks?.();
    },
    {
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      integrationsPluginId: INTEGRATIONS_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
    },
  );
  await expect(page.locator(".agentic-researcher-view")).toHaveCount(1, {
    timeout: 30_000,
  });
}

async function readRemoteState(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const state = (
      window as typeof window & { __e2eBackgroundGitHub?: any }
    ).__e2eBackgroundGitHub;
    const jobId = Object.keys(state?.jobs ?? {})[0];
    return jobId ? String(state.jobs[jobId]?.state ?? "") : null;
  });
}

async function setProofMode(
  page: Page,
  mode: "full" | "fingerprint-only",
): Promise<void> {
  await page.evaluate((nextMode) => {
    const state = (
      window as typeof window & { __e2eBackgroundGitHub?: any }
    ).__e2eBackgroundGitHub;
    if (!state) throw new Error("Background GitHub fixture is unavailable.");
    state.proofMode = nextMode;
  }, mode);
}

async function reconnectCompanion(page: Page): Promise<void> {
  await page.evaluate(async ({ companionPluginId }) => {
    const harnessWindow = window as typeof window & {
      app?: any;
      __e2eBackgroundGitHub?: any;
    };
    const companion = harnessWindow.app?.plugins?.plugins?.[companionPluginId];
    const state = harnessWindow.__e2eBackgroundGitHub;
    if (!companion?.pairForegroundCompanion || !state?.fetchImpl) {
      throw new Error("Companion reconnect fixture is unavailable.");
    }
    await companion.pairForegroundCompanion({
      baseUrl: "http://127.0.0.1:18789",
      acquireBootstrapToken: async () =>
        "background-github-companion-bootstrap-token-0123456789abcdef",
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
  }, { corePluginId: NATIVE_CORE_PLUGIN_ID });
}

async function readSnapshot(
  page: Page,
  publicationId: string,
): Promise<BackgroundGitHubCompanionSnapshot> {
  return page.evaluate(
    async ({
      publicationId: expectedPublicationId,
      corePluginId,
      integrationsPluginId,
      companionPluginId,
      backgroundTool,
    }) => {
      const harnessWindow = window as typeof window & {
        app?: any;
        __e2eBackgroundGitHub?: any;
      };
      const app = harnessWindow.app;
      const state = (
        window as typeof window & { __e2eBackgroundGitHub?: any }
      ).__e2eBackgroundGitHub ?? {};
      const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value));
      const jobId = Object.keys(state.jobs ?? {})[0] ?? "";
      const remote = jobId ? state.jobs[jobId] ?? null : null;
      const receipts = jobId ? state.receipts?.[jobId] ?? [] : [];
      const verifiedReceipt = receipts.find(
        (item: any) => item.status === "verified",
      );
      const fullOutput = jobId ? state.fullOutputs?.[jobId] ?? null : null;
      const visibleOutput = state.proofMode === "full" ? fullOutput : null;
      const outputProof = visibleOutput?.outputs?.githubVerifiedResult ?? null;
      const receiptProof = verifiedReceipt?.payload?.verifiedResult ?? null;
      const runtime = await state.readRuntime?.();
      const journal = runtime?.operationJournal?.find(
        (record: any) => record.toolName === backgroundTool,
      );
      const graphNode = await state.readGraphNode?.(runtime);
      const integrations = app?.plugins?.plugins?.[integrationsPluginId];
      const integrationsState = integrations?.readBackgroundGitHubHostState?.();
      const resolvedPublicationId =
        expectedPublicationId || state.fixture?.publicationId || "";
      const integrationsCheckpoint = resolvedPublicationId
        ? integrationsState?.checkpoints?.checkpoints?.[resolvedPublicationId] ?? null
        : null;
      const core = app?.plugins?.plugins?.[corePluginId];
      const coreCheckpoint = resolvedPublicationId
        ? await core?.githubPublicationCheckpointStore
            ?.get?.(resolvedPublicationId)
            .catch(() => null)
        : null;
      const lineage = jobId
        ? app?.plugins?.plugins?.[companionPluginId]?.companionCoordinator
            ?.getRuntimeState?.()?.jobs?.[jobId] ?? null
        : null;
      return {
        modelToolCallCount: Number(state.modelToolCallCount ?? 0),
        backgroundToolArguments: copy(state.backgroundToolArguments ?? []),
        signerReceiptCount: Number(state.signerReceiptCount ?? 0),
        actionSignerReceiptCount: Number(state.actionSignerReceiptCount ?? 0),
        hostSyncCount: Number(state.hostSyncCount ?? 0),
        bindingResolveCount: Number(state.bindingResolveCount ?? 0),
        sealCount: Number(state.sealCount ?? 0),
        sealResultStatus: state.sealResult?.status ?? null,
        sealError: state.sealError ?? null,
        submitCount: Number(state.submitCount ?? 0),
        postCount: Number(state.postCount ?? 0),
        foregroundExecuteCount: Number(state.foregroundExecuteCount ?? 0),
        foregroundExecutePreparedCount: Number(state.foregroundExecutePreparedCount ?? 0),
        providerFallbackCount: Number(state.providerFallbackCount ?? 0),
        walPresentBeforePost: state.walPresentBeforePost === true,
        packageIdentityPresentBeforePost: state.packageIdentityPresentBeforePost === true,
        packageReadbackVerifiedBeforePost: state.packageReadbackVerifiedBeforePost === true,
        signerReceiptPresentBeforePost: state.signerReceiptPresentBeforePost === true,
        remoteState: remote?.state ?? null,
        remoteOutputHasFullProof: Boolean(
          outputProof?.kind === "verified_background_github_action" &&
            outputProof?.fingerprint ===
              visibleOutput?.outputs?.resultFingerprint,
        ),
        receiptHasFullProof: Boolean(
          receiptProof?.kind === "verified_background_github_action" &&
            receiptProof?.fingerprint ===
              verifiedReceipt?.payload?.resultFingerprint,
        ),
        outputReceiptProofMatch: Boolean(
          outputProof &&
            receiptProof &&
            outputProof.fingerprint === receiptProof.fingerprint &&
            JSON.stringify(outputProof) === JSON.stringify(receiptProof),
        ),
        receiptStatuses: receipts.map((item: any) => String(item.status)),
        runtimeJournalState: journal?.state ?? null,
        backgroundAttemptStatus:
          journal?.backgroundGitHubDispatchAttempt?.status ?? null,
        graphNodeStatus: graphNode?.status ?? null,
        graphNodeAllowedTools: copy(graphNode?.allowedTools ?? []),
        graphNodeExecutionHost: graphNode?.executionHost ?? null,
        graphNodeEffect: graphNode?.effect ?? null,
        graphReceiptKinds: (graphNode?.receipts ?? []).map((item: any) =>
          String(item?.kind ?? item?.provider ?? item?.status ?? ""),
        ),
        graphEvidenceKinds: (graphNode?.evidence ?? []).map((item: any) =>
          String(item?.kind ?? item?.status ?? ""),
        ),
        graphVerifierId:
          graphNode?.completionContract?.verifierId ??
          graphNode?.verification?.verifierId ??
          null,
        graphCompletionTransitionCount:
          (graphNode?.transitions ?? []).filter(
            (item: any) =>
              item?.status === "complete" || item?.state === "complete",
          ).length || (graphNode?.status === "complete" ? 1 : 0),
        integrationsCheckpointStatus: integrationsCheckpoint?.status ?? null,
        integrationsCheckpointReceiptIds: copy(
          integrationsCheckpoint?.receiptIds ?? [],
        ),
        integrationsCheckpointRevision:
          typeof integrationsState?.checkpoints?.revision === "number"
            ? integrationsState.checkpoints.revision
            : null,
        coreCheckpointStatus: coreCheckpoint?.status ?? null,
        integrationsApplyCount: Number(state.integrationsApplyCount ?? 0),
        coreCheckpointUpsertCount: Number(state.coreCheckpointUpsertCount ?? 0),
        reconciliationOrder: copy(state.reconciliationOrder ?? []),
        lineageState: lineage?.state ?? null,
        lineageReconcileStatus: lineage?.reconcileStatus ?? null,
        proofMode: state.proofMode === "fingerprint-only" ? "fingerprint-only" : "full",
      };
    },
    {
      publicationId,
      corePluginId: NATIVE_CORE_PLUGIN_ID,
      integrationsPluginId: INTEGRATIONS_PLUGIN_ID,
      companionPluginId: COMPANION_PLUGIN_ID,
      backgroundTool: BACKGROUND_TOOL,
    },
  );
}

async function snapshotBackgroundGitHubStores(): Promise<DirectoryBaseline[]> {
  if (!process.env.LOCALAPPDATA) return [];
  const directory = path.join(
    process.env.LOCALAPPDATA,
    "AgenticResearcher",
    "integrations",
    "prepared-background-github-v1",
  );
  const stat = await lstat(directory).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
  if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
    throw new Error(`Background GitHub store is unsafe: ${directory}`);
  }
  return [{
    root: stat ? await realpath(directory) : directory,
    existingNames: new Set(
      stat
        ? (await readdir(directory, { withFileTypes: true })).map((entry) => entry.name)
        : [],
    ),
  }];
}

async function restoreBackgroundGitHubStores(
  baselines: DirectoryBaseline[],
): Promise<void> {
  for (const baseline of baselines) {
    const stat = await lstat(baseline.root).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? null : Promise.reject(error),
    );
    if (!stat) continue;
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`Background GitHub cleanup root is unsafe: ${baseline.root}`);
    }
    const canonicalRoot = await realpath(baseline.root);
    for (const entry of await readdir(canonicalRoot, { withFileTypes: true })) {
      if (baseline.existingNames.has(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile() || !/^[A-Za-z0-9._:-]+\.json$/u.test(entry.name)) {
        throw new Error(`Refusing to remove unexpected Background GitHub store entry ${entry.name}.`);
      }
      const candidate = path.join(canonicalRoot, entry.name);
      const canonicalCandidate = await realpath(candidate);
      if (path.dirname(canonicalCandidate) !== canonicalRoot) {
        throw new Error("Background GitHub store entry escaped cleanup root.");
      }
      await rm(canonicalCandidate, { force: true });
    }
  }
}
