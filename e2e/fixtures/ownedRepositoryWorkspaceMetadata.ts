import {
  lstat,
  opendir,
  readFile,
  realpath,
  rm,
} from "node:fs/promises";
import path from "node:path";

import {
  parseWorkspaceManifestV2,
  type WorkspaceManifestV2,
} from "../../extensions/code/workspaces/WorkspaceManifestV2";

export const OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1 = Object.freeze({
  maxDirectEntries: 4_096,
  maxManifestBytes: 2 * 1024 * 1024,
  maxTotalManifestBytes: 64 * 1024 * 1024,
  maxContainerTreeEntries: 50_000,
});

export interface OwnedRepositoryWorkspaceMetadataSelectionV1 {
  workspaceId: string;
  containerPath: string;
  manifestPath: string;
  worktreeRoot: string;
}

export interface OwnedRepositoryWorkspaceMetadataInventoryV1 {
  version: 1;
  /**
   * The AgenticResearcher application-data directory. The code extension owns
   * only the `code/` child beneath this boundary.
   */
  applicationDataRoot: string;
  repositoryRoot: string;
  codeRoot: string;
  metadataRoot: string;
  worktreeParent: string;
  inspectedDirectEntries: number;
  inspectedContainers: number;
  inspectedManifestBytes: number;
  selected: OwnedRepositoryWorkspaceMetadataSelectionV1[];
}

export interface OwnedRepositoryWorkspaceMetadataCleanupProofV1 {
  version: 1;
  applicationDataRoot: string;
  repositoryRoot: string;
  selectedWorkspaceIds: string[];
  removedMetadataContainers: string[];
  repositoryRootAbsent: true;
  worktreeAbsence: Array<{
    workspaceId: string;
    worktreeRoot: string;
    absent: true;
  }>;
  survivingWorkspaceIds: string[];
  selectedSurvivorCount: 0;
  absenceVerified: true;
}

/**
 * Inventories only direct workspace-metadata children and selects repository
 * manifests bound to one exact disposable source checkout. It never mutates
 * the source repository, worktrees, or metadata.
 */
export async function inventoryOwnedRepositoryWorkspaceMetadata(input: {
  applicationDataRoot: string;
  repositoryRoot: string;
}): Promise<OwnedRepositoryWorkspaceMetadataInventoryV1> {
  const applicationDataRoot = absoluteNonRootPath(
    input.applicationDataRoot,
    "application-data root",
  );
  const repositoryRoot = absoluteNonRootPath(
    input.repositoryRoot,
    "source repository root",
  );
  await requireRealDirectory(applicationDataRoot, "application-data root");
  await requireAbsentOrRealDirectory(
    repositoryRoot,
    "source repository root",
  );

  const codeRoot = exactChild(applicationDataRoot, "code");
  const metadataRoot = exactChild(codeRoot, "workspaces-v2");
  const worktreeParent = exactChild(codeRoot, "repository-worktrees");
  const codeExists = await requireAbsentOrRealDirectory(
    codeRoot,
    "code application-data root",
  );
  if (codeExists) {
    await requireAbsentOrRealDirectory(
      worktreeParent,
      "repository worktree parent",
    );
  }
  const metadataExists = codeExists
    ? await requireAbsentOrRealDirectory(
        metadataRoot,
        "workspace metadata root",
      )
    : false;

  const baseInventory = {
    version: 1 as const,
    applicationDataRoot,
    repositoryRoot,
    codeRoot,
    metadataRoot,
    worktreeParent,
  };
  if (!metadataExists) {
    return {
      ...baseInventory,
      inspectedDirectEntries: 0,
      inspectedContainers: 0,
      inspectedManifestBytes: 0,
      selected: [],
    };
  }

  const entries = await readBoundedDirectory(
    metadataRoot,
    OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxDirectEntries,
    "workspace metadata inventory",
  );
  let inspectedContainers = 0;
  let inspectedManifestBytes = 0;
  const selected: OwnedRepositoryWorkspaceMetadataSelectionV1[] = [];

  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (entry.isSymbolicLink()) {
      throw new Error(
        `Workspace metadata inventory refuses linked entry: ${entry.name}.`,
      );
    }
    if (!entry.isDirectory()) continue;
    inspectedContainers += 1;
    const containerPath = exactChild(metadataRoot, entry.name);
    await requireRealDirectory(
      containerPath,
      `workspace metadata container ${entry.name}`,
    );
    const manifestPath = exactChild(containerPath, "manifest.v2.json");
    const manifestStat = await lstatOrNull(manifestPath);
    if (
      !manifestStat ||
      manifestStat.isSymbolicLink() ||
      !manifestStat.isFile()
    ) {
      throw new Error(
        `Workspace metadata container ${entry.name} has no safe manifest.v2.json.`,
      );
    }
    const canonicalManifestPath = await realpath(manifestPath);
    if (!samePath(canonicalManifestPath, manifestPath)) {
      throw new Error(
        `Workspace metadata manifest escaped container ${entry.name}.`,
      );
    }
    if (
      manifestStat.size >
      OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxManifestBytes
    ) {
      throw new Error(
        `Workspace metadata manifest exceeded its byte bound: ${entry.name}.`,
      );
    }
    const loadedManifest = await readWorkspaceManifest(
      manifestPath,
      entry.name,
    );
    inspectedManifestBytes += loadedManifest.byteLength;
    if (
      inspectedManifestBytes >
      OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxTotalManifestBytes
    ) {
      throw new Error(
        "Workspace metadata inventory exceeded its total manifest byte bound.",
      );
    }

    const manifest = loadedManifest.manifest;
    if (manifest.kind !== "repository" || !manifest.repositoryBinding) {
      continue;
    }
    if (
      !samePath(
        normalizedAbsolutePath(
          manifest.repositoryBinding.repositoryRoot,
          `repository binding for ${entry.name}`,
        ),
        repositoryRoot,
      )
    ) {
      continue;
    }

    assertMatchingOwnedManifest({
      manifest,
      containerName: entry.name,
      worktreeParent,
    });
    const worktreeRoot = normalizedAbsolutePath(
      manifest.repositoryBinding.worktreeRoot,
      `worktree root for ${entry.name}`,
    );
    await requireAbsentOrRealDirectory(
      worktreeRoot,
      `repository worktree ${entry.name}`,
    );
    selected.push({
      workspaceId: manifest.workspaceId,
      containerPath,
      manifestPath,
      worktreeRoot,
    });
  }

  selected.sort((left, right) =>
    left.workspaceId.localeCompare(right.workspaceId),
  );
  return {
    ...baseInventory,
    inspectedDirectEntries: entries.length,
    inspectedContainers,
    inspectedManifestBytes,
    selected,
  };
}

/**
 * Removes only metadata selected by a prior inventory. The caller must first
 * remove the exact disposable source repository and every selected worktree.
 * This helper proves those paths absent, revalidates the inventory, removes
 * metadata containers, and performs a final zero-survivor readback.
 */
export async function cleanupOwnedRepositoryWorkspaceMetadata(
  inventory: OwnedRepositoryWorkspaceMetadataInventoryV1,
): Promise<OwnedRepositoryWorkspaceMetadataCleanupProofV1> {
  assertInventoryContract(inventory);
  const current = await inventoryOwnedRepositoryWorkspaceMetadata({
    applicationDataRoot: inventory.applicationDataRoot,
    repositoryRoot: inventory.repositoryRoot,
  });
  assertSameSelection(inventory.selected, current.selected);

  await requirePathAbsent(
    current.repositoryRoot,
    "source repository root",
  );
  const worktreeAbsence: OwnedRepositoryWorkspaceMetadataCleanupProofV1["worktreeAbsence"] =
    [];
  for (const selection of current.selected) {
    await requirePathAbsent(
      selection.worktreeRoot,
      `repository worktree ${selection.workspaceId}`,
    );
    worktreeAbsence.push({
      workspaceId: selection.workspaceId,
      worktreeRoot: selection.worktreeRoot,
      absent: true,
    });
  }

  const removedMetadataContainers: string[] = [];
  for (const selection of current.selected) {
    await assertSafeMetadataContainerTree(selection);
    await rm(selection.containerPath, { recursive: true, force: false });
    await requirePathAbsent(
      selection.containerPath,
      `workspace metadata container ${selection.workspaceId}`,
    );
    removedMetadataContainers.push(selection.containerPath);
  }

  const readback = await inventoryOwnedRepositoryWorkspaceMetadata({
    applicationDataRoot: current.applicationDataRoot,
    repositoryRoot: current.repositoryRoot,
  });
  const survivingWorkspaceIds = readback.selected.map(
    (selection) => selection.workspaceId,
  );
  if (survivingWorkspaceIds.length > 0) {
    throw new Error(
      `Owned repository workspace metadata survived cleanup: ${survivingWorkspaceIds.join(", ")}.`,
    );
  }

  return {
    version: 1,
    applicationDataRoot: current.applicationDataRoot,
    repositoryRoot: current.repositoryRoot,
    selectedWorkspaceIds: current.selected.map(
      (selection) => selection.workspaceId,
    ),
    removedMetadataContainers,
    repositoryRootAbsent: true,
    worktreeAbsence,
    survivingWorkspaceIds,
    selectedSurvivorCount: 0,
    absenceVerified: true,
  };
}

function assertMatchingOwnedManifest(input: {
  manifest: WorkspaceManifestV2;
  containerName: string;
  worktreeParent: string;
}): void {
  const { manifest, containerName, worktreeParent } = input;
  if (manifest.workspaceId !== containerName) {
    throw new Error(
      `Owned workspace id does not equal metadata container basename: ${containerName}.`,
    );
  }
  const binding = manifest.repositoryBinding;
  if (!binding) {
    throw new Error(
      `Owned repository workspace has no repository binding: ${containerName}.`,
    );
  }
  const canonicalRoot = assertDirectManagedWorktree(
    manifest.canonicalRoot,
    worktreeParent,
    manifest.workspaceId,
    "canonical root",
  );
  const worktreeRoot = assertDirectManagedWorktree(
    binding.worktreeRoot,
    worktreeParent,
    manifest.workspaceId,
    "worktree root",
  );
  if (!samePath(canonicalRoot, worktreeRoot)) {
    throw new Error(
      `Owned workspace canonical and worktree roots mismatch: ${containerName}.`,
    );
  }
}

function assertDirectManagedWorktree(
  value: string,
  worktreeParent: string,
  workspaceId: string,
  label: string,
): string {
  const resolved = normalizedAbsolutePath(
    value,
    `${label} for ${workspaceId}`,
  );
  const relative = path.relative(worktreeParent, resolved);
  if (
    !relative ||
    relative.startsWith("..") ||
    path.isAbsolute(relative) ||
    relative.includes(path.sep) ||
    !samePath(path.dirname(resolved), worktreeParent) ||
    path.basename(resolved) !== workspaceId ||
    relative !== workspaceId
  ) {
    throw new Error(
      `Owned workspace ${label} is not the exact direct repository-worktrees child for ${workspaceId}.`,
    );
  }
  return resolved;
}

async function readWorkspaceManifest(
  manifestPath: string,
  containerName: string,
): Promise<{ manifest: WorkspaceManifestV2; byteLength: number }> {
  const bytes = await readFile(manifestPath);
  if (
    bytes.byteLength >
    OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxManifestBytes
  ) {
    throw new Error(
      `Workspace metadata manifest exceeded its byte bound: ${containerName}.`,
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return {
      manifest: parseWorkspaceManifestV2(JSON.parse(text)),
      byteLength: bytes.byteLength,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Workspace metadata manifest is invalid for ${containerName}: ${message}`,
    );
  }
}

function assertInventoryContract(
  inventory: OwnedRepositoryWorkspaceMetadataInventoryV1,
): void {
  if (
    !inventory ||
    inventory.version !== 1 ||
    !Array.isArray(inventory.selected)
  ) {
    throw new Error("Unsupported owned repository workspace metadata inventory.");
  }
  const applicationDataRoot = absoluteNonRootPath(
    inventory.applicationDataRoot,
    "inventory application-data root",
  );
  const repositoryRoot = absoluteNonRootPath(
    inventory.repositoryRoot,
    "inventory repository root",
  );
  const codeRoot = exactChild(applicationDataRoot, "code");
  const metadataRoot = exactChild(codeRoot, "workspaces-v2");
  const worktreeParent = exactChild(codeRoot, "repository-worktrees");
  if (
    !samePath(inventory.codeRoot, codeRoot) ||
    !samePath(inventory.metadataRoot, metadataRoot) ||
    !samePath(inventory.worktreeParent, worktreeParent) ||
    !samePath(inventory.repositoryRoot, repositoryRoot)
  ) {
    throw new Error(
      "Owned repository workspace metadata inventory boundary is inconsistent.",
    );
  }
  if (
    inventory.selected.length >
    OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxDirectEntries
  ) {
    throw new Error(
      "Owned repository workspace metadata selection is oversized.",
    );
  }
  const workspaceIds = new Set<string>();
  for (const selection of inventory.selected) {
    if (
      !selection ||
      typeof selection.workspaceId !== "string" ||
      typeof selection.containerPath !== "string" ||
      typeof selection.manifestPath !== "string" ||
      typeof selection.worktreeRoot !== "string"
    ) {
      throw new Error(
        "Owned repository workspace metadata selection is invalid.",
      );
    }
    if (workspaceIds.has(selection.workspaceId)) {
      throw new Error(
        "Owned repository workspace metadata selection contains duplicate ids.",
      );
    }
    workspaceIds.add(selection.workspaceId);
    const expectedContainer = exactChild(
      metadataRoot,
      selection.workspaceId,
    );
    const expectedManifest = exactChild(
      expectedContainer,
      "manifest.v2.json",
    );
    if (
      selection.containerPath !== expectedContainer ||
      selection.manifestPath !== expectedManifest
    ) {
      throw new Error(
        `Owned repository workspace metadata selection escaped its boundary: ${selection.workspaceId}.`,
      );
    }
    assertDirectManagedWorktree(
      selection.worktreeRoot,
      worktreeParent,
      selection.workspaceId,
      "inventory worktree root",
    );
  }
}

function assertSameSelection(
  expected: readonly OwnedRepositoryWorkspaceMetadataSelectionV1[],
  actual: readonly OwnedRepositoryWorkspaceMetadataSelectionV1[],
): void {
  const identities = (
    selections: readonly OwnedRepositoryWorkspaceMetadataSelectionV1[],
  ) =>
    [...selections]
      .map((selection) =>
        [
          selection.workspaceId,
          comparablePath(selection.containerPath),
          comparablePath(selection.manifestPath),
          comparablePath(selection.worktreeRoot),
        ].join("\n"),
      )
      .sort();
  const expectedIdentities = identities(expected);
  const actualIdentities = identities(actual);
  if (
    expectedIdentities.length !== actualIdentities.length ||
    expectedIdentities.some(
      (identity, index) => identity !== actualIdentities[index],
    )
  ) {
    throw new Error(
      "Owned repository workspace metadata inventory changed before cleanup.",
    );
  }
}

async function assertSafeMetadataContainerTree(
  selection: OwnedRepositoryWorkspaceMetadataSelectionV1,
): Promise<void> {
  await requireRealDirectory(
    selection.containerPath,
    `workspace metadata container ${selection.workspaceId}`,
  );
  const pending = [selection.containerPath];
  let entryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readBoundedDirectory(
      directory,
      OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1
        .maxContainerTreeEntries - entryCount,
      `workspace metadata tree ${selection.workspaceId}`,
    );
    entryCount += entries.length;
    if (
      entryCount >
      OWNED_REPOSITORY_WORKSPACE_METADATA_LIMITS_V1.maxContainerTreeEntries
    ) {
      throw new Error(
        `Workspace metadata container tree is oversized: ${selection.workspaceId}.`,
      );
    }
    for (const entry of entries) {
      const child = exactChild(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `Workspace metadata cleanup refuses linked content: ${selection.workspaceId}/${entry.name}.`,
        );
      }
      if (entry.isDirectory()) {
        await requireRealDirectory(
          child,
          `workspace metadata directory ${selection.workspaceId}/${entry.name}`,
        );
        pending.push(child);
      } else if (!entry.isFile()) {
        throw new Error(
          `Workspace metadata cleanup refuses non-regular content: ${selection.workspaceId}/${entry.name}.`,
        );
      }
    }
  }
}

async function readBoundedDirectory(
  directory: string,
  maxEntries: number,
  label: string,
) {
  if (maxEntries < 0) {
    throw new Error(`${label} exceeded its entry bound.`);
  }
  const handle = await opendir(directory);
  const entries = [];
  for await (const entry of handle) {
    entries.push(entry);
    if (entries.length > maxEntries) {
      throw new Error(`${label} exceeded its entry bound.`);
    }
  }
  return entries;
}

async function requireRealDirectory(
  value: string,
  label: string,
): Promise<void> {
  const stat = await lstatOrNull(value);
  if (!stat) throw new Error(`${label} does not exist.`);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real, non-linked directory.`);
  }
  const canonical = await realpath(value);
  if (!samePath(canonical, value)) {
    throw new Error(`${label} resolves through an alias or escape.`);
  }
}

async function requireAbsentOrRealDirectory(
  value: string,
  label: string,
): Promise<boolean> {
  const stat = await lstatOrNull(value);
  if (!stat) return false;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be absent or a real, non-linked directory.`);
  }
  const canonical = await realpath(value);
  if (!samePath(canonical, value)) {
    throw new Error(`${label} resolves through an alias or escape.`);
  }
  return true;
}

async function requirePathAbsent(value: string, label: string): Promise<void> {
  if (await lstatOrNull(value)) {
    throw new Error(
      `${label} must be independently removed and proven absent before metadata cleanup.`,
    );
  }
}

async function lstatOrNull(value: string) {
  return lstat(value).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? null : Promise.reject(error),
  );
}

function absoluteNonRootPath(value: string, label: string): string {
  const resolved = normalizedAbsolutePath(value, label);
  if (resolved === path.parse(resolved).root) {
    throw new Error(`${label} cannot be a filesystem root.`);
  }
  return resolved;
}

function normalizedAbsolutePath(value: string, label: string): string {
  if (typeof value !== "string" || !path.isAbsolute(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  if (/[\0\r\n]/u.test(value)) {
    throw new Error(`${label} contains invalid characters.`);
  }
  return path.resolve(value);
}

function exactChild(parent: string, basename: string): string {
  if (
    !basename ||
    basename === "." ||
    basename === ".." ||
    path.basename(basename) !== basename
  ) {
    throw new Error("Workspace metadata child basename is invalid.");
  }
  const child = path.resolve(parent, basename);
  const relative = path.relative(parent, child);
  if (
    relative !== basename ||
    path.dirname(child) !== parent ||
    path.isAbsolute(relative) ||
    relative.startsWith("..")
  ) {
    throw new Error("Workspace metadata child escaped its parent.");
  }
  return child;
}

function samePath(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function comparablePath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}
