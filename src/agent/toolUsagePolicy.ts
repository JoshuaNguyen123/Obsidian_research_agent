/**
 * Compact repo-adapted tool usage policy for system prompt assembly.
 * Not the generic CRM context pack — Obsidian compound tools only.
 */

export const TOOL_USAGE_POLICY_MAX_CHARS = 2000;

export const TOOL_USAGE_POLICY = `TOOL USAGE POLICY (host):
- Call only tools listed on this turn's HOST ROUTING CARD / frontier. Exact names only.
- Pre-call: Intent → Need → Selection → Args match schema → Auth/effect class → Sequence → Risk.
- Prefer read/search before write when the target path, issue id, workspaceId, or SHA is unknown.
- Draft/advice ≠ execute. Note append/replace, Linear create, code commit, GitHub publish/merge need explicit mission intent.
- Never invent: vault paths, Linear issue ids, workspaceId, commit SHA, GitHub repo names, enum actions.
- If a required arg is missing: call the listed read/status tool first; do not guess.
- After a tool result: treat it as source of truth; use returned ids/paths/SHAs in the next call.
- On reject: read the error; fix only that issue; do not repeat the same invalid call; prefer Preferred next.
- Compound sequence (when those stages are in plan):
  research note → Linear create/get → code_workspace_create → edit → validate_fast → repair →
  validate_targeted/full → code_commit_verified (host git add+commit) →
  ask public-or-private → github_create_repository with that exact choice → publish_verified_code_to_github publish_draft →
  write_project_results (or append_jupyter_reflection for an explicit notebook). In compound missions, Linear phase updates are host-projected from verified receipts; use report_progress_to_linear only for an explicit standalone progress request.
- Do not invent git_*, verify_all, patch, send_email, or tools not listed.`;

if (TOOL_USAGE_POLICY.length > TOOL_USAGE_POLICY_MAX_CHARS) {
  throw new Error(
    `TOOL_USAGE_POLICY exceeds ${TOOL_USAGE_POLICY_MAX_CHARS} chars (${TOOL_USAGE_POLICY.length}).`,
  );
}
