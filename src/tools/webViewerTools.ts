import { verifySourceNote } from "../agent/verification";
import type { AgentTool, ToolExecutionContext } from "./types";
import { ToolExecutionError } from "./types";
import { getRequiredString, getOptionalString } from "./validation";

const SOURCE_FOLDER = "Agent Sources";
const SOURCE_OPEN_INTENT_PATTERN =
  /\b(open|view|show|launch)\b[\s\S]{0,100}\b(source|sources|link|url|web|browser|reference|citation|page)\b|\b(source|sources|link|url|web\s+page|reference|citation|page)\b[\s\S]{0,100}\b(open|view|show|launch)\b/i;

export function createWebViewerTools(): AgentTool[] {
  return [openWebSourceTool];
}

export const openWebSourceTool: AgentTool = {
  name: "open_web_source",
  description:
    "Open an explicit HTTP/HTTPS source URL in the system browser and create or update a source receipt note.",
  parameters: {
    type: "object",
    required: ["url"],
    properties: {
      url: {
        type: "string",
        description: "HTTP or HTTPS source URL to open.",
      },
      title: {
        type: "string",
        description: "Optional source title for the receipt note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertSourceOpenIntent(context);
    const url = normalizeSourceUrl(getRequiredString(args, "url"));
    const title = getOptionalString(args, "title")?.trim();
    const timestamp = (context.now?.() ?? new Date()).toISOString();
    const path = getSourceNotePath(url);

    await ensureFolderPath(context, SOURCE_FOLDER);

    const existing = context.app.vault.getFileByPath(path);
    const note = existing
      ? await context.app.vault.read(existing)
      : buildNewSourceNote(url, title, timestamp);
    const updated = existing
      ? appendOpenEvent(note, url, timestamp)
      : note;
    const verification = verifySourceNote(updated, url);
    if (!verification.ok) {
      throw new Error(`Source note verification failed: ${verification.errors.join(" ")}`);
    }

    if (existing) {
      await context.app.vault.modify(existing, updated);
    } else {
      await context.app.vault.create(path, updated);
    }

    const openResult = openBrowserWindow(url);

    return {
      operation: existing ? "update_source_note" : "create_source_note",
      path,
      url,
      opened: openResult.opened,
      fallback: openResult.fallback,
      bytesWritten: getByteLength(updated),
    };
  },
};

function assertSourceOpenIntent(context: ToolExecutionContext) {
  if (!SOURCE_OPEN_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new ToolExecutionError(
      "intent_required",
      "open_web_source requires the user to explicitly ask to open, view, show, or launch a source URL.",
    );
  }
}

function normalizeSourceUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new ToolExecutionError("invalid_arguments", "open_web_source URL is invalid.");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolExecutionError(
      "invalid_arguments",
      "open_web_source only supports HTTP and HTTPS URLs.",
    );
  }

  if (url.username || url.password) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "open_web_source URLs with credentials are not allowed.",
    );
  }

  return url.toString();
}

function getSourceNotePath(url: string): string {
  const parsed = new URL(url);
  const sourceName = `${parsed.hostname}${parsed.pathname}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 70) || "source";
  return `${SOURCE_FOLDER}/${sourceName}-${hashUrl(url)}.md`;
}

function buildNewSourceNote(
  url: string,
  title: string | undefined,
  timestamp: string,
): string {
  const heading = title || new URL(url).hostname;
  return [
    `# ${heading}`,
    "",
    `Source URL: ${url}`,
    `Opened: ${timestamp}`,
    "",
    "## Open Events",
    `- ${timestamp} - ${url}`,
    "",
  ].join("\n");
}

function appendOpenEvent(content: string, url: string, timestamp: string): string {
  const line = `- ${timestamp} - ${url}`;
  const withUpdatedTimestamp = /^Opened:\s*.+$/im.test(content)
    ? content.replace(/^Opened:\s*.+$/im, `Opened: ${timestamp}`)
    : `${content.replace(/\s+$/g, "")}\nOpened: ${timestamp}\n`;
  const base = withUpdatedTimestamp.endsWith("\n")
    ? withUpdatedTimestamp
    : `${withUpdatedTimestamp}\n`;

  if (/^## Open Events\s*$/im.test(base)) {
    return `${base}${line}\n`;
  }

  return `${base}\n## Open Events\n${line}\n`;
}

function openBrowserWindow(url: string): { opened: boolean; fallback: string | null } {
  try {
    if (typeof window === "undefined" || typeof window.open !== "function") {
      return {
        opened: false,
        fallback: url,
      };
    }

    const openedWindow = window.open(url, "_blank", "noopener,noreferrer");
    return {
      opened: Boolean(openedWindow),
      fallback: openedWindow ? null : url,
    };
  } catch {
    return {
      opened: false,
      fallback: url,
    };
  }
}

async function ensureFolderPath(
  context: ToolExecutionContext,
  path: string,
): Promise<void> {
  const parts = path.split("/");
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    if (context.app.vault.getFileByPath(currentPath)) {
      throw new Error(`Cannot create folder because a file exists at: ${currentPath}`);
    }

    if (!context.app.vault.getFolderByPath(currentPath)) {
      await context.app.vault.createFolder(currentPath);
    }
  }
}

function hashUrl(url: string): string {
  let hash = 2166136261;
  for (let index = 0; index < url.length; index += 1) {
    hash ^= url.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
