/**
 * Agent Runs retention. The selector never answers "is this run done?" itself:
 * Chat already does that in `buildMissionResumePlan`. This module only ages out
 * plugin-owned artifacts whose Chat plan is `canResume === false` with reason
 * `ledger_already_complete` or `user_dismissed`.
 */

import {
  parseMissionLedgerFromMarkdown,
  type MissionLedger,
} from "./missionLedger";
import { buildMissionResumePlan } from "./missionResume";

export const AGENT_RUN_NOTE_PATH = /^Agent Runs\/[^/]+\.md$/u;
export const AGENT_RUN_GRAPH_PATH = /^Agent Runs\/Mission Graphs\/[^/]+\.md$/u;
export const MAX_AGENT_RUN_TRASHES_PER_SESSION = 50;
/** Run-note reads between event-loop yields during the load-time sweep. */
export const RETENTION_READS_PER_YIELD = 20;

/** Chat resume reasons that may age out. Not a second completeness predicate. */
export const RETENTION_ALLOWED_CHAT_REASONS = [
  "ledger_already_complete",
  "user_dismissed",
] as const;

export type RetentionAllowedChatReason =
  (typeof RETENTION_ALLOWED_CHAT_REASONS)[number];

export interface RunRetentionPolicyV1 {
  retentionDays: number;
  maxTerminalRuns: number;
}

export interface RunRetentionArtifactV1 {
  path: string;
  mtimeMs: number;
  kind: "run_note" | "mission_graph" | "foreign";
  /** Ledger runId when known. Graphs without a matching ledger never prune. */
  runId?: string;
  /** Chat `buildMissionResumePlan` fields. Absent means fail closed. */
  canResume?: boolean;
  resumeReason?: string;
  ledger?: MissionLedger;
}

export interface RunRetentionSelectionV1 {
  paths: string[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function resolveRunRetentionPolicy(settings: {
  runRetentionDays?: number;
  runRetentionMaxRuns?: number;
}): RunRetentionPolicyV1 {
  return {
    retentionDays: settings.runRetentionDays ?? 30,
    maxTerminalRuns: settings.runRetentionMaxRuns ?? 200,
  };
}

export function classifyOwnedAgentRunPath(
  path: string,
): RunRetentionArtifactV1["kind"] {
  const normalized = normalizeVaultPath(path);
  if (AGENT_RUN_GRAPH_PATH.test(normalized)) {
    return "mission_graph";
  }
  if (AGENT_RUN_NOTE_PATH.test(normalized)) {
    return "run_note";
  }
  return "foreign";
}

/**
 * True only when Chat already refuses resume for a terminal reason we may age
 * out. `canResume === false` alone is not enough (`proof_debt_blocked` stays).
 */
export function chatResumePlanAllowsRetention(plan: {
  canResume?: boolean;
  reason?: string;
}): boolean {
  if (plan.canResume !== false) {
    return false;
  }
  return (RETENTION_ALLOWED_CHAT_REASONS as readonly string[]).includes(
    plan.reason ?? "",
  );
}

export function selectPrunableRunArtifacts(
  entries: readonly RunRetentionArtifactV1[],
  policy: RunRetentionPolicyV1,
  now: Date,
): RunRetentionSelectionV1 {
  if (policy.retentionDays <= 0 || policy.maxTerminalRuns <= 0) {
    return { paths: [] };
  }

  const nowMs = now.getTime();
  const ageCutoffMs = nowMs - policy.retentionDays * DAY_MS;

  const ownedNotes = entries.filter(
    (entry) =>
      entry.kind === "run_note" &&
      AGENT_RUN_NOTE_PATH.test(normalizeVaultPath(entry.path)),
  );
  const ownedGraphs = entries.filter(
    (entry) =>
      entry.kind === "mission_graph" &&
      AGENT_RUN_GRAPH_PATH.test(normalizeVaultPath(entry.path)),
  );

  const agedTerminalNotes = ownedNotes.filter((entry) => {
    if (entry.mtimeMs >= ageCutoffMs) {
      return false;
    }
    return chatResumePlanAllowsRetention(chatPlanForArtifact(entry));
  });
  agedTerminalNotes.sort((left, right) => right.mtimeMs - left.mtimeMs);
  const overflowNotes = agedTerminalNotes
    .slice(policy.maxTerminalRuns)
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  const selected = new Set<string>();
  for (const note of overflowNotes) {
    selected.add(note.path);
    for (const graph of pairedGraphsForNote(note, ownedGraphs)) {
      selected.add(graph.path);
    }
  }

  return { paths: [...selected] };
}

export interface AgentRunRetentionVaultV1 {
  getFiles(): Array<{
    path: string;
    extension?: string;
    stat?: { mtime?: number };
  }>;
  read(file: { path: string }): Promise<string>;
  /** Obsidian's cache-backed read; preferred for the sweep when present. */
  cachedRead?(file: { path: string }): Promise<string>;
  getFileByPath?(path: string): unknown;
  getAbstractFileByPath?(path: string): unknown;
  trash?(file: unknown, system: boolean): Promise<void>;
}

export async function sweepAgentRunsRetentionBestEffort(input: {
  vault: AgentRunRetentionVaultV1;
  policy: RunRetentionPolicyV1;
  now?: Date;
  maxTrashes?: number;
}): Promise<{ trashed: string[] }> {
  const trashed: string[] = [];
  try {
    if (input.policy.retentionDays <= 0 || input.policy.maxTerminalRuns <= 0) {
      return { trashed };
    }
    if (typeof input.vault.getFiles !== "function") {
      return { trashed };
    }

    const files = input.vault.getFiles();
    const artifacts: RunRetentionArtifactV1[] = [];
    // Reading a run note only matters when the selector could prune it: a
    // note younger than the age cutoff never enters the aged-terminal set, and
    // when the aged notes fit within maxTerminalRuns nothing can overflow the
    // cap. Both facts come from mtimes alone, so the sweep reads nothing on the
    // common load (an active vault of recent runs) instead of parsing every
    // note under Agent Runs/ at layout-ready.
    const ageCutoffMs =
      (input.now ?? new Date()).getTime() - input.policy.retentionDays * DAY_MS;
    const agedRunNoteCount = files.filter(
      (file) =>
        classifyOwnedAgentRunPath(file.path) === "run_note" &&
        (file.stat?.mtime ?? 0) < ageCutoffMs,
    ).length;
    const readAgedNotes = agedRunNoteCount > input.policy.maxTerminalRuns;
    const readNote =
      typeof input.vault.cachedRead === "function"
        ? (file: { path: string }) => input.vault.cachedRead!(file)
        : (file: { path: string }) => input.vault.read(file);
    let readsSinceYield = 0;
    for (const file of files) {
      const kind = classifyOwnedAgentRunPath(file.path);
      if (kind === "foreign") {
        continue;
      }
      const artifact: RunRetentionArtifactV1 = {
        path: file.path,
        mtimeMs: file.stat?.mtime ?? 0,
        kind,
      };
      if (kind === "run_note") {
        if (!readAgedNotes || artifact.mtimeMs >= ageCutoffMs) {
          // Unread notes fail closed in the selector (no Chat plan).
          artifacts.push(artifact);
          continue;
        }
        try {
          if (readsSinceYield >= RETENTION_READS_PER_YIELD) {
            readsSinceYield = 0;
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          }
          readsSinceYield += 1;
          const markdown = await readNote(file);
          const ledger = parseMissionLedgerFromMarkdown(markdown);
          if (!ledger) {
            artifacts.push(artifact);
            continue;
          }
          const plan = buildMissionResumePlan(ledger);
          artifact.ledger = ledger;
          artifact.runId = ledger.runId;
          artifact.canResume = plan.canResume;
          artifact.resumeReason = plan.reason;
        } catch {
          artifacts.push(artifact);
          continue;
        }
      } else {
        artifact.runId = graphBasenameAsRunId(file.path);
      }
      artifacts.push(artifact);
    }

    const selected = selectPrunableRunArtifacts(
      artifacts,
      input.policy,
      input.now ?? new Date(),
    );
    const limit = Math.max(
      0,
      Math.min(
        input.maxTrashes ?? MAX_AGENT_RUN_TRASHES_PER_SESSION,
        MAX_AGENT_RUN_TRASHES_PER_SESSION,
      ),
    );
    const batch = limitRetentionTrashBatch(selected.paths, limit);
    for (const path of batch) {
      try {
        const file = resolveVaultFile(input.vault, path, files);
        if (!file || typeof input.vault.trash !== "function") {
          continue;
        }
        await input.vault.trash(file, false);
        trashed.push(path);
      } catch {
        // Best-effort: one trash failure must not block the rest of onload.
      }
    }
  } catch {
    return { trashed };
  }
  return { trashed };
}

export function limitRetentionTrashBatch(
  paths: readonly string[],
  limit: number,
): string[] {
  const taken: string[] = [];
  let index = 0;
  while (index < paths.length) {
    const path = paths[index];
    const group = [path];
    index += 1;
    if (classifyOwnedAgentRunPath(path) === "run_note") {
      while (
        index < paths.length &&
        classifyOwnedAgentRunPath(paths[index]) === "mission_graph"
      ) {
        group.push(paths[index]);
        index += 1;
      }
    }
    if (taken.length + group.length > limit) {
      break;
    }
    taken.push(...group);
  }
  return taken;
}

function chatPlanForArtifact(entry: RunRetentionArtifactV1): {
  canResume?: boolean;
  reason?: string;
} {
  if (entry.ledger) {
    const plan = buildMissionResumePlan(entry.ledger);
    return { canResume: plan.canResume, reason: plan.reason };
  }
  return {
    canResume: entry.canResume,
    reason: entry.resumeReason,
  };
}

function pairedGraphsForNote(
  note: RunRetentionArtifactV1,
  graphs: readonly RunRetentionArtifactV1[],
): RunRetentionArtifactV1[] {
  const notePath = normalizeVaultPath(note.path);
  const noteBasename = vaultBasename(notePath);
  const expectedGraphPath = `Agent Runs/Mission Graphs/${noteBasename}`;
  return graphs.filter((graph) => {
    const graphPath = normalizeVaultPath(graph.path);
    if (graphPath === expectedGraphPath) {
      return true;
    }
    if (note.runId && graph.runId && note.runId === graph.runId) {
      return true;
    }
    return false;
  });
}

function resolveVaultFile(
  vault: AgentRunRetentionVaultV1,
  path: string,
  files: Array<{ path: string }>,
): unknown {
  if (typeof vault.getFileByPath === "function") {
    const byPath = vault.getFileByPath(path);
    if (byPath) {
      return byPath;
    }
  }
  if (typeof vault.getAbstractFileByPath === "function") {
    const abstractFile = vault.getAbstractFileByPath(path);
    if (abstractFile) {
      return abstractFile;
    }
  }
  return files.find((candidate) => candidate.path === path) ?? null;
}

function graphBasenameAsRunId(path: string): string | undefined {
  const basename = vaultBasename(path);
  if (!basename.toLowerCase().endsWith(".md")) {
    return undefined;
  }
  return basename.slice(0, -3);
}

function vaultBasename(path: string): string {
  const normalized = normalizeVaultPath(path);
  return normalized.split("/").pop() ?? "";
}

function normalizeVaultPath(path: string): string {
  return path.replace(/\\/gu, "/");
}
