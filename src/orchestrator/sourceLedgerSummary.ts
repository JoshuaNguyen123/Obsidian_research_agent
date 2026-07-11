import {
  computeSourceProofDebt,
  type SourceCandidateLedgerV1,
} from "./sourceCandidateLedger";
import type { SourceLedgerSummary } from "./types";

export function summarizeSourceLedger(
  ledger: SourceCandidateLedgerV1,
): SourceLedgerSummary {
  const candidates = Object.values(ledger.candidates);
  const usable = candidates.filter((item) => item.status === "usable");
  const unusable = candidates.filter((item) => item.status === "unusable");
  const rejected = candidates.filter((item) => item.status === "rejected");
  const proofDebt = computeSourceProofDebt(ledger);
  return {
    candidateCount: candidates.length,
    usableCount: usable.length,
    unusableCount: unusable.length,
    rejectedCount: rejected.length,
    proofDebtMissing: proofDebt.reduce((sum, item) => sum + item.missing, 0),
    proofDebtItems: proofDebt.slice(0, 6).map((item) => ({
      claimId: item.claimId,
      description: item.description,
      missing: item.missing,
    })),
    topSources: [...usable, ...candidates]
      .filter(
        (item, index, all) => all.findIndex((other) => other.id === item.id) === index,
      )
      .slice(0, 6)
      .map((item) => ({
        id: item.id,
        title: item.title,
        status: item.status,
        ...(item.url ? { url: item.url } : {}),
      })),
  };
}
