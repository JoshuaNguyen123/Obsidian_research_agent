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
 * requestAnimationFrame for real. Frames are sampled in short windows and the
 * probe keeps sampling while the main thread is merely busy (Obsidian indexes
 * the vault right after launch, and its timers starve together with its
 * frames); only a renderer whose timers run while its frames do not, or one
 * that never proves itself live, is put back on screen, and that lane proceeds
 * visibly rather than silently slower.
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
  /** Sampling windows it took the renderer probe to reach its verdict. */
  probeWindows?: number;
  probeVerdict?: RendererProbeVerdictV1;
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

/**
 * How the attach step proves the parked renderer is alive. Each window counts
 * animation frames and zero-delay timer ticks side by side: two frames say
 * "live" (Playwright's own stability wait needs exactly two consecutive
 * frames); timers with NO frame at all say the compositor is throttled, which
 * is what Chromium does to an occluded window it throttles (0 fps, not a
 * slow rate); anything else says the main thread is busy (vault indexing
 * right after launch, or a renderer drawing slowly under load) and the window
 * is sampled again. Only a throttled or never-live renderer is put back on
 * screen, so a busy start no longer flashes the window at the user (cohorts
 * 9-10, 2026-09-07: one launch in nine did on a five-frame bar; cohort 12,
 * one in fifteen at 10 fps, still called "throttled"; every one of them
 * passed).
 */
export const RENDERER_PROBE_THRESHOLDS = {
  /** Length of one sampling window. */
  windowMs: 400,
  /** Frames in one window that prove the compositor runs. */
  minLiveFrames: 2,
  /** Zero-delay timer ticks in one window that prove the main thread was free. */
  minTimerTicks: 10,
  /** Windows sampled before a never-live renderer is put back on screen. */
  maxWindows: 8,
  /** Consecutive timers-without-frames windows that conclude "throttled". */
  throttledWindowsToConclude: 2,
  /** A window in which neither frames nor timers ran at all ends here. */
  windowTimeoutMs: 1500,
} as const;

export interface RendererProbeWindowV1 {
  frames: number;
  timerTicks: number;
  elapsedMs: number;
  timedOut: boolean;
}

export type RendererProbeVerdictV1 = "live" | "throttled" | "busy";

export interface RendererProbeJudgementV1 {
  verdict: RendererProbeVerdictV1;
  /** Frames in the live window, or the best window when none was live. */
  frames: number;
  /** Windows it took to reach the verdict. */
  windows: number;
  timedOut: boolean;
}

interface RendererProbeSamples {
  history: RendererProbeWindowV1[];
  visibility: string;
}

/**
 * The single judge of a renderer probe. The in-page sampler only decides when
 * to stop sampling; whether the window stays parked is decided here, from the
 * returned history, so the rule lives in one tested place.
 */
export function judgeRendererProbeV1(
  history: readonly RendererProbeWindowV1[],
  thresholds: typeof RENDERER_PROBE_THRESHOLDS = RENDERER_PROBE_THRESHOLDS,
): RendererProbeJudgementV1 {
  let best = 0;
  let throttledRun = 0;
  let timedOut = false;
  for (let index = 0; index < history.length; index += 1) {
    const sample = history[index]!;
    best = Math.max(best, sample.frames);
    timedOut = timedOut || sample.timedOut;
    if (sample.frames >= thresholds.minLiveFrames) {
      return { verdict: "live", frames: sample.frames, windows: index + 1, timedOut };
    }
    // Throttled means the compositor produced NOTHING while the main thread
    // was demonstrably free; a straggler frame is not a verdict either way.
    throttledRun =
      sample.frames === 0 && sample.timerTicks >= thresholds.minTimerTicks
        ? throttledRun + 1
        : 0;
    if (throttledRun >= thresholds.throttledWindowsToConclude) {
      return { verdict: "throttled", frames: best, windows: index + 1, timedOut };
    }
  }
  return {
    verdict: throttledRun > 0 ? "throttled" : "busy",
    frames: best,
    windows: history.length,
    timedOut,
  };
}

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
        // Electron's isFocused() stays true after the hand-back (its flag lags
        // the OS), so a polling watchdog would minimize and restore the window
        // every tick for the whole mission. React to the window's own "focus"
        // event instead: it fires only when the window really gains focus.
        const globalScope = window as unknown as { __quietWindowWatchdog?: unknown };
        if (!globalScope.__quietWindowWatchdog) {
          const onFocus = () => handBack();
          win.on?.("focus", onFocus);
          globalScope.__quietWindowWatchdog = onFocus;
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
      // Sampler only: it counts frames and zero-delay timer ticks per window
      // and stops when a window is live, when timers-without-frames repeats,
      // or when the window budget is spent. The verdict is the judge's below.
      const probe = (await page.evaluate(
        (t) =>
          new Promise((resolve) => {
            const history: Array<{
              frames: number;
              timerTicks: number;
              elapsedMs: number;
              timedOut: boolean;
            }> = [];
            let throttledRun = 0;
            const finish = () => resolve({ history, visibility: document.visibilityState });
            const sample = () => {
              let frames = 0;
              let timerTicks = 0;
              let settled = false;
              let guard: ReturnType<typeof setTimeout> | undefined;
              const start = performance.now();
              const settle = (timedOut: boolean) => {
                if (settled) return;
                settled = true;
                if (guard !== undefined) clearTimeout(guard);
                history.push({
                  frames,
                  timerTicks,
                  elapsedMs: Math.round(performance.now() - start),
                  timedOut,
                });
                const live = frames >= t.minLiveFrames;
                throttledRun =
                  !live && frames === 0 && timerTicks >= t.minTimerTicks ? throttledRun + 1 : 0;
                if (
                  live ||
                  throttledRun >= t.throttledWindowsToConclude ||
                  history.length >= t.maxWindows
                ) {
                  finish();
                } else {
                  sample();
                }
              };
              const frameTick = () => {
                if (settled) return;
                frames += 1;
                if (performance.now() - start < t.windowMs) requestAnimationFrame(frameTick);
                else settle(false);
              };
              const timerTick = () => {
                if (settled) return;
                timerTicks += 1;
                if (performance.now() - start < t.windowMs) setTimeout(timerTick, 0);
                else settle(false);
              };
              guard = setTimeout(() => settle(true), t.windowTimeoutMs);
              requestAnimationFrame(frameTick);
              setTimeout(timerTick, 0);
            };
            sample();
          }),
        RENDERER_PROBE_THRESHOLDS,
      )) as RendererProbeSamples;
      const judgement = judgeRendererProbeV1(probe.history);
      if (judgement.verdict === "live" && probe.visibility === "visible" && !parked.minimized) {
        report = {
          status: "parked",
          detail: `off-screen at ${parked.after?.x},${parked.after?.y} (${parked.after?.width}x${parked.after?.height}), focus handed back=${String(!parked.stillFocused)}`,
          frames: judgement.frames,
          probeWindows: judgement.windows,
          probeVerdict: judgement.verdict,
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
              win.removeListener?.("focus", globalScope.__quietWindowWatchdog);
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
        const windowMs = RENDERER_PROBE_THRESHOLDS.windowMs;
        const why =
          judgement.verdict === "live"
            ? `renderer is live (${judgement.frames} frames in ${windowMs}ms) but the window ${parked.minimized ? "stayed minimized" : `reports visibility ${probe.visibility}`}`
            : judgement.verdict === "throttled"
              ? `renderer's animation frames stopped while its timers kept running (best ${judgement.frames} frames in ${windowMs}ms over ${judgement.windows} window(s))`
              : `renderer never proved itself live in ${judgement.windows} window(s) (best ${judgement.frames} frames in ${windowMs}ms, main thread busy${judgement.timedOut ? ", probe timed out" : ""})`;
        report = {
          status: "restored-visible",
          detail: `${why}; window put back on screen`,
          frames: judgement.frames,
          probeWindows: judgement.windows,
          probeVerdict: judgement.verdict,
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
      (report.frames !== undefined
        ? ` | rAF ${report.frames}/${RENDERER_PROBE_THRESHOLDS.windowMs}ms` +
          (report.probeWindows !== undefined && report.probeWindows > 1
            ? ` after ${report.probeWindows} windows`
            : "")
        : "") +
      (report.wasMaximized !== undefined
        ? ` | launched ${report.wasMaximized ? "maximized" : "windowed"}, focused=${String(report.wasFocused)}`
        : ""),
  );
  return report;
}
