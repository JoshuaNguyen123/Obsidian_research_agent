import { spawnSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

function fail(message) {
  throw new Error(`public demo media: ${message}`);
}

function probe(filePath) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration,format_name:stream=index,codec_name,codec_type,width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    fail(
      `ffprobe failed for ${path.basename(filePath)}: ${
        result.error?.message ?? String(result.stderr ?? "").slice(-500)
      }`,
    );
  }
  return JSON.parse(result.stdout);
}

function durationOf(probeResult) {
  const value = Number(probeResult.format?.duration);
  if (!Number.isFinite(value)) fail("media duration is missing.");
  return value;
}

function videoStream(probeResult, fileName) {
  const videos = (probeResult.streams ?? []).filter(
    (stream) => stream.codec_type === "video",
  );
  const audios = (probeResult.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  if (videos.length !== 1) fail(`${fileName} must contain exactly one video stream.`);
  if (audios.length !== 0) fail(`${fileName} must not contain an audio stream.`);
  return videos[0];
}

const mediaDirectory = path.resolve(process.cwd(), "public-site", "media");
const contract = JSON.parse(
  await readFile(path.join(mediaDirectory, "demo-media-contract.json"), "utf8"),
);
if (contract.version !== 1) fail("unsupported contract version.");

const summaries = [];
for (const [role, definition] of Object.entries(contract.roles)) {
  const variants = [
    { kind: "mp4", fileName: definition.mp4, codec: "h264" },
    { kind: "webm", fileName: definition.webm, codec: "vp9" },
  ];
  const durations = [];
  for (const variant of variants) {
    const filePath = path.join(mediaDirectory, variant.fileName);
    const [info, probeResult] = await Promise.all([stat(filePath), Promise.resolve(probe(filePath))]);
    if (info.size > contract.maximumBytesPerFallback) {
      fail(
        `${variant.fileName} is ${info.size} bytes; maximum is ${contract.maximumBytesPerFallback}.`,
      );
    }
    const stream = videoStream(probeResult, variant.fileName);
    if (stream.codec_name !== variant.codec) {
      fail(
        `${variant.fileName} uses ${stream.codec_name}; expected ${variant.codec}.`,
      );
    }
    if (
      stream.width !== contract.output.width ||
      stream.height !== contract.output.height
    ) {
      fail(
        `${variant.fileName} is ${stream.width}x${stream.height}; expected ${contract.output.width}x${contract.output.height}.`,
      );
    }
    const duration = durationOf(probeResult);
    if (
      duration < definition.minimumDurationSeconds - 0.05 ||
      duration > definition.maximumDurationSeconds + 0.05
    ) {
      fail(
        `${variant.fileName} is ${duration.toFixed(3)}s; expected ${definition.minimumDurationSeconds}-${definition.maximumDurationSeconds}s.`,
      );
    }
    durations.push(duration);
    summaries.push({
      role,
      kind: variant.kind,
      file: variant.fileName,
      bytes: info.size,
      duration,
      codec: stream.codec_name,
      width: stream.width,
      height: stream.height,
      audioStreams: 0,
    });
  }
  if (Math.abs(durations[0] - durations[1]) > 0.1) {
    fail(`${role} fallback durations differ by more than 0.1 seconds.`);
  }

  const posterPath = path.join(mediaDirectory, definition.poster);
  const posterProbe = probe(posterPath);
  const posterInfo = await stat(posterPath);
  const posterVideo = videoStream(posterProbe, definition.poster);
  if (
    posterVideo.width !== contract.output.width ||
    posterVideo.height !== contract.output.height
  ) {
    fail(
      `${definition.poster} is ${posterVideo.width}x${posterVideo.height}; expected ${contract.output.width}x${contract.output.height}.`,
    );
  }
  summaries.push({
    role,
    kind: "poster",
    file: definition.poster,
    bytes: posterInfo.size,
    width: posterVideo.width,
    height: posterVideo.height,
  });
}

console.log(JSON.stringify({ version: 1, media: summaries }, null, 2));
