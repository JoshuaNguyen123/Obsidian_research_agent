// Shared by browserMissionPlan.test.ts and browserMissionRun.test.ts (COMP-4).
import { normalizeAgentSettings } from "../../src/agent/settingsNormalize";
import type { createDefaultToolRegistry } from "../../src/tools/createToolRegistry";
import type { ToolExecutionContext } from "../../src/tools/types";

/** A small in-memory vault: the mission graph is persisted into the vault, and without one the runner plans no graph. */
export function createVaultContext(options: { note: boolean; browserToolsEnabled: boolean }): ToolExecutionContext {
  const notePath = "Browser check.md";
  const content = new Map<string, string>(options.note ? [[notePath, "# Browser check"+String.fromCharCode(10)]] : []);
  const folders = new Set<string>();
  const fileOf = (path: string) => {
    if (!content.has(path)) return null;
    const name = path.split("/").pop() ?? path;
    return { path, name, basename: name.split(".")[0] ?? name, extension: name.includes(".") ? (name.split(".").pop() ?? "").toLowerCase() : "" };
  };
  const folderOf = (path: string) => (path && folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null);
  const vault = {
    getFiles: () => [...content.keys()].map(fileOf).filter(Boolean),
    getAllLoadedFiles: () => [...[...folders].map((path) => ({ path, name: path })), ...[...content.keys()].map(fileOf).filter(Boolean)],
    cachedRead: async (file: { path: string }) => content.get(file.path) ?? "",
    read: async (file: { path: string }) => content.get(file.path) ?? "",
    process: async (file: { path: string }, transform: (current: string) => string) => {
      const next = transform(content.get(file.path) ?? "");
      content.set(file.path, next);
      return next;
    },
    modify: async (file: { path: string }, data: string) => { content.set(file.path, data); },
    getFileByPath: fileOf,
    getFolderByPath: folderOf,
    getAbstractFileByPath: (path: string) => fileOf(path) ?? folderOf(path),
    createFolder: async (path: string) => { folders.add(path); },
    create: async (path: string, data: string) => { content.set(path, data); return fileOf(path); },
    rename: async () => undefined,
  };
  const active = options.note ? fileOf(notePath) : null;
  return {
    app: { workspace: { getActiveFile: () => active }, vault } as never,
    settings: normalizeAgentSettings({ browserToolsEnabled: options.browserToolsEnabled } as never),
    originalPrompt: "",
    httpTransport: async () => ({ status: 500, headers: {}, json: { error: "not mocked" } }),
    now: () => new Date(123),
    ...(options.note ? { getCurrentMarkdownFile: () => active as never, getCurrentMarkdownContent: (file: { path: string }) => content.get(file.path) ?? null } : {}),
  } as ToolExecutionContext;
}


/** What the desktop host does: it reports the page open as a read in its registry. The plan must not depend on the effect. */
export function withOpenPageAsRead(registry: ReturnType<typeof createDefaultToolRegistry>): ReturnType<typeof createDefaultToolRegistry> {
  return Object.assign(Object.create(registry) as object, {
    getDescriptor(name: string) {
      const descriptor = registry.getDescriptor?.(name) ?? null;
      return name === "browser_open_page" && descriptor ? { ...descriptor, effect: "read" as const } : descriptor;
    },
  }) as ReturnType<typeof createDefaultToolRegistry>;
}


