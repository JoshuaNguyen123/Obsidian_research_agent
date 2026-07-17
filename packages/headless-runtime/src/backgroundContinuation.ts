import { sha256Fingerprint } from "./canonicalize";
import {
  linearIssueStateUpdateAttemptIdV1,
  parsePreparedExternalActionHandoffV1,
  type PreparedExternalActionHandoffV1,
} from "../../core-api/src/preparedExternalActionHandoffV1";
import {
  PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1,
  backgroundCodeContinuationAttemptIdV1,
  parsePreparedBackgroundCodeActionV1,
  type PreparedBackgroundCodeActionV1,
} from "../../core-api/src/preparedBackgroundCodeActionV1";
import {
  parsePreparedBackgroundCodePackageIdentityV1,
  type PreparedBackgroundCodePackageIdentityV1,
} from "../../core-api/src/preparedBackgroundCodePackageIdentityV1";
import {
  backgroundGitHubActionAttemptIdV1,
  parsePreparedBackgroundGitHubActionV1,
  type PreparedBackgroundGitHubActionV1,
} from "../../core-api/src/preparedBackgroundGitHubActionV1";
import {
  parsePreparedBackgroundGitHubPackageIdentityV1,
  type PreparedBackgroundGitHubPackageIdentityV1,
} from "../../core-api/src/preparedBackgroundGitHubPackageIdentityV1";
import type {
  MissionGraphV3,
  MissionJsonValueV1,
  MissionNodeV3,
} from "./missionGraphV3";
import { parseMissionGraphV3 } from "./missionGraphV3";

export const COMPANION_COORDINATION_PROTOCOL_VERSION = 1 as const;
export const COMPANION_MAX_REQUEST_BYTES = 1_048_576 as const;
export const COMPANION_DEFAULT_LEASE_SECONDS = 60 as const;
export const COMPANION_MAX_LEASE_SECONDS = 300 as const;

export type BackgroundExecutionDomainV1 =
  | "research"
  | "code"
  | "linear"
  | "github";

export type CompanionJobStateV1 =
  | "queued"
  | "leased"
  | "running"
  | "waiting_obsidian"
  | "verifying"
  | "blocked"
  | "complete"
  | "cancelled"
  | "failed";

export interface BackgroundAuthorizationV1 {
  version: 1;
  grantId: string;
  fingerprint: string;
  authorizedAt: string;
  expiresAt: string | null;
}

export async function buildBackgroundAuthorizationV1(input: {
  graph: MissionGraphV3;
  nodeId: string;
  grantId: string;
  authorizedAt: string;
  expiresAt: string | null;
  authorizedGraphRevision?: number;
}): Promise<BackgroundAuthorizationV1> {
  const graph = await parseMissionGraphV3(input.graph);
  const node = graph.nodes[input.nodeId];
  if (!node) {
    throw new CompanionBoundaryErrorV1(
      "invalid_authorization",
      `Mission node ${input.nodeId} does not exist.`,
    );
  }
  const draft: Omit<BackgroundAuthorizationV1, "fingerprint"> = {
    version: 1,
    grantId: input.grantId,
    authorizedAt: input.authorizedAt,
    expiresAt: input.expiresAt,
  };
  validateAuthorization({ ...draft, fingerprint: zeroFingerprint() }, new Date(0), false);
  return {
    ...draft,
    fingerprint: await backgroundAuthorizationFingerprint(
      graph,
      node,
      draft,
      input.authorizedGraphRevision,
    ),
  };
}

export interface CompanionBindingRefV1 {
  id: string;
  kind: string;
  destinationFingerprint: string;
}

/**
 * Secret-free, environment-neutral job handed to the local companion. It is a
 * projection of one already-authorized MissionGraphV3 node, never a second
 * source of authority.
 */
export interface CompanionJobV1 {
  version: typeof COMPANION_COORDINATION_PROTOCOL_VERSION;
  id: string;
  missionId: string;
  nodeId: string;
  graphRevision: number;
  domain: BackgroundExecutionDomainV1;
  executionHost: "companion" | "headless_runtime";
  state: CompanionJobStateV1;
  objective: string;
  inputs: Record<string, MissionJsonValueV1>;
  allowedTools: string[];
  requiredCapabilities: string[];
  bindings: CompanionBindingRefV1[];
  capabilityEnvelopeFingerprint: string;
  authorization: BackgroundAuthorizationV1;
  preparedExternalActionHandoff?: PreparedExternalActionHandoffV1 | null;
  preparedBackgroundCodeAction?: PreparedBackgroundCodeActionV1 | null;
  preparedBackgroundCodePackage?: PreparedBackgroundCodePackageIdentityV1 | null;
  preparedBackgroundGitHubAction?: PreparedBackgroundGitHubActionV1 | null;
  preparedBackgroundGitHubPackage?: PreparedBackgroundGitHubPackageIdentityV1 | null;
  idempotencyKey: string;
  attempts: number;
  createdAt: string;
  updatedAt: string;
}

export type CompanionEventTypeV1 =
  | "job_accepted"
  | "job_leased"
  | "job_started"
  | "job_progress"
  | "job_waiting_obsidian"
  | "job_verifying"
  | "receipt_committed"
  | "job_blocked"
  | "job_completed"
  | "job_cancelled"
  | "job_failed";

export interface CompanionEventV1 {
  version: typeof COMPANION_COORDINATION_PROTOCOL_VERSION;
  sequence: number;
  jobId: string;
  missionId: string;
  nodeId: string;
  type: CompanionEventTypeV1;
  payload: Record<string, MissionJsonValueV1>;
  occurredAt: string;
}

export interface CompanionReceiptV1 {
  version: typeof COMPANION_COORDINATION_PROTOCOL_VERSION;
  id: string;
  jobId: string;
  missionId: string;
  nodeId: string;
  provider: BackgroundExecutionDomainV1 | "companion";
  operation: string;
  status: "prepared" | "dispatched" | "verified" | "ambiguous" | "failed";
  fingerprint: string;
  payload: Record<string, MissionJsonValueV1>;
  committedAt: string;
}

export async function buildCompanionReceiptV1(input: {
  job: Pick<
    CompanionJobV1,
    | "id"
    | "missionId"
    | "nodeId"
    | "idempotencyKey"
    | "capabilityEnvelopeFingerprint"
    | "authorization"
  >;
  id: string;
  provider: CompanionReceiptV1["provider"];
  operation: string;
  status: CompanionReceiptV1["status"];
  payload: Record<string, MissionJsonValueV1>;
  committedAt: string;
}): Promise<CompanionReceiptV1> {
  const payload = sanitizeCompanionPersistenceValueV1(
    input.payload,
  ) as Record<string, MissionJsonValueV1>;
  assertNoVaultPayload(payload);
  const fingerprint = await companionReceiptFingerprintV1({
    job: input.job,
    provider: input.provider,
    operation: input.operation,
    status: input.status,
    payload,
  });
  return {
    version: COMPANION_COORDINATION_PROTOCOL_VERSION,
    id: input.id,
    jobId: input.job.id,
    missionId: input.job.missionId,
    nodeId: input.job.nodeId,
    provider: input.provider,
    operation: input.operation,
    status: input.status,
    fingerprint,
    payload,
    committedAt: input.committedAt,
  };
}

export async function companionReceiptFingerprintV1(input: {
  job: Pick<
    CompanionJobV1,
    | "id"
    | "missionId"
    | "nodeId"
    | "idempotencyKey"
    | "capabilityEnvelopeFingerprint"
    | "authorization"
  >;
  provider: CompanionReceiptV1["provider"];
  operation: string;
  status: CompanionReceiptV1["status"];
  payload: Record<string, MissionJsonValueV1>;
}): Promise<string> {
  return sha256Fingerprint({
    version: 1,
    job: {
      id: input.job.id,
      missionId: input.job.missionId,
      nodeId: input.job.nodeId,
      idempotencyKey: input.job.idempotencyKey,
      capabilityEnvelopeFingerprint: input.job.capabilityEnvelopeFingerprint,
      authorizationFingerprint: input.job.authorization.fingerprint,
    },
    provider: input.provider,
    operation: input.operation,
    status: input.status,
    payload: input.payload,
  });
}

export interface CompanionLeaseV1 {
  version: typeof COMPANION_COORDINATION_PROTOCOL_VERSION;
  jobId: string;
  coordinatorId: string;
  /** Opaque lease reference. The bearer lease token is never represented here. */
  leaseId: string;
  expiresAt: string;
}

export interface BootstrapTokenDescriptionV1 {
  source: "session_memory" | "secure_store_lease" | "service_bootstrap";
  persistent: boolean;
  expiresAt: string | null;
}

/**
 * A closure-backed credential capability. There is intentionally no getter,
 * JSON form, or string conversion that can expose the bearer token.
 */
export interface BootstrapTokenLeaseV1 {
  readonly description: BootstrapTokenDescriptionV1;
  readonly disposed: boolean;
  withToken<TResult>(use: (token: string) => Promise<TResult>): Promise<TResult>;
  dispose(): void;
  toJSON(): { redacted: true; description: BootstrapTokenDescriptionV1 };
}

export function createSessionBootstrapTokenLeaseV1(
  token: string,
  input: {
    source?: BootstrapTokenDescriptionV1["source"];
    persistent?: boolean;
    expiresAt?: string | null;
  } = {},
): BootstrapTokenLeaseV1 {
  assertBootstrapToken(token);
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt !== null) {
    assertIsoTimestamp(expiresAt, "expiresAt");
  }
  const description = Object.freeze({
    source: input.source ?? "session_memory",
    persistent: input.persistent === true,
    expiresAt,
  });
  let secret: string | null = token;

  return Object.freeze({
    description,
    get disposed() {
      return secret === null;
    },
    async withToken<TResult>(
      use: (value: string) => Promise<TResult>,
    ): Promise<TResult> {
      if (secret === null) {
        throw new CompanionBoundaryErrorV1(
          "credential_unavailable",
          "The companion bootstrap credential is unavailable.",
        );
      }
      if (expiresAt !== null && Date.parse(expiresAt) <= Date.now()) {
        throw new CompanionBoundaryErrorV1(
          "credential_expired",
          "The companion bootstrap credential has expired.",
        );
      }
      return use(secret);
    },
    dispose() {
      secret = null;
    },
    toJSON() {
      return { redacted: true as const, description };
    },
  });
}

export function generateBootstrapTokenV1(): string {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new CompanionBoundaryErrorV1(
      "secure_random_unavailable",
      "A cryptographically secure random source is required.",
    );
  }
  const bytes = new Uint8Array(32);
  cryptoApi.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export type BackgroundNodeClassificationV1 =
  | {
      disposition: "background";
      domain: BackgroundExecutionDomainV1;
      reason: string;
    }
  | {
      disposition: "waiting_obsidian";
      reason: string;
    }
  | {
      disposition: "blocked";
      code: string;
      reason: string;
    };

/**
 * The host decides whether a graph node can leave Obsidian. Any vault-shaped
 * capability, tool, input binding, destination, or lock fails closed into
 * waiting_obsidian. External content cannot change this classification.
 */
export function classifyBackgroundMissionNodeV1(
  graph: MissionGraphV3,
  nodeId: string,
): BackgroundNodeClassificationV1 {
  const node = graph.nodes[nodeId];
  if (!node) {
    return {
      disposition: "blocked",
      code: "unknown_node",
      reason: `Mission node ${nodeId} does not exist.`,
    };
  }
  if (node.status === "complete" || node.status === "cancelled") {
    return {
      disposition: "blocked",
      code: "terminal_node",
      reason: `Mission node ${nodeId} is already ${node.status}.`,
    };
  }
  if (node.executionHost === "obsidian_core" || nodeTouchesVault(graph, node)) {
    return {
      disposition: "waiting_obsidian",
      reason:
        "Vault-bound work must wait for the connected Obsidian core and execute through the Obsidian API.",
    };
  }
  if (node.executionHost !== "companion" && node.executionHost !== "headless_runtime") {
    return {
      disposition: "blocked",
      code: "unsupported_execution_host",
      reason: `Execution host ${node.executionHost} is not available to the companion.`,
    };
  }

  const domain = inferBackgroundDomain(graph, node);
  if (!domain) {
    return {
      disposition: "blocked",
      code: "unclassified_background_domain",
      reason: "The host could not classify this node as research, code, Linear, or GitHub work.",
    };
  }
  return {
    disposition: "background",
    domain,
    reason: `Already-authorized ${domain} work may continue through the local companion.`,
  };
}

export type PrepareCompanionJobResultV1 =
  | { status: "ready"; job: CompanionJobV1 }
  | { status: "waiting_obsidian"; nodeId: string; reason: string }
  | { status: "blocked"; nodeId: string; code: string; reason: string };

/** Deterministic pre-package identity used by the foreground Code extension to
 * persist a package whose closed body is itself bound to the final job id. */
export async function prepareBackgroundCodeCompanionJobIdentityV1(input: {
  graph: MissionGraphV3;
  nodeId: string;
  authorization: BackgroundAuthorizationV1;
  preparedBackgroundCodeAction: PreparedBackgroundCodeActionV1;
  now?: Date;
}): Promise<{ id: string; idempotencyKey: string }> {
  const graph = await parseMissionGraphV3(input.graph);
  const node = graph.nodes[input.nodeId];
  const now = input.now ?? new Date();
  const action = parsePreparedBackgroundCodeActionV1(
    input.preparedBackgroundCodeAction,
  );
  validateAuthorization(input.authorization, now);
  if (
    !node ||
    inferBackgroundDomain(graph, node) !== "code" ||
    node.effect !== "execution"
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Prepared background Code identity requires one executable Code mission node.",
    );
  }
  const expectedAuthorization = await backgroundAuthorizationFingerprint(
    graph,
    node,
    input.authorization,
  );
  if (input.authorization.fingerprint !== expectedAuthorization) {
    throw new CompanionBoundaryErrorV1(
      "invalid_authorization",
      "Background Code authorization does not match the exact mission node.",
    );
  }
  assertPreparedBackgroundCodeActionScope(graph, node, action, now);
  const idempotencyKey = await sha256Fingerprint({
    version: COMPANION_COORDINATION_PROTOCOL_VERSION,
    missionId: graph.missionId,
    nodeId: node.id,
    graphRevision: graph.revision,
    capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
    authorizationFingerprint: input.authorization.fingerprint,
    preparedBackgroundCodeActionFingerprint: action.fingerprint,
  });
  return {
    id: `companion-${idempotencyKey.slice("sha256:".length, "sha256:".length + 32)}`,
    idempotencyKey,
  };
}

export async function prepareBackgroundGitHubCompanionJobIdentityV1(input: {
  graph: MissionGraphV3;
  nodeId: string;
  authorization: BackgroundAuthorizationV1;
  preparedBackgroundGitHubAction: PreparedBackgroundGitHubActionV1;
  now?: Date;
}): Promise<{ id: string; idempotencyKey: string }> {
  const graph = await parseMissionGraphV3(input.graph);
  const node = graph.nodes[input.nodeId];
  const now = input.now ?? new Date();
  const action = parsePreparedBackgroundGitHubActionV1(input.preparedBackgroundGitHubAction);
  validateAuthorization(input.authorization, now);
  if (!node || inferBackgroundDomain(graph, node) !== "github" || node.effect !== "external_action") {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Prepared background GitHub identity requires one external-action GitHub mission node.",
    );
  }
  const expectedAuthorization = await backgroundAuthorizationFingerprint(graph, node, input.authorization);
  if (input.authorization.fingerprint !== expectedAuthorization) {
    throw new CompanionBoundaryErrorV1("invalid_authorization", "Background GitHub authorization does not match the exact mission node.");
  }
  assertPreparedBackgroundGitHubActionScope(graph, node, action, now);
  const idempotencyKey = await sha256Fingerprint({
    version: 1,
    missionId: graph.missionId,
    nodeId: node.id,
    graphRevision: graph.revision,
    capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
    authorizationFingerprint: input.authorization.fingerprint,
    preparedBackgroundGitHubActionFingerprint: action.fingerprint,
  });
  return {
    id: `companion-${idempotencyKey.slice("sha256:".length, "sha256:".length + 32)}`,
    idempotencyKey,
  };
}

export async function prepareCompanionJobV1(input: {
  graph: MissionGraphV3;
  nodeId: string;
  authorization: BackgroundAuthorizationV1;
  preparedExternalActionHandoff?: PreparedExternalActionHandoffV1 | null;
  preparedBackgroundCodeAction?: PreparedBackgroundCodeActionV1 | null;
  preparedBackgroundCodePackage?: PreparedBackgroundCodePackageIdentityV1 | null;
  preparedBackgroundGitHubAction?: PreparedBackgroundGitHubActionV1 | null;
  preparedBackgroundGitHubPackage?: PreparedBackgroundGitHubPackageIdentityV1 | null;
  now?: Date;
}): Promise<PrepareCompanionJobResultV1> {
  // Parsing recomputes the host capability-envelope fingerprint. A caller
  // cannot dispatch a node from a mutated or merely type-cast graph object.
  const graph = await parseMissionGraphV3(input.graph);
  const classification = classifyBackgroundMissionNodeV1(graph, input.nodeId);
  if (classification.disposition === "waiting_obsidian") {
    return {
      status: "waiting_obsidian",
      nodeId: input.nodeId,
      reason: classification.reason,
    };
  }
  if (classification.disposition === "blocked") {
    return {
      status: "blocked",
      nodeId: input.nodeId,
      code: classification.code,
      reason: classification.reason,
    };
  }

  const now = input.now ?? new Date();
  const node = graph.nodes[input.nodeId];
  const preparedExternalActionHandoff = input.preparedExternalActionHandoff
    ? parsePreparedExternalActionHandoffV1(input.preparedExternalActionHandoff)
    : null;
  const preparedBackgroundCodeAction = input.preparedBackgroundCodeAction
    ? parsePreparedBackgroundCodeActionV1(input.preparedBackgroundCodeAction)
    : null;
  const preparedBackgroundCodePackage = input.preparedBackgroundCodePackage
    ? parsePreparedBackgroundCodePackageIdentityV1(input.preparedBackgroundCodePackage)
    : null;
  const preparedBackgroundGitHubAction = input.preparedBackgroundGitHubAction
    ? parsePreparedBackgroundGitHubActionV1(input.preparedBackgroundGitHubAction)
    : null;
  const preparedBackgroundGitHubPackage = input.preparedBackgroundGitHubPackage
    ? parsePreparedBackgroundGitHubPackageIdentityV1(input.preparedBackgroundGitHubPackage)
    : null;
  const preparedFamilies = [
    Boolean(preparedExternalActionHandoff),
    Boolean(preparedBackgroundCodeAction || preparedBackgroundCodePackage),
    Boolean(preparedBackgroundGitHubAction || preparedBackgroundGitHubPackage),
  ].filter(Boolean).length;
  if (
    preparedFamilies > 1
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Linear, Code, and GitHub prepared-action contracts cannot share one companion job.",
    );
  }
  if (node.effect === "read" && preparedFamilies > 0) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Read-only companion work cannot carry an effectful action handoff.",
    );
  }
  if (node.effect !== "read") {
    if (preparedBackgroundCodeAction || preparedBackgroundCodePackage) {
      assertPreparedBackgroundCodeScope(
        graph,
        node,
        preparedBackgroundCodeAction,
        preparedBackgroundCodePackage,
        now,
      );
    } else if (preparedBackgroundGitHubAction || preparedBackgroundGitHubPackage) {
      assertPreparedBackgroundGitHubScope(
        graph,
        node,
        preparedBackgroundGitHubAction,
        preparedBackgroundGitHubPackage,
        now,
      );
      if (
        preparedBackgroundGitHubPackage?.backgroundAuthorizationFingerprint !==
        input.authorization.fingerprint
      ) {
        throw new CompanionBoundaryErrorV1(
          "invalid_authorization",
          "Background GitHub package identity is bound to a different companion authorization.",
        );
      }
    } else {
      assertPreparedExternalActionScope(
        graph,
        node,
        preparedExternalActionHandoff,
        now,
      );
    }
  }
  const timestamp = now.toISOString();
  validateAuthorization(input.authorization, now);
  const expectedAuthorization = await backgroundAuthorizationFingerprint(
    graph,
    node,
    input.authorization,
  );
  if (input.authorization.fingerprint !== expectedAuthorization) {
    throw new CompanionBoundaryErrorV1(
      "invalid_authorization",
      "Background authorization does not match the exact mission node authority scope.",
    );
  }
  const bindingIds = collectNodeBindingIds(node);
  const bindings = bindingIds.map((bindingId) => {
    const binding = graph.capabilityEnvelope.bindings[bindingId];
    if (!binding) {
      throw new CompanionBoundaryErrorV1(
        "unknown_binding",
        `Mission binding ${bindingId} is not present in the host envelope.`,
      );
    }
    return {
      id: binding.id,
      kind: binding.kind,
      destinationFingerprint: binding.destinationFingerprint,
    };
  });
  const inputs = preparedFamilies > 0
    ? {}
    : projectLiteralInputs(node);
  assertNoVaultPayload({ inputs, bindings });

  const identity = {
    version: COMPANION_COORDINATION_PROTOCOL_VERSION,
    missionId: graph.missionId,
    nodeId: node.id,
    graphRevision: graph.revision,
    capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
    authorizationFingerprint: input.authorization.fingerprint,
    ...(preparedExternalActionHandoff
      ? {
          preparedExternalActionHandoffFingerprint:
            preparedExternalActionHandoff.fingerprint,
        }
      : {}),
    ...(preparedBackgroundCodeAction && preparedBackgroundCodePackage
      ? {
          preparedBackgroundCodeActionFingerprint:
            preparedBackgroundCodeAction.fingerprint,
        }
      : {}),
    ...(preparedBackgroundGitHubAction && preparedBackgroundGitHubPackage
      ? {
          preparedBackgroundGitHubActionFingerprint:
            preparedBackgroundGitHubAction.fingerprint,
        }
      : {}),
  };
  const identityFingerprint = await sha256Fingerprint(identity);
  const id = `companion-${identityFingerprint.slice("sha256:".length, "sha256:".length + 32)}`;

  return {
    status: "ready",
    job: {
      version: COMPANION_COORDINATION_PROTOCOL_VERSION,
      id,
      missionId: graph.missionId,
      nodeId: node.id,
      graphRevision: graph.revision,
      domain: classification.domain,
      executionHost:
        node.executionHost === "companion" ? "companion" : "headless_runtime",
      state: "queued",
      objective: node.objective,
      inputs,
      allowedTools: [...node.allowedTools],
      requiredCapabilities: [...node.requiredCapabilities],
      bindings,
      capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
      authorization: { ...input.authorization },
      preparedExternalActionHandoff,
      preparedBackgroundCodeAction,
      preparedBackgroundCodePackage,
      preparedBackgroundGitHubAction,
      preparedBackgroundGitHubPackage,
      idempotencyKey: identityFingerprint,
      attempts: node.retries.attempts,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  };
}

export interface HeadlessWorkerResultV1 {
  status:
    | "complete"
    | "blocked"
    | "cancelled"
    | "failed"
    | "reconcile_required";
  outputs?: Record<string, MissionJsonValueV1>;
  evidence?: MissionJsonValueV1[];
  receipts?: CompanionReceiptV1[];
  blocker?: { code: string; message: string; requiredAction: string | null };
}

export interface HeadlessWorkerContextV1 {
  signal: AbortSignal;
  now(): Date;
  reportProgress(message: string): Promise<void>;
  listCommittedReceipts?(): Promise<CompanionReceiptV1[]>;
  commitReceipt?(receipt: CompanionReceiptV1): Promise<CompanionReceiptV1>;
}

export type HeadlessDomainExecutorV1 = (
  job: Readonly<CompanionJobV1>,
  context: HeadlessWorkerContextV1,
) => Promise<HeadlessWorkerResultV1>;

export interface HeadlessMissionWorkerOptionsV1 {
  executors: Partial<Record<BackgroundExecutionDomainV1, HeadlessDomainExecutorV1>>;
  emit(event: CompanionEventV1): Promise<void>;
  receiptJournal?: {
    list(job: CompanionJobV1): Promise<CompanionReceiptV1[]>;
    commit(
      job: CompanionJobV1,
      receipt: CompanionReceiptV1,
    ): Promise<CompanionReceiptV1>;
  };
  now?: () => Date;
  initialSequence?: number;
}

/**
 * Shared worker used by foreground tests and the companion service host. It
 * dispatches only pre-authorized, non-vault jobs and emits replayable events.
 */
export class HeadlessMissionWorkerV1 {
  private sequence: number;
  private readonly now: () => Date;

  constructor(private readonly options: HeadlessMissionWorkerOptionsV1) {
    this.sequence = Math.max(0, Math.floor(options.initialSequence ?? 0));
    this.now = options.now ?? (() => new Date());
  }

  async execute(job: CompanionJobV1, signal = new AbortController().signal): Promise<HeadlessWorkerResultV1> {
    const validationNow = this.now();
    // First establish the complete structural and fingerprint boundary without
    // allowing an expired grant to authorize work. Only a previously committed
    // dispatch marker can narrow an expired effectful job to readback-only.
    validateCompanionJob(job, validationNow, false);
    const committedBeforeStart = job.preparedExternalActionHandoff ||
        job.preparedBackgroundCodeAction || job.preparedBackgroundGitHubAction
      ? await this.options.receiptJournal?.list(job) ?? []
      : [];
    validateCompanionJob(
      job,
      validationNow,
      !hasDurablePreparedActionDispatchMarker(job, committedBeforeStart),
    );
    if (signal.aborted) {
      const result: HeadlessWorkerResultV1 = { status: "cancelled" };
      await this.emit(job, "job_cancelled", { reason: "aborted_before_start" });
      return result;
    }
    const executor = this.options.executors[job.domain];
    if (!executor) {
      const result: HeadlessWorkerResultV1 = {
        status: "blocked",
        blocker: {
          code: "executor_unavailable",
          message: `No ${job.domain} executor is installed.`,
          requiredAction: "Enable the extension that owns this execution domain.",
        },
      };
      await this.emit(job, "job_blocked", {
        code: "executor_unavailable",
        message: result.blocker!.message,
      });
      return result;
    }

    await this.emit(job, "job_started", { domain: job.domain });
    const context: HeadlessWorkerContextV1 = {
      signal,
      now: this.now,
      reportProgress: async (message) => {
        await this.emit(job, "job_progress", { message: boundedText(message, 4_096) });
      },
      listCommittedReceipts: async () =>
        this.options.receiptJournal?.list(job) ?? [],
      commitReceipt: async (receipt) => {
        if (!this.options.receiptJournal) {
          throw new CompanionBoundaryErrorV1(
            "receipt_journal_unavailable",
            "Effectful background work requires the durable companion receipt journal.",
          );
        }
        return this.options.receiptJournal.commit(job, receipt);
      },
    };
    try {
      const result = await sanitizeWorkerResult(
        job,
        await executor(Object.freeze({ ...job }), context),
      );
      validateWorkerResult(job, result);
      const eventType: CompanionEventTypeV1 =
        result.status === "complete"
          ? "job_completed"
          : result.status === "cancelled"
            ? "job_cancelled"
            : result.status === "blocked" || result.status === "reconcile_required"
              ? "job_blocked"
              : "job_failed";
      await this.emit(job, eventType, {
        status: result.status,
        blockerCode: result.blocker?.code ?? null,
      });
      return result;
    } catch (error) {
      const message = sanitizeErrorMessage(error);
      const committedReceipts = await context
        .listCommittedReceipts?.()
        .catch(() => []);
      const dispatchedWithoutReadback = Boolean(
        (job.preparedExternalActionHandoff || job.preparedBackgroundCodeAction ||
          job.preparedBackgroundGitHubAction) &&
          (committedReceipts ?? []).some(
            (receipt) =>
              (receipt.provider === "linear" &&
                (receipt.status === "dispatched" || receipt.status === "ambiguous")) ||
              (receipt.provider === "code" && receipt.status === "ambiguous") ||
              (receipt.provider === "github" &&
                (receipt.status === "dispatched" || receipt.status === "ambiguous")),
          ) &&
          !(committedReceipts ?? []).some(
            (receipt) =>
              (receipt.provider === "linear" || receipt.provider === "code" ||
                receipt.provider === "github") &&
              receipt.status === "verified",
          ),
      );
      if (dispatchedWithoutReadback) {
        await this.emit(job, "job_blocked", {
          code: "provider_reconcile_required",
          message:
            "A prepared external or Code effect may have applied; the next lease may perform readback only.",
        });
        return {
          status: "reconcile_required",
          blocker: {
            code: "provider_reconcile_required",
            message:
              "A prepared effect may have applied; independent readback is required before completion.",
            requiredAction: null,
          },
        };
      }
      await this.emit(job, "job_failed", { code: "executor_failed", message });
      return {
        status: "failed",
        blocker: {
          code: "executor_failed",
          message,
          requiredAction: null,
        },
      };
    }
  }

  private async emit(
    job: CompanionJobV1,
    type: CompanionEventTypeV1,
    payload: Record<string, MissionJsonValueV1>,
  ): Promise<void> {
    this.sequence += 1;
    await this.options.emit({
      version: COMPANION_COORDINATION_PROTOCOL_VERSION,
      sequence: this.sequence,
      jobId: job.id,
      missionId: job.missionId,
      nodeId: job.nodeId,
      type,
      payload: sanitizeCompanionPersistenceValueV1(payload) as Record<
        string,
        MissionJsonValueV1
      >,
      occurredAt: this.now().toISOString(),
    });
  }
}

/** Single serializer boundary for every value persisted by the companion. */
export function sanitizeCompanionPersistenceValueV1(
  value: unknown,
): MissionJsonValueV1 {
  const seen = new Set<object>();
  let entries = 0;
  const walk = (candidate: unknown, key: string | null, depth: number): MissionJsonValueV1 => {
    if (depth > 16 || entries > 10_000) return "[TRUNCATED]";
    entries += 1;
    if (candidate === null || candidate === undefined) return null;
    if (typeof candidate === "boolean") return candidate;
    if (typeof candidate === "number") return Number.isFinite(candidate) ? candidate : null;
    if (typeof candidate === "string") {
      if (
        key &&
        isOpaqueSecretReferenceKey(key) &&
        /^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/.test(candidate)
      ) {
        return candidate;
      }
      if (key && isSecretBearingKey(key)) return "[REDACTED]";
      return redactSecretText(candidate).slice(0, 250_000);
    }
    if (typeof candidate !== "object") return String(candidate).slice(0, 4_096);
    if (seen.has(candidate as object)) return "[CIRCULAR]";
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      const result = candidate.slice(0, 10_000).map((item) => walk(item, key, depth + 1));
      seen.delete(candidate);
      return result;
    }
    const result: Record<string, MissionJsonValueV1> = {};
    for (const [nestedKey, nested] of Object.entries(candidate as Record<string, unknown>)) {
      result[nestedKey] =
        isSecretBearingKey(nestedKey) && !isOpaqueSecretReferenceKey(nestedKey)
          ? "[REDACTED]"
          : walk(nested, nestedKey, depth + 1);
    }
    seen.delete(candidate as object);
    return result;
  };
  return walk(value, null, 0);
}

async function sanitizeWorkerResult(
  job: CompanionJobV1,
  result: HeadlessWorkerResultV1,
): Promise<HeadlessWorkerResultV1> {
  const receipts: CompanionReceiptV1[] = [];
  for (const receipt of result.receipts ?? []) {
    receipts.push(
      await buildCompanionReceiptV1({
        job,
        id: receipt.id,
        provider: receipt.provider,
        operation: redactSecretText(receipt.operation).slice(0, 256),
        status: receipt.status,
        payload: sanitizeCompanionPersistenceValueV1(receipt.payload) as Record<
          string,
          MissionJsonValueV1
        >,
        committedAt: receipt.committedAt,
      }),
    );
  }
  return {
    status: result.status,
    outputs: sanitizeCompanionPersistenceValueV1(result.outputs ?? {}) as Record<
      string,
      MissionJsonValueV1
    >,
    evidence: sanitizeCompanionPersistenceValueV1(result.evidence ?? []) as MissionJsonValueV1[],
    receipts,
    blocker: result.blocker
      ? {
          code: redactSecretText(result.blocker.code).slice(0, 256),
          message: redactSecretText(result.blocker.message).slice(0, 4_096),
          requiredAction: result.blocker.requiredAction
            ? redactSecretText(result.blocker.requiredAction).slice(0, 4_096)
            : null,
        }
      : undefined,
  };
}

function isSecretBearingKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(token|secret|password|passwd|apikey|authorization|cookie|privatekey|clientsecret)/.test(
    normalized,
  );
}

function isOpaqueSecretReferenceKey(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return (
    normalized === "secretref" ||
    normalized === "credentialref" ||
    normalized === "secretreferenceid" ||
    normalized === "credentialreferenceid"
  );
}

function redactSecretText(value: string): string {
  return value
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\bghp_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_KEY]")
    .replace(/\blin_api_[A-Za-z0-9_-]{12,}\b/g, "[REDACTED_LINEAR_TOKEN]")
    .replace(/(token|secret|password|passwd|api[_-]?key)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]");
}

export class CompanionBoundaryErrorV1 extends Error {
  constructor(
    readonly code:
      | "credential_unavailable"
      | "credential_expired"
      | "secure_random_unavailable"
      | "invalid_authorization"
      | "authorization_expired"
      | "unknown_binding"
      | "vault_boundary_violation"
      | "invalid_job"
      | "invalid_receipt"
      | "receipt_journal_unavailable",
    message: string,
  ) {
    super(message);
    this.name = "CompanionBoundaryErrorV1";
  }
}

function nodeTouchesVault(graph: MissionGraphV3, node: MissionNodeV3): boolean {
  if (
    node.requiredCapabilities.some(isVaultMarker) ||
    node.allowedTools.some(isVaultMarker) ||
    containsVaultPayload(node.inputs)
  ) {
    return true;
  }
  return collectNodeBindingIds(node).some((bindingId) => {
    const binding = graph.capabilityEnvelope.bindings[bindingId];
    return !binding || isVaultMarker(binding.kind) || isVaultMarker(binding.id);
  });
}

function inferBackgroundDomain(
  graph: MissionGraphV3,
  node: MissionNodeV3,
): BackgroundExecutionDomainV1 | null {
  const markers = [
    node.executorId,
    ...node.requiredCapabilities,
    ...node.allowedTools,
    ...collectNodeBindingIds(node).flatMap((bindingId) => {
      const binding = graph.capabilityEnvelope.bindings[bindingId];
      return binding ? [binding.id, binding.kind] : [];
    }),
  ].map((value) => value.toLowerCase());
  if (markers.some((value) => /(^|[._:-])linear([._:-]|$)/.test(value))) return "linear";
  if (markers.some((value) => /(^|[._:-])github([._:-]|$)/.test(value))) return "github";
  if (
    markers.some((value) =>
      /(^|[._:-])(code|workspace|repository|repo|git)([._:-]|$)/.test(value),
    )
  ) {
    return "code";
  }
  if (
    node.effect === "read" ||
    markers.some((value) => /(^|[._:-])(research|web|source)([._:-]|$)/.test(value))
  ) {
    return "research";
  }
  return null;
}

function collectNodeBindingIds(node: MissionNodeV3): string[] {
  const ids = new Set<string>();
  for (const input of Object.values(node.inputs)) {
    if (input.kind === "binding") ids.add(input.bindingId);
  }
  if (node.destination) ids.add(node.destination.bindingId);
  for (const lock of node.resourceLocks) ids.add(lock.bindingId);
  return [...ids].sort();
}

function projectLiteralInputs(node: MissionNodeV3): Record<string, MissionJsonValueV1> {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([key, input]) => [
      key,
      input.kind === "literal"
        ? input.value
        : { bindingId: input.bindingId, selector: input.selector },
    ]),
  );
}

function validateAuthorization(
  authorization: BackgroundAuthorizationV1 | null | undefined,
  now: Date,
  enforceExpiry = true,
): void {
  if (
    !authorization ||
    authorization.version !== 1 ||
    !authorization.grantId.trim() ||
    !isFingerprint(authorization.fingerprint)
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_authorization",
      "Background continuation requires an exact host authorization fingerprint.",
    );
  }
  assertIsoTimestamp(authorization.authorizedAt, "authorizedAt");
  if (authorization.expiresAt !== null) {
    assertIsoTimestamp(authorization.expiresAt, "expiresAt");
    if (enforceExpiry && Date.parse(authorization.expiresAt) <= now.getTime()) {
      throw new CompanionBoundaryErrorV1(
        "authorization_expired",
        "The background authorization has expired.",
      );
    }
  }
}

async function backgroundAuthorizationFingerprint(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  authorization: Omit<BackgroundAuthorizationV1, "fingerprint">,
  authorizedGraphRevision = graph.revision,
): Promise<string> {
  const bindingIds = collectNodeBindingIds(node);
  return sha256Fingerprint({
    version: 1,
    grantId: authorization.grantId,
    authorizedAt: authorization.authorizedAt,
    expiresAt: authorization.expiresAt,
    missionId: graph.missionId,
    nodeId: node.id,
    graphRevision: authorizedGraphRevision,
    capabilityEnvelopeFingerprint: graph.capabilityEnvelope.fingerprint,
    executorId: node.executorId,
    objective: node.objective,
    executionHost: node.executionHost,
    effect: node.effect,
    inputs: node.inputs,
    outputs: node.outputs,
    allowedTools: [...node.allowedTools].sort(),
    requiredCapabilities: [...node.requiredCapabilities].sort(),
    bindings: bindingIds.map((bindingId) => graph.capabilityEnvelope.bindings[bindingId]),
    destination: node.destination,
    resourceLocks: [...node.resourceLocks].sort((left, right) =>
      left.bindingId.localeCompare(right.bindingId),
    ),
    budget: node.budget,
    completionContract: node.completionContract,
    verifierId: node.completionContract.verifierId,
  });
}

function zeroFingerprint(): string {
  return `sha256:${"0".repeat(64)}`;
}

function validateCompanionJob(
  job: CompanionJobV1,
  now: Date,
  enforceExpiry = true,
): void {
  if (
    job.version !== COMPANION_COORDINATION_PROTOCOL_VERSION ||
    !job.id ||
    !job.missionId ||
    !job.nodeId ||
    !["companion", "headless_runtime"].includes(job.executionHost) ||
    !["research", "code", "linear", "github"].includes(job.domain)
  ) {
    throw new CompanionBoundaryErrorV1("invalid_job", "Invalid companion job contract.");
  }
  validateAuthorization(job.authorization, now, enforceExpiry);
  if (!isFingerprint(job.capabilityEnvelopeFingerprint) || !isFingerprint(job.idempotencyKey)) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "The companion job is missing canonical host fingerprints.",
    );
  }
  if (job.preparedExternalActionHandoff) {
    const handoff = parsePreparedExternalActionHandoffV1(
      job.preparedExternalActionHandoff,
    );
    if (
      job.domain !== "linear" ||
      handoff.missionId !== job.missionId ||
      handoff.nodeId !== job.nodeId ||
      handoff.graphRevision !== job.graphRevision ||
      handoff.capabilityEnvelopeFingerprint !==
        job.capabilityEnvelopeFingerprint ||
      (enforceExpiry && Date.parse(handoff.expiresAt) <= now.getTime())
    ) {
      throw new CompanionBoundaryErrorV1(
        "invalid_job",
        "Prepared external action handoff drifted from the companion job.",
      );
    }
  }
  if (
    [
      Boolean(job.preparedExternalActionHandoff),
      Boolean(job.preparedBackgroundCodeAction || job.preparedBackgroundCodePackage),
      Boolean(job.preparedBackgroundGitHubAction || job.preparedBackgroundGitHubPackage),
    ].filter(Boolean).length > 1
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "A companion job cannot mix Linear, Code, and GitHub prepared-action contracts.",
    );
  }
  if (job.preparedBackgroundCodeAction || job.preparedBackgroundCodePackage) {
    const handoff = job.preparedBackgroundCodeAction
      ? parsePreparedBackgroundCodeActionV1(job.preparedBackgroundCodeAction)
      : null;
    const packageIdentity = job.preparedBackgroundCodePackage
      ? parsePreparedBackgroundCodePackageIdentityV1(job.preparedBackgroundCodePackage)
      : null;
    if (
      !handoff ||
      !packageIdentity ||
      job.domain !== "code" ||
      handoff.missionId !== job.missionId ||
      handoff.nodeId !== job.nodeId ||
      handoff.graphRevision !== job.graphRevision ||
      handoff.capabilityEnvelopeFingerprint !== job.capabilityEnvelopeFingerprint ||
      packageIdentity.handoffFingerprint !== handoff.fingerprint ||
      packageIdentity.workspaceId !== handoff.binding.workspaceId ||
      packageIdentity.workspaceBindingFingerprint !== handoff.payload.workspaceBindingFingerprint ||
      packageIdentity.repositoryProfileKey !== handoff.binding.repositoryProfileKey ||
      packageIdentity.repositoryProfileFingerprint !== handoff.payload.repositoryProfileFingerprint ||
      packageIdentity.consumedActionAuthorityFingerprint !== handoff.authority.authorityFingerprint ||
      packageIdentity.backgroundAuthorizationFingerprint !== job.authorization.fingerprint ||
      (enforceExpiry &&
        (Date.parse(handoff.expiresAt) <= now.getTime() ||
          Date.parse(packageIdentity.expiresAt) <= now.getTime()))
    ) {
      throw new CompanionBoundaryErrorV1(
        "invalid_job",
        "Prepared background Code action or package identity drifted from the companion job.",
      );
    }
  }
  if (job.preparedBackgroundGitHubAction || job.preparedBackgroundGitHubPackage) {
    const action = job.preparedBackgroundGitHubAction
      ? parsePreparedBackgroundGitHubActionV1(job.preparedBackgroundGitHubAction)
      : null;
    const packageIdentity = job.preparedBackgroundGitHubPackage
      ? parsePreparedBackgroundGitHubPackageIdentityV1(job.preparedBackgroundGitHubPackage)
      : null;
    if (
      !action ||
      !packageIdentity ||
      job.domain !== "github" ||
      action.missionId !== job.missionId ||
      action.nodeId !== job.nodeId ||
      action.graphRevision !== job.graphRevision ||
      action.capabilityEnvelopeFingerprint !== job.capabilityEnvelopeFingerprint ||
      packageIdentity.actionFingerprint !== action.fingerprint ||
      packageIdentity.preparedActionFingerprint !== action.preparedActionFingerprint ||
      packageIdentity.operation !== action.operation ||
      packageIdentity.publicationId !== action.payload.publicationId ||
      packageIdentity.repositoryBindingFingerprint !== action.binding.repositoryBindingFingerprint ||
      packageIdentity.repositoryProfileFingerprint !== action.binding.repositoryProfileFingerprint ||
      packageIdentity.verifiedAccountId !== action.binding.verifiedAccountId ||
      packageIdentity.backgroundAuthorizationFingerprint !== job.authorization.fingerprint ||
      (enforceExpiry &&
        (Date.parse(action.expiresAt) <= now.getTime() ||
          Date.parse(packageIdentity.expiresAt) <= now.getTime()))
    ) {
      throw new CompanionBoundaryErrorV1(
        "invalid_job",
        "Prepared background GitHub action or package identity drifted from the companion job.",
      );
    }
  }
  assertNoVaultPayload(job);
}

function hasDurablePreparedActionDispatchMarker(
  job: CompanionJobV1,
  receipts: CompanionReceiptV1[],
): boolean {
  const handoff = job.preparedExternalActionHandoff;
  if (handoff) {
    const attemptId = linearIssueStateUpdateAttemptIdV1(job.id, handoff);
    return receipts.some(
      (receipt) =>
        receipt.provider === "linear" &&
        receipt.operation === "linear_issue_state_update_v1" &&
        (receipt.status === "dispatched" || receipt.status === "ambiguous") &&
        receipt.payload.attemptId === attemptId &&
        receipt.payload.handoffFingerprint === handoff.fingerprint,
    );
  }
  const code = job.preparedBackgroundCodeAction;
  if (code) {
    const attemptId = backgroundCodeContinuationAttemptIdV1(job.id, code);
    return receipts.some(
      (receipt) =>
        receipt.provider === "code" &&
        receipt.operation === PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 &&
        receipt.status === "ambiguous" &&
        receipt.payload.attemptId === attemptId &&
        receipt.payload.handoffFingerprint === code.fingerprint,
    );
  }
  const github = job.preparedBackgroundGitHubAction;
  if (!github) return false;
  const attemptId = backgroundGitHubActionAttemptIdV1(job.id, github);
  return receipts.some(
    (receipt) =>
      receipt.provider === "github" &&
      receipt.operation === github.operation &&
      (receipt.status === "dispatched" || receipt.status === "ambiguous") &&
      receipt.payload.attemptId === attemptId &&
      receipt.payload.actionFingerprint === github.fingerprint,
  );
}

function assertPreparedExternalActionScope(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  handoff: PreparedExternalActionHandoffV1 | null,
  now: Date,
): void {
  const binding = node.destination
    ? graph.capabilityEnvelope.bindings[node.destination.bindingId]
    : null;
  if (
    !handoff ||
    node.effect !== "external_action" ||
    node.allowedTools.length !== 1 ||
    node.allowedTools[0] !== "linear_update_issue" ||
    handoff.operation !== "linear_issue_state_update_v1" ||
    handoff.status !== "prepared" ||
    handoff.missionId !== graph.missionId ||
    handoff.graphRevision !== graph.revision ||
    handoff.capabilityEnvelopeFingerprint !==
      graph.capabilityEnvelope.fingerprint ||
    handoff.nodeId !== node.id ||
    handoff.executionHost !== node.executionHost ||
    handoff.toolName !== node.allowedTools[0] ||
    !binding ||
    handoff.binding.id !== binding.id ||
    handoff.binding.kind !== binding.kind ||
    handoff.binding.destinationFingerprint !== binding.destinationFingerprint ||
    Date.parse(handoff.expiresAt) <= now.getTime()
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Background mutations accept only the exact host-prepared Linear issue state update handoff.",
    );
  }
}

function assertPreparedBackgroundCodeScope(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  handoff: PreparedBackgroundCodeActionV1 | null,
  packageIdentity: PreparedBackgroundCodePackageIdentityV1 | null,
  now: Date,
): void {
  assertPreparedBackgroundCodeActionScope(graph, node, handoff, now);
  if (
    !handoff ||
    !packageIdentity ||
    packageIdentity.handoffFingerprint !== handoff.fingerprint ||
    packageIdentity.workspaceId !== handoff.binding.workspaceId ||
    packageIdentity.workspaceBindingFingerprint !== handoff.payload.workspaceBindingFingerprint ||
    packageIdentity.repositoryProfileKey !== handoff.binding.repositoryProfileKey ||
    packageIdentity.repositoryProfileFingerprint !== handoff.payload.repositoryProfileFingerprint ||
    packageIdentity.consumedActionAuthorityFingerprint !== handoff.authority.authorityFingerprint ||
    Date.parse(packageIdentity.expiresAt) <= now.getTime()
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Background Code execution accepts only one exact host-prepared validation/readback/commit package.",
    );
  }
}

function assertPreparedBackgroundCodeActionScope(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  handoff: PreparedBackgroundCodeActionV1 | null,
  now: Date,
): void {
  const binding = node.destination
    ? graph.capabilityEnvelope.bindings[node.destination.bindingId]
    : null;
  if (
    !handoff ||
    node.effect !== "execution" ||
    node.allowedTools.length !== 1 ||
    node.allowedTools[0] !== "code_validate_commit_prepared" ||
    handoff.operation !== PREPARED_CODE_VALIDATION_COMMIT_OPERATION_V1 ||
    handoff.status !== "prepared" ||
    handoff.missionId !== graph.missionId ||
    handoff.graphRevision !== graph.revision ||
    handoff.capabilityEnvelopeFingerprint !== graph.capabilityEnvelope.fingerprint ||
    handoff.nodeId !== node.id ||
    handoff.executionHost !== node.executionHost ||
    handoff.toolName !== node.allowedTools[0] ||
    !binding ||
    handoff.binding.workspaceId !== binding.id ||
    handoff.binding.destinationFingerprint !== binding.destinationFingerprint ||
    Date.parse(handoff.expiresAt) <= now.getTime()
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Background Code execution accepts only one exact host-prepared validation/readback/commit package.",
    );
  }
}

function assertPreparedBackgroundGitHubScope(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  action: PreparedBackgroundGitHubActionV1 | null,
  packageIdentity: PreparedBackgroundGitHubPackageIdentityV1 | null,
  now: Date,
): void {
  assertPreparedBackgroundGitHubActionScope(graph, node, action, now);
  if (
    !action ||
    !packageIdentity ||
    packageIdentity.actionFingerprint !== action.fingerprint ||
    packageIdentity.preparedActionFingerprint !== action.preparedActionFingerprint ||
    packageIdentity.operation !== action.operation ||
    packageIdentity.publicationId !== action.payload.publicationId ||
    packageIdentity.repositoryBindingFingerprint !== action.binding.repositoryBindingFingerprint ||
    packageIdentity.repositoryProfileFingerprint !== action.binding.repositoryProfileFingerprint ||
    packageIdentity.verifiedAccountId !== action.binding.verifiedAccountId ||
    Date.parse(packageIdentity.expiresAt) <= now.getTime()
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Background GitHub execution accepts only one exact host-prepared local package identity.",
    );
  }
}

function assertPreparedBackgroundGitHubActionScope(
  graph: MissionGraphV3,
  node: MissionNodeV3,
  action: PreparedBackgroundGitHubActionV1 | null,
  now: Date,
): void {
  const binding = node.destination
    ? graph.capabilityEnvelope.bindings[node.destination.bindingId]
    : null;
  if (
    !action ||
    node.effect !== "external_action" ||
    node.allowedTools.length !== 1 ||
    node.allowedTools[0] !== action.toolName ||
    action.status !== "prepared" ||
    action.missionId !== graph.missionId ||
    action.graphRevision !== graph.revision ||
    action.capabilityEnvelopeFingerprint !== graph.capabilityEnvelope.fingerprint ||
    action.nodeId !== node.id ||
    action.executionHost !== node.executionHost ||
    !binding ||
    action.binding.id !== binding.id ||
    action.binding.destinationFingerprint !== binding.destinationFingerprint ||
    Date.parse(action.expiresAt) <= now.getTime()
  ) {
    throw new CompanionBoundaryErrorV1(
      "invalid_job",
      "Background GitHub execution accepts only one exact host-prepared fixed-catalog action.",
    );
  }
}

function validateWorkerResult(job: CompanionJobV1, result: HeadlessWorkerResultV1): void {
  if (
    ![
      "complete",
      "blocked",
      "cancelled",
      "failed",
      "reconcile_required",
    ].includes(result.status)
  ) {
    throw new CompanionBoundaryErrorV1("invalid_job", "Executor returned an invalid state.");
  }
  for (const receipt of result.receipts ?? []) {
    if (
      receipt.version !== COMPANION_COORDINATION_PROTOCOL_VERSION ||
      receipt.jobId !== job.id ||
      receipt.missionId !== job.missionId ||
      receipt.nodeId !== job.nodeId ||
      !isFingerprint(receipt.fingerprint)
    ) {
      throw new CompanionBoundaryErrorV1(
        "invalid_receipt",
        "Executor receipt does not belong to the active mission node.",
      );
    }
    assertNoVaultPayload(receipt);
  }
}

function assertNoVaultPayload(value: unknown): void {
  const seen = new Set<object>();
  const walk = (candidate: unknown): void => {
    if (!candidate || typeof candidate !== "object") return;
    if (seen.has(candidate as object)) return;
    seen.add(candidate as object);
    if (Array.isArray(candidate)) {
      candidate.forEach(walk);
      return;
    }
    for (const [key, nested] of Object.entries(candidate as Record<string, unknown>)) {
      if (isVaultMarker(key)) {
        throw new CompanionBoundaryErrorV1(
          "vault_boundary_violation",
          "Companion jobs cannot contain vault paths, content, or operations.",
        );
      }
      walk(nested);
    }
  };
  walk(value);
}

function containsVaultPayload(value: unknown): boolean {
  try {
    assertNoVaultPayload(value);
    return false;
  } catch (error) {
    if (
      error instanceof CompanionBoundaryErrorV1 &&
      error.code === "vault_boundary_violation"
    ) {
      return true;
    }
    throw error;
  }
}

function isVaultMarker(value: string): boolean {
  const normalized = value.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return [
    "vault",
    "vaultroot",
    "vaultpath",
    "vaultcontent",
    "notepath",
    "notecontent",
    "obsidianvault",
  ].includes(normalized) || /^vault/.test(normalized);
}

function isFingerprint(value: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(value);
}

function assertBootstrapToken(token: string): void {
  if (typeof token !== "string" || new TextEncoder().encode(token).byteLength < 32) {
    throw new CompanionBoundaryErrorV1(
      "credential_unavailable",
      "The companion bootstrap token must contain at least 256 bits of material.",
    );
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  if (!value || Number.isNaN(Date.parse(value))) {
    throw new CompanionBoundaryErrorV1(
      "invalid_authorization",
      `${field} must be an ISO timestamp.`,
    );
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = bytes[index] ?? 0;
    const b = bytes[index + 1] ?? 0;
    const c = bytes[index + 2] ?? 0;
    const packed = (a << 16) | (b << 8) | c;
    output += alphabet[(packed >>> 18) & 63];
    output += alphabet[(packed >>> 12) & 63];
    if (index + 1 < bytes.length) output += alphabet[(packed >>> 6) & 63];
    if (index + 2 < bytes.length) output += alphabet[packed & 63];
  }
  return output;
}

function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Headless executor failed.";
  return boundedText(message.replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]"), 4_096);
}

function boundedText(value: string, maxChars: number): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}
