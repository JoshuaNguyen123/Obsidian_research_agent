export interface ProjectMemoryLocation {
  memoryFolder: string;
  conversationPath: string;
  researchIndexPath: string;
  /**
   * Folder-scoped tool outcome ledger. Read for migration only; new
   * observations go to {@link vaultToolOutcomePath}.
   */
  toolOutcomePath: string;
  researchNotesFolder: string;
  /** Vault-wide memory folder, independent of the active note's parent. */
  vaultMemoryFolder: string;
  /**
   * Vault-wide tool outcome ledger; see `outcomeMemory.ts`.
   *
   * Everything else here is deliberately scoped to the active note's folder:
   * a conversation and a research index belong to the project being worked on.
   * "which tools keep failing, and how" does not. It is a property of the
   * vault, the machine, and the configured providers, and scoping it by folder
   * meant a research mission run from `Projects/CRDT/` taught the agent
   * nothing a later coding mission run from `Desktop notes/` could use --
   * every folder relearned the same failures from scratch.
   *
   * The records are counters keyed by tool name, error code, and a coarse
   * target kind, and carry no paths or URLs by construction, so promoting them
   * to vault scope moves no vault structure between projects.
   */
  vaultToolOutcomePath: string;
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
  const vaultMemoryFolder = joinVaultPath(PROJECT_MEMORY_FOLDER);

  return {
    memoryFolder,
    conversationPath: joinVaultPath(memoryFolder, "conversation-history.json"),
    researchIndexPath: joinVaultPath(memoryFolder, "research-memory-index.json"),
    toolOutcomePath: joinVaultPath(memoryFolder, "tool-outcome-memory.json"),
    researchNotesFolder: joinVaultPath(memoryFolder, "Research"),
    vaultMemoryFolder,
    vaultToolOutcomePath: joinVaultPath(
      vaultMemoryFolder,
      "tool-outcome-memory.json",
    ),
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
