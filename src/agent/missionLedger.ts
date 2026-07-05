import type { TFile } from "obsidian";
import type { LoopBudgetPlan } from "./loopPlanner";
import type { ToolExecutionContext } from "../tools/types";
import { normalizeVaultPath } from "../tools/validation";

const AGENT_RUNS_FOLDER = "Agent Runs";
const LEDGER_HEADING = "## Mission Ledger";
const LEDGER_BLOCK_PATTERN =
  /## Mission Ledger\r?\n```json\r?\n[\s\S]*?\r?\n```/;

export type MissionLedgerStatus =
  | "running"
  | "complete"
  | "blocked"
  | "stopped"
  | "budget";

export type MissionTaskStatus =
  | "pending"
  | "in_progress"
  | "complete"
  | "blocked";

export type MissionEvidenceKind =
  | "vault_note"
  | "web_source"
  | "tool_result"
  | "artifact"
  | "receipt";

export interface MissionTask {
  id: string;
  title: string;
  status: MissionTaskStatus;
  toolNames: string[];
  evidenceIds: string[];
  notes: string;
}

export interface MissionEvidence {
  id: string;
  kind: MissionEvidenceKind;
  title: string;
  path?: string;
  url?: string;
  summary: string;
  confidence: "low" | "medium" | "high";
}

export interface MissionLedger {
  runId: string;
  mission: string;
  route: string;
  createdAt: string;
  updatedAt: string;
  status: MissionLedgerStatus;
  loopBudget: {
    hardCap: number;
    toolStepBudget: number;
    finalizationReserve: number;
    expectedTools: string[];
  };
  tasks: MissionTask[];
  evidence: MissionEvidence[];
  receipts: string[];
  blockers: string[];
  nextActions: string[];
}

export interface MissionLedgerWriteResult {
  path: string;
  bytesWritten: number;
}

export interface MissionLedgerSummary {
  runId: string;
  status: MissionLedgerStatus;
  evidenceCount: number;
  receiptCount: number;
  expectedTools: string[];
  nextAction: string;
}

export function createMissionLedger({
  runId,
  mission,
  route,
  loopBudget,
  now = new Date(),
}: {
  runId: string;
  mission: string;
  route: string;
  loopBudget: LoopBudgetPlan;
  now?: Date;
}): MissionLedger {
  const timestamp = now.toISOString();
  return {
    runId,
    mission,
    route,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "running",
    loopBudget: {
      hardCap: loopBudget.hardCap,
      toolStepBudget: loopBudget.toolStepBudget,
      finalizationReserve: loopBudget.finalizationReserve,
      expectedTools: [...loopBudget.expectedTools],
    },
    tasks: [
      {
        id: "task-1",
        title: "Complete requested mission",
        status: "in_progress",
        toolNames: [],
        evidenceIds: [],
        notes: "",
      },
    ],
    evidence: [],
    receipts: [],
    blockers: [],
    nextActions: [],
  };
}

export function updateMissionLedgerStatus(
  ledger: MissionLedger,
  status: MissionLedgerStatus,
  now = new Date(),
) {
  ledger.status = status;
  ledger.updatedAt = now.toISOString();
  const activeTask = getActiveTask(ledger);
  if (activeTask) {
    activeTask.status =
      status === "complete"
        ? "complete"
        : status === "blocked" || status === "budget"
          ? "blocked"
          : activeTask.status;
  }
}

export function upsertLedgerEvidence(
  ledger: MissionLedger,
  evidence: MissionEvidence,
  now = new Date(),
) {
  const index = ledger.evidence.findIndex((item) => item.id === evidence.id);
  if (index >= 0) {
    ledger.evidence[index] = evidence;
  } else {
    ledger.evidence.push(evidence);
  }
  ledger.updatedAt = now.toISOString();
}

export function markLedgerToolUsed(
  ledger: MissionLedger,
  toolName: string,
  evidenceId?: string,
  now = new Date(),
) {
  const task = getActiveTask(ledger);
  if (!task) {
    return;
  }
  if (!task.toolNames.includes(toolName)) {
    task.toolNames.push(toolName);
  }
  if (evidenceId && !task.evidenceIds.includes(evidenceId)) {
    task.evidenceIds.push(evidenceId);
  }
  ledger.updatedAt = now.toISOString();
}

export function addLedgerReceipt(
  ledger: MissionLedger,
  receiptId: string,
  now = new Date(),
) {
  if (!ledger.receipts.includes(receiptId)) {
    ledger.receipts.push(receiptId);
  }
  ledger.updatedAt = now.toISOString();
}

export function addLedgerBlocker(
  ledger: MissionLedger,
  blocker: string,
  now = new Date(),
) {
  if (blocker.trim() && !ledger.blockers.includes(blocker.trim())) {
    ledger.blockers.push(blocker.trim());
  }
  ledger.updatedAt = now.toISOString();
}

export function setLedgerNextAction(
  ledger: MissionLedger,
  action: string,
  now = new Date(),
) {
  ledger.nextActions = action.trim() ? [action.trim()] : [];
  ledger.updatedAt = now.toISOString();
}

export function summarizeMissionLedger(
  ledger: MissionLedger,
): MissionLedgerSummary {
  return {
    runId: ledger.runId,
    status: ledger.status,
    evidenceCount: ledger.evidence.length,
    receiptCount: ledger.receipts.length,
    expectedTools: [...ledger.loopBudget.expectedTools],
    nextAction: ledger.nextActions[0] ?? "none",
  };
}

export async function writeMissionLedger(
  context: ToolExecutionContext,
  ledger: MissionLedger,
): Promise<MissionLedgerWriteResult | null> {
  if (!hasLedgerVaultApi(context)) {
    return null;
  }

  const vault = context.app.vault;
  const folderPath = normalizeVaultPath(AGENT_RUNS_FOLDER);
  const path = getMissionLedgerPath(ledger.runId);
  const block = formatMissionLedgerBlock(ledger);

  if (!vault.getFolderByPath(folderPath)) {
    try {
      await vault.createFolder(folderPath);
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  const file = vault.getFileByPath(path);
  if (!file) {
    const content = `# Agent Run ${sanitizeRunId(ledger.runId)}\n\n${block}`;
    await vault.create(path, content);
    return {
      path,
      bytesWritten: getByteLength(content),
    };
  }

  const current = await vault.read(file as TFile);
  const next = replaceMissionLedgerBlock(current, block);
  await vault.modify(file as TFile, next);
  return {
    path,
    bytesWritten: getByteLength(block),
  };
}

export async function readMissionLedgerByRunId(
  context: ToolExecutionContext,
  runId: string,
): Promise<{ path: string; ledger: MissionLedger } | null> {
  if (!hasLedgerVaultApi(context)) {
    return null;
  }

  const path = getMissionLedgerPath(runId);
  const file = context.app.vault.getFileByPath(path);
  if (!file) {
    return null;
  }

  const content = await context.app.vault.read(file as TFile);
  const ledger = parseMissionLedgerFromMarkdown(content);
  return ledger ? { path, ledger } : null;
}

export async function readLatestMissionLedger(
  context: ToolExecutionContext,
): Promise<{ path: string; ledger: MissionLedger; mtime: number } | null> {
  if (!hasLedgerVaultApi(context) || typeof context.app.vault.getFiles !== "function") {
    return null;
  }

  const candidates = context.app.vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path))
    .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));

  for (const file of candidates) {
    const content = await context.app.vault.read(file);
    const ledger = parseMissionLedgerFromMarkdown(content);
    if (ledger) {
      return {
        path: file.path,
        ledger,
        mtime: file.stat?.mtime ?? 0,
      };
    }
  }

  return null;
}

export function parseMissionLedgerFromMarkdown(
  markdown: string,
): MissionLedger | null {
  const match = LEDGER_BLOCK_PATTERN.exec(markdown);
  if (!match) {
    return null;
  }

  const json = /```json\r?\n([\s\S]*?)\r?\n```/.exec(match[0])?.[1];
  if (!json) {
    return null;
  }

  try {
    return normalizeMissionLedger(JSON.parse(json));
  } catch {
    return null;
  }
}

export function formatMissionLedgerBlock(ledger: MissionLedger): string {
  return [
    LEDGER_HEADING,
    "```json",
    JSON.stringify(ledger, null, 2),
    "```",
    "",
    "### Mission Summary",
    `- Status: ${ledger.status}`,
    `- Route: ${ledger.route}`,
    `- Expected tools: ${ledger.loopBudget.expectedTools.join(", ") || "none"}`,
    `- Evidence: ${ledger.evidence.length}`,
    `- Receipts: ${ledger.receipts.length}`,
    `- Next action: ${ledger.nextActions[0] ?? "none"}`,
    "",
  ].join("\n");
}

export function getMissionLedgerPath(runId: string): string {
  return normalizeVaultPath(`${AGENT_RUNS_FOLDER}/${sanitizeRunId(runId)}.md`, {
    requireMarkdown: true,
  });
}

function replaceMissionLedgerBlock(current: string, block: string): string {
  if (LEDGER_BLOCK_PATTERN.test(current)) {
    return current.replace(LEDGER_BLOCK_PATTERN, block.trimEnd());
  }

  const separator = current.endsWith("\n") ? "\n" : "\n\n";
  return `${current}${separator}${block}`;
}

function getActiveTask(ledger: MissionLedger): MissionTask | null {
  return (
    ledger.tasks.find((task) => task.status === "in_progress") ??
    ledger.tasks[0] ??
    null
  );
}

function normalizeMissionLedger(value: unknown): MissionLedger | null {
  if (!isRecord(value)) {
    return null;
  }

  const runId = getString(value.runId);
  const mission = getString(value.mission);
  const route = getString(value.route);
  const createdAt = getString(value.createdAt);
  const updatedAt = getString(value.updatedAt);
  const status = getLedgerStatus(value.status);
  const loopBudget = isRecord(value.loopBudget) ? value.loopBudget : {};

  if (!runId || !mission || !route || !createdAt || !updatedAt || !status) {
    return null;
  }

  return {
    runId,
    mission,
    route,
    createdAt,
    updatedAt,
    status,
    loopBudget: {
      hardCap: getNumber(loopBudget.hardCap) ?? 0,
      toolStepBudget: getNumber(loopBudget.toolStepBudget) ?? 0,
      finalizationReserve: getNumber(loopBudget.finalizationReserve) ?? 0,
      expectedTools: getStringArray(loopBudget.expectedTools),
    },
    tasks: Array.isArray(value.tasks)
      ? value.tasks.map(normalizeMissionTask).filter(isMissionTask)
      : [],
    evidence: Array.isArray(value.evidence)
      ? value.evidence.map(normalizeMissionEvidence).filter(isMissionEvidence)
      : [],
    receipts: getStringArray(value.receipts),
    blockers: getStringArray(value.blockers),
    nextActions: getStringArray(value.nextActions),
  };
}

function normalizeMissionTask(value: unknown): MissionTask | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const title = getString(value.title);
  const status = getTaskStatus(value.status);
  const notes = getString(value.notes) ?? "";
  if (!id || !title || !status) {
    return null;
  }
  return {
    id,
    title,
    status,
    toolNames: getStringArray(value.toolNames),
    evidenceIds: getStringArray(value.evidenceIds),
    notes,
  };
}

function normalizeMissionEvidence(value: unknown): MissionEvidence | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id);
  const kind = getEvidenceKind(value.kind);
  const title = getString(value.title);
  const summary = getString(value.summary);
  const confidence = getConfidence(value.confidence);
  if (!id || !kind || !title || !summary || !confidence) {
    return null;
  }
  return {
    id,
    kind,
    title,
    ...(getString(value.path) ? { path: getString(value.path) } : {}),
    ...(getString(value.url) ? { url: getString(value.url) } : {}),
    summary,
    confidence,
  };
}

function isMissionTask(value: MissionTask | null): value is MissionTask {
  return value !== null;
}

function isMissionEvidence(value: MissionEvidence | null): value is MissionEvidence {
  return value !== null;
}

function getLedgerStatus(value: unknown): MissionLedgerStatus | null {
  return value === "running" ||
    value === "complete" ||
    value === "blocked" ||
    value === "stopped" ||
    value === "budget"
    ? value
    : null;
}

function getTaskStatus(value: unknown): MissionTaskStatus | null {
  return value === "pending" ||
    value === "in_progress" ||
    value === "complete" ||
    value === "blocked"
    ? value
    : null;
}

function getEvidenceKind(value: unknown): MissionEvidenceKind | null {
  return value === "vault_note" ||
    value === "web_source" ||
    value === "tool_result" ||
    value === "artifact" ||
    value === "receipt"
    ? value
    : null;
}

function getConfidence(value: unknown): MissionEvidence["confidence"] | null {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : null;
}

function hasLedgerVaultApi(context: ToolExecutionContext): boolean {
  const vault = context.app?.vault;
  return Boolean(
    vault &&
      typeof vault.getFileByPath === "function" &&
      typeof vault.create === "function" &&
      typeof vault.modify === "function" &&
      typeof vault.read === "function" &&
      typeof vault.getFolderByPath === "function" &&
      typeof vault.createFolder === "function",
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  return /already exists/i.test(error instanceof Error ? error.message : String(error));
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

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
