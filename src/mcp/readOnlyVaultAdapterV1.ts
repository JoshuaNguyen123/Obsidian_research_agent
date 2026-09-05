import * as fs from "node:fs";
import * as path from "node:path";
import type { App } from "obsidian";

/**
 * An Obsidian-shaped, read-only view of a vault directory.
 *
 * The retrieval stack — the sharded index, the hybrid scorer, the rerank stage
 * — is written against `app.vault`, not against Obsidian. Everything it needs
 * from the vault is reading: list the markdown files, read one, look a path up.
 * That surface is small enough to satisfy from the filesystem, which is what
 * lets the same code answer a query outside the plugin without a second
 * implementation of the search.
 *
 * Read-only is enforced here rather than promised. Every mutating method of
 * the vault surface throws, so a caller that tries to rebuild the index or
 * write a note through this adapter fails loudly at the call instead of
 * quietly modifying someone's vault from a process they exposed to another
 * application.
 *
 * Two containment rules, both checked on every access:
 *
 * - every resolved path must stay inside the vault root after symlink
 *   resolution, so a symlink in the vault cannot read the rest of the disk;
 * - dotfolders are skipped entirely, which keeps `.obsidian` (workspace
 *   layout, plugin settings, and any API keys stored in them) out of the file
 *   listing.
 */

export class ReadOnlyVaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyVaultError";
  }
}

export interface AdaptedVaultFileV1 {
  path: string;
  name: string;
  basename: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
}

const READ_ONLY = (operation: string) => () => {
  throw new ReadOnlyVaultError(
    `${operation} is not available: this vault is open read-only.`,
  );
};

/** Files larger than this are listed but never read into a query. */
export const MAX_ADAPTED_FILE_BYTES_V1 = 4 * 1024 * 1024;

export class ReadOnlyVaultAdapterV1 {
  private readonly root: string;
  private cache = new Map<string, AdaptedVaultFileV1>();
  private scanned = false;

  constructor(vaultRoot: string) {
    const resolved = path.resolve(vaultRoot);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
      throw new ReadOnlyVaultError(`Vault path is not a directory: ${resolved}`);
    }
    // realpath so a symlinked vault root compares equal to the paths walked
    // beneath it; without it every containment check below fails closed.
    this.root = fs.realpathSync(resolved);
  }

  /** Absolute path for a vault-relative one, or null when it escapes. */
  private absolute(vaultPath: string): string | null {
    if (typeof vaultPath !== "string" || vaultPath.length === 0) return null;
    if (path.isAbsolute(vaultPath)) return null;
    const joined = path.resolve(this.root, vaultPath);
    const contained =
      joined === this.root || joined.startsWith(this.root + path.sep);
    if (!contained) return null;
    let real: string;
    try {
      real = fs.realpathSync(joined);
    } catch {
      // Absent is not an escape; the caller distinguishes them.
      return joined;
    }
    // Checked again after resolution: the first test says the *name* is inside
    // the vault, this one says the file is.
    return real === this.root || real.startsWith(this.root + path.sep)
      ? real
      : null;
  }

  private scan(): Map<string, AdaptedVaultFileV1> {
    if (this.scanned) return this.cache;
    const found = new Map<string, AdaptedVaultFileV1>();
    const walk = (directory: string, prefix: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(directory, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(absolute, relative);
          continue;
        }
        if (!entry.isFile()) continue;
        let stat: fs.Stats;
        try {
          stat = fs.statSync(absolute);
        } catch {
          continue;
        }
        const extension = path.extname(entry.name).replace(/^\./u, "");
        found.set(relative, {
          path: relative,
          name: entry.name,
          basename: path.basename(entry.name, path.extname(entry.name)),
          extension,
          stat: { mtime: stat.mtimeMs, ctime: stat.birthtimeMs, size: stat.size },
        });
      }
    };
    walk(this.root, "");
    this.cache = found;
    this.scanned = true;
    return found;
  }

  /** Forget the file listing; the next read re-walks the directory. */
  refresh(): void {
    this.scanned = false;
    this.cache = new Map();
  }

  private readFile(file: AdaptedVaultFileV1): string {
    const absolute = this.absolute(file.path);
    if (!absolute) {
      throw new ReadOnlyVaultError(`Path escapes the vault: ${file.path}`);
    }
    if (fs.statSync(absolute).size > MAX_ADAPTED_FILE_BYTES_V1) {
      throw new ReadOnlyVaultError(
        `File exceeds the ${MAX_ADAPTED_FILE_BYTES_V1}-byte read limit: ${file.path}`,
      );
    }
    return fs.readFileSync(absolute, "utf8");
  }

  /**
   * The `app` object the retrieval stack expects. Cast at the boundary because
   * Obsidian's `App` is far wider than the read surface used here, and
   * satisfying the whole of it would mean stubbing an editor.
   */
  asApp(): App {
    const self = this;
    const vault = {
      getFiles: () => [...self.scan().values()],
      getMarkdownFiles: () =>
        [...self.scan().values()].filter((file) => file.extension === "md"),
      getFileByPath: (vaultPath: string) => self.scan().get(vaultPath) ?? null,
      getAbstractFileByPath: (vaultPath: string) => {
        const file = self.scan().get(vaultPath);
        if (file) return file;
        const absolute = self.absolute(vaultPath);
        if (absolute && fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()) {
          return { path: vaultPath, children: [] };
        }
        return null;
      },
      getFolderByPath: (vaultPath: string) => {
        const absolute = self.absolute(vaultPath);
        return absolute && fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()
          ? { path: vaultPath, children: [] }
          : null;
      },
      cachedRead: async (file: AdaptedVaultFileV1) => self.readFile(file),
      read: async (file: AdaptedVaultFileV1) => self.readFile(file),
      adapter: {
        exists: async (vaultPath: string) => {
          const absolute = self.absolute(vaultPath);
          return absolute !== null && fs.existsSync(absolute);
        },
      },
      create: READ_ONLY("create"),
      createFolder: READ_ONLY("createFolder"),
      modify: READ_ONLY("modify"),
      delete: READ_ONLY("delete"),
      trash: READ_ONLY("trash"),
      rename: READ_ONLY("rename"),
      copy: READ_ONLY("copy"),
      append: READ_ONLY("append"),
      process: READ_ONLY("process"),
      on: () => ({}),
      off: () => undefined,
    };
    return {
      vault,
      // No editor, no active file: a query arriving over a protocol has no
      // "note the user is looking at", and inventing one would seed the graph
      // prior with a note nobody opened.
      workspace: { getActiveFile: () => null },
      metadataCache: { getFileCache: () => null, getCache: () => null },
    } as unknown as App;
  }
}
