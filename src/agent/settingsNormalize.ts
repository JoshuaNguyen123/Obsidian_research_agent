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

export const SETTINGS_SCHEMA_VERSION = 4;

export type SupportedSettingsSchemaVersion = 1 | 2 | 3 | 4;

/** Missing version is the original schema-1 representation. */
export function parseSupportedSettingsSchemaVersion(
  value: unknown,
): SupportedSettingsSchemaVersion {
  if (
    value === undefined ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4
  ) {
    return (value ?? 1) as SupportedSettingsSchemaVersion;
  }
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1
  ) {
    throw new Error(
      "settingsSchemaVersion must be one of the supported integer schemas: 1, 2, 3, or 4.",
    );
  }
  throw new Error(
    `Unsupported future settings schema ${value}; this core supports schemas 1 through ${SETTINGS_SCHEMA_VERSION}.`,
  );
}

export type AutonomyProfileSetting = AutonomyProfile;
export type OutputProfileSetting = OutputProfile;
export type WorkingModeSetting = "automatic" | "chat_only" | "custom";
export type MemoryModeSetting =
  | "off"
  | "research"
  | "research_and_experience";
export type StreamWritebackMode = "off" | "all_current_note_content_writes";
export type ThinkingMode = "auto" | "off" | "low" | "medium" | "high" | "max";

/** Minimal settings shape used by normalize — compatible with AgentSettings. */
export interface NormalizableAgentSettings {
  settingsSchemaVersion?: number;
  workingMode?: WorkingModeSetting;
  memoryMode?: MemoryModeSetting;
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
  githubEnabled?: boolean;
  githubOAuthClientId?: string;
  scheduledMissions?: unknown[];
  [key: string]: unknown;
}

const BASE_DEFAULTS: NormalizableAgentSettings = {
  settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  workingMode: "automatic",
  memoryMode: "research",
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
  modelRouterEnabled: true,
  modelRouterMode: "authority",
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
  orchestratorWorkerMaxSteps: 40,
  orchestratorWorkerMaxToolCalls: 40,
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
  githubEnabled: false,
  githubOAuthClientId: "",
  scheduledMissions: [],
};

export interface NormalizedAgentSettings extends NormalizableAgentSettings {
  settingsSchemaVersion: number;
  workingMode: WorkingModeSetting;
  memoryMode: MemoryModeSetting;
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
  merged.companionBaseUrl = normalizeCompanionLoopbackBaseUrl(
    merged.companionBaseUrl,
  );
  merged.githubEnabled = merged.githubEnabled === true;
  merged.githubOAuthClientId = normalizeGitHubOAuthClientIdSetting(
    merged.githubOAuthClientId,
  );

  const schemaVersion = parseSupportedSettingsSchemaVersion(
    data.settingsSchemaVersion,
  );
  const explicitWorkingMode = coerceWorkingMode(data.workingMode);
  const explicitMemoryMode = coerceMemoryMode(data.memoryMode);
  const explicitProfile = coerceAutonomyProfile(data.autonomyProfile);
  const explicitOutput = coerceOutputProfile(data.outputProfile);

  let autonomyProfile: AutonomyProfileSetting;
  let outputProfile: OutputProfileSetting;
  let workingMode: WorkingModeSetting;

  if (explicitWorkingMode === "automatic") {
    workingMode = "automatic";
    autonomyProfile = "automatic";
    outputProfile = "active_or_new_note";
    applyAutomaticProfileDefaults(merged);
  } else if (explicitWorkingMode === "chat_only") {
    workingMode = "chat_only";
    autonomyProfile = "conservative";
    outputProfile = "chat_first";
    applyConservativeOutputDefaults(merged);
  } else if (explicitWorkingMode === "custom") {
    workingMode = "custom";
    autonomyProfile = "custom";
    outputProfile =
      explicitOutput ??
      deriveOutputProfileFromLegacy({
        enableStreaming: merged.enableStreaming,
        streamWritebackMode: merged.streamWritebackMode,
        autoTitleOnWrite: merged.autoTitleOnWrite !== false,
      });
  } else if (installKind === "new_install" && schemaVersion < 2) {
    workingMode = "automatic";
    autonomyProfile = "automatic";
    outputProfile = "active_or_new_note";
    applyAutomaticProfileDefaults(merged);
  } else if (explicitProfile === "automatic") {
    workingMode = "automatic";
    autonomyProfile = "automatic";
    outputProfile = "active_or_new_note";
    applyAutomaticProfileDefaults(merged);
  } else if (explicitProfile === "conservative") {
    workingMode = "chat_only";
    autonomyProfile = "conservative";
    outputProfile = "chat_first";
    applyConservativeOutputDefaults(merged);
  } else if (explicitProfile === "custom" || hasConflictingLegacyOutput(merged)) {
    workingMode = "custom";
    autonomyProfile = "custom";
    outputProfile =
      explicitOutput ??
      deriveOutputProfileFromLegacy({
        enableStreaming: merged.enableStreaming,
        streamWritebackMode: merged.streamWritebackMode,
        autoTitleOnWrite: merged.autoTitleOnWrite !== false,
      });
  } else if (installKind === "new_install") {
    workingMode = "automatic";
    autonomyProfile = "automatic";
    outputProfile = "active_or_new_note";
    applyAutomaticProfileDefaults(merged);
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
    workingMode =
      autonomyProfile === "automatic" ? "automatic" : "custom";
  }

  if (autonomyProfile === "automatic" && outputProfile === "active_or_new_note") {
    applyAutomaticProfileDefaults(merged);
  } else if (
    autonomyProfile === "conservative" &&
    outputProfile === "chat_first"
  ) {
    applyConservativeOutputDefaults(merged);
  }

  const memoryMode =
    explicitMemoryMode ??
    deriveMemoryMode({
      researchMemoryEnabled: merged.researchMemoryEnabled,
      experienceMemoryEnabled: merged.experienceMemoryEnabled,
    });
  applyMemoryModeDefaults(merged, memoryMode);

  return {
    ...merged,
    settingsSchemaVersion: Math.max(schemaVersion, SETTINGS_SCHEMA_VERSION),
    autonomyProfile,
    outputProfile,
    workingMode,
    memoryMode,
  };
}

/** Apply recommended Automatic defaults without touching credentials. */
export function applyRecommendedAutomaticDefaults(
  settings: NormalizableAgentSettings,
): NormalizedAgentSettings {
  const next = {
    ...settings,
    workingMode: "automatic" as const,
    autonomyProfile: "automatic" as const,
    outputProfile: "active_or_new_note" as const,
    settingsSchemaVersion: SETTINGS_SCHEMA_VERSION,
  };
  applyAutomaticProfileDefaults(next);
  next.orchestratorEnabled = true;
  next.orchestratorPreviewEnabled = true;
  next.semanticSearchEnabled = true;
  next.semanticIndexEnabled = true;
  next.autoContinueLongRuns = true;
  next.completionDrivenLoops = true;
  return normalizeAgentSettings(next, "existing_install");
}

export function applyAutomaticProfileDefaults(
  settings: NormalizableAgentSettings,
): void {
  settings.enableStreaming = true;
  settings.streamWritebackMode = "all_current_note_content_writes";
  settings.autoTitleOnWrite = true;
  settings.thinkingMode = "auto";
  settings.agenticReflexEnabled = true;
  settings.modelRouterMode = "authority";
  settings.modelRouterEnabled = true;
}

export function applyWorkingModeDefaults(
  settings: NormalizableAgentSettings,
  mode: WorkingModeSetting,
): void {
  settings.workingMode = mode;
  if (mode === "automatic") {
    settings.autonomyProfile = "automatic";
    settings.outputProfile = "active_or_new_note";
    settings.orchestratorEnabled = true;
    settings.orchestratorPreviewEnabled = true;
    settings.autoContinueLongRuns = true;
    settings.completionDrivenLoops = true;
    applyAutomaticProfileDefaults(settings);
    return;
  }
  if (mode === "chat_only") {
    settings.autonomyProfile = "conservative";
    settings.outputProfile = "chat_first";
    applyConservativeOutputDefaults(settings);
    return;
  }
  settings.autonomyProfile = "custom";
}

export function applyMemoryModeDefaults(
  settings: NormalizableAgentSettings,
  mode: MemoryModeSetting,
): void {
  settings.memoryMode = mode;
  settings.researchMemoryEnabled = mode !== "off";
  settings.experienceMemoryEnabled = mode === "research_and_experience";
}

/** Normalize the public OAuth application identifier without accepting secrets. */
export function normalizeGitHubOAuthClientIdSetting(value: unknown): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return /^[A-Za-z0-9._-]{3,256}$/.test(trimmed) ? trimmed : "";
}

export function normalizeCompanionLoopbackBaseUrl(value: unknown): string {
  if (typeof value !== "string") return BASE_DEFAULTS.companionBaseUrl;
  try {
    const parsed = new URL(value.trim());
    const host = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback =
      host === "localhost" ||
      host === "::1" ||
      /^127(?:\.\d{1,3}){3}$/.test(host);
    if (
      !loopback ||
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      (parsed.pathname !== "/" && parsed.pathname !== "")
    ) {
      return BASE_DEFAULTS.companionBaseUrl;
    }
    return parsed.origin;
  } catch {
    return BASE_DEFAULTS.companionBaseUrl;
  }
}

function applyConservativeOutputDefaults(settings: NormalizableAgentSettings): void {
  settings.enableStreaming = true;
  settings.streamWritebackMode = "off";
  settings.autoTitleOnWrite = false;
  settings.modelRouterMode = "off";
  settings.modelRouterEnabled = false;
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

function coerceWorkingMode(value: unknown): WorkingModeSetting | null {
  return value === "automatic" || value === "chat_only" || value === "custom"
    ? value
    : null;
}

function coerceMemoryMode(value: unknown): MemoryModeSetting | null {
  return value === "off" ||
    value === "research" ||
    value === "research_and_experience"
    ? value
    : null;
}

function deriveMemoryMode(input: {
  researchMemoryEnabled: boolean;
  experienceMemoryEnabled: boolean;
}): MemoryModeSetting {
  if (input.experienceMemoryEnabled) return "research_and_experience";
  if (input.researchMemoryEnabled) return "research";
  return "off";
}
