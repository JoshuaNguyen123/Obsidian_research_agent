import type { ClaimPassageRef } from "../agent/claimLedger";
import {
  detectEvidenceConflicts,
  listOpenEvidenceConflicts,
} from "../agent/evidenceConflicts";
import {
  mergeMissionEvidence,
  type MissionEvidence,
} from "../agent/missionLedger";
import type { MergeSummary, WorkerHandoff } from "./types";
import type { ResearchWorkerResult } from "./researchWorker";

export interface TeamEvidenceMergeResult {
  evidence: MissionEvidence[];
  claimPassages: ClaimPassageRef[];
  handoff: WorkerHandoff;
  merge: MergeSummary;
  promptContext: string;
}

export function mergeResearchWorkerResult(input: {
  existingEvidence?: MissionEvidence[];
  existingClaimPassages?: ClaimPassageRef[];
  worker: ResearchWorkerResult;
  now?: Date;
}): TeamEvidenceMergeResult {
  const evidence = [...(input.existingEvidence ?? [])];
  let accepted = 0;
  let deduplicated = 0;
  let rejected = 0;
  for (const incoming of input.worker.evidence) {
    if (!isUsableEvidence(incoming)) {
      rejected += 1;
      continue;
    }
    const index = evidence.findIndex((item) => sameEvidenceSource(item, incoming));
    if (index >= 0) {
      evidence[index] = mergeMissionEvidence(evidence[index], incoming);
      deduplicated += 1;
    } else {
      evidence.push(incoming);
      accepted += 1;
    }
  }

  const claimPassages = [...(input.existingClaimPassages ?? [])];
  for (const passage of input.worker.claimPassages) {
    const index = claimPassages.findIndex((item) => item.id === passage.id);
    if (index >= 0) {
      claimPassages[index] = passage;
    } else {
      claimPassages.push(passage);
    }
  }

  const now = (input.now ?? new Date()).toISOString();
  const openConflicts = listOpenEvidenceConflicts(
    detectEvidenceConflicts(
      claimPassages.map((passage) => ({
        id: passage.id,
        text: passage.text,
      })),
    ),
  ).length;
  const handoff: WorkerHandoff = {
    ...input.worker.handoff,
    status: accepted + deduplicated > 0 ? "accepted" : "rejected",
    updatedAt: now,
  };
  const merge: MergeSummary = {
    status: rejected > 0 && accepted + deduplicated === 0 ? "blocked" : "complete",
    evidenceReceived: input.worker.evidence.length,
    evidenceAccepted: accepted + deduplicated,
    evidenceRejected: rejected,
    evidenceDeduplicated: deduplicated,
    conflicts: openConflicts,
    commitShas: [],
    verificationStatus:
      accepted + deduplicated > 0 ? "pending" : "blocked",
    integrationStatus: "not_applicable",
    ...(accepted + deduplicated === 0
      ? { blocker: "worker_handoff_has_no_usable_evidence" }
      : {}),
    updatedAt: now,
  };

  return {
    evidence,
    claimPassages,
    handoff,
    merge,
    promptContext: formatHandoffForLead(handoff, input.worker.evidence),
  };
}

export function formatHandoffForLead(
  handoff: WorkerHandoff,
  evidence: MissionEvidence[],
): string {
  const usable = evidence.filter(isUsableEvidence);
  const evidenceLines = usable.slice(0, 12).map((item) => {
    const locator = item.url ?? item.path ?? item.sourceId ?? item.id;
    const passages = item.passageIds?.slice(0, 4).join(", ") ?? "none";
    return `- ${item.title}: ${locator}; passages=${passages}; ${item.summary}`;
  });

  if (usable.length === 0) {
    return [
      "Researcher handoff contained no usable accepted evidence.",
      `Task: ${handoff.taskId}`,
      `Summary: ${handoff.summary}`,
      `Confidence: ${handoff.confidence}`,
      ...(handoff.unresolvedQuestions.length > 0
        ? [`Unresolved: ${handoff.unresolvedQuestions.join(" | ")}`]
        : []),
      "Recovery required before final acceptance:",
      "1. Call web_search for the mission's open questions.",
      "2. Call web_fetch on the strongest candidate URLs and extract passages.",
      "3. Do not treat search snippets alone as proof.",
      "Evidence:",
      "- No usable evidence.",
    ].join("\n");
  }

  return [
    "Researcher handoff (observed evidence; verify before final acceptance):",
    `Task: ${handoff.taskId}`,
    `Summary: ${handoff.summary}`,
    `Confidence: ${handoff.confidence}`,
    ...(handoff.unresolvedQuestions.length > 0
      ? [`Unresolved: ${handoff.unresolvedQuestions.join(" | ")}`]
      : []),
    "Evidence:",
    ...evidenceLines,
    "Lead-only completion contract:",
    "- The Researcher is read-only. Only the Lead may request the authorized write.",
    "- Cite each factual claim with the accepted passage identifier in the exact form [passage:<id>].",
    "- Include explicit ## Limitations and ## Confidence sections before final acceptance.",
    "- When the mission requests current-note append, append exactly once with append_to_current_file after the synthesis passes verification.",
  ].join("\n");
}

function isUsableEvidence(evidence: MissionEvidence): boolean {
  if (evidence.kind !== "web_source") return true;
  return (
    evidence.usableSource !== false &&
    Boolean(evidence.url?.trim()) &&
    (evidence.passageIds?.length ?? 0) > 0
  );
}

function sameEvidenceSource(
  left: MissionEvidence,
  right: MissionEvidence,
): boolean {
  if (left.id === right.id) return true;
  if (left.sourceId && right.sourceId) return left.sourceId === right.sourceId;
  if (left.url && right.url) return normalizeUrl(left.url) === normalizeUrl(right.url);
  return Boolean(left.path && right.path && left.path === right.path);
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = "";
    return url.toString();
  } catch {
    return value.trim().toLowerCase();
  }
}
