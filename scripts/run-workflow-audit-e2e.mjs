import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  containsSensitiveProofText,
  proofDirectoryForSha,
} from "./run-targeted-protected-release.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const exclusiveRunner = path.join(repoRoot, "scripts", "run-e2e-exclusive.mjs");
const byokVerifier = path.join(
  repoRoot,
  "scripts",
  "verify-byok-autonomous-journey.mjs",
);

export const WORKFLOW_AUDIT_CONFIRMATION =
  "RESEARCH_LINEAR_DESKTOP_PRIVATE_GITHUB_REFLECTION";
export const WORKFLOW_AUDIT_MODEL = "deepseek-v4-pro";

/**
 * Project ideation first proves its independent closed API contract, followed
 * by the ordinary-language six-stage routing contract. Each runtime product
 * function then gets its own Obsidian boot and proof surface. The final BYOK
 * lane proves the durable cross-phase identity joins, but is intentionally not
 * mislabeled as a one-prompt hierarchy journey. Running these as separate child processes is
 * deliberate: comma-joining Playwright projects changes E2E_PLAYWRIGHT_LANE
 * and can make exact lane guards skip while the overall command exits green.
 */
export const WORKFLOW_AUDIT_STAGES = Object.freeze([
  Object.freeze({
    id: "project_ideation_contract",
    canonicalOrder: 1,
    proofClass: "deterministic_contract",
    testFile: "tests/projectIdeaBriefTool.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "natural_developer_mission_routing_contract",
    canonicalOrder: 2,
    proofClass: "deterministic_contract",
    testFile: "tests/projectLinearProgressHostIntegration.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "jupyter_reflection_contract",
    canonicalOrder: 7,
    proofClass: "deterministic_contract",
    testFile: "tests/jupyterReflectionTool.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "linear_ticket_creation",
    canonicalOrder: 4,
    proofClass: "live_external_capability",
    project: "configured-linear-live",
    realAi: false,
  }),
  Object.freeze({
    id: "private_github_push",
    canonicalOrder: 6,
    proofClass: "live_external_capability",
    project: "github-askpass-runtime-live",
    realAi: false,
  }),
  Object.freeze({
    id: "research",
    canonicalOrder: 3,
    proofClass: "live_model_capability",
    project: "daily-use-research",
    grep: "DU-02 proof-gated sourced writeback binds owned fetched passages",
    realAi: true,
  }),
  Object.freeze({
    id: "desktop_code_test_execution",
    canonicalOrder: 5,
    proofClass: "live_model_capability",
    project: "desktop-code-delivery-real-live",
    realAi: true,
  }),
  Object.freeze({
    id: "linked_phase_research_to_note_and_jupyter_reflection",
    canonicalOrder: 8,
    proofClass: "joined_live_workflow",
    project: "byok-autonomous-journey",
    realAi: true,
    verifier: byokVerifier,
  }),
]);

export function validateWorkflowAuditEnvironmentV1(
  env = process.env,
  platform = process.platform,
) {
  if (platform !== "win32") {
    throw new Error("The full workflow audit requires Windows and native Obsidian.");
  }
  if (env.WORKFLOW_AUDIT_LIVE_CONFIRMATION !== WORKFLOW_AUDIT_CONFIRMATION) {
    throw new Error(
      `Set WORKFLOW_AUDIT_LIVE_CONFIRMATION=${WORKFLOW_AUDIT_CONFIRMATION} to authorize disposable Linear and private GitHub mutations with mandatory cleanup.`,
    );
  }
  const expectedHead = env.WORKFLOW_AUDIT_EXPECTED_HEAD?.trim() ?? "";
  if (!/^[a-f0-9]{40}$/u.test(expectedHead)) {
    throw new Error(
      "WORKFLOW_AUDIT_EXPECTED_HEAD must be the exact 40-character commit SHA selected for this audit.",
    );
  }
  if (!env.LINEAR_LIVE_TEST_TEAM_ID?.trim()) {
    throw new Error(
      "The joined workflow requires LINEAR_LIVE_TEST_TEAM_ID as its exact disposable cleanup scope.",
    );
  }
  const githubToken = env.E2E_GITHUB_TOKEN?.trim() ?? "";
  if (!/^gh[pousr]_[A-Za-z0-9]{20,500}$/u.test(githubToken)) {
    throw new Error(
      "E2E_GITHUB_TOKEN must be a classic/OAuth GitHub token with repo and delete_repo scopes for the private push proof.",
    );
  }
  const visibility = env.E2E_GITHUB_VISIBILITY?.trim().toLowerCase() ?? "";
  if (visibility && visibility !== "private") {
    throw new Error("The workflow audit is private-GitHub-only.");
  }
  return { expectedHead, visibility: "private" };
}

export async function runWorkflowAuditE2eV1(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const { expectedHead } = validateWorkflowAuditEnvironmentV1(env, platform);
  const runChild = options.runChild ?? runChildV1;
  const gitState = options.gitState ?? readGitStateV1;
  const persistManifest = options.persistManifest ?? persistManifestV1;
  const persistProtectedManifest =
    options.persistProtectedManifest ?? persistProtectedManifestV1;
  const readStageEvidence = options.readStageEvidence ?? readStageEvidenceV1;
  const now = options.now ?? (() => new Date());
  const before = await gitState();
  assertExactCleanHeadV1(before, expectedHead, "before workflow audit");

  const manifest = {
    version: 2,
    kind: "exact_head_workflow_audit",
    headSha: expectedHead,
    githubVisibility: "private",
    model: WORKFLOW_AUDIT_MODEL,
    startedAt: now().toISOString(),
    completedAt: null,
    status: "running",
    stages: [],
  };
  const manifestPath = path.join(
    repoRoot,
    "test-results",
    `workflow-audit-${expectedHead}.json`,
  );
  const protectedManifestPath = protectedWorkflowAuditManifestPathV1(
    expectedHead,
    manifest.startedAt,
  );
  await persistManifest(manifestPath, manifest);

  let auditError = null;
  try {
    for (const stage of WORKFLOW_AUDIT_STAGES) {
      const boundary = await gitState();
      assertExactCleanHeadV1(boundary, expectedHead, `before ${stage.id}`);
      const startedAt = now().toISOString();
      const args = stage.testFile
        ? ["--import", "tsx", "--test", stage.testFile]
        : [
            exclusiveRunner,
            ...(stage.realAi ? ["--real-ai"] : []),
            `--project=${stage.project}`,
            ...(stage.grep ? ["--grep", stage.grep] : []),
          ];
      const exitCode = await runChild(process.execPath, args, {
        cwd: repoRoot,
        env: {
          ...env,
          E2E_GITHUB_VISIBILITY: "private",
          ...(stage.realAi ? { E2E_AI_MODEL: WORKFLOW_AUDIT_MODEL } : {}),
          ...(stage.id === "linked_phase_research_to_note_and_jupyter_reflection" &&
              env.WORKFLOW_AUDIT_BASELINE_BOOTSTRAP === "1"
            ? { E2E_ALLOW_MISSING_SCORECARD_BASELINE: "1" }
            : {}),
        },
      });
      if (exitCode !== 0) {
        throw new Error(
          `Workflow audit stage ${stage.id} (${stage.project ?? stage.testFile}) exited ${exitCode}.`,
        );
      }
      if (stage.verifier) {
        const verifyExitCode = await runChild(
          process.execPath,
          [stage.verifier],
          {
            cwd: repoRoot,
            env: { ...env, E2E_GITHUB_VISIBILITY: "private" },
          },
        );
        if (verifyExitCode !== 0) {
          throw new Error(
            `Workflow audit verifier for ${stage.id} exited ${verifyExitCode}.`,
          );
        }
      }
      const afterStage = await gitState();
      assertExactCleanHeadV1(afterStage, expectedHead, `after ${stage.id}`);
      const completedAt = now().toISOString();
      const runtimeEvidence = stage.project
        ? await readStageEvidence(stage)
        : deterministicStageEvidenceV1();
      manifest.stages.push({
        id: stage.id,
        canonicalOrder: stage.canonicalOrder,
        proofClass: stage.proofClass,
        project: stage.project ?? null,
        testFile: stage.testFile ?? null,
        grep: stage.grep ?? null,
        headSha: expectedHead,
        startedAt,
        completedAt,
        elapsedMs: Math.max(
          0,
          Date.parse(completedAt) - Date.parse(startedAt),
        ),
        status: "passed",
        model: stage.realAi ? WORKFLOW_AUDIT_MODEL : null,
        providerUsage: runtimeEvidence.providerUsage,
        receipts: runtimeEvidence.receipts,
        cleanup: runtimeEvidence.cleanup,
        acceptance: runtimeEvidence.acceptance,
        evidenceSource: runtimeEvidence.evidenceSource,
        verifier: stage.verifier
          ? { name: path.basename(stage.verifier), status: "passed" }
          : null,
      });
      await persistManifest(manifestPath, manifest);
    }
    manifest.status = "passed";
    manifest.completedAt = now().toISOString();
  } catch (error) {
    auditError = error;
    manifest.status = "failed";
    manifest.completedAt = now().toISOString();
    manifest.failure = sanitizeWorkflowAuditFailureV1(error);
  }
  const persistence = await Promise.allSettled([
    persistManifest(manifestPath, manifest),
    persistProtectedManifest(protectedManifestPath, manifest),
  ]);
  const persistenceErrors = persistence.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  if (persistenceErrors.length > 0) {
    throw new AggregateError(
      [...(auditError ? [auditError] : []), ...persistenceErrors],
      "Workflow audit could not persist every final evidence copy.",
    );
  }
  if (auditError) throw auditError;
  console.log(
    `Exact-HEAD workflow audit passed: head=${expectedHead} manifest=${manifestPath} protected=${protectedManifestPath}`,
  );
  return manifest;
}

export function protectedWorkflowAuditManifestPathV1(headSha, startedAt) {
  if (!/^[a-f0-9]{40}$/u.test(headSha)) {
    throw new Error("Protected workflow audit path requires one full lowercase Git commit SHA.");
  }
  const timestamp = String(startedAt ?? "")
    .replace(/[^A-Za-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 80);
  if (!timestamp) {
    throw new Error("Protected workflow audit path requires a bounded start timestamp.");
  }
  return path.join(
    proofDirectoryForSha(headSha),
    `workflow-audit-${timestamp}.json`,
  );
}

function sanitizeWorkflowAuditFailureV1(error) {
  return String(error?.message ?? error)
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|lin_api_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,})/giu,
      "[credential redacted]",
    )
    .replace(/\b[A-Za-z]:[\\/][^\r\n"']+/gu, "[local path redacted]")
    .replace(/https?:\/\/[^\s"')]+/giu, "[URL redacted]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 1_000);
}

function deterministicStageEvidenceV1() {
  return {
    evidenceSource: "node_test_contract",
    providerUsage: { modelCallCount: 0, toolCallCount: 0 },
    receipts: { status: "not_applicable", verifiedCount: 0, proofTokens: [] },
    cleanup: { status: "not_applicable", proofCount: 0 },
    acceptance: { status: "passed", missing: [] },
  };
}

async function readStageEvidenceV1(stage) {
  const reportPath = path.join(
    repoRoot,
    "test-results",
    "playwright-execution-report.json",
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  const matches = collectPlaywrightTestsV1(report?.suites).filter(
    (entry) => entry.projectName === stage.project,
  );
  if (matches.length !== 1) {
    throw new Error(
      `Workflow audit evidence expected one ${stage.project} result, found ${matches.length}.`,
    );
  }
  const entry = matches[0];
  const passed = [...entry.results]
    .reverse()
    .find((result) => result?.status === "passed");
  if (entry.status !== "expected" || !passed) {
    throw new Error(`Workflow audit evidence for ${stage.project} is not a passing result.`);
  }
  const annotations = new Map();
  for (const annotation of [
    ...(entry.annotations ?? []),
    ...(passed.annotations ?? []),
  ]) {
    if (
      typeof annotation?.type === "string" &&
      typeof annotation?.description === "string"
    ) annotations.set(annotation.type, annotation.description);
  }
  const custom = parseJsonAnnotationV1(
    annotations.get("workflow-audit-runtime-evidence-v1"),
  );
  const metrics = parseJsonAnnotationV1(
    annotations.get("daily-use-metrics-v1"),
  );
  const observed = parseJsonAnnotationV1(
    annotations.get("daily-use-observed-v1"),
  );
  const modelCallCount = boundedEvidenceCount(
    custom?.modelCallCount ?? metrics?.modelCalls ?? 0,
    "model-call count",
  );
  if (stage.realAi && modelCallCount < 1) {
    throw new Error(
      `Workflow audit evidence for ${stage.project} omitted its model-call count.`,
    );
  }
  const toolCallCount = boundedEvidenceCount(
    custom?.toolCallCount ?? metrics?.toolCalls ?? 0,
    "tool-call count",
  );
  const proofTokens = Array.isArray(observed?.proofs)
    ? [...new Set(observed.proofs.filter(
        (value) => typeof value === "string" && /^receipt:[a-z0-9_:-]+$/u.test(value),
      ))].sort()
    : [];
  const cleanupTokens = Array.isArray(observed?.cleanup)
    ? [...new Set(observed.cleanup.filter(
        (value) => typeof value === "string" && /^cleanup:[a-z0-9_:-]+$/u.test(value),
      ))].sort()
    : [];
  const verifiedReceiptCount = boundedEvidenceCount(
    custom?.verifiedReceiptCount ?? proofTokens.length,
    "verified receipt count",
  );
  const missing = Array.isArray(metrics?.missingAcceptanceCriteria)
    ? metrics.missingAcceptanceCriteria.filter(
        (value) => typeof value === "string" && value.length <= 160,
      ).slice(0, 100)
    : [];
  const acceptanceStatus = metrics
    ? metrics.acceptanceStatus === "pass" && missing.length === 0
      ? "passed"
      : "failed"
    : "passed_by_stage_contract";
  if (acceptanceStatus === "failed") {
    throw new Error(`Workflow audit acceptance evidence failed for ${stage.project}.`);
  }
  const cleanupStatus = custom?.cleanupStatus === "failed"
    ? "failed"
    : cleanupTokens.length > 0
      ? "verified"
      : stage.id === "research" || stage.id === "desktop_code_test_execution"
        ? custom?.cleanupStatus === "verified" ? "verified" : "not_applicable"
        : "verified_by_stage_contract";
  if (cleanupStatus === "failed") {
    throw new Error(`Workflow audit cleanup evidence failed for ${stage.project}.`);
  }
  return {
    evidenceSource: "test-results/playwright-execution-report.json",
    providerUsage: { modelCallCount, toolCallCount },
    receipts: {
      status: verifiedReceiptCount > 0
        ? "verified"
        : stage.verifier
          ? "verified_by_independent_verifier"
          : "verified_by_stage_contract",
      verifiedCount: verifiedReceiptCount,
      proofTokens,
    },
    cleanup: { status: cleanupStatus, proofCount: cleanupTokens.length },
    acceptance: { status: acceptanceStatus, missing },
  };
}

function collectPlaywrightTestsV1(suites = []) {
  const collected = [];
  const visit = (suite) => {
    for (const spec of suite?.specs ?? []) {
      for (const test of spec?.tests ?? []) collected.push(test);
    }
    for (const child of suite?.suites ?? []) visit(child);
  };
  for (const suite of suites ?? []) visit(suite);
  return collected;
}

function parseJsonAnnotationV1(value) {
  if (typeof value !== "string" || value.length > 1_000_000) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}

function boundedEvidenceCount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
    throw new Error(`Workflow audit ${label} is invalid.`);
  }
  return value;
}

function assertExactCleanHeadV1(state, expectedHead, boundary) {
  if (state.headSha !== expectedHead) {
    throw new Error(
      `Git HEAD changed ${boundary}: expected ${expectedHead}, observed ${state.headSha}.`,
    );
  }
  if (state.status.trim()) {
    throw new Error(
      `Exact-HEAD workflow audit requires a clean checkout ${boundary}; dirty paths:\n${state.status}`,
    );
  }
}

async function readGitStateV1() {
  const [head, status] = await Promise.all([
    execGitV1(["rev-parse", "HEAD"]),
    execGitV1(["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  return { headSha: head.trim(), status };
}

async function execGitV1(args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd: repoRoot,
    windowsHide: true,
    timeout: 30_000,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return stdout;
}

async function persistManifestV1(manifestPath, manifest) {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function persistProtectedManifestV1(manifestPath, manifest) {
  const envelope = {
    version: 1,
    kind: "exact_head_workflow_audit_manifest",
    releaseSha: manifest.headSha,
    capturedAt: manifest.completedAt,
    payload: manifest,
  };
  const serialized = `${JSON.stringify(envelope, null, 2)}\n`;
  if (containsSensitiveProofText(serialized)) {
    throw new Error(
      "Protected workflow audit manifest contains private or credential-bearing text.",
    );
  }
  await mkdir(path.dirname(manifestPath), { recursive: true });
  try {
    await lstat(manifestPath);
    throw new Error("Protected workflow audit manifest already exists.");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const temporaryPath = `${manifestPath}.tmp-${process.pid}`;
  try {
    await writeFile(temporaryPath, serialized, {
      encoding: "utf8",
      flag: "wx",
    });
    await rename(temporaryPath, manifestPath);
    if (await readFile(manifestPath, "utf8") !== serialized) {
      throw new Error("Protected workflow audit manifest failed exact readback.");
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function runChildV1(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      ...options,
      shell: false,
      windowsHide: true,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`Workflow audit child stopped by ${signal}.`));
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  runWorkflowAuditE2eV1().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
