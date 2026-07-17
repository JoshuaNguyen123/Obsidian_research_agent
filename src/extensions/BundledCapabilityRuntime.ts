import { Notice, type Plugin } from "obsidian";
import {
  AGENTIC_RESEARCHER_COMPANION_RECONCILE_EVENT,
  AGENTIC_RESEARCHER_CORE_API_MAJOR,
  AGENTIC_RESEARCHER_CORE_API_MINOR,
  type AgenticResearcherCoreApiV1,
  type ExtensionContributionV1,
  type ExtensionRegistrationTokenV1,
  type ExtensionStateMigrationOfferV1,
} from "../../packages/core-api/src";
import { createSessionBootstrapTokenLeaseV1 } from "../../packages/headless-runtime/src";
import type { VerifiedCodePublicationHandoffV1 } from "../../packages/core-api/src";
import {
  CODE_EXTENSION_VERSION_V2,
  CodeExtensionRuntimeV2,
  type CodeReviewRepairBaseResolutionInputV1,
  type CodeReviewRepairPipelineInputV1,
} from "../../extensions/code/CodeExtensionRuntimeV2";
import { SandboxProviderConfigurationModal } from "../../extensions/code/main";
import type { CodeRepairRequestV1 } from "../../extensions/code/repair";
import type { RepositoryProfileV2 } from "../../extensions/code/repositories";
import type {
  SandboxCapabilityStatusV2,
  SandboxProviderConfigV2,
} from "../../extensions/code/sandbox/SandboxManager";
import type {
  PrepareBackgroundValidationCommitApprovalInputV1,
  PrepareBackgroundValidationCommitApprovalResultV1,
  SealBackgroundValidationCommitPackageInputV1,
  SealBackgroundValidationCommitPackageResultV1,
} from "../../extensions/code/background";
import {
  CompanionExtensionCoordinatorV1,
  type CompanionSessionConfigurationV1,
} from "../../extensions/companion/CompanionExtensionCoordinator";
import {
  CompanionServiceControllerV1,
  type CompanionServiceCommandResultV1,
} from "../../extensions/companion/CompanionServiceController";
import {
  createCompanionReplayContribution,
  createCompanionStatusContribution,
} from "../../extensions/companion/main";
import {
  PreparedBackgroundGitHubHostV1,
  createPreparedBackgroundGitHubToolContributionsV1,
  type ApplyVerifiedBackgroundGitHubResultInputV1,
  type PrepareBackgroundGitHubApprovalInputV1,
  type SealBackgroundGitHubPackageInputV1,
  type SynchronizeBackgroundGitHubHostStateInputV1,
} from "../../extensions/integrations/host";
import type { PreparedBackgroundGitHubToolNameV1 } from "../../packages/core-api/src";
import {
  createCompatibilityBridgeContribution,
  createMigrationStatusContribution,
  createScaffoldSettingsContribution,
  createScaffoldStatusContribution,
  persistMigrationSnapshot,
  withPluginDataLock,
} from "../../extensions/shared/softDependency";
import { requireNodeModule } from "../platform/nodeRequire";

const CODE_ID = "agentic-researcher-code" as const;
const INTEGRATIONS_ID = "agentic-researcher-integrations" as const;
const COMPANION_ID = "agentic-researcher-companion" as const;
const BUNDLED_VERSION = "0.4.0";

type CapabilityPluginDataPort = Pick<Plugin, "loadData" | "saveData"> & {
  app: Plugin["app"];
};

export type CodeReviewRepairBridgeResultV1 =
  | { status: "verified"; handoff: VerifiedCodePublicationHandoffV1 }
  | {
      status: "blocked";
      blocker: {
        code: string;
        message: string;
        evidenceFingerprint: string | null;
      };
    };

interface BundledCapabilityRegistrationOptions {
  api: AgenticResearcherCoreApiV1;
  dataPlugin: CapabilityPluginDataPort;
  migrationOffer: ExtensionStateMigrationOfferV1;
}

export interface BundledCodeCapabilityOptions
  extends BundledCapabilityRegistrationOptions {
  host: Plugin;
  runMission(prompt: string): Promise<unknown>;
  runReviewRepairMission(prompt: string): Promise<unknown>;
}

/** Built-in Code capability. It keeps its scoped state and contribution API. */
export class BundledCodeCapability {
  public readonly runtime: CodeExtensionRuntimeV2;
  private token: ExtensionRegistrationTokenV1 | null = null;
  private probeController: AbortController | null = null;
  private probeInFlight: Promise<void> | null = null;

  constructor(private readonly options: BundledCodeCapabilityOptions) {
    this.runtime = new CodeExtensionRuntimeV2({
      plugin: options.dataPlugin as Plugin,
    });
  }

  async initialize(): Promise<void> {
    const migration = await persistBundledMigrationSnapshot(
      this.options.dataPlugin as Plugin,
      this.options.migrationOffer,
    );
    await this.runtime.initialize();
    this.registerCommands();
    let migrationStatus = "copying";
    let migrationMessage = "Verifying bundled Code state.";
    const token = this.options.api.registerExtension({
      manifest: {
        id: CODE_ID,
        displayName: "Agentic Researcher Code",
        version: BUNDLED_VERSION,
        apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
        apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      },
      contributions: [
        createCompatibilityBridgeContribution(CODE_ID),
        ...this.runtime.getContributions(),
        createMigrationStatusContribution(CODE_ID, () => ({
          status: migrationStatus,
          message: migrationMessage,
        })),
      ],
    });
    this.token = token;
    try {
      const result = await this.options.api.acknowledgeStateMigration(token, {
        version: 1,
        migrationId: migration.migrationId,
        namespace: migration.namespace,
        snapshot: migration.snapshot,
        acknowledgedAt: migration.acknowledgedAt,
      });
      migrationStatus =
        result.pendingSecureImportKinds.length > 0
          ? "secure_import_pending"
          : "verified";
      migrationMessage =
        result.pendingSecureImportKinds.length > 0
          ? `Bundled Code state is verified; secure import remains pending for ${result.pendingSecureImportKinds.join(", ")}.`
          : "Bundled Code state is verified inside Agentic Researcher.";
    } catch (error) {
      this.options.api.unregisterExtension(token, "bundled_code_migration_failed");
      this.token = null;
      throw error;
    }
  }

  dispose(): void {
    this.probeController?.abort("bundled_code_unload");
    this.probeController = null;
    this.probeInFlight = null;
    if (this.token) {
      this.options.api.unregisterExtension(this.token, "bundled_code_unload");
      this.token = null;
    }
  }

  async runCodeRepair(input: CodeRepairRequestV1): Promise<unknown> {
    const prompt = await this.runtime.createForegroundRepairMissionPrompt(input);
    return this.options.runMission(prompt);
  }

  async prepareBackgroundValidationCommitApproval(
    input: PrepareBackgroundValidationCommitApprovalInputV1,
  ): Promise<PrepareBackgroundValidationCommitApprovalResultV1> {
    return this.runtime.prepareBackgroundValidationCommitApproval(input);
  }

  async resolveBackgroundMissionBinding(input: {
    objective: string;
    toolName: "code_validate_commit_prepared";
  }): Promise<{
    id: string;
    kind: "prepared_validation_commit";
    destinationFingerprint: string;
    allowedEffects: ["read", "execution"];
  } | null> {
    return this.runtime.resolveBackgroundMissionBinding(input);
  }

  async sealBackgroundValidationCommitPackage(
    input: SealBackgroundValidationCommitPackageInputV1,
  ): Promise<SealBackgroundValidationCommitPackageResultV1> {
    return this.runtime.sealBackgroundValidationCommitPackage(input);
  }

  async resolveVerifiedCodePublicationHandoff(
    profileKey: string,
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    return this.runtime.resolveLatestVerifiedPublicationHandoff(profileKey);
  }

  async resolveTrustedRepositoryProfile(
    profileKey: string,
  ): Promise<RepositoryProfileV2 | null> {
    return this.runtime.getRepositoryProfile(profileKey);
  }

  async createTrustedQueueCodeMissionPrompt(input: {
    runId: string;
    workspaceId: string;
    profileKey: string;
    requestId: string;
    objective: string;
    commitMessage: string;
  }): Promise<string> {
    return this.runtime.createTrustedQueueCodeMissionPrompt(input);
  }

  async resolveVerifiedQueueCodeHandoff(input: {
    profileKey: string;
    runId: string;
    requestId: string;
  }): Promise<VerifiedCodePublicationHandoffV1 | null> {
    return this.runtime.resolveLatestVerifiedPublicationHandoff(input.profileKey, {
      runId: input.runId,
      requestId: input.requestId,
    });
  }

  async resolveVerifiedReviewRepairBase(
    input: CodeReviewRepairBaseResolutionInputV1,
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    return this.runtime.resolveVerifiedReviewRepairBase(input);
  }

  async resolveVerifiedReviewRepairResult(input: {
    repairRequestId: string;
    runId: string;
    profileKey: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<CodeReviewRepairBridgeResultV1 | null> {
    const handoff = await this.runtime.resolveVerifiedReviewRepairResult(input);
    return handoff ? { status: "verified", handoff } : null;
  }

  async runVerifiedReviewRepairPipeline(
    input: CodeReviewRepairPipelineInputV1,
  ): Promise<CodeReviewRepairBridgeResultV1> {
    const existing = await this.runtime.resolveVerifiedReviewRepairResult(input);
    if (existing) return { status: "verified", handoff: existing };
    const prompt = await this.runtime.createVerifiedReviewRepairMissionPrompt(input);
    await this.options.runReviewRepairMission(prompt);
    const handoff = await this.runtime.resolveVerifiedReviewRepairResult(input);
    if (handoff) return { status: "verified", handoff };
    return {
      status: "blocked",
      blocker: {
        code: "review_repair_pipeline_incomplete",
        message:
          "The normal durable code-repair mission ended without a verified local commit handoff.",
        evidenceFingerprint: input.reviewEvidenceFingerprint,
      },
    };
  }

  readState() {
    return this.runtime.readState();
  }

  getSandboxCapabilityStatus(): SandboxCapabilityStatusV2 {
    return this.runtime.getSandboxCapabilityStatus();
  }

  readCapabilityState() {
    return this.runtime.readState();
  }

  async loadData(): Promise<unknown> {
    return this.options.dataPlugin.loadData();
  }

  async saveData(value: unknown): Promise<void> {
    await this.options.dataPlugin.saveData(value);
  }

  async configureSandboxProvider(
    input: SandboxProviderConfigV2,
  ) {
    return this.runtime.configureSandboxProvider(input);
  }

  async removeSandboxProvider(
    kind: SandboxProviderConfigV2["kind"],
  ) {
    return this.runtime.removeSandboxProvider(kind);
  }

  async probeConfiguredSandboxProviders(
    signal?: AbortSignal,
  ): Promise<SandboxCapabilityStatusV2> {
    return this.runtime.probeConfiguredSandboxProviders(signal);
  }

  private registerCommands(): void {
    this.options.host.addCommand({
      id: "probe-sandbox-boundaries",
      name: "Code: Probe configured sandbox boundaries",
      callback: () => this.probeSandboxBoundaries(),
    });
    this.options.host.addCommand({
      id: "configure-sandbox-provider",
      name: "Code: Configure immutable sandbox provider",
      callback: () =>
        new SandboxProviderConfigurationModal(
          this.options.host,
          this.runtime,
        ).open(),
    });
  }

  private probeSandboxBoundaries(): void {
    if (this.probeInFlight) {
      new Notice("A code sandbox boundary probe is already running.");
      return;
    }
    const controller = new AbortController();
    this.probeController = controller;
    this.probeInFlight = this.runtime
      .probeConfiguredSandboxProviders(controller.signal)
      .then((status) => {
        new Notice(
          status.executionAvailable
            ? `Code sandbox verified through ${status.selectedProvider}.`
            : "No configured sandbox provider passed its boundary probe. Editing remains available; generated-code execution is blocked.",
          status.executionAvailable ? 5_000 : 8_000,
        );
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          new Notice(
            `Code sandbox probe failed: ${safeNoticeError(error)}`,
            8_000,
          );
        }
      })
      .finally(() => {
        if (this.probeController === controller) this.probeController = null;
        this.probeInFlight = null;
      });
  }
}

export interface BundledCompanionCapabilityOptions
  extends BundledCapabilityRegistrationOptions {
  host: Plugin;
}

/** Built-in Companion controller; the Python service remains a separate process. */
export class BundledCompanionCapability {
  public readonly companionCoordinator = new CompanionExtensionCoordinatorV1();
  private token: ExtensionRegistrationTokenV1 | null = null;
  private serviceController: CompanionServiceControllerV1 | null = null;

  constructor(private readonly options: BundledCompanionCapabilityOptions) {}

  async initialize(): Promise<void> {
    const migration = await persistBundledMigrationSnapshot(
      this.options.dataPlugin as Plugin,
      this.options.migrationOffer,
    );
    this.serviceController = this.createServiceController();
    this.companionCoordinator.configurePersistence({
      load: () =>
        withPluginDataLock(this.options.dataPlugin as Plugin, async () => {
          const data = asRecord(await this.options.dataPlugin.loadData());
          return data.companionRuntimeState;
        }),
      save: (state) =>
        withPluginDataLock(this.options.dataPlugin as Plugin, async () => {
          const current = asRecord(await this.options.dataPlugin.loadData());
          await this.options.dataPlugin.saveData({
            ...current,
            companionRuntimeState: state,
          });
        }),
    });
    this.registerCommands();
    let migrationStatus = "copying";
    let migrationMessage = "Verifying bundled Companion state.";
    const token = this.options.api.registerExtension({
      manifest: {
        id: COMPANION_ID,
        displayName: "Agentic Researcher Companion",
        version: BUNDLED_VERSION,
        apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
        apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      },
      contributions: [
        createCompatibilityBridgeContribution(COMPANION_ID),
        createScaffoldSettingsContribution({
          id: COMPANION_ID,
          displayName: "Background service",
          title: "Authenticated local companion",
          fields: [
            {
              id: "background_continuation",
              type: "boolean",
              label: "Background continuation",
              description:
                "Available after explicit service installation and secure OS credential-store readback.",
              defaultValue: false,
            },
            {
              id: "credential_backend",
              type: "select",
              label: "Credential backend",
              description:
                "Background work is blocked unless the companion verifies a persistent OS credential backend.",
              defaultValue: "not_configured",
              options: [
                { label: "Not configured", value: "not_configured" },
                { label: "OS credential store", value: "os_credential_store" },
              ],
            },
          ],
        }),
        createCompanionStatusContribution(this.companionCoordinator),
        createCompanionReplayContribution(this.companionCoordinator),
        createMigrationStatusContribution(COMPANION_ID, () => ({
          status: migrationStatus,
          message: migrationMessage,
        })),
      ],
    });
    this.token = token;
    try {
      const result = await this.options.api.acknowledgeStateMigration(token, {
        version: 1,
        migrationId: migration.migrationId,
        namespace: migration.namespace,
        snapshot: migration.snapshot,
        acknowledgedAt: migration.acknowledgedAt,
      });
      migrationStatus = "verified";
      migrationMessage =
        result.pendingSecureImportKinds.length > 0
          ? `Bundled Companion state is verified; secure import remains pending for ${result.pendingSecureImportKinds.join(", ")}.`
          : "Bundled Companion state is verified inside Agentic Researcher.";
      void this.restoreCompanionRuntime();
    } catch (error) {
      this.options.api.unregisterExtension(token, "bundled_companion_migration_failed");
      this.token = null;
      throw error;
    }
  }

  dispose(): void {
    this.companionCoordinator.clearSession();
    if (this.token) {
      this.options.api.unregisterExtension(
        this.token,
        "bundled_companion_unload",
      );
      this.token = null;
    }
    this.serviceController = null;
  }

  configureCompanionSession(
    configuration: CompanionSessionConfigurationV1,
  ): void {
    this.companionCoordinator.configureSession(configuration);
    this.requestCoreReconciliation();
  }

  async pairForegroundCompanion(input: {
    baseUrl: string;
    acquireBootstrapToken: () => Promise<string>;
    fetchImpl?: typeof fetch;
  }): Promise<void> {
    const token = await input.acquireBootstrapToken();
    const credential = createSessionBootstrapTokenLeaseV1(token, {
      source: "session_memory",
      persistent: false,
    });
    try {
      this.companionCoordinator.configureSession({
        baseUrl: input.baseUrl,
        credential,
        fetchImpl: input.fetchImpl,
      });
      const snapshot = await this.waitForCompanionReady(true);
      if (!snapshot.health?.ok || !snapshot.health.workerReady) {
        this.companionCoordinator.clearSession();
        throw new Error(
          snapshot.lastError ?? "Companion health verification failed.",
        );
      }
      this.requestCoreReconciliation();
    } catch (error) {
      credential.dispose();
      throw error;
    }
  }

  async installCompanionService(): Promise<CompanionServiceCommandResultV1> {
    const controller = this.requireServiceController();
    const result = await controller.install();
    await this.connectCompanionService();
    await this.companionCoordinator.setServiceInstalled(true, controller.baseUrl);
    return result;
  }

  async connectCompanionService(): Promise<void> {
    const controller = this.requireServiceController();
    const credential = await controller.connectCredential();
    try {
      this.companionCoordinator.configureSession({
        baseUrl: controller.baseUrl,
        credential,
      });
      const snapshot = await this.companionCoordinator.refreshHealth();
      if (!snapshot.health?.ok) {
        this.companionCoordinator.clearSession();
        throw new Error(
          snapshot.lastError ?? "Companion health verification failed.",
        );
      }
      await this.companionCoordinator.setServiceInstalled(
        true,
        controller.baseUrl,
      );
      await this.companionCoordinator.reconcilePersistedJobs();
      this.requestCoreReconciliation();
    } catch (error) {
      credential.dispose();
      throw error;
    }
  }

  async readCompanionServiceStatus(): Promise<CompanionServiceCommandResultV1> {
    return this.requireServiceController().status();
  }

  async provisionHostApprovalSigner(): Promise<string> {
    const description =
      await this.companionCoordinator.provisionHostApprovalSigner();
    if (
      !description.persistent ||
      !description.provisioned ||
      !description.signingKeyFingerprint
    ) {
      throw new Error(
        "Companion did not verify a persistent host approval signing key.",
      );
    }
    return description.signingKeyFingerprint;
  }

  async rotateHostApprovalSigner(): Promise<string> {
    const description = await this.companionCoordinator.rotateHostApprovalSigner();
    if (
      !description.persistent ||
      !description.provisioned ||
      !description.signingKeyFingerprint
    ) {
      throw new Error(
        "Companion did not verify the rotated host approval signing key.",
      );
    }
    return description.signingKeyFingerprint;
  }

  async removeCompanionService(
    removeBootstrapToken = false,
  ): Promise<CompanionServiceCommandResultV1> {
    this.companionCoordinator.clearSession();
    const result = await this.requireServiceController().remove({
      removeBootstrapToken,
    });
    await this.companionCoordinator.setServiceInstalled(false);
    return result;
  }

  async loadData(): Promise<unknown> {
    return this.options.dataPlugin.loadData();
  }

  async saveData(value: unknown): Promise<void> {
    await this.options.dataPlugin.saveData(value);
  }

  private createServiceController(): CompanionServiceControllerV1 | null {
    try {
      requireNodeModule<typeof import("path")>("path", "bundled_companion");
      return new CompanionServiceControllerV1({});
    } catch {
      return null;
    }
  }

  private requireServiceController(): CompanionServiceControllerV1 {
    if (!this.serviceController) {
      throw new Error(
        "Companion service control is available only in the desktop filesystem runtime.",
      );
    }
    return this.serviceController;
  }

  private requestCoreReconciliation(): void {
    this.options.host.app.workspace.trigger(
      AGENTIC_RESEARCHER_COMPANION_RECONCILE_EVENT,
    );
  }

  private async waitForCompanionReady(requireWorker: boolean) {
    const deadline = Date.now() + 45_000;
    let delayMs = 250;
    let latest = await this.companionCoordinator.refreshHealth();
    while (
      Date.now() < deadline &&
      !(
        latest.health?.ok &&
        latest.health.coordinatorReady &&
        (!requireWorker || latest.health.workerReady)
      )
    ) {
      await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
      delayMs = Math.min(3_000, Math.floor(delayMs * 1.7));
      latest = await this.companionCoordinator.refreshHealth();
    }
    if (
      !latest.health?.ok ||
      !latest.health.coordinatorReady ||
      (requireWorker && !latest.health.workerReady)
    ) {
      throw new Error(
        latest.health?.workerDiagnostic ??
          latest.lastError ??
          "Companion readiness timed out after 45 seconds.",
      );
    }
    return latest;
  }

  private async restoreCompanionRuntime(): Promise<void> {
    const state = await this.companionCoordinator.hydratePersistence();
    if (!state.serviceInstalled || !this.serviceController) return;
    try {
      await this.connectCompanionService();
    } catch {
      // Health/status contributions expose the resumable blocker.
    }
  }

  private registerCommands(): void {
    const command = (
      id: string,
      name: string,
      operation: string,
      execute: () => Promise<string>,
    ) => {
      this.options.host.addCommand({
        id,
        name,
        callback: () => void this.runUserCommand(operation, execute),
      });
    };
    command(
      "install-background-service",
      "Companion: Install background service",
      "install",
      async () => {
        const result = await this.installCompanionService();
        return `Companion installed (${result.platform}).`;
      },
    );
    command(
      "connect-background-service",
      "Companion: Connect authenticated service",
      "connect",
      async () => {
        await this.connectCompanionService();
        return "Authenticated companion service connected.";
      },
    );
    command(
      "show-background-service-status",
      "Companion: Show service status",
      "status",
      async () => {
        const result = await this.readCompanionServiceStatus();
        return `Companion service: installed=${String(result.installed ?? false)}, active=${String(result.active ?? false)}, platform=${result.platform}.`;
      },
    );
    command(
      "provision-host-approval-signer",
      "Companion: Provision approval signing key",
      "approval signer provision",
      async () => {
        const fingerprint = await this.provisionHostApprovalSigner();
        return `Companion approval signing key is ready (${fingerprint.slice(0, 23)}…).`;
      },
    );
    command(
      "rotate-host-approval-signer",
      "Companion: Rotate approval signing key",
      "approval signer rotation",
      async () => {
        const fingerprint = await this.rotateHostApprovalSigner();
        return `Companion approval signing key was rotated (${fingerprint.slice(0, 23)}…).`;
      },
    );
    command(
      "remove-background-service",
      "Companion: Remove background service",
      "remove",
      async () => {
        const result = await this.removeCompanionService(false);
        return `Companion service removed (${result.platform}); bootstrap credential retained.`;
      },
    );
    command(
      "remove-background-service-and-credential",
      "Companion: Remove service and bootstrap credential",
      "remove credential",
      async () => {
        const result = await this.removeCompanionService(true);
        return `Companion service and bootstrap credential removed (${result.platform}).`;
      },
    );
  }

  private async runUserCommand(
    operation: string,
    execute: () => Promise<string>,
  ): Promise<void> {
    try {
      new Notice(await execute(), 8_000);
    } catch (error) {
      new Notice(
        `Companion ${operation} failed: ${safeNoticeError(error)}`,
        12_000,
      );
    }
  }
}

export interface BundledIntegrationsCapabilityOptions
  extends BundledCapabilityRegistrationOptions {
  code: BundledCodeCapability;
}

/** Built-in integrations host with the same prepared-action contracts. */
export class BundledIntegrationsCapability {
  private token: ExtensionRegistrationTokenV1 | null = null;
  private host: PreparedBackgroundGitHubHostV1 | null = null;

  constructor(private readonly options: BundledIntegrationsCapabilityOptions) {}

  async initialize(): Promise<void> {
    const migration = await persistBundledMigrationSnapshot(
      this.options.dataPlugin as Plugin,
      this.options.migrationOffer,
    );
    const host = new PreparedBackgroundGitHubHostV1(
      this.options.dataPlugin as Plugin,
      { resolveCodeBridge: () => this.options.code },
    );
    await host.initialize();
    this.host = host;
    let migrationStatus = "copying";
    let migrationMessage = "Verifying bundled Integrations state.";
    const token = this.options.api.registerExtension({
      manifest: {
        id: INTEGRATIONS_ID,
        displayName: "Agentic Researcher Integrations",
        version: BUNDLED_VERSION,
        apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
        apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
      },
      contributions: [
        createCompatibilityBridgeContribution(INTEGRATIONS_ID),
        ...createPreparedBackgroundGitHubToolContributionsV1(host),
        createScaffoldSettingsContribution({
          id: INTEGRATIONS_ID,
          displayName: "Integrations",
          title: "Linear and GitHub integrations",
          fields: [
            {
              id: "linear_state",
              type: "select",
              label: "Linear capability",
              description:
                "Linear and GitHub are built into Agentic Researcher and remain connection- and approval-gated.",
              defaultValue: "built_in",
              options: [{ label: "Built in", value: "built_in" }],
            },
            {
              id: "secure_credentials",
              type: "boolean",
              label: "Secure credential import",
              description:
                "Credentials remain opaque SecretStoreV1 references after persistent-store readback.",
              defaultValue: false,
            },
          ],
        }),
        createScaffoldStatusContribution({
          id: INTEGRATIONS_ID,
          displayName: "Integrations",
          summary:
            "Linear and GitHub capability code is built into Agentic Researcher; provider access remains disabled until configured and verified.",
        }),
        createMigrationStatusContribution(INTEGRATIONS_ID, () => ({
          status: migrationStatus,
          message: migrationMessage,
        })),
      ],
    });
    this.token = token;
    try {
      const result = await this.options.api.acknowledgeStateMigration(token, {
        version: 1,
        migrationId: migration.migrationId,
        namespace: migration.namespace,
        snapshot: migration.snapshot,
        acknowledgedAt: migration.acknowledgedAt,
      });
      migrationStatus =
        result.pendingSecureImportKinds.length > 0
          ? "secure_import_pending"
          : "verified";
      migrationMessage =
        result.pendingSecureImportKinds.length > 0
          ? `Bundled Integrations state is verified; secure import remains pending for ${result.pendingSecureImportKinds.join(", ")}.`
          : "Bundled Integrations state is verified inside Agentic Researcher.";
    } catch (error) {
      this.options.api.unregisterExtension(
        token,
        "bundled_integrations_migration_failed",
      );
      this.token = null;
      this.host = null;
      throw error;
    }
  }

  dispose(): void {
    if (this.token) {
      this.options.api.unregisterExtension(
        this.token,
        "bundled_integrations_unload",
      );
      this.token = null;
    }
    this.host = null;
  }

  synchronizeBackgroundGitHubHostState(
    input: SynchronizeBackgroundGitHubHostStateInputV1,
  ) {
    return this.requireHost().synchronize(input);
  }

  resolveBackgroundGitHubMissionBinding(input: {
    objective: string;
    toolName: PreparedBackgroundGitHubToolNameV1;
  }) {
    return this.requireHost().resolveMissionBinding(input);
  }

  prepareBackgroundGitHubApproval(input: PrepareBackgroundGitHubApprovalInputV1) {
    return this.requireHost().prepareApproval(input);
  }

  sealBackgroundGitHubPackage(input: SealBackgroundGitHubPackageInputV1) {
    return this.requireHost().sealPackage(input);
  }

  applyVerifiedBackgroundGitHubResult(
    input: ApplyVerifiedBackgroundGitHubResultInputV1,
  ) {
    return this.requireHost().applyVerifiedResult(input);
  }

  readBackgroundGitHubHostState() {
    return this.requireHost().readState();
  }

  private requireHost(): PreparedBackgroundGitHubHostV1 {
    if (!this.host) {
      throw new Error("The bundled integrations GitHub host is not ready.");
    }
    return this.host;
  }
}

export interface BundledCapabilitiesV1 {
  [CODE_ID]: BundledCodeCapability;
  [INTEGRATIONS_ID]: BundledIntegrationsCapability;
  [COMPANION_ID]: BundledCompanionCapability;
}

export function capabilityModuleEntries(
  capabilities: BundledCapabilitiesV1,
): Array<[string, unknown]> {
  return [
    [CODE_ID, capabilities[CODE_ID]],
    [INTEGRATIONS_ID, capabilities[INTEGRATIONS_ID]],
    [COMPANION_ID, capabilities[COMPANION_ID]],
  ];
}

/**
 * A bundled module and core now share one owner and one data file. If an older
 * core migration is already verified but the former extension-local receipt
 * is unavailable, materialize the exact authenticated core offer inside the
 * module namespace and then run the normal strict readback verifier.
 */
async function persistBundledMigrationSnapshot(
  plugin: Plugin,
  offer: ExtensionStateMigrationOfferV1,
) {
  try {
    return await persistMigrationSnapshot(plugin, offer);
  } catch (error) {
    if (
      !offer.alreadyVerified ||
      !offer.acknowledgedAt ||
      !/verified extension migration state is missing/iu.test(
        error instanceof Error ? error.message : String(error),
      )
    ) {
      throw error;
    }
    await withPluginDataLock(plugin, async () => {
      const current = asRecord(await plugin.loadData());
      await plugin.saveData({
        ...current,
        schemaVersion: 1,
        extensionStateMigration: {
          version: 1,
          migrationId: offer.migrationId,
          namespace: offer.namespace,
          sourceSnapshotHash: offer.sourceSnapshotHash,
          snapshotHash: offer.snapshotHash,
          acknowledgedAt: offer.acknowledgedAt,
          pendingSecureImportKinds: [...offer.pendingSecureImportKinds],
          snapshot: offer.snapshot,
        },
      });
    });
    return persistMigrationSnapshot(plugin, offer);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeNoticeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown error.")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(
      /(token|secret|password)\s*[=:]\s*[^\s,;}]+/giu,
      "$1=[REDACTED]",
    )
    .slice(0, 1_000);
}
