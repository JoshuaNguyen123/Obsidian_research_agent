import { getNodeRequireForObsidian } from "./nodeRequire";

/**
 * Commit pending DOMStorage writes to disk now.
 *
 * Obsidian's native SecretStorage lives in Chromium DOMStorage, which the
 * browser process commits to its LevelDB on a delay (seconds, longer under
 * commit rate limiting). The plugin's own data.json is written straight
 * through. So a secret written moments before Obsidian is killed can vanish
 * while the data.json record that references it survives — which is exactly
 * how a rotated Linear OAuth pair was lost on 2026-09-07: rotation at
 * 19:18:34Z, the harness force-kill at 19:18:40Z, and every later launch
 * found references to secrets that had never reached disk.
 */
export type DomStorageFlusherV1 = () => void;

interface ElectronSessionLike {
  flushStorageData?: () => void;
}

interface ElectronRemoteLike {
  session?: { defaultSession?: ElectronSessionLike };
}

/**
 * Resolve Electron's `session.defaultSession.flushStorageData` through the
 * main-process bridge Obsidian exposes to the renderer. `@electron/remote` is
 * what current Obsidian builds ship; the legacy `electron.remote` alias is
 * tried second. Null when no bridge is available, in which case writes keep
 * Chromium's own commit schedule and lose nothing they did not lose before.
 */
export function resolveElectronDomStorageFlusherV1(
  nodeRequire: NodeRequire | null = getNodeRequireForObsidian(),
): DomStorageFlusherV1 | null {
  if (!nodeRequire) return null;
  const candidates: Array<() => ElectronSessionLike | undefined> = [
    () => (nodeRequire("@electron/remote") as ElectronRemoteLike).session?.defaultSession,
    () =>
      (nodeRequire("electron") as { remote?: ElectronRemoteLike }).remote?.session
        ?.defaultSession,
  ];
  for (const load of candidates) {
    let session: ElectronSessionLike | undefined;
    try {
      session = load();
    } catch {
      continue;
    }
    if (session && typeof session.flushStorageData === "function") {
      const bound = session;
      return () => {
        bound.flushStorageData?.();
      };
    }
  }
  return null;
}
