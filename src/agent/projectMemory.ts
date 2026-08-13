export interface ProjectMemoryLocation {
  memoryFolder: string;
  conversationPath: string;
  researchIndexPath: string;
  /** Cross-run tool outcome ledger; see `outcomeMemory.ts`. */
  toolOutcomePath: string;
  researchNotesFolder: string;
}

export interface ProjectMemoryLoadSnapshot {
  generation: number;
  location: ProjectMemoryLocation;
}

export interface ProjectMemoryAnchorCandidates {
  activeMarkdownPath?: string | null;
  recentMarkdownPath?: string | null;
  rememberedMarkdownPath?: string | null;
  openMarkdownPaths?: readonly string[];
}

const PROJECT_MEMORY_FOLDER = "Agent Memory";

export function getProjectMemoryLocation(
  activeFilePath: string | null,
): ProjectMemoryLocation {
  const projectRoot = getProjectRoot(activeFilePath);
  const memoryFolder = joinVaultPath(projectRoot, PROJECT_MEMORY_FOLDER);

  return {
    memoryFolder,
    conversationPath: joinVaultPath(memoryFolder, "conversation-history.json"),
    researchIndexPath: joinVaultPath(memoryFolder, "research-memory-index.json"),
    toolOutcomePath: joinVaultPath(memoryFolder, "tool-outcome-memory.json"),
    researchNotesFolder: joinVaultPath(memoryFolder, "Research"),
  };
}

/**
 * Keep project memory attached to the last intentional Markdown context while
 * a mission opens a Canvas or another non-Markdown leaf. Obsidian's generic
 * Markdown-leaf enumeration is not ordered by user intent, so an unrelated
 * open note is only a final fallback after the remembered note.
 */
export function resolveProjectMemoryAnchorPath(
  candidates: ProjectMemoryAnchorCandidates,
): string | null {
  for (const candidate of [
    candidates.activeMarkdownPath,
    candidates.recentMarkdownPath,
    candidates.rememberedMarkdownPath,
    ...(candidates.openMarkdownPaths ?? []),
  ]) {
    const normalized = candidate?.trim();
    if (normalized) {
      return normalized;
    }
  }
  return null;
}

/**
 * Latest-request-wins guard for asynchronous project-memory hydration.
 *
 * Obsidian can emit overlapping file-open and active-leaf-change events. A
 * completed read may update in-memory state only when no newer hydration has
 * started and the active note still resolves to the captured project.
 */
export function canApplyProjectMemoryLoad(
  snapshot: ProjectMemoryLoadSnapshot,
  latestGeneration: number,
  currentLocation: ProjectMemoryLocation,
): boolean {
  return (
    snapshot.generation === latestGeneration &&
    snapshot.location.conversationPath === currentLocation.conversationPath &&
    snapshot.location.researchIndexPath === currentLocation.researchIndexPath
  );
}

function getProjectRoot(activeFilePath: string | null): string {
  if (!activeFilePath?.trim()) {
    return "";
  }

  const normalized = activeFilePath.trim().replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }

  return normalized.slice(0, lastSlash);
}

function joinVaultPath(...parts: string[]): string {
  return parts
    .map((part) => part.trim().replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
}
