import type {
  ActionReconciliationResultV1,
  ActionReceiptV1,
  JsonValueV1,
  PreparedActionResultV1,
  PreparedActionV1,
  ResourceActionV1,
  ScopedExtensionContextV1,
} from "@agentic-researcher/core-api";

import { sha256Fingerprint } from "../../../packages/headless-runtime/src/canonicalize";
import {
  classifyProtectedControlChangesV2,
  parseRepositoryProfileV2,
  type ProtectedControlClassificationV2,
  type RepositoryFileChangeV2,
  type RepositoryProfileV2,
} from "../repositories/RepositoryProfileV2";
import {
  type WorkspaceManifestV2,
} from "../workspaces/WorkspaceManifestV2";
import { WorkspaceManagerV2 } from "../workspaces/WorkspaceManagerV2";
import {
  CODE_COMMIT_VERIFIED_TOOL,
  CODE_REPAIR_RECORD_CYCLE_TOOL,
  type CodeRepairScopeArgsV1,
  type CodeRepairStatusV1,
  type CodeRepairToolHandlersV1,
} from "./contributions";
import {
  codeRepairCheckpointIdV1,
  normalizeCodeRepairRequestV1,
} from "./codeRepairCoordinator";
import {
  CallbackCodeRepairCheckpointStoreV1,
  type CallbackCheckpointPersistenceV1,
} from "./productionAdapters";
import { assertSafeRepositoryRelativePath } from "./protectedControls";
import {
  CODE_REPAIR_CHECKPOINT_VERSION,
  CODE_REPAIR_RECEIPT_VERSION,
  type ArtifactHashReadbackV1,
  type CodeCommitReadbackV1,
  type CodeCommitResultV1,
  type CodeDiffFileV1,
  type CodeDiffReadbackV1,
  type CodeDiffReceiptV1,
  type CodeProofReaderV1,
  type CodeRepairBlockerCodeV1,
  type CodeRepairCheckpointV1,
  type CodeRepairCycleReceiptV1,
  type CodeValidationReceiptV1,
  type ExpectedArtifactV1,
  type NormalizedCodeRepairRequestV1,
  type VerifiedCommitGatewayV1,
  type VerifiedLocalCommitReceiptV1,
} from "./types";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_CHANGED_FILES = 100;
const MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;
const MAX_PATCH_BYTES = 10 * 1024 * 1024;
const PREPARED_TTL_MS = 10 * 60 * 1_000;

export interface RepositoryProfileResolutionForRepairV1 {
  profile: RepositoryProfileV2;
  /** Exact agent-owned worktree branch; WorkspaceManifestV2 does not store it. */
  worktreeBranch: string;
  commitMessage?: string;
  expectedArtifacts?: ExpectedArtifactV1[];
}

export interface RepositoryProfileResolverForRepairV1 {
  resolve(input: {
    profileKey: string;
    workspaceId: string;
    runId: string;
    requestId: string;
    manifest: WorkspaceManifestV2;
  }): Promise<RepositoryProfileResolutionForRepairV1 | null>;
}

/** Registry implementations must enforce the supplied mission/workspace binding. */
export interface ValidationReceiptRegistryV1 {
  readValidation(input: {
    receiptId: string;
    runId: string;
    workspaceId: string;
    requestId: string;
  }): Promise<CodeValidationReceiptV1 | null>;
  readLatestValidation?(input: {
    runId: string;
    workspaceId: string;
    requestId: string;
    kind: CodeValidationReceiptV1["kind"];
  }): Promise<CodeValidationReceiptV1 | null>;
}

export interface CodeRepairToolRuntimeDependenciesV1 {
  workspaceManager: WorkspaceManagerV2;
  repositoryProfiles: RepositoryProfileResolverForRepairV1;
  validations: ValidationReceiptRegistryV1;
  checkpointPersistence: CallbackCheckpointPersistenceV1;
  proofReader: CodeProofReaderV1;
  /** Commit-only fixed-argv gateway with Git object readback. */
  commitGateway: VerifiedCommitGatewayV1;
  now?: () => Date;
}

interface CycleActionPayloadV1 {
  kind: "code_repair_cycle_v1";
  scope: CodeRepairScopeArgsV1;
  checkpointSequence: number;
  cycle: number;
  validationReceiptId: string;
  validationFingerprint: string;
  cycleFingerprint: string;
  outcome: CodeRepairCycleReceiptV1["outcome"];
}

interface CommitActionPayloadV1 {
  kind: "verified_local_commit_v1";
  scope: CodeRepairScopeArgsV1;
  checkpointSequence: number;
  profileKey: string;
  diffFingerprint: string;
  artifactFingerprint: string;
  targetedValidationReceiptId: string;
  targetedValidationFingerprint: string;
  fullValidationReceiptId: string;
  fullValidationFingerprint: string;
  protectedClassificationFingerprint: string;
  requiredConfirmations: 1 | 2;
}

interface ResolvedRepairScopeV1 {
  manifest: WorkspaceManifestV2;
  profile: RepositoryProfileV2;
  request: NormalizedCodeRepairRequestV1;
}

/**
 * Production proof-only handlers for the public repair contributions. They do
 * not run a model, validator, native command, or legacy GitWorktreeManager.
 */
export function createCodeRepairToolRuntimeV1(
  dependencies: CodeRepairToolRuntimeDependenciesV1,
): CodeRepairToolHandlersV1 {
  const runtime = new CodeRepairToolRuntimeV1(dependencies);
  return {
    readStatus: (args, context) => runtime.readStatus(args, context),
    prepareCycleRecord: (args, context) => runtime.prepareCycleRecord(args, context),
    executePreparedCycleRecord: (action, context) =>
      runtime.executePreparedCycleRecord(action, context),
    reconcileCycleRecord: (action, context) =>
      runtime.reconcileCycleRecord(action, context),
    prepareVerifiedCommit: (args, context) => runtime.prepareVerifiedCommit(args, context),
    executePreparedVerifiedCommit: (action, context) =>
      runtime.executePreparedVerifiedCommit(action, context),
    reconcileVerifiedCommit: (action, context) =>
      runtime.reconcileVerifiedCommit(action, context),
  };
}

export class CodeRepairToolRuntimeV1 implements CodeRepairToolHandlersV1 {
  private readonly checkpoints: CallbackCodeRepairCheckpointStoreV1;
  private readonly now: () => Date;

  constructor(private readonly dependencies: CodeRepairToolRuntimeDependenciesV1) {
    this.checkpoints = new CallbackCodeRepairCheckpointStoreV1(
      dependencies.checkpointPersistence,
    );
    this.now = dependencies.now ?? (() => new Date());
  }

  async readStatus(
    args: CodeRepairScopeArgsV1,
    context: ScopedExtensionContextV1,
  ): Promise<CodeRepairStatusV1> {
    assertContextScope(args, context);
    const id = checkpointId(args);
    const checkpoint = await this.checkpoints.load(id);
    if (!checkpoint) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repair_checkpoint_missing",
        `No durable code repair checkpoint exists for ${id}.`,
      );
    }
    assertCheckpointScope(checkpoint, args);
    return statusFromCheckpoint(checkpoint, args);
  }

  async prepareCycleRecord(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1> {
    let scope: CodeRepairScopeArgsV1 | null = null;
    let checkpoint: CodeRepairCheckpointV1 | null = null;
    try {
      const parsed = parseCycleArgs(args);
      scope = parsed.scope;
      assertContextScope(scope, context);
      const resolved = await this.resolveScope(scope, context);
      checkpoint = await this.loadOrCreateCheckpoint(
        scope,
        resolved.request,
        parsed.checkpointSequence ?? 0,
      );
      if (checkpoint.terminal) {
        return preparationFailure(
          "repair_checkpoint_terminal",
          "The code repair checkpoint is terminal and immutable.",
        );
      }
      if (
        parsed.checkpointSequence !== null &&
        parsed.checkpointSequence !== checkpoint.sequence
      ) {
        return preparationFailure(
          "repair_checkpoint_stale",
          `Checkpoint sequence is ${checkpoint.sequence}, not ${parsed.checkpointSequence}.`,
        );
      }
      const validation = parsed.validationReceiptId === null
        ? await this.latestValidation(scope, "fast")
        : await this.requiredValidation(scope, parsed.validationReceiptId, "fast");
      assertValidationBoundToWorkspace(
        validation,
        resolved.manifest,
        resolved.profile.key,
        scope,
      );
      const hostCycleFingerprint = validation.failureFingerprint ?? validation.fingerprint;
      if (
        parsed.cycleFingerprint !== null &&
        parsed.cycleFingerprint !== hostCycleFingerprint
      ) {
        await this.persistBlocker(
          checkpoint,
          "diff_readback_invalid",
          "The proposed cycle fingerprint does not match the host-verified fast validation receipt.",
          validation.fingerprint,
          false,
        );
        return preparationFailure(
          "cycle_fingerprint_mismatch",
          "Cycle fingerprint does not match the referenced validation proof.",
        );
      }
      const nextCycle = checkpoint.attempts.length + 1;
      const cycle = parsed.cycle ?? nextCycle;
      const existingAttempt = checkpoint.attempts.find(
        (attempt) => attempt.cycle === cycle,
      );
      if (
        existingAttempt?.fastValidation &&
        existingAttempt.fastValidation.id !== validation.id
      ) {
        return preparationFailure(
          "cycle_already_recorded",
          "This cycle is already bound to a different validation receipt.",
        );
      }
      if (!existingAttempt && cycle !== nextCycle) {
        return preparationFailure(
          "cycle_sequence_invalid",
          `The next repair cycle must be ${nextCycle}.`,
        );
      }
      if (
        validation.status === "failed" &&
        validation.failureFingerprint &&
        checkpoint.failureHistory.some(
          (entry) =>
            entry.cycle < cycle &&
            entry.fingerprint === validation.failureFingerprint,
        )
      ) {
        await this.recordUnchangedFailure(checkpoint, cycle, validation);
        return preparationFailure(
          "unchanged_failure",
          "The same fast-validation failure fingerprint survived a repair; further repair is stopped.",
        );
      }
      const outcome = validation.status === "passed"
        ? "passed"
        : cycle >= 3
          ? "blocked"
          : "repaired";
      const payload: CycleActionPayloadV1 = {
        kind: "code_repair_cycle_v1",
        scope,
        checkpointSequence: checkpoint.sequence,
        cycle,
        validationReceiptId: validation.id,
        validationFingerprint: validation.fingerprint,
        cycleFingerprint: hostCycleFingerprint,
        outcome,
      };
      return {
        ok: true,
        action: await this.preparedAction({
          toolName: CODE_REPAIR_RECORD_CYCLE_TOOL,
          scope,
          context,
          normalizedArgs: payload as unknown as Record<string, JsonValueV1>,
          expectedTargetRevision: String(checkpoint.sequence),
          summary: `Record repair cycle ${cycle} from verified fast sandbox receipt ${validation.id}.`,
          warnings: outcome === "blocked"
            ? ["This third failed cycle will durably block the repair request."]
            : [],
          requiredConfirmations: 1,
          operation: "update",
          repositoryProfileId: resolved.profile.key,
        }),
      };
    } catch (error) {
      if (checkpoint && isProofError(error)) {
        await this.persistBlocker(
          checkpoint,
          proofBlockerCode(error),
          errorMessage(error),
          null,
          false,
        ).catch(() => undefined);
      }
      return preparationFailure(errorCode(error), errorMessage(error));
    }
  }

  async executePreparedCycleRecord(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ domainReceipt: CodeRepairCycleReceiptV1; actionReceipt: ActionReceiptV1 }> {
    await validatePreparedAction(action, context, CODE_REPAIR_RECORD_CYCLE_TOOL);
    const payload = parseCyclePayload(action.normalizedArgs);
    assertContextScope(payload.scope, context);
    const checkpoint = await this.requiredCheckpoint(payload.scope);
    const existing = checkpoint.attempts.find(
      (attempt) => attempt.cycle === payload.cycle,
    );
    if (existing?.cycleReceipt) {
      if (
        existing.fastValidation?.id !== payload.validationReceiptId ||
        existing.fastValidation.fingerprint !== payload.validationFingerprint
      ) {
        throw new CodeRepairToolRuntimeErrorV1(
          "cycle_reconciliation_mismatch",
          "A recorded repair cycle does not match the prepared validation proof.",
        );
      }
      return {
        domainReceipt: cloneJson(existing.cycleReceipt),
        actionReceipt: actionReceipt(
          action,
          context,
          "update",
          existing.cycleReceipt.id,
          existing.cycleReceipt.fingerprint,
          existing.cycleReceipt.recordedAt,
          `Repair cycle ${payload.cycle} was already recorded and reconciled.`,
          "reconciled",
        ),
      };
    }
    if (checkpoint.sequence !== payload.checkpointSequence) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repair_checkpoint_stale",
        "The repair checkpoint changed after cycle preparation.",
      );
    }
    let validation: CodeValidationReceiptV1;
    try {
      validation = await this.requiredValidation(
        payload.scope,
        payload.validationReceiptId,
        "fast",
      );
    } catch (error) {
      await this.persistBlocker(
        checkpoint,
        proofBlockerCode(error),
        errorMessage(error),
        null,
        false,
      );
      throw error;
    }
    if (
      validation.fingerprint !== payload.validationFingerprint ||
      (validation.failureFingerprint ?? validation.fingerprint) !== payload.cycleFingerprint
    ) {
      await this.persistBlocker(
        checkpoint,
        "diff_readback_invalid",
        "Fast validation proof changed after cycle preparation.",
        validation.fingerprint,
        false,
      );
      throw new CodeRepairToolRuntimeErrorV1(
        "validation_proof_stale",
        "Fast validation proof changed after preparation.",
      );
    }
    const repeated = validation.status === "failed" &&
      validation.failureFingerprint &&
      checkpoint.failureHistory.some(
        (entry) => entry.fingerprint === validation.failureFingerprint,
      );
    if (repeated) {
      await this.recordUnchangedFailure(checkpoint, payload.cycle, validation);
      throw new CodeRepairToolRuntimeErrorV1(
        "unchanged_failure",
        "The same validation failure fingerprint survived the previous cycle.",
      );
    }
    const recordedAt = this.timestamp();
    const domainReceipt = await createCycleReceipt(
      payload.scope,
      payload.cycle,
      payload.outcome,
      validation,
      recordedAt,
    );
    const next = cloneJson(checkpoint);
    next.sequence += 1;
    next.updatedAt = recordedAt;
    next.validationHistory.push(validation);
    next.attempts.push({
      cycle: payload.cycle,
      fastValidation: validation,
      cycleReceipt: domainReceipt,
    });
    if (validation.failureFingerprint) {
      next.failureHistory.push({
        cycle: payload.cycle,
        fingerprint: validation.failureFingerprint,
        recordedAt,
      });
    }
    delete next.blocker;
    if (payload.outcome === "passed") {
      next.stage = "diff_preview";
    } else if (payload.outcome === "repaired") {
      next.stage = "repairing";
    } else {
      next.stage = "blocked";
      next.blocker = {
        code: "repair_cycles_exhausted",
        message: "Fast validation remained red after the third bounded repair cycle.",
        evidenceFingerprint: validation.failureFingerprint,
        blockedAt: recordedAt,
      };
      next.terminal = {
        status: "blocked",
        publicationEligible: false,
        completedAt: recordedAt,
      };
    }
    await this.checkpoints.save(next, checkpoint.sequence);
    return {
      domainReceipt,
      actionReceipt: actionReceipt(
        action,
        context,
        "update",
        domainReceipt.id,
        domainReceipt.fingerprint,
        recordedAt,
        `Recorded repair cycle ${payload.cycle} with outcome ${payload.outcome}.`,
      ),
    };
  }

  async reconcileCycleRecord(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<ActionReconciliationResultV1> {
    try {
      await validatePreparedActionIntegrity(action, CODE_REPAIR_RECORD_CYCLE_TOOL);
      const payload = parseCyclePayload(action.normalizedArgs);
      assertContextScope(payload.scope, context);
      const checkpoint = await this.checkpoints.load(checkpointId(payload.scope));
      if (!checkpoint) {
        return {
          outcome: "still_uncertain",
          message: "Repair checkpoint is missing; durable state loss prevents a safe replay decision.",
        };
      }
      assertCheckpointScope(checkpoint, payload.scope);
      const existing = checkpoint.attempts.find(
        (attempt) => attempt.cycle === payload.cycle,
      );
      if (existing?.cycleReceipt) {
        if (
          existing.fastValidation?.id !== payload.validationReceiptId ||
          existing.fastValidation.fingerprint !== payload.validationFingerprint
        ) {
          return {
            outcome: "still_uncertain",
            message: "Stored repair-cycle evidence does not match the prepared action.",
          };
        }
        return {
          outcome: "committed",
          receipt: actionReceipt(
            action,
            context,
            "update",
            existing.cycleReceipt.id,
            existing.cycleReceipt.fingerprint,
            existing.cycleReceipt.recordedAt,
            `Repair cycle ${payload.cycle} was proven from its durable checkpoint.`,
            "reconciled",
          ),
          message: `Repair cycle ${payload.cycle} is durably committed.`,
        };
      }
      if (checkpoint.sequence === payload.checkpointSequence) {
        return {
          outcome: "not_applied",
          message: `Repair cycle ${payload.cycle} is absent at the exact prepared checkpoint sequence.`,
        };
      }
      return {
        outcome: "still_uncertain",
        message: "Repair checkpoint advanced without matching cycle evidence.",
      };
    } catch (error) {
      return {
        outcome: "still_uncertain",
        message: `Repair-cycle reconciliation failed closed: ${errorMessage(error)}`,
      };
    }
  }

  async prepareVerifiedCommit(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1> {
    let checkpoint: CodeRepairCheckpointV1 | null = null;
    try {
      const parsed = parseCommitArgs(args);
      assertContextScope(parsed.scope, context);
      const resolved = await this.resolveScope(parsed.scope, context);
      checkpoint = await this.requiredCheckpoint(parsed.scope);
      if (checkpoint.terminal) {
        return preparationFailure(
          "repair_checkpoint_terminal",
          "The code repair checkpoint is terminal and immutable.",
        );
      }
      if (
        parsed.checkpointSequence !== null &&
        checkpoint.sequence !== parsed.checkpointSequence
      ) {
        return preparationFailure(
          "repair_checkpoint_stale",
          `Checkpoint sequence is ${checkpoint.sequence}, not ${parsed.checkpointSequence}.`,
        );
      }
      if (!checkpoint.attempts.some((attempt) => attempt.fastValidation?.status === "passed")) {
        await this.persistBlocker(
          checkpoint,
          "targeted_validation_failed",
          "A verified passing fast cycle is required before commit preparation.",
          null,
          false,
        );
        return preparationFailure(
          "passing_fast_validation_missing",
          "A verified passing fast cycle is required before commit preparation.",
        );
      }
      const [targeted, full] = await Promise.all([
        parsed.targetedValidationReceiptId === null
          ? this.latestValidation(parsed.scope, "targeted")
          : this.requiredValidation(
              parsed.scope,
              parsed.targetedValidationReceiptId,
              "targeted",
            ),
        parsed.fullValidationReceiptId === null
          ? this.latestValidation(parsed.scope, "full")
          : this.requiredValidation(
              parsed.scope,
              parsed.fullValidationReceiptId,
              "full",
            ),
      ]);
      assertCommitValidationPair(targeted, full);
      const proof = await this.readCommitProof(resolved, parsed.scope, context);
      const proofManifest = await this.dependencies.workspaceManager.loadManifest(
        parsed.scope.workspaceId,
      );
      assertCommitValidationBindings(
        targeted,
        full,
        proofManifest,
        resolved.profile.key,
        parsed.scope,
        proof.diff,
      );
      if (
        parsed.diffFingerprint !== null &&
        proof.diff.fingerprint !== parsed.diffFingerprint
      ) {
        await this.persistBlocker(
          checkpoint,
          "diff_readback_invalid",
          "The caller-provided diff fingerprint is stale.",
          proof.diff.fingerprint,
          false,
        );
        return preparationFailure(
          "diff_fingerprint_stale",
          "The live diff no longer matches the requested fingerprint.",
        );
      }
      const classification = classifyDiff(resolved.profile, proof.diff.files);
      if (classification.level === "blocked") {
        await this.persistBlocker(
          checkpoint,
          "diff_readback_invalid",
          `Repository controls block these paths: ${classification.blockedPaths.join(", ")}.`,
          classification.exactDiffFingerprint,
          false,
        );
        return preparationFailure(
          "protected_control_blocked",
          "The diff touches blocked Git control paths.",
        );
      }
      const requiredConfirmations: 1 | 2 =
        classification.level === "double_exact" ? 2 : 1;
      const artifactFingerprint = await sha256Fingerprint(proof.artifacts);
      const payload: CommitActionPayloadV1 = {
        kind: "verified_local_commit_v1",
        scope: parsed.scope,
        checkpointSequence: checkpoint.sequence,
        profileKey: resolved.profile.key,
        diffFingerprint: proof.diff.fingerprint,
        artifactFingerprint,
        targetedValidationReceiptId: targeted.id,
        targetedValidationFingerprint: targeted.fingerprint,
        fullValidationReceiptId: full.id,
        fullValidationFingerprint: full.fingerprint,
        protectedClassificationFingerprint: classification.exactDiffFingerprint,
        requiredConfirmations,
      };
      const warnings = classification.matchedControls.length > 0
        ? [
            `${classification.matchedControls.length} protected repository control(s) require ${requiredConfirmations === 2 ? "double-exact" : "exact"} approval.`,
          ]
        : [];
      return {
        ok: true,
        action: await this.preparedAction({
          toolName: CODE_COMMIT_VERIFIED_TOOL,
          scope: parsed.scope,
          context,
          normalizedArgs: payload as unknown as Record<string, JsonValueV1>,
          expectedTargetRevision: String(checkpoint.sequence),
          summary: `Commit ${proof.diff.changedPaths.length} verified file change(s) on ${resolved.request.worktree.branch}.`,
          warnings,
          requiredConfirmations,
          operation: "commit",
          repositoryProfileId: resolved.profile.key,
          outboundPayload: {
            diffPatch: proof.diff.patch,
            diffFingerprint: proof.diff.fingerprint,
            artifactFingerprint,
            changedPaths: proof.diff.changedPaths,
            protectedPaths: classification.matchedControls.map((entry) => entry.path),
          },
        }),
      };
    } catch (error) {
      if (checkpoint && isProofError(error)) {
        await this.persistBlocker(
          checkpoint,
          proofBlockerCode(error),
          errorMessage(error),
          null,
          false,
        ).catch(() => undefined);
      }
      return preparationFailure(errorCode(error), errorMessage(error));
    }
  }

  async executePreparedVerifiedCommit(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ domainReceipt: VerifiedLocalCommitReceiptV1; actionReceipt: ActionReceiptV1 }> {
    await validatePreparedAction(action, context, CODE_COMMIT_VERIFIED_TOOL);
    const payload = parseCommitPayload(action.normalizedArgs);
    if (action.requiredConfirmations !== payload.requiredConfirmations) {
      throw new CodeRepairToolRuntimeErrorV1(
        "commit_confirmation_drift",
        "Prepared confirmation count does not match the protected diff payload.",
      );
    }
    assertContextScope(payload.scope, context);
    const resolved = await this.resolveScope(payload.scope, context);
    if (resolved.profile.key !== payload.profileKey) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repository_profile_drift",
        "Repository profile binding changed after commit preparation.",
      );
    }
    let checkpoint = await this.requiredCheckpoint(payload.scope);
    if (checkpoint.verifiedCommitReceipt && checkpoint.terminal?.status === "complete") {
      const receipt = checkpoint.verifiedCommitReceipt;
      if (receipt.diffFingerprint !== payload.diffFingerprint) {
        throw new CodeRepairToolRuntimeErrorV1(
          "commit_reconciliation_mismatch",
          "Completed commit receipt does not match this prepared action.",
        );
      }
      return {
        domainReceipt: cloneJson(receipt),
        actionReceipt: actionReceipt(
          action,
          context,
          "commit",
          receipt.id,
          receipt.fingerprint,
          receipt.committedAt,
          "Verified local commit was already reconciled.",
          "reconciled",
        ),
      };
    }
    const retryingPreparedCommit =
      checkpoint.stage === "committing" &&
      checkpoint.sequence === payload.checkpointSequence + 1 &&
      checkpoint.finalDiff?.fingerprint === payload.diffFingerprint;
    if (
      checkpoint.sequence !== payload.checkpointSequence &&
      !retryingPreparedCommit
    ) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repair_checkpoint_stale",
        "The repair checkpoint changed after commit preparation.",
      );
    }
    let targeted: CodeValidationReceiptV1;
    let full: CodeValidationReceiptV1;
    try {
      if (retryingPreparedCommit) {
        if (
          !checkpoint.targetedValidation ||
          !checkpoint.fullValidation
        ) {
          throw new CodeRepairToolRuntimeErrorV1(
            "commit_intent_proof_missing",
            "Persisted committing intent lost its validation proof.",
          );
        }
        [targeted, full] = await Promise.all([
          validateValidationReceipt(
            checkpoint.targetedValidation,
            payload.targetedValidationReceiptId,
            "targeted",
          ),
          validateValidationReceipt(
            checkpoint.fullValidation,
            payload.fullValidationReceiptId,
            "full",
          ),
        ]);
      } else {
        [targeted, full] = await Promise.all([
          this.requiredValidation(
            payload.scope,
            payload.targetedValidationReceiptId,
            "targeted",
          ),
          this.requiredValidation(
            payload.scope,
            payload.fullValidationReceiptId,
            "full",
          ),
        ]);
      }
      assertCommitValidationPair(targeted, full);
    } catch (error) {
      await this.persistBlocker(
        checkpoint,
        proofBlockerCode(error),
        errorMessage(error),
        null,
        false,
      );
      throw error;
    }
    if (
      targeted.fingerprint !== payload.targetedValidationFingerprint ||
      full.fingerprint !== payload.fullValidationFingerprint
    ) {
      await this.persistBlocker(
        checkpoint,
        "full_validation_failed",
        "Validation proof changed after commit preparation.",
        null,
        false,
      );
      throw new CodeRepairToolRuntimeErrorV1(
        "validation_proof_stale",
        "Validation proof changed after commit preparation.",
      );
    }
    let proof: { diff: CodeDiffReceiptV1; artifacts: ArtifactHashReadbackV1[] };
    try {
      if (retryingPreparedCommit) {
        if (!checkpoint.finalDiff || !checkpoint.artifactReadback) {
          throw new CodeRepairToolRuntimeErrorV1(
            "commit_intent_proof_missing",
            "Persisted committing intent lost its exact diff or artifact readback.",
          );
        }
        proof = {
          diff: cloneJson(checkpoint.finalDiff),
          artifacts: cloneJson(checkpoint.artifactReadback),
        };
      } else {
        proof = await this.readCommitProof(resolved, payload.scope, context);
      }
    } catch (error) {
      await this.persistBlocker(
        checkpoint,
        proofBlockerCode(error),
        errorMessage(error),
        null,
        false,
      );
      throw error;
    }
    const classification = classifyDiff(resolved.profile, proof.diff.files);
    const proofManifest = await this.dependencies.workspaceManager.loadManifest(
      payload.scope.workspaceId,
    );
    assertCommitValidationBindings(
      targeted,
      full,
      proofManifest,
      resolved.profile.key,
      payload.scope,
      proof.diff,
    );
    const requiredConfirmations: 1 | 2 =
      classification.level === "double_exact" ? 2 : 1;
    const artifactFingerprint = await sha256Fingerprint(proof.artifacts);
    if (
      proof.diff.fingerprint !== payload.diffFingerprint ||
      artifactFingerprint !== payload.artifactFingerprint ||
      classification.exactDiffFingerprint !==
        payload.protectedClassificationFingerprint ||
      requiredConfirmations !== payload.requiredConfirmations ||
      classification.level === "blocked"
    ) {
      await this.persistBlocker(
        checkpoint,
        "diff_readback_invalid",
        "Diff, artifacts, or protected-control classification changed after approval.",
        proof.diff.fingerprint,
        false,
      );
      throw new CodeRepairToolRuntimeErrorV1(
        "commit_proof_stale",
        "The exact approved commit proof is stale.",
      );
    }
    if (!retryingPreparedCommit) {
      const intent = cloneJson(checkpoint);
      intent.sequence += 1;
      intent.updatedAt = this.timestamp();
      intent.stage = "committing";
      intent.finalDiff = proof.diff;
      intent.artifactReadback = proof.artifacts;
      intent.targetedValidation = targeted;
      intent.fullValidation = full;
      intent.validationHistory.push(targeted, full);
      delete intent.blocker;
      await this.checkpoints.save(intent, checkpoint.sequence);
      checkpoint = intent;
    }
    const commit = await this.dependencies.commitGateway.commit({
      operationId: `${action.id}:commit`,
      request: resolved.request,
      diff: proof.diff,
      artifactHashes: proof.artifacts,
      targetedValidation: targeted,
      fullValidation: full,
    });
    const readback = await this.dependencies.commitGateway.readCommit({
      operationId: `${action.id}:readback`,
      request: resolved.request,
      commitSha: commit.commitSha,
    });
    const mismatch = compareCommitReadback(
      resolved.request,
      commit,
      readback,
      proof.diff,
      proof.artifacts,
    );
    if (mismatch) {
      await this.persistBlocker(
        checkpoint,
        "commit_readback_mismatch",
        mismatch,
        proof.diff.fingerprint,
        true,
      );
      throw new CodeRepairToolRuntimeErrorV1(
        "commit_readback_mismatch",
        mismatch,
      );
    }
    const domainReceipt = await createVerifiedCommitReceipt(
      resolved.request,
      commit,
      readback,
      proof.diff,
      proof.artifacts,
      targeted,
      full,
    );
    const complete = cloneJson(checkpoint);
    complete.sequence += 1;
    complete.updatedAt = this.timestamp();
    complete.stage = "complete";
    complete.commit = commit;
    complete.commitReadback = readback;
    complete.verifiedCommitReceipt = domainReceipt;
    complete.terminal = {
      status: "complete",
      publicationEligible: true,
      completedAt: domainReceipt.committedAt,
    };
    delete complete.blocker;
    await this.checkpoints.save(complete, checkpoint.sequence);
    return {
      domainReceipt,
      actionReceipt: actionReceipt(
        action,
        context,
        "commit",
        domainReceipt.id,
        domainReceipt.fingerprint,
        domainReceipt.committedAt,
        `Created and read back verified local commit ${domainReceipt.commitSha}.`,
      ),
    };
  }

  async reconcileVerifiedCommit(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<ActionReconciliationResultV1> {
    try {
      await validatePreparedActionIntegrity(action, CODE_COMMIT_VERIFIED_TOOL);
      const payload = parseCommitPayload(action.normalizedArgs);
      assertContextScope(payload.scope, context);
      const resolved = await this.resolveScope(payload.scope, context);
      let checkpoint = await this.requiredCheckpoint(payload.scope);
      if (checkpoint.verifiedCommitReceipt && checkpoint.terminal?.status === "complete") {
        const receipt = checkpoint.verifiedCommitReceipt;
        if (receipt.diffFingerprint !== payload.diffFingerprint) {
          return {
            outcome: "still_uncertain",
            message: "Completed commit receipt belongs to different prepared evidence.",
          };
        }
        return {
          outcome: "committed",
          receipt: actionReceipt(
            action,
            context,
            "commit",
            receipt.id,
            receipt.fingerprint,
            receipt.committedAt,
            `Verified commit ${receipt.commitSha} was proven from the durable checkpoint.`,
            "reconciled",
          ),
          message: `Verified local commit ${receipt.commitSha} is durably committed.`,
        };
      }
      if (
        checkpoint.sequence === payload.checkpointSequence &&
        checkpoint.stage !== "committing"
      ) {
        return {
          outcome: "not_applied",
          message: "No committing intent was journaled for this exact prepared action.",
        };
      }
      if (
        checkpoint.stage !== "committing" ||
        checkpoint.sequence !== payload.checkpointSequence + 1 ||
        checkpoint.finalDiff?.fingerprint !== payload.diffFingerprint ||
        !checkpoint.artifactReadback ||
        !checkpoint.targetedValidation ||
        !checkpoint.fullValidation
      ) {
        return {
          outcome: "still_uncertain",
          message: "Durable committing intent is missing or does not match the prepared proof.",
        };
      }
      if (!this.dependencies.commitGateway.reconcilePreparedCommit) {
        return {
          outcome: "still_uncertain",
          message: "The commit gateway has no read-only Git reconciliation capability.",
        };
      }
      const reconciled = await this.dependencies.commitGateway.reconcilePreparedCommit({
        operationId: `${action.id}:reconcile`,
        request: resolved.request,
        diff: checkpoint.finalDiff,
        artifactHashes: checkpoint.artifactReadback,
        targetedValidation: checkpoint.targetedValidation,
        fullValidation: checkpoint.fullValidation,
      });
      if (reconciled.outcome === "not_applied") {
        return {
          outcome: "not_applied",
          message: "Git HEAD remains at the trusted base; the prepared commit was not applied.",
        };
      }
      if (reconciled.outcome === "still_uncertain") return reconciled;
      const mismatch = compareCommitReadback(
        resolved.request,
        reconciled.commit,
        reconciled.readback,
        checkpoint.finalDiff,
        checkpoint.artifactReadback,
      );
      if (mismatch) {
        return {
          outcome: "still_uncertain",
          message: `Git object reconciliation mismatched prepared evidence: ${mismatch}`,
        };
      }
      const domainReceipt = await createVerifiedCommitReceipt(
        resolved.request,
        reconciled.commit,
        reconciled.readback,
        checkpoint.finalDiff,
        checkpoint.artifactReadback,
        checkpoint.targetedValidation,
        checkpoint.fullValidation,
      );
      const complete = cloneJson(checkpoint);
      complete.sequence += 1;
      complete.updatedAt = this.timestamp();
      complete.stage = "complete";
      complete.commit = reconciled.commit;
      complete.commitReadback = reconciled.readback;
      complete.verifiedCommitReceipt = domainReceipt;
      complete.terminal = {
        status: "complete",
        publicationEligible: true,
        completedAt: domainReceipt.committedAt,
      };
      delete complete.blocker;
      try {
        await this.checkpoints.save(complete, checkpoint.sequence);
      } catch {
        checkpoint = await this.requiredCheckpoint(payload.scope);
        if (
          checkpoint.verifiedCommitReceipt?.fingerprint !== domainReceipt.fingerprint ||
          checkpoint.terminal?.status !== "complete"
        ) {
          return {
            outcome: "still_uncertain",
            message: "Commit was proven, but checkpoint compare-and-swap readback conflicted.",
          };
        }
      }
      return {
        outcome: "committed",
        receipt: actionReceipt(
          action,
          context,
          "commit",
          domainReceipt.id,
          domainReceipt.fingerprint,
          domainReceipt.committedAt,
          `Reconciled verified local commit ${domainReceipt.commitSha} from Git objects.`,
          "reconciled",
        ),
        message: `Verified local commit ${domainReceipt.commitSha} was reconciled without replay.`,
      };
    } catch (error) {
      return {
        outcome: "still_uncertain",
        message: `Verified-commit reconciliation failed closed: ${errorMessage(error)}`,
      };
    }
  }

  private async resolveScope(
    scope: CodeRepairScopeArgsV1,
    context: ScopedExtensionContextV1,
  ): Promise<ResolvedRepairScopeV1> {
    const status = await this.dependencies.workspaceManager.status(scope.workspaceId);
    const manifest = status.manifest;
    if (!status.rootReadable || manifest.status === "blocked" || manifest.status === "expired" || manifest.status === "closed") {
      throw new CodeRepairToolRuntimeErrorV1(
        "workspace_unavailable",
        `Workspace ${scope.workspaceId} is not an active readable workspace.`,
      );
    }
    if (
      manifest.kind !== "repository" ||
      !manifest.repositoryBinding ||
      !manifest.baseSha
    ) {
      throw new CodeRepairToolRuntimeErrorV1(
        "trusted_repository_required",
        "Code repair and verified commits require a trusted repository worktree workspace.",
      );
    }
    if (manifest.ownerRunId !== scope.runId) {
      throw new CodeRepairToolRuntimeErrorV1(
        "workspace_owner_mismatch",
        "Workspace is owned by a different mission.",
      );
    }
    const resolution = await this.dependencies.repositoryProfiles.resolve({
      profileKey: manifest.repositoryBinding.profileKey,
      workspaceId: scope.workspaceId,
      runId: scope.runId,
      requestId: scope.requestId,
      manifest,
    });
    if (!resolution) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repository_profile_missing",
        "The trusted RepositoryProfileV2 binding is unavailable.",
      );
    }
    const profile = parseRepositoryProfileV2(resolution.profile);
    if (
      profile.key !== manifest.repositoryBinding.profileKey ||
      !sameHostPath(profile.repositoryRoot, manifest.repositoryBinding.repositoryRoot)
    ) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repository_profile_binding_mismatch",
        "Repository profile does not match the trusted workspace binding.",
      );
    }
    if (manifest.repositoryBinding.branch === null) {
      throw new CodeRepairToolRuntimeErrorV1(
        "worktree_branch_readback_required",
        "Legacy repository workspace has no persisted fixed-argv branch readback; commit authority remains blocked.",
      );
    }
    const worktreeBranch = boundedString(
      resolution.worktreeBranch,
      "worktree branch",
      1,
      512,
    );
    if (worktreeBranch !== manifest.repositoryBinding.branch) {
      throw new CodeRepairToolRuntimeErrorV1(
        "worktree_branch_drift",
        "Resolved worktree branch does not match the persisted trusted workspace branch.",
      );
    }
    const expectedArtifacts = normalizeExpectedArtifacts(
      resolution.expectedArtifacts ?? [],
    );
    const originalPrompt = context.originalPrompt?.trim();
    const objective = originalPrompt
      ? boundedString(originalPrompt, "repair objective", 1, 20_000)
      : `Complete verified code repair ${scope.requestId}`;
    const commitMessage = boundedString(
      resolution.commitMessage ?? `Agent repair: ${scope.requestId}`,
      "commit message",
      1,
      4_000,
    );
    const request = normalizeCodeRepairRequestV1({
      id: scope.requestId,
      runId: scope.runId,
      objective,
      worktree: {
        id: scope.workspaceId,
        path: manifest.canonicalRoot,
        repositoryRoot: manifest.repositoryBinding.repositoryRoot,
        branch: worktreeBranch,
        baseSha: manifest.baseSha,
        profileId: profile.key,
      },
      commitMessage,
      maxCycles: 3,
      expectedArtifacts,
      protectedControlPaths: profile.protectedControls.map((control) => control.path),
    });
    return { manifest, profile, request };
  }

  private async loadOrCreateCheckpoint(
    scope: CodeRepairScopeArgsV1,
    request: NormalizedCodeRepairRequestV1,
    requestedSequence: number,
  ): Promise<CodeRepairCheckpointV1> {
    const id = checkpointId(scope);
    const existing = await this.checkpoints.load(id);
    if (existing) {
      assertCheckpointScope(existing, scope);
      const fingerprint = await sha256Fingerprint(request);
      if (existing.requestFingerprint !== fingerprint) {
        throw new CodeRepairToolRuntimeErrorV1(
          "repair_request_drift",
          "The durable repair request no longer matches the trusted workspace binding.",
        );
      }
      return existing;
    }
    if (requestedSequence !== 0) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repair_checkpoint_missing",
        "A new repair checkpoint must begin at sequence zero.",
      );
    }
    const timestamp = this.timestamp();
    const checkpoint: CodeRepairCheckpointV1 = {
      version: CODE_REPAIR_CHECKPOINT_VERSION,
      id,
      request,
      requestFingerprint: await sha256Fingerprint(request),
      sequence: 0,
      stage: "initialized",
      createdAt: timestamp,
      updatedAt: timestamp,
      attempts: [],
      failureHistory: [],
      validationHistory: [],
      approvalHistory: [],
    };
    await this.checkpoints.save(checkpoint, null);
    return checkpoint;
  }

  private async requiredCheckpoint(
    scope: CodeRepairScopeArgsV1,
  ): Promise<CodeRepairCheckpointV1> {
    const checkpoint = await this.checkpoints.load(checkpointId(scope));
    if (!checkpoint) {
      throw new CodeRepairToolRuntimeErrorV1(
        "repair_checkpoint_missing",
        "The durable code repair checkpoint is missing.",
      );
    }
    assertCheckpointScope(checkpoint, scope);
    return checkpoint;
  }

  private async requiredValidation(
    scope: CodeRepairScopeArgsV1,
    receiptId: string,
    kind: CodeValidationReceiptV1["kind"],
  ): Promise<CodeValidationReceiptV1> {
    const receipt = await this.dependencies.validations.readValidation({
      receiptId,
      runId: scope.runId,
      workspaceId: scope.workspaceId,
      requestId: scope.requestId,
    });
    if (!receipt) {
      throw new CodeRepairToolRuntimeErrorV1(
        "validation_receipt_missing",
        `Validation receipt ${receiptId} is unavailable for this exact scope.`,
      );
    }
    return validateValidationReceipt(receipt, receiptId, kind);
  }

  private async latestValidation(
    scope: CodeRepairScopeArgsV1,
    kind: CodeValidationReceiptV1["kind"],
  ): Promise<CodeValidationReceiptV1> {
    const receipt = await this.dependencies.validations.readLatestValidation?.({
      ...scope,
      kind,
    });
    if (!receipt) {
      throw new CodeRepairToolRuntimeErrorV1(
        "validation_receipt_missing",
        `No durable ${kind} validation receipt is available for this exact scope.`,
      );
    }
    return validateValidationReceipt(receipt, receipt.id, kind);
  }

  private async readCommitProof(
    resolved: ResolvedRepairScopeV1,
    _scope: CodeRepairScopeArgsV1,
    context: ScopedExtensionContextV1,
  ): Promise<{ diff: CodeDiffReceiptV1; artifacts: ArtifactHashReadbackV1[] }> {
    const operationId = context.operationId?.trim() ||
      `code-repair:${resolved.request.id}:proof`;
    const rawDiff = await this.dependencies.proofReader.readDiff({
      operationId,
      request: resolved.request,
    });
    const diff = await normalizeDiffReceipt(
      rawDiff,
      operationId,
      resolved.request.worktree.baseSha,
    );
    const expected = diff.files
      .filter((file) => file.afterSha256 !== null)
      .map((file) => ({ path: file.path, sha256: file.afterSha256! }));
    const artifacts = normalizeArtifactReadback(
      await this.dependencies.proofReader.readArtifactHashes({
        operationId: `${operationId}:artifacts`,
        request: resolved.request,
        expectedArtifacts: expected,
      }),
      expected,
    );
    return { diff, artifacts };
  }

  private async recordUnchangedFailure(
    checkpoint: CodeRepairCheckpointV1,
    cycle: number,
    validation: CodeValidationReceiptV1,
  ): Promise<void> {
    const recordedAt = this.timestamp();
    const receipt = await createCycleReceipt(
      {
        runId: checkpoint.request.runId,
        workspaceId: checkpoint.request.worktree.id,
        requestId: checkpoint.request.id,
      },
      cycle,
      "blocked",
      validation,
      recordedAt,
    );
    const next = cloneJson(checkpoint);
    next.sequence += 1;
    next.updatedAt = recordedAt;
    next.stage = "blocked";
    next.attempts.push({ cycle, fastValidation: validation, cycleReceipt: receipt });
    next.validationHistory.push(validation);
    if (validation.failureFingerprint) {
      next.failureHistory.push({
        cycle,
        fingerprint: validation.failureFingerprint,
        recordedAt,
      });
    }
    next.blocker = {
      code: "unchanged_failure",
      message: "The same fast-validation failure fingerprint survived a repair.",
      evidenceFingerprint: validation.failureFingerprint,
      blockedAt: recordedAt,
    };
    next.terminal = {
      status: "blocked",
      publicationEligible: false,
      completedAt: recordedAt,
    };
    await this.checkpoints.save(next, checkpoint.sequence);
  }

  private async persistBlocker(
    checkpoint: CodeRepairCheckpointV1,
    code: CodeRepairBlockerCodeV1,
    message: string,
    evidenceFingerprint: string | null,
    terminal: boolean,
  ): Promise<void> {
    if (checkpoint.terminal) return;
    const timestamp = this.timestamp();
    const next = cloneJson(checkpoint);
    next.sequence += 1;
    next.updatedAt = timestamp;
    next.stage = "blocked";
    next.blocker = {
      code,
      message: boundedString(message, "blocker message", 1, 20_000),
      evidenceFingerprint,
      blockedAt: timestamp,
    };
    if (terminal) {
      next.terminal = {
        status: "blocked",
        publicationEligible: false,
        completedAt: timestamp,
      };
    }
    await this.checkpoints.save(next, checkpoint.sequence);
  }

  private async preparedAction(input: {
    toolName: string;
    scope: CodeRepairScopeArgsV1;
    context: ScopedExtensionContextV1;
    normalizedArgs: Record<string, JsonValueV1>;
    expectedTargetRevision: string;
    summary: string;
    warnings: string[];
    requiredConfirmations: 1 | 2;
    operation: ResourceActionV1;
    repositoryProfileId: string;
    outboundPayload?: Record<string, JsonValueV1>;
  }): Promise<PreparedActionV1> {
    const preparedAt = this.now();
    const core = {
      version: 1 as const,
      id: `prepared:${input.toolName}:${input.scope.runId}:${input.scope.workspaceId}:${input.scope.requestId}:${input.expectedTargetRevision}`,
      runId: input.context.missionId?.trim() || input.scope.runId,
      toolCallId: input.context.operationId?.trim() ||
        `${input.toolName}:${input.scope.requestId}:prepare`,
      toolName: input.toolName,
      target: {
        system: input.operation === "commit" ? "git" as const : "workspace" as const,
        resourceType: input.operation === "commit"
          ? "verified_local_commit"
          : "code_repair_checkpoint",
        id: checkpointId(input.scope),
        workspaceId: input.scope.workspaceId,
        repositoryProfileId: input.repositoryProfileId,
        revision: input.expectedTargetRevision,
      },
      relatedResources: [
        {
          system: "workspace" as const,
          resourceType: "workspace",
          id: input.scope.workspaceId,
          workspaceId: input.scope.workspaceId,
        },
      ],
      normalizedArgs: input.normalizedArgs,
      preview: {
        summary: input.summary,
        destination: input.operation === "commit"
          ? `local worktree ${input.scope.workspaceId}`
          : checkpointId(input.scope),
        ...(input.outboundPayload
          ? { outboundPayload: input.outboundPayload }
          : {}),
        warnings: input.warnings,
        outboundBytes: input.outboundPayload
          ? Buffer.byteLength(JSON.stringify(input.outboundPayload), "utf8")
          : 0,
      },
      expectedTargetRevision: input.expectedTargetRevision,
      idempotencyKey: `${input.scope.runId}:${input.scope.workspaceId}:${input.scope.requestId}:${input.toolName}:${input.expectedTargetRevision}`,
      reconciliationKey: `${checkpointId(input.scope)}:${input.toolName}`,
      requiredConfirmations: input.requiredConfirmations,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + PREPARED_TTL_MS).toISOString(),
    };
    return { ...core, payloadFingerprint: await sha256Fingerprint(core) };
  }

  private timestamp(): string {
    const value = this.now().toISOString();
    if (!Number.isFinite(Date.parse(value))) {
      throw new CodeRepairToolRuntimeErrorV1(
        "clock_invalid",
        "Host clock did not produce a valid ISO timestamp.",
      );
    }
    return value;
  }
}

export class CodeRepairToolRuntimeErrorV1 extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodeRepairToolRuntimeErrorV1";
  }
}

function parseCycleArgs(args: Record<string, unknown>): {
  scope: CodeRepairScopeArgsV1;
  cycle: number | null;
  checkpointSequence: number | null;
  validationReceiptId: string | null;
  cycleFingerprint: string | null;
} {
  const optionalKeys = [
    "cycle", "checkpointSequence", "validationReceiptId", "cycleFingerprint",
  ].filter((key) => args[key] !== undefined);
  assertExactKeys(args, ["runId", "workspaceId", "requestId", ...optionalKeys]);
  return {
    scope: parseScope(args),
    cycle: args.cycle === undefined ? null : safeInteger(args.cycle, "cycle", 1, 3),
    checkpointSequence: args.checkpointSequence === undefined
      ? null
      : safeInteger(args.checkpointSequence, "checkpointSequence", 0, Number.MAX_SAFE_INTEGER),
    validationReceiptId: args.validationReceiptId === undefined
      ? null
      : identifier(args.validationReceiptId, "validationReceiptId"),
    cycleFingerprint: args.cycleFingerprint === undefined
      ? null
      : sha256(args.cycleFingerprint, "cycleFingerprint"),
  };
}

function parseCommitArgs(args: Record<string, unknown>): {
  scope: CodeRepairScopeArgsV1;
  checkpointSequence: number | null;
  diffFingerprint: string | null;
  targetedValidationReceiptId: string | null;
  fullValidationReceiptId: string | null;
} {
  const optionalKeys = [
    "checkpointSequence", "diffFingerprint",
    "targetedValidationReceiptId", "fullValidationReceiptId",
  ].filter((key) => args[key] !== undefined);
  assertExactKeys(args, ["runId", "workspaceId", "requestId", ...optionalKeys]);
  return {
    scope: parseScope(args),
    checkpointSequence: args.checkpointSequence === undefined
      ? null
      : safeInteger(args.checkpointSequence, "checkpointSequence", 0, Number.MAX_SAFE_INTEGER),
    diffFingerprint: args.diffFingerprint === undefined
      ? null
      : sha256(args.diffFingerprint, "diffFingerprint"),
    targetedValidationReceiptId: args.targetedValidationReceiptId === undefined
      ? null
      : identifier(args.targetedValidationReceiptId, "targetedValidationReceiptId"),
    fullValidationReceiptId: args.fullValidationReceiptId === undefined
      ? null
      : identifier(args.fullValidationReceiptId, "fullValidationReceiptId"),
  };
}

function parseCyclePayload(args: Record<string, JsonValueV1>): CycleActionPayloadV1 {
  assertExactKeys(args, [
    "kind",
    "scope",
    "checkpointSequence",
    "cycle",
    "validationReceiptId",
    "validationFingerprint",
    "cycleFingerprint",
    "outcome",
  ]);
  if (args.kind !== "code_repair_cycle_v1") throw new Error("Invalid cycle payload kind.");
  const scope = plainRecord(args.scope, "cycle scope");
  assertExactKeys(scope, ["runId", "workspaceId", "requestId"]);
  const outcome = args.outcome;
  if (outcome !== "passed" && outcome !== "repaired" && outcome !== "blocked") {
    throw new Error("Invalid cycle outcome.");
  }
  return {
    kind: "code_repair_cycle_v1",
    scope: parseScope(scope),
    checkpointSequence: safeInteger(
      args.checkpointSequence,
      "checkpointSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    cycle: safeInteger(args.cycle, "cycle", 1, 3),
    validationReceiptId: identifier(args.validationReceiptId, "validationReceiptId"),
    validationFingerprint: sha256(args.validationFingerprint, "validationFingerprint"),
    cycleFingerprint: sha256(args.cycleFingerprint, "cycleFingerprint"),
    outcome,
  };
}

function parseCommitPayload(args: Record<string, JsonValueV1>): CommitActionPayloadV1 {
  assertExactKeys(args, [
    "kind",
    "scope",
    "checkpointSequence",
    "profileKey",
    "diffFingerprint",
    "artifactFingerprint",
    "targetedValidationReceiptId",
    "targetedValidationFingerprint",
    "fullValidationReceiptId",
    "fullValidationFingerprint",
    "protectedClassificationFingerprint",
    "requiredConfirmations",
  ]);
  if (args.kind !== "verified_local_commit_v1") throw new Error("Invalid commit payload kind.");
  const scope = plainRecord(args.scope, "commit scope");
  assertExactKeys(scope, ["runId", "workspaceId", "requestId"]);
  return {
    kind: "verified_local_commit_v1",
    scope: parseScope(scope),
    checkpointSequence: safeInteger(
      args.checkpointSequence,
      "checkpointSequence",
      0,
      Number.MAX_SAFE_INTEGER,
    ),
    profileKey: identifier(args.profileKey, "profileKey"),
    diffFingerprint: sha256(args.diffFingerprint, "diffFingerprint"),
    artifactFingerprint: sha256(args.artifactFingerprint, "artifactFingerprint"),
    targetedValidationReceiptId: identifier(
      args.targetedValidationReceiptId,
      "targetedValidationReceiptId",
    ),
    targetedValidationFingerprint: sha256(
      args.targetedValidationFingerprint,
      "targetedValidationFingerprint",
    ),
    fullValidationReceiptId: identifier(
      args.fullValidationReceiptId,
      "fullValidationReceiptId",
    ),
    fullValidationFingerprint: sha256(
      args.fullValidationFingerprint,
      "fullValidationFingerprint",
    ),
    protectedClassificationFingerprint: sha256(
      args.protectedClassificationFingerprint,
      "protectedClassificationFingerprint",
    ),
    requiredConfirmations: safeInteger(
      args.requiredConfirmations,
      "requiredConfirmations",
      1,
      2,
    ) as 1 | 2,
  };
}

async function validatePreparedAction(
  action: PreparedActionV1,
  context: ScopedExtensionContextV1,
  toolName: string,
): Promise<void> {
  await validatePreparedActionIntegrity(action, toolName);
  if (
    Date.parse(action.expiresAt) <= context.now().getTime()
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "prepared_action_invalid",
      "Prepared repair action is invalid or expired.",
    );
  }
  if (
    !context.authorizedAction ||
    context.authorizedAction.preparedActionId !== action.id ||
    context.authorizedAction.payloadFingerprint !== action.payloadFingerprint
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "prepared_action_authorization_missing",
      "Prepared repair action lacks exact host authorization.",
    );
  }
}

async function validatePreparedActionIntegrity(
  action: PreparedActionV1,
  toolName: string,
): Promise<void> {
  if (
    action.version !== 1 ||
    action.toolName !== toolName ||
    !Number.isFinite(Date.parse(action.preparedAt)) ||
    !Number.isFinite(Date.parse(action.expiresAt))
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "prepared_action_invalid",
      "Prepared repair action has an invalid closed contract.",
    );
  }
  const { payloadFingerprint: _ignored, ...core } = action;
  if (await sha256Fingerprint(core) !== action.payloadFingerprint) {
    throw new CodeRepairToolRuntimeErrorV1(
      "prepared_action_fingerprint_mismatch",
      "Prepared repair action fingerprint changed.",
    );
  }
}

async function validateValidationReceipt(
  input: CodeValidationReceiptV1,
  expectedId: string,
  expectedKind: CodeValidationReceiptV1["kind"],
): Promise<CodeValidationReceiptV1> {
  const receipt = cloneJson(input);
  if (
    receipt.version !== CODE_REPAIR_RECEIPT_VERSION ||
    receipt.kindName !== "code_validation" ||
    receipt.id !== expectedId ||
    receipt.kind !== expectedKind ||
    !identifier(receipt.operationId, "validation operationId") ||
    !identifier(receipt.sandboxId, "validation sandboxId") ||
    typeof receipt.freshSandbox !== "boolean" ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    !Array.isArray(receipt.checks) ||
    receipt.checks.length < 1 ||
    receipt.checks.length > 50
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_receipt_invalid",
      `Validation receipt ${expectedId} is invalid.`,
    );
  }
  for (const check of receipt.checks) {
    boundedString(check.label, "validation label", 1, 512);
    if (!Number.isSafeInteger(check.exitCode)) throw new Error("Validation exit code is invalid.");
    boundedString(check.stdout, "validation stdout", 0, 32_000);
    boundedString(check.stderr, "validation stderr", 0, 32_000);
    safeInteger(check.durationMs, "validation duration", 0, 86_400_000);
  }
  const computedStatus = receipt.checks.every((check) => check.exitCode === 0)
    ? "passed"
    : "failed";
  if (receipt.status !== computedStatus) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_receipt_invalid",
      "Validation status does not match its check exit codes.",
    );
  }
  if (
    (receipt.status === "passed" && receipt.failureFingerprint !== null) ||
    (receipt.status === "failed" && !SHA256.test(receipt.failureFingerprint ?? ""))
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_receipt_invalid",
      "Validation failure fingerprint is inconsistent with status.",
    );
  }
  const evidence = {
    operationId: receipt.operationId,
    kind: receipt.kind,
    sandboxId: receipt.sandboxId,
    freshSandbox: receipt.freshSandbox,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    checks: receipt.checks,
    status: receipt.status,
    failureFingerprint: receipt.failureFingerprint,
    binding: normalizeValidationBinding(receipt.binding),
  };
  if (await sha256Fingerprint(evidence) !== receipt.fingerprint) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_receipt_invalid",
      `Validation receipt ${expectedId} failed fingerprint verification.`,
    );
  }
  return receipt;
}

function normalizeValidationBinding(
  input: CodeValidationReceiptV1["binding"],
): CodeValidationReceiptV1["binding"] {
  if (input === null) return null;
  const stagedFiles = normalizeBoundArtifacts(input.stagedFiles, "staged files");
  const importedArtifacts = normalizeBoundArtifacts(input.importedArtifacts, "imported artifacts");
  const workspaceChangedPaths = normalizePathSet(
    input.workspaceChangedPaths,
    "validation workspace changed paths",
  );
  return {
    requestId: identifier(input.requestId, "validation requestId"),
    workspaceId: identifier(input.workspaceId, "validation workspaceId"),
    profileKey: identifier(input.profileKey, "validation profileKey"),
    inputWorkspaceManifestFingerprint: sha256(
      input.inputWorkspaceManifestFingerprint,
      "validation input workspace fingerprint",
    ),
    validatedWorkspaceManifestFingerprint: sha256(
      input.validatedWorkspaceManifestFingerprint,
      "validation output workspace fingerprint",
    ),
    workspaceChangedPaths,
    stagingManifestFingerprint: sha256(
      input.stagingManifestFingerprint,
      "validation staging fingerprint",
    ),
    stagedFiles,
    importedArtifacts,
  };
}

function normalizeBoundArtifacts(
  input: Array<{ path: string; sha256: string; bytes: number }>,
  label: string,
): Array<{ path: string; sha256: string; bytes: number }> {
  if (!Array.isArray(input) || input.length > MAX_CHANGED_FILES) {
    throw new Error(`${label} exceed ${MAX_CHANGED_FILES} entries.`);
  }
  const values = input.map((entry) => ({
    path: assertSafeRepositoryRelativePath(entry.path),
    sha256: sha256(entry.sha256, `${label} sha256`),
    bytes: safeInteger(entry.bytes, `${label} bytes`, 0, MAX_ARTIFACT_BYTES),
  })).sort(comparePath);
  if (new Set(values.map((entry) => entry.path)).size !== values.length) {
    throw new Error(`${label} repeat a path.`);
  }
  return values;
}

function normalizePathSet(input: string[], label: string): string[] {
  if (!Array.isArray(input) || input.length > MAX_CHANGED_FILES) {
    throw new Error(`${label} exceed ${MAX_CHANGED_FILES} entries.`);
  }
  const values = input
    .map((entry) => assertSafeRepositoryRelativePath(entry))
    .sort();
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} repeat a path.`);
  }
  return values;
}

function assertValidationBoundToWorkspace(
  receipt: CodeValidationReceiptV1,
  manifest: WorkspaceManifestV2,
  profileKey: string,
  scope: CodeRepairScopeArgsV1,
): void {
  const binding = receipt.binding;
  if (
    !binding ||
    binding.requestId !== scope.requestId ||
    binding.workspaceId !== scope.workspaceId ||
    binding.profileKey !== profileKey ||
    binding.validatedWorkspaceManifestFingerprint !== manifest.hashes.indexFingerprint ||
    !sameStrings(binding.workspaceChangedPaths, manifest.budget.changedPaths)
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_workspace_drift",
      "Validation receipt is not bound to the current exact workspace hash index and request scope.",
    );
  }
}

function assertCommitValidationBindings(
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
  manifest: WorkspaceManifestV2,
  profileKey: string,
  scope: CodeRepairScopeArgsV1,
  diff: CodeDiffReceiptV1,
): void {
  for (const receipt of [targeted, full]) {
    assertValidationBoundToWorkspace(receipt, manifest, profileKey, scope);
    const binding = receipt.binding!;
    const covered = new Map(
      [...binding.stagedFiles, ...binding.importedArtifacts]
        .map((entry) => [entry.path, entry.sha256]),
    );
    for (const file of diff.files) {
      if (!binding.workspaceChangedPaths.includes(file.path)) {
        throw new CodeRepairToolRuntimeErrorV1(
          "validation_diff_not_covered",
          `Validation workspace binding does not include changed path ${file.path}.`,
        );
      }
      if (file.afterSha256 !== null && covered.get(file.path) !== file.afterSha256) {
        throw new CodeRepairToolRuntimeErrorV1(
          "validation_diff_not_covered",
          `Validation staging/artifact proof does not cover final bytes for ${file.path}.`,
        );
      }
    }
  }
  if (targeted.binding!.stagingManifestFingerprint !== full.binding!.stagingManifestFingerprint) {
    throw new CodeRepairToolRuntimeErrorV1(
      "validation_staging_mismatch",
      "Targeted and full validation were not run against the same staged file manifest.",
    );
  }
}

function assertCommitValidationPair(
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
): void {
  if (targeted.status !== "passed") {
    throw new CodeRepairToolRuntimeErrorV1(
      "targeted_validation_failed",
      "Targeted sandbox validation is not green.",
    );
  }
  if (full.status !== "passed") {
    throw new CodeRepairToolRuntimeErrorV1(
      "full_validation_failed",
      "Full sandbox validation is not green.",
    );
  }
  if (!full.freshSandbox) {
    throw new CodeRepairToolRuntimeErrorV1(
      "full_validation_not_fresh",
      "Full validation must run in a fresh sandbox.",
    );
  }
  if (targeted.sandboxId === full.sandboxId) {
    throw new CodeRepairToolRuntimeErrorV1(
      "full_validation_not_fresh",
      "Targeted and full validation receipts must use distinct sandboxes.",
    );
  }
  if (Date.parse(full.completedAt) < Date.parse(targeted.completedAt)) {
    throw new CodeRepairToolRuntimeErrorV1(
      "full_validation_not_fresh",
      "Full validation must complete after targeted validation.",
    );
  }
}

async function normalizeDiffReceipt(
  input: CodeDiffReadbackV1,
  expectedOperationId: string,
  expectedBaseSha: string,
): Promise<CodeDiffReceiptV1> {
  if (input.operationId !== expectedOperationId || input.baseSha !== expectedBaseSha) {
    throw new CodeRepairToolRuntimeErrorV1(
      "diff_readback_invalid",
      "Diff readback does not match the requested operation or trusted base SHA.",
    );
  }
  if (
    typeof input.patch !== "string" ||
    input.patch.includes("\u0000") ||
    Buffer.byteLength(input.patch, "utf8") > MAX_PATCH_BYTES ||
    !Number.isFinite(Date.parse(input.readAt)) ||
    !Array.isArray(input.files) ||
    input.files.length < 1 ||
    input.files.length > MAX_CHANGED_FILES
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "diff_readback_invalid",
      "Diff readback has an invalid patch, timestamp, or file count.",
    );
  }
  const files = input.files.map(normalizeDiffFile).sort(comparePath);
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new CodeRepairToolRuntimeErrorV1(
      "diff_readback_invalid",
      "Diff readback repeats a changed path.",
    );
  }
  const changedPaths = files.map((file) => file.path);
  const fingerprint = await sha256Fingerprint({
    baseSha: input.baseSha,
    patch: input.patch,
    files,
  });
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kindName: "code_diff_readback",
    id: `${expectedOperationId}:diff`,
    operationId: expectedOperationId,
    baseSha: input.baseSha,
    patch: input.patch,
    files,
    changedPaths,
    readAt: input.readAt,
    fingerprint,
  };
}

function normalizeDiffFile(input: CodeDiffFileV1): CodeDiffFileV1 {
  const path = assertSafeRepositoryRelativePath(input.path);
  if (path !== input.path) throw new Error("Diff paths must already be canonical.");
  if (!["added", "modified", "deleted", "renamed"].includes(input.status)) {
    throw new Error("Diff status is invalid.");
  }
  const previousPath = input.previousPath === null
    ? null
    : assertSafeRepositoryRelativePath(input.previousPath);
  if ((input.status === "renamed") !== (previousPath !== null)) {
    throw new Error("Only renamed diff entries may include previousPath.");
  }
  const beforeSha256 = input.beforeSha256 === null
    ? null
    : sha256(input.beforeSha256, "beforeSha256");
  const afterSha256 = input.afterSha256 === null
    ? null
    : sha256(input.afterSha256, "afterSha256");
  if (
    (input.status === "added" && beforeSha256 !== null) ||
    (input.status === "deleted" && afterSha256 !== null) ||
    (input.status !== "added" && beforeSha256 === null) ||
    (input.status !== "deleted" && afterSha256 === null)
  ) {
    throw new Error("Diff hashes are inconsistent with status.");
  }
  return { path, status: input.status, previousPath, beforeSha256, afterSha256 };
}

function normalizeArtifactReadback(
  input: ArtifactHashReadbackV1[],
  expected: ExpectedArtifactV1[],
): ArtifactHashReadbackV1[] {
  if (!Array.isArray(input) || input.length !== expected.length || input.length > MAX_CHANGED_FILES) {
    throw new CodeRepairToolRuntimeErrorV1(
      "artifact_hash_mismatch",
      "Artifact readback must cover every non-deleted changed file exactly.",
    );
  }
  const expectedMap = new Map(expected.map((entry) => [entry.path, entry.sha256]));
  let totalBytes = 0;
  const artifacts = input.map((entry) => {
    const path = assertSafeRepositoryRelativePath(entry.path);
    const sha = sha256(entry.sha256, "artifact sha256");
    const bytes = safeInteger(entry.bytes, "artifact bytes", 0, MAX_ARTIFACT_BYTES);
    totalBytes += bytes;
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      throw new CodeRepairToolRuntimeErrorV1(
        "artifact_hash_mismatch",
        "Artifact readback exceeds the 10 MiB mission boundary.",
      );
    }
    if (expectedMap.get(path) !== sha) {
      throw new CodeRepairToolRuntimeErrorV1(
        "artifact_hash_mismatch",
        `Artifact hash readback changed for ${path}.`,
      );
    }
    return { path, sha256: sha, bytes };
  }).sort(comparePath);
  if (new Set(artifacts.map((entry) => entry.path)).size !== artifacts.length) {
    throw new Error("Artifact readback repeats a path.");
  }
  return artifacts;
}

function classifyDiff(
  profile: RepositoryProfileV2,
  files: CodeDiffFileV1[],
): ProtectedControlClassificationV2 {
  const changes: RepositoryFileChangeV2[] = [];
  for (const file of files) {
    if (file.status === "renamed" && file.previousPath) {
      changes.push({
        path: file.previousPath,
        beforeSha256: file.beforeSha256,
        afterSha256: null,
      });
      changes.push({
        path: file.path,
        beforeSha256: null,
        afterSha256: file.afterSha256,
      });
    } else {
      changes.push({
        path: file.path,
        beforeSha256: file.beforeSha256,
        afterSha256: file.afterSha256,
      });
    }
  }
  if (changes.length > MAX_CHANGED_FILES) {
    throw new CodeRepairToolRuntimeErrorV1(
      "diff_readback_invalid",
      "Protected-control classification exceeds 100 involved paths.",
    );
  }
  return classifyProtectedControlChangesV2(profile, changes);
}

async function createCycleReceipt(
  scope: CodeRepairScopeArgsV1,
  cycle: number,
  outcome: CodeRepairCycleReceiptV1["outcome"],
  validation: CodeValidationReceiptV1,
  recordedAt: string,
): Promise<CodeRepairCycleReceiptV1> {
  const evidence = {
    requestId: scope.requestId,
    runId: scope.runId,
    workspaceId: scope.workspaceId,
    cycle,
    outcome,
    validationReceiptId: validation.id,
    validationFingerprint: validation.fingerprint,
    diagnosisOperationId: null,
    repairOperationId: null,
    recordedAt,
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kind: "code_repair_cycle",
    id: `code-repair:${scope.requestId}:cycle-${cycle}`,
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

async function createVerifiedCommitReceipt(
  request: NormalizedCodeRepairRequestV1,
  commit: CodeCommitResultV1,
  readback: CodeCommitReadbackV1,
  diff: CodeDiffReceiptV1,
  artifacts: ArtifactHashReadbackV1[],
  targeted: CodeValidationReceiptV1,
  full: CodeValidationReceiptV1,
): Promise<VerifiedLocalCommitReceiptV1> {
  const evidence = {
    requestId: request.id,
    runId: request.runId,
    worktreeId: request.worktree.id,
    workspaceId: request.worktree.id,
    branch: request.worktree.branch,
    baseSha: request.worktree.baseSha,
    commitSha: commit.commitSha,
    parentSha: readback.parentSha,
    treeSha: readback.treeSha,
    diffFingerprint: diff.fingerprint,
    changedPaths: diff.changedPaths,
    artifactHashes: artifacts,
    changedArtifacts: diff.files.map((file) => ({
      path: file.path,
      sha256: file.afterSha256,
    })),
    targetedValidationReceiptId: targeted.id,
    fullValidationReceiptId: full.id,
    targetedValidationFingerprint: targeted.fingerprint,
    fullValidationFingerprint: full.fingerprint,
    committedAt: commit.committedAt,
  };
  return {
    version: CODE_REPAIR_RECEIPT_VERSION,
    kind: "verified_local_commit",
    id: `code-repair:${request.id}:verified-commit`,
    status: "verified",
    ...evidence,
    fingerprint: await sha256Fingerprint(evidence),
  };
}

function compareCommitReadback(
  request: NormalizedCodeRepairRequestV1,
  commit: CodeCommitResultV1,
  readback: CodeCommitReadbackV1,
  diff: CodeDiffReceiptV1,
  artifacts: ArtifactHashReadbackV1[],
): string | null {
  if (!GIT_SHA.test(commit.commitSha) || readback.commitSha !== commit.commitSha) {
    return "Commit SHA readback does not match the created commit.";
  }
  if (readback.parentSha !== request.worktree.baseSha) {
    return "Commit parent does not match the trusted base SHA.";
  }
  if (!GIT_SHA.test(readback.treeSha)) return "Commit tree SHA is invalid.";
  if (readback.diffFingerprint !== diff.fingerprint) {
    return "Commit diff fingerprint does not match the approved diff.";
  }
  if (!sameStrings(readback.changedPaths, diff.changedPaths)) {
    return "Commit changed paths do not match the approved diff.";
  }
  const expected = artifacts.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  const actual = readback.artifactHashes.map(({ path, sha256, bytes }) => ({ path, sha256, bytes }));
  if (JSON.stringify(expected.sort(comparePath)) !== JSON.stringify(actual.sort(comparePath))) {
    return "Commit artifact hashes do not match working-tree readback.";
  }
  return null;
}

function actionReceipt(
  action: PreparedActionV1,
  context: ScopedExtensionContextV1,
  operation: ResourceActionV1,
  receiptId: string,
  observedFingerprint: string,
  committedAt: string,
  message: string,
  commitKind: ActionReceiptV1["commitKind"] = "committed",
): ActionReceiptV1 {
  if (!context.authorizedAction) throw new Error("Authorized action context is missing.");
  return {
    version: 1,
    id: receiptId,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation,
    resource: cloneJson(action.target),
    relatedResources: cloneJson(action.relatedResources),
    message,
    payloadFingerprint: action.payloadFingerprint,
    grantId: context.authorizedAction.grantId,
    idempotencyKey: action.idempotencyKey,
    startedAt: action.preparedAt,
    committedAt,
    commitKind,
    readback: {
      status: "verified",
      checkedAt: committedAt,
      observedRevision: action.expectedTargetRevision,
      observedFingerprint,
    },
    effects: { affectedCount: 1 },
  };
}

function statusFromCheckpoint(
  checkpoint: CodeRepairCheckpointV1,
  scope: CodeRepairScopeArgsV1,
): CodeRepairStatusV1 {
  return {
    kind: "code_repair_status",
    ...scope,
    checkpointId: checkpoint.id,
    sequence: checkpoint.sequence,
    stage: checkpoint.stage,
    attempts: checkpoint.attempts.map((attempt) => ({
      cycle: attempt.cycle,
      validationReceiptId: attempt.fastValidation?.id ?? null,
      cycleReceiptId: attempt.cycleReceipt?.id ?? null,
      outcome: attempt.cycleReceipt?.outcome ?? null,
    })),
    targetedValidationReceiptId: checkpoint.targetedValidation?.id ?? null,
    fullValidationReceiptId: checkpoint.fullValidation?.id ?? null,
    terminalStatus: checkpoint.terminal?.status ?? null,
    publicationEligible: checkpoint.terminal?.publicationEligible ?? false,
    blockerCode: checkpoint.blocker?.code ?? null,
  };
}

function assertCheckpointScope(
  checkpoint: CodeRepairCheckpointV1,
  scope: CodeRepairScopeArgsV1,
): void {
  if (
    checkpoint.version !== CODE_REPAIR_CHECKPOINT_VERSION ||
    checkpoint.id !== checkpointId(scope) ||
    checkpoint.request.runId !== scope.runId ||
    checkpoint.request.id !== scope.requestId ||
    checkpoint.request.worktree.id !== scope.workspaceId
  ) {
    throw new CodeRepairToolRuntimeErrorV1(
      "repair_checkpoint_scope_mismatch",
      "Repair checkpoint does not match the exact mission, workspace, and request scope.",
    );
  }
}

function assertContextScope(
  scope: CodeRepairScopeArgsV1,
  context: ScopedExtensionContextV1,
): void {
  const durableMissionId = context.rootMissionId ?? context.missionId;
  if (durableMissionId && durableMissionId !== scope.runId) {
    throw new CodeRepairToolRuntimeErrorV1(
      "mission_scope_mismatch",
      "Extension mission context does not match repair runId.",
    );
  }
}

function checkpointId(scope: CodeRepairScopeArgsV1): string {
  return codeRepairCheckpointIdV1({
    id: scope.requestId,
    runId: scope.runId,
    worktree: { id: scope.workspaceId } as NormalizedCodeRepairRequestV1["worktree"],
  });
}

function parseScope(input: Record<string, unknown>): CodeRepairScopeArgsV1 {
  return {
    runId: identifier(input.runId, "runId"),
    workspaceId: identifier(input.workspaceId, "workspaceId"),
    requestId: identifier(input.requestId, "requestId"),
  };
}

function normalizeExpectedArtifacts(input: ExpectedArtifactV1[]): ExpectedArtifactV1[] {
  if (!Array.isArray(input) || input.length > MAX_CHANGED_FILES) {
    throw new Error("Expected artifact list exceeds 100 entries.");
  }
  const result = input.map((entry) => ({
    path: assertSafeRepositoryRelativePath(entry.path),
    sha256: sha256(entry.sha256, "expected artifact sha256"),
  })).sort(comparePath);
  if (new Set(result.map((entry) => entry.path)).size !== result.length) {
    throw new Error("Expected artifact list repeats a path.");
  }
  return result;
}

function preparationFailure(code: string, message: string): PreparedActionResultV1 {
  return { ok: false, error: { code, message } };
}

function proofBlockerCode(error: unknown): CodeRepairBlockerCodeV1 {
  const code = errorCode(error);
  if (code === "full_validation_not_fresh") return "full_validation_not_fresh";
  if (code === "full_validation_failed") return "full_validation_failed";
  if (code === "targeted_validation_failed") return "targeted_validation_failed";
  if (code.includes("artifact")) return "artifact_hash_mismatch";
  return "diff_readback_invalid";
}

function isProofError(error: unknown): boolean {
  return error instanceof CodeRepairToolRuntimeErrorV1 &&
    /validation|diff|artifact|proof/u.test(error.code);
}

function errorCode(error: unknown): string {
  return error instanceof CodeRepairToolRuntimeErrorV1
    ? error.code
    : "code_repair_prepare_rejected";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) {
    throw new CodeRepairToolRuntimeErrorV1(
      "identifier_invalid",
      `${label} must be a bounded durable identifier.`,
    );
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new CodeRepairToolRuntimeErrorV1(
      "fingerprint_invalid",
      `${label} must be a sha256 fingerprint.`,
    );
  }
  return value;
}

function safeInteger(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value as number;
}

function boundedString(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string" || value.length < minimum || value.length > maximum) {
    throw new Error(`${label} must contain ${minimum}-${maximum} characters.`);
  }
  if (value.includes("\u0000")) throw new Error(`${label} contains NUL.`);
  return value;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  const actual = Object.keys(value).sort();
  const expected = [...allowed].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`Unexpected or missing fields: ${actual.join(", ")}.`);
  }
}

function comparePath<T extends { path: string }>(left: T, right: T): number {
  return left.path.localeCompare(right.path);
}

function sameStrings(left: string[], right: string[]): boolean {
  return JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());
}

function sameHostPath(left: string, right: string): boolean {
  const normalized = (value: string) =>
    value.replace(/\\/gu, "/").replace(/\/+$/u, "").toLowerCase();
  return normalized(left) === normalized(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
