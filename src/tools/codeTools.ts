import {
  verifyCodeRequest,
  verifyHtmlPreviewDocument,
  verifyHtmlPreviewSandbox,
} from "../agent/verification";
import {
  buildHtmlPreviewDocument,
  HTML_PREVIEW_IFRAME_SANDBOX,
} from "../ui/htmlPreview";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import {
  getOptionalInteger,
  getOptionalString,
  getRequiredString,
} from "./validation";
import { requireNodeModule } from "../platform/nodeRequire";
import {
  ensureCodeWorkspace,
  getWorkspaceAbsolutePath,
  assertSafeWorkspaceRelativePath,
} from "../agent/codeWorkspace";

export type SupportedCodeLanguage =
  | "python"
  | "javascript"
  | "typescript"
  | "html"
  | "c"
  | "cpp";

interface ProcessResult {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

interface NodeCodeRuntime {
  spawn: typeof import("child_process").spawn;
  mkdtemp: typeof import("fs/promises").mkdtemp;
  rm: typeof import("fs/promises").rm;
  readFile: typeof import("fs/promises").readFile;
  writeFile: typeof import("fs/promises").writeFile;
  tmpdir: typeof import("os").tmpdir;
  join: typeof import("path").join;
}

const CODE_INTENT_PATTERN =
  /\b(run|execute|eval|evaluate|test|compile|preview|render)\b[\s\S]{0,100}\b(code|script|program|snippet|python|javascript|typescript|html|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|html|c\+\+|cpp|c\s+code)\b[\s\S]{0,100}\b(run|execute|eval|evaluate|test|compile|preview|render)\b/i;
const DEFAULT_TIMEOUT_MS = 5000;
const APPROVAL_TIMEOUT_THRESHOLD_MS = 30000;
const MAX_TIMEOUT_MS = 300000;
const MAX_OUTPUT_CHARS = 20000;

let desktopAppOverride: boolean | null = null;

export function createCodeTools(): AgentTool[] {
  return [runCodeBlockTool, renderHtmlPreviewTool];
}

export function __setCodeToolsDesktopAppForTests(value: boolean | null) {
  desktopAppOverride = value;
}

export function isCodeToolsDesktopRuntime(): boolean {
  return isDesktopApp();
}

export const runCodeBlockTool: AgentTool = {
  name: "run_code_block",
  description:
    "Run an explicitly requested code block locally on desktop with a timeout. Supports Python, JavaScript, TypeScript, HTML preview metadata, and C/C++ compile-run.",
  parameters: {
    type: "object",
    required: ["language"],
    properties: {
      language: {
        type: "string",
        enum: ["python", "javascript", "typescript", "html", "c", "cpp", "c++"],
        description: "Language of the code block.",
      },
      code: {
        type: "string",
        description: "Inline code to run. Omit when entryPath points to a workspace file.",
      },
      entryPath: {
        type: "string",
        description: "Optional workspace-relative file path to run with the workspace root as cwd.",
      },
      args: {
        type: "array",
        items: { type: "string" },
        description: "Optional command arguments passed to the entry file.",
      },
      timeoutMs: {
        type: "integer",
        description: "Execution timeout in milliseconds. Defaults to 5000, maximum 300000; values over 30000 require approval.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "run_code_block");
    assertDesktopApp("run_code_block");
    const language = normalizeLanguage(getRequiredString(args, "language"));
    const code = getOptionalString(args, "code");
    const entryPath = getOptionalString(args, "entryPath");
    const runArgs = getOptionalStringArray(args, "args") ?? [];
    if (!code && !entryPath) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "run_code_block requires either inline code or entryPath.",
      );
    }
    if (code) {
      const requestVerification = verifyCodeRequest(language, code);
      if (!requestVerification.ok) {
        throw new ToolExecutionError(
          "invalid_arguments",
          requestVerification.errors.join(" "),
        );
      }
    }

    const timeoutMs = clampTimeout(getOptionalInteger(args, "timeoutMs"));
    if (
      timeoutMs > APPROVAL_TIMEOUT_THRESHOLD_MS &&
      context.userApprovalGranted !== true
    ) {
      return requiresApprovalOutput("run_code_block", {
        action: `run code for ${timeoutMs}ms`,
        reason: "Code execution timeout exceeds 30000ms.",
        policyTags: ["long_code_timeout"],
        timeoutMs: 120000,
      });
    }

    return executeCode(language, code ?? "", timeoutMs, context, entryPath, runArgs);
  },
};

export const renderHtmlPreviewTool: AgentTool = {
  name: "render_html_preview",
  description:
    "Render an explicitly requested HTML snippet as a sandboxed iframe preview document.",
  parameters: {
    type: "object",
    required: ["html"],
    properties: {
      html: {
        type: "string",
        description: "HTML snippet or document to render in a sandboxed iframe.",
      },
      title: {
        type: "string",
        description: "Optional preview title.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "render_html_preview");
    assertDesktopApp("render_html_preview");
    const html = getRequiredString(args, "html");
    const title = getOptionalString(args, "title");
    const previewHtml = buildHtmlPreviewDocument(html, { title });
    const documentVerification = verifyHtmlPreviewDocument(previewHtml);
    const sandboxVerification = verifyHtmlPreviewSandbox(HTML_PREVIEW_IFRAME_SANDBOX);

    if (!documentVerification.ok || !sandboxVerification.ok) {
      throw new Error(
        [
          ...documentVerification.errors,
          ...sandboxVerification.errors,
        ].join(" "),
      );
    }

    return {
      operation: "render_html_preview",
      sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
      previewHtml,
      bytesRendered: getByteLength(previewHtml),
    };
  },
};

async function executeCode(
  language: SupportedCodeLanguage,
  code: string,
  timeoutMs: number,
  context: ToolExecutionContext,
  entryPath?: string,
  args: string[] = [],
) {
  if (entryPath) {
    const workspace = await ensureCodeWorkspace(context.runId ?? "adhoc");
    assertSafeWorkspaceRelativePath(entryPath);
    const filePath = getWorkspaceAbsolutePath(workspace, entryPath);
    return runLanguageFile(language, filePath, timeoutMs, args, context, workspace.rootDir);
  }

  if (language === "html") {
    const previewHtml = buildHtmlPreviewDocument(code, { title: "HTML Code Preview" });
    const verification = verifyHtmlPreviewDocument(previewHtml);
    if (!verification.ok) {
      throw new Error(`HTML preview verification failed: ${verification.errors.join(" ")}`);
    }

    return {
      language,
      operation: "render_html_preview",
      sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
      previewHtml,
      bytesRendered: getByteLength(previewHtml),
    };
  }

  const runtime = await loadNodeCodeRuntime();
  const tempDir = await runtime.mkdtemp(
    runtime.join(runtime.tmpdir(), "agentic-researcher-code-"),
  );
  try {
    if (language === "python") {
      const filePath = runtime.join(tempDir, "snippet.py");
      await runtime.writeFile(filePath, code, "utf8");
      return {
        language,
        operation: "run",
        result: await runFirstAvailable(
          [
            { command: "py", args: ["-3", filePath] },
            { command: "python", args: [filePath] },
            { command: "python3", args: [filePath] },
          ],
          timeoutMs,
          "Python runtime was not found. Install Python or choose another language.",
          context,
        ),
      };
    }

    if (language === "javascript") {
      const filePath = runtime.join(tempDir, "snippet.mjs");
      await runtime.writeFile(filePath, code, "utf8");
      return {
        language,
        operation: "run",
        result: await runFirstAvailable(
          [{ command: "node", args: [filePath] }],
          timeoutMs,
          "Node.js runtime was not found. Install Node.js or choose another language.",
          context,
        ),
      };
    }

    if (language === "typescript") {
      const filePath = runtime.join(tempDir, "snippet.ts");
      await runtime.writeFile(filePath, code, "utf8");
      return {
        language,
        operation: "run",
        result: await runTypeScript(filePath, timeoutMs, context),
      };
    }

    return compileAndRunC(language, code, tempDir, timeoutMs, context);
  } finally {
    await runtime.rm(tempDir, { recursive: true, force: true });
  }
}

async function loadNodeCodeRuntime(): Promise<NodeCodeRuntime> {
  const childProcessModule = requireNodeModule<typeof import("child_process")>(
    "child_process",
    "run_code_block",
  );
  const fsPromisesModule = requireNodeModule<typeof import("fs/promises")>(
    "fs/promises",
    "run_code_block",
  );
  const osModule = requireNodeModule<typeof import("os")>(
    "os",
    "run_code_block",
  );
  const pathModule = requireNodeModule<typeof import("path")>(
    "path",
    "run_code_block",
  );

  return {
    spawn: childProcessModule.spawn,
    mkdtemp: fsPromisesModule.mkdtemp,
    rm: fsPromisesModule.rm,
    readFile: fsPromisesModule.readFile,
    writeFile: fsPromisesModule.writeFile,
    tmpdir: osModule.tmpdir,
    join: pathModule.join,
  };
}

async function runLanguageFile(
  language: SupportedCodeLanguage,
  filePath: string,
  timeoutMs: number,
  args: string[],
  context: ToolExecutionContext,
  cwd: string,
) {
  const runtime = await loadNodeCodeRuntime();

  if (language === "html") {
    const html = await runtime.readFile(filePath, "utf8");
    const previewHtml = buildHtmlPreviewDocument(html, {
      title: "HTML Code Preview",
    });
    const verification = verifyHtmlPreviewDocument(previewHtml);
    if (!verification.ok) {
      throw new Error(`HTML preview verification failed: ${verification.errors.join(" ")}`);
    }
    return {
      language,
      operation: "render_html_preview",
      sandbox: HTML_PREVIEW_IFRAME_SANDBOX,
      previewHtml,
      bytesRendered: getByteLength(previewHtml),
    };
  }

  if (language === "python") {
    return {
      language,
      operation: "run",
      result: await runFirstAvailable(
        [
          { command: "py", args: ["-3", filePath, ...args], cwd },
          { command: "python", args: [filePath, ...args], cwd },
          { command: "python3", args: [filePath, ...args], cwd },
        ],
        timeoutMs,
        "Python runtime was not found. Install Python or choose another language.",
        context,
      ),
    };
  }

  if (language === "javascript") {
    return {
      language,
      operation: "run",
      result: await runFirstAvailable(
        [{ command: "node", args: [filePath, ...args], cwd }],
        timeoutMs,
        "Node.js runtime was not found. Install Node.js or choose another language.",
        context,
      ),
    };
  }

  if (language === "typescript") {
    return {
      language,
      operation: "run",
      result: await runTypeScript(filePath, timeoutMs, context, cwd, args),
    };
  }

  const binaryPath = runtime.join(
    cwd,
    process.platform === "win32" ? ".agent-run.exe" : ".agent-run",
  );
  const compilerCandidates =
    language === "c"
      ? [
          { command: "gcc", args: [filePath, "-o", binaryPath], cwd },
          { command: "clang", args: [filePath, "-o", binaryPath], cwd },
        ]
      : [
          { command: "g++", args: [filePath, "-o", binaryPath], cwd },
          { command: "clang++", args: [filePath, "-o", binaryPath], cwd },
        ];
  const compile = await runFirstAvailable(
    compilerCandidates,
    timeoutMs,
    `${language === "c" ? "C" : "C++"} compiler was not found. Install gcc, clang, g++, or clang++; no runtime was installed.`,
    context,
  );
  if (compile.timedOut || compile.exitCode !== 0) {
    return {
      language,
      operation: "compile",
      compile,
      run: null,
    };
  }

  return {
    language,
    operation: "compile_run",
    compile,
    run: await runProcess(
      { command: binaryPath, args, cwd },
      timeoutMs,
      { context },
    ),
  };
}

async function runTypeScript(
  filePath: string,
  timeoutMs: number,
  context: ToolExecutionContext,
  cwd?: string,
  args: string[] = [],
): Promise<ProcessResult> {
  const nodeResult = await runFirstAvailable(
    [{ command: "node", args: ["--experimental-strip-types", filePath, ...args], cwd }],
    timeoutMs,
    "Node.js runtime was not found. Install Node.js or choose another language.",
    context,
  );

  if (
    nodeResult.exitCode !== 0 &&
    /bad option|unknown option|experimental-strip-types/i.test(nodeResult.stderr)
  ) {
    return runFirstAvailable(
      [{ command: "npx", args: ["--no-install", "tsx", filePath, ...args], cwd }],
      timeoutMs,
      "TypeScript execution requires Node.js with type stripping or a local tsx runtime. No runtime was installed.",
      context,
    );
  }

  return nodeResult;
}

async function compileAndRunC(
  language: "c" | "cpp",
  code: string,
  tempDir: string,
  timeoutMs: number,
  context: ToolExecutionContext,
) {
  const runtime = await loadNodeCodeRuntime();
  const sourcePath = runtime.join(
    tempDir,
    language === "c" ? "snippet.c" : "snippet.cpp",
  );
  const binaryPath = runtime.join(
    tempDir,
    process.platform === "win32" ? "snippet.exe" : "snippet",
  );
  await runtime.writeFile(sourcePath, code, "utf8");

  const compilerCandidates =
    language === "c"
      ? [
          { command: "gcc", args: [sourcePath, "-o", binaryPath] },
          { command: "clang", args: [sourcePath, "-o", binaryPath] },
        ]
      : [
          { command: "g++", args: [sourcePath, "-o", binaryPath] },
          { command: "clang++", args: [sourcePath, "-o", binaryPath] },
        ];
  const compile = await runFirstAvailable(
    compilerCandidates,
    timeoutMs,
    `${language === "c" ? "C" : "C++"} compiler was not found. Install gcc, clang, g++, or clang++; no runtime was installed.`,
    context,
  );

  if (compile.timedOut || compile.exitCode !== 0) {
    return {
      language,
      operation: "compile",
      compile,
      run: null,
    };
  }

  return {
    language,
    operation: "compile_run",
    compile,
    run: await runProcess({ command: binaryPath, args: [] }, timeoutMs, { context }),
  };
}

async function runFirstAvailable(
  candidates: Array<{ command: string; args: string[]; cwd?: string }>,
  timeoutMs: number,
  missingMessage: string,
  context: ToolExecutionContext,
): Promise<ProcessResult> {
  const missingErrors: string[] = [];

  for (const candidate of candidates) {
    try {
      return await runProcess(candidate, timeoutMs, { context });
    } catch (error) {
      if (isMissingRuntimeError(error)) {
        missingErrors.push(`${candidate.command}: ${getErrorMessage(error)}`);
        continue;
      }

      throw error;
    }
  }

  throw new ToolExecutionError(
    "missing_runtime",
    `${missingMessage}${missingErrors.length ? ` Checked: ${missingErrors.join("; ")}` : ""}`,
  );
}

function runProcess(
  spec: { command: string; args: string[]; cwd?: string },
  timeoutMs: number,
  options: { context?: ToolExecutionContext } = {},
): Promise<ProcessResult> {
  const startedAt = Date.now();
  const context = options.context;
  const abortSignal = context?.abortSignal;
  const deadlineRemaining =
    typeof context?.deadlineAt === "number" && Number.isFinite(context.deadlineAt)
      ? context.deadlineAt - Date.now()
      : timeoutMs;
  const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, deadlineRemaining));

  if (abortSignal?.aborted) {
    return Promise.reject(
      new ToolExecutionError(
        "operation_cancelled",
        "Code execution cancelled before the process started.",
      ),
    );
  }
  if (deadlineRemaining <= 0) {
    return Promise.reject(
      new ToolExecutionError(
        "operation_deadline_exceeded",
        "Code execution skipped because the run deadline expired.",
      ),
    );
  }

  return new Promise((resolve, reject) => {
    loadNodeCodeRuntime().then(({ spawn }) => {
      if (abortSignal?.aborted) {
        reject(
          new ToolExecutionError(
            "operation_cancelled",
            "Code execution cancelled before the process started.",
          ),
        );
        return;
      }
      const child = spawn(spec.command, spec.args, {
        shell: false,
        windowsHide: true,
        cwd: spec.cwd,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let cancelled = false;
      const abortHandler = () => {
        cancelled = true;
        child.kill();
      };
      abortSignal?.addEventListener("abort", abortHandler, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, effectiveTimeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stdout = truncateOutput(`${stdout}${text}`);
        options.context?.reportCodeOutput?.({
          runId: options.context.runId ?? "adhoc",
          stream: "stdout",
          chunk: text,
        });
      });
      child.stderr.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        stderr = truncateOutput(`${stderr}${text}`);
        options.context?.reportCodeOutput?.({
          runId: options.context.runId ?? "adhoc",
          stream: "stderr",
          chunk: text,
        });
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        abortSignal?.removeEventListener("abort", abortHandler);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
        abortSignal?.removeEventListener("abort", abortHandler);
        if (cancelled) {
          reject(
            new ToolExecutionError(
              "operation_cancelled",
              "Code execution cancelled while the process was running.",
            ),
          );
          return;
        }
        resolve({
          command: spec.command,
          args: spec.args,
          exitCode,
          stdout,
          stderr,
          timedOut,
          durationMs: Date.now() - startedAt,
        });
      });
    }).catch(reject);
  });
}

function assertCodeIntent(context: ToolExecutionContext, toolName: string) {
  if (!CODE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new ToolExecutionError(
      "intent_required",
      `${toolName} requires the user to explicitly ask to run, execute, compile, render, or preview code.`,
    );
  }
}

function assertDesktopApp(toolName: string) {
  if (!isDesktopApp()) {
    throw new ToolExecutionError(
      "desktop_required",
      `${toolName} is only available in the Obsidian desktop app.`,
    );
  }
}

function isDesktopApp(): boolean {
  if (desktopAppOverride !== null) {
    return desktopAppOverride;
  }

  return getObsidianPlatform().isDesktopApp === true;
}

function getObsidianPlatform(): { isDesktopApp?: boolean } {
  try {
    const maybeRequire = typeof require === "function" ? require : null;
    const module = maybeRequire?.("obsidian") as
      | { Platform?: { isDesktopApp?: boolean } }
      | undefined;
    if (module?.Platform) {
      return module.Platform;
    }
  } catch {
    // Tests do not load Obsidian's runtime module.
  }

  return (globalThis as { Platform?: { isDesktopApp?: boolean } }).Platform ?? {};
}

function normalizeLanguage(language: string): SupportedCodeLanguage {
  const normalized = language.trim().toLowerCase();

  if (normalized === "js" || normalized === "node") {
    return "javascript";
  }

  if (normalized === "ts") {
    return "typescript";
  }

  if (normalized === "c++") {
    return "cpp";
  }

  if (
    normalized === "python" ||
    normalized === "javascript" ||
    normalized === "typescript" ||
    normalized === "html" ||
    normalized === "c" ||
    normalized === "cpp"
  ) {
    return normalized;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    `Unsupported code language: ${language}.`,
  );
}

function clampTimeout(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  return Math.min(Math.max(value, 1000), MAX_TIMEOUT_MS);
}

function getOptionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be an array of strings.`,
    );
  }
  return value as string[];
}

function requiresApprovalOutput(
  toolName: string,
  approval: {
    action: string;
    reason: string;
    policyTags: string[];
    timeoutMs: number;
  },
) {
  return {
    status: "requires_approval",
    toolName,
    reason: approval.reason,
    approval: {
      action: approval.action,
      reason: approval.reason,
      policyTags: approval.policyTags,
      expiresInMs: approval.timeoutMs,
    },
  };
}

function isMissingRuntimeError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function truncateOutput(value: string): string {
  if (value.length <= MAX_OUTPUT_CHARS) {
    return value;
  }

  return `${value.slice(0, MAX_OUTPUT_CHARS)}\n[truncated]`;
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
