import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";

import {
  classifyProtectedControlChanges,
  assertSafeRepositoryRelativePath,
} from "./protectedControls";
import {
  CODE_REPAIR_CHECKPOINT_VERSION,
  CODE_REPAIR_RECEIPT_VERSION,
  type ArtifactHashReadbackV1,
  type CodeCommitReadbackV1,
  type CodeCommitResultV1,
  type CodeDiagnosisV1,
  type CodeDiffFileV1,
  type CodeDiffReadbackV1,
  type CodeDiffReceiptV1,
  type CodeEditResultV1,
  type CodeRepairAttemptV1,
  type CodeRepairBlockerCodeV1,
  type CodeRepairCheckpointV1,
  type CodeRepairCommitReconciliationResultV1,
  type CodeRepairCycleReceiptV1,
  type CodeRepairCoordinatorDependenciesV1,
  type CodeRepairRequestV1,
  type CodeRepairResultV1,
  type CodeValidationCheckV1,
  type CodeValidationExecutionV1,
  type CodeValidationReceiptV1,
  type ExpectedArtifactV1,
  type NormalizedCodeRepairRequestV1,
  type ProtectedDiffApprovalDecisionV1,
  type ProtectedDiffApprovalRequestV1,
  type ValidationKindV1,
  type VerifiedLocalCommitReceiptV1,
} from "./types";

const MAX_CHANGED_FILES = 100;
const MAX_EXPECTED_ARTIFACTS = 100;
const MAX_MODEL_EDITED_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_DIFF_PATCH_BYTES = 10 * 1024 * 1024;
const MAX_VALIDATION_CHECKS = 50;
const MAX_VALIDATION_OUTPUT_CHARACTERS = 32_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const CODE_REPAIR_STAGES = new Set([
  "initialized", "initial_edit", "fast_validation", "diagnosing", "repairing",
  "diff_preview", "protected_approval", "targeted_validation", "full_validation",
  "final_readback", "committing", "commit_readback", "complete", "blocked",
]);

/**
 * Coordinates bounded code repair and proves a local commit. Every mutating
 * dependency receives a stable operation ID and must reconcile that operation
 * idempotently. The checkpoint is persisted before each external side effect.
 */
export class CodeRepairCoordinatorV1 {
  private readonly now: () => string;

  constructor(private readonly dependencies: CodeRepairCoordinatorDependenciesV1) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  async execute(requestInput: CodeRepairRequestV1): Promise<CodeRepairResultV1> {
    const request = normalizeCodeRepairRequestV1(requestInput);
    let checkpoint = await this.loadOrCreateCheckpoint(request);
    if (checkpoint.terminal) {
      if (checkpoint.terminal.status === "complete") {
        await this.verifyCompletedCheckpointFresh(checkpoint);
      }
      return resultFromCheckpoint(checkpoint);
    }

    if (!checkpoint.initialEdit) {
      checkpoint = await this.transition(checkpoint, "initial_edit");
      const operationId = operation(checkpoint.id, "initial-edit");
      const edit = normalizeEditResult(
        await this.dependencies.mutator.applyInitialEdit({ operationId, request }),
        operationId,
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.initialEdit = edit;
      });
    }

    let fastValidationPassed = false;
    for (let cycle = 1; cycle <= request.maxCycles; cycle += 1) {
      let attempt = checkpoint.attempts.find((candidate) => candidate.cycle === cycle);
      if (!attempt) {
        checkpoint = await this.persist(checkpoint, (next) => {
          next.stage = "fast_validation";
          next.attempts.push({ cycle });
        });
        attempt = checkpoint.attempts.find((candidate) => candidate.cycle === cycle);
      }
      if (!attempt) throw new Error(`Failed to persist repair attempt ${cycle}.`);

      if (!attempt.fastValidation) {
        checkpoint = await this.transition(checkpoint, "fast_validation");
        const operationId = operation(checkpoint.id, `validation-fast-${cycle}`);
        const receipt = await createValidationReceipt(
          await this.dependencies.validator.runValidation({
            operationId,
            request,
            kind: "fast",
            cycle,
            freshSandboxRequired: false,
          }),
          { operationId, kind: "fast", request },
        );
        checkpoint = await this.persist(checkpoint, (next) => {
          requiredAttempt(next, cycle).fastValidation = receipt;
          next.validationHistory.push(receipt);
        });
        attempt = requiredAttempt(checkpoint, cycle);
      }

      const fastValidation = attempt.fastValidation;
      if (!fastValidation) throw new Error(`Repair attempt ${cycle} lost its validation receipt.`);
      if (fastValidation.status === "passed") {
        checkpoint = await this.ensureCycleReceipt(checkpoint, cycle, "passed");
        fastValidationPassed = true;
        break;
      }

      const failureFingerprint = requireFailureFingerprint(fastValidation);
      const unchanged = checkpoint.failureHistory.some(
        (failure) => failure.cycle < cycle && failure.fingerprint === failureFingerprint,
      );
      if (unchanged) {
        checkpoint = await this.ensureCycleReceipt(checkpoint, cycle, "blocked");
        checkpoint = await this.block(
          checkpoint,
          "unchanged_failure",
          `Fast validation repeated unchanged failure ${failureFingerprint} on cycle ${cycle}.`,
          failureFingerprint,
        );
        return resultFromCheckpoint(checkpoint);
      }

      if (!checkpoint.failureHistory.some((failure) => failure.cycle === cycle)) {
        checkpoint = await this.persist(checkpoint, (next) => {
          next.failureHistory.push({
            cycle,
            fingerprint: failureFingerprint,
            recordedAt: this.timestamp(),
          });
        });
      }

      attempt = requiredAttempt(checkpoint, cycle);
      if (!attempt.diagnosis) {
        checkpoint = await this.transition(checkpoint, "diagnosing");
        const operationId = operation(checkpoint.id, `diagnose-${cycle}`);
        const diagnosis = normalizeDiagnosis(
          await this.dependencies.diagnoser.diagnose({
            operationId,
            request,
            cycle,
            failedValidation: fastValidation,
          }),
          operationId,
          failureFingerprint,
        );
        checkpoint = await this.persist(checkpoint, (next) => {
          requiredAttempt(next, cycle).diagnosis = diagnosis;
        });
        attempt = requiredAttempt(checkpoint, cycle);
      }

      if (cycle === request.maxCycles) {
        checkpoint = await this.ensureCycleReceipt(checkpoint, cycle, "blocked");
        checkpoint = await this.block(
          checkpoint,
          "repair_cycles_exhausted",
          `Fast validation remained red after ${request.maxCycles} repair cycles.`,
          failureFingerprint,
        );
        return resultFromCheckpoint(checkpoint);
      }

      if (!attempt.repair) {
        checkpoint = await this.transition(checkpoint, "repairing");
        const operationId = operation(checkpoint.id, `repair-${cycle}`);
        const diagnosis = requiredAttempt(checkpoint, cycle).diagnosis;
        if (!diagnosis) throw new Error(`Repair attempt ${cycle} lost its diagnosis.`);
        const repair = normalizeEditResult(
          await this.dependencies.mutator.applyRepair({
            operationId,
            request,
            cycle,
            diagnosis,
            failedValidation: fastValidation,
          }),
          operationId,
        );
        checkpoint = await this.persist(checkpoint, (next) => {
          requiredAttempt(next, cycle).repair = repair;
        });
      }
      checkpoint = await this.ensureCycleReceipt(checkpoint, cycle, "repaired");
    }

    if (!fastValidationPassed) {
      throw new Error("Repair loop ended without a passing fast validation or durable blocker.");
    }

    if (!checkpoint.previewDiff) {
      checkpoint = await this.transition(checkpoint, "diff_preview");
      const operationId = operation(checkpoint.id, "diff-preview");
      const rawDiff = await this.dependencies.proofReader.readDiff({ operationId, request });
      let previewDiff: CodeDiffReceiptV1;
      try {
        previewDiff = await createDiffReceipt(rawDiff, operationId, request.worktree.baseSha);
      } catch (error) {
        const message = errorMessage(error);
        checkpoint = await this.block(
          checkpoint,
          "diff_readback_invalid",
          `Preview diff readback was invalid: ${message}`,
          await sha256Fingerprint({ stage: "preview", message }),
        );
        return resultFromCheckpoint(checkpoint);
      }
      checkpoint = await this.persist(checkpoint, (next) => {
        next.previewDiff = previewDiff;
      });
    }

    checkpoint = await this.ensureProtectedApproval(checkpoint, requiredPreviewDiff(checkpoint));
    if (checkpoint.terminal) return resultFromCheckpoint(checkpoint);

    if (!checkpoint.targetedValidation) {
      checkpoint = await this.transition(checkpoint, "targeted_validation");
      const operationId = operation(checkpoint.id, "validation-targeted");
      const targeted = await createValidationReceipt(
        await this.dependencies.validator.runValidation({
          operationId,
          request,
          kind: "targeted",
          cycle: null,
          freshSandboxRequired: false,
        }),
        { operationId, kind: "targeted", request },
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.targetedValidation = targeted;
        next.validationHistory.push(targeted);
      });
    }
    const targetedValidation = requiredTargetedValidation(checkpoint);
    if (targetedValidation.status === "failed") {
      checkpoint = await this.block(
        checkpoint,
        "targeted_validation_failed",
        "Targeted validation is red; local commit and publication are prohibited.",
        targetedValidation.failureFingerprint,
      );
      return resultFromCheckpoint(checkpoint);
    }

    if (!checkpoint.fullValidation) {
      checkpoint = await this.transition(checkpoint, "full_validation");
      const operationId = operation(checkpoint.id, "validation-full");
      const full = await createValidationReceipt(
        await this.dependencies.validator.runValidation({
          operationId,
          request,
          kind: "full",
          cycle: null,
          freshSandboxRequired: true,
        }),
        { operationId, kind: "full", request },
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.fullValidation = full;
        next.validationHistory.push(full);
      });
    }
    const fullValidation = requiredFullValidation(checkpoint);
    if (fullValidation.status === "failed") {
      checkpoint = await this.block(
        checkpoint,
        "full_validation_failed",
        "Fresh full validation is red; local commit and publication are prohibited.",
        fullValidation.failureFingerprint,
      );
      return resultFromCheckpoint(checkpoint);
    }
    const sandboxWasReused = checkpoint.validationHistory.some(
      (receipt) =>
        receipt.operationId !== fullValidation.operationId &&
        receipt.sandboxId === fullValidation.sandboxId,
    );
    if (!fullValidation.freshSandbox || sandboxWasReused) {
      checkpoint = await this.block(
        checkpoint,
        "full_validation_not_fresh",
        sandboxWasReused
          ? `Full validation reused sandbox ${fullValidation.sandboxId}.`
          : "Full validation did not attest to a fresh sandbox.",
        fullValidation.fingerprint,
      );
      return resultFromCheckpoint(checkpoint);
    }

    if (!checkpoint.finalDiff) {
      checkpoint = await this.transition(checkpoint, "final_readback");
      const operationId = operation(checkpoint.id, "diff-final");
      const rawDiff = await this.dependencies.proofReader.readDiff({ operationId, request });
      let finalDiff: CodeDiffReceiptV1;
      try {
        finalDiff = await createDiffReceipt(rawDiff, operationId, request.worktree.baseSha);
      } catch (error) {
        const message = errorMessage(error);
        checkpoint = await this.block(
          checkpoint,
          "diff_readback_invalid",
          `Final diff readback was invalid: ${message}`,
          await sha256Fingerprint({ stage: "final", message }),
        );
        return resultFromCheckpoint(checkpoint);
      }
      checkpoint = await this.persist(checkpoint, (next) => {
        next.finalDiff = finalDiff;
      });
    }
    const finalDiff = requiredFinalDiff(checkpoint);

    // A protected diff that drifted after its preview needs approval bound to
    // the final bytes. Existing approval records are reused only by fingerprint.
    checkpoint = await this.ensureProtectedApproval(checkpoint, finalDiff);
    if (checkpoint.terminal) return resultFromCheckpoint(checkpoint);

    if (!checkpoint.artifactReadback) {
      const expected = collectExpectedArtifacts(checkpoint, finalDiff);
      if (expected.mismatch) {
        checkpoint = await this.block(
          checkpoint,
          "artifact_hash_mismatch",
          expected.mismatch,
          finalDiff.fingerprint,
        );
        return resultFromCheckpoint(checkpoint);
      }
      const operationId = operation(checkpoint.id, "artifact-readback");
      const readback = expected.artifacts.length
        ? normalizeArtifactReadback(
            await this.dependencies.proofReader.readArtifactHashes({
              operationId,
              request,
              expectedArtifacts: expected.artifacts,
            }),
            expected.artifacts,
          )
        : [];
      const mismatch = compareExpectedArtifacts(expected.artifacts, readback);
      if (mismatch) {
        checkpoint = await this.block(
          checkpoint,
          "artifact_hash_mismatch",
          mismatch,
          await sha256Fingerprint({ expected: expected.artifacts, actual: readback }),
        );
        return resultFromCheckpoint(checkpoint);
      }
      checkpoint = await this.persist(checkpoint, (next) => {
        next.artifactReadback = readback;
      });
    }

    const artifactReadback = checkpoint.artifactReadback;
    if (!artifactReadback) throw new Error("Artifact readback disappeared from the checkpoint.");
    checkpoint = await this.ensureCommitApproval({
      checkpoint,
      diff: finalDiff,
      artifactHashes: artifactReadback,
      targetedValidation,
      fullValidation,
    });
    if (checkpoint.terminal) return resultFromCheckpoint(checkpoint);
    if (!checkpoint.commit) {
      checkpoint = await this.transition(checkpoint, "committing");
      const operationId = operation(checkpoint.id, "commit");
      const commit = normalizeCommitResult(
        await this.dependencies.committer.commit({
          operationId,
          request,
          diff: finalDiff,
          artifactHashes: artifactReadback,
          targetedValidation,
          fullValidation,
        }),
        operationId,
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.commit = commit;
      });
    }

    const commit = checkpoint.commit;
    if (!commit) throw new Error("Commit result disappeared from the checkpoint.");
    if (!checkpoint.commitReadback) {
      checkpoint = await this.transition(checkpoint, "commit_readback");
      const operationId = operation(checkpoint.id, "commit-readback");
      const readback = normalizeCommitReadback(
        await this.dependencies.committer.readCommit({
          operationId,
          request,
          commitSha: commit.commitSha,
        }),
        operationId,
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.commitReadback = readback;
      });
    }

    const commitReadback = checkpoint.commitReadback;
    if (!commitReadback) throw new Error("Commit readback disappeared from the checkpoint.");
    const commitMismatch = compareCommitReadback({
      request,
      commit,
      readback: commitReadback,
      diff: finalDiff,
      artifactHashes: artifactReadback,
    });
    if (commitMismatch) {
      checkpoint = await this.block(
        checkpoint,
        "commit_readback_mismatch",
        commitMismatch,
        await sha256Fingerprint({ commit, commitReadback, expectedDiff: finalDiff.fingerprint }),
      );
      return resultFromCheckpoint(checkpoint);
    }

    if (!checkpoint.verifiedCommitReceipt) {
      const receipt = await createVerifiedCommitReceipt({
        request,
        commit,
        commitReadback,
        diff: finalDiff,
        artifactHashes: artifactReadback,
        targetedValidation,
        fullValidation,
      });
      checkpoint = await this.persist(checkpoint, (next) => {
        next.stage = "complete";
        next.verifiedCommitReceipt = receipt;
        next.terminal = {
          status: "complete",
          publicationEligible: true,
          completedAt: this.timestamp(),
        };
      });
    }
    return resultFromCheckpoint(checkpoint);
  }

  /**
   * Recover a commit whose process response was lost without ever invoking the
   * commit mutation again. The fixed-argv gateway may inspect HEAD and Git
   * objects only. A proven commit is folded into the ordinary terminal
   * checkpoint and receipt shape so every downstream consumer uses one proof
   * contract.
   */
  async reconcileAmbiguousCommit(
    requestInput: CodeRepairRequestV1,
  ): Promise<CodeRepairCommitReconciliationResultV1> {
    const request = normalizeCodeRepairRequestV1(requestInput);
    const checkpointId = codeRepairCheckpointIdV1(request);
    let checkpoint = await this.dependencies.checkpointStore.load(checkpointId);
    if (!checkpoint) {
      throw new Error("Cannot reconcile a commit without its durable repair checkpoint.");
    }
    const requestFingerprint = await sha256Fingerprint(request);
    if (
      checkpoint.version !== CODE_REPAIR_CHECKPOINT_VERSION ||
      checkpoint.id !== checkpointId ||
      checkpoint.requestFingerprint !== requestFingerprint
    ) {
      throw new Error("Code repair reconciliation request does not match its durable checkpoint.");
    }
    if (checkpoint.terminal) {
      if (checkpoint.terminal.status === "complete") {
        await this.verifyCompletedCheckpointFresh(checkpoint);
      }
      return checkpoint.terminal.status === "complete"
        ? { outcome: "complete", result: resultFromCheckpoint(checkpoint) }
        : {
            outcome: "still_uncertain",
            message: "The durable repair checkpoint is already blocked.",
          };
    }
    if (checkpoint.stage !== "committing" || checkpoint.commit) {
      throw new Error(
        "Read-only commit reconciliation is allowed only for a committing checkpoint with no persisted commit result.",
      );
    }
    const finalDiff = requiredFinalDiff(checkpoint);
    const artifactHashes = checkpoint.artifactReadback;
    if (!artifactHashes) throw new Error("Ambiguous commit checkpoint has no artifact readback.");
    const targetedValidation = requiredTargetedValidation(checkpoint);
    const fullValidation = requiredFullValidation(checkpoint);
    const approvalFingerprint = await verifiedCommitApprovalFingerprint({
      checkpoint,
      diff: finalDiff,
      artifactHashes,
      targetedValidation,
      fullValidation,
    });
    const approved = checkpoint.approvalHistory.some(
      (record) =>
        record.purpose === "verified_commit" &&
        record.confirmationIndex === 1 &&
        record.payloadFingerprint === approvalFingerprint &&
        record.decision === "approved",
    );
    if (!approved) {
      throw new Error("Ambiguous commit checkpoint lacks its exact persisted commit approval.");
    }
    if (!this.dependencies.committer.reconcilePreparedCommit) {
      return {
        outcome: "still_uncertain",
        message: "The verified commit gateway does not provide read-only reconciliation.",
      };
    }

    const operationId = operation(checkpoint.id, "commit-reconcile");
    const reconciliation = await this.dependencies.committer.reconcilePreparedCommit({
      operationId,
      request,
      diff: finalDiff,
      artifactHashes,
      targetedValidation,
      fullValidation,
    });
    if (reconciliation.outcome === "not_applied") return { outcome: "not_applied" };
    if (reconciliation.outcome === "still_uncertain") {
      return {
        outcome: "still_uncertain",
        message: assertBoundedString(
          reconciliation.message,
          "commit reconciliation message",
          1,
          1_000,
        ),
      };
    }
    const commit = normalizeCommitResult(reconciliation.commit, operationId);
    const readbackOperationId = `${operationId}:readback`;
    const commitReadback = normalizeCommitReadback(
      reconciliation.readback,
      readbackOperationId,
    );
    const mismatch = compareCommitReadback({
      request,
      commit,
      readback: commitReadback,
      diff: finalDiff,
      artifactHashes,
    });
    if (mismatch) {
      return {
        outcome: "still_uncertain",
        message: `Read-only commit reconciliation evidence mismatched: ${mismatch}`,
      };
    }
    const receipt = await createVerifiedCommitReceipt({
      request,
      commit,
      commitReadback,
      diff: finalDiff,
      artifactHashes,
      targetedValidation,
      fullValidation,
    });
    checkpoint = await this.persist(checkpoint, (next) => {
      next.stage = "complete";
      next.commit = commit;
      next.commitReadback = commitReadback;
      next.verifiedCommitReceipt = receipt;
      next.terminal = {
        status: "complete",
        publicationEligible: true,
        completedAt: this.timestamp(),
      };
    });
    return { outcome: "complete", result: resultFromCheckpoint(checkpoint) };
  }

  /** A persisted terminal bit is never completion proof. Re-read the exact Git
   * object and rebuild the receipt before any caller may publish it. */
  private async verifyCompletedCheckpointFresh(
    checkpoint: CodeRepairCheckpointV1,
  ): Promise<VerifiedLocalCommitReceiptV1> {
    const parsed = await parseCodeRepairCheckpointV1(checkpoint);
    const request = parsed.request;
    const commit = parsed.commit;
    const diff = parsed.finalDiff;
    const artifactHashes = parsed.artifactReadback;
    const targetedValidation = parsed.targetedValidation;
    const fullValidation = parsed.fullValidation;
    const stored = parsed.verifiedCommitReceipt;
    if (
      !commit || !diff || !artifactHashes || !targetedValidation ||
      !fullValidation || !stored
    ) throw new Error("Completed checkpoint lacks its verified proof chain.");
    assertTerminalValidationCoverage(
      request,
      diff,
      targetedValidation,
      fullValidation,
    );
    const operationId = operation(parsed.id, `terminal-readback-${parsed.sequence}`);
    const fresh = normalizeCommitReadback(
      await this.dependencies.committer.readCommit({
        operationId,
        request,
        commitSha: commit.commitSha,
      }),
      operationId,
    );
    const mismatch = compareCommitReadback({
      request,
      commit,
      readback: fresh,
      diff,
      artifactHashes,
    });
    if (mismatch) throw new Error(`Fresh terminal Git readback failed: ${mismatch}`);
    const rebuilt = await createVerifiedCommitReceipt({
      request,
      commit,
      commitReadback: fresh,
      diff,
      artifactHashes,
      targetedValidation,
      fullValidation,
    });
    if (await sha256Fingerprint(rebuilt) !== await sha256Fingerprint(stored)) {
      throw new Error("Fresh terminal Git readback does not rebuild the persisted verified receipt.");
    }
    return rebuilt;
  }

  private async ensureCycleReceipt(
    checkpoint: CodeRepairCheckpointV1,
    cycle: number,
    outcome: CodeRepairCycleReceiptV1["outcome"],
  ): Promise<CodeRepairCheckpointV1> {
    const attempt = requiredAttempt(checkpoint, cycle);
    if (attempt.cycleReceipt) return checkpoint;
    if (!attempt.fastValidation) {
      throw new Error(`Cannot record repair cycle ${cycle} without validation evidence.`);
    }
    if (outcome === "repaired" && (!attempt.diagnosis || !attempt.repair)) {
      throw new Error(`Cannot record repaired cycle ${cycle} without diagnosis and repair evidence.`);
    }
    const receipt = await createCodeRepairCycleReceipt({
      request: checkpoint.request,
      attempt,
      outcome,
      recordedAt: this.timestamp(),
    });
    return this.persist(checkpoint, (next) => {
      requiredAttempt(next, cycle).cycleReceipt = receipt;
    });
  }

  private async ensureCommitApproval(input: {
    checkpoint: CodeRepairCheckpointV1;
    diff: CodeDiffReceiptV1;
    artifactHashes: ArtifactHashReadbackV1[];
    targetedValidation: CodeValidationReceiptV1;
    fullValidation: CodeValidationReceiptV1;
  }): Promise<CodeRepairCheckpointV1> {
    let checkpoint = input.checkpoint;
    const payloadFingerprint = await verifiedCommitApprovalFingerprint({
      checkpoint,
      diff: input.diff,
      artifactHashes: input.artifactHashes,
      targetedValidation: input.targetedValidation,
      fullValidation: input.fullValidation,
    });
    const existing = checkpoint.approvalHistory.find(
      (record) =>
        record.purpose === "verified_commit" &&
        record.payloadFingerprint === payloadFingerprint &&
        record.confirmationIndex === 1,
    );
    if (existing?.decision === "approved") return checkpoint;
    if (existing?.decision === "denied") {
      return this.block(
        checkpoint,
        "approval_denied",
        "The exact prepared local commit action was denied.",
        payloadFingerprint,
      );
    }

    checkpoint = await this.transition(checkpoint, "protected_approval");
    const approvalRequest: ProtectedDiffApprovalRequestV1 = {
      operationId: operation(
        checkpoint.id,
        `commit-approval-${payloadFingerprint.slice("sha256:".length, 23)}`,
      ),
      requestId: checkpoint.request.id,
      runId: checkpoint.request.runId,
      purpose: "verified_commit",
      level: "exact",
      confirmationIndex: 1,
      requiredConfirmations: 1,
      payloadFingerprint,
      diffFingerprint: input.diff.fingerprint,
      diffPatch: input.diff.patch,
      changedPaths: [...input.diff.changedPaths],
      protectedPaths: [],
    };
    const decision = normalizeApprovalDecision(
      await this.dependencies.approvalGateway.requestApproval(cloneJson(approvalRequest)),
      approvalRequest.operationId,
    );
    checkpoint = await this.persist(checkpoint, (next) => {
      next.approvalHistory.push({ ...approvalRequest, ...decision });
    });
    if (decision.decision === "denied") {
      return this.block(
        checkpoint,
        "approval_denied",
        "The exact prepared local commit action was denied.",
        payloadFingerprint,
      );
    }
    return checkpoint;
  }

  private async loadOrCreateCheckpoint(
    request: NormalizedCodeRepairRequestV1,
  ): Promise<CodeRepairCheckpointV1> {
    const requestFingerprint = await sha256Fingerprint(request);
    const checkpointId = codeRepairCheckpointIdV1(request);
    const existing = await this.dependencies.checkpointStore.load(checkpointId);
    if (existing) {
      if (existing.version !== CODE_REPAIR_CHECKPOINT_VERSION) {
        throw new Error(`Unsupported code repair checkpoint version ${existing.version}.`);
      }
      if (existing.id !== checkpointId || existing.requestFingerprint !== requestFingerprint) {
        throw new Error("Code repair request does not match its durable checkpoint.");
      }
      return cloneJson(existing);
    }
    const timestamp = this.timestamp();
    const checkpoint: CodeRepairCheckpointV1 = {
      version: CODE_REPAIR_CHECKPOINT_VERSION,
      id: checkpointId,
      request,
      requestFingerprint,
      sequence: 0,
      stage: "initialized",
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: [],
      failureHistory: [],
      validationHistory: [],
      approvalHistory: [],
    };
    await this.dependencies.checkpointStore.save(cloneJson(checkpoint), null);
    return checkpoint;
  }

  private async ensureProtectedApproval(
    checkpoint: CodeRepairCheckpointV1,
    diff: CodeDiffReceiptV1,
  ): Promise<CodeRepairCheckpointV1> {
    const classification = classifyProtectedControlChanges(
      diff.changedPaths,
      checkpoint.request.protectedControlPaths,
    );
    if (classification.level === "none") return checkpoint;

    const requiredConfirmations = classification.level === "double_exact" ? 2 : 1;
    for (let confirmation = 1; confirmation <= requiredConfirmations; confirmation += 1) {
      const confirmationIndex = confirmation as 1 | 2;
      const existing = checkpoint.approvalHistory.find(
        (record) =>
          record.purpose === "protected_diff" &&
          record.diffFingerprint === diff.fingerprint &&
          record.confirmationIndex === confirmationIndex &&
          record.requiredConfirmations === requiredConfirmations,
      );
      if (existing?.decision === "approved") continue;
      if (existing?.decision === "denied") {
        return this.block(
          checkpoint,
          "approval_denied",
          `Protected diff approval ${confirmationIndex}/${requiredConfirmations} was denied.`,
          diff.fingerprint,
        );
      }

      checkpoint = await this.transition(checkpoint, "protected_approval");
      const approvalRequest: ProtectedDiffApprovalRequestV1 = {
        operationId: operation(
          checkpoint.id,
          `approval-${diff.fingerprint.slice("sha256:".length, 23)}-${confirmationIndex}`,
        ),
        requestId: checkpoint.request.id,
        runId: checkpoint.request.runId,
        purpose: "protected_diff",
        level: classification.level,
        confirmationIndex,
        requiredConfirmations,
        payloadFingerprint: diff.fingerprint,
        diffFingerprint: diff.fingerprint,
        diffPatch: diff.patch,
        changedPaths: [...diff.changedPaths],
        protectedPaths: [...classification.protectedPaths],
      };
      const decision = normalizeApprovalDecision(
        await this.dependencies.approvalGateway.requestApproval(cloneJson(approvalRequest)),
        approvalRequest.operationId,
      );
      checkpoint = await this.persist(checkpoint, (next) => {
        next.approvalHistory.push({ ...approvalRequest, ...decision });
      });
      if (decision.decision === "denied") {
        return this.block(
          checkpoint,
          "approval_denied",
          `Protected diff approval ${confirmationIndex}/${requiredConfirmations} was denied.`,
          diff.fingerprint,
        );
      }
    }
    return checkpoint;
  }

  private async transition(
    checkpoint: CodeRepairCheckpointV1,
    stage: CodeRepairCheckpointV1["stage"],
  ): Promise<CodeRepairCheckpointV1> {
    if (checkpoint.stage === stage) return checkpoint;
    return this.persist(checkpoint, (next) => {
      next.stage = stage;
    });
  }

  private async block(
    checkpoint: CodeRepairCheckpointV1,
    code: CodeRepairBlockerCodeV1,
    message: string,
    evidenceFingerprint: string | null,
  ): Promise<CodeRepairCheckpointV1> {
    if (checkpoint.terminal) return checkpoint;
    return this.persist(checkpoint, (next) => {
      const timestamp = this.timestamp();
      next.stage = "blocked";
      next.blocker = {
        code,
        message,
        evidenceFingerprint,
        blockedAt: timestamp,
      };
      next.terminal = {
        status: "blocked",
        publicationEligible: false,
        completedAt: timestamp,
      };
    });
  }

  private async persist(
    checkpoint: CodeRepairCheckpointV1,
    update: (next: CodeRepairCheckpointV1) => void,
  ): Promise<CodeRepairCheckpointV1> {
    const expectedSequence = checkpoint.sequence;
    const next = cloneJson(checkpoint);
    update(next);
    next.sequence = expectedSequence + 1;
    next.updatedAt = this.timestamp();
    await this.dependencies.checkpointStore.save(cloneJson(next), expectedSequence);
    return next;
  }

  private timestamp(): string {
    const value = this.now();
    assertBoundedString(value, "timestamp", 1, 128);
    return value;
  }
}

export function normalizeCodeRepairRequestV1(
  input: CodeRepairRequestV1,
): NormalizedCodeRepairRequestV1 {
  assertPlainObject(input, "Code repair request");
  const id = assertIdentifier(input.id, "request id");
  const runId = assertIdentifier(input.runId, "run id");
  const objective = assertBoundedString(input.objective, "objective", 1, 20_000);
  const commitMessage = assertBoundedString(input.commitMessage, "commit message", 1, 4_000);
  if (commitMessage.includes("\u0000")) throw new Error("Commit message contains NUL.");
  const maxCycles = input.maxCycles ?? 3;
  if (!Number.isInteger(maxCycles) || maxCycles < 1 || maxCycles > 3) {
    throw new Error("Code repair maxCycles must be an integer from 1 through 3.");
  }
  assertPlainObject(input.worktree, "Code repair worktree");
  const worktree = {
    id: assertIdentifier(input.worktree.id, "worktree id"),
    path: assertBoundedString(input.worktree.path, "worktree path", 1, 2_048),
    repositoryRoot: assertBoundedString(
      input.worktree.repositoryRoot,
      "repository root",
      1,
      2_048,
    ),
    branch: assertBoundedString(input.worktree.branch, "worktree branch", 1, 512),
    baseSha: assertGitSha(input.worktree.baseSha, "worktree base SHA"),
    profileId: assertIdentifier(input.worktree.profileId, "repository profile id"),
  };
  const expectedArtifacts = normalizeExpectedArtifacts(input.expectedArtifacts ?? []);
  const protectedControlPaths = [...new Set(input.protectedControlPaths ?? [])].sort();
  classifyProtectedControlChanges([], protectedControlPaths);
  return {
    id,
    runId,
    objective,
    worktree,
    commitMessage,
    maxCycles,
    expectedArtifacts,
    protectedControlPaths,
  };
}

/** Stable persistence key scoped to mission, workspace, and repair request. */
export function codeRepairCheckpointIdV1(
  request: Pick<NormalizedCodeRepairRequestV1, "id" | "runId" | "worktree">,
): string {
  return `code-repair:${request.runId}:${request.worktree.id}:${request.id}`;
}

/**
 * Closed, fingerprint-verifying parser for durable checkpoint state. This is
 * deliberately stronger than a TypeScript cast: same-user app-data edits must
 * not be able to manufacture green validation or a verified commit.
 */
export async function parseCodeRepairCheckpointV1(
  input: unknown,
): Promise<CodeRepairCheckpointV1> {
  assertExactKeys(input, [
    "version", "id", "request", "requestFingerprint", "sequence", "stage",
    "createdAt", "updatedAt", "initialEdit", "attempts", "failureHistory",
    "validationHistory", "approvalHistory", "previewDiff", "finalDiff",
    "artifactReadback", "targetedValidation", "fullValidation", "commit",
    "commitReadback", "verifiedCommitReceipt", "blocker", "terminal",
  ], "Code repair checkpoint", true);
  const checkpoint = cloneJson(input as unknown as CodeRepairCheckpointV1);
  if (
    checkpoint.version !== CODE_REPAIR_CHECKPOINT_VERSION ||
    !Number.isSafeInteger(checkpoint.sequence) ||
    checkpoint.sequence < 0 ||
    !CODE_REPAIR_STAGES.has(checkpoint.stage)
  ) {
    throw new Error("Code repair checkpoint version, sequence, or stage is invalid.");
  }
  assertIdentifier(checkpoint.id, "checkpoint id");
  assertExactKeys(checkpoint.request, [
    "id", "runId", "objective", "worktree", "commitMessage", "maxCycles",
    "expectedArtifacts", "protectedControlPaths",
  ], "normalized Code repair request");
  assertExactKeys(checkpoint.request.worktree, [
    "id", "path", "repositoryRoot", "branch", "baseSha", "profileId",
  ], "Code repair worktree");
  for (const artifact of checkpoint.request.expectedArtifacts) {
    assertExactKeys(artifact, ["path", "sha256"], "expected artifact");
  }
  const request = normalizeCodeRepairRequestV1(checkpoint.request);
  if (await sha256Fingerprint(request) !== await sha256Fingerprint(checkpoint.request)) {
    throw new Error("Code repair checkpoint request is not canonically normalized.");
  }
  if (
    checkpoint.id !== codeRepairCheckpointIdV1(request) ||
    checkpoint.requestFingerprint !== await sha256Fingerprint(request)
  ) {
    throw new Error("Code repair checkpoint request identity or fingerprint is invalid.");
  }
  const createdAt = parseTimestamp(checkpoint.createdAt, "checkpoint createdAt");
  const updatedAt = parseTimestamp(checkpoint.updatedAt, "checkpoint updatedAt");
  if (Date.parse(updatedAt) < Date.parse(createdAt)) {
    throw new Error("Code repair checkpoint updatedAt predates createdAt.");
  }

  if (!Array.isArray(checkpoint.attempts) || checkpoint.attempts.length > request.maxCycles) {
    throw new Error("Code repair checkpoint attempts exceed the repair budget.");
  }
  const validationById = new Map<string, CodeValidationReceiptV1>();
  const parsedValidation = async (receipt: CodeValidationReceiptV1) => {
    assertExactValidationReceipt(receipt);
    const parsed = await createValidationReceipt(receipt, {
      operationId: receipt.operationId,
      kind: receipt.kind,
      request,
    });
    const existing = validationById.get(parsed.id);
    if (existing && existing.fingerprint !== parsed.fingerprint) {
      throw new Error(`Validation receipt ${parsed.id} repeats with different evidence.`);
    }
    validationById.set(parsed.id, parsed);
    return parsed;
  };

  if (checkpoint.initialEdit) {
    assertExactKeys(checkpoint.initialEdit, [
      "operationId", "summary", "changedPaths", "expectedArtifacts", "appliedAt",
    ], "initial edit");
    normalizeEditResult(checkpoint.initialEdit, checkpoint.initialEdit.operationId);
  }
  const cycles = new Set<number>();
  for (const attempt of checkpoint.attempts) {
    assertExactKeys(attempt, [
      "cycle", "fastValidation", "diagnosis", "repair", "cycleReceipt",
    ], "repair attempt", true);
    if (
      !Number.isSafeInteger(attempt.cycle) ||
      attempt.cycle < 1 ||
      attempt.cycle > request.maxCycles ||
      cycles.has(attempt.cycle)
    ) throw new Error("Code repair attempt cycle is invalid or duplicated.");
    cycles.add(attempt.cycle);
    if (attempt.fastValidation) {
      if (attempt.fastValidation.kind !== "fast") {
        throw new Error("Repair attempt validation is not a fast validation.");
      }
      await parsedValidation(attempt.fastValidation);
    }
    if (attempt.diagnosis) {
      assertExactKeys(attempt.diagnosis, [
        "operationId", "failureFingerprint", "summary", "proposedRepair", "diagnosedAt",
      ], "repair diagnosis");
      normalizeDiagnosis(
        attempt.diagnosis,
        attempt.diagnosis.operationId,
        attempt.diagnosis.failureFingerprint,
      );
    }
    if (attempt.repair) {
      assertExactKeys(attempt.repair, [
        "operationId", "summary", "changedPaths", "expectedArtifacts", "appliedAt",
      ], "repair edit");
      normalizeEditResult(attempt.repair, attempt.repair.operationId);
    }
    if (attempt.cycleReceipt) {
      assertExactKeys(attempt.cycleReceipt, [
        "version", "kind", "id", "requestId", "runId", "workspaceId", "cycle",
        "outcome", "validationReceiptId", "validationFingerprint",
        "diagnosisOperationId", "repairOperationId", "recordedAt", "fingerprint",
      ], "repair cycle receipt");
      const rebuilt = await createCodeRepairCycleReceipt({
        request,
        attempt,
        outcome: attempt.cycleReceipt.outcome,
        recordedAt: attempt.cycleReceipt.recordedAt,
      });
      if (await sha256Fingerprint(rebuilt) !== await sha256Fingerprint(attempt.cycleReceipt)) {
        throw new Error("Repair cycle receipt failed canonical fingerprint verification.");
      }
    }
  }

  if (!Array.isArray(checkpoint.validationHistory) || checkpoint.validationHistory.length > 8) {
    throw new Error("Code repair validation history is invalid.");
  }
  for (const receipt of checkpoint.validationHistory) await parsedValidation(receipt);
  if (checkpoint.targetedValidation) {
    if (checkpoint.targetedValidation.kind !== "targeted") {
      throw new Error("Targeted validation has the wrong validation kind.");
    }
    await parsedValidation(checkpoint.targetedValidation);
  }
  if (checkpoint.fullValidation) {
    if (checkpoint.fullValidation.kind !== "full") {
      throw new Error("Full validation has the wrong validation kind.");
    }
    await parsedValidation(checkpoint.fullValidation);
  }

  const parsedDiff = async (diff: CodeDiffReceiptV1, label: string) => {
    assertExactKeys(diff, [
      "version", "kindName", "id", "operationId", "baseSha", "patch", "files",
      "readAt", "changedPaths", "fingerprint",
    ], label);
    for (const file of diff.files) {
      assertExactKeys(file, [
        "path", "status", "previousPath", "beforeSha256", "afterSha256",
      ], `${label} file`);
    }
    if (
      diff.version !== CODE_REPAIR_RECEIPT_VERSION ||
      diff.kindName !== "code_diff_readback" ||
      diff.baseSha !== request.worktree.baseSha
    ) {
      throw new Error(`${label} has an invalid version, kind, or trusted base SHA.`);
    }
    assertIdentifier(diff.id, `${label} id`);
    assertIdentifier(diff.operationId, `${label} operation id`);
    parseTimestamp(diff.readAt, `${label} readAt`);
    const patch = assertBoundedString(diff.patch, `${label} patch`, 0, MAX_DIFF_PATCH_BYTES);
    if (new TextEncoder().encode(patch).byteLength > MAX_DIFF_PATCH_BYTES) {
      throw new Error(`${label} patch exceeds the mission byte limit.`);
    }
    const files = diff.files.map(normalizeDiffFile).sort((left, right) =>
      left.path.localeCompare(right.path));
    const changedPaths = files.map((file) => file.path);
    if (
      new Set(changedPaths).size !== changedPaths.length ||
      !sameStrings(changedPaths, diff.changedPaths) ||
      diff.fingerprint !== await sha256Fingerprint({
        baseSha: diff.baseSha,
        patch,
        files,
      })
    ) {
      throw new Error(`${label} failed canonical fingerprint verification.`);
    }
    return diff;
  };
  if (checkpoint.previewDiff) await parsedDiff(checkpoint.previewDiff, "preview diff");
  if (checkpoint.finalDiff) await parsedDiff(checkpoint.finalDiff, "final diff");

  if (!Array.isArray(checkpoint.failureHistory) || checkpoint.failureHistory.length > 3) {
    throw new Error("Code repair failure history is invalid.");
  }
  for (const failure of checkpoint.failureHistory) {
    assertExactKeys(failure, ["cycle", "fingerprint", "recordedAt"], "failure record");
    if (!Number.isSafeInteger(failure.cycle) || failure.cycle < 1 || failure.cycle > 3) {
      throw new Error("Failure record cycle is invalid.");
    }
    assertSha256(failure.fingerprint, "failure fingerprint");
    parseTimestamp(failure.recordedAt, "failure recordedAt");
  }
  if (!Array.isArray(checkpoint.approvalHistory) || checkpoint.approvalHistory.length > 8) {
    throw new Error("Code repair approval history is invalid.");
  }
  for (const approval of checkpoint.approvalHistory) {
    assertExactKeys(approval, [
      "operationId", "requestId", "runId", "purpose", "level",
      "confirmationIndex", "requiredConfirmations", "payloadFingerprint",
      "diffFingerprint", "diffPatch", "changedPaths", "protectedPaths",
      "decision", "decidedAt",
    ], "approval record");
    normalizeApprovalDecision(approval, approval.operationId);
    if (approval.requestId !== request.id || approval.runId !== request.runId) {
      throw new Error("Approval record escaped its repair request scope.");
    }
  }

  const artifactReadback = checkpoint.artifactReadback
    ? normalizeArtifactReadback(checkpoint.artifactReadback)
    : undefined;
  if (checkpoint.commit) {
    assertExactKeys(checkpoint.commit, ["operationId", "commitSha", "committedAt"], "commit result");
    normalizeCommitResult(checkpoint.commit, checkpoint.commit.operationId);
  }
  if (checkpoint.commitReadback) {
    assertExactKeys(checkpoint.commitReadback, [
      "operationId", "commitSha", "parentSha", "treeSha", "diffFingerprint",
      "changedPaths", "artifactHashes", "readAt",
    ], "commit readback");
    normalizeCommitReadback(checkpoint.commitReadback, checkpoint.commitReadback.operationId);
  }

  if (checkpoint.verifiedCommitReceipt) {
    assertExactVerifiedCommitReceipt(checkpoint.verifiedCommitReceipt);
    if (
      !checkpoint.commit ||
      !checkpoint.commitReadback ||
      !checkpoint.finalDiff ||
      !artifactReadback ||
      !checkpoint.targetedValidation ||
      !checkpoint.fullValidation
    ) throw new Error("Verified commit receipt lacks its complete proof chain.");
    const rebuilt = await createVerifiedCommitReceipt({
      request,
      commit: checkpoint.commit,
      commitReadback: checkpoint.commitReadback,
      diff: checkpoint.finalDiff,
      artifactHashes: artifactReadback,
      targetedValidation: checkpoint.targetedValidation,
      fullValidation: checkpoint.fullValidation,
    });
    if (
      await sha256Fingerprint(rebuilt) !==
      await sha256Fingerprint(checkpoint.verifiedCommitReceipt)
    ) {
      throw new Error("Verified local commit receipt failed canonical fingerprint verification.");
    }
    const mismatch = compareCommitReadback({
      request,
      commit: checkpoint.commit,
      readback: checkpoint.commitReadback,
      diff: checkpoint.finalDiff,
      artifactHashes: artifactReadback,
    });
    if (mismatch) throw new Error(`Persisted commit readback is invalid: ${mismatch}`);
  }

  if (checkpoint.blocker) {
    assertExactKeys(checkpoint.blocker, [
      "code", "message", "evidenceFingerprint", "blockedAt",
    ], "repair blocker");
    parseTimestamp(checkpoint.blocker.blockedAt, "blocker timestamp");
    if (checkpoint.blocker.evidenceFingerprint !== null) {
      assertSha256(checkpoint.blocker.evidenceFingerprint, "blocker evidence fingerprint");
    }
  }
  if (checkpoint.terminal) {
    assertExactKeys(checkpoint.terminal, [
      "status", "publicationEligible", "completedAt",
    ], "repair terminal");
    parseTimestamp(checkpoint.terminal.completedAt, "terminal timestamp");
    const complete = checkpoint.terminal.status === "complete";
    if (
      (complete && (
        checkpoint.stage !== "complete" ||
        checkpoint.terminal.publicationEligible !== true ||
        !checkpoint.verifiedCommitReceipt ||
        checkpoint.blocker !== undefined
      )) ||
      (!complete && (
        checkpoint.terminal.status !== "blocked" ||
        checkpoint.stage !== "blocked" ||
        checkpoint.terminal.publicationEligible !== false ||
        !checkpoint.blocker ||
        checkpoint.verifiedCommitReceipt !== undefined
      ))
    ) throw new Error("Code repair terminal state is internally inconsistent.");
  } else if (checkpoint.stage === "complete") {
    throw new Error("Complete Code repair stage lacks a terminal record.");
  } else if (checkpoint.stage === "blocked" && !checkpoint.blocker) {
    throw new Error("Blocked Code repair stage lacks its resumable blocker record.");
  } else if (checkpoint.blocker && checkpoint.stage !== "blocked") {
    throw new Error("Non-terminal Code repair blocker must use the blocked stage.");
  }
  return checkpoint;
}

/** Recomputes the complete durable validation fingerprint and optionally binds
 * it to the exact request/workspace/profile expected by the current action. */
export async function parseBoundCodeValidationReceiptV1(
  input: unknown,
  expected?: { requestId: string; workspaceId: string; profileKey: string },
): Promise<CodeValidationReceiptV1> {
  const receipt = cloneJson(input as CodeValidationReceiptV1);
  assertExactValidationReceipt(receipt);
  if (
    receipt.version !== CODE_REPAIR_RECEIPT_VERSION ||
    receipt.kindName !== "code_validation" ||
    !["fast", "targeted", "full"].includes(receipt.kind) ||
    typeof receipt.freshSandbox !== "boolean"
  ) throw new Error("Durable validation receipt contract is invalid.");
  assertIdentifier(receipt.id, "validation receipt id");
  assertIdentifier(receipt.sandboxId, "validation sandbox id");
  parseTimestamp(receipt.startedAt, "validation startedAt");
  parseTimestamp(receipt.completedAt, "validation completedAt");
  if (Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt)) {
    throw new Error("Validation completion predates its start.");
  }
  const checks = receipt.checks.map(normalizeValidationCheck);
  if (await sha256Fingerprint(checks) !== await sha256Fingerprint(receipt.checks)) {
    throw new Error("Durable validation checks are not canonically normalized.");
  }
  const status = checks.every((check) => check.exitCode === 0) ? "passed" : "failed";
  if (
    receipt.status !== status ||
    (status === "passed" && receipt.failureFingerprint !== null) ||
    (status === "failed" && !SHA256.test(receipt.failureFingerprint ?? ""))
  ) throw new Error("Durable validation status and failure evidence disagree.");
  if (!receipt.binding) throw new Error("Durable validation receipt has no production binding.");
  if (
    expected && (
      receipt.binding.requestId !== expected.requestId ||
      receipt.binding.workspaceId !== expected.workspaceId ||
      receipt.binding.profileKey !== expected.profileKey
    )
  ) throw new Error("Durable validation receipt escaped its expected request binding.");
  for (const value of [
    receipt.binding.inputWorkspaceManifestFingerprint,
    receipt.binding.validatedWorkspaceManifestFingerprint,
    receipt.binding.stagingManifestFingerprint,
  ]) assertSha256(value, "validation binding fingerprint");
  normalizePathSet(receipt.binding.workspaceChangedPaths, "validation changed paths");
  for (const entry of [...receipt.binding.stagedFiles, ...receipt.binding.importedArtifacts]) {
    assertSafeRepositoryRelativePath(entry.path);
    assertSha256(entry.sha256, "validation artifact fingerprint");
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_TOTAL_ARTIFACT_BYTES) {
      throw new Error("Validation artifact byte count is invalid.");
    }
  }
  const { version: _version, kindName: _kindName, id: _id, fingerprint, ...evidence } = receipt;
  if (fingerprint !== await sha256Fingerprint(evidence)) {
    throw new Error("Durable validation receipt fingerprint is invalid.");
  }
  return receipt;
}

async function createCodeRepairCycleReceipt(input: {
  request: NormalizedCodeRepairRequestV1;
  attempt: CodeRepairAttemptV1;
  outcome: CodeRepairCycleReceiptV1["outcome"];
  recordedAt: string;
}): Promise<CodeRepairCycleReceiptV1> {
  const validation = input.attempt.fastValidation;
  if (!validation) throw new Error("A repair cycle receipt requires validation evidence.");
  const evidence = {
    requestId: input.request.id,
    runId: input.request.runId,
    workspaceId: input.request.worktree.id,
    cycle: input.attempt.cycle,
    outcome: input.outcome,
    validationReceiptId: validation.id,
    validationFingerprint: validation.fingerprint,
    diagnosisOperationId: input.attempt.diagnosis?.operationId ?? null,
    repairOperationId: input.attempt.repair?.operationId ?? null,
    recordedAt: input.recordedAt,
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kind: "code_repair_cycle",
    id: operation(input.request.id, `cycle-${input.attempt.cycle}`),
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

async function createValidationReceipt(
  input: CodeValidationExecutionV1 | CodeValidationReceiptV1,
  expected: {
    operationId: string;
    kind: ValidationKindV1;
    request: NormalizedCodeRepairRequestV1;
  },
): Promise<CodeValidationReceiptV1> {
  assertPlainObject(input, "Validation execution");
  if ("kindName" in input) {
    const receipt = input as CodeValidationReceiptV1;
    if (
      receipt.version !== CODE_REPAIR_RECEIPT_VERSION ||
      receipt.kindName !== "code_validation" ||
      receipt.operationId !== expected.operationId ||
      receipt.kind !== expected.kind ||
      (receipt.binding !== null && (
        receipt.binding.requestId !== expected.request.id ||
        receipt.binding.workspaceId !== expected.request.worktree.id ||
        receipt.binding.profileKey !== expected.request.worktree.profileId
      ))
    ) {
      throw new Error("Bound validation receipt does not match the requested operation and repair scope.");
    }
    const { version: _version, kindName: _kindName, id: _id, fingerprint, ...evidence } = receipt;
    if (fingerprint !== await sha256Fingerprint(evidence)) {
      throw new Error("Bound validation receipt fingerprint is invalid.");
    }
    return JSON.parse(JSON.stringify(receipt)) as CodeValidationReceiptV1;
  }
  if (input.operationId !== expected.operationId) {
    throw new Error("Validation operation ID does not match the requested operation.");
  }
  if (input.kind !== expected.kind) {
    throw new Error(`Validation kind ${input.kind} does not match ${expected.kind}.`);
  }
  const sandboxId = assertIdentifier(input.sandboxId, "sandbox id");
  if (typeof input.freshSandbox !== "boolean") {
    throw new Error("Validation freshSandbox must be boolean.");
  }
  const startedAt = assertBoundedString(input.startedAt, "validation start", 1, 128);
  const completedAt = assertBoundedString(input.completedAt, "validation completion", 1, 128);
  if (!Array.isArray(input.checks) || input.checks.length < 1) {
    throw new Error("Validation must return at least one check.");
  }
  if (input.checks.length > MAX_VALIDATION_CHECKS) {
    throw new Error(`Validation exceeds ${MAX_VALIDATION_CHECKS} checks.`);
  }
  const checks = input.checks.map(normalizeValidationCheck);
  const status: "passed" | "failed" = checks.every((check) => check.exitCode === 0)
    ? "passed"
    : "failed";
  const failureFingerprint =
    status === "failed"
      ? await sha256Fingerprint({
          kind: expected.kind,
          failedChecks: checks
            .filter((check) => check.exitCode !== 0)
            .map((check) => ({
              label: check.label,
              exitCode: check.exitCode,
              stdout: normalizeFailureText(
                check.stdout,
                expected.operationId,
                expected.request,
              ),
              stderr: normalizeFailureText(
                check.stderr,
                expected.operationId,
                expected.request,
              ),
            })),
        })
      : null;
  const receiptEvidence = {
    operationId: expected.operationId,
    kind: expected.kind,
    sandboxId,
    freshSandbox: input.freshSandbox,
    startedAt,
    completedAt,
    checks,
    status,
    failureFingerprint,
    // Coordinator-only validation remains a legacy/non-production lane. The
    // production extension always supplies an exact durable workspace binding.
    binding: null,
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kindName: "code_validation",
    id: expected.operationId,
    ...receiptEvidence,
    fingerprint: await sha256Fingerprint(receiptEvidence),
  };
}

async function createDiffReceipt(
  input: CodeDiffReadbackV1,
  operationId: string,
  expectedBaseSha: string,
): Promise<CodeDiffReceiptV1> {
  assertPlainObject(input, "Diff readback");
  if (input.operationId !== operationId) throw new Error("Diff operation ID mismatch.");
  const baseSha = assertGitSha(input.baseSha, "diff base SHA");
  if (baseSha !== expectedBaseSha) throw new Error("Diff base SHA does not match the worktree base.");
  const patch = assertBoundedString(input.patch, "diff patch", 0, MAX_DIFF_PATCH_BYTES);
  if (new TextEncoder().encode(patch).byteLength > MAX_DIFF_PATCH_BYTES) {
    throw new Error("Diff patch exceeds the 10 MB mission limit.");
  }
  if (!Array.isArray(input.files) || input.files.length < 1) {
    throw new Error("Diff readback contains no changed files.");
  }
  if (input.files.length > MAX_CHANGED_FILES) {
    throw new Error(`Diff exceeds the ${MAX_CHANGED_FILES}-file mission limit.`);
  }
  const files = input.files.map(normalizeDiffFile).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("Diff readback contains duplicate changed paths.");
  }
  const changedPaths = files.map((file) => file.path);
  const evidence = { baseSha, patch, files };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kindName: "code_diff_readback",
    id: operationId,
    operationId,
    baseSha,
    patch,
    files,
    readAt: assertBoundedString(input.readAt, "diff readback time", 1, 128),
    changedPaths,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function normalizeDiffFile(input: CodeDiffFileV1): CodeDiffFileV1 {
  assertPlainObject(input, "Diff file");
  const path = assertSafeRepositoryRelativePath(input.path);
  if (!(["added", "modified", "deleted", "renamed"] as const).includes(input.status)) {
    throw new Error(`Unsupported diff status for ${path}.`);
  }
  const previousPath =
    input.previousPath === null ? null : assertSafeRepositoryRelativePath(input.previousPath);
  const beforeSha256 = input.beforeSha256 === null ? null : assertSha256(input.beforeSha256, "before hash");
  const afterSha256 = input.afterSha256 === null ? null : assertSha256(input.afterSha256, "after hash");
  if (input.status === "added" && (beforeSha256 !== null || afterSha256 === null)) {
    throw new Error(`Added file ${path} has inconsistent hashes.`);
  }
  if (input.status === "deleted" && (beforeSha256 === null || afterSha256 !== null)) {
    throw new Error(`Deleted file ${path} has inconsistent hashes.`);
  }
  if (input.status === "modified" && (beforeSha256 === null || afterSha256 === null)) {
    throw new Error(`Modified file ${path} must have before and after hashes.`);
  }
  if (
    input.status === "renamed" &&
    (previousPath === null || beforeSha256 === null || afterSha256 === null)
  ) {
    throw new Error(`Renamed file ${path} has incomplete lineage.`);
  }
  if (input.status !== "renamed" && previousPath !== null) {
    throw new Error(`Only renamed files may have previousPath (${path}).`);
  }
  return { path, status: input.status, previousPath, beforeSha256, afterSha256 };
}

function normalizeValidationCheck(input: CodeValidationCheckV1): CodeValidationCheckV1 {
  assertPlainObject(input, "Validation check");
  const exitCode = input.exitCode;
  if (!Number.isSafeInteger(exitCode) || exitCode < -1 || exitCode > 255) {
    throw new Error("Validation exitCode must be a safe integer from -1 through 255.");
  }
  const durationMs = input.durationMs;
  if (!Number.isSafeInteger(durationMs) || durationMs < 0 || durationMs > 86_400_000) {
    throw new Error("Validation duration is outside the one-day bound.");
  }
  return {
    label: assertBoundedString(input.label, "validation label", 1, 512),
    exitCode,
    stdout: truncateTail(assertString(input.stdout, "validation stdout"), MAX_VALIDATION_OUTPUT_CHARACTERS),
    stderr: truncateTail(assertString(input.stderr, "validation stderr"), MAX_VALIDATION_OUTPUT_CHARACTERS),
    durationMs,
  };
}

function normalizeEditResult(input: CodeEditResultV1, operationId: string): CodeEditResultV1 {
  assertPlainObject(input, "Code edit result");
  if (input.operationId !== operationId) throw new Error("Code edit operation ID mismatch.");
  if (!Array.isArray(input.changedPaths) || input.changedPaths.length > MAX_CHANGED_FILES) {
    throw new Error(`Code edit result exceeds ${MAX_CHANGED_FILES} changed files.`);
  }
  const changedPaths = [...new Set(input.changedPaths.map(assertSafeRepositoryRelativePath))].sort();
  const expectedArtifacts = normalizeExpectedArtifacts(input.expectedArtifacts);
  const changedSet = new Set(changedPaths);
  for (const artifact of expectedArtifacts) {
    if (!changedSet.has(artifact.path)) {
      throw new Error(`Expected artifact ${artifact.path} was not reported as changed.`);
    }
  }
  return {
    operationId,
    summary: assertBoundedString(input.summary, "edit summary", 1, 20_000),
    changedPaths,
    expectedArtifacts,
    appliedAt: assertBoundedString(input.appliedAt, "edit application time", 1, 128),
  };
}

function normalizeDiagnosis(
  input: CodeDiagnosisV1,
  operationId: string,
  failureFingerprint: string,
): CodeDiagnosisV1 {
  assertPlainObject(input, "Code diagnosis");
  if (input.operationId !== operationId) throw new Error("Diagnosis operation ID mismatch.");
  if (input.failureFingerprint !== failureFingerprint) {
    throw new Error("Diagnosis is not bound to the failed validation fingerprint.");
  }
  return {
    operationId,
    failureFingerprint,
    summary: assertBoundedString(input.summary, "diagnosis summary", 1, 20_000),
    proposedRepair: assertBoundedString(input.proposedRepair, "proposed repair", 1, 20_000),
    diagnosedAt: assertBoundedString(input.diagnosedAt, "diagnosis time", 1, 128),
  };
}

function normalizeApprovalDecision(
  input: ProtectedDiffApprovalDecisionV1,
  operationId: string,
): ProtectedDiffApprovalDecisionV1 {
  assertPlainObject(input, "Protected diff approval decision");
  if (input.operationId !== operationId) throw new Error("Approval decision operation ID mismatch.");
  if (input.decision !== "approved" && input.decision !== "denied") {
    throw new Error("Approval decision must be approved or denied.");
  }
  return {
    operationId,
    decision: input.decision,
    decidedAt: assertBoundedString(input.decidedAt, "approval decision time", 1, 128),
  };
}

function normalizeCommitResult(input: CodeCommitResultV1, operationId: string): CodeCommitResultV1 {
  assertPlainObject(input, "Commit result");
  if (input.operationId !== operationId) throw new Error("Commit operation ID mismatch.");
  return {
    operationId,
    commitSha: assertGitSha(input.commitSha, "commit SHA"),
    committedAt: assertBoundedString(input.committedAt, "commit time", 1, 128),
  };
}

function normalizeCommitReadback(
  input: CodeCommitReadbackV1,
  operationId: string,
): CodeCommitReadbackV1 {
  assertPlainObject(input, "Commit readback");
  if (input.operationId !== operationId) throw new Error("Commit readback operation ID mismatch.");
  return {
    operationId,
    commitSha: assertGitSha(input.commitSha, "readback commit SHA"),
    parentSha: assertGitSha(input.parentSha, "readback parent SHA"),
    treeSha: assertGitSha(input.treeSha, "readback tree SHA"),
    diffFingerprint: assertSha256(input.diffFingerprint, "readback diff fingerprint"),
    changedPaths: normalizePathSet(input.changedPaths, "commit readback changed paths"),
    artifactHashes: normalizeArtifactReadback(input.artifactHashes),
    readAt: assertBoundedString(input.readAt, "commit readback time", 1, 128),
  };
}

function normalizeExpectedArtifacts(input: ExpectedArtifactV1[]): ExpectedArtifactV1[] {
  if (!Array.isArray(input) || input.length > MAX_EXPECTED_ARTIFACTS) {
    throw new Error(`Expected artifacts exceed the ${MAX_EXPECTED_ARTIFACTS}-file limit.`);
  }
  const byPath = new Map<string, string>();
  for (const artifact of input) {
    assertPlainObject(artifact, "Expected artifact");
    const path = assertSafeRepositoryRelativePath(artifact.path);
    const sha256 = assertSha256(artifact.sha256, `expected hash for ${path}`);
    const existing = byPath.get(path);
    if (existing && existing !== sha256) {
      throw new Error(`Expected artifact ${path} has conflicting hashes.`);
    }
    byPath.set(path, sha256);
  }
  return [...byPath.entries()]
    .map(([path, sha256]) => ({ path, sha256 }))
    .sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeArtifactReadback(
  input: ArtifactHashReadbackV1[],
  expected?: ExpectedArtifactV1[],
): ArtifactHashReadbackV1[] {
  if (!Array.isArray(input) || input.length > MAX_EXPECTED_ARTIFACTS) {
    throw new Error(`Artifact readback exceeds the ${MAX_EXPECTED_ARTIFACTS}-file limit.`);
  }
  const normalized = input.map((artifact) => {
    assertPlainObject(artifact, "Artifact hash readback");
    if (
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > MAX_MODEL_EDITED_FILE_BYTES
    ) {
      throw new Error(`Artifact ${artifact.path} exceeds the 2 MB model-edit limit.`);
    }
    return {
      path: assertSafeRepositoryRelativePath(artifact.path),
      sha256: assertSha256(artifact.sha256, `artifact hash for ${artifact.path}`),
      bytes: artifact.bytes,
    };
  });
  normalized.sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(normalized.map((artifact) => artifact.path)).size !== normalized.length) {
    throw new Error("Artifact readback contains duplicate paths.");
  }
  const totalBytes = normalized.reduce((sum, artifact) => sum + artifact.bytes, 0);
  if (totalBytes > MAX_TOTAL_ARTIFACT_BYTES) {
    throw new Error("Artifact readback exceeds the 10 MB mission limit.");
  }
  if (expected) {
    const mismatch = compareExpectedArtifacts(expected, normalized);
    if (mismatch) throw new Error(mismatch);
  }
  return normalized;
}

function collectExpectedArtifacts(
  checkpoint: CodeRepairCheckpointV1,
  finalDiff: CodeDiffReceiptV1,
): { artifacts: ExpectedArtifactV1[]; mismatch: string | null } {
  const explicit = new Map<string, string>();
  const sources: ExpectedArtifactV1[][] = [checkpoint.request.expectedArtifacts];
  if (checkpoint.initialEdit) sources.push(checkpoint.initialEdit.expectedArtifacts);
  for (const attempt of checkpoint.attempts) {
    if (attempt.repair) sources.push(attempt.repair.expectedArtifacts);
  }
  for (const source of sources) {
    for (const artifact of source) explicit.set(artifact.path, artifact.sha256);
  }

  const finalHashes = new Map(
    finalDiff.files
      .filter((file): file is CodeDiffFileV1 & { afterSha256: string } => file.afterSha256 !== null)
      .map((file) => [file.path, file.afterSha256]),
  );
  for (const [path, expectedHash] of explicit) {
    const finalHash = finalHashes.get(path);
    if (!finalHash) {
      return { artifacts: [], mismatch: `Expected artifact ${path} is absent from the final diff.` };
    }
    if (finalHash !== expectedHash) {
      return {
        artifacts: [],
        mismatch: `Expected artifact ${path} has final diff hash ${finalHash}, not ${expectedHash}.`,
      };
    }
  }
  for (const [path, finalHash] of finalHashes) {
    if (!explicit.has(path)) explicit.set(path, finalHash);
  }
  return {
    artifacts: [...explicit.entries()]
      .map(([path, sha256]) => ({ path, sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
    mismatch: null,
  };
}

function compareExpectedArtifacts(
  expected: ExpectedArtifactV1[],
  actual: ArtifactHashReadbackV1[],
): string | null {
  const expectedMap = new Map(expected.map((artifact) => [artifact.path, artifact.sha256]));
  const actualMap = new Map(actual.map((artifact) => [artifact.path, artifact.sha256]));
  if (expectedMap.size !== actualMap.size) {
    return `Artifact readback count ${actualMap.size} does not match expected count ${expectedMap.size}.`;
  }
  for (const [path, sha256] of expectedMap) {
    if (actualMap.get(path) !== sha256) {
      return `Artifact readback hash mismatch for ${path}.`;
    }
  }
  return null;
}

function compareCommitReadback(input: {
  request: NormalizedCodeRepairRequestV1;
  commit: CodeCommitResultV1;
  readback: CodeCommitReadbackV1;
  diff: CodeDiffReceiptV1;
  artifactHashes: ArtifactHashReadbackV1[];
}): string | null {
  if (input.readback.commitSha !== input.commit.commitSha) {
    return "Commit readback SHA does not match the created commit SHA.";
  }
  if (input.readback.parentSha !== input.request.worktree.baseSha) {
    return "Commit parent does not match the trusted worktree base SHA.";
  }
  if (input.readback.diffFingerprint !== input.diff.fingerprint) {
    return "Commit diff fingerprint does not match the verified worktree diff.";
  }
  if (!sameStrings(input.readback.changedPaths, input.diff.changedPaths)) {
    return "Commit changed paths do not match the verified worktree diff.";
  }
  const expected = input.artifactHashes.map(({ path, sha256 }) => ({ path, sha256 }));
  return compareExpectedArtifacts(expected, input.readback.artifactHashes);
}

function assertTerminalValidationCoverage(
  request: NormalizedCodeRepairRequestV1,
  diff: CodeDiffReceiptV1,
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
): void {
  if (
    targeted.kind !== "targeted" || targeted.status !== "passed" ||
    full.kind !== "full" || full.status !== "passed" ||
    !full.freshSandbox || targeted.sandboxId === full.sandboxId ||
    !targeted.binding || !full.binding
  ) throw new Error("Terminal checkpoint lacks distinct green targeted/full validation proof.");
  for (const receipt of [targeted, full]) {
    const binding = receipt.binding!;
    if (
      binding.requestId !== request.id ||
      binding.workspaceId !== request.worktree.id ||
      binding.profileKey !== request.worktree.profileId
    ) throw new Error("Terminal validation receipt escaped its request binding.");
    const covered = new Map(
      [...binding.stagedFiles, ...binding.importedArtifacts]
        .map((entry) => [entry.path, entry.sha256]),
    );
    for (const file of diff.files) {
      if (
        !binding.workspaceChangedPaths.includes(file.path) ||
        (file.afterSha256 !== null && covered.get(file.path) !== file.afterSha256)
      ) throw new Error(`Terminal validation does not cover ${file.path}.`);
    }
  }
  if (
    targeted.binding.validatedWorkspaceManifestFingerprint !==
      full.binding.validatedWorkspaceManifestFingerprint ||
    targeted.binding.stagingManifestFingerprint !==
      full.binding.stagingManifestFingerprint
  ) throw new Error("Terminal targeted/full validation bindings drifted.");
}

function verifiedCommitApprovalFingerprint(input: {
  checkpoint: CodeRepairCheckpointV1;
  diff: CodeDiffReceiptV1;
  artifactHashes: ArtifactHashReadbackV1[];
  targetedValidation: CodeValidationReceiptV1;
  fullValidation: CodeValidationReceiptV1;
}): Promise<string> {
  return verifiedCommitApprovalFingerprintV1({
    request: input.checkpoint.request,
    diff: input.diff,
    artifactHashes: input.artifactHashes,
    targetedValidationReceiptId: input.targetedValidation.id,
    fullValidationReceiptId: input.fullValidation.id,
  });
}

export function verifiedCommitApprovalFingerprintV1(input: {
  request: NormalizedCodeRepairRequestV1;
  diff: CodeDiffReceiptV1;
  artifactHashes: ArtifactHashReadbackV1[];
  targetedValidationReceiptId: string;
  fullValidationReceiptId: string;
}): Promise<string> {
  return sha256Fingerprint({
    toolName: "code_commit_verified",
    requestId: input.request.id,
    runId: input.request.runId,
    workspaceId: input.request.worktree.id,
    baseSha: input.request.worktree.baseSha,
    branch: input.request.worktree.branch,
    commitMessage: input.request.commitMessage,
    diffFingerprint: input.diff.fingerprint,
    changedPaths: input.diff.changedPaths,
    artifactHashes: input.artifactHashes,
    targetedValidationReceiptId: input.targetedValidationReceiptId,
    fullValidationReceiptId: input.fullValidationReceiptId,
  });
}

async function createVerifiedCommitReceipt(input: {
  request: NormalizedCodeRepairRequestV1;
  commit: CodeCommitResultV1;
  commitReadback: CodeCommitReadbackV1;
  diff: CodeDiffReceiptV1;
  artifactHashes: ArtifactHashReadbackV1[];
  targetedValidation: CodeValidationReceiptV1;
  fullValidation: CodeValidationReceiptV1;
}): Promise<VerifiedLocalCommitReceiptV1> {
  const evidence = {
    requestId: input.request.id,
    runId: input.request.runId,
    worktreeId: input.request.worktree.id,
    workspaceId: input.request.worktree.id,
    branch: input.request.worktree.branch,
    baseSha: input.request.worktree.baseSha,
    commitSha: input.commit.commitSha,
    parentSha: input.request.worktree.baseSha,
    treeSha: input.commitReadback.treeSha,
    diffFingerprint: input.diff.fingerprint,
    changedPaths: [...input.diff.changedPaths],
    artifactHashes: cloneJson(input.artifactHashes),
    changedArtifacts: input.diff.files.map((file) => ({
      path: file.path,
      sha256: file.afterSha256,
    })),
    targetedValidationReceiptId: input.targetedValidation.id,
    fullValidationReceiptId: input.fullValidation.id,
    targetedValidationFingerprint: input.targetedValidation.fingerprint,
    fullValidationFingerprint: input.fullValidation.fingerprint,
    committedAt: input.commit.committedAt,
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kind: "verified_local_commit",
    id: operation(input.request.id, "verified-commit"),
    status: "verified",
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function resultFromCheckpoint(checkpoint: CodeRepairCheckpointV1): CodeRepairResultV1 {
  if (!checkpoint.terminal) throw new Error("Code repair checkpoint is not terminal.");
  const result: CodeRepairResultV1 = {
    status: checkpoint.terminal.status,
    publicationEligible: checkpoint.terminal.publicationEligible,
    checkpoint: cloneJson(checkpoint),
  };
  if (checkpoint.verifiedCommitReceipt) {
    result.verifiedCommitReceipt = cloneJson(checkpoint.verifiedCommitReceipt);
  }
  if (checkpoint.blocker) result.blocker = cloneJson(checkpoint.blocker);
  return result;
}

function requiredAttempt(checkpoint: CodeRepairCheckpointV1, cycle: number): CodeRepairAttemptV1 {
  const attempt = checkpoint.attempts.find((candidate) => candidate.cycle === cycle);
  if (!attempt) throw new Error(`Missing repair attempt ${cycle}.`);
  return attempt;
}

function requiredPreviewDiff(checkpoint: CodeRepairCheckpointV1): CodeDiffReceiptV1 {
  if (!checkpoint.previewDiff) throw new Error("Missing preview diff receipt.");
  return checkpoint.previewDiff;
}

function requiredFinalDiff(checkpoint: CodeRepairCheckpointV1): CodeDiffReceiptV1 {
  if (!checkpoint.finalDiff) throw new Error("Missing final diff receipt.");
  return checkpoint.finalDiff;
}

function requiredTargetedValidation(checkpoint: CodeRepairCheckpointV1): CodeValidationReceiptV1 {
  if (!checkpoint.targetedValidation) throw new Error("Missing targeted validation receipt.");
  return checkpoint.targetedValidation;
}

function requiredFullValidation(checkpoint: CodeRepairCheckpointV1): CodeValidationReceiptV1 {
  if (!checkpoint.fullValidation) throw new Error("Missing full validation receipt.");
  return checkpoint.fullValidation;
}

function requireFailureFingerprint(receipt: CodeValidationReceiptV1): string {
  if (!receipt.failureFingerprint) throw new Error("Failed validation has no failure fingerprint.");
  return receipt.failureFingerprint;
}

function normalizePathSet(input: string[], label: string): string[] {
  if (!Array.isArray(input) || input.length > MAX_CHANGED_FILES) {
    throw new Error(`${label} exceeds ${MAX_CHANGED_FILES} paths.`);
  }
  const normalized = [...new Set(input.map(assertSafeRepositoryRelativePath))].sort();
  if (normalized.length !== input.length) throw new Error(`${label} contains duplicate paths.`);
  return normalized;
}

function normalizeFailureText(
  text: string,
  operationId: string,
  request: NormalizedCodeRepairRequestV1,
): string {
  let normalized = text.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "");
  for (const volatile of [operationId, request.worktree.path, request.worktree.repositoryRoot]) {
    if (volatile) normalized = normalized.split(volatile).join("<BOUNDARY>");
  }
  normalized = normalized.replace(/\s+/g, " ").trim();
  return truncateTail(normalized, 8_192);
}

function truncateTail(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `[truncated ${value.length - maxCharacters} chars]${value.slice(-maxCharacters)}`;
}

function operation(requestId: string, suffix: string): string {
  return `code-repair:${requestId}:${suffix}`;
}

function assertIdentifier(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (!IDENTIFIER.test(text)) throw new Error(`${label} is not a valid durable identifier.`);
  return text;
}

function assertGitSha(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (!GIT_SHA.test(text)) throw new Error(`${label} is not a full Git object SHA.`);
  return text;
}

function assertSha256(value: unknown, label: string): string {
  const text = assertString(value, label);
  if (!SHA256.test(text)) throw new Error(`${label} is not a canonical SHA-256 fingerprint.`);
  return text;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new TypeError(`${label} must be a string.`);
  return value;
}

function assertBoundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  const text = assertString(value, label);
  if (text.length < minimum || text.length > maximum) {
    throw new Error(`${label} must contain ${minimum} through ${maximum} characters.`);
  }
  return text;
}

function assertPlainObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
}

function assertExactKeys(
  value: unknown,
  keys: readonly string[],
  label: string,
  allowMissing = false,
): asserts value is Record<string, unknown> {
  assertPlainObject(value, label);
  const allowed = new Set(keys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  const missing = allowMissing
    ? []
    : keys.filter((key) => !Object.prototype.hasOwnProperty.call(value, key));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(
      `${label} has unknown or missing fields (unknown=${unknown.join(",") || "none"}; missing=${missing.join(",") || "none"}).`,
    );
  }
}

function parseTimestamp(value: unknown, label: string): string {
  const timestamp = assertBoundedString(value, label, 1, 128);
  if (!Number.isFinite(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    throw new Error(`${label} is not a canonical ISO timestamp.`);
  }
  return timestamp;
}

function assertExactValidationReceipt(receipt: CodeValidationReceiptV1): void {
  assertExactKeys(receipt, [
    "version", "kindName", "id", "operationId", "kind", "sandboxId",
    "freshSandbox", "startedAt", "completedAt", "checks", "status",
    "failureFingerprint", "binding", "fingerprint",
  ], "validation receipt");
  if (!Array.isArray(receipt.checks) || receipt.checks.length < 1 || receipt.checks.length > MAX_VALIDATION_CHECKS) {
    throw new Error("Validation receipt checks are invalid.");
  }
  for (const check of receipt.checks) {
    assertExactKeys(check, [
      "label", "exitCode", "stdout", "stderr", "durationMs",
    ], "validation check");
  }
  if (!receipt.binding) return;
  assertExactKeys(receipt.binding, [
    "requestId", "workspaceId", "profileKey", "inputWorkspaceManifestFingerprint",
    "validatedWorkspaceManifestFingerprint", "workspaceChangedPaths",
    "stagingManifestFingerprint", "stagedFiles", "importedArtifacts",
  ], "validation binding");
  for (const entry of [...receipt.binding.stagedFiles, ...receipt.binding.importedArtifacts]) {
    assertExactKeys(entry, ["path", "sha256", "bytes"], "validation bound artifact");
  }
}

function assertExactVerifiedCommitReceipt(receipt: VerifiedLocalCommitReceiptV1): void {
  assertExactKeys(receipt, [
    "version", "kind", "id", "status", "requestId", "runId", "worktreeId",
    "workspaceId", "branch", "baseSha", "commitSha", "parentSha", "treeSha",
    "diffFingerprint", "changedPaths", "artifactHashes", "changedArtifacts",
    "targetedValidationReceiptId", "fullValidationReceiptId",
    "targetedValidationFingerprint", "fullValidationFingerprint", "committedAt",
    "fingerprint",
  ], "verified local commit receipt");
  for (const artifact of receipt.artifactHashes) {
    assertExactKeys(artifact, ["path", "sha256", "bytes"], "verified artifact hash");
  }
  for (const artifact of receipt.changedArtifacts) {
    assertExactKeys(artifact, ["path", "sha256"], "verified changed artifact");
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return [...left].sort().every((value, index) => value === [...right].sort()[index]);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
