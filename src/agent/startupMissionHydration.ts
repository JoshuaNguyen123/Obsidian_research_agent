import {
  isIncompleteRuntimeStatus,
  readRunNoteStatusFromMetadataCache,
} from "./runNoteStatus";
import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "../tools/types";
import { buildMissionResumePlan } from "./missionResume";
import {
  computeProofDebt,
  proofDebtSnapshotFromRuntime,
} from "./proofDebt";
import {
  readMissionLedgerByRunId,
  summarizeMissionLedger,
} from "./missionLedger";
import { readMissionGraphStoreRecord } from "./missionGraphStore";
import type { PersistedMissionRunProjection } from "./runCoordinator";
import {
  parseMissionRuntimeSnapshotFromMarkdown,
  readMissionRuntimeSnapshotByRunId,
  type MissionGraphStoreReferenceV1,
  type MissionRuntimeSnapshotV2,
} from "./runStore";

const LIFECYCLE_RESTART_TOOLS = new Set([
  "publish_research_to_linear",
  "publish_research_project_to_linear",
  "code_commit_verified",
  "publish_verified_code_to_github",
  "github_delete_private_repository",
]);

export class StartupMissionHydrationIntegrityError extends Error {
  readonly code = "startup_mission_hydration_integrity_error";

  constructor(message: string) {
    super(message);
    this.name = "StartupMissionHydrationIntegrityError";
  }
}

export function getDurablyCompletedLifecycleToolNames(
  projection: PersistedMissionRunProjection,
): string[] {
  if (!projection.missionLedger.canResume) {
    return [];
  }
  return [...new Set(
    Object.values(projection.missionGraph.nodes).flatMap((node) =>
      node.status === "complete"
        ? node.allowedTools.filter((toolName) =>
            LIFECYCLE_RESTART_TOOLS.has(toolName),
          )
        : [],
    ),
  )].sort((left, right) => left.localeCompare(right));
}

/**
 * Rebuilds only the in-memory Run Details projection after a plugin restart.
 * The runtime snapshot's exact graph reference remains the sole authority: a
 * missing or drifting record fails closed instead of falling back to a loose
 * latest-graph scan or a legacy plan copy.
 */
export async function loadLatestPersistedMissionRunProjection(
  context: ToolExecutionContext,
): Promise<PersistedMissionRunProjection | null> {
  // Newest first, one note at a time, stopping at the first usable
  // projection. This runs in the IMMEDIATE phase of plugin load (main.ts
  // awaits it before the view can render), and it used to read and
  // JSON-parse every note under Agent Runs/ before returning -- with the
  // default retention keeping 200 terminal runs, that was 200 full reads on
  // the load path to find the one run that can resume.
  for await (const candidate of iterateRuntimeCandidatesNewestFirst(context)) {
    const projection = await loadProjectionForCandidate(context, candidate);
    if (projection) return projection;
  }

  return null;
}

/**
 * Rehydrates one known durable run by its exact runtime path. Companion
 * reconciliation uses this after committing a graph reference so it does not
 * depend on Obsidian's eventually refreshed vault-wide file index.
 */
export async function loadPersistedMissionRunProjectionByRunId(
  context: ToolExecutionContext,
  runId: string,
): Promise<PersistedMissionRunProjection | null> {
  const stored = await readMissionRuntimeSnapshotByRunId(context, runId);
  return stored ? loadProjectionForCandidate(context, stored) : null;
}

async function loadProjectionForCandidate(
  context: ToolExecutionContext,
  candidate: { path: string; snapshot: MissionRuntimeSnapshotV2 },
): Promise<PersistedMissionRunProjection | null> {
  if (!isIncompleteRuntimeStatus(candidate.snapshot.status)) {
    return null;
  }
  const ledgerReadback = await readMissionLedgerByRunId(
    context,
    candidate.snapshot.runId,
  );
  if (!ledgerReadback) {
    return null;
  }

  const resumePlan = buildMissionResumePlan(ledgerReadback.ledger);
  if (resumePlan.reason === "ledger_already_complete") {
    return null;
  }

  const reference = candidate.snapshot.missionGraphRef;
  if (!reference) {
    return null;
  }
  const graphReadback = await readMissionGraphStoreRecord(
    context,
    reference.missionId,
  );
  if (!graphReadback) {
    throw new StartupMissionHydrationIntegrityError(
      `Referenced mission graph is missing: ${reference.path}.`,
    );
  }
  assertExactGraphReference(reference, graphReadback);

  const missionLedger = summarizeMissionLedger(ledgerReadback.ledger);
  // Recompute proof debt at startup. In particular, an ambiguous write-ahead
  // journal or pending approval must remain visible but cannot expose a
  // Continue action until it is reconciled.
  const runtimeDebt = computeProofDebt(
    proofDebtSnapshotFromRuntime(candidate.snapshot, {
      blockers: ledgerReadback.ledger.blockers,
      blockerCategory: ledgerReadback.ledger.blockerCategory,
      acceptance: ledgerReadback.ledger.acceptance,
      pendingApprovals: Object.values(graphReadback.record.graph.nodes).some(
        (node) => node.status === "waiting_approval",
      ),
    }),
  );
  missionLedger.canResume = resumePlan.canResume && !runtimeDebt.resumeBlocked;
  missionLedger.continuationCommand = resumePlan.continuationCommand;
  missionLedger.remainingActions = runtimeDebt.resumeBlocked
    ? [
        runtimeDebt.nextAction.summary,
        ...resumePlan.remainingActions.filter(
          (action) => action !== runtimeDebt.nextAction.summary,
        ),
      ]
    : [...resumePlan.remainingActions];
  missionLedger.nextAction = runtimeDebt.resumeBlocked
    ? runtimeDebt.nextAction.summary
    : resumePlan.remainingActions[0] ?? missionLedger.nextAction;
  if (runtimeDebt.resumeBlocked && !missionLedger.blockerCategory) {
    missionLedger.blockerCategory = "safety_policy";
  }

  return {
    runId: candidate.snapshot.runId,
    runtimeSnapshotPath: candidate.path,
    missionLedgerPath: ledgerReadback.path,
    graphStorePath: graphReadback.path,
    graphReference: { ...reference },
    missionLedger,
    missionGraph: graphReadback.record.graph,
  };
}

function assertExactGraphReference(
  reference: MissionGraphStoreReferenceV1,
  readback: Awaited<ReturnType<typeof readMissionGraphStoreRecord>> & {},
): void {
  const record = readback.record;
  const mismatches: string[] = [];
  if (readback.path !== reference.path) mismatches.push("path");
  if (record.missionId !== reference.missionId) mismatches.push("missionId");
  if (record.graph.missionId !== reference.missionId) {
    mismatches.push("graph.missionId");
  }
  if (record.storeRevision !== reference.storeRevision) {
    mismatches.push("storeRevision");
  }
  if (record.graph.revision !== reference.graphRevision) {
    mismatches.push("graphRevision");
  }
  if (record.recordFingerprint !== reference.recordFingerprint) {
    mismatches.push("recordFingerprint");
  }
  if (
    record.graph.journalHeadFingerprint !== reference.journalHeadFingerprint
  ) {
    mismatches.push("journalHeadFingerprint");
  }
  if (mismatches.length > 0) {
    throw new StartupMissionHydrationIntegrityError(
      `Mission graph reference drifted at ${reference.path}: ${mismatches.join(
        ", ",
      )}.`,
    );
  }
}

/**
 * Lazily yields run-note candidates newest first. Reads go through
 * `cachedRead` when the vault offers it (startup reads a note nobody is
 * writing, so the cache is authoritative) and fall back to `read`; each note
 * is read only when the caller asks for the next candidate, so a consumer
 * that stops at the first usable projection pays for one note, not for the
 * whole folder.
 */
async function* iterateRuntimeCandidatesNewestFirst(
  context: ToolExecutionContext,
): AsyncGenerator<
  { path: string; snapshot: MissionRuntimeSnapshotV2; mtime: number },
  void,
  undefined
> {
  const vault = context.app?.vault;
  if (
    !vault ||
    typeof vault.getFiles !== "function" ||
    typeof vault.read !== "function"
  ) {
    return;
  }
  const readNote =
    typeof vault.cachedRead === "function"
      ? (file: TFile) => vault.cachedRead(file)
      : (file: TFile) => vault.read(file);

  const files = vault
    .getFiles()
    .filter((file) => file.extension === "md")
    .filter((file) => /^Agent Runs\/[^/]+\.md$/i.test(file.path))
    .sort((left, right) => (right.stat?.mtime ?? 0) - (left.stat?.mtime ?? 0));
  for (const file of files) {
    // A terminal note announces its status in frontmatter; the metadata cache
    // answers without a read, so a vault full of finished runs costs the load
    // path a listing instead of one read and parse per note.
    const cachedStatus = readRunNoteStatusFromMetadataCache(
      context.app,
      file as TFile,
    );
    if (cachedStatus && !isIncompleteRuntimeStatus(cachedStatus)) {
      continue;
    }
    const markdown = await readNote(file as TFile);
    const snapshot = parseMissionRuntimeSnapshotFromMarkdown(markdown);
    if (!snapshot) {
      continue;
    }
    yield {
      path: file.path,
      snapshot,
      mtime: file.stat?.mtime ?? 0,
    };
  }
}
