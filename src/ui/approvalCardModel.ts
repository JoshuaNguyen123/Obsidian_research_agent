import type { ApprovalRequest } from "../agent/approvalBroker";

/**
 * Pure view-model for the Activity approval card.
 *
 * The card is the moment a user authorizes an outward-facing mutation, and its
 * strings were composed inline across ~140 lines of DOM construction — which
 * meant the one surface where wording is safety-relevant had no unit test and
 * no e2e assertion could be written against a stable contract. This module is
 * that contract: every user-visible string on the card comes from here, and
 * the e2e fixtures assert against these exact shapes.
 *
 * The output is byte-identical to what the inline renderer produced. Changing
 * any format here is a breaking change to e2e assertions (the
 * `fingerprint=sha256:` prefix is asserted by the research lane) — do it
 * deliberately, with the fixtures, or not at all.
 */

export interface ApprovalCardModelV1 {
  title: string;
  reason: string;
  policyLine: string;
  /** Present only when the request carries a prepared action. */
  preview: ApprovalCardPreviewModelV1 | null;
  approveLabel: string;
  denyLabel: string;
}

export interface ApprovalCardPreviewModelV1 {
  destination: string;
  summary: string;
  targetLine: string;
  /** Pretty-printed before/after JSON, or null when neither side exists. */
  diffJson: string | null;
  /** Pretty-printed outbound payload JSON, or null when absent. */
  outboundPayloadJson: string | null;
  /** One line per possible duplicate: `identifier — url`. */
  duplicateLines: string[];
  /** One line per warning: `warning=<text>`. */
  warningLines: string[];
  fingerprintLine: string;
}

export function formatApprovalCardModelV1(
  request: ApprovalRequest,
): ApprovalCardModelV1 {
  return {
    title: `${request.toolName}: ${request.action}`,
    reason: request.reason,
    policyLine: `policy=${request.policyTags.join(",") || "approval_required"}`,
    preview: buildPreviewModel(request),
    approveLabel:
      request.requiredConfirmations === 2
        ? request.confirmationIndex === 2
          ? "Confirm permanent delete"
          : "Approve deletion"
        : "Approve",
    denyLabel: "Deny",
  };
}

function buildPreviewModel(
  request: ApprovalRequest,
): ApprovalCardPreviewModelV1 | null {
  const prepared = request.preparedAction;
  if (!prepared) return null;

  const targetParts = [
    `${prepared.target.system}:${prepared.target.resourceType}`,
    prepared.target.identifier ?? prepared.target.id,
    prepared.target.url,
  ].filter((item): item is string => Boolean(item));

  const confirmation = request.requiredConfirmations ?? 1;
  const confirmationIndex = request.confirmationIndex ?? 1;

  return {
    destination: prepared.preview.destination,
    summary: prepared.preview.summary,
    targetLine: `target=${targetParts.join(" ")}`,
    diffJson:
      prepared.preview.before || prepared.preview.after
        ? JSON.stringify(
            {
              before: prepared.preview.before ?? null,
              after: prepared.preview.after ?? null,
            },
            null,
            2,
          )
        : null,
    outboundPayloadJson: prepared.preview.outboundPayload
      ? JSON.stringify(prepared.preview.outboundPayload, null, 2)
      : null,
    duplicateLines: (prepared.preview.duplicateCandidates ?? []).map(
      (candidate) =>
        `${candidate.identifier ?? candidate.id}${candidate.url ? ` — ${candidate.url}` : ""}`,
    ),
    warningLines: prepared.preview.warnings.map(
      (warning) => `warning=${warning}`,
    ),
    fingerprintLine: `fingerprint=${prepared.payloadFingerprint.slice(0, 24)}… outbound=${prepared.preview.outboundBytes}B confirmation=${confirmationIndex}/${confirmation}`,
  };
}
