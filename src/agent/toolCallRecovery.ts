import type {
  ModelChatResponse,
  ModelToolCall,
} from "../model/types";
import { getString, isRecord } from "./recordUtils";

const MAX_RECOVERED_TEXT_TOOL_CALLS = 4;

export interface RecoverToolCallsOptions {
  /** Ready-frontier names. Structured calls off this set are recovered from text. */
  frontierToolNames?: ReadonlySet<string>;
}

/**
 * Prefer structured provider toolCalls when they are known, on-frontier, and
 * have usable arguments. Recover from assistant text when structured calls
 * are missing, unknown, empty-args (and text has better args), or off-frontier.
 */
export function recoverToolCallsFromAssistantMessage(
  response: Pick<ModelChatResponse, "message" | "toolCalls">,
  knownToolNames: ReadonlySet<string>,
  options?: RecoverToolCallsOptions,
): ModelToolCall[] {
  const structured = response.toolCalls ?? [];
  const textCalls = extractToolCallsFromAssistantText(
    response.message.content,
    knownToolNames,
  );
  const frontier = options?.frontierToolNames;

  if (structured.length === 0) {
    return filterRecoveredCallsToFrontier(textCalls, frontier);
  }

  if (shouldRecoverStructuredFromText(structured, textCalls, knownToolNames, frontier)) {
    const recovered = filterRecoveredCallsToFrontier(textCalls, frontier);
    if (recovered.length > 0) {
      return recovered;
    }
    return structured.filter((call) => isUsableStructuredCall(call, knownToolNames, frontier));
  }

  return structured;
}

export const MIXED_STRUCTURED_TEXT_RECOVERY_FIXTURE = {
  content:
    '<tool_call>{"name":"web_search","arguments":{"query":"obsidian"}}</tool_call>',
  structured: [
    {
      name: "not_a_real_tool",
      arguments: {},
      index: 0,
      raw: { source: "junk-structured" },
    },
  ] satisfies ModelToolCall[],
  knownToolNames: ["web_search"],
  expectedName: "web_search",
} as const;

/** Metric B: share of expected text calls recovered from mixed junk structured. */
export function measureMixedStructuredTextRecoveryRate(): number {
  const recovered = recoverToolCallsFromAssistantMessage(
    {
      message: {
        role: "assistant",
        content: MIXED_STRUCTURED_TEXT_RECOVERY_FIXTURE.content,
      },
      toolCalls: [...MIXED_STRUCTURED_TEXT_RECOVERY_FIXTURE.structured],
    },
    new Set(MIXED_STRUCTURED_TEXT_RECOVERY_FIXTURE.knownToolNames),
  );
  const expected = MIXED_STRUCTURED_TEXT_RECOVERY_FIXTURE.expectedName;
  const hits = recovered.filter(
    (call) => call.name === expected && !isEmptyArgsToolCall(call),
  );
  return hits.length > 0 ? 1 : 0;
}

function shouldRecoverStructuredFromText(
  structured: readonly ModelToolCall[],
  textCalls: readonly ModelToolCall[],
  knownToolNames: ReadonlySet<string>,
  frontier: ReadonlySet<string> | undefined,
): boolean {
  if (textCalls.length === 0) {
    return false;
  }
  if (
    structured.some(
      (call) =>
        !knownToolNames.has(call.name) || isOffFrontierToolCall(call, frontier),
    )
  ) {
    return true;
  }
  return structured.some(
    (call) =>
      isEmptyArgsToolCall(call) &&
      textCalls.some(
        (textCall) =>
          textCall.name === call.name && !isEmptyArgsToolCall(textCall),
      ),
  );
}

function isUsableStructuredCall(
  call: ModelToolCall,
  knownToolNames: ReadonlySet<string>,
  frontier: ReadonlySet<string> | undefined,
): boolean {
  return knownToolNames.has(call.name) && !isOffFrontierToolCall(call, frontier);
}

function isEmptyArgsToolCall(call: ModelToolCall): boolean {
  return Object.keys(call.arguments ?? {}).length === 0;
}

function isOffFrontierToolCall(
  call: ModelToolCall,
  frontier: ReadonlySet<string> | undefined,
): boolean {
  return Boolean(frontier && frontier.size > 0 && !frontier.has(call.name));
}

function filterRecoveredCallsToFrontier(
  calls: ModelToolCall[],
  frontier: ReadonlySet<string> | undefined,
): ModelToolCall[] {
  if (!frontier || frontier.size === 0) {
    return calls;
  }
  return calls.filter((call) => frontier.has(call.name));
}

export function extractToolCallsFromAssistantText(
  content: string,
  knownToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  if (!content.trim() || knownToolNames.size === 0) {
    return [];
  }

  const toolCalls: ModelToolCall[] = [];

  for (const toolCall of extractXmlToolCallCandidates(content, knownToolNames)) {
    toolCalls.push(toolCall);

    if (toolCalls.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      return toolCalls.slice(0, MAX_RECOVERED_TEXT_TOOL_CALLS);
    }
  }

  extractVendorToolCallCandidates(content, knownToolNames, toolCalls);
  if (toolCalls.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
    return toolCalls.slice(0, MAX_RECOVERED_TEXT_TOOL_CALLS);
  }

  const parsedCandidates = extractJsonCandidates(content);

  for (const candidate of parsedCandidates) {
    collectToolCallsFromJson(candidate, knownToolNames, toolCalls);

    if (toolCalls.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      break;
    }
  }

  return toolCalls.slice(0, MAX_RECOVERED_TEXT_TOOL_CALLS);
}

function extractXmlToolCallCandidates(
  content: string,
  knownToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  const toolCalls: ModelToolCall[] = [];
  const pattern =
    /<requested_tool_call\b[^>]*>([\s\S]*?)<\/requested_tool_call>/gi;
  let match: RegExpExecArray | null;

  while (
    (match = pattern.exec(content)) !== null &&
    toolCalls.length < MAX_RECOVERED_TEXT_TOOL_CALLS
  ) {
    const body = match[1];
    const name = readXmlTag(body, "name");
    if (!name || !knownToolNames.has(name)) {
      continue;
    }

    const rawArgs =
      readXmlTag(body, "arguments") ??
      readXmlTag(body, "args") ??
      readXmlTag(body, "parameters");
    const parsedArgs = rawArgs ? parseJsonCandidate(rawArgs) : undefined;
    const args = isRecord(parsedArgs) ? parsedArgs : {};

    toolCalls.push({
      name,
      arguments: normalizeRecoveredToolArguments(name, args),
      index: toolCalls.length,
      raw: match[0],
    });
  }

  return toolCalls;
}

/**
 * Vendor-native text tool-call formats. Budget models on Ollama-compatible
 * bridges frequently emit their chat-template syntax as plain content instead
 * of a structured tool_calls array: Kimi K2 sentinel sections, Qwen/Hermes
 * <tool_call> blocks, Llama <function=…> tags, and bare functions.name({…})
 * pseudo-code. Recover every recognizable call; unknown tool names are
 * dropped, and the shared cap bounds the total.
 */
function extractVendorToolCallCandidates(
  content: string,
  knownToolNames: ReadonlySet<string>,
  output: ModelToolCall[],
): void {
  const push = (rawName: string, rawArgs: string, raw: string) => {
    if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) return;
    const name = rawName
      .trim()
      .replace(/^functions\./iu, "")
      .replace(/:\d+$/u, "");
    if (!knownToolNames.has(name)) return;
    const parsed = parseJsonCandidate(rawArgs);
    const candidate: ModelToolCall = {
      name,
      arguments: normalizeRecoveredToolArguments(
        name,
        isRecord(parsed) ? parsed : {},
      ),
      index: output.length,
      raw,
    };
    if (!isDuplicateRecoveredToolCall(output, candidate)) {
      output.push(candidate);
    }
  };

  // Kimi K2: <|tool_call_begin|>functions.NAME:0<|tool_call_argument_begin|>{…}<|tool_call_end|>
  const kimiPattern =
    /<\|tool_call_begin\|>\s*([\w.:-]+?)\s*<\|tool_call_argument_begin\|>\s*([\s\S]*?)\s*<\|tool_call_end\|>/gi;
  let match: RegExpExecArray | null;
  while ((match = kimiPattern.exec(content)) !== null) {
    push(match[1], match[2], match[0]);
  }

  // Qwen / Hermes: <tool_call>{"name": …, "arguments": …}</tool_call>
  const hermesPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/gi;
  while ((match = hermesPattern.exec(content)) !== null) {
    const parsed = parseJsonCandidate(match[1]);
    if (parsed !== undefined) {
      collectToolCallsFromJson(parsed, knownToolNames, output);
    }
    if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) return;
  }

  // Llama 3.x: <function=NAME>{…}</function>
  const llamaPattern = /<function=([\w.-]+)>\s*([\s\S]*?)\s*<\/function>/gi;
  while ((match = llamaPattern.exec(content)) !== null) {
    push(match[1], match[2], match[0]);
  }

  // Bare pseudo-code: functions.NAME({…}) or NAME({…}) for a known tool.
  const barePattern = /\b(?:functions\.)?([A-Za-z][A-Za-z0-9_]*)\s*\(\s*(?=\{)/gu;
  while ((match = barePattern.exec(content)) !== null) {
    if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) return;
    const name = match[1].trim();
    if (!knownToolNames.has(name)) continue;
    const objectStart = match.index + match[0].length;
    const objectEnd = findBalancedJsonObjectEnd(content, objectStart);
    if (objectEnd < 0) continue;
    push(
      name,
      content.slice(objectStart, objectEnd + 1),
      content.slice(match.index, objectEnd + 1),
    );
  }
}

function readXmlTag(content: string, tagName: string): string | null {
  const pattern = new RegExp(
    `<${tagName}\\b[^>]*>([\\s\\S]*?)<\\/${tagName}>`,
    "i",
  );
  const match = pattern.exec(content);
  return match ? decodeBasicXmlEntities(match[1].trim()) : null;
}

function decodeBasicXmlEntities(value: string): string {
  return value
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function extractJsonCandidates(content: string): unknown[] {
  const candidates: unknown[] = [];
  const fencedJsonPattern =
    /\\?`\\?`\\?`(?:json|tool_call|tool|function)?\s*([\s\S]*?)\\?`\\?`\\?`/gi;
  let match: RegExpExecArray | null;

  while ((match = fencedJsonPattern.exec(content)) !== null) {
    const parsed = parseJsonCandidate(match[1]);
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  const trimmed = content.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const parsed = parseJsonCandidate(trimmed);
    if (parsed !== undefined) {
      candidates.push(parsed);
    }
  }

  if (candidates.length === 0) {
    for (const snippet of extractInlineJsonObjectSnippets(content)) {
      const parsed = parseJsonCandidate(snippet);
      if (parsed !== undefined) {
        candidates.push(parsed);
      }
    }
  }

  return candidates;
}

function extractInlineJsonObjectSnippets(content: string): string[] {
  const snippets: string[] = [];
  let searchStart = 0;

  while (
    snippets.length < MAX_RECOVERED_TEXT_TOOL_CALLS &&
    searchStart < content.length
  ) {
    const start = content.indexOf("{", searchStart);
    if (start < 0) {
      break;
    }

    const end = findBalancedJsonObjectEnd(content, start);
    if (end < 0) {
      break;
    }

    const snippet = content.slice(start, end + 1);
    if (/"(?:name|tool|tool_name)"\s*:/.test(snippet)) {
      snippets.push(snippet);
    }
    searchStart = end + 1;
  }

  return snippets;
}

function findBalancedJsonObjectEnd(content: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < content.length; index += 1) {
    const char = content[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return -1;
}

/**
 * The same textual call frequently parses through more than one recovery
 * stage (a <tool_call> body is also a balanced inline JSON object). One
 * textual request must never become two executions.
 */
function isDuplicateRecoveredToolCall(
  output: readonly ModelToolCall[],
  candidate: ModelToolCall,
): boolean {
  const fingerprint = JSON.stringify(candidate.arguments);
  return output.some(
    (existing) =>
      existing.name === candidate.name &&
      JSON.stringify(existing.arguments) === fingerprint,
  );
}

function parseJsonCandidate(value: string): unknown | undefined {
  try {
    return JSON.parse(value.trim());
  } catch {
    return undefined;
  }
}

function collectToolCallsFromJson(
  value: unknown,
  knownToolNames: ReadonlySet<string>,
  output: ModelToolCall[],
) {
  if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectToolCallsFromJson(item, knownToolNames, output);

      if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
        return;
      }
    }
    return;
  }

  if (!isRecord(value)) {
    return;
  }

  const directToolCall = parseToolCallRecord(value, knownToolNames, output.length);
  if (directToolCall) {
    if (!isDuplicateRecoveredToolCall(output, directToolCall)) {
      output.push(directToolCall);
    }
    return;
  }

  for (const nestedKey of ["tool_calls", "toolCalls", "tools", "calls"]) {
    collectToolCallsFromJson(value[nestedKey], knownToolNames, output);

    if (output.length >= MAX_RECOVERED_TEXT_TOOL_CALLS) {
      return;
    }
  }

  collectToolCallsFromJson(value.function, knownToolNames, output);
}

function parseToolCallRecord(
  value: Record<string, unknown>,
  knownToolNames: ReadonlySet<string>,
  index: number,
): ModelToolCall | null {
  const name = getRecoveredToolName(value);
  if (!name || !knownToolNames.has(name)) {
    return null;
  }

  return {
    name,
    arguments: normalizeRecoveredToolArguments(
      name,
      parseRecoveredToolArguments(value),
    ),
    index,
    raw: value,
  };
}

function parseRecoveredToolArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const args =
    value.arguments ??
    value.args ??
    value.parameters ??
    value.input;

  if (isRecord(args)) {
    return args;
  }

  if (typeof args === "string" && args.trim()) {
    const parsedArgs = parseJsonCandidate(args);
    if (isRecord(parsedArgs)) {
      return parsedArgs;
    }
  }

  return extractTopLevelRecoveredToolArguments(value);
}

function getRecoveredToolName(value: Record<string, unknown>): string | undefined {
  const direct =
    getString(value.name) ??
    getString(value.tool) ??
    getString(value.tool_name);
  if (direct) {
    return direct;
  }

  if (isRecord(value.function)) {
    return getString(value.function.name);
  }

  return undefined;
}

function extractTopLevelRecoveredToolArguments(
  value: Record<string, unknown>,
): Record<string, unknown> {
  const reservedKeys = new Set([
    "name",
    "tool",
    "tool_name",
    "arguments",
    "args",
    "parameters",
    "input",
    "function",
    "id",
    "index",
    "type",
  ]);
  const args: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!reservedKeys.has(key)) {
      args[key] = item;
    }
  }
  return args;
}

function normalizeRecoveredToolArguments(
  toolName: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  if (
    (toolName === "list_folder" || toolName === "get_path_info") &&
    args.path === "/"
  ) {
    return {
      ...args,
      path: "",
    };
  }

  return args;
}
