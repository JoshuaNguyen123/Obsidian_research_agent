/**
 * Decide whether a note switch needs to re-read project memory.
 *
 * `file-open` and `active-leaf-change` both fire for one click, and each used
 * to read and parse the four Agent Memory JSON files, so a single note switch
 * cost about eight raw reads. The memory location depends on the active note's
 * project folder, so a reload IS needed when the location changes or one of
 * the files changed on disk -- but Obsidian already knows each file's mtime
 * and size without I/O. A signature over the location and those stats tells
 * the two cases apart, and a trailing debounce folds the paired events into
 * one decision.
 */

export interface ProjectMemoryFileStatV1 {
  path: string;
  mtime: number | null;
  size: number | null;
}

export function buildProjectMemorySignatureV1(
  memoryFolder: string,
  stats: readonly ProjectMemoryFileStatV1[],
): string {
  const parts = [...stats]
    .sort((left, right) => left.path.localeCompare(right.path))
    .map((stat) => `${stat.path}@${stat.mtime ?? "-"}:${stat.size ?? "-"}`);
  return `${memoryFolder}|${parts.join("|")}`;
}

/** True the first time and whenever the signature moved. */
export function shouldReloadProjectMemoryV1(
  previousSignature: string | null,
  nextSignature: string,
): boolean {
  return previousSignature === null || previousSignature !== nextSignature;
}

export interface TrailingDebounceTimers {
  set: (callback: () => void, delayMs: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface TrailingDebounce {
  schedule(): void;
  cancel(): void;
  /** Run now if a call is pending; no-op otherwise. */
  flush(): void;
}

export function createTrailingDebounce(
  callback: () => void,
  delayMs: number,
  timers: TrailingDebounceTimers = {
    set: (fn, ms) => setTimeout(fn, ms),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
): TrailingDebounce {
  let handle: unknown = null;
  const fire = () => {
    handle = null;
    callback();
  };
  return {
    schedule() {
      if (handle !== null) timers.clear(handle);
      handle = timers.set(fire, Math.max(0, delayMs));
    },
    cancel() {
      if (handle !== null) timers.clear(handle);
      handle = null;
    },
    flush() {
      if (handle === null) return;
      timers.clear(handle);
      fire();
    },
  };
}
