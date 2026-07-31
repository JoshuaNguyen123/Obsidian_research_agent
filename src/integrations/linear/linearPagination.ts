import type { LinearToolClient } from "./LinearTools";
import type { LinearBaseRecord, LinearPage, LinearRequestOptions } from "./types";

/**
 * Bounded cursor pagination over a Linear list operation.
 *
 * The GraphQL layer has supported cursors end to end since it was written —
 * every list document declares `$after` and selects `pageInfo` — but no caller
 * ever followed one. Every collection read therefore saw only the first page
 * (50 records, the server clamp), which is how a workspace past 50 projects
 * could fail to find an existing project and create a duplicate.
 *
 * `maxPages` is a hard cap, not a target: one page is still one request, and
 * the cap exists so a pathological workspace cannot turn a lookup into an
 * unbounded crawl. Callers receive `truncated` and must treat "not found" as
 * "not found within the cap" when it is true.
 */
export interface LinearPageSweepResult {
  items: LinearBaseRecord[];
  /** True when the cap stopped the sweep while the server had more pages. */
  truncated: boolean;
  pagesFetched: number;
}

export async function listAllLinearPages(
  client: LinearToolClient,
  operationKey: string,
  variables: Record<string, unknown>,
  options?: LinearRequestOptions,
  { maxPages = 5 }: { maxPages?: number } = {},
): Promise<LinearPageSweepResult> {
  const cap = Math.max(1, Math.trunc(maxPages));
  const items: LinearBaseRecord[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let after: string | undefined;
  let pagesFetched = 0;
  let truncated = false;

  for (let page = 0; page < cap; page += 1) {
    const output = await client.execute(
      operationKey,
      { ...variables, ...(after ? { after } : {}) },
      options,
    );
    if (!isLinearPage(output)) break;
    pagesFetched += 1;
    for (const item of output.items) {
      // Cursor pagination over a live workspace can repeat a record when rows
      // shift between requests; ids are stable, so dedupe on them.
      if (item.id && seenIds.has(item.id)) continue;
      if (item.id) seenIds.add(item.id);
      items.push(item);
    }
    if (!output.pageInfo?.hasNextPage) {
      return { items, truncated: false, pagesFetched };
    }
    const cursor = output.pageInfo.endCursor;
    // A server claiming more pages without a cursor — or repeating one — would
    // loop forever; treat both as the end of what can be safely fetched.
    if (!cursor || seenCursors.has(cursor)) {
      truncated = true;
      break;
    }
    seenCursors.add(cursor);
    after = cursor;
    truncated = true;
  }

  return { items, truncated, pagesFetched };
}

function isLinearPage(value: unknown): value is LinearPage<LinearBaseRecord> {
  return (
    !!value &&
    typeof value === "object" &&
    Array.isArray((value as LinearPage<LinearBaseRecord>).items)
  );
}
