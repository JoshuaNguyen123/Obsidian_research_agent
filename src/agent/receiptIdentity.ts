import type { AgentRunReceipt } from "../AgentRunner";

/** A display label is not an operation identity. Legacy replays need readback proof. */
export function sameReceiptIdentity(
  left: AgentRunReceipt,
  right: AgentRunReceipt,
): boolean {
  if (left.id && right.id) return left.id === right.id;
  if (left === right) return true;
  if (left.runId && right.runId && left.runId !== right.runId) return false;
  const leftReadback = left.readback;
  const rightReadback = right.readback;
  const leftRevision = leftReadback?.observedFingerprint ?? leftReadback?.observedRevision;
  const rightRevision = rightReadback?.observedFingerprint ?? rightReadback?.observedRevision;
  return Boolean(
    leftRevision && rightRevision && leftRevision === rightRevision &&
    leftReadback?.status === "verified" && rightReadback?.status === "verified" &&
    leftReadback.checkedAt === rightReadback.checkedAt &&
    left.toolName === right.toolName && left.operation === right.operation &&
    left.path === right.path && left.toPath === right.toPath &&
    left.backupPath === right.backupPath &&
    left.resource?.system === right.resource?.system &&
    left.resource?.resourceType === right.resource?.resourceType &&
    left.resource?.id === right.resource?.id
  );
}
