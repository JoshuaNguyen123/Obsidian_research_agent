import {
  backgroundGitHubActionAttemptIdV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionV1,
} from "../../../packages/core-api/src/preparedBackgroundGitHubActionV1";
import { parsePreparedBackgroundGitHubPackageIdentityV1 } from "../../../packages/core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import { parseBackgroundGitHubVerifiedResultV1 } from "../../../packages/core-api/src/backgroundGitHubVerifiedResultV1";
import {
  buildCompanionReceiptV1,
  type CompanionJobV1,
  type HeadlessDomainExecutorV1,
  type HeadlessWorkerContextV1,
  type HeadlessWorkerResultV1,
} from "../../../packages/headless-runtime/src/backgroundContinuation";
import {
  BackgroundGitHubContinuationRuntimeV1,
  type BackgroundGitHubContinuationDependenciesV1,
  type BackgroundGitHubHostApprovalReceiptVerifierV1,
} from "./BackgroundGitHubContinuationV1";
import {
  FileBackgroundGitHubActionAttemptStoreV1,
} from "./BackgroundGitHubAttemptStoreV1";
import {
  PreparedBackgroundGitHubPackageStoreV1,
} from "./PreparedBackgroundGitHubPackageStoreV1";

export interface PreparedBackgroundGitHubStandaloneExecutorOptionsV1 {
  applicationDataRoot: string;
  /** Independently trusted verifier materialized by the installed host. */
  hostApprovalReceiptVerifier?: BackgroundGitHubHostApprovalReceiptVerifierV1;
  /** Authenticated service readback; false keeps provider/WAL dispatch disabled. */
  hostApprovalSignerAvailable?: () => Promise<boolean>;
  /** Closed production dependency factory. No dynamic module or arbitrary API ids. */
  createRuntimeDependencies?: (
    input: {
      action: PreparedBackgroundGitHubActionV1;
      attempts: FileBackgroundGitHubActionAttemptStoreV1;
      approvalReceipts: BackgroundGitHubHostApprovalReceiptVerifierV1;
    },
  ) => BackgroundGitHubContinuationDependenciesV1;
  now?: () => Date;
}

/**
 * Integrations-owned standalone boundary. Package bytes are loaded only from
 * companion app-data. Until a pinned host approval verifier is installed, the
 * executor proves transport/readback and stops before provider WAL or effects.
 */
export function createPreparedBackgroundGitHubStandaloneExecutorV1(
  options: PreparedBackgroundGitHubStandaloneExecutorOptionsV1,
): HeadlessDomainExecutorV1 {
  const now = options.now ?? (() => new Date());
  const packages = new PreparedBackgroundGitHubPackageStoreV1({
    applicationDataRoot: options.applicationDataRoot,
    now,
  });
  const attempts = new FileBackgroundGitHubActionAttemptStoreV1(
    options.applicationDataRoot,
  );
  return async (job, context) => {
    const parsed = exactPreparedJob(job);
    if (!parsed) return invalidJob();
    const { action, identity } = parsed;
    let preparedPackage;
    try {
      preparedPackage = await packages.load({
        packageId: identity.packageId,
        packageFingerprint: identity.packageFingerprint,
        jobId: job.id,
        backgroundAuthorizationFingerprint: job.authorization.fingerprint,
        actionFingerprint: identity.actionFingerprint,
        operation: identity.operation,
        publicationId: identity.publicationId,
        repositoryBindingFingerprint: identity.repositoryBindingFingerprint,
        repositoryProfileFingerprint: identity.repositoryProfileFingerprint,
        verifiedAccountId: identity.verifiedAccountId,
      }, {
        reconciliationAttempts: attempts,
      });
    } catch {
      return blocked(
        "background_github_package_unavailable",
        "The prepared GitHub package could not be loaded or did not match the exact worker scope.",
        "Reconnect Obsidian and re-export the same exact integrations package.",
      );
    }
    if (
      preparedPackage.action.fingerprint !== action.fingerprint ||
      preparedPackage.jobId !== job.id
    ) return invalidJob();

    if (!options.hostApprovalReceiptVerifier) {
      return signerUnavailable();
    }
    if (options.hostApprovalSignerAvailable) {
      let available = false;
      try {
        available = await options.hostApprovalSignerAvailable();
      } catch {
        available = false;
      }
      if (!available) return signerUnavailable();
    }
    if (!options.createRuntimeDependencies) {
      return blocked(
        "background_github_provider_runtime_unavailable",
        "The fixed GitHub provider, worktree push, and readback runtime is not installed.",
        "Repair or upgrade the integrations companion runtime, then resume this package.",
      );
    }
    try {
      const runtimeDependencies = options.createRuntimeDependencies({
          action,
          attempts,
          approvalReceipts: options.hostApprovalReceiptVerifier,
        });
      const runtime = new BackgroundGitHubContinuationRuntimeV1({
        ...runtimeDependencies,
        attempts,
        approvalReceipts: options.hostApprovalReceiptVerifier,
      });
      const result = await runtime.execute({
        jobId: job.id,
        package: preparedPackage,
        signal: context.signal,
      });
      return projectResult(job, context, action, result);
    } catch {
      return blocked(
        "background_github_provider_boundary_rejected",
        "The fixed GitHub provider rejected credential, account, repository, or runtime drift before a safe continuation could complete.",
        "Repair the pinned GitHub credential or repository binding, then resume the same package for readback.",
      );
    }
  };
}

function exactPreparedJob(job: Readonly<CompanionJobV1>) {
  if (
    job.domain !== "github" ||
    job.allowedTools.length !== 1 ||
    Object.keys(job.inputs).length !== 0 ||
    !job.preparedBackgroundGitHubAction ||
    !job.preparedBackgroundGitHubPackage
  ) return null;
  const action = parsePreparedBackgroundGitHubActionV1(job.preparedBackgroundGitHubAction);
  const identity = parsePreparedBackgroundGitHubPackageIdentityV1(
    job.preparedBackgroundGitHubPackage,
  );
  if (
    job.allowedTools[0] !== action.toolName ||
    action.missionId !== job.missionId ||
    action.nodeId !== job.nodeId ||
    action.graphRevision !== job.graphRevision ||
    action.capabilityEnvelopeFingerprint !== job.capabilityEnvelopeFingerprint ||
    identity.actionFingerprint !== action.fingerprint ||
    identity.backgroundAuthorizationFingerprint !== job.authorization.fingerprint
  ) return null;
  return { action, identity };
}

async function projectResult(
  job: Readonly<CompanionJobV1>,
  context: HeadlessWorkerContextV1,
  action: PreparedBackgroundGitHubActionV1,
  result: Awaited<ReturnType<BackgroundGitHubContinuationRuntimeV1["execute"]>>,
): Promise<HeadlessWorkerResultV1> {
  if (result.status === "blocked") {
    return blocked("background_github_blocked", result.message, null);
  }
  const attemptId = backgroundGitHubActionAttemptIdV1(job.id, action);
  const status = result.status === "verified"
    ? "verified" as const
    : result.status === "reconcile_required"
      ? "ambiguous" as const
      : "failed" as const;
  const verifiedResult = result.status === "verified"
    ? parseBackgroundGitHubVerifiedResultV1(result.proof)
    : null;
  const verifiedResultPayload = verifiedResult ? { ...verifiedResult } : null;
  const receipt = await buildCompanionReceiptV1({
    job,
    id: `github-${attemptId.slice("sha256:".length, "sha256:".length + 40)}`,
    provider: "github",
    operation: action.operation,
    status,
    payload: {
      attemptId,
      actionFingerprint: action.fingerprint,
      packageFingerprint: job.preparedBackgroundGitHubPackage!.packageFingerprint,
      ...(verifiedResult ? {
        resultFingerprint: verifiedResult.fingerprint,
        verifiedResult: verifiedResultPayload,
      } : {}),
    },
    committedAt: context.now().toISOString(),
  });
  if (result.status === "verified") {
    return {
      status: "complete",
      outputs: {
        resultFingerprint: verifiedResult!.fingerprint,
        githubVerifiedResult: verifiedResultPayload!,
      },
      evidence: [{ kind: "github_background_readback", fingerprint: verifiedResult!.fingerprint }],
      receipts: [receipt],
    };
  }
  if (result.status === "reconcile_required") {
    return {
      status: "reconcile_required",
      receipts: [receipt],
      blocker: {
        code: "provider_reconcile_required",
        message: result.message,
        requiredAction: "Resume the same durable package for readback only.",
      },
    };
  }
  return { status: "blocked", receipts: [receipt], blocker: {
    code: "background_github_not_applied",
    message: result.message,
    requiredAction: null,
  } };
}

function invalidJob(): HeadlessWorkerResultV1 {
  return blocked(
    "invalid_background_github_package",
    "The companion rejected a GitHub action outside the exact closed package identity.",
    "Reconnect Obsidian and prepare a fresh exact GitHub action.",
  );
}

function signerUnavailable(): HeadlessWorkerResultV1 {
  return blocked(
    "background_github_host_signer_unavailable",
    "The companion has no independently trusted host approval-signature verifier; GitHub provider dispatch is disabled.",
    "Reconnect Obsidian and install or rotate the pinned host approval verification key, then resume this package.",
  );
}

function blocked(code: string, message: string, requiredAction: string | null): HeadlessWorkerResultV1 {
  return { status: "blocked", blocker: { code, message, requiredAction } };
}
