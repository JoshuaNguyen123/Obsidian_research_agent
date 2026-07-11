import { requireNodeModule } from "../platform/nodeRequire";

export interface CodeWorkspace {
  runId: string;
  rootDir: string;
}

interface WorkspaceRuntime {
  mkdir: typeof import("fs/promises").mkdir;
  readFile: typeof import("fs/promises").readFile;
  readdir: typeof import("fs/promises").readdir;
  rm: typeof import("fs/promises").rm;
  stat: typeof import("fs/promises").stat;
  writeFile: typeof import("fs/promises").writeFile;
  tmpdir: typeof import("os").tmpdir;
  basename: typeof import("path").basename;
  dirname: typeof import("path").dirname;
  join: typeof import("path").join;
  normalize: typeof import("path").normalize;
  resolve: typeof import("path").resolve;
  sep: typeof import("path").sep;
}

const WORKSPACE_FOLDER = "agentic-researcher-workspaces";

export async function ensureCodeWorkspace(runId: string): Promise<CodeWorkspace> {
  const runtime = loadWorkspaceRuntime();
  const rootDir = getWorkspaceRoot(runtime, runId);
  await runtime.mkdir(rootDir, { recursive: true });
  return { runId, rootDir };
}

export function assertSafeWorkspaceRelativePath(path: string): void {
  const normalized = normalizeWorkspaceRelativePath(path);
  if (!normalized) {
    throw new Error("Workspace path cannot be empty.");
  }
}

export async function writeWorkspaceFile(
  ws: CodeWorkspace,
  path: string,
  content: string,
): Promise<{ path: string; bytesWritten: number }> {
  const runtime = loadWorkspaceRuntime();
  const relativePath = normalizeWorkspaceRelativePath(path);
  const absolutePath = resolveWorkspacePath(runtime, ws.rootDir, relativePath);
  await runtime.mkdir(runtime.dirname(absolutePath), { recursive: true });
  await runtime.writeFile(absolutePath, content, "utf8");
  return { path: relativePath, bytesWritten: new TextEncoder().encode(content).length };
}

export async function readWorkspaceFile(
  ws: CodeWorkspace,
  path: string,
  maxChars = 20_000,
): Promise<{ path: string; content: string; truncated: boolean }> {
  const runtime = loadWorkspaceRuntime();
  const relativePath = normalizeWorkspaceRelativePath(path);
  const absolutePath = resolveWorkspacePath(runtime, ws.rootDir, relativePath);
  const content = await runtime.readFile(absolutePath, "utf8");
  const truncated = content.length > maxChars;
  return {
    path: relativePath,
    content: truncated ? `${content.slice(0, maxChars)}\n[truncated]` : content,
    truncated,
  };
}

export async function listWorkspaceFiles(
  ws: CodeWorkspace,
): Promise<Array<{ path: string; bytes: number }>> {
  const runtime = loadWorkspaceRuntime();
  const output: Array<{ path: string; bytes: number }> = [];
  await walkWorkspace(runtime, ws.rootDir, "", output);
  return output.sort((left, right) => left.path.localeCompare(right.path));
}

export async function cleanupOldWorkspaces(maxAgeDays = 7): Promise<number> {
  const runtime = loadWorkspaceRuntime();
  const root = runtime.join(runtime.tmpdir(), WORKSPACE_FOLDER);
  let entries: Array<{ name: string }> = [];
  try {
    entries = await runtime.readdir(root, { withFileTypes: true }) as Array<{ name: string; isDirectory?: () => boolean }>;
  } catch {
    return 0;
  }
  const maxAgeMs = Math.max(1, maxAgeDays) * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const entry of entries) {
    const dir = runtime.join(root, entry.name);
    try {
      const stat = await runtime.stat(dir);
      if (Date.now() - stat.mtimeMs >= maxAgeMs) {
        await runtime.rm(dir, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Best effort cleanup.
    }
  }
  return removed;
}

export function getWorkspaceAbsolutePath(
  ws: CodeWorkspace,
  path: string,
): string {
  const runtime = loadWorkspaceRuntime();
  return resolveWorkspacePath(
    runtime,
    ws.rootDir,
    normalizeWorkspaceRelativePath(path),
  );
}

function normalizeWorkspaceRelativePath(path: string): string {
  const trimmed = path.trim();
  if (trimmed.includes("\\")) {
    throw new Error(`Unsafe workspace path: ${path}`);
  }
  const normalized = trimmed.replace(/^\/+/, "");
  if (
    !normalized ||
    normalized.includes("..") ||
    /^[a-zA-Z]:/.test(normalized) ||
    normalized.split("/").some((part) => !part || part === ".")
  ) {
    throw new Error(`Unsafe workspace path: ${path}`);
  }
  return normalized;
}

function resolveWorkspacePath(
  runtime: WorkspaceRuntime,
  rootDir: string,
  relativePath: string,
): string {
  const root = runtime.resolve(rootDir);
  const resolved = runtime.resolve(root, relativePath);
  if (resolved !== root && !resolved.startsWith(`${root}${runtime.sep}`)) {
    throw new Error(`Workspace path escapes run workspace: ${relativePath}`);
  }
  return resolved;
}

async function walkWorkspace(
  runtime: WorkspaceRuntime,
  rootDir: string,
  relativeDir: string,
  output: Array<{ path: string; bytes: number }>,
) {
  const dir = relativeDir ? runtime.join(rootDir, relativeDir) : rootDir;
  const entries = await runtime.readdir(dir, { withFileTypes: true }) as Array<{
    name: string;
    isDirectory: () => boolean;
    isFile: () => boolean;
  }>;
  for (const entry of entries) {
    const relativePath = relativeDir
      ? `${relativeDir.replace(/\\/g, "/")}/${entry.name}`
      : entry.name;
    if (entry.isDirectory()) {
      await walkWorkspace(runtime, rootDir, relativePath, output);
    } else if (entry.isFile()) {
      const stat = await runtime.stat(runtime.join(rootDir, relativePath));
      output.push({ path: relativePath.replace(/\\/g, "/"), bytes: stat.size });
    }
  }
}

function getWorkspaceRoot(runtime: WorkspaceRuntime, runId: string): string {
  const safeRunId =
    runId.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
  return runtime.join(runtime.tmpdir(), WORKSPACE_FOLDER, safeRunId);
}

function loadWorkspaceRuntime(): WorkspaceRuntime {
  const fs = requireNodeModule<typeof import("fs/promises")>(
    "fs/promises",
    "code_workspace",
  );
  const os = requireNodeModule<typeof import("os")>("os", "code_workspace");
  const path = requireNodeModule<typeof import("path")>(
    "path",
    "code_workspace",
  );
  return {
    mkdir: fs.mkdir,
    readFile: fs.readFile,
    readdir: fs.readdir,
    rm: fs.rm,
    stat: fs.stat,
    writeFile: fs.writeFile,
    tmpdir: os.tmpdir,
    basename: path.basename,
    dirname: path.dirname,
    join: path.join,
    normalize: path.normalize,
    resolve: path.resolve,
    sep: path.sep,
  };
}
