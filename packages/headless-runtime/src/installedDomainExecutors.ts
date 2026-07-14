import type { SecretStoreV1 } from "../../core-api/src/secretStoreV1";
import { linearIssueStateUpdateAttemptIdV1 } from "../../core-api/src/preparedExternalActionHandoffV1";
import {
  buildCompanionReceiptV1,
  type BackgroundExecutionDomainV1,
  type CompanionJobV1,
  type HeadlessDomainExecutorV1,
  type HeadlessWorkerResultV1,
} from "./backgroundContinuation";
import { sha256Fingerprint } from "./canonicalize";
import type { MissionJsonValueV1 } from "./missionGraphV3";
import {
  requireBackgroundSecretStoreV1,
  SecretStoreBoundaryErrorV1,
} from "./secretStoreV1";

export const INSTALLED_HEADLESS_EXECUTOR_IDS_V1 = Object.freeze({
  research: "public_research_fetch_v1",
  code: "verified_code_manifest_readback_v1",
  linear: "linear_issue_readback_v1",
  github: "github_repository_readback_v1",
} as const);

export type InstalledHeadlessExecutorIdV1 =
  (typeof INSTALLED_HEADLESS_EXECUTOR_IDS_V1)[BackgroundExecutionDomainV1];

export const INSTALLED_HEADLESS_TOOL_BY_DOMAIN_V1 = Object.freeze({
  research: "web_fetch",
  code: "code_workspace_status",
  linear: "linear_get_issue",
  github: "github_get_repository",
} as const);

export interface LinearIssueReadbackV1 {
  id: string;
  identifier: string;
  title: string;
  updatedAt: string;
  url: string | null;
  state: { id: string; name: string } | null;
  projectId?: string;
  workItemFingerprint?: string;
  /** Exact hash produced by the core Linear issue normalization contract. */
  snapshotFingerprint?: string;
}

export interface GitHubRepositoryReadbackV1 {
  id: number;
  nodeId: string;
  fullName: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  updatedAt: string;
}

export interface InstalledDomainExecutorDependenciesV1 {
  secretStore?: Pick<SecretStoreV1, "health" | "lease">;
  linearReadIssue?: (
    input: { issueId: string },
    credential: string,
    signal: AbortSignal,
  ) => Promise<LinearIssueReadbackV1>;
  linearUpdateIssueState?: (
    input: { issueId: string; stateId: string },
    credential: string,
    signal: AbortSignal,
  ) => Promise<{ providerRequestId: string | null }>;
  githubReadRepository?: (
    input: { owner: string; repository: string },
    credential: string,
    signal: AbortSignal,
  ) => Promise<GitHubRepositoryReadbackV1>;
  preparedBackgroundCodeExecutor?: HeadlessDomainExecutorV1;
  preparedBackgroundGitHubExecutor?: HeadlessDomainExecutorV1;
  now?: () => Date;
}

/** Fixed composite: ordinary GitHub jobs are bounded readbacks; prepared jobs
 * can run only through the integrations-owned local-package executor. */
export function createInstalledGitHubExecutorV1(
  dependencies: InstalledDomainExecutorDependenciesV1,
): HeadlessDomainExecutorV1 {
  const readback = createGitHubRepositoryReadbackExecutorV1(dependencies);
  return (job, context) => {
    const hasAction = Boolean(job.preparedBackgroundGitHubAction);
    const hasPackage = Boolean(job.preparedBackgroundGitHubPackage);
    if (hasAction || hasPackage) {
      if (!hasAction || !hasPackage || !dependencies.preparedBackgroundGitHubExecutor) {
        return Promise.resolve(blocked(
          "github_package_executor_unavailable",
          "Prepared GitHub continuation requires the installed integrations local-package executor and both closed identities.",
          "Repair or upgrade the local companion integrations extension, then resume the same durable package.",
        ));
      }
      return dependencies.preparedBackgroundGitHubExecutor(job, context);
    }
    return readback(job, context);
  };
}

/** Fixed composite: ordinary Code jobs are proof readbacks; prepared jobs use
 * only the explicitly installed local package executor. */
export function createInstalledCodeExecutorV1(
  dependencies: Pick<
    InstalledDomainExecutorDependenciesV1,
    "now" | "preparedBackgroundCodeExecutor"
  > = {},
): HeadlessDomainExecutorV1 {
  const readback = createVerifiedCodeManifestReadbackExecutorV1(dependencies);
  return (job, context) => {
    const hasAction = Boolean(job.preparedBackgroundCodeAction);
    const hasPackage = Boolean(job.preparedBackgroundCodePackage);
    if (hasAction || hasPackage) {
      if (!hasAction || !hasPackage || !dependencies.preparedBackgroundCodeExecutor) {
        return Promise.resolve(blocked(
          "code_package_executor_unavailable",
          "Prepared Code validation/commit requires the installed local package executor and both closed identities.",
          "Repair or upgrade the local companion Code extension, then resume the same durable package.",
        ));
      }
      return dependencies.preparedBackgroundCodeExecutor(job, context);
    }
    return readback(job, context);
  };
}

/**
 * The code-domain worker deliberately performs proof readback only. It never
 * receives a path or command and cannot access the host filesystem. Repository
 * mutations and validation remain inside the trusted code extension/sandbox.
 */
export function createVerifiedCodeManifestReadbackExecutorV1(
  dependencies: Pick<InstalledDomainExecutorDependenciesV1, "now"> = {},
): HeadlessDomainExecutorV1 {
  const now = dependencies.now ?? (() => new Date());
  return async (job) => {
    const scope = exactOperation(job, "code", "code_workspace_status");
    if (scope) return scope;
    const inputError = rejectUnknownInputs(job, [
      "workspaceId",
      "manifestFingerprint",
      "repositoryBindingFingerprint",
    ]);
    if (inputError) return inputError;
    const workspaceId = boundedIdentifier(job.inputs.workspaceId, "workspaceId", 128);
    const manifestFingerprint = fingerprint(job.inputs.manifestFingerprint);
    const repositoryBindingFingerprint = fingerprint(
      job.inputs.repositoryBindingFingerprint,
    );
    if (!workspaceId || !manifestFingerprint || !repositoryBindingFingerprint) {
      return blocked(
        "invalid_code_manifest_readback",
        "Code manifest readback requires an opaque workspace id and exact manifest and repository binding fingerprints.",
        "Resume in Obsidian so the code extension can persist and project the verified manifest fingerprints.",
      );
    }
    const proofFingerprint = await sha256Fingerprint({
      workspaceId,
      manifestFingerprint,
      repositoryBindingFingerprint,
    });
    const receipt = await buildCompanionReceiptV1({
      job,
      id: receiptId("code", job),
      provider: "code",
      operation: "verified_code_manifest_readback",
      status: "verified",
      payload: {
        workspaceId,
        manifestFingerprint,
        repositoryBindingFingerprint,
        proofFingerprint,
      },
      committedAt: now().toISOString(),
    });
    return {
      status: "complete",
      outputs: {
        workspaceId,
        manifestFingerprint,
        repositoryBindingFingerprint,
        proofFingerprint,
      },
      evidence: [{ kind: "code_manifest_readback", proofFingerprint }],
      receipts: [receipt],
    };
  };
}

export function createLinearIssueReadbackExecutorV1(
  dependencies: InstalledDomainExecutorDependenciesV1,
): HeadlessDomainExecutorV1 {
  const now = dependencies.now ?? (() => new Date());
  return async (job, context) => {
    if (job.preparedExternalActionHandoff) {
      return executePreparedLinearIssueStateUpdateV1(
        job,
        context,
        dependencies,
        now,
      );
    }
    const scope = exactOperation(job, "linear", "linear_get_issue");
    if (scope) return scope;
    const inputError = rejectUnknownInputs(job, [
      "issueId",
      "credentialReferenceId",
      "projectBindingId",
      "contractFingerprint",
      "queueCandidateFingerprint",
    ]);
    if (inputError) return inputError;
    const issueId = boundedIdentifier(job.inputs.issueId, "issueId", 128);
    const credentialReferenceId = credentialReference(job.inputs.credentialReferenceId);
    const projectBindingId = optionalBoundedIdentifier(
      job.inputs.projectBindingId,
      "projectBindingId",
      128,
    );
    const contractFingerprint = optionalFingerprint(job.inputs.contractFingerprint);
    const queueCandidateFingerprint = optionalFingerprint(
      job.inputs.queueCandidateFingerprint,
    );
    const queueReadback =
      projectBindingId !== undefined ||
      contractFingerprint !== undefined ||
      queueCandidateFingerprint !== undefined;
    if (!issueId || !credentialReferenceId) {
      return blocked(
        "invalid_linear_issue_readback",
        "Linear issue readback requires an exact issue id and opaque credential reference.",
        "Select a trusted Linear issue and credential binding in Obsidian, then resume.",
      );
    }
    if (
      queueReadback &&
      (!projectBindingId || !contractFingerprint || !queueCandidateFingerprint)
    ) {
      return blocked(
        "invalid_linear_queue_readback",
        "Linear queue readback requires exact project, contract, and candidate fingerprints.",
        "Reconnect Obsidian and refresh the trusted queue configuration.",
      );
    }
    if (!dependencies.secretStore || !dependencies.linearReadIssue) {
      return executorBindingUnavailable("linear");
    }
    return withPersistentCredential(
      dependencies.secretStore,
      credentialReferenceId,
      async (credential) => {
        await context.reportProgress("Reading the authorized Linear issue.");
        const issue = validateLinearIssue(
          await dependencies.linearReadIssue!({ issueId }, credential, context.signal),
          issueId,
        );
        if (
          queueReadback &&
          (issue.projectId !== projectBindingId ||
            issue.workItemFingerprint !== contractFingerprint)
        ) {
          return blocked(
            "linear_queue_candidate_changed",
            "The Linear queue issue project or signed work-item contract changed before independent readback.",
            "Reconnect Obsidian and rescan the trusted queue candidate.",
          );
        }
        const readbackFingerprint =
          issue.snapshotFingerprint ?? (await sha256Fingerprint(issue));
        const receipt = await buildCompanionReceiptV1({
          job,
          id: receiptId("linear", job),
          provider: "linear",
          operation: "linear_issue_readback",
          status: "verified",
          payload: {
            issueId: issue.id,
            identifier: issue.identifier,
            updatedAt: issue.updatedAt,
            readbackFingerprint,
            ...(queueReadback
              ? {
                  candidateFingerprint: queueCandidateFingerprint!,
                  workItemFingerprint: contractFingerprint!,
                }
              : {}),
          },
          committedAt: now().toISOString(),
        });
        const outputs: Record<string, MissionJsonValueV1> = queueReadback
          ? {
              issueId: issue.id,
              state: issue.state?.id ?? "",
              candidateFingerprint: queueCandidateFingerprint!,
              workItemFingerprint: contractFingerprint!,
              readbackFingerprint,
            }
          : {
              issue: {
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                updatedAt: issue.updatedAt,
                url: issue.url,
                state: issue.state
                  ? { id: issue.state.id, name: issue.state.name }
                  : null,
              },
              readbackFingerprint,
            };
        return {
          status: "complete",
          outputs,
          evidence: [
            {
              kind: "linear_issue_readback",
              issueId: issue.id,
              readbackFingerprint,
            },
          ],
          receipts: [receipt],
        };
      },
    );
  };
}

async function executePreparedLinearIssueStateUpdateV1(
  job: CompanionJobV1,
  context: Parameters<HeadlessDomainExecutorV1>[1],
  dependencies: InstalledDomainExecutorDependenciesV1,
  now: () => Date,
): Promise<HeadlessWorkerResultV1> {
  const handoff = job.preparedExternalActionHandoff!;
  if (
    job.domain !== "linear" ||
    job.allowedTools.length !== 1 ||
    job.allowedTools[0] !== "linear_update_issue" ||
    Object.keys(job.inputs).length !== 0 ||
    handoff.operation !== "linear_issue_state_update_v1" ||
    handoff.missionId !== job.missionId ||
    handoff.nodeId !== job.nodeId ||
    handoff.graphRevision !== job.graphRevision ||
    handoff.capabilityEnvelopeFingerprint !==
      job.capabilityEnvelopeFingerprint
  ) {
    return blocked(
      "invalid_linear_state_update_handoff",
      "The companion rejected a Linear mutation outside the exact fingerprinted state-update handoff.",
      "Reconnect Obsidian and prepare a fresh exact action.",
    );
  }
  const credentialReferenceId = credentialReference(
    handoff.payload.credentialReferenceId,
  );
  if (
    !credentialReferenceId ||
    !dependencies.secretStore ||
    !dependencies.linearReadIssue ||
    !dependencies.linearUpdateIssueState ||
    !context.listCommittedReceipts ||
    !context.commitReceipt
  ) {
    return executorBindingUnavailable("linear");
  }
  const commitReceipt = context.commitReceipt;
  const attemptId = linearIssueStateUpdateAttemptIdV1(job.id, handoff);
  const committed = await context.listCommittedReceipts();
  const relevant = committed.filter(
    (receipt) =>
      receipt.provider === "linear" &&
      receipt.operation === "linear_issue_state_update_v1" &&
      receipt.payload.attemptId === attemptId &&
      receipt.payload.handoffFingerprint === handoff.fingerprint,
  );
  const dispatchAlreadyCommitted = relevant.some(
    (receipt) =>
      receipt.status === "dispatched" || receipt.status === "ambiguous",
  );
  if (
    Date.parse(handoff.expiresAt) <= now().getTime() &&
    !dispatchAlreadyCommitted
  ) {
    return blocked(
      "linear_state_update_authority_expired",
      "The prepared Linear state update expired before a durable dispatch marker was committed.",
      "Reconnect Obsidian and prepare a fresh exact action; the expired action will not be dispatched.",
    );
  }
  const priorVerified = relevant.find((receipt) => receipt.status === "verified");
  if (priorVerified) {
    return completedLinearStateUpdate(job, priorVerified);
  }

  return withPersistentCredential(
    dependencies.secretStore,
    credentialReferenceId,
    async (credential) => {
      if (!dispatchAlreadyCommitted) {
        await context.reportProgress(
          "Re-reading the exact Linear issue precondition before dispatch.",
        );
        const before = validateLinearIssue(
          await dependencies.linearReadIssue!(
            { issueId: handoff.payload.issueId },
            credential,
            context.signal,
          ),
          handoff.payload.issueId,
        );
        if (
          before.snapshotFingerprint !==
          handoff.payload.preconditionFingerprint
        ) {
          return blocked(
            "linear_precondition_changed",
            "The Linear issue changed after preparation; the mutation was not dispatched.",
            "Reconnect Obsidian, re-read the issue, and approve a freshly prepared state update.",
          );
        }
        const dispatched = await buildCompanionReceiptV1({
          job,
          id: `${receiptId("linear", job)}-dispatched`,
          provider: "linear",
          operation: "linear_issue_state_update_v1",
          status: "dispatched",
          payload: {
            attemptId,
            handoffFingerprint: handoff.fingerprint,
            preparedActionFingerprint: handoff.preparedActionFingerprint,
            issueId: handoff.payload.issueId,
            targetStateId: handoff.payload.stateId,
            preconditionFingerprint: handoff.payload.preconditionFingerprint,
          },
          committedAt: now().toISOString(),
        });
        // This is the write-ahead boundary: the SQLite-backed receipt is
        // acknowledged before the provider request is allowed to start.
        await commitReceipt(dispatched);
        await context.reportProgress(
          "Dispatch marker committed; applying the exact Linear state update.",
        );
        try {
          await dependencies.linearUpdateIssueState!(
            {
              issueId: handoff.payload.issueId,
              stateId: handoff.payload.stateId,
            },
            credential,
            context.signal,
          );
        } catch {
          // Transport failure is ambiguous by definition. The only allowed
          // next operation is the independent readback below.
        }
      } else {
        await context.reportProgress(
          "A durable dispatch marker already exists; performing readback only.",
        );
      }

      let observed: LinearIssueReadbackV1;
      try {
        observed = validateLinearIssue(
          await dependencies.linearReadIssue!(
            { issueId: handoff.payload.issueId },
            credential,
            context.signal,
          ),
          handoff.payload.issueId,
        );
      } catch {
        const ambiguous = await buildLinearStateUpdateTransitionReceipt({
          job,
          handoff,
          attemptId,
          status: "ambiguous",
          observed: null,
          reconciliationMode: dispatchAlreadyCommitted
            ? "readback_only"
            : "dispatch",
          now,
        });
        await commitReceipt(ambiguous);
        return {
          status: "reconcile_required",
          blocker: {
            code: "linear_readback_inconclusive",
            message:
              "The Linear mutation may have applied, but independent issue readback is currently inconclusive.",
            requiredAction: null,
          },
        };
      }
      if (observed.state?.id !== handoff.payload.stateId) {
        const ambiguous = await buildLinearStateUpdateTransitionReceipt({
          job,
          handoff,
          attemptId,
          status: "ambiguous",
          observed,
          reconciliationMode: dispatchAlreadyCommitted
            ? "readback_only"
            : "dispatch",
          now,
        });
        await commitReceipt(ambiguous);
        return {
          status: "reconcile_required",
          blocker: {
            code: "linear_state_update_not_verified",
            message:
              "Linear readback does not yet show the exact approved target state; the mutation will not be redispatched.",
            requiredAction: null,
          },
        };
      }
      const verified = await buildLinearStateUpdateTransitionReceipt({
        job,
        handoff,
        attemptId,
        status: "verified",
        observed,
        reconciliationMode: dispatchAlreadyCommitted
          ? "readback_only"
          : "dispatch",
        now,
      });
      await commitReceipt(verified);
      return completedLinearStateUpdate(job, verified);
    },
  );
}

async function buildLinearStateUpdateTransitionReceipt(input: {
  job: CompanionJobV1;
  handoff: NonNullable<CompanionJobV1["preparedExternalActionHandoff"]>;
  attemptId: string;
  status: "ambiguous" | "verified";
  observed: LinearIssueReadbackV1 | null;
  reconciliationMode: "dispatch" | "readback_only";
  now: () => Date;
}) {
  const readbackFingerprint = input.observed
    ? await sha256Fingerprint(input.observed)
    : null;
  return buildCompanionReceiptV1({
    job: input.job,
    id: `${receiptId("linear", input.job)}-${input.status}`,
    provider: "linear",
    operation: "linear_issue_state_update_v1",
    status: input.status,
    payload: {
      attemptId: input.attemptId,
      handoffFingerprint: input.handoff.fingerprint,
      preparedActionFingerprint: input.handoff.preparedActionFingerprint,
      issueId: input.handoff.payload.issueId,
      targetStateId: input.handoff.payload.stateId,
      preconditionFingerprint:
        input.handoff.payload.preconditionFingerprint,
      observedStateId: input.observed?.state?.id ?? null,
      observedUpdatedAt: input.observed?.updatedAt ?? null,
      readbackFingerprint,
      reconciliationMode: input.reconciliationMode,
    },
    committedAt: input.now().toISOString(),
  });
}

function completedLinearStateUpdate(
  job: CompanionJobV1,
  receipt: Awaited<ReturnType<typeof buildCompanionReceiptV1>>,
): HeadlessWorkerResultV1 {
  const payload = receipt.payload;
  return {
    status: "complete",
    outputs: {
      issueId: String(payload.issueId),
      state: String(payload.observedStateId ?? payload.targetStateId),
      workItemFingerprint: receipt.fingerprint,
      summary: "Linear issue state update verified by independent readback.",
    },
    evidence: [
      {
        kind: "linear_readback",
        id: String(payload.issueId),
        fingerprint: receipt.fingerprint,
        status: "verified",
      },
    ],
    receipts: [receipt],
  };
}

export function createGitHubRepositoryReadbackExecutorV1(
  dependencies: InstalledDomainExecutorDependenciesV1,
): HeadlessDomainExecutorV1 {
  const now = dependencies.now ?? (() => new Date());
  return async (job, context) => {
    const scope = exactOperation(job, "github", "github_get_repository");
    if (scope) return scope;
    const inputError = rejectUnknownInputs(job, [
      "owner",
      "repository",
      "credentialReferenceId",
    ]);
    if (inputError) return inputError;
    const owner = githubName(job.inputs.owner);
    const repository = githubName(job.inputs.repository);
    const credentialReferenceId = credentialReference(job.inputs.credentialReferenceId);
    if (!owner || !repository || !credentialReferenceId) {
      return blocked(
        "invalid_github_repository_readback",
        "GitHub repository readback requires exact owner/repository names and an opaque credential reference.",
        "Select a trusted GitHub repository and credential binding in Obsidian, then resume.",
      );
    }
    if (!dependencies.secretStore || !dependencies.githubReadRepository) {
      return executorBindingUnavailable("github");
    }
    return withPersistentCredential(
      dependencies.secretStore,
      credentialReferenceId,
      async (credential) => {
        await context.reportProgress("Reading the authorized GitHub repository.");
        const repositoryResult = validateGitHubRepository(
          await dependencies.githubReadRepository!(
            { owner, repository },
            credential,
            context.signal,
          ),
          owner,
          repository,
        );
        const readbackFingerprint = await sha256Fingerprint(repositoryResult);
        const receipt = await buildCompanionReceiptV1({
          job,
          id: receiptId("github", job),
          provider: "github",
          operation: "github_repository_readback",
          status: "verified",
          payload: {
            fullName: repositoryResult.fullName,
            nodeId: repositoryResult.nodeId,
            updatedAt: repositoryResult.updatedAt,
            readbackFingerprint,
          },
          committedAt: now().toISOString(),
        });
        return {
          status: "complete",
          outputs: {
            repository: {
              id: repositoryResult.id,
              nodeId: repositoryResult.nodeId,
              fullName: repositoryResult.fullName,
              defaultBranch: repositoryResult.defaultBranch,
              private: repositoryResult.private,
              archived: repositoryResult.archived,
              updatedAt: repositoryResult.updatedAt,
            },
            readbackFingerprint,
          },
          evidence: [
            {
              kind: "github_repository_readback",
              fullName: repositoryResult.fullName,
              readbackFingerprint,
            },
          ],
          receipts: [receipt],
        };
      },
    );
  };
}

async function withPersistentCredential(
  store: Pick<SecretStoreV1, "health" | "lease">,
  referenceId: string,
  use: (credential: string) => Promise<HeadlessWorkerResultV1>,
): Promise<HeadlessWorkerResultV1> {
  try {
    await requireBackgroundSecretStoreV1(store);
    const lease = await store.lease(referenceId, { ttlSeconds: 60 });
    try {
      return await lease.withSecret(use);
    } finally {
      lease.dispose();
    }
  } catch (error) {
    if (error instanceof SecretStoreBoundaryErrorV1) {
      return blocked(
        error.code,
        error.message,
        error.code === "secure_persistent_credential_backend_required"
          ? "Configure a persistent OS credential-store backend, then resume."
          : "Reconnect the companion secure store and resume.",
      );
    }
    throw error;
  }
}

function exactOperation(
  job: CompanionJobV1,
  domain: BackgroundExecutionDomainV1,
  tool: string,
): HeadlessWorkerResultV1 | null {
  if (
    job.domain !== domain ||
    job.allowedTools.length !== 1 ||
    job.allowedTools[0] !== tool
  ) {
    return blocked(
      "executor_scope_mismatch",
      `The installed ${domain} executor accepts only the fixed ${tool} operation.`,
      null,
    );
  }
  return null;
}

function rejectUnknownInputs(
  job: CompanionJobV1,
  allowed: string[],
): HeadlessWorkerResultV1 | null {
  const unknown = Object.keys(job.inputs).filter((key) => !allowed.includes(key));
  if (unknown.length === 0) return null;
  return blocked(
    "executor_input_scope_mismatch",
    "The background executor rejected inputs outside its fixed operation contract.",
    null,
  );
}

function blocked(
  code: string,
  message: string,
  requiredAction: string | null,
): HeadlessWorkerResultV1 {
  return { status: "blocked", blocker: { code, message, requiredAction } };
}

function executorBindingUnavailable(domain: "linear" | "github"): HeadlessWorkerResultV1 {
  return blocked(
    `${domain}_executor_binding_unavailable`,
    `The installed ${domain} readback executor is not bound to its fixed provider client and secure store.`,
    "Repair or upgrade the companion installation, then resume.",
  );
}

function boundedIdentifier(value: unknown, _field: string, maximum: number): string | null {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value)
    ? value
    : null;
}

function optionalBoundedIdentifier(
  value: unknown,
  field: string,
  maximum: number,
): string | null | undefined {
  return value === undefined ? undefined : boundedIdentifier(value, field, maximum);
}

function fingerprint(value: unknown): string | null {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value)
    ? value
    : null;
}

function optionalFingerprint(value: unknown): string | null | undefined {
  return value === undefined ? undefined : fingerprint(value);
}

function credentialReference(value: unknown): string | null {
  return typeof value === "string" &&
    /^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/.test(value)
    ? value
    : null;
}

function githubName(value: unknown): string | null {
  return typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(value)
    ? value
    : null;
}

function receiptId(domain: BackgroundExecutionDomainV1, job: CompanionJobV1): string {
  return `${domain}-${job.id}`.slice(0, 256);
}

function validateLinearIssue(
  value: LinearIssueReadbackV1,
  expectedId: string,
): LinearIssueReadbackV1 {
  if (
    !value ||
    value.id !== expectedId ||
    !boundedIdentifier(value.identifier, "identifier", 128) ||
    typeof value.title !== "string" ||
    value.title.length > 4_096 ||
    Number.isNaN(Date.parse(value.updatedAt)) ||
    (value.url !== null &&
      (typeof value.url !== "string" ||
        !value.url.startsWith("https://linear.app/") ||
        value.url.length > 8_192)) ||
    (value.state !== null &&
      (!boundedIdentifier(value.state.id, "state.id", 128) ||
        typeof value.state.name !== "string" ||
        value.state.name.length > 512))
  ) {
    throw new Error("Linear issue readback returned an invalid or drifted response.");
  }
  return Object.freeze({
    ...value,
    state: value.state ? Object.freeze({ ...value.state }) : null,
  });
}

/**
 * Normalize the fixed full Linear issue selection into the same canonical
 * snapshot shape used by the core Linear client. Keeping this helper in the
 * shared runtime prevents the separately versioned companion from importing
 * core plugin internals.
 */
export async function normalizeLinearIssueReadbackV1(
  value: unknown,
): Promise<LinearIssueReadbackV1> {
  const issue = record(value, "Linear issue");
  const reference = (candidate: unknown, label: string) => {
    const source = record(candidate, label);
    return {
      id: requiredText(source.id, `${label}.id`),
      ...(typeof source.name === "string" ? { name: source.name } : {}),
      ...(typeof source.key === "string" ? { key: source.key } : {}),
      ...(typeof source.identifier === "string"
        ? { identifier: source.identifier }
        : {}),
      ...(typeof source.url === "string" ? { url: source.url } : {}),
    };
  };
  const optionalReference = (key: string) =>
    issue[key] === null || issue[key] === undefined
      ? {}
      : { [key]: reference(issue[key], key) };
  const stateSource = record(issue.state, "issue.state");
  const labelsSource = record(issue.labels, "issue.labels");
  const labelNodes = Array.isArray(labelsSource.nodes)
    ? labelsSource.nodes.slice(0, 50)
    : [];
  const withoutHash = {
    resourceType: "issue",
    id: requiredText(issue.id, "issue.id"),
    trashed: issue.trashed === true,
    identifier: requiredText(issue.identifier, "issue.identifier"),
    url: requiredText(issue.url, "issue.url"),
    title: requiredText(issue.title, "issue.title"),
    priority: requiredNumber(issue.priority, "issue.priority"),
    team: reference(issue.team, "issue.team"),
    state: {
      ...reference(issue.state, "issue.state"),
      ...(typeof stateSource.type === "string"
        ? { type: stateSource.type }
        : {}),
    },
    labels: labelNodes.map((label) => reference(label, "issue.label")),
    ...(typeof issue.description === "string"
      ? {
          description:
            issue.description.length <= 20_000
              ? issue.description
              : `${issue.description.slice(0, 20_000)}\n[truncated]`,
        }
      : {}),
    ...(typeof issue.estimate === "number" && Number.isFinite(issue.estimate)
      ? { estimate: issue.estimate }
      : {}),
    ...copyString(issue, "dueDate"),
    ...copyString(issue, "createdAt"),
    ...copyString(issue, "updatedAt"),
    ...copyString(issue, "archivedAt"),
    ...copyString(issue, "completedAt"),
    ...copyString(issue, "canceledAt"),
    ...optionalReference("project"),
    ...optionalReference("cycle"),
    ...optionalReference("projectMilestone"),
    ...optionalReference("assignee"),
    ...optionalReference("parent"),
  };
  return {
    id: withoutHash.id,
    identifier: withoutHash.identifier,
    title: withoutHash.title,
    updatedAt: requiredText(issue.updatedAt, "issue.updatedAt"),
    url: withoutHash.url,
    state: {
      id: withoutHash.state.id,
      name: requiredText(withoutHash.state.name, "issue.state.name"),
    },
    snapshotFingerprint: await sha256Fingerprint(withoutHash),
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function requiredNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} is missing.`);
  }
  return value;
}

function copyString(
  value: Record<string, unknown>,
  key: string,
): Record<string, string> {
  return typeof value[key] === "string" ? { [key]: value[key] } : {};
}

function validateGitHubRepository(
  value: GitHubRepositoryReadbackV1,
  owner: string,
  repository: string,
): GitHubRepositoryReadbackV1 {
  if (
    !value ||
    !Number.isSafeInteger(value.id) ||
    value.id <= 0 ||
    !boundedIdentifier(value.nodeId, "nodeId", 256) ||
    value.fullName.toLowerCase() !== `${owner}/${repository}`.toLowerCase() ||
    value.fullName.length > 201 ||
    !githubName(value.defaultBranch) ||
    typeof value.private !== "boolean" ||
    typeof value.archived !== "boolean" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new Error("GitHub repository readback returned an invalid or drifted response.");
  }
  return Object.freeze({ ...value });
}
