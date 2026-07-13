import { createHash } from "node:crypto";
import * as path from "node:path";

import {
  canonicalMissionGraphId,
  type JsonValueV1,
  type PreparedActionV1,
} from "@agentic-researcher/core-api";
import {
  createPreparedBackgroundCodeActionV1,
  type ConsumedBackgroundCodeGrantV1,
} from "../../../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  canonicalJson,
  parseMissionGraphV3,
  prepareBackgroundCodeCompanionJobIdentityV1,
  sha256Fingerprint,
  type BackgroundAuthorizationV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "../../../packages/headless-runtime/src";
import {
  repositoryProfileExecutionBlockersV2,
  type RepositoryProfileV2,
  type RepositoryProjectV2,
  type RepositoryValidationCommandV2,
} from "../repositories";
import {
  codeRepairCheckpointIdV1,
  normalizeCodeRepairRequestV1,
  parseBoundCodeValidationReceiptV1,
  parseCodeRepairCheckpointV1,
  type ArtifactHashReadbackV1,
  type CodeDiffFileV1,
  type CodeRepairCheckpointStoreV1,
  type CodeRepairCheckpointV1,
  type CodeValidationReceiptV1,
} from "../repair";
import { classifyProtectedControlChanges } from "../repair/protectedControls";
import {
  parsePreparedSandboxActionV2,
  type PreparedSandboxActionV2,
  type SandboxCapabilityStatusV2,
  type SandboxManagerV2,
  type SandboxProviderConfigV2,
  type SandboxStagingEntryV2,
} from "../sandbox";
import {
  type WorkspaceManagerV2,
  type WorkspaceManifestV2,
} from "../workspaces";
import { workspaceBindingFingerprintV1 } from "./BackgroundCodeContinuationV1";
import {
  PREPARED_BACKGROUND_CODE_EDIT_SUMMARY_V1,
  PREPARED_BACKGROUND_CODE_COMMIT_MESSAGE_V1,
  PREPARED_BACKGROUND_CODE_OBJECTIVE_V1,
  type PreparedSandboxValidationStepV1,
} from "./PreparedBackgroundCodeExecutionPlanV1";
import {
  PREPARED_BACKGROUND_CODE_TOOL_DESCRIPTOR_V1,
  PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
} from "./PreparedBackgroundCodeContributionsV1";
import {
  type PrepareBackgroundValidationCommitApprovalInputV1,
  type PrepareBackgroundValidationCommitApprovalResultV1,
  type PreparedBackgroundCodeHostV1,
  type SealBackgroundValidationCommitPackageInputV1,
  type SealBackgroundValidationCommitPackageResultV1,
} from "./PreparedBackgroundCodeHostV1";

const APPROVAL_TTL_MS = 15 * 60_000;
const MIN_REMAINING_AUTHORITY_MS = 10_000;
const MAX_STAGED_FILES = 100;
const MAX_STAGED_FILE_BYTES = 2_000_000;
const MAX_STAGED_TOTAL_BYTES = 10_000_000;
interface PreparedBackgroundCodeResolverDependenciesV1 {
  checkpoints: CodeRepairCheckpointStoreV1;
  workspaceManager: WorkspaceManagerV2;
  getRepositoryProfile(profileKey: string): Promise<RepositoryProfileV2 | null>;
  sandboxManager: SandboxManagerV2;
  sandboxProviders(): readonly SandboxProviderConfigV2[];
  host: PreparedBackgroundCodeHostV1;
  now(): Date;
}

interface ResolvedBackgroundCodeStateV1 {
  sourceCheckpoint: CodeRepairCheckpointV1;
  checkpoint: CodeRepairCheckpointV1;
  manifest: WorkspaceManifestV2;
  profile: RepositoryProfileV2;
  sandboxStatus: SandboxCapabilityStatusV2;
  sandboxProvider: SandboxProviderConfigV2;
  sandboxBoundaryFingerprint: string;
  workspaceBindingFingerprint: string;
  repositoryProfileFingerprint: string;
  sandboxCapabilityFingerprint: string;
  previewDiffFingerprint: string;
  stagingManifestFingerprint: string;
  stagingManifest: SandboxStagingEntryV2[];
  approvedArtifacts: ArtifactHashReadbackV1[];
  project: RepositoryProjectV2;
  targetedCommand: RepositoryValidationCommandV2;
  fullCommand: RepositoryValidationCommandV2;
  stateFingerprint: string;
}

/**
 * Production-only resolver for the approval and sealing halves of one exact
 * background Code continuation. Every executable value is reconstructed from
 * extension-owned durable state; caller input is identity and authority only.
 */
export class PreparedBackgroundCodeResolverV1 {
  constructor(
    private readonly dependencies: PreparedBackgroundCodeResolverDependenciesV1,
  ) {}

  async prepareApproval(
    inputValue: PrepareBackgroundValidationCommitApprovalInputV1,
  ): Promise<PrepareBackgroundValidationCommitApprovalResultV1> {
    try {
      const input = approvalInput(inputValue);
      const preparedAt = canonicalTime(this.dependencies.now(), "approval preparation time");
      const expiresAt = new Date(
        Date.parse(preparedAt) + APPROVAL_TTL_MS,
      ).toISOString();
      const state = await this.resolveState({
        repairCheckpointId: input.repairCheckpointId,
        runId: input.runId,
      });
      return {
        status: "ready",
        preparedAction: buildApprovalAction({
          input,
          state,
          preparedAt,
          expiresAt,
        }),
      };
    } catch (error) {
      return blockedResult(error);
    }
  }

  async sealPackage(
    input: SealBackgroundValidationCommitPackageInputV1,
  ): Promise<SealBackgroundValidationCommitPackageResultV1> {
    try {
      const now = canonicalTime(this.dependencies.now(), "package sealing time");
      const action = parseApprovalAction(input.preparedAction, now);
      const graph = await parseMissionGraphV3(input.graph);
      const authority = parseConsumedAuthority(input.authority, action, now);
      const authorization = parseBackgroundAuthorization(input.authorization, now);
      if (graph.missionId !== canonicalMissionGraphId(action.runId)) {
        fail(
          "background_code_graph_scope_drift",
          "The approved Code action belongs to a different authoritative mission graph.",
          "Prepare and approve the action again from the current mission graph.",
        );
      }
      const state = await this.resolveState({
        repairCheckpointId: stringArg(
          action.normalizedArgs.repairCheckpointId,
          "repair checkpoint id",
        ),
        runId: action.runId,
      });
      const rebuilt = buildApprovalAction({
        input: {
          repairCheckpointId: state.sourceCheckpoint.id,
          runId: action.runId,
          toolCallId: action.toolCallId,
        },
        state,
        preparedAt: action.preparedAt,
        expiresAt: action.expiresAt,
      });
      if (canonicalJson(rebuilt) !== canonicalJson(action)) {
        fail(
          "background_code_prepared_state_drift",
          "The exact checkpoint, workspace, profile, sandbox, or diff evidence changed after approval preparation.",
          "Read the current trusted state and approve a fresh exact Code action.",
        );
      }

      const node = selectAuthorizedNode(graph, action, state);
      const descriptorFingerprint = await sha256Fingerprint(
        PREPARED_BACKGROUND_CODE_TOOL_DESCRIPTOR_V1,
      );
      const nodeFingerprint = await sha256Fingerprint(node);
      const preparedAt = latestTimestamp(
        action.preparedAt,
        authority.consumedAt,
        authorization.authorizedAt,
      );
      const expiresAt = earliestTimestamp(
        action.expiresAt,
        authority.expiresAt,
        authorization.expiresAt,
      );
      if (Date.parse(expiresAt) - Date.parse(now) < MIN_REMAINING_AUTHORITY_MS) {
        fail(
          "background_code_authority_expired",
          "Too little exact approval lifetime remains to persist and dispatch the Code package safely.",
          "Approve a fresh exact Code action.",
        );
      }
      const binding = graph.capabilityEnvelope.bindings[node.destination!.bindingId];
      const handoffIdentity = await sha256Fingerprint({
        version: 1,
        missionId: graph.missionId,
        graphRevision: graph.revision,
        capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
        nodeId: node.id,
        nodeFingerprint,
        descriptorFingerprint,
        preparedActionFingerprint: action.payloadFingerprint,
        consumedAuthorityFingerprint: authority.authorityFingerprint,
        backgroundAuthorizationFingerprint: authorization.fingerprint,
        checkpointId: state.checkpoint.id,
        checkpointFingerprint: state.checkpoint.requestFingerprint,
        stateFingerprint: state.stateFingerprint,
      });
      const handoff = createPreparedBackgroundCodeActionV1({
        id: `background-code-${handoffIdentity.slice(7, 39)}`,
        missionId: graph.missionId,
        graphRevision: graph.revision,
        capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
        nodeId: node.id,
        nodeFingerprint,
        executionHost: node.executionHost as "companion" | "headless_runtime",
        descriptorFingerprint,
        preparedActionId: action.id,
        preparedActionFingerprint: action.payloadFingerprint,
        binding: {
          workspaceId: state.manifest.workspaceId,
          repositoryProfileKey: state.profile.key,
          destinationFingerprint: binding.destinationFingerprint,
        },
        authority,
        payload: {
          repairCheckpointId: state.checkpoint.id,
          repairRequestFingerprint: state.checkpoint.requestFingerprint,
          preparedCheckpointSequence: state.checkpoint.sequence,
          workspaceBindingFingerprint: state.workspaceBindingFingerprint,
          repositoryProfileFingerprint: state.repositoryProfileFingerprint,
          sandboxCapabilityFingerprint: state.sandboxCapabilityFingerprint,
        },
        idempotencyKey: handoffIdentity,
        reconciliationKey: handoffIdentity,
        preparedAt,
        expiresAt,
      });
      const jobIdentity = await prepareBackgroundCodeCompanionJobIdentityV1({
        graph,
        nodeId: node.id,
        authorization,
        preparedBackgroundCodeAction: handoff,
        now: new Date(Date.parse(now)),
      });
      const remainingMs = Date.parse(expiresAt) - Date.parse(now);
      const targetedValidation = await this.prepareValidationStep({
        state,
        purpose: "validation_targeted",
        commandId: state.targetedCommand.id,
        authority,
        preparedAt,
        expiresAt,
        ttlMs: remainingMs,
      });
      const fullValidation = await this.prepareValidationStep({
        state,
        purpose: "validation_full",
        commandId: state.fullCommand.id,
        authority,
        preparedAt,
        expiresAt,
        ttlMs: remainingMs,
      });
      const persisted = await this.dependencies.host.prepare({
        jobId: jobIdentity.id,
        backgroundAuthorizationFingerprint: authorization.fingerprint,
        handoff,
        checkpoint: state.checkpoint,
        repositoryProfile: state.profile,
        sandboxCapabilityStatus: state.sandboxStatus,
        sandboxProviders: [...this.dependencies.sandboxProviders()],
        targetedValidation,
        fullValidation,
        approvedArtifacts: state.approvedArtifacts,
        sandboxProvider: state.sandboxProvider.kind,
        sandboxBoundaryFingerprint: state.sandboxBoundaryFingerprint,
      });
      return {
        status: "ready",
        handoff,
        packageIdentity: persisted.packageIdentity,
        packagePersistenceReceipt: persisted.packagePersistenceReceipt,
      };
    } catch (error) {
      return blockedResult(error);
    }
  }

  private async resolveState(input: {
    repairCheckpointId: string;
    runId: string;
  }): Promise<ResolvedBackgroundCodeStateV1> {
    const checkpointId = checkpointIdentifier(input.repairCheckpointId);
    const authorizingRunId = identifier(input.runId, "run id");
    const loaded = await this.dependencies.checkpoints.load(checkpointId);
    if (!loaded) {
      fail(
        "background_code_checkpoint_unavailable",
        "The exact durable Code repair checkpoint is unavailable.",
        "Resume or recreate the foreground repair checkpoint in Obsidian.",
      );
    }
    const sourceCheckpoint = await parseCodeRepairCheckpointV1(loaded);
    if (
      sourceCheckpoint.id !== checkpointId ||
      sourceCheckpoint.id !== codeRepairCheckpointIdV1(sourceCheckpoint.request)
    ) {
      fail(
        "background_code_checkpoint_scope_drift",
        "The durable checkpoint identity does not match its exact source request and workspace.",
        "Use the exact nonterminal checkpoint created by the trusted foreground repair flow.",
      );
    }
    const latestAttempt = sourceCheckpoint.attempts.at(-1);
    if (
      sourceCheckpoint.stage !== "diff_preview" ||
      sourceCheckpoint.terminal ||
      sourceCheckpoint.blocker ||
      !sourceCheckpoint.initialEdit ||
      !sourceCheckpoint.previewDiff ||
      sourceCheckpoint.targetedValidation ||
      sourceCheckpoint.fullValidation ||
      sourceCheckpoint.finalDiff ||
      sourceCheckpoint.artifactReadback ||
      sourceCheckpoint.commit ||
      sourceCheckpoint.commitReadback ||
      sourceCheckpoint.verifiedCommitReceipt ||
      sourceCheckpoint.request.expectedArtifacts.length !== 0 ||
      sourceCheckpoint.initialEdit.expectedArtifacts.length !== 0 ||
      !latestAttempt?.fastValidation ||
      latestAttempt.fastValidation.status !== "passed" ||
      latestAttempt.fastValidation.freshSandbox !== true
    ) {
      fail(
        "background_code_checkpoint_not_ready",
        "Background Code requires a nonterminal diff-preview checkpoint whose latest fresh fast validation passed and which expects no generated artifacts.",
        "Complete the edit, fresh fast validation, and exact diff preview in the foreground repair flow.",
      );
    }
    const fastValidation = await parseBoundCodeValidationReceiptV1(
      latestAttempt.fastValidation,
      {
        requestId: sourceCheckpoint.request.id,
        workspaceId: sourceCheckpoint.request.worktree.id,
        profileKey: sourceCheckpoint.request.worktree.profileId,
      },
    );
    const manifest = await this.dependencies.workspaceManager.resumeWorkspace(
      sourceCheckpoint.request.worktree.id,
      sourceCheckpoint.request.runId,
    );
    const profile = await this.dependencies.getRepositoryProfile(
      sourceCheckpoint.request.worktree.profileId,
    );
    if (!profile) {
      fail(
        "background_code_profile_unavailable",
        "The trusted repository profile is unavailable.",
        "Re-detect and explicitly trust the repository profile.",
      );
    }
    assertTrustedWorkspaceBinding(sourceCheckpoint, manifest, profile);
    if (manifest.status !== "active" || manifest.lease !== null) {
      fail(
        "background_code_workspace_locked",
        "The trusted workspace is already leased or is not active.",
        "Wait for the current workspace owner to release its lease, then prepare again.",
      );
    }
    const preview = sourceCheckpoint.previewDiff;
    const changedPaths = [...preview.changedPaths];
    if (
      changedPaths.length < 1 ||
      changedPaths.length > MAX_STAGED_FILES ||
      canonicalJson(changedPaths) !== canonicalJson([...changedPaths].sort()) ||
      canonicalJson(manifest.budget.changedPaths) !== canonicalJson(changedPaths) ||
      canonicalJson(sourceCheckpoint.initialEdit.changedPaths) !== canonicalJson(changedPaths)
    ) {
      fail(
        "background_code_changed_path_drift",
        "The checkpoint, diff preview, and live workspace disagree about the exact changed paths.",
        "Read the live diff again and create a fresh checkpoint.",
      );
    }
    const protectedDiff = classifyProtectedControlChanges(changedPaths, [
      ...sourceCheckpoint.request.protectedControlPaths,
      ...profile.protectedControls.map((control) => control.path),
    ]);
    if (protectedDiff.level !== "none") {
      fail(
        "background_code_protected_diff_forbidden",
        "Background validation and commit cannot include protected manifests, lockfiles, build controls, workflows, or hooks.",
        "Handle the protected diff in the foreground exact-diff approval flow.",
      );
    }
    const project = selectProject(profile, changedPaths);
    const targetedCommand = selectTargetedCommand(profile, project.id);
    const fullCommand = selectCommand(profile, project.id, "full");
    for (const command of [targetedCommand, fullCommand]) {
      if (command.network !== "disabled" || command.credentialPolicy !== "none") {
        fail(
          "background_code_networked_validation_forbidden",
          "Prepared Code validation must use profile commands with network disabled and no credentials.",
          "Add an offline validation command to the trusted repository profile.",
        );
      }
    }
    const runtimeBlockers = repositoryProfileExecutionBlockersV2(profile);
    if (runtimeBlockers.length > 0) {
      fail(
        "background_code_runtime_unresolved",
        "The selected repository validation runtime lacks an immutable verified digest.",
        "Confirm the repository-pinned runtime or its immutable digest.",
      );
    }

    const stagingManifest = await this.readStagingManifest(manifest);
    const stagingManifestFingerprint = await sha256Fingerprint(stagingManifest);
    const binding = fastValidation.binding!;
    if (
      binding.inputWorkspaceManifestFingerprint !== manifest.hashes.indexFingerprint ||
      binding.validatedWorkspaceManifestFingerprint !== manifest.hashes.indexFingerprint ||
      canonicalJson(binding.workspaceChangedPaths) !== canonicalJson(changedPaths) ||
      binding.stagingManifestFingerprint !== stagingManifestFingerprint ||
      canonicalJson(binding.stagedFiles) !== canonicalJson(stagingManifest) ||
      binding.importedArtifacts.length !== 0
    ) {
      fail(
        "background_code_fast_validation_drift",
        "The latest fast validation is not bound to the exact current workspace manifest and staged bytes.",
        "Run fresh fast validation against the current workspace and read the diff again.",
      );
    }
    const approvedArtifacts = await this.readChangedArtifacts(
      manifest,
      preview.files,
    );
    if (approvedArtifacts.length < 1) {
      fail(
        "background_code_changed_artifact_missing",
        "The exact prepared diff has no readable after-artifact to verify.",
        "Complete deletion-only commits in the foreground flow.",
      );
    }

    const sandboxStatus = await this.dependencies.sandboxManager.probeProviders();
    if (
      sandboxStatus.mode !== "sandbox_verified" ||
      sandboxStatus.executionAvailable !== true ||
      !sandboxStatus.selectedProvider ||
      sandboxStatus.blocker !== null
    ) {
      fail(
        "background_code_sandbox_unavailable",
        "No configured sandbox provider passed its fresh boundary probe.",
        "Install or repair a supported immutable sandbox and run the boundary probe.",
      );
    }
    const sandboxProvider = this.dependencies.sandboxProviders().find(
      (candidate) => candidate.kind === sandboxStatus.selectedProvider,
    );
    const providerStatus = sandboxStatus.providers.find(
      (candidate) => candidate.provider === sandboxStatus.selectedProvider,
    );
    if (!sandboxProvider || providerStatus?.state !== "verified" || !providerStatus.probeFingerprint) {
      fail(
        "background_code_sandbox_binding_drift",
        "The selected sandbox is not bound to a configured provider and verified boundary proof.",
        "Reconfigure and freshly probe the immutable sandbox provider.",
      );
    }
    if (
      manifest.sandboxPolicy.provider !== null &&
      (manifest.sandboxPolicy.provider !== sandboxStatus.selectedProvider ||
        manifest.sandboxPolicy.boundaryFingerprint !== providerStatus.probeFingerprint)
    ) {
      fail(
        "background_code_sandbox_binding_drift",
        "The live workspace sandbox binding differs from the freshly verified provider.",
        "Refresh the workspace sandbox binding after an explicit boundary probe.",
      );
    }
    const workspaceBindingFingerprint = await workspaceBindingFingerprintV1(manifest);
    const repositoryProfileFingerprint = await sha256Fingerprint(profile);
    const sandboxCapabilityFingerprint = await sha256Fingerprint({
      version: 1,
      selectedProvider: sandboxStatus.selectedProvider,
      probeFingerprint: providerStatus.probeFingerprint,
      providerFingerprint: await sha256Fingerprint(sandboxProvider),
    });
    const previewDiffFingerprint = preview.fingerprint;
    const checkpoint = await sanitizeCheckpoint(sourceCheckpoint);
    const stateFingerprint = await sha256Fingerprint({
      version: 1,
      authorizingRunId,
      checkpointId: sourceCheckpoint.id,
      sourceRequestFingerprint: sourceCheckpoint.requestFingerprint,
      checkpointSequence: sourceCheckpoint.sequence,
      workspaceManifestFingerprint: manifest.hashes.indexFingerprint,
      workspaceBindingFingerprint,
      repositoryProfileFingerprint,
      sandboxCapabilityFingerprint,
      previewDiffFingerprint,
      stagingManifestFingerprint,
      approvedArtifactsFingerprint: await sha256Fingerprint(approvedArtifacts),
      projectId: project.id,
      targetedCommandId: targetedCommand.id,
      fullCommandId: fullCommand.id,
    });
    return {
      sourceCheckpoint,
      checkpoint,
      manifest,
      profile,
      sandboxStatus,
      sandboxProvider,
      sandboxBoundaryFingerprint: providerStatus.probeFingerprint,
      workspaceBindingFingerprint,
      repositoryProfileFingerprint,
      sandboxCapabilityFingerprint,
      previewDiffFingerprint,
      stagingManifestFingerprint,
      stagingManifest,
      approvedArtifacts,
      project,
      targetedCommand,
      fullCommand,
      stateFingerprint,
    };
  }

  private async readStagingManifest(
    manifest: WorkspaceManifestV2,
  ): Promise<SandboxStagingEntryV2[]> {
    const entries = Object.entries(manifest.hashes.files).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (entries.length < 1 || entries.length > MAX_STAGED_FILES) {
      fail(
        "background_code_staging_limit_exceeded",
        "The trusted workspace cannot be staged within the 1-100 file limit.",
        "Reduce the isolated repository fixture or complete this work in the foreground flow.",
      );
    }
    let total = 0;
    const result: SandboxStagingEntryV2[] = [];
    for (const [relativePath, expected] of entries) {
      if (expected.bytes > MAX_STAGED_FILE_BYTES) {
        fail(
          "background_code_staging_limit_exceeded",
          "A trusted staged file exceeds the 2 MB model-edit limit.",
          "Remove the oversized file from the isolated worktree or use a human-owned flow.",
        );
      }
      const readback = await this.dependencies.workspaceManager.read(
        manifest.workspaceId,
        relativePath,
      );
      if (
        readback.path !== relativePath ||
        readback.sha256 !== expected.sha256 ||
        readback.bytes !== expected.bytes
      ) {
        fail(
          "background_code_workspace_hash_drift",
          "A staged workspace file changed after its trusted manifest was recorded.",
          "Re-read the workspace through WorkspaceManager and run fresh validation.",
        );
      }
      total += readback.bytes;
      if (total > MAX_STAGED_TOTAL_BYTES) {
        fail(
          "background_code_staging_limit_exceeded",
          "The trusted staging manifest exceeds the 10 MB mission limit.",
          "Reduce the isolated workspace or use a human-owned flow.",
        );
      }
      result.push({
        path: relativePath,
        sha256: readback.sha256,
        bytes: readback.bytes,
      });
    }
    return result;
  }

  private async readChangedArtifacts(
    manifest: WorkspaceManifestV2,
    files: CodeDiffFileV1[],
  ): Promise<ArtifactHashReadbackV1[]> {
    const artifacts: ArtifactHashReadbackV1[] = [];
    for (const file of files) {
      if (file.afterSha256 === null) continue;
      const expected = manifest.hashes.files[file.path];
      if (!expected || expected.sha256 !== file.afterSha256) {
        fail(
          "background_code_diff_hash_drift",
          "The exact preview diff no longer matches the trusted workspace hash index.",
          "Read the current diff again and approve a fresh action.",
        );
      }
      const readback = await this.dependencies.workspaceManager.read(
        manifest.workspaceId,
        file.path,
      );
      if (readback.sha256 !== file.afterSha256 || readback.bytes !== expected.bytes) {
        fail(
          "background_code_diff_hash_drift",
          "A changed after-artifact failed exact live hash readback.",
          "Read the current diff again and approve a fresh action.",
        );
      }
      artifacts.push({
        path: file.path,
        sha256: readback.sha256,
        bytes: readback.bytes,
      });
    }
    return artifacts.sort((left, right) => left.path.localeCompare(right.path));
  }

  private async prepareValidationStep(input: {
    state: ResolvedBackgroundCodeStateV1;
    purpose: "validation_targeted" | "validation_full";
    commandId: string;
    authority: ConsumedBackgroundCodeGrantV1;
    preparedAt: string;
    expiresAt: string;
    ttlMs: number;
  }): Promise<PreparedSandboxValidationStepV1> {
    const result = await this.dependencies.sandboxManager.prepareExecution({
      profile: input.state.profile,
      purpose: input.purpose,
      projectId: input.state.project.id,
      commandId: input.commandId,
      workspaceId: input.state.manifest.workspaceId,
      repairRequestId: input.state.checkpoint.request.id,
      workspaceManifestFingerprint:
        input.state.manifest.hashes.indexFingerprint,
      stagingManifest: input.state.stagingManifest,
      expectedArtifacts: [],
      environment: {
        CI: "1",
        NO_COLOR: "1",
        TZ: "UTC",
      },
      ttlMs: Math.min(APPROVAL_TTL_MS, input.ttlMs),
    });
    if (result.status === "blocked") {
      fail(
        result.blocker.code === "sandbox_runtime_digest_required"
          ? "background_code_runtime_unresolved"
          : "background_code_sandbox_unavailable",
        result.blocker.code === "sandbox_runtime_digest_required"
          ? "The selected validation command lacks an immutable runtime binding."
          : "The exact sandbox validation action could not be prepared.",
        result.blocker.requiredAction,
      );
    }
    const action = retimeSandboxAction(
      result.action,
      input.preparedAt,
      input.expiresAt,
    );
    return {
      action,
      authorization: {
        preparedActionId: action.id,
        payloadFingerprint: action.payloadFingerprint,
        grantId: input.authority.id,
      },
    };
  }
}

function buildApprovalAction(input: {
  input: PrepareBackgroundValidationCommitApprovalInputV1;
  state: ResolvedBackgroundCodeStateV1;
  preparedAt: string;
  expiresAt: string;
}): PreparedActionV1 {
  const normalizedArgs: Record<string, JsonValueV1> = {
    version: 1,
    kind: "prepared_background_code_approval_v1",
    repairCheckpointId: input.state.sourceCheckpoint.id,
    sourceRequestFingerprint: input.state.sourceCheckpoint.requestFingerprint,
    checkpointSequence: input.state.sourceCheckpoint.sequence,
    workspaceId: input.state.manifest.workspaceId,
    repositoryProfileKey: input.state.profile.key,
    stateFingerprint: input.state.stateFingerprint,
    previewDiffFingerprint: input.state.previewDiffFingerprint,
    stagingManifestFingerprint: input.state.stagingManifestFingerprint,
    workspaceBindingFingerprint: input.state.workspaceBindingFingerprint,
    repositoryProfileFingerprint: input.state.repositoryProfileFingerprint,
    sandboxCapabilityFingerprint: input.state.sandboxCapabilityFingerprint,
    projectId: input.state.project.id,
    targetedCommandId: input.state.targetedCommand.id,
    fullCommandId: input.state.fullCommand.id,
  };
  const target: PreparedActionV1["target"] = {
    system: "git",
    resourceType: "prepared_validation_commit",
    id: input.state.manifest.workspaceId,
    workspaceId: input.state.manifest.workspaceId,
    repositoryProfileId: input.state.profile.key,
    revision: input.state.manifest.hashes.indexFingerprint,
  };
  const preview: PreparedActionV1["preview"] = {
    summary:
      "Validate the exact prepared source diff in two offline sandbox passes, read it back, and create one verified local commit.",
    destination: `workspace:${input.state.manifest.workspaceId}`,
    before: {
      checkpointSequence: input.state.sourceCheckpoint.sequence,
      workspaceManifestFingerprint:
        input.state.manifest.hashes.indexFingerprint,
    },
    after: {
      changedPaths: [...input.state.sourceCheckpoint.previewDiff!.changedPaths],
      previewDiffFingerprint: input.state.previewDiffFingerprint,
      projectId: input.state.project.id,
      targetedCommandId: input.state.targetedCommand.id,
      fullCommandId: input.state.fullCommand.id,
    },
    warnings: [
      "Execution is sandbox-only, network-disabled, and has no foreground fallback.",
    ],
    outboundBytes: 0,
  };
  const seed = {
    version: 1 as const,
    runId: input.input.runId,
    toolCallId: input.input.toolCallId,
    toolName: PREPARED_BACKGROUND_CODE_TOOL_NAME_V1,
    target,
    relatedResources: [],
    normalizedArgs,
    preview,
    expectedTargetRevision: input.state.manifest.hashes.indexFingerprint,
    idempotencyKey: input.state.stateFingerprint,
    reconciliationKey: input.state.stateFingerprint,
    requiredConfirmations: 1 as const,
    preparedAt: input.preparedAt,
    expiresAt: input.expiresAt,
  };
  const identity = sha256Canonical(seed);
  const evidence: Omit<PreparedActionV1, "payloadFingerprint"> = {
    ...seed,
    id: `prepared-background-code-${identity.slice(7, 39)}`,
  };
  return { ...evidence, payloadFingerprint: sha256Canonical(evidence) };
}

function parseApprovalAction(value: unknown, now: string): PreparedActionV1 {
  const action = exactRecord(value, [
    "version", "id", "runId", "toolCallId", "toolName", "target",
    "relatedResources", "normalizedArgs", "preview", "payloadFingerprint",
    "expectedTargetRevision", "idempotencyKey", "reconciliationKey",
    "requiredConfirmations", "preparedAt", "expiresAt",
  ], "prepared background Code approval") as unknown as PreparedActionV1;
  if (
    action.version !== 1 ||
    action.toolName !== PREPARED_BACKGROUND_CODE_TOOL_NAME_V1 ||
    action.requiredConfirmations !== 1 ||
    !Array.isArray(action.relatedResources) ||
    action.relatedResources.length !== 0 ||
    Date.parse(action.expiresAt) <= Date.parse(now) ||
    Date.parse(action.expiresAt) - Date.parse(action.preparedAt) > APPROVAL_TTL_MS
  ) {
    fail(
      "background_code_prepared_action_invalid",
      "The prepared background Code action is malformed, expired, or exceeds its authority window.",
      "Prepare and approve a fresh exact Code action.",
    );
  }
  exactRecord(action.target, [
    "system", "resourceType", "id", "workspaceId",
    "repositoryProfileId", "revision",
  ], "prepared background Code target");
  exactRecord(action.normalizedArgs, [
    "version", "kind", "repairCheckpointId", "sourceRequestFingerprint",
    "checkpointSequence", "workspaceId", "repositoryProfileKey",
    "stateFingerprint", "previewDiffFingerprint", "stagingManifestFingerprint",
    "workspaceBindingFingerprint", "repositoryProfileFingerprint",
    "sandboxCapabilityFingerprint", "projectId", "targetedCommandId",
    "fullCommandId",
  ], "prepared background Code normalized arguments");
  exactRecord(action.preview, [
    "summary", "destination", "before", "after", "warnings", "outboundBytes",
  ], "prepared background Code preview");
  exactRecord(action.preview.before, [
    "checkpointSequence", "workspaceManifestFingerprint",
  ], "prepared background Code before-preview");
  exactRecord(action.preview.after, [
    "changedPaths", "previewDiffFingerprint", "projectId",
    "targetedCommandId", "fullCommandId",
  ], "prepared background Code after-preview");
  if (
    action.target.system !== "git" ||
    action.target.resourceType !== "prepared_validation_commit" ||
    action.normalizedArgs.version !== 1 ||
    action.normalizedArgs.kind !== "prepared_background_code_approval_v1" ||
    action.preview.outboundBytes !== 0 ||
    action.idempotencyKey !== action.reconciliationKey
  ) {
    fail(
      "background_code_prepared_action_invalid",
      "The prepared background Code action escaped its closed logical scope.",
      "Prepare and approve a fresh exact Code action.",
    );
  }
  const { payloadFingerprint, ...evidence } = action;
  if (payloadFingerprint !== sha256Canonical(evidence)) {
    fail(
      "background_code_prepared_action_drift",
      "The prepared background Code action fingerprint no longer matches its exact preview.",
      "Prepare and approve a fresh exact Code action.",
    );
  }
  return cloneJson(action);
}

function selectAuthorizedNode(
  graph: MissionGraphV3,
  action: PreparedActionV1,
  state: ResolvedBackgroundCodeStateV1,
): MissionNodeV3 {
  const candidates = Object.values(graph.nodes).filter((node) => {
    const destination = node.destination;
    const binding = destination
      ? graph.capabilityEnvelope.bindings[destination.bindingId]
      : null;
    return (
      node.effect === "execution" &&
      (node.executionHost === "companion" ||
        node.executionHost === "headless_runtime") &&
      node.allowedTools.length === 1 &&
      node.allowedTools[0] === PREPARED_BACKGROUND_CODE_TOOL_NAME_V1 &&
      destination?.effect === "execution" &&
      binding?.id === state.manifest.workspaceId &&
      binding.destinationFingerprint === state.manifest.repositoryBinding?.bindingFingerprint &&
      binding.allowedEffects.includes("execution") &&
      node.resourceLocks.some(
        (lock) => lock.bindingId === binding.id && lock.mode === "exclusive",
      )
    );
  });
  if (candidates.length !== 1) {
    fail(
      "background_code_graph_node_ambiguous",
      "The authoritative graph does not contain exactly one exclusive background Code node for this trusted workspace.",
      "Replan the mission with one exact Code execution node and binding.",
    );
  }
  const node = candidates[0];
  const binding = graph.capabilityEnvelope.bindings[node.destination!.bindingId];
  if (
    action.target.id !== state.manifest.workspaceId ||
    action.target.workspaceId !== state.manifest.workspaceId ||
    action.target.repositoryProfileId !== state.profile.key ||
    action.target.revision !== state.manifest.hashes.indexFingerprint ||
    binding.destinationFingerprint !== state.manifest.repositoryBinding!.bindingFingerprint
  ) {
    fail(
      "background_code_graph_binding_drift",
      "The approved action no longer matches the graph's exact trusted destination binding.",
      "Prepare the action again from the current mission graph.",
    );
  }
  return node;
}

function assertTrustedWorkspaceBinding(
  checkpoint: CodeRepairCheckpointV1,
  manifest: WorkspaceManifestV2,
  profile: RepositoryProfileV2,
): void {
  const request = checkpoint.request;
  const binding = manifest.repositoryBinding;
  if (
    manifest.kind !== "repository" ||
    !binding ||
    manifest.ownerRunId !== request.runId ||
    manifest.workspaceId !== request.worktree.id ||
    manifest.baseSha !== request.worktree.baseSha ||
    binding.profileKey !== request.worktree.profileId ||
    binding.branch !== request.worktree.branch ||
    profile.key !== request.worktree.profileId ||
    !samePath(manifest.canonicalRoot, request.worktree.path) ||
    !samePath(binding.worktreeRoot, request.worktree.path) ||
    !samePath(binding.repositoryRoot, request.worktree.repositoryRoot) ||
    !samePath(profile.repositoryRoot, request.worktree.repositoryRoot)
  ) {
    fail(
      "background_code_workspace_binding_drift",
      "The durable checkpoint no longer matches its exact trusted repository workspace and profile binding.",
      "Recreate the repair checkpoint from the live trusted worktree.",
    );
  }
}

function selectProject(
  profile: RepositoryProfileV2,
  changedPaths: readonly string[],
): RepositoryProjectV2 {
  const candidates = profile.projects.filter((project) =>
    changedPaths.every(
      (changedPath) =>
        pathAtOrBelow(project.root, changedPath) &&
        project.allowedPaths.some((root) => pathAtOrBelow(root, changedPath)) &&
        profile.allowedPaths.some((root) => pathAtOrBelow(root, changedPath)),
    ),
  );
  if (candidates.length !== 1) {
    fail(
      "background_code_project_ambiguous",
      "The exact changed paths are not covered by exactly one trusted repository project.",
      "Narrow the diff to one project or correct the trusted RepositoryProfileV2 mapping.",
    );
  }
  return candidates[0];
}

function selectTargetedCommand(
  profile: RepositoryProfileV2,
  projectId: string,
): RepositoryValidationCommandV2 {
  const targeted = profile.validationCatalog.filter(
    (command) => command.projectId === projectId && command.phase === "targeted",
  );
  return targeted.length > 0
    ? exactCommand(targeted, "targeted")
    : selectCommand(profile, projectId, "fast");
}

function selectCommand(
  profile: RepositoryProfileV2,
  projectId: string,
  phase: "fast" | "full",
): RepositoryValidationCommandV2 {
  return exactCommand(
    profile.validationCatalog.filter(
      (command) => command.projectId === projectId && command.phase === phase,
    ),
    phase,
  );
}

function exactCommand(
  candidates: RepositoryValidationCommandV2[],
  phase: string,
): RepositoryValidationCommandV2 {
  if (candidates.length !== 1) {
    fail(
      "background_code_validation_command_ambiguous",
      `The trusted project requires exactly one ${phase} validation command.`,
      "Correct the RepositoryProfileV2 validation catalog and prepare again.",
    );
  }
  return candidates[0];
}

async function sanitizeCheckpoint(
  source: CodeRepairCheckpointV1,
): Promise<CodeRepairCheckpointV1> {
  const latest = source.attempts.at(-1)!.fastValidation!;
  const request = normalizeCodeRepairRequestV1({
    id: source.request.id,
    runId: source.request.runId,
    objective: PREPARED_BACKGROUND_CODE_OBJECTIVE_V1,
    worktree: cloneJson(source.request.worktree),
    commitMessage: PREPARED_BACKGROUND_CODE_COMMIT_MESSAGE_V1,
    maxCycles: 1,
    expectedArtifacts: [],
    protectedControlPaths: [],
  });
  const checks = latest.checks.map((check, index) => ({
    label: `fast-validation-${index + 1}`,
    exitCode: check.exitCode,
    stdout: validationHashSummary(check.stdout),
    stderr: validationHashSummary(check.stderr),
    durationMs: check.durationMs,
  }));
  const validationEvidence = {
    operationId: latest.operationId,
    kind: "fast" as const,
    sandboxId: latest.sandboxId,
    freshSandbox: true,
    startedAt: latest.startedAt,
    completedAt: latest.completedAt,
    checks,
    status: "passed" as const,
    failureFingerprint: null,
    binding: cloneJson(latest.binding),
  };
  const fastValidation: CodeValidationReceiptV1 = {
    version: 1,
    kindName: "code_validation",
    id: latest.id,
    ...validationEvidence,
    fingerprint: await sha256Fingerprint(validationEvidence),
  };
  const checkpoint: CodeRepairCheckpointV1 = {
    version: 1,
    id: codeRepairCheckpointIdV1(request),
    request,
    requestFingerprint: await sha256Fingerprint(request),
    sequence: source.sequence,
    stage: "diff_preview",
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    initialEdit: {
      operationId: `background-edit-${source.previewDiff!.fingerprint.slice(7, 31)}`,
      summary: PREPARED_BACKGROUND_CODE_EDIT_SUMMARY_V1,
      changedPaths: [...source.previewDiff!.changedPaths],
      expectedArtifacts: [],
      appliedAt: source.initialEdit!.appliedAt,
    },
    attempts: [{ cycle: 1, fastValidation }],
    failureHistory: [],
    validationHistory: [fastValidation],
    approvalHistory: [],
    previewDiff: cloneJson(source.previewDiff!),
  };
  return parseCodeRepairCheckpointV1(checkpoint);
}

function retimeSandboxAction(
  source: PreparedSandboxActionV2,
  preparedAt: string,
  expiresAt: string,
): PreparedSandboxActionV2 {
  const parsed = parsePreparedSandboxActionV2(source);
  const { id: _id, payloadFingerprint: _fingerprint, ...core } = parsed;
  const retimed = { ...core, preparedAt, expiresAt };
  const payloadFingerprint = sha256Canonical(retimed);
  return parsePreparedSandboxActionV2({
    ...retimed,
    id: `sandbox-action-${payloadFingerprint.slice(7, 39)}`,
    payloadFingerprint,
  });
}

function approvalInput(
  value: PrepareBackgroundValidationCommitApprovalInputV1,
): PrepareBackgroundValidationCommitApprovalInputV1 {
  const record = exactRecord(value, [
    "repairCheckpointId", "runId", "toolCallId",
  ], "background Code approval input");
  return {
    repairCheckpointId: checkpointIdentifier(record.repairCheckpointId),
    runId: identifier(record.runId, "run id"),
    toolCallId: identifier(record.toolCallId, "tool call id"),
  };
}

function parseConsumedAuthority(
  value: ConsumedBackgroundCodeGrantV1,
  action: PreparedActionV1,
  now: string,
): ConsumedBackgroundCodeGrantV1 {
  const record = exactRecord(value, [
    "id", "authorityFingerprint", "actionFingerprint", "consumedAt", "expiresAt",
  ], "consumed background Code grant");
  const result = {
    id: identifier(record.id, "consumed grant id"),
    authorityFingerprint: fingerprint(record.authorityFingerprint, "authority fingerprint"),
    actionFingerprint: fingerprint(record.actionFingerprint, "action fingerprint"),
    consumedAt: timestamp(record.consumedAt, "authority consumedAt"),
    expiresAt: timestamp(record.expiresAt, "authority expiresAt"),
  };
  if (
    result.actionFingerprint !== action.payloadFingerprint ||
    Date.parse(result.consumedAt) < Date.parse(action.preparedAt) ||
    Date.parse(result.consumedAt) > Date.parse(now) ||
    Date.parse(result.expiresAt) <= Date.parse(now)
  ) {
    fail(
      "background_code_consumed_authority_invalid",
      "The consumed grant is not bound to the exact current prepared action and lifetime.",
      "Approve and consume a fresh exact action grant.",
    );
  }
  return result;
}

function parseBackgroundAuthorization(
  value: BackgroundAuthorizationV1,
  now: string,
): BackgroundAuthorizationV1 {
  const record = exactRecord(value, [
    "version", "grantId", "fingerprint", "authorizedAt", "expiresAt",
  ], "background authorization");
  const result: BackgroundAuthorizationV1 = {
    version: record.version as 1,
    grantId: identifier(record.grantId, "background grant id"),
    fingerprint: fingerprint(record.fingerprint, "background authorization fingerprint"),
    authorizedAt: timestamp(record.authorizedAt, "background authorizedAt"),
    expiresAt: record.expiresAt === null
      ? null
      : timestamp(record.expiresAt, "background authorization expiresAt"),
  };
  if (
    result.version !== 1 ||
    Date.parse(result.authorizedAt) > Date.parse(now) ||
    (result.expiresAt !== null && Date.parse(result.expiresAt) <= Date.parse(now))
  ) {
    fail(
      "background_code_background_authorization_invalid",
      "Background authorization is invalid or expired.",
      "Authorize the exact current mission graph node again.",
    );
  }
  return result;
}

function blockedResult(
  error: unknown,
): Extract<
  PrepareBackgroundValidationCommitApprovalResultV1,
  { status: "blocked" }
> {
  if (error instanceof PreparedBackgroundCodeResolutionErrorV1) {
    return {
      status: "blocked",
      code: error.code,
      message: error.message,
      requiredAction: error.requiredAction,
    };
  }
  return {
    status: "blocked",
    code: "background_code_trusted_state_invalid",
    message:
      "The Code extension could not verify the exact durable checkpoint, workspace, profile, sandbox, and diff proof chain.",
    requiredAction:
      "Inspect the foreground Code repair checkpoint and prepare a fresh exact action.",
  };
}

class PreparedBackgroundCodeResolutionErrorV1 extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requiredAction: string | null,
  ) {
    super(message);
    this.name = "PreparedBackgroundCodeResolutionErrorV1";
  }
}

function fail(code: string, message: string, requiredAction: string | null): never {
  throw new PreparedBackgroundCodeResolutionErrorV1(
    code,
    message,
    requiredAction,
  );
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail("background_code_contract_invalid", `${label} must be an object.`, null);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    fail("background_code_contract_invalid", `${label} must be a plain object.`, null);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    fail(
      "background_code_contract_invalid",
      `${label} does not match its closed contract.`,
      null,
    );
  }
  return record;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/u.test(value)
  ) {
    fail("background_code_contract_invalid", `${label} is invalid.`, null);
  }
  return value;
}

function checkpointIdentifier(value: unknown): string {
  const result = identifier(value, "repair checkpoint id");
  if (!result.startsWith("code-repair:")) {
    fail(
      "background_code_checkpoint_identity_invalid",
      "repairCheckpointId is not a durable Code repair checkpoint identity.",
      null,
    );
  }
  return result;
}

function stringArg(value: JsonValueV1 | undefined, label: string): string {
  return identifier(value, label);
}

function fingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    fail("background_code_contract_invalid", `${label} is invalid.`, null);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    fail("background_code_contract_invalid", `${label} is invalid.`, null);
  }
  return value;
}

function canonicalTime(value: Date, label: string): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    fail("background_code_clock_invalid", `${label} is invalid.`, null);
  }
  return value.toISOString();
}

function latestTimestamp(...values: string[]): string {
  return new Date(Math.max(...values.map((value) => Date.parse(value)))).toISOString();
}

function earliestTimestamp(...values: Array<string | null>): string {
  return new Date(
    Math.min(...values.filter((value): value is string => value !== null)
      .map((value) => Date.parse(value))),
  ).toISOString();
}

function validationHashSummary(value: string): string {
  return `sha256=${sha256Text(value)};bytes=${Buffer.byteLength(value, "utf8")}`;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function pathAtOrBelow(root: string, candidate: string): boolean {
  return root === "." || candidate === root || candidate.startsWith(`${root}/`);
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string) =>
    path.resolve(value).replace(/[\\/]+$/u, "").toLowerCase();
  return normalize(left) === normalize(right);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
