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
import { writeFileSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
const model = readFlag("model", "").trim();
const rendererPollDeadlineRaw = readFlag("renderer-poll-deadline-ms", "").trim();
const rendererPollDeadlineMs = rendererPollDeadlineRaw
  ? Number.parseInt(rendererPollDeadlineRaw, 10)
  : null;
if (
  rendererPollDeadlineRaw &&
  (!Number.isSafeInteger(rendererPollDeadlineMs) ||
    rendererPollDeadlineMs < 30_000 ||
    rendererPollDeadlineMs > 15 * 60_000)
) {
  console.error(
    "record-e2e-demo: --renderer-poll-deadline-ms must be an integer from 30000 to 900000.",
  );
  process.exit(2);
}
if (model && (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(model) || model.includes(".."))) {
  console.error("record-e2e-demo: --model must be a bounded provider model tag.");
  process.exit(2);
}
// Desktop (DWM-composited) capture is the default: per-window gdigrab BitBlt
// returns black frames for GPU-rendered Electron windows — verified against
// Obsidian 1.12.7, which recorded 100 s of pure black plus a cursor. The
// window title is still polled, but only as the recording start trigger.
// --window opts back into per-window capture for non-accelerated targets.
const captureWindow = ownArgs.includes("--window");
const useShowcaseVault = ownArgs.includes("--showcase-vault");

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
const showcaseVault = useShowcaseVault
  ? path.join(captureDir, "Agentic Researcher Showcase")
  : null;
let showcaseTrustedVaultId = null;
let showcaseTrustedVaultRestore = null;

function providerSettingsSourcePath() {
  return (
    process.env.DEMO_PROVIDER_SETTINGS_SOURCE ||
    path.join(
      process.env.USERPROFILE || "",
      "OneDrive",
      "Desktop",
      "test_vault_obsidian_ai",
      ".obsidian",
      "plugins",
      "agentic-researcher",
      "data.json",
    )
  );
}

async function readShowcaseProviderSeed() {
  if (
    process.env.E2E_OLLAMA_API_KEY?.trim() ||
    process.env.E2E_OPENAI_COMPATIBLE_API_KEY?.trim()
  ) {
    return {};
  }
  const sourcePath = providerSettingsSourcePath();
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const allowedKeys = [
    "modelProvider",
    "model",
    "ollamaBaseUrl",
    "openAiCompatibleBaseUrl",
    "modelCredentialReferences",
    "modelConnectionVerifiedAt",
    "modelConnectionVerifiedProvider",
    "modelConnectionVerifiedModel",
    "modelConnectionVerifiedBaseUrl",
    "modelConnectionVerifiedAgenticCapabilities",
    "modelConnectionVerifiedContextLength",
  ];
  return Object.fromEntries(
    allowedKeys
      .filter((key) => source[key] !== undefined)
      .map((key) => [key, source[key]]),
  );
}

async function readTrustedShowcaseVaultId() {
  const explicit = process.env.DEMO_TRUSTED_VAULT_ID?.trim();
  if (explicit) {
    if (!/^[a-f0-9]{16}$/u.test(explicit)) {
      throw new Error("DEMO_TRUSTED_VAULT_ID must be a 16-character lowercase hex id.");
    }
  }
  const sourceVault = path.resolve(
    path.dirname(providerSettingsSourcePath()),
    "..",
    "..",
    "..",
  );
  const obsidianStatePath = path.join(
    process.env.APPDATA || "",
    "obsidian",
    "obsidian.json",
  );
  const state = JSON.parse(await readFile(obsidianStatePath, "utf8"));
  const normalize = (value) =>
    path.resolve(String(value ?? "")).replaceAll("\\", "/").toLowerCase();
  let match = Object.entries(state?.vaults ?? {}).find(
    ([id, value]) =>
      /^[a-f0-9]{16}$/u.test(id) &&
      (!explicit || id === explicit) &&
      normalize(value?.path) === normalize(sourceVault),
  );
  if (!match) {
    // The native harness temporarily rebinds the trusted source vault id to
    // the disposable showcase path. If capture is force-stopped, its normal
    // restore step cannot run. Recover only an exact prior showcase mapping
    // under this tool's own media root; never adopt an arbitrary vault id.
    const abandonedShowcaseMappings = Object.entries(state?.vaults ?? {}).filter(
      ([id, value]) => {
        if (
          !/^[a-f0-9]{16}$/u.test(id) ||
          (explicit && id !== explicit)
        ) {
          return false;
        }
        const candidatePath = path.resolve(String(value?.path ?? ""));
        const relative = path.relative(mediaRoot, candidatePath);
        return (
          path.basename(candidatePath) === "Agentic Researcher Showcase" &&
          relative.length > 0 &&
          !path.isAbsolute(relative) &&
          relative !== ".." &&
          !relative.startsWith(`..${path.sep}`)
        );
      },
    );
    if (abandonedShowcaseMappings.length === 1) {
      match = abandonedShowcaseMappings[0];
    }
  }
  if (!match) {
    throw new Error("Could not resolve the trusted source vault id for showcase capture.");
  }
  const [trustedVaultId, existingEntry] = match;
  const reboundFromPath = path.resolve(String(existingEntry?.path ?? ""));
  showcaseTrustedVaultRestore = {
    obsidianStatePath,
    sourceVault,
    trustedVaultId,
    reboundFromPath,
    existingEntry: {
      ...(existingEntry && typeof existingEntry === "object"
        ? existingEntry
        : {}),
      path: sourceVault,
      open: true,
    },
  };
  return trustedVaultId;
}

async function restoreTrustedShowcaseVaultMapping() {
  if (!showcaseTrustedVaultRestore || !showcaseVault) return;
  const {
    obsidianStatePath,
    sourceVault,
    trustedVaultId,
    reboundFromPath,
    existingEntry,
  } = showcaseTrustedVaultRestore;
  const state = JSON.parse(await readFile(obsidianStatePath, "utf8"));
  const vaults =
    state?.vaults && typeof state.vaults === "object" ? state.vaults : {};
  const currentEntry =
    vaults[trustedVaultId] && typeof vaults[trustedVaultId] === "object"
      ? vaults[trustedVaultId]
      : {};
  const currentPath = path.resolve(String(currentEntry.path ?? ""));
  const normalizedCurrent = currentPath.replaceAll("\\", "/").toLowerCase();
  const allowedPaths = [sourceVault, showcaseVault, reboundFromPath].map((value) =>
    path.resolve(value).replaceAll("\\", "/").toLowerCase(),
  );
  if (!allowedPaths.includes(normalizedCurrent)) {
    throw new Error(
      `Refusing to restore trusted vault id ${trustedVaultId} from unexpected path ${currentPath}.`,
    );
  }
  await writeFile(
    obsidianStatePath,
    JSON.stringify({
      ...state,
      vaults: {
        ...vaults,
        [trustedVaultId]: {
          ...currentEntry,
          ...existingEntry,
          path: sourceVault,
          ts: Date.now(),
          open: true,
        },
      },
      cli: true,
    }),
    "utf8",
  );
}

if (showcaseVault) {
  const relativeVault = path.relative(captureDir, showcaseVault);
  if (
    relativeVault !== "Agentic Researcher Showcase" ||
    path.isAbsolute(relativeVault)
  ) {
    throw new Error(`Refusing unsafe showcase vault path: ${showcaseVault}`);
  }
  const obsidianDirectory = path.join(showcaseVault, ".obsidian");
  const pluginDirectory = path.join(
    obsidianDirectory,
    "plugins",
    "agentic-researcher",
  );
  const [providerSeed, trustedVaultId] = await Promise.all([
    readShowcaseProviderSeed(),
    readTrustedShowcaseVaultId(),
  ]);
  showcaseTrustedVaultId = trustedVaultId;
  await mkdir(pluginDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(obsidianDirectory, "app.json"),
      `${JSON.stringify(
        {
          readableLineLength: true,
          showInlineTitle: true,
          spellcheck: false,
        },
        null,
        2,
      )}\n`,
      "utf8",
    ),
    writeFile(
      path.join(pluginDirectory, "data.json"),
      `${JSON.stringify(providerSeed, null, 2)}\n`,
      "utf8",
    ),
    writeFile(
      path.join(showcaseVault, "Welcome.md"),
      [
        "# Agentic Researcher Showcase",
        "",
        "A disposable vault for recording clean, genuine product runs.",
        "",
      ].join("\n"),
      "utf8",
    ),
    writeFile(
      path.join(showcaseVault, "Reference shelf.md"),
      [
        "# Reference shelf",
        "",
        "A small place for source notes and working decisions.",
        "",
      ].join("\n"),
      "utf8",
    ),
  ]);
}

const WINDOW_POLL_INTERVAL_MS = 2_000;
const WINDOW_POLL_TIMEOUT_MS = 5 * 60_000;

function findObsidianWindow() {
  const script = String.raw`
$signature = @"
using System;
using System.Runtime.InteropServices;
public static class DemoCaptureWindow {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }
  [DllImport("user32.dll")]
  public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")]
  public static extern int GetSystemMetrics(int index);
}
"@
Add-Type -TypeDefinition $signature -ErrorAction SilentlyContinue
$process = Get-Process Obsidian -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -and $_.MainWindowHandle -ne 0 } |
  Select-Object -First 1
if ($null -eq $process) { exit 3 }
$rect = New-Object DemoCaptureWindow+RECT
if (-not [DemoCaptureWindow]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
  exit 4
}
[pscustomobject]@{
  title = $process.MainWindowTitle
  window = [pscustomobject]@{
    left = $rect.Left
    top = $rect.Top
    width = $rect.Right - $rect.Left
    height = $rect.Bottom - $rect.Top
  }
  virtualDesktop = [pscustomobject]@{
    left = [DemoCaptureWindow]::GetSystemMetrics(76)
    top = [DemoCaptureWindow]::GetSystemMetrics(77)
    width = [DemoCaptureWindow]::GetSystemMetrics(78)
    height = [DemoCaptureWindow]::GetSystemMetrics(79)
  }
} | ConvertTo-Json -Depth 3 -Compress
`;
  const probe = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", script],
    { encoding: "utf8", windowsHide: true },
  );
  const line = (probe.stdout ?? "")
    .trim()
    .split(/\r?\n/u)
    .reverse()
    .find((candidate) => candidate.trim().startsWith("{"));
  if (!line) return null;
  try {
    const result = JSON.parse(line);
    if (
      !result?.title ||
      !Number.isFinite(result?.window?.width) ||
      !Number.isFinite(result?.window?.height) ||
      result.window.width <= 0 ||
      result.window.height <= 0
    ) {
      return null;
    }
    return result;
  } catch {
    return null;
  }
}

let ffmpeg = null;
let ffmpegExited = false;

function startCapture(windowInfo) {
  const input = captureWindow ? `title=${windowInfo.title}` : "desktop";
  writeFileSync(
    path.join(captureDir, "capture.json"),
    `${JSON.stringify(
      {
        version: 1,
        label,
        fps,
        captureMode: captureWindow ? "window" : "virtual-desktop",
        captureStartedAt: new Date().toISOString(),
        rawFile: path.basename(rawPath),
        model: model || null,
        vaultName: showcaseVault ? path.basename(showcaseVault) : null,
        window: windowInfo.window,
        virtualDesktop: windowInfo.virtualDesktop,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  const ffmpegArgs = [
    "-y",
    "-f",
    "gdigrab",
    "-framerate",
    String(fps),
    // No cursor: the harness drives via CDP, so the physical pointer is an
    // idle artifact that reads as an awkward extra actor in the footage.
    "-draw_mouse",
    "0",
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
    `record-e2e-demo: capturing ${captureWindow ? `window "${windowInfo.title}"` : "full desktop (crop in post)"} at ${fps} fps -> ${rawPath}`,
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
    env: {
      ...process.env,
      DEMO_CAPTURE_DIR: captureDir,
      ...(showcaseVault
        ? {
            OBSIDIAN_VAULT: showcaseVault,
            E2E_TRUST_DISPOSABLE_VAULT: "1",
            OBSIDIAN_E2E_VAULT_ID: showcaseTrustedVaultId,
          }
        : {}),
      ...(model ? { E2E_AI_MODEL: model } : {}),
      ...(rendererPollDeadlineMs
        ? { E2E_RENDERER_POLL_DEADLINE_MS: String(rendererPollDeadlineMs) }
        : {}),
    },
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
  const windowInfo = findObsidianWindow();
  if (windowInfo) {
    clearInterval(pollTimer);
    try {
      startCapture(windowInfo);
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

let showcaseCleanupFailed = false;
if (showcaseVault) {
  try {
    const relativeVault = path.relative(captureDir, showcaseVault);
    if (
      relativeVault !== "Agentic Researcher Showcase" ||
      path.isAbsolute(relativeVault)
    ) {
      throw new Error(`Refusing unsafe showcase vault cleanup: ${showcaseVault}`);
    }
    await rm(showcaseVault, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 250,
    });
    const residue = await lstat(showcaseVault).catch((error) => {
      if (error?.code === "ENOENT") return null;
      throw error;
    });
    if (residue) {
      throw new Error("showcase vault still exists after cleanup");
    }
    await writeFile(
      path.join(captureDir, "showcase-vault-cleanup.json"),
      `${JSON.stringify(
        {
          version: 1,
          vaultName: path.basename(showcaseVault),
          status: "removed",
          cleanedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch (error) {
    showcaseCleanupFailed = true;
    console.error(
      `record-e2e-demo: showcase vault cleanup failed: ${error?.message ?? error}`,
    );
  }
}

let showcaseMappingRestoreFailed = false;
if (showcaseVault) {
  try {
    await restoreTrustedShowcaseVaultMapping();
  } catch (error) {
    showcaseMappingRestoreFailed = true;
    console.error(
      `record-e2e-demo: trusted vault mapping restore failed: ${error?.message ?? error}`,
    );
  }
}

if (ffmpeg) {
  console.log(`record-e2e-demo: raw footage: ${rawPath}`);
} else {
  console.warn("record-e2e-demo: no footage captured this run.");
}
process.exitCode =
  showcaseCleanupFailed || showcaseMappingRestoreFailed
    ? 1
    : childExit.code ?? (childExit.signal ? 1 : 0);
