import type { SecretStoreV1 } from "../../core-api/src/secretStoreV1";
import {
  LINEAR_QUEUE_SCAN_INTERVAL_MS,
  LINEAR_QUEUE_SCAN_LIMIT,
} from "../../core-api/src/linearQueuePolicyV1";
import { sha256Fingerprint } from "./canonicalize";
import type {
  CompanionLinearQueueCandidateObservationV1,
  CompanionLinearQueueConfigurationV1,
  CompanionLinearQueueCursorV1,
  CompanionLinearQueueStatusV1,
} from "./companionCoordinatorClient";
import type { CompanionCoordinatorClientV1 } from "./companionCoordinatorClient";
import {
  requireBackgroundSecretStoreV1,
  SecretStoreBoundaryErrorV1,
} from "./secretStoreV1";

export {
  LINEAR_QUEUE_SCAN_INTERVAL_MS as COMPANION_LINEAR_QUEUE_SCAN_INTERVAL_MS,
  LINEAR_QUEUE_SCAN_LIMIT as COMPANION_LINEAR_QUEUE_SCAN_LIMIT,
};

export interface CompanionLinearQueueScanPageV1 {
  candidates: CompanionLinearQueueCandidateObservationV1[];
  cursor: CompanionLinearQueueCursorV1 | null;
}

export interface CompanionLinearQueuePollerDependenciesV1 {
  client: Pick<
    CompanionCoordinatorClientV1,
    "claimLinearQueueScan" | "completeLinearQueueScan" | "failLinearQueueScan"
  >;
  secretStore: Pick<SecretStoreV1, "health" | "lease">;
  coordinatorId: string;
  catalogFingerprint: string;
  scan(
    input: {
      configuration: CompanionLinearQueueConfigurationV1;
      cursor: CompanionLinearQueueCursorV1 | null;
    },
    credential: string,
    signal: AbortSignal,
  ): Promise<CompanionLinearQueueScanPageV1>;
  now?: () => Date;
}

type CompanionLinearQueuePollFailureCodeV1 =
  | "linear_queue_provider_unavailable"
  | "linear_queue_invalid_response"
  | "linear_queue_credential_unavailable";

export type CompanionLinearQueuePollResultV1 =
  | {
      status: "completed";
      candidates: number;
      queueStatus: CompanionLinearQueueStatusV1;
    }
  | {
      status: "skipped";
      reason: "disabled" | "not_due" | "authority_expired" | "scan_in_progress";
    }
  | {
      status: "failed";
      code: CompanionLinearQueuePollFailureCodeV1;
    };

/**
 * Restart-safe, read-only queue polling. The provider can contribute only
 * fingerprinted candidate data. The coordinator service independently creates
 * fixed readback jobs; this class cannot claim work, mutate Linear, or access a
 * vault/workspace path.
 */
export class CompanionLinearQueuePollerV1 {
  private readonly now: () => Date;

  constructor(private readonly dependencies: CompanionLinearQueuePollerDependenciesV1) {
    this.now = dependencies.now ?? (() => new Date());
    requireStableId(dependencies.coordinatorId, "coordinatorId");
    requireFingerprint(dependencies.catalogFingerprint, "catalogFingerprint");
  }

  async runDue(signal = new AbortController().signal): Promise<CompanionLinearQueuePollResultV1> {
    const claimedAt = this.now().toISOString();
    const claim = await this.dependencies.client.claimLinearQueueScan({
      coordinatorId: this.dependencies.coordinatorId,
      catalogFingerprint: this.dependencies.catalogFingerprint,
      claimedAt,
    });
    if (!claim.claimed) {
      return { status: "skipped", reason: claim.reason };
    }

    const lease = claim.lease;
    let failureCode: CompanionLinearQueuePollFailureCodeV1 =
      "linear_queue_provider_unavailable";
    try {
      if (signal.aborted) throw new DOMException("Linear queue scan aborted.", "AbortError");
      await requireBackgroundSecretStoreV1(this.dependencies.secretStore);
      const secretLease = await this.dependencies.secretStore.lease(
        claim.configuration.credentialReferenceId,
        { ttlSeconds: 120 },
      );
      try {
        const page = await secretLease.withSecret((credential) =>
          this.dependencies.scan(
            { configuration: claim.configuration, cursor: claim.cursor },
            credential,
            signal,
          ),
        );
        failureCode = "linear_queue_invalid_response";
        await validateScanPage(page, claim.configuration);
        const queueStatus = await this.dependencies.client.completeLinearQueueScan({
          lease,
          scannedAt: this.now().toISOString(),
          candidates: page.candidates,
          cursor: page.cursor,
        });
        return {
          status: "completed",
          candidates: page.candidates.length,
          queueStatus,
        };
      } finally {
        secretLease.dispose();
      }
    } catch (error) {
      if (error instanceof SecretStoreBoundaryErrorV1) {
        failureCode = "linear_queue_credential_unavailable";
      }
      await this.dependencies.client
        .failLinearQueueScan({
          lease,
          failedAt: this.now().toISOString(),
          errorCode: failureCode,
        })
        .catch(() => undefined);
      return { status: "failed", code: failureCode };
    } finally {
      lease.dispose();
    }
  }
}

export async function createCompanionLinearQueueConfigurationV1(input: {
  workspaceId: string;
  queueProjectId: string;
  credentialReferenceId: string;
  authority: {
    version: 1;
    grantId: string;
    fingerprint: string;
    authorizedAt: string;
    expiresAt: string;
  };
}): Promise<CompanionLinearQueueConfigurationV1> {
  const workspaceId = requireStableId(input.workspaceId, "workspaceId");
  const queueProjectId = requireStableId(input.queueProjectId, "queueProjectId");
  const credentialReferenceId = requireCredentialReference(
    input.credentialReferenceId,
  );
  requireStableId(input.authority.grantId, "authority.grantId");
  requireFingerprint(input.authority.fingerprint, "authority.fingerprint");
  const authorizedAt = requireIso(input.authority.authorizedAt, "authority.authorizedAt");
  const expiresAt = requireIso(input.authority.expiresAt, "authority.expiresAt");
  if (expiresAt - authorizedAt !== 4 * 60 * 60_000) {
    throw new Error("Companion Linear queue authority must use the exact four-hour grant.");
  }
  const authoritySubjectId = `linear-queue-project:${queueProjectId}`;
  const queueBindingFingerprint = await sha256Fingerprint({
    version: 1,
    system: "linear",
    workspaceId,
    queueProjectId,
  });
  const withoutConfigurationFingerprint = {
    version: 1 as const,
    workspaceId,
    queueProjectId,
    credentialReferenceId,
    authoritySubjectId,
    authority: Object.freeze({ ...input.authority }),
    queueBindingFingerprint,
  };
  return Object.freeze({
    ...withoutConfigurationFingerprint,
    configurationFingerprint: await sha256Fingerprint(
      withoutConfigurationFingerprint,
    ),
  });
}

export async function createCompanionLinearQueueCandidateObservationV1(input: {
  issueId: string;
  identifier: string;
  queueProjectId: string;
  remoteStateId: string;
  remoteUpdatedAt: string;
  workItemFingerprint: string;
  readbackFingerprint: string;
}): Promise<CompanionLinearQueueCandidateObservationV1> {
  const withoutCandidateFingerprint = {
    issueId: requireStableId(input.issueId, "issueId"),
    identifier: requireStableId(input.identifier, "identifier"),
    queueProjectId: requireStableId(input.queueProjectId, "queueProjectId"),
    remoteStateId: requireStableId(input.remoteStateId, "remoteStateId"),
    remoteUpdatedAt: input.remoteUpdatedAt,
    workItemFingerprint: requireFingerprint(
      input.workItemFingerprint,
      "workItemFingerprint",
    ),
    readbackFingerprint: requireFingerprint(
      input.readbackFingerprint,
      "readbackFingerprint",
    ),
  };
  requireIso(withoutCandidateFingerprint.remoteUpdatedAt, "remoteUpdatedAt");
  return Object.freeze({
    ...withoutCandidateFingerprint,
    candidateFingerprint: await sha256Fingerprint(withoutCandidateFingerprint),
  });
}

async function validateScanPage(
  page: CompanionLinearQueueScanPageV1,
  configuration: CompanionLinearQueueConfigurationV1,
): Promise<void> {
  if (
    !page ||
    !Array.isArray(page.candidates) ||
    page.candidates.length > LINEAR_QUEUE_SCAN_LIMIT
  ) {
    throw new Error("Companion Linear queue scan exceeded its fixed candidate limit.");
  }
  const seen = new Set<string>();
  for (const candidate of page.candidates) {
    if (
      candidate.queueProjectId !== configuration.queueProjectId ||
      seen.has(candidate.candidateFingerprint)
    ) {
      throw new Error("Companion Linear queue scan escaped its configured project.");
    }
    seen.add(candidate.candidateFingerprint);
    const expected = await createCompanionLinearQueueCandidateObservationV1(candidate);
    if (expected.candidateFingerprint !== candidate.candidateFingerprint) {
      throw new Error("Companion Linear queue candidate fingerprint drifted.");
    }
  }
  if (page.cursor) {
    requireStableId(page.cursor.issueId, "cursor.issueId");
    requireIso(page.cursor.updatedAt, "cursor.updatedAt");
  }
}

function requireStableId(value: string, field: string): string {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value)
  ) {
    throw new Error(`Companion Linear queue ${field} is invalid.`);
  }
  return value;
}

function requireFingerprint(value: string, field: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Companion Linear queue ${field} is invalid.`);
  }
  return value;
}

function requireCredentialReference(value: string): string {
  if (!/^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/.test(value)) {
    throw new Error("Companion Linear queue credential reference is invalid.");
  }
  return value;
}

function requireIso(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Companion Linear queue ${field} is invalid.`);
  }
  return parsed;
}
