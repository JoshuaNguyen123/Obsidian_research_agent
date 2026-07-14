import {
  AGENTIC_RESEARCHER_CORE_API_MAJOR,
  AGENTIC_RESEARCHER_CORE_API_MINOR,
  ExtensionRegistrationErrorV1,
  type AgenticResearcherCoreApiV1,
  type CoreLifecycleStateV1,
  type ExpectedExtensionStatusV1,
  type ExpectedExtensionV1,
  type ExtensionMissionSnapshotV1,
  type ExtensionRegistrationTokenV1,
  type ExtensionStateMigrationOfferV1,
  type ExtensionStateMigrationReadbackV1,
  type ExtensionStateMigrationResultV1,
  type RegisterExtensionRequestV1,
} from "../../packages/core-api/src";
import {
  ExtensionRegistry,
  type ExtensionToolNameReservation,
} from "./ExtensionRegistry";

export interface CoreApiHostOptions {
  now?: () => Date;
  onRegistryChange?: () => void;
  toolNameReservations?: Iterable<ExtensionToolNameReservation>;
  getStateMigrationOffer?: (
    extensionId: string,
  ) => ExtensionStateMigrationOfferV1;
  acknowledgeStateMigration?: (
    extensionId: string,
    readback: ExtensionStateMigrationReadbackV1,
  ) => Promise<ExtensionStateMigrationResultV1>;
}

/** Host-owned lifecycle and registration boundary. */
export class CoreApiHost {
  readonly apiMajor = AGENTIC_RESEARCHER_CORE_API_MAJOR;
  readonly apiMinor = AGENTIC_RESEARCHER_CORE_API_MINOR;

  private lifecycleState: CoreLifecycleStateV1 = "loading";
  private readonly registry: ExtensionRegistry;
  private readonly publicApi: AgenticResearcherCoreApiV1;
  private readonly onRegistryChange?: () => void;
  private readonly getStateMigrationOfferHandler?: CoreApiHostOptions["getStateMigrationOffer"];
  private readonly acknowledgeStateMigrationHandler?: CoreApiHostOptions["acknowledgeStateMigration"];

  constructor(options: CoreApiHostOptions = {}) {
    this.onRegistryChange = options.onRegistryChange;
    this.getStateMigrationOfferHandler = options.getStateMigrationOffer;
    this.acknowledgeStateMigrationHandler = options.acknowledgeStateMigration;
    this.registry = new ExtensionRegistry({
      getCoreState: () => this.lifecycleState,
      now: options.now,
      toolNameReservations: options.toolNameReservations,
    });
    const host = this;
    this.publicApi = Object.freeze({
      apiMajor: this.apiMajor,
      apiMinor: this.apiMinor,
      get state(): CoreLifecycleStateV1 {
        return host.lifecycleState;
      },
      registerExtension(request: RegisterExtensionRequestV1) {
        return host.registerExtension(request);
      },
      unregisterExtension(token: ExtensionRegistrationTokenV1, reason?: string) {
        return host.unregisterExtension(token, reason);
      },
      getStateMigrationOffer(token: ExtensionRegistrationTokenV1) {
        return host.getStateMigrationOffer(token);
      },
      acknowledgeStateMigration(
        token: ExtensionRegistrationTokenV1,
        readback: ExtensionStateMigrationReadbackV1,
      ) {
        return host.acknowledgeStateMigration(token, readback);
      },
    });
  }

  get state(): CoreLifecycleStateV1 {
    return this.lifecycleState;
  }

  /** The narrow object published to soft-dependent extensions. */
  getApi(): AgenticResearcherCoreApiV1 {
    return this.publicApi;
  }

  markReady(): void {
    if (this.lifecycleState === "unloading") {
      throw new ExtensionRegistrationErrorV1(
        "core_unloading",
        "Core extension API cannot become ready after unloading starts.",
      );
    }
    this.lifecycleState = "ready";
  }

  beginUnload(reason = "core_unloading"): number {
    if (this.lifecycleState === "unloading") {
      return 0;
    }
    this.lifecycleState = "unloading";
    const removed = this.registry.unregisterAll(reason);
    this.onRegistryChange?.();
    return removed;
  }

  registerExtension(request: RegisterExtensionRequestV1): ExtensionRegistrationTokenV1 {
    try {
      return this.registry.registerExtension(request);
    } finally {
      // Compatibility failures are registry state too and must be visible.
      this.onRegistryChange?.();
    }
  }

  unregisterExtension(
    token: ExtensionRegistrationTokenV1,
    reason?: string,
  ): boolean {
    const removed = this.registry.unregisterExtension(token, reason);
    if (removed) {
      this.onRegistryChange?.();
    }
    return removed;
  }

  isTokenActive(token: ExtensionRegistrationTokenV1): boolean {
    return this.registry.isTokenActive(token);
  }

  getStateMigrationOffer(
    token: ExtensionRegistrationTokenV1,
  ): ExtensionStateMigrationOfferV1 {
    this.assertActiveMigrationToken(token);
    if (!this.getStateMigrationOfferHandler) {
      throw new Error("Core state migration is not initialized.");
    }
    return this.getStateMigrationOfferHandler(token.extensionId);
  }

  async acknowledgeStateMigration(
    token: ExtensionRegistrationTokenV1,
    readback: ExtensionStateMigrationReadbackV1,
  ): Promise<ExtensionStateMigrationResultV1> {
    this.assertActiveMigrationToken(token);
    if (!this.acknowledgeStateMigrationHandler) {
      throw new Error("Core state migration is not initialized.");
    }
    return this.acknowledgeStateMigrationHandler(token.extensionId, readback);
  }

  createMissionSnapshot(missionId: string): ExtensionMissionSnapshotV1 {
    if (this.lifecycleState !== "ready") {
      throw new ExtensionRegistrationErrorV1(
        this.lifecycleState === "unloading" ? "core_unloading" : "core_not_ready",
        `Cannot create an extension snapshot while core is ${this.lifecycleState}.`,
      );
    }
    return this.registry.createMissionSnapshot(missionId);
  }

  getRegisteredExtensionIds(): ReadonlyArray<string> {
    return this.registry.getRegisteredExtensionIds();
  }

  getExpectedExtensionStatuses(
    expected: ReadonlyArray<ExpectedExtensionV1>,
  ): ReadonlyArray<ExpectedExtensionStatusV1> {
    return this.registry.getExpectedExtensionStatuses(expected);
  }

  private assertActiveMigrationToken(token: ExtensionRegistrationTokenV1): void {
    if (this.lifecycleState !== "ready" || !this.registry.isTokenActive(token)) {
      throw new Error("Extension registration token is not active.");
    }
  }
}
