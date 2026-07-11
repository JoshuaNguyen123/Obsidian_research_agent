import type {
  AgentRunCompleteEvent,
  AgentRunConfigEvent,
  AgentRunEvents,
  AgentRunReceipt,
  AgentRunStopReason,
} from "../AgentRunner";

const MAX_BUFFERED_RUN_EVENTS = 800;
const MAX_BUFFERED_RUN_EVENT_CHARS = 2_000_000;
const MAX_RETAINED_RUN_RECEIPTS = 256;

export type RunCoordinatorState = "idle" | "running" | "stopping";

export interface RunOutcome {
  runId: string | null;
  stopReason: AgentRunStopReason;
  step: number;
  maxSteps: number;
}

export interface RunCoordinatorSnapshot {
  isRunning: boolean;
  state: RunCoordinatorState;
  runId: string | null;
  bufferedEventCount: number;
  bufferedEventChars: number;
  droppedEventCount: number;
  eventSequence: number;
  startedAtMs: number | null;
  lastActivityAtMs: number | null;
  lastConfig: AgentRunConfigEvent | null;
  lastReceipts: AgentRunReceipt[];
  lastComplete: AgentRunCompleteEvent | null;
}

export class RunAlreadyActiveError extends Error {
  constructor() {
    super("An agent mission is already running.");
    this.name = "RunAlreadyActiveError";
  }
}

type RunExecutor = (
  abortSignal: AbortSignal,
  events: AgentRunEvents,
) => Promise<void>;

export interface RunCoordinatorStartOptions {
  /** Receives only events from the run accepted by this start call. */
  eventTap?: AgentRunEvents;
}

type BufferedRunEvent = {
  sequence: number;
  estimatedChars: number;
  key: keyof AgentRunEvents;
  args: unknown[];
};

export class RunCoordinator {
  private readonly listeners = new Set<AgentRunEvents>();
  private readonly bufferedEvents: BufferedRunEvent[] = [];
  private activePromise: Promise<RunOutcome> | null = null;
  private activeController: AbortController | null = null;
  private activeEventTap: AgentRunEvents | null = null;
  private state: RunCoordinatorState = "idle";
  private runId: string | null = null;
  private lastConfig: AgentRunConfigEvent | null = null;
  private readonly lastReceipts: AgentRunReceipt[] = [];
  private lastComplete: AgentRunCompleteEvent | null = null;
  private bufferedEventChars = 0;
  private droppedEventCount = 0;
  private eventSequence = 0;
  private startedAtMs: number | null = null;
  private lastActivityAtMs: number | null = null;

  isRunning(): boolean {
    return this.activePromise !== null;
  }

  getSnapshot(): RunCoordinatorSnapshot {
    return {
      isRunning: this.isRunning(),
      state: this.state,
      runId: this.runId,
      bufferedEventCount: this.bufferedEvents.length,
      bufferedEventChars: this.bufferedEventChars,
      droppedEventCount: this.droppedEventCount,
      eventSequence: this.eventSequence,
      startedAtMs: this.startedAtMs,
      lastActivityAtMs: this.lastActivityAtMs,
      lastConfig: this.lastConfig ? { ...this.lastConfig } : null,
      lastReceipts: this.lastReceipts.map((receipt) => ({ ...receipt })),
      lastComplete: this.lastComplete ? { ...this.lastComplete } : null,
    };
  }

  subscribe(
    listener: AgentRunEvents,
    options: { replay?: boolean } = {},
  ): () => void {
    this.listeners.add(listener);
    if (options.replay === true) {
      for (const event of this.bufferedEvents) {
        dispatchRunEvent(listener, event);
      }
    }
    return () => {
      this.listeners.delete(listener);
    };
  }

  start(
    executor: RunExecutor,
    options: RunCoordinatorStartOptions = {},
  ): Promise<RunOutcome> {
    if (this.activePromise) {
      throw new RunAlreadyActiveError();
    }

    this.bufferedEvents.splice(0, this.bufferedEvents.length);
    this.bufferedEventChars = 0;
    this.droppedEventCount = 0;
    this.eventSequence = 0;
    this.runId = null;
    this.lastConfig = null;
    this.lastReceipts.splice(0, this.lastReceipts.length);
    this.lastComplete = null;
    this.activeController = new AbortController();
    this.state = "running";
    this.startedAtMs = Date.now();
    this.lastActivityAtMs = this.startedAtMs;
    const controller = this.activeController;
    this.activeEventTap = options.eventTap ?? null;
    const events = this.createEvents();

    let resolveOutcome!: (outcome: RunOutcome) => void;
    let rejectOutcome!: (error: unknown) => void;
    const promise = new Promise<RunOutcome>((resolve, reject) => {
      resolveOutcome = resolve;
      rejectOutcome = reject;
    });
    // Reserve the coordinator before invoking the executor. Event handlers can
    // synchronously re-enter start(), so assigning this afterward would leave a
    // brief second-run acceptance window.
    this.activePromise = promise;

    void (async () => {
      try {
        await executor(controller.signal, events);
        const fallbackComplete = {
          step: 0,
          maxSteps: this.lastConfig?.maxStepsForRun ?? 0,
          stopReason: controller.signal.aborted
            ? "user_stopped" as const
            : "error" as const,
        } satisfies AgentRunCompleteEvent;
        if (!this.lastComplete) {
          // A runtime may finish setup/backoff cancellation without entering a
          // child runner that emits its own terminal event. Publish the same
          // fallback used for the returned outcome so detached/replaced views
          // cannot remain stuck in Running or Stopping.
          this.emit("onRunComplete", [fallbackComplete]);
        }
        const complete = this.lastComplete ?? fallbackComplete;
        resolveOutcome({
          runId: this.runId,
          stopReason: complete.stopReason,
          step: complete.step,
          maxSteps: complete.maxSteps,
        });
      } catch (error) {
        if (!this.lastComplete) {
          this.emit("onRunComplete", [
            {
              step: 0,
              maxSteps: this.lastConfig?.maxStepsForRun ?? 0,
              stopReason: "error",
            } satisfies AgentRunCompleteEvent,
          ]);
        }
        rejectOutcome(error);
      } finally {
        if (this.activePromise === promise) {
          this.activePromise = null;
          this.activeController = null;
          this.activeEventTap = null;
          this.state = "idle";
        }
      }
    })();
    return promise;
  }

  requestStop(): boolean {
    if (!this.activeController || this.activeController.signal.aborted) {
      return false;
    }
    this.state = "stopping";
    this.lastActivityAtMs = Date.now();
    this.activeController.abort();
    return true;
  }

  async shutdown(): Promise<void> {
    this.requestStop();
    if (!this.activePromise) {
      return;
    }
    try {
      await this.activePromise;
    } catch {
      // Shutdown is best-effort; the runner records the actionable error.
    }
  }

  private createEvents(): AgentRunEvents {
    return new Proxy({} as AgentRunEvents, {
      get: (_target, property) => {
        if (typeof property !== "string") {
          return undefined;
        }
        return (...args: unknown[]) => {
          this.emit(property as keyof AgentRunEvents, args);
        };
      },
    });
  }

  private emit(key: keyof AgentRunEvents, args: unknown[]): void {
    this.lastActivityAtMs = Date.now();
    if (key === "onRunConfig") {
      const config = args[0] as AgentRunConfigEvent | undefined;
      this.runId = config?.runId ?? this.runId;
      this.lastConfig = config ? { ...config } : this.lastConfig;
    } else if (key === "onOrchestratorEvent") {
      const snapshot = args[1] as { runId?: string } | undefined;
      this.runId = snapshot?.runId ?? this.runId;
    } else if (key === "onReceipt") {
      const receipt = args[0] as AgentRunReceipt | undefined;
      if (receipt) {
        this.lastReceipts.push({ ...receipt });
        if (this.lastReceipts.length > MAX_RETAINED_RUN_RECEIPTS) {
          this.lastReceipts.splice(
            0,
            this.lastReceipts.length - MAX_RETAINED_RUN_RECEIPTS,
          );
        }
      }
    } else if (key === "onRunComplete") {
      this.lastComplete = { ...(args[0] as AgentRunCompleteEvent) };
    }

    const event: BufferedRunEvent = {
      sequence: ++this.eventSequence,
      estimatedChars: estimateRunEventChars(args),
      key,
      args: [...args],
    };
    this.bufferedEvents.push(event);
    this.bufferedEventChars += event.estimatedChars;
    while (
      this.bufferedEvents.length > MAX_BUFFERED_RUN_EVENTS ||
      this.bufferedEventChars > MAX_BUFFERED_RUN_EVENT_CHARS
    ) {
      const removed = this.bufferedEvents.shift();
      if (!removed) {
        break;
      }
      this.bufferedEventChars = Math.max(
        0,
        this.bufferedEventChars - removed.estimatedChars,
      );
      this.droppedEventCount += 1;
    }
    const activeEventTap = this.activeEventTap;
    if (activeEventTap) {
      dispatchRunEvent(activeEventTap, event);
    }
    for (const listener of this.listeners) {
      dispatchRunEvent(listener, event);
    }
  }
}

function estimateRunEventChars(args: unknown[]): number {
  try {
    return Math.max(1, JSON.stringify(args).length);
  } catch {
    return 1_000;
  }
}

function dispatchRunEvent(
  listener: AgentRunEvents,
  event: BufferedRunEvent,
): void {
  const handler = listener[event.key] as
    | ((...args: unknown[]) => void)
    | undefined;
  handler?.(...event.args);
}
