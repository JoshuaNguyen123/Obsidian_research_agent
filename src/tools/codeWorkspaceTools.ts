import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
  normalizeVaultPath,
} from "./validation";
import {
  assertSafeWorkspaceRelativePath,
  ensureCodeWorkspace,
  listWorkspaceFiles,
  readWorkspaceFile,
  writeWorkspaceFile,
} from "../agent/codeWorkspace";
import {
  buildHtmlPreviewDocument,
  HTML_PREVIEW_IFRAME_SANDBOX,
} from "../ui/htmlPreview";
import { requireNodeModule } from "../platform/nodeRequire";

const ARTIFACT_FOLDER = "Agent Artifacts";
const MAX_WORKSPACE_READ_CHARS = 60_000;
const WORKSPACE_MANIFEST_PATH = ".agent-workspace.json";

export function createCodeWorkspaceTools(): AgentTool[] {
  return [
    writeWorkspaceFileTool,
    readWorkspaceFileTool,
    listWorkspaceFilesTool,
    replaceWorkspaceTextTool,
    previewWorkspaceHtmlTool,
    exportWorkspaceArtifactTool,
    installCodeDependencyTool,
  ];
}

const writeWorkspaceFileTool: AgentTool = {
  name: "write_workspace_file",
  description:
    "Write a UTF-8 text file into this run's temporary code workspace using a safe workspace-relative path.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "write_workspace_file");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    const result = await writeWorkspaceFile(
      workspace,
      getRequiredString(args, "path"),
      getRequiredString(args, "content"),
    );
    return {
      operation: "write_workspace_file",
      runId: workspace.runId,
      workspaceRoot: workspace.rootDir,
      ...result,
    };
  },
};

const readWorkspaceFileTool: AgentTool = {
  name: "read_workspace_file",
  description:
    "Read a UTF-8 text file from this run's temporary code workspace using a safe workspace-relative path.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      maxChars: { type: "integer" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "read_workspace_file");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    return {
      operation: "read_workspace_file",
      runId: workspace.runId,
      ...(await readWorkspaceFile(
        workspace,
        getRequiredString(args, "path"),
        Math.min(
          MAX_WORKSPACE_READ_CHARS,
          Math.max(1, getOptionalInteger(args, "maxChars") ?? 20_000),
        ),
      )),
    };
  },
};

const listWorkspaceFilesTool: AgentTool = {
  name: "list_workspace_files",
  description: "List files in this run's temporary code workspace.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(_args, context) {
    assertCodeIntent(context, "list_workspace_files");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    return {
      operation: "list_workspace_files",
      runId: workspace.runId,
      files: await listWorkspaceFiles(workspace),
    };
  },
};

const replaceWorkspaceTextTool: AgentTool = {
  name: "replace_workspace_text",
  description:
    "Replace text in a workspace file. Set replaceAll=true to replace every occurrence; default replaces the first match only.",
  parameters: {
    type: "object",
    required: ["path", "find", "replace"],
    properties: {
      path: { type: "string" },
      find: { type: "string" },
      replace: { type: "string" },
      replaceAll: { type: "boolean" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "replace_workspace_text");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    const path = getRequiredString(args, "path");
    assertSafeWorkspaceRelativePath(path);
    const find = getRequiredString(args, "find");
    const replace = getRequiredString(args, "replace");
    const replaceAll = getOptionalBoolean(args, "replaceAll") === true;
    if (!find) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "replace_workspace_text requires a non-empty find string.",
      );
    }
    const current = await readWorkspaceFile(
      workspace,
      path,
      MAX_WORKSPACE_READ_CHARS,
    );
    if (!current.content.includes(find)) {
      throw new ToolExecutionError(
        "not_found",
        `No match for find text in ${path}.`,
      );
    }
    const next = replaceAll
      ? current.content.split(find).join(replace)
      : current.content.replace(find, replace);
    const replacements = replaceAll
      ? current.content.split(find).length - 1
      : 1;
    const written = await writeWorkspaceFile(workspace, path, next);
    await maybeWriteWorkspaceManifest(workspace, {
      lastOp: "replace_workspace_text",
      path: written.path,
      replacements,
    });
    return {
      operation: "replace_workspace_text",
      runId: workspace.runId,
      path: written.path,
      replacements,
      replaceAll,
      bytesWritten: written.bytesWritten,
    };
  },
};

const previewWorkspaceHtmlTool: AgentTool = {
  name: "preview_workspace_html",
  description:
    "Load HTML (and optional CSS) from the run workspace and return a CSP script-src-none sandboxed preview document.",
  parameters: {
    type: "object",
    required: ["htmlPath"],
    properties: {
      htmlPath: { type: "string" },
      cssPath: { type: "string" },
      title: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "preview_workspace_html");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    const htmlPath = getRequiredString(args, "htmlPath");
    assertSafeWorkspaceRelativePath(htmlPath);
    const html = await readWorkspaceFile(
      workspace,
      htmlPath,
      MAX_WORKSPACE_READ_CHARS,
    );
    const cssPath = getOptionalString(args, "cssPath");
    let body = html.content;
    if (cssPath) {
      assertSafeWorkspaceRelativePath(cssPath);
      const css = await readWorkspaceFile(
        workspace,
        cssPath,
        MAX_WORKSPACE_READ_CHARS,
      );
      body = `<style>\n${css.content}\n</style>\n${body}`;
    }
    const title = getOptionalString(args, "title") ?? "Workspace HTML Preview";
    const previewHtml = buildHtmlPreviewDocument(body, { title });
    if (!/script-src\s+'none'/i.test(previewHtml)) {
      throw new ToolExecutionError(
        "verification_failed",
        "HTML preview CSP must include script-src 'none'.",
      );
    }
    return {
      operation: "preview_workspace_html",
      runId: workspace.runId,
      htmlPath: html.path,
      ...(cssPath ? { cssPath } : {}),
      sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
      previewHtml,
      bytesRendered: new TextEncoder().encode(previewHtml).length,
    };
  },
};

const exportWorkspaceArtifactTool: AgentTool = {
  name: "export_workspace_artifact",
  description:
    "Copy a text workspace artifact into a markdown note under Agent Artifacts as a fenced block with a receipt.",
  parameters: {
    type: "object",
    required: ["workspacePath", "vaultPath"],
    properties: {
      workspacePath: { type: "string" },
      vaultPath: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "export_workspace_artifact");
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    const workspacePath = getRequiredString(args, "workspacePath");
    const read = await readWorkspaceFile(
      workspace,
      workspacePath,
      MAX_WORKSPACE_READ_CHARS,
    );
    const vaultPath = normalizeArtifactPath(getRequiredString(args, "vaultPath"));
    await ensureParentFolder(context, vaultPath);
    const fence = chooseFence(read.content);
    const content = [
      `# ${basenameWithoutExtension(vaultPath)}`,
      "",
      `Source workspace path: \`${read.path}\``,
      "",
      `${fence}`,
      read.content,
      `${fence}`,
      "",
    ].join("\n");
    await createOrReplaceVaultFile(context, vaultPath, content);
    return {
      status: "ok",
      operation: "create",
      path: vaultPath,
      workspacePath: read.path,
      bytesWritten: new TextEncoder().encode(content).length,
      truncated: read.truncated,
      receipt: {
        operation: "create",
        path: vaultPath,
        bytesWritten: new TextEncoder().encode(content).length,
      },
    };
  },
};

const installCodeDependencyTool: AgentTool = {
  name: "install_code_dependency",
  description:
    "Install one npm or pip dependency for this run's code workspace. Always requires approval.",
  parameters: {
    type: "object",
    required: ["manager", "packageName"],
    properties: {
      manager: { type: "string", enum: ["pip", "npm"] },
      packageName: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "install_code_dependency");
    const manager = getRequiredString(args, "manager");
    const packageName = getRequiredString(args, "packageName");
    if (manager !== "pip" && manager !== "npm") {
      throw new ToolExecutionError(
        "invalid_arguments",
        "install_code_dependency manager must be pip or npm.",
      );
    }
    if (!/^[A-Za-z0-9@._/-]+$/.test(packageName)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "Package name contains unsupported characters.",
      );
    }
    if (context.userApprovalGranted !== true) {
      return {
        status: "requires_approval",
        toolName: "install_code_dependency",
        reason: `Installing ${manager} package ${packageName} changes the local environment.`,
        approval: {
          action: `install ${manager} dependency ${packageName}`,
          reason: `Installing ${manager} package ${packageName} changes the local environment.`,
          policyTags: ["install_code_dependency"],
          expiresInMs: 120_000,
        },
      };
    }

    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    const result =
      manager === "pip"
        ? await runInstallProcess(
            { command: "py", args: ["-m", "pip", "install", "--user", packageName] },
            context,
          )
        : await runInstallProcess(
            {
              command: "npm",
              args: ["install", "--prefix", workspace.rootDir, packageName],
            },
            context,
          );
    return {
      status: "ok",
      operation: "install_code_dependency",
      manager,
      packageName,
      exitCode: result.exitCode,
      stdout: truncate(result.stdout, 20_000),
      stderr: truncate(result.stderr, 20_000),
    };
  },
};

function assertCodeIntent(context: ToolExecutionContext, toolName: string) {
  if (
    !/\b(code|script|program|python|javascript|typescript|npm|pip|dependency|artifact|workspace|html|css|preview)\b/i.test(
      context.originalPrompt,
    )
  ) {
    throw new ToolExecutionError(
      "intent_required",
      `${toolName} requires an explicit code, dependency, artifact, or workspace request.`,
    );
  }
}

async function maybeWriteWorkspaceManifest(
  workspace: { runId: string; rootDir: string },
  patch: Record<string, unknown>,
): Promise<void> {
  try {
    let existing: Record<string, unknown> = {
      version: 1,
      runId: workspace.runId,
    };
    try {
      const prior = await readWorkspaceFile(
        workspace,
        WORKSPACE_MANIFEST_PATH,
        20_000,
      );
      const parsed = JSON.parse(prior.content) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // Optional manifest — create on first write.
    }
    await writeWorkspaceFile(
      workspace,
      WORKSPACE_MANIFEST_PATH,
      `${JSON.stringify(
        {
          ...existing,
          ...patch,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    );
  } catch {
    // Manifest is best-effort and must not fail the primary edit.
  }
}

function normalizeArtifactPath(path: string): string {
  const normalized = normalizeVaultPath(path, { requireMarkdown: true });
  return normalized.startsWith(`${ARTIFACT_FOLDER}/`)
    ? normalized
    : normalizeVaultPath(`${ARTIFACT_FOLDER}/${normalized}`, {
        requireMarkdown: true,
      });
}

async function ensureParentFolder(
  context: ToolExecutionContext,
  path: string,
): Promise<void> {
  const segments = path.split("/").slice(0, -1);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    if (!context.app.vault.getFolderByPath(current)) {
      await context.app.vault.createFolder(current);
    }
  }
}

async function createOrReplaceVaultFile(
  context: ToolExecutionContext,
  path: string,
  content: string,
): Promise<void> {
  const existing = context.app.vault.getFileByPath(path);
  if (existing) {
    await context.app.vault.modify(existing, content);
    return;
  }
  await context.app.vault.create(path, content);
}

async function runInstallProcess(
  spec: { command: string; args: string[] },
  context: ToolExecutionContext,
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  if (context.abortSignal?.aborted) {
    throw new ToolExecutionError(
      "operation_cancelled",
      "Dependency installation cancelled before it started.",
    );
  }
  const deadlineRemaining =
    typeof context.deadlineAt === "number" && Number.isFinite(context.deadlineAt)
      ? context.deadlineAt - Date.now()
      : null;
  if (deadlineRemaining !== null && deadlineRemaining <= 0) {
    throw new ToolExecutionError(
      "operation_deadline_exceeded",
      "Dependency installation skipped because the run deadline expired.",
    );
  }
  const { spawn } = requireNodeModule<typeof import("child_process")>(
    "child_process",
    "install_code_dependency",
  );
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let stopReason: "cancelled" | "deadline" | null = null;
    const abortHandler = () => {
      stopReason = "cancelled";
      child.kill();
    };
    context.abortSignal?.addEventListener("abort", abortHandler, { once: true });
    const deadlineTimer =
      deadlineRemaining === null
        ? null
        : setTimeout(() => {
            stopReason = "deadline";
            child.kill();
          }, Math.max(1, deadlineRemaining));
    const cleanup = () => {
      context.abortSignal?.removeEventListener("abort", abortHandler);
      if (deadlineTimer !== null) {
        clearTimeout(deadlineTimer);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stdout += text;
      context.reportCodeOutput?.({
        runId: context.runId ?? "adhoc",
        stream: "stdout",
        chunk: text,
      });
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8");
      stderr += text;
      context.reportCodeOutput?.({
        runId: context.runId ?? "adhoc",
        stream: "stderr",
        chunk: text,
      });
    });
    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("close", (exitCode) => {
      cleanup();
      if (stopReason) {
        reject(
          new ToolExecutionError(
            stopReason === "cancelled"
              ? "operation_cancelled"
              : "operation_deadline_exceeded",
            stopReason === "cancelled"
              ? "Dependency installation cancelled while running."
              : "Dependency installation stopped at the run deadline.",
          ),
        );
        return;
      }
      resolve({ exitCode, stdout, stderr });
    });
  });
}

function chooseFence(content: string): string {
  return content.includes("```") ? "````" : "```";
}

function basenameWithoutExtension(path: string): string {
  const name = path.split("/").pop() ?? "Artifact";
  return name.replace(/\.md$/i, "") || "Artifact";
}

function truncate(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}\n[truncated]`;
}
