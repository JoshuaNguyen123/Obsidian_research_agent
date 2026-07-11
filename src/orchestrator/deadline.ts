export interface LinkedDeadlineSignal {
  signal: AbortSignal;
  dispose(): void;
}

/** Links participant/root wall-clock exhaustion to the caller's cancellation. */
export function createLinkedDeadlineSignal(
  parent: AbortSignal,
  timeoutMs: number,
  timeoutMessage: string,
): LinkedDeadlineSignal {
  const controller = new AbortController();
  const forwardParentAbort = () => {
    controller.abort(
      parent.reason instanceof Error
        ? parent.reason
        : new Error("Orchestrated run was cancelled."),
    );
  };
  if (parent.aborted) {
    forwardParentAbort();
  } else {
    parent.addEventListener("abort", forwardParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(new Error(timeoutMessage));
  }, Math.max(1, Math.floor(timeoutMs)));
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer);
      parent.removeEventListener("abort", forwardParentAbort);
    },
  };
}

export function getAbortSignalMessage(
  signal: AbortSignal,
  fallback: string,
): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : typeof signal.reason === "string" && signal.reason.trim()
      ? signal.reason.trim()
      : fallback;
}
