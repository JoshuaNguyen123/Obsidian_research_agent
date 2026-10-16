import { createHash } from "node:crypto";

import { isAgentGitCommitIdentityV1 } from "../../../packages/core-api/src/agentGitCommitIdentityV1";
import type { RepositoryProfileV2 } from "../repositories/RepositoryProfileV2";
import {
  WORKSPACE_MAX_TEXT_BYTES_V2,
  WorkspaceManagerErrorV2,
  createVerifiedWorkspaceBaseReadbackV2,
  type WorkspaceBaseAdvanceReceiptV2,
  type WorkspaceManagerV2,
  type WorkspaceManifestV2,
} from "../workspaces";
import {
  CodeRepairCoordinatorV1,
  codeRepairCheckpointIdV1,
  normalizeCodeRepairRequestV1,
  normalizePersonCommitIdentityV1,
  parseCodeRepairCheckpointV1,
} from "./codeRepairCoordinator";
import {
  FixedArgvArtifactHashReaderV1,
  FixedArgvRepairProofAdapterV1,
  createFixedArgvVerifiedCommitGatewayV1,
  type FixedArgvGitBytesRunnerV1,
} from "./GitRepairProofAdaptersV1";
import {
  CallbackCodeRepairCheckpointStoreV1,
  type CallbackCheckpointPersistenceV1,
} from "./productionAdapters";
import type {
  CodeDiffFileV1,
  CodeRepairBlockerCodeV1,
  CodeRepairCheckpointV1,
  CodeRepairResultV1,
  CodeValidationExecutionV1,
  CodeValidationReceiptV1,
  NormalizedCodeRepairRequestV1,
  ProtectedDiffApprovalRequestV1,
  ValidationKindV1,
  VerifiedLocalCommitReceiptV1,
} from "./types";

/**
 * A person's verified commit (CODE-15, DEBT-125).
 *
 * The person's changes in a repository workspace are committed through the
 * same verified path a coding pass takes: a fast, a targeted and a fresh full
 * validation in the sandbox, the exact diff read back, the commit made by
 * fixed-argv Git with hooks off, and the commit object read back. What
 * differs is who it is by: author and committer are the person, the message
 * is theirs, and the request is the workspace owner's, so the proof stays
 * bound to the workspace. Nothing here runs a model or edits code except the
 * revert form, which writes back the files a verified commit changed, as
 * they were in its parent, and then commits that the same way.
 *
 * A person's commit is never a publication handoff: the agent's push path
 * publishes the agent's commits only.
 */

/** The lease a person's commit holds while it validates and commits. */
export const PERSON_COMMIT_LEASE_OWNER_V1 = "person:validate-and-commit" as const;

const LEASE_TTL_MS = 15 * 60_000;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/u;
const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_MESSAGE_CHARACTERS = 4_000;
const MAX_SUBJECT_CHARACTERS = 200;

export interface PersonCommitIdentityInputV1 {
  name: string;
  email: string;
}

export interface PersonWorkspaceCommitInputV1 {
  workspaceId: string;
  /**
   * The host's id for this attempt. The same id resumes an attempt that
   * stopped part-way and answers a finished one again; a new attempt takes a
   * new id.
   */
  operationId: string;
  message: string;
  person: PersonCommitIdentityInputV1;
  /**
   * Asked for each approval the verified path needs: the commit itself
   * (`purpose: "verified_commit"`) and, when the diff touches a repository's
   * protected controls, one or two exact confirmations (`"protected_diff"`).
   * True approves. Without it the commit is approved, because the call is the
   * person's own request, and a protected diff is denied.
   */
  approve?(request: ProtectedDiffApprovalRequestV1): Promise<boolean>;
  signal?: AbortSignal;
}

export interface PersonWorkspaceRevertInputV1
  extends Omit<PersonWorkspaceCommitInputV1, "message"> {
  /** A verified commit in this workspace, which must be its newest. */
  commitSha: string;
  /** Defaults to `Revert "<subject>"` and `This reverts commit <sha>.` */
  message?: string;
}

export type PersonCommitRefusalCodeV1 =
  | "commit_unavailable"
  | "invalid_input"
  | "person_identity_invalid"
  | "person_identity_is_agent"
  | "commit_message_invalid"
  | "workspace_not_found"
  | "workspace_unavailable"
  | "workspace_not_repository"
  | "workspace_attached_to_run"
  | "workspace_in_use"
  | "repository_profile_unavailable"
  | "sandbox_unavailable"
  | "nothing_to_commit"
  | "operation_mismatch"
  | "revert_commit_not_verified"
  | "revert_not_latest"
  | "revert_workspace_dirty"
  | "revert_conflict"
  | "revert_binary_unsupported"
  | "revert_file_too_large";

export type PersonCommitBlockCodeV1 =
  | "fast_validation_failed"
  | "targeted_validation_failed"
  | "full_validation_failed"
  | "full_validation_not_fresh"
  | "approval_denied"
  | "diff_changed"
  | "commit_readback_mismatch";

export type PersonWorkspaceBaseV1 =
  | { advanced: true; receipt: WorkspaceBaseAdvanceReceiptV2 }
  | { advanced: false; reason: string };

export interface PersonWorkspaceRevertedV1 {
  commitSha: string;
  /** The paths written back to the commit's parent, in order. */
  paths: string[];
}

export type PersonWorkspaceCommitResultV1 =
  | {
      status: "committed";
      workspaceId: string;
      checkpointId: string;
      commitSha: string;
      receipt: VerifiedLocalCommitReceiptV1;
      base: PersonWorkspaceBaseV1;
      reverted?: PersonWorkspaceRevertedV1;
    }
  | {
      status: "blocked";
      workspaceId: string;
      checkpointId: string;
      code: PersonCommitBlockCodeV1;
      message: string;
      /** The validation that failed, when one did. */
      validation: CodeValidationReceiptV1 | null;
      /** A revert that was written but not committed stays in the workspace. */
      reverted?: PersonWorkspaceRevertedV1;
    }
  | {
      /** Something stopped it part-way; the same operation id resumes it. */
      status: "failed";
      workspaceId: string;
      checkpointId: string;
      code: string;
      message: string;
      reverted?: PersonWorkspaceRevertedV1;
    }
  | {
      status: "refused";
      workspaceId: string;
      code: PersonCommitRefusalCodeV1;
      message: string;
    };

export interface PersonWorkspaceCommitDependenciesV1 {
  workspaceManager: WorkspaceManagerV2;
  getRepositoryProfile(profileKey: string): Promise<RepositoryProfileV2 | null>;
  /** The same durable checkpoint namespace a pass's commit uses. */
  checkpointPersistence: CallbackCheckpointPersistenceV1;
  /**
   * One validation of the workspace as it stands, in the verified sandbox,
   * bound to the request: the production runtime prepares the profile's own
   * command for `kind`, runs it and captures its scoped receipt.
   */
  validate(input: {
    operationId: string;
    request: NormalizedCodeRepairRequestV1;
    kind: ValidationKindV1;
    signal?: AbortSignal;
  }): Promise<CodeValidationReceiptV1 | CodeValidationExecutionV1>;
  /** Whether a sandbox can validate now; asked before anything starts. */
  sandboxReady(signal?: AbortSignal): Promise<{ ready: true } | { ready: false; message: string }>;
  git: FixedArgvGitBytesRunnerV1;
  /** An empty host-controlled directory used as Git's hooks path. */
  disabledHooksPath: string;
  now?: () => Date;
}

class PersonCommitRefusalV1 extends Error {
  constructor(readonly code: PersonCommitRefusalCodeV1, message: string) {
    super(message);
    this.name = "PersonCommitRefusalV1";
  }
}

export class PersonWorkspaceCommitRuntimeV1 {
  private readonly now: () => Date;
  private readonly checkpoints: CallbackCodeRepairCheckpointStoreV1;

  constructor(private readonly dependencies: PersonWorkspaceCommitDependenciesV1) {
    this.now = dependencies.now ?? (() => new Date());
    this.checkpoints = new CallbackCodeRepairCheckpointStoreV1(dependencies.checkpointPersistence);
  }

  /** Validate and commit the person's changes in a repository workspace. */
  async commit(input: PersonWorkspaceCommitInputV1): Promise<PersonWorkspaceCommitResultV1> {
    const workspaceId = String(input?.workspaceId ?? "");
    try {
      const operationId = parseOperationId(input.operationId);
      const identity = personIdentity(input.person);
      const message = commitMessage(input.message);
      const requestId = `person-commit-${operationId}`;
      const { manifest, profile } = await this.readWorkspace(workspaceId);
      const resumed = await this.resumable(manifest, requestId, identity, message);
      if (!resumed && manifest.budget.changedPaths.length === 0) {
        throw new PersonCommitRefusalV1("nothing_to_commit", "There are no changes in this workspace to commit.");
      }
      return await this.withLease(manifest, async () => this.validateAndCommit({
        manifest,
        profile,
        request: resumed ?? this.request(manifest, profile, requestId, identity, message),
        approve: input.approve,
        signal: input.signal,
      }));
    } catch (error) {
      return refusedOrThrow(workspaceId, error);
    }
  }

  /**
   * Revert a verified commit as a new verified commit: the files it changed
   * are written back as they were in its parent, through the workspace
   * manager, and committed by the person on the same verified path. Only the
   * workspace's newest commit is reverted, on a workspace with nothing else
   * changed, so the revert is exact and needs no merge.
   */
  async revert(input: PersonWorkspaceRevertInputV1): Promise<PersonWorkspaceCommitResultV1> {
    const workspaceId = String(input?.workspaceId ?? "");
    try {
      const operationId = parseOperationId(input.operationId);
      const identity = personIdentity(input.person);
      const commitSha = String(input.commitSha ?? "").toLowerCase();
      if (!GIT_SHA.test(commitSha)) {
        throw new PersonCommitRefusalV1("invalid_input", "The commit to revert must be a full commit id.");
      }
      const requestId = `person-revert-${operationId}`;
      let { manifest, profile } = await this.readWorkspace(workspaceId);
      const reverted = await this.verifiedCommitIn(manifest.workspaceId, commitSha);
      if (!reverted) {
        throw new PersonCommitRefusalV1(
          "revert_commit_not_verified",
          `Commit ${commitSha.slice(0, 7)} is not a verified commit in this workspace.`,
        );
      }
      const message = input.message === undefined
        ? revertMessage(reverted.request.commitMessage, commitSha)
        : commitMessage(input.message);
      const resumed = await this.resumable(manifest, requestId, identity, message);
      if (resumed) {
        const paths = revertPaths(revertedFiles(reverted));
        return withReverted(
          await this.withLease(manifest, async () => this.validateAndCommit({
            manifest, profile, request: resumed, approve: input.approve, signal: input.signal,
          })),
          { commitSha, paths },
        );
      }
      manifest = await this.settleBaseAt(manifest, reverted.verifiedCommitReceipt!);
      if (manifest.baseSha !== commitSha) {
        throw new PersonCommitRefusalV1(
          "revert_not_latest",
          `Only this workspace's newest commit can be reverted; ${commitSha.slice(0, 7)} is not it.`,
        );
      }
      const files = revertedFiles(reverted);
      const paths = revertPaths(files);
      // Only the revert's own paths may already be changed: a revert that
      // stopped part-way is finished, other uncommitted work is left alone.
      if (manifest.budget.changedPaths.some((changed) => !paths.includes(changed))) {
        throw new PersonCommitRefusalV1(
          "revert_workspace_dirty",
          "This workspace has changes that are not committed. Commit or discard them, then revert.",
        );
      }
      const parentSha = reverted.verifiedCommitReceipt!.parentSha;
      const writes = await this.revertWrites(manifest, files, parentSha);
      return withReverted(
        await this.withLease(manifest, async (leaseId) => {
          for (const write of writes) await this.applyRevertWrite(manifest.workspaceId, leaseId, write);
          const written = await this.dependencies.workspaceManager.loadManifest(manifest.workspaceId);
          return this.validateAndCommit({
            manifest: written,
            profile,
            request: this.request(written, profile, requestId, identity, message),
            approve: input.approve,
            signal: input.signal,
          });
        }),
        { commitSha, paths },
      );
    } catch (error) {
      return refusedOrThrow(workspaceId, error);
    }
  }

  private async readWorkspace(workspaceIdInput: string): Promise<{
    manifest: WorkspaceManifestV2;
    profile: RepositoryProfileV2;
  }> {
    let status: Awaited<ReturnType<WorkspaceManagerV2["status"]>>;
    try {
      status = await this.dependencies.workspaceManager.status(workspaceIdInput);
    } catch (error) {
      if (error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_not_found") {
        throw new PersonCommitRefusalV1("workspace_not_found", "There is no such workspace.");
      }
      if (error instanceof WorkspaceManagerErrorV2 && error.code === "invalid_identifier") {
        throw new PersonCommitRefusalV1("invalid_input", "The workspace id is invalid.");
      }
      throw error;
    }
    const manifest = status.manifest;
    if (!status.rootReadable || ["expired", "closed", "blocked"].includes(manifest.status)) {
      throw new PersonCommitRefusalV1(
        "workspace_unavailable",
        status.rootReadable ? `This workspace is ${manifest.status}.` : "This workspace's folder cannot be read.",
      );
    }
    const binding = manifest.repositoryBinding;
    if (manifest.kind !== "repository" || !binding || !binding.branch || !manifest.baseSha) {
      throw new PersonCommitRefusalV1(
        "workspace_not_repository",
        "Only a repository workspace's changes can be committed.",
      );
    }
    if (manifest.attachedRunId !== undefined) {
      throw new PersonCommitRefusalV1(
        "workspace_attached_to_run",
        "The agent is working in this workspace. Commit once it has finished.",
      );
    }
    if (manifest.lease && manifest.lease.ownerId !== PERSON_COMMIT_LEASE_OWNER_V1) {
      throw new PersonCommitRefusalV1("workspace_in_use", "This workspace is in use. Try again when it is free.");
    }
    const profile = await this.dependencies.getRepositoryProfile(binding.profileKey);
    if (!profile || !sameHostPath(profile.repositoryRoot, binding.repositoryRoot)) {
      throw new PersonCommitRefusalV1(
        "repository_profile_unavailable",
        "This workspace's repository is not trusted any more, so its changes cannot be validated.",
      );
    }
    return { manifest, profile };
  }

  /**
   * The request of an attempt already begun under this id, when there is
   * one. Its workspace, person and message must be the ones asked for now.
   */
  private async resumable(
    manifest: WorkspaceManifestV2,
    requestId: string,
    identity: ReturnType<typeof normalizePersonCommitIdentityV1>,
    message: string,
  ): Promise<NormalizedCodeRepairRequestV1 | null> {
    const id = codeRepairCheckpointIdV1({
      id: requestId,
      runId: manifest.ownerRunId,
      worktree: { id: manifest.workspaceId } as NormalizedCodeRepairRequestV1["worktree"],
    });
    const existing = await this.checkpoints.load(id);
    if (!existing) return null;
    const request = existing.request;
    if (
      request.worktree.id !== manifest.workspaceId ||
      request.commitMessage !== message ||
      !request.commitIdentity ||
      request.commitIdentity.authorName !== identity.authorName ||
      request.commitIdentity.authorEmail !== identity.authorEmail
    ) {
      throw new PersonCommitRefusalV1(
        "operation_mismatch",
        "This operation id was used for a different commit. Use a new id.",
      );
    }
    return request;
  }

  private request(
    manifest: WorkspaceManifestV2,
    profile: RepositoryProfileV2,
    requestId: string,
    identity: ReturnType<typeof normalizePersonCommitIdentityV1>,
    message: string,
  ): NormalizedCodeRepairRequestV1 {
    const binding = manifest.repositoryBinding!;
    return normalizeCodeRepairRequestV1({
      id: requestId,
      runId: manifest.ownerRunId,
      objective: "Validate and commit the person's changes in this workspace.",
      worktree: {
        id: manifest.workspaceId,
        path: manifest.canonicalRoot,
        repositoryRoot: binding.repositoryRoot,
        branch: binding.branch!,
        baseSha: manifest.baseSha!,
        profileId: profile.key,
      },
      commitMessage: message,
      // The person's tree is the edit: no model diagnoses or repairs it.
      maxCycles: 1,
      expectedArtifacts: [],
      protectedControlPaths: profile.protectedControls.map((control) => control.path),
      commitIdentity: identity,
    });
  }

  private async validateAndCommit(input: {
    manifest: WorkspaceManifestV2;
    profile: RepositoryProfileV2;
    request: NormalizedCodeRepairRequestV1;
    approve?: PersonWorkspaceCommitInputV1["approve"];
    signal?: AbortSignal;
  }): Promise<PersonWorkspaceCommitResultV1> {
    const { request } = input;
    const checkpointId = codeRepairCheckpointIdV1(request);
    const existing = await this.checkpoints.load(checkpointId);
    let result: CodeRepairResultV1;
    if (existing?.terminal) {
      // A finished attempt answers from its durable proof, which the closed
      // parser verifies. Its commit is not read against the live workspace
      // again: once the base has moved, the workspace's changed paths no
      // longer describe it.
      const checkpoint = await parseCodeRepairCheckpointV1(existing);
      result = {
        status: checkpoint.terminal!.status,
        publicationEligible: checkpoint.terminal!.publicationEligible,
        checkpoint,
        ...(checkpoint.verifiedCommitReceipt ? { verifiedCommitReceipt: checkpoint.verifiedCommitReceipt } : {}),
        ...(checkpoint.blocker ? { blocker: checkpoint.blocker } : {}),
      };
    } else {
      const sandbox = await this.dependencies.sandboxReady(input.signal);
      if (!sandbox.ready) throw new PersonCommitRefusalV1("sandbox_unavailable", sandbox.message);
      const coordinator = await this.coordinator(input.profile, input.approve, input.signal);
      try {
        result = await coordinator.execute(request);
      } catch (error) {
        return {
          status: "failed",
          workspaceId: request.worktree.id,
          checkpointId,
          code: errorCode(error),
          message: `The commit stopped part-way: ${errorMessage(error)}`,
        };
      }
    }
    if (result.status === "complete" && result.verifiedCommitReceipt) {
      return {
        status: "committed",
        workspaceId: request.worktree.id,
        checkpointId,
        commitSha: result.verifiedCommitReceipt.commitSha,
        receipt: result.verifiedCommitReceipt,
        base: { advanced: false, reason: "pending" },
      };
    }
    const blocker = result.blocker;
    return {
      status: "blocked",
      workspaceId: request.worktree.id,
      checkpointId,
      code: blockCode(blocker?.code),
      message: blockMessage(blocker?.code, blocker?.message),
      validation: failedValidation(result.checkpoint, blocker?.code),
    };
  }

  private async coordinator(
    profile: RepositoryProfileV2,
    approve: PersonWorkspaceCommitInputV1["approve"],
    signal: AbortSignal | undefined,
  ): Promise<CodeRepairCoordinatorV1> {
    const { workspaceManager, git } = this.dependencies;
    const artifactHashReader = new FixedArgvArtifactHashReaderV1(git);
    const proof = new FixedArgvRepairProofAdapterV1({
      workspaceManager,
      git,
      artifactHashReader,
      getProfile: async (key) => (key === profile.key ? profile : null),
      now: this.now,
    });
    const committer = await createFixedArgvVerifiedCommitGatewayV1({
      workspaceManager,
      git,
      artifactHashReader,
      disabledHooksPath: this.dependencies.disabledHooksPath,
      now: this.now,
    });
    const timestamp = () => this.now().toISOString();
    return new CodeRepairCoordinatorV1({
      checkpointStore: this.checkpoints,
      mutator: {
        async applyInitialEdit({ operationId, request }) {
          const manifest = await workspaceManager.loadManifest(request.worktree.id);
          return {
            operationId,
            summary: "The person's changes, as they stand in the workspace.",
            changedPaths: [...manifest.budget.changedPaths],
            expectedArtifacts: [],
            appliedAt: timestamp(),
          };
        },
        async applyRepair() {
          throw new Error("A person's commit is never repaired by the agent.");
        },
      },
      diagnoser: {
        async diagnose({ operationId, failedValidation }) {
          return {
            operationId,
            failureFingerprint: failedValidation.failureFingerprint!,
            summary: "Validation failed on the person's changes.",
            proposedRepair: "None: the person changes the code and asks again.",
            diagnosedAt: timestamp(),
          };
        },
      },
      validator: {
        runValidation: async ({ operationId, request, kind }) => {
          await this.renewLease(request.worktree.id);
          try {
            return await this.dependencies.validate({ operationId, request, kind, signal });
          } finally {
            await this.renewLease(request.worktree.id);
          }
        },
      },
      proofReader: proof,
      approvalGateway: {
        async requestApproval(request) {
          const approved = approve
            ? (await approve(structuredClone(request))) === true
            : request.purpose === "verified_commit";
          return { operationId: request.operationId, decision: approved ? "approved" : "denied", decidedAt: timestamp() };
        },
      },
      committer,
      now: timestamp,
    });
  }

  /**
   * Hold the person's lease for the work, then release it and, when the work
   * committed, move the workspace's base to the new commit: the next pass, or
   * the next commit, starts from it.
   */
  private async withLease(
    manifest: WorkspaceManifestV2,
    work: (leaseId: string) => Promise<PersonWorkspaceCommitResultV1>,
  ): Promise<PersonWorkspaceCommitResultV1> {
    const manager = this.dependencies.workspaceManager;
    let leaseId: string;
    try {
      const leased = await manager.acquireLease(manifest.workspaceId, PERSON_COMMIT_LEASE_OWNER_V1, LEASE_TTL_MS);
      leaseId = leased.lease!.id;
    } catch (error) {
      if (error instanceof WorkspaceManagerErrorV2 && error.code === "workspace_lease_conflict") {
        throw new PersonCommitRefusalV1("workspace_in_use", "This workspace is in use. Try again when it is free.");
      }
      throw error;
    }
    let result: PersonWorkspaceCommitResultV1;
    try {
      result = await work(leaseId);
    } finally {
      await manager.releaseLease(manifest.workspaceId, leaseId).catch(() => undefined);
    }
    if (result.status !== "committed") return result;
    return { ...result, base: await this.advanceBase(result.receipt) };
  }

  private async renewLease(workspaceId: string): Promise<void> {
    const manager = this.dependencies.workspaceManager;
    const manifest = await manager.loadManifest(workspaceId);
    if (manifest.lease?.ownerId === PERSON_COMMIT_LEASE_OWNER_V1) {
      await manager.renewLease(workspaceId, manifest.lease.id, LEASE_TTL_MS).catch(() => undefined);
    }
  }

  private async advanceBase(receipt: VerifiedLocalCommitReceiptV1): Promise<PersonWorkspaceBaseV1> {
    const manager = this.dependencies.workspaceManager;
    try {
      const manifest = await manager.loadManifest(receipt.workspaceId);
      if (manifest.baseSha === receipt.commitSha) {
        return { advanced: false, reason: "The workspace's base is already this commit." };
      }
      return { advanced: true, receipt: await this.advanceTo(manifest, receipt) };
    } catch (error) {
      return { advanced: false, reason: `The workspace's base was not moved: ${errorMessage(error)}` };
    }
  }

  private async advanceTo(
    manifest: WorkspaceManifestV2,
    receipt: VerifiedLocalCommitReceiptV1,
  ): Promise<WorkspaceBaseAdvanceReceiptV2> {
    const binding = manifest.repositoryBinding!;
    const root = manifest.canonicalRoot;
    const [head, branch, dirty] = await Promise.all([
      this.gitText(root, ["rev-parse", "HEAD"]),
      this.gitText(root, ["branch", "--show-current"]),
      this.gitText(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
    ]);
    if (head !== receipt.commitSha || branch !== binding.branch || dirty !== "") {
      throw new Error(`the worktree is not clean at ${receipt.commitSha.slice(0, 7)} on ${binding.branch}`);
    }
    const operationId = `advance-${manifest.workspaceId}-${receipt.commitSha.slice(0, 12)}`;
    return this.dependencies.workspaceManager.advanceRepositoryBaseAfterVerifiedReadback({
      operationId,
      workspaceId: manifest.workspaceId,
      ownerRunId: manifest.ownerRunId,
      profileKey: binding.profileKey,
      expectedWorktreeRoot: root,
      expectedBranch: binding.branch!,
      expectedPreviousBaseSha: receipt.baseSha,
      nextBaseSha: receipt.commitSha,
      handoffFingerprint: receipt.fingerprint,
      readback: createVerifiedWorkspaceBaseReadbackV2({
        operationId,
        workspaceId: manifest.workspaceId,
        worktreeRoot: root,
        branch: binding.branch!,
        headSha: head,
        clean: true,
        handoffFingerprint: receipt.fingerprint,
      }),
    });
  }

  /**
   * A verified commit whose base was never moved (a pass that committed
   * while the host had not advanced it yet) is settled first, by the same
   * proof the host uses: a clean worktree exactly at that commit.
   */
  private async settleBaseAt(
    manifest: WorkspaceManifestV2,
    receipt: VerifiedLocalCommitReceiptV1,
  ): Promise<WorkspaceManifestV2> {
    if (manifest.baseSha !== receipt.baseSha || manifest.budget.changedPaths.length > 0) return manifest;
    try {
      await this.advanceTo(manifest, receipt);
    } catch {
      return manifest;
    }
    return this.dependencies.workspaceManager.loadManifest(manifest.workspaceId);
  }

  private async verifiedCommitIn(
    workspaceId: string,
    commitSha: string,
  ): Promise<CodeRepairCheckpointV1 | null> {
    const namespace = await this.dependencies.checkpointPersistence.readNamespace();
    const raw = namespace && typeof namespace === "object" ? Object.values(namespace.checkpoints ?? {}) : [];
    for (const candidate of raw) {
      if (
        candidate?.verifiedCommitReceipt?.commitSha !== commitSha ||
        candidate.verifiedCommitReceipt.workspaceId !== workspaceId ||
        candidate.terminal?.status !== "complete"
      ) continue;
      const checkpoint = await parseCodeRepairCheckpointV1(candidate).catch(() => null);
      if (checkpoint?.verifiedCommitReceipt && checkpoint.finalDiff) return checkpoint;
    }
    return null;
  }

  private async revertWrites(
    manifest: WorkspaceManifestV2,
    files: CodeDiffFileV1[],
    parentSha: string,
  ): Promise<RevertWriteV1[]> {
    // Each file is either still as the commit left it, or already back as it
    // was before (a revert that stopped part-way and is asked again).
    // Anything else is somebody's later work, which a revert never clobbers.
    const conflict = (relativePath: string) =>
      new PersonCommitRefusalV1("revert_conflict", `${relativePath} changed since that commit, so it is not reverted.`);
    const writes: RevertWriteV1[] = [];
    for (const file of files) {
      const current = await this.statOrNull(manifest.workspaceId, file.path);
      if (file.status === "added") {
        if (current === null) continue;
        if (current.sha256 !== file.afterSha256) throw conflict(file.path);
        writes.push({ kind: "trash", path: file.path, expectedSha256: current.sha256 });
        continue;
      }
      if (file.status === "modified") {
        const parent = await this.parentText(manifest.canonicalRoot, parentSha, file.path);
        if (current === null) throw conflict(file.path);
        if (current.sha256 === parent.sha256) continue;
        if (current.sha256 !== file.afterSha256) throw conflict(file.path);
        writes.push({ kind: "write", path: file.path, content: parent.text, sha256: parent.sha256, expectedSha256: current.sha256 });
        continue;
      }
      if (file.status === "deleted") {
        const parent = await this.parentText(manifest.canonicalRoot, parentSha, file.path);
        if (current === null) {
          writes.push({ kind: "create", path: file.path, content: parent.text, sha256: parent.sha256 });
        } else if (current.sha256 !== parent.sha256) {
          throw conflict(file.path);
        }
        continue;
      }
      // Renamed: the new name goes, the old one comes back as it was.
      const previousPath = file.previousPath!;
      const parent = await this.parentText(manifest.canonicalRoot, parentSha, previousPath);
      if (current !== null) {
        if (current.sha256 !== file.afterSha256) throw conflict(file.path);
        writes.push({ kind: "trash", path: file.path, expectedSha256: current.sha256 });
      }
      const old = await this.statOrNull(manifest.workspaceId, previousPath);
      if (old === null) {
        writes.push({ kind: "create", path: previousPath, content: parent.text, sha256: parent.sha256 });
      } else if (old.sha256 !== parent.sha256) {
        throw conflict(previousPath);
      }
    }
    return writes;
  }

  private async applyRevertWrite(workspaceId: string, leaseId: string, write: RevertWriteV1): Promise<void> {
    const manager = this.dependencies.workspaceManager;
    const current = await this.statOrNull(workspaceId, write.path);
    if (write.kind === "trash") {
      if (current === null) return;
      await manager.trash(workspaceId, leaseId, write.path, write.expectedSha256);
      return;
    }
    if (current?.sha256 === write.sha256) return;
    if (write.kind === "create") {
      await manager.createFile(workspaceId, leaseId, write.path, write.content);
    } else {
      await manager.writeExpected(workspaceId, leaseId, write.path, write.content, write.expectedSha256);
    }
    const written = await this.statOrNull(workspaceId, write.path);
    if (written?.sha256 !== write.sha256) {
      throw new Error(`${write.path} did not read back as it was before the commit.`);
    }
  }

  private async parentText(
    root: string,
    parentSha: string,
    relativePath: string,
  ): Promise<{ text: string; sha256: string }> {
    const result = await this.dependencies.git.runBytes({
      cwd: root,
      args: ["cat-file", "blob", `${parentSha}:${relativePath}`],
      maxStdoutBytes: WORKSPACE_MAX_TEXT_BYTES_V2 + 1,
    }).catch((error: unknown) => {
      if (errorCode(error) === "git_output_limit") {
        throw new PersonCommitRefusalV1("revert_file_too_large", `${relativePath} is too large to write back.`);
      }
      throw error;
    });
    if (result.exitCode !== 0) {
      throw new Error(`Git could not read ${relativePath} at ${parentSha.slice(0, 7)} (${result.exitCode}).`);
    }
    if (result.stdout.byteLength > WORKSPACE_MAX_TEXT_BYTES_V2) {
      throw new PersonCommitRefusalV1("revert_file_too_large", `${relativePath} is too large to write back.`);
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(result.stdout);
    } catch {
      throw new PersonCommitRefusalV1(
        "revert_binary_unsupported",
        `${relativePath} is not text, so it cannot be written back.`,
      );
    }
    return { text, sha256: `sha256:${createHash("sha256").update(result.stdout).digest("hex")}` };
  }

  private async statOrNull(workspaceId: string, relativePath: string) {
    return this.dependencies.workspaceManager.stat(workspaceId, relativePath).catch((error: unknown) => {
      if (
        error instanceof WorkspaceManagerErrorV2 &&
        ["path_not_found", "parent_missing"].includes(error.code)
      ) return null;
      if ((error as { code?: unknown })?.code === "ENOENT") return null;
      throw error;
    });
  }

  private async gitText(cwd: string, args: string[]): Promise<string> {
    const result = await this.dependencies.git.run({ cwd, args });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed (${result.exitCode})`);
    return result.stdout.trim();
  }
}

type RevertWriteV1 =
  | { kind: "trash"; path: string; expectedSha256: string }
  | { kind: "create"; path: string; content: string; sha256: string }
  | { kind: "write"; path: string; content: string; sha256: string; expectedSha256: string };

function revertedFiles(checkpoint: CodeRepairCheckpointV1): CodeDiffFileV1[] {
  return [...checkpoint.finalDiff!.files].sort((left, right) => left.path.localeCompare(right.path));
}

function revertPaths(files: CodeDiffFileV1[]): string[] {
  return [...new Set(files.flatMap((file) =>
    file.status === "renamed" && file.previousPath ? [file.path, file.previousPath] : [file.path]
  ))].sort();
}

function withReverted(
  result: PersonWorkspaceCommitResultV1,
  reverted: PersonWorkspaceRevertedV1,
): PersonWorkspaceCommitResultV1 {
  return result.status === "refused" ? result : { ...result, reverted };
}

function parseOperationId(value: unknown): string {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) {
    throw new PersonCommitRefusalV1(
      "invalid_input",
      "The operation id must be 1 to 96 letters, digits, dots, dashes or underscores.",
    );
  }
  return value;
}

function personIdentity(person: PersonCommitIdentityInputV1 | undefined) {
  const name = typeof person?.name === "string" ? person.name.trim() : "";
  const email = typeof person?.email === "string" ? person.email.trim() : "";
  const candidate = { authorName: name, authorEmail: email, committerName: name, committerEmail: email };
  if (isAgentGitCommitIdentityV1(candidate)) {
    throw new PersonCommitRefusalV1("person_identity_is_agent", "A person's commit cannot be made as the agent.");
  }
  try {
    return normalizePersonCommitIdentityV1(candidate);
  } catch (error) {
    throw new PersonCommitRefusalV1(
      /agent/u.test(errorMessage(error)) ? "person_identity_is_agent" : "person_identity_invalid",
      /agent/u.test(errorMessage(error))
        ? "A person's commit cannot be made as the agent."
        : "The commit needs your name and email address, as Git would record them.",
    );
  }
}

function commitMessage(value: unknown): string {
  if (typeof value !== "string") {
    throw new PersonCommitRefusalV1("commit_message_invalid", "The commit needs a message.");
  }
  const message = value.replace(/\r\n?/gu, "\n").trim();
  if (!message || message.length > MAX_MESSAGE_CHARACTERS || message.includes("\u0000")) {
    throw new PersonCommitRefusalV1(
      "commit_message_invalid",
      `The commit message must have words and at most ${MAX_MESSAGE_CHARACTERS} characters.`,
    );
  }
  return message;
}

function revertMessage(original: string, commitSha: string): string {
  const subject = (original.split("\n")[0] ?? "").trim().slice(0, MAX_SUBJECT_CHARACTERS) || commitSha.slice(0, 7);
  return `Revert "${subject}"\n\nThis reverts commit ${commitSha}.`;
}

function blockCode(code: CodeRepairBlockerCodeV1 | undefined): PersonCommitBlockCodeV1 {
  switch (code) {
    case "repair_cycles_exhausted":
    case "unchanged_failure":
      return "fast_validation_failed";
    case "targeted_validation_failed":
    case "full_validation_failed":
    case "full_validation_not_fresh":
    case "approval_denied":
    case "commit_readback_mismatch":
      return code;
    default:
      return "diff_changed";
  }
}

function blockMessage(code: CodeRepairBlockerCodeV1 | undefined, detail: string | undefined): string {
  switch (code) {
    case "repair_cycles_exhausted":
    case "unchanged_failure":
      return "The quick checks failed on these changes, so nothing was committed.";
    case "targeted_validation_failed":
      return "The tests for these changes failed, so nothing was committed.";
    case "full_validation_failed":
      return "The full validation failed, so nothing was committed.";
    case "full_validation_not_fresh":
      return "The full validation did not run in a fresh sandbox, so nothing was committed.";
    case "approval_denied":
      return "The commit was not approved, so nothing was committed.";
    case "commit_readback_mismatch":
      return `The commit did not read back as it was made: ${detail ?? "unknown"}`;
    default:
      return `The changes moved while they were being checked, so nothing was committed: ${detail ?? "unknown"}`;
  }
}

function failedValidation(
  checkpoint: CodeRepairCheckpointV1,
  code: CodeRepairBlockerCodeV1 | undefined,
): CodeValidationReceiptV1 | null {
  if (code === "targeted_validation_failed") return checkpoint.targetedValidation ?? null;
  if (code === "full_validation_failed" || code === "full_validation_not_fresh") return checkpoint.fullValidation ?? null;
  if (code === "repair_cycles_exhausted" || code === "unchanged_failure") {
    return checkpoint.attempts.at(-1)?.fastValidation ?? null;
  }
  return null;
}

function refusedOrThrow(workspaceId: string, error: unknown): PersonWorkspaceCommitResultV1 {
  if (error instanceof PersonCommitRefusalV1) {
    return { status: "refused", workspaceId, code: error.code, message: error.message };
  }
  throw error;
}

function sameHostPath(left: string, right: string): boolean {
  const normalize = (value: string) => {
    const unified = value.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return process.platform === "win32" ? unified.toLowerCase() : unified;
  };
  return normalize(left) === normalize(right);
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : "commit_failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
