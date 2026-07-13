import * as os from "node:os";
import * as path from "node:path";

import type { Plugin } from "obsidian";
import type {
  JsonValueV1,
  PreparedActionV1,
} from "@agentic-researcher/core-api";
import {
  GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
  GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1,
  GITHUB_PULL_REQUEST_MERGE_OPERATION_V1,
  GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1,
  GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1,
  canonicalMissionGraphId,
  createPreparedBackgroundGitHubActionV1,
  fingerprintBackgroundGitHubValueV1,
  parseHostApprovalReceiptV1,
  parsePreparedBackgroundGitHubActionV1,
  type ConsumedBackgroundGitHubGrantV1,
  type HostApprovalReceiptV1,
  type PreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubOperationV1,
  type PreparedBackgroundGitHubPackageIdentityV1,
  type PreparedBackgroundGitHubToolNameV1,
} from "@agentic-researcher/core-api";
import {
  canonicalJson,
  parseMissionGraphV3,
  prepareBackgroundGitHubCompanionJobIdentityV1,
  sha256Fingerprint,
  type BackgroundAuthorizationV1,
  type MissionGraphV3,
  type MissionNodeV3,
} from "@agentic-researcher/headless-runtime";

import type { RepositoryProfileV2 } from "../../code/repositories";
import { parseRepositoryProfileV2 } from "../../code/repositories";
import { withPluginDataLock } from "../../shared/softDependency";
import {
  parseGitHubCredentialV1,
  type GitHubCredentialV1,
} from "../../../src/integrations/github/GitHubAuth";
import {
  parseGitHubPublicationCheckpointNamespaceV1,
  parseGitHubPublicationCheckpointV1,
  type GitHubPublicationCheckpointNamespaceV1,
} from "../../../src/integrations/github/GitHubPublicationCheckpointStore";
import type {
  GitHubPublicationCheckpointV1,
} from "../../../src/integrations/github/GitHubPublicationWorkflow";
import {
  assertTrustedGitHubBindingMatchesProfileV1,
  parseTrustedGitHubRepositoryBindingV1,
  type TrustedGitHubRepositoryBindingV1,
} from "../../../src/integrations/github/TrustedGitHubRepositoryBindingV1";
import {
  parseVerifiedCodePublicationHandoffV1,
  type VerifiedCodePublicationHandoffV1,
} from "../../../packages/core-api/src/verifiedCodePublicationHandoffV1";
import {
  createBackgroundGitHubRepositoryProofV1,
  createPreparedBackgroundGitHubPackageIdentityFromPackageV1,
  createPreparedBackgroundGitHubPackageV1,
  PreparedBackgroundGitHubPackageStoreV1,
  type BackgroundGitHubPullRequestDocumentV1,
  type PreparedBackgroundGitHubPackagePersistenceReceiptV1,
} from "../background/PreparedBackgroundGitHubPackageStoreV1";
import {
  parseBackgroundGitHubVerifiedResultV1,
  type BackgroundGitHubVerifiedResultV1,
} from "../../../packages/core-api/src/backgroundGitHubVerifiedResultV1";
import { createPreparedBackgroundGitHubToolDescriptorV1 } from "./PreparedBackgroundGitHubToolsV1";

const HOST_STATE_KEY = "backgroundGitHubHostStateV1";
const APPROVAL_TTL_MS = 15 * 60_000;
const MIN_REMAINING_AUTHORITY_MS = 10_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const GIT_SHA = /^[0-9a-f]{40}$/u;

export interface BackgroundGitHubRemoteBranchObservationV1 {
  version: 1;
  branch: string;
  remoteSha: string | null;
  handoffFingerprint: string;
  localHeadSha: string;
  observedAt: string;
  fingerprint: string;
}

export interface BackgroundGitHubTrustedBindingStateV1 {
  version: 1;
  binding: TrustedGitHubRepositoryBindingV1;
  completionProof: "draft_pr" | "merged_pr";
  remoteBranch: BackgroundGitHubRemoteBranchObservationV1;
  synchronizedAt: string;
  fingerprint: string;
}

export interface BackgroundGitHubPreparedDocumentV1
  extends BackgroundGitHubPullRequestDocumentV1 {
  version: 1;
  publicationId: string;
  repositoryProfileKey: string;
  preparedAt: string;
  fingerprint: string;
}

export interface BackgroundGitHubHostStateV1 {
  version: 1;
  revision: number;
  credential: GitHubCredentialV1 | null;
  bindings: Record<string, BackgroundGitHubTrustedBindingStateV1>;
  checkpoints: GitHubPublicationCheckpointNamespaceV1;
  documents: Record<string, BackgroundGitHubPreparedDocumentV1>;
  updatedAt: string;
  fingerprint: string;
}

export interface SynchronizeBackgroundGitHubHostStateInputV1 {
  credential: GitHubCredentialV1;
  binding: TrustedGitHubRepositoryBindingV1;
  completionProof: "draft_pr" | "merged_pr";
  remoteBranch: Omit<BackgroundGitHubRemoteBranchObservationV1, "version" | "fingerprint">;
  checkpoints: GitHubPublicationCheckpointNamespaceV1;
}

export interface BackgroundGitHubMissionBindingV1 {
  id: string;
  kind: "trusted_repository_publication";
  destinationFingerprint: string;
  allowedEffects: ["read", "external_action"];
}

export type PrepareBackgroundGitHubApprovalResultV1 =
  | { status: "ready"; preparedAction: PreparedActionV1 }
  | BackgroundGitHubHostBlockedV1;

export type SealBackgroundGitHubPackageResultV1 =
  | {
      status: "ready";
      action: PreparedBackgroundGitHubActionV1;
      packageIdentity: PreparedBackgroundGitHubPackageIdentityV1;
      packagePersistenceReceipt: PreparedBackgroundGitHubPackagePersistenceReceiptV1;
    }
  | BackgroundGitHubHostBlockedV1;

export interface BackgroundGitHubHostBlockedV1 {
  status: "blocked";
  code: string;
  message: string;
  requiredAction: string | null;
}

export interface PrepareBackgroundGitHubApprovalInputV1 {
  toolName: PreparedBackgroundGitHubToolNameV1;
  args: Record<string, unknown>;
  runId: string;
  toolCallId: string;
}

export interface SealBackgroundGitHubPackageInputV1 {
  graph: MissionGraphV3;
  authorization: BackgroundAuthorizationV1;
  preparedAction: PreparedActionV1;
  authority: Omit<
    ConsumedBackgroundGitHubGrantV1,
    "requiredConfirmations" | "confirmationReceipts"
  >;
  hostApprovalReceipts: HostApprovalReceiptV1[];
}

export interface ApplyVerifiedBackgroundGitHubResultInputV1 {
  action: PreparedBackgroundGitHubActionV1;
  packageIdentity: PreparedBackgroundGitHubPackageIdentityV1;
  result: BackgroundGitHubVerifiedResultV1;
  verifiedReceiptId: string;
  verifiedReceiptFingerprint: string;
}

interface CodePublicationBridgeV1 {
  resolveVerifiedCodePublicationHandoff(
    profileKey: string,
  ): Promise<VerifiedCodePublicationHandoffV1 | null>;
  resolveTrustedRepositoryProfile(
    profileKey: string,
  ): Promise<RepositoryProfileV2 | null>;
}

interface ResolvedOperationStateV1 {
  hostState: BackgroundGitHubHostStateV1;
  bindingState: BackgroundGitHubTrustedBindingStateV1;
  credential: GitHubCredentialV1;
  profile: RepositoryProfileV2;
  handoff: VerifiedCodePublicationHandoffV1;
  checkpoint: GitHubPublicationCheckpointV1;
  document: BackgroundGitHubPreparedDocumentV1 | null;
  logical: LogicalGitHubActionV1;
  stateFingerprint: string;
}

interface LogicalGitHubActionV1 {
  toolName: PreparedBackgroundGitHubToolNameV1;
  operation: PreparedBackgroundGitHubOperationV1;
  profileKey: string;
  publicationId: string;
  title: string | null;
  body: string | null;
}

export class PreparedBackgroundGitHubHostV1 {
  private state: BackgroundGitHubHostStateV1 | null = null;
  private readonly packages: PreparedBackgroundGitHubPackageStoreV1;
  private readonly now: () => Date;

  constructor(
    private readonly plugin: Plugin,
    options: { applicationDataRoot?: string; now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.packages = new PreparedBackgroundGitHubPackageStoreV1({
      applicationDataRoot:
        options.applicationDataRoot ?? defaultIntegrationsApplicationDataRootV1(),
      now: this.now,
    });
  }

  async initialize(): Promise<void> {
    this.state = await withPluginDataLock(this.plugin, async () => {
      const topLevel = topLevelRecord(await this.plugin.loadData());
      if (topLevel[HOST_STATE_KEY] !== undefined) {
        return parseBackgroundGitHubHostStateV1(topLevel[HOST_STATE_KEY]);
      }
      const initial = createInitialHostState(this.now().toISOString());
      await this.plugin.saveData({
        ...topLevel,
        schemaVersion: topLevel.schemaVersion ?? 1,
        [HOST_STATE_KEY]: initial,
      });
      return parseBackgroundGitHubHostStateV1(
        topLevelRecord(await this.plugin.loadData())[HOST_STATE_KEY],
      );
    });
  }

  readState(): BackgroundGitHubHostStateV1 {
    return clone(this.requireState());
  }

  async synchronize(
    input: SynchronizeBackgroundGitHubHostStateInputV1,
  ): Promise<{ revision: number; fingerprint: string; readbackVerified: true }> {
    const credential = parseGitHubCredentialV1(input.credential);
    const binding = parseTrustedGitHubRepositoryBindingV1(input.binding);
    if (
      binding.verifiedAccountId !== credential.account.id ||
      binding.verifiedAccountLogin !== credential.account.login
    ) {
      throw new Error(
        "Trusted GitHub binding account does not match the opaque credential identity.",
      );
    }
    const remoteBranch = createRemoteBranchObservation(input.remoteBranch);
    if (remoteBranch.branch.indexOf("codex/") !== 0) {
      throw new Error("Background GitHub accepts only agent-owned codex/ branches.");
    }
    const checkpoints = parseGitHubPublicationCheckpointNamespaceV1(
      input.checkpoints,
    );
    const bindingState = createBindingState({
      binding,
      completionProof: input.completionProof,
      remoteBranch,
      synchronizedAt: this.now().toISOString(),
    });
    const current = this.requireState();
    const mergedCheckpoints = mergeCheckpointNamespaces(
      current.checkpoints,
      checkpoints,
    );
    const next = createHostState({
      revision: current.revision + 1,
      credential,
      bindings: {
        ...current.bindings,
        [binding.repositoryProfileKey]: bindingState,
      },
      checkpoints: mergedCheckpoints,
      documents: current.documents,
      updatedAt: this.now().toISOString(),
    });
    const readback = await this.persistState(next);
    return {
      revision: readback.revision,
      fingerprint: readback.fingerprint,
      readbackVerified: true,
    };
  }

  async resolveMissionBinding(input: {
    objective: string;
    toolName: PreparedBackgroundGitHubToolNameV1;
  }): Promise<BackgroundGitHubMissionBindingV1 | null> {
    createPreparedBackgroundGitHubToolDescriptorV1(input.toolName);
    const objective = boundedText(input.objective, "mission objective", 1, 24_000);
    const state = this.requireState();
    if (!state.credential) return null;
    const candidates = Object.keys(state.bindings)
      .sort()
      .filter((profileKey) => containsLogicalIdentifier(objective, profileKey));
    const profileKey =
      candidates.length === 1
        ? candidates[0]
        : candidates.length === 0 && Object.keys(state.bindings).length === 1
          ? Object.keys(state.bindings)[0]
          : null;
    if (!profileKey) return null;
    return missionBindingFor(state, state.bindings[profileKey]);
  }

  async prepareApproval(
    input: PrepareBackgroundGitHubApprovalInputV1,
  ): Promise<PrepareBackgroundGitHubApprovalResultV1> {
    try {
      const logical = parseLogicalAction(input.toolName, input.args);
      const preparedAt = this.now().toISOString();
      const expiresAt = new Date(
        Date.parse(preparedAt) + APPROVAL_TTL_MS,
      ).toISOString();
      const resolved = await this.resolveOperationState(logical, {
        allowCreateCheckpoint: true,
        allowStoreDocument: true,
      });
      return {
        status: "ready",
        preparedAction: buildPreparedApproval({
          runId: identifier(input.runId, "run id"),
          toolCallId: identifier(input.toolCallId, "tool call id"),
          resolved,
          preparedAt,
          expiresAt,
        }),
      };
    } catch (error) {
      return blocked(error);
    }
  }

  async sealPackage(
    input: SealBackgroundGitHubPackageInputV1,
  ): Promise<SealBackgroundGitHubPackageResultV1> {
    try {
      const now = this.now().toISOString();
      const preparedAction = parsePreparedApproval(input.preparedAction, now);
      const logical = logicalFromPreparedAction(preparedAction);
      const resolved = await this.resolveOperationState(logical, {
        allowCreateCheckpoint: false,
        allowStoreDocument: false,
      });
      const rebuilt = buildPreparedApproval({
        runId: preparedAction.runId,
        toolCallId: preparedAction.toolCallId,
        resolved,
        preparedAt: preparedAction.preparedAt,
        expiresAt: preparedAction.expiresAt,
      });
      if (canonicalJson(rebuilt) !== canonicalJson(preparedAction)) {
        fail(
          "background_github_prepared_state_drift",
          "The repository binding, account, branch, checkpoint, code handoff, PR document, or policy changed after approval preparation.",
          "Read the current GitHub state and approve a fresh exact action.",
        );
      }
      const graph = await parseMissionGraphV3(input.graph);
      const node = selectAuthorizedNode(graph, preparedAction, resolved);
      const descriptor = createPreparedBackgroundGitHubToolDescriptorV1(
        logical.toolName,
      );
      const descriptorFingerprint = await sha256Fingerprint(descriptor);
      const nodeFingerprint = await sha256Fingerprint(node);
      const requiredConfirmations = isMergeTool(logical.toolName) ? 2 : 1;
      const receipts = input.hostApprovalReceipts.map((receipt) =>
        parseHostApprovalReceiptV1(receipt),
      );
      const consumedAt = timestamp(input.authority.consumedAt, "grant consumedAt");
      const authorityExpiresAt = timestamp(
        input.authority.expiresAt,
        "grant expiresAt",
      );
      if (
        input.authority.actionFingerprint !== preparedAction.payloadFingerprint ||
        receipts.length !== requiredConfirmations
      ) {
        fail(
          "background_github_consumed_authority_invalid",
          "Background GitHub requires the exact consumed grant and every signed approval gesture.",
          "Approve the exact GitHub action again from the normal approval UI.",
        );
      }
      const authority: ConsumedBackgroundGitHubGrantV1 = {
        id: identifier(input.authority.id, "grant id"),
        authorityFingerprint: sha(
          input.authority.authorityFingerprint,
          "grant authority fingerprint",
        ),
        actionFingerprint: preparedAction.payloadFingerprint,
        consumedAt,
        expiresAt: authorityExpiresAt,
        requiredConfirmations: requiredConfirmations as 1 | 2,
        confirmationReceipts: receipts,
      };
      const preparedAt = latestTimestamp(
        preparedAction.preparedAt,
        consumedAt,
        input.authorization.authorizedAt,
      );
      const expiresAt = earliestTimestamp(
        preparedAction.expiresAt,
        authorityExpiresAt,
        input.authorization.expiresAt,
      );
      if (Date.parse(expiresAt) - Date.parse(now) < MIN_REMAINING_AUTHORITY_MS) {
        fail(
          "background_github_authority_expired",
          "Too little exact approval lifetime remains to persist and dispatch the GitHub package safely.",
          "Approve a fresh exact GitHub action.",
        );
      }
      const graphBinding = graph.capabilityEnvelope.bindings[
        node.destination!.bindingId
      ];
      const actionSeed = {
        version: 1,
        missionId: graph.missionId,
        graphRevision: graph.revision,
        nodeId: node.id,
        preparedActionFingerprint: preparedAction.payloadFingerprint,
        authorityFingerprint: authority.authorityFingerprint,
        authorizationFingerprint: input.authorization.fingerprint,
        stateFingerprint: resolved.stateFingerprint,
      };
      const actionIdentity = fingerprintBackgroundGitHubValueV1(actionSeed);
      const action = createPreparedBackgroundGitHubActionV1({
        id: `background-github-${actionIdentity.slice(7, 39)}`,
        missionId: graph.missionId,
        graphRevision: graph.revision,
        capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
        nodeId: node.id,
        nodeFingerprint,
        executionHost: node.executionHost as "companion" | "headless_runtime",
        operation: logical.operation,
        toolName: logical.toolName,
        descriptorFingerprint,
        preparedActionId: preparedAction.id,
        preparedActionFingerprint: preparedAction.payloadFingerprint,
        binding: {
          id: graphBinding.id,
          destinationFingerprint: graphBinding.destinationFingerprint,
          repositoryBindingKey: resolved.bindingState.binding.key,
          repositoryBindingFingerprint:
            resolved.bindingState.binding.fingerprint,
          repositoryProfileKey: resolved.profile.key,
          repositoryProfileFingerprint:
            resolved.bindingState.binding.repositoryProfileFingerprint,
          owner: resolved.bindingState.binding.owner,
          repository: resolved.bindingState.binding.repository,
          repositoryId: resolved.bindingState.binding.repositoryId,
          verifiedAccountId: resolved.credential.account.id,
          verifiedAccountLogin: resolved.credential.account.login,
          credentialReferenceId: resolved.credential.tokenReferenceId,
        },
        authority,
        payload: githubPayload(resolved, preparedAction.payloadFingerprint),
        idempotencyKey: actionIdentity,
        reconciliationKey: actionIdentity,
        preparedAt,
        expiresAt,
      } as Parameters<typeof createPreparedBackgroundGitHubActionV1>[0]);
      const jobIdentity = await prepareBackgroundGitHubCompanionJobIdentityV1({
        graph,
        nodeId: node.id,
        authorization: input.authorization,
        preparedBackgroundGitHubAction: action,
        now: new Date(now),
      });
      const proof = createBackgroundGitHubRepositoryProofV1({
        repositoryProfileKey: resolved.profile.key,
        repositoryProfileFingerprint:
          resolved.bindingState.binding.repositoryProfileFingerprint,
        canonicalRepositoryRoot: resolved.profile.repositoryRoot,
        defaultBranch: resolved.profile.defaultBranch,
        requiredChecks: resolved.profile.requiredGitHubChecks,
        mergeMethod: resolved.profile.mergePolicy.defaultMethod,
      });
      const packageValue = createPreparedBackgroundGitHubPackageV1({
        jobId: jobIdentity.id,
        backgroundAuthorizationFingerprint: input.authorization.fingerprint,
        action,
        repositoryBinding: resolved.bindingState.binding,
        repositoryProof: proof,
        checkpoint: resolved.checkpoint,
        verifiedCodeHandoff:
          logical.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1 ||
          logical.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1
            ? resolved.handoff
            : null,
        pullRequestDocument:
          logical.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1
            ? projectBackgroundGitHubPullRequestDocumentV1(resolved.document)
            : null,
      });
      const persisted = await this.packages.persist(packageValue);
      if (
        persisted.package.fingerprint !== packageValue.fingerprint ||
        persisted.receipt.readbackVerified !== true
      ) {
        throw new Error(
          "Prepared background GitHub package failed exact persistence readback.",
        );
      }
      return {
        status: "ready",
        action,
        packageIdentity:
          createPreparedBackgroundGitHubPackageIdentityFromPackageV1(
            persisted.package,
          ),
        packagePersistenceReceipt: persisted.receipt,
      };
    } catch (error) {
      return blocked(error);
    }
  }

  async applyVerifiedResult(
    input: ApplyVerifiedBackgroundGitHubResultInputV1,
  ): Promise<GitHubPublicationCheckpointV1> {
    const action = parsePreparedBackgroundGitHubActionV1(input.action);
    const packageIdentity = input.packageIdentity;
    const result = parseBackgroundGitHubVerifiedResultV1(input.result);
    if (
      packageIdentity.actionFingerprint !== action.fingerprint ||
      packageIdentity.preparedActionFingerprint !==
        action.preparedActionFingerprint ||
      packageIdentity.operation !== action.operation ||
      packageIdentity.publicationId !== action.payload.publicationId ||
      packageIdentity.repositoryBindingFingerprint !==
        action.binding.repositoryBindingFingerprint ||
      result.operation !== action.operation ||
      result.publicationId !== action.payload.publicationId ||
      result.repositoryBindingFingerprint !==
        action.binding.repositoryBindingFingerprint ||
      result.verifiedAccountId !== action.binding.verifiedAccountId ||
      !SHA256.test(input.verifiedReceiptFingerprint)
    ) {
      throw new Error(
        "Verified GitHub result drifted from its exact action, package, account, or receipt lineage.",
      );
    }
    const current = this.requireState().checkpoints.checkpoints[
      action.payload.publicationId
    ];
    if (!current) {
      throw new Error("Verified GitHub result has no integrations-owned checkpoint.");
    }
    const receiptIds = current.receiptIds.includes(input.verifiedReceiptId)
      ? current.receiptIds
      : [...current.receiptIds, identifier(input.verifiedReceiptId, "receipt id")];
    const next = projectVerifiedBackgroundGitHubCheckpointV1(
      current,
      action,
      result,
      receiptIds,
    );
    if (
      fingerprintBackgroundGitHubValueV1(next) ===
      fingerprintBackgroundGitHubValueV1(current)
    ) {
      return clone(current);
    }
    await this.persistCheckpoint(next);
    return clone(next);
  }

  private async resolveOperationState(
    logical: LogicalGitHubActionV1,
    options: { allowCreateCheckpoint: boolean; allowStoreDocument: boolean },
  ): Promise<ResolvedOperationStateV1> {
    let hostState = this.requireState();
    const credential = hostState.credential;
    const bindingState = hostState.bindings[logical.profileKey];
    if (!credential || !bindingState) {
      fail(
        "background_github_binding_unavailable",
        "The integrations extension has no exact synchronized repository binding and opaque credential identity for this profile.",
        "Reconnect GitHub, re-verify the trusted repository profile, and retry.",
      );
    }
    const bridge = this.getCodeBridge();
    const [profileValue, handoffValue] = await Promise.all([
      bridge.resolveTrustedRepositoryProfile(logical.profileKey),
      bridge.resolveVerifiedCodePublicationHandoff(logical.profileKey),
    ]);
    if (!profileValue || !handoffValue) {
      fail(
        "background_github_code_handoff_unavailable",
        "The exact RepositoryProfileV2 and verified local commit handoff are unavailable.",
        "Complete fresh local validation and commit in the Code extension.",
      );
    }
    const profile = parseRepositoryProfileV2(profileValue);
    const handoff = parseVerifiedCodePublicationHandoffV1(handoffValue);
    assertTrustedGitHubBindingMatchesProfileV1(bindingState.binding, profile);
    if (
      handoff.repositoryProfileKey !== profile.key ||
      handoff.repositoryProfileFingerprint !==
        bindingState.binding.repositoryProfileFingerprint ||
      handoff.baseBranch !== bindingState.binding.defaultBranch ||
      bindingState.remoteBranch.branch !== handoff.branch ||
      bindingState.remoteBranch.handoffFingerprint !== handoff.fingerprint ||
      bindingState.remoteBranch.localHeadSha !== handoff.commitSha
    ) {
      fail(
        "background_github_code_handoff_drift",
        "The live verified Code handoff no longer matches the synchronized repository and branch readback.",
        "Re-synchronize the exact trusted GitHub binding and approve again.",
      );
    }
    let checkpoint = hostState.checkpoints.checkpoints[logical.publicationId];
    if (!checkpoint && options.allowCreateCheckpoint) {
      if (logical.operation !== GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
        fail(
          "background_github_checkpoint_unavailable",
          "This GitHub action has no durable predecessor checkpoint.",
          "Run and reconcile the verified branch-push node first.",
        );
      }
      checkpoint = createLocalVerifiedCheckpoint({
        logical,
        bindingState,
        handoff,
        now: this.now().toISOString(),
      });
      await this.persistCheckpoint(checkpoint);
      hostState = this.requireState();
    }
    if (!checkpoint) {
      fail(
        "background_github_checkpoint_unavailable",
        "The exact durable GitHub publication checkpoint is unavailable.",
        "Resume the predecessor publication node and reconcile its verified receipt.",
      );
    }
    checkpoint = parseGitHubPublicationCheckpointV1(checkpoint);
    validateCheckpointForLogicalAction(checkpoint, logical, handoff, bindingState);
    let document: BackgroundGitHubPreparedDocumentV1 | null =
      hostState.documents[logical.publicationId] ?? null;
    if (
      logical.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
      options.allowStoreDocument
    ) {
      const proposed = createPreparedDocument(logical, this.now().toISOString());
      if (document && document.fingerprint !== proposed.fingerprint) {
        document = proposed;
      } else {
        document = document ?? proposed;
      }
      if (
        hostState.documents[logical.publicationId]?.fingerprint !==
        document.fingerprint
      ) {
        await this.persistDocument(document);
        hostState = this.requireState();
      }
    }
    if (logical.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
      if (
        !document ||
        document.repositoryProfileKey !== logical.profileKey ||
        document.title !== logical.title ||
        document.body !== logical.body
      ) {
        fail(
          "background_github_document_drift",
          "The durable pull-request document no longer matches the approved title and body.",
          "Preview and approve a fresh draft pull-request action.",
        );
      }
    } else {
      document = null;
    }
    const stateFingerprint = fingerprintBackgroundGitHubValueV1({
      version: 1,
      bindingStateFingerprint: bindingState.fingerprint,
      credentialId: credential.credentialId,
      credentialReferenceId: credential.tokenReferenceId,
      profileFingerprint: bindingState.binding.repositoryProfileFingerprint,
      handoffFingerprint: handoff.fingerprint,
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      documentFingerprint: document?.fingerprint ?? null,
      logical,
    });
    return {
      hostState,
      bindingState,
      credential,
      profile,
      handoff,
      checkpoint,
      document,
      logical,
      stateFingerprint,
    };
  }

  private getCodeBridge(): CodePublicationBridgeV1 {
    const plugins = (this.plugin.app as unknown as {
      plugins?: { plugins?: Record<string, unknown> };
    }).plugins?.plugins;
    const code = plugins?.["agentic-researcher-code"] as
      | Partial<CodePublicationBridgeV1>
      | undefined;
    if (
      typeof code?.resolveTrustedRepositoryProfile !== "function" ||
      typeof code.resolveVerifiedCodePublicationHandoff !== "function"
    ) {
      fail(
        "background_github_code_extension_unavailable",
        "The compatible Code extension publication bridge is unavailable.",
        "Enable the Agentic Researcher Code extension and resume.",
      );
    }
    return code as CodePublicationBridgeV1;
  }

  private async persistCheckpoint(
    checkpointValue: GitHubPublicationCheckpointV1,
  ): Promise<void> {
    const checkpoint = parseGitHubPublicationCheckpointV1(checkpointValue);
    const current = this.requireState();
    const nextNamespace = parseGitHubPublicationCheckpointNamespaceV1({
      version: 1,
      revision: current.checkpoints.revision + 1,
      checkpoints: {
        ...current.checkpoints.checkpoints,
        [checkpoint.publicationId]: checkpoint,
      },
    });
    await this.persistState(
      createHostState({
        revision: current.revision + 1,
        credential: current.credential,
        bindings: current.bindings,
        checkpoints: nextNamespace,
        documents: current.documents,
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  private async persistDocument(
    document: BackgroundGitHubPreparedDocumentV1,
  ): Promise<void> {
    const parsed = parsePreparedDocument(document);
    const current = this.requireState();
    await this.persistState(
      createHostState({
        revision: current.revision + 1,
        credential: current.credential,
        bindings: current.bindings,
        checkpoints: current.checkpoints,
        documents: {
          ...current.documents,
          [parsed.publicationId]: parsed,
        },
        updatedAt: this.now().toISOString(),
      }),
    );
  }

  private async persistState(
    value: BackgroundGitHubHostStateV1,
  ): Promise<BackgroundGitHubHostStateV1> {
    const next = parseBackgroundGitHubHostStateV1(value);
    const readback = await withPluginDataLock(this.plugin, async () => {
      const topLevel = topLevelRecord(await this.plugin.loadData());
      const current =
        topLevel[HOST_STATE_KEY] === undefined
          ? null
          : parseBackgroundGitHubHostStateV1(topLevel[HOST_STATE_KEY]);
      if (current && next.revision !== current.revision + 1) {
        throw new Error(
          "Integrations GitHub host state changed before it could be saved.",
        );
      }
      const migrationFingerprint = fingerprintBackgroundGitHubValueV1(
        topLevel.extensionStateMigration ?? null,
      );
      await this.plugin.saveData({
        ...topLevel,
        schemaVersion: topLevel.schemaVersion ?? 1,
        [HOST_STATE_KEY]: next,
      });
      const persistedTopLevel = topLevelRecord(await this.plugin.loadData());
      if (
        fingerprintBackgroundGitHubValueV1(
          persistedTopLevel.extensionStateMigration ?? null,
        ) !== migrationFingerprint
      ) {
        throw new Error(
          "GitHub host persistence changed the integrations migration snapshot.",
        );
      }
      const persisted = parseBackgroundGitHubHostStateV1(
        persistedTopLevel[HOST_STATE_KEY],
      );
      if (persisted.fingerprint !== next.fingerprint) {
        throw new Error(
          "Integrations GitHub host state failed exact persistence readback.",
        );
      }
      return persisted;
    });
    this.state = readback;
    return clone(readback);
  }

  private requireState(): BackgroundGitHubHostStateV1 {
    if (!this.state) {
      throw new Error("Integrations GitHub host state is not initialized.");
    }
    return this.state;
  }
}

export function defaultIntegrationsApplicationDataRootV1(): string {
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
      "AgenticResearcher",
      "integrations",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "AgenticResearcher",
      "integrations",
    );
  }
  return path.join(
    process.env.XDG_DATA_HOME ?? path.join(os.homedir(), ".local", "share"),
    "agentic-researcher",
    "integrations",
  );
}

export function parseBackgroundGitHubHostStateV1(
  value: unknown,
): BackgroundGitHubHostStateV1 {
  const record = exactRecord(
    value,
    [
      "version",
      "revision",
      "credential",
      "bindings",
      "checkpoints",
      "documents",
      "updatedAt",
      "fingerprint",
    ],
    "background GitHub host state",
  );
  if (record.version !== 1) {
    throw new Error("Unsupported background GitHub host-state version.");
  }
  const bindingsRecord = plainRecord(record.bindings, "GitHub host bindings");
  const bindings = Object.fromEntries(
    Object.entries(bindingsRecord).map(([key, binding]) => {
      const profileKey = identifier(key, "repository profile key");
      const parsed = parseBindingState(binding);
      if (parsed.binding.repositoryProfileKey !== profileKey) {
        throw new Error("GitHub host binding key does not match its profile.");
      }
      return [profileKey, parsed];
    }),
  );
  const documentRecord = plainRecord(record.documents, "GitHub PR documents");
  const documents = Object.fromEntries(
    Object.entries(documentRecord).map(([key, document]) => {
      const publicationId = identifier(key, "publication id");
      const parsed = parsePreparedDocument(document);
      if (parsed.publicationId !== publicationId) {
        throw new Error("GitHub document key does not match its publication.");
      }
      return [publicationId, parsed];
    }),
  );
  const evidence = {
    version: 1 as const,
    revision: integer(record.revision, "host-state revision", 0),
    credential:
      record.credential === null
        ? null
        : parseGitHubCredentialV1(record.credential),
    bindings,
    checkpoints: parseGitHubPublicationCheckpointNamespaceV1(record.checkpoints),
    documents,
    updatedAt: timestamp(record.updatedAt, "host-state updatedAt"),
  };
  const observed = sha(record.fingerprint, "host-state fingerprint");
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    throw new Error("Background GitHub host-state fingerprint is invalid.");
  }
  return { ...evidence, fingerprint: observed };
}

function createInitialHostState(now: string): BackgroundGitHubHostStateV1 {
  return createHostState({
    revision: 0,
    credential: null,
    bindings: {},
    checkpoints: parseGitHubPublicationCheckpointNamespaceV1(null),
    documents: {},
    updatedAt: now,
  });
}

function createHostState(
  evidenceInput: Omit<BackgroundGitHubHostStateV1, "version" | "fingerprint">,
): BackgroundGitHubHostStateV1 {
  const evidence = {
    version: 1 as const,
    ...clone(evidenceInput),
  };
  return {
    ...evidence,
    fingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  };
}

function createBindingState(input: {
  binding: TrustedGitHubRepositoryBindingV1;
  completionProof: "draft_pr" | "merged_pr";
  remoteBranch: BackgroundGitHubRemoteBranchObservationV1;
  synchronizedAt: string;
}): BackgroundGitHubTrustedBindingStateV1 {
  const evidence = {
    version: 1 as const,
    binding: parseTrustedGitHubRepositoryBindingV1(input.binding),
    completionProof: input.completionProof,
    remoteBranch: createRemoteBranchObservation(input.remoteBranch),
    synchronizedAt: timestamp(input.synchronizedAt, "binding synchronizedAt"),
  };
  return {
    ...evidence,
    fingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  };
}

function parseBindingState(value: unknown): BackgroundGitHubTrustedBindingStateV1 {
  const record = exactRecord(
    value,
    [
      "version",
      "binding",
      "completionProof",
      "remoteBranch",
      "synchronizedAt",
      "fingerprint",
    ],
    "background GitHub binding state",
  );
  if (
    record.version !== 1 ||
    (record.completionProof !== "draft_pr" &&
      record.completionProof !== "merged_pr")
  ) {
    throw new Error("Background GitHub binding state is invalid.");
  }
  const completionProof: "draft_pr" | "merged_pr" = record.completionProof;
  const evidence = {
    version: 1 as const,
    binding: parseTrustedGitHubRepositoryBindingV1(record.binding),
    completionProof,
    remoteBranch: createRemoteBranchObservation(record.remoteBranch),
    synchronizedAt: timestamp(record.synchronizedAt, "binding synchronizedAt"),
  };
  const observed = sha(record.fingerprint, "binding-state fingerprint");
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    throw new Error("Background GitHub binding-state fingerprint is invalid.");
  }
  return { ...evidence, fingerprint: observed };
}

function createRemoteBranchObservation(
  value: unknown,
): BackgroundGitHubRemoteBranchObservationV1 {
  const record = plainRecord(value, "remote branch observation");
  const evidence = {
    version: 1 as const,
    branch: gitBranch(record.branch, "agent branch"),
    remoteSha:
      record.remoteSha === null ? null : gitSha(record.remoteSha, "remote SHA"),
    handoffFingerprint: sha(
      record.handoffFingerprint,
      "handoff fingerprint",
    ),
    localHeadSha: gitSha(record.localHeadSha, "local head SHA"),
    observedAt: timestamp(record.observedAt, "branch observedAt"),
  };
  const fingerprint = fingerprintBackgroundGitHubValueV1(evidence);
  if (record.fingerprint !== undefined && record.fingerprint !== fingerprint) {
    throw new Error("Remote branch observation fingerprint is invalid.");
  }
  return { ...evidence, fingerprint };
}

function createPreparedDocument(
  logical: LogicalGitHubActionV1,
  preparedAt: string,
): BackgroundGitHubPreparedDocumentV1 {
  if (logical.title === null || logical.body === null) {
    throw new Error("Draft pull-request title and body are required.");
  }
  const evidence = {
    version: 1 as const,
    publicationId: logical.publicationId,
    repositoryProfileKey: logical.profileKey,
    title: boundedText(logical.title, "pull-request title", 1, 256),
    body: boundedText(logical.body, "pull-request body", 1, 60_000),
    titleFingerprint: fingerprintBackgroundGitHubValueV1(logical.title),
    bodyFingerprint: fingerprintBackgroundGitHubValueV1(logical.body),
    preparedAt: timestamp(preparedAt, "document preparedAt"),
  };
  return {
    ...evidence,
    fingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  };
}

function parsePreparedDocument(
  value: unknown,
): BackgroundGitHubPreparedDocumentV1 {
  const record = exactRecord(
    value,
    [
      "version",
      "publicationId",
      "repositoryProfileKey",
      "title",
      "body",
      "titleFingerprint",
      "bodyFingerprint",
      "preparedAt",
      "fingerprint",
    ],
    "background GitHub PR document",
  );
  if (record.version !== 1) throw new Error("Unsupported GitHub document version.");
  const logical: LogicalGitHubActionV1 = {
    toolName: "github_create_draft_pull_request",
    operation: GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1,
    profileKey: identifier(record.repositoryProfileKey, "repository profile key"),
    publicationId: identifier(record.publicationId, "publication id"),
    title: boundedText(record.title, "pull-request title", 1, 256),
    body: boundedText(record.body, "pull-request body", 1, 60_000),
  };
  const evidence = {
    version: 1 as const,
    publicationId: logical.publicationId,
    repositoryProfileKey: logical.profileKey,
    title: logical.title!,
    body: logical.body!,
    titleFingerprint: sha(record.titleFingerprint, "title fingerprint"),
    bodyFingerprint: sha(record.bodyFingerprint, "body fingerprint"),
    preparedAt: timestamp(record.preparedAt, "document preparedAt"),
  };
  if (
    evidence.titleFingerprint !== fingerprintBackgroundGitHubValueV1(evidence.title) ||
    evidence.bodyFingerprint !== fingerprintBackgroundGitHubValueV1(evidence.body)
  ) {
    throw new Error("GitHub PR document prose fingerprint is invalid.");
  }
  const observed = sha(record.fingerprint, "document fingerprint");
  if (observed !== fingerprintBackgroundGitHubValueV1(evidence)) {
    throw new Error("GitHub PR document fingerprint is invalid.");
  }
  return { ...evidence, fingerprint: observed };
}

function mergeCheckpointNamespaces(
  current: GitHubPublicationCheckpointNamespaceV1,
  incoming: GitHubPublicationCheckpointNamespaceV1,
): GitHubPublicationCheckpointNamespaceV1 {
  const checkpoints = { ...current.checkpoints };
  let changed = false;
  for (const [publicationId, checkpoint] of Object.entries(incoming.checkpoints)) {
    const existing = checkpoints[publicationId];
    if (!existing) {
      checkpoints[publicationId] = checkpoint;
      changed = true;
      continue;
    }
    if (
      fingerprintBackgroundGitHubValueV1(existing) ===
      fingerprintBackgroundGitHubValueV1(checkpoint)
    ) {
      continue;
    }
    if (
      Date.parse(checkpoint.updatedAt) > Date.parse(existing.updatedAt) &&
      checkpoint.bindingFingerprint === existing.bindingFingerprint &&
      checkpoint.branch === existing.branch &&
      checkpoint.receiptIds.length >= existing.receiptIds.length &&
      existing.receiptIds.every((id, index) => checkpoint.receiptIds[index] === id)
    ) {
      checkpoints[publicationId] = checkpoint;
      changed = true;
    }
  }
  return parseGitHubPublicationCheckpointNamespaceV1({
    version: 1,
    revision: changed
      ? Math.max(current.revision, incoming.revision) + 1
      : current.revision,
    checkpoints,
  });
}

function missionBindingFor(
  state: BackgroundGitHubHostStateV1,
  bindingState: BackgroundGitHubTrustedBindingStateV1,
): BackgroundGitHubMissionBindingV1 {
  const credential = state.credential!;
  return {
    id: `github-publication-${bindingState.binding.repositoryProfileKey}`,
    kind: "trusted_repository_publication",
    destinationFingerprint: fingerprintBackgroundGitHubValueV1({
      version: 1,
      repositoryBindingFingerprint: bindingState.binding.fingerprint,
      repositoryProfileFingerprint:
        bindingState.binding.repositoryProfileFingerprint,
      verifiedAccountId: credential.account.id,
      verifiedAccountLogin: credential.account.login,
      credentialReferenceId: credential.tokenReferenceId,
    }),
    allowedEffects: ["read", "external_action"],
  };
}

function parseLogicalAction(
  toolName: PreparedBackgroundGitHubToolNameV1,
  argsValue: Record<string, unknown>,
): LogicalGitHubActionV1 {
  createPreparedBackgroundGitHubToolDescriptorV1(toolName);
  const args = plainRecord(argsValue, `${toolName} arguments`);
  const draft = toolName === "github_create_draft_pull_request";
  const expected = draft
    ? ["profileKey", "publicationId", "title", "body"]
    : ["profileKey", "publicationId"];
  if (Object.keys(args).sort().join("\0") !== expected.sort().join("\0")) {
    throw new Error(
      `${toolName} accepts only logical profile/publication identity${draft ? " and PR prose" : ""}.`,
    );
  }
  return {
    toolName,
    operation: operationForTool(toolName),
    profileKey: identifier(args.profileKey, "repository profile key"),
    publicationId: identifier(args.publicationId, "publication id"),
    title: draft ? boundedText(args.title, "pull-request title", 1, 256) : null,
    body: draft ? boundedText(args.body, "pull-request body", 1, 60_000) : null,
  };
}

function logicalFromPreparedAction(
  action: PreparedActionV1,
): LogicalGitHubActionV1 {
  const args = exactRecord(
    action.normalizedArgs,
    [
      "version",
      "kind",
      "operation",
      "profileKey",
      "publicationId",
      "title",
      "body",
      "stateFingerprint",
      "checkpointFingerprint",
      "bindingFingerprint",
      "handoffFingerprint",
      "documentFingerprint",
    ],
    "prepared background GitHub normalized arguments",
  );
  if (args.version !== 1 || args.kind !== "prepared_background_github_approval_v1") {
    throw new Error("Prepared background GitHub logical contract is invalid.");
  }
  return parseLogicalAction(action.toolName as PreparedBackgroundGitHubToolNameV1, {
    profileKey: args.profileKey,
    publicationId: args.publicationId,
    ...(action.toolName === "github_create_draft_pull_request"
      ? { title: args.title, body: args.body }
      : {}),
  });
}

function buildPreparedApproval(input: {
  runId: string;
  toolCallId: string;
  resolved: ResolvedOperationStateV1;
  preparedAt: string;
  expiresAt: string;
}): PreparedActionV1 {
  const { logical, bindingState, checkpoint, document } = input.resolved;
  const normalizedArgs: Record<string, JsonValueV1> = {
    version: 1,
    kind: "prepared_background_github_approval_v1",
    operation: logical.operation,
    profileKey: logical.profileKey,
    publicationId: logical.publicationId,
    title: logical.title,
    body: logical.body,
    stateFingerprint: input.resolved.stateFingerprint,
    checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
    bindingFingerprint: bindingState.binding.fingerprint,
    handoffFingerprint: input.resolved.handoff.fingerprint,
    documentFingerprint: document?.fingerprint ?? null,
  };
  const target: PreparedActionV1["target"] = {
    system: "github",
    resourceType: "trusted_repository_publication",
    id: bindingState.binding.key,
    identifier: logical.publicationId,
    accountId: String(bindingState.binding.verifiedAccountId),
    repositoryId: String(bindingState.binding.repositoryId),
    repositoryProfileId: logical.profileKey,
    revision: input.resolved.stateFingerprint,
  };
  const preview: PreparedActionV1["preview"] = {
    summary: summaryForTool(logical.toolName),
    destination: `${bindingState.binding.owner}/${bindingState.binding.repository}`,
    before: {
      checkpointStatus: checkpoint.status,
      checkpointFingerprint: fingerprintBackgroundGitHubValueV1(checkpoint),
      remoteBranchSha: bindingState.remoteBranch.remoteSha,
    },
    after: {
      operation: logical.operation,
      branch: checkpoint.branch,
      headSha: checkpoint.headSha,
      baseBranch: bindingState.binding.defaultBranch,
      titleFingerprint: document?.titleFingerprint ?? null,
      bodyFingerprint: document?.bodyFingerprint ?? null,
    },
    ...(document
      ? {
          outboundPayload: {
            title: document.title,
            body: document.body,
          },
        }
      : {}),
    warnings: [
      "Dispatch is background-only, package-readback verified, and has no foreground provider fallback.",
      ...(isMergeTool(logical.toolName)
        ? ["Merge authority is double-exact and any PR/check drift invalidates it."]
        : []),
    ],
    outboundBytes: document
      ? new TextEncoder().encode(`${document.title}\n${document.body}`).byteLength
      : 0,
  };
  const seed = {
    version: 1 as const,
    runId: input.runId,
    toolCallId: input.toolCallId,
    toolName: logical.toolName,
    target,
    relatedResources: [],
    normalizedArgs,
    preview,
    expectedTargetRevision: input.resolved.stateFingerprint,
    idempotencyKey: input.resolved.stateFingerprint,
    reconciliationKey: input.resolved.stateFingerprint,
    requiredConfirmations: (isMergeTool(logical.toolName) ? 2 : 1) as 1 | 2,
    preparedAt: input.preparedAt,
    expiresAt: input.expiresAt,
  };
  const identity = fingerprintBackgroundGitHubValueV1(seed);
  const evidence: Omit<PreparedActionV1, "payloadFingerprint"> = {
    ...seed,
    id: `prepared-background-github-${identity.slice(7, 39)}`,
  };
  return {
    ...evidence,
    payloadFingerprint: fingerprintBackgroundGitHubValueV1(evidence),
  };
}

function parsePreparedApproval(value: unknown, now: string): PreparedActionV1 {
  const action = value as PreparedActionV1;
  if (
    !action ||
    action.version !== 1 ||
    !isPreparedGitHubTool(action.toolName) ||
    !Array.isArray(action.relatedResources) ||
    action.relatedResources.length !== 0 ||
    Date.parse(action.expiresAt) <= Date.parse(now) ||
    Date.parse(action.expiresAt) - Date.parse(action.preparedAt) > APPROVAL_TTL_MS ||
    action.requiredConfirmations !== (isMergeTool(action.toolName) ? 2 : 1) ||
    action.idempotencyKey !== action.reconciliationKey
  ) {
    throw new Error("Prepared background GitHub action is malformed or expired.");
  }
  const { payloadFingerprint, ...evidence } = action;
  if (payloadFingerprint !== fingerprintBackgroundGitHubValueV1(evidence)) {
    throw new Error("Prepared background GitHub approval fingerprint is invalid.");
  }
  logicalFromPreparedAction(action);
  return clone(action);
}

function selectAuthorizedNode(
  graph: MissionGraphV3,
  action: PreparedActionV1,
  resolved: ResolvedOperationStateV1,
): MissionNodeV3 {
  assertPreparedBackgroundGitHubMissionScopeV1(graph.missionId, action.runId);
  const expectedBinding = missionBindingFor(
    resolved.hostState,
    resolved.bindingState,
  );
  const candidates = Object.values(graph.nodes).filter((node) => {
    const destination = node.destination;
    const binding = destination
      ? graph.capabilityEnvelope.bindings[destination.bindingId]
      : null;
    return Boolean(
      node.effect === "external_action" &&
        (node.executionHost === "companion" ||
          node.executionHost === "headless_runtime") &&
        node.allowedTools.length === 1 &&
        node.allowedTools[0] === action.toolName &&
        destination?.effect === "external_action" &&
        binding?.id === expectedBinding.id &&
        binding?.kind === expectedBinding.kind &&
        binding?.destinationFingerprint ===
          expectedBinding.destinationFingerprint,
    );
  });
  if (candidates.length !== 1) {
    fail(
      "background_github_graph_binding_invalid",
      "The authoritative graph does not contain exactly one GitHub node bound to the synchronized repository destination.",
      "Rebuild the mission graph after exact integrations binding resolution.",
    );
  }
  return candidates[0];
}

/** Prepared actions retain the host run id while MissionGraphV3 stores its
 * canonical stable-id projection. This is the only accepted comparison. */
export function assertPreparedBackgroundGitHubMissionScopeV1(
  graphMissionId: string,
  preparedRunId: string,
): void {
  if (graphMissionId !== canonicalMissionGraphId(preparedRunId)) {
    fail(
      "background_github_graph_scope_drift",
      "The approved GitHub action belongs to a different mission graph.",
      "Prepare and approve the action again from the current mission.",
    );
  }
}

/**
 * The durable host document carries host-only lineage fields. The companion
 * package accepts only the four provider document fields, so seal-time export
 * must explicitly project that closed boundary instead of relying on
 * structurally compatible TypeScript objects with extra persisted metadata.
 */
export function projectBackgroundGitHubPullRequestDocumentV1(
  document: BackgroundGitHubPreparedDocumentV1 | null,
): BackgroundGitHubPullRequestDocumentV1 | null {
  if (!document) return null;
  return {
    title: document.title,
    body: document.body,
    titleFingerprint: document.titleFingerprint,
    bodyFingerprint: document.bodyFingerprint,
  };
}

function githubPayload(
  resolved: ResolvedOperationStateV1,
  approvalFingerprint: string,
): PreparedBackgroundGitHubActionV1["payload"] {
  const { logical, checkpoint, handoff, bindingState, document, profile } = resolved;
  const checkpointFingerprint = fingerprintBackgroundGitHubValueV1(checkpoint);
  if (logical.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    const expectedRemoteSha = bindingState.remoteBranch.remoteSha;
    return {
      publicationId: logical.publicationId,
      checkpointFingerprint,
      checkpointStatus: checkpoint.status as "local_verified" | "push_prepared",
      handoffFingerprint: handoff.fingerprint,
      branch: handoff.branch,
      baseBranch: handoff.baseBranch,
      baseSha: handoff.baseSha,
      headSha: handoff.commitSha,
      expectedRemoteSha,
      pushMode: expectedRemoteSha === null ? "create" : "fast_forward",
    };
  }
  if (logical.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    if (!document || !checkpoint.publishApprovalFingerprint) {
      throw new Error("Draft PR package lacks its push approval or document.");
    }
    return {
      publicationId: logical.publicationId,
      checkpointFingerprint,
      checkpointStatus: "pushed_verified",
      handoffFingerprint: handoff.fingerprint,
      publishApprovalFingerprint: checkpoint.publishApprovalFingerprint,
      workflowApprovalFingerprint: approvalFingerprint,
      branch: handoff.branch,
      headSha: handoff.commitSha,
      baseBranch: handoff.baseBranch,
      baseSha: handoff.baseSha,
      titleFingerprint: document.titleFingerprint,
      bodyFingerprint: document.bodyFingerprint,
    };
  }
  if (logical.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    if (!checkpoint.pullRequest) {
      throw new Error("Review repair requires the exact open pull request.");
    }
    return {
      publicationId: logical.publicationId,
      checkpointFingerprint,
      checkpointStatus: "repair_required",
      workflowApprovalFingerprint: approvalFingerprint,
      repairId: checkpoint.repairId ?? `repair-${handoff.fingerprint.slice(7, 31)}`,
      pullRequestNumber: checkpoint.pullRequest.number,
      branch: checkpoint.branch,
      baseBranch: profile.defaultBranch,
      baseSha: handoff.baseSha,
      expectedOldHeadSha: checkpoint.headSha,
      newHeadSha: handoff.commitSha,
      previousHandoffFingerprint: checkpoint.handoffFingerprint,
      handoffFingerprint: handoff.fingerprint,
    };
  }
  if (!checkpoint.pullRequest || !checkpoint.proofSnapshot) {
    throw new Error("Merge preparation requires a fresh PR and check proof snapshot.");
  }
  return {
    publicationId: logical.publicationId,
    checkpointFingerprint,
    checkpointStatus: "review_or_merge_ready",
    workflowApprovalFingerprint: approvalFingerprint,
    pullRequestNumber: checkpoint.pullRequest.number,
    branch: checkpoint.branch,
    headSha: checkpoint.headSha,
    baseBranch: checkpoint.pullRequest.base.ref,
    baseSha: checkpoint.pullRequest.base.sha,
    pullRequestUpdatedAt: checkpoint.pullRequest.updatedAt,
    proofSnapshotFingerprint: checkpoint.proofSnapshot.snapshotFingerprint,
    requiredChecksFingerprint: fingerprintBackgroundGitHubValueV1(
      profile.requiredGitHubChecks,
    ),
    mergeMethod: profile.mergePolicy.defaultMethod,
  };
}

function createLocalVerifiedCheckpoint(input: {
  logical: LogicalGitHubActionV1;
  bindingState: BackgroundGitHubTrustedBindingStateV1;
  handoff: VerifiedCodePublicationHandoffV1;
  now: string;
}): GitHubPublicationCheckpointV1 {
  return parseGitHubPublicationCheckpointV1({
    version: 1,
    publicationId: input.logical.publicationId,
    status: "local_verified",
    updatedAt: input.now,
    handoffFingerprint: input.handoff.fingerprint,
    bindingFingerprint: input.bindingState.binding.fingerprint,
    headSha: input.handoff.commitSha,
    branch: input.handoff.branch,
    remoteSha: null,
    mergeSha: null,
    pullRequest: null,
    proofSnapshot: null,
    publishApprovalFingerprint: null,
    readyApprovalFingerprint: null,
    mergeApprovalFingerprint: null,
    completionProof: input.bindingState.completionProof,
    linearLinkReceiptId: null,
    linearCompletionReceiptId: null,
    obsidianReceiptId: null,
    receiptIds: [],
    pendingAction: null,
    blocker: null,
  });
}

function validateCheckpointForLogicalAction(
  checkpoint: GitHubPublicationCheckpointV1,
  logical: LogicalGitHubActionV1,
  handoff: VerifiedCodePublicationHandoffV1,
  bindingState: BackgroundGitHubTrustedBindingStateV1,
): void {
  if (
    checkpoint.publicationId !== logical.publicationId ||
    checkpoint.bindingFingerprint !== bindingState.binding.fingerprint ||
    checkpoint.branch !== handoff.branch
  ) {
    throw new Error("GitHub checkpoint drifted from its publication or binding.");
  }
  const requiredStatus: Record<PreparedBackgroundGitHubOperationV1, string[]> = {
    [GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1]: ["local_verified", "push_prepared"],
    [GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1]: ["pushed_verified"],
    [GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1]: ["repair_required"],
    [GITHUB_PULL_REQUEST_MERGE_OPERATION_V1]: ["review_or_merge_ready"],
    [GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1]: ["review_or_merge_ready"],
  };
  if (!requiredStatus[logical.operation].includes(checkpoint.status)) {
    throw new Error(
      `GitHub ${logical.operation} requires checkpoint state ${requiredStatus[logical.operation].join(" or ")}.`,
    );
  }
  if (
    logical.operation !== GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1 &&
    (checkpoint.handoffFingerprint !== handoff.fingerprint ||
      checkpoint.headSha !== handoff.commitSha)
  ) {
    throw new Error("GitHub checkpoint no longer matches the verified local commit.");
  }
  if (
    logical.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1 &&
    (checkpoint.remoteSha !== handoff.commitSha ||
      bindingState.remoteBranch.remoteSha !== handoff.commitSha)
  ) {
    throw new Error("Draft PR requires verified remote branch readback at the exact head.");
  }
  if (
    isMergeTool(logical.toolName) &&
    (!checkpoint.pullRequest ||
      checkpoint.pullRequest.draft ||
      checkpoint.pullRequest.merged ||
      checkpoint.pullRequest.state !== "open" ||
      checkpoint.pullRequest.head.sha !== checkpoint.headSha ||
      !checkpoint.proofSnapshot ||
      checkpoint.proofSnapshot.headSha !== checkpoint.headSha ||
      checkpoint.proofSnapshot.pendingChecks.length > 0 ||
      checkpoint.proofSnapshot.failedChecks.length > 0 ||
      checkpoint.mergeApprovalFingerprint !== null)
  ) {
    throw new Error(
      "Merge requires a fresh non-draft PR head with all required checks passing and no prior merge approval.",
    );
  }
}

export function projectVerifiedBackgroundGitHubCheckpointV1(
  current: GitHubPublicationCheckpointV1,
  action: PreparedBackgroundGitHubActionV1,
  result: BackgroundGitHubVerifiedResultV1,
  receiptIds: string[],
): GitHubPublicationCheckpointV1 {
  if (
    result.operation !== action.operation ||
    result.publicationId !== action.payload.publicationId ||
    result.repositoryBindingFingerprint !==
      action.binding.repositoryBindingFingerprint ||
    result.verifiedAccountId !== action.binding.verifiedAccountId ||
    current.publicationId !== action.payload.publicationId ||
    current.bindingFingerprint !== action.binding.repositoryBindingFingerprint ||
    current.branch !== action.payload.branch
  ) {
    throw new Error(
      "Verified GitHub result drifted from its exact action, publication, account, or checkpoint binding.",
    );
  }
  if (
    sameStrings(current.receiptIds, receiptIds) &&
    checkpointAlreadyRepresentsVerifiedResultV1(current, action, result)
  ) {
    return parseGitHubPublicationCheckpointV1(current);
  }
  if (
    fingerprintBackgroundGitHubValueV1(current) !==
      action.payload.checkpointFingerprint ||
    current.status !== action.payload.checkpointStatus
  ) {
    throw new Error(
      "GitHub checkpoint changed after the exact external action was prepared.",
    );
  }
  if (action.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    if (
      result.headSha !== action.payload.headSha ||
      result.pullRequestNumber !== null ||
      result.mergeSha !== null ||
      result.autoMergeEnabled
    ) {
      throw new Error("Verified push result does not prove the exact branch head.");
    }
    return parseGitHubPublicationCheckpointV1({
      ...current,
      status: "pushed_verified",
      updatedAt: result.verifiedAt,
      remoteSha: action.payload.headSha,
      publishApprovalFingerprint: action.preparedActionFingerprint,
      receiptIds,
      pendingAction: null,
      blocker: null,
    });
  }
  if (action.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    if (
      result.headSha !== action.payload.headSha ||
      !result.pullRequestNumber ||
      result.mergeSha !== null ||
      result.autoMergeEnabled
    ) {
      throw new Error("Verified draft PR result does not prove the exact head and PR.");
    }
    return parseGitHubPublicationCheckpointV1({
      ...current,
      status: "draft_pr_verified",
      updatedAt: result.verifiedAt,
      remoteSha: action.payload.headSha,
      pullRequest: {
        number: result.pullRequestNumber,
        htmlUrl: `https://github.com/${action.binding.owner}/${action.binding.repository}/pull/${result.pullRequestNumber}`,
        state: "open",
        draft: true,
        merged: false,
        head: { ref: action.payload.branch, sha: action.payload.headSha },
        base: { ref: action.payload.baseBranch, sha: action.payload.baseSha },
        updatedAt: result.verifiedAt,
      },
      receiptIds,
      pendingAction: null,
      blocker: null,
    });
  }
  if (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    if (
      result.headSha !== action.payload.newHeadSha ||
      result.pullRequestNumber !== action.payload.pullRequestNumber ||
      result.mergeSha !== null ||
      result.autoMergeEnabled ||
      !current.pullRequest ||
      current.pullRequest.number !== action.payload.pullRequestNumber ||
      current.pullRequest.head.sha !== action.payload.expectedOldHeadSha ||
      current.handoffFingerprint !==
        action.payload.previousHandoffFingerprint ||
      current.headSha !== action.payload.expectedOldHeadSha
    ) {
      throw new Error(
        "Verified review-repair result does not prove the exact approved fast-forward and pull request.",
      );
    }
    return parseGitHubPublicationCheckpointV1({
      ...current,
      status: "draft_pr_verified",
      updatedAt: result.verifiedAt,
      handoffFingerprint: action.payload.handoffFingerprint,
      headSha: action.payload.newHeadSha,
      remoteSha: action.payload.newHeadSha,
      mergeSha: null,
      pullRequest: {
        ...current.pullRequest,
        state: "open",
        merged: false,
        head: {
          ref: action.payload.branch,
          sha: action.payload.newHeadSha,
        },
        base: {
          ref: action.payload.baseBranch,
          sha: action.payload.baseSha,
        },
        updatedAt: result.verifiedAt,
      },
      proofSnapshot: null,
      publishApprovalFingerprint: action.preparedActionFingerprint,
      readyApprovalFingerprint: null,
      mergeApprovalFingerprint: null,
      repairBaseSha: action.payload.expectedOldHeadSha,
      repairId: action.payload.repairId,
      repairPullRequestNumber: action.payload.pullRequestNumber,
      receiptIds,
      pendingAction: null,
      blocker: null,
    });
  }
  if (action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
    if (
      !result.mergeSha ||
      result.pullRequestNumber !== action.payload.pullRequestNumber ||
      result.headSha !== action.payload.headSha ||
      result.autoMergeEnabled
    ) {
      throw new Error("Verified merge result does not prove the exact approved PR.");
    }
    return parseGitHubPublicationCheckpointV1({
      ...current,
      status: "merged_verified",
      updatedAt: result.verifiedAt,
      mergeSha: result.mergeSha,
      mergeApprovalFingerprint: action.preparedActionFingerprint,
      pullRequest: {
        ...current.pullRequest!,
        draft: false,
        merged: true,
        state: "closed",
        updatedAt: result.verifiedAt,
      },
      receiptIds,
      pendingAction: null,
      blocker: null,
    });
  }
  if (action.operation === GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1) {
    if (
      !result.autoMergeEnabled ||
      result.mergeSha !== null ||
      result.pullRequestNumber !== action.payload.pullRequestNumber ||
      result.headSha !== action.payload.headSha ||
      !current.pullRequest ||
      current.pullRequest.number !== action.payload.pullRequestNumber ||
      current.pullRequest.head.sha !== action.payload.headSha ||
      current.proofSnapshot?.snapshotFingerprint !==
        action.payload.proofSnapshotFingerprint
    ) {
      throw new Error(
        "Verified auto-merge result does not prove enablement for the exact double-approved pull request snapshot.",
      );
    }
    return parseGitHubPublicationCheckpointV1({
      ...current,
      status: "checks_pending",
      updatedAt: result.verifiedAt,
      mergeApprovalFingerprint: action.preparedActionFingerprint,
      pullRequest: {
        ...current.pullRequest,
        updatedAt: result.verifiedAt,
      },
      receiptIds,
      pendingAction: null,
      blocker: null,
    });
  }
  throw new Error("Unsupported verified GitHub result operation.");
}

function checkpointAlreadyRepresentsVerifiedResultV1(
  current: GitHubPublicationCheckpointV1,
  action: PreparedBackgroundGitHubActionV1,
  result: BackgroundGitHubVerifiedResultV1,
): boolean {
  if (current.updatedAt !== result.verifiedAt || current.pendingAction !== null) {
    return false;
  }
  if (action.operation === GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1) {
    return Boolean(
      current.status === "pushed_verified" &&
        current.headSha === action.payload.headSha &&
        current.remoteSha === action.payload.headSha &&
        current.publishApprovalFingerprint === action.preparedActionFingerprint &&
        result.headSha === action.payload.headSha &&
        result.pullRequestNumber === null &&
        result.mergeSha === null &&
        !result.autoMergeEnabled,
    );
  }
  if (action.operation === GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1) {
    const pullRequest = current.pullRequest;
    return Boolean(
      current.status === "draft_pr_verified" &&
        current.remoteSha === action.payload.headSha &&
        current.publishApprovalFingerprint ===
          action.payload.publishApprovalFingerprint &&
        pullRequest?.number === result.pullRequestNumber &&
        pullRequest.state === "open" &&
        pullRequest.draft &&
        !pullRequest.merged &&
        pullRequest.head.ref === action.payload.branch &&
        pullRequest.head.sha === action.payload.headSha &&
        pullRequest.base.ref === action.payload.baseBranch &&
        pullRequest.base.sha === action.payload.baseSha &&
        result.headSha === action.payload.headSha &&
        result.pullRequestNumber !== null &&
        result.mergeSha === null &&
        !result.autoMergeEnabled,
    );
  }
  if (action.operation === GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1) {
    const pullRequest = current.pullRequest;
    return Boolean(
      current.status === "draft_pr_verified" &&
        current.handoffFingerprint === action.payload.handoffFingerprint &&
        current.headSha === action.payload.newHeadSha &&
        current.remoteSha === action.payload.newHeadSha &&
        current.proofSnapshot === null &&
        current.publishApprovalFingerprint === action.preparedActionFingerprint &&
        current.readyApprovalFingerprint === null &&
        current.mergeApprovalFingerprint === null &&
        current.repairBaseSha === action.payload.expectedOldHeadSha &&
        current.repairId === action.payload.repairId &&
        current.repairPullRequestNumber === action.payload.pullRequestNumber &&
        pullRequest?.number === action.payload.pullRequestNumber &&
        pullRequest.state === "open" &&
        !pullRequest.merged &&
        pullRequest.head.ref === action.payload.branch &&
        pullRequest.head.sha === action.payload.newHeadSha &&
        pullRequest.base.ref === action.payload.baseBranch &&
        pullRequest.base.sha === action.payload.baseSha &&
        result.headSha === action.payload.newHeadSha &&
        result.pullRequestNumber === action.payload.pullRequestNumber &&
        result.mergeSha === null &&
        !result.autoMergeEnabled,
    );
  }
  if (action.operation === GITHUB_PULL_REQUEST_MERGE_OPERATION_V1) {
    const pullRequest = current.pullRequest;
    return Boolean(
      current.status === "merged_verified" &&
        current.mergeSha === result.mergeSha &&
        current.mergeApprovalFingerprint === action.preparedActionFingerprint &&
        pullRequest?.number === action.payload.pullRequestNumber &&
        pullRequest.state === "closed" &&
        !pullRequest.draft &&
        pullRequest.merged &&
        pullRequest.head.ref === action.payload.branch &&
        pullRequest.head.sha === action.payload.headSha &&
        pullRequest.base.ref === action.payload.baseBranch &&
        pullRequest.base.sha === action.payload.baseSha &&
        result.headSha === action.payload.headSha &&
        result.pullRequestNumber === action.payload.pullRequestNumber &&
        result.mergeSha !== null &&
        !result.autoMergeEnabled,
    );
  }
  const pullRequest = current.pullRequest;
  return Boolean(
    current.status === "checks_pending" &&
      current.mergeApprovalFingerprint === action.preparedActionFingerprint &&
      current.proofSnapshot?.snapshotFingerprint ===
        action.payload.proofSnapshotFingerprint &&
      pullRequest?.number === action.payload.pullRequestNumber &&
      pullRequest.state === "open" &&
      !pullRequest.draft &&
      !pullRequest.merged &&
      pullRequest.head.ref === action.payload.branch &&
      pullRequest.head.sha === action.payload.headSha &&
      pullRequest.base.ref === action.payload.baseBranch &&
      pullRequest.base.sha === action.payload.baseSha &&
      result.headSha === action.payload.headSha &&
      result.pullRequestNumber === action.payload.pullRequestNumber &&
      result.mergeSha === null &&
      result.autoMergeEnabled,
  );
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function operationForTool(
  toolName: PreparedBackgroundGitHubToolNameV1,
): PreparedBackgroundGitHubOperationV1 {
  switch (toolName) {
    case "github_publish_verified_branch":
      return GITHUB_VERIFIED_BRANCH_PUSH_OPERATION_V1;
    case "github_create_draft_pull_request":
      return GITHUB_DRAFT_PULL_REQUEST_OPERATION_V1;
    case "github_update_owned_branch":
      return GITHUB_REVIEW_REPAIR_FAST_FORWARD_OPERATION_V1;
    case "github_merge_pull_request":
      return GITHUB_PULL_REQUEST_MERGE_OPERATION_V1;
    case "github_enable_auto_merge":
      return GITHUB_PULL_REQUEST_AUTO_MERGE_OPERATION_V1;
  }
}

function isPreparedGitHubTool(
  value: string,
): value is PreparedBackgroundGitHubToolNameV1 {
  return [
    "github_publish_verified_branch",
    "github_create_draft_pull_request",
    "github_update_owned_branch",
    "github_merge_pull_request",
    "github_enable_auto_merge",
  ].includes(value);
}

function isMergeTool(value: string): boolean {
  return value === "github_merge_pull_request" || value === "github_enable_auto_merge";
}

function summaryForTool(toolName: PreparedBackgroundGitHubToolNameV1): string {
  const summaries: Record<PreparedBackgroundGitHubToolNameV1, string> = {
    github_publish_verified_branch:
      "Push the exact verified local commit to one agent-owned branch and independently read back its remote SHA.",
    github_create_draft_pull_request:
      "Create one draft pull request for the exact verified branch head and read it back.",
    github_update_owned_branch:
      "Fast-forward one agent-owned review-repair branch to the exact newly verified commit.",
    github_merge_pull_request:
      "Merge one exact non-draft pull request after fresh head, base, review, and required-check proof.",
    github_enable_auto_merge:
      "Enable auto-merge for one exact pull request after fresh head, base, review, and required-check proof.",
  };
  return summaries[toolName];
}

function blocked(error: unknown): BackgroundGitHubHostBlockedV1 {
  if (error instanceof BackgroundGitHubHostErrorV1) {
    return {
      status: "blocked",
      code: error.code,
      message: error.message,
      requiredAction: error.requiredAction,
    };
  }
  return {
    status: "blocked",
    code: "background_github_host_failed",
    message: safeError(error),
    requiredAction:
      "Inspect Integrations and Code extension health, then resume from the same durable mission.",
  };
}

class BackgroundGitHubHostErrorV1 extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requiredAction: string | null,
  ) {
    super(message);
    this.name = "BackgroundGitHubHostErrorV1";
  }
}

function fail(code: string, message: string, requiredAction: string | null): never {
  throw new BackgroundGitHubHostErrorV1(code, message, requiredAction);
}

function topLevelRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  return plainRecord(value, "integrations plugin data");
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = plainRecord(value, label);
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new Error(`${label} does not match its closed contract.`);
  }
  return record;
}

function plainRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be a plain object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !IDENTIFIER.test(value) ||
    ["__proto__", "prototype", "constructor"].includes(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !SHA256.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function gitSha(value: unknown, label: string): string {
  if (typeof value !== "string" || !GIT_SHA.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function gitBranch(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 255 ||
    value.startsWith("-") ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    /[~^:?*[\\\s\]]/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) {
    throw new Error(`${label} is invalid.`);
  }
  return Number(value);
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /\u0000/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function containsLogicalIdentifier(text: string, identifierValue: string): boolean {
  const escaped = identifierValue.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9._:-])${escaped}(?:$|[^A-Za-z0-9._:-])`, "u").test(text);
}

function earliestTimestamp(...values: Array<string | null>): string {
  const finite = values.filter((value): value is string => value !== null);
  return new Date(Math.min(...finite.map((value) => Date.parse(value)))).toISOString();
}

function latestTimestamp(...values: string[]): string {
  return new Date(Math.max(...values.map((value) => Date.parse(value)))).toISOString();
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error))
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/github_pat_[A-Za-z0-9_]+/gu, "[REDACTED]")
    .replace(/gh[pousr]_[A-Za-z0-9]+/gu, "[REDACTED]")
    .replace(/[A-Za-z]:[\\/][^\s]+/gu, "[LOCAL_PATH]")
    .slice(0, 2_000);
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
