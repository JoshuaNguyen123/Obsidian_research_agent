#!/usr/bin/env node
/**
 * Operator cleanup for known disposable e2e GitHub repositories listed in
 * docs/plans/current-agentic-gaps.md / e2e/fixtures/externalCleanup.ts.
 *
 * Safe by default (dry-run). Requires authenticated `gh` with delete_repo
 * (or a PAT that can delete the repositories) before --execute will delete.
 *
 * Usage:
 *   node scripts/cleanup-e2e-github-residue.mjs
 *   node scripts/cleanup-e2e-github-residue.mjs --execute
 *   node scripts/cleanup-e2e-github-residue.mjs --owner=LOGIN --execute
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES = Object.freeze([
  "e2e-number-guess-5791ec950ef7",
  "e2e-compound-smoke-6025ad99b010",
  "e2e-compound-smoke-0ef7b19fcda1",
  "e2e-flow-real-f17e0747ef9d",
  "e2e-flow-real-88f06a57bd68",
  "e2e-compound-smoke-1621b6c837e7",
  "e2e-compound-smoke-59c14013e558",
]);

function parseArgs(argv) {
  let execute = false;
  let owner = "";
  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg.startsWith("--owner=")) {
      owner = arg.slice("--owner=".length).trim();
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { execute, owner };
}

function printHelp() {
  console.log(`cleanup-e2e-github-residue.mjs

Dry-run (default): list which of the seven known residue repos exist.
--execute: delete present repos after proving gh delete_repo authority.
--owner=LOGIN: override owner (defaults to gh api user login).
`);
}

async function ghJson(args) {
  const { stdout } = await execFileAsync("gh", args, {
    windowsHide: true,
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return JSON.parse(String(stdout || "null"));
}

async function ghText(args) {
  const { stdout, stderr } = await execFileAsync("gh", args, {
    windowsHide: true,
    timeout: 90_000,
  });
  return `${String(stdout)}\n${String(stderr)}`;
}

async function assertDeleteRepoAuthority() {
  const status = await ghText(["auth", "status", "-h", "github.com"]);
  if (!/(?:^|[\s,'"])delete_repo(?:$|[\s,'"])/mu.test(status)) {
    throw new Error(
      "Refusing deletion: active gh token lacks delete_repo. Run: gh auth refresh -h github.com -s delete_repo",
    );
  }
}

async function repositoryState(owner, repository) {
  try {
    await ghJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${owner}/${repository}`,
    ]);
    return "present";
  } catch (error) {
    const message = String(error?.stderr || error?.message || error);
    if (/\b404\b|Not Found/u.test(message)) return "absent";
    throw error;
  }
}

async function deleteRepository(owner, repository) {
  await ghText(["repo", "delete", `${owner}/${repository}`, "--yes"]);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if ((await repositoryState(owner, repository)) === "absent") return;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`${owner}/${repository} survived deletion`);
}

async function main() {
  const { execute, owner: ownerArg } = parseArgs(process.argv.slice(2));
  let owner = ownerArg;
  if (!owner) {
    const user = await ghJson(["api", "user"]);
    owner = String(user?.login || "").trim();
  }
  if (!owner) {
    throw new Error("Could not resolve GitHub owner login. Pass --owner=LOGIN.");
  }

  console.log(`Owner: ${owner}`);
  console.log(`Mode: ${execute ? "EXECUTE" : "dry-run"}`);
  console.log(`Scanning ${KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES.length} known residue names…`);

  const present = [];
  const absent = [];
  for (const repository of KNOWN_E2E_GITHUB_RESIDUE_REPOSITORY_NAMES) {
    const state = await repositoryState(owner, repository);
    if (state === "present") present.push(repository);
    else absent.push(repository);
    console.log(`  ${state.padEnd(7)} ${owner}/${repository}`);
  }

  if (!execute) {
    console.log(
      `\nDry-run complete. ${present.length} present, ${absent.length} absent.`,
    );
    console.log("Re-run with --execute to delete present repositories.");
    return;
  }

  if (present.length === 0) {
    console.log("\nNothing to delete.");
    return;
  }

  await assertDeleteRepoAuthority();
  const failures = [];
  for (const repository of present) {
    try {
      console.log(`Deleting ${owner}/${repository}…`);
      await deleteRepository(owner, repository);
      console.log(`  absent  ${owner}/${repository}`);
    } catch (error) {
      failures.push(`${repository}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Residue cleanup failures:\n${failures.join("\n")}`);
  }
  console.log(`\nDeleted ${present.length} residue repositor${present.length === 1 ? "y" : "ies"}.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
