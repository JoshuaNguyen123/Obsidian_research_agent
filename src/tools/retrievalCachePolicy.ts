import type { ToolExecutionContext } from "./types";
import { SOURCE_CACHE_FRESH_MS, SOURCE_CACHE_MAX_AGE_MS, resolveSourceCacheMissionId } from "./sourceCache";
import { getOptionalBoolean, getOptionalInteger } from "./validation";

/** Host-owned defaults, carried independently of specialist/model instructions. */
export interface RetrievalCacheDefaults {
  refresh: boolean;
}

export interface ResolvedRetrievalCachePolicy extends RetrievalCacheDefaults {
  maxAgeMs: number;
  missionId?: string;
}

export function retrievalCacheDefaultsForMission(prompt: string): RetrievalCacheDefaults {
  return { refresh: /\b(current(?:ly)?|latest|today|now|recent|newest|up[- ]to[- ]date|as of)\b/i.test(prompt) };
}

/** Explicit refresh wins; an explicit age suppresses the implicit refresh default.
 * Zero age always bypasses, even with refresh=false. */
export function resolveRetrievalCachePolicy(
  args: Record<string, unknown>, context: ToolExecutionContext,
): ResolvedRetrievalCachePolicy {
  const age = getOptionalInteger(args, "max_age_ms");
  if (age !== undefined && (age < 0 || age > SOURCE_CACHE_MAX_AGE_MS)) {
    throw new Error(`max_age_ms must be between 0 and ${SOURCE_CACHE_MAX_AGE_MS}.`);
  }
  return {
    maxAgeMs: age ?? SOURCE_CACHE_FRESH_MS,
    refresh: getOptionalBoolean(args, "refresh") ?? (age === undefined &&
      (context.retrievalCacheDefaults ?? retrievalCacheDefaultsForMission(context.originalPrompt ?? "")).refresh),
    missionId: resolveSourceCacheMissionId(context),
  };
}
