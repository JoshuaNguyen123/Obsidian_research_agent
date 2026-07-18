import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { Plugin } from "obsidian";
import type {
  ExtensionContributionV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
  SettingsContributionV1,
  StatusContributionV1,
} from "@agentic-researcher/core-api";
import {
  createPreparedBackgroundCodeActionV1,
  createVerifiedCodePublicationHandoffV1,
  type ConsumedBackgroundCodeGrantV1,
  type VerifiedCodePublicationHandoffV1,
} from "@agentic-researcher/core-api";
import {
  canonicalJson,
  prepareBackgroundCodeCompanionJobIdentityV1,
  sha256Fingerprint,
  type BackgroundAuthorizationV1,
  type MissionGraphV3,
} from "@agentic-researcher/headless-runtime";

import {
  parseRepositoryProfileRegistry,
} from "../../src/agent/repositories/RepositoryProfile";
import { withPluginDataLock } from "../shared/softDependency";
import {
  CODE_EXECUTION_TOOL_NAMES_V2,
  CodeSandboxContributionErrorV2,
  SandboxManagerV2,
  SpawnSandboxCommandRunnerV2,
  createCodeExecutionContributionsV2,
  parseSandboxProviderConfigV2,
  type PreparedSandboxActionV2,
  type SandboxCapabilityStatusV2,
  type SandboxCommandRunnerV2,
  type SandboxArtifactImporterV2,
  type SandboxProviderConfigV2,
  type SandboxStagedFileBytesV2,
} from "./sandbox";
import {
  detectRepositoryProfileV2,
  migrateRepositoryProfileV1,
  parseRepositoryProfileV2,
  type RepositoryProfileV2,
  type RepositoryValidationCommandV2,
} from "./repositories";
import {
  CODE_WORKSPACE_TOOL_NAMES_V2,
  LocalGitWorkspaceProvisionerV2,
  createCodeWorkspaceToolContributionsV2,
  type RepositoryInspectionV2,
  type RepositoryWorktreeProvisionV2,
  type WorkspaceRepositoryProvisionerV2,
} from "./workspaceTools";
import {
  WorkspaceManagerErrorV2,
  WorkspaceManagerV2,
  assertWorkspaceRelativePathV2,
  createVerifiedWorkspaceBaseReadbackV2,
} from "./workspaces";
import {
  DurableValidationReceiptRegistryV1,
  CallbackCodeRepairCheckpointStoreV1,
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  SpawnFixedArgvGitRunnerV1,
  createCodeRepairToolContributionsV1,
  createCodeRepairToolRuntimeV1,
  createFixedArgvVerifiedCommitGatewayV1,
  normalizeCodeRepairRequestV1,
  parseCodeRepairCheckpointV1,
  type CallbackCheckpointPersistenceV1,
  type CodeRepairCheckpointNamespaceV1,
  type DurableValidationReceiptNamespaceV1,
  type ValidationReceiptPersistenceV1,
  type CodeRepairRequestV1,
  type CodeRepairCheckpointV1,
} from "./repair";
import {
  PREPARED_BACKGROUND_CODE_TOOL_DESCRIPTOR_V1,
  PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
  PreparedBackgroundCodeHostV1,
  PreparedBackgroundCodeResolverV1,
  createPreparedBackgroundCodeToolContributionV1,
  type PrepareBackgroundValidationCommitApprovalInputV1,
  type PrepareBackgroundValidationCommitApprovalResultV1,
  type SealBackgroundValidationCommitPackageInputV1,
  type SealBackgroundValidationCommitPackageResultV1,
} from "./background";
import { classifyProtectedControlChanges } from "./repair/protectedControls";

export const CODE_RUNTIME_STATE_VERSION_V2 = 2 as const;
export const CODE_EXTENSION_VERSION_V2 = "0.2.0" as const;

const EXTENSION_ID = "agentic-researcher-code";
const MAX_PROFILE_INVENTORY_ENTRIES = 20_000;
const MAX_PROFILE_INVENTORY_DEPTH = 32;
const MAX_PIN_BYTES = 64 * 1024;
const IGNORED_INVENTORY_DIRECTORIES = new Set([
  ".git",
  ".agent-backups",
  ".cache",
  ".gradle",
  ".idea",
  ".next",
  ".pytest_cache",
  ".venv",
  ".vscode",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "target",
  "vendor",
]);
const PIN_BASENAMES = new Set([
  ".node-version",
  ".nvmrc",
  ".python-version",
  "global.json",
  "gradlew",
  "mvnw",
  "runtime.txt",
]);

export type CodeRepositoryProfileSourceV2 =
  | "migrated_repository_profile_v1"
  | "detected_raw_exact_approval";

export interface CodeRepositoryProfileRecordV2 {
  version: 2;
  source: CodeRepositoryProfileSourceV2;
  sourceFingerprint: string;
  trustedAt: string;
  profile: RepositoryProfileV2;
}

export interface CodeRuntimeMigrationV2 {
  version: 1;
  migrationId: string;
  snapshotHash: string;
  migratedProfileKeys: string[];
  verifiedAt: string;
}

export interface PersistedSandboxProbeV2 {
  version: 1;
  observedAt: string;
  status: SandboxCapabilityStatusV2;
}

export interface CodeRuntimeStateV2 {
  version: typeof CODE_RUNTIME_STATE_VERSION_V2;
  repositoryProfiles: Record<string, CodeRepositoryProfileRecordV2>;
  migration: CodeRuntimeMigrationV2 | null;
  sandbox: {
    providerConfigs: SandboxProviderConfigV2[];
    lastProbe: PersistedSandboxProbeV2 | null;
  };
  repair: {
    mode: "degraded_not_wired" | "production_wired";
    blockerCode: "repair_handlers_not_production_wired" | null;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface CodeExtensionRuntimeOptionsV2 {
  plugin: Plugin;
  workspaceManager?: WorkspaceManagerV2;
  sandboxManager?: SandboxManagerV2;
  /** Test/host adapter for the fixed provider catalog; never runs repository commands directly. */
  sandboxRunner?: SandboxCommandRunnerV2;
  /**
   * Optional production repair tools assembled from narrow, verified adapters.
   * Omission is an explicit degraded capability, never a simulated commit path.
   */
  repairContributions?: readonly ExtensionContributionV1[];
  now?: () => Date;
}

export interface CodeReviewRepairBaseResolutionInputV1 {
  profileKey: string;
  workspaceId: string;
  branch: string;
  runId: string;
  requestId: string;
  expectedFingerprint: string;
  signal?: AbortSignal;
}

export interface CodeReviewRepairPipelineInputV1 {
  repairRequestId: string;
  runId: string;
  profileKey: string;
  workspaceId: string;
  branch: string;
  expectedBaseSha: string;
  baseRequestId: string;
  baseHandoffFingerprint: string;
  objective: string;
  reviewEvidenceFingerprint: string;
  maxCycles: 3;
  signal?: AbortSignal;
}

interface PersistedExtensionMigrationV1 {
  migrationId: string;
  snapshotHash: string;
  repositoryProfiles: ReturnType<typeof parseRepositoryProfileRegistry>;
}

interface RepositoryInventoryV2 {
  files: string[];
  fileContents: Record<string, string>;
  fileHashes: Record<string, string>;
  fingerprint: string;
}

/**
 * Production owner for the built-in Code capability. It owns no model, vault,
 * or credential handle. Every filesystem mutation remains workspace-scoped,
 * and every generated-code process remains behind SandboxManagerV2.
 */
export class CodeExtensionRuntimeV2 {
  readonly workspaceManager: WorkspaceManagerV2;

  private readonly plugin: Plugin;
  private readonly now: () => Date;
  private readonly injectedSandboxManager: SandboxManagerV2 | null;
  private readonly sandboxRunner: SandboxCommandRunnerV2;
  private repairContributions: ExtensionContributionV1[];
  private validationReceiptRegistry: DurableValidationReceiptRegistryV1 | null = null;
  private repairGit: SpawnFixedArgvGitRunnerV1 | null = null;
  private sandboxManager: SandboxManagerV2 | null = null;
  private state: CodeRuntimeStateV2 | null = null;
  private repositoryProvisioner: ProfileAwareRepositoryProvisionerV2 | null = null;
  private initialized = false;
  private refreshQueue: Promise<void> = Promise.resolve();

  constructor(options: CodeExtensionRuntimeOptionsV2) {
    if (options.sandboxManager && options.sandboxRunner) {
      throw new Error("Inject either a sandbox manager or a fixed sandbox runner, not both.");
    }
    this.plugin = options.plugin;
    this.workspaceManager = options.workspaceManager ?? new WorkspaceManagerV2();
    this.injectedSandboxManager = options.sandboxManager ?? null;
    this.sandboxRunner = options.sandboxRunner ?? new SpawnSandboxCommandRunnerV2();
    this.repairContributions = [...(options.repairContributions ?? [])];
    this.now = options.now ?? (() => new Date());
  }

  async initialize(): Promise<void> {
    await this.serializedRefresh(async () => {
      const loaded = await withPluginDataLock(this.plugin, async () => {
        const topLevel = topLevelRecord(await this.plugin.loadData());
        assertTopLevelSchema(topLevel);
        const current = topLevel.codeRuntimeState === undefined
          ? createInitialCodeRuntimeStateV2(this.isoNow())
          : parseCodeRuntimeStateV2(topLevel.codeRuntimeState);
        const migration = parsePersistedExtensionMigration(topLevel.extensionStateMigration);
        const migrated = applyLegacyProfileMigration(current, migration, this.isoNow());
        if (topLevel.codeRuntimeState === undefined || migrated.changed) {
          await this.plugin.saveData({
            ...topLevel,
            schemaVersion: 1,
            codeRuntimeState: migrated.state,
          });
          const readback = topLevelRecord(await this.plugin.loadData());
          assertPreservedMigration(topLevel, readback);
          return parseCodeRuntimeStateV2(readback.codeRuntimeState);
        }
        return migrated.state;
      });
      this.state = loaded;
    });

    this.sandboxManager = this.injectedSandboxManager ?? this.createConfiguredSandboxManager();
    this.repositoryProvisioner = new ProfileAwareRepositoryProvisionerV2(
      this,
      new LocalGitWorkspaceProvisionerV2(this.workspaceManager),
    );
    if (this.repairContributions.length === 0) {
      await this.initializeProductionRepairAdapters();
    }
    this.initialized = true;
  }

  getContributions(): ExtensionContributionV1[] {
    this.assertInitialized();
    const sandboxManager = this.requireSandboxManager();
    const workspace = createCodeWorkspaceToolContributionsV2({
      manager: this.workspaceManager,
      repositoryProvisioner: this.repositoryProvisioner!,
      isForegroundUserMission: (repositoryRoot, context) =>
        Boolean(
          context.originalPrompt &&
          context.originalPrompt.includes(repositoryRoot) &&
          context.missionId &&
          /^run-/u.test(context.missionId),
        ),
    });
    const execution = createCodeExecutionContributionsV2({
      sandboxManager,
      getProfile: (profileKey) => this.getRepositoryProfile(profileKey),
      resolvePreparationInput: ({ purpose, workspaceId }) =>
        this.resolveSandboxPreparationInput(purpose, workspaceId),
      resolveExecutionInput: (_action, sandboxAction, context) =>
        this.resolveSandboxExecutionInput(sandboxAction, context),
      observeValidationReceipt: this.validationReceiptRegistry
        ? async ({ runId, requestId, action, receipt, diagnostics, context }) => {
            const manifest = await this.workspaceManager.loadManifest(action.workspaceId);
            return await this.validationReceiptRegistry!.capture({
              scope: {
                runId: context.rootMissionId?.trim() || runId,
                workspaceId: action.workspaceId,
                requestId,
              },
              action,
              receipt,
              diagnostics,
              validatedWorkspaceManifestFingerprint: manifest.hashes.indexFingerprint,
              workspaceChangedPaths: manifest.budget.changedPaths,
            }) as unknown as import("@agentic-researcher/core-api").JsonValueV1;
          }
        : undefined,
    });
    const contributions: ExtensionContributionV1[] = [
      ...workspace,
      ...execution,
      createPreparedBackgroundCodeToolContributionV1({
        prepareBackgroundValidationCommitApproval: (input) =>
          this.prepareBackgroundValidationCommitApproval(input),
      }),
      this.createRuntimeStatusContribution(),
      this.createSettingsContribution(),
      ...(this.repairContributions.length > 0
        ? this.repairContributions
        : [this.createRepairDegradedStatusContribution()]),
    ];
    assertRequiredCodeContributions(contributions);
    return contributions;
  }

  async refreshMigratedProfiles(): Promise<void> {
    this.assertInitialized();
    await this.serializedRefresh(async () => {
      this.state = await withPluginDataLock(this.plugin, async () => {
        const topLevel = topLevelRecord(await this.plugin.loadData());
        assertTopLevelSchema(topLevel);
        const current = topLevel.codeRuntimeState === undefined
          ? createInitialCodeRuntimeStateV2(this.isoNow())
          : parseCodeRuntimeStateV2(topLevel.codeRuntimeState);
        const migration = parsePersistedExtensionMigration(topLevel.extensionStateMigration);
        const migrated = applyLegacyProfileMigration(current, migration, this.isoNow());
        if (!migrated.changed && topLevel.codeRuntimeState !== undefined) {
          return migrated.state;
        }
        await this.plugin.saveData({
          ...topLevel,
          schemaVersion: 1,
          codeRuntimeState: migrated.state,
        });
        const readback = topLevelRecord(await this.plugin.loadData());
        assertPreservedMigration(topLevel, readback);
        return parseCodeRuntimeStateV2(readback.codeRuntimeState);
      });
    });
  }

  async getRepositoryProfile(profileKey: string): Promise<RepositoryProfileV2 | null> {
    await this.refreshMigratedProfiles();
    const key = boundedIdentifier(profileKey, "repository profile key");
    return this.requireState().repositoryProfiles[key]?.profile ?? null;
  }

  async redetectRepositoryProfile(input: {
    profileKey: string;
    workspaceId: string;
    context: ScopedExtensionContextV1;
  }): Promise<void> {
    this.assertInitialized();
    if (!input.context.authorizedAction) {
      throw new WorkspaceManagerErrorV2("repository_profile_authority_missing", "Protected-control re-detection requires the exact authorized workspace action.");
    }
    const key = boundedIdentifier(input.profileKey, "repository profile key");
    const existing = await this.getRepositoryProfile(key);
    if (!existing) throw new WorkspaceManagerErrorV2("repository_profile_unavailable", `Repository profile ${key} is unavailable.`);
    const manifest = await this.workspaceManager.loadManifest(input.workspaceId);
    if (manifest.kind !== "repository" || manifest.repositoryBinding?.profileKey !== key) {
      throw new WorkspaceManagerErrorV2("repository_profile_binding_conflict", "Protected-control re-detection escaped its trusted repository workspace.");
    }
    const inventory = await inventoryRepository(manifest.canonicalRoot);
    const detected = detectRepositoryProfileV2({
      key,
      displayName: existing.displayName,
      repositoryRoot: existing.repositoryRoot,
      defaultBranch: existing.defaultBranch,
      files: inventory.files,
      fileContents: inventory.fileContents,
      fileHashes: inventory.fileHashes,
      allowedPaths: existing.allowedPaths,
      generatedOutputs: existing.generatedOutputs,
      requiredGitHubChecks: existing.requiredGitHubChecks,
      runtimeDigests: Object.fromEntries(existing.pinnedRuntimes
        .filter((runtime) => runtime.digest)
        .map((runtime) => [runtime.ecosystem, runtime.digest!])),
    });
    await this.serializedRefresh(async () => {
      const current = this.requireState();
      const prior = current.repositoryProfiles[key];
      if (!prior) throw new WorkspaceManagerErrorV2("repository_profile_unavailable", `Repository profile ${key} disappeared during re-detection.`);
      const record: CodeRepositoryProfileRecordV2 = {
        ...prior,
        sourceFingerprint: sha256Canonical({
          repositoryRoot: existing.repositoryRoot,
          inventoryFingerprint: inventory.fingerprint,
          profile: detected,
        }),
        profile: detected,
      };
      const next = parseCodeRuntimeStateV2({
        ...current,
        repositoryProfiles: { ...current.repositoryProfiles, [key]: record },
        updatedAt: this.isoNow(),
      });
      this.state = await this.persistState(next);
    });
  }

  async persistDetectedRepositoryProfile(input: {
    profileKey: string;
    inspection: RepositoryInspectionV2;
    context: ScopedExtensionContextV1;
  }): Promise<RepositoryProfileV2> {
    this.assertInitialized();
    if (!input.context.authorizedAction) {
      throw new WorkspaceManagerErrorV2(
        "repository_profile_authority_missing",
        "Raw repository profile detection requires the exact authorized worktree action.",
      );
    }
    const key = boundedIdentifier(input.profileKey, "repository profile key");
    const root = await canonicalSafeDirectory(input.inspection.repositoryRoot);
    const existing = await this.getRepositoryProfile(key);
    if (existing) {
      if (!samePath(existing.repositoryRoot, root)) {
        throw new WorkspaceManagerErrorV2(
          "repository_profile_binding_conflict",
          `Repository profile ${key} is already bound to another canonical root.`,
        );
      }
      return existing;
    }
    const inventory = await inventoryRepository(root);
    const profile = detectRepositoryProfileV2({
      key,
      displayName: path.basename(root) || key,
      repositoryRoot: root,
      defaultBranch: input.inspection.branch,
      files: inventory.files,
      fileContents: inventory.fileContents,
      fileHashes: inventory.fileHashes,
    });
    const record: CodeRepositoryProfileRecordV2 = {
      version: 2,
      source: "detected_raw_exact_approval",
      sourceFingerprint: sha256Canonical({
        repositoryRoot: root,
        baseSha: input.inspection.baseSha,
        inventoryFingerprint: inventory.fingerprint,
        profile,
      }),
      trustedAt: this.isoNow(),
      profile,
    };
    await this.persistProfileRecord(record);
    return profile;
  }

  async resolveSandboxExecutionInput(
    sandboxAction: PreparedSandboxActionV2,
    _context: ScopedExtensionContextV1,
  ): Promise<{
    stagedFiles: readonly SandboxStagedFileBytesV2[];
    artifactImporter?: SandboxArtifactImporterV2;
  }> {
    this.assertInitialized();
    const profile = await this.getRepositoryProfile(sandboxAction.profileKey);
    if (!profile) {
      throw new CodeSandboxContributionErrorV2(
        "repository_profile_missing",
        "Sandbox staging requires a trusted RepositoryProfileV2.",
      );
    }
    const manifest = await this.workspaceManager.loadManifest(sandboxAction.workspaceId);
    if (
      manifest.kind !== "repository" ||
      manifest.repositoryBinding?.profileKey !== profile.key ||
      !samePath(manifest.repositoryBinding.repositoryRoot, profile.repositoryRoot)
    ) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_workspace_binding_mismatch",
        "Sandbox staging requires the exact trusted repository-worktree binding.",
      );
    }
    if (manifest.hashes.indexFingerprint !== sandboxAction.workspaceManifestFingerprint) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_workspace_manifest_drift",
        "Workspace hash index changed after sandbox preparation.",
      );
    }
    const project = profile.projects.find((candidate) => candidate.id === sandboxAction.projectId);
    if (!project) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_project_binding_mismatch",
        "Sandbox staging references an unknown trusted repository project.",
      );
    }
    const stagedFiles: SandboxStagedFileBytesV2[] = [];
    for (const entry of sandboxAction.stagingManifest) {
      const relativePath = assertWorkspaceRelativePathV2(entry.path);
      if (
        !project.allowedPaths.some((allowed) => pathAtOrBelow(allowed, relativePath)) &&
        !profile.protectedControls.some((control) => pathAtOrBelow(control.path, relativePath))
      ) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_staging_scope_rejected",
          `Sandbox staging path is outside the trusted project scope: ${relativePath}.`,
        );
      }
      const tracked = manifest.hashes.files[relativePath];
      const readback = await this.workspaceManager.read(manifest.workspaceId, relativePath);
      if (
        readback.sha256 !== entry.sha256 ||
        readback.bytes !== entry.bytes ||
        (tracked && (tracked.sha256 !== readback.sha256 || tracked.bytes !== readback.bytes))
      ) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_staging_mismatch",
          `Workspace staging drifted before execution: ${relativePath}.`,
        );
      }
      stagedFiles.push({
        path: relativePath,
        bytes: new TextEncoder().encode(readback.content),
      });
    }
    if (sandboxAction.expectedArtifacts.length === 0) return { stagedFiles };

    const declaredArtifacts = new Map<string, {
      expectedSha256: string | null;
      expectedExistingSha256: string | null;
      maxBytes: number;
    }>();
    for (const artifact of sandboxAction.expectedArtifacts) {
      const artifactPath = assertWorkspaceRelativePathV2(
        artifact.path,
        "sandbox generated artifact path",
      );
      if (!profile.generatedOutputs.some((root) => pathAtOrBelow(root, artifactPath))) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_artifact_scope_rejected",
          `Sandbox artifact is not under a RepositoryProfileV2 generated output: ${artifactPath}.`,
        );
      }
      if (!project.allowedPaths.some((allowed) => pathAtOrBelow(allowed, artifactPath))) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_artifact_scope_rejected",
          `Sandbox artifact is outside the trusted project path scope: ${artifactPath}.`,
        );
      }
      if (profile.protectedControls.some(
        (control) =>
          pathAtOrBelow(control.path, artifactPath) ||
          pathAtOrBelow(artifactPath, control.path),
      )) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_artifact_protected_control",
          `Sandbox artifact cannot replace or contain a protected repository control: ${artifactPath}.`,
        );
      }
      const existing = await this.workspaceManager.stat(
        manifest.workspaceId,
        artifactPath,
      ).catch((error) => {
        if (
          error instanceof WorkspaceManagerErrorV2 &&
          (error.code === "path_not_found" || error.code === "parent_missing")
        ) {
          return null;
        }
        throw error;
      });
      if (existing?.kind === "directory") {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_artifact_path_conflict",
          `Sandbox artifact destination is an existing directory: ${artifactPath}.`,
        );
      }
      declaredArtifacts.set(artifactPath, {
        expectedSha256: artifact.expectedSha256,
        expectedExistingSha256: existing?.sha256 ?? null,
        maxBytes: artifact.maxBytes,
      });
    }
    const leaseOwner = `extension:${contextRunId(_context)}`;
    let leaseId = await this.ensureArtifactImportLease(
      manifest.workspaceId,
      leaseOwner,
    );
    const artifactImporter: SandboxArtifactImporterV2 = {
      importArtifacts: async (inputs) => {
        if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
          throw new CodeSandboxContributionErrorV2(
            "sandbox_artifact_batch_invalid",
            "Sandbox artifact import requires one bounded atomic batch.",
          );
        }
        const prepared = inputs.map((input) => {
          const artifactPath = assertWorkspaceRelativePathV2(
            input.path,
            "sandbox generated artifact path",
          );
          const declared = declaredArtifacts.get(artifactPath);
          if (!declared) {
            throw new CodeSandboxContributionErrorV2(
              "sandbox_artifact_undeclared",
              `Sandbox returned an undeclared artifact: ${artifactPath}.`,
            );
          }
          if (
            !(input.bytes instanceof Uint8Array) ||
            input.bytes.byteLength > declared.maxBytes ||
            sha256Bytes(input.bytes) !== input.sha256 ||
            (declared.expectedSha256 !== null && declared.expectedSha256 !== input.sha256)
          ) {
            throw new CodeSandboxContributionErrorV2(
              "sandbox_artifact_hash_mismatch",
              `Sandbox artifact failed its declared hash or byte boundary: ${artifactPath}.`,
            );
          }
          return {
            path: artifactPath,
            bytes: input.bytes,
            sha256: input.sha256,
            expectedExistingSha256: declared.expectedExistingSha256,
            maxBytes: declared.maxBytes,
          };
        }).sort((left, right) => left.path.localeCompare(right.path));
        if (new Set(prepared.map((artifact) => artifact.path)).size !== prepared.length) {
          throw new CodeSandboxContributionErrorV2(
            "sandbox_artifact_batch_invalid",
            "Sandbox artifact import batch contains duplicate paths.",
          );
        }
        leaseId = await this.ensureArtifactImportLease(
          manifest.workspaceId,
          leaseOwner,
          leaseId,
        );
        const receipts = await this.workspaceManager.importSandboxArtifacts({
          workspaceId: manifest.workspaceId,
          leaseId,
          artifacts: prepared.map((artifact) => ({
            relativePath: artifact.path,
            bytes: artifact.bytes,
            expectedSha256: artifact.sha256,
            expectedExistingSha256: artifact.expectedExistingSha256,
            maxBytes: artifact.maxBytes,
          })),
        });
        const receiptByPath = new Map(receipts.map((receipt) => [receipt.path, receipt]));
        return prepared.map((artifact) => {
          const receipt = receiptByPath.get(artifact.path);
          if (!receipt || receipt.afterSha256 !== artifact.sha256) {
            throw new CodeSandboxContributionErrorV2(
              "sandbox_artifact_readback_failed",
              `Sandbox artifact batch receipt failed readback: ${artifact.path}.`,
            );
          }
          return { path: artifact.path, readbackSha256: artifact.sha256 };
        });
      },
    };
    return { stagedFiles, artifactImporter };
  }

  async resolveSandboxPreparationInput(
    purpose: PreparedSandboxActionV2["purpose"],
    workspaceId: string,
  ): Promise<{
    profile: RepositoryProfileV2;
    projectId: string;
    commandId: string;
    workspaceManifestFingerprint: string;
    stagingManifest: Array<{ path: string; sha256: string; bytes: number }>;
  }> {
    this.assertInitialized();
    const manifest = await this.workspaceManager.loadManifest(workspaceId);
    const profileKey = manifest.repositoryBinding?.profileKey;
    const profile = profileKey ? await this.getRepositoryProfile(profileKey) : null;
    if (
      !profile ||
      manifest.kind !== "repository" ||
      !samePath(manifest.repositoryBinding!.repositoryRoot, profile.repositoryRoot)
    ) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_workspace_binding_mismatch",
        "Sandbox preparation requires the exact trusted repository-worktree profile binding.",
      );
    }
    const changedPaths = manifest.budget.changedPaths;
    const projects = profile.projects.filter((candidate) =>
      changedPaths.length === 0 || changedPaths.every((relativePath) =>
        candidate.allowedPaths.some((allowed) => pathAtOrBelow(allowed, relativePath)),
      ),
    );
    if (projects.length !== 1) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_project_binding_mismatch",
        "Sandbox preparation requires exactly one project covering the trusted workspace changes.",
      );
    }
    const project = projects[0];
    const command = selectForegroundValidationCommand(profile, project.id, purpose);
    const stagingManifest = Object.entries(manifest.hashes.files)
      .filter(([relativePath]) =>
        project.allowedPaths.some((allowed) => pathAtOrBelow(allowed, relativePath)) ||
        profile.protectedControls.some((control) => pathAtOrBelow(control.path, relativePath)),
      )
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([relativePath, evidence]) => ({
        path: relativePath,
        sha256: evidence.sha256,
        bytes: evidence.bytes,
      }));
    if (stagingManifest.length === 0) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_staging_empty",
        "The trusted workspace has no hash-bound files in the selected project scope.",
      );
    }
    const sandboxStatus = await this.probeConfiguredSandboxProviders();
    if (!sandboxStatus.executionAvailable) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_provider_unavailable",
        sandboxStatus.blocker?.message ??
          "No sandbox provider passed the fresh preparation boundary probe.",
      );
    }
    return {
      profile,
      projectId: project.id,
      commandId: command.id,
      workspaceManifestFingerprint: manifest.hashes.indexFingerprint,
      stagingManifest,
    };
  }

  /** Host-controlled boundary probe. It never receives a model-supplied command. */
  async probeConfiguredSandboxProviders(signal?: AbortSignal): Promise<SandboxCapabilityStatusV2> {
    this.assertInitialized();
    const status = await this.requireSandboxManager().probeProviders(signal);
    await this.serializedRefresh(async () => {
      const next = parseCodeRuntimeStateV2({
        ...this.requireState(),
        sandbox: {
          ...this.requireState().sandbox,
          lastProbe: {
            version: 1,
            observedAt: this.isoNow(),
            status,
          },
        },
        updatedAt: this.isoNow(),
      });
      this.state = await this.persistState(next);
    });
    return status;
  }

  /**
   * Persist one exact immutable provider binding from the local settings UI.
   * The model/tool surface receives no handle to this method. Any change drops
   * cached probe proof and requires a fresh explicit boundary probe.
   */
  async configureSandboxProvider(
    input: SandboxProviderConfigV2,
  ): Promise<CodeRuntimeStateV2> {
    this.assertInitialized();
    if (this.injectedSandboxManager) {
      throw new Error("Injected sandbox managers cannot be reconfigured at runtime.");
    }
    const provider = parseSandboxProviderConfigV2(input);
    await this.serializedRefresh(async () => {
      const current = this.requireState();
      const providerConfigs = [
        ...current.sandbox.providerConfigs.filter((candidate) => candidate.kind !== provider.kind),
        provider,
      ].sort((left, right) => left.priority - right.priority || left.kind.localeCompare(right.kind));
      this.state = await this.persistState(parseCodeRuntimeStateV2({
        ...current,
        sandbox: { providerConfigs, lastProbe: null },
        updatedAt: this.isoNow(),
      }));
      this.sandboxManager = this.createConfiguredSandboxManager();
    });
    return this.readState();
  }

  /** Local settings operation. Removing configuration cannot start a process. */
  async removeSandboxProvider(kindInput: SandboxProviderConfigV2["kind"]): Promise<CodeRuntimeStateV2> {
    this.assertInitialized();
    if (this.injectedSandboxManager) {
      throw new Error("Injected sandbox managers cannot be reconfigured at runtime.");
    }
    const kind = sandboxProviderKind(kindInput);
    await this.serializedRefresh(async () => {
      const current = this.requireState();
      const providerConfigs = current.sandbox.providerConfigs.filter((provider) => provider.kind !== kind);
      if (providerConfigs.length === current.sandbox.providerConfigs.length) return;
      this.state = await this.persistState(parseCodeRuntimeStateV2({
        ...current,
        sandbox: { providerConfigs, lastProbe: null },
        updatedAt: this.isoNow(),
      }));
      this.sandboxManager = this.createConfiguredSandboxManager();
    });
    return this.readState();
  }

  readState(): CodeRuntimeStateV2 {
    return cloneJson(this.requireState());
  }

  /**
   * Read-only cross-extension handoff. Only a terminal publication-eligible
   * repair checkpoint can become a signed publication contract; callers never
   * supply a worktree path, commit SHA, or validation receipt.
   */
  async resolveLatestVerifiedPublicationHandoff(
    profileKeyInput: string,
    exact?: { runId: string; requestId: string },
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    this.assertInitialized();
    const profileKey = boundedIdentifier(
      profileKeyInput,
      "repository profile key",
    );
    const profile = await this.getRepositoryProfile(profileKey);
    if (!profile) return null;
    const exactRunId = exact
      ? boundedIdentifier(exact.runId, "queue code run id")
      : null;
    const exactRequestId = exact
      ? boundedIdentifier(exact.requestId, "queue code request id")
      : null;
    const rawNamespace = await this.readTopLevelNamespace<CodeRepairCheckpointNamespaceV1>(
      "codeRepairCheckpointsV1",
    );
    if (!rawNamespace) return null;
    const raw = topLevelRecord(rawNamespace);
    if (raw.version !== 1 || !Number.isSafeInteger(raw.revision)) {
      throw new Error("Code repair checkpoint namespace is invalid.");
    }
    const rawCheckpoints = topLevelRecord(raw.checkpoints);
    const checkpointIds = Object.keys(rawCheckpoints);
    if (checkpointIds.length > 512) {
      throw new Error("Code repair checkpoint namespace exceeds its fixed bound.");
    }
    const store = new CallbackCodeRepairCheckpointStoreV1(
      this.checkpointPersistence(),
    );
    const eligible = [];
    for (const id of checkpointIds) {
      const checkpoint = await store.load(id);
      if (
        checkpoint?.terminal?.status === "complete" &&
        checkpoint.terminal.publicationEligible === true &&
        checkpoint.verifiedCommitReceipt &&
        checkpoint.request.worktree.profileId === profileKey &&
        (!exactRunId || checkpoint.request.runId === exactRunId) &&
        (!exactRequestId || checkpoint.request.id === exactRequestId)
      ) {
        eligible.push(checkpoint);
      }
    }
    eligible.sort((left, right) =>
      String(right.verifiedCommitReceipt?.committedAt ?? "").localeCompare(
        String(left.verifiedCommitReceipt?.committedAt ?? ""),
      ) || right.sequence - left.sequence,
    );
    const checkpoint = eligible[0];
    const receipt = checkpoint?.verifiedCommitReceipt;
    if (!checkpoint || !receipt) return null;
    const manifest = await this.workspaceManager.loadManifest(receipt.workspaceId);
    const binding = manifest.repositoryBinding;
    if (
      manifest.kind !== "repository" ||
      manifest.ownerRunId !== receipt.runId ||
      (manifest.baseSha !== receipt.baseSha && manifest.baseSha !== receipt.commitSha) ||
      !binding ||
      binding.profileKey !== profile.key ||
      binding.branch !== receipt.branch ||
      !samePath(binding.worktreeRoot, manifest.canonicalRoot) ||
      !samePath(binding.repositoryRoot, profile.repositoryRoot)
    ) {
      throw new Error(
        "Verified commit receipt no longer matches its durable repository workspace and profile binding.",
      );
    }
    return createVerifiedCodePublicationHandoffV1({
      id: `code-handoff-${receipt.fingerprint.slice(7, 31)}`,
      repositoryProfileKey: profile.key,
      repositoryProfileFingerprint: sha256Canonical(profile),
      canonicalWorktreeRoot: manifest.canonicalRoot,
      baseBranch: profile.defaultBranch,
      localCommit: receipt,
      // A publication handoff must be reproducible across resolver calls and
      // restart. The terminal checkpoint update is durable and cannot predate
      // the verified commit it contains.
      preparedAt: checkpoint.updatedAt,
    });
  }

  async resolveVerifiedReviewRepairBase(
    input: CodeReviewRepairBaseResolutionInputV1,
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    this.assertInitialized();
    const profileKey = boundedIdentifier(input.profileKey, "review-repair profile key");
    const workspaceId = boundedIdentifier(input.workspaceId, "review-repair workspace id");
    const runId = boundedIdentifier(input.runId, "review-repair run id");
    const requestId = boundedIdentifier(input.requestId, "review-repair base request id");
    const expectedFingerprint = fingerprint(
      input.expectedFingerprint,
      "review-repair base handoff fingerprint",
    );
    const handoff = await this.resolveLatestVerifiedPublicationHandoff(profileKey, {
      runId,
      requestId,
    });
    if (
      !handoff ||
      handoff.fingerprint !== expectedFingerprint ||
      handoff.workspaceId !== workspaceId ||
      handoff.branch !== input.branch
    ) return null;
    return handoff;
  }

  async resolveVerifiedReviewRepairResult(input: {
    repairRequestId: string;
    runId: string;
    profileKey: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<VerifiedCodePublicationHandoffV1 | null> {
    this.assertInitialized();
    const repairRequestId = boundedIdentifier(input.repairRequestId, "review repair request id");
    const runId = boundedIdentifier(input.runId, "review repair run id");
    const profileKey = boundedIdentifier(input.profileKey, "review repair profile key");
    const workspaceId = boundedIdentifier(input.workspaceId, "review repair workspace id");
    const handoff = await this.resolveLatestVerifiedPublicationHandoff(profileKey, {
      runId,
      requestId: repairRequestId,
    });
    return handoff?.workspaceId === workspaceId && handoff.requestId === repairRequestId
      ? handoff
      : null;
  }

  /**
   * Verify and advance the durable workspace epoch, then build the ordinary
   * production repair mission. No review-supplied path or command is accepted.
   */
  async createVerifiedReviewRepairMissionPrompt(
    input: CodeReviewRepairPipelineInputV1,
  ): Promise<string> {
    this.assertInitialized();
    const repairRequestId = boundedIdentifier(input.repairRequestId, "review repair request id");
    const runId = boundedIdentifier(input.runId, "review repair run id");
    const profileKey = boundedIdentifier(input.profileKey, "review repair profile key");
    const workspaceId = boundedIdentifier(input.workspaceId, "review repair workspace id");
    const expectedBaseSha = gitObjectId(input.expectedBaseSha, "review repair expected base SHA");
    const baseRequestId = boundedIdentifier(input.baseRequestId, "review repair base request id");
    const baseHandoffFingerprint = fingerprint(
      input.baseHandoffFingerprint,
      "review repair base handoff fingerprint",
    );
    const reviewEvidenceFingerprint = fingerprint(
      input.reviewEvidenceFingerprint,
      "review repair evidence fingerprint",
    );
    const objective = reviewRepairObjective(input.objective);
    if (input.maxCycles !== 3) throw new Error("GitHub review repair is limited to three repair cycles.");
    const base = await this.resolveVerifiedReviewRepairBase({
      profileKey,
      workspaceId,
      branch: input.branch,
      runId,
      requestId: baseRequestId,
      expectedFingerprint: baseHandoffFingerprint,
      signal: input.signal,
    });
    if (!base || base.commitSha !== expectedBaseSha) {
      throw new Error("Exact verified review-repair base handoff is unavailable or stale.");
    }
    const manifest = await this.workspaceManager.loadManifest(workspaceId);
    if (
      manifest.kind !== "repository" ||
      manifest.ownerRunId !== runId ||
      (manifest.baseSha !== base.baseSha && manifest.baseSha !== base.commitSha) ||
      manifest.repositoryBinding?.profileKey !== profileKey ||
      manifest.repositoryBinding.branch !== base.branch ||
      !samePath(manifest.canonicalRoot, base.canonicalWorktreeRoot)
    ) {
      throw new Error("Verified review-repair base no longer matches its durable workspace manifest.");
    }
    const git = this.repairGit;
    if (!git || this.requireState().repair.mode !== "production_wired") {
      throw new Error("Production code-repair adapters are unavailable.");
    }
    const operationId = `review-base-${repairRequestId}`;
    const runGit = async (args: readonly string[], label: string): Promise<string> => {
      const result = await git.run({ cwd: manifest.canonicalRoot, args, signal: input.signal });
      if (result.exitCode !== 0) {
        throw new Error(`${label} failed through fixed-argv Git: ${result.stderr.slice(0, 500)}`);
      }
      return result.stdout.trim();
    };
    const [root, headSha, branch, status] = await Promise.all([
      runGit(["rev-parse", "--show-toplevel"], "Worktree-root readback"),
      runGit(["rev-parse", "HEAD"], "Worktree-head readback"),
      runGit(["branch", "--show-current"], "Worktree-branch readback"),
      runGit(["status", "--porcelain=v1", "--untracked-files=all"], "Worktree-cleanliness readback"),
    ]);
    if (
      !samePath(root, manifest.canonicalRoot) ||
      headSha !== base.commitSha ||
      branch !== base.branch ||
      status.length !== 0
    ) {
      throw new Error("Fixed-argv Git did not prove the exact clean verified review-repair base.");
    }
    const readback = createVerifiedWorkspaceBaseReadbackV2({
      operationId,
      workspaceId,
      worktreeRoot: manifest.canonicalRoot,
      branch,
      headSha,
      clean: true,
      handoffFingerprint: base.fingerprint,
    });
    await this.workspaceManager.advanceRepositoryBaseAfterVerifiedReadback({
      operationId,
      workspaceId,
      ownerRunId: runId,
      profileKey,
      expectedWorktreeRoot: manifest.canonicalRoot,
      expectedBranch: base.branch,
      expectedPreviousBaseSha: base.baseSha,
      nextBaseSha: base.commitSha,
      handoffFingerprint: base.fingerprint,
      readback,
    });
    return this.createTrustedQueueCodeMissionPrompt({
      runId,
      workspaceId,
      profileKey,
      requestId: repairRequestId,
      objective,
      commitMessage: "Address verified GitHub review feedback",
    });
  }

  /**
   * Validate an explicit foreground repair request against the durable
   * workspace binding, then reduce it to binding keys for the core-owned model
   * loop. The extension never runs a second model loop or bypasses approvals.
   */
  async createForegroundRepairMissionPrompt(
    input: CodeRepairRequestV1,
  ): Promise<string> {
    this.assertInitialized();
    const request = normalizeCodeRepairRequestV1(input);
    const manifest = await this.workspaceManager.loadManifest(request.worktree.id);
    const binding = manifest.repositoryBinding;
    if (
      manifest.kind !== "repository" ||
      !binding ||
      manifest.ownerRunId !== request.runId ||
      manifest.baseSha !== request.worktree.baseSha ||
      binding.profileKey !== request.worktree.profileId ||
      binding.branch !== request.worktree.branch ||
      !samePath(binding.worktreeRoot, request.worktree.path) ||
      !samePath(binding.repositoryRoot, request.worktree.repositoryRoot)
    ) {
      throw new Error(
        "Foreground repair request does not match the exact trusted workspace, owner, profile, branch, and base SHA binding.",
      );
    }
    if (!await this.getRepositoryProfile(binding.profileKey)) {
      throw new Error("Foreground repair request references an unavailable trusted repository profile.");
    }
    return [
      `Execute explicit code repair request ${request.id} in trusted workspace ${request.worktree.id}.`,
      `Objective (untrusted task text only): ${JSON.stringify(request.objective)}.`,
      `Use repairRequestId ${request.id} for every validation, repair-cycle, status, and commit call.`,
      `Use at most ${request.maxCycles} edit and fast-validation cycles.`,
      "Edit only through prepared code_workspace_* mutations; never execute on the host.",
      "Run sandbox fast validation, record its durable cycle receipt, then run distinct targeted and fresh-full sandbox validation.",
      `Prepare code_commit_verified with commit message ${JSON.stringify(request.commitMessage)} and the exact durable validation receipt IDs.`,
      "Return only after the verified_local_commit receipt is present; if sandbox or authority is unavailable, persist and report the exact blocker.",
    ].join(" ");
  }

  /**
   * Resolve the graph-planning grant for the canonical foreground repair
   * mission produced above. The caller supplies only the original objective;
   * workspace identity is extracted from extension-owned prompt markers,
   * while every authority-bearing field comes from fresh durable readback.
   */
  async resolveBackgroundMissionBinding(input: {
    objective: string;
    toolName: "code_validate_commit_prepared";
  }): Promise<{
    id: string;
    kind: "prepared_validation_commit";
    destinationFingerprint: string;
    allowedEffects: ["read", "execution"];
  } | null> {
    this.assertInitialized();
    const route = parseBackgroundMissionBindingRoute(input);
    if (!route) return null;
    try {
      const initial = await this.workspaceManager.loadManifest(route.workspaceId);
      const manifest = await this.workspaceManager.resumeWorkspace(
        initial.workspaceId,
        initial.ownerRunId,
      );
      const binding = manifest.repositoryBinding;
      if (
        manifest.kind !== "repository" ||
        manifest.status !== "active" ||
        manifest.lease !== null ||
        !manifest.baseSha ||
        !binding ||
        !binding.branch ||
        !samePath(binding.worktreeRoot, manifest.canonicalRoot)
      ) return null;
      const profile = await this.getRepositoryProfile(binding.profileKey);
      if (
        !profile ||
        !samePath(binding.repositoryRoot, profile.repositoryRoot)
      ) return null;
      return {
        id: manifest.workspaceId,
        kind: "prepared_validation_commit",
        destinationFingerprint: binding.bindingFingerprint,
        allowedEffects: ["read", "execution"],
      };
    } catch {
      // Missing, expired, corrupt, drifted, or concurrently rebound durable
      // state is an unavailable capability, never caller-supplied authority.
      return null;
    }
  }

  /**
   * Extension-owned approval preparation seam for background validation and
   * commit. This deliberately fails closed until the runtime can reconstruct
   * every executable value from its durable checkpoint/profile/workspace
   * stores. Core may never supply paths, commands, or sandbox actions here.
   */
  async prepareBackgroundValidationCommitApproval(
    input: PrepareBackgroundValidationCommitApprovalInputV1,
  ): Promise<PrepareBackgroundValidationCommitApprovalResultV1> {
    this.assertInitialized();
    return this.createPreparedBackgroundCodeResolver().prepareApproval(input);
  }

  /**
   * Sealing is a separate post-approval operation. It remains fail-closed with
   * the same blocker so an approval can never authorize an incomplete package
   * or revive the removed caller-supplied executable-input route.
   */
  async sealBackgroundValidationCommitPackage(
    input: SealBackgroundValidationCommitPackageInputV1,
  ): Promise<SealBackgroundValidationCommitPackageResultV1> {
    this.assertInitialized();
    return this.createPreparedBackgroundCodeResolver().sealPackage(input);
  }

  private createPreparedBackgroundCodeResolver(): PreparedBackgroundCodeResolverV1 {
    return new PreparedBackgroundCodeResolverV1({
      checkpoints: new CallbackCodeRepairCheckpointStoreV1(
        this.checkpointPersistence(),
      ),
      workspaceManager: this.workspaceManager,
      getRepositoryProfile: (profileKey) => this.getRepositoryProfile(profileKey),
      sandboxManager: this.requireSandboxManager(),
      sandboxProviders: () => [...this.requireState().sandbox.providerConfigs],
      host: new PreparedBackgroundCodeHostV1({
        applicationDataRoot: this.workspaceManager.applicationDataRoot,
        now: this.now,
      }),
      now: this.now,
    });
  }

  /**
   * Host-only queue bridge. The caller supplies logical identities and
   * untrusted objective text, never repository or worktree paths. The runtime
   * reconstructs the exact repair contract from its trusted durable manifest.
   */
  async createTrustedQueueCodeMissionPrompt(input: {
    runId: string;
    workspaceId: string;
    profileKey: string;
    requestId: string;
    objective: string;
    commitMessage: string;
  }): Promise<string> {
    this.assertInitialized();
    const runId = boundedIdentifier(input.runId, "queue code run id");
    const workspaceId = boundedIdentifier(input.workspaceId, "queue code workspace id");
    const profileKey = boundedIdentifier(input.profileKey, "queue repository profile key");
    const requestId = boundedIdentifier(input.requestId, "queue code request id");
    const binding = await this.resolveRepairWorkspaceBinding({ workspaceId, profileKey });
    if (!binding || binding.blockerCode || !binding.worktreeBranch) {
      throw new Error(
        binding?.blockerCode === "worktree_branch_readback_required"
          ? "Trusted queue worktree branch readback is required before repair can start."
          : "Trusted queue repository workspace is unavailable or does not match its profile.",
      );
    }
    const sandbox = this.getSandboxCapabilityStatus();
    if (!sandbox.executionAvailable) {
      throw new Error(
        `Sandbox execution is unavailable: ${sandbox.blocker?.message ?? "no provider passed its boundary probe"}.`,
      );
    }
    return this.createForegroundRepairMissionPrompt({
      id: requestId,
      runId,
      objective: input.objective,
      worktree: {
        id: workspaceId,
        path: binding.worktreeRoot,
        repositoryRoot: binding.repositoryRoot,
        branch: binding.worktreeBranch,
        baseSha: binding.baseSha,
        profileId: binding.profile.key,
      },
      commitMessage: input.commitMessage,
      maxCycles: 3,
    });
  }

  private async initializeProductionRepairAdapters(): Promise<void> {
    try {
      const validationReceiptRegistry = new DurableValidationReceiptRegistryV1(
        this.validationReceiptPersistence(),
        this.now,
      );
      const git = new SpawnFixedArgvGitRunnerV1();
      this.repairGit = git;
      const artifactHashReader = new FixedArgvArtifactHashReaderV1(git);
      const proof = new FixedArgvRepairProofAdapterV1({
        workspaceManager: this.workspaceManager,
        git,
        artifactHashReader,
        getProfile: (profileKey) => this.getRepositoryProfile(profileKey),
        now: this.now,
      });
      const commitGateway = await createFixedArgvVerifiedCommitGatewayV1({
        workspaceManager: this.workspaceManager,
        git,
        artifactHashReader,
        disabledHooksPath: path.join(
          this.workspaceManager.applicationDataRoot,
          "repair-disabled-hooks",
        ),
        now: this.now,
      });
      const handlers = createCodeRepairToolRuntimeV1({
        workspaceManager: this.workspaceManager,
        repositoryProfiles: proof,
        validations: validationReceiptRegistry,
        checkpointPersistence: this.checkpointPersistence(),
        proofReader: proof,
        commitGateway,
        now: this.now,
      });
      this.validationReceiptRegistry = validationReceiptRegistry;
      this.repairContributions = createCodeRepairToolContributionsV1(handlers, {
        hostResolvesDurableProof: true,
      });
      if (this.requireState().repair.mode !== "production_wired") {
        this.state = await this.persistState(parseCodeRuntimeStateV2({
          ...this.requireState(),
          repair: {
            mode: "production_wired",
            blockerCode: null,
            message: "Durable scoped validation, checkpoint, fixed-argv proof, and verified local commit adapters are connected.",
          },
          updatedAt: this.isoNow(),
        }));
      }
    } catch (error) {
      this.repairGit = null;
      this.validationReceiptRegistry = null;
      this.repairContributions = [];
      const message = `Production repair adapters are blocked: ${error instanceof Error ? error.message : String(error)}`.slice(0, 500);
      const degraded = parseCodeRuntimeStateV2({
        ...this.requireState(),
        repair: {
          mode: "degraded_not_wired",
          blockerCode: "repair_handlers_not_production_wired",
          message,
        },
        updatedAt: this.isoNow(),
      });
      if (canonicalJson(degraded.repair) !== canonicalJson(this.requireState().repair)) {
        this.state = await this.persistState(degraded);
      }
    }
  }

  private checkpointPersistence(): CallbackCheckpointPersistenceV1 {
    return {
      readNamespace: () => this.readTopLevelNamespace<CodeRepairCheckpointNamespaceV1>(
        "codeRepairCheckpointsV1",
      ),
      writeNamespace: (namespace, expectedRevision) =>
        this.writeTopLevelNamespace(
          "codeRepairCheckpointsV1",
          namespace,
          expectedRevision,
        ),
    };
  }

  private validationReceiptPersistence(): ValidationReceiptPersistenceV1 {
    return {
      readNamespace: () => this.readTopLevelNamespace<DurableValidationReceiptNamespaceV1>(
        "codeValidationReceiptsV1",
      ),
      writeNamespace: (namespace, expectedRevision) =>
        this.writeTopLevelNamespace(
          "codeValidationReceiptsV1",
          namespace,
          expectedRevision,
        ),
    };
  }

  private readTopLevelNamespace<T>(key: string): Promise<T | null> {
    return withPluginDataLock(this.plugin, async () => {
      const topLevel = topLevelRecord(await this.plugin.loadData());
      assertTopLevelSchema(topLevel);
      return topLevel[key] === undefined ? null : cloneJson(topLevel[key] as T);
    });
  }

  private writeTopLevelNamespace<T extends { revision: number }>(
    key: string,
    namespace: T,
    expectedRevision: number,
  ): Promise<boolean> {
    return withPluginDataLock(this.plugin, async () => {
      const topLevel = topLevelRecord(await this.plugin.loadData());
      assertTopLevelSchema(topLevel);
      const current = topLevel[key] === undefined
        ? null
        : plainRecord(topLevel[key], `${key} namespace`);
      const currentRevision = current === null ? 0 : current.revision;
      if (currentRevision !== expectedRevision) return false;
      await this.plugin.saveData({
        ...topLevel,
        schemaVersion: 1,
        [key]: cloneJson(namespace),
      });
      return true;
    });
  }

  /** Narrow handle for a production repair adapter; never exposes a runner. */
  getSandboxCapabilityStatus(): SandboxCapabilityStatusV2 {
    this.assertInitialized();
    return this.requireSandboxManager().readStatus();
  }

  /**
   * Resolve only the trusted profile/worktree binding needed by repair proof
   * adapters. Legacy pre-branch manifests remain explicit blockers; current
   * manifests return the exact branch persisted at worktree creation.
   */
  async resolveRepairWorkspaceBinding(input: {
    workspaceId: string;
    profileKey: string;
  }): Promise<{
    profile: RepositoryProfileV2;
    workspaceId: string;
    repositoryRoot: string;
    worktreeRoot: string;
    baseSha: string;
    hashIndexFingerprint: string;
    worktreeBranch: string | null;
    blockerCode: "worktree_branch_readback_required" | null;
  } | null> {
    this.assertInitialized();
    const profile = await this.getRepositoryProfile(input.profileKey);
    if (!profile) return null;
    const manifest = await this.workspaceManager.loadManifest(input.workspaceId);
    if (
      manifest.kind !== "repository" ||
      !manifest.baseSha ||
      manifest.repositoryBinding?.profileKey !== profile.key ||
      !samePath(manifest.repositoryBinding.repositoryRoot, profile.repositoryRoot)
    ) return null;
    return {
      profile,
      workspaceId: manifest.workspaceId,
      repositoryRoot: manifest.repositoryBinding.repositoryRoot,
      worktreeRoot: manifest.repositoryBinding.worktreeRoot,
      baseSha: manifest.baseSha,
      hashIndexFingerprint: manifest.hashes.indexFingerprint,
      worktreeBranch: manifest.repositoryBinding.branch,
      blockerCode: manifest.repositoryBinding.branch
        ? null
        : "worktree_branch_readback_required",
    };
  }

  private async persistProfileRecord(recordInput: CodeRepositoryProfileRecordV2): Promise<void> {
    const record = parseProfileRecord(recordInput, "detected repository profile");
    await this.serializedRefresh(async () => {
      const current = this.requireState();
      const existing = current.repositoryProfiles[record.profile.key];
      if (existing) {
        if (sha256Canonical(existing) !== sha256Canonical(record)) {
          throw new WorkspaceManagerErrorV2(
            "repository_profile_binding_conflict",
            `Repository profile ${record.profile.key} changed after trust was established.`,
          );
        }
        return;
      }
      const next = parseCodeRuntimeStateV2({
        ...current,
        repositoryProfiles: {
          ...current.repositoryProfiles,
          [record.profile.key]: record,
        },
        updatedAt: this.isoNow(),
      });
      this.state = await this.persistState(next);
    });
  }

  private async ensureArtifactImportLease(
    workspaceId: string,
    ownerId: string,
    knownLeaseId?: string,
  ): Promise<string> {
    const manifest = await this.workspaceManager.loadManifest(workspaceId);
    if (
      knownLeaseId &&
      manifest.lease?.id === knownLeaseId &&
      manifest.lease.ownerId === ownerId &&
      Date.parse(manifest.lease.expiresAt) > this.now().getTime()
    ) {
      const renewed = await this.workspaceManager.renewLease(
        workspaceId,
        knownLeaseId,
        15 * 60_000,
      );
      return renewed.lease!.id;
    }
    if (
      manifest.lease?.ownerId === ownerId &&
      Date.parse(manifest.lease.expiresAt) > this.now().getTime()
    ) {
      const renewed = await this.workspaceManager.renewLease(
        workspaceId,
        manifest.lease.id,
        15 * 60_000,
      );
      return renewed.lease!.id;
    }
    const acquired = await this.workspaceManager.acquireLease(
      workspaceId,
      ownerId,
      15 * 60_000,
    );
    if (!acquired.lease || acquired.lease.ownerId !== ownerId) {
      throw new WorkspaceManagerErrorV2(
        "workspace_lease_conflict",
        "Sandbox artifact import could not obtain the mission-owned workspace lease.",
      );
    }
    return acquired.lease.id;
  }

  private async persistState(next: CodeRuntimeStateV2): Promise<CodeRuntimeStateV2> {
    return withPluginDataLock(this.plugin, async () => {
      const topLevel = topLevelRecord(await this.plugin.loadData());
      assertTopLevelSchema(topLevel);
      await this.plugin.saveData({
        ...topLevel,
        schemaVersion: 1,
        codeRuntimeState: next,
      });
      const readback = topLevelRecord(await this.plugin.loadData());
      assertPreservedMigration(topLevel, readback);
      return parseCodeRuntimeStateV2(readback.codeRuntimeState);
    });
  }

  private createRuntimeStatusContribution(): StatusContributionV1 {
    return {
      descriptor: {
        version: 1,
        kind: "status",
        id: `${EXTENSION_ID}:runtime-health`,
        displayName: "Code runtime health",
      },
      readStatus: async (context) => {
        await this.refreshMigratedProfiles();
        const state = this.requireState();
        const sandbox = this.requireSandboxManager().readStatus();
        return {
          status: sandbox.executionAvailable ? "healthy" : "degraded",
          summary: sandbox.executionAvailable
            ? `Durable workspace editing, sandbox execution, and selective hash-verified generated-artifact import are available through ${sandbox.selectedProvider}.`
            : "Durable workspace editing is available; generated-code execution and generated-artifact import are blocked until an immutable provider passes an explicit boundary probe.",
          details: {
            stateVersion: state.version,
            repositoryProfileCount: Object.keys(state.repositoryProfiles).length,
            migratedProfileCount: state.migration?.migratedProfileKeys.length ?? 0,
            workspaceMetadataRoot: this.workspaceManager.metadataRoot,
            executionMode: sandbox.mode,
            artifactImport: "selective_sandbox_generated_hash_verified",
            repairMode: this.repairContributions.length > 0
              ? "handlers_contributed"
              : state.repair.mode,
            backgroundValidationCommitCapability:
              PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
            backgroundValidationCommitExecutionHost: "headless_runtime",
            backgroundValidationCommitForegroundFallback: false,
            backgroundValidationCommitAvailability: sandbox.executionAvailable
              ? "registered_sandbox_verified"
              : "registered_blocked_until_sandbox_verified",
          },
          checkedAt: context.now().toISOString(),
        };
      },
    };
  }

  private createSettingsContribution(): SettingsContributionV1 {
    return {
      descriptor: {
        version: 1,
        kind: "settings",
        id: `${EXTENSION_ID}:settings-v2`,
        displayName: "Code capability settings",
      },
      section: {
        id: EXTENSION_ID,
        title: "Code workspaces and sandbox",
        fields: [
          {
            id: "workspace_manager_v2",
            type: "boolean",
            label: "Durable workspace manager",
            description: "WorkspaceManifestV2 CRUD, leases, hashes, trash, and restart recovery are active.",
            defaultValue: true,
          },
          {
            id: "execution_mode",
            type: "select",
            label: "Execution capability",
            description: "Execution remains editing-only until a configured immutable sandbox passes its explicit boundary probe.",
            defaultValue: "editing_only",
            options: [
              { label: "Editing only", value: "editing_only" },
              { label: "Sandbox verified", value: "sandbox_verified" },
            ],
          },
          {
            id: "profile_contract_version",
            type: "integer",
            label: "Repository profile contract",
            description: "Repository profiles use the closed RepositoryProfileV2 contract.",
            defaultValue: 2,
          },
        ],
      },
    };
  }

  private createRepairDegradedStatusContribution(): StatusContributionV1 {
    return {
      descriptor: {
        version: 1,
        kind: "status",
        id: `${EXTENSION_ID}:repair-health`,
        displayName: "Code repair and verified commit health",
      },
      async readStatus(context) {
        return {
          status: "degraded",
          summary: "The durable repair contracts are installed, but production mutator, validator, approval, and verified-commit handlers are not connected; no commit is simulated.",
          details: {
            blockerCode: "repair_handlers_not_production_wired",
            publicationEligible: false,
          },
          checkedAt: context.now().toISOString(),
        };
      },
    };
  }

  private serializedRefresh(operation: () => Promise<void>): Promise<void> {
    const next = this.refreshQueue.catch(() => undefined).then(operation);
    this.refreshQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private requireState(): CodeRuntimeStateV2 {
    if (!this.state) throw new Error("CodeExtensionRuntimeV2 is not initialized.");
    return this.state;
  }

  private requireSandboxManager(): SandboxManagerV2 {
    if (!this.sandboxManager) throw new Error("CodeExtensionRuntimeV2 sandbox is not initialized.");
    return this.sandboxManager;
  }

  private createConfiguredSandboxManager(): SandboxManagerV2 {
    return new SandboxManagerV2({
      runner: this.sandboxRunner,
      providers: this.requireState().sandbox.providerConfigs,
      now: this.now,
    });
  }

  private assertInitialized(): void {
    if (!this.initialized) throw new Error("CodeExtensionRuntimeV2 is not initialized.");
  }

  private isoNow(): string {
    return this.now().toISOString();
  }
}

export class ProfileAwareRepositoryProvisionerV2
  implements WorkspaceRepositoryProvisionerV2
{
  constructor(
    private readonly runtime: CodeExtensionRuntimeV2,
    private readonly delegate: WorkspaceRepositoryProvisionerV2,
  ) {}

  async resolveProfile(
    profileKey: string,
    _context: ScopedExtensionContextV1,
  ): Promise<string | null> {
    return (await this.runtime.getRepositoryProfile(profileKey))?.repositoryRoot ?? null;
  }

  async resolveProfileContract(
    profileKey: string,
    _context: ScopedExtensionContextV1,
  ): Promise<RepositoryProfileV2 | null> {
    return this.runtime.getRepositoryProfile(profileKey);
  }

  async redetectProfile(
    profileKey: string,
    workspaceId: string,
    context: ScopedExtensionContextV1,
  ): Promise<void> {
    await this.runtime.redetectRepositoryProfile({ profileKey, workspaceId, context });
  }

  inspect(
    repositoryRoot: string,
    context: ScopedExtensionContextV1,
  ): Promise<RepositoryInspectionV2> {
    return this.delegate.inspect(repositoryRoot, context);
  }

  async provision(input: {
    workspaceId: string;
    profileKey: string;
    inspection: RepositoryInspectionV2;
    context: ScopedExtensionContextV1;
  }): Promise<RepositoryWorktreeProvisionV2> {
    let profile = await this.runtime.getRepositoryProfile(input.profileKey);
    if (!profile) {
      profile = await this.runtime.persistDetectedRepositoryProfile({
        profileKey: input.profileKey,
        inspection: input.inspection,
        context: input.context,
      });
    }
    if (!samePath(profile.repositoryRoot, input.inspection.repositoryRoot)) {
      throw new WorkspaceManagerErrorV2(
        "repository_profile_binding_conflict",
        "Trusted repository profile does not match the approved canonical root.",
      );
    }
    const provisioned = await this.delegate.provision(input);
    if (
      provisioned.profileKey !== profile.key ||
      !samePath(provisioned.repositoryRoot, profile.repositoryRoot)
    ) {
      throw new WorkspaceManagerErrorV2(
        "repository_profile_binding_drift",
        "Provisioned worktree escaped its trusted repository profile.",
      );
    }
    return provisioned;
  }
}

export function createInitialCodeRuntimeStateV2(now: string): CodeRuntimeStateV2 {
  return parseCodeRuntimeStateV2({
    version: 2,
    repositoryProfiles: {},
    migration: null,
    sandbox: {
      providerConfigs: [],
      lastProbe: null,
    },
    repair: {
      mode: "degraded_not_wired",
      blockerCode: "repair_handlers_not_production_wired",
      message: "Production repair and verified-commit handlers are not connected.",
    },
    createdAt: now,
    updatedAt: now,
  });
}

export function parseCodeRuntimeStateV2(value: unknown): CodeRuntimeStateV2 {
  const record = exactRecord(value, [
    "version",
    "repositoryProfiles",
    "migration",
    "sandbox",
    "repair",
    "createdAt",
    "updatedAt",
  ], "code runtime state");
  if (record.version !== 2) throw new Error("Unsupported code runtime state version.");
  const rawProfiles = plainRecord(record.repositoryProfiles, "repository profile records");
  if (Object.keys(rawProfiles).length > 256) throw new Error("Code runtime profile registry exceeds 256 entries.");
  const repositoryProfiles: Record<string, CodeRepositoryProfileRecordV2> = {};
  for (const [key, rawProfile] of Object.entries(rawProfiles)) {
    const parsed = parseProfileRecord(rawProfile, `repository profile ${key}`);
    if (key !== parsed.profile.key) throw new Error("Persisted repository profile key does not match its record.");
    repositoryProfiles[key] = parsed;
  }
  const sandbox = exactRecord(record.sandbox, ["providerConfigs", "lastProbe"], "sandbox runtime state");
  if (!Array.isArray(sandbox.providerConfigs) || sandbox.providerConfigs.length > 4) {
    throw new Error("Sandbox provider configuration must contain at most four providers.");
  }
  const providerConfigs = sandbox.providerConfigs.map(parseSandboxProviderConfigV2);
  if (new Set(providerConfigs.map((provider) => provider.kind)).size !== providerConfigs.length) {
    throw new Error("Sandbox provider configuration kinds must be unique.");
  }
  const repair = exactRecord(record.repair, ["mode", "blockerCode", "message"], "repair runtime state");
  if (
    (repair.mode !== "degraded_not_wired" && repair.mode !== "production_wired") ||
    (repair.mode === "degraded_not_wired" && repair.blockerCode !== "repair_handlers_not_production_wired") ||
    (repair.mode === "production_wired" && repair.blockerCode !== null) ||
    typeof repair.message !== "string" ||
    repair.message.length < 1 ||
    repair.message.length > 500
  ) throw new Error("Code repair runtime state is invalid.");
  const createdAt = isoTimestamp(record.createdAt, "createdAt");
  const updatedAt = isoTimestamp(record.updatedAt, "updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) throw new Error("Code runtime updatedAt predates createdAt.");
  return {
    version: 2,
    repositoryProfiles,
    migration: record.migration === null ? null : parseRuntimeMigration(record.migration),
    sandbox: {
      providerConfigs,
      lastProbe: sandbox.lastProbe === null ? null : parsePersistedProbe(sandbox.lastProbe),
    },
    repair: {
      mode: repair.mode,
      blockerCode: repair.blockerCode as CodeRuntimeStateV2["repair"]["blockerCode"],
      message: repair.message,
    },
    createdAt,
    updatedAt,
  };
}

function applyLegacyProfileMigration(
  currentInput: CodeRuntimeStateV2,
  migration: PersistedExtensionMigrationV1 | null,
  now: string,
): { state: CodeRuntimeStateV2; changed: boolean } {
  const current = parseCodeRuntimeStateV2(currentInput);
  if (!migration) return { state: current, changed: false };
  const repositoryProfiles = { ...current.repositoryProfiles };
  let changed = false;
  const migratedProfileKeys = Object.keys(migration.repositoryProfiles.profiles).sort();
  for (const key of migratedProfileKeys) {
    const source = migration.repositoryProfiles.profiles[key];
    const profile = migrateRepositoryProfileV1(source);
    const expected: CodeRepositoryProfileRecordV2 = {
      version: 2,
      source: "migrated_repository_profile_v1",
      sourceFingerprint: sha256Canonical(source),
      trustedAt: current.repositoryProfiles[key]?.trustedAt ?? now,
      profile,
    };
    const existing = repositoryProfiles[key];
    if (!existing) {
      repositoryProfiles[key] = expected;
      changed = true;
      continue;
    }
    if (
      existing.source !== expected.source ||
      existing.sourceFingerprint !== expected.sourceFingerprint ||
      sha256Canonical(existing.profile) !== sha256Canonical(expected.profile)
    ) {
      throw new Error(`Migrated RepositoryProfileV1 conflict for ${key}.`);
    }
  }
  const nextMigration: CodeRuntimeMigrationV2 = {
    version: 1,
    migrationId: migration.migrationId,
    snapshotHash: migration.snapshotHash,
    migratedProfileKeys,
    verifiedAt: current.migration?.verifiedAt ?? now,
  };
  if (!current.migration || sha256Canonical(current.migration) !== sha256Canonical(nextMigration)) {
    if (
      current.migration &&
      (current.migration.migrationId !== migration.migrationId ||
        current.migration.snapshotHash !== migration.snapshotHash)
    ) throw new Error("Code runtime migration source changed after verification.");
    changed = true;
  }
  const state = parseCodeRuntimeStateV2({
    ...current,
    repositoryProfiles,
    migration: nextMigration,
    updatedAt: changed ? now : current.updatedAt,
  });
  return { state, changed };
}

function parsePersistedExtensionMigration(value: unknown): PersistedExtensionMigrationV1 | null {
  if (value === undefined || value === null) return null;
  const record = plainRecord(value, "extension state migration");
  if (record.version !== 1 || record.namespace !== "code") return null;
  const snapshot = plainRecord(record.snapshot, "code extension migration snapshot");
  if (snapshot.schemaVersion !== 1) throw new Error("Unsupported code extension migration snapshot version.");
  const snapshotHash = fingerprint(record.snapshotHash, "migration snapshot hash");
  if (sha256Canonical(snapshot) !== snapshotHash) {
    throw new Error("Code capability migration snapshot does not match its verified hash.");
  }
  return {
    migrationId: fingerprint(record.migrationId, "migration id"),
    snapshotHash,
    repositoryProfiles: parseRepositoryProfileRegistry(snapshot.repositoryProfiles),
  };
}

function parseProfileRecord(value: unknown, label: string): CodeRepositoryProfileRecordV2 {
  const record = exactRecord(value, ["version", "source", "sourceFingerprint", "trustedAt", "profile"], label);
  if (record.version !== 2) throw new Error(`${label} has an unsupported version.`);
  if (
    record.source !== "migrated_repository_profile_v1" &&
    record.source !== "detected_raw_exact_approval"
  ) throw new Error(`${label} has an invalid trust source.`);
  return {
    version: 2,
    source: record.source,
    sourceFingerprint: fingerprint(record.sourceFingerprint, `${label} source fingerprint`),
    trustedAt: isoTimestamp(record.trustedAt, `${label} trustedAt`),
    profile: parseRepositoryProfileV2(record.profile),
  };
}

function parseRuntimeMigration(value: unknown): CodeRuntimeMigrationV2 {
  const record = exactRecord(value, ["version", "migrationId", "snapshotHash", "migratedProfileKeys", "verifiedAt"], "code runtime migration");
  if (record.version !== 1 || !Array.isArray(record.migratedProfileKeys)) {
    throw new Error("Code runtime migration record is invalid.");
  }
  const keys = record.migratedProfileKeys.map((key) => boundedIdentifier(key, "migrated profile key"));
  if (keys.length > 256 || new Set(keys).size !== keys.length || [...keys].sort().join("\0") !== keys.join("\0")) {
    throw new Error("Migrated profile keys must be unique, sorted, and bounded.");
  }
  return {
    version: 1,
    migrationId: fingerprint(record.migrationId, "migration id"),
    snapshotHash: fingerprint(record.snapshotHash, "migration snapshot hash"),
    migratedProfileKeys: keys,
    verifiedAt: isoTimestamp(record.verifiedAt, "migration verifiedAt"),
  };
}

function parsePersistedProbe(value: unknown): PersistedSandboxProbeV2 {
  const record = exactRecord(value, ["version", "observedAt", "status"], "persisted sandbox probe");
  if (record.version !== 1) throw new Error("Persisted sandbox probe version is invalid.");
  return {
    version: 1,
    observedAt: isoTimestamp(record.observedAt, "sandbox probe observedAt"),
    status: parseSandboxCapabilityStatus(record.status),
  };
}

function parseSandboxCapabilityStatus(value: unknown): SandboxCapabilityStatusV2 {
  const record = exactRecord(value, ["version", "mode", "executionAvailable", "editingAvailable", "selectedProvider", "providers", "blocker"], "sandbox capability status");
  if (
    record.version !== 1 ||
    (record.mode !== "editing_only" && record.mode !== "sandbox_verified") ||
    typeof record.executionAvailable !== "boolean" ||
    record.editingAvailable !== true ||
    !Array.isArray(record.providers) ||
    record.providers.length > 4
  ) throw new Error("Sandbox capability status is invalid.");
  const providerKinds = ["docker", "podman", "wsl2", "bubblewrap"] as const;
  const providers = record.providers.map((value, index) => {
    const provider = exactRecord(
      value,
      ["provider", "state", "diagnostic", "probeFingerprint", "checkedAt"],
      `sandbox provider status ${index + 1}`,
    );
    if (
      !providerKinds.includes(provider.provider as typeof providerKinds[number]) ||
      !["unprobed", "verified", "unavailable", "rejected"].includes(String(provider.state)) ||
      typeof provider.diagnostic !== "string" ||
      provider.diagnostic.length < 1 ||
      provider.diagnostic.length > 2_000
    ) throw new Error("Sandbox provider status is invalid.");
    const checkedAt = provider.checkedAt === null
      ? null
      : isoTimestamp(provider.checkedAt, "sandbox provider checkedAt");
    const probeFingerprint = provider.probeFingerprint === null
      ? null
      : fingerprint(provider.probeFingerprint, "sandbox provider probe fingerprint");
    if ((provider.state === "verified") !== (probeFingerprint !== null)) {
      throw new Error("Only verified sandbox providers may retain a probe fingerprint.");
    }
    return {
      provider: provider.provider as typeof providerKinds[number],
      state: provider.state as "unprobed" | "verified" | "unavailable" | "rejected",
      diagnostic: provider.diagnostic,
      probeFingerprint,
      checkedAt,
    };
  });
  if (new Set(providers.map((provider) => provider.provider)).size !== providers.length) {
    throw new Error("Persisted sandbox provider statuses must be unique.");
  }
  const selectedProvider = record.selectedProvider === null
    ? null
    : providerKinds.includes(record.selectedProvider as typeof providerKinds[number])
      ? record.selectedProvider as typeof providerKinds[number]
      : (() => { throw new Error("Selected sandbox provider is invalid."); })();
  const blocker = record.blocker === null
    ? null
    : parsePersistedSandboxBlocker(record.blocker);
  if (
    (record.mode === "sandbox_verified") !== record.executionAvailable ||
    (selectedProvider !== null) !== record.executionAvailable ||
    (blocker === null) !== record.executionAvailable ||
    (selectedProvider !== null && !providers.some(
      (provider) => provider.provider === selectedProvider && provider.state === "verified",
    ))
  ) throw new Error("Persisted sandbox capability invariants are invalid.");
  // This is diagnostic history only. It is never used to rehydrate verified
  // execution state; the live SandboxManager must probe again after restart.
  return {
    version: 1,
    mode: record.mode,
    executionAvailable: record.executionAvailable,
    editingAvailable: true,
    selectedProvider,
    providers,
    blocker,
  };
}

function parsePersistedSandboxBlocker(value: unknown): NonNullable<SandboxCapabilityStatusV2["blocker"]> {
  const record = exactRecord(
    value,
    ["version", "code", "message", "requiredAction", "retryable", "editingAvailable", "executionAvailable", "fingerprint"],
    "persisted sandbox blocker",
  );
  const codes = [
    "sandbox_provider_unavailable",
    "sandbox_boundary_probe_failed",
    "sandbox_authorization_required",
    "sandbox_runtime_digest_required",
    "sandbox_staging_mismatch",
    "sandbox_staging_transport_unsupported",
    "sandbox_execution_failed",
    "sandbox_artifact_readback_failed",
  ] as const;
  if (
    record.version !== 1 ||
    !codes.includes(record.code as typeof codes[number]) ||
    typeof record.message !== "string" ||
    record.message.length < 1 ||
    record.message.length > 2_000 ||
    typeof record.requiredAction !== "string" ||
    record.requiredAction.length < 1 ||
    record.requiredAction.length > 2_000 ||
    typeof record.retryable !== "boolean" ||
    record.editingAvailable !== true ||
    record.executionAvailable !== false
  ) throw new Error("Persisted sandbox blocker is invalid.");
  return {
    version: 1,
    code: record.code as typeof codes[number],
    message: record.message,
    requiredAction: record.requiredAction,
    retryable: record.retryable,
    editingAvailable: true,
    executionAvailable: false,
    fingerprint: fingerprint(record.fingerprint, "sandbox blocker fingerprint"),
  };
}

async function inventoryRepository(repositoryRoot: string): Promise<RepositoryInventoryV2> {
  const files: string[] = [];
  const fileContents: Record<string, string> = {};
  const fileHashes: Record<string, string> = {};
  let visited = 0;
  const visit = async (folder: string, relativeFolder: string, depth: number): Promise<void> => {
    if (depth > MAX_PROFILE_INVENTORY_DEPTH) throw new Error("Repository marker inventory exceeds depth 32.");
    const entries = await fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      visited += 1;
      if (visited > MAX_PROFILE_INVENTORY_ENTRIES) {
        throw new Error("Repository marker inventory exceeds 20,000 entries.");
      }
      const relative = relativeFolder ? `${relativeFolder}/${entry.name}` : entry.name;
      const absolute = path.join(folder, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        if (IGNORED_INVENTORY_DIRECTORIES.has(entry.name.toLowerCase())) continue;
        await visit(absolute, relative, depth + 1);
        continue;
      }
      if (!stat.isFile()) continue;
      if (stat.nlink > 1) throw new Error(`Repository marker inventory rejects hard-linked files: ${relative}.`);
      const normalized = assertWorkspaceRelativePathV2(relative, "repository inventory path");
      files.push(normalized);
      if (PIN_BASENAMES.has(entry.name) && stat.size <= MAX_PIN_BYTES) {
        const bytes = await fs.readFile(absolute);
        const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (content.includes("\0")) throw new Error(`Repository pin file is binary: ${relative}.`);
        fileContents[normalized] = content;
        fileHashes[normalized] = sha256Bytes(bytes);
      }
    }
  };
  await visit(repositoryRoot, "", 0);
  files.sort();
  if (files.length < 1) throw new Error("Repository marker inventory is empty.");
  return {
    files,
    fileContents,
    fileHashes,
    fingerprint: sha256Canonical({ files, fileHashes }),
  };
}

function assertRequiredCodeContributions(contributions: readonly ExtensionContributionV1[]): void {
  const tools = new Set(
    contributions
      .filter((item) => item.descriptor.kind === "tool")
      .map((item) => (item as Extract<ExtensionContributionV1, { descriptor: { kind: "tool" } }>).tool.name),
  );
  const required = [
    ...CODE_WORKSPACE_TOOL_NAMES_V2,
    ...CODE_EXECUTION_TOOL_NAMES_V2,
    PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
  ];
  const missing = required.filter((name) => !tools.has(name));
  if (missing.length > 0) throw new Error(`Code capability is missing required tool contributions: ${missing.join(", ")}.`);
}

function topLevelRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return plainRecord(value, "code extension plugin data");
}

function assertTopLevelSchema(record: Record<string, unknown>): void {
  if (record.schemaVersion !== undefined && record.schemaVersion !== 1) {
    throw new Error(`Unsupported code extension plugin-data schema: ${String(record.schemaVersion)}.`);
  }
}

function assertPreservedMigration(before: Record<string, unknown>, after: Record<string, unknown>): void {
  if (
    Object.prototype.hasOwnProperty.call(before, "extensionStateMigration") &&
    sha256Canonical(before.extensionStateMigration) !== sha256Canonical(after.extensionStateMigration)
  ) throw new Error("Code runtime persistence changed the top-level extension migration snapshot.");
}

function exactRecord(value: unknown, keys: readonly string[], label: string): Record<string, unknown> {
  const record = plainRecord(value, label);
  const expected = new Set(keys);
  const unknown = Object.keys(record).filter((key) => !expected.has(key));
  const missing = keys.filter((key) => !Object.prototype.hasOwnProperty.call(record, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`${label} keys are invalid (unknown: ${unknown.join(", ") || "none"}; missing: ${missing.join(", ") || "none"}).`);
  }
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label} must be a plain object.`);
  return value as Record<string, unknown>;
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function isoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || new Date(Date.parse(value)).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp.`);
  }
  return value;
}

function boundedIdentifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  ) throw new Error(`${label} is invalid.`);
  return value;
}

function parseBackgroundMissionBindingRoute(value: unknown): {
  requestId: string;
  workspaceId: string;
} | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join("\u0000") !==
      ["objective", "toolName"].sort().join("\u0000") ||
    record.toolName !== PREPARED_BACKGROUND_CODE_TOOL_NAME_V1 ||
    typeof record.objective !== "string" ||
    !record.objective.trim() ||
    record.objective.length > 24_000 ||
    record.objective.includes("\u0000")
  ) return null;

  const identifierPattern = "([A-Za-z0-9][A-Za-z0-9._:-]{0,127})";
  const header = new RegExp(
    `Execute explicit code repair request ${identifierPattern} in trusted workspace ${identifierPattern}\\.`,
    "gu",
  );
  const requestMarker = new RegExp(
    `Use repairRequestId ${identifierPattern} for every validation, repair-cycle, status, and commit call\\.`,
    "gu",
  );
  const headerMatches = [...record.objective.matchAll(header)];
  const requestMatches = [...record.objective.matchAll(requestMarker)];
  if (
    headerMatches.length !== 1 ||
    requestMatches.length !== 1 ||
    headerMatches[0][1] !== requestMatches[0][1]
  ) return null;
  return {
    requestId: headerMatches[0][1],
    workspaceId: headerMatches[0][2],
  };
}

function gitObjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) {
    throw new Error(`${label} must be a canonical Git object id.`);
  }
  return value;
}

function reviewRepairObjective(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 20_000 ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) throw new Error("GitHub review objective is empty, too long, or contains control characters.");
  const authorityField = /(?:^|\n)\s*(?:[-*]\s*)?(?:["']?(?:path|file(?:path)?|directory|cwd|command|cmd|shell|args?|env(?:ironment)?|token|secret|password|api[_ -]?key|credential|repository|repo|owner|branch|base|head|profile|binding|authority|grant|capability|approval|permission)["']?)\s*[:=]/iu;
  const activePathOrCommand = /(?:^|[\s('"`])(?:\.\.?[/\\]|[A-Za-z]:[/\\]|\.git(?:[/\\]|\b))|```\s*(?:bash|bat|cmd|powershell|ps1|sh|shell)\b|(?:^|\n)\s*(?:\$|>|PS>)\s+/iu;
  const credentialMaterial = /\b(?:lin_api_[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|bearer\s+[A-Za-z0-9._~+/-]{12,})\b/iu;
  if (authorityField.test(value) || activePathOrCommand.test(value) || credentialMaterial.test(value)) {
    throw new Error("GitHub review objective may not supply paths, commands, credentials, repository mappings, or authority.");
  }
  return value;
}

function sandboxProviderKind(value: unknown): SandboxProviderConfigV2["kind"] {
  if (value !== "docker" && value !== "podman" && value !== "wsl2" && value !== "bubblewrap") {
    throw new Error("Sandbox provider kind is invalid.");
  }
  return value;
}

async function canonicalSafeDirectory(value: string): Promise<string> {
  if (!path.isAbsolute(value)) throw new Error("Repository root must be absolute.");
  const stat = await fs.lstat(value);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Repository root must be a safe directory.");
  return fs.realpath(value);
}

function pathAtOrBelow(root: string, candidate: string): boolean {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function selectForegroundValidationCommand(
  profile: RepositoryProfileV2,
  projectId: string,
  purpose: PreparedSandboxActionV2["purpose"],
): RepositoryValidationCommandV2 {
  const catalog = profile.validationCatalog
    .filter((command) => command.projectId === projectId)
    .sort((left, right) => left.id.localeCompare(right.id));
  const exactPhase = purpose === "validation_fast"
    ? "fast"
    : purpose === "validation_targeted" || purpose === "code_block"
      ? "targeted"
      : purpose === "validation_full"
        ? "full"
        : "bootstrap";
  const exact = catalog.filter((command) => command.phase === exactPhase);
  const legacyFull = catalog.filter((command) => command.phase === "full");
  const isLegacyV1Catalog = legacyFull.length > 0 && legacyFull.every((command) =>
    /^root-full-\d+$/u.test(command.id),
  );
  if (
    isLegacyV1Catalog &&
    (purpose === "validation_fast" || purpose === "validation_targeted" || purpose === "validation_full")
  ) {
    return purpose === "validation_full"
      ? legacyFull.at(-1)!
      : legacyFull[0];
  }
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_validation_command_ambiguous",
      `The trusted repository profile has multiple ${exactPhase} commands for project ${projectId}.`,
    );
  }
  if (
    legacyFull.length === 1 &&
    (purpose === "validation_fast" || purpose === "validation_targeted" || purpose === "validation_full")
  ) {
    return legacyFull[0];
  }

  throw new CodeSandboxContributionErrorV2(
    "sandbox_validation_command_unavailable",
    `The trusted repository profile has no unambiguous ${exactPhase} command for project ${projectId}.`,
  );
}

function contextRunId(context: ScopedExtensionContextV1): string {
  return context.rootMissionId ?? context.missionId ?? context.operationId ?? "adhoc";
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function sha256Canonical(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
}

function sha256Bytes(value: Uint8Array): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
