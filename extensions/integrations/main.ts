import { Plugin } from "obsidian";
import {
  createCompatibilityBridgeContribution,
  createScaffoldSettingsContribution,
  createScaffoldStatusContribution,
  registerSoftDependentExtension,
} from "../shared/softDependency";
import {
  PreparedBackgroundGitHubHostV1,
  createPreparedBackgroundGitHubToolContributionsV1,
  type ApplyVerifiedBackgroundGitHubResultInputV1,
  type PrepareBackgroundGitHubApprovalInputV1,
  type SealBackgroundGitHubPackageInputV1,
  type SynchronizeBackgroundGitHubHostStateInputV1,
} from "./host";
import type { PreparedBackgroundGitHubToolNameV1 } from "@agentic-researcher/core-api";

export default class AgenticResearcherIntegrationsExtension extends Plugin {
  private disconnect: (() => void) | null = null;
  private backgroundGitHubHost: PreparedBackgroundGitHubHostV1 | null = null;

  async onload(): Promise<void> {
    const backgroundGitHubHost = new PreparedBackgroundGitHubHostV1(this);
    await backgroundGitHubHost.initialize();
    this.backgroundGitHubHost = backgroundGitHubHost;
    this.disconnect = registerSoftDependentExtension(this, {
      id: "agentic-researcher-integrations",
      displayName: "Agentic Researcher Integrations",
      version: "0.2.0",
      contributions: [
        createCompatibilityBridgeContribution("agentic-researcher-integrations"),
        ...createPreparedBackgroundGitHubToolContributionsV1(
          backgroundGitHubHost,
        ),
        createScaffoldSettingsContribution({
          id: "agentic-researcher-integrations",
          displayName: "Agentic Researcher Integrations",
          title: "Integrations extension",
          fields: [
            {
              id: "linear_state",
              type: "select",
              label: "Linear capability",
              description:
                "Legacy Linear compatibility remains core-owned until production wiring is complete.",
              defaultValue: "compatibility",
              options: [
                { label: "Compatibility", value: "compatibility" },
                { label: "Extension owned", value: "extension_owned" },
              ],
            },
            {
              id: "secure_credentials",
              type: "boolean",
              label: "Secure credential import",
              description:
                "Core can create an opaque SecretStoreV1 reference after authenticated persistent-store readback; legacy plaintext is never copied or cleared automatically.",
              defaultValue: false,
            },
          ],
        }),
        createScaffoldStatusContribution({
          id: "agentic-researcher-integrations",
          displayName: "Agentic Researcher Integrations",
          summary: "Integrations owns hash-readback GitHub background bindings, checkpoints, approval preparation, and local companion packages; core compatibility still provides connection-derived Linear discovery and explicit SecretStoreV1 migration.",
        }),
      ],
    });
  }

  onunload(): void {
    this.disconnect?.();
    this.disconnect = null;
    this.backgroundGitHubHost = null;
  }

  async synchronizeBackgroundGitHubHostState(
    input: SynchronizeBackgroundGitHubHostStateInputV1,
  ) {
    return this.requireBackgroundGitHubHost().synchronize(input);
  }

  async resolveBackgroundGitHubMissionBinding(input: {
    objective: string;
    toolName: PreparedBackgroundGitHubToolNameV1;
  }) {
    return this.requireBackgroundGitHubHost().resolveMissionBinding(input);
  }

  async prepareBackgroundGitHubApproval(
    input: PrepareBackgroundGitHubApprovalInputV1,
  ) {
    return this.requireBackgroundGitHubHost().prepareApproval(input);
  }

  async sealBackgroundGitHubPackage(
    input: SealBackgroundGitHubPackageInputV1,
  ) {
    return this.requireBackgroundGitHubHost().sealPackage(input);
  }

  async applyVerifiedBackgroundGitHubResult(
    input: ApplyVerifiedBackgroundGitHubResultInputV1,
  ) {
    return this.requireBackgroundGitHubHost().applyVerifiedResult(input);
  }

  readBackgroundGitHubHostState() {
    return this.requireBackgroundGitHubHost().readState();
  }

  private requireBackgroundGitHubHost(): PreparedBackgroundGitHubHostV1 {
    if (!this.backgroundGitHubHost) {
      throw new Error("The integrations background GitHub host is not ready.");
    }
    return this.backgroundGitHubHost;
  }
}
