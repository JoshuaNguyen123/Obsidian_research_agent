import {
  WORK_ITEM_CONTRACT_END,
  WORK_ITEM_CONTRACT_START,
} from "./WorkItemRenderer";
import {
  parseWorkItemSpecV1,
  WorkItemContractError,
  type WorkItemSpecV1,
} from "./WorkItemSpecV1";

export interface ParsedWorkItemV1 {
  spec: WorkItemSpecV1;
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
