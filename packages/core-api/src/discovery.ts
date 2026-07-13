import type { AgenticResearcherCoreApiV1 } from "./contracts";

export const AGENTIC_RESEARCHER_CORE_PLUGIN_ID = "agentic-researcher" as const;
export const AGENTIC_RESEARCHER_CORE_READY_EVENT =
  "agentic-researcher:core-ready" as const;
export const AGENTIC_RESEARCHER_CORE_UNLOADING_EVENT =
  "agentic-researcher:core-unloading" as const;
/** Companion emits this after an authenticated session becomes available. */
export const AGENTIC_RESEARCHER_COMPANION_RECONCILE_EVENT =
  "agentic-researcher:companion-reconcile" as const;

export interface AgenticResearcherCorePluginV1 {
  agenticResearcherApi?: AgenticResearcherCoreApiV1;
}
