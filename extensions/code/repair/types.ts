export const CODE_REPAIR_CHECKPOINT_VERSION = 1 as const;
export const CODE_REPAIR_RECEIPT_VERSION = 1 as const;

export type CodeRepairStageV1 =
  | "initialized"
  | "initial_edit"
  | "fast_validation"
  | "diagnosing"
  | "repairing"
  | "diff_preview"
  | "protected_approval"
  | "targeted_validation"
  | "full_validation"
  | "final_readback"
  | "committing"
  | "commit_readback"
  | "complete"
  | "blocked";

export type ValidationKindV1 = "fast" | "targeted" | "full";

export interface CodeRepairWorktreeV1 {
  id: string;
  path: string;
  repositoryRoot: string;
  branch: string;
  baseSha: string;
  profileId: string;
}

export interface ExpectedArtifactV1 {
  path: string;
  sha256: string;
}

export interface CodeRepairRequestV1 {
  id: string;
  runId: string;
  objective: string;
  worktree: CodeRepairWorktreeV1;
  commitMessage: string;
  maxCycles?: number;
  expectedArtifacts?: ExpectedArtifactV1[];
  protectedControlPaths?: string[];
}

export interface NormalizedCodeRepairRequestV1
  extends Omit<
    CodeRepairRequestV1,
    "maxCycles" | "expectedArtifacts" | "protectedControlPaths"
  > {
  maxCycles: number;
  expectedArtifacts: ExpectedArtifactV1[];
  protectedControlPaths: string[];
}

export interface CodeEditResultV1 {
  operationId: string;
  summary: string;
  changedPaths: string[];
  expectedArtifacts: ExpectedArtifactV1[];
  appliedAt: string;
}

export interface CodeDiagnosisV1 {
  operationId: string;
  failureFingerprint: string;
  summary: string;
  proposedRepair: string;
  diagnosedAt: string;
}

export interface CodeValidationCheckV1 {
  label: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface CodeValidationExecutionV1 {
  operationId: string;
  kind: ValidationKindV1;
  sandboxId: string;
  freshSandbox: boolean;
  startedAt: string;
  completedAt: string;
  checks: CodeValidationCheckV1[];
}

export interface CodeValidationBindingV1 {
  requestId: string;
  workspaceId: string;
  profileKey: string;
  inputWorkspaceManifestFingerprint: string;
  validatedWorkspaceManifestFingerprint: string;
  workspaceChangedPaths: string[];
  stagingManifestFingerprint: string;
  stagedFiles: Array<{ path: string; sha256: string; bytes: number }>;
  importedArtifacts: Array<{ path: string; sha256: string; bytes: number }>;
}

export interface CodeValidationReceiptV1 extends CodeValidationExecutionV1 {
  version: typeof CODE_REPAIR_RECEIPT_VERSION;
  kindName: "code_validation";
  id: string;
  status: "passed" | "failed";
  failureFingerprint: string | null;
  /** Null only for legacy/non-production coordinator evidence. */
  binding: CodeValidationBindingV1 | null;
  fingerprint: string;
}

export type CodeDiffStatusV1 = "added" | "modified" | "deleted" | "renamed";

export interface CodeDiffFileV1 {
  path: string;
  status: CodeDiffStatusV1;
  previousPath: string | null;
  beforeSha256: string | null;
  afterSha256: string | null;
}

export interface CodeDiffReadbackV1 {
  operationId: string;
  baseSha: string;
  patch: string;
  files: CodeDiffFileV1[];
  readAt: string;
}

export interface CodeDiffReceiptV1 extends CodeDiffReadbackV1 {
  version: typeof CODE_REPAIR_RECEIPT_VERSION;
  kindName: "code_diff_readback";
  id: string;
  changedPaths: string[];
  fingerprint: string;
}

export interface ArtifactHashReadbackV1 {
  path: string;
  sha256: string;
  bytes: number;
}

export type ProtectedApprovalLevelV1 = "none" | "exact" | "double_exact";

export interface ProtectedControlClassificationV1 {
  level: ProtectedApprovalLevelV1;
  protectedPaths: string[];
  doubleExactPaths: string[];
}

export interface ProtectedDiffApprovalRequestV1 {
  operationId: string;
  requestId: string;
  runId: string;
  purpose: "protected_diff" | "verified_commit";
  level: Exclude<ProtectedApprovalLevelV1, "none">;
  confirmationIndex: 1 | 2;
  requiredConfirmations: 1 | 2;
  payloadFingerprint: string;
  diffFingerprint: string;
  diffPatch: string;
  changedPaths: string[];
  protectedPaths: string[];
}

export interface ProtectedDiffApprovalDecisionV1 {
  operationId: string;
  decision: "approved" | "denied";
  decidedAt: string;
}

export interface ProtectedDiffApprovalRecordV1
  extends ProtectedDiffApprovalRequestV1,
    ProtectedDiffApprovalDecisionV1 {}

export interface CodeCommitResultV1 {
  operationId: string;
  commitSha: string;
  committedAt: string;
}

export interface CodeCommitReadbackV1 {
  operationId: string;
  commitSha: string;
  parentSha: string;
  treeSha: string;
  diffFingerprint: string;
  changedPaths: string[];
  artifactHashes: ArtifactHashReadbackV1[];
  readAt: string;
}

export interface ChangedArtifactHashV1 {
  path: string;
  sha256: string | null;
}

export interface VerifiedLocalCommitReceiptV1 {
  version: typeof CODE_REPAIR_RECEIPT_VERSION;
  kind: "verified_local_commit";
  id: string;
  status: "verified";
  requestId: string;
  runId: string;
  worktreeId: string;
  workspaceId: string;
  branch: string;
  baseSha: string;
  commitSha: string;
  parentSha: string;
  treeSha: string;
  diffFingerprint: string;
  changedPaths: string[];
  artifactHashes: ArtifactHashReadbackV1[];
  changedArtifacts: ChangedArtifactHashV1[];
  targetedValidationReceiptId: string;
  fullValidationReceiptId: string;
  targetedValidationFingerprint: string;
  fullValidationFingerprint: string;
  committedAt: string;
  fingerprint: string;
}

export interface CodeRepairFailureRecordV1 {
  cycle: number;
  fingerprint: string;
  recordedAt: string;
}

export interface CodeRepairAttemptV1 {
  cycle: number;
  fastValidation?: CodeValidationReceiptV1;
  diagnosis?: CodeDiagnosisV1;
  repair?: CodeEditResultV1;
  cycleReceipt?: CodeRepairCycleReceiptV1;
}

export interface CodeRepairCycleReceiptV1 {
  version: typeof CODE_REPAIR_RECEIPT_VERSION;
  kind: "code_repair_cycle";
  id: string;
  requestId: string;
  runId: string;
  workspaceId: string;
  cycle: number;
  outcome: "passed" | "repaired" | "blocked";
  validationReceiptId: string;
  validationFingerprint: string;
  diagnosisOperationId: string | null;
  repairOperationId: string | null;
  recordedAt: string;
  fingerprint: string;
}

export type CodeRepairBlockerCodeV1 =
  | "approval_denied"
  | "artifact_hash_mismatch"
  | "commit_readback_mismatch"
  | "diff_readback_invalid"
  | "full_validation_failed"
  | "full_validation_not_fresh"
  | "repair_cycles_exhausted"
  | "targeted_validation_failed"
  | "unchanged_failure";

export interface CodeRepairBlockerV1 {
  code: CodeRepairBlockerCodeV1;
  message: string;
  evidenceFingerprint: string | null;
  blockedAt: string;
}

export interface CodeRepairTerminalV1 {
  status: "complete" | "blocked";
  publicationEligible: boolean;
  completedAt: string;
}

export interface CodeRepairCheckpointV1 {
  version: typeof CODE_REPAIR_CHECKPOINT_VERSION;
  id: string;
  request: NormalizedCodeRepairRequestV1;
  requestFingerprint: string;
  sequence: number;
  stage: CodeRepairStageV1;
  createdAt: string;
  updatedAt: string;
  initialEdit?: CodeEditResultV1;
  attempts: CodeRepairAttemptV1[];
  failureHistory: CodeRepairFailureRecordV1[];
  validationHistory: CodeValidationReceiptV1[];
  approvalHistory: ProtectedDiffApprovalRecordV1[];
  previewDiff?: CodeDiffReceiptV1;
  finalDiff?: CodeDiffReceiptV1;
  artifactReadback?: ArtifactHashReadbackV1[];
  targetedValidation?: CodeValidationReceiptV1;
  fullValidation?: CodeValidationReceiptV1;
  commit?: CodeCommitResultV1;
  commitReadback?: CodeCommitReadbackV1;
  verifiedCommitReceipt?: VerifiedLocalCommitReceiptV1;
  blocker?: CodeRepairBlockerV1;
  terminal?: CodeRepairTerminalV1;
}

export interface CodeRepairResultV1 {
  status: "complete" | "blocked";
  publicationEligible: boolean;
  checkpoint: CodeRepairCheckpointV1;
  verifiedCommitReceipt?: VerifiedLocalCommitReceiptV1;
  blocker?: CodeRepairBlockerV1;
}

/**
 * Result of the deliberately read-only recovery path used after the process
 * loses the response to the prepared Git commit. `not_applied` is proof that
 * HEAD is still the trusted base; callers must obtain fresh authority before
 * they may attempt the commit again.
 */
export type CodeRepairCommitReconciliationResultV1 =
  | { outcome: "complete"; result: CodeRepairResultV1 }
  | { outcome: "not_applied" }
  | { outcome: "still_uncertain"; message: string };

export interface CodeRepairCheckpointStoreV1 {
  /** Load by codeRepairCheckpointIdV1(runId, workspaceId, requestId). */
  load(id: string): Promise<CodeRepairCheckpointV1 | null>;
  /** Compare-and-swap; null means create-only and must fail if a record exists. */
  save(
    checkpoint: CodeRepairCheckpointV1,
    expectedSequence: number | null,
  ): Promise<void>;
}

export interface CodeRepairMutatorV1 {
  applyInitialEdit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
  }): Promise<CodeEditResultV1>;
  applyRepair(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    cycle: number;
    diagnosis: CodeDiagnosisV1;
    failedValidation: CodeValidationReceiptV1;
  }): Promise<CodeEditResultV1>;
}

export interface CodeRepairDiagnoserV1 {
  diagnose(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    cycle: number;
    failedValidation: CodeValidationReceiptV1;
  }): Promise<CodeDiagnosisV1>;
}

export interface CodeSandboxValidatorV1 {
  /** Never execute generated code on the host when sandbox proof is unavailable. */
  runValidation(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    kind: ValidationKindV1;
    cycle: number | null;
    freshSandboxRequired: boolean;
  }): Promise<CodeValidationExecutionV1 | CodeValidationReceiptV1>;
}

export interface CodeProofReaderV1 {
  readDiff(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
  }): Promise<CodeDiffReadbackV1>;
  readArtifactHashes(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    expectedArtifacts: ExpectedArtifactV1[];
  }): Promise<ArtifactHashReadbackV1[]>;
}

export interface ProtectedDiffApprovalGatewayV1 {
  requestApproval(
    request: ProtectedDiffApprovalRequestV1,
  ): Promise<ProtectedDiffApprovalDecisionV1>;
}

export interface VerifiedCommitGatewayV1 {
  /**
   * Atomically re-check the supplied diff and artifact hashes immediately
   * before staging. Refuse drift; do not rerun validation natively.
   */
  commit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<CodeCommitResultV1>;
  /** Read commit, parent, tree, paths, and blob hashes back from Git object data. */
  readCommit(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    commitSha: string;
  }): Promise<CodeCommitReadbackV1>;
  /**
   * Read-only crash reconciliation. It must never stage or create a commit.
   * `not_applied` is safe only when HEAD is still the trusted base.
   */
  reconcilePreparedCommit?(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<
    | { outcome: "committed"; commit: CodeCommitResultV1; readback: CodeCommitReadbackV1 }
    | { outcome: "not_applied" }
    | { outcome: "still_uncertain"; message: string }
  >;
}

export interface CodeRepairCoordinatorDependenciesV1 {
  checkpointStore: CodeRepairCheckpointStoreV1;
  mutator: CodeRepairMutatorV1;
  diagnoser: CodeRepairDiagnoserV1;
  validator: CodeSandboxValidatorV1;
  proofReader: CodeProofReaderV1;
  approvalGateway: ProtectedDiffApprovalGatewayV1;
  committer: VerifiedCommitGatewayV1;
  now?: () => string;
}
