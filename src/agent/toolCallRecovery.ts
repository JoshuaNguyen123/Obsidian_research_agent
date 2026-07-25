import type {
  ModelChatResponse,
  ModelToolCall,
} from "../model/types";
import { getString, isRecord } from "./recordUtils";

const MAX_RECOVERED_TEXT_TOOL_CALLS = 4;

export function recoverToolCallsFromAssistantMessage(
  response: Pick<ModelChatResponse, "message" | "toolCalls">,
  knownToolNames: ReadonlySet<string>,
): ModelToolCall[] {
  if (response.toolCalls.length > 0) {
    return response.toolCalls;
  }

  return extractToolCallsFromAssistantText(
    response.message.content,
    knownToolNames,
  );
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
    output.push(directToolCall);
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
