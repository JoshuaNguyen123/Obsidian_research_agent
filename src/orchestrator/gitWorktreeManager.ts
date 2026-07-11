import { requireNodeModule } from "../platform/nodeRequire";
import {
  buildOrchestratorBranchName,
  evaluateWorktreePromotion,
  isPathInsideRoot,
  type WorktreePromotionDecision,
} from "./gitWorktreePolicy";

export interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type GitCommandExecutor = (input: {
  cwd: string;
  args: string[];
  signal?: AbortSignal;
}) => Promise<GitCommandResult>;

export interface RepositorySnapshot {
  repositoryRoot: string;
  branch: string;
  headSha: string;
  clean: boolean;
  status: string;
}

export interface ManagedGitWorktree {
  id: string;
  taskId: string;
  repositoryRoot: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  baseWasClean: boolean;
}

export interface ValidationCommand {
  command: string;
  args: string[];
  label: string;
}

export interface ValidationProfile {
  id: string;
  bootstrapCommands: ValidationCommand[];
  validationCommands: ValidationCommand[];
  /** Repository-relative execution-control files that a worker may not change. */
  protectedPaths: string[];
  /** Explicit build outputs that validation is expected to add or update. */
  allowedGeneratedPaths: string[];
}

const ALLOWED_VALIDATION_COMMANDS = new Set(["npm", "node", "py", "python"]);
const NODE_VALIDATION_PROTECTED_PATHS = [
  ".github/workflows",
  ".githooks",
  ".husky",
  "esbuild.config.mjs",
  "jsconfig.json",
  "package.json",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "scripts",
  "tsconfig.json",
  "yarn.lock",
];

export function createNodeValidationProfile(
  validationCommands: ValidationCommand[],
  options: { allowedGeneratedPaths?: string[] } = {},
): ValidationProfile {
  if (validationCommands.length === 0) {
    throw new Error("Node validation profile requires at least one validation command.");
  }
  return {
    id: "node-npm-lockfile-v1",
    bootstrapCommands: [
      {
        command: "npm",
        args: ["ci", "--ignore-scripts", "--no-audit", "--no-fund"],
        label: "npm ci --ignore-scripts",
      },
    ],
    validationCommands: validationCommands.map(cloneValidationCommand),
    protectedPaths: [...NODE_VALIDATION_PROTECTED_PATHS],
    allowedGeneratedPaths: normalizeProfilePaths(
      options.allowedGeneratedPaths ?? [],
      "generated output",
    ),
  };
}

export class GitWorktreeManager {
  private readonly execGit: GitCommandExecutor;
  private readonly preparedValidationPaths = new Set<string>();
  private disabledHooksPathPromise: Promise<string> | null = null;

  constructor(executor: GitCommandExecutor = createGitCommandExecutor()) {
    this.execGit = executor;
  }

  async inspectRepository(
    repositoryPath: string,
    signal?: AbortSignal,
  ): Promise<RepositorySnapshot> {
    const root = await this.gitText(repositoryPath, ["rev-parse", "--show-toplevel"], signal);
    const branch = await this.gitText(root, ["branch", "--show-current"], signal);
    const headSha = await this.gitText(root, ["rev-parse", "HEAD"], signal);
    const status = await this.gitText(
      root,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      signal,
      true,
      true,
    );
    return {
      repositoryRoot: root,
      branch: branch || "HEAD",
      headSha,
      clean: status.trim().length === 0,
      status,
    };
  }

  async createTaskWorktree(input: {
    repository: RepositorySnapshot;
    runId: string;
    taskId: string;
    signal?: AbortSignal;
  }): Promise<ManagedGitWorktree> {
    const runtime = loadPathRuntime();
    const root = getManagedRoot(runtime, input.repository.repositoryRoot, input.runId);
    const path = runtime.resolve(root, safePathPart(input.taskId));
    assertManagedPath(runtime, root, path);
    const branch = buildOrchestratorBranchName("agent", input.runId, input.taskId);
    await this.gitOk(
      input.repository.repositoryRoot,
      ["worktree", "add", "-b", branch, path, input.repository.headSha],
      input.signal,
    );
    return {
      id: `${input.runId}:${input.taskId}`,
      taskId: input.taskId,
      repositoryRoot: input.repository.repositoryRoot,
      path,
      branch,
      baseBranch: input.repository.branch,
      baseSha: input.repository.headSha,
      baseWasClean: input.repository.clean,
    };
  }

  async createIntegrationWorktree(input: {
    repository: RepositorySnapshot;
    runId: string;
    signal?: AbortSignal;
  }): Promise<ManagedGitWorktree> {
    const runtime = loadPathRuntime();
    const root = getManagedRoot(runtime, input.repository.repositoryRoot, input.runId);
    const path = runtime.resolve(root, "integration");
    assertManagedPath(runtime, root, path);
    const branch = buildOrchestratorBranchName("orchestrator", input.runId);
    await this.gitOk(
      input.repository.repositoryRoot,
      ["worktree", "add", "-b", branch, path, input.repository.headSha],
      input.signal,
    );
    return {
      id: `${input.runId}:integration`,
      taskId: "integration",
      repositoryRoot: input.repository.repositoryRoot,
      path,
      branch,
      baseBranch: input.repository.branch,
      baseSha: input.repository.headSha,
      baseWasClean: input.repository.clean,
    };
  }

  async getChangedFileCount(
    worktree: ManagedGitWorktree,
    signal?: AbortSignal,
  ): Promise<number> {
    const status = await this.gitText(
      worktree.path,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      signal,
      true,
      true,
    );
    return status.split(/\r?\n/).filter((line) => line.trim()).length;
  }

  async getChangedFiles(
    worktree: ManagedGitWorktree,
    signal?: AbortSignal,
  ): Promise<string[]> {
    const status = await this.gitText(
      worktree.path,
      ["status", "--porcelain=v1", "--untracked-files=all"],
      signal,
      true,
      true,
    );
    return status
      .split(/\r?\n/)
      .map((line) => line.slice(3).trim())
      .filter(Boolean);
  }

  async runValidationCommands(input: {
    worktree: ManagedGitWorktree;
    validationCommands: ValidationCommand[];
    profile?: ValidationProfile;
    signal?: AbortSignal;
    onValidationOutput?: (line: string) => void;
  }): Promise<GitCommandResult[]> {
    const validationCommands = input.profile?.validationCommands ?? input.validationCommands;
    if (validationCommands.length === 0) {
      throw new Error("At least one integration validation command is required.");
    }
    if (input.profile) {
      await this.prepareValidationDependencies({
        worktree: input.worktree,
        profile: input.profile,
        signal: input.signal,
        onValidationOutput: input.onValidationOutput,
      });
      await this.assertProtectedValidationPathsUnchanged(
        input.worktree,
        input.profile.protectedPaths,
        input.signal,
      );
    }
    const validation: GitCommandResult[] = [];
    for (const command of validationCommands) {
      const result = await runValidationCommand(
        input.worktree.path,
        command,
        input.signal,
      );
      validation.push(result);
      input.onValidationOutput?.(`${command.label}: exit ${result.exitCode}`);
      if (result.exitCode !== 0) {
        throw new Error(`${command.label} failed with exit code ${result.exitCode}.`);
      }
    }
    return validation;
  }

  async prepareValidationDependencies(input: {
    worktree: ManagedGitWorktree;
    profile: ValidationProfile;
    signal?: AbortSignal;
    onValidationOutput?: (line: string) => void;
  }): Promise<GitCommandResult[]> {
    if (this.preparedValidationPaths.has(input.worktree.path)) return [];
    await this.assertProtectedValidationPathsUnchanged(
      input.worktree,
      input.profile.protectedPaths,
      input.signal,
    );
    const results: GitCommandResult[] = [];
    for (const command of input.profile.bootstrapCommands) {
      const result = await runValidationCommand(
        input.worktree.path,
        command,
        input.signal,
        { forceIgnoreLifecycleScripts: true },
      );
      results.push(result);
      input.onValidationOutput?.(`${command.label}: exit ${result.exitCode}`);
      if (result.exitCode !== 0) {
        throw new Error(`${command.label} failed with exit code ${result.exitCode}.`);
      }
    }
    await this.assertProtectedValidationPathsUnchanged(
      input.worktree,
      input.profile.protectedPaths,
      input.signal,
    );
    this.preparedValidationPaths.add(input.worktree.path);
    return results;
  }

  async commitGreenWorktree(input: {
    worktree: ManagedGitWorktree;
    message: string;
    validationCommands: ValidationCommand[];
    profile?: ValidationProfile;
    signal?: AbortSignal;
    onValidationOutput?: (line: string) => void;
  }): Promise<{
    commitSha: string;
    validation: GitCommandResult[];
    changedFilePaths: string[];
  }> {
    const expectedChanges = await this.getChangedFiles(input.worktree, input.signal);
    if (expectedChanges.length === 0) {
      throw new Error("Worktree has no changes to validate or commit.");
    }
    const validation = await this.runValidationCommands(input);
    const validatedChanges = await this.getChangedFiles(input.worktree, input.signal);
    const allowedGeneratedPaths = new Set(
      normalizeProfilePaths(
        input.profile?.allowedGeneratedPaths ?? [],
        "generated output",
      ),
    );
    const unexpected = validatedChanges.filter(
      (path) => !expectedChanges.includes(path) && !allowedGeneratedPaths.has(path),
    );
    const missing = expectedChanges.filter((path) => !validatedChanges.includes(path));
    if (unexpected.length > 0 || missing.length > 0) {
      const suffix = unexpected.length > 0 ? `: ${unexpected.join(", ")}` : ".";
      throw new Error(`Validation or dependency bootstrap changed the worktree${suffix}`);
    }
    await this.gitOk(input.worktree.path, ["add", "-A"], input.signal);
    await this.gitOk(
      input.worktree.path,
      ["commit", "-m", sanitizeCommitMessage(input.message)],
      input.signal,
    );
    return {
      commitSha: await this.gitText(input.worktree.path, ["rev-parse", "HEAD"], input.signal),
      validation,
      changedFilePaths: validatedChanges,
    };
  }

  async integrateCommit(input: {
    integration: ManagedGitWorktree;
    commitSha: string;
    signal?: AbortSignal;
  }): Promise<string> {
    assertCommitSha(input.commitSha);
    await this.gitOk(
      input.integration.path,
      ["cherry-pick", input.commitSha],
      input.signal,
    );
    return this.gitText(input.integration.path, ["rev-parse", "HEAD"], input.signal);
  }

  async promoteIfGreen(input: {
    original: RepositorySnapshot;
    integration: ManagedGitWorktree;
    validationPassed: boolean;
    integrationConflict: boolean;
    approvalGranted: boolean;
    proofBlocked: boolean;
    signal?: AbortSignal;
  }): Promise<WorktreePromotionDecision> {
    const current = await this.inspectRepository(
      input.original.repositoryRoot,
      input.signal,
    );
    const decision = evaluateWorktreePromotion({
      baseWasClean: input.original.clean,
      baseIsClean: current.clean,
      baseBranch: input.original.branch,
      currentBranch: current.branch,
      baseSha: input.original.headSha,
      currentSha: current.headSha,
      validationPassed: input.validationPassed,
      integrationConflict: input.integrationConflict,
      approvalGranted: input.approvalGranted,
      proofBlocked: input.proofBlocked,
    });
    if (!decision.allow) {
      return decision;
    }
    await this.gitOk(
      input.original.repositoryRoot,
      ["merge", "--ff-only", input.integration.branch],
      input.signal,
    );
    return { allow: true };
  }

  private async gitText(
    cwd: string,
    args: string[],
    signal?: AbortSignal,
    allowEmpty = false,
    preserveLeadingWhitespace = false,
  ): Promise<string> {
    const result = await this.gitOk(cwd, args, signal);
    const output = preserveLeadingWhitespace
      ? result.stdout.replace(/(?:\r?\n)+$/, "")
      : result.stdout.trim();
    if (!allowEmpty && !output) {
      throw new Error(`git ${args[0] ?? "command"} returned no output.`);
    }
    return output;
  }

  private async gitOk(
    cwd: string,
    args: string[],
    signal?: AbortSignal,
  ): Promise<GitCommandResult> {
    assertAllowedGitArgs(args);
    const disabledHooksPath = await this.getDisabledHooksPath();
    const safeArgs = [
      "-c",
      `core.hooksPath=${disabledHooksPath}`,
      "-c",
      "core.fsmonitor=false",
      "-c",
      "commit.gpgSign=false",
      ...args,
    ];
    const result = await this.execGit({ cwd, args: safeArgs, signal });
    if (result.exitCode !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
    return result;
  }

  private async assertProtectedValidationPathsUnchanged(
    worktree: ManagedGitWorktree,
    protectedPaths: string[],
    signal?: AbortSignal,
  ): Promise<void> {
    const normalized = normalizeProtectedPaths(protectedPaths);
    if (normalized.length === 0) {
      throw new Error("Validation profile must protect its execution-control files.");
    }
    const status = await this.gitText(
      worktree.path,
      ["status", "--porcelain=v1", "--untracked-files=all", "--", ...normalized],
      signal,
      true,
      true,
    );
    if (status.trim()) {
      throw new Error(
        `Worker changed protected validation controls: ${status.split(/\r?\n/)[0].trim()}`,
      );
    }
  }

  private getDisabledHooksPath(): Promise<string> {
    if (!this.disabledHooksPathPromise) {
      this.disabledHooksPathPromise = createDisabledHooksDirectory();
    }
    return this.disabledHooksPathPromise;
  }
}

function createGitCommandExecutor(): GitCommandExecutor {
  return async ({ cwd, args, signal }) => {
    const { spawn } = requireNodeModule<typeof import("child_process")>(
      "child_process",
      "git_worktree_manager",
    );
    return new Promise<GitCommandResult>((resolve, reject) => {
      const child = spawn("git", args, {
        cwd,
        shell: false,
        windowsHide: true,
        signal,
        env: {
          ...process.env,
          GIT_EDITOR: "true",
          GIT_MERGE_AUTOEDIT: "no",
          GIT_TERMINAL_PROMPT: "0",
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
      child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
      child.on("error", reject);
      child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
    });
  };
}

async function runValidationCommand(
  cwd: string,
  command: ValidationCommand,
  signal?: AbortSignal,
  options: { forceIgnoreLifecycleScripts?: boolean } = {},
): Promise<GitCommandResult> {
  if (!ALLOWED_VALIDATION_COMMANDS.has(command.command)) {
    throw new Error(`Validation command is not allowlisted: ${command.command}`);
  }
  const { spawn } = requireNodeModule<typeof import("child_process")>(
    "child_process",
    "git_worktree_validation",
  );
  return new Promise((resolve, reject) => {
    const invocation = resolveValidationInvocation(command);
    const child = spawn(invocation.executable, invocation.args, {
      cwd,
      shell: false,
      windowsHide: true,
      signal,
      env: {
        ...process.env,
        CI: "1",
        NPM_CONFIG_AUDIT: "false",
        NPM_CONFIG_FUND: "false",
        NPM_CONFIG_UPDATE_NOTIFIER: "false",
        ...(options.forceIgnoreLifecycleScripts
          ? { NPM_CONFIG_IGNORE_SCRIPTS: "true" }
          : {}),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode: exitCode ?? 1, stdout, stderr }));
  });
}

function resolveValidationInvocation(command: ValidationCommand): {
  executable: string;
  args: string[];
} {
  if (
    command.command !== "npm" ||
    typeof process === "undefined" ||
    process.platform !== "win32"
  ) {
    return { executable: command.command, args: [...command.args] };
  }
  const npmCli = findWindowsNpmCli();
  if (!npmCli) {
    throw new Error(
      "Unable to locate npm-cli.js for shell-free validation on Windows.",
    );
  }
  return { executable: "node", args: [npmCli, ...command.args] };
}

function findWindowsNpmCli(): string | null {
  const fs = requireNodeModule<typeof import("fs")>("fs", "git_worktree_validation");
  const path = requireNodeModule<typeof import("path")>("path", "git_worktree_validation");
  const candidates = new Set<string>();
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath) candidates.add(npmExecPath);
  for (const entry of (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.add(path.join(entry, "node_modules", "npm", "bin", "npm-cli.js"));
    candidates.add(path.join(entry, "..", "node_modules", "npm", "bin", "npm-cli.js"));
  }
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) return resolved;
  }
  return null;
}

async function createDisabledHooksDirectory(): Promise<string> {
  const fs = requireNodeModule<typeof import("fs/promises")>(
    "fs/promises",
    "git_worktree_manager",
  );
  const runtime = loadPathRuntime();
  return fs.mkdtemp(runtime.join(runtime.tmpdir(), "agentic-researcher-disabled-hooks-"));
}

function normalizeProtectedPaths(paths: string[]): string[] {
  return normalizeProfilePaths(paths, "protected path", true);
}

function normalizeProfilePaths(
  paths: string[],
  label: string,
  requireNonEmpty = false,
): string[] {
  const output = new Set<string>();
  for (const value of paths) {
    const path = value.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (
      !path ||
      path === "." ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\r\n\0]/.test(path)
    ) {
      throw new Error(`Validation profile contains an unsafe ${label}: ${value}`);
    }
    output.add(path);
  }
  if (requireNonEmpty && output.size === 0) {
    throw new Error(`Validation profile requires at least one ${label}.`);
  }
  return [...output].sort();
}

function cloneValidationCommand(command: ValidationCommand): ValidationCommand {
  return { command: command.command, args: [...command.args], label: command.label };
}


function assertAllowedGitArgs(args: string[]): void {
  const allowed = new Set(["rev-parse", "branch", "status", "worktree", "add", "commit", "cherry-pick", "merge"]);
  if (args.length === 0 || !allowed.has(args[0])) {
    throw new Error(`Git operation is not allowlisted: ${args[0] ?? "empty"}`);
  }
  if (args.some((arg) => /[\r\n\0]/.test(arg))) {
    throw new Error("Git arguments contain unsupported control characters.");
  }
}

function assertCommitSha(value: string): void {
  if (!/^[0-9a-f]{7,64}$/i.test(value)) {
    throw new Error("Commit SHA is invalid.");
  }
}

function sanitizeCommitMessage(value: string): string {
  const output = value.replace(/[\r\n\0]+/g, " ").trim().slice(0, 200);
  if (!output) throw new Error("Commit message cannot be empty.");
  return output;
}

function safePathPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "task";
}

interface PathRuntime {
  resolve: typeof import("path").resolve;
  join: typeof import("path").join;
  sep: typeof import("path").sep;
  tmpdir: typeof import("os").tmpdir;
}

function loadPathRuntime(): PathRuntime {
  const path = requireNodeModule<typeof import("path")>("path", "git_worktree_manager");
  const os = requireNodeModule<typeof import("os")>("os", "git_worktree_manager");
  return { resolve: path.resolve, join: path.join, sep: path.sep, tmpdir: os.tmpdir };
}

function getManagedRoot(runtime: PathRuntime, repositoryRoot: string, runId: string): string {
  const repoKey = hashPath(repositoryRoot);
  return runtime.resolve(
    runtime.tmpdir(),
    "agentic-researcher-git-worktrees",
    repoKey,
    safePathPart(runId),
  );
}

function assertManagedPath(runtime: PathRuntime, root: string, path: string): void {
  if (!isPathInsideRoot(runtime.resolve(root), runtime.resolve(path), runtime.sep)) {
    throw new Error("Managed worktree path escapes the orchestrator root.");
  }
}

function hashPath(value: string): string {
  let hash = 2166136261;
  for (const char of value.toLowerCase()) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
