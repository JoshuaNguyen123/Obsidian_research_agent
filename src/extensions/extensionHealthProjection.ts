import type {
  ExtensionHealthStatusV1,
  ExtensionMissionSnapshotV1,
  ExtensionSettingFieldV1,
  ScopedExtensionContextV1,
} from "../../packages/core-api/src";

export const DEFAULT_EXTENSION_HEALTH_TIMEOUT_MS = 2_000;

export type ExtensionHealthFailureCode =
  | "timeout"
  | "handler_failed"
  | "extension_unavailable";

export interface ExtensionHealthProjectionEntryV1 {
  version: 1;
  extensionId: string;
  contributionId: string;
  displayName: string;
  status: ExtensionHealthStatusV1["status"];
  summary: string;
  details: Readonly<Record<string, unknown>>;
  checkedAt: string;
  failureCode?: ExtensionHealthFailureCode;
}

export interface ExtensionSettingsSectionProjectionV1 {
  version: 1;
  extensionId: string;
  contributionId: string;
  title: string;
  fields: ReadonlyArray<ExtensionSettingFieldProjectionV1>;
}

export type ExtensionSettingFieldProjectionV1 = Readonly<
  Omit<ExtensionSettingFieldV1, "options"> & {
    options?: ReadonlyArray<Readonly<{ label: string; value: string }>>;
  }
>;

export interface ExtensionRuntimeProjectionV1 {
  version: 1;
  revision: number;
  refreshedAt: string;
  health: ReadonlyArray<Readonly<ExtensionHealthProjectionEntryV1>>;
  settings: ReadonlyArray<Readonly<ExtensionSettingsSectionProjectionV1>>;
}

export interface ReadExtensionRuntimeProjectionInput {
  snapshot: ExtensionMissionSnapshotV1;
  revision: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  now?: () => Date;
  /** Host-owned generation check. False discards the completed projection. */
  isCurrent?: () => boolean;
}

/**
 * Reads optional-extension health without exposing Obsidian, settings, models,
 * secrets, or vault handles. Snapshot handlers are already token-guarded by
 * the registry; this adds deadline/abort isolation and result normalization.
 */
export async function readExtensionRuntimeProjection(
  input: ReadExtensionRuntimeProjectionInput,
): Promise<ExtensionRuntimeProjectionV1 | null> {
  const timeoutMs = normalizeTimeout(input.timeoutMs);
  const now = input.now ?? (() => new Date());
  const settings = projectExtensionSettings(input.snapshot);
  const health = await Promise.all(
    input.snapshot.statuses.map((registered) =>
      readHealthContribution({
        registered,
        missionId: input.snapshot.missionId,
        timeoutMs,
        signal: input.signal,
        now,
      }),
    ),
  );

  if (input.signal?.aborted || input.isCurrent?.() === false) {
    return null;
  }

  return Object.freeze({
    version: 1,
    revision: input.revision,
    refreshedAt: now().toISOString(),
    health: Object.freeze(health),
    settings,
  });
}

export function createEmptyExtensionRuntimeProjection(
  revision = 0,
  at = new Date(0).toISOString(),
): ExtensionRuntimeProjectionV1 {
  return Object.freeze({
    version: 1,
    revision,
    refreshedAt: at,
    health: Object.freeze([]),
    settings: Object.freeze([]),
  });
}

export function projectExtensionSettings(
  snapshot: ExtensionMissionSnapshotV1,
): ReadonlyArray<Readonly<ExtensionSettingsSectionProjectionV1>> {
  return Object.freeze(
    snapshot.settings.map((registered) =>
      Object.freeze({
        version: 1 as const,
        extensionId: registered.extensionId,
        contributionId: registered.contribution.descriptor.id,
        title: registered.contribution.section.title,
        fields: Object.freeze(
          registered.contribution.section.fields.map((field) =>
            Object.freeze({
              ...field,
              ...(field.options
                ? {
                    options: Object.freeze(
                      field.options.map((option) => Object.freeze({ ...option })),
                    ),
                  }
                : {}),
            }),
          ),
        ),
      }),
    ),
  );
}

interface RegisteredStatusInput {
  registered: ExtensionMissionSnapshotV1["statuses"][number];
  missionId: string;
  timeoutMs: number;
  signal?: AbortSignal;
  now: () => Date;
}

async function readHealthContribution(
  input: RegisteredStatusInput,
): Promise<Readonly<ExtensionHealthProjectionEntryV1>> {
  const { registered } = input;
  const controller = new AbortController();
  let timedOut = false;
  const abortFromHost = () => controller.abort(input.signal?.reason);
  const abortFromToken = () => controller.abort(registered.token.signal.reason);
  if (input.signal?.aborted) {
    abortFromHost();
  } else {
    input.signal?.addEventListener("abort", abortFromHost, { once: true });
  }
  if (registered.token.signal.aborted) {
    abortFromToken();
  } else {
    registered.token.signal.addEventListener("abort", abortFromToken, {
      once: true,
    });
  }

  const deadlineAt = Date.now() + input.timeoutMs;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("extension_health_timeout"));
  }, input.timeoutMs);
  const context: ScopedExtensionContextV1 = Object.freeze({
    version: 1,
    extensionId: registered.extensionId,
    missionId: input.missionId,
    operationId: registered.contribution.descriptor.id,
    deadlineAt,
    abortSignal: controller.signal,
    now: input.now,
    reportProgress() {},
  });

  try {
    const raw = await Promise.race([
      registered.contribution.readStatus(context),
      waitForAbort(controller.signal),
    ]);
    return normalizeHealthResult(registered, raw, input.now);
  } catch (error) {
    if (timedOut) {
      return failureEntry(
        registered,
        "degraded",
        `Health check timed out after ${input.timeoutMs}ms.`,
        "timeout",
        input.now,
      );
    }
    if (
      registered.token.signal.aborted ||
      isExtensionUnavailableError(error)
    ) {
      return failureEntry(
        registered,
        "disabled",
        "Extension became unavailable during its health check.",
        "extension_unavailable",
        input.now,
      );
    }
    return failureEntry(
      registered,
      "blocked",
      "Extension health handler failed; core remains available.",
      "handler_failed",
      input.now,
    );
  } finally {
    clearTimeout(timeoutId);
    input.signal?.removeEventListener("abort", abortFromHost);
    registered.token.signal.removeEventListener("abort", abortFromToken);
  }
}

function normalizeHealthResult(
  registered: ExtensionMissionSnapshotV1["statuses"][number],
  value: ExtensionHealthStatusV1,
  now: () => Date,
): Readonly<ExtensionHealthProjectionEntryV1> {
  const validResult =
    isHealthStatus(value?.status) &&
    typeof value?.summary === "string" &&
    Boolean(value.summary.trim());
  const status = validResult ? value.status : "blocked";
  const summary = normalizeSummary(value?.summary, "Extension returned invalid health data.");
  const checkedAt = isIsoDate(value?.checkedAt)
    ? value.checkedAt
    : now().toISOString();
  const details = isRecord(value?.details)
    ? Object.freeze({ ...value.details })
    : Object.freeze({});
  return Object.freeze({
    version: 1,
    extensionId: registered.extensionId,
    contributionId: registered.contribution.descriptor.id,
    displayName: registered.contribution.descriptor.displayName,
    status,
    summary,
    details,
    checkedAt,
    ...(!validResult
      ? { failureCode: "handler_failed" as const }
      : {}),
  });
}

function failureEntry(
  registered: ExtensionMissionSnapshotV1["statuses"][number],
  status: ExtensionHealthStatusV1["status"],
  summary: string,
  failureCode: ExtensionHealthFailureCode,
  now: () => Date,
): Readonly<ExtensionHealthProjectionEntryV1> {
  return Object.freeze({
    version: 1,
    extensionId: registered.extensionId,
    contributionId: registered.contribution.descriptor.id,
    displayName: registered.contribution.descriptor.displayName,
    status,
    summary,
    details: Object.freeze({}),
    checkedAt: now().toISOString(),
    failureCode,
  });
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("Extension health check aborted."));
      return;
    }
    signal.addEventListener(
      "abort",
      () => reject(signal.reason ?? new Error("Extension health check aborted.")),
      { once: true },
    );
  });
}

function normalizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_EXTENSION_HEALTH_TIMEOUT_MS;
  }
  return Math.max(10, Math.min(10_000, Math.floor(value!)));
}

function normalizeSummary(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return fallback;
  }
  return value.replace(/[\r\n\t]+/gu, " ").trim().slice(0, 500);
}

function isHealthStatus(
  value: unknown,
): value is ExtensionHealthStatusV1["status"] {
  return ["healthy", "degraded", "blocked", "disabled"].includes(String(value));
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isExtensionUnavailableError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { code?: string }).code === "extension_unavailable"
  );
}
