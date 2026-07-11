import {
  parseRenderedWorkItemSpecV1,
} from "../../integrations/linear/WorkItemParser";
import type {
  LinearBaseRecord,
  LinearIssueRecord,
  LinearOperationResult,
  LinearRequestOptions,
} from "../../integrations/linear/types";
import type { WorkItemSpecV1 } from "../../integrations/linear/WorkItemSpecV1";
import {
  advanceLinearQueueCursor,
  compareLinearQueueCursors,
  recordCandidateEligibility,
  upsertLinearQueueCandidate,
} from "./linearQueue";
import type {
  CandidateEligibilityV1,
  LinearQueueCandidateV1,
  LinearQueueCursorV1,
  LinearQueueStateV1,
} from "./types";

export const LINEAR_QUEUE_SCAN_INTERVAL_MS = 15 * 60_000;
export const LINEAR_QUEUE_SCAN_LIMIT = 10;

export type MaybePromise<T> = T | Promise<T>;

export interface LinearQueueClock {
  now(): Date;
}

export interface LinearQueueTimer {
  setInterval(callback: () => void, intervalMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LinearQueueReadClient {
  execute(
    operationKey: string,
    variables?: Record<string, unknown>,
    options?: LinearRequestOptions,
  ): Promise<LinearOperationResult>;
}

/**
 * The host must serialize this callback and persist the returned state before
 * resolving. It is the only queue mutation seam used by the supervisor.
 */
export type DurableLinearQueueReducer = (
  reduce: (current: LinearQueueStateV1) => LinearQueueStateV1,
) => Promise<LinearQueueStateV1>;

export interface QueueCandidateGrantInput {
  issueId: string;
  identifier: string;
  workItem: WorkItemSpecV1;
  signal: AbortSignal;
}

export interface QueueCandidateEligibilityInput extends QueueCandidateGrantInput {
  at: string;
}

export interface LinearQueueSupervisorOptions {
  client: LinearQueueReadClient;
  /** Trusted Linear project that exclusively owns executable queue issues. */
  queueProjectId: string;
  clock?: LinearQueueClock;
  timer?: LinearQueueTimer;
  reduceQueueState: DurableLinearQueueReducer;
  isConnectionEligible(input: { signal: AbortSignal }): MaybePromise<boolean>;
  isConfigurationEligible(input: { signal: AbortSignal }): MaybePromise<boolean>;
  isExecutionGrantEligible(input: QueueCandidateGrantInput): MaybePromise<boolean>;
  evaluateCandidate(input: QueueCandidateEligibilityInput): MaybePromise<CandidateEligibilityV1>;
  onCandidatesReady?(issueIds: string[], signal: AbortSignal): MaybePromise<void>;
  onScanError?(error: unknown): void;
}

export type LinearQueueScanResult =
  | {
      status: "completed";
      fetched: number;
      upserted: number;
      evaluated: number;
      readyIssueIds: string[];
      cursor: LinearQueueCursorV1 | null;
    }
  | {
      status: "skipped";
      reason:
        | "not_started"
        | "scan_in_progress"
        | "connection_ineligible"
        | "configuration_ineligible"
        | "stopped";
    }
  | { status: "failed"; error: unknown };

export class LinearQueueSupervisor {
  private readonly options: LinearQueueSupervisorOptions;
  private readonly clock: LinearQueueClock;
  private readonly timer: LinearQueueTimer;
  private intervalHandle: unknown;
  private started = false;
  private stopped = false;
  private scanPromise: Promise<LinearQueueScanResult> | null = null;
  private scanAbortController: AbortController | null = null;

  constructor(options: LinearQueueSupervisorOptions) {
    assertTrustedId(options.queueProjectId, "Linear queue project id");
    this.options = options;
    this.clock = options.clock ?? SYSTEM_CLOCK;
    this.timer = options.timer ?? SYSTEM_TIMER;
  }

  async start(options: { scanImmediately?: boolean } = {}): Promise<LinearQueueScanResult | null> {
    if (this.started && !this.stopped) {
      return null;
    }
    this.started = true;
    this.stopped = false;
    this.intervalHandle = this.timer.setInterval(() => {
      void this.scanNow();
    }, LINEAR_QUEUE_SCAN_INTERVAL_MS);
    return options.scanImmediately === false ? null : this.scanNow();
  }

  async scanNow(): Promise<LinearQueueScanResult> {
    if (!this.started) {
      return { status: "skipped", reason: "not_started" };
    }
    if (this.stopped) {
      return { status: "skipped", reason: "stopped" };
    }
    if (this.scanPromise) {
      return { status: "skipped", reason: "scan_in_progress" };
    }

    const controller = new AbortController();
    this.scanAbortController = controller;
    const scan = this.performScan(controller.signal)
      .catch((error): LinearQueueScanResult => {
        if (controller.signal.aborted && this.stopped) {
          return { status: "skipped", reason: "stopped" };
        }
        this.options.onScanError?.(error);
        return { status: "failed", error };
      })
      .finally(() => {
        if (this.scanPromise === scan) {
          this.scanPromise = null;
          this.scanAbortController = null;
        }
      });
    this.scanPromise = scan;
    return scan;
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      if (this.scanPromise) {
        await this.scanPromise;
      }
      return;
    }
    this.stopped = true;
    if (this.intervalHandle !== undefined) {
      this.timer.clearInterval(this.intervalHandle);
      this.intervalHandle = undefined;
    }
    this.scanAbortController?.abort();
    if (this.scanPromise) {
      await this.scanPromise;
    }
  }

  get isRunning(): boolean {
    return this.started && !this.stopped;
  }

  private async performScan(signal: AbortSignal): Promise<LinearQueueScanResult> {
    if (!(await this.options.isConnectionEligible({ signal }))) {
      return { status: "skipped", reason: "connection_ineligible" };
    }
    assertNotAborted(signal);
    if (!(await this.options.isConfigurationEligible({ signal }))) {
      return { status: "skipped", reason: "configuration_ineligible" };
    }
    assertNotAborted(signal);

    let state = await this.options.reduceQueueState((current) => current);
    const initialCursor = state.cursor;
    const result = await this.options.client.execute(
      "issues.list",
      buildIssueListVariables(initialCursor, this.options.queueProjectId),
      { abortSignal: signal },
    );
    assertNotAborted(signal);
    const fetchedIssues = readIssuePage(result)
      .filter((issue) => issue.project?.id === this.options.queueProjectId)
      .filter((issue) => isAfterCursor(issue, initialCursor))
      .sort(compareIssuesByCursor)
      .slice(0, LINEAR_QUEUE_SCAN_LIMIT);

    let upserted = 0;
    for (const issue of fetchedIssues) {
      assertNotAborted(signal);
      const workItem = parseIssueWorkItem(issue);
      if (
        !workItem ||
        issue.trashed ||
        issue.archivedAt ||
        issue.completedAt ||
        issue.canceledAt
      ) {
        continue;
      }
      const eventAt = this.nowIso();
      state = await this.options.reduceQueueState((current) =>
        upsertLinearQueueCandidate(current, {
          at: eventAt,
          issueId: issue.id,
          identifier: issue.identifier,
          remoteUpdatedAt: issue.updatedAt!,
          workItem,
        }),
      );
      upserted += 1;
    }

    const pending = Object.values(state.candidates)
      .filter((candidate) => candidate.status === "pending")
      .sort(
        (left, right) =>
          left.remoteUpdatedAt.localeCompare(right.remoteUpdatedAt) ||
          left.issueId.localeCompare(right.issueId),
      )
      .slice(0, LINEAR_QUEUE_SCAN_LIMIT);
    const readyIssueIds: string[] = [];
    let evaluated = 0;
    for (const candidate of pending) {
      assertNotAborted(signal);
      const grantInput = toGrantInput(candidate, signal);
      if (!(await this.options.isExecutionGrantEligible(grantInput))) {
        continue;
      }
      assertNotAborted(signal);
      const at = this.nowIso();
      const eligibility = await this.options.evaluateCandidate({
        ...grantInput,
        at,
      });
      state = await this.options.reduceQueueState((current) =>
        recordCandidateEligibility(current, candidate.issueId, eligibility),
      );
      evaluated += 1;
      if (eligibility.eligible) {
        readyIssueIds.push(candidate.issueId);
      }
    }

    if (fetchedIssues.length > 0) {
      const lastIssue = fetchedIssues[fetchedIssues.length - 1];
      const cursor = issueCursor(lastIssue);
      const cursorAt = this.nowIso();
      // This commit occurs only after every candidate upsert and decision above
      // has durably resolved. Any earlier failure leaves the prior cursor intact.
      state = await this.options.reduceQueueState((current) =>
        advanceLinearQueueCursor(current, cursor, cursorAt),
      );
    }
    assertNotAborted(signal);
    if (readyIssueIds.length > 0) {
      try {
        await this.options.onCandidatesReady?.([...readyIssueIds], signal);
      } catch (error) {
        // Queue/cursor durability is already complete. Downstream scheduling is
        // retriable and must not misreport the committed scan as failed.
        this.options.onScanError?.(error);
      }
    }
    return {
      status: "completed",
      fetched: fetchedIssues.length,
      upserted,
      evaluated,
      readyIssueIds,
      cursor: state.cursor,
    };
  }

  private nowIso(): string {
    const now = this.clock.now();
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error("Linear queue clock returned an invalid date.");
    }
    return now.toISOString();
  }
}

function buildIssueListVariables(
  cursor: LinearQueueCursorV1 | null,
  queueProjectId: string,
): Record<string, unknown> {
  return {
    first: LINEAR_QUEUE_SCAN_LIMIT,
    includeArchived: false,
    filter: {
      project: { id: { eq: queueProjectId } },
      ...(cursor
        ? {
            updatedAt: { gte: cursor.updatedAt },
          }
        : {}),
    },
  };
}

function readIssuePage(result: LinearOperationResult): LinearIssueRecord[] {
  if (
    !result ||
    typeof result !== "object" ||
    !("items" in result) ||
    !Array.isArray(result.items)
  ) {
    throw new Error("Linear issues.list returned an unexpected non-page result.");
  }
  return result.items.filter(isIssueRecord);
}

function isIssueRecord(value: LinearBaseRecord): value is LinearIssueRecord {
  return (
    value.resourceType === "issue" &&
    typeof value.id === "string" &&
    typeof value.identifier === "string" &&
    typeof value.updatedAt === "string"
  );
}

function parseIssueWorkItem(issue: LinearIssueRecord): WorkItemSpecV1 | null {
  if (!issue.description) {
    return null;
  }
  try {
    return parseRenderedWorkItemSpecV1(issue.description).spec;
  } catch {
    return null;
  }
}

function isAfterCursor(
  issue: LinearIssueRecord,
  cursor: LinearQueueCursorV1 | null,
): boolean {
  return !cursor || compareLinearQueueCursors(issueCursor(issue), cursor) > 0;
}

function compareIssuesByCursor(left: LinearIssueRecord, right: LinearIssueRecord): number {
  return compareLinearQueueCursors(issueCursor(left), issueCursor(right));
}

function issueCursor(issue: LinearIssueRecord): LinearQueueCursorV1 {
  if (!issue.updatedAt) {
    throw new Error("Linear queue issue is missing updatedAt.");
  }
  return { updatedAt: issue.updatedAt, issueId: issue.id };
}

function toGrantInput(
  candidate: LinearQueueCandidateV1,
  signal: AbortSignal,
): QueueCandidateGrantInput {
  return {
    issueId: candidate.issueId,
    identifier: candidate.identifier,
    workItem: candidate.workItem,
    signal,
  };
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException("Linear queue scan was aborted.", "AbortError");
  }
}

function assertTrustedId(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/.test(value)) {
    throw new Error(`${label} is invalid.`);
  }
}

const SYSTEM_CLOCK: LinearQueueClock = {
  now: () => new Date(),
};

const SYSTEM_TIMER: LinearQueueTimer = {
  setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
  clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
};
