/**
 * Bridge live WorkerHandoff → AcceptedResearchArtifactV1 + ResearcherHandoffV1.
 *
 * // INTEGRATOR: In main.runResearchTeamMission after mergeResearchWorkerResult
 * // acceptance, call bridge → seed Lead seedMissionEvidence + attach artifact
 * // for publish_research_*. After Lead write_completed + cleared debt, allow
 * // prepared publish under envelope.
 */

import { portableSha256Text } from "../../packages/core-api/src/portableSha256";
import {
  createAcceptedResearchArtifactV1,
  type AcceptedResearchArtifactV1,
  type AcceptedResearchEvidenceKindV1,
  type AcceptedResearchEvidenceV1,
} from "../integrations/linear/AcceptedResearchArtifactV1";
import {
  createResearcherHandoffV1,
  type ResearcherHandoffV1,
} from "../agent/projectLifecycle";
import type { MissionEvidence } from "../agent/missionLedger";
import type { WorkerHandoff } from "./types";

function sha256Hex(text: string): string {
  return `sha256:${portableSha256Text(text)}`;
}

function isReadyHandoff(handoff: WorkerHandoff): boolean {
  return (
    handoff.status === "ready" ||
    handoff.status === "accepted"
  );
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isVaultMarkdownPath(value: string): boolean {
  const path = value.trim();
  return (
    path.length > 0 &&
    path.endsWith(".md") &&
    !path.includes("..") &&
    !path.includes("\\") &&
    !/^[A-Za-z]:/.test(path) &&
    !path.startsWith("/")
  );
}

function contentShaForEvidence(item: MissionEvidence, runId: string): string {
  if (
    typeof item.contentHash === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(item.contentHash)
  ) {
    return item.contentHash;
  }
  const passageKey = item.passageIds?.slice(0, 4).join(",") ?? "";
  return sha256Hex(
    `evidence:${runId}:${item.id}:${item.url ?? item.path ?? ""}:${passageKey}:${item.summary}`,
  );
}

/**
 * Resolve AcceptedResearch evidence from host-observed MissionEvidence /
 * handoff IDs. Never invents example.com (or other synthetic) provenance.
 */
export function resolveAcceptedResearchEvidenceFromWorker(input: {
  handoff: WorkerHandoff;
  runId: string;
  evidence?: MissionEvidence[];
}): AcceptedResearchEvidenceV1[] {
  const resolved: AcceptedResearchEvidenceV1[] = [];
  const seenRefs = new Set<string>();
  const push = (
    kind: AcceptedResearchEvidenceKindV1,
    reference: string,
    contentSha256: string,
    preferredId?: string,
  ): void => {
    const refKey = `${kind}:${reference}`;
    if (seenRefs.has(refKey)) return;
    seenRefs.add(refKey);
    const idBase = (preferredId?.trim() || `ev-${resolved.length + 1}`)
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .slice(0, 80);
    resolved.push({
      id: idBase || `ev-${resolved.length + 1}`,
      kind,
      reference,
      contentSha256,
    });
  };

  const missionEvidence = input.evidence ?? [];
  for (const item of missionEvidence) {
    if (resolved.length >= 20) break;
    const url = item.url?.trim();
    if (url && isHttpUrl(url)) {
      push("web", url, contentShaForEvidence(item, input.runId), item.id);
      continue;
    }
    const path = item.path?.trim();
    if (path && isVaultMarkdownPath(path)) {
      push("vault", path, contentShaForEvidence(item, input.runId), item.id);
    }
  }

  if (resolved.length > 0) {
    return resolved;
  }

  // Fallback: only accept handoff IDs that already are real URLs or vault paths.
  const handoffIds =
    input.handoff.evidenceIds.length > 0
      ? input.handoff.evidenceIds
      : input.handoff.sourceIds;
  for (const rawId of handoffIds) {
    if (resolved.length >= 20) break;
    const raw = rawId.trim();
    if (!raw) continue;
    if (isHttpUrl(raw)) {
      push("web", raw, sha256Hex(`evidence:${input.runId}:${raw}`), raw);
      continue;
    }
    if (isVaultMarkdownPath(raw)) {
      push("vault", raw, sha256Hex(`evidence:${input.runId}:${raw}`), raw);
    }
  }

  return resolved;
}

export function buildAcceptedResearchArtifactFromWorkerHandoff(input: {
  handoff: WorkerHandoff;
  notePath: string;
  noteSha256?: string;
  runId: string;
  /** Host-observed worker evidence; required for real URL/path provenance. */
  evidence?: MissionEvidence[];
}): AcceptedResearchArtifactV1 | { ok: false; reason: string } {
  const { handoff, notePath, runId } = input;
  if (!isReadyHandoff(handoff)) {
    return { ok: false, reason: `handoff_status_${handoff.status}` };
  }
  if (handoff.evidenceIds.length === 0 && handoff.sourceIds.length === 0) {
    return { ok: false, reason: "zero_usable_evidence" };
  }
  if (handoff.unresolvedQuestions.length > 0 && handoff.evidenceIds.length === 0) {
    return { ok: false, reason: "unpaid_source_proof" };
  }
  const path = notePath.trim();
  if (!path || !path.endsWith(".md")) {
    return { ok: false, reason: "invalid_note_path" };
  }
  const evidence = resolveAcceptedResearchEvidenceFromWorker({
    handoff,
    runId,
    evidence: input.evidence,
  });
  if (evidence.length === 0) {
    return { ok: false, reason: "no_resolvable_evidence_references" };
  }
  const noteSha =
    input.noteSha256?.trim() ||
    sha256Hex(`note:${runId}:${path}:${handoff.id}`);
  try {
    return createAcceptedResearchArtifactV1({
      schemaVersion: 1,
      artifactId: `accepted-research-${handoff.id}`.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 160),
      originRunId: runId,
      vaultBindingKey: "current-vault",
      notePath: path,
      noteSha256: noteSha,
      noteReceiptId: `note-receipt-${handoff.id}`.replace(/[^A-Za-z0-9._-]/g, "-"),
      evidence,
      acceptanceCriteria: [
        {
          id: "AC-1",
          text: "Lead writeback cites Researcher evidence passages.",
        },
      ],
      riskClass: handoff.confidence === "high" ? "low" : "medium",
      acceptedAt: handoff.updatedAt || handoff.createdAt || new Date().toISOString(),
      acceptedBy: "host",
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "artifact_create_failed",
    };
  }
}

export function buildResearcherHandoffV1FromWorker(input: {
  handoff: WorkerHandoff;
  runId: string;
  taskId: string;
  notePath: string;
  noteSha256: string;
  acceptedArtifactFingerprint: string;
  artifact?: AcceptedResearchArtifactV1;
  evidence?: MissionEvidence[];
}): ResearcherHandoffV1 | { ok: false; reason: string } {
  const { handoff } = input;
  if (!isReadyHandoff(handoff)) {
    return { ok: false, reason: `handoff_status_${handoff.status}` };
  }
  const artifact =
    input.artifact ??
    buildAcceptedResearchArtifactFromWorkerHandoff({
      handoff,
      notePath: input.notePath,
      noteSha256: input.noteSha256,
      runId: input.runId,
      evidence: input.evidence,
    });
  if ("ok" in artifact && artifact.ok === false) {
    return artifact;
  }
  const accepted = artifact as AcceptedResearchArtifactV1;
  if (
    input.acceptedArtifactFingerprint &&
    accepted.artifactFingerprint !== input.acceptedArtifactFingerprint
  ) {
    return { ok: false, reason: "artifact_fingerprint_mismatch" };
  }
  try {
    return createResearcherHandoffV1({
      runId: input.runId,
      taskId: input.taskId || handoff.taskId,
      evidenceIds: accepted.evidence.map((item) => item.id),
      summary: handoff.summary?.trim() || "Researcher handoff accepted.",
      unresolvedQuestions: [...handoff.unresolvedQuestions],
      acceptedAt: new Date().toISOString(),
      artifact: accepted,
    });
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error ? error.message : "researcher_handoff_failed",
    };
  }
}

/** Prompt appendix after a successful host bridge (fingerprints + real refs). */
export function formatBridgedHandoffAttachContext(input: {
  artifact: AcceptedResearchArtifactV1;
  durableHandoff: ResearcherHandoffV1;
}): string {
  return [
    "Host-attached AcceptedResearchArtifact for Lead/publish:",
    `artifactId: ${input.artifact.artifactId}`,
    `artifactFingerprint: ${input.artifact.artifactFingerprint}`,
    `researcherHandoffFingerprint: ${input.durableHandoff.fingerprint}`,
    `notePath: ${input.artifact.notePath}`,
    "Evidence references:",
    ...input.artifact.evidence.map(
      (item) => `- [${item.kind}] ${item.id}: ${item.reference}`,
    ),
  ].join("\n");
}
