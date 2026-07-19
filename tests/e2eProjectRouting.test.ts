import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// @ts-ignore The production runner is an intentionally unbundled Node ESM script.
import { applyE2eAiMode, applyE2eLane, normalizeExclusiveArgs } from "../scripts/run-e2e-exclusive.mjs";
// @ts-ignore The production preflight is an intentionally unbundled Node ESM script.
import { validateLiveExternalPreflight } from "../scripts/live-external-preflight.mjs";

test("DU-04 Linear scenarios are owned by the dedicated file-routed spec", () => {
  const phase6 = readFileSync(
    new URL("../e2e/daily-use-linear.spec.ts", import.meta.url),
    "utf8",
  );
  const monolith = readFileSync(
    new URL("../e2e/obsidian-agent.spec.ts", import.meta.url),
    "utf8",
  );
  for (const title of [
    "ordinary Linear-looking text does not expose or execute Linear tools",
    "DU-04 accepted research creates a verified Linear hierarchy, backlink, and restart-safe dedupe",
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

test("free self-hosted daily-use job explicitly trusts only its created disposable vault", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.match(
    workflow,
    /\$vault = Join-Path \$env:RUNNER_TEMP "agentic-researcher-e2e-\$env:E2E_RELEASE_COMMIT_SHA"/u,
  );
  assert.match(
    workflow,
    /run-targeted-protected-release\.mjs[\s\S]{0,160}"--lanes=deterministic"/u,
  );
  assert.match(
    workflow,
    /runs-on: \[self-hosted, Windows, X64, agentic-daily-use\]/u,
  );
  assert.doesNotMatch(workflow, /^\s*pull_request:/mu);
  assert.match(workflow, /\.\/scripts\/install-verified-obsidian\.ps1/u);
  assert.doesNotMatch(workflow, /npm run test:e2e:daily-use/u);
  assert.doesNotMatch(workflow, /npm run test:e2e:deterministic-matrix/u);
  const installer = readFileSync(
    new URL("../scripts/install-verified-obsidian.ps1", import.meta.url),
    "utf8",
  );
  assert.match(installer, /Obsidian-\$version\.exe/u);
  assert.match(installer, /f35d2a35061098400a3fafc1bfd38d8bd33f1ad76df8b78b62ccdf20b0a30d26/u);
  assert.match(installer, /\$machine -ne 0x8664/u);
  assert.match(installer, /if \(\$null -ne \$reader\)/u);
  assert.doesNotMatch(installer, /\$reader\?\.Dispose\(\)/u);
  assert.match(installer, /Get-AuthenticodeSignature/u);
  assert.doesNotMatch(workflow, /choco install obsidian/u);
});

test("live Windows workflows publish runner-temp vault paths from a step", () => {
  for (const [file, vaultName] of [
    ["live-model.yml", "agentic-researcher-live-$env:E2E_RELEASE_COMMIT_SHA"],
    [
      "protected-release-vertical.yml",
      "agentic-researcher-protected-$env:E2E_RELEASE_COMMIT_SHA",
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
        `\\$vault = Join-Path \\$env:RUNNER_TEMP "${vaultName.replace(
          /[.*+?^${}()|[\]\\]/gu,
          "\\$&",
        )}"`,
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
  assert.match(source, /getLinearOAuthStatus/u);
  assert.doesNotMatch(source, /LINEAR_LIVE_TEST_TOKEN/u);
  assert.doesNotMatch(source, /linearApiKey/u);
  const harness = readFileSync(
    new URL("../e2e/fixtures/nativeObsidianHarness.ts", import.meta.url),
    "utf8",
  );
  assert.match(harness, /preservedLinearOAuthRuntimeState/u);
  assert.match(harness, /linearOAuthRuntimeState: preservedLinearOAuthRuntimeState/u);
  assert.match(harness, /linearCapabilitySnapshot: preservedLinearCapabilitySnapshot/u);
  assert.match(harness, /linearIntegrationState: preservedLinearIntegrationState/u);
  const preflight = readFileSync(
    new URL("../scripts/e2e-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.match(preflight, /"configured-linear-live": \[\]/u);
  assert.match(preflight, /modelCredentialReferences/u);
  assert.match(preflight, /hasPersistentSecureReference/u);
  assert.match(preflight, /persistent opaque model credential reference/u);
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

test("daily-use commands route to focused specs and live projects disable reruns", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.match(packageJson.scripts["test:e2e"], /--real-ai --project=daily-use-research/u);
  assert.match(packageJson.scripts["test:e2e:mock"], /deterministic-core-mock/u);
  assert.match(packageJson.scripts["test:e2e:daily-use"], /daily-use-note/u);
  assert.match(packageJson.scripts["test:e2e:daily-use"], /daily-use:focused/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:focused"], /daily-use-connections/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:focused"], /daily-use-memory-reflex/u);
  assert.doesNotMatch(packageJson.scripts["test:e2e:daily-use"], /daily-use-mock/u);
  assert.equal(
    packageJson.scripts["test:e2e:daily-use:mock"],
    "npm run test:e2e:daily-use",
  );
  assert.match(packageJson.scripts["test:e2e:daily-use:live-model"], /DU-02/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:code"], /DU-03/u);
  assert.match(
    packageJson.scripts["test:e2e:daily-use:languages"],
    /--project=daily-use-code --grep=LANG-01/u,
  );
  assert.match(packageJson.scripts["test:e2e:daily-use:linear"], /DU-04/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:github"], /DU-05/u);
  assert.match(packageJson.scripts["test:e2e:daily-use:compound"], /DU-06/u);
  assert.match(
    packageJson.scripts["test:e2e:daily-use:checkers"],
    /--project=daily-use-compound --grep="DU-06 checkers"/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:configured-linear"],
    /--project=configured-linear-live/u,
  );
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  for (const project of [
    "daily-use-research",
    "daily-use-code-live",
    "daily-use-compound",
    "real-ai-soak",
    "provider-canary",
  ]) {
    assert.match(
      config,
      new RegExp(`name: "${project}"[\\s\\S]{0,160}retries: 0`, "u"),
    );
  }
});

test("protected release workflow is exact-SHA, self-hosted, and cannot dispatch broad or merge lanes", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/protected-release-vertical.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /ref: \$\{\{ inputs\.commit_sha \}\}/u);
  assert.match(workflow, /if \(\$actualSha -ne \$env:E2E_RELEASE_COMMIT_SHA\)/u);
  assert.match(
    workflow,
    /runs-on: \[self-hosted, Windows, X64, agentic-daily-use\]/u,
  );
  assert.match(workflow, /PROTECTED_TARGETED_LANES: \$\{\{ inputs\.lanes \}\}/u);
  assert.match(workflow, /"--lanes=\$env:PROTECTED_TARGETED_LANES"/u);
  assert.match(workflow, /run-targeted-protected-release\.mjs/u);
  assert.doesNotMatch(workflow, /run:[^\r\n]*\$\{\{ inputs\.(?:commit_sha|lanes) \}\}/u);
  assert.doesNotMatch(workflow, /^\s*(?:run:\s*)?npm run test:e2e\s*$/mu);
  assert.doesNotMatch(workflow, /npm run test:e2e:daily-use/u);
  assert.doesNotMatch(workflow, /npm run test:e2e:deterministic-matrix/u);
  assert.doesNotMatch(workflow, /npm run test:e2e:real:soak/u);
  assert.doesNotMatch(workflow, /E2E_LIVE_ALLOW_MERGE:\s*["']?1/u);
  assert.doesNotMatch(workflow, /LIVE_EXTERNAL_MERGE_CONFIRMATION:\s*MERGE/u);
  assert.doesNotMatch(workflow, /git\s+push[^\r\n]*(?:--force|-f\b)/u);
  assert.match(workflow, /protected-targeted-summaries-\$\{\{ inputs\.commit_sha \}\}/u);
  assert.match(workflow, /did not consume GitHub-hosted runner minutes/u);
  const installStep = workflow.indexOf("Install exact repository dependencies");
  const protectedRunStep = workflow.indexOf(
    "Run only exact affected daily-use files and selected research cases",
  );
  assert.ok(installStep >= 0 && protectedRunStep > installStep);
  for (const credential of [
    "E2E_OLLAMA_API_KEY:",
    "E2E_LINEAR_API_KEY:",
    "E2E_GITHUB_TOKEN:",
  ]) {
    assert.ok(
      workflow.indexOf(credential) > protectedRunStep,
      `${credential} must be scoped after dependency installation to the exact protected run step`,
    );
  }

  const targetedRunner = readFileSync(
    new URL("../scripts/run-targeted-protected-release.mjs", import.meta.url),
    "utf8",
  );
  for (const focusedFile of [
    "e2e/daily-use-connections.spec.ts",
    "e2e/daily-use-note.spec.ts",
    "e2e/daily-use-memory-reflex.spec.ts",
    "e2e/daily-use-code.spec.ts",
    "e2e/daily-use-linear.spec.ts",
    "e2e/daily-use-github.spec.ts",
    "e2e/daily-use-research.spec.ts",
    "e2e/daily-use-compound.spec.ts",
  ]) {
    assert.match(targetedRunner, new RegExp(focusedFile.replace(/\./gu, "\\."), "u"));
  }
  assert.match(targetedRunner, /DU-02 proof-gated sourced writeback/u);
  assert.match(targetedRunner, /bounded recovery changes action/u);
  assert.match(targetedRunner, /DU-03 protected real-model TypeScript project creation/u);
  assert.match(targetedRunner, /DU-06 checkers exact-SHA lifecycle/u);
  assert.equal(
    targetedRunner.match(/verifyExactCleanSha\(options\.sha\)/gu)?.length,
    4,
  );
  assert.match(targetedRunner, /buildCredentialFreeEnvironment\(\)/u);
  assert.match(
    targetedRunner,
    /runNpmScript\("build", credentialFreeEnvironment\)/u,
  );
  assert.doesNotMatch(targetedRunner, /deterministic-matrix|real:soak/u);

  const compound = readFileSync(
    new URL("../e2e/daily-use-compound.spec.ts", import.meta.url),
    "utf8",
  );
  const realHarness = readFileSync(
    new URL("../e2e/fixtures/realAiHarness.ts", import.meta.url),
    "utf8",
  );
  const phase4GitRepo = readFileSync(
    new URL("../e2e/fixtures/phase4GitRepo.ts", import.meta.url),
    "utf8",
  );
  const du06Progress = readFileSync(
    new URL("../e2e/fixtures/dailyUseDu06Progress.ts", import.meta.url),
    "utf8",
  );
  const mainSource = readFileSync(
    new URL("../main.ts", import.meta.url),
    "utf8",
  );
  assert.match(compound, /restartAfterProjectStages: MAIN_STAGES/u);
  assert.match(compound, /restartAfterProjectStages: \["reconciliation_cleanup"\]/u);
  assert.match(
    realHarness,
    /PROJECT_STAGE_COMPLETION_TOOL\[stage as ProjectLifecycleStageName\]/u,
  );
  assert.match(realHarness, /node\.status === "complete"/u);
  assert.match(
    realHarness,
    /ui\.stopReason === null &&\s*ui\.canResume &&\s*Boolean\(ui\.continuationCommand\)/u,
  );
  assert.match(realHarness, /durablyCompletedLifecycleTools\.includes/u);
  const approvalPoll = realHarness.indexOf(
    "if (await approveFirstVisiblePreparedAction(page))",
  );
  const durableRestartRead = realHarness.indexOf(
    "plugin?.getDurableMissionRestartReadiness?.()",
  );
  assert.ok(approvalPoll >= 0);
  assert.ok(durableRestartRead >= 0);
  assert.ok(
    approvalPoll < durableRestartRead,
    "protected approval polling must run before durable restart projection",
  );
  assert.match(
    realHarness,
    /Promise\.race\(\[\s*Promise\.resolve\(plugin\?\.getDurableMissionRestartReadiness\?\.\(\)\)/u,
  );
  assert.match(
    realHarness,
    /setTimeout\(\(\) => resolve\(null\), 500\)/u,
    "durable restart polling must yield before an exact approval can expire",
  );
  assert.match(mainSource, /after\.ledgerStatus !== "running"/u);
  assert.match(realHarness, /prepareForDurableMissionRestart/u);
  assert.match(realHarness, /quiescent durable restart boundary/u);
  assert.match(compound, /expectGitHubRepositoryAbsent/u);
  assert.match(compound, /independentlyVerifyLinearCleanup/u);
  assert.match(compound, /createPhase4PythonCheckersProjectFixture/u);
  assert.match(compound, /topic: "checkers"/u);
  assert.match(
    compound,
    /completionDrivenLoops: true,\s*thinkingMode: "medium"/u,
    "the protected compound coding proof must use bounded agentic reasoning",
  );
  assert.match(compound, /Application Testing Dumping Grounds/u);
  assert.match(
    compound,
    /linearEvidenceDestinationName:\s*LINEAR_EVIDENCE_DESTINATION_NAME/u,
  );
  assert.match(compound, /linearWorkspaceName:\s*workspaceName/u);
  assert.match(compound, /linearTeamName:/u);
  assert.match(compound, /linear_get_issue/u);
  assert.match(compound, /Read the protected scripts\/verify_project\.py contract/u);
  assert.match(compound, /args: \["-m", "scripts\.verify_all"\]/u);
  assert.match(phase4GitRepo, /scripts", "verify_all\.py"/u);
  assert.match(phase4GitRepo, /run_module\('scripts\.verify_project'/u);
  assert.match(phase4GitRepo, /discover\('tests', pattern='test_checkers\.py'\)/u);
  assert.match(compound, /readRedactedDailyUseCounters/u);
  assert.match(compound, /metrics attachment/u);
  assert.match(compound, /buildProgressiveDu06Observations/u);
  assert.doesNotMatch(compound, /artifacts: \[\],\s*proofs: \[\]/u);
  assert.match(du06Progress, /item\.items\.length < 4/u);
  assert.match(du06Progress, /\["committed", "deduplicated"\]\.includes/u);
  assert.match(du06Progress, /targetedValidationReceiptId !==/u);
  assert.match(du06Progress, /item\?\.remoteSha === codeHandoff\?\.commitSha/u);
  assert.match(compound, /checkpoint\?\.artifact\?\.notePath === scope\.notePath/u);
  assert.match(compound, /JSON\.stringify\(checkpoint\?\.items \?\? \[\]\)\.includes\(scope\.marker\)/u);
  assert.match(compound, /checkers\/game\.py/u);
  assert.match(compound, /tests\/test_checkers\.py/u);
  assert.match(compound, /verifiedPrivate: true/u);
  assert.match(compound, /git", \["status", "--porcelain"\]/u);
  assert.match(compound, /preserveConfiguredLinearCredential: !linearToken/u);
  assert.match(compound, /preserveConfiguredGitHubCredential: true/u);
  assert.match(compound, /withGitHubCredentialToken/u);
  assert.match(compound, /getLinearOAuthStatus/u);
  assert.match(compound, /https:\/\/ollama\.com\/api/u);
  assert.match(compound, /getE2EAiConfig/u);
  assert.doesNotMatch(compound, /E2E_RELEASE_GITHUB_REPOSITORY["')]/u);
});

test("public workflows use only the free trusted self-hosted runner and SHA-pinned actions", () => {
  const workflows: string[] = [];
  for (const file of [
    "ci.yml",
    "live-external-smoke.yml",
    "live-model.yml",
    "live-sandbox-boundary.yml",
    "pages.yml",
    "protected-release-vertical.yml",
    "unified-plugin-release-gate.yml",
  ]) {
    const workflow = readFileSync(
      new URL(`../.github/workflows/${file}`, import.meta.url),
      "utf8",
    );
    workflows.push(workflow);
    assert.match(
      workflow,
      /runs-on: \[self-hosted, Windows, X64, agentic-daily-use\]/u,
      `${file} must use the free protected local runner`,
    );
    assert.doesNotMatch(
      workflow,
      /runs-on:\s*(?:ubuntu-|windows-\d|macos-)/u,
      `${file} must not consume GitHub-hosted runner minutes`,
    );
    for (const match of workflow.matchAll(/^\s*uses:\s*([^\s#]+).*$/gmu)) {
      assert.match(
        match[1] ?? "",
        /^actions\/[A-Za-z0-9_.-]+@[0-9a-f]{40}$/u,
        `${file} contains an unpinned or non-GitHub-owned action`,
      );
    }
  }
  assert.doesNotMatch(
    workflows.join("\n"),
    /^\s*pull_request:/mu,
    "untrusted fork code must never execute on the persistent self-hosted runner",
  );
  assert.doesNotMatch(
    workflows.join("\n"),
    /npm run test:e2e:deterministic-matrix|npm run test:e2e:real:soak/u,
  );

  const pagesWorkflow = readFileSync(
    new URL("../.github/workflows/pages.yml", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    pagesWorkflow,
    /actions\/upload-pages-artifact@/u,
    "Pages must not use a composite action whose internal upload action is tag-pinned",
  );
  assert.match(
    pagesWorkflow,
    /actions\/upload-artifact@[0-9a-f]{40}/u,
    "Pages must upload its explicit artifact through a full-SHA-pinned action",
  );
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
