import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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
    testFile: "tests/projectIdeaBriefTool.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "natural_developer_mission_routing_contract",
    testFile: "tests/projectLinearProgressHostIntegration.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "research",
    project: "daily-use-research",
    realAi: true,
  }),
  Object.freeze({
    id: "linear_ticket_creation",
    project: "configured-linear-live",
    realAi: false,
  }),
  Object.freeze({
    id: "desktop_code_test_execution",
    project: "desktop-code-delivery-real-live",
    realAi: true,
  }),
  Object.freeze({
    id: "private_github_push",
    project: "github-askpass-runtime-live",
    realAi: false,
  }),
  Object.freeze({
    id: "jupyter_reflection_contract",
    testFile: "tests/jupyterReflectionTool.test.ts",
    realAi: false,
  }),
  Object.freeze({
    id: "linked_phase_research_to_note_and_jupyter_reflection",
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
  const now = options.now ?? (() => new Date());
  const before = await gitState();
  assertExactCleanHeadV1(before, expectedHead, "before workflow audit");

  const manifest = {
    version: 1,
    kind: "exact_head_workflow_audit",
    headSha: expectedHead,
    githubVisibility: "private",
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
  await persistManifest(manifestPath, manifest);

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
          ];
      const exitCode = await runChild(process.execPath, args, {
        cwd: repoRoot,
        env: {
          ...env,
          E2E_GITHUB_VISIBILITY: "private",
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
      manifest.stages.push({
        id: stage.id,
        project: stage.project ?? null,
        testFile: stage.testFile ?? null,
        headSha: expectedHead,
        startedAt,
        completedAt: now().toISOString(),
        status: "passed",
        verifier: stage.verifier ? path.basename(stage.verifier) : null,
      });
      await persistManifest(manifestPath, manifest);
    }
    manifest.status = "passed";
    manifest.completedAt = now().toISOString();
    await persistManifest(manifestPath, manifest);
    console.log(
      `Exact-HEAD workflow audit passed: head=${expectedHead} manifest=${manifestPath}`,
    );
    return manifest;
  } catch (error) {
    manifest.status = "failed";
    manifest.completedAt = now().toISOString();
    manifest.failure = String(error?.message ?? error).slice(0, 1_000);
    await persistManifest(manifestPath, manifest);
    throw error;
  }
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
