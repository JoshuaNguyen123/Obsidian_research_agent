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
  writeFile: typeof import("fs/promises").writeFile;
  tmpdir: typeof import("os").tmpdir;
  join: typeof import("path").join;
}

const CODE_INTENT_PATTERN =
  /\b(run|execute|eval|evaluate|test|compile|preview|render)\b[\s\S]{0,100}\b(code|script|program|snippet|python|javascript|typescript|html|c\+\+|cpp|c\s+code)\b|\b(code|script|program|snippet|python|javascript|typescript|html|c\+\+|cpp|c\s+code)\b[\s\S]{0,100}\b(run|execute|eval|evaluate|test|compile|preview|render)\b/i;
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const MAX_OUTPUT_CHARS = 20000;

let desktopAppOverride: boolean | null = null;

export function createCodeTools(): AgentTool[] {
  return [runCodeBlockTool, renderHtmlPreviewTool];
}

export function __setCodeToolsDesktopAppForTests(value: boolean | null) {
  desktopAppOverride = value;
}

export const runCodeBlockTool: AgentTool = {
  name: "run_code_block",
  description:
    "Run an explicitly requested code block locally on desktop with a timeout. Supports Python, JavaScript, TypeScript, HTML preview metadata, and C/C++ compile-run.",
  parameters: {
    type: "object",
    required: ["language", "code"],
    properties: {
      language: {
        type: "string",
        enum: ["python", "javascript", "typescript", "html", "c", "cpp", "c++"],
        description: "Language of the code block.",
      },
      code: {
        type: "string",
        description: "Code to run.",
      },
      timeoutMs: {
        type: "integer",
        description: "Execution timeout in milliseconds. Defaults to 5000, maximum 30000.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCodeIntent(context, "run_code_block");
    assertDesktopApp("run_code_block");
    const language = normalizeLanguage(getRequiredString(args, "language"));
    const code = getRequiredString(args, "code");
    const requestVerification = verifyCodeRequest(language, code);
    if (!requestVerification.ok) {
      throw new ToolExecutionError(
        "invalid_arguments",
        requestVerification.errors.join(" "),
      );
    }

    const timeoutMs = clampTimeout(getOptionalInteger(args, "timeoutMs"));
    return executeCode(language, code, timeoutMs);
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
) {
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
        ),
      };
    }

    if (language === "typescript") {
      const filePath = runtime.join(tempDir, "snippet.ts");
      await runtime.writeFile(filePath, code, "utf8");
      return {
        language,
        operation: "run",
        result: await runTypeScript(filePath, timeoutMs),
      };
    }

    return compileAndRunC(language, code, tempDir, timeoutMs);
  } finally {
    await runtime.rm(tempDir, { recursive: true, force: true });
  }
}

async function loadNodeCodeRuntime(): Promise<NodeCodeRuntime> {
  const [
    childProcessModule,
    fsPromisesModule,
    osModule,
    pathModule,
  ] = await Promise.all([
    import("child_process"),
    import("fs/promises"),
    import("os"),
    import("path"),
  ]);

  return {
    spawn: childProcessModule.spawn,
    mkdtemp: fsPromisesModule.mkdtemp,
    rm: fsPromisesModule.rm,
    writeFile: fsPromisesModule.writeFile,
    tmpdir: osModule.tmpdir,
    join: pathModule.join,
  };
}

async function runTypeScript(
  filePath: string,
  timeoutMs: number,
): Promise<ProcessResult> {
  const nodeResult = await runFirstAvailable(
    [{ command: "node", args: ["--experimental-strip-types", filePath] }],
    timeoutMs,
    "Node.js runtime was not found. Install Node.js or choose another language.",
  );

  if (
    nodeResult.exitCode !== 0 &&
    /bad option|unknown option|experimental-strip-types/i.test(nodeResult.stderr)
  ) {
    return runFirstAvailable(
      [{ command: "npx", args: ["--no-install", "tsx", filePath] }],
      timeoutMs,
      "TypeScript execution requires Node.js with type stripping or a local tsx runtime. No runtime was installed.",
    );
  }

  return nodeResult;
}

async function compileAndRunC(
  language: "c" | "cpp",
  code: string,
  tempDir: string,
  timeoutMs: number,
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
    run: await runProcess({ command: binaryPath, args: [] }, timeoutMs),
  };
}

async function runFirstAvailable(
  candidates: Array<{ command: string; args: string[] }>,
  timeoutMs: number,
  missingMessage: string,
): Promise<ProcessResult> {
  const missingErrors: string[] = [];

  for (const candidate of candidates) {
    try {
      return await runProcess(candidate, timeoutMs);
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
  spec: { command: string; args: string[] },
  timeoutMs: number,
): Promise<ProcessResult> {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    loadNodeCodeRuntime().then(({ spawn }) => {
      const child = spawn(spec.command, spec.args, {
        shell: false,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, timeoutMs);

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = truncateOutput(`${stdout}${chunk.toString("utf8")}`);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = truncateOutput(`${stderr}${chunk.toString("utf8")}`);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (exitCode) => {
        clearTimeout(timeout);
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
