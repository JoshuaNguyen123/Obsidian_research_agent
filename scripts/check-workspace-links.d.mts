export const WORKSPACE_LINK_SCOPE: string;
export const WORKSPACE_LINK_REINSTALL_HINT: string;
export interface WorkspaceLink {
  name: string;
  resolved: string;
}
export function findStrayWorkspaceLinks(
  repoRoot: string,
  links: readonly WorkspaceLink[],
): WorkspaceLink[];
export function formatStrayWorkspaceLinkError(
  repoRoot: string,
  stray: readonly WorkspaceLink[],
): string;
export function readWorkspaceLinks(repoRoot: string): Promise<WorkspaceLink[]>;
export function validateWorkspaceLinks(repoRoot: string): Promise<void>;
