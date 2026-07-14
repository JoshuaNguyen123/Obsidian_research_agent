import {
  type BackgroundExecutionDomainV1,
  type CompanionEventV1,
  type CompanionJobV1,
  type CompanionReceiptV1,
  companionReceiptFingerprintV1,
  HeadlessMissionWorkerV1,
  type HeadlessDomainExecutorV1,
  type HeadlessWorkerResultV1,
} from "./backgroundContinuation";
import {
  CompanionCoordinatorClientErrorV1,
  type CompanionCoordinatorClientV1,
  type CompanionJobLeaseHandleV1,
  type CompanionRemoteJobV1,
} from "./companionCoordinatorClient";
import { sha256Fingerprint } from "./canonicalize";
import type { MissionJsonValueV1 } from "./missionGraphV3";
import type { CompanionLinearQueuePollerV1 } from "./companionLinearQueuePoller";
import { parsePreparedExternalActionHandoffV1 } from "../../core-api/src/preparedExternalActionHandoffV1";
import { parsePreparedBackgroundCodeActionV1 } from "../../core-api/src/preparedBackgroundCodeActionV1";
import { parsePreparedBackgroundCodePackageIdentityV1 } from "../../core-api/src/preparedBackgroundCodePackageIdentityV1";
import { parsePreparedBackgroundGitHubActionV1 } from "../../core-api/src/preparedBackgroundGitHubActionV1";
import { parsePreparedBackgroundGitHubPackageIdentityV1 } from "../../core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import {
  createPublicResearchFetchExecutorV1,
  type PublicResearchFetchDependenciesV1,
} from "./publicResearchFetchExecutor";
import {
  createInstalledGitHubExecutorV1,
  createInstalledCodeExecutorV1,
  createLinearIssueReadbackExecutorV1,
  INSTALLED_HEADLESS_EXECUTOR_IDS_V1,
  type InstalledDomainExecutorDependenciesV1,
} from "./installedDomainExecutors";

export const COMPANION_WORKER_CATALOG_VERSION = 1 as const;
export const COMPANION_WORKER_HEARTBEAT_INTERVAL_MS = 15_000 as const;

export interface HeadlessExecutorCatalogConfigV1 {
  version: typeof COMPANION_WORKER_CATALOG_VERSION;
  executors: Partial<
    Record<BackgroundExecutionDomainV1, string>
  >;
}

export type HeadlessExecutorCatalogDependenciesV1 =
  InstalledDomainExecutorDependenciesV1 & {
    publicResearchFetch?: PublicResearchFetchDependenciesV1;
  };

export interface CompanionWorkerCoordinatorOptionsV1 {
  client: CompanionCoordinatorClientV1;
  coordinatorId: string;
  executorCatalog: Partial<
    Record<BackgroundExecutionDomainV1, HeadlessDomainExecutorV1>
  >;
  catalogFingerprint: string;
  leaseSeconds?: number;
  heartbeatIntervalMs?: number;
  workerHeartbeatIntervalMs?: number;
  pollIntervalMs?: number;
  linearQueuePoller?: Pick<CompanionLinearQueuePollerV1, "runDue">;
  now?: () => Date;
}

export interface CompanionWorkerCycleResultV1 {
  inspected: number;
  claimed: number;
  completed: number;
  blocked: number;
  failed: number;
}

/**
 * Production coordinator loop. It claims queued or expired-running jobs from
 * the authenticated service, renews the exact lease during execution, invokes
 * the shared worker, and persists every event, receipt, and terminal outcome.
 */
export class CompanionWorkerCoordinatorV1 {
  private readonly now: () => Date;
  private readonly leaseSeconds: number;
  private readonly heartbeatIntervalMs: number;
  private readonly pollIntervalMs: number;
  private readonly workerHeartbeatIntervalMs: number;

  constructor(private readonly options: CompanionWorkerCoordinatorOptionsV1) {
    this.now = options.now ?? (() => new Date());
    this.leaseSeconds = clamp(options.leaseSeconds ?? 60, 5, 300);
    this.heartbeatIntervalMs = clamp(
      options.heartbeatIntervalMs ?? Math.floor((this.leaseSeconds * 1_000) / 3),
      1_000,
      Math.max(1_000, this.leaseSeconds * 1_000 - 1_000),
    );
    this.workerHeartbeatIntervalMs = clamp(
      options.workerHeartbeatIntervalMs ?? COMPANION_WORKER_HEARTBEAT_INTERVAL_MS,
      250,
      COMPANION_WORKER_HEARTBEAT_INTERVAL_MS,
    );
    this.pollIntervalMs = clamp(
      options.pollIntervalMs ?? 2_000,
      250,
      COMPANION_WORKER_HEARTBEAT_INTERVAL_MS,
    );
    if (!options.coordinatorId.trim()) {
      throw new Error("Companion worker coordinatorId is required.");
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(options.catalogFingerprint)) {
      throw new Error("Companion worker catalog fingerprint is invalid.");
    }
  }

  async runOnce(signal = new AbortController().signal): Promise<CompanionWorkerCycleResultV1> {
    const liveness = this.startWorkerLiveness(signal);
    try {
      await liveness.started;
      return await this.runCycle(signal);
    } finally {
      await liveness.stop();
    }
  }

  private async runCycle(signal: AbortSignal): Promise<CompanionWorkerCycleResultV1> {
    await this.options.client.health();
    try {
      await this.options.linearQueuePoller?.runDue(signal);
    } catch {
      // Queue polling persists its own bounded diagnostics. A transient scan
      // failure must not stop already-authorized companion jobs from running.
    }
    const jobs = await this.options.client.listJobs({
      state: ["queued", "running"],
      limit: 500,
    });
    const result: CompanionWorkerCycleResultV1 = {
      inspected: jobs.length,
      claimed: 0,
      completed: 0,
      blocked: 0,
      failed: 0,
    };
    for (const remote of jobs) {
      if (signal.aborted) break;
      if (!isClaimable(remote, this.now())) continue;
      let claimed;
      try {
        claimed = await this.options.client.claim({
          jobId: remote.id,
          coordinatorId: this.options.coordinatorId,
          leaseSeconds: this.leaseSeconds,
        });
      } catch (error) {
        if (isExpectedClaimRace(error)) continue;
        result.failed += 1;
        continue;
      }
      result.claimed += 1;
      try {
        const outcome = await this.executeClaimed(claimed.job, claimed.lease, signal);
        if (outcome === "complete") result.completed += 1;
        else if (outcome === "blocked") result.blocked += 1;
        else if (outcome === "reconcile_required") result.blocked += 1;
        else result.failed += 1;
      } finally {
        claimed.lease.dispose();
      }
    }
    return result;
  }

  async runForever(signal: AbortSignal): Promise<void> {
    const liveness = this.startWorkerLiveness(signal);
    try {
      await liveness.started;
      while (!signal.aborted) {
        try {
          await this.runCycle(signal);
        } catch {
          // The process-level service supervisor owns diagnostics and restart.
          // Transient service unavailability is retried without logging secrets.
        }
        await abortableDelay(this.pollIntervalMs, signal);
      }
    } finally {
      await liveness.stop();
    }
  }

  private startWorkerLiveness(signal: AbortSignal): {
    started: Promise<void>;
    stop(): Promise<void>;
  } {
    let stopped = false;
    let failure: unknown = null;
    let chain = Promise.resolve();
    const pulse = () => {
      chain = chain.then(async () => {
        if (stopped || signal.aborted || failure) return;
        try {
          await this.options.client.workerHeartbeat({
            coordinatorId: this.options.coordinatorId,
            catalogFingerprint: this.options.catalogFingerprint,
            polledAt: this.now().toISOString(),
          });
        } catch (error) {
          failure = error;
        }
      });
      return chain;
    };
    const started = pulse().then(() => {
      if (failure) throw failure;
    });
    const interval = globalThis.setInterval(pulse, this.workerHeartbeatIntervalMs);
    return {
      started,
      async stop() {
        stopped = true;
        globalThis.clearInterval(interval);
        await chain;
        if (failure) throw failure;
      },
    };
  }

  private async executeClaimed(
    remote: CompanionRemoteJobV1,
    lease: CompanionJobLeaseHandleV1,
    signal: AbortSignal,
  ): Promise<HeadlessWorkerResultV1["status"]> {
    let job: CompanionJobV1 | null = null;
    let heartbeatFailure: unknown = null;
    let heartbeatChain = Promise.resolve();
    const heartbeat = globalThis.setInterval(() => {
      heartbeatChain = heartbeatChain
        .then(async () => {
          if (signal.aborted || heartbeatFailure) return;
          await this.options.client.heartbeat({
            jobId: remote.id,
            lease,
            leaseSeconds: this.leaseSeconds,
          });
        })
        .catch((error) => {
          heartbeatFailure = error;
        });
    }, this.heartbeatIntervalMs);
    try {
      job = remoteJobToCompanionJob(remote);
      const worker = new HeadlessMissionWorkerV1({
        executors: this.options.executorCatalog,
        now: this.now,
        receiptJournal: {
          list: async () => {
            const receipts = await this.options.client.listReceipts(remote.id);
            for (const receipt of receipts) {
              const expected = await companionReceiptFingerprintV1({
                job: remoteJobToCompanionJob(remote),
                provider: receipt.provider,
                operation: receipt.operation,
                status: receipt.status,
                payload: receipt.payload,
              });
              if (expected !== receipt.fingerprint) {
                throw new Error(
                  `Companion receipt ${receipt.id} fingerprint drifted.`,
                );
              }
            }
            return receipts;
          },
          commit: (activeJob, receipt) =>
            this.options.client.appendReceipt({
              job: remote,
              lease,
              receipt: {
                version: receipt.version,
                jobId: activeJob.id,
                missionId: activeJob.missionId,
                nodeId: activeJob.nodeId,
                provider: receipt.provider,
                operation: receipt.operation,
                status: receipt.status,
                fingerprint: receipt.fingerprint,
                payload: receipt.payload,
              },
            }),
        },
        emit: async (event) => {
          if (isTerminalWorkerEvent(event.type)) {
            // The coordinator service creates terminal events only after its
            // receipt and completion transactions are durably committed.
            return;
          }
          await this.options.client.appendEvent({
            job: remote,
            lease,
            type: event.type,
            payload:
              event.type === "job_progress"
                ? { ...event.payload, observedSequence: event.sequence }
                : event.payload,
          });
        },
      });
      const outcome = await worker.execute(job, signal);
      globalThis.clearInterval(heartbeat);
      await heartbeatChain;
      if (heartbeatFailure) {
        throw heartbeatFailure;
      }

      const persistedReceipts: CompanionReceiptV1[] = [];
      for (const receipt of outcome.receipts ?? []) {
        persistedReceipts.push(
          await this.options.client.appendReceipt({
            job: remote,
            lease,
            receipt: {
              version: receipt.version,
              jobId: receipt.jobId,
              missionId: receipt.missionId,
              nodeId: receipt.nodeId,
              provider: receipt.provider,
              operation: receipt.operation,
              status: receipt.status,
              fingerprint: receipt.fingerprint,
              payload: receipt.payload,
            },
          }),
        );
      }
      const completion = {
        status: outcome.status,
        outputs: outcome.outputs ?? {},
        evidence: outcome.evidence ?? [],
        receiptIds: persistedReceipts.map((receipt) => receipt.id),
        blocker: outcome.blocker ?? null,
      };
      if (outcome.status === "reconcile_required") {
        await this.options.client.appendEvent({
          job: remote,
          lease,
          type: "job_progress",
          payload: {
            message:
              "Provider mutation may have applied; lease will expire and the next worker attempt is readback-only.",
          },
        });
        return "reconcile_required";
      }
      const resultFingerprint = await companionResultFingerprintV1(job, completion);
      await this.options.client.complete({
        jobId: remote.id,
        lease,
        state: outcome.status,
        output: {
          ...completion,
          resultFingerprint,
        },
      });
      return outcome.status;
    } catch (error) {
      globalThis.clearInterval(heartbeat);
      await heartbeatChain.catch(() => undefined);
      try {
        if (!job) {
          job = remoteJobToCompanionJob(remote);
        }
        const failedResult = {
          status: "failed",
          outputs: {},
          evidence: [],
          receiptIds: [],
          blocker: {
            code: "worker_execution_failed",
            message: sanitizeError(error),
            requiredAction: null,
          },
        };
        await this.options.client.complete({
          jobId: remote.id,
          lease,
          state: "failed",
          output: {
            ...failedResult,
            resultFingerprint: await companionResultFingerprintV1(job, failedResult),
          },
        });
      } catch {
        // Ambiguous completion is reconciled by the next expired-lease cycle.
      }
      return "failed";
    }
  }
}

export async function companionResultFingerprintV1(
  job: Pick<
    CompanionJobV1,
    | "id"
    | "missionId"
    | "nodeId"
    | "idempotencyKey"
    | "capabilityEnvelopeFingerprint"
    | "authorization"
  >,
  result: {
    status: string;
    outputs: Record<string, MissionJsonValueV1>;
    evidence: MissionJsonValueV1[];
    receiptIds: string[];
    blocker: { code: string; message: string; requiredAction: string | null } | null;
  },
): Promise<string> {
  return sha256Fingerprint({
    version: 1,
    job: {
      id: job.id,
      missionId: job.missionId,
      nodeId: job.nodeId,
      idempotencyKey: job.idempotencyKey,
      capabilityEnvelopeFingerprint: job.capabilityEnvelopeFingerprint,
      authorizationFingerprint: job.authorization.fingerprint,
    },
    result,
  });
}

export function buildHeadlessExecutorCatalogV1(
  config: HeadlessExecutorCatalogConfigV1 | null | undefined,
  dependencies: HeadlessExecutorCatalogDependenciesV1 = {},
): Partial<Record<BackgroundExecutionDomainV1, HeadlessDomainExecutorV1>> {
  if (!config) return {};
  const parsed = parseHeadlessExecutorCatalogConfigV1(config);
  const result: Partial<Record<BackgroundExecutionDomainV1, HeadlessDomainExecutorV1>> = {};
  for (const domain of ["research", "code", "linear", "github"] as const) {
    const executorId = parsed.executors[domain];
    if (!executorId) continue;
    if (
      domain === "research" &&
      executorId === INSTALLED_HEADLESS_EXECUTOR_IDS_V1.research &&
      dependencies.publicResearchFetch
    ) {
      result.research = createPublicResearchFetchExecutorV1(
        dependencies.publicResearchFetch,
      );
      continue;
    }
    if (domain === "code" && executorId === INSTALLED_HEADLESS_EXECUTOR_IDS_V1.code) {
      result.code = createInstalledCodeExecutorV1(dependencies);
      continue;
    }
    if (
      domain === "linear" &&
      executorId === INSTALLED_HEADLESS_EXECUTOR_IDS_V1.linear
    ) {
      result.linear = createLinearIssueReadbackExecutorV1(dependencies);
      continue;
    }
    if (
      domain === "github" &&
      executorId === INSTALLED_HEADLESS_EXECUTOR_IDS_V1.github
    ) {
      result.github = createInstalledGitHubExecutorV1(dependencies);
      continue;
    }
    // IDs are data only. Nothing here imports a path, evaluates code, loads a
    // module, or converts an unknown operation into an executable handler.
    throw new Error(`Unknown installed ${domain} executor: ${executorId}.`);
  }
  return result;
}

export function parseHeadlessExecutorCatalogConfigV1(
  value: unknown,
): HeadlessExecutorCatalogConfigV1 {
  const record = asRecord(value);
  assertExactKeys(record, ["version", "executors"], "executor catalog");
  if (record.version !== COMPANION_WORKER_CATALOG_VERSION) {
    throw new Error("Unsupported headless executor catalog version.");
  }
  const executors = asRecord(record.executors);
  const domains = ["research", "code", "linear", "github"] as const;
  const unknown = Object.keys(executors).filter(
    (key) => !domains.includes(key as BackgroundExecutionDomainV1),
  );
  if (unknown.length > 0) {
    throw new Error("Headless executor catalog contains an unknown domain.");
  }
  const parsed: Partial<Record<BackgroundExecutionDomainV1, string>> = {};
  for (const domain of domains) {
    const executorId = executors[domain];
    if (executorId === undefined) continue;
    if (
      typeof executorId !== "string" ||
      executorId !== INSTALLED_HEADLESS_EXECUTOR_IDS_V1[domain]
    ) {
      throw new Error(`Unknown installed ${domain} executor: ${String(executorId)}.`);
    }
    parsed[domain] = executorId;
  }
  return Object.freeze({
    version: COMPANION_WORKER_CATALOG_VERSION,
    executors: Object.freeze(parsed),
  });
}

export function remoteJobToCompanionJob(remote: CompanionRemoteJobV1): CompanionJobV1 {
  const payload = asRecord(remote.payload);
  const capability = asRecord(remote.capabilityEnvelope);
  const authorization = asRecord(payload.authorization);
  const domain = remote.executionHost;
  if (!isDomain(domain)) {
    throw new Error("Remote job has an unsupported execution domain.");
  }
  const authorizationFingerprint = requiredString(
    authorization.fingerprint,
    "authorization.fingerprint",
  );
  if (
    requiredString(
      capability.authorizationFingerprint,
      "capabilityEnvelope.authorizationFingerprint",
    ) !== authorizationFingerprint
  ) {
    throw new Error("Remote job authorization fingerprint drifted from its envelope.");
  }
  const bindings = Array.isArray(payload.bindings)
    ? payload.bindings.map((binding) => {
        const value = asRecord(binding);
        return {
          id: requiredString(value.id, "binding.id"),
          kind: requiredString(value.kind, "binding.kind"),
          destinationFingerprint: requiredString(
            value.destinationFingerprint,
            "binding.destinationFingerprint",
          ),
        };
      })
    : [];
  return {
    version: 1,
    id: remote.id,
    missionId: remote.missionId,
    nodeId: remote.nodeId,
    graphRevision: requiredInteger(payload.graphRevision, "graphRevision"),
    domain,
    executionHost:
      payload.executionHost === "companion" ? "companion" : "headless_runtime",
    state: remote.state === "running" ? "running" : "queued",
    objective: requiredString(payload.objective, "objective"),
    inputs: asJsonRecord(payload.inputs),
    allowedTools: stringArray(payload.allowedTools, "allowedTools"),
    requiredCapabilities: stringArray(
      payload.requiredCapabilities,
      "requiredCapabilities",
    ),
    bindings,
    capabilityEnvelopeFingerprint: requiredString(
      capability.fingerprint,
      "capabilityEnvelope.fingerprint",
    ),
    authorization: {
      version: 1,
      grantId: requiredString(authorization.grantId, "authorization.grantId"),
      fingerprint: authorizationFingerprint,
      authorizedAt: requiredString(
        authorization.authorizedAt,
        "authorization.authorizedAt",
      ),
      expiresAt:
        authorization.expiresAt === null
          ? null
          : requiredString(authorization.expiresAt, "authorization.expiresAt"),
    },
    preparedExternalActionHandoff:
      payload.preparedExternalActionHandoff === null ||
      payload.preparedExternalActionHandoff === undefined
        ? null
        : parsePreparedExternalActionHandoffV1(
            payload.preparedExternalActionHandoff,
          ),
    preparedBackgroundCodeAction:
      payload.preparedBackgroundCodeAction === null ||
      payload.preparedBackgroundCodeAction === undefined
        ? null
        : parsePreparedBackgroundCodeActionV1(
            payload.preparedBackgroundCodeAction,
          ),
    preparedBackgroundCodePackage:
      payload.preparedBackgroundCodePackage === null ||
      payload.preparedBackgroundCodePackage === undefined
        ? null
        : parsePreparedBackgroundCodePackageIdentityV1(
            payload.preparedBackgroundCodePackage,
          ),
    preparedBackgroundGitHubAction:
      payload.preparedBackgroundGitHubAction === null ||
      payload.preparedBackgroundGitHubAction === undefined
        ? null
        : parsePreparedBackgroundGitHubActionV1(
            payload.preparedBackgroundGitHubAction,
          ),
    preparedBackgroundGitHubPackage:
      payload.preparedBackgroundGitHubPackage === null ||
      payload.preparedBackgroundGitHubPackage === undefined
        ? null
        : parsePreparedBackgroundGitHubPackageIdentityV1(
            payload.preparedBackgroundGitHubPackage,
          ),
    idempotencyKey: remote.idempotencyKey,
    attempts: remote.attempts,
    createdAt: remote.createdAt,
    updatedAt: remote.updatedAt,
  };
}

function isClaimable(job: CompanionRemoteJobV1, now: Date): boolean {
  if (job.state === "queued") return true;
  if (job.state !== "running") return false;
  return !job.leaseExpiresAt || Date.parse(job.leaseExpiresAt) <= now.getTime();
}

function isExpectedClaimRace(error: unknown): boolean {
  return (
    error instanceof CompanionCoordinatorClientErrorV1 &&
    (error.status === 409 || error.status === 503)
  );
}

async function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = globalThis.setTimeout(done, milliseconds);
    function done() {
      signal.removeEventListener("abort", done);
      globalThis.clearTimeout(timer);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function sanitizeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Worker execution failed.")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]")
    .slice(0, 4_096);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function assertExactKeys(
  value: Record<string, unknown>,
  expected: string[],
  context: string,
): void {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (
    actual.length !== canonical.length ||
    actual.some((key, index) => key !== canonical[index])
  ) {
    throw new Error(`${context} has unknown or missing fields.`);
  }
}

function asJsonRecord(value: unknown): Record<string, MissionJsonValueV1> {
  return asRecord(value) as Record<string, MissionJsonValueV1>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Remote job ${field} is invalid.`);
  }
  return value;
}

function requiredInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`Remote job ${field} is invalid.`);
  }
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Remote job ${field} is invalid.`);
  }
  return [...value];
}

function isDomain(value: string): value is BackgroundExecutionDomainV1 {
  return ["research", "code", "linear", "github"].includes(value);
}

function isTerminalWorkerEvent(type: CompanionEventV1["type"]): boolean {
  return ["job_completed", "job_blocked", "job_cancelled", "job_failed"].includes(type);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
