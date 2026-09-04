export const WORKSPACE_LINK_SCOPE: string;
export const WORKSPACE_LINK_REINSTALL_HINT: string;
export interface WorkspaceLink {
  name: string;
  resolved: string;
}
export interface ResolvedWorkspacePackages {
  /** Packages the bundler would resolve, sorted by name. */
  resolved: WorkspaceLink[];
  /** Declared packages installed nowhere on the resolution walk. */
  unresolved: string[];
}
export function findStrayWorkspaceLinks(
  repoRoot: string,
  links: readonly WorkspaceLink[],
): WorkspaceLink[];
export function formatStrayWorkspaceLinkError(
  repoRoot: string,
  stray: readonly WorkspaceLink[],
): string;
export function nodeModulesSearchPaths(fromDir: string): string[];
export function readWorkspacePackageNames(repoRoot: string): Promise<string[]>;
export function resolveWorkspacePackages(
  repoRoot: string,
): Promise<ResolvedWorkspacePackages>;
export function readWorkspaceLinks(repoRoot: string): Promise<WorkspaceLink[]>;
export function validateWorkspaceLinks(
  repoRoot: string,
): Promise<ResolvedWorkspacePackages>;
