import { Notice, Plugin } from "obsidian";
import type { ExtensionContributionV1 } from "@agentic-researcher/core-api";
import { AGENTIC_RESEARCHER_COMPANION_RECONCILE_EVENT } from "@agentic-researcher/core-api";
import {
  createCompatibilityBridgeContribution,
  createScaffoldSettingsContribution,
  registerSoftDependentExtension,
  withPluginDataLock,
} from "../shared/softDependency";
import {
  CompanionExtensionCoordinatorV1,
  type CompanionSessionConfigurationV1,
} from "./CompanionExtensionCoordinator";
import {
  CompanionServiceControllerV1,
  type CompanionServiceCommandResultV1,
} from "./CompanionServiceController";
import { requireNodeModule } from "../../src/platform/nodeRequire";
import { createSessionBootstrapTokenLeaseV1 } from "@agentic-researcher/headless-runtime";

export default class AgenticResearcherCompanionExtension extends Plugin {
  public readonly companionCoordinator = new CompanionExtensionCoordinatorV1();
  private disconnect: (() => void) | null = null;
  private serviceController: CompanionServiceControllerV1 | null = null;

  onload(): void {
    this.serviceController = this.createServiceController();
    this.companionCoordinator.configurePersistence({
      load: async () => {
        return withPluginDataLock(this, async () => {
          const data = asRecord(await this.loadData());
          return data.companionRuntimeState;
        });
      },
      save: async (state) => {
        await withPluginDataLock(this, async () => {
          const current = asRecord(await this.loadData());
          await this.saveData({ ...current, companionRuntimeState: state });
        });
      },
    });
    this.registerServiceCommands();
    this.disconnect = registerSoftDependentExtension(this, {
      id: "agentic-researcher-companion",
      displayName: "Agentic Researcher Companion",
      version: "0.2.0",
      contributions: [
        createCompatibilityBridgeContribution("agentic-researcher-companion"),
        createScaffoldSettingsContribution({
          id: "agentic-researcher-companion",
          displayName: "Agentic Researcher Companion",
          title: "Authenticated local companion",
          fields: [
            {
              id: "background_continuation",
              type: "boolean",
              label: "Background continuation",
              description:
                "Available only after explicit service installation and secure OS credential-store readback.",
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
      ],
    });
    void this.restoreCompanionRuntime();
  }

  /** Connect an externally launched companion with a closure-backed credential. */
  public configureCompanionSession(configuration: CompanionSessionConfigurationV1): void {
    this.companionCoordinator.configureSession(configuration);
    this.requestCoreReconciliation();
  }

  /**
   * Foreground-only pairing for an already running local service. The caller
   * supplies a closure, not a serializable token field; the result remains in
   * process memory and is disposed on disconnect/unload.
   */
  public async pairForegroundCompanion(input: {
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
        throw new Error(snapshot.lastError ?? "Companion health verification failed.");
      }
      this.requestCoreReconciliation();
    } catch (error) {
      credential.dispose();
      throw error;
    }
  }

  /** Explicitly install and pair the OS-managed background service. */
  public async installCompanionService(): Promise<CompanionServiceCommandResultV1> {
    const controller = this.requireServiceController();
    const result = await controller.install();
    await this.connectCompanionService();
    await this.companionCoordinator.setServiceInstalled(true, controller.baseUrl);
    return result;
  }

  /** Pair to the existing service via a stdout-only keyring token lease. */
  public async connectCompanionService(): Promise<void> {
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
        throw new Error(snapshot.lastError ?? "Companion health verification failed.");
      }
      await this.companionCoordinator.setServiceInstalled(true, controller.baseUrl);
      await this.companionCoordinator.reconcilePersistedJobs();
      this.requestCoreReconciliation();
    } catch (error) {
      credential.dispose();
      throw error;
    }
  }

  public async readCompanionServiceStatus(): Promise<CompanionServiceCommandResultV1> {
    return this.requireServiceController().status();
  }

  /** Explicit user action: provision the persistent approval signing key. */
  public async provisionHostApprovalSigner(): Promise<string> {
    const description = await this.companionCoordinator.provisionHostApprovalSigner();
    if (
      !description.persistent ||
      !description.provisioned ||
      !description.signingKeyFingerprint
    ) {
      throw new Error("Companion did not verify a persistent host approval signing key.");
    }
    return description.signingKeyFingerprint;
  }

  /** Explicit user action: rotate and pin a fresh approval signing key. */
  public async rotateHostApprovalSigner(): Promise<string> {
    const description = await this.companionCoordinator.rotateHostApprovalSigner();
    if (
      !description.persistent ||
      !description.provisioned ||
      !description.signingKeyFingerprint
    ) {
      throw new Error("Companion did not verify the rotated host approval signing key.");
    }
    return description.signingKeyFingerprint;
  }

  /** Removal is always explicit; secure bootstrap deletion is a separate choice. */
  public async removeCompanionService(
    removeBootstrapToken = false,
  ): Promise<CompanionServiceCommandResultV1> {
    this.companionCoordinator.clearSession();
    const result = await this.requireServiceController().remove({ removeBootstrapToken });
    await this.companionCoordinator.setServiceInstalled(false);
    return result;
  }

  onunload(): void {
    this.companionCoordinator.clearSession();
    this.disconnect?.();
    this.disconnect = null;
    this.serviceController = null;
  }

  private createServiceController(): CompanionServiceControllerV1 | null {
    try {
      requireNodeModule<typeof import("path")>("path", "companion_extension");
      return new CompanionServiceControllerV1({});
    } catch {
      return null;
    }
  }

  private requestCoreReconciliation(): void {
    this.app.workspace.trigger(
      AGENTIC_RESEARCHER_COMPANION_RECONCILE_EVENT,
    );
  }

  private requireServiceController(): CompanionServiceControllerV1 {
    if (!this.serviceController) {
      throw new Error(
        "Companion service control is available only in the desktop filesystem runtime.",
      );
    }
    return this.serviceController;
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
      // Health/status contributions expose the resumable blocker. Bootstrap
      // credentials are never copied into extension data while reconnecting.
    }
  }

  private registerServiceCommands(): void {
    this.addCommand({
      id: "install-background-service",
      name: "Companion: Install background service",
      callback: () => void this.runUserCommand("install", async () => {
        const result = await this.installCompanionService();
        return `Companion installed (${result.platform}).`;
      }),
    });
    this.addCommand({
      id: "connect-background-service",
      name: "Companion: Connect authenticated service",
      callback: () => void this.runUserCommand("connect", async () => {
        await this.connectCompanionService();
        return "Authenticated companion service connected.";
      }),
    });
    this.addCommand({
      id: "show-background-service-status",
      name: "Companion: Show service status",
      callback: () => void this.runUserCommand("status", async () => {
        const result = await this.readCompanionServiceStatus();
        return `Companion service: installed=${String(result.installed ?? false)}, active=${String(result.active ?? false)}, platform=${result.platform}.`;
      }),
    });
    this.addCommand({
      id: "provision-host-approval-signer",
      name: "Companion: Provision approval signing key",
      callback: () => void this.runUserCommand("approval signer provision", async () => {
        const fingerprint = await this.provisionHostApprovalSigner();
        return `Companion approval signing key is ready (${fingerprint.slice(0, 23)}…).`;
      }),
    });
    this.addCommand({
      id: "rotate-host-approval-signer",
      name: "Companion: Rotate approval signing key",
      callback: () => void this.runUserCommand("approval signer rotation", async () => {
        const fingerprint = await this.rotateHostApprovalSigner();
        return `Companion approval signing key was rotated (${fingerprint.slice(0, 23)}…).`;
      }),
    });
    this.addCommand({
      id: "remove-background-service",
      name: "Companion: Remove background service",
      callback: () => void this.runUserCommand("remove", async () => {
        const result = await this.removeCompanionService(false);
        return `Companion service removed (${result.platform}); bootstrap credential retained.`;
      }),
    });
    this.addCommand({
      id: "remove-background-service-and-credential",
      name: "Companion: Remove service and bootstrap credential",
      callback: () => void this.runUserCommand("remove credential", async () => {
        const result = await this.removeCompanionService(true);
        return `Companion service and bootstrap credential removed (${result.platform}).`;
      }),
    });
  }

  private async runUserCommand(
    operation: string,
    execute: () => Promise<string>,
  ): Promise<void> {
    try {
      new Notice(await execute(), 8_000);
    } catch (error) {
      new Notice(`Companion ${operation} failed: ${safeNoticeError(error)}`, 12_000);
    }
  }
}

export function createCompanionStatusContribution(
  coordinator: CompanionExtensionCoordinatorV1,
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "status",
      id: "agentic-researcher-companion:status",
      displayName: "Authenticated companion status",
    },
    async readStatus(context) {
      const snapshot = await coordinator.refreshHealth();
      const health = snapshot.health;
      const hostApprovalSigner = snapshot.configured
        ? await coordinator.describeHostApprovalSigner().catch(() => null)
        : null;
      const healthy = Boolean(
          health?.ok &&
          health.coordinatorReady &&
          health.workerReady &&
          health.backgroundEnabled &&
          health.secureStorePersistent,
      );
      return {
        status: healthy ? "healthy" : snapshot.configured ? "degraded" : "blocked",
        summary: healthy
          ? "Authenticated background coordinator and persistent credential store are ready."
          : snapshot.lastError ??
            health?.backgroundBlocker ??
            "Install and connect the authenticated local companion service.",
        details: {
          configured: snapshot.configured,
          coordinatorReady: health?.coordinatorReady ?? false,
          workerReady: health?.workerReady ?? false,
          workerDiagnostic: health?.workerDiagnostic ?? null,
          installedExecutorDomains: health?.installedExecutorDomains ?? [],
          executorCatalogVersion: health?.executorCatalogVersion ?? null,
          secureStorePersistent: health?.secureStorePersistent ?? false,
          hostApprovalSignerPersistent:
            hostApprovalSigner?.persistent ?? false,
          hostApprovalSignerProvisioned:
            hostApprovalSigner?.provisioned ?? false,
          hostApprovalSigningKeyFingerprint:
            hostApprovalSigner?.signingKeyFingerprint ?? null,
          backgroundEnabled: health?.backgroundEnabled ?? false,
          backgroundBlocker: health?.backgroundBlocker ?? null,
          lastWaitingObsidianNodeId: snapshot.lastWaitingObsidianNodeId,
          requiredAction: healthy
            ? hostApprovalSigner?.provisioned
              ? null
              : "Run Companion: Provision approval signing key before background GitHub mutations."
            : "Install/connect the service and verify an OS credential-store backend.",
        },
        checkedAt: context.now().toISOString(),
      };
    },
  };
}

export function createCompanionReplayContribution(
  coordinator: CompanionExtensionCoordinatorV1,
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "background_handler",
      id: "agentic-researcher-companion:receipt_replay",
      displayName: "Companion receipt and event replay",
      description:
        "Replays authenticated external events to core; it never reads or mutates the vault.",
    },
    async handle(event, context) {
      if (event.type !== "companion.replay_events") return;
      const payload = asRecord(event.payload);
      const jobId = typeof payload.jobId === "string" ? payload.jobId : "";
      const afterSequence =
        typeof payload.afterSequence === "number" ? payload.afterSequence : 0;
      if (!jobId) throw new Error("Companion replay requires a jobId.");
      const events = await coordinator.replayEvents(
        jobId,
        afterSequence,
        context.abortSignal,
      );
      for (const replayed of events) {
        context.reportProgress(
          `Companion replay ${replayed.sequence}: ${replayed.type} (${replayed.jobId})`,
        );
      }
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function safeNoticeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error.";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 1_000);
}
