/**
 * Secret-free diagnostics export for a one-click bug attachment.
 *
 * The builder is pure: it copies only allowlisted fields, redacts secret-shaped
 * strings, and never serializes note bodies, vault paths, command lines, API
 * keys, tokens, or SecretStorage values. The clipboard/file helpers take
 * adapters so unit tests can exercise them without Obsidian.
 */

import {
  buildRunFailureEvidenceV1,
  type RunFailureEvidenceInputV1,
  type RunFailureFactV1,
} from "./runFailureEvidence";
import { normalizeVaultPath } from "../tools/validation";

export const DIAGNOSTICS_EXPORT_SCHEMA_VERSION = 1 as const;
export const DIAGNOSTICS_EXPORT_VAULT_PATH = "Agent Runs/diagnostics-export.md";

const MAX_CLIP_CHARS = 220;

const SECRET_LIKE =
  /\b(?:sk-[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|gho_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._\-+=/]{8,})\b/gi;
const SECRET_ASSIGNMENT =
  /\b(?:api[_-]?key|token|secret|password|authorization|access[_-]?token)\s*[:=]\s*\S+/gi;
const SECRET_STORAGE_VALUE =
  /\b(?:secret_store|SecretStorage|credential_[A-Za-z0-9_-]{8,})\b[^\n]{0,80}/gi;

const NOTE_BODY_KEYS = new Set([
  "content",
  "text",
  "body",
  "note",
  "markdown",
  "prompt",
  "selection",
  "draft",
  "message_content",
]);

const PATH_OR_COMMAND_KEYS = new Set([
  "path",
  "frompath",
  "topath",
  "backuppath",
  "notepath",
  "vaultpath",
  "filepath",
  "cwd",
  "command",
  "executable",
  "args",
  "argv",
  "cmdline",
  "commandline",
  "shell",
]);

export interface DiagnosticsSandboxProbeV1 {
  observedAt: string | null;
  status: {
    mode: string | null;
    executionAvailable: boolean | null;
    editingAvailable: boolean | null;
    selectedProvider: string | null;
    blocker: {
      code: string | null;
      message: string | null;
      requiredAction: string | null;
    } | null;
  } | null;
}

export interface DiagnosticsModelIdentityV1 {
  id: string | null;
  provider: string | null;
}

export interface DiagnosticsLastFailureV1 {
  stopReason: string | null;
  stopDetail: string | null;
  facts: RunFailureFactV1[];
}

export interface DiagnosticsExportInputV1 {
  pluginVersion?: string | null;
  obsidianVersion?: string | null;
  platform?: string | null;
  startupPhase?: string | null;
  /** Load-time instrument from the plugin (`getStartupTiming()`); absent until ready. */
  startupTiming?: {
    coreReadyMs?: number | null;
    phases?: Record<string, number> | null;
    runNoteCount?: number | null;
    layoutReadyAfterMs?: number | null;
    deferred?: Record<string, number> | null;
  } | null;
  sandboxLastProbe?: {
    observedAt?: string | null;
    status?: {
      mode?: string | null;
      executionAvailable?: boolean | null;
      editingAvailable?: boolean | null;
      selectedProvider?: string | null;
      blocker?: {
        code?: string | null;
        message?: string | null;
        requiredAction?: string | null;
      } | null;
    } | null;
  } | null;
  model?: { id?: string | null; provider?: string | null } | null;
  runSnapshot?: DiagnosticsRunSnapshotInputV1 | null;
  generatedAt?: string | null;
}

export interface DiagnosticsRunSnapshotInputV1 {
  isRunning?: boolean;
  stopReason?: string | null;
  stopDetail?: string | null;
  lastComplete?: {
    stopReason?: string | null;
    stopDetail?: string | null;
  } | null;
  lastMissionGraph?: {
    nodes?:
      | Record<
          string,
          {
            id?: string;
            status?: string;
            blocker?: {
              code?: string | null;
              message?: string | null;
              requiredAction?: string | null;
            } | null;
          }
        >
      | readonly {
          id?: string;
          status?: string;
          blocker?: {
            code?: string | null;
            message?: string | null;
            requiredAction?: string | null;
          } | null;
        }[];
    continuationCheckpoint?: { activeNodeIds?: readonly string[] | null } | null;
  } | null;
  diagnosticAttestations?: readonly {
    id?: string | null;
    kind?: string | null;
    toolName?: string | null;
    message?: string | null;
    errorCode?: string | null;
  }[];
  failureEvidence?: RunFailureEvidenceInputV1 | null;
}

export interface DiagnosticsExportReportV1 {
  schemaVersion: typeof DIAGNOSTICS_EXPORT_SCHEMA_VERSION;
  generatedAt: string;
  pluginVersion: string | null;
  obsidianVersion: string | null;
  platform: string | null;
  startupPhase: string | null;
  startup: DiagnosticsStartupTimingV1 | null;
  sandbox: { lastProbe: DiagnosticsSandboxProbeV1 | null };
  model: DiagnosticsModelIdentityV1;
  lastFailure: DiagnosticsLastFailureV1 | null;
}

export interface DiagnosticsClipboardAdapterV1 {
  writeText(text: string): Promise<void>;
}

export interface DiagnosticsVaultAdapterV1 {
  getFileByPath(path: string): { path: string } | null;
  getAbstractFileByPath?(path: string): unknown;
  create(path: string, data: string): Promise<unknown>;
  modify(file: { path: string }, data: string): Promise<unknown>;
  createFolder(path: string): Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clip(value: string, maxChars = MAX_CLIP_CHARS): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

export function redactDiagnosticsSecretsV1(value: string): string {
  return value
    .replace(SECRET_LIKE, "[redacted]")
    .replace(SECRET_ASSIGNMENT, "[redacted]")
    .replace(SECRET_STORAGE_VALUE, "[redacted]");
}

function sanitizeText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const redacted = redactDiagnosticsSecretsV1(value).trim();
  return redacted ? clip(redacted) : null;
}

function sanitizeBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function looksLikeVaultPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.includes("..") || trimmed.includes("\\")) return true;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return true;
  return /(?:^|\/)[^/\s]+\.md(?:$|\s)/i.test(trimmed) || /(?:^|\/)Agent Runs\//i.test(trimmed);
}

function looksLikeCommandLine(value: string): boolean {
  return /^\s*(?:[A-Za-z]:\\|\.\/|\/usr\/|wsl\.exe|docker|podman|bash|cmd(?:\.exe)?)\b/i.test(
    value,
  );
}

function sanitizeIdentity(value: unknown): string | null {
  const text = sanitizeText(value);
  if (!text) return null;
  if (looksLikeVaultPath(text) || looksLikeCommandLine(text)) return null;
  return text;
}

function sanitizeSandboxProbe(
  probe: DiagnosticsExportInputV1["sandboxLastProbe"],
): DiagnosticsSandboxProbeV1 | null {
  if (!probe || !isRecord(probe)) return null;
  const observedAt = sanitizeText(probe.observedAt);
  const rawStatus = probe.status;
  if (!rawStatus || !isRecord(rawStatus)) {
    return observedAt ? { observedAt, status: null } : null;
  }
  const blocker = rawStatus.blocker && isRecord(rawStatus.blocker)
    ? {
        code: sanitizeIdentity(rawStatus.blocker.code),
        message: sanitizeText(rawStatus.blocker.message),
        requiredAction: sanitizeText(rawStatus.blocker.requiredAction),
      }
    : null;
  return {
    observedAt,
    status: {
      mode: sanitizeIdentity(rawStatus.mode),
      executionAvailable: sanitizeBoolean(rawStatus.executionAvailable),
      editingAvailable: sanitizeBoolean(rawStatus.editingAvailable),
      selectedProvider: sanitizeIdentity(rawStatus.selectedProvider),
      blocker,
    },
  };
}

function dropUnsafeArgValue(key: string, value: unknown): unknown {
  const folded = key.toLowerCase();
  if (NOTE_BODY_KEYS.has(folded) || PATH_OR_COMMAND_KEYS.has(folded)) {
    return typeof value === "string"
      ? `<omitted ${folded}, ${value.length} chars>`
      : `<omitted ${folded}>`;
  }
  if (typeof value === "string") {
    if (looksLikeVaultPath(value) || looksLikeCommandLine(value)) {
      return `<omitted ${folded}>`;
    }
    return redactDiagnosticsSecretsV1(value);
  }
  return value;
}

function sanitizeToolArgs(args: unknown): unknown {
  if (!isRecord(args)) return undefined;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    next[key] = dropUnsafeArgValue(key, value);
  }
  return next;
}

function sanitizeFailureEvidence(
  input: RunFailureEvidenceInputV1 | null | undefined,
): RunFailureEvidenceInputV1 | null {
  if (!input) return null;
  const lastToolFailure = input.lastToolFailure
    ? {
        name: sanitizeIdentity(input.lastToolFailure.name) ?? input.lastToolFailure.name,
        step: input.lastToolFailure.step ?? null,
        errorCode: sanitizeIdentity(input.lastToolFailure.errorCode),
        errorMessage: sanitizeText(input.lastToolFailure.errorMessage),
        args: sanitizeToolArgs(input.lastToolFailure.args),
      }
    : null;
  const diagnostics = (input.diagnostics ?? []).map((diagnostic) => ({
    id: sanitizeIdentity(diagnostic.id) ?? diagnostic.id,
    code: sanitizeIdentity(diagnostic.code),
    message: sanitizeText(diagnostic.message),
    detail: undefined,
  }));
  return {
    stopDetail: sanitizeText(input.stopDetail),
    blocker: input.blocker
      ? {
          code: sanitizeIdentity(input.blocker.code),
          message: sanitizeText(input.blocker.message),
          requiredAction: sanitizeText(input.blocker.requiredAction),
        }
      : null,
    activeNodeId: sanitizeIdentity(input.activeNodeId),
    lastToolFailure,
    diagnostics,
  };
}

function nodeListFromGraph(
  graph: DiagnosticsRunSnapshotInputV1["lastMissionGraph"],
): {
  id?: string;
  status?: string;
  blocker?: {
    code?: string | null;
    message?: string | null;
    requiredAction?: string | null;
  } | null;
}[] {
  const nodes = graph?.nodes;
  if (!nodes) return [];
  return Array.isArray(nodes) ? [...nodes] : Object.values(nodes);
}

/**
 * Pull last-failure facts from a run coordinator snapshot without copying
 * graph objectives, receipts, vault paths, or note content.
 */
export function extractFailureEvidenceFromRunSnapshotV1(
  snapshot: DiagnosticsRunSnapshotInputV1 | null | undefined,
): RunFailureEvidenceInputV1 | null {
  if (!snapshot) return null;
  if (snapshot.failureEvidence) {
    return sanitizeFailureEvidence(snapshot.failureEvidence);
  }

  const nodes = nodeListFromGraph(snapshot.lastMissionGraph);
  const blocked = nodes.find((node) => node.status === "blocked" && node.blocker);
  const activeIds = snapshot.lastMissionGraph?.continuationCheckpoint?.activeNodeIds ?? [];
  const active =
    blocked ??
    nodes.find((node) => node.id && activeIds.includes(node.id)) ??
    null;

  const attestations = snapshot.diagnosticAttestations ?? [];
  const lastTool = [...attestations]
    .reverse()
    .find((item) => item.toolName && (item.errorCode || item.message));

  const stopDetail =
    snapshot.stopDetail ?? snapshot.lastComplete?.stopDetail ?? null;
  const hasAnything =
    Boolean(stopDetail) ||
    Boolean(active?.blocker) ||
    Boolean(active?.id) ||
    attestations.length > 0;
  if (!hasAnything) return null;

  return sanitizeFailureEvidence({
    stopDetail,
    blocker: active?.blocker
      ? {
          code: active.blocker.code ?? null,
          message: active.blocker.message ?? null,
          requiredAction: active.blocker.requiredAction ?? null,
        }
      : null,
    activeNodeId: active?.id ?? null,
    lastToolFailure: lastTool?.toolName
      ? {
          name: lastTool.toolName,
          errorCode: lastTool.errorCode ?? null,
          errorMessage: lastTool.message ?? null,
        }
      : null,
    diagnostics: attestations.map((item) => ({
      id: item.id ?? "diagnostic",
      code: item.errorCode ?? null,
      message: item.message ?? null,
    })),
  });
}

export interface DiagnosticsStartupTimingV1 {
  coreReadyMs: number;
  runNoteCount: number | null;
  phases: Record<string, number>;
  layoutReadyAfterMs: number | null;
  deferred: Record<string, number>;
}

function sanitizeDurationRecord(
  value: Record<string, number> | null | undefined,
): Record<string, number> {
  const record: Record<string, number> = {};
  for (const [name, ms] of Object.entries(value ?? {}).slice(0, 32)) {
    const key = sanitizeIdentity(name);
    if (key && typeof ms === "number" && Number.isFinite(ms)) {
      record[key] = Math.max(0, ms);
    }
  }
  return record;
}

function sanitizeStartupTiming(
  value: DiagnosticsExportInputV1["startupTiming"],
): DiagnosticsStartupTimingV1 | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const coreReadyMs =
    typeof value.coreReadyMs === "number" && Number.isFinite(value.coreReadyMs)
      ? Math.max(0, value.coreReadyMs)
      : null;
  if (coreReadyMs === null) {
    return null;
  }
  const phases = sanitizeDurationRecord(value.phases);
  const deferred = sanitizeDurationRecord(value.deferred);
  const layoutReadyAfterMs =
    typeof value.layoutReadyAfterMs === "number" &&
    Number.isFinite(value.layoutReadyAfterMs)
      ? Math.max(0, value.layoutReadyAfterMs)
      : null;
  const runNoteCount =
    typeof value.runNoteCount === "number" && Number.isFinite(value.runNoteCount)
      ? Math.max(0, Math.floor(value.runNoteCount))
      : null;
  return { coreReadyMs, runNoteCount, phases, layoutReadyAfterMs, deferred };
}

export function buildDiagnosticsReportV1(
  input: DiagnosticsExportInputV1 = {},
): DiagnosticsExportReportV1 {
  const snapshot = input.runSnapshot ?? null;
  const evidence = extractFailureEvidenceFromRunSnapshotV1(snapshot);
  const facts = evidence ? buildRunFailureEvidenceV1(evidence) : [];
  const stopReason = sanitizeIdentity(
    snapshot?.stopReason ?? snapshot?.lastComplete?.stopReason ?? null,
  );
  const stopDetail = sanitizeText(
    snapshot?.stopDetail ?? snapshot?.lastComplete?.stopDetail ?? evidence?.stopDetail ?? null,
  );
  const lastFailure =
    facts.length > 0 || stopReason || stopDetail
      ? { stopReason, stopDetail, facts }
      : null;

  const generatedAt =
    typeof input.generatedAt === "string" && input.generatedAt.trim()
      ? redactDiagnosticsSecretsV1(input.generatedAt.trim())
      : new Date().toISOString();

  return {
    schemaVersion: DIAGNOSTICS_EXPORT_SCHEMA_VERSION,
    generatedAt,
    pluginVersion: sanitizeIdentity(input.pluginVersion),
    obsidianVersion: sanitizeIdentity(input.obsidianVersion),
    platform: sanitizeIdentity(input.platform),
    startupPhase: sanitizeIdentity(input.startupPhase),
    startup: sanitizeStartupTiming(input.startupTiming),
    sandbox: { lastProbe: sanitizeSandboxProbe(input.sandboxLastProbe) },
    model: {
      id: sanitizeIdentity(input.model?.id),
      provider: sanitizeIdentity(input.model?.provider),
    },
    lastFailure,
  };
}

export function formatDiagnosticsReportJsonV1(
  report: DiagnosticsExportReportV1,
): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}

export function formatDiagnosticsReportMarkdownV1(
  report: DiagnosticsExportReportV1,
): string {
  const lines = [
    "# Agentic Researcher diagnostics",
    "",
    `- Schema: ${report.schemaVersion}`,
    `- Generated: ${report.generatedAt}`,
    `- Plugin version: ${report.pluginVersion ?? "unknown"}`,
    `- Obsidian: ${report.obsidianVersion ?? "unknown"}`,
    `- Platform: ${report.platform ?? "unknown"}`,
    `- Startup phase: ${report.startupPhase ?? "unknown"}`,
    `- Model: ${report.model.id ?? "unknown"}`,
    `- Provider: ${report.model.provider ?? "unknown"}`,
  ];

  if (report.startup) {
    lines.push("", "## Startup");
    lines.push(`- Core ready: ${report.startup.coreReadyMs} ms`);
    if (report.startup.runNoteCount !== null) {
      lines.push(`- Run notes in vault: ${report.startup.runNoteCount}`);
    }
    for (const [phase, ms] of Object.entries(report.startup.phases)) {
      lines.push(`- ${phase}: ${ms} ms`);
    }
    if (report.startup.layoutReadyAfterMs !== null) {
      lines.push(`- Layout ready after: ${report.startup.layoutReadyAfterMs} ms`);
    }
    for (const [task, ms] of Object.entries(report.startup.deferred)) {
      lines.push(`- layout-ready ${task}: ${ms} ms`);
    }
  }

  const probe = report.sandbox.lastProbe;
  if (probe) {
    lines.push("", "## Sandbox last probe");
    lines.push(`- Observed at: ${probe.observedAt ?? "unknown"}`);
    if (probe.status) {
      lines.push(`- Mode: ${probe.status.mode ?? "unknown"}`);
      lines.push(`- Execution available: ${String(probe.status.executionAvailable)}`);
      lines.push(`- Editing available: ${String(probe.status.editingAvailable)}`);
      lines.push(`- Selected provider: ${probe.status.selectedProvider ?? "none"}`);
      if (probe.status.blocker) {
        lines.push(`- Blocker: ${probe.status.blocker.code ?? "unknown"}`);
        if (probe.status.blocker.message) {
          lines.push(`- Blocker message: ${probe.status.blocker.message}`);
        }
        if (probe.status.blocker.requiredAction) {
          lines.push(`- Required action: ${probe.status.blocker.requiredAction}`);
        }
      }
    }
  } else {
    lines.push("", "## Sandbox last probe", "", "No probe recorded.");
  }

  if (report.lastFailure) {
    lines.push("", "## Last failure");
    if (report.lastFailure.stopReason) {
      lines.push(`- Stop reason: ${report.lastFailure.stopReason}`);
    }
    if (report.lastFailure.stopDetail) {
      lines.push(`- Stop detail: ${report.lastFailure.stopDetail}`);
    }
    for (const fact of report.lastFailure.facts) {
      lines.push(`- ${fact.label}: ${fact.value}`);
    }
    if (
      !report.lastFailure.stopReason &&
      !report.lastFailure.stopDetail &&
      report.lastFailure.facts.length === 0
    ) {
      lines.push("No failure artifacts.");
    }
  } else {
    lines.push("", "## Last failure", "", "No run snapshot.");
  }

  lines.push("", "This export omits API keys, tokens, SecretStorage values, note bodies, vault paths, and command lines.", "");
  return lines.join("\n");
}

export function isSafeDiagnosticsExportPathV1(path: string): boolean {
  try {
    return (
      normalizeVaultPath(path, { requireMarkdown: true }) ===
      DIAGNOSTICS_EXPORT_VAULT_PATH
    );
  } catch {
    return false;
  }
}

export async function copyDiagnosticsReportToClipboardV1(
  report: string,
  clipboard: DiagnosticsClipboardAdapterV1,
): Promise<boolean> {
  try {
    await clipboard.writeText(report);
    return true;
  } catch {
    return false;
  }
}

export async function writeDiagnosticsExportNoteV1(input: {
  markdown: string;
  vault: DiagnosticsVaultAdapterV1;
  path?: string;
}): Promise<{ path: string; created: boolean }> {
  const requested = input.path ?? DIAGNOSTICS_EXPORT_VAULT_PATH;
  if (!isSafeDiagnosticsExportPathV1(requested)) {
    throw new Error("Diagnostics export path is not a safe vault-relative markdown path.");
  }
  const path = DIAGNOSTICS_EXPORT_VAULT_PATH;
  const folder = "Agent Runs";
  const existingFolder = input.vault.getAbstractFileByPath?.(folder);
  if (!existingFolder) {
    try {
      await input.vault.createFolder(folder);
    } catch {
      // Folder may already exist between the existence check and create.
    }
  }
  const existing = input.vault.getFileByPath(path);
  if (existing) {
    await input.vault.modify(existing, input.markdown);
    return { path, created: false };
  }
  await input.vault.create(path, input.markdown);
  return { path, created: true };
}
