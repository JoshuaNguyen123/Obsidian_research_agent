import type { PreparedAction, ToolDescriptor } from "./actions";

/**
 * Tools whose one call can make different kinds of change, so the kind is
 * known only once the call is prepared. `code_workspace_apply_patch` (CODE-7)
 * edits, adds, renames and deletes files in one diff; its prepared action
 * names the kind as `preview.after.operation`: `trash` when the patch deletes
 * a file, else `move` when it renames one, else `create` when it only adds,
 * else `update`. The prepared action is the tool's own, fingerprinted, and
 * what the person approves.
 */
const PREPARED_KIND_TOOLS_V1: ReadonlySet<string> = new Set(["code_workspace_apply_patch"]);

/**
 * The descriptor a prepared action is judged by (CODE-7, 4b). For every tool
 * but the ones above this is the registry's descriptor unchanged. For those,
 * it is the descriptor of the single-file tool the prepared kind matches, so
 * policy, write autonomy, grants and approvals decide a patch as they would
 * decide that change made alone:
 *
 *   - `trash` (the patch deletes a file) is a destructive, high-risk change,
 *     as `code_workspace_trash` is: it always asks for an exact approval, no
 *     standing or run grant covers it, and no prompt-derived grant either, so
 *     write autonomy and set-loose never pass it;
 *   - `move` (it renames one) asks as `code_workspace_move` does, since write
 *     autonomy takes only replace, append, update and create;
 *   - `create` and `update` stay as they are under write autonomy.
 *
 * A kind the tool did not name is read as `trash`: an unknown change asks.
 * Applying this twice gives the same descriptor.
 */
export function descriptorForPreparedActionV1<T extends ToolDescriptor | null | undefined>(
  descriptor: T,
  action: PreparedAction | null | undefined,
): T {
  if (!descriptor || !PREPARED_KIND_TOOLS_V1.has(descriptor.name) || !action) return descriptor;
  const after = action.preview?.after;
  const kind =
    action.toolName === descriptor.name && after && typeof after === "object"
      ? (after as Record<string, unknown>).operation
      : undefined;
  if (kind === "update" || kind === "create" || kind === "move") {
    return {
      ...descriptor,
      capability: { ...descriptor.capability, action: kind },
    } as T;
  }
  return {
    ...descriptor,
    capability: { ...descriptor.capability, action: "trash" },
    effect: "destructive_mutation",
    risk: "high",
    approval: {
      ...descriptor.approval,
      allowPromptGrant: false,
      allowPersistentGrant: false,
    },
  } as T;
}
