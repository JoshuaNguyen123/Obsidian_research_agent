import {
  evaluateMissionAcceptance,
  type MissionAcceptanceInput,
  type MissionAcceptanceResult,
} from "./missionAcceptance";
import type { MissionEvidence } from "./missionLedger";
import {
  CODE_RUN_SUCCESS_EVIDENCE_ID,
  getTaskEvidence,
  isFetchedWebEvidence,
  isFinalOutputRelevant,
  isWebEvidence,
  isVaultReadEvidence,
  receiptSatisfiesProof,
  taskHasRecordedProof,
  type MissionPlan,
  type MissionPlanProofKind,
  type MissionPlanTask,
} from "./missionPlan";
import type { MissionAcceptanceReceiptLike } from "./missionAcceptance";

export interface MissionPlanAcceptanceInput extends MissionAcceptanceInput {
  plan?: MissionPlan | null;
}

export function evaluateMissionPlanAcceptance(
  input: MissionPlanAcceptanceInput,
): MissionAcceptanceResult {
  const base = evaluateMissionAcceptance(input);
  if (!input.plan) {
    return base;
  }
  return mergeAcceptance(
    base,
    evaluatePlanProof(
      input.plan,
      input.evidence,
      input.receipts,
      input.finalOutput,
    ),
  );
}

function evaluatePlanProof(
  plan: MissionPlan,
  evidence: MissionEvidence[],
  receipts: MissionAcceptanceReceiptLike[],
  finalOutput?: string,
): MissionAcceptanceResult {
  const missing = new Set<string>();
  const reasons: string[] = [];
  for (const task of plan.tasks) {
    for (const proof of task.completionContract.requiredProof) {
      if (!hasProof(proof, task, plan, evidence, receipts, finalOutput)) {
        missing.add(`plan:${task.id}:${proof}`);
      }
    }
    if (task.status === "blocked" && !task.blocker) {
      missing.add(`plan:${task.id}:blocker`);
    }
  }

  if (missing.size === 0) {
    return {
      status: "pass",
      confidence: 0.9,
      missing: [],
      reasons: ["mission_plan_contracts_satisfied"],
    };
  }

  reasons.push("mission_plan_contracts_incomplete");
  return {
    status: "needs_more_work",
    confidence: 0.55,
    missing: [...missing],
    reasons,
    nextAction: "Complete the active mission-plan task proof contract.",
  };
}

function hasProof(
  proof: MissionPlanProofKind,
  task: MissionPlanTask,
  plan: MissionPlan,
  evidence: MissionEvidence[],
  receipts: MissionAcceptanceReceiptLike[],
  finalOutput?: string,
): boolean {
  const allowUnboundFallback = plan.tasks.length === 1;
  const taskEvidence = getTaskEvidence(task, evidence, allowUnboundFallback);
  const minimum = Math.max(1, task.completionContract.minEvidenceCount ?? 1);
  switch (proof) {
    case "web_evidence":
      return hasWebCoverage(taskEvidence, minimum, task.completionContract.minDistinctDomains);
    case "vault_evidence":
      return taskEvidence.filter(isVaultReadEvidence).length >= minimum;
    case "write_receipt":
    case "external_action_receipt":
    case "rename_receipt":
    case "highlight_receipt":
      return taskHasRecordedProof(task, proof) ||
        receipts.some((receipt) => receiptSatisfiesProof(proof, receipt));
    case "artifact_receipt":
      return taskHasRecordedProof(task, proof) ||
        taskEvidence.some((item) => item.kind === "artifact") ||
        receipts.some((receipt) => receiptSatisfiesProof(proof, receipt));
    case "word_count":
      return (
        taskHasRecordedProof(task, proof) ||
        (allowUnboundFallback &&
          evidence.some((item) => /count_words|word count/i.test(item.title + item.summary)))
      );
    case "code_execution":
      return (
        task.evidenceIds.includes(CODE_RUN_SUCCESS_EVIDENCE_ID) ||
        (allowUnboundFallback &&
          evidence.some((item) =>
            /run_code_block[\s\S]{0,120}exit\s*code\s*0|exit\s*code\s*0[\s\S]{0,120}run_code_block/i.test(
              `${item.title} ${item.summary}`,
            ),
          ))
      );
    case "final_relevance":
      return taskHasRecordedProof(task, proof) || isFinalOutputRelevant(plan, finalOutput);
    case "blocker":
      return Boolean(task.blocker);
  }
  return false;
}

function hasWebCoverage(
  evidence: MissionEvidence[],
  minimum: number,
  minDistinctDomains = 0,
): boolean {
  if (minDistinctDomains <= 0) {
    return evidence.filter(isWebEvidence).length >= minimum;
  }
  const fetched = evidence.filter(isFetchedWebEvidence);
  if (fetched.length < minimum) {
    return false;
  }
  const domains = new Set(
    fetched
      .map((item) => {
        try {
          return new URL(item.url ?? "").hostname.replace(/^www\./i, "").toLowerCase();
        } catch {
          return "";
        }
      })
      .filter(Boolean),
  );
  return domains.size >= minDistinctDomains;
}

function mergeAcceptance(
  base: MissionAcceptanceResult,
  plan: MissionAcceptanceResult,
): MissionAcceptanceResult {
  const missing = [...new Set([...base.missing, ...plan.missing])];
  const reasons = [...new Set([...base.reasons, ...plan.reasons])];
  if (missing.length === 0) {
    return {
      status: "pass",
      confidence: Math.min(base.confidence, plan.confidence),
      missing,
      reasons,
    };
  }
  const hardFail = base.status === "fail" || plan.status === "fail";
  return {
    status: hardFail ? "fail" : "needs_more_work",
    confidence: hardFail ? 0.3 : Math.min(base.confidence, plan.confidence),
    missing,
    reasons,
    nextAction: plan.nextAction ?? base.nextAction,
  };
}
