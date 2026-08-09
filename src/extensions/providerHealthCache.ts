export const PROVIDER_HEALTH_TTL_MS_V1 = 15 * 60_000;

export type ProviderHealthNameV1 = "linear" | "github";

export interface ProviderHealthResultV1 {
  version: 1;
  provider: ProviderHealthNameV1;
  status: "healthy" | "degraded" | "blocked" | "disabled";
  summary: string;
  checkedAt: string;
  expiresAt: string | null;
  details?: Record<string, string | number | boolean | null | string[]>;
}

/** Session-only provider proof. Restart and TTL expiry deliberately degrade. */
export class ProviderHealthCacheV1 {
  private generation = 0;
  private readonly records = new Map<ProviderHealthNameV1, ProviderHealthResultV1>();

  beginRefresh(): number {
    this.generation += 1;
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }

  commit(
    generation: number,
    results: readonly ProviderHealthResultV1[],
  ): boolean {
    if (!this.isCurrent(generation)) return false;
    for (const result of results) {
      this.records.set(result.provider, cloneResult(result));
    }
    return true;
  }

  read(input: {
    provider: ProviderHealthNameV1;
    enabled: boolean;
    credentialPresent: boolean;
    now?: Date;
  }): ProviderHealthResultV1 {
    const now = input.now ?? new Date();
    const checkedAt = now.toISOString();
    if (!input.enabled) {
      return {
        version: 1,
        provider: input.provider,
        status: "disabled",
        summary: `${displayProvider(input.provider)} is switched off.`,
        checkedAt,
        expiresAt: null,
      };
    }
    if (!input.credentialPresent) {
      return {
        version: 1,
        provider: input.provider,
        status: "blocked",
        summary: `${displayProvider(input.provider)} is enabled but has no verified credential.`,
        checkedAt,
        expiresAt: null,
      };
    }
    const cached = this.records.get(input.provider);
    const expiresAtMs = cached?.expiresAt ? Date.parse(cached.expiresAt) : NaN;
    if (cached && Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime()) {
      return cloneResult(cached);
    }
    return {
      version: 1,
      provider: input.provider,
      status: "degraded",
      summary: cached
        ? `${displayProvider(input.provider)} verification expired. Select Refresh health.`
        : `${displayProvider(input.provider)} has not been verified in this session. Select Refresh health.`,
      checkedAt: cached?.checkedAt ?? checkedAt,
      expiresAt: cached?.expiresAt ?? null,
      ...(cached?.details ? { details: { ...cached.details } } : {}),
    };
  }
}

export function createProviderHealthResultV1(input: {
  provider: ProviderHealthNameV1;
  status: ProviderHealthResultV1["status"];
  summary: string;
  checkedAt?: Date;
  ttlMs?: number;
  details?: ProviderHealthResultV1["details"];
}): ProviderHealthResultV1 {
  const checkedAt = input.checkedAt ?? new Date();
  const ttlMs = Math.max(1_000, input.ttlMs ?? PROVIDER_HEALTH_TTL_MS_V1);
  return {
    version: 1,
    provider: input.provider,
    status: input.status,
    summary: input.summary,
    checkedAt: checkedAt.toISOString(),
    expiresAt: new Date(checkedAt.getTime() + ttlMs).toISOString(),
    ...(input.details ? { details: { ...input.details } } : {}),
  };
}

function displayProvider(provider: ProviderHealthNameV1): string {
  return provider === "github" ? "GitHub" : "Linear";
}

function cloneResult(result: ProviderHealthResultV1): ProviderHealthResultV1 {
  return {
    ...result,
    ...(result.details ? { details: { ...result.details } } : {}),
  };
}
