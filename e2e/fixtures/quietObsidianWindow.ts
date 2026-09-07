/**
 * Quiet Obsidian window for proof lanes.
 *
 * Obsidian restores each vault's last window placement from
 * `%APPDATA%/obsidian/<vaultId>.json` on launch. The live test vault's saved
 * state was `isMaximized: true`, so every lane launch covered the user's
 * screen with a maximized Obsidian window for the length of the mission.
 * `windowsHide` on the spawn only hides console windows; it never touched
 * Obsidian's own window.
 *
 * The lane parks the window instead: before launch it rewrites the vault's
 * saved placement to an off-screen, unmaximized position (keeping the size,
 * zoom and devTools fields so layout-dependent selectors see the same
 * viewport), and after the CDP attach it confirms the placement from inside
 * the renderer, drops the taskbar button, and gives focus back if the window
 * took it. After the owned process is gone the original placement is written
 * back, so opening the vault by hand later looks exactly as before.
 *
 * Off-screen or covered windows are normally backgrounded by Chromium: no
 * animation frames, throttled timers. Playwright's actionability checks wait
 * for two stable animation frames, so a parked window would hang every click.
 * The launch therefore adds the three Chromium switches below, the renderer
 * disables background throttling on itself, and the attach step measures
 * requestAnimationFrame for real; if frames stop, the window is put back on
 * screen and the lane proceeds visibly rather than silently slower.
 *
 * `E2E_SHOW_OBSIDIAN_WINDOW=1` (the demo recorder) keeps everything visible
 * and skips all of this.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "@playwright/test";

export const SHOW_OBSIDIAN_WINDOW_ENV = "E2E_SHOW_OBSIDIAN_WINDOW";

export function quietObsidianWindowRequested(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return env[SHOW_OBSIDIAN_WINDOW_ENV] !== "1";
}

/**
 * Keep rendering, animation frames and timers at full rate while the window is
 * off-screen or covered. Without these Playwright's stability wait (two
 * consecutive animation frames) never completes on a parked window.
 */
export const QUIET_OBSIDIAN_CHROMIUM_SWITCHES = [
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-background-timer-throttling",
] as const;

/** Far outside any plausible virtual screen, well inside Win32's ±32767 range. */
export const QUIET_WINDOW_X = 20000;
export const QUIET_WINDOW_Y = 20000;
const DEFAULT_WIDTH = 1428;
const DEFAULT_HEIGHT = 800;
const ORIGINAL_SIDECAR_SUFFIX = ".e2e-quiet-window-original.json";

export interface QuietWindowStateResultV1 {
  state: Record<string, unknown>;
  changed: boolean;
}

function finitePositive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : fallback;
}

/**
 * The saved placement Obsidian will restore: same size, zoom and devTools as
 * before, but unmaximized and off-screen. Garbage input yields a sane default
 * rather than a throw; a lane must never fail because of window cosmetics.
 */
export function quietObsidianWindowStateV1(existing: unknown): QuietWindowStateResultV1 {
  const source =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? (existing as Record<string, unknown>)
      : {};
  const state: Record<string, unknown> = {
    ...source,
    x: QUIET_WINDOW_X,
    y: QUIET_WINDOW_Y,
    width: finitePositive(source.width, DEFAULT_WIDTH),
    height: finitePositive(source.height, DEFAULT_HEIGHT),
    isMaximized: false,
  };
  const changed =
    source.x !== QUIET_WINDOW_X ||
    source.y !== QUIET_WINDOW_Y ||
    source.isMaximized !== false ||
    source.width !== state.width ||
    source.height !== state.height;
  return { state, changed };
}

export function isParkedObsidianWindowStateV1(existing: unknown): boolean {
  return quietObsidianWindowStateV1(existing).changed === false;
}

function normalizeVaultPath(value: string): string {
  return value
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/+$/u, "")
    .toLowerCase();
}

/** The vault id Obsidian keys its per-vault window state by, or null. */
export function resolveObsidianVaultIdV1(appState: unknown, vaultRoot: string): string | null {
  if (!appState || typeof appState !== "object") return null;
  const vaults = (appState as { vaults?: unknown }).vaults;
  if (!vaults || typeof vaults !== "object") return null;
  const wanted = normalizeVaultPath(vaultRoot);
  for (const [id, entry] of Object.entries(vaults as Record<string, unknown>)) {
    const candidate =
      entry && typeof entry === "object" ? (entry as { path?: unknown }).path : undefined;
    if (typeof candidate === "string" && normalizeVaultPath(candidate) === wanted) {
      return id;
    }
  }
  return null;
}

export interface ParkedObsidianWindowStateV1 {
  stateFilePath: string;
  sidecarPath: string;
}

export type ParkWindowStateOutcomeV1 =
  | { status: "parked"; parked: ParkedObsidianWindowStateV1; originalRecorded: boolean }
  | { status: "skipped"; reason: string };

async function readJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * Rewrite the vault's saved placement so the window opens parked. The
 * pre-park placement is kept in a sidecar for the restore after exit; when a
 * previous lane died before restoring, the sidecar already holds the true
 * original and is left alone.
 */
export async function parkObsidianWindowStateBeforeLaunchV1(input: {
  appStatePath: string;
  vaultRoot: string;
}): Promise<ParkWindowStateOutcomeV1> {
  try {
    const appState = await readJsonIfPresent(input.appStatePath);
    if (appState === undefined) {
      return { status: "skipped", reason: `no app state at ${input.appStatePath}` };
    }
    const vaultId = resolveObsidianVaultIdV1(appState, input.vaultRoot);
    if (!vaultId) {
      return { status: "skipped", reason: "vault is not registered in obsidian.json" };
    }
    const dir = path.dirname(input.appStatePath);
    const stateFilePath = path.join(dir, `${vaultId}.json`);
    const sidecarPath = path.join(dir, `${vaultId}${ORIGINAL_SIDECAR_SUFFIX}`);
    const existing = await readJsonIfPresent(stateFilePath);
    let originalRecorded = false;
    if (existing !== undefined && !isParkedObsidianWindowStateV1(existing)) {
      await mkdir(dir, { recursive: true });
      await writeFile(sidecarPath, `${JSON.stringify(existing)}\n`, "utf8");
      originalRecorded = true;
    } else if (existing === undefined) {
      // Nothing to restore later; an absent file means Obsidian's defaults.
      await rm(sidecarPath, { force: true });
    }
    const { state } = quietObsidianWindowStateV1(existing);
    await mkdir(dir, { recursive: true });
    await writeFile(stateFilePath, JSON.stringify(state), "utf8");
    return { status: "parked", parked: { stateFilePath, sidecarPath }, originalRecorded };
  } catch (error) {
    return { status: "skipped", reason: `could not park: ${String((error as Error)?.message ?? error)}` };
  }
}

/** Put the pre-park placement back once the owned Obsidian process is gone. */
export async function restoreObsidianWindowStateAfterExitV1(
  parked: ParkedObsidianWindowStateV1,
): Promise<"restored" | "nothing-to-restore" | "failed"> {
  try {
    const original = await readJsonIfPresent(parked.sidecarPath);
    if (original === undefined) return "nothing-to-restore";
    await writeFile(parked.stateFilePath, JSON.stringify(original), "utf8");
    await rm(parked.sidecarPath, { force: true });
    return "restored";
  } catch {
    return "failed";
  }
}

export interface QuietWindowAttachReportV1 {
  status: "parked" | "restored-visible" | "unavailable";
  detail: string;
  frames?: number;
  visibility?: string;
  wasMaximized?: boolean;
  wasFocused?: boolean;
}

interface RendererParkResult {
  ok: boolean;
  reason?: string;
  wasMaximized?: boolean;
  wasFocused?: boolean;
  stillFocused?: boolean;
  minimized?: boolean;
  before?: { x: number; y: number; width: number; height: number };
  after?: { x: number; y: number; width: number; height: number };
}

interface RendererFrameProbe {
  frames: number;
  visibility: string;
  timedOut: boolean;
}

const MIN_LIVE_FRAMES = 5;

/**
 * Confirm the placement from inside the renderer, then prove animation frames
 * still run. If they do not, the window goes back on screen: a visible lane
 * is a correct lane, a parked-but-frozen one is a timeout.
 */
export async function parkObsidianWindowAfterAttachV1(
  page: Page,
  label: string,
): Promise<QuietWindowAttachReportV1> {
  let report: QuietWindowAttachReportV1;
  try {
    const parked = (await page.evaluate(
      ({ x, y }) => {
        const anyWindow = window as unknown as { require?: (id: string) => any };
        const req = anyWindow.require;
        let remote: any = null;
        try {
          remote = req?.("electron")?.remote ?? null;
        } catch {
          remote = null;
        }
        if (!remote) {
          try {
            remote = req?.("@electron/remote") ?? null;
          } catch {
            remote = null;
          }
        }
        const win = remote?.getCurrentWindow?.();
        if (!win) return { ok: false, reason: "no electron remote window in the renderer" };
        const before = win.getBounds();
        const wasMaximized = Boolean(win.isMaximized?.());
        const wasFocused = Boolean(win.isFocused?.());
        try {
          win.webContents?.setBackgroundThrottling?.(false);
        } catch {
          /* best effort */
        }
        if (wasMaximized) win.unmaximize?.();
        // Every earlier proof record ran in a maximized window. Parking at the
        // primary display's work-area size keeps the same viewport, so
        // layout-dependent selectors and the mission console behave as they
        // did on screen; a smaller default window would change what the
        // product lays out and what the lane sees.
        let work: { width: number; height: number } | undefined;
        try {
          work = remote?.screen?.getPrimaryDisplay?.()?.workAreaSize;
        } catch {
          work = undefined;
        }
        const width = work && work.width > 0 ? work.width : before.width;
        const height = work && work.height > 0 ? work.height : before.height;
        win.setBounds?.({ x, y, width, height });
        win.setSkipTaskbar?.(true);
        // An invisible window that owns keyboard focus is worse than a visible
        // one: the user's keystrokes vanish into the parked editor. Refuse
        // activation from now on, hand focus to the next window in the Z order
        // (Chromium's Deactivate does exactly that), and keep doing so from
        // inside the renderer, because Obsidian re-focuses its window when it
        // opens notes during the mission. CDP input never needs OS focus;
        // Playwright's focus emulation keeps the page "focused" for the DOM.
        win.setFocusable?.(false);
        // Electron's blur() activates the window ABOVE ours in the Z order, and
        // the foreground window has none, so it did nothing (measured: 99% of
        // a mission with Obsidian foreground). Minimizing the active window
        // makes Windows activate the next one; showInactive then restores ours
        // off-screen without activation. Once another process owns the
        // foreground, Windows refuses Obsidian's own re-focus attempts.
        const handBack = () => {
          try {
            win.minimize?.();
            win.showInactive?.();
            if (win.isMinimized?.()) win.showInactive?.();
          } catch {
            /* the window may be closing */
          }
        };
        if (wasFocused) handBack();
        const globalScope = window as unknown as { __quietWindowWatchdog?: unknown };
        if (!globalScope.__quietWindowWatchdog) {
          globalScope.__quietWindowWatchdog = setInterval(() => {
            try {
              if (win.isFocused?.()) handBack();
            } catch {
              /* the window may be closing */
            }
          }, 750);
        }
        return {
          ok: true,
          wasMaximized,
          wasFocused,
          before,
          after: win.getBounds(),
          stillFocused: Boolean(win.isFocused?.()),
          minimized: Boolean(win.isMinimized?.()),
        };
      },
      { x: QUIET_WINDOW_X, y: QUIET_WINDOW_Y },
    )) as RendererParkResult;
    if (!parked.ok) {
      report = { status: "unavailable", detail: parked.reason ?? "unknown" };
    } else {
      const probe = (await page.evaluate(
        () =>
          new Promise((resolve) => {
            let frames = 0;
            const start = performance.now();
            const done = (timedOut: boolean) =>
              resolve({ frames, visibility: document.visibilityState, timedOut });
            const tick = () => {
              frames += 1;
              if (performance.now() - start < 400) requestAnimationFrame(tick);
              else done(false);
            };
            requestAnimationFrame(tick);
            setTimeout(() => done(true), 1500);
          }),
      )) as RendererFrameProbe;
      if (probe.frames >= MIN_LIVE_FRAMES && probe.visibility === "visible" && !parked.minimized) {
        report = {
          status: "parked",
          detail: `off-screen at ${parked.after?.x},${parked.after?.y} (${parked.after?.width}x${parked.after?.height}), focus handed back=${String(!parked.stillFocused)}`,
          frames: probe.frames,
          visibility: probe.visibility,
          wasMaximized: parked.wasMaximized,
          wasFocused: parked.wasFocused,
        };
      } else {
        await page.evaluate(
          ({ before, wasMaximized }) => {
            const anyWindow = window as unknown as { require?: (id: string) => any };
            let remote: any = null;
            try {
              remote = anyWindow.require?.("electron")?.remote ?? anyWindow.require?.("@electron/remote");
            } catch {
              remote = null;
            }
            const win = remote?.getCurrentWindow?.();
            if (!win) return;
            const globalScope = window as unknown as { __quietWindowWatchdog?: unknown };
            if (globalScope.__quietWindowWatchdog) {
              clearInterval(globalScope.__quietWindowWatchdog as number);
              globalScope.__quietWindowWatchdog = undefined;
            }
            win.setFocusable?.(true);
            win.setSkipTaskbar?.(false);
            if (win.isMinimized?.()) win.restore?.();
            if (before) win.setBounds?.(before);
            if (wasMaximized) win.maximize?.();
          },
          { before: parked.before, wasMaximized: parked.wasMaximized },
        );
        report = {
          status: "restored-visible",
          detail: `renderer stopped animating while parked (frames ${probe.frames} in 400ms, visibility ${probe.visibility}${probe.timedOut ? ", probe timed out" : ""}${parked.minimized ? ", window stayed minimized" : ""}); window put back on screen`,
          frames: probe.frames,
          visibility: probe.visibility,
          wasMaximized: parked.wasMaximized,
          wasFocused: parked.wasFocused,
        };
      }
    }
  } catch (error) {
    report = {
      status: "unavailable",
      detail: `park step threw: ${String((error as Error)?.message ?? error)}`,
    };
  }
  console.log(
    `[quiet-window] ${label}: ${report.status} — ${report.detail}` +
      (report.frames !== undefined ? ` | rAF ${report.frames}/400ms` : "") +
      (report.wasMaximized !== undefined
        ? ` | launched ${report.wasMaximized ? "maximized" : "windowed"}, focused=${String(report.wasFocused)}`
        : ""),
  );
  return report;
}
