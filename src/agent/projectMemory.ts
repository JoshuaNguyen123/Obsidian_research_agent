export interface ProjectMemoryLocation {
  memoryFolder: string;
  conversationPath: string;
  researchIndexPath: string;
  researchNotesFolder: string;
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
