import { DefaultToolRegistry } from "./ToolRegistry";
import type { ToolRegistry } from "./types";
import { createVaultTools } from "./vaultTools";
import { createWebTools } from "./webTools";

export function createDefaultToolRegistry(): ToolRegistry {
  return new DefaultToolRegistry([...createVaultTools(), ...createWebTools()]);
}
