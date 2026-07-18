import type {
  ActionReconciliationResultV1,
  ActionReceiptV1,
  ExtensionToolContributionV1,
  PreparedActionResultV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
} from "@agentic-researcher/core-api";

import type {
  CodeRepairCycleReceiptV1,
  VerifiedLocalCommitReceiptV1,
} from "./types";
import { bindForegroundRepairScopeV1 } from "./ForegroundRepairScopeV1";

export const CODE_REPAIR_STATUS_TOOL = "code_repair_status" as const;
export const CODE_REPAIR_RECORD_CYCLE_TOOL = "code_repair_record_cycle" as const;
export const CODE_COMMIT_VERIFIED_TOOL = "code_commit_verified" as const;

export interface CodeRepairScopeArgsV1 {
  runId: string;
  workspaceId: string;
  requestId: string;
}

export interface CodeRepairStatusV1 extends CodeRepairScopeArgsV1 {
  kind: "code_repair_status";
  checkpointId: string;
  sequence: number;
  stage: string;
  attempts: Array<{
    cycle: number;
    validationReceiptId: string | null;
    cycleReceiptId: string | null;
    outcome: CodeRepairCycleReceiptV1["outcome"] | null;
  }>;
  targetedValidationReceiptId: string | null;
  fullValidationReceiptId: string | null;
  terminalStatus: "complete" | "blocked" | null;
  publicationEligible: boolean;
  blockerCode: string | null;
}

export interface CodeRepairToolHandlersV1 {
  readStatus(
    args: CodeRepairScopeArgsV1,
    context: ScopedExtensionContextV1,
  ): Promise<CodeRepairStatusV1>;
  prepareCycleRecord(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1>;
  executePreparedCycleRecord(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ domainReceipt: CodeRepairCycleReceiptV1; actionReceipt: ActionReceiptV1 }>;
  reconcileCycleRecord(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<ActionReconciliationResultV1>;
  prepareVerifiedCommit(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1>;
  executePreparedVerifiedCommit(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ domainReceipt: VerifiedLocalCommitReceiptV1; actionReceipt: ActionReceiptV1 }>;
  reconcileVerifiedCommit(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<ActionReconciliationResultV1>;
}

/**
 * Standard extension-tool surface for AgentRunner. The supplied handlers own
 * workspace-scoped persistence and Git adapters; the core context deliberately
 * exposes neither model credentials nor vault handles.
 */
export function createCodeRepairToolContributionsV1(
  handlers: CodeRepairToolHandlersV1,
  options: { hostResolvesDurableProof?: boolean } = {},
): ExtensionToolContributionV1[] {
  const hostResolvesDurableProof = options.hostResolvesDurableProof === true;
  return [
    {
      descriptor: contributionDescriptor(CODE_REPAIR_STATUS_TOOL, "Code repair status"),
      tool: {
        name: CODE_REPAIR_STATUS_TOOL,
        description:
          "Read a durable code-repair checkpoint and its validation, blocker, and receipt status.",
        parameters: scopeSchema(),
        descriptor: {
          version: 1,
          name: CODE_REPAIR_STATUS_TOOL,
          capability: { system: "workspace", resourceType: "code_repair_checkpoint", action: "read" },
          effect: "read",
          risk: "low",
          approval: {
            allowPromptGrant: false,
            allowPersistentGrant: true,
            fallback: "none",
          },
          execution: {
            preparation: "none",
            cacheable: false,
            parallelSafe: true,
          },
          durability: {
            journal: false,
            receipt: false,
            readback: "none",
            reconciliation: "none",
          },
          allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
          operationGoals: ["read durable repair progress", "surface blockers and proof"],
        },
        async execute(args, context) {
          return handlers.readStatus(
            normalizeScopeArgs(
              hostResolvesDurableProof
                ? bindForegroundRepairScopeV1(args, context)
                : args,
            ),
            context,
          );
        },
      },
    },
    {
      descriptor: contributionDescriptor(
        CODE_REPAIR_RECORD_CYCLE_TOOL,
        "Record code repair cycle",
      ),
      tool: {
        name: CODE_REPAIR_RECORD_CYCLE_TOOL,
        description:
          "Persist one fingerprint-bound code repair cycle and return a code_repair_cycle domain receipt.",
        parameters: {
          ...scopeSchema(),
          properties: {
            ...scopeSchema().properties,
            ...(hostResolvesDurableProof ? {} : {
              cycle: { type: "integer", minimum: 1, maximum: 3 },
              checkpointSequence: { type: "integer", minimum: 0 },
              validationReceiptId: { type: "string", minLength: 1, maxLength: 256 },
              cycleFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
            }),
          },
          required: [
            "runId",
            "workspaceId",
            "requestId",
            ...(hostResolvesDurableProof ? [] : [
              "cycle",
              "checkpointSequence",
              "validationReceiptId",
              "cycleFingerprint",
            ]),
          ],
        },
        descriptor: {
          version: 1,
          name: CODE_REPAIR_RECORD_CYCLE_TOOL,
          capability: {
            system: "workspace",
            resourceType: "code_repair_checkpoint",
            action: "update",
          },
          effect: "reversible_mutation",
          risk: "medium",
          approval: {
            allowPromptGrant: true,
            allowPersistentGrant: true,
            fallback: "exact",
          },
          execution: {
            preparation: "required",
            cacheable: false,
            parallelSafe: false,
          },
          durability: {
            journal: true,
            receipt: true,
            readback: "required",
            reconciliation: "required",
          },
          allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
          receiptKind: "code_change",
          operationGoals: ["checkpoint a bounded repair cycle", "preserve restart-safe evidence"],
        },
        async execute() {
          throw new Error(`${CODE_REPAIR_RECORD_CYCLE_TOOL} requires a prepared action.`);
        },
        prepare: (args, context) => handlers.prepareCycleRecord(
          hostResolvesDurableProof
            ? bindForegroundRepairScopeV1(args, context)
            : args,
          context,
        ),
        async executePrepared(action, context) {
          const result = await handlers.executePreparedCycleRecord(action, context);
          return {
            output: result.domainReceipt,
            receipt: result.actionReceipt,
            mutationState: "applied",
          };
        },
        reconcile: (action, context) => handlers.reconcileCycleRecord(action, context),
      },
    },
    {
      descriptor: contributionDescriptor(CODE_COMMIT_VERIFIED_TOOL, "Commit verified code"),
      tool: {
        name: CODE_COMMIT_VERIFIED_TOOL,
        description:
          "Execute an exact prepared local commit only after protected approvals, artifact readback, and fresh targeted/full sandbox validation.",
        parameters: {
          ...scopeSchema(),
          properties: {
            ...scopeSchema().properties,
            ...(hostResolvesDurableProof ? {} : {
              checkpointSequence: { type: "integer", minimum: 0 },
              diffFingerprint: { type: "string", pattern: "^sha256:[0-9a-f]{64}$" },
              targetedValidationReceiptId: { type: "string", minLength: 1, maxLength: 256 },
              fullValidationReceiptId: { type: "string", minLength: 1, maxLength: 256 },
            }),
          },
          required: [
            "runId",
            "workspaceId",
            "requestId",
            ...(hostResolvesDurableProof ? [] : [
              "checkpointSequence",
              "targetedValidationReceiptId",
              "fullValidationReceiptId",
            ]),
          ],
        },
        descriptor: {
          version: 1,
          name: CODE_COMMIT_VERIFIED_TOOL,
          capability: { system: "git", resourceType: "verified_local_commit", action: "commit" },
          effect: "execution",
          risk: "high",
          approval: {
            allowPromptGrant: true,
            allowPersistentGrant: true,
            fallback: "exact",
          },
          execution: {
            preparation: "required",
            desktopOnly: true,
            cacheable: false,
            parallelSafe: false,
          },
          durability: {
            journal: true,
            receipt: true,
            readback: "required",
            reconciliation: "required",
          },
          allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
          receiptKind: "code_change",
          operationGoals: ["create a verified local commit", "block red or stale proof"],
        },
        async execute() {
          throw new Error(`${CODE_COMMIT_VERIFIED_TOOL} requires a prepared exact action.`);
        },
        prepare: (args, context) => handlers.prepareVerifiedCommit(
          hostResolvesDurableProof
            ? bindForegroundRepairScopeV1(args, context)
            : args,
          context,
        ),
        async executePrepared(action, context) {
          const result = await handlers.executePreparedVerifiedCommit(action, context);
          return {
            output: result.domainReceipt,
            receipt: result.actionReceipt,
            mutationState: "applied",
          };
        },
        reconcile: (action, context) => handlers.reconcileVerifiedCommit(action, context),
      },
    },
  ];
}

function contributionDescriptor(id: string, displayName: string) {
  return {
    version: 1 as const,
    kind: "tool" as const,
    id: `agentic-researcher-code:${id}`,
    displayName,
  };
}

function scopeSchema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      runId: { type: "string", minLength: 1, maxLength: 128 },
      workspaceId: { type: "string", minLength: 1, maxLength: 128 },
      requestId: { type: "string", minLength: 1, maxLength: 128 },
    },
    required: ["runId", "workspaceId", "requestId"],
  };
}

function normalizeScopeArgs(args: Record<string, unknown>): CodeRepairScopeArgsV1 {
  return {
    runId: boundedId(args.runId, "runId"),
    workspaceId: boundedId(args.workspaceId, "workspaceId"),
    requestId: boundedId(args.requestId, "requestId"),
  };
}

function boundedId(value: unknown, name: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
  ) {
    throw new Error(`${name} must be a bounded durable identifier.`);
  }
  return value;
}
