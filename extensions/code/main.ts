import { Modal, Notice, Plugin, Setting } from "obsidian";

import {
  createCompatibilityBridgeContribution,
  registerSoftDependentExtension,
} from "../shared/softDependency";
import {
  CODE_EXTENSION_VERSION_V2,
  CodeExtensionRuntimeV2,
  type CodeReviewRepairBaseResolutionInputV1,
  type CodeReviewRepairPipelineInputV1,
} from "./CodeExtensionRuntimeV2";
import type {
  SandboxProviderConfigV2,
  SandboxProviderKindV2,
} from "./sandbox";
import type { CodeRepairRequestV1 } from "./repair";
import type { VerifiedCodePublicationHandoffV1 } from "@agentic-researcher/core-api";
import type { RepositoryProfileV2 } from "./repositories";
import type {
  PrepareBackgroundValidationCommitApprovalInputV1,
  PrepareBackgroundValidationCommitApprovalResultV1,
  SealBackgroundValidationCommitPackageInputV1,
  SealBackgroundValidationCommitPackageResultV1,
} from "./background";

export type CodeReviewRepairBridgeResultV1 =
  | { status: "verified"; handoff: VerifiedCodePublicationHandoffV1 }
  | {
      status: "blocked";
      blocker: { code: string; message: string; evidenceFingerprint: string | null };
    };

export default class AgenticResearcherCodeExtension extends Plugin {
  private disconnect: (() => void) | null = null;
  private runtime: CodeExtensionRuntimeV2 | null = null;
  private probeController: AbortController | null = null;
  private probeInFlight: Promise<void> | null = null;

  async onload(): Promise<void> {
    const runtime = new CodeExtensionRuntimeV2({ plugin: this });
    await runtime.initialize();
    this.runtime = runtime;

    this.addCommand({
      id: "probe-sandbox-boundaries",
      name: "Probe configured code sandbox boundaries",
      callback: () => this.probeSandboxBoundaries(),
    });
    this.addCommand({
      id: "configure-sandbox-provider",
      name: "Configure immutable code sandbox provider",
      callback: () => this.openSandboxProviderConfiguration(),
    });

    this.disconnect = registerSoftDependentExtension(this, {
      id: "agentic-researcher-code",
      displayName: "Agentic Researcher Code",
      version: CODE_EXTENSION_VERSION_V2,
      contributions: [
        createCompatibilityBridgeContribution("agentic-researcher-code"),
        ...runtime.getContributions(),
      ],
    });
  }

  onunload(): void {
    this.probeController?.abort("code_extension_unload");
    this.probeController = null;
    this.probeInFlight = null;
    this.disconnect?.();
    this.disconnect = null;
    this.runtime = null;
  }

  /**
   * Public foreground coordinator route. It delegates to the core-owned model
   * loop after the code runtime verifies the exact durable workspace binding,
   * so all tool preparation, approvals, journaling, and receipts remain on the
   * normal production path.
   */
  async runCodeRepair(input: CodeRepairRequestV1): Promise<unknown> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    const prompt = await runtime.createForegroundRepairMissionPrompt(input);
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins;
    const core = plugins?.["agentic-researcher"] as {
      runMission?: (prompt: string, history?: unknown[]) => Promise<unknown>;
    } | undefined;
    if (typeof core?.runMission !== "function") {
      throw new Error("The Agentic Researcher core mission runner is unavailable.");
    }
    return core.runMission(prompt, []);
  }

  /** Core requests a path-free approval payload; the Code capability resolves
   * every trusted local execution input from its own durable stores. */
  async prepareBackgroundValidationCommitApproval(
    input: PrepareBackgroundValidationCommitApprovalInputV1,
  ): Promise<PrepareBackgroundValidationCommitApprovalResultV1> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.prepareBackgroundValidationCommitApproval(input);
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
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.resolveBackgroundMissionBinding(input);
  }

  /** Post-approval sealing re-resolves local inputs and returns only remote-safe
   * identities. It never accepts caller-supplied paths, commands, or actions. */
  async sealBackgroundValidationCommitPackage(
    input: SealBackgroundValidationCommitPackageInputV1,
  ): Promise<SealBackgroundValidationCommitPackageResultV1> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.sealBackgroundValidationCommitPackage(input);
  }

  async resolveVerifiedCodePublicationHandoff(
    profileKey: string,
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.resolveLatestVerifiedPublicationHandoff(profileKey);
  }

  async resolveTrustedRepositoryProfile(
    profileKey: string,
  ): Promise<RepositoryProfileV2 | null> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.getRepositoryProfile(profileKey);
  }

  async createTrustedQueueCodeMissionPrompt(input: {
    runId: string;
    workspaceId: string;
    profileKey: string;
    requestId: string;
    objective: string;
    commitMessage: string;
  }): Promise<string> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.createTrustedQueueCodeMissionPrompt(input);
  }

  async resolveVerifiedQueueCodeHandoff(input: {
    profileKey: string;
    runId: string;
    requestId: string;
  }): Promise<VerifiedCodePublicationHandoffV1 | null> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.resolveLatestVerifiedPublicationHandoff(input.profileKey, {
      runId: input.runId,
      requestId: input.requestId,
    });
  }

  async resolveVerifiedReviewRepairBase(
    input: CodeReviewRepairBaseResolutionInputV1,
  ): Promise<VerifiedCodePublicationHandoffV1 | null> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    return runtime.resolveVerifiedReviewRepairBase(input);
  }

  async resolveVerifiedReviewRepairResult(input: {
    repairRequestId: string;
    runId: string;
    profileKey: string;
    workspaceId: string;
    signal?: AbortSignal;
  }): Promise<CodeReviewRepairBridgeResultV1 | null> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    const handoff = await runtime.resolveVerifiedReviewRepairResult(input);
    return handoff ? { status: "verified", handoff } : null;
  }

  async runVerifiedReviewRepairPipeline(
    input: CodeReviewRepairPipelineInputV1,
  ): Promise<CodeReviewRepairBridgeResultV1> {
    const runtime = this.runtime;
    if (!runtime) throw new Error("The Agentic Researcher Code runtime is not ready.");
    const existing = await runtime.resolveVerifiedReviewRepairResult(input);
    if (existing) return { status: "verified", handoff: existing };
    const prompt = await runtime.createVerifiedReviewRepairMissionPrompt(input);
    const plugins = (this.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins;
    const core = plugins?.["agentic-researcher"] as {
      runReviewRepairCodeMission?: (prompt: string, history?: unknown[]) => Promise<unknown>;
    } | undefined;
    if (typeof core?.runReviewRepairCodeMission !== "function") {
      throw new Error("The Agentic Researcher core review-repair mission runner is unavailable.");
    }
    await core.runReviewRepairCodeMission(prompt, []);
    const handoff = await runtime.resolveVerifiedReviewRepairResult(input);
    if (handoff) return { status: "verified", handoff };
    return {
      status: "blocked",
      blocker: {
        code: "review_repair_pipeline_incomplete",
        message: "The normal durable code-repair mission ended without a verified local commit handoff.",
        evidenceFingerprint: input.reviewEvidenceFingerprint,
      },
    };
  }

  private probeSandboxBoundaries(): void {
    if (this.probeInFlight) {
      new Notice("A code sandbox boundary probe is already running.");
      return;
    }
    const runtime = this.runtime;
    if (!runtime) {
      new Notice("The Agentic Researcher Code runtime is not ready.");
      return;
    }
    const controller = new AbortController();
    this.probeController = controller;
    this.probeInFlight = runtime
      .probeConfiguredSandboxProviders(controller.signal)
      .then((status) => {
        if (status.executionAvailable) {
          new Notice(`Code sandbox verified through ${status.selectedProvider}.`);
        } else {
          new Notice(
            "No configured sandbox provider passed its boundary probe. Editing remains available; generated-code execution is blocked.",
            8_000,
          );
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          const message = error instanceof Error ? error.message : "Sandbox boundary probe failed.";
          new Notice(`Code sandbox probe failed: ${message}`, 8_000);
        }
      })
      .finally(() => {
        if (this.probeController === controller) this.probeController = null;
        this.probeInFlight = null;
      });
  }

  private openSandboxProviderConfiguration(): void {
    if (!this.runtime) {
      new Notice("The Agentic Researcher Code runtime is not ready.");
      return;
    }
    new SandboxProviderConfigurationModal(this, this.runtime).open();
  }
}

export class SandboxProviderConfigurationModal extends Modal {
  private kind: SandboxProviderKindV2 = "docker";
  private runtimeReference = "";
  private runtimeDigest = "";
  private wslDistribution = "";
  private runtimeRoot = "";
  private priority = 10;
  private saving = false;

  constructor(
    private readonly plugin: Plugin,
    private readonly runtime: CodeExtensionRuntimeV2,
  ) {
    super(plugin.app);
  }

  onOpen(): void {
    this.loadKind(this.kind);
    this.render();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private render(): void {
    this.contentEl.empty();
    this.titleEl.setText("Configure code sandbox provider");
    this.contentEl.createEl("p", {
      text:
        "This local-only setting pins one sandbox runtime by SHA-256. Saving configuration never probes or starts it; run the separate boundary-probe command afterward.",
    });
    new Setting(this.contentEl)
      .setName("Provider")
      .setDesc("Only the fixed provider catalog is supported.")
      .addDropdown((dropdown) => dropdown
        .addOptions({
          docker: "Docker",
          podman: "Podman",
          wsl2: "Dedicated WSL2 distribution",
          bubblewrap: "bubblewrap",
        })
        .setValue(this.kind)
        .onChange((value) => {
          this.loadKind(value as SandboxProviderKindV2);
          this.render();
        }));
    new Setting(this.contentEl)
      .setName(this.kind === "docker" || this.kind === "podman" ? "OCI image" : "Runtime identity")
      .setDesc(this.kind === "docker" || this.kind === "podman"
        ? "Registry image name only, without @digest."
        : "Stable local runtime name used in the boundary fingerprint.")
      .addText((text) => text
        .setPlaceholder(this.kind === "docker" || this.kind === "podman" ? "registry.example/agentic-sandbox" : "agentic-runtime")
        .setValue(this.runtimeReference)
        .onChange((value) => { this.runtimeReference = value.trim(); }));
    new Setting(this.contentEl)
      .setName("Immutable runtime digest")
      .setDesc("Required exact form: sha256 followed by 64 lowercase hexadecimal characters.")
      .addText((text) => text
        .setPlaceholder(`sha256:${"0".repeat(64)}`)
        .setValue(this.runtimeDigest)
        .onChange((value) => { this.runtimeDigest = value.trim(); }));
    if (this.kind === "wsl2") {
      new Setting(this.contentEl)
        .setName("Dedicated WSL distribution")
        .setDesc("The distribution must run the sandbox as the non-root agentic user.")
        .addText((text) => text
          .setPlaceholder("AgenticResearcherSandbox")
          .setValue(this.wslDistribution)
          .onChange((value) => { this.wslDistribution = value.trim(); }));
    }
    if (this.kind === "wsl2" || this.kind === "bubblewrap") {
      new Setting(this.contentEl)
        .setName("Read-only runtime root")
        .setDesc("Absolute guest path containing bin/sandbox-entrypoint and the pinned runtime.")
        .addText((text) => text
          .setPlaceholder("/opt/agentic/runtime")
          .setValue(this.runtimeRoot)
          .onChange((value) => { this.runtimeRoot = value.trim(); }));
    }
    const existing = this.runtime.readState().sandbox.providerConfigs.some((provider) => provider.kind === this.kind);
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText(this.saving ? "Saving…" : "Save immutable binding")
        .setCta()
        .setDisabled(this.saving)
        .onClick(() => { void this.save(); }))
      .addButton((button) => button
        .setButtonText("Remove this provider")
        .setDisabled(this.saving || !existing)
        .onClick(() => { void this.remove(); }));
  }

  private loadKind(kind: SandboxProviderKindV2): void {
    this.kind = kind;
    const existing = this.runtime.readState().sandbox.providerConfigs.find((provider) => provider.kind === kind);
    this.runtimeReference = existing?.runtimeReference ?? "";
    this.runtimeDigest = existing?.runtimeDigest ?? "";
    this.wslDistribution = existing?.wslDistribution ?? "";
    this.runtimeRoot = existing?.runtimeRoot ?? "";
    this.priority = existing?.priority ?? ({ docker: 10, podman: 20, wsl2: 30, bubblewrap: 40 }[kind]);
  }

  private async save(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.render();
    try {
      const config: SandboxProviderConfigV2 = {
        version: 1,
        kind: this.kind,
        executable: ({ docker: "docker", podman: "podman", wsl2: "wsl.exe", bubblewrap: "bwrap" } as const)[this.kind],
        priority: this.priority,
        runtimeReference: this.runtimeReference,
        runtimeDigest: this.runtimeDigest,
        wslDistribution: this.kind === "wsl2" ? this.wslDistribution : null,
        runtimeRoot: this.kind === "wsl2" || this.kind === "bubblewrap" ? this.runtimeRoot : null,
      };
      await this.runtime.configureSandboxProvider(config);
      new Notice(`Saved immutable ${this.kind} sandbox binding. Run the boundary probe before execution.`);
      this.close();
    } catch (error) {
      this.saving = false;
      this.render();
      new Notice(`Sandbox provider configuration was not saved: ${error instanceof Error ? error.message : String(error)}`, 10_000);
    }
  }

  private async remove(): Promise<void> {
    if (this.saving) return;
    this.saving = true;
    this.render();
    try {
      await this.runtime.removeSandboxProvider(this.kind);
      new Notice(`Removed ${this.kind} sandbox configuration. Generated-code execution remains blocked until another provider is verified.`);
      this.close();
    } catch (error) {
      this.saving = false;
      this.render();
      new Notice(`Sandbox provider configuration was not removed: ${error instanceof Error ? error.message : String(error)}`, 10_000);
    }
  }
}
