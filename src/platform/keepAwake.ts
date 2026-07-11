export type KeepAwakeMode = "prevent-app-suspension";

export interface KeepAwakeAcquireOptions {
  missionId: string;
  mode?: KeepAwakeMode;
}

export interface KeepAwakeLease {
  readonly id: string;
  readonly missionId: string;
  readonly mode: KeepAwakeMode;
  /** True only when the platform actually acquired a native blocker. */
  readonly acquired: boolean;
  readonly warning?: string;
  readonly released: boolean;
  release(): Promise<void>;
}

export interface KeepAwakeController {
  readonly supported: boolean;
  acquire(options: KeepAwakeAcquireOptions): Promise<KeepAwakeLease>;
}

/**
 * Safe default used until an Electron adapter is explicitly wired. It never
 * claims that suspension protection is active and its lease is idempotently
 * releasable, which keeps supervisor cleanup paths platform-independent.
 */
export class NoopKeepAwakeController implements KeepAwakeController {
  readonly supported = false;

  async acquire({
    missionId,
    mode = "prevent-app-suspension",
  }: KeepAwakeAcquireOptions): Promise<KeepAwakeLease> {
    const normalizedMissionId = missionId.trim();
    if (!normalizedMissionId) {
      throw new Error("missionId must be a non-empty string.");
    }
    return new NoopKeepAwakeLease(normalizedMissionId, mode);
  }
}

export function createNoopKeepAwakeController(): KeepAwakeController {
  return new NoopKeepAwakeController();
}

class NoopKeepAwakeLease implements KeepAwakeLease {
  readonly id: string;
  readonly acquired = false;
  readonly warning =
    "Keep-awake is unavailable; application suspension is not prevented.";
  private isReleased = false;

  constructor(
    readonly missionId: string,
    readonly mode: KeepAwakeMode,
  ) {
    this.id = `noop:${missionId}`;
  }

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    this.isReleased = true;
  }
}
