/**
 * Settle `work` the moment `signal` aborts, without waiting for the
 * underlying operation. Use it around awaits on the mission path that cannot
 * be cancelled themselves (a Python subprocess request, a queued helper call)
 * so a stopped run reaches its stop boundary instead of waiting out the
 * helper. The abandoned operation still runs to completion in the
 * background; callers must treat its eventual result as irrelevant.
 */
export function abortError(): DOMException {
  return new DOMException("The operation was aborted.", "AbortError");
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function raceAbort<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (!signal) {
    return work;
  }
  if (signal.aborted) {
    return Promise.reject(abortError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}
