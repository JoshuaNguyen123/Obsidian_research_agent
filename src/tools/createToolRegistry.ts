import { DefaultToolRegistry } from "./ToolRegistry";
import { ToolExecutionError, type AgentTool, type ToolRegistry } from "./types";
import { createCodeTools } from "./codeTools";
import { createCodeWorkspaceTools } from "./codeWorkspaceTools";
import { createDesignTools } from "./designTools";
import { createMermaidTools } from "./mermaidTools";
import { createCompanionTools } from "./companionTools";
import { createVaultIndexTools } from "./vaultIndexTools";
import { createVaultTools } from "./vaultTools";
import { createWebViewerTools } from "./webViewerTools";
import { createWebTools } from "./webTools";
import { createSemanticSearchTools } from "./semanticSearchTools";
import { withExplicitToolDescriptor } from "./toolDescriptors";
import {
  createLinearTools,
  LINEAR_TOOL_OPERATION_MAP,
  type LinearToolClient,
} from "../integrations/linear/LinearTools";
import type { LinearCapabilityGate } from "../integrations/linear/types";
import type { OptionalExtensionCapabilityStateV1 } from "../extensions/extensionCapabilities";
import { PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME } from "./researchPublicationTool";
import { PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME } from "./researchProjectHierarchyTool";
import { PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME } from "./githubPublicationTool";
import { CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME } from "./githubPrivateRepositoryTool";
import { DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME } from "./githubPrivateRepositoryCleanupTool";
import { GITHUB_CATALOG_TOOL_OPERATION_MAP } from "./githubCatalogTools";

export interface DefaultToolRegistryOptions {
  linear?: {
    client: LinearToolClient;
    gate: LinearCapabilityGate;
    researchPublicationTool?: AgentTool;
    researchProjectHierarchyTool?: AgentTool;
  };
  githubPublicationTool?: AgentTool;
  githubPrivateRepositoryTool?: AgentTool;
  githubPrivateRepositoryCleanupTool?: AgentTool;
  githubCatalogTools?: ReadonlyArray<AgentTool>;
  extensionTools?: ReadonlyArray<AgentTool>;
  /**
   * Production passes the live registration-derived state. Omission retains
   * the legacy all-enabled catalog for isolated unit callers.
   */
  optionalCapabilities?: OptionalExtensionCapabilityStateV1;
  /** Rechecked at every handler boundary so unload revokes captured tools. */
  isOptionalCapabilityAvailable?: (
    capability: keyof OptionalExtensionCapabilityStateV1,
  ) => boolean;
  /**
   * Transitional host bridges are opt-in per domain. Production disables a
   * bridge once its extension owns the real implementation so registration
   * can never expose the old host-process fallback.
   */
  legacyCompatibility?: Partial<
    Record<keyof OptionalExtensionCapabilityStateV1, boolean>
  >;
}

let reservedCoreToolNames: ReadonlyArray<string> | null = null;
let coreToolNameReservations: ReadonlyArray<CoreToolNameReservation> | null = null;

export interface CoreToolNameReservation {
  name: string;
  ownerExtensionId: string | null;
}

export const CODE_EXTENSION_V2_TOOL_NAMES = Object.freeze([
  "code_workspace_create",
  "code_workspace_status",
  "code_workspace_stat",
  "code_workspace_list",
  "code_workspace_read",
  "code_workspace_search",
  "code_workspace_mkdir",
  "code_workspace_create_file",
  "code_workspace_append",
  "code_workspace_write_expected",
  "code_workspace_patch",
  "code_workspace_move",
  "code_workspace_copy",
  "code_workspace_trash",
  "code_workspace_restore",
  "code_repository_detect_profile",
  "code_sandbox_status",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "code_repair_status",
  "code_repair_record_cycle",
  "code_commit_verified",
] as const);

/**
 * Complete host-owned name catalog used by extension registration. This
 * includes every fixed Linear and GitHub tool, not only the names enabled by
 * the current capability gates, so an extension cannot claim a dormant host
 * capability.
 */
export function getReservedCoreToolNames(): ReadonlyArray<string> {
  if (!reservedCoreToolNames) {
    reservedCoreToolNames = Object.freeze(
      getCoreToolNameReservations().map((reservation) => reservation.name),
    );
  }
  return reservedCoreToolNames;
}

/**
 * Host catalog with the sole extension allowed to adopt each compatibility
 * tool name. A null owner is a permanently core-owned capability.
 */
export function getCoreToolNameReservations(): ReadonlyArray<CoreToolNameReservation> {
  if (!coreToolNameReservations) {
    const reservations: CoreToolNameReservation[] = [
      ...createCoreOwnedTools().map((tool) => ({
        name: tool.name,
        ownerExtensionId: null,
      })),
      ...createCodeCompatibilityTools().map((tool) => ({
        name: tool.name,
        ownerExtensionId: "agentic-researcher-code",
      })),
      ...CODE_EXTENSION_V2_TOOL_NAMES.map((name) => ({
        name,
        ownerExtensionId: "agentic-researcher-code",
      })),
      ...createCompanionCompatibilityTools().map((tool) => ({
        name: tool.name,
        ownerExtensionId: "agentic-researcher-companion",
      })),
      ...Object.keys(LINEAR_TOOL_OPERATION_MAP).map((name) => ({
        name,
        ownerExtensionId: "agentic-researcher-integrations",
      })),
      ...Object.keys(GITHUB_CATALOG_TOOL_OPERATION_MAP).map((name) => ({
        name,
        ownerExtensionId: "agentic-researcher-integrations",
      })),
      {
        name: PUBLISH_RESEARCH_TO_LINEAR_TOOL_NAME,
        ownerExtensionId: "agentic-researcher-integrations",
      },
      {
        name: PUBLISH_RESEARCH_PROJECT_TO_LINEAR_TOOL_NAME,
        ownerExtensionId: "agentic-researcher-integrations",
      },
      {
        name: PUBLISH_VERIFIED_CODE_TO_GITHUB_TOOL_NAME,
        ownerExtensionId: "agentic-researcher-integrations",
      },
      {
        name: CREATE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
        ownerExtensionId: "agentic-researcher-integrations",
      },
      {
        name: DELETE_PRIVATE_GITHUB_REPOSITORY_TOOL_NAME,
        ownerExtensionId: "agentic-researcher-integrations",
      },
    ];
    const unique = new Map<string, CoreToolNameReservation>();
    for (const reservation of reservations) {
      const existing = unique.get(reservation.name);
      if (existing && existing.ownerExtensionId !== reservation.ownerExtensionId) {
        throw new TypeError(`Conflicting core tool ownership for ${reservation.name}.`);
      }
      unique.set(reservation.name, Object.freeze(reservation));
    }
    coreToolNameReservations = Object.freeze([...unique.values()]);
  }
  return coreToolNameReservations;
}

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const capabilities = options.optionalCapabilities ?? {
    code: true,
    integrations: true,
    companion: true,
  };
  const extensionTools = [...(options.extensionTools ?? [])];
  const extensionToolNames = new Set(extensionTools.map((tool) => tool.name));
  const builtInTools = createCoreBuiltInTools(
    capabilities,
    options.isOptionalCapabilityAvailable,
    options.legacyCompatibility,
  ).filter(
    (tool) => !extensionToolNames.has(tool.name),
  );
  const linearTools =
    capabilities.integrations && options.linear
      ? guardCompatibilityTools(
          createLinearTools(options.linear),
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter(
          (tool) => !extensionToolNames.has(tool.name),
        )
      : [];
  const researchPublicationTools =
    capabilities.integrations && options.linear?.researchPublicationTool
      ? guardCompatibilityTools(
          [options.linear.researchPublicationTool],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const researchProjectHierarchyTools =
    capabilities.integrations && options.linear?.researchProjectHierarchyTool
      ? guardCompatibilityTools(
          [options.linear.researchProjectHierarchyTool],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const githubPublicationTools =
    capabilities.integrations && options.githubPublicationTool
      ? guardCompatibilityTools(
          [options.githubPublicationTool],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const githubPrivateRepositoryTools =
    capabilities.integrations && options.githubPrivateRepositoryTool
      ? guardCompatibilityTools(
          [options.githubPrivateRepositoryTool],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const githubPrivateRepositoryCleanupTools =
    capabilities.integrations && options.githubPrivateRepositoryCleanupTool
      ? guardCompatibilityTools(
          [options.githubPrivateRepositoryCleanupTool],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const githubCatalogTools =
    capabilities.integrations && options.githubCatalogTools
      ? guardCompatibilityTools(
          [...options.githubCatalogTools],
          "integrations",
          options.isOptionalCapabilityAvailable,
        ).filter((tool) => !extensionToolNames.has(tool.name))
      : [];
  const tools = [
    ...builtInTools,
    ...linearTools,
    ...researchPublicationTools,
    ...researchProjectHierarchyTools,
    ...githubCatalogTools,
    ...githubPrivateRepositoryTools,
    ...githubPrivateRepositoryCleanupTools,
    ...githubPublicationTools,
    ...extensionTools,
  ];
  return new DefaultToolRegistry(tools);
}

function createCoreBuiltInTools(
  capabilities: OptionalExtensionCapabilityStateV1 = {
    code: true,
    integrations: true,
    companion: true,
  },
  isAvailable?: DefaultToolRegistryOptions["isOptionalCapabilityAvailable"],
  legacyCompatibility: DefaultToolRegistryOptions["legacyCompatibility"] = {},
): AgentTool[] {
  return [
    ...createCoreOwnedTools(),
    ...(capabilities.code && legacyCompatibility.code !== false
      ? guardCompatibilityTools(createCodeCompatibilityTools(), "code", isAvailable)
      : []),
    ...(capabilities.companion && legacyCompatibility.companion !== false
      ? guardCompatibilityTools(
          createCompanionCompatibilityTools(),
          "companion",
          isAvailable,
        )
      : []),
  ];
}

function createCoreOwnedTools(): AgentTool[] {
  return [
    ...createVaultTools(),
    ...createVaultIndexTools(),
    ...createSemanticSearchTools(),
    ...createWebTools(),
    ...createWebViewerTools(),
    ...createDesignTools(),
    ...createMermaidTools(),
  ].map(withExplicitToolDescriptor);
}

function createCodeCompatibilityTools(): AgentTool[] {
  return [...createCodeTools(), ...createCodeWorkspaceTools()].map(
    withExplicitToolDescriptor,
  );
}

function createCompanionCompatibilityTools(): AgentTool[] {
  return createCompanionTools().map(withExplicitToolDescriptor);
}

function guardCompatibilityTools(
  tools: AgentTool[],
  capability: keyof OptionalExtensionCapabilityStateV1,
  isAvailable?: DefaultToolRegistryOptions["isOptionalCapabilityAvailable"],
): AgentTool[] {
  if (!isAvailable) {
    return tools;
  }
  const assertAvailable = () => {
    if (!isAvailable(capability)) {
      throw new ToolExecutionError(
        "extension_unavailable",
        `Built-in capability is unavailable: ${capability}`,
        { mutationState: "not_applied" },
      );
    }
  };
  return tools.map((tool) => ({
    ...tool,
    async execute(args, context) {
      assertAvailable();
      const result = await tool.execute(args, context);
      assertAvailable();
      return result;
    },
    ...(tool.executeResult
      ? {
          async executeResult(args, context) {
            assertAvailable();
            const result = await tool.executeResult!(args, context);
            assertAvailable();
            return result;
          },
        }
      : {}),
    ...(tool.prepare
      ? {
          async prepare(args, context) {
            assertAvailable();
            const result = await tool.prepare!(args, context);
            assertAvailable();
            return result;
          },
        }
      : {}),
    ...(tool.executePrepared
      ? {
          async executePrepared(action, context) {
            assertAvailable();
            const result = await tool.executePrepared!(action, context);
            assertAvailable();
            return result;
          },
        }
      : {}),
    ...(tool.reconcile
      ? {
          async reconcile(action, context) {
            assertAvailable();
            const result = await tool.reconcile!(action, context);
            assertAvailable();
            return result;
          },
        }
      : {}),
  }));
}
