import { DefaultToolRegistry } from "./ToolRegistry";
import type { ToolRegistry } from "./types";
import { createCodeTools } from "./codeTools";
import { createDesignTools } from "./designTools";
import { createCompanionTools } from "./companionTools";
import { createVaultIndexTools } from "./vaultIndexTools";
import { createVaultTools } from "./vaultTools";
import { createWebViewerTools } from "./webViewerTools";
import { createWebTools } from "./webTools";
import { createSemanticSearchTools } from "./semanticSearchTools";

export function createDefaultToolRegistry(): ToolRegistry {
  return new DefaultToolRegistry([
    ...createVaultTools(),
    ...createVaultIndexTools(),
    ...createSemanticSearchTools(),
    ...createWebTools(),
    ...createWebViewerTools(),
    ...createCodeTools(),
    ...createDesignTools(),
    ...createCompanionTools(),
  ]);
}
