/**
 * Does every claim the mission graph makes correspond to work that actually ran?
 *
 * This is the anti-theatre property, and it is the one the product genuinely
 * promises: a completed node may not carry evidence or a receipt that no
 * observed execution produced.
 *
 * IT IS NOT THE CONVERSE. The assertion deliberately does NOT require that
 * every observed execution appear in the graph, because the runner may execute
 * a tool without graph bookkeeping: when a Soft companion has no ready node,
 * `mayBypassMissionGraphStartForSetLooseSoftCompanion` lets it run with
 * `missionGraphExecution = null`, and `finishMissionGraphTool` returns early on
 * that null, writing no evidence (AgentRunner.ts, the bypass block and the
 * `if (!missionGraphSession || !execution) return;` guard). A third
 * `linear_get_issue` re-read did exactly that in a live stage-8 run: real
 * content fingerprint, `evidenceId: null`, no node anywhere.
 *
 * So a green result here proves graph HONESTY, not graph COMPLETENESS. Some
 * genuinely executed reads are invisible to the graph by design. Do not read
 * this passing as "every execution is recorded" — it never asserted that, and
 * the earlier version that tried died on work the product never promised to
 * record. The observability gap itself is a real design question, logged
 * separately rather than papered over here.
 */

export interface ObservedExecutionLinkageV1 {
  name: string;
  sequence?: number;
  descriptorEffect?: string;
  evidenceId?: string | null;
  evidenceFingerprint?: string | null;
  receiptId?: string | null;
  receiptReadbackStatus?: string | null;
}

export interface GraphClaimV1 {
  nodeId: string;
  toolName: string;
  claimKind: "evidence" | "receipt";
  id: string;
  fingerprint: string;
}

/**
 * A receipt claim is backed only by an execution whose receipt read back as
 * verified. An unverified receipt is not proof that the mutation landed, so it
 * cannot discharge a graph claim that says it did.
 */
export const VERIFIED_RECEIPT_READBACK_STATUS_V1 = "verified";

export function isGraphClaimBackedV1(
  claim: GraphClaimV1,
  observed: readonly ObservedExecutionLinkageV1[],
): boolean {
  if (claim.claimKind === "receipt") {
    return observed.some(
      (execution) =>
        typeof execution.receiptId === "string" &&
        execution.receiptId === claim.id &&
        execution.receiptReadbackStatus ===
          VERIFIED_RECEIPT_READBACK_STATUS_V1,
    );
  }
  return observed.some(
    (execution) =>
      typeof execution.evidenceFingerprint === "string" &&
      execution.evidenceFingerprint === claim.fingerprint &&
      // The runner does not always stamp an evidence id onto the observed
      // execution. When it does, it must be the same one the graph claims.
      (execution.evidenceId === undefined ||
        execution.evidenceId === null ||
        execution.evidenceId === claim.id),
  );
}

/**
 * Every graph claim with no observed execution behind it. Empty means the
 * graph is honest about this requirement.
 */
export function findUnbackedGraphClaimsV1(
  claims: readonly GraphClaimV1[],
  observed: readonly ObservedExecutionLinkageV1[],
): GraphClaimV1[] {
  return claims.filter((claim) => !isGraphClaimBackedV1(claim, observed));
}
