/**
 * Carry the read-only, provenance-bound parts of a run's in-memory cache into
 * the next continuation segment of the same root mission.
 *
 * Every segment used to start with an empty `AgentRuntimeCache`, so a
 * `web_fetch` the previous segment already paid for was fetched again (unless
 * the vault-backed source cache happened to cover it) and its strong-hash
 * trust record was lost. What carries is deliberately narrow:
 *
 * - `toolResults` entries for `web_fetch` / `web_search` -- pure functions of
 *   their arguments whose payloads are immutable once fetched;
 * - `trustedWebFetchResults` -- hash-bound reads downstream proof tools rely on.
 *
 * Vault reads stay segment-scoped (a note may have changed between segments),
 * and so do workspace reads, Mermaid observations, the fast-validation
 * diagnostic, and the run-local ideation brief (its docstring makes it
 * restart-bound by design). The returned maps are fresh objects: a later
 * segment can never mutate the previous segment's cache through aliasing.
 */
import type { AgentRuntimeCache } from "../tools/types";

export const CARRIED_TOOL_RESULT_KEY_PREFIXES_V1 = [
  "web_fetch:",
  "web_search:",
] as const;

export function isCarriedToolResultKeyV1(key: string): boolean {
  return CARRIED_TOOL_RESULT_KEY_PREFIXES_V1.some((prefix) =>
    key.startsWith(prefix),
  );
}

export function createCarriedRuntimeCacheV1(
  previous?: AgentRuntimeCache | null,
): AgentRuntimeCache {
  const next: AgentRuntimeCache = {
    toolResults: new Map(),
    trustedWebFetchResults: new Map(),
    verifiedWorkspaceReads: new Map(),
  };
  if (!previous) {
    return next;
  }
  for (const [key, result] of previous.toolResults) {
    if (isCarriedToolResultKeyV1(key) && result.ok) {
      next.toolResults.set(key, result);
    }
  }
  for (const [key, result] of previous.trustedWebFetchResults ?? []) {
    next.trustedWebFetchResults!.set(key, result);
  }
  return next;
}
