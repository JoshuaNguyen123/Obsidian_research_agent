import type { TFile } from "obsidian";
import {
  BACKUP_FOLDER,
  MAX_BATCH_READ_CHARS_PER_FILE,
  MAX_BATCH_READ_FILES,
  MAX_FILE_READ_CHARS,
  MAX_LISTED_FILES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SNIPPET_CHARS,
} from "./constants";
import {
  ToolExecutionError,
  type AgentTool,
  type ToolExecutionContext,
} from "./types";
import {
  getFirstH1,
  getFrontmatterTitle,
  retitleNoteMarkdown,
} from "./noteTitles";
import {
  assertSafeMarkdownPath,
  expectNoArgs,
  getOptionalBoolean,
  getOptionalInteger,
  getOptionalString,
  getRequiredStringArray,
  getRequiredString,
  getString,
  getErrorMessage,
  normalizeVaultPath,
  truncateText,
} from "./validation";
import { createGraphTools } from "./graphTools";
import { countMarkdownVisibleText } from "./wordCount";

const CREATE_INTENT_PATTERN = /\b(create|new|make)\b/i;
const REPLACE_INTENT_PATTERN =
  /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+fresh\b/i;
const APPEND_INTENT_PATTERN =
  /\b(append|save|write|update|add|insert)\b[\s\S]{0,80}\b(note|file|markdown|vault)\b|\b(note|file|markdown|vault)\b[\s\S]{0,80}\b(append|save|write|update|add|insert)\b/i;
const MOVE_INTENT_PATTERN = /\b(move|rename|relocate)\b/i;
const TITLE_INTENT_PATTERN =
  /\b(retitle|rename|title|heading|h1)\b|\bcall\s+(?:this|the)\s+note\b|\b(note|file)\b[\s\S]{0,80}\b(organize|restructure|improve)\b|\b(organize|restructure|improve)\b[\s\S]{0,80}\b(note|file)\b/i;
const EDIT_INTENT_PATTERN =
  /\b(edit|revise|update|replace|rewrite)\b[\s\S]{0,80}\b(section|heading|part|paragraph|content)\b|\b(section|heading|part|paragraph|content)\b[\s\S]{0,80}\b(edit|revise|update|replace|rewrite)\b/i;
const DELETE_INTENT_PATTERN =
  /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i;
const DELETE_PATH_INTENT_PATTERN = /\b(delete|remove|trash)\b/i;

const DEFAULT_FOLDER_LIST_LIMIT = 100;
const DEFAULT_RECURSIVE_DEPTH = 3;

export function createVaultTools(): AgentTool[] {
  return [
    readCurrentFileTool,
    listCurrentFolderTool,
    listMarkdownFilesTool,
    searchMarkdownFilesTool,
    readMarkdownFilesTool,
    readFileTool,
    countWordsTool,
    ...createGraphTools(),
    listFolderTool,
    getPathInfoTool,
    createFolderTool,
    createFileTool,
    appendFileTool,
    replaceFileTool,
    movePathTool,
    deletePathTool,
    retitleCurrentFileTool,
    prepareEditCurrentSectionTool,
    editCurrentSectionTool,
    appendToCurrentFileTool,
    replaceCurrentFileTool,
    deleteCurrentFileTool,
  ];
}

export const readCurrentFileTool: AgentTool = {
  name: "read_current_file",
  description: "Read the active markdown note.",
  parameters: {
    type: "object",
    properties: {
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const maxChars = clampPositiveInteger(
      getOptionalInteger(args, "maxChars") ?? MAX_FILE_READ_CHARS,
      1,
      MAX_FILE_READ_CHARS,
    );
    const file = getActiveMarkdownFile(context);
    const content =
      context.getCurrentMarkdownContent?.(file) ??
      (await context.app.vault.cachedRead(file));

    return {
      path: file.path,
      content: truncateText(content, maxChars),
    };
  },
};

export const listCurrentFolderTool: AgentTool = {
  name: "list_current_folder",
  description:
    "List siblings and nearby entries in the active note's current folder.",
  parameters: {
    type: "object",
    properties: {
      recursive: {
        type: "boolean",
        description: "When true, include nested descendants up to maxDepth.",
      },
      maxDepth: {
        type: "integer",
        description: "Maximum descendant depth when recursive is true.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of entries to return.",
      },
      markdownOnly: {
        type: "boolean",
        description: "When true, include folders and markdown files only.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const file = getActiveMarkdownFile(context);
    const folderPath = getParentFolderPath(file.path);
    if (folderPath && isBlockedSystemPath(folderPath)) {
      throw new Error(`Current folder is not available for agent browsing: ${folderPath}`);
    }

    const recursive = getOptionalBoolean(args, "recursive") ?? false;
    const maxDepth = clampPositiveInteger(
      getOptionalInteger(args, "maxDepth") ??
        (recursive ? DEFAULT_RECURSIVE_DEPTH : 1),
      1,
      DEFAULT_RECURSIVE_DEPTH,
    );
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_FOLDER_LIST_LIMIT,
      1,
      MAX_LISTED_FILES,
    );
    const markdownOnly = getOptionalBoolean(args, "markdownOnly") ?? false;
    const { entries, truncated } = buildFolderEntries({
      context,
      path: folderPath,
      recursive,
      maxDepth,
      limit,
      markdownOnly,
    });
    const parentPath = folderPath ? getParentFolderPath(folderPath) : null;

    return {
      activeFile: {
        path: file.path,
        basename: file.basename,
      },
      currentFolder: {
        path: folderPath,
        name: folderPath ? getPathName(folderPath) : "",
      },
      parentFolder:
        parentPath === null
          ? null
          : {
              path: parentPath,
              name: parentPath ? getPathName(parentPath) : "",
            },
      recursive,
      maxDepth: recursive ? maxDepth : 1,
      limit,
      entries,
      truncated,
    };
  },
};

export const listMarkdownFilesTool: AgentTool = {
  name: "list_markdown_files",
  description: "List markdown files in the vault.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(args, context) {
    expectNoArgs(args, "list_markdown_files");

    return context.app.vault
      .getFiles()
      .filter((file) => file.extension === "md")
      .slice(0, MAX_LISTED_FILES)
      .map((file) => ({
        path: file.path,
        basename: file.basename,
      }));
  },
};

export const searchMarkdownFilesTool: AgentTool = {
  name: "search_markdown_files",
  description:
    "Search markdown file contents across the vault and return matching note paths with snippets.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Search text or phrase.",
      },
      limit: {
        type: "integer",
        description: "Maximum matching files to return.",
      },
      maxSnippetChars: {
        type: "integer",
        description: "Maximum snippet characters per result.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const query = getRequiredString(args, "query").trim();
    if (!query) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "search_markdown_files requires a non-empty query.",
      );
    }

    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? MAX_SEARCH_RESULTS,
      1,
      MAX_SEARCH_RESULTS,
    );
    const maxSnippetChars = clampPositiveInteger(
      getOptionalInteger(args, "maxSnippetChars") ??
        MAX_SEARCH_SNIPPET_CHARS,
      80,
      MAX_SEARCH_SNIPPET_CHARS,
    );
    const normalizedQuery = query.toLowerCase();
    const results: Array<{
      path: string;
      basename: string;
      matchCount: number;
      snippet: string;
    }> = [];

    for (const file of context.app.vault.getFiles()) {
      if (file.extension !== "md" || isBlockedSystemPath(file.path)) {
        continue;
      }

      const content = await context.app.vault.cachedRead(file);
      const index = content.toLowerCase().indexOf(normalizedQuery);
      if (index === -1) {
        continue;
      }

      results.push({
        path: file.path,
        basename: file.basename,
        matchCount: countMatches(content, query),
        snippet: buildSearchSnippet(content, index, maxSnippetChars),
      });

      if (results.length >= limit) {
        break;
      }
    }

    return {
      query,
      limit,
      results,
      truncated: results.length >= limit,
    };
  },
};

export const readMarkdownFilesTool: AgentTool = {
  name: "read_markdown_files",
  description:
    "Read multiple markdown files by vault-relative paths. Use this after listing or searching notes.",
  parameters: {
    type: "object",
    required: ["paths"],
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Vault-relative markdown paths.",
      },
      maxCharsPerFile: {
        type: "integer",
        description: "Optional maximum characters returned per file.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const requestedPaths = getRequiredStringArray(args, "paths");
    const paths = requestedPaths.slice(0, MAX_BATCH_READ_FILES);
    const maxCharsPerFile = clampPositiveInteger(
      getOptionalInteger(args, "maxCharsPerFile") ??
        MAX_BATCH_READ_CHARS_PER_FILE,
      1,
      MAX_BATCH_READ_CHARS_PER_FILE,
    );
    const files: Array<{
      path: string;
      basename: string;
      content: string;
      truncated: boolean;
    }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const rawPath of paths) {
      try {
        const path = normalizeVaultPath(rawPath, { requireMarkdown: true });
        const file = context.app.vault.getFileByPath(path);
        if (!file || file.extension !== "md") {
          skipped.push({ path, reason: "not_found_or_not_markdown" });
          continue;
        }

        const content = await context.app.vault.cachedRead(file);
        files.push({
          path: file.path,
          basename: file.basename,
          content: truncateText(content, maxCharsPerFile),
          truncated: content.length > maxCharsPerFile,
        });
      } catch (error) {
        skipped.push({
          path: rawPath,
          reason: getErrorMessage(error),
        });
      }
    }

    for (const skippedPath of requestedPaths.slice(MAX_BATCH_READ_FILES)) {
      skipped.push({
        path: skippedPath,
        reason: "batch_limit_exceeded",
      });
    }

    return {
      requestedCount: requestedPaths.length,
      returnedCount: files.length,
      limit: MAX_BATCH_READ_FILES,
      maxCharsPerFile,
      files,
      skipped,
    };
  },
};

export const readFileTool: AgentTool = {
  name: "read_file",
  description: "Read a markdown file by vault-relative path.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative markdown path, for example Projects/example.md.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = getRequiredString(args, "path");
    assertSafeMarkdownPath(path);

    const file = context.app.vault.getFileByPath(path);
    if (!file || file.extension !== "md") {
      throw new Error(`Markdown file not found: ${path}`);
    }

    const content = await context.app.vault.cachedRead(file);
    return {
      path: file.path,
      content: truncateText(content, MAX_FILE_READ_CHARS),
    };
  },
};

export const countWordsTool: AgentTool = {
  name: "count_words",
  description:
    "Count visible markdown words in the active note or a vault-relative markdown file. Returns counts only, not note content.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description:
          "Optional vault-relative markdown path. Omit to count the active note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const requestedPath = getOptionalString(args, "path");
    const file = requestedPath
      ? getMarkdownFileByPath(
          context,
          normalizeVaultPath(requestedPath, { requireMarkdown: true }),
        )
      : getActiveMarkdownFile(context);
    const content =
      !requestedPath && context.getCurrentMarkdownContent
        ? context.getCurrentMarkdownContent(file) ??
          (await context.app.vault.cachedRead(file))
        : await context.app.vault.cachedRead(file);
    const counts = countMarkdownVisibleText(content);

    return {
      path: file.path,
      ...counts,
    };
  },
};

export const listFolderTool: AgentTool = {
  name: "list_folder",
  description:
    "List files and folders under a vault-relative folder path. Use an empty path for the vault root.",
  parameters: {
    type: "object",
    properties: {
      path: {
        type: "string",
        description: "Vault-relative folder path. Use an empty string for the vault root.",
      },
      recursive: {
        type: "boolean",
        description: "When true, include nested descendants up to maxDepth.",
      },
      maxDepth: {
        type: "integer",
        description: "Maximum descendant depth when recursive is true.",
      },
      limit: {
        type: "integer",
        description: "Maximum number of entries to return.",
      },
      markdownOnly: {
        type: "boolean",
        description: "When true, include folders and markdown files only.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeVaultPath(getOptionalString(args, "path") ?? "", {
      allowRoot: true,
    });
    const recursive = getOptionalBoolean(args, "recursive") ?? false;
    const maxDepth = clampPositiveInteger(
      getOptionalInteger(args, "maxDepth") ??
        (recursive ? DEFAULT_RECURSIVE_DEPTH : 1),
      1,
      DEFAULT_RECURSIVE_DEPTH,
    );
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_FOLDER_LIST_LIMIT,
      1,
      MAX_LISTED_FILES,
    );
    const markdownOnly = getOptionalBoolean(args, "markdownOnly") ?? false;

    if (path && !getFolderByPath(context, path)) {
      throw new Error(`Folder not found: ${path}`);
    }

    const { entries, truncated } = buildFolderEntries({
      context,
      path,
      recursive,
      maxDepth,
      limit,
      markdownOnly,
    });

    return {
      path,
      recursive,
      maxDepth: recursive ? maxDepth : 1,
      limit,
      entries,
      truncated,
    };
  },
};

export const getPathInfoTool: AgentTool = {
  name: "get_path_info",
  description: "Inspect whether a vault-relative path exists and whether it is a file or folder.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative file or folder path. Use an empty string for the vault root.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeVaultPath(getString(args, "path"), {
      allowRoot: true,
    });

    if (!path) {
      return {
        path,
        exists: true,
        type: "folder",
        childCount: getDirectChildEntries(context, path).length,
        supportedRead: true,
        supportedWrite: false,
      };
    }

    const target = getAbstractPath(context, path);
    if (!target) {
      return {
        path,
        exists: false,
      };
    }

    const type = getPathType(target);
    const extension = type === "file" ? getEntryExtension(target) : undefined;

    return {
      path: target.path,
      exists: true,
      type,
      basename: getEntryBasename(target),
      extension,
      markdown: extension === "md",
      childCount: type === "folder" ? getDirectChildEntries(context, path).length : undefined,
      supportedRead: type === "folder" || extension === "md",
      supportedWrite: !isBlockedSystemPath(path) && (type === "folder" || extension === "md"),
    };
  },
};

export const createFolderTool: AgentTool = {
  name: "create_folder",
  description: "Create a vault folder, creating missing parent folders when needed.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative folder path to create.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCreateIntent(context, "create_folder");
    const path = normalizeVaultPath(getRequiredString(args, "path"));

    if (path.toLowerCase().endsWith(".md")) {
      throw new Error("create_folder requires a folder path, not a markdown file path.");
    }

    if (getAbstractPath(context, path)) {
      throw new Error(`Path already exists: ${path}`);
    }

    const createdFolders = await ensureFolderPath(context, path);
    return {
      path,
      operation: "create_folder",
      createdFolders,
    };
  },
};

export const createFileTool: AgentTool = {
  name: "create_file",
  description: "Create a new markdown file at a vault-relative path.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative markdown file path to create.",
      },
      content: {
        type: "string",
        description: "Initial markdown content.",
      },
      createFolders: {
        type: "boolean",
        description: "When true, create missing parent folders first.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertCreateIntent(context, "create_file");
    const path = normalizeVaultPath(getRequiredString(args, "path"), {
      requireMarkdown: true,
    });
    const content = getString(args, "content");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? false;

    if (getAbstractPath(context, path)) {
      throw new Error(`Path already exists: ${path}`);
    }

    await ensureParentFolder(context, path, createFolders);
    await context.app.vault.create(path, content);

    return {
      path,
      operation: "create",
      bytesWritten: getByteLength(content),
    };
  },
};

export const appendFileTool: AgentTool = {
  name: "append_file",
  description: "Append markdown text to an existing vault markdown file by path.",
  parameters: {
    type: "object",
    required: ["path", "text"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative markdown file path.",
      },
      text: {
        type: "string",
        description: "Markdown text to append.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertAppendIntent(context, "append_file");
    const path = normalizeVaultPath(getRequiredString(args, "path"), {
      requireMarkdown: true,
    });
    const text = getRequiredString(args, "text");
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    const appendedText = `${prefix}${text}`;

    await context.app.vault.modify(file, `${current}${appendedText}`);

    return {
      path: file.path,
      operation: "append",
      bytesWritten: getByteLength(appendedText),
    };
  },
};

export const replaceFileTool: AgentTool = {
  name: "replace_file",
  description: "Replace an existing vault markdown file by path after creating a backup.",
  parameters: {
    type: "object",
    required: ["path", "text"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative markdown file path.",
      },
      text: {
        type: "string",
        description: "Full replacement markdown content.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertReplaceIntent(context, "replace_file");
    const path = normalizeVaultPath(getRequiredString(args, "path"), {
      requireMarkdown: true,
    });
    const text = getString(args, "text");
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    const backupPath = await backupCurrentFile(context, file, current);

    await context.app.vault.modify(file, text);

    return {
      path: file.path,
      operation: "replace",
      backupPath,
      bytesWritten: getByteLength(text),
    };
  },
};

export const movePathTool: AgentTool = {
  name: "move_path",
  description: "Move or rename a vault file or folder without overwriting an existing path.",
  parameters: {
    type: "object",
    required: ["fromPath", "toPath"],
    properties: {
      fromPath: {
        type: "string",
        description: "Existing vault-relative file or folder path.",
      },
      toPath: {
        type: "string",
        description: "Destination vault-relative file or folder path.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertMoveIntent(context, "move_path");
    const fromPath = normalizeVaultPath(getRequiredString(args, "fromPath"));
    const toPath = normalizeVaultPath(getRequiredString(args, "toPath"));
    const target = getAbstractPath(context, fromPath);

    if (!target) {
      throw new Error(`Path not found: ${fromPath}`);
    }

    if (getAbstractPath(context, toPath)) {
      throw new Error(`Destination already exists: ${toPath}`);
    }

    if (getPathType(target) === "file" && getEntryExtension(target) === "md") {
      normalizeVaultPath(toPath, { requireMarkdown: true });
    }

    await ensureParentFolder(context, toPath, false);
    await renameVaultPath(context, target, toPath);

    return {
      path: fromPath,
      toPath,
      operation: "move",
    };
  },
};

export const deletePathTool: AgentTool = {
  name: "delete_path",
  description: "Trash a vault file or folder by path. Does not hard delete.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative file or folder path to trash.",
      },
      recursive: {
        type: "boolean",
        description: "Required for non-empty folders.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertDeletePathIntent(context, "delete_path");
    const path = normalizeVaultPath(getRequiredString(args, "path"));
    const recursive = getOptionalBoolean(args, "recursive") ?? false;
    const target = getAbstractPath(context, path);

    if (!target) {
      throw new Error(`Path not found: ${path}`);
    }

    const type = getPathType(target);
    const affectedCount =
      type === "folder" ? getDescendantEntries(context, path).length : 1;
    const bytesDeleted =
      type === "file" && getEntryExtension(target) === "md"
        ? getByteLength(await context.app.vault.read(target as TFile))
        : undefined;

    if (type === "folder" && affectedCount > 0 && !recursive) {
      throw new Error("delete_path requires recursive=true for non-empty folders.");
    }

    await trashVaultPath(context, target);

    return {
      path,
      operation: "trash",
      bytesDeleted,
      affectedCount,
    };
  },
};

export const appendToCurrentFileTool: AgentTool = {
  name: "append_to_current_file",
  description: "Append markdown text to the active markdown note.",
  parameters: {
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
        description: "Markdown text to append to the active note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const text = getRequiredString(args, "text");
    if (!context.writeAutonomy && !APPEND_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "append_to_current_file requires the user to explicitly ask to append, save, write, add, insert, or update the note.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    const appendedText = `${prefix}${text}`;

    await context.app.vault.modify(file, `${current}${appendedText}`);

    return {
      path: file.path,
      bytesWritten: getByteLength(appendedText),
    };
  },
};

export const retitleCurrentFileTool: AgentTool = {
  name: "retitle_current_file",
  description:
    "Patch the active markdown note title by updating frontmatter title and the first H1, or inserting a missing H1. Does not rename the file.",
  parameters: {
    type: "object",
    required: ["title"],
    properties: {
      title: {
        type: "string",
        description: "The new note title to write into frontmatter and the first H1.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const title = getRequiredString(args, "title").trim();
    if (!title) {
      throw new Error("retitle_current_file requires a non-empty title.");
    }

    if (!TITLE_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "retitle_current_file requires the user to explicitly ask for a title, heading, rename, retitle, organize, restructure, or improve operation.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const previousFrontmatterTitle = getFrontmatterTitle(current);
    const previousH1 = getFirstH1(current)?.text ?? null;
    const updated = retitleNoteMarkdown(current, title);
    const changed = updated !== current;

    if (changed) {
      await context.app.vault.modify(file, updated);
    }

    return {
      path: file.path,
      title,
      previousFrontmatterTitle,
      previousH1,
      updatedFrontmatterTitle: getFrontmatterTitle(updated),
      updatedH1: getFirstH1(updated)?.text ?? null,
      changed,
      suggestedFileRename: getSuggestedFileRename(file, title),
      bytesWritten: changed ? getByteLength(updated) : 0,
    };
  },
};

export const editCurrentSectionTool: AgentTool = {
  name: "edit_current_section",
  description:
    "Replace the body of one heading section in the active markdown note after creating a backup. Preserves the heading line.",
  parameters: {
    type: "object",
    required: ["heading", "content"],
    properties: {
      heading: {
        type: "string",
        description:
          "Exact ATX heading text without leading # characters, for example Project Goals.",
      },
      level: {
        type: "integer",
        enum: [1, 2, 3, 4, 5, 6],
        description:
          "Optional heading level from 1 to 6. When omitted, heading text must match exactly once across all levels.",
      },
      content: {
        type: "string",
        description:
          "Replacement markdown body for the section. The existing heading line is preserved.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const heading = getRequiredString(args, "heading").trim();
    const level = getOptionalInteger(args, "level");
    const content = getString(args, "content");

    if (!heading) {
      throw new Error("edit_current_section requires a non-empty heading.");
    }

    if (level !== undefined && (level < 1 || level > 6)) {
      throw new Error("edit_current_section level must be between 1 and 6.");
    }

    if (!EDIT_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "edit_current_section requires the user to explicitly ask to edit, revise, update, replace, or rewrite a section.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const edit = replaceMarkdownSection(current, { heading, level, content });
    const backupPath = await backupCurrentFile(context, file, current);

    await context.app.vault.modify(file, edit.updated);

    return {
      path: file.path,
      backupPath,
      heading,
      level: edit.level,
      bytesWritten: getByteLength(edit.updated),
      replacedChars: edit.replacedChars,
    };
  },
};

export const prepareEditCurrentSectionTool: AgentTool = {
  name: "prepare_edit_current_section",
  description:
    "Validate a target heading section in the active markdown note and create a backup before streamed section replacement.",
  parameters: {
    type: "object",
    required: ["heading"],
    properties: {
      heading: {
        type: "string",
        description:
          "Exact ATX heading text without leading # characters, for example Project Goals.",
      },
      level: {
        type: "integer",
        enum: [1, 2, 3, 4, 5, 6],
        description:
          "Optional heading level from 1 to 6. When omitted, heading text must match exactly once across all levels.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const heading = getRequiredString(args, "heading").trim();
    const level = getOptionalInteger(args, "level");

    if (!heading) {
      throw new Error("prepare_edit_current_section requires a non-empty heading.");
    }

    if (level !== undefined && (level < 1 || level > 6)) {
      throw new Error("prepare_edit_current_section level must be between 1 and 6.");
    }

    if (!EDIT_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "prepare_edit_current_section requires the user to explicitly ask to edit, revise, update, replace, or rewrite a section.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const section = prepareMarkdownSectionReplacement(current, { heading, level });
    const backupPath = await backupCurrentFile(context, file, current);

    return {
      path: file.path,
      backupPath,
      heading,
      level: section.level,
      prefix: section.prefix,
      suffix: section.suffix,
      replacedChars: section.replacedChars,
    };
  },
};

export const replaceCurrentFileTool: AgentTool = {
  name: "replace_current_file",
  description: "Replace the active markdown note after creating a backup.",
  parameters: {
    type: "object",
    required: ["text"],
    properties: {
      text: {
        type: "string",
        description: "Full replacement markdown content for the active note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const text = getString(args, "text");
    if (!REPLACE_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "replace_current_file requires the user to explicitly ask for rewrite, replace, clean up, reset, start fresh, or overwrite.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const backupPath = await backupCurrentFile(context, file, current);
    await context.app.vault.modify(file, text);

    return {
      path: file.path,
      backupPath,
      bytesWritten: getByteLength(text),
    };
  },
};

export const deleteCurrentFileTool: AgentTool = {
  name: "delete_current_file",
  description: "Delete the active markdown note after creating a backup.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute(args, context) {
    expectNoArgs(args, "delete_current_file");
    if (!DELETE_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "delete_current_file requires the user to explicitly ask to delete, remove, or trash the current note.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const backupPath = await backupCurrentFile(context, file, current);

    await trashVaultPath(context, file);

    return {
      path: file.path,
      operation: "trash",
      backupPath,
      bytesDeleted: getByteLength(current),
    };
  },
};

type VaultPathType = "file" | "folder";

interface VaultEntryLike {
  path: string;
  name?: string;
  basename?: string;
  extension?: string;
}

interface FolderListEntry {
  path: string;
  type: VaultPathType;
  name: string;
  extension?: string;
  depth: number;
  supportedRead: boolean;
  supportedWrite: boolean;
}

interface BuildFolderEntriesInput {
  context: ToolExecutionContext;
  path: string;
  recursive: boolean;
  maxDepth: number;
  limit: number;
  markdownOnly: boolean;
}

function assertCreateIntent(context: ToolExecutionContext, toolName: string) {
  if (!CREATE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to create a file or folder.`);
  }
}

function assertAppendIntent(context: ToolExecutionContext, toolName: string) {
  if (!APPEND_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to append, save, write, add, insert, or update a note or file.`);
  }
}

function assertReplaceIntent(context: ToolExecutionContext, toolName: string) {
  if (!REPLACE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to rewrite, replace, reset, clean up, start fresh, or overwrite a file.`);
  }
}

function assertMoveIntent(context: ToolExecutionContext, toolName: string) {
  if (!MOVE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to move, rename, or relocate a path.`);
  }
}

function assertDeletePathIntent(context: ToolExecutionContext, toolName: string) {
  if (!DELETE_PATH_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to delete, remove, or trash a path.`);
  }
}

function getMarkdownFileByPath(context: ToolExecutionContext, path: string): TFile {
  const file = context.app.vault.getFileByPath(path);
  if (!file || file.extension !== "md") {
    throw new Error(`Markdown file not found: ${path}`);
  }

  return file;
}

function getVaultEntries(context: ToolExecutionContext): VaultEntryLike[] {
  const vault = context.app.vault as unknown as {
    getAllLoadedFiles?: () => VaultEntryLike[];
    getFiles: () => VaultEntryLike[];
  };

  if (typeof vault.getAllLoadedFiles === "function") {
    return vault.getAllLoadedFiles();
  }

  return withDerivedFolders(vault.getFiles());
}

function withDerivedFolders(files: VaultEntryLike[]): VaultEntryLike[] {
  const folders = new Map<string, VaultEntryLike>();

  for (const file of files) {
    let folderPath = getFolderPath(file.path).replace(/\/$/, "");
    while (folderPath) {
      if (!folders.has(folderPath)) {
        folders.set(folderPath, {
          path: folderPath,
          name: getPathName(folderPath),
        });
      }

      folderPath = getFolderPath(folderPath).replace(/\/$/, "");
    }
  }

  return [...folders.values(), ...files];
}

function getAbstractPath(
  context: ToolExecutionContext,
  path: string,
): VaultEntryLike | null {
  if (!path) {
    return {
      path: "",
      name: "",
    };
  }

  const vault = context.app.vault as unknown as {
    getAbstractFileByPath?: (path: string) => VaultEntryLike | null;
  };

  if (typeof vault.getAbstractFileByPath === "function") {
    const abstractFile = vault.getAbstractFileByPath(path);
    if (abstractFile) {
      return abstractFile;
    }
  }

  const file = context.app.vault.getFileByPath(path);
  if (file) {
    return file;
  }

  return getFolderByPath(context, path);
}

function getFolderByPath(
  context: ToolExecutionContext,
  path: string,
): VaultEntryLike | null {
  if (!path) {
    return {
      path: "",
      name: "",
    };
  }

  return context.app.vault.getFolderByPath(path) as VaultEntryLike | null;
}

function getPathType(entry: VaultEntryLike): VaultPathType {
  return typeof entry.extension === "string" ? "file" : "folder";
}

function getEntryExtension(entry: VaultEntryLike): string | undefined {
  return typeof entry.extension === "string"
    ? entry.extension.toLowerCase()
    : undefined;
}

function getEntryBasename(entry: VaultEntryLike): string {
  return entry.basename ?? getPathName(entry.path);
}

function getPathName(path: string): string {
  return path.split("/").pop() ?? path;
}

function buildFolderEntries({
  context,
  path,
  recursive,
  maxDepth,
  limit,
  markdownOnly,
}: BuildFolderEntriesInput): {
  entries: FolderListEntry[];
  truncated: boolean;
} {
  const allEntries = getVaultEntries(context)
    .filter((entry) => !isBlockedSystemPath(entry.path))
    .map((entry) => formatFolderListEntry(entry, path))
    .filter((entry): entry is FolderListEntry => entry !== null)
    .filter((entry) => (recursive ? entry.depth <= maxDepth : entry.depth === 1))
    .filter(
      (entry) =>
        !markdownOnly || entry.type === "folder" || entry.extension === "md",
    )
    .sort((a, b) => a.path.localeCompare(b.path));

  return {
    entries: allEntries.slice(0, limit),
    truncated: allEntries.length > limit,
  };
}

function formatFolderListEntry(
  entry: VaultEntryLike,
  folderPath: string,
): FolderListEntry | null {
  if (entry.path === folderPath) {
    return null;
  }

  const relativePath = getRelativeChildPath(entry.path, folderPath);
  if (relativePath === null) {
    return null;
  }

  const type = getPathType(entry);
  const extension = getEntryExtension(entry);

  return {
    path: entry.path,
    type,
    name: getPathName(entry.path),
    extension,
    depth: relativePath.split("/").length,
    supportedRead: type === "folder" || extension === "md",
    supportedWrite: !isBlockedSystemPath(entry.path) && (type === "folder" || extension === "md"),
  };
}

function getRelativeChildPath(
  childPath: string,
  folderPath: string,
): string | null {
  if (!folderPath) {
    return childPath || null;
  }

  const prefix = `${folderPath}/`;
  return childPath.startsWith(prefix) ? childPath.slice(prefix.length) : null;
}

function getDirectChildEntries(
  context: ToolExecutionContext,
  folderPath: string,
): VaultEntryLike[] {
  return getVaultEntries(context).filter((entry) => {
    const relativePath = getRelativeChildPath(entry.path, folderPath);
    return relativePath !== null && relativePath.split("/").length === 1;
  });
}

function getDescendantEntries(
  context: ToolExecutionContext,
  folderPath: string,
): VaultEntryLike[] {
  return getVaultEntries(context).filter((entry) => {
    const relativePath = getRelativeChildPath(entry.path, folderPath);
    return relativePath !== null && relativePath.length > 0;
  });
}

async function ensureParentFolder(
  context: ToolExecutionContext,
  path: string,
  createMissing: boolean,
) {
  const parentPath = getParentFolderPath(path);
  if (!parentPath) {
    return;
  }

  if (getFolderByPath(context, parentPath)) {
    return;
  }

  if (!createMissing) {
    throw new Error(`Destination folder not found: ${parentPath}`);
  }

  await ensureFolderPath(context, parentPath);
}

async function ensureFolderPath(
  context: ToolExecutionContext,
  path: string,
): Promise<string[]> {
  const createdFolders: string[] = [];
  const parts = path.split("/");
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;

    if (context.app.vault.getFileByPath(currentPath)) {
      throw new Error(`Cannot create folder because a file exists at: ${currentPath}`);
    }

    if (!getFolderByPath(context, currentPath)) {
      await context.app.vault.createFolder(currentPath);
      createdFolders.push(currentPath);
    }
  }

  return createdFolders;
}

async function renameVaultPath(
  context: ToolExecutionContext,
  target: VaultEntryLike,
  toPath: string,
) {
  const vault = context.app.vault as unknown as {
    rename?: (file: unknown, newPath: string) => Promise<void>;
  };

  if (typeof vault.rename !== "function") {
    throw new Error("Vault rename is not available.");
  }

  await vault.rename(target, toPath);
}

async function trashVaultPath(
  context: ToolExecutionContext,
  target: VaultEntryLike,
) {
  const vault = context.app.vault as unknown as {
    trash?: (file: unknown, system: boolean) => Promise<void>;
  };

  if (typeof vault.trash !== "function") {
    throw new Error("Vault trash is not available.");
  }

  await vault.trash(target, false);
}

function countMatches(content: string, query: string): number {
  const needle = query.toLowerCase();
  if (!needle) {
    return 0;
  }

  const haystack = content.toLowerCase();
  let count = 0;
  let offset = 0;

  while (offset < haystack.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) {
      break;
    }

    count += 1;
    offset = index + needle.length;
  }

  return count;
}

function buildSearchSnippet(
  content: string,
  index: number,
  maxChars: number,
): string {
  const half = Math.floor(maxChars / 2);
  const start = Math.max(0, index - half);
  const end = Math.min(content.length, start + maxChars);
  const prefix = start > 0 ? "... " : "";
  const suffix = end < content.length ? " ..." : "";
  return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

function clampPositiveInteger(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function isBlockedSystemPath(path: string): boolean {
  return /^(?:\.agent-backups|\.obsidian|\.trash|trash)(?:\/|$)/i.test(path);
}

function getParentFolderPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : path.slice(0, slashIndex);
}

function getActiveMarkdownFile(context: ToolExecutionContext): TFile {
  const file =
    context.getCurrentMarkdownFile?.() ?? context.app.workspace.getActiveFile();
  if (!file || file.extension !== "md") {
    throw new Error(
      "An active markdown file is required. Open or focus a markdown note before asking the agent to read the current note.",
    );
  }

  return file;
}

async function ensureBackupFolder(context: ToolExecutionContext) {
  if (context.app.vault.getFolderByPath(BACKUP_FOLDER)) {
    return;
  }

  await context.app.vault.createFolder(BACKUP_FOLDER);
}

async function backupCurrentFile(
  context: ToolExecutionContext,
  file: TFile,
  content: string,
): Promise<string> {
  await ensureBackupFolder(context);
  const backupPath = getAvailableBackupPath(context, file);
  await context.app.vault.create(backupPath, content);
  return backupPath;
}

interface SectionReplacementInput {
  heading: string;
  level?: number;
  content: string;
}

interface SectionReplacementResult {
  updated: string;
  level: number;
  replacedChars: number;
}

interface PreparedSectionReplacement {
  level: number;
  prefix: string;
  suffix: string;
  replacedChars: number;
}

interface MarkdownHeading {
  level: number;
  text: string;
  lineStart: number;
  lineEnd: number;
}

function replaceMarkdownSection(
  markdown: string,
  { heading, level, content }: SectionReplacementInput,
): SectionReplacementResult {
  const prepared = prepareMarkdownSectionReplacement(markdown, { heading, level });
  const replacementBody = formatStreamingSectionBody(content, prepared.suffix);

  return {
    updated: `${prepared.prefix}${replacementBody}${prepared.suffix}`,
    level: prepared.level,
    replacedChars: prepared.replacedChars,
  };
}

function prepareMarkdownSectionReplacement(
  markdown: string,
  { heading, level }: { heading: string; level?: number },
): PreparedSectionReplacement {
  const headings = findMarkdownHeadings(markdown);
  const matches = headings.filter(
    (candidate) =>
      candidate.text === heading &&
      (level === undefined || candidate.level === level),
  );

  if (matches.length === 0) {
    throw new Error(`Markdown heading not found: ${heading}`);
  }

  if (matches.length > 1) {
    throw new Error(`Markdown heading is ambiguous: ${heading}`);
  }

  const match = matches[0];
  const nextBoundary = headings.find(
    (candidate) =>
      candidate.lineStart > match.lineStart && candidate.level <= match.level,
  );
  const bodyStart = match.lineEnd;
  const bodyEnd = nextBoundary?.lineStart ?? markdown.length;

  return {
    level: match.level,
    prefix: markdown.slice(0, bodyStart),
    suffix: markdown.slice(bodyEnd),
    replacedChars: bodyEnd - bodyStart,
  };
}

function findMarkdownHeadings(markdown: string): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [];
  const linePattern = /.*(?:\r?\n|$)/g;
  let inFence = false;
  let match: RegExpExecArray | null;

  while ((match = linePattern.exec(markdown)) !== null) {
    const line = match[0];
    if (line.length === 0) {
      break;
    }

    const lineStart = match.index;
    const lineEnd = lineStart + line.length;
    const content = line.replace(/\r?\n$/, "");
    const trimmed = content.trimStart();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
    }

    if (!inFence) {
      const headingMatch = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(content);
      if (headingMatch) {
        headings.push({
          level: headingMatch[1].length,
          text: headingMatch[2].trim(),
          lineStart,
          lineEnd,
        });
      }
    }

    if (lineEnd >= markdown.length) {
      break;
    }
  }

  return headings;
}

function formatSectionBody(
  content: string,
  bodyStart: number,
  bodyEnd: number,
  markdown: string,
): string {
  if (!content) {
    return "";
  }

  const headingAlreadyEndsLine =
    bodyStart > 0 && markdown.slice(bodyStart - 1, bodyStart) === "\n";
  const prefix =
    !headingAlreadyEndsLine && !content.startsWith("\n") ? "\n" : "";
  const suffix =
    bodyEnd < markdown.length && !content.endsWith("\n") ? "\n" : "";

  return `${prefix}${content}${suffix}`;
}

function formatStreamingSectionBody(content: string, suffix: string): string {
  if (!content) {
    return "";
  }

  return suffix && !content.endsWith("\n") ? `${content}\n` : content;
}

function getAvailableBackupPath(
  context: ToolExecutionContext,
  file: TFile,
): string {
  const timestamp = (context.now?.() ?? new Date()).getTime();
  const basename = sanitizeBackupBasename(file.basename);
  let backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}.md`;
  let suffix = 1;

  while (context.app.vault.getFileByPath(backupPath)) {
    backupPath = `${BACKUP_FOLDER}/${timestamp}-${basename}-${suffix}.md`;
    suffix += 1;
  }

  return backupPath;
}

function sanitizeBackupBasename(basename: string): string {
  const sanitized = basename.trim().replace(/[^a-zA-Z0-9._-]+/g, "-");
  return sanitized || "untitled";
}

function getSuggestedFileRename(file: TFile, title: string) {
  const suggestedBasename = sanitizeFileBasename(title);
  if (!suggestedBasename || suggestedBasename === file.basename) {
    return null;
  }

  const folder = getFolderPath(file.path);
  return {
    from: file.path,
    to: `${folder}${suggestedBasename}.md`,
  };
}

function sanitizeFileBasename(title: string): string {
  return title
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\.+$/g, "")
    .trim();
}

function getFolderPath(path: string): string {
  const slashIndex = path.lastIndexOf("/");
  return slashIndex === -1 ? "" : `${path.slice(0, slashIndex + 1)}`;
}

function getByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}
