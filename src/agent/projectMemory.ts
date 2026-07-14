export interface ProjectMemoryLocation {
  memoryFolder: string;
  conversationPath: string;
  researchIndexPath: string;
  researchNotesFolder: string;
}

export interface ProjectMemoryLoadSnapshot {
  generation: number;
  location: ProjectMemoryLocation;
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
    researchNotesFolder: joinVaultPath(memoryFolder, "Research"),
  };
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
