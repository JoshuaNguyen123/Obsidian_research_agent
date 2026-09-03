import type { HostWorkPhaseV1, ToolExecutionContext } from "../tools/types";

export type { HostWorkPhaseV1 };

/** Metric kind the runner emits for observed host work. */
export const HOST_WORK_METRIC_KIND_V1 = "host_work" as const;

export function hostWorkNowMs(): number {
  return typeof performance !== "undefined" &&
    typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

/**
 * Run `work` and report its wall-clock duration to the context's host-work
 * observer, when there is one. The observer can never fail the work: an
 * observer that throws is swallowed, and a context without one costs a single
 * property read.
 */
export async function observeHostWorkV1<T>(
  context: Pick<ToolExecutionContext, "observeHostWork"> | null | undefined,
  phase: HostWorkPhaseV1,
  work: () => Promise<T>,
): Promise<T> {
  const observer = context?.observeHostWork;
  if (typeof observer !== "function") {
    return work();
  }
  const startedAt = hostWorkNowMs();
  try {
    return await work();
  } finally {
    try {
      observer(phase, Math.max(0, hostWorkNowMs() - startedAt));
    } catch {
      // Observers never break a durable write.
    }
  }
}
