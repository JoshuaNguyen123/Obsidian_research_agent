import { spawnSync } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function readFlag(name, fallback = "") {
  const prefix = `--${name}=`;
  const match = process.argv.slice(2).find((argument) => argument.startsWith(prefix));
  return match ? match.slice(prefix.length) : fallback;
}

function fail(message) {
  console.error(`render-public-demo: ${message}`);
  process.exit(2);
}

function finiteNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number)) fail(`${label} must be a finite number.`);
  return number;
}

function evenFloor(value) {
  return Math.max(2, Math.floor(value / 2) * 2);
}

function evenPosition(value) {
  return Math.max(0, Math.floor(value / 2) * 2);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: options.inherit ? undefined : "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    const detail = options.inherit
      ? ""
      : `\n${String(result.stderr ?? result.stdout ?? "").slice(-4_000)}`;
    fail(
      `${command} failed with exit ${result.status ?? "unknown"}: ${
        result.error?.message ?? ""
      }${detail}`,
    );
  }
  return result.stdout ?? "";
}

function probeVideo(filePath) {
  const raw = run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration:stream=index,codec_type,width,height",
    "-of",
    "json",
    filePath,
  ]);
  const probe = JSON.parse(raw);
  const stream = probe.streams?.find((item) => item.codec_type === "video");
  if (!stream) fail(`No video stream found in ${filePath}.`);
  return {
    width: finiteNumber(stream.width, "raw video width"),
    height: finiteNumber(stream.height, "raw video height"),
    duration: finiteNumber(probe.format?.duration, "raw video duration"),
  };
}

function validateManifest(manifest) {
  if (manifest?.version !== 1) fail("manifest.version must be 1.");
  if (!["researcher", "builder"].includes(manifest.role)) {
    fail("manifest.role must be researcher or builder.");
  }
  if (!Array.isArray(manifest.segments) || manifest.segments.length < 2) {
    fail("manifest.segments must contain at least two straight-cut segments.");
  }
  const width = finiteNumber(manifest.output?.width, "output.width");
  const height = finiteNumber(manifest.output?.height, "output.height");
  const fps = finiteNumber(manifest.output?.fps, "output.fps");
  if (width / height !== 16 / 9 || width % 2 || height % 2) {
    fail("manifest output must be an even-pixel 16:9 frame.");
  }
  if (fps < 24 || fps > 60) fail("manifest output fps must be between 24 and 60.");
}

function readTimeline(rawText, captureStartedAt) {
  const base = Date.parse(captureStartedAt);
  if (!Number.isFinite(base)) fail("captureStartedAt is not a valid ISO timestamp.");
  const byName = new Map();
  for (const line of rawText.split(/\r?\n/u).filter(Boolean)) {
    const item = JSON.parse(line);
    const at = Date.parse(item.at);
    if (
      item.version !== 1 ||
      typeof item.name !== "string" ||
      !Number.isFinite(at)
    ) {
      fail("timeline.ndjson contains an invalid marker.");
    }
    byName.set(item.name, Math.max(0, (at - base) / 1_000));
  }
  return byName;
}

function segmentStart(segment, timeline, index) {
  if (Number.isFinite(segment.start)) return Number(segment.start);
  if (typeof segment.at !== "string") {
    fail(`segment ${index + 1} needs a numeric start or an at marker.`);
  }
  const marker = timeline.get(segment.at);
  if (!Number.isFinite(marker)) {
    fail(`segment ${index + 1} references missing timeline marker ${segment.at}.`);
  }
  return Math.max(0, marker + finiteNumber(segment.offsetSeconds ?? 0, "offsetSeconds"));
}

function resolveWindowCrop(capture, raw, manifest) {
  const inset = manifest.crop?.inset ?? {};
  const base = (() => {
    if (capture.captureMode === "window") {
      return { left: 0, top: 0, width: raw.width, height: raw.height };
    }
    // Win32 reports DWM bounds in logical desktop pixels while gdigrab emits
    // the physical framebuffer. At 125% display scaling, using the logical
    // bounds directly crops away a quarter of the application and makes every
    // later push-in look accidental. Resolve the exact per-axis scale from the
    // captured desktop metadata before applying the window crop.
    const virtualWidth = finiteNumber(
      capture.virtualDesktop?.width,
      "virtualDesktop.width",
    );
    const virtualHeight = finiteNumber(
      capture.virtualDesktop?.height,
      "virtualDesktop.height",
    );
    const scaleX = raw.width / virtualWidth;
    const scaleY = raw.height / virtualHeight;
    return {
      left:
        (finiteNumber(capture.window?.left, "window.left") -
          finiteNumber(capture.virtualDesktop?.left, "virtualDesktop.left")) *
        scaleX,
      top:
        (finiteNumber(capture.window?.top, "window.top") -
          finiteNumber(capture.virtualDesktop?.top, "virtualDesktop.top")) *
        scaleY,
      width: finiteNumber(capture.window?.width, "window.width") * scaleX,
      height: finiteNumber(capture.window?.height, "window.height") * scaleY,
    };
  })();
  const left = Math.max(
    0,
    base.left + finiteNumber(inset.left ?? 0, "crop.inset.left"),
  );
  const top = Math.max(
    0,
    base.top + finiteNumber(inset.top ?? 0, "crop.inset.top"),
  );
  const right = Math.min(
    raw.width,
    base.left +
      base.width -
      finiteNumber(inset.right ?? 0, "crop.inset.right"),
  );
  const bottom = Math.min(
    raw.height,
    base.top +
      base.height -
      finiteNumber(inset.bottom ?? 0, "crop.inset.bottom"),
  );
  const availableWidth = right - left;
  const availableHeight = bottom - top;
  if (availableWidth < 640 || availableHeight < 360) {
    fail("captured Obsidian bounds are too small after applying crop insets.");
  }

  const ratio = 16 / 9;
  const anchorX = finiteNumber(manifest.crop?.anchorX ?? 0.5, "crop.anchorX");
  const anchorY = finiteNumber(manifest.crop?.anchorY ?? 0.5, "crop.anchorY");
  let width;
  let height;
  if (availableWidth / availableHeight > ratio) {
    height = evenFloor(availableHeight);
    width = evenFloor(height * ratio);
  } else {
    width = evenFloor(availableWidth);
    height = evenFloor(width / ratio);
  }
  const x = evenPosition(
    left + Math.max(0, availableWidth - width) * Math.min(1, Math.max(0, anchorX)),
  );
  const y = evenPosition(
    top + Math.max(0, availableHeight - height) * Math.min(1, Math.max(0, anchorY)),
  );
  return { x, y, width, height };
}

function segmentFilter(segment, index, start, baseCrop, output) {
  const duration = finiteNumber(segment.duration, `segment ${index + 1} duration`);
  if (duration <= 0 || duration > 15) {
    fail(`segment ${index + 1} duration must be greater than 0 and at most 15 seconds.`);
  }
  const zoomFrom = finiteNumber(segment.zoomFrom ?? 1, "zoomFrom");
  const zoomTo = finiteNumber(segment.zoomTo ?? zoomFrom, "zoomTo");
  if (zoomFrom < 1 || zoomFrom > 2.5 || zoomTo < 1 || zoomTo > 2.5) {
    fail("Demo framing zoom must stay between 1 and 2.5.");
  }
  if (Math.abs(zoomTo - zoomFrom) > 0.12) {
    fail("Each demo push-in must stay within 0.12 zoom.");
  }
  const anchorX = Math.min(
    1,
    Math.max(0, finiteNumber(segment.anchorX ?? 0.5, "segment.anchorX")),
  );
  const anchorY = Math.min(
    1,
    Math.max(0, finiteNumber(segment.anchorY ?? 0.5, "segment.anchorY")),
  );
  const frames = Math.max(2, Math.round(duration * output.fps));
  const delta = zoomTo - zoomFrom;
  const zoomExpression =
    Math.abs(delta) < 0.000001
      ? zoomFrom.toFixed(6)
      : `${zoomFrom.toFixed(6)}+(${delta.toFixed(6)})*on/${frames - 1}`;
  return [
    `[0:v]trim=start=${start.toFixed(3)}:duration=${duration.toFixed(3)}`,
    "setpts=PTS-STARTPTS",
    `fps=${output.fps}`,
    `crop=${baseCrop.width}:${baseCrop.height}:${baseCrop.x}:${baseCrop.y}`,
    `zoompan=z='${zoomExpression}':x='(iw-iw/zoom)*${anchorX.toFixed(
      4,
    )}':y='(ih-ih/zoom)*${anchorY.toFixed(4)}':d=1:s=${output.width}x${
      output.height
    }:fps=${output.fps}`,
    "format=yuv420p",
    "setsar=1",
  ].join(",");
}

const manifestArgument = readFlag("manifest");
const captureDirectoryArgument = readFlag("capture-dir");
if (!manifestArgument || !captureDirectoryArgument) {
  fail(
    "usage: node scripts/render-public-demo.mjs --manifest=<json> --capture-dir=<recording directory>",
  );
}

const manifestPath = path.resolve(process.cwd(), manifestArgument);
const captureDirectory = path.resolve(process.cwd(), captureDirectoryArgument);
const outputDirectory = path.resolve(
  process.cwd(),
  readFlag("output-dir", "public-site/media"),
);
const contactSheetDirectory = path.resolve(
  process.cwd(),
  readFlag("contact-sheet-dir", "test-results/public-site-media"),
);
const [manifest, capture, timelineText] = await Promise.all([
  readFile(manifestPath, "utf8").then(JSON.parse),
  readFile(path.join(captureDirectory, "capture.json"), "utf8").then(JSON.parse),
  readFile(path.join(captureDirectory, "timeline.ndjson"), "utf8"),
]);
validateManifest(manifest);
if (capture.vaultName) {
  const vaultName = String(capture.vaultName).trim();
  if (!vaultName || /\b(?:e2e|test)\b/iu.test(vaultName)) {
    fail(`capture vault name is not release-safe: ${vaultName || "(empty)"}.`);
  }
  const cleanup = await readFile(
    path.join(captureDirectory, "showcase-vault-cleanup.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((error) => {
      fail(`showcase vault cleanup proof is missing: ${error?.message ?? error}`);
    });
  if (
    cleanup?.version !== 1 ||
    cleanup?.status !== "removed" ||
    cleanup?.vaultName !== vaultName
  ) {
    fail("showcase vault cleanup proof is invalid.");
  }
}
const rawPath = path.join(captureDirectory, capture.rawFile ?? "raw.mkv");
const raw = probeVideo(rawPath);
const timeline = readTimeline(timelineText, capture.captureStartedAt);
const baseCrop = resolveWindowCrop(capture, raw, manifest);
const output = {
  width: Number(manifest.output.width),
  height: Number(manifest.output.height),
  fps: Number(manifest.output.fps),
};
const resolvedSegments = manifest.segments.map((segment, index) => {
  const start = segmentStart(segment, timeline, index);
  const duration = finiteNumber(segment.duration, `segment ${index + 1} duration`);
  if (start + duration > raw.duration + 0.05) {
    fail(`segment ${index + 1} ends after the raw capture.`);
  }
  return { segment, start, duration };
});
const finalDuration = resolvedSegments.reduce(
  (total, item) => total + item.duration,
  0,
);
const expectedMin = finiteNumber(manifest.expectedDuration?.min, "expectedDuration.min");
const expectedMax = finiteNumber(manifest.expectedDuration?.max, "expectedDuration.max");
if (finalDuration < expectedMin || finalDuration > expectedMax) {
  fail(
    `straight cuts total ${finalDuration.toFixed(2)}s; expected ${expectedMin}-${expectedMax}s.`,
  );
}

const filters = resolvedSegments.map(({ segment, start }, index) => {
  return `${segmentFilter(segment, index, start, baseCrop, output)}[segment${index}]`;
});
const concatInputs = resolvedSegments
  .map((_, index) => `[segment${index}]`)
  .join("");
const filterComplex = `${filters.join(";")};${concatInputs}concat=n=${
  resolvedSegments.length
}:v=1:a=0[outv]`;

await Promise.all([
  mkdir(outputDirectory, { recursive: true }),
  mkdir(contactSheetDirectory, { recursive: true }),
]);
const baseName = `${manifest.role}-demo`;
const mp4Path = path.join(outputDirectory, `${baseName}.mp4`);
const webmPath = path.join(outputDirectory, `${baseName}.webm`);
const posterPath = path.join(outputDirectory, `${baseName}-poster.jpg`);
const contactSheetPath = path.join(
  contactSheetDirectory,
  `${baseName}-contact-sheet.jpg`,
);

console.log(
  `render-public-demo: ${manifest.role} ${finalDuration.toFixed(
    2,
  )}s, ${resolvedSegments.length} straight cuts, crop ${baseCrop.width}x${
    baseCrop.height
  }+${baseCrop.x}+${baseCrop.y}`,
);
run(
  "ffmpeg",
  [
    "-y",
    "-i",
    rawPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-an",
    "-map_metadata",
    "-1",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "24",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Path,
  ],
  { inherit: true },
);
run(
  "ffmpeg",
  [
    "-y",
    "-i",
    rawPath,
    "-filter_complex",
    filterComplex,
    "-map",
    "[outv]",
    "-an",
    "-map_metadata",
    "-1",
    "-c:v",
    "libvpx-vp9",
    "-deadline",
    "good",
    "-cpu-used",
    "2",
    "-row-mt",
    "1",
    "-crf",
    "38",
    "-b:v",
    "0",
    webmPath,
  ],
  { inherit: true },
);

const posterAt = finiteNumber(
  manifest.poster?.atSeconds ?? finalDuration - 0.5,
  "poster.atSeconds",
);
if (posterAt < 0 || posterAt >= finalDuration) {
  fail("poster.atSeconds must fall inside the final edit.");
}
const posterZoom = finiteNumber(manifest.poster?.zoom ?? 1, "poster.zoom");
if (posterZoom < 1 || posterZoom > 2.5) {
  fail("poster.zoom must stay between 1 and 2.5.");
}
const posterAnchorX = Math.min(
  1,
  Math.max(0, finiteNumber(manifest.poster?.anchorX ?? 0.5, "poster.anchorX")),
);
const posterAnchorY = Math.min(
  1,
  Math.max(0, finiteNumber(manifest.poster?.anchorY ?? 0.5, "poster.anchorY")),
);
const posterFilter = [
  `crop=iw/${posterZoom.toFixed(6)}:ih/${posterZoom.toFixed(6)}`,
  `(iw-ow)*${posterAnchorX.toFixed(4)}`,
  `(ih-oh)*${posterAnchorY.toFixed(4)}`,
].join(":");
run(
  "ffmpeg",
  [
    "-y",
    "-ss",
    posterAt.toFixed(3),
    "-i",
    mp4Path,
    "-vf",
    `${posterFilter},scale=${output.width}:${output.height}:flags=lanczos,setsar=1`,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    "2",
    posterPath,
  ],
  { inherit: true },
);
const columns = 4;
const rows = 3;
const interval = finalDuration / (columns * rows);
run(
  "ffmpeg",
  [
    "-y",
    "-i",
    mp4Path,
    "-vf",
    `fps=1/${interval.toFixed(
      6,
    )},scale=320:180:flags=lanczos,tile=${columns}x${rows}:padding=4:margin=4:color=0x111214`,
    "-frames:v",
    "1",
    "-update",
    "1",
    "-q:v",
    "3",
    contactSheetPath,
  ],
  { inherit: true },
);

console.log(
  JSON.stringify(
    {
      role: manifest.role,
      duration: finalDuration,
      segments: resolvedSegments.map(({ start, duration }) => ({
        start,
        duration,
      })),
      outputs: { mp4Path, webmPath, posterPath, contactSheetPath },
    },
    null,
    2,
  ),
);
