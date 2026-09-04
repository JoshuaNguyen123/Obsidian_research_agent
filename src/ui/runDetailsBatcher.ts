/**
 * Coalesces Run Details trace-row and mission-graph DOM onto the shared
 * keyed frame batcher. Burst onTrace / onMissionGraphUpdate events render
 * once per animation frame (latest callback wins).
 *
 * AgentView is owned by the Community workstream. Wire there with:
 *   runDetailsBatcher.scheduleTrace(() => this.appendTraceEvent(event));
 *   runDetailsBatcher.scheduleGraph(() => this.renderMissionGraph());
 */

import {
  KeyedFrameBatcher,
  type FrameScheduler,
} from "./frameBatcher";

export type RunDetailsBatchKey = "trace" | "graph";

export class RunDetailsFrameBatcher {
  private readonly batcher: KeyedFrameBatcher<RunDetailsBatchKey>;

  constructor(scheduler: FrameScheduler) {
    this.batcher = new KeyedFrameBatcher(scheduler);
  }

  scheduleTrace(callback: () => void): void {
    this.batcher.schedule("trace", callback);
  }

  scheduleGraph(callback: () => void): void {
    this.batcher.schedule("graph", callback);
  }

  flushTrace(): void {
    this.batcher.flush("trace");
  }

  flushGraph(): void {
    this.batcher.flush("graph");
  }

  flushAll(): void {
    this.batcher.flushAll();
  }

  cancelAll(): void {
    this.batcher.cancelAll();
  }

  get pendingCount(): number {
    return this.batcher.pendingCount;
  }
}

export function createRunDetailsFrameBatcher(
  scheduler: FrameScheduler,
): RunDetailsFrameBatcher {
  return new RunDetailsFrameBatcher(scheduler);
}
