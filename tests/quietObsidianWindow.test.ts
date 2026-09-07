import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  QUIET_OBSIDIAN_CHROMIUM_SWITCHES,
  QUIET_WINDOW_X,
  QUIET_WINDOW_Y,
  isParkedObsidianWindowStateV1,
  parkObsidianWindowStateBeforeLaunchV1,
  quietObsidianWindowRequested,
  quietObsidianWindowStateV1,
  resolveObsidianVaultIdV1,
  restoreObsidianWindowStateAfterExitV1,
  judgeRendererProbeV1,
  RENDERER_PROBE_THRESHOLDS,
} from "../e2e/fixtures/quietObsidianWindow";

const LIVE_STATE = {
  x: 272,
  y: 16,
  width: 1428,
  height: 800,
  isMaximized: true,
  devTools: false,
  zoom: 0,
};

test("a maximized on-screen placement becomes windowed and off-screen at the same size", () => {
  const { state, changed } = quietObsidianWindowStateV1(LIVE_STATE);
  assert.equal(changed, true);
  assert.deepEqual(state, {
    x: QUIET_WINDOW_X,
    y: QUIET_WINDOW_Y,
    width: 1428,
    height: 800,
    isMaximized: false,
    devTools: false,
    zoom: 0,
  });
  assert.equal(isParkedObsidianWindowStateV1(state), true);
  assert.equal(quietObsidianWindowStateV1(state).changed, false, "parking is idempotent");
});

test("garbage or missing placement falls back to a sane windowed default", () => {
  for (const input of [undefined, null, "x", 3, [], { width: -1, height: "tall" }]) {
    const { state } = quietObsidianWindowStateV1(input);
    assert.equal(state.x, QUIET_WINDOW_X);
    assert.equal(state.y, QUIET_WINDOW_Y);
    assert.equal(state.width, 1428);
    assert.equal(state.height, 800);
    assert.equal(state.isMaximized, false);
  }
});

test("the vault id is resolved by normalized path, never by string equality", () => {
  const appState = {
    vaults: {
      ae0c6fd8fe85395f: { path: "C:\\Users\\me\\Documents\\Obsidian Vault ", ts: 1 },
      e4ac721a9af5e1c9: { path: "C:\\Users\\me\\Desktop\\test_vault_obsidian_ai", ts: 2, open: true },
    },
  };
  assert.equal(
    resolveObsidianVaultIdV1(appState, "c:/users/me/desktop/TEST_VAULT_OBSIDIAN_AI/"),
    "e4ac721a9af5e1c9",
  );
  assert.equal(
    resolveObsidianVaultIdV1(appState, "C:\\Users\\me\\Documents\\Obsidian Vault"),
    "ae0c6fd8fe85395f",
    "a trailing space in the registry entry still matches the real path",
  );
  assert.equal(resolveObsidianVaultIdV1(appState, "C:\\elsewhere"), null);
  assert.equal(resolveObsidianVaultIdV1({ vaults: "nope" }, "C:\\x"), null);
  assert.equal(resolveObsidianVaultIdV1(null, "C:\\x"), null);
});

test("park before launch keeps the original in a sidecar and restore puts it back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quiet-window-"));
  try {
    const vaultRoot = path.join(dir, "vault");
    const appStatePath = path.join(dir, "obsidian.json");
    await writeFile(appStatePath, JSON.stringify({ vaults: { abc123: { path: vaultRoot } } }));
    const stateFile = path.join(dir, "abc123.json");
    await writeFile(stateFile, JSON.stringify(LIVE_STATE));

    const first = await parkObsidianWindowStateBeforeLaunchV1({ appStatePath, vaultRoot });
    assert.equal(first.status, "parked");
    if (first.status !== "parked") return;
    assert.equal(first.originalRecorded, true);
    const parkedState = JSON.parse(await readFile(stateFile, "utf8"));
    assert.equal(parkedState.isMaximized, false);
    assert.equal(parkedState.x, QUIET_WINDOW_X);
    assert.equal(parkedState.zoom, 0);
    const sidecar = JSON.parse(await readFile(first.parked.sidecarPath, "utf8"));
    assert.deepEqual(sidecar, LIVE_STATE);

    // A previous lane died before restoring: the file is already parked, so the
    // sidecar's original must survive a second park untouched.
    const second = await parkObsidianWindowStateBeforeLaunchV1({ appStatePath, vaultRoot });
    assert.equal(second.status, "parked");
    if (second.status !== "parked") return;
    assert.equal(second.originalRecorded, false);
    assert.deepEqual(JSON.parse(await readFile(second.parked.sidecarPath, "utf8")), LIVE_STATE);

    assert.equal(await restoreObsidianWindowStateAfterExitV1(second.parked), "restored");
    assert.deepEqual(JSON.parse(await readFile(stateFile, "utf8")), LIVE_STATE);
    await assert.rejects(stat(second.parked.sidecarPath), "the sidecar is removed after restore");
    assert.equal(
      await restoreObsidianWindowStateAfterExitV1(second.parked),
      "nothing-to-restore",
      "a second restore is a no-op",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("park is skipped, never thrown, when the vault is unregistered or the app state is absent", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "quiet-window-"));
  try {
    const appStatePath = path.join(dir, "obsidian.json");
    const absent = await parkObsidianWindowStateBeforeLaunchV1({ appStatePath, vaultRoot: dir });
    assert.equal(absent.status, "skipped");
    await writeFile(appStatePath, JSON.stringify({ vaults: { z: { path: path.join(dir, "other") } } }));
    const unregistered = await parkObsidianWindowStateBeforeLaunchV1({ appStatePath, vaultRoot: dir });
    assert.equal(unregistered.status, "skipped");
    // No placement file yet: park writes one and leaves nothing to restore.
    await writeFile(appStatePath, JSON.stringify({ vaults: { z: { path: dir } } }));
    const fresh = await parkObsidianWindowStateBeforeLaunchV1({ appStatePath, vaultRoot: dir });
    assert.equal(fresh.status, "parked");
    if (fresh.status !== "parked") return;
    assert.equal(fresh.originalRecorded, false);
    assert.equal(await restoreObsidianWindowStateAfterExitV1(fresh.parked), "nothing-to-restore");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the demo recorder's visible mode is honoured and the quiet mode is the default", () => {
  assert.equal(quietObsidianWindowRequested({}), true);
  assert.equal(quietObsidianWindowRequested({ E2E_SHOW_OBSIDIAN_WINDOW: "1" }), false);
  assert.equal(quietObsidianWindowRequested({ E2E_SHOW_OBSIDIAN_WINDOW: "0" }), true);
});

test("the native harness wires the quiet window into launch, attach and teardown", async () => {
  const source = await readFile(
    path.join(__dirname, "..", "e2e", "fixtures", "nativeObsidianHarness.ts"),
    "utf8",
  );
  // The Chromium switches ride on the same argv as the vault path, gated by
  // the same env the spawn already honours for the demo recorder.
  assert.match(source, /\.\.\.\(quietWindow \? QUIET_OBSIDIAN_CHROMIUM_SWITCHES : \[\]\)/u);
  assert.match(source, /windowsHide: process\.env\.E2E_SHOW_OBSIDIAN_WINDOW !== "1"/u);
  // The placement is parked before spawn and confirmed right after the page is found.
  const parkAt = source.indexOf("parkObsidianWindowStateBeforeLaunchV1(");
  const spawnAt = source.indexOf("processHandle = spawn(");
  const attachAt = source.indexOf("parkObsidianWindowAfterAttachV1(");
  const pageAt = source.indexOf("page = await findOnlyVaultPage(browser, vaultRoot);");
  assert.ok(parkAt > 0 && spawnAt > parkAt, "park before spawn");
  assert.ok(pageAt > 0 && attachAt > pageAt, "confirm after the vault page is found");
  assert.match(source, /restoreObsidianWindowStateAfterExitV1\(/u);
  for (const flag of QUIET_OBSIDIAN_CHROMIUM_SWITCHES) {
    assert.ok(flag.startsWith("--disable-"), flag);
  }
  // The parked window keeps the viewport every earlier proof record had: the
  // primary display's work area, the size a maximized window renders at.
  const module = await readFile(
    path.join(__dirname, "..", "e2e", "fixtures", "quietObsidianWindow.ts"),
    "utf8",
  );
  assert.match(module, /getPrimaryDisplay\?\.\(\)\?\.workAreaSize/u);
  assert.match(module, /setBackgroundThrottling\?\.\(false\)/u);
  // A parked window must never own the user's keyboard: activation is refused,
  // focus is handed back, and a renderer-side watchdog keeps handing it back
  // when Obsidian re-focuses itself while opening notes.
  assert.match(module, /setFocusable\?\.\(false\)/u);
  // blur() cannot hand focus back from the foreground window (measured); the
  // hand-back minimizes, which activates the next window, then shows inactive.
  assert.match(module, /win\.minimize\?\.\(\);\s*win\.showInactive\?\.\(\);/u);
  // Electron's isFocused() lags the OS, so a polling watchdog thrashed the
  // window every tick; the hand-back re-runs only on the window's focus event.
  assert.doesNotMatch(module, /setInterval\(/u, "no polling watchdog");
  assert.match(module, /win\.on\?\.\("focus", onFocus\)/u);
  assert.match(module, /win\.removeListener\?\.\("focus"/u, "the visible fallback detaches the listener");
  assert.doesNotMatch(module, /win\.blur\?\.\(\)/u, "blur is not relied on any more");
  assert.match(module, /setFocusable\?\.\(true\)/u, "the visible fallback re-enables activation");
  assert.match(module, /if \(win\.isMinimized\?\.\(\)\) win\.restore\?\.\(\);/u, "the visible fallback un-minimizes");
});

test("the renderer probe judge: busy windows are sampled again, timers without frames conclude throttled, a never-live renderer is not parked", () => {
  const busy = { frames: 1, timerTicks: 0, elapsedMs: 812, timedOut: false };
  const stalled = { frames: 0, timerTicks: 0, elapsedMs: 1500, timedOut: true };
  const live = { frames: 19, timerTicks: 96, elapsedMs: 401, timedOut: false };
  const throttled = { frames: 1, timerTicks: 88, elapsedMs: 400, timedOut: false };

  assert.deepEqual(judgeRendererProbeV1([live]), { verdict: "live", frames: 19, windows: 1, timedOut: false });
  // Cohorts 9-10 (2026-09-07): one frame in the first window while Obsidian
  // indexed the vault, then normal frames. Ten lanes in ninety-two were put
  // back on screen for this; they must stay parked.
  assert.deepEqual(judgeRendererProbeV1([busy, stalled, live]), { verdict: "live", frames: 19, windows: 3, timedOut: true });
  assert.deepEqual(judgeRendererProbeV1([throttled, throttled]), { verdict: "throttled", frames: 1, windows: 2, timedOut: false });
  // One timers-without-frames window between busy ones concludes nothing.
  assert.equal(judgeRendererProbeV1([throttled, busy, live]).verdict, "live");
  const never = judgeRendererProbeV1(
    Array.from({ length: RENDERER_PROBE_THRESHOLDS.maxWindows }, () => busy),
  );
  assert.equal(never.verdict, "busy");
  assert.equal(never.windows, RENDERER_PROBE_THRESHOLDS.maxWindows);
  assert.deepEqual(judgeRendererProbeV1([]), { verdict: "busy", frames: 0, windows: 0, timedOut: false });
  assert.ok(RENDERER_PROBE_THRESHOLDS.maxWindows >= 6, "a busy start gets several windows of patience");
  assert.ok(RENDERER_PROBE_THRESHOLDS.minTimerTicks < 40, "an idle main thread runs ~100 zero-delay timers per 400ms; the bar must sit well below that");
});

test("the attach step samples frames and timers side by side and lets the one judge decide", async () => {
  const module = await readFile(
    path.join(__dirname, "..", "e2e", "fixtures", "quietObsidianWindow.ts"),
    "utf8",
  );
  assert.match(module, /setTimeout\(timerTick, 0\)/u, "zero-delay timers tell a busy main thread from a throttled compositor");
  assert.match(module, /requestAnimationFrame\(frameTick\)/u);
  assert.match(module, /RENDERER_PROBE_THRESHOLDS,\s*\)\) as RendererProbeSamples/u, "the sampler receives the shared thresholds");
  assert.match(module, /const judgement = judgeRendererProbeV1\(probe\.history\)/u, "one judge decides");
  assert.match(module, /judgement\.verdict === "live" && probe\.visibility === "visible" && !parked\.minimized/u);
  assert.doesNotMatch(module, /MIN_LIVE_FRAMES/u, "no second copy of the live threshold");
});
