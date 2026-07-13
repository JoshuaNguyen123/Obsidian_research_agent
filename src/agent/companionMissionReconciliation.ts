import type { ToolExecutionContext } from "../tools/types";
import {
  buildBackgroundAuthorizationV1,
  classifyBackgroundMissionNodeV1,
  type CompanionEventV1,
  type CompanionReceiptV1,
} from "../../packages/headless-runtime/src/backgroundContinuation";
import type { CompanionRemoteJobV1 } from "../../packages/headless-runtime/src/companionCoordinatorClient";
import {
  companionResultFingerprintV1,
  remoteJobToCompanionJob,
} from "../../packages/headless-runtime/src/companionWorkerCoordinator";
import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import type { MissionJsonValueV1 } from "../../packages/headless-runtime/src/missionGraphV3";
import { MissionGraphSession } from "./missionGraphSession";
import type {
  MissionEvidenceRefV1,
  MissionGraphPatchOperationV1,
  MissionReceiptRefV1,
} from "./missionGraphV3";
import type { MissionGraphStoreReferenceV1 } from "./runStore";

export interface CompanionMissionReconciliationInputV1 {
  context: ToolExecutionContext;
  job: CompanionRemoteJobV1;
  receipts: CompanionReceiptV1[];
  events: CompanionEventV1[];
}

export interface CompanionMissionReconciliationResultV1 {
  status: "applied" | "already_applied" | "waiting_obsidian" | "blocked";
  missionId: string;
  nodeId: string;
  graphRevision: number;
  graphReference: MissionGraphStoreReferenceV1;
  appliedThroughSequence: number;
  message: string;
}

/**
 * Journaled, idempotent bridge from verified companion state into the sole
 * authoritative MissionGraphV3. External content never receives vault access.
 */
export async function reconcileCompanionMissionCompletionV1(
  input: CompanionMissionReconciliationInputV1,
): Promise<CompanionMissionReconciliationResultV1> {
  const projectedJob = remoteJobToCompanionJob(input.job);
  const session = await MissionGraphSession.resume({
    context: input.context,
    missionId: projectedJob.missionId,
  });
  const graph = session.graph;
  const node = graph.nodes[projectedJob.nodeId];
  if (!node) throw new Error("Companion completion references an unknown mission node.");
  if (graph.capabilityEnvelope.fingerprint !== projectedJob.capabilityEnvelopeFingerprint) {
    throw new Error("Companion completion capability envelope drifted.");
  }
  const classification = classifyBackgroundMissionNodeV1(graph, node.id);
  if (
    node.executionHost === "obsidian_core" ||
    classification.disposition === "waiting_obsidian"
  ) {
    if (node.status === "ready" || node.status === "running") {
      await session.transitionNode(node.id, "waiting_obsidian", {
        code: "waiting_obsidian",
        message: "Vault-bound work requires the connected Obsidian core.",
        requiredAction: "Reconnect Obsidian to execute this node through the vault API.",
      });
    }
    return finish("waiting_obsidian", session, projectedJob.nodeId, input, "Vault node remains host-bound.");
  }
  let completion: ReturnType<typeof parseCompletion> | null = null;
  const receiptById = new Map(input.receipts.map((receipt) => [receipt.id, receipt]));
  if (input.job.state === "complete") {
    completion = parseCompletion(input.job.output);
    if (completion.status !== "complete") {
      throw new Error("Companion job state and completion payload disagree.");
    }
    const { resultFingerprint: claimedResultFingerprint, ...completionProof } = completion;
    const expectedResultFingerprint = await companionResultFingerprintV1(
      projectedJob,
      completionProof,
    );
    if (claimedResultFingerprint !== expectedResultFingerprint) {
      throw new Error("Companion completion result fingerprint drifted.");
    }
    if (
      completion.receiptIds.some((receiptId) => !receiptById.has(receiptId)) ||
      completion.receiptIds.some(
        (receiptId) => receiptById.get(receiptId)?.status !== "verified",
      )
    ) {
      throw new Error("Companion completion lacks verified receipt readback.");
    }
    if (node.status === "complete") {
      const evidenceFingerprints = new Set(node.evidence.map((item) => item.fingerprint));
      const receiptFingerprints = new Set(node.receipts.map((item) => item.fingerprint));
      const proofAlreadyApplied =
        node.verification?.fingerprint === claimedResultFingerprint &&
        canonicalJson(node.outputs) === canonicalJson(completion.outputs) &&
        completion.evidence.every((item) => {
          const fingerprint = String(asRecord(item).fingerprint ?? "");
          return evidenceFingerprints.has(fingerprint);
        }) &&
        completion.receiptIds.every((receiptId) =>
          receiptFingerprints.has(receiptById.get(receiptId)!.fingerprint),
        );
      if (!proofAlreadyApplied) {
        throw new Error("Completed mission node does not match the companion completion proof.");
      }
      return finish(
        "already_applied",
        session,
        node.id,
        input,
        "External completion proof was already applied.",
      );
    }
  }
  const rebuiltAuthorization = await buildBackgroundAuthorizationV1({
    graph,
    nodeId: node.id,
    grantId: projectedJob.authorization.grantId,
    authorizedAt: projectedJob.authorization.authorizedAt,
    expiresAt: projectedJob.authorization.expiresAt,
    authorizedGraphRevision: projectedJob.graphRevision,
  });
  if (rebuiltAuthorization.fingerprint !== projectedJob.authorization.fingerprint) {
    throw new Error("Companion completion authorization no longer matches the mission node.");
  }
  if (["blocked", "failed", "cancelled"].includes(input.job.state)) {
    if (node.status !== "blocked" && node.status !== "cancelled" && node.status !== "complete") {
      await session.transitionNode(node.id, "blocked", {
        code: `companion_${input.job.state}`,
        message: "Background execution ended without verified completion proof.",
        requiredAction: "Inspect Run Details and explicitly resume after correcting the blocker.",
      });
    }
    return finish("blocked", session, node.id, input, "External work ended without success proof.");
  }
  if (input.job.state !== "complete") {
    return finish("blocked", session, node.id, input, "External work is not terminal-complete.");
  }
  if (!completion) throw new Error("Companion completion payload is unavailable.");
  const latestSequence = maxEventSequence(input.events);
  const operations: MissionGraphPatchOperationV1[] = [];
  let currentStatus = node.status;
  if (currentStatus === "queued") {
    if (!node.dependencyIds.every((id) => graph.nodes[id]?.status === "complete")) {
      throw new Error("Companion completion arrived before mission dependencies completed.");
    }
    operations.push(status(node.id, "queued", "ready"));
    currentStatus = "ready";
  }
  if (currentStatus === "blocked") {
    operations.push(status(node.id, "blocked", "ready"));
    currentStatus = "ready";
  }
  if (currentStatus !== "verifying") {
    if (!["ready", "running", "waiting_obsidian"].includes(currentStatus)) {
      throw new Error(`Mission node cannot reconcile external completion from ${currentStatus}.`);
    }
    if (currentStatus !== "running") {
      operations.push(status(node.id, currentStatus, "running"));
    }
  }
  operations.push({ op: "set_outputs", nodeId: node.id, outputs: completion.outputs });
  const existingEvidence = new Set(node.evidence.map((item) => item.fingerprint));
  for (const evidence of completion.evidence) {
    const ref = evidenceRef(evidence, input.job.updatedAt);
    if (!existingEvidence.has(ref.fingerprint)) operations.push({ op: "append_evidence", nodeId: node.id, evidence: ref });
  }
  const existingReceipts = new Set(node.receipts.map((item) => item.fingerprint));
  for (const receiptId of completion.receiptIds) {
    const ref = receiptRef(receiptById.get(receiptId)!, input.job.updatedAt);
    if (!existingReceipts.has(ref.fingerprint)) operations.push({ op: "append_receipt", nodeId: node.id, receipt: ref });
  }
  const verifierId = node.completionContract.verifierId ?? "companion-external-result-v1";
  operations.push({
    op: "record_verification",
    nodeId: node.id,
    verification: {
      verifierId,
      status: "passed",
      fingerprint: completion.resultFingerprint,
      verifiedAt: input.job.updatedAt,
    },
  });
  if (currentStatus !== "verifying") {
    operations.push(status(node.id, "running", "verifying"));
  }
  operations.push(status(node.id, "verifying", "complete"));
  await session.apply(`Reconcile verified companion completion ${input.job.id}.`, operations);
  await session.promoteReadyNodes();
  return finish("applied", session, node.id, input, "Verified external completion applied once.", latestSequence);
}

function parseCompletion(value: unknown) {
  const source = asRecord(value);
  const exact = ["status", "outputs", "evidence", "receiptIds", "blocker", "resultFingerprint"].sort();
  const actual = Object.keys(source).sort();
  if (actual.length !== exact.length || actual.some((key, index) => key !== exact[index])) {
    throw new Error("Companion completion payload has unknown or missing fields.");
  }
  if (!Array.isArray(source.evidence) || !Array.isArray(source.receiptIds)) {
    throw new Error("Companion completion evidence or receipts are malformed.");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(String(source.resultFingerprint))) {
    throw new Error("Companion completion result fingerprint is invalid.");
  }
  return {
    status: String(source.status),
    outputs: asRecord(source.outputs) as Record<string, MissionJsonValueV1>,
    evidence: source.evidence as MissionJsonValueV1[],
    receiptIds: source.receiptIds.map(String),
    blocker: source.blocker === null ? null : (asRecord(source.blocker) as {
      code: string;
      message: string;
      requiredAction: string | null;
    }),
    resultFingerprint: String(source.resultFingerprint),
  };
}

function evidenceRef(value: MissionJsonValueV1, observedAt: string): MissionEvidenceRefV1 {
  const source = asRecord(value);
  const fingerprint = String(source.fingerprint ?? "");
  if (!/^sha256:[a-f0-9]{64}$/.test(fingerprint)) throw new Error("External evidence fingerprint is invalid.");
  return {
    id: `external-evidence-${fingerprint.slice(7, 23)}`,
    kind: typeof source.kind === "string" ? source.kind : "external_evidence",
    fingerprint,
    observedAt,
  };
}

function receiptRef(receipt: CompanionReceiptV1, committedAt: string): MissionReceiptRefV1 {
  return {
    id: receipt.id,
    kind: `external:${receipt.provider}:${receipt.operation}`,
    fingerprint: receipt.fingerprint,
    committedAt,
  };
}

function status(
  nodeId: string,
  expectedStatus: Parameters<MissionGraphSession["transitionNode"]>[1],
  next: Parameters<MissionGraphSession["transitionNode"]>[1],
): MissionGraphPatchOperationV1 {
  return { op: "set_status", nodeId, expectedStatus, status: next, blocker: null };
}

async function finish(
  statusValue: CompanionMissionReconciliationResultV1["status"],
  session: MissionGraphSession,
  nodeId: string,
  input: CompanionMissionReconciliationInputV1,
  message: string,
  sequence = maxEventSequence(input.events),
): Promise<CompanionMissionReconciliationResultV1> {
  return {
    status: statusValue,
    missionId: input.job.missionId,
    nodeId,
    graphRevision: session.graph.revision,
    graphReference: session.reference,
    appliedThroughSequence: sequence,
    message,
  };
}

function maxEventSequence(events: CompanionEventV1[]): number {
  return events.reduce((maximum, event) => Math.max(maximum, event.sequence), 0);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
