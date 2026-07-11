import type { AgentRunReceipt } from "../AgentRunner";
import { normalizeVaultPath } from "../tools/validation";
import type { MissionAcceptanceReceiptLike } from "./missionAcceptance";

export type VaultMutationStage =
  | "planned"
  | "validated"
  | "backed_up"
  | "applied"
  | "verified"
  | "committed"
  | "rolled_back";

export interface VaultMutationStageRecord {
  stage: VaultMutationStage;
  at: string;
  message: string;
}

export interface VaultMutationTransaction {
  id: string;
  runId: string;
  nodeId?: string;
  toolName: string;
  operation: AgentRunReceipt["operation"];
  targetPath?: string;
  backupPath?: string;
  stages: VaultMutationStageRecord[];
  receipt?: AgentRunReceipt;
}

export interface BeginVaultTransactionInput {
  runId: string;
  nodeId?: string;
  toolName: string;
  operation?: AgentRunReceipt["operation"];
  targetPath?: string;
  now?: Date;
}

export function beginVaultTransaction({
  runId,
  nodeId,
  toolName,
  operation = "append",
  targetPath,
  now = new Date(),
}: BeginVaultTransactionInput): VaultMutationTransaction {
  return {
    id: `txn-${runId}-${Date.parse(now.toISOString())}-${sanitizeId(toolName)}`,
    runId,
    nodeId,
    toolName,
    operation,
    targetPath,
    stages: [
      {
        stage: "planned",
        at: now.toISOString(),
        message: `Planned vault mutation ${toolName}.`,
      },
    ],
  };
}

export function recordTransactionStage(
  transaction: VaultMutationTransaction,
  stage: VaultMutationStage,
  message: string,
  now = new Date(),
): VaultMutationTransaction {
  return {
    ...transaction,
    stages: [
      ...transaction.stages,
      {
        stage,
        at: now.toISOString(),
        message,
      },
    ],
  };
}

export function commitVaultTransaction(
  transaction: VaultMutationTransaction,
  receipt: AgentRunReceipt,
  now = new Date(),
): VaultMutationTransaction {
  const withReceipt: VaultMutationTransaction = {
    ...transaction,
    operation: receipt.operation,
    targetPath: receipt.path ?? receipt.toPath ?? transaction.targetPath,
    backupPath: receipt.backupPath ?? transaction.backupPath,
    receipt,
  };
  const verified = recordTransactionStage(
    withReceipt,
    "verified",
    "Vault mutation has receipt proof.",
    now,
  );
  return recordTransactionStage(
    verified,
    "committed",
    `Committed ${receipt.operation} ${receipt.path ?? receipt.toPath ?? ""}`.trim(),
    now,
  );
}

export function rollbackVaultTransaction(
  transaction: VaultMutationTransaction,
  message: string,
  now = new Date(),
): VaultMutationTransaction {
  return recordTransactionStage(transaction, "rolled_back", message, now);
}

function sanitizeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "tool";
}

export type VaultMutationOperation =
  | "append"
  | "replace"
  | "rename"
  | "create"
  | "highlight"
  | "delete";

export type VaultTransactionStatus =
  | "staged"
  | "prepared"
  | "committed"
  | "failed"
  | "rolled_back";

export interface StagedVaultMutation {
  id: string;
  operation: VaultMutationOperation;
  path: string;
  toPath?: string;
  requiresBackup: boolean;
  backupPath?: string;
  receipt?: MissionAcceptanceReceiptLike;
  status: VaultTransactionStatus;
  error?: string;
}

export interface VaultTransaction {
  id: string;
  status: VaultTransactionStatus;
  createdAt: string;
  updatedAt: string;
  mutations: StagedVaultMutation[];
}

export interface StageVaultMutationInput {
  operation: VaultMutationOperation;
  path: string;
  toPath?: string;
  id?: string;
}

export function createVaultTransaction({
  id,
  now = new Date(),
}: {
  id: string;
  now?: Date;
}): VaultTransaction {
  const timestamp = now.toISOString();
  return {
    id,
    status: "staged",
    createdAt: timestamp,
    updatedAt: timestamp,
    mutations: [],
  };
}

export function stageVaultMutation(
  transaction: VaultTransaction,
  input: StageVaultMutationInput,
  now = new Date(),
): VaultTransaction {
  const mutation: StagedVaultMutation = {
    id: input.id ?? `mutation-${transaction.mutations.length + 1}`,
    operation: input.operation,
    path: normalizeVaultPath(input.path, { requireMarkdown: true }),
    toPath: input.toPath
      ? normalizeVaultPath(input.toPath, { requireMarkdown: true })
      : undefined,
    requiresBackup: requiresStagedBackup(input.operation),
    status: "staged",
  };
  if (mutation.operation === "rename" && !mutation.toPath) {
    throw new Error("Rename mutations require a target path.");
  }
  return {
    ...transaction,
    status: "staged",
    updatedAt: now.toISOString(),
    mutations: [...transaction.mutations, mutation],
  };
}

export function markVaultMutationPrepared({
  transaction,
  mutationId,
  backupPath,
  now = new Date(),
}: {
  transaction: VaultTransaction;
  mutationId: string;
  backupPath?: string;
  now?: Date;
}): VaultTransaction {
  return updateStagedMutation(transaction, mutationId, now, (mutation) => {
    if (mutation.requiresBackup && !backupPath) {
      throw new Error("Backup path is required before preparing this mutation.");
    }
    return {
      ...mutation,
      backupPath: backupPath
        ? normalizeVaultPath(backupPath, {
            requireMarkdown: true,
            blockSystemPaths: false,
          })
        : mutation.backupPath,
      status: "prepared",
    };
  });
}

export function recordVaultMutationReceipt({
  transaction,
  mutationId,
  receipt,
  now = new Date(),
}: {
  transaction: VaultTransaction;
  mutationId: string;
  receipt: MissionAcceptanceReceiptLike;
  now?: Date;
}): VaultTransaction {
  return updateStagedMutation(transaction, mutationId, now, (mutation) => ({
    ...mutation,
    receipt: { ...receipt },
    status: "committed",
  }));
}

export function markVaultMutationFailed({
  transaction,
  mutationId,
  error,
  now = new Date(),
}: {
  transaction: VaultTransaction;
  mutationId: string;
  error: string;
  now?: Date;
}): VaultTransaction {
  return updateStagedMutation(transaction, mutationId, now, (mutation) => ({
    ...mutation,
    error,
    status: "failed",
  }));
}

export function summarizeVaultTransaction(
  transaction: VaultTransaction,
): {
  id: string;
  status: VaultTransactionStatus;
  staged: number;
  prepared: number;
  committed: number;
  failed: number;
} {
  return {
    id: transaction.id,
    status: transaction.status,
    staged: transaction.mutations.filter((item) => item.status === "staged").length,
    prepared: transaction.mutations.filter((item) => item.status === "prepared").length,
    committed: transaction.mutations.filter((item) => item.status === "committed").length,
    failed: transaction.mutations.filter((item) => item.status === "failed").length,
  };
}

function updateStagedMutation(
  transaction: VaultTransaction,
  mutationId: string,
  now: Date,
  update: (mutation: StagedVaultMutation) => StagedVaultMutation,
): VaultTransaction {
  let found = false;
  const mutations = transaction.mutations.map((mutation) => {
    if (mutation.id !== mutationId) {
      return mutation;
    }
    found = true;
    return update(mutation);
  });
  if (!found) {
    throw new Error(`Unknown vault mutation: ${mutationId}`);
  }
  return {
    ...transaction,
    status: getStagedTransactionStatus(mutations),
    updatedAt: now.toISOString(),
    mutations,
  };
}

function getStagedTransactionStatus(
  mutations: StagedVaultMutation[],
): VaultTransactionStatus {
  if (mutations.some((mutation) => mutation.status === "failed")) {
    return "failed";
  }
  if (
    mutations.length > 0 &&
    mutations.every((mutation) => mutation.status === "committed")
  ) {
    return "committed";
  }
  if (mutations.some((mutation) => mutation.status === "prepared")) {
    return "prepared";
  }
  return "staged";
}

function requiresStagedBackup(operation: VaultMutationOperation): boolean {
  return operation === "replace" || operation === "delete";
}
