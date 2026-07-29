/**
 * Demo capture wrapper: records the real Obsidian window with ffmpeg while an
 * unmodified e2e lane runs underneath.
 *
 * Usage (PowerShell — sandbox lanes require it, same as run-e2e-exclusive):
 *   node scripts/record-e2e-demo.mjs [--label=hero-take1] [--fps=30] [--window] -- <run-e2e-exclusive args>
 * Example:
 *   node scripts/record-e2e-demo.mjs --label=hero-take1 -- --real-ai --project=desktop-code-delivery-real-live
 *
 * Design constraints, in order:
 * - The lane must be byte-identical with and without capture. This wrapper
 *   only spawns `run-e2e-exclusive.mjs` untouched and points ffmpeg at the
 *   window from outside the process tree. No Playwright config, spec, or
 *   fixture knows recording exists (CDP screencast was rejected: it shares
 *   the harness's CDP pipe and its frame acks can throttle the renderer).
 * - Capture failure warns and never fails the run; the run's exit code is
 *   always the child's exit code.
 * - Raw footage lands OUTSIDE the repo and OneDrive by default: the repo is
 *   OneDrive-resident and multi-GB raw captures would thrash sync mid-run.
 *   Override with DEMO_MEDIA_DIR.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
const ownArgs = separatorIndex === -1 ? args : args.slice(0, separatorIndex);
const passthroughArgs = separatorIndex === -1 ? [] : args.slice(separatorIndex + 1);

function readFlag(name, fallback) {
  const prefix = `--${name}=`;
  const match = ownArgs.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

const label = (readFlag("label", "demo") || "demo").replace(/[^\w.-]+/g, "-");
const fps = Math.max(1, Math.min(60, Number.parseInt(readFlag("fps", "30"), 10) || 30));
// Desktop (DWM-composited) capture is the default: per-window gdigrab BitBlt
// returns black frames for GPU-rendered Electron windows — verified against
// Obsidian 1.12.7, which recorded 100 s of pure black plus a cursor. The
// window title is still polled, but only as the recording start trigger.
// --window opts back into per-window capture for non-accelerated targets.
const captureWindow = ownArgs.includes("--window");

if (passthroughArgs.length === 0) {
  console.error(
    "record-e2e-demo: no lane arguments given. Pass run-e2e-exclusive args after `--`,\n" +
      "e.g. node scripts/record-e2e-demo.mjs --label=hero -- --real-ai --project=desktop-code-delivery-real-live",
  );
  process.exit(2);
}

const ffmpegProbe = spawnSync("ffmpeg", ["-version"], { windowsHide: true });
if (ffmpegProbe.error || ffmpegProbe.status !== 0) {
  console.error(
    "record-e2e-demo: ffmpeg is not on PATH. Install it first: winget install Gyan.FFmpeg",
  );
  process.exit(2);
}

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace(/T/, "_")
  .slice(0, 19);
const mediaRoot =
  process.env.DEMO_MEDIA_DIR ||
  path.join(
    process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || ".", "AppData", "Local"),
    "agentic-demo-media",
  );
const captureDir = path.join(mediaRoot, `${label}-${timestamp}`);
await mkdir(captureDir, { recursive: true });
const rawPath = path.join(captureDir, "raw.mkv");

const WINDOW_POLL_INTERVAL_MS = 2_000;
const WINDOW_POLL_TIMEOUT_MS = 5 * 60_000;

function findObsidianWindowTitle() {
  const probe = spawnSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      "(Get-Process Obsidian -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle } | Select-Object -First 1).MainWindowTitle",
    ],
    { encoding: "utf8", windowsHide: true },
  );
  const title = (probe.stdout ?? "").trim();
  return title.length > 0 ? title : null;
}

let ffmpeg = null;
let ffmpegExited = false;

function startCapture(windowTitle) {
  const input = captureWindow ? `title=${windowTitle}` : "desktop";
  const ffmpegArgs = [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    String(fps),
    "-draw_mouse",
    "1",
    "-i",
    input,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    rawPath,
  ];
  console.log(
    `record-e2e-demo: capturing ${captureWindow ? `window "${windowTitle}"` : "full desktop (crop in post)"} at ${fps} fps -> ${rawPath}`,
  );
  ffmpeg = spawn("ffmpeg", ffmpegArgs, {
    stdio: ["pipe", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderrTail = "";
  ffmpeg.stderr.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk}`.slice(-2_000);
  });
  ffmpeg.on("exit", (code) => {
    ffmpegExited = true;
    // Exit before stop was requested = capture died mid-run (window title
    // changed, display locked). The lane must keep running regardless.
    if (!stopRequested && code !== 0) {
      console.warn(
        `record-e2e-demo: WARNING capture stopped early (ffmpeg exit ${code}). Lane continues unrecorded.\n${stderrTail}`,
      );
    }
  });
}

let stopRequested = false;

function stopCapture() {
  return new Promise((resolve) => {
    if (!ffmpeg || ffmpegExited) {
      resolve();
      return;
    }
    stopRequested = true;
    const forceKill = setTimeout(() => {
      try {
        ffmpeg.kill();
      } catch {
        // already gone
      }
      resolve();
    }, 15_000);
    ffmpeg.on("exit", () => {
      clearTimeout(forceKill);
      resolve();
    });
    try {
      // "q" asks ffmpeg to finalize the container cleanly; killing it instead
      // truncates the MKV index.
      ffmpeg.stdin.write("q");
      ffmpeg.stdin.end();
    } catch {
      clearTimeout(forceKill);
      try {
        ffmpeg.kill();
      } catch {
        // already gone
      }
      resolve();
    }
  });
}

console.log(
  `record-e2e-demo: starting lane: node scripts/run-e2e-exclusive.mjs ${passthroughArgs.join(" ")}`,
);
const child = spawn(
  process.execPath,
  [path.join("scripts", "run-e2e-exclusive.mjs"), ...passthroughArgs],
  {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  },
);

const pollStart = Date.now();
const pollTimer = setInterval(() => {
  if (ffmpeg) {
    clearInterval(pollTimer);
    return;
  }
  if (Date.now() - pollStart > WINDOW_POLL_TIMEOUT_MS) {
    clearInterval(pollTimer);
    console.warn(
      "record-e2e-demo: WARNING no Obsidian window appeared within 5 minutes; lane continues unrecorded.",
    );
    return;
  }
  const title = findObsidianWindowTitle();
  if (title) {
    clearInterval(pollTimer);
    try {
      startCapture(title);
    } catch (error) {
      console.warn(
        `record-e2e-demo: WARNING could not start capture: ${error?.message ?? error}. Lane continues unrecorded.`,
      );
    }
  }
}, WINDOW_POLL_INTERVAL_MS);

const childExit = await new Promise((resolve) => {
  child.on("exit", (code, signal) => resolve({ code, signal }));
  child.on("error", (error) => {
    console.error(`record-e2e-demo: lane failed to start: ${error.message}`);
    resolve({ code: 1, signal: null });
  });
});

clearInterval(pollTimer);
await stopCapture();

if (ffmpeg) {
  console.log(`record-e2e-demo: raw footage: ${rawPath}`);
} else {
  console.warn("record-e2e-demo: no footage captured this run.");
}
process.exitCode = childExit.code ?? (childExit.signal ? 1 : 0);
