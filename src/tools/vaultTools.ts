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
  type ResearchMemoryIndexEntry,
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
  isRecord,
  normalizeVaultPath,
  truncateText,
} from "./validation";
import { createGraphTools } from "./graphTools";
import { countMarkdownVisibleText } from "./wordCount";
import { getProjectMemoryLocation } from "../agent/projectMemory";
import { buildRetrievalCoverage } from "../agent/retrievalCoverage";

const CREATE_INTENT_PATTERN = /\b(create|creating|new|make)\b/i;
const REPLACE_INTENT_PATTERN =
  /\b(rewrite|replace|reset|overwrite)\b|\bclean\s+up\b|\bstart\s+(?:fresh|cleanly)\b|\bedit\s+over\s+(?:it|this|the\s+(?:note|page|document|file|contents?))\b|\b(edit(?:ing)?|revise|revising|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire|current|this|active)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(edit(?:ing)?|revise|revising|rewrite|rewriting|improve|improving|expand|expanding|iterate|iterating|flesh\s+out|develop|add(?:ing)?\s+(?:more\s+)?detail)\b|\b(update|updating)\b[\s\S]{0,120}\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire)\s+(?:note|page|file|markdown))\b|\b(essay|draft|article|paragraphs?|body|content|document|(?:whole|entire)\s+(?:note|page|file|markdown))\b[\s\S]{0,120}\b(update|updating)\b|\b(clear|delete|remove|empty)\s+all\s+(?:of\s+)?(?:the\s+)?(?:notes?|contents?|content|text|writing)\s+(?:on|from|in)\s+(?:this|the|current|active)?\s*(?:page|note|document|file)?\b[\s\S]{0,180}\b(write|draft|compose|generate|create)\b|\bkeep\s+(?:the\s+)?(?:note|page|document|file)\b[\s\S]{0,180}\b(delete|remove|clear|empty)\b[\s\S]{0,120}\b(?:contents?|text|writing)\b/i;
const APPEND_INTENT_PATTERN =
  /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i;
const SECTION_APPEND_INTENT_PATTERN =
  /\b(write|draft|compose|generate|append|add|insert|put)\b[\s\S]{0,160}\b(?:below|under|after|beneath|inside)\b[\s\S]{0,80}\b(?:section|heading)\b|\b(?:below|under|after|beneath|inside)\b[\s\S]{0,80}\b(?:section|heading)\b[\s\S]{0,160}\b(write|draft|compose|generate|append|add|insert|put)\b/i;
const MOVE_INTENT_PATTERN = /\b(move|rename|relocate)\b/i;
const TITLE_INTENT_PATTERN =
  /\b(retitle|rename|title|heading|h1)\b|\bcall\s+(?:this|the)\s+note\b|\b(note|file)\b[\s\S]{0,80}\b(organize|restructure|improve)\b|\b(organize|restructure|improve)\b[\s\S]{0,80}\b(note|file)\b/i;
const EDIT_INTENT_PATTERN =
  /\b(edit|revise|update|replace|rewrite)\b[\s\S]{0,80}\b(section|heading|part|paragraph|content)\b|\b(section|heading|part|paragraph|content)\b[\s\S]{0,80}\b(edit|revise|update|replace|rewrite)\b/i;
const DELETE_INTENT_PATTERN =
  /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i;
const DELETE_PATH_INTENT_PATTERN = /\b(delete|remove|trash)\b/i;
const TEMPLATE_INTENT_PATTERN =
  /\b(template|templates|templated|form|boilerplate|reusable\s+(?:note|markdown|outline|format|structure)|fill\s+(?:this|the)?\s*(?:out\s+)?(?:form|template)|populate\s+(?:this|the)?\s*(?:form|template))\b/i;
const TEMPLATE_CREATE_INTENT_PATTERN =
  /\b(create|new|make|save)\b[\s\S]{0,100}\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b|\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b[\s\S]{0,100}\b(create|new|make|save)\b/i;
const TEMPLATE_OUTPUT_CREATE_INTENT_PATTERN =
  /\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,100}\bfrom\b[\s\S]{0,80}\btemplate\b|\btemplate\b[\s\S]{0,100}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i;
const TEMPLATE_FILL_INTENT_PATTERN =
  /\b(fill|use|apply|complete|populate|render)\b[\s\S]{0,100}\b(template|form|boilerplate)\b|\b(template|form|boilerplate)\b[\s\S]{0,100}\b(fill|use|apply|complete|populate|render)\b/i;
const TEMPLATE_SEED_INTENT_PATTERN =
  /\b(seed|install|create|make|add)\b[\s\S]{0,120}\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b|\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b[\s\S]{0,120}\b(seed|install|create|make|add)\b/i;

const DEFAULT_FOLDER_LIST_LIMIT = 100;
const DEFAULT_RECURSIVE_DEPTH = 3;
const DEFAULT_TEMPLATE_FOLDER = "Templates";
const DEFAULT_TEMPLATE_LIST_LIMIT = 50;
export const DEFAULT_TEMPLATE_SEEDS: Record<string, string> = {
  "Research brief.md":
    "# {{title}}\n\n## Question\n{{question}}\n\n## Sources\n{{sources}}\n\n## Findings\n{{findings}}\n",
  "Research note.md":
    "# {{title}}\n\n## Claim\n{{claim}}\n\n## Evidence\n{{evidence}}\n\n## Open Questions\n{{open_questions}}\n",
  "Linear ticket.md":
    "# {{title}}\n\n## Problem\n{{problem}}\n\n## Proposed Change\n{{proposed_change}}\n\n## Acceptance Criteria\n{{acceptance_criteria}}\n",
  "Experiment log.md":
    "# {{title}}\n\n## Hypothesis\n{{hypothesis}}\n\n## Materials\n{{materials}}\n\n## Procedure\n{{procedure}}\n\n## Results\n{{results}}\n",
  "Essay section.md":
    "# {{title}}\n\n## Thesis\n{{thesis}}\n\n## Draft\n{{draft}}\n\n## Citations\n{{citations}}\n",
  "Design brief.md":
    "# {{title}}\n\n## Goal\n{{goal}}\n\n## Audience\n{{audience}}\n\n## Layout Notes\n{{layout_notes}}\n",
};
const DEFAULT_RESEARCH_MEMORY_FOLDER = "Agent Research Memory";
const DEFAULT_RESEARCH_MEMORY_READ_CHARS = 8000;
const MAX_RESEARCH_MEMORY_READ_CHARS = 20000;
const DEFAULT_RESEARCH_MEMORY_SEARCH_LIMIT = 5;
const DEFAULT_INSPECT_VAULT_FILES = 12;
const DEFAULT_INSPECT_VAULT_CHARS_PER_FILE = 1200;
const TEMPLATE_PLACEHOLDER_PATTERN = /{{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*}}/g;

export function createVaultTools(): AgentTool[] {
  return [
    readCurrentFileTool,
    listCurrentFolderTool,
    listMarkdownFilesTool,
    searchMarkdownFilesTool,
    readMarkdownFilesTool,
    readFileTool,
    inspectVaultContextTool,
    countWordsTool,
    ...createGraphTools(),
    listFolderTool,
    getPathInfoTool,
    searchResearchMemoryTool,
    readResearchMemoryTool,
    appendResearchMemoryTool,
    reviewResearchMemoryTool,
    compactResearchMemoryTool,
    deleteResearchMemoryEntryTool,
    listTemplatesTool,
    readTemplateTool,
    seedDefaultTemplatesTool,
    createTemplateTool,
    fillTemplateTool,
    createFolderTool,
    createFileTool,
    appendFileTool,
    replaceFileTool,
    movePathTool,
    deletePathTool,
    retitleCurrentFileTool,
    prepareEditCurrentSectionTool,
    editCurrentSectionTool,
    appendToCurrentSectionTool,
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
    const queryTerms = tokenizeSearchText(query);
    const results: Array<{
      path: string;
      basename: string;
      matchCount: number;
      score: number;
      reasons: string[];
      snippet: string;
    }> = [];

    for (const file of context.app.vault.getFiles()) {
      if (file.extension !== "md" || isBlockedSystemPath(file.path)) {
        continue;
      }

      const content = await context.app.vault.cachedRead(file);
      const contentLower = content.toLowerCase();
      const phraseIndex = contentLower.indexOf(normalizedQuery);
      const scored = scoreMarkdownSearchResult({
        file,
        content,
        query: normalizedQuery,
        queryTerms,
      });
      if (scored.score <= 0) {
        continue;
      }
      const snippetIndex =
        phraseIndex >= 0
          ? phraseIndex
          : findFirstTermIndex(contentLower, queryTerms);

      results.push({
        path: file.path,
        basename: file.basename,
        matchCount:
          phraseIndex >= 0
            ? countMatches(content, query)
            : countSearchTermMatches(contentLower, queryTerms),
        score: scored.score,
        reasons: scored.reasons,
        snippet: buildSearchSnippet(
          content,
          snippetIndex >= 0 ? snippetIndex : 0,
          maxSnippetChars,
        ),
      });
    }

    results.sort(
      (a, b) =>
        b.score - a.score ||
        b.matchCount - a.matchCount ||
        a.path.localeCompare(b.path),
    );
    const limitedResults = results.slice(0, limit);

    return {
      query,
      limit,
      results: limitedResults,
      truncated: results.length > limitedResults.length,
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

export const inspectVaultContextTool: AgentTool = {
  name: "inspect_vault_context",
  description:
    "Inspect vault folders and read bounded markdown note contents for vault-content questions.",
  parameters: {
    type: "object",
    properties: {
      scope: {
        type: "string",
        enum: ["other_folders", "all_vault", "current_folder"],
        description: "Which vault scope to inspect.",
      },
      maxFiles: {
        type: "integer",
        description: "Maximum markdown files to read. Defaults to 12, maximum 12.",
      },
      maxCharsPerFile: {
        type: "integer",
        description:
          "Maximum characters returned per markdown file. Defaults to 1200, maximum 1200.",
      },
      includeFolderTree: {
        type: "boolean",
        description: "When true, include folder markdown counts.",
      },
      targetFolders: {
        type: "array",
        items: {
          type: "string",
        },
        description:
          "Optional vault-relative folder paths or folder basenames to inspect.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const scope = getInspectVaultScope(args.scope);
    const targetFolders = getOptionalTargetFolders(args);
    const maxFiles = clampPositiveInteger(
      getOptionalInteger(args, "maxFiles") ?? DEFAULT_INSPECT_VAULT_FILES,
      1,
      DEFAULT_INSPECT_VAULT_FILES,
    );
    const maxCharsPerFile = clampPositiveInteger(
      getOptionalInteger(args, "maxCharsPerFile") ??
        DEFAULT_INSPECT_VAULT_CHARS_PER_FILE,
      1,
      DEFAULT_INSPECT_VAULT_CHARS_PER_FILE,
    );
    const includeFolderTree = getOptionalBoolean(args, "includeFolderTree") ?? true;
    const activeFile = getActiveMarkdownFile(context);
    const activeFolder = getParentFolderPath(activeFile.path);
    const skipped: Array<{ path: string; reason: string }> = [];

    const markdownFiles = context.app.vault
      .getFiles()
      .filter((file) => {
        if (file.extension !== "md") {
          return false;
        }

        if (isBlockedSystemPath(file.path)) {
          skipped.push({ path: file.path, reason: "blocked_system_path" });
          return false;
        }

        return true;
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    const scopedFiles =
      targetFolders.length > 0
        ? markdownFiles.filter((file) =>
            isFileInTargetFolders(file.path, targetFolders, activeFile.path),
          )
        : markdownFiles.filter((file) =>
            isFileInInspectScope({
              filePath: file.path,
              activePath: activeFile.path,
              activeFolder,
              scope,
            }),
          );
    const orderedScopedFiles =
      targetFolders.length > 0
        ? [...scopedFiles].sort(compareFilesByRecentMtimeThenPath)
        : scopedFiles;
    const selectedFiles = orderedScopedFiles.slice(0, maxFiles);

    for (const file of orderedScopedFiles.slice(maxFiles)) {
      skipped.push({ path: file.path, reason: "file_limit_exceeded" });
    }

    const files: Array<{
      path: string;
      folder: string;
      basename: string;
      content: string;
      truncated: boolean;
    }> = [];

    for (const file of selectedFiles) {
      try {
        const content = await context.app.vault.cachedRead(file);
        files.push({
          path: file.path,
          folder: getParentFolderPath(file.path),
          basename: file.basename,
          content: truncateText(content, maxCharsPerFile),
          truncated: content.length > maxCharsPerFile,
        });
      } catch (error) {
        skipped.push({
          path: file.path,
          reason: getErrorMessage(error),
        });
      }
    }

    return {
      activeFile: {
        path: activeFile.path,
        folder: activeFolder,
        basename: activeFile.basename,
      },
      scope,
      targetFolders: buildTargetFolderSummary(targetFolders, scopedFiles),
      folders: includeFolderTree ? buildInspectFolderSummary(markdownFiles) : [],
      selectedFiles: selectedFiles.map((file) => ({
        path: file.path,
        folder: getParentFolderPath(file.path),
        basename: file.basename,
      })),
      files,
      skipped,
      truncated:
        orderedScopedFiles.length > selectedFiles.length ||
        files.some((file) => file.truncated),
      limits: {
        maxFiles,
        maxCharsPerFile,
      },
      coverage: buildRetrievalCoverage({
        mode:
          orderedScopedFiles.length > selectedFiles.length ||
          files.some((file) => file.truncated)
            ? "sampled"
            : "exact",
        considered: orderedScopedFiles.length,
        read: files.length,
        skipped: skipped.length,
        truncated:
          orderedScopedFiles.length > selectedFiles.length ||
          files.some((file) => file.truncated),
        reasons: [
          targetFolders.length > 0 ? "target_folder_scope" : `scope_${scope}`,
          orderedScopedFiles.length > selectedFiles.length
            ? "file_limit_applied"
            : "file_limit_not_reached",
          files.some((file) => file.truncated)
            ? "content_truncated"
            : "content_within_limit",
        ],
      }),
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

export const searchResearchMemoryTool: AgentTool = {
  name: "search_research_memory",
  description:
    "Search durable topic memory index entries and return bounded markdown excerpts from matching memory notes.",
  parameters: {
    type: "object",
    required: ["query"],
    properties: {
      query: {
        type: "string",
        description: "Research topic, keyword, or continuation phrase to search for.",
      },
      limit: {
        type: "integer",
        description: "Maximum memory notes to return.",
      },
      maxCharsPerMemory: {
        type: "integer",
        description: "Maximum excerpt characters per memory note.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    const query = getRequiredString(args, "query").trim();
    if (!query) {
      throw new Error("search_research_memory requires a non-empty query.");
    }

    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_RESEARCH_MEMORY_SEARCH_LIMIT,
      1,
      20,
    );
    const maxCharsPerMemory = clampPositiveInteger(
      getOptionalInteger(args, "maxCharsPerMemory") ??
        DEFAULT_RESEARCH_MEMORY_READ_CHARS,
      1,
      MAX_RESEARCH_MEMORY_READ_CHARS,
    );
    const matches = rankResearchMemoryIndex(
      context.getResearchMemoryIndex?.() ?? [],
      query,
    ).slice(0, limit);
    const memories: Array<
      ResearchMemoryIndexEntry & { found: boolean; content: string }
    > = [];

    for (const entry of matches) {
      const file = context.app.vault.getFileByPath(entry.path);
      if (!file) {
        memories.push({
          ...entry,
          found: false,
          content: "",
        });
        continue;
      }

      const content = await context.app.vault.read(file);
      memories.push({
        ...entry,
        found: true,
        content: truncateText(content, maxCharsPerMemory),
      });
    }

    return {
      query,
      matches: memories,
      truncated: memories.some((entry) => /\n\n\[truncated\]$/u.test(entry.content)),
    };
  },
};

export const readResearchMemoryTool: AgentTool = {
  name: "read_research_memory",
  description: "Read one durable topic memory markdown note by topic.",
  parameters: {
    type: "object",
    required: ["topic"],
    properties: {
      topic: {
        type: "string",
        description: "Topic name to read from durable research memory.",
      },
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    const topic = getRequiredString(args, "topic").trim();
    if (!topic) {
      throw new Error("read_research_memory requires a non-empty topic.");
    }

    const maxChars = clampPositiveInteger(
      getOptionalInteger(args, "maxChars") ?? DEFAULT_RESEARCH_MEMORY_READ_CHARS,
      1,
      MAX_RESEARCH_MEMORY_READ_CHARS,
    );
    const path = buildResearchMemoryPath(context, topic);
    const indexed = (context.getResearchMemoryIndex?.() ?? []).find(
      (entry) => entry.path === path || entry.topic.toLowerCase() === topic.toLowerCase(),
    );
    const targetPath = indexed?.path ?? path;
    const file = context.app.vault.getFileByPath(targetPath);
    if (!file) {
      return {
        topic,
        path: targetPath,
        found: false,
        content: "",
      };
    }

    const content = await context.app.vault.read(file);
    return {
      topic: indexed?.topic ?? topic,
      path: targetPath,
      found: true,
      keywords: indexed?.keywords ?? [],
      lastUpdated: indexed?.lastUpdated ?? null,
      content: truncateText(content, maxChars),
    };
  },
};

export const appendResearchMemoryTool: AgentTool = {
  name: "append_research_memory",
  description:
    "Append durable topic memory to a markdown note under the configured research memory folder and update the plugin memory index.",
  parameters: {
    type: "object",
    required: ["topic", "text"],
    properties: {
      topic: {
        type: "string",
        description: "Research topic name.",
      },
      text: {
        type: "string",
        description: "Markdown memory content to append.",
      },
      keywords: {
        type: "array",
        items: { type: "string" },
        description: "Optional keywords for recall.",
      },
      sourcePaths: {
        type: "array",
        items: { type: "string" },
        description: "Optional vault-relative source note paths.",
      },
      sourceUrls: {
        type: "array",
        items: { type: "string" },
        description: "Optional web source URLs.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    const topic = getRequiredString(args, "topic").trim();
    const text = getRequiredString(args, "text").trim();
    if (!topic) {
      throw new Error("append_research_memory requires a non-empty topic.");
    }
    if (!text) {
      throw new Error("append_research_memory requires non-empty text.");
    }

    const keywords = getOptionalStringArray(args, "keywords");
    const sourcePaths = getOptionalStringArray(args, "sourcePaths");
    const sourceUrls = getOptionalStringArray(args, "sourceUrls");
    const path = buildResearchMemoryPath(context, topic);
    const contentHash = hashResearchMemoryText(text);
    const existingIndexEntry = (context.getResearchMemoryIndex?.() ?? []).find(
      (entry) => entry.path === path,
    );
    if (existingIndexEntry?.contentHash === contentHash) {
      return {
        path,
        operation: "duplicate",
        topic,
        keywords: existingIndexEntry.keywords,
        lastUpdated: existingIndexEntry.lastUpdated,
        contentHash,
        duplicate: true,
        bytesWritten: 0,
      };
    }
    await ensureParentFolder(context, path, true);
    const now = context.now?.() ?? new Date();
    const nowIso = now.toISOString();
    const entryText = formatResearchMemoryAppend({
      topic,
      text,
      keywords,
      sourcePaths,
      sourceUrls,
      nowIso,
    });
    const file = context.app.vault.getFileByPath(path);
    let operation: "create" | "append";

    if (file) {
      const current = await context.app.vault.read(file);
      const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
      await context.app.vault.modify(file, `${current}${prefix}${entryText}`);
      operation = "append";
    } else {
      await context.app.vault.create(path, `# ${topic}\n\n${entryText}`);
      operation = "create";
    }

    const nextIndex = upsertResearchMemoryIndexEntry(
      context.getResearchMemoryIndex?.() ?? [],
      {
        topic,
        path,
        keywords,
        lastUpdated: nowIso,
        confidence: "high",
        sourcePaths,
        sourceUrls,
        contentHash,
        updateCount: (existingIndexEntry?.updateCount ?? 0) + 1,
      },
    );
    await context.setResearchMemoryIndex?.(nextIndex);

    return {
      path,
      operation,
      topic,
      keywords,
      lastUpdated: nowIso,
      contentHash,
      duplicate: false,
      bytesWritten: getByteLength(entryText),
    };
  },
};

export const reviewResearchMemoryTool: AgentTool = {
  name: "review_research_memory",
  description:
    "Review durable research memory hygiene: missing files, duplicate topics or content hashes, and cleanup recommendations.",
  parameters: {
    type: "object",
    properties: {
      includeExisting: {
        type: "boolean",
        description: "When true, include indexed memory entries in the result.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    const entries = context.getResearchMemoryIndex?.() ?? [];
    const includeExisting = getOptionalBoolean(args, "includeExisting") ?? false;
    const duplicates = findResearchMemoryDuplicates(entries);
    const stale: Array<{ topic: string; path: string; reason: string }> = [];

    for (const entry of entries) {
      if (!context.app.vault.getFileByPath(entry.path)) {
        stale.push({
          topic: entry.topic,
          path: entry.path,
          reason: "indexed_file_missing",
        });
      }
    }

    const recommendations: string[] = [];
    if (duplicates.length > 0) {
      recommendations.push("Compact or merge duplicate research memory topics.");
    }
    if (stale.length > 0) {
      recommendations.push("Remove or repair stale memory index entries.");
    }
    if (recommendations.length === 0) {
      recommendations.push("No memory hygiene issues detected.");
    }

    return {
      operation: "review_research_memory",
      entryCount: entries.length,
      duplicates,
      stale,
      recommendations,
      entries: includeExisting ? entries : undefined,
    };
  },
};

export const compactResearchMemoryTool: AgentTool = {
  name: "compact_research_memory",
  description:
    "Replace one research memory note with a compacted summary after creating a backup.",
  parameters: {
    type: "object",
    required: ["topic", "summary"],
    properties: {
      topic: { type: "string" },
      summary: { type: "string" },
      keywords: { type: "array", items: { type: "string" } },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    const topic = getRequiredString(args, "topic").trim();
    const summary = getRequiredString(args, "summary").trim();
    if (!topic || !summary) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "compact_research_memory requires non-empty topic and summary.",
      );
    }
    const indexed = findResearchMemoryIndexEntry(context, topic);
    const path = indexed?.path ?? buildResearchMemoryPath(context, topic);
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    const backupPath = await backupCurrentFile(context, file, current);
    const nowIso = (context.now?.() ?? new Date()).toISOString();
    const content = [
      `# ${indexed?.topic ?? topic}`,
      "",
      `## Compacted Memory - ${nowIso}`,
      "",
      summary,
      "",
    ].join("\n");
    await context.app.vault.modify(file, content);
    const keywords = getOptionalStringArray(args, "keywords");
    const nextIndex = upsertResearchMemoryIndexEntry(
      context.getResearchMemoryIndex?.() ?? [],
      {
        topic: indexed?.topic ?? topic,
        path,
        keywords,
        lastUpdated: nowIso,
        confidence: indexed?.confidence ?? "medium",
        sourcePaths: indexed?.sourcePaths ?? [],
        sourceUrls: indexed?.sourceUrls ?? [],
        contentHash: hashResearchMemoryText(summary),
        updateCount: (indexed?.updateCount ?? 0) + 1,
      },
    );
    await context.setResearchMemoryIndex?.(nextIndex);
    return {
      path,
      operation: "replace",
      topic: indexed?.topic ?? topic,
      backupPath,
      bytesWritten: getByteLength(content),
      bytesDeleted: getByteLength(current),
    };
  },
};

export const deleteResearchMemoryEntryTool: AgentTool = {
  name: "delete_research_memory_entry",
  description:
    "Trash one durable research memory note and remove its index entry. Requires explicit delete/remove/trash memory intent.",
  parameters: {
    type: "object",
    required: ["topic"],
    properties: {
      topic: { type: "string" },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertResearchMemoryEnabled(context);
    if (!/\b(delete|remove|trash)\b/i.test(context.originalPrompt)) {
      throw new Error("delete_research_memory_entry requires explicit delete, remove, or trash intent.");
    }
    const topic = getRequiredString(args, "topic").trim();
    const indexed = findResearchMemoryIndexEntry(context, topic);
    const path = indexed?.path ?? buildResearchMemoryPath(context, topic);
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    const backupPath = await backupCurrentFile(context, file, current);
    await trashVaultPath(context, file);
    const nextIndex = (context.getResearchMemoryIndex?.() ?? []).filter(
      (entry) => entry.path !== path,
    );
    await context.setResearchMemoryIndex?.(nextIndex);
    return {
      path,
      operation: "trash",
      topic: indexed?.topic ?? topic,
      backupPath,
      bytesDeleted: getByteLength(current),
    };
  },
};

export const listTemplatesTool: AgentTool = {
  name: "list_templates",
  description:
    "List reusable markdown templates from the configured template folder.",
  parameters: {
    type: "object",
    properties: {
      limit: {
        type: "integer",
        description: "Maximum templates to return.",
      },
      includePlaceholders: {
        type: "boolean",
        description: "When true, include {{field}} placeholder names for each template.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateIntent(context, "list_templates");
    const templateFolder = getTemplateFolder(context);
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_TEMPLATE_LIST_LIMIT,
      1,
      MAX_LISTED_FILES,
    );
    const includePlaceholders =
      getOptionalBoolean(args, "includePlaceholders") ?? false;
    const templateFiles = getVaultEntries(context)
      .filter((entry) => getEntryExtension(entry) === "md")
      .filter((entry) => isPathInFolder(entry.path, templateFolder))
      .filter((entry) => !isBlockedSystemPath(entry.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    const templates = [];

    for (const entry of templateFiles.slice(0, limit)) {
      const item: {
        path: string;
        basename: string;
        placeholders?: string[];
      } = {
        path: entry.path,
        basename: getEntryBasename(entry),
      };

      if (includePlaceholders) {
        const file = getMarkdownFileByPath(context, entry.path);
        item.placeholders = extractTemplatePlaceholders(
          await context.app.vault.cachedRead(file),
        );
      }

      templates.push(item);
    }

    return {
      templateFolder,
      templates,
      truncated: templateFiles.length > limit,
    };
  },
};

export const readTemplateTool: AgentTool = {
  name: "read_template",
  description:
    "Read a reusable markdown template from the configured template folder.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description:
          "Template path. Bare filenames are resolved inside the configured template folder.",
      },
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateIntent(context, "read_template");
    const path = normalizeTemplatePath(
      context,
      getRequiredString(args, "path"),
    );
    const maxChars = clampPositiveInteger(
      getOptionalInteger(args, "maxChars") ?? MAX_FILE_READ_CHARS,
      1,
      MAX_FILE_READ_CHARS,
    );
    const file = getMarkdownFileByPath(context, path);
    const content = await context.app.vault.cachedRead(file);

    return {
      path: file.path,
      content: truncateText(content, maxChars),
      placeholders: extractTemplatePlaceholders(content),
      truncated: content.length > maxChars,
    };
  },
};

export const seedDefaultTemplatesTool: AgentTool = {
  name: "seed_default_templates",
  description:
    "Create the built-in starter markdown templates in the configured template folder when explicitly requested.",
  parameters: {
    type: "object",
    properties: {
      createFolders: {
        type: "boolean",
        description: "When true, create the template folder first. Defaults to true.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateSeedIntent(context, "seed_default_templates");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;
    const templateFolder = getTemplateFolder(context);
    const createdTemplates: Array<{
      path: string;
      placeholders: string[];
      bytesWritten: number;
    }> = [];
    const skippedExisting: string[] = [];
    let totalBytesWritten = 0;

    for (const [fileName, content] of Object.entries(DEFAULT_TEMPLATE_SEEDS)) {
      const path = normalizeTemplatePath(context, fileName);
      if (getAbstractPath(context, path)) {
        skippedExisting.push(path);
        continue;
      }

      await ensureParentFolder(context, path, createFolders);
      await context.app.vault.create(path, content);
      const bytesWritten = getByteLength(content);
      totalBytesWritten += bytesWritten;
      createdTemplates.push({
        path,
        placeholders: extractTemplatePlaceholders(content),
        bytesWritten,
      });
    }

    return {
      path: templateFolder,
      operation: "create",
      templateFolder,
      createdTemplates,
      skippedExisting,
      affectedCount: createdTemplates.length,
      bytesWritten: totalBytesWritten,
    };
  },
};

export const createTemplateTool: AgentTool = {
  name: "create_template",
  description:
    "Create a reusable markdown template with {{field}} placeholders in the configured template folder.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description:
          "Template markdown path. Bare filenames are resolved inside the configured template folder.",
      },
      content: {
        type: "string",
        description: "Reusable markdown template content.",
      },
      createFolders: {
        type: "boolean",
        description: "When true, create missing parent folders first.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateCreateIntent(context, "create_template");
    const path = normalizeTemplatePath(
      context,
      getRequiredString(args, "path"),
    );
    const content = getString(args, "content");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;

    if (getAbstractPath(context, path)) {
      throw new Error(`Path already exists: ${path}`);
    }

    await ensureParentFolder(context, path, createFolders);
    await context.app.vault.create(path, content);

    return {
      path,
      operation: "create",
      templateFolder: getTemplateFolder(context),
      placeholders: extractTemplatePlaceholders(content),
      bytesWritten: getByteLength(content),
    };
  },
};

export const fillTemplateTool: AgentTool = {
  name: "fill_template",
  description:
    "Fill a saved or ad hoc markdown template with {{field}} values and create a new markdown note.",
  parameters: {
    type: "object",
    required: ["values"],
    properties: {
      templatePath: {
        type: "string",
        description:
          "Optional saved template path. Bare filenames are resolved inside the configured template folder.",
      },
      templateText: {
        type: "string",
        description:
          "Optional ad hoc template markdown. Use this when the user supplies the template in the mission.",
      },
      values: {
        type: "object",
        description: "Placeholder values keyed by field name.",
        additionalProperties: {
          type: "string",
        },
      },
      targetPath: {
        type: "string",
        description:
          "Optional vault-relative markdown path for the new filled note.",
      },
      createFolders: {
        type: "boolean",
        description: "When true, create missing parent folders first.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateFillIntent(context, "fill_template");
    const templatePathArg = getOptionalString(args, "templatePath");
    const templateTextArg = getOptionalString(args, "templateText");

    if (Boolean(templatePathArg) === Boolean(templateTextArg)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "fill_template requires exactly one of templatePath or templateText.",
      );
    }

    const values = getOptionalStringMap(args, "values");
    const templateSource =
      templatePathArg !== undefined ? "saved_template" : "ad_hoc_template";
    const templatePath =
      templatePathArg !== undefined
        ? normalizeTemplatePath(context, templatePathArg)
        : undefined;
    const templateText =
      templatePath !== undefined
        ? await context.app.vault.cachedRead(getMarkdownFileByPath(context, templatePath))
        : templateTextArg ?? "";
    const fill = fillTemplateText(templateText, values);
    const targetPath = normalizeTemplateTargetPath({
      context,
      explicitTargetPath: getOptionalString(args, "targetPath"),
      values,
      templatePath,
    });
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;

    if (getAbstractPath(context, targetPath)) {
      throw new Error(`Path already exists: ${targetPath}`);
    }

    await ensureParentFolder(context, targetPath, createFolders);
    await context.app.vault.create(targetPath, fill.content);

    return {
      path: targetPath,
      operation: "create",
      templateSource,
      templatePath,
      placeholders: fill.placeholders,
      valuesApplied: Object.keys(values).sort(),
      bytesWritten: getByteLength(fill.content),
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

export const appendToCurrentSectionTool: AgentTool = {
  name: "append_to_current_section",
  description:
    "Append markdown text below a named heading section in the active markdown note after creating a backup.",
  parameters: {
    type: "object",
    required: ["heading", "content"],
    properties: {
      heading: {
        type: "string",
        description:
          "Exact ATX heading text without leading # characters, for example Findings.",
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
          "Markdown content to insert at the end of the target section.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const heading = getRequiredString(args, "heading").trim();
    const level = getOptionalInteger(args, "level");
    const content = getRequiredString(args, "content").trim();

    if (!heading) {
      throw new Error("append_to_current_section requires a non-empty heading.");
    }

    if (level !== undefined && (level < 1 || level > 6)) {
      throw new Error("append_to_current_section level must be between 1 and 6.");
    }

    if (!SECTION_APPEND_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "append_to_current_section requires the user to explicitly ask to write, add, append, or insert content below a section or heading.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const edit = appendMarkdownToSection(current, { heading, level, content });
    const backupPath = await backupCurrentFile(context, file, current);

    await context.app.vault.modify(file, edit.updated);

    return {
      path: file.path,
      backupPath,
      heading,
      level: edit.level,
      bytesWritten: getByteLength(edit.insertedText),
      insertedChars: edit.insertedText.length,
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

interface TemplateFillResult {
  content: string;
  placeholders: string[];
}

function assertTemplateIntent(context: ToolExecutionContext, toolName: string) {
  if (!TEMPLATE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to ask about templates.`);
  }
}

function assertTemplateCreateIntent(
  context: ToolExecutionContext,
  toolName: string,
) {
  if (
    !TEMPLATE_CREATE_INTENT_PATTERN.test(context.originalPrompt) ||
    TEMPLATE_OUTPUT_CREATE_INTENT_PATTERN.test(context.originalPrompt)
  ) {
    throw new Error(`${toolName} requires the user to explicitly ask to create, make, or save a template.`);
  }
}

function assertTemplateFillIntent(
  context: ToolExecutionContext,
  toolName: string,
) {
  if (!TEMPLATE_FILL_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to fill, use, apply, complete, populate, or render a template.`);
  }
}

function assertTemplateSeedIntent(
  context: ToolExecutionContext,
  toolName: string,
) {
  if (!TEMPLATE_SEED_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to seed, install, create, make, or add default starter templates.`);
  }
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

function assertResearchMemoryEnabled(context: ToolExecutionContext) {
  if (context.settings.researchMemoryEnabled === false) {
    throw new Error("Research memory is disabled in plugin settings.");
  }
}

function getOptionalStringArray(
  args: Record<string, unknown>,
  key: string,
): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 24);
}

function buildResearchMemoryPath(
  context: ToolExecutionContext,
  topic: string,
): string {
  const projectMemory = getProjectMemoryLocation(
    context.getCurrentMarkdownFile?.()?.path ?? null,
  );
  const folder = normalizeVaultPath(
    projectMemory.researchNotesFolder ||
      context.settings.researchMemoryFolder ||
      DEFAULT_RESEARCH_MEMORY_FOLDER,
  );
  const slug = sanitizeResearchTopicSlug(topic);
  return normalizeVaultPath(`${folder}/${slug}.md`, { requireMarkdown: true });
}

function sanitizeResearchTopicSlug(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);

  return slug || "untitled-topic";
}

function formatResearchMemoryAppend({
  topic,
  text,
  keywords,
  sourcePaths,
  sourceUrls,
  nowIso,
}: {
  topic: string;
  text: string;
  keywords: string[];
  sourcePaths: string[];
  sourceUrls: string[];
  nowIso: string;
}): string {
  const metadata = [
    `## Memory - ${nowIso}`,
    "",
    `Topic: ${topic}`,
    keywords.length > 0 ? `Keywords: ${keywords.join(", ")}` : null,
    sourcePaths.length > 0 ? `Vault sources: ${sourcePaths.join(", ")}` : null,
    sourceUrls.length > 0 ? `Web sources: ${sourceUrls.join(", ")}` : null,
    "",
    text,
    "",
  ].filter((line): line is string => line !== null);

  return metadata.join("\n");
}

function upsertResearchMemoryIndexEntry(
  entries: ResearchMemoryIndexEntry[],
  entry: ResearchMemoryIndexEntry,
): ResearchMemoryIndexEntry[] {
  const byPath = new Map<string, ResearchMemoryIndexEntry>();
  for (const existing of entries) {
    byPath.set(existing.path, existing);
  }

  byPath.set(entry.path, {
    topic: entry.topic,
    path: entry.path,
    keywords: dedupeStrings([
      ...(byPath.get(entry.path)?.keywords ?? []),
      ...entry.keywords,
      ...extractResearchKeywords(entry.topic),
    ]).slice(0, 24),
    lastUpdated: entry.lastUpdated,
    confidence: entry.confidence ?? byPath.get(entry.path)?.confidence,
    sourcePaths: dedupeStrings([
      ...(byPath.get(entry.path)?.sourcePaths ?? []),
      ...(entry.sourcePaths ?? []),
    ]).slice(0, 24),
    sourceUrls: dedupeStrings([
      ...(byPath.get(entry.path)?.sourceUrls ?? []),
      ...(entry.sourceUrls ?? []),
    ]).slice(0, 24),
    contentHash: entry.contentHash ?? byPath.get(entry.path)?.contentHash,
    updateCount: entry.updateCount ?? byPath.get(entry.path)?.updateCount,
  });

  return [...byPath.values()]
    .sort((left, right) => right.lastUpdated.localeCompare(left.lastUpdated))
    .slice(0, 200);
}

function findResearchMemoryIndexEntry(
  context: ToolExecutionContext,
  topic: string,
): ResearchMemoryIndexEntry | undefined {
  const targetPath = buildResearchMemoryPath(context, topic);
  return (context.getResearchMemoryIndex?.() ?? []).find(
    (entry) =>
      entry.path === targetPath ||
      entry.topic.toLowerCase() === topic.trim().toLowerCase(),
  );
}

function findResearchMemoryDuplicates(
  entries: ResearchMemoryIndexEntry[],
): Array<{ topic: string; paths: string[]; reason: string }> {
  const groups = new Map<string, ResearchMemoryIndexEntry[]>();
  for (const entry of entries) {
    const keys = [
      `topic:${entry.topic.trim().toLowerCase()}`,
      entry.contentHash ? `hash:${entry.contentHash}` : null,
    ].filter((key): key is string => key !== null);
    for (const key of keys) {
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
  }

  return [...groups.entries()]
    .filter(([, group]) => new Set(group.map((entry) => entry.path)).size > 1)
    .map(([key, group]) => ({
      topic: group[0]?.topic ?? "unknown",
      paths: dedupeStrings(group.map((entry) => entry.path)),
      reason: key.startsWith("hash:") ? "duplicate_content_hash" : "duplicate_topic",
    }));
}

function hashResearchMemoryText(value: string): string {
  let hash = 0;
  for (const char of value.replace(/\s+/g, " ").trim().toLowerCase()) {
    hash = (hash * 31 + char.charCodeAt(0)) | 0;
  }
  return Math.abs(hash).toString(36) || "0";
}

function rankResearchMemoryIndex(
  entries: ResearchMemoryIndexEntry[],
  query: string,
): ResearchMemoryIndexEntry[] {
  const queryTokens = new Set(extractResearchKeywords(query));
  if (queryTokens.size === 0) {
    return entries;
  }

  return entries
    .map((entry) => ({
      entry,
      score: scoreResearchMemoryEntry(entry, queryTokens),
    }))
    .filter((item) => item.score > 0)
    .sort((left, right) =>
      right.score === left.score
        ? right.entry.lastUpdated.localeCompare(left.entry.lastUpdated)
        : right.score - left.score,
    )
    .map((item) => item.entry);
}

function scoreResearchMemoryEntry(
  entry: ResearchMemoryIndexEntry,
  queryTokens: Set<string>,
): number {
  const haystack = new Set([
    ...extractResearchKeywords(entry.topic),
    ...entry.keywords.flatMap(extractResearchKeywords),
  ]);
  let score = 0;
  for (const token of queryTokens) {
    if (haystack.has(token)) {
      score += 1;
    }
  }
  return score;
}

function extractResearchKeywords(text: string): string[] {
  return dedupeStrings(
    (text.toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) ?? []).filter(
      (token) =>
        !new Set([
          "the",
          "and",
          "for",
          "this",
          "that",
          "with",
          "memory",
          "research",
          "topic",
          "continue",
        ]).has(token),
    ),
  );
}

function getTemplateFolder(context: ToolExecutionContext): string {
  const rawFolder =
    context.settings.templateFolder?.trim() || DEFAULT_TEMPLATE_FOLDER;
  const folder = normalizeVaultPath(rawFolder);

  if (folder.toLowerCase().endsWith(".md")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Template folder must be a vault folder path, not a markdown file.",
    );
  }

  return folder;
}

function getTemplateOutputFolder(context: ToolExecutionContext): string {
  const rawFolder = context.settings.templateOutputFolder?.trim();
  if (!rawFolder) {
    return getActiveProjectBaseFolder(context);
  }

  const folder = normalizeVaultPath(rawFolder, { allowRoot: true });
  if (folder.toLowerCase().endsWith(".md")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Template output folder must be a vault folder path, not a markdown file.",
    );
  }

  return folder;
}

function getActiveProjectBaseFolder(context: ToolExecutionContext): string {
  const activePath =
    context.getCurrentMarkdownFile?.()?.path ??
    context.app.workspace.getActiveFile()?.path ??
    "";
  if (!activePath.trim()) {
    return "";
  }

  const normalizedPath = normalizeVaultPath(activePath, {
    requireMarkdown: true,
  });
  const lastSlash = normalizedPath.lastIndexOf("/");
  if (lastSlash <= 0) {
    return "";
  }

  return normalizeVaultPath(normalizedPath.slice(0, lastSlash), {
    allowRoot: true,
  });
}

function normalizeTemplatePath(
  context: ToolExecutionContext,
  rawPath: string,
): string {
  const templateFolder = getTemplateFolder(context);
  const inputPath = normalizeVaultPath(rawPath, { requireMarkdown: true });
  const path = isPathInFolder(inputPath, templateFolder)
    ? inputPath
    : normalizeVaultPath(`${templateFolder}/${inputPath}`, {
        requireMarkdown: true,
      });

  if (!isPathInFolder(path, templateFolder)) {
    throw new ToolExecutionError(
      "unsafe_path",
      `Template path must be inside ${templateFolder}.`,
    );
  }

  return path;
}

function normalizeTemplateTargetPath({
  context,
  explicitTargetPath,
  values,
  templatePath,
}: {
  context: ToolExecutionContext;
  explicitTargetPath?: string;
  values: Record<string, string>;
  templatePath?: string;
}): string {
  if (explicitTargetPath?.trim()) {
    return normalizeVaultPath(explicitTargetPath, { requireMarkdown: true });
  }

  const outputFolder = getTemplateOutputFolder(context);
  const title =
    values.title ||
    values.noteTitle ||
    values.note_title ||
    values.name ||
    values.topic ||
    getTemplateTitleFromPath(templatePath);
  const basename =
    toSafeNoteBasename(title) || `Filled Template ${formatTimestampForPath(context)}`;

  return normalizeVaultPath(joinVaultPath(outputFolder, `${basename}.md`), {
    requireMarkdown: true,
  });
}

function extractTemplatePlaceholders(templateText: string): string[] {
  const placeholders: string[] = [];
  const seen = new Set<string>();
  TEMPLATE_PLACEHOLDER_PATTERN.lastIndex = 0;

  for (const match of templateText.matchAll(TEMPLATE_PLACEHOLDER_PATTERN)) {
    const placeholder = match[1];
    if (!seen.has(placeholder)) {
      seen.add(placeholder);
      placeholders.push(placeholder);
    }
  }

  return placeholders;
}

function fillTemplateText(
  templateText: string,
  values: Record<string, string>,
): TemplateFillResult {
  const placeholders = extractTemplatePlaceholders(templateText);
  const missing = placeholders.filter(
    (placeholder) => !Object.prototype.hasOwnProperty.call(values, placeholder),
  );

  if (missing.length > 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `fill_template missing values for placeholders: ${missing.join(", ")}`,
    );
  }

  TEMPLATE_PLACEHOLDER_PATTERN.lastIndex = 0;
  const content = templateText.replace(
    TEMPLATE_PLACEHOLDER_PATTERN,
    (_match, placeholder: string) => values[placeholder] ?? "",
  );
  const unresolved = extractTemplatePlaceholders(content);
  if (unresolved.length > 0) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `fill_template left unresolved placeholders: ${unresolved.join(", ")}`,
    );
  }

  return { content, placeholders };
}

function getOptionalStringMap(
  args: Record<string, unknown>,
  key: string,
): Record<string, string> {
  const value = args[key];
  if (value === undefined || value === null) {
    return {};
  }

  if (!isRecord(value)) {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Expected "${key}" to be an object of string values.`,
    );
  }

  const output: Record<string, string> = {};
  for (const [field, fieldValue] of Object.entries(value)) {
    if (
      typeof fieldValue !== "string" &&
      typeof fieldValue !== "number" &&
      typeof fieldValue !== "boolean"
    ) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `Expected "${key}.${field}" to be a string, number, or boolean.`,
      );
    }

    output[field] = String(fieldValue);
  }

  return output;
}

function isPathInFolder(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}/`);
}

type InspectVaultScope = "other_folders" | "all_vault" | "current_folder";

function getInspectVaultScope(value: unknown): InspectVaultScope {
  if (value === undefined || value === null || value === "") {
    return "other_folders";
  }

  if (
    value === "other_folders" ||
    value === "all_vault" ||
    value === "current_folder"
  ) {
    return value;
  }

  throw new ToolExecutionError(
    "invalid_arguments",
    "inspect_vault_context scope must be other_folders, all_vault, or current_folder.",
  );
}

function getOptionalTargetFolders(args: Record<string, unknown>): string[] {
  const value = args.targetFolders;
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "targetFolders must be an array of strings.",
    );
  }

  const targets = new Set<string>();
  for (const item of value) {
    const normalized = normalizeVaultPath(item);
    if (normalized) {
      targets.add(normalized);
    }
  }

  return [...targets];
}

function isFileInInspectScope({
  filePath,
  activePath,
  activeFolder,
  scope,
}: {
  filePath: string;
  activePath: string;
  activeFolder: string;
  scope: InspectVaultScope;
}): boolean {
  const folder = getParentFolderPath(filePath);

  if (scope === "all_vault") {
    return true;
  }

  if (scope === "current_folder") {
    return folder === activeFolder;
  }

  return filePath !== activePath && folder !== activeFolder;
}

function isFileInTargetFolders(
  filePath: string,
  targets: string[],
  activePath: string,
): boolean {
  if (filePath === activePath) {
    return false;
  }

  const folder = getParentFolderPath(filePath);
  return targets.some((target) => doesFolderMatchTarget(folder, target));
}

function compareFilesByRecentMtimeThenPath(left: TFile, right: TFile): number {
  const rightMtime = getFileMtime(right);
  const leftMtime = getFileMtime(left);

  if (rightMtime !== leftMtime) {
    return rightMtime - leftMtime;
  }

  return left.path.localeCompare(right.path);
}

function getFileMtime(file: TFile): number {
  const mtime = file.stat?.mtime;
  return typeof mtime === "number" && Number.isFinite(mtime) ? mtime : 0;
}

function doesFolderMatchTarget(folder: string, target: string): boolean {
  const folderLower = folder.toLowerCase();
  const targetLower = target.toLowerCase();

  if (folderLower === targetLower || folderLower.startsWith(`${targetLower}/`)) {
    return true;
  }

  if (!targetLower.includes("/")) {
    return folderLower.split("/").includes(targetLower);
  }

  return false;
}

function buildTargetFolderSummary(
  targets: string[],
  files: Array<{ path: string }>,
) {
  const folderPaths = new Set(files.map((file) => getParentFolderPath(file.path)));
  const matched = targets.map((target) => ({
    target,
    paths: [...folderPaths]
      .filter((folder) => doesFolderMatchTarget(folder, target))
      .sort((left, right) => left.localeCompare(right)),
  }));

  return {
    requested: targets,
    matched: matched.filter((item) => item.paths.length > 0),
    unmatched: matched
      .filter((item) => item.paths.length === 0)
      .map((item) => item.target),
  };
}

function buildInspectFolderSummary(files: Array<{ path: string }>) {
  const folderCounts = new Map<string, number>();

  for (const file of files) {
    const folder = getParentFolderPath(file.path);
    folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1);
  }

  return [...folderCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, markdownCount]) => ({
      path,
      name: path ? getPathName(path) : "",
      markdownCount,
    }));
}

function getTemplateTitleFromPath(path: string | undefined): string {
  if (!path) {
    return "";
  }

  return getPathName(path).replace(/\.md$/i, "");
}

function toSafeNoteBasename(value: string): string {
  return value
    .trim()
    .replace(/[\\/:*?"<>|#[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function formatTimestampForPath(context: ToolExecutionContext): string {
  return (context.now?.() ?? new Date())
    .toISOString()
    .replace(/\.\d{3}Z$/, "")
    .replace(/[T:]/g, "-");
}

function joinVaultPath(folder: string, child: string): string {
  return folder ? `${folder}/${child}` : child;
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
      try {
        await context.app.vault.createFolder(currentPath);
        createdFolders.push(currentPath);
      } catch (error) {
        if (!isFolderAlreadyExistsError(error)) {
          throw error;
        }
      }
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

function scoreMarkdownSearchResult({
  file,
  content,
  query,
  queryTerms,
}: {
  file: TFile;
  content: string;
  query: string;
  queryTerms: string[];
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const contentLower = content.toLowerCase();
  const titleLower = file.basename.toLowerCase();
  const pathLower = file.path.toLowerCase();
  const phraseMatches = countMatches(content, query);

  if (titleLower === query || pathLower === query) {
    score += 120;
    reasons.push("path_or_title_exact");
  } else if (titleLower.includes(query) || pathLower.includes(query)) {
    score += 70;
    reasons.push("path_or_title_match");
  }

  if (phraseMatches > 0) {
    score += Math.min(80, phraseMatches * 16);
    reasons.push("phrase_match");
  }

  let titleTermMatches = 0;
  let pathTermMatches = 0;
  let bodyTermMatches = 0;

  for (const term of queryTerms) {
    if (titleLower.includes(term)) {
      titleTermMatches += 1;
    }

    if (pathLower.includes(term)) {
      pathTermMatches += 1;
    }

    if (contentLower.includes(term)) {
      bodyTermMatches += countTermOccurrences(contentLower, term);
    }
  }

  if (titleTermMatches > 0) {
    score += Math.min(60, titleTermMatches * 20);
    reasons.push("title_terms");
  }

  if (pathTermMatches > 0) {
    score += Math.min(30, pathTermMatches * 8);
    reasons.push("path_terms");
  }

  if (bodyTermMatches > 0) {
    score += Math.min(50, bodyTermMatches * 4);
    reasons.push("content_terms");
  }

  return {
    score,
    reasons: dedupeStrings(reasons),
  };
}

function tokenizeSearchText(text: string): string[] {
  return dedupeStrings(
    text
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9_-]{1,}/g) ?? [],
  ).filter((term) => !SEARCH_STOPWORDS.has(term));
}

function findFirstTermIndex(contentLower: string, queryTerms: string[]): number {
  return queryTerms.reduce((bestIndex, term) => {
    const index = contentLower.indexOf(term);
    if (index < 0) {
      return bestIndex;
    }

    return bestIndex < 0 ? index : Math.min(bestIndex, index);
  }, -1);
}

function countSearchTermMatches(
  contentLower: string,
  queryTerms: string[],
): number {
  return queryTerms.reduce(
    (count, term) => count + countTermOccurrences(contentLower, term),
    0,
  );
}

function countTermOccurrences(contentLower: string, term: string): number {
  if (!term) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (offset < contentLower.length) {
    const index = contentLower.indexOf(term, offset);
    if (index < 0) {
      break;
    }

    count += 1;
    offset = index + term.length;
  }

  return count;
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

const SEARCH_STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "into",
  "about",
  "note",
  "notes",
  "file",
  "files",
  "vault",
  "search",
  "find",
]);

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

  try {
    await context.app.vault.createFolder(BACKUP_FOLDER);
  } catch (error) {
    if (isFolderAlreadyExistsError(error)) {
      return;
    }

    throw error;
  }
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

interface SectionAppendResult {
  updated: string;
  level: number;
  insertedText: string;
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

function appendMarkdownToSection(
  markdown: string,
  { heading, level, content }: SectionReplacementInput,
): SectionAppendResult {
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
  const insertAt = nextBoundary?.lineStart ?? markdown.length;
  const prefix = markdown.slice(0, insertAt);
  const suffix = markdown.slice(insertAt);
  const insertedText = formatSectionAppendBody(content, prefix, suffix);

  return {
    updated: `${prefix}${insertedText}${suffix}`,
    level: match.level,
    insertedText,
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

function formatSectionAppendBody(
  content: string,
  prefix: string,
  suffix: string,
): string {
  const body = content.trim();
  if (!body) {
    return "";
  }

  const leading = prefix.endsWith("\n\n")
    ? ""
    : prefix.endsWith("\n")
      ? "\n"
      : "\n\n";
  const trailing = suffix
    ? body.endsWith("\n\n")
      ? ""
      : body.endsWith("\n")
        ? "\n"
        : "\n\n"
    : body.endsWith("\n")
      ? ""
      : "\n";

  return `${leading}${body}${trailing}`;
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

function isFolderAlreadyExistsError(error: unknown): boolean {
  return /folder already exists|already exists/i.test(getErrorMessage(error));
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
