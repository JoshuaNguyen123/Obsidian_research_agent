// Read-only resource evidence alongside controlled native fault/mission lanes.
// This observes an existing loopback CDP session. It never launches missions,
// extends grants, changes settings, resets budgets, or closes Obsidian.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = ["main.js", "styles.css", "manifest.json", "companion-assets.json"];

export function parseResourceMeasurementArgs(args) {
  const values = Object.fromEntries(args.map((arg) => {
    const match = /^--(cdp|vault|duration-ms|interval-ms|output)=(.+)$/u.exec(arg);
    if (!match) throw new Error(`Unrecognized measurement argument: ${arg}`);
    return [match[1], match[2]];
  }));
  const cdp = new URL(values.cdp ?? "http://127.0.0.1:11223");
  if (cdp.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(cdp.hostname) || cdp.username || cdp.password) {
    throw new Error("Measurement requires an unauthenticated loopback CDP endpoint.");
  }
  const durationMs = Number(values["duration-ms"] ?? 8 * 60 * 60_000);
  const intervalMs = Number(values["interval-ms"] ?? 60_000);
  if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 24 * 60 * 60_000 ||
      !Number.isSafeInteger(intervalMs) || intervalMs < 1_000 || intervalMs > 60_000) throw new Error("Invalid bounded measurement duration or interval.");
  if (!values.vault) throw new Error("Specify --vault=absolute-path to bind observations to the intended vault.");
  if (!path.isAbsolute(values.vault)) throw new Error("The measurement vault must be an absolute path.");
  return { cdp: cdp.href, vault: values.vault, durationMs, intervalMs,
    output: path.resolve(values.output ?? path.join(repoRoot, "docs", "eval", "overnight-resources", `${randomUUID()}.jsonl`)) };
}

export async function measureStorage(directory, maxEntries = 100_000) {
  let bytes = 0;
  let files = 0;
  let visited = 0;
  const queue = [directory];
  while (queue.length) {
    const current = queue.pop();
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    for (const entry of entries) {
      if (++visited > maxEntries) throw new Error("Storage inventory exceeded its bounded entry limit.");
      const target = path.join(current, entry.name);
      const info = await lstat(target);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) queue.push(target);
      else if (info.isFile()) { bytes += info.size; files++; }
    }
  }
  return { bytes, files };
}

export function summarizeResourceSamples(samples, targetDurationMs) {
  const observed = samples.filter((sample) => sample.status === "observed");
  const first = observed[0];
  const last = observed.at(-1);
  const sessions = [...new Set(observed.map((sample) => sample.runtimeStartedAt).filter((value) => value != null))];
  const elapsedMs = samples.length > 1 ? samples.at(-1).elapsedMs - samples[0].elapsedMs : 0;
  return { samples: samples.length, observed: observed.length, coverage: samples.length ? observed.length / samples.length : null,
    elapsedMs, durationSatisfied: elapsedMs >= targetDurationMs,
    runtimeSessions: sessions.length,
    heapGrowthBytes: sessions.length <= 1 && first?.heapUsedBytes != null && last?.heapUsedBytes != null ? last.heapUsedBytes - first.heapUsedBytes : null,
    storageGrowthBytes: first?.storageBytes != null && last?.storageBytes != null ? last.storageBytes - first.storageBytes : null,
    maxRoundTripMs: observed.length ? Math.max(...observed.map((sample) => sample.roundTripMs)) : null,
    // Sampling resource behavior does not establish accepted mission output.
    acceptedOutputEfficiency: null, qualification: "resource_observation_only" };
}

export async function runResourceMeasurement(options) {
  const { chromium } = await import("playwright");
  const vault = await realpath(options.vault);
  const installed = path.join(vault, ".obsidian", "plugins", "agentic-researcher");
  const hashes = Object.fromEntries(await Promise.all(artifacts.map(async (name) => [name, {
    source: await hashFile(path.join(repoRoot, name)), installed: await hashFile(path.join(installed, name)),
  }])));
  if (Object.values(hashes).some((value) => value.source !== value.installed)) throw new Error("Install current plugin artifacts before measuring the runtime.");
  const [{ stdout: commit }, { stdout: dirty }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }),
    execFileAsync("git", ["status", "--porcelain"], { cwd: repoRoot }),
  ]);
  let browser;
  const samples = [];
  const started = Date.now();
  async function connectToMatchingVault() {
    await browser?.close().catch(() => undefined);
    browser = await chromium.connectOverCDP(options.cdp, { timeout: 15_000 });
    const pages = browser.contexts().flatMap((context) => context.pages());
    for (const candidate of pages) {
      const identity = await boundedMeasurement(candidate.evaluate(() => {
        const app = globalThis.app;
        const plugin = app?.plugins?.plugins?.["agentic-researcher"];
        return plugin ? { vault: app.vault.adapter.basePath, model: plugin.settings.model,
          maxAgentSteps: plugin.settings.maxAgentSteps, overnightMaxSegments: plugin.settings.overnightMaxSegments } : null;
      })).catch(() => null);
      if (identity?.vault && await realpath(identity.vault).catch(() => null) === vault) return { page: candidate, settings: identity };
    }
    throw new Error("No native plugin page matched the requested vault.");
  }
  try {
    let { page, settings } = await connectToMatchingVault();
    await mkdir(path.dirname(options.output), { recursive: true });
    await appendFile(options.output, `${JSON.stringify({ kind: "identity", version: 1, startedAt: new Date(started).toISOString(),
      commit: commit.trim(), sourceState: dirty.trim() ? "dirty_worktree" : "clean_head", hashes,
      settings: { model: settings.model, maxAgentSteps: settings.maxAgentSteps, overnightMaxSegments: settings.overnightMaxSegments },
      targetDurationMs: options.durationMs, intervalMs: options.intervalMs, qualification: "resource_observation_only" })}\n`, { flag: "wx" });
    do {
      const before = Date.now();
      let sample;
      try {
        if (!page || page.isClosed() || !browser.isConnected()) {
          ({ page, settings } = await connectToMatchingVault());
          const installedHashes = Object.fromEntries(await Promise.all(artifacts.map(async (name) => [name, await hashFile(path.join(installed, name))])));
          if (artifacts.some((name) => installedHashes[name] !== hashes[name].installed)) throw new Error("Installed build changed during observation.");
          await appendFile(options.output, `${JSON.stringify({ kind: "reconnected", elapsedMs: Date.now() - started,
            settings: { model: settings.model, maxAgentSteps: settings.maxAgentSteps, overnightMaxSegments: settings.overnightMaxSegments }, installedHashes })}\n`);
        }
        const renderer = await boundedMeasurement(page.evaluate(async () => {
          const before = performance.now();
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { runtimeStartedAt: performance.timeOrigin, heapUsedBytes: performance.memory?.usedJSHeapSize ?? null, eventLoopLagMs: Math.max(0, performance.now() - before - 100) };
        }));
        const roundTripMs = Date.now() - before;
        const storage = await Promise.all(["Agent Runs", "Agent Sources", ".agent-backups"].map((folder) => measureStorage(path.join(vault, folder))));
        sample = { status: "observed", elapsedMs: Date.now() - started, roundTripMs,
          ...renderer, storageBytes: storage.reduce((sum, item) => sum + item.bytes, 0), storageFiles: storage.reduce((sum, item) => sum + item.files, 0) };
      } catch {
        page = undefined;
        sample = { status: "unavailable", elapsedMs: Date.now() - started, heapUsedBytes: null, storageBytes: null };
      }
      samples.push(sample);
      await appendFile(options.output, `${JSON.stringify({ kind: "sample", ...sample })}\n`);
      const remaining = options.durationMs - (sample.elapsedMs - samples[0].elapsedMs);
      if (remaining <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(options.intervalMs, remaining)));
    } while (true);
    const summary = summarizeResourceSamples(samples, options.durationMs);
    await appendFile(options.output, `${JSON.stringify({ kind: "summary", ...summary })}\n`);
    return { output: options.output, ...summary };
  } finally {
    // Playwright's CDP close disconnects this client; it does not terminate the
    // existing browser. This sampler never owns the application lifetime.
    await browser?.close();
  }
}

async function hashFile(file) { return createHash("sha256").update(await readFile(file)).digest("hex"); }

async function boundedMeasurement(operation) {
  let timer;
  try { return await Promise.race([operation, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("Renderer observation timed out.")), 10_000);
  })]); } finally { clearTimeout(timer); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runResourceMeasurement(parseResourceMeasurementArgs(process.argv.slice(2)))
    .then((result) => { console.log(JSON.stringify(result)); if (!result.durationSatisfied || result.coverage !== 1) process.exitCode = 1; })
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}
