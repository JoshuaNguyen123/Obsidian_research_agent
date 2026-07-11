import type {
  ActionReceipt,
  AuthorizedActionContext,
  PreparedAction,
  ResourceRef,
  ToolDescriptor,
} from "./types";

export type ReceiptValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

export function validateActionReceipt(
  receipt: ActionReceipt,
  action: PreparedAction,
  descriptor: ToolDescriptor,
  authorized: AuthorizedActionContext,
): ReceiptValidationResult {
  if (receipt.version !== 1) {
    return invalid("receipt_version", "Action receipt version must be 1.");
  }
  for (const [field, value] of [
    ["id", receipt.id],
    ["message", receipt.message],
    ["grantId", receipt.grantId],
  ] as const) {
    if (!value.trim()) {
      return invalid("receipt_field", `Action receipt ${field} is required.`);
    }
  }
  if (
    authorized.preparedActionId !== action.id ||
    receipt.actionId !== action.id
  ) {
    return invalid("receipt_action", "Action receipt does not identify the prepared action.");
  }
  if (receipt.runId !== action.runId || receipt.toolName !== action.toolName) {
    return invalid("receipt_identity", "Action receipt run or tool identity does not match.");
  }
  if (
    authorized.payloadFingerprint !== action.payloadFingerprint ||
    receipt.payloadFingerprint !== action.payloadFingerprint
  ) {
    return invalid("receipt_fingerprint", "Action receipt payload fingerprint does not match.");
  }
  if (receipt.grantId !== authorized.grantId) {
    return invalid("receipt_grant", "Action receipt grant does not match authorization.");
  }
  if (
    action.idempotencyKey !== undefined &&
    receipt.idempotencyKey !== action.idempotencyKey
  ) {
    return invalid(
      "receipt_idempotency",
      "Action receipt idempotency key does not match the prepared action.",
    );
  }
  if (receipt.operation !== descriptor.capability.action) {
    return invalid("receipt_operation", "Action receipt operation does not match the tool descriptor.");
  }
  if (!sameResourceIdentity(receipt.resource, action.target, descriptor)) {
    return invalid("receipt_resource", "Action receipt resource does not match the prepared target.");
  }
  if (
    descriptor.durability.readback === "required" &&
    receipt.readback.status !== "verified"
  ) {
    return invalid("receipt_readback", "This action requires verified provider readback.");
  }
  const startedAt = Date.parse(receipt.startedAt);
  const committedAt = Date.parse(receipt.committedAt);
  const checkedAt = Date.parse(receipt.readback.checkedAt);
  if (
    !Number.isFinite(startedAt) ||
    !Number.isFinite(committedAt) ||
    !Number.isFinite(checkedAt) ||
    committedAt < startedAt ||
    checkedAt < startedAt ||
    checkedAt > committedAt
  ) {
    return invalid("receipt_timestamps", "Action receipt timestamps are invalid or out of order.");
  }
  return { ok: true };
}

function sameResourceIdentity(
  actual: ResourceRef,
  expected: ResourceRef,
  descriptor: ToolDescriptor,
): boolean {
  if (
    actual.system !== descriptor.capability.system ||
    actual.resourceType !== descriptor.capability.resourceType ||
    actual.system !== expected.system ||
    actual.resourceType !== expected.resourceType ||
    !actual.id.trim() ||
    (descriptor.capability.action !== "create" && actual.id !== expected.id)
  ) {
    return false;
  }

  const fields: Array<keyof ResourceRef> = [
    "identifier",
    "path",
    "accountId",
    "containerId",
    "workspaceId",
    "teamId",
    "projectId",
    "repositoryId",
    "repositoryProfileId",
  ];
  return fields.every(
    (field) => expected[field] === undefined || actual[field] === expected[field],
  );
}

function invalid(code: string, message: string): ReceiptValidationResult {
  return { ok: false, code, message };
}
