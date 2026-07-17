import { requireNodeModule } from "../platform/nodeRequire";
import { appendToolTranscript } from "../model/toolTranscript";
import { serializeToolResultForModel } from "../model/toolResultPayload";
import type {
  ModelChatMessage,
  ModelClient,
  ModelToolCall,
  ModelToolDefinition,
} from "../model/types";
import type { ToolExecutionResult } from "../tools/types";
import type { WorkerHandoff } from "./types";

const MAX_CODE_FILE_BYTES = 1_000_000;
const MAX_LISTED_FILES = 500;
const ALLOWED_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css",
  ".scss", ".html", ".md", ".yaml", ".yml", ".toml", ".txt", ".py",
  ".ps1", ".sh", ".sql", ".svg",
]);
const IGNORED_DIRECTORIES = new Set([
  ".git", "node_modules", "dist", "build", "coverage", ".agent-backups",
]);
const BLOCKED_MUTATION_DIRECTORIES = new Set([
  ".git",
  ".githooks",
  ".husky",
  "bin",
  "hooks",
  "scripts",
]);
const BLOCKED_MUTATION_FILES = new Set([
  ".npmrc",
  ".pypirc",
  ".yarnrc",
  ".yarnrc.yml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cargo.toml",
  "composer.json",
  "composer.lock",
  "deno.json",
  "deno.jsonc",
  "gemfile",
  "gemfile.lock",
  "go.mod",
  "go.sum",
  "gruntfile.js",
  "gulpfile.js",
  "jsconfig.json",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "pyproject.toml",
  "requirements.txt",
  "tsconfig.json",
  "yarn.lock",
]);
const BLOCKED_MUTATION_EXTENSIONS = new Set([
  ".bat",
  ".cmd",
  ".com",
  ".dll",
  ".exe",
  ".msi",
  ".ps1",
  ".sh",
]);

export interface CodeWorkerResult {
  handoff: WorkerHandoff;
  summary: string;
  changedFilePaths: string[];
  modelSteps: number;
  toolCalls: number;
}

export interface CodeWorkerEvents {
  onStatus?: (message: string) => void | Promise<void>;
  onFileChanged?: (path: string) => void | Promise<void>;
  onTool?: (input: {
    name: string;
    step: number;
    ok: boolean;
  }) => void | Promise<void>;
}

/**
 * Bounded coding worker. Its only mutation tools are path-confined text edits
 * inside an already approved disposable worktree. It has no shell, Git,
 * network, vault, approval, or base-checkout capability.
 */
export async function runCodeWorker(input: {
  runId: string;
  participantId: string;
  leadParticipantId: string;
  taskId: string;
  assignment: string;
  worktreePath: string;
  modelClient: ModelClient;
  abortSignal?: AbortSignal;
  maxSteps?: number;
  maxToolCalls?: number;
  events?: CodeWorkerEvents;
  now?: () => Date;
}): Promise<CodeWorkerResult> {
  const maxSteps = clamp(input.maxSteps ?? 20, 1, 30);
  const maxToolCalls = clamp(input.maxToolCalls ?? 30, 1, 50);
  const changed = new Set<string>();
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: [
        "You are a code worker in an approved isolated Git worktree.",
        "Use only the code file tools provided. You have no shell, Git, network, vault, or approval capability.",
        "Inspect relevant files before editing. Keep changes scoped to the assigned task.",
        "When finished, return a concise summary and tests the Lead should run.",
      ].join(" "),
    },
    { role: "user", content: input.assignment },
  ];
  let toolCalls = 0;
  let modelSteps = 0;
  let summary = "";

  for (let step = 1; step <= maxSteps; step += 1) {
    throwIfAborted(input.abortSignal);
    modelSteps = step;
    await input.events?.onStatus?.(`Code worker step ${step}/${maxSteps}`);
    const response = await input.modelClient.chat({
      messages,
      tools: CODE_WORKER_TOOL_DEFINITIONS,
      think: false,
      abortSignal: input.abortSignal,
      evidencePhase: "worker",
    });
    messages.push(response.message);
    if (response.toolCalls.length === 0) {
      summary = response.message.content.trim();
      if (summary) break;
      messages.push({
        role: "user",
        content: "Summarize the scoped implementation now.",
      });
      continue;
    }

    for (const rawCall of response.toolCalls) {
      throwIfAborted(input.abortSignal);
      if (toolCalls >= maxToolCalls) {
        summary = "Code worker stopped at its bounded tool-call budget.";
        break;
      }
      toolCalls += 1;
      const call: ModelToolCall = rawCall.id
        ? rawCall
        : { ...rawCall, id: `${input.runId}-code-call-${toolCalls}` };
      const result = await executeCodeWorkerTool({
        root: input.worktreePath,
        call,
        changed,
      });
      await input.events?.onTool?.({
        name: call.name,
        step,
        ok: result.ok,
      });
      const changedPath = getOutputPath(result);
      if (result.ok && changedPath && isMutationTool(call.name)) {
        await input.events?.onFileChanged?.(changedPath);
      }
      appendToolTranscript({
        messages,
        toolCall: call,
        resultContent: serializeToolResultForModel(result),
        origin: "model",
        fallbackId: call.id ?? `${input.runId}-code-call-${toolCalls}`,
      });
      throwIfAborted(input.abortSignal);
    }
    if (summary) break;
  }

  if (!summary) {
    summary = changed.size > 0
      ? `Changed ${changed.size} file(s); bounded worker ended before prose synthesis.`
      : "No code changes were produced within the bounded worker budget.";
  }
  const now = (input.now?.() ?? new Date()).toISOString();
  const changedFilePaths = [...changed].sort();
  return {
    handoff: {
      id: `${input.runId}:handoff:${input.taskId}`,
      fromParticipantId: input.participantId,
      toParticipantId: input.leadParticipantId,
      taskId: input.taskId,
      status: changedFilePaths.length > 0 ? "ready" : "rejected",
      summary,
      sourceIds: [],
      evidenceIds: [],
      unresolvedQuestions:
        changedFilePaths.length > 0 ? [] : ["No worktree changes were produced."],
      confidence: changedFilePaths.length > 0 ? "medium" : "low",
      stopReason: changedFilePaths.length > 0 ? "changes_ready" : "no_changes",
      createdAt: now,
      updatedAt: now,
    },
    summary,
    changedFilePaths,
    modelSteps,
    toolCalls,
  };
}

export async function executeCodeWorkerTool(input: {
  root: string;
  call: ModelToolCall;
  changed?: Set<string>;
}): Promise<ToolExecutionResult> {
  try {
    const runtime = loadRuntime();
    if (input.call.name === "code_list_files") {
      const start = resolveCodeWorkerPath(
        input.root,
        getString(input.call.arguments.path) ?? ".",
        { allowRoot: true, requireAllowedExtension: false },
      );
      await assertNoLinkTraversal(runtime, input.root, start, {
        allowMissingLeaf: false,
        requireDirectory: true,
      });
      const files = await listFiles(runtime, input.root, start);
      return { ok: true, toolName: input.call.name, output: { files } };
    }
    const relativePath = requireString(input.call.arguments.path, "path");
    const path = resolveCodeWorkerPath(input.root, relativePath);
    if (input.call.name === "code_read_file") {
      await assertNoLinkTraversal(runtime, input.root, path, {
        allowMissingLeaf: false,
      });
      const content = await runtime.fs.readFile(path, "utf8");
      assertFileSize(content);
      return {
        ok: true,
        toolName: input.call.name,
        output: { path: normalizeRelative(input.root, path, runtime), content },
      };
    }
    if (input.call.name === "code_write_file") {
      assertWorkerMutationPath(input.root, path, runtime);
      await assertNoLinkTraversal(runtime, input.root, path, {
        allowMissingLeaf: true,
      });
      const content = requireString(input.call.arguments.content, "content", true);
      assertFileSize(content);
      await runtime.fs.mkdir(runtime.path.dirname(path), { recursive: true });
      await runtime.fs.writeFile(path, content, "utf8");
      const normalized = normalizeRelative(input.root, path, runtime);
      input.changed?.add(normalized);
      return {
        ok: true,
        toolName: input.call.name,
        output: { path: normalized, bytesWritten: Buffer.byteLength(content, "utf8") },
      };
    }
    if (input.call.name === "code_replace_text") {
      assertWorkerMutationPath(input.root, path, runtime);
      await assertNoLinkTraversal(runtime, input.root, path, {
        allowMissingLeaf: false,
      });
      const oldText = requireString(input.call.arguments.oldText, "oldText", true);
      const newText = requireString(input.call.arguments.newText, "newText", true);
      const current = await runtime.fs.readFile(path, "utf8");
      const first = current.indexOf(oldText);
      if (first < 0 || current.indexOf(oldText, first + oldText.length) >= 0) {
        throw new Error("oldText must match exactly once before replacement.");
      }
      const next = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
      assertFileSize(next);
      await runtime.fs.writeFile(path, next, "utf8");
      const normalized = normalizeRelative(input.root, path, runtime);
      input.changed?.add(normalized);
      return {
        ok: true,
        toolName: input.call.name,
        output: { path: normalized, replacements: 1 },
      };
    }
    return failure(input.call.name, "code_worker_tool_blocked", "Tool is not available to the code worker.");
  } catch (error) {
    return failure(
      input.call.name,
      "code_worker_tool_failed",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function resolveCodeWorkerPath(
  root: string,
  relativePath: string,
  options: { allowRoot?: boolean; requireAllowedExtension?: boolean } = {},
): string {
  const runtime = loadRuntime();
  if (!relativePath.trim() || runtime.path.isAbsolute(relativePath) || /[\0\r\n]/.test(relativePath)) {
    throw new Error("Code worker paths must be non-empty worktree-relative paths.");
  }
  const resolvedRoot = runtime.path.resolve(root);
  const resolved = runtime.path.resolve(resolvedRoot, relativePath);
  const prefix = resolvedRoot.endsWith(runtime.path.sep)
    ? resolvedRoot
    : `${resolvedRoot}${runtime.path.sep}`;
  if (resolved !== resolvedRoot && !resolved.startsWith(prefix)) {
    throw new Error("Code worker path escapes the approved worktree.");
  }
  if (resolved === resolvedRoot && options.allowRoot !== true) {
    throw new Error("A file path is required.");
  }
  if (options.requireAllowedExtension !== false && resolved !== resolvedRoot) {
    const extension = runtime.path.extname(resolved).toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw new Error(`Code worker file extension is not allowlisted: ${extension || "none"}`);
    }
  }
  return resolved;
}

export const CODE_WORKER_TOOL_DEFINITIONS: ModelToolDefinition[] = [
  definition("code_list_files", "List bounded source files in the approved worktree.", {
    path: { type: "string", description: "Optional worktree-relative folder." },
  }),
  definition("code_read_file", "Read one allowlisted text source file.", {
    path: { type: "string" },
  }, ["path"]),
  definition("code_write_file", "Create or replace one allowlisted text source file in the worktree.", {
    path: { type: "string" },
    content: { type: "string" },
  }, ["path", "content"]),
  definition("code_replace_text", "Replace one exact unique text occurrence in a worktree file.", {
    path: { type: "string" },
    oldText: { type: "string" },
    newText: { type: "string" },
  }, ["path", "oldText", "newText"]),
];

function definition(
  name: string,
  description: string,
  properties: Record<string, { type: string; description?: string }>,
  required: string[] = [],
): ModelToolDefinition {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties, required, additionalProperties: false },
    },
  };
}

async function listFiles(runtime: Runtime, root: string, start: string): Promise<string[]> {
  const output: string[] = [];
  const visit = async (folder: string): Promise<void> => {
    if (output.length >= MAX_LISTED_FILES) return;
    const entries = await runtime.fs.readdir(folder, { withFileTypes: true });
    for (const entry of entries) {
      if (output.length >= MAX_LISTED_FILES) break;
      const path = runtime.path.join(folder, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await visit(path);
      } else if (entry.isFile() && ALLOWED_EXTENSIONS.has(runtime.path.extname(entry.name).toLowerCase())) {
        output.push(normalizeRelative(root, path, runtime));
      }
    }
  };
  await visit(start);
  return output.sort();
}

async function assertNoLinkTraversal(
  runtime: Runtime,
  root: string,
  target: string,
  options: { allowMissingLeaf: boolean; requireDirectory?: boolean },
): Promise<void> {
  const resolvedRoot = runtime.path.resolve(root);
  const resolvedTarget = runtime.path.resolve(target);
  const rootStat = await runtime.fs.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Approved worktree root cannot be a symbolic link or junction.");
  }
  const canonicalRoot = await runtime.fs.realpath(resolvedRoot);
  const relative = runtime.path.relative(resolvedRoot, resolvedTarget);
  const segments = relative ? relative.split(runtime.path.sep).filter(Boolean) : [];
  let cursor = resolvedRoot;

  for (let index = 0; index < segments.length; index += 1) {
    cursor = runtime.path.join(cursor, segments[index]);
    let stat: Awaited<ReturnType<Runtime["fs"]["lstat"]>>;
    try {
      stat = await runtime.fs.lstat(cursor);
    } catch (error) {
      if (options.allowMissingLeaf && isMissingPathError(error)) {
        return;
      }
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error("Code worker paths cannot traverse symbolic links or junctions.");
    }
    const canonical = await runtime.fs.realpath(cursor);
    if (!isCanonicalPathInside(canonicalRoot, canonical, runtime)) {
      throw new Error("Code worker path resolves outside the approved worktree.");
    }
    const isLeaf = index === segments.length - 1;
    if (!isLeaf && !stat.isDirectory()) {
      throw new Error("Code worker path contains a non-directory parent component.");
    }
    if (isLeaf && options.requireDirectory && !stat.isDirectory()) {
      throw new Error("Code worker list path must be a directory.");
    }
  }
}

function assertWorkerMutationPath(root: string, target: string, runtime: Runtime): void {
  const relative = normalizeRelative(root, target, runtime);
  const parts = relative.split("/").filter(Boolean);
  const lowerParts = parts.map((part) => part.toLowerCase());
  const fileName = lowerParts.at(-1) ?? "";
  const extension = runtime.path.extname(fileName).toLowerCase();
  const blockedDirectory = lowerParts.slice(0, -1).some((part) =>
    BLOCKED_MUTATION_DIRECTORIES.has(part)
  );
  const githubExecutionControl = lowerParts[0] === ".github" &&
    (lowerParts[1] === "workflows" || lowerParts[1] === "actions");
  const requirementsFile = /^requirements(?:[-_.][a-z0-9_-]+)?\.txt$/i.test(fileName);
  const executableConfigFile = /(?:^|\.)(?:config|workspace)\.(?:[cm]?js|tsx?)$/i.test(
    fileName,
  );
  const typedConfigFile = /^(?:js|ts)config(?:\.[a-z0-9_-]+)?\.json$/i.test(fileName);
  if (
    blockedDirectory ||
    githubExecutionControl ||
    BLOCKED_MUTATION_FILES.has(fileName) ||
    BLOCKED_MUTATION_EXTENSIONS.has(extension) ||
    requirementsFile ||
    executableConfigFile ||
    typedConfigFile
  ) {
    throw new Error(
      `Code worker cannot edit execution-control or sensitive file: ${relative}`,
    );
  }
}

function isCanonicalPathInside(root: string, candidate: string, runtime: Runtime): boolean {
  const relative = runtime.path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${runtime.path.sep}`) &&
    !runtime.path.isAbsolute(relative)
  );
}

function isMissingPathError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

interface Runtime {
  fs: typeof import("fs/promises");
  path: typeof import("path");
}

function loadRuntime(): Runtime {
  return {
    fs: requireNodeModule<typeof import("fs/promises")>("fs/promises", "orchestrator_code_worker"),
    path: requireNodeModule<typeof import("path")>("path", "orchestrator_code_worker"),
  };
}

function normalizeRelative(root: string, path: string, runtime: Runtime): string {
  return runtime.path.relative(runtime.path.resolve(root), path).replace(/\\/g, "/");
}

function getOutputPath(result: ToolExecutionResult): string | null {
  return result.output && typeof result.output === "object" && "path" in result.output && typeof result.output.path === "string"
    ? result.output.path
    : null;
}

function isMutationTool(name: string): boolean {
  return name === "code_write_file" || name === "code_replace_text";
}

function failure(toolName: string, code: string, message: string): ToolExecutionResult {
  return { ok: false, toolName, error: { code, message } };
}

function requireString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && !value.trim())) {
    throw new Error(`${name} must be a string${allowEmpty ? "" : " with content"}.`);
  }
  return value;
}

function getString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function assertFileSize(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_CODE_FILE_BYTES) {
    throw new Error("Code worker file exceeds the 1 MB text limit.");
  }
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error("Code worker was cancelled.");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
