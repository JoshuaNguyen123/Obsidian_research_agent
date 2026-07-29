import { canonicalJson } from "../../packages/headless-runtime/src/canonicalize";
import { sha256DiagramContent } from "../design/diagramArtifactStore";
import type { ToolExecutionContext } from "../tools/types";
import { MissionGraphSession } from "./missionGraphSession";
import { getMissionCompositeLifecycleSpecV1 } from "./missionGraphV3";
import {
  isCompletedAcceptedResearchPublicationReceipt,
  type SetLooseDeliveryReceiptLikeV1,
} from "./setLooseCompoundAutonomy";

export type ResearchPublicationResumeReceiptV1 =
  SetLooseDeliveryReceiptLikeV1 & {
    id?: string | null;
    runId?: string | null;
    createdAt?: string | null;
    committedAt?: string | null;
  };

export interface ResearchPublicationGraphReconciliationResultV1 {
  reconciled: boolean;
  nodeId?: string;
  receiptId?: string;
  notePath?: string;
  reason:
    | "reconciled"
    | "publication_proof_missing"
    | "publication_receipt_conflict"
    | "publication_note_proof_invalid"
    | "publication_note_state_mismatch"
    | "legacy_append_not_ready"
    | "legacy_append_ambiguous";
}

interface AcceptedResearchNoteProofV1 {
  publicationReceiptId: string;
  noteReceiptId: string;
  notePath: string;
  noteSha256: string;
  currentNoteSha256: string;
  artifactFingerprint: string;
  observedAt: string;
}

/**
 * A pre-composite MissionGraph may retain a standalone current-note append
 * after publish_research_to_linear already committed that exact note. Resume
 * that graph by attaching the composite tool's real note proof to the stale
 * node; never execute append_to_current_file or rewrite graph dependencies.
 */
export async function reconcileCompositeOwnedCurrentNoteGraphOnResume(input: {
  session: MissionGraphSession;
  receipts: readonly ResearchPublicationResumeReceiptV1[];
  rootRunId: string;
  toolContext: ToolExecutionContext;
}): Promise<ResearchPublicationGraphReconciliationResultV1> {
  if (hasConflictingReceiptIdentity(input.receipts)) {
    return {
      reconciled: false,
      reason: "publication_receipt_conflict",
    };
  }
  const canonicalReceipts = input.receipts.filter(
    isCompletedAcceptedResearchPublicationReceipt,
  );
  if (canonicalReceipts.length === 0) {
    return {
      reconciled: false,
      reason: "publication_proof_missing",
    };
  }

  const extractedProofs = canonicalReceipts
    .map((receipt) =>
      extractAcceptedResearchNoteProof(receipt, input.rootRunId),
    )
    .filter((proof): proof is AcceptedResearchNoteProofV1 => proof !== null);
  if (extractedProofs.length === 0) {
    return {
      reconciled: false,
      reason: "publication_note_proof_invalid",
    };
  }
  const proofs = [
    ...new Map(
      extractedProofs.map((proof) => [
        [
          proof.notePath,
          proof.noteReceiptId,
          proof.noteSha256,
          proof.currentNoteSha256,
          proof.artifactFingerprint,
        ].join("\u0000"),
        proof,
      ]),
    ).values(),
  ];

  await input.session.promoteReadyNodes();
  const matches = proofs.flatMap((proof) =>
    Object.values(input.session.graph.nodes)
      .filter((node) =>
        isLegacyCompositeOwnedAppendNode(
          node,
          proof.notePath,
          input.session.graph.nodes,
        ),
      )
      .map((node) => ({ node, proof })),
  );
  if (matches.length === 0) {
    return {
      reconciled: false,
      reason: "legacy_append_not_ready",
    };
  }
  if (matches.length !== 1) {
    return {
      reconciled: false,
      reason: "legacy_append_ambiguous",
    };
  }

  const { node, proof } = matches[0]!;
  if (!(await currentNoteMatchesProof(input.toolContext, proof))) {
    return {
      reconciled: false,
      nodeId: node.id,
      receiptId: proof.publicationReceiptId,
      notePath: proof.notePath,
      reason: "publication_note_state_mismatch",
    };
  }
  await input.session.apply(
    `Reconcile legacy current-note append ${node.id} from accepted-research publication proof.`,
    [
      {
        op: "set_status",
        nodeId: node.id,
        expectedStatus: "ready",
        status: "running",
        blocker: null,
      },
      {
        op: "append_evidence",
        nodeId: node.id,
        evidence: {
          id: `research-publication-note-${proof.artifactFingerprint.slice(7, 39)}`,
          kind: "tool-result",
          fingerprint: proof.artifactFingerprint,
          observedAt: proof.observedAt,
        },
      },
      {
        op: "append_receipt",
        nodeId: node.id,
        receipt: {
          id: proof.noteReceiptId,
          kind: "vault_write",
          fingerprint: proof.noteSha256,
          committedAt: proof.observedAt,
        },
      },
      {
        op: "set_status",
        nodeId: node.id,
        expectedStatus: "running",
        status: "verifying",
        blocker: null,
      },
      {
        op: "set_status",
        nodeId: node.id,
        expectedStatus: "verifying",
        status: "complete",
        blocker: null,
      },
    ],
  );
  await input.session.promoteReadyNodes();

  return {
    reconciled: true,
    nodeId: node.id,
    receiptId: proof.publicationReceiptId,
    notePath: proof.notePath,
    reason: "reconciled",
  };
}

function extractAcceptedResearchNoteProof(
  receipt: ResearchPublicationResumeReceiptV1,
  expectedRootRunId: string,
): AcceptedResearchNoteProofV1 | null {
  if (!isCompletedAcceptedResearchPublicationReceipt(receipt)) return null;
  const output = asRecord(receipt.output);
  const artifact = asRecord(output?.artifact);
  const note = asRecord(output?.note);
  const noteArtifact = asRecord(note?.artifact);
  const backlink = asRecord(output?.backlink);
  const issue = asRecord(output?.issue);
  const originRunId = stringField(artifact, "originRunId");
  const notePath = stringField(artifact, "notePath");
  const noteSha256 = stringField(artifact, "noteSha256");
  const noteReceiptId = stringField(artifact, "noteReceiptId");
  const artifactFingerprint = stringField(artifact, "artifactFingerprint");
  const publication = stringField(output, "publication");
  const noteAfterSha256 = stringField(note, "afterSha256");
  const backlinkAfterSha256 = stringField(backlink, "afterSha256");
  const publicationReceiptId =
    typeof receipt.id === "string" ? receipt.id.trim() : "";
  const observedAt = canonicalTimestamp(stringField(artifact, "acceptedAt"));
  if (
    artifact?.schemaVersion !== 1 ||
    artifact?.acceptedBy !== "host" ||
    (publication !== "created" && publication !== "deduplicated") ||
    !originRunId ||
    originRunId !== expectedRootRunId.trim() ||
    !notePath ||
    stringField(note, "path") !== notePath ||
    stringField(backlink, "path") !== notePath ||
    stringField(backlink, "issueUrl") !== stringField(issue, "url") ||
    !noteReceiptId ||
    stringField(note, "noteReceiptId") !== noteReceiptId ||
    stringField(noteArtifact, "notePath") !== notePath ||
    stringField(noteArtifact, "noteReceiptId") !== noteReceiptId ||
    stringField(noteArtifact, "artifactFingerprint") !== artifactFingerprint ||
    !isSha256(noteSha256) ||
    !isSha256(noteAfterSha256) ||
    !isSha256(backlinkAfterSha256) ||
    (publication === "created" && noteAfterSha256 !== noteSha256) ||
    (publication === "deduplicated" &&
      noteAfterSha256 !== backlinkAfterSha256) ||
    !isSha256(artifactFingerprint) ||
    !isStableReferenceId(noteReceiptId) ||
    !publicationReceiptId ||
    !observedAt
  ) {
    return null;
  }
  return {
    publicationReceiptId,
    noteReceiptId,
    notePath,
    noteSha256,
    currentNoteSha256: backlinkAfterSha256,
    artifactFingerprint,
    observedAt,
  };
}

function isLegacyCompositeOwnedAppendNode(
  node: MissionGraphSession["graph"]["nodes"][string],
  notePath: string,
  nodes: MissionGraphSession["graph"]["nodes"],
): boolean {
  return (
    node.status === "ready" &&
    node.effect === "mutation" &&
    node.executionHost === "obsidian_core" &&
    getMissionCompositeLifecycleSpecV1(node) === null &&
    node.allowedTools.length === 1 &&
    node.allowedTools[0] === "append_to_current_file" &&
    node.destination?.selector === notePath &&
    node.dependencyIds.some((dependencyId) =>
      isCompletedResearchPublicationDependency(nodes[dependencyId]),
    ) &&
    node.dependencyIds.every(
      (dependencyId) => nodes[dependencyId]?.status === "complete",
    ) &&
    node.retries.attempts === 0 &&
    node.evidence.length === 0 &&
    node.receipts.length === 0 &&
    node.blocker === null &&
    node.verification === null &&
    node.completionContract.minimumEvidence === 1 &&
    node.completionContract.requiredEvidenceKinds.length === 1 &&
    node.completionContract.requiredEvidenceKinds[0] === "tool-result" &&
    node.completionContract.minimumReceipts === 1 &&
    node.completionContract.requiredReceiptKinds.length === 1 &&
    node.completionContract.requiredReceiptKinds[0] === "vault_write" &&
    node.completionContract.verifierId === null &&
    !/\b(?:reflect(?:ion|ive)?|retrospective|postmortem|lessons?\s+learned)\b/iu.test(
      node.objective,
    )
  );
}

function isCompletedResearchPublicationDependency(
  node: MissionGraphSession["graph"]["nodes"][string] | undefined,
): boolean {
  return Boolean(
    node &&
      node.status === "complete" &&
      node.effect === "external_action" &&
      node.executionHost === "obsidian_core" &&
      getMissionCompositeLifecycleSpecV1(node) === null &&
      node.allowedTools.length === 1 &&
      node.allowedTools[0] === "publish_research_to_linear" &&
      node.evidence.some((evidence) => evidence.kind === "tool-result") &&
      node.receipts.some((receipt) => receipt.kind === "external_action") &&
      node.blocker === null,
  );
}

async function currentNoteMatchesProof(
  context: ToolExecutionContext,
  proof: AcceptedResearchNoteProofV1,
): Promise<boolean> {
  try {
    const file = context.app.vault.getFileByPath(proof.notePath);
    if (!file) return false;
    const content = await context.app.vault.read(file);
    return (await sha256DiagramContent(content)) === proof.currentNoteSha256;
  } catch {
    return false;
  }
}

function hasConflictingReceiptIdentity(
  receipts: readonly ResearchPublicationResumeReceiptV1[],
): boolean {
  const canonicalById = new Map<string, string>();
  for (const receipt of receipts) {
    const id = typeof receipt.id === "string" ? receipt.id.trim() : "";
    if (!id) continue;
    let canonical: string;
    try {
      canonical = canonicalJson(receipt);
    } catch {
      return true;
    }
    const prior = canonicalById.get(id);
    if (prior !== undefined && prior !== canonical) return true;
    canonicalById.set(id, canonical);
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown> | null,
  key: string,
): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isSha256(value: string | null): value is string {
  return Boolean(value && /^sha256:[a-f0-9]{64}$/u.test(value));
}

function isStableReferenceId(value: string): boolean {
  return (
    value.length <= 128 &&
    /^[a-z0-9](?:[a-z0-9._:-]*[a-z0-9])?$/iu.test(value)
  );
}

function canonicalTimestamp(value: string | null): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}
