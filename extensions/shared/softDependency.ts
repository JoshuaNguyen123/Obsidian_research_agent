import type { EventRef, Plugin } from "obsidian";
import {
  AGENTIC_RESEARCHER_CORE_API_MAJOR,
  AGENTIC_RESEARCHER_CORE_API_MINOR,
  AGENTIC_RESEARCHER_CORE_PLUGIN_ID,
  AGENTIC_RESEARCHER_CORE_READY_EVENT,
  AGENTIC_RESEARCHER_CORE_UNLOADING_EVENT,
  type AgenticResearcherCoreApiV1,
  type AgenticResearcherCorePluginV1,
  type ExtensionContributionV1,
  type ExtensionSettingFieldV1,
  type ExtensionStateMigrationOfferV1,
  type ExtensionRegistrationTokenV1,
} from "@agentic-researcher/core-api";

export interface SoftDependentExtensionDefinition {
  id: string;
  displayName: string;
  version: string;
  contributions: ExtensionContributionV1[];
}

/**
 * Explicitly declares the temporary host compatibility bridge. Core checks
 * this contribution before exposing a legacy domain tool; registration alone
 * never implies capability ownership.
 */
export function createCompatibilityBridgeContribution(
  extensionId: string,
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "background_handler",
      id: `${extensionId}:compatibility_bridge`,
      displayName: "Compatibility bridge",
      description:
        "Phase 1 declaration for the bounded host bridge; full implementation moves into this extension in its domain phase.",
    },
    async handle() {
      // Capability is host-invoked through its existing safety boundary. This
      // declaration receives no vault, credential, model, or process handle.
    },
  };
}

export function registerSoftDependentExtension(
  plugin: Plugin,
  definition: SoftDependentExtensionDefinition,
): () => void {
  let api: AgenticResearcherCoreApiV1 | null = null;
  let token: ExtensionRegistrationTokenV1 | null = null;
  let migrationStatus:
    | "waiting_for_core"
    | "copying"
    | "verified"
    | "secure_import_pending"
    | "blocked" = "waiting_for_core";
  let migrationMessage = "Waiting for the Agentic Researcher core.";

  const resolveApi = (): AgenticResearcherCoreApiV1 | null => {
    const plugins = (plugin.app as typeof plugin.app & {
      plugins?: { plugins?: Record<string, AgenticResearcherCorePluginV1> };
    }).plugins?.plugins;
    const candidate = plugins?.[AGENTIC_RESEARCHER_CORE_PLUGIN_ID]
      ?.agenticResearcherApi;
    return candidate?.apiMajor === AGENTIC_RESEARCHER_CORE_API_MAJOR &&
      candidate.apiMinor >= AGENTIC_RESEARCHER_CORE_API_MINOR
      ? candidate
      : null;
  };

  const connect = async () => {
    if (token && !token.signal.aborted) {
      return;
    }
    const resolved = resolveApi();
    if (!resolved || resolved.state !== "ready") {
      return;
    }
    try {
      token = resolved.registerExtension({
        manifest: {
          id: definition.id,
          displayName: definition.displayName,
          version: definition.version,
          apiMajor: AGENTIC_RESEARCHER_CORE_API_MAJOR,
          apiMinor: AGENTIC_RESEARCHER_CORE_API_MINOR,
        },
        contributions: [
          ...definition.contributions,
          createMigrationStatusContribution(definition.id, () => ({
            status: migrationStatus,
            message: migrationMessage,
          })),
        ],
      });
      api = resolved;
      migrationStatus = "copying";
      migrationMessage = "Copying the core-owned namespace into extension data.";
      const offer = resolved.getStateMigrationOffer(token);
      const persisted = await persistMigrationSnapshot(plugin, offer);
      const result = await resolved.acknowledgeStateMigration(token, {
        version: 1,
        migrationId: offer.migrationId,
        namespace: offer.namespace,
        snapshot: persisted.snapshot,
        acknowledgedAt: persisted.acknowledgedAt,
      });
      migrationStatus =
        result.pendingSecureImportKinds.length > 0
          ? "secure_import_pending"
          : "verified";
      migrationMessage =
        result.pendingSecureImportKinds.length > 0
          ? `State verified. Secure import is still required for: ${result.pendingSecureImportKinds.join(", ")}.`
          : `State verified for namespace ${result.namespace}.`;
    } catch (error) {
      migrationStatus = "blocked";
      migrationMessage =
        error instanceof Error ? error.message : "Extension registration failed.";
      if (token) {
        resolved.unregisterExtension(token, "migration_failed");
      }
      token = null;
      api = null;
      console.warn(`Unable to register ${definition.id} with Agentic Researcher core.`, error);
    }
  };

  const workspaceEvents = plugin.app.workspace as unknown as {
    on(name: string, callback: () => void): EventRef;
  };
  plugin.registerEvent(
    workspaceEvents.on(AGENTIC_RESEARCHER_CORE_READY_EVENT, () => {
      void connect();
    }),
  );
  plugin.registerEvent(
    workspaceEvents.on(AGENTIC_RESEARCHER_CORE_UNLOADING_EVENT, () => {
      api = null;
      token = null;
      migrationStatus = "waiting_for_core";
      migrationMessage = "Waiting for the Agentic Researcher core.";
    }),
  );
  void connect();

  return () => {
    if (api && token) {
      api.unregisterExtension(token, "extension_unload");
    }
    api = null;
    token = null;
  };
}

interface PersistedExtensionMigrationV1 {
  version: 1;
  migrationId: string;
  namespace: ExtensionStateMigrationOfferV1["namespace"];
  sourceSnapshotHash: string | null;
  snapshotHash: string;
  acknowledgedAt: string;
  pendingSecureImportKinds: string[];
  snapshot: ExtensionStateMigrationOfferV1["snapshot"];
}

const pluginDataQueues = new WeakMap<Plugin, Promise<void>>();

export async function withPluginDataLock<TResult>(
  plugin: Plugin,
  operation: () => Promise<TResult>,
): Promise<TResult> {
  const previous = pluginDataQueues.get(plugin) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pluginDataQueues.set(plugin, previous.then(() => current));
  await previous;
  try {
    return await operation();
  } finally {
    release();
  }
}

async function persistMigrationSnapshot(
  plugin: Plugin,
  offer: ExtensionStateMigrationOfferV1,
): Promise<PersistedExtensionMigrationV1> {
  return withPluginDataLock(plugin, () =>
    persistMigrationSnapshotUnlocked(plugin, offer),
  );
}

async function persistMigrationSnapshotUnlocked(
  plugin: Plugin,
  offer: ExtensionStateMigrationOfferV1,
): Promise<PersistedExtensionMigrationV1> {
  const current = asRecord(await plugin.loadData());
  if (
    current.schemaVersion !== undefined &&
    current.schemaVersion !== 1
  ) {
    throw new Error(
      `Unsupported future extension data schema: ${String(current.schemaVersion)}.`,
    );
  }
  const existing = asRecord(current.extensionStateMigration);
  if (offer.alreadyVerified) {
    const acknowledgedAt =
      typeof existing.acknowledgedAt === "string"
        ? existing.acknowledgedAt
        : offer.acknowledgedAt;
    if (
      existing.version !== 1 ||
      existing.migrationId !== offer.migrationId ||
      existing.namespace !== offer.namespace ||
      existing.snapshotHash !== offer.snapshotHash ||
      acknowledgedAt !== offer.acknowledgedAt ||
      !("snapshot" in existing)
    ) {
      throw new Error(
        "Verified extension migration state is missing or does not match core readback.",
      );
    }
    return {
      version: 1,
      migrationId: offer.migrationId,
      namespace: offer.namespace,
      sourceSnapshotHash: offer.sourceSnapshotHash,
      snapshotHash: offer.snapshotHash,
      acknowledgedAt: acknowledgedAt!,
      pendingSecureImportKinds: [...offer.pendingSecureImportKinds],
      snapshot: existing.snapshot as ExtensionStateMigrationOfferV1["snapshot"],
    };
  }
  const acknowledgedAt =
    offer.acknowledgedAt ??
    (typeof existing.acknowledgedAt === "string" &&
    existing.migrationId === offer.migrationId
      ? existing.acknowledgedAt
      : new Date().toISOString());
  const persisted: PersistedExtensionMigrationV1 = {
    version: 1,
    migrationId: offer.migrationId,
    namespace: offer.namespace,
    sourceSnapshotHash: offer.sourceSnapshotHash,
    snapshotHash: offer.snapshotHash,
    acknowledgedAt,
    pendingSecureImportKinds: [...offer.pendingSecureImportKinds],
    snapshot: offer.snapshot,
  };
  await plugin.saveData({
    ...current,
    schemaVersion: 1,
    extensionStateMigration: persisted,
  });
  const readback = asRecord((await plugin.loadData())?.extensionStateMigration);
  if (
    readback.version !== 1 ||
    readback.migrationId !== offer.migrationId ||
    readback.namespace !== offer.namespace ||
    readback.snapshotHash !== offer.snapshotHash ||
    readback.acknowledgedAt !== acknowledgedAt ||
    !("snapshot" in readback)
  ) {
    throw new Error("Extension state migration readback metadata does not match the prepared copy.");
  }
  return {
    ...persisted,
    snapshot: readback.snapshot as ExtensionStateMigrationOfferV1["snapshot"],
  };
}

function createMigrationStatusContribution(
  extensionId: string,
  read: () => { status: string; message: string },
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "status",
      id: `${extensionId}:migration`,
      displayName: "Extension state migration",
    },
    async readStatus(context) {
      const current = read();
      return {
        status:
          current.status === "verified"
            ? "healthy"
            : current.status === "blocked"
              ? "blocked"
              : "degraded",
        summary: current.message,
        details: { migrationStatus: current.status },
        checkedAt: context.now().toISOString(),
      };
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createScaffoldStatusContribution(input: {
  id: string;
  displayName: string;
  summary: string;
}): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "status",
      id: `${input.id}:status`,
      displayName: `${input.displayName} status`,
    },
    async readStatus(context) {
      return {
        status: "degraded",
        summary: input.summary,
        checkedAt: context.now().toISOString(),
      };
    },
  };
}

export function createScaffoldSettingsContribution(input: {
  id: string;
  displayName: string;
  title: string;
  fields: ExtensionSettingFieldV1[];
}): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "settings",
      id: `${input.id}:settings`,
      displayName: `${input.displayName} settings`,
      description:
        "Read-only extension settings metadata. Extension-owned persistence is introduced with the implementing phase.",
    },
    section: {
      id: input.id,
      title: input.title,
      fields: input.fields,
    },
  };
}
