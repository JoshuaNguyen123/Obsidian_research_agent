import type { AgentRunStopReason } from "../AgentRunner";
import { evaluateContinuousResearchRun } from "../orchestrator/continuousResearch";

export type MissionCadence = "hourly" | "daily" | "weekly";

export interface ScheduledMission {
  id: string;
  /** Human-readable label used by the settings schedule builder. */
  name?: string;
  prompt: string;
  cadence: MissionCadence;
  hourLocal?: number;
  weekday?: number;
  targetNotePath?: string;
  enabled: boolean;
  lastRunAt: string | null;
  lastRunId: string | null;
  lastOutcome?: AgentRunStopReason;
  mode?: "standard" | "continuous_research";
  pinnedTargetIds?: string[];
  quietHours?: { startMinute: number; endMinute: number };
  consecutiveFailures?: number;
  lastSourceHashes?: Record<string, string>;
}

export function getDueMissions(
  schedules: ScheduledMission[],
  now: Date,
): ScheduledMission[] {
  return schedules.filter((mission) => isDue(mission, now));
}

export class MissionScheduler {
  private intervalId: number | null = null;
  private readonly checkIntervalMs: number;
  private readonly onDue: (mission: ScheduledMission) => Promise<void>;
  private readonly getSchedules: () => ScheduledMission[];

  constructor(options: {
    checkIntervalMs?: number;
    getSchedules: () => ScheduledMission[];
    onDue: (mission: ScheduledMission) => Promise<void>;
  }) {
    this.checkIntervalMs = options.checkIntervalMs ?? 60_000;
    this.getSchedules = options.getSchedules;
    this.onDue = options.onDue;
  }

  start(registerInterval: (id: number) => void): void {
    this.stop();
    this.intervalId = window.setInterval(() => {
      void this.tick(new Date());
    }, this.checkIntervalMs);
    registerInterval(this.intervalId);
    void this.tick(new Date());
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  async tick(now: Date): Promise<void> {
    for (const mission of getDueMissions(this.getSchedules(), now)) {
      await this.onDue(mission);
    }
  }
}

export function normalizeScheduledMissions(value: unknown): ScheduledMission[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(normalizeScheduledMission)
    .filter((item): item is ScheduledMission => item !== null)
    .slice(0, 50);
}

function isDue(mission: ScheduledMission, now: Date): boolean {
  if (!mission.enabled || !mission.prompt.trim()) {
    return false;
  }

  if (mission.mode === "continuous_research") {
    return evaluateContinuousResearchRun(
      {
        enabled: mission.enabled,
        intervalMinutes:
          mission.cadence === "hourly"
            ? 60
            : mission.cadence === "daily"
              ? 24 * 60
              : 7 * 24 * 60,
        pinnedTargetIds: mission.pinnedTargetIds ?? [],
        quietHours: mission.quietHours,
        retry: {
          maxAttempts: 5,
          baseDelayMinutes: 15,
          maxDelayMinutes: 6 * 60,
        },
      },
      {
        lastCompletedAt: isSuccessfulOutcome(mission.lastOutcome)
          ? mission.lastRunAt
          : null,
        lastAttemptAt: mission.lastRunAt,
        consecutiveFailures: mission.consecutiveFailures ?? 0,
        lastSourceHashes: mission.lastSourceHashes ?? {},
      },
      now,
    ).shouldRun;
  }

  const lastRunAt = mission.lastRunAt ? Date.parse(mission.lastRunAt) : NaN;
  const lastRun = Number.isFinite(lastRunAt) ? new Date(lastRunAt) : null;
  const periodMs = getCadenceMs(mission.cadence);
  if (lastRun && now.getTime() - lastRun.getTime() < periodMs) {
    return false;
  }

  if (mission.cadence === "hourly") {
    return true;
  }

  if (mission.cadence === "daily") {
    return now.getHours() >= clampHour(mission.hourLocal);
  }

  return (
    now.getDay() === clampWeekday(mission.weekday) &&
    now.getHours() >= clampHour(mission.hourLocal)
  );
}

function getCadenceMs(cadence: MissionCadence): number {
  if (cadence === "hourly") {
    return 60 * 60 * 1000;
  }
  if (cadence === "daily") {
    return 24 * 60 * 60 * 1000;
  }
  return 7 * 24 * 60 * 60 * 1000;
}

function normalizeScheduledMission(value: unknown): ScheduledMission | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = getString(value.id) || `schedule-${Math.random().toString(36).slice(2)}`;
  const prompt = getString(value.prompt)?.trim() ?? "";
  const cadence = getCadence(value.cadence);
  if (!prompt || !cadence) {
    return null;
  }
  return {
    id,
    name: getString(value.name)?.trim() || undefined,
    prompt,
    cadence,
    hourLocal: clampHour(getNumber(value.hourLocal)),
    weekday: clampWeekday(getNumber(value.weekday)),
    targetNotePath: getString(value.targetNotePath),
    enabled: value.enabled !== false,
    lastRunAt: getString(value.lastRunAt) ?? null,
    lastRunId: getString(value.lastRunId) ?? null,
    lastOutcome: getRunOutcome(value.lastOutcome),
    mode: value.mode === "continuous_research" ? "continuous_research" : "standard",
    pinnedTargetIds: getStringArray(value.pinnedTargetIds).slice(0, 100),
    quietHours: normalizeQuietHours(value.quietHours),
    consecutiveFailures: Math.max(0, Math.trunc(getNumber(value.consecutiveFailures) ?? 0)),
    lastSourceHashes: getStringRecord(value.lastSourceHashes),
  };
}

function getCadence(value: unknown): MissionCadence | null {
  return value === "hourly" || value === "daily" || value === "weekly"
    ? value
    : null;
}

function clampHour(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(23, Math.max(0, Math.trunc(value)))
    : 8;
}

function clampWeekday(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(6, Math.max(0, Math.trunc(value)))
    : 1;
}

function getString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function getNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function getStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean))]
    : [];
}

function getStringRecord(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] =>
        Boolean(entry[0].trim()) && typeof entry[1] === "string",
    ),
  );
}

function normalizeQuietHours(
  value: unknown,
): { startMinute: number; endMinute: number } | undefined {
  if (!isRecord(value)) return undefined;
  return {
    startMinute: Math.min(1439, Math.max(0, Math.trunc(getNumber(value.startMinute) ?? 0))),
    endMinute: Math.min(1439, Math.max(0, Math.trunc(getNumber(value.endMinute) ?? 0))),
  };
}

function getRunOutcome(value: unknown): AgentRunStopReason | undefined {
  return value === "final" ||
    value === "write_completed" ||
    value === "clarifying_question" ||
    value === "user_stopped" ||
    value === "budget" ||
    value === "error"
    ? value
    : undefined;
}

function isSuccessfulOutcome(value: AgentRunStopReason | undefined): boolean {
  return (
    value === "final" ||
    value === "write_completed" ||
    value === "clarifying_question"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
