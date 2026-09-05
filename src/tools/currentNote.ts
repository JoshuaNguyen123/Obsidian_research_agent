import type { TFile } from "obsidian";
import type { ToolExecutionContext } from "./types";

/** An explicit host binding, including null, outranks the focused editor. */
export function resolveCurrentNoteFile(context: ToolExecutionContext): TFile | null {
  return context.getCurrentMarkdownFile
    ? context.getCurrentMarkdownFile()
    : context.app.workspace.getActiveFile();
}
