import type {
  BackgroundExecutionDomainV1,
  BootstrapTokenLeaseV1,
  CompanionEventTypeV1,
  CompanionEventV1,
  CompanionJobV1,
  CompanionReceiptV1,
} from "./backgroundContinuation";
import {
  COMPANION_MAX_REQUEST_BYTES,
  COMPANION_COORDINATION_PROTOCOL_VERSION,
} from "./backgroundContinuation";
import {
  normalizeCompanionBaseUrlV1,
  resolveCompanionBootstrapSessionV1,
} from "./companionCredentialSession";
import type { MissionJsonValueV1 } from "./missionGraphV3";
import {
  parseHostApprovalReceiptEvidenceV1,
  parseHostApprovalReceiptV1,
  type HostApprovalReceiptEvidenceV1,
  type HostApprovalReceiptV1,
} from "../../core-api/src/hostApprovalReceiptV1";

export interface CompanionServiceHealthV1 {
  ok: boolean;
  service: string;
  browserReady: boolean;
  memoryReady: boolean;
  coordinatorReady: boolean;
  workerReady: boolean;
  workerDiagnostic: string | null;
  installedExecutorDomains?: BackgroundExecutionDomainV1[];
  executorCatalogVersion?: 1;
  secureStorePersistent: boolean;
  backgroundEnabled: boolean;
  backgroundBlocker: string | null;
  version: string;
}

export interface CompanionServiceStatusV1 {
  ok: boolean;
  coordinatorId: string;
  queuedJobs: number;
  leasedJobs: number;
  eventCount: number;
  receiptCount: number;
  secureStorePersistent: boolean;
  secureStoreBackend: string;
  backgroundRequested: boolean;
  backgroundEnabled: boolean;
  backgroundBlocker: string | null;
  workerReady: boolean;
  workerDiagnostic: string | null;
  installedExecutorDomains?: BackgroundExecutionDomainV1[];
  executorCatalogVersion?: 1;
}

export interface CompanionWorkerHeartbeatV1 {
  ok: true;
  workerReady: true;
  expiresAt: string;
}

export interface CompanionHostApprovalSignerDescriptionV1 {
  version: 1;
  kind: "host_approval_signer";
  persistent: boolean;
  provisioned: boolean;
  backend: string;
  signingKeyFingerprint: string | null;
}

export interface CompanionHostApprovalVerificationResultV1 {
  version: 1;
  verified: boolean;
  reason:
    | "verified"
    | "signer_unavailable"
    | "key_mismatch"
    | "authenticator_mismatch"
    | "decision_not_approved";
  signingKeyFingerprint: string | null;
}

export interface CompanionLinearQueueConfigurationV1 {
  version: 1;
  workspaceId: string;
  queueProjectId: string;
  credentialReferenceId: string;
  authoritySubjectId: string;
  authority: {
    version: 1;
    grantId: string;
    fingerprint: string;
    authorizedAt: string;
    expiresAt: string;
  };
  queueBindingFingerprint: string;
  configurationFingerprint: string;
}

export interface CompanionLinearQueueCursorV1 {
  updatedAt: string;
  issueId: string;
}

export interface CompanionLinearQueueCandidateObservationV1 {
  issueId: string;
  identifier: string;
  queueProjectId: string;
  remoteStateId: string;
  remoteUpdatedAt: string;
  workItemFingerprint: string;
  readbackFingerprint: string;
  candidateFingerprint: string;
}

export interface CompanionLinearQueueStatusV1 {
  enabled: boolean;
  configurationFingerprint: string | null;
  queueProjectId: string | null;
  authorityExpiresAt: string | null;
  cursor: CompanionLinearQueueCursorV1 | null;
  nextScanAt: string | null;
  lastScanStartedAt: string | null;
  lastScanCompletedAt: string | null;
  lastErrorCode: string | null;
  candidateCount: number;
  scheduledReadbackCount: number;
  latestEventSequence: number;
}

export interface CompanionLinearQueueEventV1 {
  sequence: number;
  type:
    | "linear_queue_configured"
    | "linear_queue_disabled"
    | "linear_queue_scan_started"
     | "linear_queue_scan_completed"
     | "linear_queue_scan_failed"
     | "linear_queue_rescan_requested"
     | "linear_queue_authority_expired"
    | "linear_queue_candidate_scheduled";
  payload: Record<string, MissionJsonValueV1>;
  createdAt: string;
}

export interface CompanionLinearQueueScanLeaseV1 {
  readonly description: {
    scanId: string;
    coordinatorId: string;
    configurationFingerprint: string;
  };
  readonly disposed: boolean;
  withToken<TResult>(use: (token: string) => Promise<TResult>): Promise<TResult>;
  dispose(): void;
  toJSON(): { redacted: true; description: CompanionLinearQueueScanLeaseV1["description"] };
}

export type CompanionLinearQueueScanClaimV1 =
  | {
      claimed: false;
      reason: "disabled" | "not_due" | "authority_expired" | "scan_in_progress";
      nextScanAt: string | null;
    }
  | {
      claimed: true;
      reason: "claimed";
      configuration: CompanionLinearQueueConfigurationV1;
      cursor: CompanionLinearQueueCursorV1 | null;
      nextScanAt: string | null;
      lease: CompanionLinearQueueScanLeaseV1;
    };

export interface CompanionRemoteJobV1 {
  id: string;
  missionId: string;
  nodeId: string;
  executionHost: "companion" | BackgroundExecutionDomainV1;
  state: string;
  payload: Record<string, MissionJsonValueV1>;
  capabilityEnvelope: Record<string, MissionJsonValueV1>;
  idempotencyKey: string;
  ownerCoordinatorId: string | null;
  leaseExpiresAt: string | null;
  attempts: number;
  output?: Record<string, MissionJsonValueV1>;
  createdAt: string;
  updatedAt: string;
}

export interface CompanionJobLeaseDescriptionV1 {
  jobId: string;
  coordinatorId: string;
  expiresAt: string | null;
}

/** Closure-backed bearer lease returned from a job claim. */
export interface CompanionJobLeaseHandleV1 {
  readonly description: CompanionJobLeaseDescriptionV1;
  readonly disposed: boolean;
  withLeaseToken<TResult>(use: (token: string) => Promise<TResult>): Promise<TResult>;
  dispose(): void;
  toJSON(): { redacted: true; description: CompanionJobLeaseDescriptionV1 };
}

export interface CompanionClaimResultV1 {
  job: CompanionRemoteJobV1;
  lease: CompanionJobLeaseHandleV1;
}

export interface CompanionCoordinatorClientOptionsV1 {
  baseUrl: string;
  credential?: BootstrapTokenLeaseV1;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

export class CompanionCoordinatorClientV1 {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: CompanionCoordinatorClientOptionsV1) {
    this.baseUrl = normalizeCompanionBaseUrlV1(options.baseUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = clampInteger(options.timeoutMs ?? 15_000, 250, 120_000);
    this.maxResponseBytes = clampInteger(
      options.maxResponseBytes ?? COMPANION_MAX_REQUEST_BYTES,
      1_024,
      16 * COMPANION_MAX_REQUEST_BYTES,
    );
  }

  async health(): Promise<CompanionServiceHealthV1> {
    return this.requestJson<CompanionServiceHealthV1>("/health", { method: "GET" });
  }

  async status(): Promise<CompanionServiceStatusV1> {
    return this.requestJson<CompanionServiceStatusV1>("/status", { method: "GET" });
  }

  async workerHeartbeat(input: {
    coordinatorId: string;
    catalogFingerprint: string;
    polledAt: string;
  }): Promise<CompanionWorkerHeartbeatV1> {
    return this.requestJson<CompanionWorkerHeartbeatV1>("/worker/heartbeat", {
      method: "POST",
      body: this.jsonBody(input),
    });
  }

  async describeHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return parseHostApprovalSignerDescriptionV1(
      await this.requestJson<unknown>("/host-approval-signer", { method: "GET" }),
    );
  }

  async provisionHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return parseHostApprovalSignerDescriptionV1(
      await this.requestJson<unknown>("/host-approval-signer/provision", {
        method: "POST",
        body: this.jsonBody({ version: 1 }),
      }),
    );
  }

  async rotateHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return parseHostApprovalSignerDescriptionV1(
      await this.requestJson<unknown>("/host-approval-signer/rotate", {
        method: "POST",
        body: this.jsonBody({ version: 1 }),
      }),
    );
  }

  /** Seals already-approved host evidence; this method never creates approval authority. */
  async sealHostApprovalReceipt(
    evidenceInput: HostApprovalReceiptEvidenceV1,
  ): Promise<HostApprovalReceiptV1> {
    const evidence = parseHostApprovalReceiptEvidenceV1(evidenceInput);
    if (evidence.decision !== "approved") {
      throw new CompanionCoordinatorClientErrorV1(
        "invalid_request",
        "Only already-approved host evidence can be sealed.",
      );
    }
    return parseHostApprovalReceiptV1(
      await this.requestJson<unknown>("/host-approval-signer/sign", {
        method: "POST",
        body: this.jsonBody({ version: 1, evidence }),
      }),
    );
  }

  async verifyHostApprovalReceipt(
    receiptInput: HostApprovalReceiptV1,
  ): Promise<CompanionHostApprovalVerificationResultV1> {
    const receipt = parseHostApprovalReceiptV1(receiptInput);
    return parseHostApprovalVerificationResultV1(
      await this.requestJson<unknown>("/host-approval-signer/verify", {
        method: "POST",
        body: this.jsonBody({ version: 1, receipt }),
      }),
    );
  }

  async configureLinearQueue(
    configuration: CompanionLinearQueueConfigurationV1,
  ): Promise<CompanionLinearQueueStatusV1> {
    return this.requestJson<CompanionLinearQueueStatusV1>(
      "/linear-queue/configuration",
      { method: "PUT", body: this.jsonBody(configuration) },
    );
  }

  async disableLinearQueue(): Promise<CompanionLinearQueueStatusV1> {
    return this.requestJson<CompanionLinearQueueStatusV1>(
      "/linear-queue/configuration",
      { method: "DELETE" },
    );
  }

  async linearQueueStatus(): Promise<CompanionLinearQueueStatusV1> {
    return this.requestJson<CompanionLinearQueueStatusV1>(
      "/linear-queue/status",
      { method: "GET" },
    );
  }

  async claimLinearQueueScan(input: {
    coordinatorId: string;
    catalogFingerprint: string;
    claimedAt: string;
  }): Promise<CompanionLinearQueueScanClaimV1> {
    const response = await this.requestJson<{
      claimed: boolean;
      reason: CompanionLinearQueueScanClaimV1["reason"];
      scanId?: string | null;
      scanToken?: string | null;
      configuration?: CompanionLinearQueueConfigurationV1 | null;
      cursor?: CompanionLinearQueueCursorV1 | null;
      nextScanAt?: string | null;
    }>("/linear-queue/scans/claim", {
      method: "POST",
      body: this.jsonBody(input),
    });
    if (!response.claimed) {
      return {
        claimed: false,
        reason: response.reason as Exclude<CompanionLinearQueueScanClaimV1, { claimed: true }>["reason"],
        nextScanAt: response.nextScanAt ?? null,
      };
    }
    if (
      response.reason !== "claimed" ||
      typeof response.scanId !== "string" ||
      typeof response.scanToken !== "string" ||
      !response.configuration
    ) {
      throw new CompanionCoordinatorClientErrorV1(
        "invalid_response",
        "Companion Linear queue scan claim is malformed.",
      );
    }
    const token = response.scanToken;
    response.scanToken = "[REDACTED]";
    return {
      claimed: true,
      reason: "claimed",
      configuration: response.configuration,
      cursor: response.cursor ?? null,
      nextScanAt: response.nextScanAt ?? null,
      lease: createLinearQueueScanLease(token, {
        scanId: response.scanId,
        coordinatorId: input.coordinatorId,
        configurationFingerprint:
          response.configuration.configurationFingerprint,
      }),
    };
  }

  async completeLinearQueueScan(input: {
    lease: CompanionLinearQueueScanLeaseV1;
    scannedAt: string;
    candidates: CompanionLinearQueueCandidateObservationV1[];
    cursor: CompanionLinearQueueCursorV1 | null;
  }): Promise<CompanionLinearQueueStatusV1> {
    return input.lease.withToken((scanToken) =>
      this.requestJson<CompanionLinearQueueStatusV1>(
        "/linear-queue/scans/complete",
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            scanId: input.lease.description.scanId,
            scanToken,
            configurationFingerprint:
              input.lease.description.configurationFingerprint,
            scannedAt: input.scannedAt,
            candidates: input.candidates,
            cursor: input.cursor,
          }),
        },
      ),
    );
  }

  async failLinearQueueScan(input: {
    lease: CompanionLinearQueueScanLeaseV1;
    failedAt: string;
    errorCode:
      | "linear_queue_provider_unavailable"
      | "linear_queue_invalid_response"
      | "linear_queue_credential_unavailable";
  }): Promise<CompanionLinearQueueStatusV1> {
    return input.lease.withToken((scanToken) =>
      this.requestJson<CompanionLinearQueueStatusV1>(
        "/linear-queue/scans/fail",
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            scanId: input.lease.description.scanId,
            scanToken,
            configurationFingerprint:
              input.lease.description.configurationFingerprint,
            failedAt: input.failedAt,
            errorCode: input.errorCode,
          }),
        },
      ),
    );
  }

  async requestLinearQueueRescan(input: {
    configurationFingerprint: string;
    requestedAt: string;
  }): Promise<CompanionLinearQueueStatusV1> {
    return this.requestJson<CompanionLinearQueueStatusV1>(
      "/linear-queue/rescan",
      {
        method: "POST",
        body: this.jsonBody({
          configurationFingerprint: input.configurationFingerprint,
          requestedAt: input.requestedAt,
          reason: "terminal_readback",
        }),
      },
    );
  }

  async replayLinearQueueEvents(input: {
    afterSequence?: number;
    limit?: number;
  } = {}): Promise<CompanionLinearQueueEventV1[]> {
    const query = new URLSearchParams({
      after: String(Math.max(0, Math.floor(input.afterSequence ?? 0))),
      limit: String(clampInteger(input.limit ?? 500, 1, 500)),
    });
    const response = await this.requestJson<{
      events: CompanionLinearQueueEventV1[];
    }>(`/linear-queue/events?${query.toString()}`, { method: "GET" });
    return Array.isArray(response.events) ? response.events : [];
  }

  async submit(job: CompanionJobV1): Promise<CompanionRemoteJobV1> {
    if (job.state !== "queued") {
      throw new CompanionCoordinatorClientErrorV1(
        "invalid_request",
        "Only queued companion jobs may be submitted.",
      );
    }
    return this.requestJson<CompanionRemoteJobV1>("/jobs", {
      method: "POST",
      body: this.jsonBody({
        id: job.id,
        missionId: job.missionId,
        nodeId: job.nodeId,
        executionHost: job.domain,
        payload: {
          version: job.version,
          graphRevision: job.graphRevision,
          objective: job.objective,
          executionHost: job.executionHost,
          inputs: job.inputs,
          allowedTools: job.allowedTools,
          requiredCapabilities: job.requiredCapabilities,
          bindings: job.bindings,
          authorization: job.authorization,
          preparedExternalActionHandoff:
            job.preparedExternalActionHandoff ?? null,
          preparedBackgroundCodeAction:
            job.preparedBackgroundCodeAction ?? null,
          preparedBackgroundCodePackage:
            job.preparedBackgroundCodePackage ?? null,
          preparedBackgroundGitHubAction:
            job.preparedBackgroundGitHubAction ?? null,
          preparedBackgroundGitHubPackage:
            job.preparedBackgroundGitHubPackage ?? null,
          createdAt: job.createdAt,
          updatedAt: job.updatedAt,
        },
        capabilityEnvelope: {
          fingerprint: job.capabilityEnvelopeFingerprint,
          authorizationFingerprint: job.authorization.fingerprint,
        },
        idempotencyKey: job.idempotencyKey,
      }),
    });
  }

  async listJobs(input: {
    state?: string | string[];
    limit?: number;
  } = {}): Promise<CompanionRemoteJobV1[]> {
    const query = new URLSearchParams();
    const states = Array.isArray(input.state) ? input.state : input.state ? [input.state] : [];
    for (const state of states) query.append("state", state);
    query.set("limit", String(clampInteger(input.limit ?? 100, 1, 500)));
    const response = await this.requestJson<{ jobs: CompanionRemoteJobV1[] }>(
      `/jobs?${query.toString()}`,
      { method: "GET" },
    );
    return Array.isArray(response.jobs) ? response.jobs : [];
  }

  async getJob(jobId: string): Promise<CompanionRemoteJobV1> {
    return this.requestJson<CompanionRemoteJobV1>(
      `/jobs/${encodeSegment(jobId)}`,
      { method: "GET" },
    );
  }

  async claim(input: {
    jobId: string;
    coordinatorId: string;
    leaseSeconds?: number;
  }): Promise<CompanionClaimResultV1> {
    const response = await this.requestJson<{
      job: CompanionRemoteJobV1;
      leaseToken: string;
    }>(`/jobs/${encodeSegment(input.jobId)}/claim`, {
      method: "POST",
      body: this.jsonBody({
        coordinatorId: requiredText(input.coordinatorId, "coordinatorId"),
        leaseSeconds: clampInteger(input.leaseSeconds ?? 60, 5, 300),
      }),
    });
    if (!response.leaseToken || typeof response.leaseToken !== "string") {
      throw new CompanionCoordinatorClientErrorV1(
        "invalid_response",
        "Companion claim did not return a bearer lease.",
      );
    }
    return {
      job: response.job,
      lease: createJobLeaseHandle(response.leaseToken, {
        jobId: response.job.id,
        coordinatorId: input.coordinatorId,
        expiresAt: response.job.leaseExpiresAt,
      }),
    };
  }

  async heartbeat(input: {
    jobId: string;
    lease: CompanionJobLeaseHandleV1;
    leaseSeconds?: number;
  }): Promise<CompanionRemoteJobV1> {
    return input.lease.withLeaseToken((leaseToken) =>
      this.requestJson<CompanionRemoteJobV1>(
        `/jobs/${encodeSegment(input.jobId)}/heartbeat`,
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            leaseToken,
            leaseSeconds: clampInteger(input.leaseSeconds ?? 60, 5, 300),
          }),
        },
      ),
    );
  }

  async complete(input: {
    jobId: string;
    lease: CompanionJobLeaseHandleV1;
    state: "complete" | "blocked" | "cancelled" | "failed";
    output?: Record<string, MissionJsonValueV1>;
  }): Promise<CompanionRemoteJobV1> {
    return input.lease.withLeaseToken((leaseToken) =>
      this.requestJson<CompanionRemoteJobV1>(
        `/jobs/${encodeSegment(input.jobId)}/complete`,
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            leaseToken,
            state: input.state,
            output: input.output ?? {},
          }),
        },
      ),
    );
  }

  async appendEvent(input: {
    job: Pick<CompanionRemoteJobV1, "id" | "missionId" | "nodeId">;
    lease: CompanionJobLeaseHandleV1;
    type: CompanionEventTypeV1;
    payload?: Record<string, MissionJsonValueV1>;
  }): Promise<CompanionEventV1> {
    const record = await input.lease.withLeaseToken((leaseToken) =>
      this.requestJson<RemoteEventRecordV1>(
        `/jobs/${encodeSegment(input.job.id)}/events`,
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            leaseToken,
            type: input.type,
            payload: input.payload ?? {},
          }),
        },
      ),
    );
    return normalizeEventRecord(record, input.job);
  }

  async appendReceipt(input: {
    job: Pick<CompanionRemoteJobV1, "id" | "missionId" | "nodeId">;
    lease: CompanionJobLeaseHandleV1;
    receipt: Omit<CompanionReceiptV1, "id" | "committedAt">;
  }): Promise<CompanionReceiptV1> {
    const record = await input.lease.withLeaseToken((leaseToken) =>
      this.requestJson<RemoteReceiptRecordV1>(
        `/jobs/${encodeSegment(input.job.id)}/receipts`,
        {
          method: "POST",
          body: this.jsonBody({
            coordinatorId: input.lease.description.coordinatorId,
            leaseToken,
            provider: input.receipt.provider,
            operation: input.receipt.operation,
            status: input.receipt.status,
            fingerprint: input.receipt.fingerprint,
            payload: input.receipt.payload,
          }),
        },
      ),
    );
    return normalizeReceiptRecord(record, input.job);
  }

  async listReceipts(jobId: string): Promise<CompanionReceiptV1[]> {
    const job = await this.getJob(jobId);
    const response = await this.requestJson<{ receipts: RemoteReceiptRecordV1[] }>(
      `/jobs/${encodeSegment(jobId)}/receipts`,
      { method: "GET" },
    );
    return (response.receipts ?? []).map((record) => normalizeReceiptRecord(record, job));
  }

  async replayEvents(input: {
    jobId: string;
    afterSequence?: number;
    signal?: AbortSignal;
  }): Promise<CompanionEventV1[]> {
    const events: CompanionEventV1[] = [];
    for await (const event of this.streamEvents({ ...input, follow: false })) {
      events.push(event);
    }
    return events;
  }

  async *streamEvents(input: {
    jobId: string;
    afterSequence?: number;
    follow?: boolean;
    signal?: AbortSignal;
  }): AsyncGenerator<CompanionEventV1> {
    const job = await this.getJob(input.jobId);
    const after = Math.max(0, Math.floor(input.afterSequence ?? 0));
    let lastSequence = after;
    let replayPages = 0;
    while (true) {
      const pageStartSequence = lastSequence;
      const query = new URLSearchParams({
        after: String(lastSequence),
        follow: input.follow === false ? "false" : "true",
      });
      const opened = await this.openResponse(
        `/jobs/${encodeSegment(input.jobId)}/events?${query.toString()}`,
        {
          method: "GET",
          headers: { Accept: "text/event-stream" },
          signal: input.signal,
        },
        input.follow === false ? this.timeoutMs : 0,
      );
      const response = opened.response;
      if (!response.body) {
        opened.release();
        throw new CompanionCoordinatorClientErrorV1(
          "invalid_response",
          "Companion event stream has no response body.",
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let boundary: ReplayBoundaryV1 | null = null;
      try {
        while (true) {
          const { done, value } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          if (new TextEncoder().encode(buffer).byteLength > this.maxResponseBytes) {
            throw new CompanionCoordinatorClientErrorV1(
              "response_too_large",
              "Companion event frame exceeded the configured response limit.",
            );
          }
          const frames = buffer.replace(/\r\n/g, "\n").split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const parsed = parseSseFrame(frame);
            if (!parsed) continue;
            if (parsed.kind === "boundary") {
              boundary = parsed.boundary;
              continue;
            }
            if (parsed.record.sequence <= lastSequence) {
              throw new CompanionCoordinatorClientErrorV1(
                "event_sequence_regression",
                "Companion event sequence did not advance monotonically.",
              );
            }
            lastSequence = parsed.record.sequence;
            yield normalizeEventRecord(parsed.record, job);
          }
          if (done) break;
        }
        if (buffer.trim()) {
          const parsed = parseSseFrame(buffer);
          if (parsed?.kind === "boundary") {
            boundary = parsed.boundary;
          } else if (parsed?.kind === "event") {
            if (parsed.record.sequence <= lastSequence) {
              throw new CompanionCoordinatorClientErrorV1(
                "event_sequence_regression",
                "Companion event sequence did not advance monotonically.",
              );
            }
            lastSequence = parsed.record.sequence;
            yield normalizeEventRecord(parsed.record, job);
          }
        }
      } finally {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed or aborted.
        }
        reader.releaseLock();
        opened.release();
      }
      if (input.follow !== false || !boundary) break;
      if (
        boundary.afterSequence !== lastSequence ||
        boundary.afterSequence <= pageStartSequence
      ) {
        throw new CompanionCoordinatorClientErrorV1(
          "invalid_response",
          "Companion replay boundary did not advance its durable cursor.",
        );
      }
      replayPages += 1;
      if (replayPages > 10_000) {
        throw new CompanionCoordinatorClientErrorV1(
          "invalid_response",
          "Companion replay exceeded its page limit.",
        );
      }
    }
  }

  private async requestJson<TResponse>(
    path: string,
    init: RequestInit,
  ): Promise<TResponse> {
    const opened = await this.openResponse(path, init, this.timeoutMs);
    try {
      const text = await readBoundedText(opened.response, this.maxResponseBytes);
      try {
        return JSON.parse(text) as TResponse;
      } catch {
        throw new CompanionCoordinatorClientErrorV1(
          "invalid_response",
          "Companion returned invalid JSON.",
        );
      }
    } finally {
      opened.release();
    }
  }

  private async openResponse(
    path: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<{ response: Response; release(): void }> {
    const credential =
      this.options.credential ??
      resolveCompanionBootstrapSessionV1(this.baseUrl)?.credential;
    if (!credential) {
      throw new CompanionCoordinatorClientErrorV1(
        "authentication_unconfigured",
        "Companion authentication is not configured for this process session.",
      );
    }
    const bodyBytes =
      typeof init.body === "string" ? new TextEncoder().encode(init.body).byteLength : 0;
    if (bodyBytes > COMPANION_MAX_REQUEST_BYTES) {
      throw new CompanionCoordinatorClientErrorV1(
        "request_too_large",
        "Companion request body exceeded the configured limit.",
      );
    }
    const controller = new AbortController();
    const callerSignal = init.signal;
    const abort = () => controller.abort(callerSignal?.reason);
    callerSignal?.addEventListener("abort", abort, { once: true });
    const timer =
      timeoutMs > 0
        ? globalThis.setTimeout(() => controller.abort("timeout"), timeoutMs)
        : null;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      callerSignal?.removeEventListener("abort", abort);
      if (timer !== null) globalThis.clearTimeout(timer);
    };
    try {
      const response = await credential.withToken((token) =>
        this.fetchImpl(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            "Cache-Control": "no-store",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
            ...headersToRecord(init.headers),
            Authorization: `Bearer ${token}`,
          },
          credentials: "omit",
          cache: "no-store",
          signal: controller.signal,
        }),
      );
      if (!response.ok) {
        const errorBody = await readBoundedText(response, Math.min(16_384, this.maxResponseBytes));
        if (response.status === 401 || response.status === 403) {
          throw new CompanionCoordinatorClientErrorV1(
            "authentication_failed",
            "Companion authentication failed.",
            response.status,
          );
        }
        throw new CompanionCoordinatorClientErrorV1(
          "request_failed",
          sanitizeServerError(errorBody, response.status),
          response.status,
        );
      }
      return { response, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  private jsonBody(value: unknown): string {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > COMPANION_MAX_REQUEST_BYTES) {
      throw new CompanionCoordinatorClientErrorV1(
        "request_too_large",
        "Companion request body exceeded the configured limit.",
      );
    }
    return serialized;
  }
}

export class CompanionCoordinatorClientErrorV1 extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "authentication_unconfigured"
      | "authentication_failed"
      | "request_too_large"
      | "response_too_large"
      | "request_failed"
      | "invalid_response"
      | "event_sequence_regression",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CompanionCoordinatorClientErrorV1";
  }
}

interface RemoteEventRecordV1 {
  sequence: number;
  jobId: string;
  type: string;
  payload: Record<string, MissionJsonValueV1>;
  createdAt: string;
}

interface RemoteReceiptRecordV1 {
  id: string;
  jobId: string;
  provider: string;
  operation: string;
  status: string;
  fingerprint: string;
  payload: Record<string, MissionJsonValueV1>;
  createdAt: string;
}

function createJobLeaseHandle(
  token: string,
  description: CompanionJobLeaseDescriptionV1,
): CompanionJobLeaseHandleV1 {
  let secret: string | null = token;
  const frozenDescription = Object.freeze({ ...description });
  return Object.freeze({
    description: frozenDescription,
    get disposed() {
      return secret === null;
    },
    async withLeaseToken<TResult>(
      use: (value: string) => Promise<TResult>,
    ): Promise<TResult> {
      if (secret === null) {
        throw new CompanionCoordinatorClientErrorV1(
          "authentication_unconfigured",
          "The companion job lease is unavailable.",
        );
      }
      return use(secret);
    },
    dispose() {
      secret = null;
    },
    toJSON() {
      return { redacted: true as const, description: frozenDescription };
    },
  });
}

function createLinearQueueScanLease(
  token: string,
  description: CompanionLinearQueueScanLeaseV1["description"],
): CompanionLinearQueueScanLeaseV1 {
  let secret: string | null = token;
  const frozenDescription = Object.freeze({ ...description });
  return Object.freeze({
    description: frozenDescription,
    get disposed() {
      return secret === null;
    },
    async withToken<TResult>(use: (value: string) => Promise<TResult>): Promise<TResult> {
      if (secret === null) {
        throw new CompanionCoordinatorClientErrorV1(
          "authentication_unconfigured",
          "The companion Linear queue scan lease is unavailable.",
        );
      }
      return use(secret);
    },
    dispose() {
      secret = null;
    },
    toJSON() {
      return { redacted: true as const, description: frozenDescription };
    },
  });
}

function normalizeEventRecord(
  record: RemoteEventRecordV1,
  job: Pick<CompanionRemoteJobV1, "id" | "missionId" | "nodeId">,
): CompanionEventV1 {
  if (
    !Number.isInteger(record.sequence) ||
    record.sequence < 1 ||
    record.jobId !== job.id ||
    typeof record.type !== "string" ||
    !record.type.trim()
  ) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      "Companion returned an invalid event record.",
    );
  }
  const canonicalType = canonicalEventType(record.type);
  return {
    version: COMPANION_COORDINATION_PROTOCOL_VERSION,
    sequence: record.sequence,
    jobId: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    type: canonicalType,
    payload:
      canonicalType === record.type
        ? record.payload ?? {}
        : { ...(record.payload ?? {}), rawEventType: record.type },
    occurredAt: record.createdAt,
  };
}

function normalizeReceiptRecord(
  record: RemoteReceiptRecordV1,
  job: Pick<CompanionRemoteJobV1, "id" | "missionId" | "nodeId">,
): CompanionReceiptV1 {
  if (
    record.jobId !== job.id ||
    !["research", "code", "linear", "github", "companion"].includes(record.provider) ||
    !["prepared", "dispatched", "verified", "ambiguous", "failed"].includes(record.status)
  ) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      "Companion returned an invalid receipt record.",
    );
  }
  return {
    version: COMPANION_COORDINATION_PROTOCOL_VERSION,
    id: record.id,
    jobId: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    provider: record.provider as CompanionReceiptV1["provider"],
    operation: record.operation,
    status: record.status as CompanionReceiptV1["status"],
    fingerprint: record.fingerprint,
    payload: record.payload ?? {},
    committedAt: record.createdAt,
  };
}

interface ReplayBoundaryV1 {
  afterSequence: number;
  complete: false;
  reason: "event_limit" | "time_limit";
}

type ParsedSseFrameV1 =
  | { kind: "event"; record: RemoteEventRecordV1 }
  | { kind: "boundary"; boundary: ReplayBoundaryV1 };

function parseSseFrame(frame: string): ParsedSseFrameV1 | null {
  const data: string[] = [];
  let id: number | null = null;
  let eventType = "message";
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const value = separator < 0 ? "" : line.slice(separator + 1).replace(/^ /, "");
    if (field === "id") id = Number(value);
    if (field === "event") eventType = value;
    if (field === "data") data.push(value);
  }
  if (data.length === 0) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join("\n"));
  } catch {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      "Companion returned invalid SSE JSON.",
    );
  }
  if (eventType === "replay_boundary") {
    const boundary = parsed as ReplayBoundaryV1;
    const keys = Object.keys(boundary as object).sort();
    if (
      keys.join(",") !== "afterSequence,complete,reason" ||
      !Number.isSafeInteger(boundary.afterSequence) ||
      boundary.afterSequence < 1 ||
      boundary.complete !== false ||
      !["event_limit", "time_limit"].includes(boundary.reason) ||
      id !== boundary.afterSequence
    ) {
      throw new CompanionCoordinatorClientErrorV1(
        "invalid_response",
        "Companion returned an invalid replay boundary.",
      );
    }
    return { kind: "boundary", boundary };
  }
  const record = parsed as RemoteEventRecordV1;
  if (id !== null && record.sequence !== id) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      "Companion SSE id does not match its event sequence.",
    );
  }
  return { kind: "event", record };
}

function parseHostApprovalSignerDescriptionV1(
  value: unknown,
): CompanionHostApprovalSignerDescriptionV1 {
  const record = exactClosedResponseV1(value, [
    "version",
    "kind",
    "persistent",
    "provisioned",
    "backend",
    "signingKeyFingerprint",
  ], "host approval signer description");
  const fingerprint = record.signingKeyFingerprint;
  if (
    record.version !== 1 ||
    record.kind !== "host_approval_signer" ||
    typeof record.persistent !== "boolean" ||
    typeof record.provisioned !== "boolean" ||
    typeof record.backend !== "string" ||
    record.backend.length < 1 ||
    record.backend.length > 512 ||
    (fingerprint !== null && !isSha256FingerprintV1(fingerprint)) ||
    (record.provisioned !== (record.persistent && fingerprint !== null))
  ) {
    throw invalidHostApprovalResponseV1();
  }
  return record as unknown as CompanionHostApprovalSignerDescriptionV1;
}

function parseHostApprovalVerificationResultV1(
  value: unknown,
): CompanionHostApprovalVerificationResultV1 {
  const record = exactClosedResponseV1(value, [
    "version",
    "verified",
    "reason",
    "signingKeyFingerprint",
  ], "host approval verification result");
  const reasons: CompanionHostApprovalVerificationResultV1["reason"][] = [
    "verified",
    "signer_unavailable",
    "key_mismatch",
    "authenticator_mismatch",
    "decision_not_approved",
  ];
  const fingerprint = record.signingKeyFingerprint;
  if (
    record.version !== 1 ||
    typeof record.verified !== "boolean" ||
    typeof record.reason !== "string" ||
    !reasons.includes(record.reason as CompanionHostApprovalVerificationResultV1["reason"]) ||
    (fingerprint !== null && !isSha256FingerprintV1(fingerprint)) ||
    (record.verified !== (record.reason === "verified")) ||
    (record.reason === "signer_unavailable"
      ? fingerprint !== null
      : fingerprint === null)
  ) {
    throw invalidHostApprovalResponseV1();
  }
  return record as unknown as CompanionHostApprovalVerificationResultV1;
}

function exactClosedResponseV1(
  value: unknown,
  keys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      `Companion returned an invalid ${label}.`,
    );
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_response",
      `Companion returned an invalid ${label}.`,
    );
  }
  return record;
}

function isSha256FingerprintV1(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function invalidHostApprovalResponseV1(): CompanionCoordinatorClientErrorV1 {
  return new CompanionCoordinatorClientErrorV1(
    "invalid_response",
    "Companion returned an invalid host approval signer response.",
  );
}

async function readBoundedText(response: Response, limit: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > limit) {
    throw new CompanionCoordinatorClientErrorV1(
      "response_too_large",
      "Companion response exceeded the configured limit.",
    );
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw new CompanionCoordinatorClientErrorV1(
          "response_too_large",
          "Companion response exceeded the configured limit.",
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function sanitizeServerError(body: string, status: number): string {
  const redacted = body
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(?:token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 4_096);
  return redacted
    ? `Companion request failed (${status}): ${redacted}`
    : `Companion request failed (${status}).`;
}

function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  const record: Record<string, string> = {};
  new Headers(headers).forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function canonicalEventType(value: string): CompanionEventTypeV1 {
  const direct = new Set<CompanionEventTypeV1>([
    "job_accepted",
    "job_leased",
    "job_started",
    "job_progress",
    "job_waiting_obsidian",
    "job_verifying",
    "receipt_committed",
    "job_blocked",
    "job_completed",
    "job_cancelled",
    "job_failed",
  ]);
  if (direct.has(value as CompanionEventTypeV1)) {
    return value as CompanionEventTypeV1;
  }
  switch (value) {
    case "job_queued":
      return "job_accepted";
    case "lease_acquired":
      return "job_leased";
    case "lease_renewed":
    case "progress":
      return "job_progress";
    case "external_receipt_recorded":
      return "receipt_committed";
    case "job_complete":
      return "job_completed";
    default:
      // Extension-defined event names are untrusted diagnostics, not new
      // authority or state transitions. Preserve their raw name as progress.
      return "job_progress";
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(requiredText(value, "jobId"));
}

function requiredText(value: string, field: string): string {
  const normalized = value?.trim();
  if (!normalized || normalized.length > 256) {
    throw new CompanionCoordinatorClientErrorV1(
      "invalid_request",
      `${field} must contain 1-256 characters.`,
    );
  }
  return normalized;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
