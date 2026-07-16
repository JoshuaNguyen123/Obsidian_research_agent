import type { AgentRunReceipt } from "../AgentRunner";
import type { MissionAcceptanceResult } from "./missionAcceptance";
import {
  evaluateMissionPlanAcceptance,
  type MissionPlanAcceptanceInput,
} from "./missionPlanAcceptance";
import type { MissionEvidence } from "./missionLedger";
import {
  buildClaimLedger,
  type ClaimLedger,
  type ClaimPassageRef,
  shouldRequireClaimGrounding,
} from "./claimLedger";
import {
  evaluateEvidenceConflictAcceptance,
  type EvidenceConflict,
} from "./evidenceConflicts";
import {
  CODE_RUN_SUCCESS_EVIDENCE_ID,
  getEvidenceCitationIdentifiers,
  getEvidencePassageIdentifiers,
  getTaskEvidence,
  isFetchedWebEvidence,
  isFinalOutputRelevant,
  isVaultReadEvidence,
  receiptSatisfiesProof,
  taskHasRecordedProof,
  type MissionPlan,
  type MissionPlanProofKind,
  type MissionPlanTask,
} from "./missionPlan";

export type VerifierKind =
  | "proof_contract"
  | "receipt_readback"
  | "word_count"
  | "source_coverage"
  | "write_safety"
  | "final_relevance"
  | "claim_grounding"
  | "evidence_conflicts";

export interface VerificationCheck {
  id: string;
  kind: VerifierKind;
  targetNodeId?: string;
  status: "pass" | "fail" | "needs_more_work" | "blocked";
  confidence: number;
  missing: string[];
  evidenceIds: string[];
  receiptIds: string[];
  message: string;
  checkedAt: string;
}

export interface MissionVerificationResult {
  status: "pass" | "needs_more_work" | "blocked";
  checks: VerificationCheck[];
  missing: string[];
  /** Present when claim grounding ran (including skipped). */
  claimLedger?: ClaimLedger;
}

export interface MissionVerifierInput {
  plan?: MissionPlan | null;
  evidence: MissionEvidence[];
  receipts: AgentRunReceipt[];
  finalOutput?: string;
  baseAcceptance?: MissionAcceptanceResult;
  conflicts?: EvidenceConflict[] | null;
  /** Mission prompt used to decide claim-ledger grounding. */
  prompt?: string;
  /** Research mode label (deep_web / deep_hybrid / chat_answer / …). */
  researchMode?: string;
  /** Optional dossier passage texts for quote-span ⊆ passage checks. */
  passages?: ClaimPassageRef[];
  /** Force quote-span validation even when the prompt does not ask for quotes. */
  requireQuoteSpans?: boolean;
  /** Force or skip claim grounding regardless of prompt heuristics. */
  requireClaimGrounding?: boolean;
  now?: Date;
}

export function runMissionVerifiers({
  plan,
  evidence,
  receipts,
  finalOutput,
  baseAcceptance,
  conflicts,
  prompt,
  researchMode,
  passages,
  requireQuoteSpans,
  requireClaimGrounding,
  now = new Date(),
}: MissionVerifierInput): MissionVerificationResult {
  const verifierNow = normalizeVerifierDate(now);
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const receiptList = Array.isArray(receipts) ? receipts : [];
  const checks: VerificationCheck[] = [];
  if (plan) {
    for (const task of plan.tasks) {
      checks.push(
        verifyTaskProofContract(
          task,
          plan,
          evidenceList,
          receiptList,
          finalOutput,
          verifierNow,
        ),
      );
    }
  }
  if (receiptList.length > 0) {
    checks.push(verifyReceiptReadback(receiptList, evidenceList, verifierNow));
    checks.push(verifyWriteSafety(receiptList, verifierNow));
  }
  if (plan?.tasks.some((task) => task.completionContract.requiredProof.includes("word_count"))) {
    checks.push(verifyWordCount(plan, evidenceList, verifierNow));
  }
  if (plan) {
    for (const task of plan.tasks.filter(taskRequiresSourceCoverageCheck)) {
      checks.push(
        verifySourceCoverage(task, plan.tasks.length === 1, evidenceList, verifierNow),
      );
    }
  }
  if (finalOutput !== undefined) {
    checks.push(verifyFinalRelevance(finalOutput, plan, evidenceList, verifierNow));
  }
  let claimLedger: ClaimLedger | undefined;
  if (finalOutput !== undefined) {
    const claimCheck = verifyClaimGrounding({
      finalOutput,
      plan,
      evidence: evidenceList,
      prompt,
      researchMode,
      passages,
      requireQuoteSpans,
      requireClaimGrounding,
      now: verifierNow,
    });
    if (claimCheck) {
      checks.push(claimCheck.check);
      claimLedger = claimCheck.ledger;
    }
  }
  if (conflicts && conflicts.length > 0) {
    checks.push(verifyEvidenceConflicts(conflicts, finalOutput, verifierNow));
  }
  // Base acceptance gaps are merged by the caller via mergeVerificationIntoAcceptance.
  void baseAcceptance;
  const missing = [...new Set(checks.flatMap((check) => check.missing))];
  const blocked = checks.some((check) => check.status === "blocked" || check.status === "fail");
  return {
    status: blocked ? "blocked" : missing.length > 0 ? "needs_more_work" : "pass",
    checks,
    missing,
    ...(claimLedger ? { claimLedger } : {}),
  };
}

function normalizeVerifierDate(value: unknown): Date {
  return value instanceof Date && Number.isFinite(value.getTime())
    ? value
    : new Date();
}

export function mergeVerificationIntoAcceptance(
  acceptance: MissionAcceptanceResult,
  verification: MissionVerificationResult,
): MissionAcceptanceResult {
  if (verification.status === "pass") {
    return acceptance;
  }
  const missing = [...new Set([...acceptance.missing, ...verification.missing])];
  return {
    ...acceptance,
    status: verification.status === "blocked" || acceptance.status === "fail"
      ? "fail"
      : "needs_more_work",
    confidence: Math.min(acceptance.confidence, verification.status === "blocked" ? 0.3 : 0.55),
    missing,
    reasons: [...new Set([...acceptance.reasons, "verifier_checks_incomplete"])],
    nextAction: acceptance.nextAction ?? "Complete verifier-required proof before finalizing.",
  };
}

function verifyTaskProofContract(
  task: MissionPlanTask,
  plan: MissionPlan,
  evidence: MissionEvidence[],
  receipts: AgentRunReceipt[],
  finalOutput: string | undefined,
  now: Date,
): VerificationCheck {
  const missing = task.completionContract.requiredProof
    .filter((proof) => !hasProof(proof, task, plan, evidence, receipts, finalOutput))
    .map((proof) => `verifier:${task.id}:${proof}`);
  return {
    id: `verifier:${task.id}:proof_contract`,
    kind: "proof_contract",
    targetNodeId: task.id,
    status: missing.length === 0 ? "pass" : task.status === "blocked" ? "blocked" : "needs_more_work",
    confidence: missing.length === 0 ? 0.9 : 0.55,
    missing,
    evidenceIds: task.evidenceIds,
    receiptIds: task.receiptIds,
    message: missing.length === 0
      ? `Task ${task.id} proof contract passed.`
      : `Task ${task.id} is missing verifier proof: ${missing.join(", ")}.`,
    checkedAt: now.toISOString(),
  };
}

function verifyReceiptReadback(
  receipts: AgentRunReceipt[],
  evidence: MissionEvidence[],
  now: Date,
): VerificationCheck {
  const receiptIds = receipts.map(getReceiptRef);
  const readbackEvidence = evidence.filter(isVaultReadEvidence);
  const missing = receipts
    .filter((receipt) =>
      receipt.version === 1
        ? !receipt.readback
        : Boolean(
            receipt.path &&
              !hasReceiptObservableProof(receipt) &&
              !readbackEvidence.some((item) => item.path === receipt.path),
          ),
    )
    .map(
      (receipt) =>
        `verifier:receipt_readback:${receipt.path ?? receipt.resource?.id ?? receipt.toolName}`,
    );
  return {
    id: "verifier:receipt_readback",
    kind: "receipt_readback",
    status: missing.length === 0 ? "pass" : "needs_more_work",
    confidence: missing.length === 0 ? 0.85 : 0.5,
    missing,
    evidenceIds: readbackEvidence.map((item) => item.id),
    receiptIds,
    message: missing.length === 0
      ? "Write receipts have readback or observable receipt proof."
      : "One or more write receipts still need readback proof.",
    checkedAt: now.toISOString(),
  };
}

function hasReceiptObservableProof(receipt: AgentRunReceipt): boolean {
  return (
    receipt.readback?.status === "verified" ||
    receipt.readback?.status === "not_required" ||
    receipt.bytesWritten !== undefined ||
    receipt.bytesDeleted !== undefined ||
    receipt.affectedCount !== undefined ||
    receipt.output !== undefined ||
    receipt.operation === "trash" ||
    receipt.operation === "rename_current_file"
  );
}

function verifyWriteSafety(receipts: AgentRunReceipt[], now: Date): VerificationCheck {
  const risky = receipts.filter(
    (receipt) =>
      (receipt.resource?.system === "vault" ||
        (!receipt.resource && Boolean(receipt.path))) &&
      ["replace", "delete", "trash", "restore"].includes(receipt.operation),
  );
  const missing = risky
    .filter(
      (receipt) =>
        receipt.operation !== "trash" &&
        !(
          receipt.toolName === "delete_path" &&
          receipt.readback?.status === "verified"
        ) &&
        !receipt.backupPath &&
        !receipt.restoredFromBackupPath,
    )
    .map((receipt) => `verifier:write_safety:${receipt.path ?? receipt.operation}`);
  return {
    id: "verifier:write_safety",
    kind: "write_safety",
    status: missing.length === 0 ? "pass" : "blocked",
    confidence: missing.length === 0 ? 0.9 : 0.25,
    missing,
    evidenceIds: [],
    receiptIds: receipts.map(getReceiptRef),
    message: missing.length === 0
      ? "Risky write receipts include required safety metadata."
      : "Risky write receipt is missing backup or restore metadata.",
    checkedAt: now.toISOString(),
  };
}

function verifyWordCount(
  plan: MissionPlan,
  evidence: MissionEvidence[],
  now: Date,
): VerificationCheck {
  const proof = plan.tasks.some((task) => task.evidenceIds.includes("tool:count_words")) ||
    evidence.some((item) => /count_words|word count/i.test(`${item.title} ${item.summary}`));
  return {
    id: "verifier:word_count",
    kind: "word_count",
    status: proof ? "pass" : "needs_more_work",
    confidence: proof ? 0.9 : 0.45,
    missing: proof ? [] : ["verifier:word_count"],
    evidenceIds: evidence.map((item) => item.id),
    receiptIds: [],
    message: proof ? "Word-count proof is present." : "Word-count proof is missing.",
    checkedAt: now.toISOString(),
  };
}

function verifySourceCoverage(
  task: MissionPlanTask,
  allowUnboundFallback: boolean,
  evidence: MissionEvidence[],
  now: Date,
): VerificationCheck {
  const requireFetchedCoverage =
    taskRequiresCitationCoverage(task) ||
    (task.completionContract.minDistinctDomains ?? 0) > 0;
  const webEvidence = getTaskEvidence(task, evidence, allowUnboundFallback)
    .filter((item) =>
      requireFetchedCoverage ? isFetchedWebEvidence(item) : isAnyWebEvidence(item),
    );
  const minimum = Math.max(1, task.completionContract.minEvidenceCount ?? 1);
  const domains = new Set(
    webEvidence
      .map((item) => getUrlDomain(item.url))
      .filter((domain): domain is string => Boolean(domain)),
  );
  const requiredDomains = Math.max(0, task.completionContract.minDistinctDomains ?? 0);
  const hasCoverage =
    webEvidence.length >= minimum && domains.size >= requiredDomains;
  const missing = [
    ...(webEvidence.length < minimum
      ? [`verifier:${task.id}:source_coverage:${webEvidence.length}/${minimum}`]
      : []),
    ...(domains.size < requiredDomains
      ? [`verifier:${task.id}:source_domains:${domains.size}/${requiredDomains}`]
      : []),
  ];
  return {
    id: `verifier:${task.id}:source_coverage`,
    kind: "source_coverage",
    targetNodeId: task.id,
    status: hasCoverage ? "pass" : "needs_more_work",
    confidence: hasCoverage ? 0.85 : 0.45,
    missing,
    evidenceIds: webEvidence.map((item) => item.id),
    receiptIds: [],
    message: hasCoverage
      ? `Task ${task.id} has ${webEvidence.length} bound fetched source(s) across ${domains.size} domain(s).`
      : `Task ${task.id} lacks bound fetched-source coverage.`,
    checkedAt: now.toISOString(),
  };
}

function verifyFinalRelevance(
  finalOutput: string | undefined,
  plan: MissionPlan | null | undefined,
  evidence: MissionEvidence[],
  now: Date,
): VerificationCheck {
  const hasOutput = Boolean(finalOutput?.trim());
  const requiresPlanRelevance =
    plan?.tasks.some((task) =>
      task.completionContract.requiredProof.includes("final_relevance"),
    ) === true;
  const relevant =
    hasOutput &&
    (!plan || !requiresPlanRelevance || isFinalOutputRelevant(plan, finalOutput));
  const citationMissing = plan
    ? plan.tasks
        .filter((task) => task.completionContract.requiredProof.includes("web_evidence"))
        .filter(taskRequiresCitationCoverage)
        .filter((task) => {
          const requirePassageCitation = taskRequiresPassageCitation(task);
          const taskEvidence = getTaskEvidence(
            task,
            evidence,
            plan.tasks.length === 1,
          ).filter((item) =>
            requirePassageCitation
              ? isFetchedWebEvidence(item)
              : isAnyWebEvidence(item),
          );
          const identifiersFor = (item: MissionEvidence) =>
            requirePassageCitation
              ? getEvidencePassageIdentifiers(item)
              : item.url
                ? [item.url]
                : getEvidenceCitationIdentifiers(item);
          const citableEvidence = taskEvidence.filter(
            (item) => identifiersFor(item).length > 0,
          );
          if (citableEvidence.length === 0) {
            return taskEvidence.length > 0;
          }
          const required = Math.min(
            citableEvidence.length,
            Math.max(1, task.completionContract.minEvidenceCount ?? 1),
          );
          const cited = citableEvidence.filter((item) =>
            identifiersFor(item).some((identifier) =>
              finalOutput?.includes(identifier),
            ),
          ).length;
          return cited < required;
        })
        .map((task) => `verifier:citation_coverage:${task.id}`)
    : [];
  const missing = [
    ...(!hasOutput ? ["verifier:final_output"] : []),
    ...(hasOutput && !relevant ? ["verifier:final_relevance"] : []),
    ...citationMissing,
  ];
  const passed = missing.length === 0;
  return {
    id: "verifier:final_relevance",
    kind: "final_relevance",
    status: passed ? "pass" : "needs_more_work",
    confidence: passed ? 0.85 : 0.4,
    missing,
    evidenceIds: evidence.map((item) => item.id),
    receiptIds: [],
    message: passed
      ? "Final output is mission-relevant and cites bound source identifiers."
      : "Final output is missing mission relevance or bound source citations.",
    checkedAt: now.toISOString(),
  };
}

function verifyEvidenceConflicts(
  conflicts: EvidenceConflict[],
  finalOutput: string | undefined,
  now: Date,
): VerificationCheck {
  const finding = evaluateEvidenceConflictAcceptance({ conflicts, finalOutput });
  const missing = finding.missing.map((item) => `verifier:${item}`);
  const passed = missing.length === 0;
  return {
    id: "verifier:evidence_conflicts",
    kind: "evidence_conflicts",
    status: passed ? "pass" : "needs_more_work",
    confidence: passed ? 0.9 : 0.45,
    missing,
    evidenceIds: [],
    receiptIds: [],
    message: passed
      ? "Evidence conflicts are resolved or acknowledged with limitation text."
      : "Open or unacknowledged evidence conflicts still block acceptance.",
    checkedAt: now.toISOString(),
  };
}

function verifyClaimGrounding(input: {
  finalOutput: string;
  plan?: MissionPlan | null;
  evidence: MissionEvidence[];
  prompt?: string;
  researchMode?: string;
  passages?: ClaimPassageRef[];
  requireQuoteSpans?: boolean;
  requireClaimGrounding?: boolean;
  now: Date;
}): { check: VerificationCheck; ledger: ClaimLedger } | null {
  const promptHint = [
    input.prompt ?? "",
    input.researchMode ?? "",
    ...(input.plan?.tasks.map((task) => task.title) ?? []),
  ]
    .filter(Boolean)
    .join(" ");
  const planRequires =
    input.plan?.tasks.some((task) => taskRequiresPassageCitation(task)) === true;
  const shouldRun =
    input.requireClaimGrounding === true ||
    (input.requireClaimGrounding !== false &&
      (planRequires ||
        shouldRequireClaimGrounding(input.prompt ?? "") ||
        // Bare researchMode tokens are only used when the caller did not pass an
        // explicit requireClaimGrounding flag (unit tests / forced ledger builds).
        shouldRequireClaimGrounding(input.researchMode ?? "")));
  if (!shouldRun) {
    return null;
  }

  const ledger = buildClaimLedger({
    draft: input.finalOutput,
    evidence: input.evidence,
    passages: input.passages,
    prompt: input.prompt || promptHint || "deep research",
    mode: input.researchMode,
    requireQuoteSpans: input.requireQuoteSpans,
    forceRequire: true,
  });

  if (ledger.status === "skipped") {
    return {
      ledger,
      check: {
        id: "verifier:claim_grounding",
        kind: "claim_grounding",
        status: "pass",
        confidence: 0.9,
        missing: [],
        evidenceIds: input.evidence.map((item) => item.id),
        receiptIds: [],
        message: "Claim grounding skipped for this mission mode.",
        checkedAt: input.now.toISOString(),
      },
    };
  }

  const missing = ledger.missing.map((item) =>
    item.startsWith("verifier:") ? item : `verifier:${item}`,
  );
  const passed = missing.length === 0;
  return {
    ledger,
    check: {
      id: "verifier:claim_grounding",
      kind: "claim_grounding",
      status: passed ? "pass" : "needs_more_work",
      confidence: passed ? 0.88 : 0.4,
      missing,
      evidenceIds: input.evidence.map((item) => item.id),
      receiptIds: [],
      message: passed
        ? `Claim grounding passed for ${ledger.claims.filter((claim) => claim.status === "grounded").length}/${ledger.claims.length} claim(s).`
        : ledger.nextAction ??
          "One or more material claims lack grounded passage citations.",
      checkedAt: input.now.toISOString(),
    },
  };
}

function taskRequiresPassageCitation(task: MissionPlanTask): boolean {
  if (task.completionContract.citationMode) {
    return task.completionContract.citationMode === "passage";
  }
  // Backward compatibility for v1 snapshots created before citationMode was
  // persisted in the task proof contract.
  return legacyTaskTitleRequiresCitationCoverage(task);
}

function taskRequiresCitationCoverage(task: MissionPlanTask): boolean {
  return task.completionContract.citationMode !== undefined ||
    legacyTaskTitleRequiresCitationCoverage(task);
}

function taskRequiresSourceCoverageCheck(task: MissionPlanTask): boolean {
  return task.completionContract.requiredProof.includes("web_evidence") &&
    (taskRequiresCitationCoverage(task) ||
      (task.completionContract.minDistinctDomains ?? 0) > 0);
}

function legacyTaskTitleRequiresCitationCoverage(task: MissionPlanTask): boolean {
  const title = task.title.replace(/^Verify the final answer for:\s*/i, "");
  return /\b(?:cite|cited|citation|citations|passage|passages|quote|quoted|quotations|verify|fact[-\s]?check|deep\s+research|long[-\s]?running\s+(?:research|co-?research)|long\s+research|exhaustive\s+(?:research|investigation))\b/i.test(
    title,
  );
}

function hasProof(
  proof: MissionPlanProofKind,
  task: MissionPlanTask,
  plan: MissionPlan,
  evidence: MissionEvidence[],
  receipts: AgentRunReceipt[],
  finalOutput?: string,
): boolean {
  const allowUnboundFallback = plan.tasks.length === 1;
  const taskEvidence = getTaskEvidence(task, evidence, allowUnboundFallback);
  const minimum = Math.max(1, task.completionContract.minEvidenceCount ?? 1);
  switch (proof) {
    case "web_evidence":
      if (taskHasRecordedProof(task, proof)) {
        return true;
      }
      return taskEvidence.filter((item) =>
        taskRequiresCitationCoverage(task) ||
          (task.completionContract.minDistinctDomains ?? 0) > 0
          ? isFetchedWebEvidence(item)
          : isAnyWebEvidence(item),
      ).length >= minimum;
    case "vault_evidence":
      return taskHasRecordedProof(task, proof) ||
        taskEvidence.filter(isVaultReadEvidence).length >= minimum;
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
      return taskHasRecordedProof(task, proof) ||
        (allowUnboundFallback &&
          evidence.some((item) => /count_words|word count/i.test(`${item.title} ${item.summary}`)));
    case "code_execution":
      return task.evidenceIds.includes(CODE_RUN_SUCCESS_EVIDENCE_ID);
    case "final_relevance":
      return taskHasRecordedProof(task, proof) || isFinalOutputRelevant(plan, finalOutput);
    case "blocker":
      return Boolean(task.blocker);
  }
  return false;
}

function isAnyWebEvidence(item: MissionEvidence): boolean {
  return item.kind === "web_source" || Boolean(item.url);
}

function getUrlDomain(url: string | undefined): string | null {
  try {
    return new URL(url ?? "").hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return null;
  }
}

function getReceiptRef(receipt: AgentRunReceipt): string {
  return `${receipt.toolName}:${receipt.operation}:${
    receipt.resource
      ? `${receipt.resource.system}:${receipt.resource.id}`
      : receipt.path ?? receipt.toPath ?? ""
  }`;
}

export interface CompletionVerifierResult {
  id: string;
  status: "pass" | "fail" | "needs_more_work";
  confidence: number;
  missing: string[];
  reasons: string[];
  nextAction?: string;
}

export interface CompletionVerifier {
  id: string;
  verify(input: MissionPlanAcceptanceInput): CompletionVerifierResult;
}

export interface VerifierCompletionInput extends MissionPlanAcceptanceInput {
  verifiers?: CompletionVerifier[];
}

export interface VerifierCompletionResult {
  status: "pass" | "fail" | "needs_more_work";
  confidence: number;
  missing: string[];
  reasons: string[];
  nextAction?: string;
  verifierResults: CompletionVerifierResult[];
}

export const missionAcceptanceVerifier: CompletionVerifier = {
  id: "mission_acceptance",
  verify(input: MissionPlanAcceptanceInput): CompletionVerifierResult {
    const result = evaluateMissionPlanAcceptance(input);
    return {
      id: this.id,
      status: result.status,
      confidence: result.confidence,
      missing: [...result.missing],
      reasons: [...result.reasons],
      nextAction: result.nextAction,
    };
  },
};

export function evaluateVerifierCompletion(
  input: VerifierCompletionInput,
): VerifierCompletionResult {
  const verifiers =
    input.verifiers && input.verifiers.length > 0
      ? [missionAcceptanceVerifier, ...input.verifiers]
      : [missionAcceptanceVerifier];
  const verifierResults = verifiers.map((verifier) => verifier.verify(input));
  return {
    status: mergeCompletionStatuses(verifierResults.map((result) => result.status)),
    confidence:
      verifierResults.length === 0
        ? 0
        : Math.min(...verifierResults.map((result) => result.confidence)),
    missing: [...new Set(verifierResults.flatMap((result) => result.missing))],
    reasons: [...new Set(verifierResults.flatMap((result) => result.reasons))],
    nextAction: verifierResults.find((result) => result.nextAction)?.nextAction,
    verifierResults,
  };
}

export function createStaticVerifier(
  id: string,
  result: Omit<CompletionVerifierResult, "id">,
): CompletionVerifier {
  return {
    id,
    verify(): CompletionVerifierResult {
      return {
        id,
        status: result.status,
        confidence: result.confidence,
        missing: [...result.missing],
        reasons: [...result.reasons],
        nextAction: result.nextAction,
      };
    },
  };
}

function mergeCompletionStatuses(
  statuses: Array<CompletionVerifierResult["status"]>,
): CompletionVerifierResult["status"] {
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("needs_more_work")) {
    return "needs_more_work";
  }
  return "pass";
}
