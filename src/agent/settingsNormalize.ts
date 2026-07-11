/**
 * Pure settings schema normalization and profile migration.
 * Avoids importing src/settings.ts so unit tests do not load the Obsidian UI module.
 */

import { normalizeModelRouterMode } from "./missionRouter";
import { normalizeScheduledMissions } from "./missionScheduler";
import type { AutonomyProfile, OutputProfile } from "./noteOutputPolicy";
import { deriveOutputProfileFromLegacy } from "./noteOutputPolicy";
import type { ModelProvider } from "../model/types";
import { MAX_AGENT_STEPS } from "../tools/constants";

export const SETTINGS_SCHEMA_VERSION = 2;

export type AutonomyProfileSetting = AutonomyProfile;
export type OutputProfileSetting = OutputProfile;
export type StreamWritebackMode = "off" | "all_current_note_content_writes";
export type ThinkingMode = "auto" | "off" | "low" | "medium" | "high" | "max";

/** Minimal settings shape used by normalize — compatible with AgentSettings. */
export interface NormalizableAgentSettings {
  settingsSchemaVersion?: number;
  autonomyProfile?: AutonomyProfileSetting;
  outputProfile?: OutputProfileSetting;
  modelProvider: ModelProvider;
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  openAiCompatibleApiKey: string;
  openAiCompatibleBaseUrl: string;
  model: string;
  utilityModel?: string;
  utilityModelProvider?: ModelProvider;
  modelRouterEnabled?: boolean;
  modelRouterMode?: "off" | "shadow" | "authority";
  enableStreaming: boolean;
  requestTimeoutMs: number;
  maxAgentSteps: number;
  maxRunMinutes?: number | null;
  autoContinueLongRuns?: boolean;
  maxLongRunSegments?: number;
  completionDrivenLoops?: boolean;
  maxCompletionSegments?: number;
  overnightRunsEnabled?: boolean;
  overnightRunHours?: number;
  overnightMaxSegments?: number;
  autoResumeOvernightRuns?: boolean;
  keepAwakeDuringOvernightRuns?: boolean;
  orchestratorPreviewEnabled?: boolean;
  orchestratorEnabled?: boolean;
  orchestratorAutoMergeGreen?: boolean;
  orchestratorWorkerMaxSteps?: number;
  orchestratorWorkerMaxToolCalls?: number;
  orchestratorWorkerMaxMinutes?: number;
  autoTitleOnWrite?: boolean;
  maxCodeRunsPerMission?: number;
  thinkingMode: ThinkingMode;
  streamWritebackMode: StreamWritebackMode;
  templateFolder: string;
  templateOutputFolder: string;
  researchMemoryEnabled: boolean;
  researchMemoryFolder: string;
  companionBaseUrl: string;
  browserToolsEnabled: boolean;
  experienceMemoryEnabled: boolean;
  defaultBrowserMissionMode: "supervised" | "extract_only";
  agenticReflexEnabled: boolean;
  agenticReflexDiagnosticsEnabled: boolean;
  semanticSearchEnabled: boolean;
  semanticEmbeddingModel: string;
  semanticEmbeddingDim: 256 | 512;
  semanticChunkMinTokens: number;
  semanticChunkTargetTokens: number;
  semanticChunkMaxTokens: number;
  semanticChunkOverlapTokens: number;
  semanticPythonCommand: string;
  semanticModelCacheDir: string;
  semanticIndexEnabled: boolean;
  semanticIndexFolder: string;
  semanticIndexDebounceMs: number;
  semanticIndexMaxFiles: number;
  semanticIndexPersistVectors: boolean;
  temperature: number | null;
  topK: number | null;
  topP: number | null;
  numCtx: number | null;
  linearEnabled?: boolean;
  linearCapabilityGate?: 0 | 1 | 2 | 3 | 4 | 5;
  linearDefaultTeamId?: string;
  linearQueueEnabled?: boolean;
  linearQueueProjectId?: string;
  linearStartedStateId?: string;
  linearCompletedStateId?: string;
  linearBlockedStateId?: string;
  linearScanIntervalMinutes?: 15;
  scheduledMissions?: unknown[];
  [key: string]: unknown;
}

const BASE_DEFAULTS: NormalizableAgentSettings = {
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  autonomyProfile: "automatic",
  outputProfile: "active_or_new_note",
  modelProvider: "ollama",
  ollamaApiKey: "",
  ollamaBaseUrl: "https://ollama.com/api",
  openAiCompatibleApiKey: "",
  openAiCompatibleBaseUrl: "https://api.openai.com/v1",
  model: "gpt-oss:120b-cloud",
  utilityModel: "",
  utilityModelProvider: "ollama",
  modelRouterEnabled: false,
  modelRouterMode: "off",
  enableStreaming: true,
  requestTimeoutMs: 180000,
  maxAgentSteps: MAX_AGENT_STEPS,
  maxRunMinutes: null,
  autoContinueLongRuns: true,
  maxLongRunSegments: 4,
  completionDrivenLoops: true,
  maxCompletionSegments: 24,
  overnightRunsEnabled: true,
  overnightRunHours: 10,
  overnightMaxSegments: 24,
  autoResumeOvernightRuns: true,
  keepAwakeDuringOvernightRuns: false,
  orchestratorPreviewEnabled: true,
  orchestratorEnabled: true,
  orchestratorAutoMergeGreen: true,
  orchestratorWorkerMaxSteps: 20,
  orchestratorWorkerMaxToolCalls: 24,
  orchestratorWorkerMaxMinutes: 15,
  autoTitleOnWrite: true,
  thinkingMode: "auto",
  streamWritebackMode: "all_current_note_content_writes",
  templateFolder: "Templates",
  templateOutputFolder: "",
  researchMemoryEnabled: true,
  researchMemoryFolder: "Agent Research Memory",
  companionBaseUrl: "http://127.0.0.1:8765",
  browserToolsEnabled: false,
  experienceMemoryEnabled: false,
  defaultBrowserMissionMode: "supervised",
  agenticReflexEnabled: true,
  agenticReflexDiagnosticsEnabled: true,
  semanticSearchEnabled: true,
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
  semanticEmbeddingDim: 512,
  semanticChunkMinTokens: 300,
  semanticChunkTargetTokens: 500,
  semanticChunkMaxTokens: 700,
  semanticChunkOverlapTokens: 80,
  semanticPythonCommand: "",
  semanticModelCacheDir: "",
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticIndexDebounceMs: 3000,
  semanticIndexMaxFiles: 10000,
  semanticIndexPersistVectors: true,
  temperature: null,
  topK: null,
  topP: null,
  numCtx: null,
  linearEnabled: false,
  linearCapabilityGate: 0,
  linearDefaultTeamId: "",
  linearQueueEnabled: false,
  linearQueueProjectId: "",
  linearStartedStateId: "",
  linearCompletedStateId: "",
  linearBlockedStateId: "",
  linearScanIntervalMinutes: 15,
  scheduledMissions: [],
};

export interface NormalizedAgentSettings extends NormalizableAgentSettings {
  settingsSchemaVersion: number;
  autonomyProfile: AutonomyProfileSetting;
  outputProfile: OutputProfileSetting;
}

export type SettingsInstallKind = "new_install" | "existing_install";

export function detectInstallKind(raw: unknown): SettingsInstallKind {
  if (!raw || typeof raw !== "object") {
    return "new_install";
  }
  const keys = Object.keys(raw as Record<string, unknown>).filter(
    (key) =>
      key !== "conversationHistory" &&
      key !== "linearApiKey" &&
      !key.startsWith("_"),
  );
  return keys.length === 0 ? "new_install" : "existing_install";
}

export function normalizeAgentSettings(
  raw: unknown,
  installKind: SettingsInstallKind = detectInstallKind(raw),
): NormalizedAgentSettings {
  const data =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const merged = {
    ...BASE_DEFAULTS,
    ...pickKnownSettings(data),
  } as NormalizableAgentSettings;

  merged.enableStreaming = coerceBoolean(merged.enableStreaming, true);
  merged.streamWritebackMode = coerceStreamWritebackMode(
    merged.streamWritebackMode,
  );
  merged.autoTitleOnWrite = merged.autoTitleOnWrite !== false;
  merged.thinkingMode = coerceThinkingMode(merged.thinkingMode);
  merged.modelRouterMode = normalizeModelRouterMode(
    merged.modelRouterMode ??
      (merged.modelRouterEnabled === true ? "shadow" : "off"),
  );
  merged.modelRouterEnabled = merged.modelRouterMode !== "off";
  if (typeof merged.orchestratorEnabled !== "boolean") {
    merged.orchestratorEnabled = merged.orchestratorPreviewEnabled !== false;
  }
  merged.orchestratorPreviewEnabled = merged.orchestratorEnabled !== false;
  merged.scheduledMissions = normalizeScheduledMissions(
    merged.scheduledMissions,
  );

  const schemaVersion = coerceSchemaVersion(data.settingsSchemaVersion);
  const explicitProfile = coerceAutonomyProfile(data.autonomyProfile);
  const explicitOutput = coerceOutputProfile(data.outputProfile);

  let autonomyProfile: AutonomyProfileSetting;
  let outputProfile: OutputProfileSetting;

  if (installKind === "new_install" && schemaVersion < 2) {
    autonomyProfile = "automatic";
    outputProfile = "active_or_new_note";
    applyAutomaticOutputDefaults(merged);
  } else if (explicitProfile && explicitOutput) {
    autonomyProfile = explicitProfile;
    outputProfile = explicitOutput;
  } else if (explicitProfile === "custom" || hasConflictingLegacyOutput(merged)) {
    autonomyProfile = "custom";
    outputProfile =
      explicitOutput ??
      deriveOutputProfileFromLegacy({
        enableStreaming: merged.enableStreaming,
        streamWritebackMode: merged.streamWritebackMode,
        autoTitleOnWrite: merged.autoTitleOnWrite !== false,
      });
  } else if (explicitProfile === "conservative") {
    autonomyProfile = "conservative";
    outputProfile = explicitOutput ?? "chat_first";
    if (!explicitOutput) {
      applyConservativeOutputDefaults(merged);
    }
  } else if (explicitProfile === "automatic" || installKind === "new_install") {
    autonomyProfile = "automatic";
    outputProfile = explicitOutput ?? "active_or_new_note";
    if (!explicitOutput) {
      applyAutomaticOutputDefaults(merged);
    }
  } else {
    outputProfile =
      explicitOutput ??
      deriveOutputProfileFromLegacy({
        enableStreaming: merged.enableStreaming,
        streamWritebackMode: merged.streamWritebackMode,
        autoTitleOnWrite: merged.autoTitleOnWrite !== false,
      });
    autonomyProfile =
      outputProfile === "active_or_new_note" &&
      merged.enableStreaming &&
      merged.streamWritebackMode === "all_current_note_content_writes" &&
      merged.autoTitleOnWrite !== false
        ? "automatic"
        : "custom";
  }

  if (autonomyProfile === "automatic" && outputProfile === "active_or_new_note") {
    applyAutomaticOutputDefaults(merged);
  } else if (
    autonomyProfile === "conservative" &&
    outputProfile === "chat_first"
  ) {
    applyConservativeOutputDefaults(merged);
  }

  return {
    ...merged,
    settingsSchemaVersion: Math.max(schemaVersion, SETTINGS_SCHEMA_VERSION),
    autonomyProfile,
    outputProfile,
  };
}

/** Apply recommended Automatic defaults without touching credentials. */
export function applyRecommendedAutomaticDefaults(
  settings: NormalizableAgentSettings,
): NormalizedAgentSettings {
  const next = {
    ...settings,
    autonomyProfile: "automatic" as const,
    outputProfile: "active_or_new_note" as const,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  applyAutomaticOutputDefaults(next);
  next.agenticReflexEnabled = true;
  next.enableStreaming = true;
  next.streamWritebackMode = "all_current_note_content_writes";
  next.autoTitleOnWrite = true;
  next.orchestratorEnabled = true;
  next.orchestratorPreviewEnabled = true;
  next.semanticSearchEnabled = true;
  next.semanticIndexEnabled = true;
  next.autoContinueLongRuns = true;
  next.completionDrivenLoops = true;
  return normalizeAgentSettings(next, "existing_install");
}

function applyAutomaticOutputDefaults(settings: NormalizableAgentSettings): void {
  settings.enableStreaming = true;
  settings.streamWritebackMode = "all_current_note_content_writes";
  settings.autoTitleOnWrite = true;
}

function applyConservativeOutputDefaults(settings: NormalizableAgentSettings): void {
  settings.enableStreaming = true;
  settings.streamWritebackMode = "off";
  settings.autoTitleOnWrite = false;
}

function hasConflictingLegacyOutput(settings: NormalizableAgentSettings): boolean {
  const streamingOff =
    settings.enableStreaming === false ||
    settings.streamWritebackMode === "off";
  const titleOff = settings.autoTitleOnWrite === false;
  return (
    (streamingOff && settings.autoTitleOnWrite !== false) ||
    (titleOff &&
      settings.enableStreaming !== false &&
      settings.streamWritebackMode === "all_current_note_content_writes")
  );
}

function pickKnownSettings(
  data: Record<string, unknown>,
): Partial<NormalizableAgentSettings> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(BASE_DEFAULTS)) {
    if (key in data) {
      result[key] = data[key];
    }
  }
  return result as Partial<NormalizableAgentSettings>;
}

function coerceBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  return fallback;
}

function coerceStreamWritebackMode(value: unknown): StreamWritebackMode {
  if (value === "off" || value === "all_current_note_content_writes") {
    return value;
  }
  return BASE_DEFAULTS.streamWritebackMode;
}

function coerceThinkingMode(value: unknown): ThinkingMode {
  const allowed: ThinkingMode[] = [
    "auto",
    "off",
    "low",
    "medium",
    "high",
    "max",
  ];
  if (typeof value === "string" && allowed.includes(value as ThinkingMode)) {
    return value as ThinkingMode;
  }
  return BASE_DEFAULTS.thinkingMode;
}

function coerceSchemaVersion(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }
  return 1;
}

function coerceAutonomyProfile(value: unknown): AutonomyProfileSetting | null {
  if (
    value === "automatic" ||
    value === "conservative" ||
    value === "custom"
  ) {
    return value;
  }
  return null;
}

function coerceOutputProfile(value: unknown): OutputProfileSetting | null {
  if (
    value === "active_or_new_note" ||
    value === "active_note_only" ||
    value === "chat_first"
  ) {
    return value;
  }
  return null;
}
