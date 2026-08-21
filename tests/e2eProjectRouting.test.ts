import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { extractVerifiedCommitBoundCodeExamplesV1 } from "../e2e/fixtures/reflectionAssertions";

// @ts-ignore The production runner is an intentionally unbundled Node ESM script.
import { allowsWorkflowAuditBaselineBootstrap, applyE2eAiMode, applyE2eLane, applyE2eProviderDefaults, applyPersistedWindowsSandboxEnvironment, assertExternalCredentialProjectPreconditions, normalizeExclusiveArgs } from "../scripts/run-e2e-exclusive.mjs";
// @ts-ignore The production preflight is an intentionally unbundled Node ESM script.
import { validateLiveExternalPreflight } from "../scripts/live-external-preflight.mjs";
// @ts-ignore The production workflow-audit runner is an intentionally unbundled Node ESM script.
import { runWorkflowAuditE2eV1, validateWorkflowAuditEnvironmentV1, WORKFLOW_AUDIT_CONFIRMATION, WORKFLOW_AUDIT_MODEL, WORKFLOW_AUDIT_STAGES } from "../scripts/run-workflow-audit-e2e.mjs";

test("no Playwright lane runs against a mocked model", () => {
  const config = readFileSync(
    new URL("../playwright.config.ts", import.meta.url),
    "utf8",
  );
  for (const removed of [
    "deterministic-core-mock",
    "integration-mock",
    "integration-mock-legacy",
    "companion-restart",
    "daily-use-connections",
    "daily-use-memory-reflex",
    "daily-use-note",
    "daily-use-linear",
    "daily-use-github",
    "agentic-capability-wireups",
    "systems-diagrams",
    "compound-flow-smoke-live",
  ]) {
    assert.equal(
      config.includes(removed),
      false,
      `mock-model lane still routed: ${removed}`,
    );
  }
  assert.match(config, /core-native/u);
});

test("the reported desktop failure has a dedicated real-model lane", () => {
  const spec = readFileSync(
    new URL("../e2e/desktop-checkers-delivery-real-live.spec.ts", import.meta.url),
    "utf8",
  );
  // The user's verbatim prompt, and the state it failed from.
  assert.match(spec, /Can you create a cli checkers game in Python on my desktop\?/u);
  assert.match(spec, /removeSandboxProvider/u);
  assert.match(spec, /sandbox_provider_unavailable/u);
  assert.match(spec, /assertProductionAdoptedSandboxV1/u);
  // It must never build its own provider configuration.
  assert.doesNotMatch(spec, /configureSandboxProvider/u);
  assert.doesNotMatch(spec, /liveProviderConfiguration/u);
});

test("real-model lanes assert the sandbox the product adopted for itself", () => {
  for (const lane of [
    "byok-autonomous-journey",
    "desktop-checkers-delivery-real-live",
    "desktop-code-delivery-real-live",
    "vault-sibling-code-delivery-real-live",
    "daily-use-code-live",
    "daily-use-compound",
    "obsidian-hello-github-live",
    "compound-flow-real-live",
  ]) {
    const spec = readFileSync(
      new URL(`../e2e/${lane}.spec.ts`, import.meta.url),
      "utf8",
    );
    assert.equal(
      spec.includes("configureSandboxProvider"),
      false,
      `${lane} still injects a sandbox provider the product never adopts`,
    );
    assert.equal(
      spec.includes("assertProductionAdoptedSandboxV1"),
      true,
      `${lane} does not assert production sandbox adoption`,
    );
  }
});

test("exclusive E2E runner defaults to the exact reported transformer lane", () => {
  const normalized = normalizeExclusiveArgs(["--real-ai"]);
  assert.deepEqual(normalized, {
    playwrightArgs: ["--project=core-native"],
    aiMode: "real",
    liveExternal: false,
    projects: ["core-native"],
  });
});

test("exclusive E2E runner permits the bounded real journey pack", () => {
  const normalized = normalizeExclusiveArgs([
    "--real-ai",
    "--project=desktop-checkers-delivery-real-live",
    "--project",
    "daily-use-research",
    "--project=daily-use-code-live",
    "--project=daily-use-compound",
  ]);
  assert.deepEqual(normalized.projects, [
    "desktop-checkers-delivery-real-live",
    "daily-use-research",
    "daily-use-code-live",
    "daily-use-compound",
  ]);
  assert.equal(normalized.aiMode, "real");
});

test("exclusive E2E runner routes the BYOK autonomous journey as real AI", () => {
  const normalized = normalizeExclusiveArgs([
    "--real-ai",
    "--project=byok-autonomous-journey",
  ]);
  assert.deepEqual(normalized, {
    playwrightArgs: ["--project=byok-autonomous-journey"],
    aiMode: "real",
    liveExternal: false,
    projects: ["byok-autonomous-journey"],
  });
});

test("full workflow audit routes independent functions and the joined journey sequentially", async () => {
  const auditStages = WORKFLOW_AUDIT_STAGES as ReadonlyArray<{
    id: string;
    project?: string;
    realAi: boolean;
    verifier?: string;
    testFile?: string;
  }>;
  assert.deepEqual(
    auditStages.map((stage) => ({
      id: stage.id,
      project: stage.project,
      realAi: stage.realAi,
      verified: Boolean(stage.verifier),
      testFile: stage.testFile ?? null,
    })),
    [
      {
        id: "project_ideation_contract",
        project: undefined,
        realAi: false,
        verified: false,
        testFile: "tests/projectIdeaBriefTool.test.ts",
      },
      {
        id: "natural_developer_mission_routing_contract",
        project: undefined,
        realAi: false,
        verified: false,
        testFile: "tests/projectLinearProgressHostIntegration.test.ts",
      },
      {
        id: "jupyter_reflection_contract",
        project: undefined,
        realAi: false,
        verified: false,
        testFile: "tests/jupyterReflectionTool.test.ts",
      },
      {
        id: "linear_ticket_creation",
        project: "configured-linear-live",
        realAi: false,
        verified: false,
        testFile: null,
      },
      {
        id: "private_github_push",
        project: "github-askpass-runtime-live",
        realAi: false,
        verified: false,
        testFile: null,
      },
      {
        id: "research",
        project: "daily-use-research",
        realAi: true,
        verified: false,
        testFile: null,
      },
      {
        id: "desktop_code_test_execution",
        project: "desktop-code-delivery-real-live",
        realAi: true,
        verified: false,
        testFile: null,
      },
      {
        id: "linked_phase_research_to_note_and_jupyter_reflection",
        project: "byok-autonomous-journey",
        realAi: true,
        verified: true,
        testFile: null,
      },
    ],
  );

  const headSha = "a".repeat(40);
  const calls: Array<{
    args: string[];
    visibility: string | undefined;
    model: string | undefined;
  }> = [];
  const manifests: any[] = [];
  const result = await runWorkflowAuditE2eV1({
    platform: "win32",
    env: {
      WORKFLOW_AUDIT_LIVE_CONFIRMATION: WORKFLOW_AUDIT_CONFIRMATION,
      WORKFLOW_AUDIT_EXPECTED_HEAD: headSha,
      LINEAR_LIVE_TEST_TEAM_ID: "team-disposable",
      E2E_GITHUB_TOKEN: `ghp_${"x".repeat(24)}`,
    },
    gitState: async () => ({ headSha, status: "" }),
    runChild: async (_command: string, args: string[], options: any) => {
      calls.push({
        args: args.map((value) => String(value)),
        visibility: options?.env?.E2E_GITHUB_VISIBILITY,
        model: options?.env?.E2E_AI_MODEL,
      });
      return 0;
    },
    persistManifest: async (_path: string, manifest: unknown) => {
      manifests.push(JSON.parse(JSON.stringify(manifest)));
    },
    readStageEvidence: async (stage: { realAi: boolean; verifier?: string }) => ({
      evidenceSource: "test-playwright-report.json",
      providerUsage: {
        modelCallCount: stage.realAi ? 3 : 0,
        toolCallCount: stage.realAi ? 7 : 0,
      },
      receipts: {
        status: stage.verifier ? "verified_by_independent_verifier" : "verified",
        verifiedCount: stage.realAi ? 2 : 1,
        proofTokens: [],
      },
      cleanup: { status: "verified", proofCount: 1 },
      acceptance: { status: "passed", missing: [] },
    }),
    now: () => new Date("2026-08-19T12:00:00.000Z"),
  });
  assert.equal(result.status, "passed");
  assert.equal(result.headSha, headSha);
  assert.deepEqual(
    calls.flatMap((call) => {
      const project = call.args.find((argument) =>
        argument.startsWith("--project="),
      );
      return project ? [project] : [];
    }),
    auditStages
      .filter((stage) => stage.project)
      .map((stage) => `--project=${stage.project}`),
  );
  assert.deepEqual(calls[0]?.args.slice(0, 3), ["--import", "tsx", "--test"]);
  assert.equal(calls[0]?.args[3], "tests/projectIdeaBriefTool.test.ts");
  assert.deepEqual(calls[1]?.args.slice(0, 3), ["--import", "tsx", "--test"]);
  assert.equal(
    calls[1]?.args[3],
    "tests/projectLinearProgressHostIntegration.test.ts",
  );
  assert.deepEqual(calls[2]?.args.slice(0, 3), ["--import", "tsx", "--test"]);
  assert.equal(calls[2]?.args[3], "tests/jupyterReflectionTool.test.ts");
  assert.deepEqual(calls[5]?.args.slice(-2), [
    "--grep",
    "DU-02 proof-gated sourced writeback binds owned fetched passages",
  ]);
  assert.equal(calls.length, 9, "the linked phase lane must run its verifier last");
  assert.equal(calls[8]?.args.some((arg) =>
    arg.endsWith("verify-byok-autonomous-journey.mjs")
  ), true);
  assert.equal(calls.every((call) => call.visibility === "private"), true);
  assert.equal(
    calls.filter((call) => call.model).every((call) => call.model === WORKFLOW_AUDIT_MODEL),
    true,
  );
  assert.equal(manifests.at(-1)?.version, 2);
  assert.equal(manifests.at(-1)?.status, "passed");
  assert.equal(manifests.at(-1)?.stages?.length, 8);
  assert.equal(manifests.at(-1)?.stages?.[5]?.providerUsage?.modelCallCount, 3);
  assert.equal(manifests.at(-1)?.stages?.[7]?.receipts?.status, "verified_by_independent_verifier");
  assert.equal(manifests.at(-1)?.stages?.[0]?.elapsedMs, 0);
});

test("missing BYOK baseline is allowed only for the explicitly authorized audit bootstrap", () => {
  const error = new Error(
    "No mission-scorecard baseline exists for: byok-autonomous-journey. Harvest it.",
  );
  const env = {
    E2E_ALLOW_MISSING_SCORECARD_BASELINE: "1",
    WORKFLOW_AUDIT_LIVE_CONFIRMATION: WORKFLOW_AUDIT_CONFIRMATION,
  };
  assert.equal(
    allowsWorkflowAuditBaselineBootstrap(
      error,
      ["byok-autonomous-journey"],
      env,
    ),
    true,
  );
  assert.equal(
    allowsWorkflowAuditBaselineBootstrap(error, ["daily-use-research"], env),
    false,
  );
  assert.equal(
    allowsWorkflowAuditBaselineBootstrap(
      new Error("BYOK execution failed."),
      ["byok-autonomous-journey"],
      env,
    ),
    false,
  );
});

test("full workflow audit fails before mutation without exact clean-head authority", () => {
  assert.throws(
    () => validateWorkflowAuditEnvironmentV1({}, "win32"),
    /WORKFLOW_AUDIT_LIVE_CONFIRMATION/u,
  );
  assert.throws(
    () =>
      validateWorkflowAuditEnvironmentV1(
        {
          WORKFLOW_AUDIT_LIVE_CONFIRMATION: WORKFLOW_AUDIT_CONFIRMATION,
          WORKFLOW_AUDIT_EXPECTED_HEAD: "a".repeat(40),
          LINEAR_LIVE_TEST_TEAM_ID: "team-disposable",
          E2E_GITHUB_TOKEN: `ghp_${"x".repeat(24)}`,
          E2E_GITHUB_VISIBILITY: "public",
        },
        "win32",
      ),
    /private-GitHub-only/u,
  );
});

test("reflection proof parser rejects links or markers without bounded commit code", () => {
  assert.deepEqual(
    extractVerifiedCommitBoundCodeExamplesV1(
      "## Agent project reflection\n\nhttps://linear.app/x https://github.com/x/y/pull/1\n",
    ),
    [],
  );
  const note = [
    "## Agent project reflection",
    "",
    "Research became tested code.",
    "",
    "### Verified code example",
    `\`src/add.ts\` lines 1-2 at commit \`aaaaaaaaaaaa\` (file hash \`bbbbbbbbbbbb\`; excerpt hash \`sha256:${"c".repeat(64)}\`).`,
    "```typescript",
    "export function add(left: number, right: number) {",
    "  return left + right;",
    "```",
  ].join("\n");
  assert.deepEqual(extractVerifiedCommitBoundCodeExamplesV1(note), [
    {
      path: "src/add.ts",
      startLine: 1,
      endLine: 2,
      commitPrefix: "aaaaaaaaaaaa",
      artifactSha256Prefix: "bbbbbbbbbbbb",
      codeSha256: `sha256:${"c".repeat(64)}`,
      language: "typescript",
      code: [
        "export function add(left: number, right: number) {",
        "  return left + right;",
      ].join("\n"),
    },
  ]);
  assert.throws(
    () =>
      extractVerifiedCommitBoundCodeExamplesV1(
        note.replace("lines 1-2", "lines 1-21"),
      ),
    /1-20 lines/u,
  );
});

test("BYOK autonomous journey requires its Linear cleanup scope before boot", () => {
  assert.throws(
    () =>
      assertExternalCredentialProjectPreconditions(
        { projects: ["byok-autonomous-journey"] },
        {},
        "win32",
      ),
    /requires LINEAR_LIVE_TEST_TEAM_ID/u,
  );
  assert.doesNotThrow(() =>
    assertExternalCredentialProjectPreconditions(
      { projects: ["byok-autonomous-journey"] },
      { LINEAR_LIVE_TEST_TEAM_ID: "team-explicit-cleanup-scope" },
      "win32",
    ),
  );
});

test("daily-use-compound requires its GitHub token before boot", () => {
  assert.throws(
    () =>
      assertExternalCredentialProjectPreconditions(
        { projects: ["daily-use-compound"] },
        {},
        "win32",
      ),
    /requires E2E_GITHUB_TOKEN/u,
  );
  assert.doesNotThrow(() =>
    assertExternalCredentialProjectPreconditions(
      { projects: ["daily-use-compound"] },
      { E2E_GITHUB_TOKEN: "github_pat_disposable_scope" },
      "win32",
    ),
  );
});

test("BYOK autonomous journey proves one root publication and cleans every owned issue", () => {
  const spec = readFileSync(
    new URL("../e2e/byok-autonomous-journey.spec.ts", import.meta.url),
    "utf8",
  );
  const harness = readFileSync(
    new URL("../e2e/fixtures/realAiHarness.ts", import.meta.url),
    "utf8",
  );
  assert.match(spec, /const ownedLinearIssueIds = new Set<string>\(\)/u);
  assert.match(spec, /readCompleteResearchPublications/u);
  assert.match(spec, /publications[\s\S]{0,220}\.toHaveLength\(1\)/u);
  assert.match(spec, /activeMarkerIssues[\s\S]{0,260}\.toHaveLength\(1\)/u);
  assert.match(spec, /receipt\?\.toolName === "linear_create_issue"/u);
  assert.match(spec, /receipt\?\.resource\?\.id === issueId/u);
  assert.match(spec, /publicationReceipts\[0\]\?\.runId/u);
  assert.match(spec, /maxContinuations: 4/u);
  assert.match(spec, /buildByokPhaseAResearchPrompt/u);
  assert.match(spec, /append_jupyter_reflection/u);
  assert.match(spec, /verified_code_example/u);
  assert.match(spec, /execution_count\)\.toBeNull\(\)/u);
  assert.match(spec, /cell\.outputs\)\.toEqual\(\[\]\)/u);
  assert.match(spec, /reconcileJupyterAfterRestart/u);
  assert.match(spec, /notebookAfterReconciliation\)\.toBe\(finalNotebookViaFilesystem\)/u);
  assert.match(spec, /hasExplicitResearchPublicationIntent\(phaseAPrompt\)/u);
  assert.match(
    spec,
    /only within repositoryWriteScope\.allowedPaths,[\s\S]{0,120}never use a substitute helper or validator file as recovery/u,
  );
  assert.doesNotMatch(spec, /any additional files yourself/iu);
  assert.match(spec, /cleanupExactOwnedLinearIssueToTrash/u);
  assert.match(spec, /byok-linear-cleanup-v1/u);
  assert.match(spec, /lastComplete\?\.stopReason\)\.not\.toBe\("budget"\)/u);
  assert.match(spec, /set_loose_delivery_unpaid\|no_progress/u);
  assert.match(
    spec,
    /Mission completion reflection\|Agent project reflection\|Flow real reflection/u,
  );
  assert.match(
    spec,
    /attestedRunLineage\?\.rootRunId[\s\S]{0,120}publication!\.originRunId/u,
  );
  assert.match(spec, /for \(const ownedIssueId of \[\.\.\.ownedLinearIssueIds\]\.sort\(\)\)/u);
  assert.match(spec, /issue \$\{ownedIssueId\} cleanup failed/u);
  assert.match(spec, /zero-survivor readback failed/u);
  assert.match(spec, /cleanupFailures\.length > 0/u);
  assert.match(spec, /output\?\.pageInfo\?\.hasNextPage/u);
  assert.match(spec, /\.\.\.\(after \? \{ after \} : \{\}\)/u);
  assert.match(spec, /completedReaders === 0/u);
  assert.match(harness, /current\.attestedRunLineage = \{/u);
  assert.match(harness, /segmentIds: \[\.\.\.priorSegmentIds, segmentId\]/u);
  assert.match(
    harness,
    /ui\.stopReason === "budget" &&\s*ui\.autoContinueReason === "no_progress"[\s\S]{0,220}Mission stopped at the production no-progress circuit/u,
  );
  assert.match(
    harness,
    /const successfulTerminal =[\s\S]{0,180}ui\.stopReason === "write_completed"/u,
  );
});

test("the removed mock mode is refused with an explicit message", () => {
  assert.throws(
    () => normalizeExclusiveArgs(["--mock-ai", "--project=daily-use-research"]),
    /--mock-ai was removed/u,
  );
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
    /run-targeted-protected-release\.mjs[\s\S]{0,640}"--lanes=desktop"/u,
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
  assert.deepEqual(
    normalizeExclusiveArgs([
      "--real-ai",
      "--project=desktop-code-delivery-real-live",
    ]).projects,
    ["desktop-code-delivery-real-live"],
  );
  assert.deepEqual(
    normalizeExclusiveArgs([
      "--real-ai",
      "--project=vault-sibling-code-delivery-real-live",
    ]).projects,
    ["vault-sibling-code-delivery-real-live"],
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--real-ai", "--project=configured-linear-live"]),
    /restricted to attested live-provider/u,
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--live-external", "--project=daily-use-research"]),
    /restricted to the disposable-live-external/u,
  );
  assert.throws(
    () => normalizeExclusiveArgs(["--project=unknown-lane"]),
    /Unknown E2E project/u,
  );
});

test("github askpass runtime lane makes no model calls and gates on its credential", () => {
  const normalized = normalizeExclusiveArgs([
    "--project=github-askpass-runtime-live",
  ]);
  assert.equal(normalized.liveExternal, false);
  assert.deepEqual(normalized.projects, ["github-askpass-runtime-live"]);
  const env: NodeJS.ProcessEnv = {};
  applyE2eLane(normalized, env);
  assert.equal(env.E2E_PLAYWRIGHT_LANE, "github-askpass-runtime-live");

  // The lane makes no model calls: --real-ai must reject it.
  assert.throws(
    () => normalizeExclusiveArgs(["--real-ai", "--project=github-askpass-runtime-live"]),
    /restricted to attested live-provider/u,
  );

  // Credential and platform preconditions fail before any Obsidian boot.
  assert.throws(
    () =>
      assertExternalCredentialProjectPreconditions(
        { projects: ["github-askpass-runtime-live"] },
        {},
        "win32",
      ),
    /requires E2E_GITHUB_TOKEN/u,
  );
  assert.throws(
    () =>
      assertExternalCredentialProjectPreconditions(
        { projects: ["github-askpass-runtime-live"] },
        { E2E_GITHUB_TOKEN: "ghp_x" },
        "linux",
      ),
    /supports only win32/u,
  );
  assert.throws(
    () =>
      assertExternalCredentialProjectPreconditions(
        { projects: ["github-askpass-runtime-live", "daily-use-research"] },
        { E2E_GITHUB_TOKEN: "ghp_x" },
        "win32",
      ),
    /only selected project/u,
  );
  assert.doesNotThrow(() =>
    assertExternalCredentialProjectPreconditions(
      { projects: ["github-askpass-runtime-live"] },
      { E2E_GITHUB_TOKEN: "ghp_x" },
      "win32",
    ),
  );
  // Lanes without external-credential requirements are unaffected.
  assert.doesNotThrow(() =>
    assertExternalCredentialProjectPreconditions(
      { projects: ["daily-use-research"] },
      {},
      "linux",
    ),
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
  applyE2eProviderDefaults(
    { aiMode: "real", projects: ["real-ai-contract"] },
    env,
  );
  applyE2eLane({ liveExternal: false, projects: ["real-ai-contract"] }, env);
  assert.deepEqual(env, {
    E2E_AI_MODE: "real",
    E2E_REAL_AI: "1",
    E2E_AI_MODEL: "glm-5.2",
    E2E_MODEL_PROVIDER: "ollama",
    E2E_PLAYWRIGHT_LANE: "real-ai-contract",
    E2E_LIVE_EXTERNAL: "0",
  });
});

test("provider canary binds preflight and runtime to its exact requested model", () => {
  const env: NodeJS.ProcessEnv = {
    E2E_AI_MODEL: "stale-default",
    E2E_CANARY_MODEL: "current-coding-model:cloud",
  };
  applyE2eProviderDefaults(
    { aiMode: "real", projects: ["provider-canary"] },
    env,
  );
  assert.equal(env.E2E_MODEL_PROVIDER, "ollama");
  assert.equal(env.E2E_AI_MODEL, "current-coding-model:cloud");
});

test("sandbox E2E lanes import only missing persisted Windows runtime declarations", () => {
  const env: NodeJS.ProcessEnv = {
    AGENTIC_SANDBOX_CI_EXECUTABLE: "explicit-wsl.exe",
  };
  const persisted: Record<string, string> = {
    AGENTIC_SANDBOX_CI_EXECUTABLE: "persisted-wsl.exe",
    AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE: "agentic-language-runtime",
    AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: `sha256:${"a".repeat(64)}`,
    AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION: "AgenticResearcherSandbox",
    AGENTIC_SANDBOX_CI_RUNTIME_ROOT: "/opt/agentic/runtime",
  };
  const imported = applyPersistedWindowsSandboxEnvironment(
    { projects: ["byok-autonomous-journey"] },
    env,
    {
      platform: "win32",
      readUserValue: (name: string) => persisted[name] ?? null,
    },
  );
  assert.equal(env.AGENTIC_SANDBOX_CI_EXECUTABLE, "explicit-wsl.exe");
  assert.equal(
    env.AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION,
    "AgenticResearcherSandbox",
  );
  assert.deepEqual(imported.sort(), [
    "AGENTIC_SANDBOX_CI_RUNTIME_DIGEST",
    "AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE",
    "AGENTIC_SANDBOX_CI_RUNTIME_ROOT",
    "AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION",
  ]);

  const untouched: NodeJS.ProcessEnv = {};
  assert.deepEqual(
    applyPersistedWindowsSandboxEnvironment(
      { projects: ["daily-use-research"] },
      untouched,
      {
        platform: "win32",
        readUserValue: () => "must-not-be-read",
      },
    ),
    [],
  );
  assert.deepEqual(untouched, {});
});

test("protected DU-06 binds retained Linear evidence to one verified project", () => {
  const source = readFileSync(
    new URL("../e2e/daily-use-compound.spec.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /requestedLinearProjectId \?\? plugin\.settings\?\.linearQueueProjectId/u,
  );
  assert.match(
    source,
    /configured protected test-evidence project with exact teamId \$\{linearEvidenceTeamId\}, exact projectId \$\{linearEvidenceProjectId\}/u,
  );
  assert.match(source, /project: \{ id: input\.projectId \}/u);
  assert.doesNotMatch(
    source,
    /requestedLinearTeamId \?\? plugin\.settings\?\.linearDefaultTeamId \?\? ""/u,
  );
});

test("package commands route only to real lanes and live projects disable reruns", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  );
  // Default `npm run test:e2e` is the exact currently reported daily-use failure.
  assert.match(
    packageJson.scripts["test:e2e"],
    /--real-ai --project=core-native/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:desktop-code-delivery"],
    /--real-ai --project=desktop-code-delivery-real-live/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:vault-sibling-code-delivery"],
    /--real-ai --project=vault-sibling-code-delivery-real-live/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:byok-autonomous-journey"],
    /--real-ai --project=byok-autonomous-journey/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:research"],
    /--real-ai --project=daily-use-research/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:code"],
    /--real-ai --project=daily-use-code-live/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:compound"],
    /--real-ai --project=daily-use-compound/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:compound-real"],
    /--real-ai --project=compound-flow-real-live/u,
  );
  assert.match(
    packageJson.scripts["test:e2e:hello-github"],
    /--real-ai --project=obsidian-hello-github-live/u,
  );
  assert.equal(
    packageJson.scripts["test:e2e:workflow-audit"],
    "node scripts/run-workflow-audit-e2e.mjs",
  );
  // test:e2e:journeys was removed: passing six --project flags made
  // E2E_PLAYWRIGHT_LANE a comma-joined string, so exact-equality lane guards
  // skipped themselves and the pack reported success having run almost
  // nothing. Sequential multi-lane belongs to run-targeted-protected-release.
  assert.equal(
    packageJson.scripts["test:e2e:journeys"],
    undefined,
    "the multi-project journeys pack must not come back; it could not fail honestly",
  );
  assert.match(
    packageJson.scripts["test:e2e:configured-linear"],
    /--project=configured-linear-live/u,
  );
  assert.match(
    packageJson.scripts["cleanup:e2e-github-residue"],
    /cleanup-e2e-github-residue\.mjs/u,
  );
  // No command may reintroduce a mocked model.
  for (const [name, command] of Object.entries(packageJson.scripts)) {
    assert.equal(
      String(command).includes("--mock-ai"),
      false,
      `script ${name} still requests a mocked model`,
    );
  }
  const config = readFileSync(new URL("../playwright.config.ts", import.meta.url), "utf8");
  for (const project of [
    "core-native",
    "byok-autonomous-journey",
    "desktop-checkers-delivery-real-live",
    "daily-use-research",
    "daily-use-code-live",
    "desktop-code-delivery-real-live",
    "vault-sibling-code-delivery-real-live",
    "daily-use-compound",
    "real-ai-soak",
    "provider-canary",
  ]) {
    assert.match(
      config,
      new RegExp(`name: "${project}"[\\s\\S]{0,160}retries: 0`, "u"),
    );
  }
  const preflight = readFileSync(
    new URL("../scripts/e2e-preflight.mjs", import.meta.url),
    "utf8",
  );
  assert.match(preflight, /"byok-autonomous-journey": \[\]/u);
  assert.match(preflight, /"core-native": \[\]/u);
  assert.match(preflight, /"safe-assistant-renderer": \[\]/u);
});

test("protected release workflow is exact-SHA, self-hosted, and cannot dispatch broad or merge lanes", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/protected-release-vertical.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /ref: \$\{\{ inputs\.commit_sha \}\}/u);
  assert.match(workflow, /if \(\$actualSha -ne \$env:REQUESTED_COMMIT_SHA\)/u);
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
  assert.match(workflow, /protected-targeted-summaries-\$\{\{ steps\.verify-sha\.outputs\.sha \}\}/u);
  for (const artifact of [
    "compound.json",
    "compound--daily-use-du06-stage-entry-proof.json",
    "compound--daily-use-du06-cleanup-proof.json",
    "compound--daily-use-du06-retained-linear-evidence.json",
  ]) {
    assert.ok(
      workflow.includes(
        `.agentic-proof/\${{ steps.verify-sha.outputs.sha }}/${artifact}`,
      ),
      `protected proof manifest must include ${artifact}`,
    );
  }
  assert.doesNotMatch(
    workflow,
    /\.agentic-proof\/\$\{\{ steps\.verify-sha\.outputs\.sha \}\}\/\*\.json/u,
    "protected proof uploads must enumerate the exact public artifact manifest",
  );
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
    "e2e/daily-use-research.spec.ts",
    "e2e/daily-use-code-live.spec.ts",
    "e2e/desktop-checkers-delivery-real-live.spec.ts",
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
  assert.doesNotMatch(
    targetedRunner,
    /aiMode: "mock"/u,
    "no protected lane may run against a mocked model",
  );

  const compound = readFileSync(
    new URL("../e2e/daily-use-compound.spec.ts", import.meta.url),
    "utf8",
  );
  const realHarness = readFileSync(
    new URL("../e2e/fixtures/realAiHarness.ts", import.meta.url),
    "utf8",
  );
  const connectionAttestation = readFileSync(
    new URL(
      "../e2e/fixtures/realAiConnectionAttestation.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(realHarness, /hasVerifiedModelConnection/u);
  assert.match(realHarness, /testModelConnection/u);
  assert.match(realHarness, /VERIFIED_REAL_AI_CONNECTIONS/u);
  assert.match(realHarness, /markModelConnectionVerifiedForHarness/u);
  assert.match(realHarness, /utilityModel:\s*""/u);
  assert.match(realHarness, /if \(reuseWorkerAttestation\)/u);
  for (const terminalMarker of [
    "Validation completed red",
    "Fast validation remained red",
    "passing cycle is still required",
    "tool_failure_terminal",
    "tool_failure_repeated",
    "same fast-validation failure fingerprint",
  ]) {
    assert.ok(realHarness.includes(terminalMarker), terminalMarker);
  }
  assert.match(
    realHarness,
    /terminal validation\/MissionGraph blocker; refusing further Continue loops/u,
  );
  assert.match(
    connectionAttestation,
    /await validate\(state\);[\s\S]*registry\.record\(target\)/u,
  );
  assert.match(realHarness, /const runId = typeof current\.runId/u);
  assert.match(
    realHarness,
    /const ledgerPath = `Agent Runs\/\$\{safeRunId\}\.md`/u,
  );
  assert.match(realHarness, /configRootRunId !== runId/u);
  assert.match(realHarness, /summaryRunId !== configLedgerRunId/u);
  assert.match(realHarness, /ledger\.runId !== ledgerRunId/u);
  assert.match(realHarness, /ledgerRunId !== runId/u);
  assert.match(
    realHarness,
    /graph\?\.missionId === runId[\s\S]*graph\?\.nodes\?\.dispatch\?\.executorId === "research-team"/u,
  );
  assert.match(realHarness, /lineage\?\.rootRunId !== leadRootRunId/u);
  assert.doesNotMatch(
    realHarness,
    /current\?\.persistedProjection\?\.missionLedgerPath/u,
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
  assert.match(
    mainSource,
    /e2eHarnessAttestationEnabled !== true[\s\S]*Harness connection attestation is disabled/u,
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
  assert.match(
    realHarness,
    /ui\.stopReason === "budget" &&\s*ui\.autoContinueReason !== "no_progress"/u,
    "the autonomous harness must not override the production no-progress circuit",
  );
  assert.match(realHarness, /durablyCompletedLifecycleTools\.includes/u);
  const approvalPoll = realHarness.indexOf(
    "approveFirstVisiblePreparedAction(page",
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
  assert.match(
    compound,
    /readCreatedRepositoryWorktreeOnce[\s\S]*waitForWorktreeCapture\(worktreeCapturePromise\)\.catch\(\(\) => undefined\)[\s\S]*readCreatedRepositoryWorktreeOnce/u,
    "DU-03 must fall back to an exact manifest readback when its concurrent worktree observer is late",
  );
  assert.equal(
    (compound.match(/code\?\.workspaceManager \?\? code\?\.runtime\?\.workspaceManager/gu) ?? []).length,
    2,
    "both DU-03 worktree readers must resolve the public bundled Code runtime manager",
  );
  assert.match(
    compound,
    /worktreeCaptureController\?\.abort\(\);[\s\S]*waitForWorktreeCapture\(worktreeCapturePromise, 1_000\)\.catch/u,
    "DU-03 must not await an in-flight Playwright worktree observer without a bound",
  );
  assert.match(compound, /topic: "checkers"/u);
  assert.match(
    compound,
    /completionDrivenLoops: true,\s*thinkingMode: resolveProtectedThinkingMode\(protectedModel\.model\)/u,
    "the protected compound coding proof must select a bounded model-aware reasoning mode",
  );
  assert.match(compound, /LINEAR_LIVE_TEST_TEAM_ID/u);
  assert.match(compound, /plugin\.settings\?\.linearDefaultTeamId/u);
  assert.match(compound, /plugin\.settings\?\.linearQueueProjectId/u);
  assert.match(compound, /configured protected test-evidence project/u);
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

test("the delivered desktop game is actually executed, not just written", () => {
  const spec = readFileSync(
    new URL("../e2e/desktop-checkers-delivery-real-live.spec.ts", import.meta.url),
    "utf8",
  );
  // Compile every delivered module, then run the entry point for real.
  assert.match(spec, /py_compile/u);
  assert.match(spec, /playDeliveredGame/u);
  assert.match(spec, /spawn\("python"/u);
  assert.match(spec, /Traceback/u);
  // Checkers-specific evidence, so another game cannot satisfy the lane.
  assert.match(spec, /king\|crown\|promot/u);
  assert.match(spec, /captur\|jump\|take/u);
});

test("public workflows use only the free trusted self-hosted runner and SHA-pinned actions", () => {
  const workflows: string[] = [];
  // pages.yml is the one deliberate exception: the repo has no registered
  // self-hosted runner anymore (agentic-daily-use aged out of GitHub), and the
  // publish job only tars committed static files and deploys them with the
  // ephemeral Pages OIDC token. GitHub-hosted minutes are free on this public
  // repo, so the original intent of the guard (no paid minutes, no secrets or
  // host state exposed to GitHub-hosted machines) still holds for it.
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
    if (file === "pages.yml") {
      assert.match(
        workflow,
        /runs-on: ubuntu-latest/u,
        "pages.yml publishes static files from a GitHub-hosted runner",
      );
      assert.doesNotMatch(
        workflow,
        /secrets\./u,
        "pages.yml must not consume repository secrets off the trusted machine",
      );
    } else {
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
    }
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

test("workflow audit research prompt names every required report section", () => {
  const source = readFileSync(
    new URL("../e2e/daily-use-research.spec.ts", import.meta.url),
    "utf8",
  );
  const scenarioStart = source.indexOf(
    'test("DU-02 proof-gated sourced writeback binds owned fetched passages"',
  );
  assert.notEqual(
    scenarioStart,
    -1,
    "DU-02 must remain an independently selectable live scenario",
  );
  const scenario = source.slice(scenarioStart);
  assert.match(scenario, /a ## Findings section/u);
  assert.match(scenario, /a ## Limitations section/u);
  assert.match(scenario, /a ## Confidence section/u);
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
