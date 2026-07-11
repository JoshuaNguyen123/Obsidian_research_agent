import { DefaultToolRegistry } from "./ToolRegistry";
import type { ToolRegistry } from "./types";
import { createCodeTools } from "./codeTools";
import { createCodeWorkspaceTools } from "./codeWorkspaceTools";
import { createDesignTools } from "./designTools";
import { createCompanionTools } from "./companionTools";
import { createVaultIndexTools } from "./vaultIndexTools";
import { createVaultTools } from "./vaultTools";
import { createWebViewerTools } from "./webViewerTools";
import { createWebTools } from "./webTools";
import { createSemanticSearchTools } from "./semanticSearchTools";
import { withExplicitToolDescriptor } from "./toolDescriptors";
import {
  createLinearTools,
  type LinearToolClient,
} from "../integrations/linear/LinearTools";
import type { LinearCapabilityGate } from "../integrations/linear/types";

export interface DefaultToolRegistryOptions {
  linear?: {
    client: LinearToolClient;
    gate: LinearCapabilityGate;
  };
}

export function createDefaultToolRegistry(
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const builtInTools = [
    ...createVaultTools(),
    ...createVaultIndexTools(),
    ...createSemanticSearchTools(),
    ...createWebTools(),
    ...createWebViewerTools(),
    ...createCodeTools(),
    ...createCodeWorkspaceTools(),
    ...createDesignTools(),
    ...createCompanionTools(),
  ].map(withExplicitToolDescriptor);
  const tools = [
    ...builtInTools,
    ...(options.linear ? createLinearTools(options.linear) : []),
  ];
  return new DefaultToolRegistry(tools);
}
