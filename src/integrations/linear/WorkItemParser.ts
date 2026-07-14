import {
  WORK_ITEM_CONTRACT_END,
  WORK_ITEM_CONTRACT_START,
  WORK_ITEM_CONTRACT_V2_END,
  WORK_ITEM_CONTRACT_V2_START,
} from "./WorkItemRenderer";
import {
  parseWorkItemSpecV1,
  WorkItemContractError,
  type WorkItemSpecV1,
} from "./WorkItemSpecV1";
import {
  parseWorkItemSpecV2,
  type ParsedCompatibleWorkItemSpec,
  type WorkItemSpecV2,
} from "./WorkItemSpecV2";

export interface ParsedWorkItemV1 {
  spec: WorkItemSpecV1;
  contractStart: number;
  contractEnd: number;
}

export interface ParsedWorkItemV2 {
  spec: WorkItemSpecV2;
  contractStart: number;
  contractEnd: number;
}

export interface ParsedCompatibleWorkItem {
  spec: ParsedCompatibleWorkItemSpec;
  contractStart: number;
  contractEnd: number;
}

export function parseRenderedWorkItemSpecV1(markdown: string): ParsedWorkItemV1 {
  if (typeof markdown !== "string" || markdown.length > 200_000) {
    throw new WorkItemContractError(
      "Linear work item description must be a string no longer than 200,000 characters.",
    );
  }
  const starts = findOccurrences(markdown, WORK_ITEM_CONTRACT_START);
  const ends = findOccurrences(markdown, WORK_ITEM_CONTRACT_END);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new WorkItemContractError(
      "Linear work item description must contain exactly one complete v1 contract block.",
    );
  }
  const contentStart = starts[0] + WORK_ITEM_CONTRACT_START.length;
  const rawBlock = markdown.slice(contentStart, ends[0]).trim();
  const match = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/.exec(rawBlock);
  if (!match) {
    throw new WorkItemContractError(
      "Work item contract must be one fenced JSON document.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    throw new WorkItemContractError("Work item contract contains invalid JSON.");
  }
  return {
    spec: parseWorkItemSpecV1(parsed),
    contractStart: starts[0],
    contractEnd: ends[0] + WORK_ITEM_CONTRACT_END.length,
  };
}

export function tryParseRenderedWorkItemSpecV1(
  markdown: string,
): ParsedWorkItemV1 | null {
  try {
    return parseRenderedWorkItemSpecV1(markdown);
  } catch {
    return null;
  }
}

export function parseRenderedWorkItemSpecV2(markdown: string): ParsedWorkItemV2 {
  const parsed = parseContractBlock(
    markdown,
    WORK_ITEM_CONTRACT_V2_START,
    WORK_ITEM_CONTRACT_V2_END,
    "v2",
  );
  return { ...parsed, spec: parseWorkItemSpecV2(parsed.value) };
}

export function tryParseRenderedWorkItemSpecV2(markdown: string): ParsedWorkItemV2 | null {
  try {
    return parseRenderedWorkItemSpecV2(markdown);
  } catch {
    return null;
  }
}

/** Parse one and only one supported machine contract, rejecting mixed-version blocks. */
export function parseRenderedCompatibleWorkItemSpec(
  markdown: string,
): ParsedCompatibleWorkItem {
  assertMarkdown(markdown);
  const v1Starts = findOccurrences(markdown, WORK_ITEM_CONTRACT_START);
  const v1Ends = findOccurrences(markdown, WORK_ITEM_CONTRACT_END);
  const v2Starts = findOccurrences(markdown, WORK_ITEM_CONTRACT_V2_START);
  const v2Ends = findOccurrences(markdown, WORK_ITEM_CONTRACT_V2_END);
  const isV1 = v1Starts.length === 1 && v1Ends.length === 1 &&
    v2Starts.length === 0 && v2Ends.length === 0;
  const isV2 = v2Starts.length === 1 && v2Ends.length === 1 &&
    v1Starts.length === 0 && v1Ends.length === 0;
  if (isV1) {
    return parseRenderedWorkItemSpecV1(markdown);
  }
  if (isV2) {
    return parseRenderedWorkItemSpecV2(markdown);
  }
  throw new WorkItemContractError(
    "Linear work item description must contain exactly one supported contract block.",
  );
}

export function tryParseRenderedCompatibleWorkItemSpec(
  markdown: string,
): ParsedCompatibleWorkItem | null {
  try {
    return parseRenderedCompatibleWorkItemSpec(markdown);
  } catch {
    return null;
  }
}

function parseContractBlock(
  markdown: string,
  startMarker: string,
  endMarker: string,
  version: string,
): { value: unknown; contractStart: number; contractEnd: number } {
  assertMarkdown(markdown);
  const starts = findOccurrences(markdown, startMarker);
  const ends = findOccurrences(markdown, endMarker);
  if (starts.length !== 1 || ends.length !== 1 || ends[0] <= starts[0]) {
    throw new WorkItemContractError(
      `Linear work item description must contain exactly one complete ${version} contract block.`,
    );
  }
  const contentStart = starts[0] + startMarker.length;
  const rawBlock = markdown.slice(contentStart, ends[0]).trim();
  const match = /^```json\s*\r?\n([\s\S]*?)\r?\n```$/.exec(rawBlock);
  if (!match) {
    throw new WorkItemContractError("Work item contract must be one fenced JSON document.");
  }
  let value: unknown;
  try {
    value = JSON.parse(match[1]);
  } catch {
    throw new WorkItemContractError("Work item contract contains invalid JSON.");
  }
  return {
    value,
    contractStart: starts[0],
    contractEnd: ends[0] + endMarker.length,
  };
}

function assertMarkdown(markdown: string): void {
  if (typeof markdown !== "string" || markdown.length > 200_000) {
    throw new WorkItemContractError(
      "Linear work item description must be a string no longer than 200,000 characters.",
    );
  }
}

function findOccurrences(value: string, needle: string): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset < value.length) {
    const index = value.indexOf(needle, offset);
    if (index < 0) {
      break;
    }
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}
