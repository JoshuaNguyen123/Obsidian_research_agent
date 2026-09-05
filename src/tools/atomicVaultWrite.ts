import type { TFile } from "obsidian";
import { ToolExecutionError, type ToolExecutionContext } from "./types";

/** Obsidian holds its file lock while this synchronous transformation runs. */
export async function transformVaultFile(context: ToolExecutionContext, file: TFile, transform: (current: string) => string): Promise<string> {
  if (typeof context.app.vault.process !== "function") {
    throw new ToolExecutionError("vault_atomic_write_unavailable", "The vault host must support atomic file transformations.", { mutationState: "not_applied" });
  }
  return context.app.vault.process(file, transform);
}

/** Recheck the source inside the lock after asynchronous preparation. */
export function replaceVaultFileIfUnchanged(context: ToolExecutionContext, file: TFile, expected: string, replacement: string): Promise<string> {
  return compareAndReplaceVaultFile(context.app.vault, file, expected, replacement);
}

export function compareAndReplaceVaultFile<File extends { path: string }>(vault: {
  process?(file: File, transform: (current: string) => string): Promise<string>;
}, file: File, expected: string, replacement: string): Promise<string> {
  if (!vault.process) throw new ToolExecutionError("vault_atomic_write_unavailable", "The vault host must support atomic file transformations.", { mutationState: "not_applied" });
  return vault.process(file, (current) => {
    if (current !== expected) throw new ToolExecutionError("vault_write_conflict", `The note changed during preparation: ${file.path}. User edits were preserved.`, { mutationState: "not_applied" });
    return replacement;
  });
}
