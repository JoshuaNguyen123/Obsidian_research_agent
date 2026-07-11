import type {
  JsonSchemaObject,
  ModelChatMessage,
  ModelClient,
} from "../model/types";

/** Opt-in structured router mode. Default remains off. */
export type ModelRouterMode = "off" | "shadow" | "authority";

/** Minimum confidence required before authority mode trusts the model route. */
export const ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD = 0.75;

export interface RoutedMissionIntent {
  mode:
    | "chat_answer"
    | "vault_read"
    | "vault_write"
    | "web_research"
    | "deep_research"
    | "code_workflow"
    | "design_artifact"
    | "browser_mission";
  writeScope:
    | "none"
    | "current_note_append"
    | "current_note_replace"
    | "current_note_section"
    | "vault_files"
    | "title_rename";
  needsWebEvidence: boolean;
  needsVaultContext: boolean;
  needsCodeExecution: boolean;
  wordTarget: number | null;
  confidence: number;
  rationale: string;
}

export const MISSION_ROUTER_SCHEMA: JsonSchemaObject = {
  type: "object",
  required: [
    "mode",
    "writeScope",
    "needsWebEvidence",
    "needsVaultContext",
    "needsCodeExecution",
    "wordTarget",
    "confidence",
    "rationale",
  ],
  additionalProperties: false,
  properties: {
    mode: {
      type: "string",
      enum: [
        "chat_answer",
        "vault_read",
        "vault_write",
        "web_research",
        "deep_research",
        "code_workflow",
        "design_artifact",
        "browser_mission",
      ],
    },
    writeScope: {
      type: "string",
      enum: [
        "none",
        "current_note_append",
        "current_note_replace",
        "current_note_section",
        "vault_files",
        "title_rename",
      ],
    },
    needsWebEvidence: { type: "boolean" },
    needsVaultContext: { type: "boolean" },
    needsCodeExecution: { type: "boolean" },
    wordTarget: { type: ["number", "null"] },
    confidence: { type: "number" },
    rationale: { type: "string" },
  },
};

export async function classifyMissionWithModel({
  client,
  prompt,
  recentAssistant,
  timeoutMs = 10_000,
}: {
  client: ModelClient;
  prompt: string;
  recentAssistant?: string;
  timeoutMs?: number;
}): Promise<RoutedMissionIntent | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content:
        "Classify the user mission for an Obsidian plugin agent. Return only JSON matching the schema. Prefer safe read-only classifications when uncertain.",
    },
    ...(recentAssistant
      ? [
          {
            role: "system" as const,
            content: `Recent assistant context: ${recentAssistant.slice(0, 2000)}`,
          },
        ]
      : []),
    { role: "user", content: prompt },
  ];

  try {
    const response = await client.chat({
      messages,
      format: MISSION_ROUTER_SCHEMA,
      abortSignal: controller.signal,
      options: { temperature: 0 },
    });
    return normalizeRoutedMissionIntent(response.message.content);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves router mode from settings. Legacy `modelRouterEnabled: true`
 * maps to shadow so existing vaults keep non-authoritative behavior.
 */
export function resolveModelRouterMode(settings: {
  modelRouterMode?: ModelRouterMode | string | null;
  modelRouterEnabled?: boolean;
} | null | undefined): ModelRouterMode {
  const mode = settings?.modelRouterMode;
  if (mode === "off" || mode === "shadow" || mode === "authority") {
    return mode;
  }
  return settings?.modelRouterEnabled === true ? "shadow" : "off";
}

export function normalizeModelRouterMode(
  value: unknown,
  legacyEnabled?: boolean,
): ModelRouterMode {
  if (value === "off" || value === "shadow" || value === "authority") {
    return value;
  }
  return legacyEnabled === true ? "shadow" : "off";
}

export type RouterResolutionSource = "model" | "regex";

export interface ResolvedRouterIntent {
  intent: RoutedMissionIntent;
  source: RouterResolutionSource;
  mode: ModelRouterMode;
  /** Present when authority fell back to regex or shadow logged a miss. */
  fallbackReason?: string;
  modelIntent?: RoutedMissionIntent | null;
}

/**
 * Authority-aware intent resolution. Shadow/off always use the regex-derived
 * fallback for policy. Authority uses a high-confidence valid model route but
 * never widens writeScope/destructiveness beyond the regex safety net.
 *
 * Callers supply `regexIntent` from `deriveRoutedIntentFallback` so this module
 * stays free of a policyEngine import cycle.
 */
export function resolveRoutedMissionIntent({
  mode,
  modelIntent,
  regexIntent,
  confidenceThreshold = ROUTER_AUTHORITY_CONFIDENCE_THRESHOLD,
}: {
  mode: ModelRouterMode;
  modelIntent?: RoutedMissionIntent | null;
  regexIntent: RoutedMissionIntent;
  confidenceThreshold?: number;
}): ResolvedRouterIntent {
  if (mode === "off") {
    return {
      intent: regexIntent,
      source: "regex",
      mode,
      modelIntent: modelIntent ?? null,
    };
  }

  if (mode === "shadow") {
    return {
      intent: regexIntent,
      source: "regex",
      mode,
      fallbackReason: modelIntent
        ? "shadow_mode_regex_authoritative"
        : "shadow_mode_model_unavailable",
      modelIntent: modelIntent ?? null,
    };
  }

  // authority
  if (!modelIntent) {
    return {
      intent: regexIntent,
      source: "regex",
      mode,
      fallbackReason: "authority_model_unavailable",
      modelIntent: null,
    };
  }
  if (modelIntent.confidence < confidenceThreshold) {
    return {
      intent: regexIntent,
      source: "regex",
      mode,
      fallbackReason: `authority_low_confidence:${modelIntent.confidence}`,
      modelIntent,
    };
  }

  return {
    intent: intersectAuthoritativeIntent(modelIntent, regexIntent),
    source: "model",
    mode,
    modelIntent,
  };
}

/**
 * Prefer the safer (less destructive) write scope so authority cannot widen
 * replace/delete/vault scope beyond the regex+policy baseline.
 */
export function saferWriteScope(
  left: RoutedMissionIntent["writeScope"],
  right: RoutedMissionIntent["writeScope"],
): RoutedMissionIntent["writeScope"] {
  return writeScopeDestructiveness(left) <= writeScopeDestructiveness(right)
    ? left
    : right;
}

export function intersectAuthoritativeIntent(
  model: RoutedMissionIntent,
  regex: RoutedMissionIntent,
): RoutedMissionIntent {
  return {
    ...model,
    writeScope: saferWriteScope(model.writeScope, regex.writeScope),
  };
}

function writeScopeDestructiveness(
  scope: RoutedMissionIntent["writeScope"],
): number {
  switch (scope) {
    case "none":
      return 0;
    case "current_note_append":
      return 1;
    case "current_note_section":
      return 2;
    case "title_rename":
      return 3;
    case "current_note_replace":
      return 4;
    case "vault_files":
      return 5;
    default:
      return 0;
  }
}

export function normalizeRoutedMissionIntent(
  value: unknown,
): RoutedMissionIntent | null {
  const parsed = typeof value === "string" ? parseJson(value) : value;
  if (!isRecord(parsed)) {
    return null;
  }
  const mode = parsed.mode;
  const writeScope = parsed.writeScope;
  if (!isMode(mode) || !isWriteScope(writeScope)) {
    return null;
  }
  const confidence =
    typeof parsed.confidence === "number" && Number.isFinite(parsed.confidence)
      ? Math.max(0, Math.min(1, parsed.confidence))
      : null;
  if (confidence === null) {
    return null;
  }
  return {
    mode,
    writeScope,
    needsWebEvidence: parsed.needsWebEvidence === true,
    needsVaultContext: parsed.needsVaultContext === true,
    needsCodeExecution: parsed.needsCodeExecution === true,
    wordTarget:
      typeof parsed.wordTarget === "number" && Number.isFinite(parsed.wordTarget)
        ? parsed.wordTarget
        : null,
    confidence,
    rationale:
      typeof parsed.rationale === "string"
        ? parsed.rationale.slice(0, 240)
        : "",
  };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function isMode(value: unknown): value is RoutedMissionIntent["mode"] {
  return (
    value === "chat_answer" ||
    value === "vault_read" ||
    value === "vault_write" ||
    value === "web_research" ||
    value === "deep_research" ||
    value === "code_workflow" ||
    value === "design_artifact" ||
    value === "browser_mission"
  );
}

function isWriteScope(value: unknown): value is RoutedMissionIntent["writeScope"] {
  return (
    value === "none" ||
    value === "current_note_append" ||
    value === "current_note_replace" ||
    value === "current_note_section" ||
    value === "vault_files" ||
    value === "title_rename"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
