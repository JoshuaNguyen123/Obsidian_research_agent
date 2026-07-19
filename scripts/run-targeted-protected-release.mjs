import { spawn } from "node:child_process";
import { copyFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { acquireE2eLock } from "./run-e2e-exclusive.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const playwrightCli = path.join(
  repoRoot,
  "node_modules",
  "@playwright",
  "test",
  "cli.js",
);
const proofRoot = path.join(repoRoot, "test-results", "protected-targeted");
const summaryPath = path.join(repoRoot, "test-results", "daily-use-run-summary.json");

const laneDefinitions = Object.freeze({
  deterministic: {
    aiMode: "mock",
    projects: [
      "daily-use-connections",
      "daily-use-note",
      "daily-use-memory-reflex",
      "daily-use-code",
      "daily-use-linear",
      "daily-use-github",
    ],
    files: [
      "e2e/daily-use-connections.spec.ts",
      "e2e/daily-use-note.spec.ts",
      "e2e/daily-use-memory-reflex.spec.ts",
      "e2e/daily-use-code.spec.ts",
      "e2e/daily-use-linear.spec.ts",
      "e2e/daily-use-github.spec.ts",
    ],
  },
  research: {
    aiMode: "real",
    projects: ["daily-use-research"],
    files: ["e2e/daily-use-research.spec.ts"],
    grep:
      "(?:DU-02 proof-gated sourced writeback|bounded recovery changes action after a retryable owned-source failure)",
  },
  code: {
    aiMode: "real",
    projects: ["daily-use-code-live"],
    files: ["e2e/daily-use-code.spec.ts"],
    grep:
      "DU-03 protected real-model TypeScript project creation, validation, README, commit, and readback",
  },
  compound: {
    aiMode: "real",
    projects: ["daily-use-compound"],
    files: ["e2e/daily-use-compound.spec.ts"],
    grep:
      "DU-06 checkers exact-SHA lifecycle restarts, cleans disposable providers, and retains redacted Linear proof",
  },
});

const externalCredentialNames = Object.freeze([
  "E2E_LINEAR_API_KEY",
  "E2E_GITHUB_TOKEN",
  "LINEAR_LIVE_TEST_TOKEN",
  "GITHUB_LIVE_TEST_TOKEN",
]);
const modelCredentialNames = Object.freeze([
  "E2E_OLLAMA_API_KEY",
  "E2E_OPENAI_COMPATIBLE_API_KEY",
]);
const sandboxConfigurationNames = Object.freeze([
  "AGENTIC_SANDBOX_CI_LIVE",
  "AGENTIC_SANDBOX_CI_EXECUTABLE",
  "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
  "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
  "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
  "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
]);

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await verifyExactCleanSha(options.sha);
  await mkdir(proofRoot, { recursive: true });

  let lock = null;
  try {
    lock = await acquireE2eLock({
      playwrightArgs: options.lanes.flatMap((lane) =>
        buildPlaywrightArgs(laneDefinitions[lane]),
      ),
    });
    console.log(`Acquired one exclusive Obsidian lock for targeted protected proof: ${lock.lockPath}`);

    const credentialFreeEnvironment = buildCredentialFreeEnvironment();
    await runNpmScript("build", credentialFreeEnvironment);
    await runNpmScript("sync:test-vault", credentialFreeEnvironment);
    await runNpmScript("e2e:preflight", credentialFreeEnvironment);
    await verifyExactCleanSha(options.sha);

    for (const lane of options.lanes) {
      await verifyExactCleanSha(options.sha);
      const definition = laneDefinitions[lane];
      console.log(`Running exact protected lane: ${lane}`);
      await runCommand(
        process.execPath,
        [playwrightCli, "test", ...buildPlaywrightArgs(definition)],
        buildLaneEnvironment(lane, definition, options.sha),
      );
      await preserveSummary(lane);
      await verifyExactCleanSha(options.sha);
    }
  } finally {
    await lock?.release();
  }
}

function parseArgs(args) {
  let sha = "";
  let requestedLanes = "deterministic,research,code,compound";
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--sha") {
      sha = args[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--sha=")) {
      sha = argument.slice("--sha=".length);
      continue;
    }
    if (argument === "--lanes") {
      requestedLanes = args[++index] ?? "";
      continue;
    }
    if (argument.startsWith("--lanes=")) {
      requestedLanes = argument.slice("--lanes=".length);
      continue;
    }
    throw new Error(`Unknown protected-runner argument: ${argument}`);
  }
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error("--sha must be one full lowercase Git commit SHA.");
  }
  const lanes = [...new Set(requestedLanes.split(",").map((value) => value.trim()).filter(Boolean))];
  if (lanes.length === 0) throw new Error("--lanes must select at least one targeted lane.");
  for (const lane of lanes) {
    if (!(lane in laneDefinitions)) {
      throw new Error(
        `Unsupported lane ${lane}. Choose only: ${Object.keys(laneDefinitions).join(", ")}.`,
      );
    }
  }
  return { sha, lanes };
}

function buildPlaywrightArgs(definition) {
  return [
    ...definition.projects.map((project) => `--project=${project}`),
    ...(definition.grep ? [`--grep=${definition.grep}`] : []),
    ...definition.files,
  ];
}

function buildLaneEnvironment(lane, definition, sha) {
  const env = {
    ...process.env,
    E2E_AI_MODE: definition.aiMode,
    E2E_REAL_AI: definition.aiMode === "real" ? "1" : "0",
    E2E_PLAYWRIGHT_LANE: definition.projects.join(","),
    E2E_RELEASE_COMMIT_SHA: sha,
  };
  if (lane === "deterministic") {
    removeEnvironmentVariables(env, [
      ...externalCredentialNames,
      ...modelCredentialNames,
      ...sandboxConfigurationNames,
    ]);
  } else if (lane === "research") {
    removeEnvironmentVariables(env, [
      ...externalCredentialNames,
      ...sandboxConfigurationNames,
    ]);
  } else if (lane === "code") {
    removeEnvironmentVariables(env, externalCredentialNames);
  }
  return env;
}

function buildCredentialFreeEnvironment() {
  const env = { ...process.env };
  removeEnvironmentVariables(env, [
    ...externalCredentialNames,
    ...modelCredentialNames,
  ]);
  return env;
}

function removeEnvironmentVariables(env, names) {
  for (const name of names) delete env[name];
}

async function verifyExactCleanSha(expectedSha) {
  const actualSha = (await capture("git", ["rev-parse", "HEAD"])).trim().toLowerCase();
  if (actualSha !== expectedSha) {
    throw new Error(`Checked out ${actualSha} instead of requested SHA ${expectedSha}.`);
  }
  const status = (await capture("git", ["status", "--porcelain"])).trim();
  if (status) {
    throw new Error("Protected exact-SHA proof requires a clean checkout.");
  }
}

async function preserveSummary(lane) {
  try {
    const current = await stat(summaryPath);
    if (!current.isFile() || current.size === 0) return;
    await copyFile(summaryPath, path.join(proofRoot, `${lane}.json`));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function runNpmScript(scriptName, env) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) {
    return runCommand(process.execPath, [npmExecPath, "run", scriptName], env);
  }
  if (process.platform === "win32") {
    return runCommand(process.env.ComSpec || "cmd.exe", [
      "/d",
      "/s",
      "/c",
      "npm",
      "run",
      scriptName,
    ], env);
  }
  return runCommand("npm", ["run", scriptName], env);
}

function runCommand(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} was interrupted by ${signal}.`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}.`));
        return;
      }
      resolve();
    });
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}: ${stderr.trim()}`));
        return;
      }
      resolve(stdout);
    });
  });
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
