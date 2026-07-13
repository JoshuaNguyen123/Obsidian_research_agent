import {
  createPreparedExternalActionHandoffV1,
  type PreparedExternalActionHandoffV1,
} from "../../packages/core-api/src/preparedExternalActionHandoffV1";
import { parseMissionGraphV3, type MissionGraphV3 } from "./missionGraphV3";
import { canonicalMissionGraphId } from "./missionGraphIds";
import {
  canonicalJson,
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "./actions";
import {
  consumeAuthorityGrant,
  evaluateAuthorityGrant,
  verifyAuthorityGrantFingerprint,
  type AuthorityGrantV1,
} from "./authority";

export interface BuildPreparedLinearIssueStateUpdateHandoffInputV1 {
  graph: MissionGraphV3;
  nodeId: string;
  preparedAction: PreparedAction;
  descriptor: ToolDescriptor;
  approvedGrant: AuthorityGrantV1;
  consumedGrant: AuthorityGrantV1;
  credentialReferenceId: string;
  now?: Date;
}

export class PreparedExternalActionHostErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_prepared_action"
      | "invalid_descriptor"
      | "invalid_authority"
      | "invalid_graph_scope"
      | "invalid_linear_state_update",
    message: string,
  ) {
    super(message);
    this.name = "PreparedExternalActionHostErrorV1";
  }
}

/**
 * Projects one exact prepared Linear state update into the shared, secret-free
 * handoff contract. It verifies the approved-to-consumed grant transition
 * rather than trusting mutable grant usage fields supplied by a caller.
 */
export async function buildPreparedLinearIssueStateUpdateHandoffV1(
  input: BuildPreparedLinearIssueStateUpdateHandoffInputV1,
): Promise<PreparedExternalActionHandoffV1> {
  const now = input.now ?? new Date();
  const graph = await parseMissionGraphV3(input.graph);
  const action = input.preparedAction;
  const descriptor = input.descriptor;
  if (
    graph.capabilityEnvelope.expiresAt !== null &&
    now.getTime() >= Date.parse(graph.capabilityEnvelope.expiresAt)
  ) {
    fail("invalid_graph_scope", "Mission capability envelope has expired.");
  }
  if (!(await verifyPreparedActionFingerprint(action))) {
    fail("invalid_prepared_action", "Prepared Linear action fingerprint is invalid.");
  }
  assertFixedDescriptor(descriptor, action);
  const payload = parseFixedLinearStateUpdate(action);
  const node = graph.nodes[input.nodeId];
  if (!node) {
    fail("invalid_graph_scope", `Mission node ${input.nodeId} does not exist.`);
  }
  if (
    graph.missionId !== canonicalMissionGraphId(action.runId) ||
    node.status !== "running" ||
    (node.executionHost !== "companion" &&
      node.executionHost !== "headless_runtime") ||
    node.effect !== "external_action" ||
    node.allowedTools.length !== 1 ||
    node.allowedTools[0] !== "linear_update_issue" ||
    node.destination === null ||
    node.destination.effect !== "external_action" ||
    (node.destination.selector !== null &&
      node.destination.selector !== action.target.id &&
      node.destination.selector !== action.target.identifier)
  ) {
    fail(
      "invalid_graph_scope",
      "Prepared Linear action is not bound to one running background external-action node.",
    );
  }
  const toolGrant = graph.capabilityEnvelope.tools.linear_update_issue;
  const executorGrant = graph.capabilityEnvelope.executors[node.executorId];
  const binding = graph.capabilityEnvelope.bindings[node.destination.bindingId];
  if (
    !toolGrant ||
    toolGrant.effect !== "external_action" ||
    !toolGrant.executionHosts.includes(node.executionHost) ||
    !executorGrant ||
    !executorGrant.executionHosts.includes(node.executionHost) ||
    !executorGrant.allowedEffects.includes("external_action") ||
    !binding ||
    (binding.kind !== "issue" && binding.kind !== "linear-work-item") ||
    !binding.allowedEffects.includes("external_action") ||
    !toolGrant.bindingKinds.includes(binding.kind) ||
    !node.resourceLocks.some(
      (lock) => lock.bindingId === binding.id && lock.mode === "exclusive",
    )
  ) {
    fail(
      "invalid_graph_scope",
      "Mission capability envelope does not grant this exact Linear background mutation.",
    );
  }
  await assertConsumedGrantTransition({
    approved: input.approvedGrant,
    consumed: input.consumedGrant,
    action,
    descriptor,
  });
  const consumedAt = input.consumedGrant.usage.lastUsedAt!;
  if (
    Date.parse(consumedAt) > now.getTime() ||
    now.getTime() >= Date.parse(action.expiresAt) ||
    now.getTime() >= Date.parse(input.consumedGrant.expiresAt)
  ) {
    fail(
      "invalid_authority",
      "Prepared action or consumed authority has expired or has an invalid consumption time.",
    );
  }
  const descriptorFingerprint = await sha256Fingerprint(descriptor);
  const nodeFingerprint = await sha256Fingerprint({
    id: node.id,
    executorId: node.executorId,
    executionHost: node.executionHost,
    effect: node.effect,
    inputs: node.inputs,
    requiredCapabilities: node.requiredCapabilities,
    allowedTools: node.allowedTools,
    destination: node.destination,
    resourceLocks: node.resourceLocks,
    budget: node.budget,
    completionContract: node.completionContract,
  });
  const expiresAt = new Date(
    Math.min(Date.parse(action.expiresAt), Date.parse(input.consumedGrant.expiresAt)),
  ).toISOString();
  const handoffSeed = await sha256Fingerprint({
    missionId: graph.missionId,
    nodeId: node.id,
    action: action.payloadFingerprint,
    descriptor: descriptorFingerprint,
    graphRevision: graph.revision,
    capabilityEnvelope: graph.capabilityEnvelope.fingerprint,
    node: nodeFingerprint,
    binding: binding.destinationFingerprint,
    grant: input.consumedGrant.authorityFingerprint,
    idempotencyKey: action.idempotencyKey,
  });
  return createPreparedExternalActionHandoffV1({
    id: `handoff:${handoffSeed.slice("sha256:".length, "sha256:".length + 40)}`,
    missionId: graph.missionId,
    graphRevision: graph.revision,
    capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
    nodeId: node.id,
    nodeFingerprint,
    executionHost: node.executionHost,
    toolName: "linear_update_issue",
    descriptorFingerprint,
    preparedActionId: action.id,
    preparedActionFingerprint: action.payloadFingerprint,
    binding: {
      id: binding.id,
      kind: binding.kind,
      destinationFingerprint: binding.destinationFingerprint,
    },
    authority: {
      id: input.consumedGrant.id,
      authorityFingerprint: input.consumedGrant.authorityFingerprint,
      actionFingerprint: action.payloadFingerprint,
      consumedAt,
      expiresAt: input.consumedGrant.expiresAt,
    },
    payload: {
      issueId: payload.issueId,
      stateId: payload.stateId,
      preconditionFingerprint: payload.preconditionFingerprint,
      credentialReferenceId: input.credentialReferenceId,
    },
    idempotencyKey: action.idempotencyKey!,
    reconciliationKey: action.reconciliationKey!,
    preparedAt: now.toISOString(),
    expiresAt,
  });
}

function assertFixedDescriptor(
  descriptor: ToolDescriptor,
  action: PreparedAction,
): void {
  if (
    descriptor.version !== 1 ||
    descriptor.name !== "linear_update_issue" ||
    action.toolName !== descriptor.name ||
    descriptor.capability.system !== "linear" ||
    descriptor.capability.resourceType !== "issue" ||
    descriptor.capability.action !== "update" ||
    descriptor.effect !== "reversible_mutation" ||
    descriptor.execution.preparation !== "required" ||
    descriptor.durability.journal !== true ||
    descriptor.durability.receipt !== true ||
    descriptor.durability.readback !== "required" ||
    descriptor.durability.reconciliation !== "required" ||
    action.target.system !== "linear" ||
    action.target.resourceType !== "issue" ||
    action.target.path !== undefined
  ) {
    fail(
      "invalid_descriptor",
      "Background handoff accepts only the fixed, journaled Linear issue update descriptor.",
    );
  }
}

function parseFixedLinearStateUpdate(action: PreparedAction): {
  issueId: string;
  stateId: string;
  preconditionFingerprint: string;
} {
  const args = action.normalizedArgs;
  const variables = exactRecord(args.variables, ["id", "input"]);
  const update = exactRecord(variables.input, ["stateId"]);
  if (
    !hasExactKeys(args, [
      "operationKey",
      "readbackOperationKey",
      "mutationKind",
      "variables",
      "preconditionHash",
      "expectedAbsent",
      "changedFields",
    ]) ||
    args.operationKey !== "issues.update" ||
    args.readbackOperationKey !== "issues.get" ||
    args.mutationKind !== "issue_update" ||
    args.expectedAbsent !== false ||
    !Array.isArray(args.changedFields) ||
    args.changedFields.length !== 1 ||
    args.changedFields[0] !== "stateId" ||
    typeof variables.id !== "string" ||
    variables.id !== action.target.id ||
    typeof update.stateId !== "string" ||
    typeof args.preconditionHash !== "string" ||
    args.preconditionHash !== action.expectedTargetRevision ||
    !/^sha256:[0-9a-f]{64}$/u.test(args.preconditionHash) ||
    !action.idempotencyKey ||
    action.idempotencyKey !== action.reconciliationKey
  ) {
    fail(
      "invalid_linear_state_update",
      "Prepared action must contain only one exact Linear issue state transition with a readback precondition.",
    );
  }
  return {
    issueId: variables.id,
    stateId: update.stateId,
    preconditionFingerprint: args.preconditionHash,
  };
}

async function assertConsumedGrantTransition(input: {
  approved: AuthorityGrantV1;
  consumed: AuthorityGrantV1;
  action: PreparedAction;
  descriptor: ToolDescriptor;
}): Promise<void> {
  if (
    !(await verifyAuthorityGrantFingerprint(input.approved)) ||
    !(await verifyAuthorityGrantFingerprint(input.consumed)) ||
    input.approved.state !== "active" ||
    input.approved.actionFingerprint !== input.action.payloadFingerprint ||
    input.consumed.actionFingerprint !== input.action.payloadFingerprint ||
    !input.consumed.usage.lastUsedAt
  ) {
    fail(
      "invalid_authority",
      "Handoff requires one valid, action-bound grant and its consumed result.",
    );
  }
  const consumedAt = new Date(input.consumed.usage.lastUsedAt);
  if (!Number.isFinite(consumedAt.getTime())) {
    fail("invalid_authority", "Consumed grant timestamp is invalid.");
  }
  const evaluated = await evaluateAuthorityGrant({
    grant: input.approved,
    action: input.action,
    descriptor: input.descriptor,
    now: consumedAt,
  });
  if (!evaluated.allowed) {
    fail("invalid_authority", evaluated.reason);
  }
  const expected = await consumeAuthorityGrant({
    grant: input.approved,
    action: input.action,
    descriptor: input.descriptor,
    now: consumedAt,
  });
  if (
    !expected.allowed ||
    canonicalJson(expected.grant) !== canonicalJson(input.consumed)
  ) {
    fail(
      "invalid_authority",
      "Consumed grant does not match the exact host-computed authority transition.",
    );
  }
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("invalid_linear_state_update", "Prepared Linear payload is not an object.");
  }
  const record = value as Record<string, unknown>;
  if (!hasExactKeys(record, keys)) {
    fail(
      "invalid_linear_state_update",
      "Prepared Linear payload contains fields outside the fixed state-update contract.",
    );
  }
  return record;
}

function hasExactKeys(value: object, keys: readonly string[]): boolean {
  return (
    Object.keys(value).sort().join("\0") === [...keys].sort().join("\0")
  );
}

function fail(
  code: PreparedExternalActionHostErrorV1["code"],
  message: string,
): never {
  throw new PreparedExternalActionHostErrorV1(code, message);
}
