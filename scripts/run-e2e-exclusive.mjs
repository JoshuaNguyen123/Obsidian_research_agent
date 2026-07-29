import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  unlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertMissionScorecardSummaryFile } from "./mission-scorecard-regression.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PLAYWRIGHT_EXECUTION_REPORT_PATH = path.join(
  repoRoot,
  "test-results",
  "playwright-execution-report.json",
);
const DEFAULT_WAIT_MS = 30_000;
const DEFAULT_POLL_MS = 250;
const DEFAULT_PLAYWRIGHT_PROJECT = "desktop-checkers-delivery-real-live";
// Only lanes that drive the production plugin against a real model, a real
// external service, or both. Mock-model projects were removed: they proved
// nothing about a host the product could not actually run on.
const PLAYWRIGHT_PROJECTS = new Set([
  DEFAULT_PLAYWRIGHT_PROJECT,
  "retained-journey",
  "byok-autonomous-journey",
  "daily-use-research",
  "daily-use-code-live",
  "desktop-code-delivery-real-live",
  "demo-recording",
  "demo-journey-recording",
  "daily-use-compound",
  "obsidian-hello-github-live",
  "real-ai-contract",
  "real-ai-soak",
  "provider-canary",
  "release-vertical",
  "disposable-live-external",
  "configured-linear-live",
  "linear-flow-real-cleanup",
  "compound-flow-real-live",
  "github-askpass-runtime-live",
]);
// Lanes that require an explicit disposable external-service scope. They gate
// before the lock, build, vault sync, or Obsidian boot, so a missing credential
// or cleanup boundary fails in seconds.
const EXTERNAL_CREDENTIAL_PROJECTS = Object.freeze({
  "byok-autonomous-journey": {
    requiredEnv: ["LINEAR_LIVE_TEST_TEAM_ID"],
    platforms: ["win32"],
  },
  "github-askpass-runtime-live": {
    requiredEnv: ["E2E_GITHUB_TOKEN"],
    platforms: ["win32"],
  },
});
const SIGNAL_EXIT_CODES = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGTERM: 143,
};
const WINDOWS_USER_SANDBOX_ENV_NAMES = Object.freeze([
  "AGENTIC_SANDBOX_CI_EXECUTABLE",
  "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
  "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
  "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
  "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
]);
const SANDBOX_E2E_PROJECTS = new Set([
  "retained-journey",
  "byok-autonomous-journey",
  "daily-use-code-live",
  "desktop-code-delivery-real-live",
  "desktop-checkers-delivery-real-live",
  "demo-recording",
  "demo-journey-recording",
  "daily-use-compound",
  "obsidian-hello-github-live",
  "compound-flow-real-live",
  "release-vertical",
]);

let activeChild = null;
let activeLock = null;
let interruptedSignal = null;
let forcedExitTimer = null;

export async function acquireE2eLock(options = {}) {
  const lockPath =
    options.lockPath ?? resolveE2eLockPath(options.env ?? process.env);
  const waitMs = parseBoundedInteger(
    options.waitMs ??
      (options.env ?? process.env).OBSIDIAN_E2E_LOCK_WAIT_MS ??
      DEFAULT_WAIT_MS,
    "OBSIDIAN_E2E_LOCK_WAIT_MS",
    0,
    30 * 60 * 1000,
  );
  const pollMs = parseBoundedInteger(
    options.pollMs ?? DEFAULT_POLL_MS,
    "e2e lock poll interval",
    10,
    10_000,
  );
  const startedWaitingAt = Date.now();
  const metadata = {
    version: 1,
    token: randomUUID(),
    pid: process.pid,
    hostname: os.hostname(),
    startedAt: new Date().toISOString(),
    cdpPort: parseCdpPort(options.env ?? process.env),
    vault:
      (options.env ?? process.env).OBSIDIAN_VAULT ??
      "default test vault",
    cwd: repoRoot,
    playwrightArgs: options.playwrightArgs ?? [],
  };
  let loggedWait = false;

  await mkdir(path.dirname(lockPath), { recursive: true });

  while (true) {
    if (options.isCancelled?.()) {
      throw new Error("Interrupted while waiting for the exclusive Obsidian e2e lock.");
    }
    const handle = await open(lockPath, "wx", 0o600).catch((error) => {
      if (error?.code === "EEXIST") {
        return null;
      }
      throw error;
    });

    if (handle) {
      try {
        await handle.writeFile(`${JSON.stringify(metadata, null, 2)}\n`, "utf8");
        await handle.sync();
      } catch (error) {
        await handle.close().catch(() => undefined);
        await unlink(lockPath).catch((unlinkError) => {
          if (unlinkError?.code !== "ENOENT") {
            throw unlinkError;
          }
        });
        throw error;
      }
      await handle.close();

      let releasePromise = null;
      return {
        lockPath,
        metadata,
        async release() {
          if (!releasePromise) {
            releasePromise = removeLockIfOwned(lockPath, metadata.token);
          }
          await releasePromise;
        },
      };
    }

    const owner = await readLockOwner(lockPath);
    if (await recoverStaleLock(lockPath, owner, options.log ?? console)) {
      continue;
    }

    const elapsedMs = Date.now() - startedWaitingAt;
    if (elapsedMs >= waitMs) {
      throw new Error(
        [
          `Timed out after ${waitMs} ms waiting for the exclusive Obsidian e2e lock.`,
          describeOwner(owner),
          `Lock file: ${lockPath}`,
          "Wait for the owning run to finish. Remove the lock manually only after confirming its owner process is dead.",
        ].join(" "),
      );
    }

    if (!loggedWait) {
      (options.log ?? console).warn(
        `Obsidian e2e is already running; waiting up to ${waitMs} ms. ${describeOwner(owner)} Lock file: ${lockPath}`,
      );
      loggedWait = true;
    }
    await delay(Math.min(pollMs, waitMs - elapsedMs));
  }
}

export function resolveE2eLockPath(env = process.env) {
  if (env.OBSIDIAN_E2E_LOCK_PATH) {
    return path.resolve(env.OBSIDIAN_E2E_LOCK_PATH);
  }
  return path.join(
    os.tmpdir(),
    `agentic-researcher-obsidian-e2e-cdp-${parseCdpPort(env)}.lock`,
  );
}

export async function readLockOwner(lockPath) {
  let raw;
  try {
    raw = await readFile(lockPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    return { raw, metadata: JSON.parse(raw) };
  } catch {
    return { raw, metadata: null };
  }
}

export function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function main() {
  const normalized = normalizeExclusiveArgs(process.argv.slice(2));
  const { playwrightArgs, aiMode, liveExternal, projects } = normalized;
  assertExternalCredentialProjectPreconditions({ projects });
  applyE2eAiMode(aiMode);
  applyE2eProviderDefaults({ aiMode, projects });
  applyE2eLane({ liveExternal, projects });
  applyPersistedWindowsSandboxEnvironment({ projects });
  installSignalHandlers();

  try {
    activeLock = await acquireE2eLock({
      playwrightArgs,
      isCancelled: () => Boolean(interruptedSignal),
    });
    console.log(
      process.env.CI
        ? "Acquired exclusive Obsidian e2e lock."
        : `Acquired exclusive Obsidian e2e lock for PID ${process.pid}: ${activeLock.lockPath}`,
    );
    console.log(
      `E2E AI mode=${process.env.E2E_AI_MODE} model=${process.env.E2E_AI_MODEL || "(unset)"}`,
    );
    console.log(
      `E2E lane=${process.env.E2E_PLAYWRIGHT_LANE} live_external=${process.env.E2E_LIVE_EXTERNAL === "1" ? "enabled" : "disabled"}`,
    );
    const exitCode = await runE2ePipeline(playwrightArgs);
    if (exitCode === 0) {
      // Execution proof first: a scorecard check over a suite that never ran
      // would just be a second way to report a green lie.
      await assertSelectedProjectsExecuted(projects);
      await assertMissionScorecardSummaryFile({ selectedProjects: projects });
    }
    process.exitCode = interruptedSignal
      ? SIGNAL_EXIT_CODES[interruptedSignal] ?? 1
      : exitCode;
  } catch (error) {
    if (!interruptedSignal) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    } else {
      process.exitCode = SIGNAL_EXIT_CODES[interruptedSignal] ?? 1;
    }
  } finally {
    if (forcedExitTimer) {
      clearTimeout(forcedExitTimer);
      forcedExitTimer = null;
    }
    await activeLock?.release().catch((error) => {
      console.error(`Failed to release Obsidian e2e lock: ${error.message}`);
      process.exitCode = 1;
    });
    activeLock = null;
    removeSignalHandlers();
  }
}

async function runE2ePipeline(playwrightArgs) {
  const stages = [
    ["build", () => runNpmScript("build")],
    ["test-vault sync", () => runNpmScript("sync:test-vault")],
    ["e2e preflight", () => runNpmScript("e2e:preflight")],
    ["Playwright", () => runPlaywright(playwrightArgs)],
  ];

  for (const [label, run] of stages) {
    throwIfInterrupted();
    const exitCode = await run();
    throwIfInterrupted();
    if (exitCode !== 0) {
      console.error(`${label} exited with code ${exitCode}.`);
      return exitCode;
    }
  }
  return 0;
}

function runNpmScript(scriptName) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, "run", scriptName]);
  }
  // On Windows, spawning npm.cmd without a shell yields EINVAL.
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/s",
      "/c",
      "npm",
      "run",
      scriptName,
    ]);
  }
  return runCommand("npm", ["run", scriptName]);
}

function runPlaywright(playwrightArgs) {
  const playwrightCli = path.join(
    repoRoot,
    "node_modules",
    "@playwright",
    "test",
    "cli.js",
  );
  // CLI reporter selection replaces the config reporter list. Keep both the
  // JSON execution proof and the scorecard summary reporter explicit here.
  return runCommand(process.execPath, [
    playwrightCli,
    "test",
    `--reporter=json,./e2e/reporters/dailyUseReporter.ts`,
    ...playwrightArgs,
  ], { PLAYWRIGHT_JSON_OUTPUT_NAME: PLAYWRIGHT_EXECUTION_REPORT_PATH });
}

/**
 * Fail a run in which a requested project executed no non-skipped test.
 *
 * A lane guard that cannot match makes its spec skip itself, and Playwright
 * still exits 0 — which is exactly how `test:e2e:journeys` reported success
 * while silently skipping half the lanes it selected. Reading the JSON report
 * turns every such guard mistake, in any lane, into a red run.
 */
export function assertProjectsExecuted(report, selectedProjects) {
  const projects = [...new Set(selectedProjects ?? [])].filter(Boolean);
  if (projects.length === 0) return { checked: 0, executed: {} };
  const executed = Object.fromEntries(projects.map((project) => [project, 0]));
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const project = String(test.projectName ?? "");
        if (!(project in executed)) continue;
        const ran = (test.results ?? []).some(
          (result) => result?.status && result.status !== "skipped",
        );
        if (ran) executed[project] += 1;
      }
    }
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of report?.suites ?? []) visit(suite);

  const empty = projects.filter((project) => executed[project] === 0);
  if (empty.length > 0) {
    throw new Error(
      `Playwright exited 0 but these selected projects executed no test: ${empty.join(", ")}. ` +
        "A skipped lane is not a pass — check the spec's E2E_PLAYWRIGHT_LANE guard.",
    );
  }
  return { checked: projects.length, executed };
}

async function assertSelectedProjectsExecuted(projects) {
  let raw;
  try {
    raw = await readFile(PLAYWRIGHT_EXECUTION_REPORT_PATH, "utf8");
  } catch (error) {
    throw new Error(
      `Playwright exited 0 but wrote no execution report at ${PLAYWRIGHT_EXECUTION_REPORT_PATH}: ${
        error?.message ?? error
      }`,
    );
  }
  const summary = assertProjectsExecuted(JSON.parse(raw), projects);
  console.log(
    `E2E execution proof: ${Object.entries(summary.executed)
      .map(([project, count]) => `${project}=${count}`)
      .join(" ")}`,
  );
}

function runCommand(command, args, envOverrides) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: envOverrides ? { ...process.env, ...envOverrides } : process.env,
      stdio: "inherit",
      windowsHide: true,
    });
    activeChild = child;
    child.once("error", (error) => {
      if (activeChild === child) {
        activeChild = null;
      }
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (activeChild === child) {
        activeChild = null;
      }
      if (signal && !interruptedSignal) {
        console.error(`Child process stopped by ${signal}.`);
      }
      resolve(code ?? 1);
    });
  });
}

async function recoverStaleLock(lockPath, owner, logger) {
  const metadata = owner?.metadata;
  if (
    !owner ||
    !metadata ||
    metadata.hostname !== os.hostname() ||
    !Number.isSafeInteger(metadata.pid) ||
    metadata.pid <= 0 ||
    isProcessAlive(metadata.pid)
  ) {
    return false;
  }

  const confirmation = await readLockOwner(lockPath);
  if (!confirmation || confirmation.raw !== owner.raw) {
    return false;
  }

  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
  logger.warn(
    `Recovered stale Obsidian e2e lock from dead PID ${metadata.pid}: ${lockPath}`,
  );
  return true;
}

async function removeLockIfOwned(lockPath, token) {
  const owner = await readLockOwner(lockPath);
  if (!owner || owner.metadata?.token !== token) {
    return false;
  }
  await unlink(lockPath).catch((error) => {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  });
  return true;
}

function installSignalHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.on(signal, signalHandlers[signal]);
  }
}

function removeSignalHandlers() {
  for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
    process.off(signal, signalHandlers[signal]);
  }
}

const signalHandlers = Object.fromEntries(
  Object.keys(SIGNAL_EXIT_CODES).map((signal) => [
    signal,
    () => {
      if (interruptedSignal) {
        return;
      }
      interruptedSignal = signal;
      terminateActiveChild(signal);
      forcedExitTimer = setTimeout(() => {
        void Promise.resolve(activeLock?.release()).finally(() => {
          process.exit(SIGNAL_EXIT_CODES[signal] ?? 1);
        });
      }, 5_000);
    },
  ]),
);

function terminateActiveChild(signal) {
  const child = activeChild;
  if (!child || child.exitCode !== null || !child.pid) {
    return;
  }

  if (process.platform === "win32") {
    const killer = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => terminateChildDirectly(child));
    killer.once("close", (code) => {
      if (code !== 0 && child.exitCode === null) {
        terminateChildDirectly(child);
      }
    });
    return;
  }
  terminateChildDirectly(child, signal);
}

function terminateChildDirectly(child, signal = "SIGTERM") {
  try {
    child.kill(signal);
  } catch {
    // The owned child may have exited between the liveness check and kill.
  }
}

function throwIfInterrupted() {
  if (interruptedSignal) {
    throw new Error(`Interrupted by ${interruptedSignal}.`);
  }
}

function describeOwner(owner) {
  const metadata = owner?.metadata;
  if (!owner) {
    return "The lock owner changed while it was inspected.";
  }
  if (!metadata) {
    return "The lock metadata is unreadable, so owner liveness cannot be proven.";
  }
  return `Owner PID ${metadata.pid ?? "unknown"} on ${metadata.hostname ?? "unknown host"}, started ${metadata.startedAt ?? "at an unknown time"}.`;
}

function parseCdpPort(env) {
  return parseBoundedInteger(
    env.OBSIDIAN_CDP_PORT ?? 11223,
    "OBSIDIAN_CDP_PORT",
    1,
    65_535,
  );
}

function parseBoundedInteger(value, label, min, max) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}.`);
  }
  return parsed;
}

function normalizePlaywrightArgs(args) {
  return args[0] === "--" ? args.slice(1) : args;
}

export function normalizeExclusiveArgs(rawArgs) {
  const args = normalizePlaywrightArgs(rawArgs);
  let aiMode = null;
  let liveExternal = false;
  const playwrightArgs = [];
  for (const arg of args) {
    if (arg === "--real-ai") {
      aiMode = "real";
      continue;
    }
    if (arg === "--mock-ai") {
      aiMode = "mock";
      continue;
    }
    if (arg === "--live-external") {
      liveExternal = true;
      continue;
    }
    playwrightArgs.push(arg);
  }
  let projects = readRequestedProjects(playwrightArgs);
  if (projects.length === 0) {
    playwrightArgs.push(`--project=${DEFAULT_PLAYWRIGHT_PROJECT}`);
    projects = [DEFAULT_PLAYWRIGHT_PROJECT];
  }
  for (const project of projects) {
    if (!PLAYWRIGHT_PROJECTS.has(project)) {
      throw new Error(
        `Unknown E2E project ${project}. Allowed projects: ${[...PLAYWRIGHT_PROJECTS].join(", ")}.`,
      );
    }
  }
  // Journey lanes that call a real model through startRealAiHarness. The
  // remaining lanes make no model calls at all and instead drive production
  // tools against real external services with real credentials.
  const realAiProjects = new Set([
    "real-ai-contract",
    "real-ai-soak",
    "provider-canary",
    "release-vertical",
    "daily-use-research",
    "daily-use-code-live",
    "desktop-code-delivery-real-live",
    "desktop-checkers-delivery-real-live",
    "demo-recording",
    "demo-journey-recording",
    "retained-journey",
    "byok-autonomous-journey",
    "daily-use-compound",
    "obsidian-hello-github-live",
    "compound-flow-real-live",
  ]);
  if (aiMode === "real" && projects.some((project) => !realAiProjects.has(project))) {
    throw new Error("--real-ai is restricted to attested live-provider Playwright projects.");
  }
  if (aiMode === "mock") {
    throw new Error(
      "--mock-ai was removed. Every Playwright lane now calls a real model, a real external service, or both.",
    );
  }
  if (
    liveExternal &&
    (projects.length !== 1 || projects[0] !== "disposable-live-external")
  ) {
    throw new Error(
      "--live-external is restricted to the disposable-live-external Playwright project.",
    );
  }
  if (liveExternal && aiMode === "real") {
    throw new Error("The disposable live external provider lane cannot also enable real-AI model calls.");
  }
  return { playwrightArgs, aiMode, liveExternal, projects };
}

/**
 * Apply AI mode for the Playwright child. Explicit CLI flags win; otherwise
 * leave any caller-provided E2E_AI_* env vars alone. Default package scripts
 * pass --real-ai (glm-5.2) or --mock-ai for deterministic runs.
 */
export function applyE2eAiMode(aiMode, env = process.env) {
  if (aiMode === "real") {
    env.E2E_AI_MODE = "real";
    env.E2E_REAL_AI = "1";
    if (!env.E2E_AI_MODEL?.trim()) {
      env.E2E_AI_MODEL = "glm-5.2";
    }
    return;
  }
  if (aiMode === "mock") {
    env.E2E_AI_MODE = "mock";
    env.E2E_REAL_AI = "0";
  }
}

/**
 * Keep the real-provider wrapper, preflight, and Playwright worker on one
 * explicit provider/model selection. The provider canary is intentionally
 * authoritative: its required model must also be the model named by preflight
 * and run diagnostics.
 */
export function applyE2eProviderDefaults(
  { aiMode, projects },
  env = process.env,
) {
  if (aiMode !== "real") return;

  if (!env.E2E_MODEL_PROVIDER?.trim()) {
    env.E2E_MODEL_PROVIDER = "ollama";
  }

  if (projects.includes("provider-canary")) {
    const canaryModel = env.E2E_CANARY_MODEL?.trim();
    if (canaryModel) {
      env.E2E_AI_MODEL = canaryModel;
    }
  }
}

export function applyE2eLane(
  { liveExternal, projects },
  env = process.env,
) {
  env.E2E_PLAYWRIGHT_LANE = projects.join(",");
  env.E2E_LIVE_EXTERNAL = liveExternal ? "1" : "0";
}

/**
 * Fail fast — before the lock, build, vault sync, or Obsidian boot — when an
 * external-credential lane is requested without its credential or on an
 * unsupported platform. These lanes must also run alone: their specs
 * self-skip unless E2E_PLAYWRIGHT_LANE equals the single project name.
 */
export function assertExternalCredentialProjectPreconditions(
  { projects },
  env = process.env,
  platform = process.platform,
) {
  for (const project of projects) {
    const requirements = EXTERNAL_CREDENTIAL_PROJECTS[project];
    if (!requirements) continue;
    if (projects.length !== 1) {
      throw new Error(
        `${project} must run as the only selected project so its lane gate matches.`,
      );
    }
    if (!requirements.platforms.includes(platform)) {
      throw new Error(
        `${project} supports only ${requirements.platforms.join(", ")}; current platform is ${platform}.`,
      );
    }
    for (const name of requirements.requiredEnv) {
      if (!env[name]?.trim()) {
        throw new Error(
          `${project} requires ${name} to be set (an explicit disposable scope) before the run starts.`,
        );
      }
    }
  }
}

/**
 * The WSL2 setup script can persist its non-secret runtime declaration at
 * Windows user scope, but an already-open terminal cannot inherit that update.
 * Import only this fixed allowlist, only for sandbox lanes, and never replace
 * an explicit process value. The normal boundary parser remains authoritative.
 */
export function applyPersistedWindowsSandboxEnvironment(
  { projects },
  env = process.env,
  options = {},
) {
  const platform = options.platform ?? process.platform;
  if (
    platform !== "win32" ||
    !projects.some((project) => SANDBOX_E2E_PROJECTS.has(project))
  ) {
    return [];
  }
  const readUserValue =
    options.readUserValue ?? readWindowsUserEnvironmentVariable;
  const imported = [];
  for (const name of WINDOWS_USER_SANDBOX_ENV_NAMES) {
    if (env[name]?.trim()) continue;
    const value = readUserValue(name);
    if (!isSafePersistedEnvironmentValue(value)) continue;
    env[name] = value.trim();
    imported.push(name);
  }
  return imported;
}

function readWindowsUserEnvironmentVariable(name) {
  const result = spawnSync(
    "reg.exe",
    ["query", "HKCU\\Environment", "/v", name],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5_000,
    },
  );
  if (result.status !== 0 || typeof result.stdout !== "string") return null;
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(
    `^\\s*${escapedName}\\s+REG_(?:SZ|EXPAND_SZ)\\s+(.+?)\\s*$`,
    "mu",
  ).exec(result.stdout);
  return match?.[1] ?? null;
}

function isSafePersistedEnvironmentValue(value) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= 512 &&
    !/[\0\r\n]/u.test(value)
  );
}

function readRequestedProjects(args) {
  const projects = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--project") {
      const project = args[index + 1];
      if (!project || project.startsWith("-")) {
        throw new Error("--project requires a Playwright project name.");
      }
      projects.push(project);
      index += 1;
      continue;
    }
    if (argument.startsWith("--project=")) {
      const project = argument.slice("--project=".length).trim();
      if (!project) throw new Error("--project requires a Playwright project name.");
      projects.push(project);
    }
  }
  return [...new Set(projects)];
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
