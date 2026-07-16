import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @ts-ignore The production runner is an intentionally unbundled Node ESM script.
import { applyE2eAiMode, applyE2eLane, normalizeExclusiveArgs } from "../scripts/run-e2e-exclusive.mjs";
// @ts-ignore The production preflight is an intentionally unbundled Node ESM script.
import { validateLiveExternalPreflight } from "../scripts/live-external-preflight.mjs";

test("Phase 6 Linear scenarios are owned by the dedicated file-routed spec", () => {
  const phase6 = readFileSync(
    new URL("../e2e/phase6-linear.spec.ts", import.meta.url),
    "utf8",
  );
  const monolith = readFileSync(
    new URL("../e2e/obsidian-agent.spec.ts", import.meta.url),
    "utf8",
  );
  for (const title of [
    "ordinary Linear-looking text does not expose or execute Linear tools",
    "accepted research is note-backed before exact Linear approval and persists verified lineage",
    "rereads claims executes vault work and reconciles completion without replay",
  ]) {
    assert.equal(phase6.includes(title), true, `missing Phase 6 title: ${title}`);
    assert.equal(monolith.includes(title), false, `duplicate monolith title: ${title}`);
  }
});

test("exclusive E2E runner defaults to deterministic core mock routing", () => {
  const normalized = normalizeExclusiveArgs(["--mock-ai"]);
  assert.deepEqual(normalized, {
    playwrightArgs: ["--project=deterministic-core-mock"],
    aiMode: "mock",
    liveExternal: false,
    projects: ["deterministic-core-mock"],
  });
});

test("exclusive E2E runner permits the bounded deterministic matrix", () => {
  const normalized = normalizeExclusiveArgs([
    "--mock-ai",
    "--project=deterministic-core-mock",
    "--project",
    "integration-mock",
    "--project=integration-mock-legacy",
    "--project=sandbox",
    "--project=companion-restart",
  ]);
  assert.deepEqual(normalized.projects, [
    "deterministic-core-mock",
    "integration-mock",
    "integration-mock-legacy",
    "sandbox",
    "companion-restart",
  ]);
  assert.equal(normalized.aiMode, "mock");
});

test("Windows installed matrix explicitly trusts only its created disposable vault", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /\$vault = Join-Path \$env:RUNNER_TEMP "agentic-researcher-e2e-vault"/u,
  );
  assert.match(
    workflow,
    /- name: Deterministic Obsidian Playwright matrix\s+env:\s+(?:#[^\r\n]*\s+)*E2E_TRUST_DISPOSABLE_VAULT: "1"\s+run: npm run test:e2e:deterministic-matrix/u,
  );
  assert.match(workflow, /runs-on: windows-2022/u);
  assert.match(workflow, /Obsidian-\$version\.exe/u);
  assert.match(
    workflow,
    /f35d2a35061098400a3fafc1bfd38d8bd33f1ad76df8b78b62ccdf20b0a30d26/u,
  );
  assert.match(workflow, /\$machine -ne 0x8664/u);
  assert.match(workflow, /if \(\$null -ne \$reader\)/u);
  assert.doesNotMatch(workflow, /\$reader\?\.Dispose\(\)/u);
  assert.match(workflow, /Get-AuthenticodeSignature/u);
  assert.doesNotMatch(workflow, /choco install obsidian/u);
});

test("live Windows workflows publish runner-temp vault paths from a step", () => {
  for (const [file, vaultName] of [
    ["live-model.yml", "agentic-researcher-live-vault"],
    [
      "protected-release-vertical.yml",
      "agentic-researcher-disposable-release-vault",
    ],
  ] as const) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(
      workflow,
      /OBSIDIAN_VAULT:\s*\$\{\{\s*runner\.temp\s*\}\}/u,
      `${file} must not use the unavailable runner context in job-level env`,
    );
    assert.match(
      workflow,
      new RegExp(
        `\\$vault = Join-Path \\$env:RUNNER_TEMP "${vaultName}"`,
        "u",
      ),
    );
    assert.match(
      workflow,
      /"OBSIDIAN_VAULT=\$vault" \| Out-File -FilePath \$env:GITHUB_ENV/u,
    );
  }
});

test("real AI and live external flags cannot widen into other projects", () => {
  assert.throws(
    () => normalizeExclusiveArgs(["--real-ai", "--project=deterministic-core-mock"]),
    /restricted to attested live-provider/u,
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--live-external", "--project=integration-mock"]),
    /restricted to the disposable-live-external/u,
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--project=unknown-lane"]),
    /Unknown E2E project/u,
  );
});

test("live external routing is single-project and explicitly exported", () => {
  const normalized = normalizeExclusiveArgs([
    "--live-external",
    "--project=disposable-live-external",
  ]);
  assert.equal(normalized.liveExternal, true);
  assert.deepEqual(normalized.projects, ["disposable-live-external"]);
  const env: NodeJS.ProcessEnv = {};
  applyE2eLane(normalized, env);
  assert.deepEqual(env, {
    E2E_PLAYWRIGHT_LANE: "disposable-live-external",
    E2E_LIVE_EXTERNAL: "1",
  });
});

test("configured Linear live routing is explicit and keeps secrets inside Obsidian", () => {
  const normalized = normalizeExclusiveArgs([
    "--mock-ai",
    "--project=configured-linear-live",
  ]);
  assert.equal(normalized.liveExternal, false);
  assert.deepEqual(normalized.projects, ["configured-linear-live"]);
  const env: NodeJS.ProcessEnv = {};
  applyE2eLane(normalized, env);
  assert.deepEqual(env, {
    E2E_PLAYWRIGHT_LANE: "configured-linear-live",
    E2E_LIVE_EXTERNAL: "0",
  });

  const source = readFileSync(
    new URL("../e2e/configured-linear-live.spec.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /preserveConfiguredLinearCredential: true/u);
  assert.match(source, /getLinearCredentialStatus/u);
  assert.doesNotMatch(source, /LINEAR_LIVE_TEST_TOKEN/u);
  assert.doesNotMatch(source, /linearApiKey/u);
  const preflight = readFileSync(
    new URL("../scripts/e2e-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.match(preflight, /"configured-linear-live": \[\]/u);
});

test("runner mode exports explicit child-process environment without secrets", () => {
  const env: NodeJS.ProcessEnv = {};
  applyE2eAiMode("real", env);
  applyE2eLane({ liveExternal: false, projects: ["real-ai-contract"] }, env);
  assert.deepEqual(env, {
    E2E_AI_MODE: "real",
    E2E_REAL_AI: "1",
    E2E_AI_MODEL: "gpt-oss:120b-cloud",
    E2E_PLAYWRIGHT_LANE: "real-ai-contract",
    E2E_LIVE_EXTERNAL: "0",
  });
});

test("standard E2E command is the live contract and live projects disable reruns", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts["test:e2e"], /--real-ai --project=real-ai-contract/u);
  assert.match(packageJson.scripts["test:e2e:mock"], /deterministic-core-mock/u);
  assert.match(packageJson.scripts["test:e2e:daily-use"], /daily-use-mock/u);
  assert.equal(
    packageJson.scripts["test:e2e:daily-use:mock"],
    "npm run test:e2e:daily-use",
  );
  assert.match(packageJson.scripts["test:e2e:daily-use:live-model"], /DU-02/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:code"], /DU-03/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:linear"], /DU-04/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:github"], /DU-05/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:compound"], /DU-06/u);
  assert.match(
    packageJson.scripts["test:e2e:configured-linear"],
    /--project=configured-linear-live/u,
  );
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  for (const project of ["real-ai-contract", "real-ai-soak", "provider-canary", "release-vertical"]) {
    assert.match(
      config,
      new RegExp(`name: "${project}"[\\s\\S]{0,160}retries: 0`, "u"),
    );
  }
});

test("live external preflight validates authority without returning credentials", () => {
  const linear = validateLiveExternalPreflight("linear", liveEnvironment());
  assert.deepEqual(linear, {
    provider: "linear",
    mergeAuthorized: false,
  });
  const draft = validateLiveExternalPreflight("github_draft", liveEnvironment());
  assert.deepEqual(draft, {
    provider: "github_draft",
    mergeAuthorized: false,
  });

  assert.throws(
    () => validateLiveExternalPreflight("github_merge", {
      ...liveEnvironment(),
      E2E_LIVE_ALLOW_MERGE: "1",
    }),
    /separate exact confirmation/u,
  );
  const merge = validateLiveExternalPreflight("github_merge", {
    ...liveEnvironment(),
    E2E_LIVE_ALLOW_MERGE: "1",
    LIVE_EXTERNAL_MERGE_CONFIRMATION: "MERGE_DISPOSABLE_PR",
  });
  assert.deepEqual(merge, {
    provider: "github_merge",
    mergeAuthorized: true,
  });
  assert.equal(JSON.stringify(merge).includes("fixture-token"), false);
});

test("live external secret leases stay within the production boundary", () => {
  const source = readFileSync(
    new URL("../e2e/disposable-live-external.spec.ts", import.meta.url),
    "utf8",
  );
  const requestedTtls = Array.from(
    source.matchAll(/ttlSeconds:\s*(\d+)/gu),
    (match) => Number.parseInt(match[1] ?? "0", 10),
  );
  assert.equal(requestedTtls.length > 0, true);
  assert.equal(
    requestedTtls.every((ttlSeconds) => ttlSeconds >= 1 && ttlSeconds <= 300),
    true,
  );
});

function liveEnvironment(): NodeJS.ProcessEnv {
  return {
    LIVE_EXTERNAL_DISPOSABLE_CONFIRMATION: "DISPOSABLE_ONLY",
    LIVE_EXTERNAL_TARGET_LABEL: "agentic-disposable-e2e",
    AGENTIC_LIVE_EXTERNAL_CLEANUP_REQUIRED: "true",
    OBSIDIAN_VAULT: "C:/e2e/agentic-disposable-vault",
    E2E_LIVE_GITHUB_REPOSITORY: "example/agentic-disposable-e2e",
    E2E_LIVE_LINEAR_PROJECT: "agentic-disposable-e2e",
    E2E_LIVE_ALLOW_MERGE: "0",
    GITHUB_LIVE_TEST_TOKEN: "fixture-token-never-returned-1234567890",
    LINEAR_LIVE_TEST_TOKEN: "fixture-token-never-returned-0987654321",
    LINEAR_LIVE_TEST_TEAM_ID: "team-fixture",
    LINEAR_LIVE_TEST_PROJECT_ID: "project-fixture",
  };
}
