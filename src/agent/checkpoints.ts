import type { TFile } from "obsidian";
import type { RunRoute } from "../AgentRunner";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";

const AGENT_RUNS_FOLDER = "Agent Runs";

export interface AgentRunCheckpoint {
  runId: string;
  step: number;
  maxSteps: number;
  status: string;
  route?: RunRoute;
  message?: string;
  toolNames?: string[];
  timestamp?: Date;
}

export interface AgentRunCheckpointWriteResult {
  path: string;
  bytesWritten: number;
}

export interface LatestAgentRunCheckpoint {
  path: string;
  content: string;
  mtime: number;
}

export function createAgentRunId(now: Date = new Date()): string {
  const timestamp = now.toISOString().replace(/\.\d{3}Z$/, "Z");
  return sanitizeRunId(`run-${timestamp}`);
}

export function getAgentRunCheckpointPath(runId: string): string {
  const sanitizedRunId = sanitizeRunId(runId);
  return normalizeVaultPath(`${AGENT_RUNS_FOLDER}/${sanitizedRunId}.md`, {
    requireMarkdown: true,
  });
}

export async function appendAgentRunCheckpoint(
  context: ToolExecutionContext,
  checkpoint: AgentRunCheckpoint,
): Promise<AgentRunCheckpointWriteResult> {
  const vault = context.app.vault;
  const folderPath = normalizeVaultPath(AGENT_RUNS_FOLDER);
  const path = getAgentRunCheckpointPath(checkpoint.runId);
  const entry = formatCheckpointEntry(checkpoint);

  if (!vault.getFolderByPath(folderPath)) {
    try {
      await vault.createFolder(folderPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  const existingFile = vault.getFileByPath(path);
  if (!existingFile) {
    const content = `# Agent Run ${sanitizeRunId(checkpoint.runId)}\n\n${entry}`;
    await vault.create(path, content);
    return {
      path,
      bytesWritten: getByteLength(content),
    };
  }

  const current = await vault.read(existingFile as TFile);
  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  const next = `${current}${separator}${entry}`;
  await vault.modify(existingFile as TFile, next);

  return {
    path,
    bytesWritten: getByteLength(entry),
  };
}

export async function readLatestAgentRunCheckpoint(
  context: ToolExecutionContext,
  maxChars = 6000,
): Promise<LatestAgentRunCheckpoint | null> {
  const files = context.app.vault.getFiles?.() ?? [];
  const checkpointFiles = files
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path))
    .sort((a, b) => (b.stat?.mtime ?? 0) - (a.stat?.mtime ?? 0));
  const latest = checkpointFiles[0];

  if (!latest) {
    return null;
  }

  const read =
    typeof context.app.vault.cachedRead === "function"
      ? context.app.vault.cachedRead.bind(context.app.vault)
      : context.app.vault.read.bind(context.app.vault);
  const content = await read(latest);

  return {
    path: latest.path,
    content: truncateCheckpointContent(content, maxChars),
    mtime: latest.stat?.mtime ?? 0,
  };
}

export function formatCheckpointEntry(checkpoint: AgentRunCheckpoint): string {
  const timestamp = (checkpoint.timestamp ?? new Date()).toISOString();
  const lines = [
    `## Step ${checkpoint.step} - ${timestamp}`,
    "",
    `- Status: ${checkpoint.status}`,
    `- Step: ${checkpoint.step} of ${checkpoint.maxSteps}`,
  ];

  if (checkpoint.route) {
    lines.push(`- Route: ${checkpoint.route}`);
  }

  if (checkpoint.toolNames && checkpoint.toolNames.length > 0) {
    lines.push(`- Tools: ${checkpoint.toolNames.join(", ")}`);
  }

  if (checkpoint.message?.trim()) {
    lines.push("", checkpoint.message.trim());
  }

  lines.push("");
  return lines.join("\n");
}

function sanitizeRunId(runId: string): string {
  return (
    runId
      .trim()
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120) || "run"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(error instanceof Error ? error.message : String(error));
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function truncateCheckpointContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  return `${content.slice(0, Math.max(0, maxChars))}\n\n[Checkpoint truncated for prompt budget]`;
}
