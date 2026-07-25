export interface FrameScheduler {
  request(callback: () => void): number;
  cancel(handle: number): void;
}

/**
 * Coalesces repeated work for the same key into one callback per animation
 * frame. The latest callback wins because UI projections should render the
 * latest state, not replay every intermediate layout mutation.
 */
export class KeyedFrameBatcher<Key> {
  private readonly scheduler: FrameScheduler;
  private readonly pending = new Map<Key, () => void>();
  private frameHandle: number | null = null;

  constructor(scheduler: FrameScheduler) {
    this.scheduler = scheduler;
  }

  schedule(key: Key, callback: () => void): void {
    this.pending.set(key, callback);
    if (this.frameHandle !== null) return;
    this.frameHandle = this.scheduler.request(() => this.runFrame());
  }

  flush(key: Key): void {
    const callback = this.pending.get(key);
    if (!callback) return;
    this.pending.delete(key);
    callback();
    this.cancelEmptyFrame();
  }

  flushAll(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }

  cancel(key: Key): void {
    this.pending.delete(key);
    this.cancelEmptyFrame();
  }

  cancelAll(): void {
    if (this.frameHandle !== null) {
      this.scheduler.cancel(this.frameHandle);
      this.frameHandle = null;
    }
    this.pending.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  private runFrame(): void {
    this.frameHandle = null;
    const callbacks = [...this.pending.values()];
    this.pending.clear();
    for (const callback of callbacks) callback();
  }

  private cancelEmptyFrame(): void {
    if (this.pending.size > 0 || this.frameHandle === null) return;
    this.scheduler.cancel(this.frameHandle);
    this.frameHandle = null;
  }
}

export function createBrowserFrameScheduler(scope: Window): FrameScheduler {
  if (typeof scope.requestAnimationFrame === "function") {
    return {
      request: (callback) => scope.requestAnimationFrame(() => callback()),
      cancel: (handle) => scope.cancelAnimationFrame(handle),
    };
  }
  return {
    request: (callback) => scope.setTimeout(callback, 16),
    cancel: (handle) => scope.clearTimeout(handle),
  };
}
