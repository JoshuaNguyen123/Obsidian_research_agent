#!/usr/bin/env node
/**
 * Measure plugin load time in the real Obsidian with a seeded Agent Runs
 * backlog.
 *
 * The campaign metric is "onload to core-ready with 200 run notes < 150 ms".
 * Nothing in the unit suite can measure it: the cost is Obsidian's vault
 * index, its metadata cache, and disk reads on the load path. This script
 *
 *   1. seeds N synthetic TERMINAL run notes into the test vault (clones of a
 *      real completed run note with fresh run ids, so the parsers see exactly
 *      the bytes the product writes; `--no-frontmatter` strips the status
 *      frontmatter to reproduce the pre-fix note shape),
 *   2. launches Obsidian once so the metadata cache indexes the new files,
 *   3. launches it again and reads `plugin.getStartupTiming()` over CDP,
 *   4. prints one JSON line and removes the seeded notes.
 *
 * Run only while no e2e lane owns the machine (the exclusive runner's
 * Obsidian must be closed). Port 11227 is the standing manual-drive port.
 *
 *   node scripts/measure-startup-timing.mjs --notes=200 [--no-frontmatter]
 *       [--launches=2] [--keep]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const VAULT = process.env.STARTUP_TIMING_VAULT ??
  "C:/Users/joshb/OneDrive/Desktop/test_vault_obsidian_ai";
const OBSIDIAN = process.env.OBSIDIAN_EXE ??
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Obsidian", "Obsidian.exe");
const PORT = Number(process.env.STARTUP_TIMING_PORT ?? 11227);
const RUNS_FOLDER = path.join(VAULT, "Agent Runs");
const SEED_PREFIX = "run-2026-09-03T00-00-00.000Z-seedtiming";

const args = new Map(
  process.argv.slice(2).map((argument) => {
    const match = /^--([^=]+)(?:=(.*))?$/u.exec(argument);
    return match ? [match[1], match[2] ?? "true"] : [argument, "true"];
  }),
);
const noteCount = Number(args.get("notes") ?? 200);
const withFrontmatter = args.get("no-frontmatter") !== "true";
const launches = Number(args.get("launches") ?? 2);
const keep = args.get("keep") === "true";

function log(message) {
  process.stderr.write(`[startup-timing] ${message}\n`);
}

function findTerminalTemplate() {
  const files = fs
    .readdirSync(RUNS_FOLDER)
    .filter((name) => name.endsWith(".md") && !name.startsWith(SEED_PREFIX));
  for (const name of files) {
    const markdown = fs.readFileSync(path.join(RUNS_FOLDER, name), "utf8");
    const fence = /## Runtime Snapshot\r?\n```json\r?\n([\s\S]*?)\r?\n```/u.exec(markdown);
    if (!fence) continue;
    try {
      const snapshot = JSON.parse(fence[1]);
      if (snapshot?.status === "complete" && typeof snapshot.runId === "string") {
        return { name, markdown, runId: snapshot.runId };
      }
    } catch {
      // not a template
    }
  }
  return null;
}

function seedNotes(template) {
  const seeded = [];
  const body = template.markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "");
  for (let index = 0; index < noteCount; index += 1) {
    const runId = `${SEED_PREFIX}${String(index).padStart(4, "0")}`;
    let markdown = body.split(template.runId).join(runId);
    if (withFrontmatter) {
      markdown = `---\nagentic_run_status: complete\n---\n${markdown}`;
    }
    const target = path.join(RUNS_FOLDER, `${runId}.md`);
    fs.writeFileSync(target, markdown);
    seeded.push(target);
  }
  return seeded;
}

function removeSeeded() {
  let removed = 0;
  for (const name of fs.readdirSync(RUNS_FOLDER)) {
    if (name.startsWith(SEED_PREFIX)) {
      fs.rmSync(path.join(RUNS_FOLDER, name), { force: true });
      removed += 1;
    }
  }
  return removed;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function connectToVaultPage(deadlineMs) {
  const deadline = Date.now() + deadlineMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          const isVault = await page
            .evaluate(() => typeof window.app?.vault?.adapter?.basePath === "string")
            .catch(() => false);
          if (isVault) return { browser, page };
        }
      }
      await browser.close().catch(() => {});
    } catch (error) {
      lastError = error;
    }
    await sleep(500);
  }
  throw new Error(`no vault page over CDP within ${deadlineMs} ms: ${lastError?.message ?? "unknown"}`);
}

async function waitFor(page, expression, deadlineMs, label, argument) {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    if (page.isClosed()) throw new Error(`page closed while waiting for ${label}`);
    const value = await page.evaluate(expression, argument).catch(() => null);
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function launchObsidian() {
  const child = spawn(
    OBSIDIAN,
    [
      `--remote-debugging-port=${PORT}`,
      "--no-first-run",
      "--enable-logging=stderr",
      "--js-flags=--max-old-space-size=8192",
      VAULT,
    ],
    { stdio: "ignore", windowsHide: false },
  );
  return child;
}

async function closeObsidian(page, browser, child) {
  try {
    await page.evaluate(() => {
      const remote = window.require?.("electron")?.remote ?? window.require?.("@electron/remote");
      remote?.app?.quit?.();
    });
  } catch {
    // fall through to a process kill
  }
  await browser.close().catch(() => {});
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && child.exitCode === null) {
    await sleep(250);
  }
  if (child.exitCode === null) {
    spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await sleep(2_000);
  }
}

async function oneLaunch(index) {
  const child = await launchObsidian();
  try {
    const { browser, page } = await connectToVaultPage(60_000);
    const title = await page.title().catch(() => "");
    if (!/test_vault_obsidian_ai/u.test(title)) {
      log(`WARNING: window title "${title}" is not the test vault`);
    }
    await waitFor(
      page,
      () => Boolean(window.app?.plugins?.plugins?.["agentic-researcher"]),
      90_000,
      "plugin load",
    );
    const timing = await waitFor(
      page,
      () => {
        const plugin = window.app?.plugins?.plugins?.["agentic-researcher"];
        const value = plugin?.getStartupTiming?.();
        return value && typeof value.coreReadyMs === "number" ? value : null;
      },
      60_000,
      "startup timing",
    );
    // Let the metadata cache index the seeded files before the next launch:
    // the last seeded file must report frontmatter through the cache.
    const lastSeeded = `Agent Runs/${SEED_PREFIX}${String(noteCount - 1).padStart(4, "0")}.md`;
    const cacheReady = await waitFor(
      page,
      (relativePath) => {
        const file = window.app.vault.getFileByPath(relativePath);
        if (!file) return "missing";
        const cache = window.app.metadataCache.getFileCache(file);
        return cache ? (cache.frontmatter ? "frontmatter" : "indexed") : null;
      },
      60_000,
      "metadata cache for the last seeded note",
      lastSeeded,
    ).catch(() => "timeout");
    const runNoteCount = await page.evaluate(
      () => window.app.vault.getFiles().filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path)).length,
    );
    await closeObsidian(page, browser, child);
    return { launch: index, timing, cacheReady, runNoteCount };
  } catch (error) {
    if (child.exitCode === null) {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    }
    throw error;
  }
}

async function main() {
  if (!fs.existsSync(OBSIDIAN)) throw new Error(`Obsidian not found at ${OBSIDIAN}`);
  if (!fs.existsSync(RUNS_FOLDER)) throw new Error(`no Agent Runs folder in ${VAULT}`);
  const template = findTerminalTemplate();
  if (!template) throw new Error("no completed run note to clone in the test vault");
  log(`template ${template.name}; seeding ${noteCount} terminal notes (${withFrontmatter ? "with" : "without"} status frontmatter)`);
  removeSeeded();
  seedNotes(template);
  const results = [];
  try {
    for (let index = 1; index <= launches; index += 1) {
      log(`launch ${index}/${launches}`);
      const result = await oneLaunch(index);
      results.push(result);
      log(`launch ${index}: core ready ${result.timing.coreReadyMs} ms (cache ${result.cacheReady}, ${result.runNoteCount} run notes)`);
      await sleep(2_000);
    }
  } finally {
    if (!keep) {
      const removed = removeSeeded();
      log(`removed ${removed} seeded notes`);
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      measuredAt: new Date().toISOString(),
      host: os.hostname(),
      noteCount,
      withFrontmatter,
      results,
    })}\n`,
  );
}

main().catch((error) => {
  log(`FAILED: ${error?.stack ?? error}`);
  if (!keep) removeSeeded();
  process.exit(1);
});
