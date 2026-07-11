import {
  NoopKeepAwakeController,
  type KeepAwakeAcquireOptions,
  type KeepAwakeController,
  type KeepAwakeLease,
  type KeepAwakeMode,
} from "./keepAwake";
import { getNodeRequireForObsidian } from "./nodeRequire";

export interface ElectronPowerSaveBlocker {
  start(mode: KeepAwakeMode): number;
  stop(id: number): boolean;
  isStarted(id: number): boolean;
}

export function createElectronKeepAwakeController(
  blocker: ElectronPowerSaveBlocker | null = resolveElectronPowerSaveBlocker(),
): KeepAwakeController {
  return blocker
    ? new ElectronKeepAwakeController(blocker)
    : new NoopKeepAwakeController();
}

export function resolveElectronPowerSaveBlocker(): ElectronPowerSaveBlocker | null {
  const nodeRequire = getNodeRequireForObsidian();
  if (!nodeRequire) {
    return null;
  }

  try {
    const electron = nodeRequire("electron") as {
      powerSaveBlocker?: ElectronPowerSaveBlocker;
      remote?: { powerSaveBlocker?: ElectronPowerSaveBlocker };
    };
    const blocker = electron.powerSaveBlocker ?? electron.remote?.powerSaveBlocker;
    if (isPowerSaveBlocker(blocker)) {
      return blocker;
    }
  } catch {
    // Fall through to @electron/remote for Obsidian builds that expose main
    // process APIs through the maintained remote bridge.
  }

  try {
    const remote = nodeRequire("@electron/remote") as {
      powerSaveBlocker?: ElectronPowerSaveBlocker;
    };
    return isPowerSaveBlocker(remote.powerSaveBlocker)
      ? remote.powerSaveBlocker
      : null;
  } catch {
    return null;
  }
}

class ElectronKeepAwakeController implements KeepAwakeController {
  readonly supported = true;

  constructor(private readonly blocker: ElectronPowerSaveBlocker) {}

  async acquire({
    missionId,
    mode = "prevent-app-suspension",
  }: KeepAwakeAcquireOptions): Promise<KeepAwakeLease> {
    const normalizedMissionId = missionId.trim();
    if (!normalizedMissionId) {
      throw new Error("missionId must be a non-empty string.");
    }

    try {
      const nativeId = this.blocker.start(mode);
      const acquired = this.blocker.isStarted(nativeId);
      return new ElectronKeepAwakeLease({
        blocker: this.blocker,
        nativeId,
        missionId: normalizedMissionId,
        mode,
        acquired,
        warning: acquired
          ? undefined
          : "Electron did not confirm the keep-awake request.",
      });
    } catch (error) {
      return new FailedKeepAwakeLease(
        normalizedMissionId,
        mode,
        `Keep-awake could not be started: ${getErrorMessage(error)}`,
      );
    }
  }
}

class ElectronKeepAwakeLease implements KeepAwakeLease {
  readonly id: string;
  private isReleased = false;

  constructor(
    private readonly options: {
      blocker: ElectronPowerSaveBlocker;
      nativeId: number;
      missionId: string;
      mode: KeepAwakeMode;
      acquired: boolean;
      warning?: string;
    },
  ) {
    this.id = `electron:${options.nativeId}`;
  }

  get missionId(): string {
    return this.options.missionId;
  }

  get mode(): KeepAwakeMode {
    return this.options.mode;
  }

  get acquired(): boolean {
    return this.options.acquired;
  }

  get warning(): string | undefined {
    return this.options.warning;
  }

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    if (this.isReleased) {
      return;
    }
    this.isReleased = true;
    if (this.options.acquired && this.options.blocker.isStarted(this.options.nativeId)) {
      this.options.blocker.stop(this.options.nativeId);
    }
  }
}

class FailedKeepAwakeLease implements KeepAwakeLease {
  readonly id: string;
  readonly acquired = false;
  private isReleased = false;

  constructor(
    readonly missionId: string,
    readonly mode: KeepAwakeMode,
    readonly warning: string,
  ) {
    this.id = `failed:${missionId}`;
  }

  get released(): boolean {
    return this.isReleased;
  }

  async release(): Promise<void> {
    this.isReleased = true;
  }
}

function isPowerSaveBlocker(
  value: ElectronPowerSaveBlocker | undefined,
): value is ElectronPowerSaveBlocker {
  return Boolean(
    value &&
      typeof value.start === "function" &&
      typeof value.stop === "function" &&
      typeof value.isStarted === "function",
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
