import {
  CompanionCoordinatorClientV1,
  CompanionCoordinatorClientErrorV1,
  type BackgroundAuthorizationV1,
  type BootstrapTokenLeaseV1,
  type CompanionEventV1,
  type CompanionHostApprovalSignerDescriptionV1,
  type CompanionHostApprovalVerificationResultV1,
  type CompanionJobV1,
  type CompanionLinearQueueConfigurationV1,
  type CompanionLinearQueueEventV1,
  type CompanionLinearQueueStatusV1,
  type CompanionRemoteJobV1,
  companionResultFingerprintV1,
  type CompanionServiceHealthV1,
  companionReceiptFingerprintV1,
  clearCompanionBootstrapSessionV1,
  installCompanionBootstrapSessionV1,
  prepareCompanionJobV1,
  remoteJobToCompanionJob,
  type MissionGraphV3,
  type MissionJsonValueV1,
} from "@agentic-researcher/headless-runtime";
import type {
  HostApprovalReceiptEvidenceV1,
  HostApprovalReceiptV1,
} from "@agentic-researcher/core-api";

export interface CompanionSessionConfigurationV1 {
  baseUrl: string;
  credential: BootstrapTokenLeaseV1;
  fetchImpl?: typeof fetch;
}

export type CompanionNodeDispatchResultV1 =
  | { status: "submitted"; job: CompanionRemoteJobV1 }
  | { status: "waiting_obsidian"; nodeId: string; reason: string }
  | {
      status: "blocked";
      nodeId: string;
      code: string;
      reason: string;
      requiredAction: string | null;
    };

export interface CompanionAuthorizedNodeSubmissionV1 {
  graph: MissionGraphV3;
  nodeId: string;
  authorization: BackgroundAuthorizationV1;
  /** Host-owned runtime-note identity; never sent to the remote job. */
  hostRuntimeRunId?: string | null;
  preparedExternalActionHandoff?: Parameters<
    typeof prepareCompanionJobV1
  >[0]["preparedExternalActionHandoff"];
  preparedBackgroundCodeAction?: Parameters<
    typeof prepareCompanionJobV1
  >[0]["preparedBackgroundCodeAction"];
  preparedBackgroundCodePackage?: Parameters<
    typeof prepareCompanionJobV1
  >[0]["preparedBackgroundCodePackage"];
  preparedBackgroundGitHubAction?: Parameters<
    typeof prepareCompanionJobV1
  >[0]["preparedBackgroundGitHubAction"];
  preparedBackgroundGitHubPackage?: Parameters<
    typeof prepareCompanionJobV1
  >[0]["preparedBackgroundGitHubPackage"];
  beforeSubmit?(job: CompanionJobV1): Promise<void>;
  now?: Date;
}

export interface CompanionCoordinatorSnapshotV1 {
  configured: boolean;
  baseUrl: string | null;
  health: CompanionServiceHealthV1 | null;
  lastError: string | null;
  lastWaitingObsidianNodeId: string | null;
  checkedAt: string;
}

export interface PersistedCompanionLineageV1 {
  version: 1;
  jobId: string;
  missionId: string;
  nodeId: string;
  graphRevision: number;
  idempotencyKey: string;
  capabilityEnvelopeFingerprint: string;
  authorizationFingerprint: string;
  hostRuntimeRunId: string | null;
  state: string;
  lastObservedEventSequence: number;
  lastAppliedEventSequence: number;
  receiptFingerprints: string[];
  resultFingerprint: string | null;
  reconcileStatus:
    | "pending"
    | "reconciled"
    | "terminal_blocked"
    | "reconcile_required";
  reconcileError: string | null;
  updatedAt: string;
}

export interface CompanionRuntimeStateV1 {
  version: 1;
  serviceInstalled: boolean;
  baseUrl: string;
  linearQueueLastObservedEventSequence: number;
  linearQueueLastAppliedEventSequence: number;
  jobs: Record<string, PersistedCompanionLineageV1>;
}

export interface CompanionLineagePersistenceV1 {
  load(): Promise<unknown>;
  save(state: CompanionRuntimeStateV1): Promise<void>;
}

export interface CompanionReconciledLineageV1 {
  lineage: PersistedCompanionLineageV1;
  job: CompanionRemoteJobV1;
  events: CompanionEventV1[];
  receipts: Awaited<ReturnType<CompanionCoordinatorClientV1["listReceipts"]>>;
}

export interface CompanionLinearQueueReconciliationV1 {
  status: CompanionLinearQueueStatusV1;
  events: CompanionLinearQueueEventV1[];
  readbacks: CompanionLinearQueueReadbackV1[];
}

export interface CompanionLinearQueueReadbackV1 {
  eventSequence: number;
  jobId: string;
  issueId: string;
  candidateFingerprint: string;
  workItemFingerprint: string;
  observedReadbackFingerprint: string;
  state: CompanionRemoteJobV1["state"];
  terminalCode: string | null;
  verifiedReadbackFingerprint: string | null;
  verifiedReceiptFingerprint: string | null;
}

/** Production boundary exposed by the optional companion plugin instance. */
export class CompanionExtensionCoordinatorV1 {
  private client: CompanionCoordinatorClientV1 | null = null;
  private baseUrl: string | null = null;
  private disconnectSession: (() => void) | null = null;
  private health: CompanionServiceHealthV1 | null = null;
  private lastError: string | null = null;
  private lastWaitingObsidianNodeId: string | null = null;
  private checkedAt = new Date(0).toISOString();
  private persistence: CompanionLineagePersistenceV1 | null = null;
  private runtimeState: CompanionRuntimeStateV1 = defaultRuntimeState();
  private persistChain = Promise.resolve();
  private coordinationTail = Promise.resolve();

  configurePersistence(persistence: CompanionLineagePersistenceV1): void {
    this.persistence = persistence;
  }

  async hydratePersistence(): Promise<CompanionRuntimeStateV1> {
    if (!this.persistence) return cloneRuntimeState(this.runtimeState);
    this.runtimeState = parseRuntimeState(await this.persistence.load());
    return cloneRuntimeState(this.runtimeState);
  }

  getRuntimeState(): CompanionRuntimeStateV1 {
    return cloneRuntimeState(this.runtimeState);
  }

  async setServiceInstalled(installed: boolean, baseUrl = this.baseUrl): Promise<void> {
    this.runtimeState.serviceInstalled = installed;
    if (baseUrl) this.runtimeState.baseUrl = baseUrl;
    await this.persistRuntimeState();
  }

  configureSession(configuration: CompanionSessionConfigurationV1): void {
    this.clearSession();
    this.disconnectSession = installCompanionBootstrapSessionV1({
      version: 1,
      baseUrl: configuration.baseUrl,
      credential: configuration.credential,
      connectedAt: new Date().toISOString(),
    });
    this.client = new CompanionCoordinatorClientV1(configuration);
    this.baseUrl = this.client.baseUrl;
    this.lastError = null;
    this.checkedAt = new Date().toISOString();
  }

  clearSession(): void {
    if (this.disconnectSession) {
      this.disconnectSession();
    } else if (this.baseUrl) {
      clearCompanionBootstrapSessionV1(this.baseUrl);
    }
    this.disconnectSession = null;
    this.client = null;
    this.baseUrl = null;
    this.health = null;
    this.lastError = null;
    this.checkedAt = new Date().toISOString();
  }

  snapshot(): CompanionCoordinatorSnapshotV1 {
    return {
      configured: this.client !== null,
      baseUrl: this.baseUrl,
      health: this.health ? { ...this.health } : null,
      lastError: this.lastError,
      lastWaitingObsidianNodeId: this.lastWaitingObsidianNodeId,
      checkedAt: this.checkedAt,
    };
  }

  async refreshHealth(): Promise<CompanionCoordinatorSnapshotV1> {
    if (!this.client) {
      this.lastError =
        "Companion session is not connected. Install or connect the authenticated local service.";
      this.checkedAt = new Date().toISOString();
      return this.snapshot();
    }
    try {
      this.health = await this.client.health();
      this.lastError = null;
    } catch (error) {
      this.health = null;
      this.lastError = safeError(error);
    }
    this.checkedAt = new Date().toISOString();
    return this.snapshot();
  }

  async describeHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return this.requireClient().describeHostApprovalSigner();
  }

  async provisionHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return this.requireClient().provisionHostApprovalSigner();
  }

  async rotateHostApprovalSigner(): Promise<CompanionHostApprovalSignerDescriptionV1> {
    return this.requireClient().rotateHostApprovalSigner();
  }

  async sealHostApprovalReceipt(
    evidence: HostApprovalReceiptEvidenceV1,
  ): Promise<HostApprovalReceiptV1> {
    return this.requireClient().sealHostApprovalReceipt(evidence);
  }

  async verifyHostApprovalReceipt(
    receipt: HostApprovalReceiptV1,
  ): Promise<CompanionHostApprovalVerificationResultV1> {
    return this.requireClient().verifyHostApprovalReceipt(receipt);
  }

  async configureLinearQueue(
    configuration: CompanionLinearQueueConfigurationV1,
  ): Promise<CompanionLinearQueueStatusV1> {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    return this.client.configureLinearQueue(configuration);
  }

  async disableLinearQueue(): Promise<CompanionLinearQueueStatusV1> {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    return this.client.disableLinearQueue();
  }

  async requestLinearQueueRescan(
    configurationFingerprint: string,
  ): Promise<CompanionLinearQueueStatusV1> {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    return this.client.requestLinearQueueRescan({
      configurationFingerprint,
      requestedAt: new Date().toISOString(),
    });
  }

  async reconcileLinearQueue(
    signal?: AbortSignal,
  ): Promise<CompanionLinearQueueReconciliationV1> {
    return this.withCoordinationLock(async () => {
      if (!this.client) {
        throw new Error("The authenticated companion session is not connected.");
      }
      if (signal?.aborted) {
        throw new DOMException("Linear queue reconciliation aborted.", "AbortError");
      }
      const status = await this.client.linearQueueStatus();
      const applied = this.runtimeState.linearQueueLastAppliedEventSequence;
      if (status.latestEventSequence < applied) {
        throw new Error(
          "Companion Linear queue event history regressed behind the durable core cursor.",
        );
      }
      const events = await this.client.replayLinearQueueEvents({
        afterSequence: applied,
        limit: 500,
      });
      let previous = applied;
      for (const event of events) {
        if (
          !Number.isInteger(event.sequence) ||
          event.sequence <= previous ||
          event.sequence > status.latestEventSequence
        ) {
          throw new Error("Companion Linear queue event sequence is malformed.");
        }
        previous = event.sequence;
      }
      if (events.length > 0) {
        this.runtimeState.linearQueueLastObservedEventSequence = Math.max(
          this.runtimeState.linearQueueLastObservedEventSequence,
          previous,
        );
        await this.persistRuntimeState();
      }
      const readbacks: CompanionLinearQueueReadbackV1[] = [];
      for (const event of events) {
        if (event.type === "linear_queue_candidate_scheduled") {
          readbacks.push(await this.readLinearQueueCandidate(event));
        }
      }
      return { status, events, readbacks };
    });
  }

  private async readLinearQueueCandidate(
    event: CompanionLinearQueueEventV1,
  ): Promise<CompanionLinearQueueReadbackV1> {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    const jobId = linearQueueEventText(event, "jobId");
    const issueId = linearQueueEventText(event, "issueId");
    const queueProjectId = linearQueueEventText(event, "queueProjectId");
    const candidateFingerprint = linearQueueEventFingerprint(
      event,
      "candidateFingerprint",
    );
    const workItemFingerprint = linearQueueEventFingerprint(
      event,
      "workItemFingerprint",
    );
    const observedReadbackFingerprint = linearQueueEventFingerprint(
      event,
      "readbackFingerprint",
    );
    const job = await this.client.getJob(jobId);
    const projected = remoteJobToCompanionJob(job);
    const expectedInputKeys = [
      "contractFingerprint",
      "credentialReferenceId",
      "issueId",
      "projectBindingId",
      "queueCandidateFingerprint",
    ];
    if (
      job.id !== jobId ||
      projected.domain !== "linear" ||
      projected.executionHost !== "headless_runtime" ||
      projected.allowedTools.length !== 1 ||
      projected.allowedTools[0] !== "linear_get_issue" ||
      projected.requiredCapabilities.length !== 1 ||
      projected.requiredCapabilities[0] !== "linear.issue.read" ||
      Object.keys(projected.inputs).sort().join("\0") !==
        expectedInputKeys.join("\0") ||
      projected.inputs.issueId !== issueId ||
      projected.inputs.projectBindingId !== queueProjectId ||
      projected.inputs.contractFingerprint !== workItemFingerprint ||
      projected.inputs.queueCandidateFingerprint !== candidateFingerprint
    ) {
      throw new Error("Companion Linear queue readback job drifted from its event binding.");
    }
    const receipts = await this.client.listReceipts(job.id);
    for (const receipt of receipts) {
      const expected = await companionReceiptFingerprintV1({
        job: projected,
        provider: receipt.provider,
        operation: receipt.operation,
        status: receipt.status,
        payload: receipt.payload,
      });
      if (expected !== receipt.fingerprint) {
        throw new Error(`Linear queue receipt ${receipt.id} fingerprint drifted.`);
      }
    }
    if (["blocked", "failed", "cancelled"].includes(job.state)) {
      const completion = exactRecord(job.output, [
        "blocker",
        "evidence",
        "outputs",
        "receiptIds",
        "resultFingerprint",
        "status",
      ], "Terminal Linear queue completion");
      const outputs = openRecord(
        completion.outputs,
        "Terminal Linear queue outputs",
      ) as Record<string, MissionJsonValueV1>;
      const evidence = Array.isArray(completion.evidence)
        ? completion.evidence as MissionJsonValueV1[]
        : null;
      const receiptIds = Array.isArray(completion.receiptIds) &&
        completion.receiptIds.every((value) => typeof value === "string")
        ? completion.receiptIds as string[]
        : null;
      const blocker = exactRecord(completion.blocker, [
        "code",
        "message",
        "requiredAction",
      ], "Terminal Linear queue blocker");
      const terminalCode = String(blocker.code ?? "");
      const resultFingerprint = String(completion.resultFingerprint ?? "");
      if (
        completion.status !== job.state ||
        !evidence ||
        !receiptIds ||
        !receiptIds.every((id) => receipts.some((receipt) => receipt.id === id)) ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(terminalCode) ||
        typeof blocker.message !== "string" ||
        (blocker.requiredAction !== null &&
          typeof blocker.requiredAction !== "string") ||
        !/^sha256:[a-f0-9]{64}$/.test(resultFingerprint)
      ) {
        throw new Error("Terminal Linear queue completion proof is malformed.");
      }
      const expectedResultFingerprint = await companionResultFingerprintV1(
        projected,
        {
          status: job.state,
          outputs,
          evidence,
          receiptIds,
          blocker: {
            code: terminalCode,
            message: blocker.message,
            requiredAction: blocker.requiredAction as string | null,
          },
        },
      );
      if (expectedResultFingerprint !== resultFingerprint) {
        throw new Error("Terminal Linear queue result fingerprint drifted.");
      }
      return {
        eventSequence: event.sequence,
        jobId,
        issueId,
        candidateFingerprint,
        workItemFingerprint,
        observedReadbackFingerprint,
        state: job.state,
        terminalCode,
        verifiedReadbackFingerprint: null,
        verifiedReceiptFingerprint: null,
      };
    }
    if (job.state !== "complete") {
      return {
        eventSequence: event.sequence,
        jobId,
        issueId,
        candidateFingerprint,
        workItemFingerprint,
        observedReadbackFingerprint,
        state: job.state,
        terminalCode: null,
        verifiedReadbackFingerprint: null,
        verifiedReceiptFingerprint: null,
      };
    }

    const completion = exactRecord(job.output, [
      "blocker",
      "evidence",
      "outputs",
      "receiptIds",
      "resultFingerprint",
      "status",
    ], "Linear queue completion");
    const outputs = exactRecord(completion.outputs, [
      "candidateFingerprint",
      "issueId",
      "readbackFingerprint",
      "state",
      "workItemFingerprint",
    ], "Linear queue completion outputs") as Record<string, MissionJsonValueV1>;
    const evidence = Array.isArray(completion.evidence)
      ? completion.evidence as MissionJsonValueV1[]
      : null;
    const receiptIds = Array.isArray(completion.receiptIds) &&
      completion.receiptIds.every((value) => typeof value === "string")
      ? completion.receiptIds as string[]
      : null;
    const resultFingerprint = String(completion.resultFingerprint ?? "");
    if (
      completion.status !== "complete" ||
      completion.blocker !== null ||
      !evidence ||
      !receiptIds ||
      receiptIds.length !== 1 ||
      !/^sha256:[a-f0-9]{64}$/.test(resultFingerprint) ||
      outputs.issueId !== issueId ||
      outputs.candidateFingerprint !== candidateFingerprint ||
      outputs.workItemFingerprint !== workItemFingerprint ||
      typeof outputs.readbackFingerprint !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(outputs.readbackFingerprint)
    ) {
      throw new Error("Companion Linear queue completion proof is malformed.");
    }
    const receipt = receipts.find((item) => item.id === receiptIds[0]);
    if (
      receipts.length !== 1 ||
      !receipt ||
      receipt.provider !== "linear" ||
      receipt.operation !== "linear_issue_readback" ||
      receipt.status !== "verified" ||
      receipt.payload.issueId !== issueId ||
      receipt.payload.candidateFingerprint !== candidateFingerprint ||
      receipt.payload.workItemFingerprint !== workItemFingerprint ||
      receipt.payload.readbackFingerprint !== outputs.readbackFingerprint
    ) {
      throw new Error("Companion Linear queue completion lacks its exact verified receipt.");
    }
    const expectedResultFingerprint = await companionResultFingerprintV1(projected, {
      status: "complete",
      outputs,
      evidence,
      receiptIds,
      blocker: null,
    });
    if (expectedResultFingerprint !== resultFingerprint) {
      throw new Error("Companion Linear queue result fingerprint drifted.");
    }
    return {
      eventSequence: event.sequence,
      jobId,
      issueId,
      candidateFingerprint,
      workItemFingerprint,
      observedReadbackFingerprint,
      state: job.state,
      terminalCode: null,
      verifiedReadbackFingerprint: outputs.readbackFingerprint,
      verifiedReceiptFingerprint: receipt.fingerprint,
    };
  }

  async acknowledgeAppliedLinearQueueEvents(
    throughSequence: number,
  ): Promise<void> {
    if (
      !Number.isInteger(throughSequence) ||
      throughSequence < this.runtimeState.linearQueueLastAppliedEventSequence ||
      throughSequence > this.runtimeState.linearQueueLastObservedEventSequence
    ) {
      throw new Error(
        "Applied Linear queue cursor is outside the observed durable range.",
      );
    }
    this.runtimeState.linearQueueLastAppliedEventSequence = throughSequence;
    await this.persistRuntimeState();
  }

  async submitAuthorizedNode(
    input: CompanionAuthorizedNodeSubmissionV1,
  ): Promise<CompanionNodeDispatchResultV1> {
    return this.withCoordinationLock(() =>
      this.submitAuthorizedNodeUnlocked(input),
    );
  }

  private async submitAuthorizedNodeUnlocked(
    input: CompanionAuthorizedNodeSubmissionV1,
  ): Promise<CompanionNodeDispatchResultV1> {
    const prepared = await prepareCompanionJobV1(input);
    if (prepared.status === "waiting_obsidian") {
      this.lastWaitingObsidianNodeId = prepared.nodeId;
      return prepared;
    }
    if (prepared.status === "blocked") {
      return { ...prepared, requiredAction: null };
    }
    const hostRuntimeRunId = normalizeHostRuntimeRunId(
      input.hostRuntimeRunId ?? null,
    );
    if (
      (prepared.job.preparedExternalActionHandoff ||
        prepared.job.preparedBackgroundCodeAction ||
        prepared.job.preparedBackgroundGitHubAction) &&
      !hostRuntimeRunId
    ) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: "companion_host_runtime_lineage_required",
        reason:
          "Effectful companion dispatch requires the exact host runtime run identity for restart-safe core WAL reconciliation.",
        requiredAction:
          "Resume from the originating Obsidian run so core can bind the exact runtime lineage.",
      };
    }
    if (!this.client) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: "companion_not_connected",
        reason: "The authenticated local companion is not connected.",
        requiredAction: "Install or connect the companion service, then resume the mission.",
      };
    }
    let existing = this.runtimeState.jobs[prepared.job.id];
    if (existing) {
      if (
        existing.hostRuntimeRunId !== null &&
        hostRuntimeRunId !== null &&
        existing.hostRuntimeRunId !== hostRuntimeRunId
      ) {
        return {
          status: "blocked",
          nodeId: input.nodeId,
          code: "companion_host_runtime_lineage_drift",
          reason:
            "Persisted companion lineage is bound to a different host runtime run.",
          requiredAction:
            "Open Run Details for the originating run and reconcile that exact lineage.",
        };
      }
      if (existing.hostRuntimeRunId === null && hostRuntimeRunId !== null) {
        existing.hostRuntimeRunId = hostRuntimeRunId;
      }
      if (!lineageMatchesPrepared(existing, prepared.job)) {
        return {
          status: "blocked",
          nodeId: input.nodeId,
          code: "companion_lineage_drift",
          reason: "Persisted companion lineage conflicts with this authorized graph node.",
          requiredAction: "Open Run Details and reconcile the persisted companion job before resuming.",
        };
      }
      try {
        const job = await this.client.getJob(existing.jobId);
        // A confirmed remote job may execute independently. Bind the exact core
        // attempt before adopting or returning that lineage.
        await input.beforeSubmit?.(prepared.job);
        assertLineageMatches(existing, job);
        adoptRemoteLineage(existing, job);
        await this.persistRuntimeState();
        return { status: "submitted", job };
      } catch (error) {
        if (existing.state === "prepared" && isDefinitiveJobMissing(error)) {
          // A prepared-only lineage has never had a confirmed remote effect.
          // A definitive 404 permits the one deterministic create below. Run
          // health gates before creating the core attempt.
        } else {
          // Ambiguous readback cannot prove the remote job absent. Bind the core
          // attempt before persisting reconcile_required.
          await input.beforeSubmit?.(prepared.job);
          existing.reconcileStatus = "reconcile_required";
          existing.reconcileError = safeError(error);
          existing.updatedAt = new Date().toISOString();
          await this.persistRuntimeState();
          return {
            status: "blocked",
            nodeId: input.nodeId,
            code: "companion_reconcile_required",
            reason:
              "The existing companion dispatch could not be verified by readback.",
            requiredAction:
              "Reconnect the companion service and reconcile the persisted job; do not resubmit it.",
          };
        }
      }
    }
    const snapshot = await this.refreshHealth();
    if (!snapshot.health?.coordinatorReady) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: "coordinator_unavailable",
        reason: snapshot.lastError ?? "The companion coordinator is unavailable.",
        requiredAction: "Start the companion service and retry after health is green.",
      };
    }
    if (!snapshot.health.workerReady) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: "background_worker_unavailable",
        reason:
          snapshot.health.workerDiagnostic ??
          "The authenticated standalone worker has not completed a recent poll cycle.",
        requiredAction: "Start or repair the companion worker, then resume the mission.",
      };
    }
    if (
      Array.isArray(snapshot.health.installedExecutorDomains) &&
      !snapshot.health.installedExecutorDomains.includes(prepared.job.domain)
    ) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: "background_executor_unavailable",
        reason: `The installed worker does not advertise a ${prepared.job.domain} executor.`,
        requiredAction: `Install or repair the companion ${prepared.job.domain} executor, then resume the mission.`,
      };
    }
    if (!snapshot.health.backgroundEnabled) {
      return {
        status: "blocked",
        nodeId: input.nodeId,
        code: snapshot.health.backgroundBlocker ?? "background_disabled",
        reason:
          "Background execution is disabled because a secure persistent credential backend is unavailable or background mode is not installed.",
        requiredAction:
          "Configure the OS credential store and explicitly install the companion background service.",
      };
    }
    // For a new job, all read-only health/capability gates pass before the core
    // consumes and persists the exact remote attempt. From this point onward
    // the extension WAL and POST /jobs are the only remaining steps.
    await input.beforeSubmit?.(prepared.job);
    if (!existing) {
      existing = lineageFromPreparedJob(prepared.job, hostRuntimeRunId);
      this.runtimeState.jobs[prepared.job.id] = existing;
    } else {
      existing.reconcileStatus = "pending";
      existing.reconcileError = null;
      existing.updatedAt = new Date().toISOString();
    }
    // This lineage is the extension-side WAL. It must be durable before the
    // first POST /jobs so a remote commit can always be adopted after restart.
    await this.persistRuntimeState();
    let job: CompanionRemoteJobV1;
    try {
      job = await this.client.submit(prepared.job);
    } catch (dispatchError) {
      // Job creation is idempotent, but a transport failure after commit is
      // ambiguous. Reconcile by deterministic job-id readback only; never
      // redispatch from this call.
      try {
        job = await this.client.getJob(prepared.job.id);
      } catch (readbackError) {
        existing.reconcileStatus = "reconcile_required";
        existing.reconcileError = safeError(readbackError);
        existing.updatedAt = new Date().toISOString();
        await this.persistRuntimeState();
        return {
          status: "blocked",
          nodeId: input.nodeId,
          code: "companion_reconcile_required",
          reason: `Companion job submission is ambiguous: ${safeError(readbackError)}`,
          requiredAction:
            "Reconnect the companion and reconcile the persisted job id; do not resubmit the Linear mutation.",
        };
      }
      this.lastError = safeError(dispatchError);
    }
    assertLineageMatches(existing, job);
    adoptRemoteLineage(existing, job);
    await this.persistRuntimeState();
    return { status: "submitted", job };
  }

  async replayEvents(
    jobId: string,
    afterSequence = 0,
    signal?: AbortSignal,
  ): Promise<CompanionEventV1[]> {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    const events = await this.client.replayEvents({ jobId, afterSequence, signal });
    const lineage = this.runtimeState.jobs[jobId];
    if (lineage && events.length > 0) {
      lineage.lastObservedEventSequence = Math.max(
        lineage.lastObservedEventSequence,
        events[events.length - 1].sequence,
      );
      lineage.updatedAt = new Date().toISOString();
      await this.persistRuntimeState();
    }
    return events;
  }

  async acknowledgeAppliedEvents(jobId: string, throughSequence: number): Promise<void> {
    const lineage = this.runtimeState.jobs[jobId];
    if (!lineage) throw new Error(`Unknown persisted companion lineage: ${jobId}.`);
    if (
      !Number.isInteger(throughSequence) ||
      throughSequence < lineage.lastAppliedEventSequence ||
      throughSequence > lineage.lastObservedEventSequence
    ) {
      throw new Error("Applied companion cursor is outside the observed durable range.");
    }
    const previousSequence = lineage.lastAppliedEventSequence;
    const previousUpdatedAt = lineage.updatedAt;
    const nextUpdatedAt = new Date().toISOString();
    lineage.lastAppliedEventSequence = throughSequence;
    lineage.updatedAt = nextUpdatedAt;
    try {
      await this.persistRuntimeState();
    } catch (error) {
      // Runtime state is a durable projection, not an optimistic UI cache. If
      // persistence rejects, restore this exact attempt so the same cursor can
      // be retried without waiting for a process restart. Do not overwrite a
      // genuinely newer concurrent lineage mutation.
      if (
        lineage.lastAppliedEventSequence === throughSequence &&
        lineage.updatedAt === nextUpdatedAt
      ) {
        lineage.lastAppliedEventSequence = previousSequence;
        lineage.updatedAt = previousUpdatedAt;
      }
      throw error;
    }
  }

  async reconcilePersistedJobs(
    signal?: AbortSignal,
  ): Promise<CompanionReconciledLineageV1[]> {
    return this.withCoordinationLock(() =>
      this.reconcilePersistedJobsUnlocked(signal),
    );
  }

  private async reconcilePersistedJobsUnlocked(
    signal?: AbortSignal,
  ): Promise<CompanionReconciledLineageV1[]> {
    if (!this.client) throw new Error("The authenticated companion session is not connected.");
    const results: CompanionReconciledLineageV1[] = [];
    for (const lineage of Object.values(this.runtimeState.jobs)) {
      if (signal?.aborted) break;
      try {
        const job = await this.client.getJob(lineage.jobId);
        assertLineageMatches(lineage, job);
        adoptRemoteLineage(lineage, job);
        const projected = remoteJobToCompanionJob(job);
        const events = await this.client.replayEvents({
          jobId: job.id,
          afterSequence: lineage.lastAppliedEventSequence,
          signal,
        });
        const receipts = await this.client.listReceipts(job.id);
        for (const receipt of receipts) {
          const expected = await companionReceiptFingerprintV1({
            job: projected,
            provider: receipt.provider,
            operation: receipt.operation,
            status: receipt.status,
            payload: receipt.payload,
          });
          if (expected !== receipt.fingerprint) {
            throw new Error(`Receipt ${receipt.id} fingerprint drifted.`);
          }
        }
        lineage.state = job.state;
        lineage.lastObservedEventSequence = Math.max(
          lineage.lastObservedEventSequence,
          events.length > 0 ? events[events.length - 1].sequence : 0,
        );
        lineage.receiptFingerprints = [...new Set(receipts.map((item) => item.fingerprint))].sort();
        lineage.resultFingerprint =
          typeof job.output?.resultFingerprint === "string"
            ? job.output.resultFingerprint
            : null;
        lineage.reconcileStatus =
          job.state === "complete"
            ? "reconciled"
            : ["blocked", "failed", "cancelled"].includes(job.state)
              ? "terminal_blocked"
              : "pending";
        lineage.reconcileError = null;
        lineage.updatedAt = job.updatedAt;
        results.push({ lineage: { ...lineage }, job, events, receipts });
      } catch (error) {
        lineage.reconcileStatus = "reconcile_required";
        lineage.reconcileError = safeError(error);
        lineage.updatedAt = new Date().toISOString();
      }
    }
    await this.persistRuntimeState();
    return results;
  }

  private async withCoordinationLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.coordinationTail.catch(() => undefined);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.coordinationTail = previous.then(() => current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async persistRuntimeState(): Promise<void> {
    if (!this.persistence) return;
    const snapshot = cloneRuntimeState(this.runtimeState);
    const save = this.persistChain
      .catch(() => undefined)
      .then(() => this.persistence!.save(snapshot));
    this.persistChain = save.catch(() => undefined);
    await save;
  }

  private requireClient(): CompanionCoordinatorClientV1 {
    if (!this.client) {
      throw new Error("The authenticated companion session is not connected.");
    }
    return this.client;
  }
}

function lineageMatchesPrepared(
  lineage: PersistedCompanionLineageV1,
  job: CompanionJobV1,
): boolean {
  return (
    lineage.jobId === job.id &&
    lineage.missionId === job.missionId &&
    lineage.nodeId === job.nodeId &&
    lineage.idempotencyKey === job.idempotencyKey &&
    lineage.capabilityEnvelopeFingerprint === job.capabilityEnvelopeFingerprint &&
    lineage.authorizationFingerprint === job.authorization.fingerprint
  );
}

function lineageFromPreparedJob(
  job: CompanionJobV1,
  hostRuntimeRunId: string | null,
): PersistedCompanionLineageV1 {
  return {
    version: 1,
    jobId: job.id,
    missionId: job.missionId,
    nodeId: job.nodeId,
    graphRevision: job.graphRevision,
    idempotencyKey: job.idempotencyKey,
    capabilityEnvelopeFingerprint: job.capabilityEnvelopeFingerprint,
    authorizationFingerprint: job.authorization.fingerprint,
    hostRuntimeRunId,
    state: "prepared",
    lastObservedEventSequence: 0,
    lastAppliedEventSequence: 0,
    receiptFingerprints: [],
    resultFingerprint: null,
    reconcileStatus: "pending",
    reconcileError: null,
    updatedAt: job.updatedAt,
  };
}

function adoptRemoteLineage(
  lineage: PersistedCompanionLineageV1,
  remote: CompanionRemoteJobV1,
): void {
  lineage.state = remote.state;
  lineage.reconcileStatus = "pending";
  lineage.reconcileError = null;
  lineage.updatedAt = remote.updatedAt;
}

function isDefinitiveJobMissing(error: unknown): boolean {
  return (
    error instanceof CompanionCoordinatorClientErrorV1 && error.status === 404
  );
}

function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Companion request failed.";
  return message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 4_096);
}

function defaultRuntimeState(): CompanionRuntimeStateV1 {
  return {
    version: 1,
    serviceInstalled: false,
    baseUrl: "http://127.0.0.1:8765",
    linearQueueLastObservedEventSequence: 0,
    linearQueueLastAppliedEventSequence: 0,
    jobs: {},
  };
}

function parseRuntimeState(value: unknown): CompanionRuntimeStateV1 {
  if (value === null || value === undefined) return defaultRuntimeState();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Persisted companion runtime state is malformed.");
  }
  const source = value as Partial<CompanionRuntimeStateV1>;
  const legacyKeys = [
    "version",
    "serviceInstalled",
    "baseUrl",
    "jobs",
  ];
  const currentKeys = [
    ...legacyKeys,
    "linearQueueLastObservedEventSequence",
    "linearQueueLastAppliedEventSequence",
  ];
  const sourceKeys = Object.keys(source as Record<string, unknown>);
  if (sourceKeys.length === legacyKeys.length) {
    assertExactKeys(source as Record<string, unknown>, legacyKeys, "runtime state");
  } else {
    assertExactKeys(source as Record<string, unknown>, currentKeys, "runtime state");
  }
  if (source.version !== 1) {
    throw new Error("Unsupported persisted companion runtime state version.");
  }
  if (typeof source.serviceInstalled !== "boolean" || typeof source.baseUrl !== "string") {
    throw new Error("Persisted companion runtime state fields are malformed.");
  }
  const state = defaultRuntimeState();
  state.serviceInstalled = source.serviceInstalled;
  state.baseUrl =
    typeof source.baseUrl === "string" ? source.baseUrl : state.baseUrl;
  const observed = source.linearQueueLastObservedEventSequence ?? 0;
  const applied = source.linearQueueLastAppliedEventSequence ?? 0;
  if (
    !Number.isInteger(observed) ||
    observed < 0 ||
    !Number.isInteger(applied) ||
    applied < 0 ||
    applied > observed
  ) {
    throw new Error("Persisted companion Linear queue cursors are malformed.");
  }
  state.linearQueueLastObservedEventSequence = observed;
  state.linearQueueLastAppliedEventSequence = applied;
  if (source.jobs && typeof source.jobs === "object" && !Array.isArray(source.jobs)) {
    for (const [jobId, raw] of Object.entries(source.jobs)) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
      const item = raw as PersistedCompanionLineageV1;
      const legacyLineageKeys = [
        "version",
        "jobId",
        "missionId",
        "nodeId",
        "graphRevision",
        "idempotencyKey",
        "capabilityEnvelopeFingerprint",
        "authorizationFingerprint",
        "state",
        "lastObservedEventSequence",
        "lastAppliedEventSequence",
        "receiptFingerprints",
        "resultFingerprint",
        "reconcileStatus",
        "reconcileError",
        "updatedAt",
      ];
      const currentLineageKeys = [
        ...legacyLineageKeys,
        "hostRuntimeRunId",
      ];
      const rawLineage = item as unknown as Record<string, unknown>;
      if (
        !hasExactKeys(rawLineage, legacyLineageKeys) &&
        !hasExactKeys(rawLineage, currentLineageKeys)
      ) {
        throw new Error(
          `Persisted companion lineage ${jobId} has unknown or missing fields.`,
        );
      }
      const hostRuntimeRunId = normalizeHostRuntimeRunId(
        "hostRuntimeRunId" in rawLineage
          ? rawLineage.hostRuntimeRunId
          : null,
      );
      if (
        item.version === 1 &&
        item.jobId === jobId &&
        typeof item.missionId === "string" &&
        typeof item.nodeId === "string" &&
        typeof item.idempotencyKey === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(item.capabilityEnvelopeFingerprint) &&
        /^sha256:[a-f0-9]{64}$/.test(item.authorizationFingerprint) &&
        Number.isInteger(item.graphRevision) &&
        item.graphRevision >= 0 &&
        Number.isInteger(item.lastObservedEventSequence) &&
        item.lastObservedEventSequence >= 0 &&
        Number.isInteger(item.lastAppliedEventSequence) &&
        item.lastAppliedEventSequence >= 0 &&
        item.lastAppliedEventSequence <= item.lastObservedEventSequence &&
        ["pending", "reconciled", "terminal_blocked", "reconcile_required"].includes(
          item.reconcileStatus,
        ) &&
        (item.resultFingerprint === null || /^sha256:[a-f0-9]{64}$/.test(item.resultFingerprint)) &&
        typeof item.state === "string" &&
        !Number.isNaN(Date.parse(item.updatedAt))
      ) {
        state.jobs[jobId] = {
          ...item,
          hostRuntimeRunId,
          receiptFingerprints: Array.isArray(item.receiptFingerprints)
            ? item.receiptFingerprints.filter((entry) => /^sha256:[a-f0-9]{64}$/.test(entry))
            : [],
        };
      }
      else {
        throw new Error(`Persisted companion lineage ${jobId} is malformed.`);
      }
    }
  }
  return state;
}

function linearQueueEventText(
  event: CompanionLinearQueueEventV1,
  key: string,
): string {
  const value = event.payload[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Companion Linear queue event ${key} is malformed.`);
  }
  return value;
}

function linearQueueEventFingerprint(
  event: CompanionLinearQueueEventV1,
  key: string,
): string {
  const value = linearQueueEventText(event, key);
  if (!/^sha256:[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Companion Linear queue event ${key} is not a fingerprint.`);
  }
  return value;
}

function exactRecord(
  value: unknown,
  keys: string[],
  context: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} is malformed.`);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${context} has unknown or missing fields.`);
  }
  return record;
}

function openRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${context} is malformed.`);
  }
  return value as Record<string, unknown>;
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (actual.length !== canonical.length || actual.some((key, index) => key !== canonical[index])) {
    throw new Error(`Persisted companion ${context} has unknown or missing fields.`);
  }
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: string[],
): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return (
    actual.length === canonical.length &&
    actual.every((key, index) => key === canonical[index])
  );
}

function normalizeHostRuntimeRunId(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value.trim() !== value ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9._:-]*[A-Za-z0-9])?$/u.test(value)
  ) {
    throw new Error("Persisted companion host runtime run id is malformed.");
  }
  return value;
}

function cloneRuntimeState(state: CompanionRuntimeStateV1): CompanionRuntimeStateV1 {
  return JSON.parse(JSON.stringify(state)) as CompanionRuntimeStateV1;
}

function assertLineageMatches(
  lineage: PersistedCompanionLineageV1,
  remote: CompanionRemoteJobV1,
): void {
  const capability = remote.capabilityEnvelope;
  if (
    remote.id !== lineage.jobId ||
    remote.missionId !== lineage.missionId ||
    remote.nodeId !== lineage.nodeId ||
    remote.idempotencyKey !== lineage.idempotencyKey ||
    capability.fingerprint !== lineage.capabilityEnvelopeFingerprint ||
    capability.authorizationFingerprint !== lineage.authorizationFingerprint
  ) {
    throw new Error("Companion remote job lineage drifted from persisted host identity.");
  }
}

function isTerminal(state: string): boolean {
  return ["complete", "blocked", "cancelled", "failed"].includes(state);
}
