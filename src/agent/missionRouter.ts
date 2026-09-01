import type {
  JsonSchemaObject,
  ModelChatMessage,
  ModelClient,
} from "../model/types";
import { ModelClientError } from "../model/types";
import { withModelRetry } from "../model/retry";

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

export const MISSION_ROUTER_SYSTEM_PROMPT = [
  "Classify the user mission for an Obsidian plugin agent.",
  "Return exactly one JSON object with these eight keys and no others:",
  '{"mode":"vault_write","writeScope":"current_note_append","needsWebEvidence":false,"needsVaultContext":true,"needsCodeExecution":false,"wordTarget":null,"confidence":0.9,"rationale":"brief reason"}',
  'mode must be one of: "chat_answer", "vault_read", "vault_write", "web_research", "deep_research", "code_workflow", "design_artifact", "browser_mission".',
  'writeScope must be one of: "none", "current_note_append", "current_note_replace", "current_note_section", "vault_files", "title_rename".',
  "The three needs* values must be JSON booleans. wordTarget must be a JSON number or null. confidence must be a JSON number from 0 through 1. rationale must be a short JSON string.",
  "Prefer safe read-only classifications when uncertain. Return JSON only: no markdown fence, prose, or alternate property names.",
].join("\n");

export async function classifyMissionWithModel({
  client,
  prompt,
  recentAssistant,
  timeoutMs = 10_000,
  abortSignal,
}: {
  client: ModelClient;
  prompt: string;
  recentAssistant?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<RoutedMissionIntent | null> {
  return (
    await classifyMissionWithModelDetailed({
      client,
      prompt,
      recentAssistant,
      timeoutMs,
      abortSignal,
    })
  ).intent;
}

export type RouterModelFailureReason =
  | "router_timeout"
  | "router_invalid_response_after_repair"
  | "router_auth"
  | "router_provider_unavailable";

export interface RouterModelClassificationResult {
  intent: RoutedMissionIntent | null;
  failureReason: RouterModelFailureReason | null;
  attempts: number;
}

export async function classifyMissionWithModelDetailed({
  client,
  prompt,
  recentAssistant,
  timeoutMs = 10_000,
  abortSignal,
}: {
  client: ModelClient;
  prompt: string;
  recentAssistant?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}): Promise<RouterModelClassificationResult> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(abortSignal?.reason);
  abortSignal?.addEventListener("abort", abortFromCaller, { once: true });
  if (abortSignal?.aborted) {
    abortFromCaller();
  }
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const messages: ModelChatMessage[] = [
    {
      role: "system",
      content: MISSION_ROUTER_SYSTEM_PROMPT,
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
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const request = {
        messages,
        ...(client.descriptor?.endpointCategory === "ollama_cloud"
          ? {}
          : { format: MISSION_ROUTER_SCHEMA }),
        abortSignal: controller.signal,
        evidencePhase: attempt === 1 ? "router" : "retry",
        think: false,
        options: { temperature: 0 },
      } satisfies Parameters<ModelClient["chat"]>[0];
      const response = await withModelRetry(() => client.chat(request), {
        policy: { maxAttempts: 2 },
        abortSignal: controller.signal,
      });
      const normalized = normalizeRoutedMissionIntent(response.message.content);
      if (normalized) return { intent: normalized, failureReason: null, attempts: attempt };
      if (attempt === 1) {
        messages.push(
          { role: "assistant", content: response.message.content.slice(0, 4_000) },
          {
            role: "system",
            content:
              `Schema repair: the previous value was invalid. ${MISSION_ROUTER_SYSTEM_PROMPT}`,
          },
        );
      }
    }
    return {
      intent: null,
      failureReason: "router_invalid_response_after_repair",
      attempts: 2,
    };
  } catch (error) {
    // The router may fail closed on its own timeout/provider error, but a
    // caller cancellation is lifecycle authority, not routing evidence. If we
    // translate it to router_provider_unavailable the agent keeps
    // bootstrapping after plugin unload and the old coordinator can overlap a
    // resumed instance.
    if (abortSignal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }
    if (
      error instanceof ModelClientError &&
      error.category === "provider_budget_exhausted"
    ) {
      throw error;
    }
    return {
      intent: null,
      failureReason: timedOut
        ? "router_timeout"
        : error instanceof ModelClientError &&
            (error.category === "auth" || error.category === "missing_api_key")
          ? "router_auth"
          : "router_provider_unavailable",
      attempts: 1,
    };
  } finally {
    clearTimeout(timeout);
    abortSignal?.removeEventListener("abort", abortFromCaller);
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

/**
 * THE authority write-scope answer: how much write scope survives when a
 * high-confidence model route meets the regex safety net.
 *
 * `regex` is not merely a second opinion. `deriveRoutedIntentFallback` builds
 * it from the run's ACTUAL write-tool exposure, and in a mission-graph run the
 * exposed tool set IS the frontier's current offer — the host only offers what
 * the graph planned. So a non-"none" regex scope is the host stating "I am
 * offering a mutation right now".
 *
 * `saferWriteScope` alone let a model opinion of "none" win that intersection.
 * `evaluateToolPolicy` then refused `create_file` with `mutation_scope` on a
 * mission whose own plan was `tool-01-create_file … tool-04-delete_path`: the
 * host planned the write, offered the tool, and its own gate refused it —
 * `offered ⊄ gate-accepted`, and the node died on `tool_failure_repeated`.
 *
 * The intersection stays a CEILING: authority still can never widen past the
 * regex scope, and a model may still narrow AMONG write scopes. It is no longer
 * a FLOOR, so a model may not revoke mutation authority the host itself
 * granted. That is exactly the boundary the mutation-scope block documents for
 * itself — it "only fires for tool calls that slipped past tool exposure", and
 * a call the frontier is actively offering did not slip past anything.
 *
 * When no write tool is exposed the regex scope is already "none", so a
 * read-only mission keeps the block with its full force.
 */
export function resolveAuthoritativeWriteScopeV1(
  model: RoutedMissionIntent["writeScope"],
  regex: RoutedMissionIntent["writeScope"],
): RoutedMissionIntent["writeScope"] {
  const withinCeiling = saferWriteScope(model, regex);
  return withinCeiling === "none" && regex !== "none" ? regex : withinCeiling;
}

export function intersectAuthoritativeIntent(
  model: RoutedMissionIntent,
  regex: RoutedMissionIntent,
): RoutedMissionIntent {
  const resolvedNeedsWeb = model.needsWebEvidence || regex.needsWebEvidence;
  return {
    ...model,
    // Read authority is additive: either planner may identify grounding that
    // is useful, while the installed tool catalog and budgets remain the host
    // boundary. Execution stays intersected so model output cannot grant it.
    needsWebEvidence: resolvedNeedsWeb,
    needsVaultContext: model.needsVaultContext || regex.needsVaultContext,
    needsCodeExecution:
      model.needsCodeExecution && regex.needsCodeExecution,
    writeScope: resolveAuthoritativeWriteScopeV1(
      model.writeScope,
      regex.writeScope,
    ),
    wordTarget: regex.wordTarget ?? model.wordTarget,
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
  const trimmed = value.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = /^```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(trimmed);
    if (!fenced) return null;
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      return null;
    }
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
