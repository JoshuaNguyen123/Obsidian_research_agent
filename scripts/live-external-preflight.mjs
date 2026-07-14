import path from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = new Set(["linear", "github_draft", "github_merge"]);
const SAFE_TARGET = /(?:disposable|e2e|sandbox|test)/iu;
const PRODUCTION_NAME = /(?:^|[-_.\/])(prod|production)(?:$|[-_.\/])/iu;

export function validateLiveExternalPreflight(provider, env = process.env) {
  if (!PROVIDERS.has(provider)) {
    throw new Error("Live external provider must be linear, github_draft, or github_merge.");
  }
  requireExact(
    env.LIVE_EXTERNAL_DISPOSABLE_CONFIRMATION,
    "DISPOSABLE_ONLY",
    "Disposable-target confirmation is missing.",
  );
  assertDisposableName(
    bounded(env.LIVE_EXTERNAL_TARGET_LABEL, "target label", 200),
    "Live external target label",
  );
  assertDisposableName(
    bounded(env.OBSIDIAN_VAULT, "Obsidian test vault", 2_048),
    "Obsidian test vault",
  );
  requireExact(
    env.AGENTIC_LIVE_EXTERNAL_CLEANUP_REQUIRED,
    "true",
    "Live external scenarios must opt into mandatory fixture cleanup.",
  );

  const githubRepository = bounded(
    env.E2E_LIVE_GITHUB_REPOSITORY,
    "GitHub repository",
    201,
  );
  if (!/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u.test(githubRepository)) {
    throw new Error("Disposable GitHub repository must use owner/repository form.");
  }
  assertDisposableName(githubRepository, "GitHub repository");
  assertDisposableName(
    bounded(env.E2E_LIVE_LINEAR_PROJECT, "Linear project label", 200),
    "Linear project label",
  );

  if (provider === "linear") {
    requireSecret(env, "LINEAR_LIVE_TEST_TOKEN");
    bounded(env.LINEAR_LIVE_TEST_TEAM_ID, "Linear team id", 200);
    bounded(env.LINEAR_LIVE_TEST_PROJECT_ID, "Linear project id", 200);
  } else {
    requireSecret(env, "GITHUB_LIVE_TEST_TOKEN");
  }

  const mergeAuthorized = provider === "github_merge";
  requireExact(
    env.E2E_LIVE_ALLOW_MERGE ?? "0",
    mergeAuthorized ? "1" : "0",
    mergeAuthorized
      ? "Live merge authority must be exported only after its separate confirmation."
      : "Non-merge live lanes cannot export merge authority.",
  );
  if (mergeAuthorized) {
    requireExact(
      env.LIVE_EXTERNAL_MERGE_CONFIRMATION,
      "MERGE_DISPOSABLE_PR",
      "Live merge requires its separate exact confirmation.",
    );
  } else if (env.LIVE_EXTERNAL_MERGE_CONFIRMATION) {
    throw new Error("Merge confirmation must not be supplied to a non-merge safety run.");
  }

  return Object.freeze({ provider, mergeAuthorized });
}

function main() {
  const result = validateLiveExternalPreflight(argumentValue("--provider"));
  console.log(
    `Live external disposable preflight passed for ${result.provider}; merge_authorized=${result.mergeAuthorized ? "yes" : "no"}. The guarded provider smoke may now mutate only the announced disposable target and must clean up its fixtures.`,
  );
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}.`);
  return process.argv[index + 1];
}

function requireSecret(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.length < 20 || value.length > 8_192) {
    throw new Error(`${name} is missing or outside its bounded secret length.`);
  }
}

function requireExact(value, expected, message) {
  if (value !== expected) throw new Error(message);
}

function assertDisposableName(value, label) {
  if (!SAFE_TARGET.test(value) || PRODUCTION_NAME.test(value)) {
    throw new Error(
      `${label} must contain disposable, e2e, sandbox, or test and must not identify production.`,
    );
  }
}

function bounded(value, label, maximum) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error(`${label} is missing or invalid.`);
  }
  return value;
}

const directScript = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
if (directScript) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
