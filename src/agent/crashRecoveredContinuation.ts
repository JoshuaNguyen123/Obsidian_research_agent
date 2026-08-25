import type { ToolExecutionContext } from "../tools/types";
import { sha256Fingerprint } from "./actions/canonicalize";
import { canonicalMissionGraphId } from "./missionGraphIds";
import {
  MissionGraphStoreIntegrityError,
  readMissionGraphStoreRecord,
  type MissionGraphStoreRecordV1,
} from "./missionGraphStore";
import {
  parseMissionLedgerFromMarkdown,
  type MissionLedger,
} from "./missionLedger";
import {
  buildOperationReconciliationInputs,
  parseMissionRuntimeSnapshotFromMarkdown,
  type MissionRuntimeSnapshotV2,
} from "./runStore";

/**
 * Why this module exists: the graceful continuation handoff and the mission
 * ledger both live in `Agent Runs/<runId>.md`, which is written at safe run
 * boundaries. The canonical mission graph store and its write-ahead journal
 * live in `Agent Runs/Mission Graphs/<missionId>.md` and are persisted on
 * every CAS patch. A hard crash (renderer death, power loss) can therefore
 * leave a mission with zero `Agent Runs` note while the graph store still
 * holds fully validated resumable state - the exact two-subsystems-disagree
 * shape. This is the one shared predicate both production resume and tests
 * use to decide whether such an orphan is crash-recoverable, and to rebuild a
 * minimal fingerprinted continuation from the store, its journal, and the
 * durable receipts it retains.
 *
 * Every refusal here is deliberate fail-closed behavior: reconstruction never
 * proceeds past an input that cannot be validated, and it never classifies a
 * possibly-applied mutation itself - pending operation-journal records are
 * carried through verbatim so the existing resume gates (which consult
 * getReconciliationAction) keep their authority.
 */
export type CrashRecoveredContinuationRefusalCodeV1 =
  | "run_note_ledger_present"
  | "graph_store_invalid"
  | "orchestrator_link_ambiguous"
  | "linked_snapshot_missing"
  | "linked_graph_reference_missing"
  | "linked_graph_store_missing"
  | "graph_reference_mismatch"
  | "graceful_handoff_present"
  | "linked_handoff_invalid"
  | "no_durable_crash_state";

export interface CrashRecoveredContinuationV1 {
  version: 1;
  provenance: "crash_recovered";
  requestedRunId: string;
  resume: {
    /** Run identity that owns the durable records driving the continuation. */
    runId: string;
    viaOrchestratorLink: boolean;
  };
  graph: {
    missionId: string;
    storeRevision: number;
    graphRevision: number;
    recordFingerprint: string;
    journalHeadFingerprint: string | null;
    walTail: { patchId: string; state: "prepared" | "applied" } | null;
    readyNodeIds: string[];
    activeNodeIds: string[];
    completedNodeIds: string[];
    evidence: Array<{ id: string; fingerprint: string }>;
    receiptFingerprints: string[];
  };
  /**
   * Non-committed operation-journal records from the linked runtime snapshot,
   * verbatim per getReconciliationAction. Empty for a store-only recovery: the
   * runtime WAL records every mutation intent before the mutation itself, so a
   * mission without any runtime snapshot provably never started one.
   */
  reconciliation: Array<{
    operationId: string;
    toolName: string;
    state: string;
    mutationMayHaveApplied: boolean;
    recommendedAction: string;
  }>;
  createdAt: string;
  fingerprint: string;
}

export type CrashRecoveredContinuationResultV1 =
  | {
      ok: true;
      value: CrashRecoveredContinuationV1;
      ledger: MissionLedger | null;
      ledgerPath: string | null;
      snapshot: MissionRuntimeSnapshotV2 | null;
    }
  | {
      ok: false;
      refusalCode: CrashRecoveredContinuationRefusalCodeV1;
      detail: string;
    };

interface LinkedCandidate {
  path: string;
  markdown: string;
  ledger: MissionLedger;
}

export async function buildCrashRecoveredContinuationV1(
  context: ToolExecutionContext,
  requestedRunId: string,
): Promise<CrashRecoveredContinuationResultV1> {
  const runId = requestedRunId.trim();
  if (!runId) {
    return refuse("no_durable_crash_state", "Requested run id is empty.");
  }

  const scan = await scanAgentRunLedgers(context);
  if (scan.some((entry) => entry.ledger.runId === runId)) {
    // A ledger for the exact requested run exists, so the primary resume path
    // owns this continuation; reconstruction must never race or shadow it.
    return refuse(
      "run_note_ledger_present",
      `Run ${runId} has a mission ledger; use the primary resume path.`,
    );
  }

  let directRecord: MissionGraphStoreRecordV1 | null = null;
  try {
    directRecord =
      (await readMissionGraphStoreRecord(
        context,
        canonicalMissionGraphId(runId),
      ))?.record ?? null;
  } catch (error) {
    if (error instanceof MissionGraphStoreIntegrityError) {
      return refuse(
        "graph_store_invalid",
        `Mission graph store for run ${runId} failed validation.`,
      );
    }
    throw error;
  }
  if (directRecord) {
    return {
      ok: true,
      value: await buildArtifact({
        context,
        requestedRunId: runId,
        resumeRunId: runId,
        viaOrchestratorLink: false,
        record: directRecord,
        snapshot: null,
      }),
      ledger: null,
      ledgerPath: null,
      snapshot: null,
    };
  }

  const linked = scan.filter(
    (entry) =>
      entry.ledger.runId !== runId &&
      entry.ledger.orchestrator?.runId === runId,
  );
  const linkedRunIds = [...new Set(linked.map((entry) => entry.ledger.runId))];
  if (linkedRunIds.length === 0) {
    return refuse(
      "no_durable_crash_state",
      `Run ${runId} has no mission graph store and no orchestrator-linked ledger.`,
    );
  }
  if (linkedRunIds.length > 1 || linked.length > 1) {
    return refuse(
      "orchestrator_link_ambiguous",
      `Run ${runId} has ${linked.length} orchestrator-linked ledgers (${linkedRunIds.join(", ")}); refusing to choose.`,
    );
  }

  const candidate = linked[0];
  if (candidate.ledger.continuationHandoffInvalid === true) {
    return refuse(
      "linked_handoff_invalid",
      `Linked run ${candidate.ledger.runId} recorded an invalid continuation handoff.`,
    );
  }
  if (candidate.ledger.continuationHandoff) {
    // A graceful handoff exists, so this is not a crash orphan. The linked
    // run's own resume path validates that handoff against full lineage
    // authority; reconstruction must not bypass that gate.
    return refuse(
      "graceful_handoff_present",
      candidate.ledger.continuationCommand ||
        `continue run ${candidate.ledger.runId}`,
    );
  }

  const snapshot = parseMissionRuntimeSnapshotFromMarkdown(candidate.markdown);
  if (!snapshot || snapshot.runId !== candidate.ledger.runId) {
    return refuse(
      "linked_snapshot_missing",
      `Linked run ${candidate.ledger.runId} has no matching runtime snapshot.`,
    );
  }
  const reference = snapshot.missionGraphRef;
  if (!reference) {
    return refuse(
      "linked_graph_reference_missing",
      `Linked run ${candidate.ledger.runId} has no durable mission graph reference.`,
    );
  }

  let linkedRecord: MissionGraphStoreRecordV1 | null = null;
  try {
    linkedRecord =
      (await readMissionGraphStoreRecord(context, reference.missionId))
        ?.record ?? null;
  } catch (error) {
    if (error instanceof MissionGraphStoreIntegrityError) {
      return refuse(
        "graph_store_invalid",
        `Mission graph store ${reference.missionId} failed validation.`,
      );
    }
    throw error;
  }
  if (!linkedRecord) {
    return refuse(
      "linked_graph_store_missing",
      `Mission graph store ${reference.missionId} is not persisted.`,
    );
  }
  if (
    linkedRecord.missionId !== reference.missionId ||
    linkedRecord.storeRevision < reference.storeRevision ||
    linkedRecord.graph.revision < reference.graphRevision ||
    (linkedRecord.storeRevision === reference.storeRevision &&
      linkedRecord.recordFingerprint !== reference.recordFingerprint)
  ) {
    return refuse(
      "graph_reference_mismatch",
      `Mission graph store ${reference.missionId} does not match the snapshot's durable reference.`,
    );
  }

  return {
    ok: true,
    value: await buildArtifact({
      context,
      requestedRunId: runId,
      resumeRunId: candidate.ledger.runId,
      viaOrchestratorLink: true,
      record: linkedRecord,
      snapshot,
    }),
    ledger: candidate.ledger,
    ledgerPath: candidate.path,
    snapshot,
  };
}

export function formatCrashRecoveredContinuationForPrompt(
  value: CrashRecoveredContinuationV1,
): string {
  const pending = value.reconciliation.map(
    (item) =>
      `${item.operationId} (${item.toolName}, ${item.state}) -> ${item.recommendedAction}`,
  );
  return [
    "Crash-recovered continuation (provenance: crash_recovered).",
    `Run ${value.requestedRunId} has no graceful continuation checkpoint; this state was rebuilt from the durable mission graph store, its write-ahead journal, and persisted receipts.`,
    `Fingerprint: ${value.fingerprint}`,
    `Resume run: ${value.resume.runId}${value.resume.viaOrchestratorLink ? " (orchestrator-linked worker of the requested run)" : ""}`,
    `Mission graph: ${value.graph.missionId} at graph revision ${value.graph.graphRevision} (store revision ${value.graph.storeRevision}).`,
    `WAL tail: ${value.graph.walTail ? `${value.graph.walTail.patchId} (${value.graph.walTail.state})` : "none"}`,
    `Ready nodes: ${value.graph.readyNodeIds.join(", ") || "none"}`,
    `Interrupted nodes (effects may or may not have applied; verify durable receipts before re-running effectful tools): ${value.graph.activeNodeIds.join(", ") || "none"}`,
    `Completed nodes: ${value.graph.completedNodeIds.join(", ") || "none"}`,
    `Durable receipts: ${value.graph.receiptFingerprints.length}. Do not replay completed note writes or tool steps with existing receipts.`,
    `Pending reconciliation: ${pending.join("; ") || "none"}`,
  ].join("\n");
}

async function buildArtifact(input: {
  context: ToolExecutionContext;
  requestedRunId: string;
  resumeRunId: string;
  viaOrchestratorLink: boolean;
  record: MissionGraphStoreRecordV1;
  snapshot: MissionRuntimeSnapshotV2 | null;
}): Promise<CrashRecoveredContinuationV1> {
  const nodes = Object.values(input.record.graph.nodes);
  const byStatus = (statuses: readonly string[]) =>
    nodes
      .filter((node) => statuses.includes(node.status))
      .map((node) => node.id)
      .sort()
      .slice(0, 64);
  const walTailEntry = input.record.journal.at(-1);
  const core = {
    version: 1 as const,
    provenance: "crash_recovered" as const,
    requestedRunId: input.requestedRunId,
    resume: {
      runId: input.resumeRunId,
      viaOrchestratorLink: input.viaOrchestratorLink,
    },
    graph: {
      missionId: input.record.missionId,
      storeRevision: input.record.storeRevision,
      graphRevision: input.record.graph.revision,
      recordFingerprint: input.record.recordFingerprint,
      journalHeadFingerprint: input.record.graph.journalHeadFingerprint,
      walTail: walTailEntry
        ? { patchId: walTailEntry.patchId, state: walTailEntry.state }
        : null,
      readyNodeIds: byStatus(["ready"]),
      activeNodeIds: byStatus([
        "running",
        "waiting_approval",
        "waiting_obsidian",
        "verifying",
      ]),
      completedNodeIds: byStatus(["complete"]),
      evidence: dedupeBy(
        nodes.flatMap((node) =>
          node.evidence.map((item) => ({
            id: item.id,
            fingerprint: item.fingerprint,
          })),
        ),
        (item) => `${item.id}:${item.fingerprint}`,
      ).slice(-64),
      receiptFingerprints: [
        ...new Set(
          nodes.flatMap((node) =>
            node.receipts.map((item) => item.fingerprint),
          ),
        ),
      ]
        .sort()
        .slice(0, 64),
    },
    reconciliation: input.snapshot
      ? buildOperationReconciliationInputs(input.snapshot.operationJournal)
          .slice(0, 32)
          .map((item) => ({
            operationId: item.operationId,
            toolName: item.toolName,
            state: item.state,
            mutationMayHaveApplied: item.mutationMayHaveApplied === true,
            recommendedAction: item.recommendedAction,
          }))
      : [],
  };
  return {
    ...core,
    createdAt: (input.context.now?.() ?? new Date()).toISOString(),
    fingerprint: await sha256Fingerprint(core),
  };
}

async function scanAgentRunLedgers(
  context: ToolExecutionContext,
): Promise<LinkedCandidate[]> {
  const vault = context.app?.vault;
  if (!vault || typeof vault.getFiles !== "function" || typeof vault.read !== "function") {
    return [];
  }
  const files = vault
    .getFiles()
    .filter((file) => /^Agent Runs\/[^/]+\.md$/iu.test(file.path))
    .slice(0, 256);
  const candidates: LinkedCandidate[] = [];
  for (const file of files) {
    let markdown: string;
    try {
      markdown = await vault.read(file);
    } catch {
      continue;
    }
    const ledger = parseMissionLedgerFromMarkdown(markdown);
    if (ledger) {
      candidates.push({ path: file.path, markdown, ledger });
    }
  }
  return candidates;
}

function dedupeBy<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function refuse(
  refusalCode: CrashRecoveredContinuationRefusalCodeV1,
  detail: string,
): CrashRecoveredContinuationResultV1 {
  return { ok: false, refusalCode, detail };
}
