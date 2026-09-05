import type { TFile } from "obsidian";
import { transformVaultFile, replaceVaultFileIfUnchanged } from "./atomicVaultWrite";
import { resolveCurrentNoteFile } from "./currentNote";
import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type ActionReconciliationResult,
  type JsonValue,
  type PreparedAction,
  type PreparedActionResult,
  type ResourceAction,
} from "../agent/actions";
import {
  BACKUP_FOLDER,
  MAX_BATCH_READ_CHARS_PER_FILE,
  MAX_BATCH_READ_FILES,
  MAX_FILE_READ_CHARS,
  MAX_LISTED_FILES,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_SNIPPET_CHARS,
} from "./constants";
import { withDiscriminativeDescription } from "./discriminativeToolDescriptions";
import {
  bm25ContentScoreV1,
  buildLexicalCorpusStatsV1,
  buildLexicalDocumentTermStatsV1,
  informativeOccurrenceCountV1,
  queryCoverageBonusV1,
  type LexicalCorpusStatsV1,
  type LexicalDocumentTermStatsV1,
} from "./lexicalRanking";
import {
  ToolExecutionError,
  type AgentTool,
  type AgentToolActionExecution,
  type ResearchMemoryIndexEntry,
  type ToolExecutionContext,
} from "./types";
import { hasExplicitNoNoteWriteIntent } from "../agent/noNoteWriteIntent";
import { allowsDestructiveShortCurrentNoteReplace } from "../agent/currentNoteResetPolicy";
import { hasAuthorizedCurrentNoteReplaceIntent } from "../agent/replaceIntent";
import { currentNoteReplaceCatalogEligible } from "../agent/missionScope";
import {
  assertSafeCurrentNoteWritePayload,
  stripRepeatedCurrentNotePrefixFromAppend,
} from "../agent/vaultWriteContentGuard";
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
  normalizeVaultContentPath,
  normalizeVaultPath,
  truncateText,
} from "./validation";
import { createGraphTools } from "./graphTools";
import { countMarkdownVisibleText } from "./wordCount";
import { getProjectMemoryLocation } from "../agent/projectMemory";
import { buildRetrievalCoverage } from "../agent/retrievalCoverage";
import { isVaultPathExcluded } from "./vaultExclusions";
import {
  AGENT_TEMPLATE_FOLDER,
  LINEAR_ISSUE_TEMPLATE_PATH,
  LINEAR_ISSUE_TEMPLATE_V1,
} from "./agentTemplateLibrary";
import { promptTargetsHeadingV1 } from "../agent/sectionTarget";
import { hasExplicitResearchPublicationIntent } from "./researchPublicationTool";
import { hasExplicitResearchProjectHierarchyIntent } from "./researchProjectHierarchyTool";
import {
  analyzeTemplateDocument,
  discoverAndRankTemplates,
  dryRenderTemplate,
  suggestCollisionFreeTemplatePath,
  verifyRenderedTemplate,
  type TemplateMetadata,
} from "../orchestrator/templateIntelligence";
import {
  buildTransactionalResearchPackPlan,
  createResearchTemplateWorkflow,
  reduceResearchTemplateWorkflow,
  stableContentHash,
  verifyTransactionalResearchPack,
  type ResearchTemplateWorkflowEvent,
  type ResearchTemplateWorkflowV1,
  type TemplateResearchFinding,
  type TransactionalResearchPackPlan,
} from "../orchestrator/researchTemplateWorkflow";

const PREPARED_VAULT_ACTION_TTL_MS = 5 * 60 * 1_000;

const CREATE_INTENT_PATTERN = /\b(create|creating|new|make)\b/i;
const APPEND_INTENT_PATTERN =
  /\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,80}\b(note|file|markdown|vault|page|document)\b|\b(note|file|markdown|vault|page|document)\b[\s\S]{0,80}\b(append|save|write|update|add|insert|copy|paste|put)\b|\b(append|save|write|update|add|insert|copy|paste|put)\b[\s\S]{0,120}\.md\b/i;
const SECTION_APPEND_INTENT_PATTERN =
  /\b(write|draft|compose|generate|append|add|insert|put)\b[\s\S]{0,160}\b(?:below|under|after|beneath|inside)\b[\s\S]{0,80}\b(?:section|heading)\b|\b(?:below|under|after|beneath|inside)\b[\s\S]{0,80}\b(?:section|heading)\b[\s\S]{0,160}\b(write|draft|compose|generate|append|add|insert|put)\b/i;
const MOVE_INTENT_PATTERN = /\b(move|rename|relocate)\b/i;
const TITLE_INTENT_PATTERN =
  /\b(retitle|rename|title|heading|h1)\b|\bcall\s+(?:this|the)\s+note\b|\b(note|file)\b[\s\S]{0,80}\b(organize|restructure|improve)\b|\b(organize|restructure|improve)\b[\s\S]{0,80}\b(note|file)\b|\btarget\s+\S+[\s\S]{0,80}\bchange\s+(?:that|it|this)\b/i;
const HIGHLIGHT_INTENT_PATTERN =
  /\b(find|search|locate|show)\b[\s\S]{0,120}\b(highlight|mark)\b|\b(highlight|mark)\b[\s\S]{0,120}\b(word|phrase|text|where|current\s+(?:note|file|page))\b/i;
const RESTORE_INTENT_PATTERN =
  /\b(undo|restore|revert|rollback|roll\s+back)\b[\s\S]{0,140}\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b|\b(agent|last|previous|backup|current\s+(?:note|file|page)|this\s+(?:note|file|page))\b[\s\S]{0,140}\b(undo|restore|revert|rollback|roll\s+back)\b/i;
const EDIT_INTENT_PATTERN =
  /\b(edit|revise|update|replace|rewrite)\b[\s\S]{0,80}\b(section|heading|part|paragraph|content)\b|\b(section|heading|part|paragraph|content)\b[\s\S]{0,80}\b(edit|revise|update|replace|rewrite)\b/i;
const DELETE_INTENT_PATTERN =
  /\b(delete|remove|trash)\b[\s\S]{0,80}\b(?:current|this|active|whole|entire)\s+(?:note|file)\b|\b(?:current|this|active|whole|entire)\s+(?:note|file)\b[\s\S]{0,80}\b(delete|remove|trash)\b/i;
const DELETE_PATH_INTENT_PATTERN = /\b(delete|remove|trash)\b/i;
const TEMPLATE_INTENT_PATTERN =
  /\b(template|templates|templated|boilerplate|reusable\s+(?:note|markdown|outline|format|structure)|fill\s+(?:this|the)?\s*(?:out\s+)?(?:form|template)|populate\s+(?:this|the)?\s*(?:form|template))\b/i;
const TEMPLATE_CREATE_INTENT_PATTERN =
  /\b(create|new|make|save)\b[\s\S]{0,100}\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b|\b(template|boilerplate|reusable\s+(?:note|markdown|outline|format|structure))\b[\s\S]{0,100}\b(create|new|make|save)\b/i;
const TEMPLATE_OUTPUT_CREATE_INTENT_PATTERN =
  /\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b[\s\S]{0,100}\bfrom\b[\s\S]{0,80}\btemplate\b|\btemplate\b[\s\S]{0,100}\bcreate\b[\s\S]{0,80}\b(note|file|markdown)\b/i;
const TEMPLATE_FILL_INTENT_PATTERN =
  /\b(fill|use|apply|complete|populate|render)\b[\s\S]{0,100}\b(template|form|boilerplate)\b|\b(template|form|boilerplate)\b[\s\S]{0,100}\b(fill|use|apply|complete|populate|render)\b/i;
const TEMPLATE_SEED_INTENT_PATTERN =
  /\b(seed|install|create|make|add)\b[\s\S]{0,120}\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b|\b(default|starter|example|sample|built[-\s]?in)\b[\s\S]{0,80}\btemplates?\b[\s\S]{0,120}\b(seed|install|create|make|add)\b/i;
const RESEARCH_PACK_INTENT_PATTERN =
  /\b(create|make|build|generate|save)\b[\s\S]{0,120}\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b|\b(research\s+pack|research\s+brief|sources?\s+index|synthesis\s+pack|transactional\s+pack)\b[\s\S]{0,120}\b(create|make|build|generate|save)\b/i;

const DEFAULT_FOLDER_LIST_LIMIT = 100;
const DEFAULT_RECURSIVE_DEPTH = 3;
const DEFAULT_TEMPLATE_FOLDER = "Templates";
const DEFAULT_TEMPLATE_LIST_LIMIT = 50;
export const DEFAULT_TEMPLATE_SEEDS: Record<string, string> = {
  "Research brief.md":
    "# {{title}}\n\n## Question\n{{question}}\n\n## Sources\n{{sources}}\n\n## Findings\n{{findings}}\n",
  "Research note.md":
    "# {{title}}\n\n## Claim\n{{claim}}\n\n## Evidence\n{{evidence}}\n\n## Open Questions\n{{open_questions}}\n",
  "Linear issue.md": LINEAR_ISSUE_TEMPLATE_V1,
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
    createResearchPackTool,
    createFolderTool,
    createFileTool,
    appendFileTool,
    replaceFileTool,
    movePathTool,
    deletePathTool,
    renameCurrentFileTool,
    retitleCurrentFileTool,
    highlightCurrentFilePhraseTool,
    prepareEditCurrentSectionTool,
    editCurrentSectionTool,
    appendToCurrentSectionTool,
    appendToCurrentFileTool,
    replaceCurrentFileTool,
    restoreCurrentFileFromBackupTool,
    deleteCurrentFileTool,
  ];
}

export const readCurrentFileTool: AgentTool = {
  name: "read_current_file",
  description: withDiscriminativeDescription(
    "read_current_file",
    "Read the active markdown note. Use offset to continue after a truncated window.",
  ),
  parameters: {
    type: "object",
    properties: {
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return from the offset.",
      },
      offset: {
        type: "integer",
        description:
          "Optional 0-based character offset into the note. Use nextOffset from a truncated read to continue.",
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
    const offset = clampPositiveInteger(
      getOptionalInteger(args, "offset") ?? 0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const file = getActiveMarkdownFile(context);
    const content =
      context.getCurrentMarkdownContent?.(file) ??
      (await context.app.vault.cachedRead(file));
    const safeOffset = Math.min(offset, content.length);
    const window = content.slice(safeOffset, safeOffset + maxChars);
    const truncated = safeOffset + window.length < content.length;

    return {
      path: file.path,
      content: truncated ? `${window}\n\n[truncated]` : window,
      totalChars: content.length,
      returnedChars: window.length,
      offset: safeOffset,
      truncated,
      nextOffset: truncated ? safeOffset + window.length : null,
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

    // The cap was previously silent, and the bare array it returned was not a
    // record, so mission evidence extraction skipped this tool entirely. The
    // envelope fixes both: the listing says when it is partial, and
    // vaultSearchEvidenceFromToolResult already recognises a "files" array.
    const all = context.app.vault
      .getFiles()
      .filter((file) => file.extension === "md")
      .filter((file) => !isBlockedSystemPath(file.path));
    const files = all.slice(0, MAX_LISTED_FILES).map((file) => ({
      path: file.path,
      basename: file.basename,
    }));

    return {
      files,
      total: all.length,
      limit: MAX_LISTED_FILES,
      truncated: all.length > files.length,
    };
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

    // Pass 1 reads every note once (as before) and keeps only small per-note
    // statistics: informative term and phrase counts, the note length, and,
    // for notes that can score at all, the snippet and match count. Note
    // contents are not retained. The corpus statistics BM25 needs (document
    // frequencies, average length) fall out of the same pass.
    const corpusDocuments: LexicalDocumentTermStatsV1[] = [];
    const candidates: Array<{
      file: TFile;
      documentStats: LexicalDocumentTermStatsV1;
      phraseCount: number;
      matchCount: number;
      snippet: string;
    }> = [];

    for (const file of context.app.vault.getFiles()) {
      if (file.extension !== "md" || isVaultPathExcluded(file.path)) {
        continue;
      }

      const content = await context.app.vault.cachedRead(file);
      const contentLower = content.toLowerCase();
      const documentStats = buildLexicalDocumentTermStatsV1(contentLower, queryTerms);
      corpusDocuments.push(documentStats);
      const phraseIndex = contentLower.indexOf(normalizedQuery);
      const phraseCount =
        phraseIndex >= 0
          ? informativeOccurrenceCountV1(contentLower, normalizedQuery, queryTerms)
          : 0;
      const titleLower = file.basename.toLowerCase();
      const pathLower = file.path.toLowerCase();
      const couldScore =
        phraseCount > 0 ||
        documentStats.termFrequencies.size > 0 ||
        titleLower.includes(normalizedQuery) ||
        pathLower.includes(normalizedQuery) ||
        queryTerms.some((term) => titleLower.includes(term) || pathLower.includes(term));
      if (!couldScore) {
        continue;
      }
      const snippetIndex =
        phraseIndex >= 0
          ? phraseIndex
          : findFirstTermIndex(contentLower, queryTerms);
      candidates.push({
        file,
        documentStats,
        phraseCount,
        matchCount:
          phraseIndex >= 0
            ? countMatches(content, query)
            : countSearchTermMatches(contentLower, queryTerms),
        snippet: buildSearchSnippet(
          content,
          snippetIndex >= 0 ? snippetIndex : 0,
          maxSnippetChars,
        ),
      });
    }

    // Pass 2 scores the candidates against the whole scanned corpus.
    const corpus = buildLexicalCorpusStatsV1(corpusDocuments);
    for (const candidate of candidates) {
      const scored = scoreMarkdownSearchResult({
        file: candidate.file,
        query: normalizedQuery,
        queryTerms,
        phraseCount: candidate.phraseCount,
        documentStats: candidate.documentStats,
        corpus,
      });
      if (scored.score <= 0) {
        continue;
      }
      results.push({
        path: candidate.file.path,
        basename: candidate.file.basename,
        matchCount: candidate.matchCount,
        score: scored.score,
        reasons: scored.reasons,
        snippet: candidate.snippet,
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
  description: withDiscriminativeDescription(
    "read_file",
    "Read a markdown file by vault-relative path.",
  ),
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
    "Prepare and atomically append durable topic memory under the configured research memory folder, update its index, and return an authorized receipt with verified readback. Existing matching content is reported as a no-op.",
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
  async execute() {
    refuseUnpreparedVaultExecution("append_research_memory");
  },
  prepare: prepareAppendResearchMemory,
  executePrepared: executePreparedAppendResearchMemory,
  reconcile: reconcileAppendResearchMemory,
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
        targetId: indexed?.targetId ?? indexed?.topic ?? topic,
        verificationState: "unverified",
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
  async execute() {
    refuseUnpreparedVaultExecution("delete_research_memory_entry");
  },
  prepare: (args, context) => prepareDeleteResearchMemoryEntry(args, context),
  executePrepared: (action, context) =>
    executePreparedDeleteResearchMemoryEntry(action, context),
};

export const listTemplatesTool: AgentTool = {
  name: "list_templates",
  description:
    "List reusable markdown templates from the configured template folder and the managed Agent Work/templates library.",
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
      query: {
        type: "string",
        description: "Optional intent query used to rank template candidates.",
      },
      kind: {
        type: "string",
        description: "Optional template kind used for metadata-aware ranking.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertTemplateIntent(context, "list_templates");
    const templateFolder = getTemplateFolder(context);
    const readableTemplateFolders = getReadableTemplateFolders(context);
    const limit = clampPositiveInteger(
      getOptionalInteger(args, "limit") ?? DEFAULT_TEMPLATE_LIST_LIMIT,
      1,
      MAX_LISTED_FILES,
    );
    const includePlaceholders =
      getOptionalBoolean(args, "includePlaceholders") ?? false;
    const query = getOptionalString(args, "query")?.trim();
    const requestedKind = getOptionalString(args, "kind")?.trim();
    const templateFiles = getVaultEntries(context)
      .filter((entry) => getEntryExtension(entry) === "md")
      .filter((entry) =>
        readableTemplateFolders.some((folder) =>
          isPathInFolder(entry.path, folder),
        ),
      )
      .filter((entry) => !isBlockedSystemPath(entry.path))
      .sort((a, b) => a.path.localeCompare(b.path));
    if (query || requestedKind) {
      const documents = await Promise.all(
        templateFiles.map(async (entry) => {
          const content = await context.app.vault.cachedRead(
            getMarkdownFileByPath(context, entry.path),
          );
          return {
            path: entry.path,
            content,
            metadata: parseTemplateMetadata(content),
          };
        }),
      );
      const ranked = discoverAndRankTemplates(documents, {
        query: query ?? "",
        kind: requestedKind,
      });
      return {
        templateFolder,
        templates: ranked.slice(0, limit).map((candidate) => ({
          path: candidate.path,
          basename: candidate.title,
          ...(includePlaceholders
            ? { placeholders: candidate.placeholders }
            : {}),
          fields: candidate.fields,
          score: candidate.score,
          reasons: candidate.reasons,
        })),
        ranked: true,
        truncated: ranked.length > limit,
      };
    }
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
    "Read a reusable markdown template from the configured template folder or the managed Agent Work/templates library. Use only when the user asks about templates, or for the managed Linear issue template during explicit Linear issue/publication/hierarchy work. Do not call this for ordinary research, web search, or note writing.",
  parameters: {
    type: "object",
    required: ["path"],
    properties: {
      path: {
        type: "string",
        description:
          "Template path. Bare filenames prefer the configured template folder and fall back to Agent Work/templates. For Linear issue shaping, use the managed Linear issue.md path.",
      },
      maxChars: {
        type: "integer",
        description: "Optional maximum characters to return.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const requestedPath = getRequiredString(args, "path");
    let path = resolveReadableTemplatePath(context, requestedPath);
    try {
      assertReadTemplateIntent(context, path);
    } catch (error) {
      // Linear mutation missions often receive a wrong Linear-* relative path.
      // Redirect only those attempts to the managed issue template.
      if (
        path !== LINEAR_ISSUE_TEMPLATE_PATH &&
        canReadManagedLinearIssueTemplate(context) &&
        looksLikeLinearTemplatePath(requestedPath)
      ) {
        path = LINEAR_ISSUE_TEMPLATE_PATH;
        assertReadTemplateIntent(context, path);
      } else {
        throw error;
      }
    }
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
      // Seeding into an already-seeded folder creates nothing; say so
      // instead of reporting a "create" that wrote zero templates.
      operation: createdTemplates.length ? "create" : "no_op",
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
          "Optional saved template path. Bare filenames prefer the configured template folder and fall back to Agent Work/templates.",
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
      useBuiltins: {
        type: "boolean",
        description:
          "Resolve safe date/time/title/frontmatter built-ins. Defaults to false.",
      },
      previewOnly: {
        type: "boolean",
        description: "Dry-render the template without creating a note.",
      },
      collisionPolicy: {
        type: "string",
        enum: ["error", "suffix"],
        description:
          "Use suffix to choose a collision-free path; error preserves strict no-overwrite behavior.",
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
        ? resolveReadableTemplatePath(context, templatePathArg)
        : undefined;
    const templateText =
      templatePath !== undefined
        ? await context.app.vault.cachedRead(getMarkdownFileByPath(context, templatePath))
        : templateTextArg ?? "";
    const useBuiltins = getOptionalBoolean(args, "useBuiltins") ?? false;
    const previewOnly = getOptionalBoolean(args, "previewOnly") ?? false;
    const collisionPolicy = args.collisionPolicy === "suffix" ? "suffix" : "error";
    const analyzed = analyzeTemplateDocument({
      path: templatePath ?? "Ad hoc template.md",
      content: templateText,
      metadata: parseTemplateMetadata(templateText),
    });
    const intelligentPreview = useBuiltins
      ? dryRenderTemplate(analyzed, {
          values,
          title:
            values.title ||
            values.noteTitle ||
            values.note_title ||
            values.name ||
            values.topic ||
            getTemplateTitleFromPath(templatePath),
          now: context.now?.() ?? new Date(),
        })
      : null;
    if (intelligentPreview && !intelligentPreview.canCreate) {
      const grouped = intelligentPreview.missingFieldGroups
        .map(
          (group) =>
            `${group.group}: ${group.fields.map((field) => field.name).join(", ")}`,
        )
        .join("; ");
      throw new ToolExecutionError(
        "invalid_arguments",
        `fill_template needs grouped field values${grouped ? ` (${grouped})` : ""}.`,
      );
    }
    const fill = intelligentPreview
      ? { content: intelligentPreview.content, placeholders: analyzed.placeholders }
      : fillTemplateText(templateText, values);
    const desiredTargetPath = normalizeTemplateTargetPath({
      context,
      explicitTargetPath: getOptionalString(args, "targetPath"),
      values,
      templatePath,
    });
    const targetPath =
      collisionPolicy === "suffix"
        ? suggestCollisionFreeTemplatePath(
            desiredTargetPath,
            getVaultEntries(context).map((entry) => entry.path),
          )
        : desiredTargetPath;
    const createFolders = getOptionalBoolean(args, "createFolders") ?? true;

    if (getAbstractPath(context, targetPath)) {
      throw new Error(`Path already exists: ${targetPath}`);
    }

    if (previewOnly) {
      return {
        path: targetPath,
        operation: "preview",
        templateSource,
        templatePath,
        placeholders: fill.placeholders,
        missingFieldGroups: intelligentPreview?.missingFieldGroups ?? [],
        unresolvedPlaceholders:
          intelligentPreview?.unresolvedPlaceholders ?? [],
        content: fill.content,
        bytes: getByteLength(fill.content),
      };
    }

    await ensureParentFolder(context, targetPath, createFolders);
    await context.app.vault.create(targetPath, fill.content);
    let verification: ReturnType<typeof verifyRenderedTemplate>;
    try {
      const actualContent = await context.app.vault.cachedRead(
        getMarkdownFileByPath(context, targetPath),
      );
      verification = verifyRenderedTemplate(fill.content, actualContent);
      if (!verification.passed) {
        throw new ToolExecutionError(
          "template_verification_failed",
          verification.reasons.join(" ") || "Template read-back verification failed.",
        );
      }
    } catch (error) {
      const created = getAbstractPath(context, targetPath);
      let rollback = "created note was already absent";
      if (created) {
        try {
          await trashVaultPath(context, created);
          rollback = "created note moved to Obsidian trash";
        } catch (rollbackError) {
          throw new ToolExecutionError(
            "template_verification_rollback_failed",
            `${getErrorMessage(error)} Rollback also failed: ${getErrorMessage(rollbackError)}`,
          );
        }
      }
      throw new ToolExecutionError(
        error instanceof ToolExecutionError
          ? error.code
          : "template_verification_failed",
        `${getErrorMessage(error)} Transaction rolled back: ${rollback}.`,
      );
    }

    return {
      path: targetPath,
      operation: "create",
      templateSource,
      templatePath,
      placeholders: fill.placeholders,
      valuesApplied: Object.keys(values).sort(),
      bytesWritten: getByteLength(fill.content),
      ...(useBuiltins || collisionPolicy === "suffix"
        ? { collisionPolicy, verification }
        : {}),
    };
  },
};

export const createResearchPackTool: AgentTool = {
  name: "create_research_pack",
  description:
    "Create and read-back verify a collision-safe transactional research pack containing Brief, Sources, Synthesis, and linked Index notes. All created notes are moved to Obsidian trash if any creation or verification step fails.",
  parameters: {
    type: "object",
    required: ["baseFolder", "title", "brief", "sources", "synthesis"],
    properties: {
      baseFolder: {
        type: "string",
        description: "Safe vault-relative parent folder for the research pack.",
      },
      title: { type: "string" },
      brief: { type: "string" },
      sources: {
        type: "array",
        minItems: 1,
        maxItems: 50,
        items: {
          type: "object",
          required: ["id", "title"],
          properties: {
            id: { type: "string" },
            title: { type: "string" },
            url: { type: "string" },
            passage: { type: "string" },
          },
          additionalProperties: false,
        },
      },
      synthesis: { type: "string" },
      previewOnly: {
        type: "boolean",
        description: "Return the deterministic pack plan without creating notes.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    // Either the user asked for a pack by name, or the runner has certified
    // this run as a genuine research mission that met its source floor. The
    // phrase gate alone made a transactional, readback-verified, rollback-safe
    // multi-note deliverable reachable only by users who already knew the
    // magic words; the eligibility flag is what makes it the ordinary shape of
    // a real research run.
    if (
      !RESEARCH_PACK_INTENT_PATTERN.test(context.originalPrompt) &&
      context.researchPackEligible !== true
    ) {
      throw new ToolExecutionError(
        "intent_required",
        "create_research_pack requires an explicit request to create a research pack, brief, source index, or synthesis pack, or an active research mission that has met its fetched-source floor.",
      );
    }
    const baseFolder = normalizeResearchPackFolder(
      getRequiredString(args, "baseFolder"),
    );
    const title = getRequiredString(args, "title").trim();
    const brief = getRequiredString(args, "brief").trim();
    const synthesis = getRequiredString(args, "synthesis").trim();
    if (!title || !brief || !synthesis) {
      throw new ToolExecutionError(
        "invalid_arguments",
        "Research pack title, brief, and synthesis cannot be empty.",
      );
    }
    const sources = getResearchPackSources(args.sources);
    const now = context.now?.() ?? new Date();
    const runId = context.runId?.trim() || `research-pack-${now.getTime()}`;
    const transactionId = `${runId}:${stableContentHash(`${baseFolder}\n${title}`).slice(-8)}`;
    const plan = buildTransactionalResearchPackPlan({
      transactionId,
      baseFolder,
      title,
      brief,
      sources,
      synthesis,
      createdAt: now.toISOString(),
      ...(context.runId?.trim() ? { runId: context.runId.trim() } : {}),
      // Opt-in only: linking into a hub is a second write, so it stays off
      // unless the user names a hub note in settings.
      ...(context.settings?.researchHubNote?.trim()
        ? { hubNote: context.settings.researchHubNote.trim() }
        : {}),
      existingPaths: getVaultEntries(context).map((entry) => entry.path),
    });
    const findings: TemplateResearchFinding[] = sources.map((source, index) => ({
      id: source.id || `source-${index + 1}`,
      summary: source.passage?.trim() || source.title,
      sourceIds: [source.id, source.url].filter(isNonEmptyString),
      confidence: source.passage?.trim() ? "high" : "medium",
    }));
    const previewContent = plan.artifacts
      .map((artifact) => `<!-- ${artifact.path} -->\n${artifact.content}`)
      .join("\n");
    let workflow = createResearchTemplateWorkflow({
      id: transactionId,
      runId,
      now,
    });
    workflow = applyResearchPackEvent(workflow, {
      kind: "template_selected",
      templatePath: "Research Pack.md",
    }, now);
    workflow = applyResearchPackEvent(workflow, {
      kind: "research_completed",
      findings,
    }, now);
    workflow = applyResearchPackEvent(workflow, {
      kind: "fields_resolved",
      values: { baseFolder, title, brief, synthesis },
    }, now);
    workflow = applyResearchPackEvent(workflow, {
      kind: "preview_prepared",
      content: previewContent,
    }, now);
    const previewHash = stableContentHash(previewContent);
    if (getOptionalBoolean(args, "previewOnly") ?? false) {
      return {
        operation: "preview_research_pack",
        path: plan.rootPath,
        transactionId,
        previewHash,
        plan,
        workflow,
      };
    }
    workflow = applyResearchPackEvent(workflow, {
      kind: "preview_approved",
      approvedHash: previewHash,
    }, now);

    const createdPaths: string[] = [];
    try {
      for (const artifactId of plan.createOrder) {
        const artifact = plan.artifacts.find((item) => item.id === artifactId);
        if (!artifact) throw new Error(`Research pack artifact is missing: ${artifactId}`);
        if (getAbstractPath(context, artifact.path)) {
          throw new Error(`Research pack path already exists: ${artifact.path}`);
        }
        await ensureParentFolder(context, artifact.path, true);
        await context.app.vault.create(artifact.path, artifact.content);
        createdPaths.push(artifact.path);
      }
      workflow = applyResearchPackEvent(workflow, {
        kind: "pack_created",
        plan,
        createdPaths,
      }, now);
      const readBack: Record<string, string | undefined> = Object.create(null);
      for (const path of plan.verifyPaths) {
        const file = getMarkdownFileByPath(context, path);
        readBack[path] = await context.app.vault.cachedRead(file);
      }
      const verification = verifyTransactionalResearchPack(plan, readBack);
      workflow = applyResearchPackEvent(workflow, {
        kind: "verification_completed",
        passed: verification.passed,
        verifiedPaths: verification.passed ? plan.verifyPaths : [],
        blocker: verification.passed
          ? undefined
          : `Missing: ${verification.missingPaths.join(", ")}; mismatched: ${verification.mismatchedPaths.join(", ")}`,
      }, now);
      if (!verification.passed) {
        throw new ToolExecutionError(
          "research_pack_verification_failed",
          workflow.blocker || "Research pack read-back verification failed.",
        );
      }
      return {
        operation: "create_research_pack",
        path: plan.rootPath,
        transactionId,
        previewHash,
        createdPaths,
        bytesWritten: plan.artifacts.reduce(
          (total, artifact) => total + getByteLength(artifact.content),
          0,
        ),
        verification,
        workflow,
      };
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (const path of [...createdPaths].reverse()) {
        const created = getAbstractPath(context, path);
        if (!created) continue;
        try {
          await trashVaultPath(context, created);
        } catch (rollbackError) {
          rollbackFailures.push(`${path}: ${getErrorMessage(rollbackError)}`);
        }
      }
      if (rollbackFailures.length > 0) {
        throw new ToolExecutionError(
          "research_pack_rollback_failed",
          `${getErrorMessage(error)} Rollback failures: ${rollbackFailures.join(" | ")}`,
        );
      }
      throw new ToolExecutionError(
        error instanceof ToolExecutionError
          ? error.code
          : "research_pack_transaction_failed",
        `${getErrorMessage(error)} Transaction rolled back ${createdPaths.length} created note(s).`,
      );
    }
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
  description:
    "Create a new markdown note, or a research data file beside one (.bib, .ris, .csv, .tsv, .json, .yaml, .yml, .txt), at a vault-relative path.",
  parameters: {
    type: "object",
    required: ["path", "content"],
    properties: {
      path: {
        type: "string",
        description:
          "Vault-relative file path to create. Markdown (.md), or a research data file: .bib, .ris, .csv, .tsv, .json, .yaml, .yml, .txt.",
      },
      content: {
        type: "string",
        description:
          "Initial file content. Markdown for .md; the file's own format for a research data file.",
      },
      createFolders: {
        type: "boolean",
        description: "When true, create missing parent folders first.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    // A bibliography, an extracted data table, and a figure-caption sidecar all
    // want to live next to the note that cites them. The allowlist is closed
    // and lives beside assertSafeMarkdownPath rather than loosening it, so
    // every markdown-only tool keeps rejecting these paths.
    const { path, kind } = normalizeVaultContentPath(
      getRequiredString(args, "path"),
    );
    assertCreateIntent(context, "create_file", path);
    const content = getString(args, "content");
    const createFolders = getOptionalBoolean(args, "createFolders") ?? false;

    if (getAbstractPath(context, path)) {
      throw new Error(`Path already exists: ${path}`);
    }

    await ensureParentFolder(context, path, createFolders);
    const file = await context.app.vault.create(path, content);
    const observed = await context.app.vault.read(file);
    if (observed !== content) {
      throw new ToolExecutionError(
        "vault_readback_failed",
        `Vault create acknowledged, but exact readback did not match: ${path}.`,
        { mutationState: "may_have_applied" },
      );
    }
    const checkedAt = (context.now?.() ?? new Date()).toISOString();
    const observedFingerprint = await sha256Fingerprint(observed);

    return {
      path,
      operation: "create",
      // The receipt says which kind was written, so a data-file create is
      // never mistaken for a new note in the run's own record.
      fileKind: kind,
      bytesWritten: getByteLength(content),
      readback: {
        status: "verified",
        checkedAt,
        observedRevision: observedFingerprint,
        observedFingerprint,
      },
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
    let appendedText = "";
    const nextContent = await transformVaultFile(context, file, (current) => {
      appendedText = `${current.length > 0 && !current.endsWith("\n") ? "\n" : ""}${text}`;
      return `${current}${appendedText}`;
    });
    const observed = await context.app.vault.read(file);
    if (observed !== nextContent) {
      throw new ToolExecutionError(
        "vault_readback_failed",
        `Vault append acknowledged, but exact readback did not match: ${file.path}.`,
        { mutationState: "may_have_applied" },
      );
    }
    const checkedAt = (context.now?.() ?? new Date()).toISOString();
    const observedFingerprint = await sha256Fingerprint(observed);

    return {
      path: file.path,
      operation: "append",
      bytesWritten: getByteLength(appendedText),
      readback: {
        status: "verified",
        checkedAt,
        observedRevision: observedFingerprint,
        observedFingerprint,
      },
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
  async execute() {
    refuseUnpreparedVaultExecution("replace_file");
  },
  prepare: (args, context) => prepareReplaceFile(args, context),
  executePrepared: (action, context) => executePreparedReplaceFile(action, context),
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
  async execute() {
    refuseUnpreparedVaultExecution("delete_path");
  },
  prepare: (args, context) => prepareDeletePath(args, context),
  executePrepared: (action, context) => executePreparedDeletePath(action, context),
};

export const appendToCurrentFileTool: AgentTool = {
  name: "append_to_current_file",
  description: withDiscriminativeDescription(
    "append_to_current_file",
    "Append markdown text to the active markdown note.",
  ),
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
    const requestedText = getRequiredString(args, "text");
    if (hasExplicitNoNoteWriteIntent(context.originalPrompt)) {
      throw new Error(
        "append_to_current_file is refused because the user forbade writing or editing notes.",
      );
    }
    if (!context.writeAutonomy && !APPEND_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "append_to_current_file requires the user to explicitly ask to append, save, write, add, insert, or update the note.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const text = stripRepeatedCurrentNotePrefixFromAppend(
      requestedText,
      current,
    );
    assertSafeCurrentNoteWritePayload({
      kind: "append",
      text,
      currentContent: current,
      allowDestructiveShortReplace:
        allowsDestructiveShortCurrentNoteReplace(context.originalPrompt),
    });
    // Revision missions must not "append" process talk or a second draft when
    // whole-note replace is the authorized path — fail closed instead of
    // polluting / appearing to wipe the page. The gate may only defer to
    // replace when replace is actually catalog-eligible under the SAME scope
    // predicate the catalog consults (currentNoteReplaceCatalogEligible);
    // otherwise blocking append here leaves the mission with ZERO write
    // paths. When no mission scope is attached (legacy hosts), the historic
    // block is preserved.
    const appendCrossGateScope = context.missionIntent?.autonomyScope;
    if (
      hasAuthorizedCurrentNoteReplaceIntent(context.originalPrompt) &&
      current.trim().length >= 400 &&
      (!appendCrossGateScope ||
        currentNoteReplaceCatalogEligible(appendCrossGateScope))
    ) {
      throw new Error(
        "append_to_current_file is blocked for this revise/replace mission. Use replace_current_file with the full revised note body.",
      );
    }
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    const appendedText = `${prefix}${text}`;
    const operationIdentity = resolveAppendOperationIdentity(context);
    const contentFingerprint = await sha256Fingerprint(text);
    const idempotencyKey = operationIdentity
      ? `${operationIdentity}::${contentFingerprint}`
      : null;
    await hydrateAppendIdempotencyFromRunSnapshot(context);
    // Duplicate-skip is identity + payload, never content alone. A second
    // mission appending the same line has a different run/operation identity
    // and must write. A Continue/retry of THIS identity may skip only after
    // the note tail already shows the exact block. PreparedAction.runId is
    // not consulted or rewritten here (it stays the executing segment runId).
    if (
      idempotencyKey &&
      hasAppliedAppendIdempotencyKey(idempotencyKey) &&
      noteTailHasExactAppendedBlock(current, appendedText)
    ) {
      const checkedAt = (context.now?.() ?? new Date()).toISOString();
      const observedFingerprint = await sha256Fingerprint(current);
      return {
        path: file.path,
        operation: "append_to_current_file",
        bytesWritten: 0,
        reason: "duplicate-skip",
        duplicateSkip: true,
        idempotencyKey,
        readback: {
          status: "verified",
          checkedAt,
          observedRevision: observedFingerprint,
          observedFingerprint,
        },
      };
    }
    if (idempotencyKey) {
      recordAppliedAppendIdempotencyKey(idempotencyKey);
      await persistAppendIdempotencyToRunSnapshot(context);
    }

    // The validated payload may depend on the original prefix. Refuse a
    // changed source inside the atomic callback rather than replacing user edits.
    const nextContent = await replaceVaultFileIfUnchanged(context, file, current, `${current}${appendedText}`);
    const observed = await context.app.vault.read(file);
    if (observed !== nextContent) {
      throw new ToolExecutionError(
        "vault_readback_failed",
        `Current-note append acknowledged, but exact readback did not match: ${file.path}.`,
        { mutationState: "may_have_applied" },
      );
    }
    const checkedAt = (context.now?.() ?? new Date()).toISOString();
    const observedFingerprint = await sha256Fingerprint(observed);

    return {
      path: file.path,
      operation: "append_to_current_file",
      bytesWritten: getByteLength(appendedText),
      readback: {
        status: "verified",
        checkedAt,
        observedRevision: observedFingerprint,
        observedFingerprint,
      },
    };
  },
};

export const renameCurrentFileTool: AgentTool = {
  name: "rename_current_file",
  description:
    "Rename the active markdown note file so the visible Obsidian file explorer entry and active tab/page title change. Does not edit frontmatter or H1 content.",
  parameters: {
    type: "object",
    required: ["title"],
    properties: {
      title: {
        type: "string",
        description: "New visible note/file title. The tool creates a safe .md filename from this title.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const title = getRequiredString(args, "title").trim();
    if (!title) {
      throw new Error("rename_current_file requires a non-empty title.");
    }

    if (
      context.autoTitleAuthorized !== true &&
      !TITLE_INTENT_PATTERN.test(context.originalPrompt) &&
      !MOVE_INTENT_PATTERN.test(context.originalPrompt)
    ) {
      throw new Error(
        "rename_current_file requires the user to explicitly ask for a title, rename, retitle, move, organize, restructure, or improve operation.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const safeBasename = sanitizeFileBasename(title);
    if (!safeBasename) {
      throw new Error("rename_current_file could not derive a safe markdown filename from the requested title.");
    }
    const fromPath = file.path;
    const previousTitle = file.basename;
    const suggested = getSuggestedFileRename(file, title);
    if (!suggested) {
      return {
        path: fromPath,
        toPath: fromPath,
        title,
        previousTitle,
        changed: false,
        operation: "rename_current_file",
        bytesWritten: 0,
      };
    }

    const toPath = normalizeVaultPath(suggested.to, { requireMarkdown: true });
    if (getAbstractPath(context, toPath)) {
      throw new Error(`Destination already exists: ${toPath}`);
    }

    await ensureParentFolder(context, toPath, false);
    await renameVaultPath(context, file, toPath);

    return {
      path: fromPath,
      toPath,
      title,
      previousTitle,
      changed: true,
      operation: "rename_current_file",
      bytesWritten: 0,
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

export const highlightCurrentFilePhraseTool: AgentTool = {
  name: "highlight_current_file_phrase",
  description:
    "Find a word or phrase in the active markdown note and persistently highlight matches with Obsidian ==highlight== syntax after creating a backup.",
  parameters: {
    type: "object",
    required: ["phrase"],
    properties: {
      phrase: {
        type: "string",
        description: "Word or phrase to highlight exactly in the active markdown note.",
      },
      caseSensitive: {
        type: "boolean",
        description: "When true, match case exactly. Defaults to false.",
      },
      occurrence: {
        type: "string",
        enum: ["first", "all"],
        description: "Highlight the first match or all matches. Defaults to first.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    if (!HIGHLIGHT_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "highlight_current_file_phrase requires the user to explicitly ask to find, mark, or highlight text in the current note.",
      );
    }

    const phrase = getRequiredString(args, "phrase").trim();
    if (!phrase) {
      throw new Error("highlight_current_file_phrase requires a non-empty phrase.");
    }

    const occurrence = getOptionalString(args, "occurrence") ?? "first";
    if (occurrence !== "first" && occurrence !== "all") {
      throw new Error("highlight_current_file_phrase occurrence must be first or all.");
    }

    const file = getActiveMarkdownFile(context);
    const current =
      context.getCurrentMarkdownContent?.(file) ??
      (await context.app.vault.read(file));
    const highlighted = highlightMarkdownPhrase(current, {
      phrase,
      caseSensitive: getOptionalBoolean(args, "caseSensitive") ?? false,
      occurrence,
    });

    if (highlighted.matchCount === 0) {
      return {
        path: file.path,
        operation: "highlight",
        phrase,
        matchCount: 0,
        changed: false,
        bytesWritten: 0,
      };
    }

    const backupPath = await backupCurrentFile(context, file, current);
    context.setCurrentMarkdownContent?.(file, highlighted.markdown);
    await context.app.vault.modify(file, highlighted.markdown);

    return {
      path: file.path,
      operation: "highlight",
      phrase,
      matchCount: highlighted.matchCount,
      backupPath,
      changed: true,
      bytesWritten: getByteLength(highlighted.markdown),
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

    // Either the user said the word "section", or they named this heading.
    // Naming it is the stronger signal: the model cannot rewrite a section the
    // request never mentioned.
    if (
      !EDIT_INTENT_PATTERN.test(context.originalPrompt) &&
      !promptTargetsHeadingV1(context.originalPrompt, heading)
    ) {
      throw new Error(
        "edit_current_section requires the user to explicitly ask to edit, revise, update, replace, or rewrite this section by name.",
      );
    }

    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const edit = replaceMarkdownSection(current, { heading, level, content });
    const changed = edit.updated !== current;
    const priorRevision = await sha256Fingerprint(current);
    const backupPath = await backupCurrentFile(context, file, current);

    if (changed) {
      await context.app.vault.modify(file, edit.updated);
    }
    const observed = await context.app.vault.read(file);
    if (observed !== edit.updated) {
      throw new ToolExecutionError(
        "vault_readback_failed",
        `Vault section edit acknowledged, but exact readback did not match: ${file.path}.`,
        { mutationState: "may_have_applied" },
      );
    }
    const checkedAt = (context.now?.() ?? new Date()).toISOString();
    const observedFingerprint = await sha256Fingerprint(observed);

    return {
      path: file.path,
      backupPath,
      heading,
      level: edit.level,
      // The delta is the new section body, not the rendered whole document:
      // a receipt claiming the full note length would overstate the write.
      bytesWritten: changed ? getByteLength(content) : 0,
      replacedChars: edit.replacedChars,
      changed,
      readback: {
        status: "verified",
        checkedAt,
        observedRevision: observedFingerprint,
        observedFingerprint,
        priorRevision,
      },
    };
  },
};

export const restoreCurrentFileFromBackupTool: AgentTool = {
  name: "restore_current_file_from_backup",
  description:
    "Restore the active markdown note from a prior .agent-backups markdown backup. Creates a fresh backup of the current state first.",
  parameters: {
    type: "object",
    properties: {
      backupPath: {
        type: "string",
        description:
          "Optional .agent-backups markdown path to restore from. When omitted, the latest matching backup for the active note is used.",
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    assertRestoreIntent(context, "restore_current_file_from_backup");
    const file = getActiveMarkdownFile(context);
    const backupPath =
      getOptionalBackupPath(args) ??
      (await findLatestBackupPathForCurrentFile(context, file));

    const current =
      context.getCurrentMarkdownContent?.(file) ??
      (await context.app.vault.read(file));
    const restored = await readBackupMarkdown(context, backupPath);
    const changed = restored !== current;

    if (!changed) {
      // The note already matches the backup: writing would only churn the
      // vault and leave a pre-restore backup identical to the note. Report
      // an honest no-op instead of a vacuous restore.
      return {
        path: file.path,
        operation: "restore",
        restoredFromBackupPath: backupPath,
        bytesWritten: 0,
        changed: false,
      };
    }

    const preRestoreBackupPath = await backupCurrentFile(context, file, current);
    context.setCurrentMarkdownContent?.(file, restored);
    await context.app.vault.modify(file, restored);

    return {
      path: file.path,
      operation: "restore",
      restoredFromBackupPath: backupPath,
      backupPath: preRestoreBackupPath,
      bytesWritten: getByteLength(restored),
      changed: true,
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

    if (
      !EDIT_INTENT_PATTERN.test(context.originalPrompt) &&
      !promptTargetsHeadingV1(context.originalPrompt, heading)
    ) {
      throw new Error(
        "prepare_edit_current_section requires the user to explicitly ask to edit, revise, update, replace, or rewrite this section by name.",
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

    if (
      !SECTION_APPEND_INTENT_PATTERN.test(context.originalPrompt) &&
      !promptTargetsHeadingV1(context.originalPrompt, heading)
    ) {
      throw new Error(
        "append_to_current_section requires the user to explicitly ask to write, add, append, or insert content below this section, naming it.",
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
  async execute() {
    refuseUnpreparedVaultExecution("replace_current_file");
  },
  prepare: (args, context) => prepareReplaceCurrentFile(args, context),
  executePrepared: (action, context) =>
    executePreparedReplaceCurrentFile(action, context),
};

export const deleteCurrentFileTool: AgentTool = {
  name: "delete_current_file",
  description: "Delete the active markdown note after creating a backup.",
  parameters: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async execute() {
    refuseUnpreparedVaultExecution("delete_current_file");
  },
  prepare: (args, context) => prepareDeleteCurrentFile(args, context),
  executePrepared: (action, context) =>
    executePreparedDeleteCurrentFile(action, context),
};

type VaultPathType = "file" | "folder";

const MAX_DELETE_MANIFEST_ENTRIES = 1_000;
const MAX_DELETE_MANIFEST_BYTES = 50 * 1024 * 1024;

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

function assertReadTemplateIntent(
  context: ToolExecutionContext,
  resolvedPath: string,
) {
  if (canReadManagedLinearIssueTemplate(context, resolvedPath)) {
    return;
  }

  assertTemplateIntent(context, "read_template");
}

function canReadManagedLinearIssueTemplate(
  context: ToolExecutionContext,
  resolvedPath: string = LINEAR_ISSUE_TEMPLATE_PATH,
): boolean {
  return (
    resolvedPath === LINEAR_ISSUE_TEMPLATE_PATH &&
    !hasNegatedLinearIssueMutationIntent(context.originalPrompt) &&
    (hasExplicitResearchPublicationIntent(context.originalPrompt) ||
      hasExplicitResearchProjectHierarchyIntent(context.originalPrompt) ||
      hasExplicitLinearIssueMutationIntent(context.originalPrompt))
  );
}

function looksLikeLinearTemplatePath(rawPath: string): boolean {
  return (
    /\blinear\b/i.test(rawPath) &&
    /\b(issue|ticket|work[\s_-]*item)s?\b/i.test(rawPath)
  );
}

function hasExplicitLinearIssueMutationIntent(prompt: string): boolean {
  const explicitMutation =
    /\blinear\b/i.test(prompt) &&
    /\b(issue|issues|ticket|tickets|work\s+item|work\s+items)\b/i.test(prompt) &&
    /\b(create|make|publish|prepare|shape|format|write|draft|update|edit)\b/i.test(
      prompt,
    );
  if (!explicitMutation) {
    return false;
  }
  return !hasNegatedLinearIssueMutationIntent(prompt);
}

function hasNegatedLinearIssueMutationIntent(prompt: string): boolean {
  return prompt
    .split(/(?:[!?;\r\n]+|\.(?=\s|$)|\bbut\b)/iu)
    .map((clause) => clause.trim())
    .filter(Boolean)
    .some((clause) => {
      const negatedAction =
        /\b(?:do\s+not|don't|never)\s+(?:(?:yet|now|currently)\s+)?(?:create|make|publish|prepare|shape|format|write|draft|update|edit)\b/iu.exec(
          clause,
        );
      if (!negatedAction) {
        return false;
      }
      const negatedTarget = clause.slice(negatedAction.index);
      return (
        /\blinear\b/iu.test(negatedTarget) &&
        /\b(?:issue|issues|ticket|tickets|work\s+item|work\s+items)\b/iu.test(
          negatedTarget,
        )
      );
    });
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

function assertCreateIntent(
  context: ToolExecutionContext,
  toolName: string,
  requestedPath?: string,
) {
  const hostPlannedNewNoteCreate =
    toolName === "create_file" &&
    context.missionIntent?.noteOutput === true &&
    typeof requestedPath === "string" &&
    requestedPath === context.plannedNoteOutputPath;
  if (!CREATE_INTENT_PATTERN.test(context.originalPrompt) && !hostPlannedNewNoteCreate) {
    throw new Error(`${toolName} requires the user to explicitly ask to create a file or folder.`);
  }
}

function assertAppendIntent(context: ToolExecutionContext, toolName: string) {
  if (hasExplicitNoNoteWriteIntent(context.originalPrompt)) {
    throw new Error(
      `${toolName} is refused because the user forbade writing or editing notes.`,
    );
  }
  if (!APPEND_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to append, save, write, add, insert, or update a note or file.`);
  }
}

function assertReplaceIntent(context: ToolExecutionContext, toolName: string) {
  if (!hasAuthorizedCurrentNoteReplaceIntent(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to rewrite, replace, reset, clean up, start fresh, overwrite, expand an under-target draft, or edit/revise the existing note.`);
  }
}

function assertRestoreIntent(context: ToolExecutionContext, toolName: string) {
  if (!RESTORE_INTENT_PATTERN.test(context.originalPrompt)) {
    throw new Error(`${toolName} requires the user to explicitly ask to undo, restore, revert, or roll back the current note from a backup.`);
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
    targetId: entry.targetId ?? byPath.get(entry.path)?.targetId,
    verificationState:
      entry.verificationState ?? byPath.get(entry.path)?.verificationState,
    verifiedAt: entry.verifiedAt ?? byPath.get(entry.path)?.verifiedAt,
    staleAt: entry.staleAt ?? byPath.get(entry.path)?.staleAt,
    supersededAt:
      entry.supersededAt ?? byPath.get(entry.path)?.supersededAt,
    supersededById:
      entry.supersededById ?? byPath.get(entry.path)?.supersededById,
    sourceHashes: entry.sourceHashes ?? byPath.get(entry.path)?.sourceHashes,
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
    resolveCurrentNoteFile(context)?.path ?? "";
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

function getReadableTemplateFolders(context: ToolExecutionContext): string[] {
  return dedupeStrings([getTemplateFolder(context), AGENT_TEMPLATE_FOLDER]);
}

function resolveReadableTemplatePath(
  context: ToolExecutionContext,
  rawPath: string,
): string {
  const inputPath = normalizeVaultPath(rawPath, { requireMarkdown: true });
  const readableFolders = getReadableTemplateFolders(context);
  const isExplicitReadablePath = readableFolders.some((folder) =>
    isPathInFolder(inputPath, folder),
  );

  if (isExplicitReadablePath) {
    return inputPath;
  }

  const candidates = readableFolders.map((folder) =>
    normalizeVaultPath(`${folder}/${inputPath}`, { requireMarkdown: true }),
  );
  return (
    candidates.find((candidate) => getAbstractPath(context, candidate)) ??
    candidates[0]
  );
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

function parseTemplateMetadata(templateText: string): TemplateMetadata | undefined {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(templateText)?.[1];
  if (!frontmatter) {
    return undefined;
  }
  const values = new Map<string, unknown>();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!match) continue;
    const key = match[1].toLowerCase();
    const raw = match[2].trim();
    let value: unknown = raw;
    if (raw.startsWith("[") || raw.startsWith("{") || raw.startsWith('"')) {
      try {
        value = JSON.parse(raw);
      } catch {
        value = raw;
      }
    }
    values.set(key, value);
  }
  const array = (value: unknown): string[] | undefined => {
    if (Array.isArray(value)) {
      const items = value.filter((item): item is string => typeof item === "string");
      return items.length > 0 ? items : undefined;
    }
    if (typeof value === "string" && value.trim()) {
      const items = value.split(",").map((item) => item.trim()).filter(Boolean);
      return items.length > 0 ? items : undefined;
    }
    return undefined;
  };
  const rawFields = values.get("template_fields");
  const fields = Array.isArray(rawFields)
    ? rawFields.filter(
        (field): field is NonNullable<TemplateMetadata["fields"]>[number] =>
          isRecord(field) && typeof field.name === "string",
      )
    : undefined;
  const metadata: TemplateMetadata = {
    kind:
      typeof values.get("template_kind") === "string"
        ? String(values.get("template_kind"))
        : undefined,
    description:
      typeof values.get("template_description") === "string"
        ? String(values.get("template_description"))
        : undefined,
    tags: array(values.get("tags")),
    aliases: array(values.get("aliases")),
    fields,
  };
  return metadata.kind ||
    metadata.description ||
    metadata.tags ||
    metadata.aliases ||
    metadata.fields
    ? metadata
    : undefined;
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

function normalizeResearchPackFolder(value: string): string {
  const normalized = normalizeVaultPath(value);
  if (
    !normalized ||
    normalized.toLowerCase().endsWith(".md") ||
    isBlockedSystemPath(normalized)
  ) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Research pack baseFolder must be a non-system vault-relative folder.",
    );
  }
  return normalized;
}

function getResearchPackSources(value: unknown): Array<{
  id: string;
  title: string;
  url?: string;
  passage?: string;
}> {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    throw new ToolExecutionError(
      "invalid_arguments",
      "Research pack sources must contain between 1 and 50 source records.",
    );
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `Research pack source ${index + 1} must be an object.`,
      );
    }
    const id = typeof item.id === "string" ? item.id.trim() : "";
    const title = typeof item.title === "string" ? item.title.trim() : "";
    if (!id || !title) {
      throw new ToolExecutionError(
        "invalid_arguments",
        `Research pack source ${index + 1} requires non-empty id and title.`,
      );
    }
    const url = normalizeOptionalResearchSourceUrl(item.url, index + 1);
    const passage = typeof item.passage === "string" ? item.passage.trim() : undefined;
    return {
      id: id.replace(/[^a-zA-Z0-9._:-]/g, "-").slice(0, 120),
      title: title.replace(/\s+/g, " ").slice(0, 300),
      ...(url ? { url } : {}),
      ...(passage ? { passage: passage.slice(0, 12_000) } : {}),
    };
  });
}

function normalizeOptionalResearchSourceUrl(
  value: unknown,
  index: number,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Research pack source ${index} URL must be a string.`,
    );
  }
  try {
    const url = new URL(value.trim());
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password
    ) {
      throw new Error("unsafe URL");
    }
    url.hash = "";
    return url.toString();
  } catch {
    throw new ToolExecutionError(
      "invalid_arguments",
      `Research pack source ${index} URL must be a credential-free HTTP or HTTPS URL.`,
    );
  }
}

type ResearchPackWorkflowEventInput =
  | { kind: "template_selected"; templatePath: string }
  | { kind: "research_completed"; findings: TemplateResearchFinding[] }
  | {
      kind: "fields_resolved";
      values: Record<string, string>;
      missingFieldGroups?: Record<string, string[]>;
    }
  | { kind: "preview_prepared"; content: string }
  | { kind: "preview_approved"; approvedHash: string }
  | {
      kind: "pack_created";
      plan: TransactionalResearchPackPlan;
      createdPaths: string[];
    }
  | {
      kind: "verification_completed";
      passed: boolean;
      verifiedPaths: string[];
      blocker?: string;
    };

function applyResearchPackEvent(
  workflow: ResearchTemplateWorkflowV1,
  event: ResearchPackWorkflowEventInput,
  now: Date,
): ResearchTemplateWorkflowV1 {
  return reduceResearchTemplateWorkflow(workflow, {
    ...event,
    runId: workflow.runId,
    sequence: workflow.sequence + 1,
    occurredAt: now.toISOString(),
  } as ResearchTemplateWorkflowEvent);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
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
    throw new ToolExecutionError(
      "vault_markdown_not_found",
      `Markdown file not found: ${path}`,
      { mutationState: "not_applied" },
    );
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

async function buildVaultDeletionManifest(
  context: ToolExecutionContext,
  targetPath: string,
  targetType: VaultPathType,
  recursive: boolean,
): Promise<{ fingerprint: string; bytes: number }> {
  const entries = targetType === "folder"
    ? getDescendantEntries(context, targetPath)
    : [getAbstractPath(context, targetPath)].filter(
        (entry): entry is VaultEntryLike => entry !== null,
      );
  if (entries.length > MAX_DELETE_MANIFEST_ENTRIES) {
    throw new ToolExecutionError(
      "vault_delete_manifest_too_large",
      `Delete preparation supports at most ${MAX_DELETE_MANIFEST_ENTRIES} entries.`,
      { mutationState: "not_applied" },
    );
  }
  const manifest: Array<Record<string, JsonValue>> = [];
  let bytes = 0;
  for (const entry of [...entries].sort((left, right) => left.path.localeCompare(right.path))) {
    const type = getPathType(entry);
    if (type === "folder") {
      manifest.push({ path: entry.path, type });
      continue;
    }
    const file = context.app.vault.getFileByPath(entry.path);
    if (!file) {
      throw new ToolExecutionError(
        "vault_precondition_changed",
        `Vault file disappeared while preparing deletion: ${entry.path}`,
        { mutationState: "not_applied" },
      );
    }
    const vault = context.app.vault as unknown as {
      read(file: TFile): Promise<string>;
      readBinary?: (file: TFile) => Promise<ArrayBuffer>;
    };
    const contentBytes = typeof vault.readBinary === "function"
      ? new Uint8Array(await vault.readBinary(file))
      : new TextEncoder().encode(await vault.read(file));
    bytes += contentBytes.byteLength;
    if (bytes > MAX_DELETE_MANIFEST_BYTES) {
      throw new ToolExecutionError(
        "vault_delete_manifest_too_large",
        `Delete preparation supports at most ${MAX_DELETE_MANIFEST_BYTES} bytes.`,
        { mutationState: "not_applied" },
      );
    }
    manifest.push({
      path: entry.path,
      type,
      bytes: contentBytes.byteLength,
      sha256: await sha256VaultBytes(contentBytes),
    });
  }
  return {
    fingerprint: await sha256Fingerprint({
      version: 1,
      path: targetPath,
      type: targetType,
      recursive,
      entries: manifest,
    }),
    bytes,
  };
}

async function sha256VaultBytes(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error("SHA-256 is unavailable in this runtime.");
  const digestInput = new Uint8Array(bytes.byteLength);
  digestInput.set(bytes);
  const digest = await subtle.digest("SHA-256", digestInput.buffer);
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
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

/**
 * Title, path, and phrase bonuses keep their historical shape and range. The
 * phrase count and the content component are corpus-aware now (see
 * lexicalRanking.ts): adjacent repeats collapse, keyword-list lines are
 * discounted, terms are IDF-weighted over the scanned corpus, and frequency
 * saturates with length normalization. Raw additive term frequency let a
 * short keyword-stuffed note outrank the note that answered the query.
 */
function scoreMarkdownSearchResult({
  file,
  query,
  queryTerms,
  phraseCount,
  documentStats,
  corpus,
}: {
  file: TFile;
  query: string;
  queryTerms: string[];
  phraseCount: number;
  documentStats: LexicalDocumentTermStatsV1;
  corpus: LexicalCorpusStatsV1;
}): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  let score = 0;
  const titleLower = file.basename.toLowerCase();
  const pathLower = file.path.toLowerCase();

  if (titleLower === query || pathLower === query) {
    score += 120;
    reasons.push("path_or_title_exact");
  } else if (titleLower.includes(query) || pathLower.includes(query)) {
    score += 70;
    reasons.push("path_or_title_match");
  }

  if (phraseCount > 0) {
    score += Math.min(80, Math.round(phraseCount * 16));
    reasons.push("phrase_match");
  }

  let titleTermMatches = 0;
  let pathTermMatches = 0;

  for (const term of queryTerms) {
    if (titleLower.includes(term)) {
      titleTermMatches += 1;
    }

    if (pathLower.includes(term)) {
      pathTermMatches += 1;
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

  const contentScore = bm25ContentScoreV1(documentStats, corpus);
  if (contentScore > 0) {
    score += Math.round(contentScore);
    reasons.push("content_terms");
  }

  const coverageBonus = queryCoverageBonusV1(documentStats, queryTerms.length);
  if (coverageBonus > 0) {
    score += coverageBonus;
    reasons.push("query_coverage");
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
  const file = resolveCurrentNoteFile(context);
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

function highlightMarkdownPhrase(
  markdown: string,
  {
    phrase,
    caseSensitive,
    occurrence,
  }: { phrase: string; caseSensitive: boolean; occurrence: "first" | "all" },
): { markdown: string; matchCount: number } {
  const needle = caseSensitive ? phrase : phrase.toLowerCase();
  let inFence = false;
  let matchCount = 0;
  let output = "";
  let index = 0;

  while (index < markdown.length) {
    const lineEnd = findLineEnd(markdown, index);
    const line = markdown.slice(index, lineEnd);
    const nextIndex = consumeLineBreak(markdown, lineEnd);
    const lineBreak = markdown.slice(lineEnd, nextIndex);
    const trimmed = line.trimStart();

    if (/^(```|~~~)/.test(trimmed)) {
      inFence = !inFence;
      output += line + lineBreak;
      index = nextIndex;
      continue;
    }

    if (inFence || (occurrence === "first" && matchCount > 0)) {
      output += line + lineBreak;
      index = nextIndex;
      continue;
    }

    output += highlightLinePhrase(line, needle, phrase.length, caseSensitive, () => {
      if (occurrence === "first" && matchCount > 0) {
        return false;
      }
      matchCount += 1;
      return true;
    }) + lineBreak;
    index = nextIndex;
  }

  return { markdown: output, matchCount };
}

function highlightLinePhrase(
  line: string,
  needle: string,
  phraseLength: number,
  caseSensitive: boolean,
  onMatch: () => boolean,
): string {
  const haystack = caseSensitive ? line : line.toLowerCase();
  let output = "";
  let offset = 0;

  while (offset < line.length) {
    const matchIndex = haystack.indexOf(needle, offset);
    if (matchIndex < 0) {
      output += line.slice(offset);
      break;
    }

    if (isInsideMarkdownHighlight(line, matchIndex)) {
      output += line.slice(offset, matchIndex + phraseLength);
      offset = matchIndex + phraseLength;
      continue;
    }

    output += line.slice(offset, matchIndex);
    if (!onMatch()) {
      output += line.slice(matchIndex);
      break;
    }

    output += `==${line.slice(matchIndex, matchIndex + phraseLength)}==`;
    offset = matchIndex + phraseLength;
  }

  return output;
}

function isInsideMarkdownHighlight(line: string, index: number): boolean {
  const before = line.slice(0, index);
  const openIndex = before.lastIndexOf("==");
  if (openIndex < 0) {
    return false;
  }

  const closeBefore = before.indexOf("==", openIndex + 2);
  if (closeBefore >= 0) {
    return false;
  }

  return line.indexOf("==", index) >= 0;
}

function findLineEnd(markdown: string, start: number): number {
  const nextNewline = markdown.indexOf("\n", start);
  return nextNewline < 0 ? markdown.length : nextNewline;
}

function consumeLineBreak(markdown: string, lineEnd: number): number {
  return lineEnd < markdown.length ? lineEnd + 1 : lineEnd;
}

function getOptionalBackupPath(args: Record<string, unknown>): string | undefined {
  const rawPath = getOptionalString(args, "backupPath")?.trim();
  if (!rawPath) {
    return undefined;
  }

  const backupPath = normalizeVaultPath(rawPath, {
    requireMarkdown: true,
    blockSystemPaths: false,
  });
  if (!backupPath.startsWith(`${BACKUP_FOLDER}/`)) {
    throw new ToolExecutionError(
      "unsafe_path",
      `Backup path must live under ${BACKUP_FOLDER}.`,
    );
  }
  return backupPath;
}

async function findLatestBackupPathForCurrentFile(
  context: ToolExecutionContext,
  file: TFile,
): Promise<string> {
  const backupBasename = sanitizeBackupBasename(file.basename);
  const backupPattern = new RegExp(
    `^${escapeRegExp(BACKUP_FOLDER)}/(\\d+)-${escapeRegExp(backupBasename)}(?:-\\d+)?\\.md$`,
    "i",
  );
  const matchesByPath = new Map<string, number>();
  const addCandidate = (path: string) => {
    const match = backupPattern.exec(path);
    if (!match) {
      return;
    }

    matchesByPath.set(path, Number.parseInt(match[1] ?? "0", 10));
  };

  for (const candidate of context.app.vault.getFiles()) {
    addCandidate(candidate.path);
  }

  try {
    const listed = await context.app.vault.adapter.list(BACKUP_FOLDER);
    for (const rawPath of listed.files) {
      const backupPath = normalizeVaultPath(rawPath, {
        requireMarkdown: true,
        blockSystemPaths: false,
      });
      addCandidate(backupPath);
    }
  } catch {
    // The backup folder may not exist yet, or the adapter may refuse hidden folders.
  }

  const matches = [...matchesByPath.entries()]
    .map(([path, timestamp]) => ({ path, timestamp }))
    .sort((a, b) => b.timestamp - a.timestamp || b.path.localeCompare(a.path));

  if (!matches[0]) {
    throw new Error(`No matching backups found under ${BACKUP_FOLDER} for ${file.path}.`);
  }

  return matches[0].path;
}

async function readBackupMarkdown(
  context: ToolExecutionContext,
  backupPath: string,
): Promise<string> {
  const backupFile = context.app.vault.getFileByPath(backupPath);
  if (backupFile) {
    if (backupFile.extension !== "md") {
      throw new Error(`Backup markdown file not found: ${backupPath}`);
    }
    return context.app.vault.read(backupFile);
  }

  try {
    return await context.app.vault.adapter.read(backupPath);
  } catch {
    throw new Error(`Backup markdown file not found: ${backupPath}`);
  }
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

/**
 * Logical-operation identity for append idempotency. Requires a durable
 * run/root id plus either the mission-graph node this call executes or a
 * step-scoped operation id, so two missions appending the same line cannot
 * collide on content.
 *
 * The node-scoped form is what survives a retry, a Continue segment, or a
 * segment turnover: the runner mints `operationId` as
 * `runId:step:toolIndex:tool`, which changes on every retry and every segment,
 * so before this the guard could only ever dedupe a same-identity retry --
 * never the resumed append that duplicated content in a user's note. A graph
 * node completes at its first receipt (multi-append missions get one node per
 * append), so one identity per node is exact. The payload fingerprint and the
 * note-tail check still apply: a different payload under the same node always
 * writes. Never rewrite PreparedAction.runId here.
 */
export function resolveAppendOperationIdentity(
  context: Pick<
    ToolExecutionContext,
    "runId" | "rootMissionId" | "operationId" | "nodeId" | "missionGraphExecution"
  >,
): string | null {
  const durableId =
    context.rootMissionId?.trim() || context.runId?.trim() || "";
  if (!durableId) {
    return null;
  }
  const nodeId =
    context.nodeId?.trim() || context.missionGraphExecution?.nodeId?.trim() || "";
  if (nodeId) {
    return `${durableId}::node:${nodeId}:append_to_current_file`;
  }
  const operationId = context.operationId?.trim() || "";
  if (!operationId) {
    return null;
  }
  return `${durableId}::${operationId}`;
}

/** Bound tail compare: only the last `block.length` characters are inspected. */
export function noteTailHasExactAppendedBlock(
  current: string,
  block: string,
): boolean {
  if (!block) {
    return false;
  }
  const tailLength = block.length;
  if (current.length < tailLength) {
    return false;
  }
  return current.slice(current.length - tailLength) === block;
}

const MAX_APPLIED_APPEND_IDEMPOTENCY_KEYS = 512;
const appliedAppendIdempotencyKeys: string[] = [];
const appliedAppendIdempotencyKeySet = new Set<string>();

export interface AppendIdempotencySnapshotV1 {
  version: 1;
  keys: string[];
}

export function createAppendIdempotencySnapshotV1(
  keys: readonly string[] = [],
): AppendIdempotencySnapshotV1 {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(key);
  }
  return {
    version: 1,
    keys: unique.slice(-MAX_APPLIED_APPEND_IDEMPOTENCY_KEYS),
  };
}

export function parseAppendIdempotencySnapshotV1(
  value: unknown,
): AppendIdempotencySnapshotV1 {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.keys)) {
    return createAppendIdempotencySnapshotV1();
  }
  return createAppendIdempotencySnapshotV1(
    value.keys.filter((key): key is string => typeof key === "string" && key.length > 0),
  );
}

export function snapshotAppendIdempotencyV1(): AppendIdempotencySnapshotV1 {
  return createAppendIdempotencySnapshotV1(appliedAppendIdempotencyKeys);
}

export function applyAppendIdempotencySnapshotV1(
  snapshot: AppendIdempotencySnapshotV1 | null | undefined,
): void {
  appliedAppendIdempotencyKeys.length = 0;
  appliedAppendIdempotencyKeySet.clear();
  for (const key of snapshot?.keys ?? []) {
    recordAppliedAppendIdempotencyKey(key);
  }
}

export function appendIdempotencySnapshotVaultPath(
  context: Pick<ToolExecutionContext, "runId" | "rootMissionId">,
): string | null {
  const durableId = context.rootMissionId?.trim() || context.runId?.trim() || "";
  if (!durableId) {
    return null;
  }
  const safe = durableId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 120);
  if (!safe) {
    return null;
  }
  try {
    return normalizeVaultPath(`Agent Runs/${safe}.append-idempotency.json`);
  } catch {
    return null;
  }
}

export async function hydrateAppendIdempotencyFromRunSnapshot(
  context: Pick<ToolExecutionContext, "app" | "runId" | "rootMissionId">,
): Promise<void> {
  const path = appendIdempotencySnapshotVaultPath(context);
  if (!path) {
    return;
  }
  const file = context.app.vault.getFileByPath(path);
  if (!file) {
    return;
  }
  try {
    const parsed = parseAppendIdempotencySnapshotV1(
      JSON.parse(await context.app.vault.read(file)),
    );
    for (const key of parsed.keys) {
      recordAppliedAppendIdempotencyKey(key);
    }
  } catch {
    // A corrupt sidecar must not block the append; in-memory keys still apply.
  }
}

export async function persistAppendIdempotencyToRunSnapshot(
  context: Pick<ToolExecutionContext, "app" | "runId" | "rootMissionId">,
): Promise<void> {
  const path = appendIdempotencySnapshotVaultPath(context);
  if (!path) {
    return;
  }
  const body = JSON.stringify(snapshotAppendIdempotencyV1());
  const existing = context.app.vault.getFileByPath(path);
  try {
    if (existing) {
      await context.app.vault.modify(existing, body);
      return;
    }
    const folder = "Agent Runs";
    if (
      typeof context.app.vault.getFolderByPath === "function" &&
      !context.app.vault.getFolderByPath(folder) &&
      typeof context.app.vault.createFolder === "function"
    ) {
      await context.app.vault.createFolder(folder);
    }
    await context.app.vault.create(path, body);
  } catch {
    // Persistence failure must not undo a successful note append.
  }
}

function hasAppliedAppendIdempotencyKey(key: string): boolean {
  return appliedAppendIdempotencyKeySet.has(key);
}

function recordAppliedAppendIdempotencyKey(key: string): void {
  if (appliedAppendIdempotencyKeySet.has(key)) {
    return;
  }
  appliedAppendIdempotencyKeySet.add(key);
  appliedAppendIdempotencyKeys.push(key);
  while (appliedAppendIdempotencyKeys.length > MAX_APPLIED_APPEND_IDEMPOTENCY_KEYS) {
    const evicted = appliedAppendIdempotencyKeys.shift();
    if (evicted) {
      appliedAppendIdempotencyKeySet.delete(evicted);
    }
  }
}

/** Test-only: isolate append idempotency memory between cases. */
export function resetAppendIdempotencyStateForTests(): void {
  appliedAppendIdempotencyKeys.length = 0;
  appliedAppendIdempotencyKeySet.clear();
}

function refuseUnpreparedVaultExecution(toolName: string): never {
  throw new ToolExecutionError(
    "prepared_action_required",
    `Tool ${toolName} must be prepared and authorized before execution.`,
    { mutationState: "not_applied" },
  );
}

function vaultNow(context: ToolExecutionContext): Date {
  return context.now?.() ?? new Date();
}

function requireVaultRunId(context: ToolExecutionContext): string {
  const runId = context.runId?.trim();
  if (runId) {
    return runId;
  }
  return `vault-run-${vaultRandomToken()}`;
}

function requireVaultToolCallId(context: ToolExecutionContext): string {
  const toolCallId = context.operationId?.trim();
  if (toolCallId) {
    return toolCallId;
  }
  return `vault-call-${vaultRandomToken()}`;
}

let vaultFallbackSequence = 0;
function vaultRandomToken(): string {
  const randomUuid = globalThis.crypto?.randomUUID?.();
  if (randomUuid) {
    return randomUuid;
  }
  vaultFallbackSequence += 1;
  return `${Date.now().toString(36)}-${vaultFallbackSequence.toString(36)}`;
}

function prepareVaultFailure(error: unknown): Extract<PreparedActionResult, { ok: false }> {
  return {
    ok: false,
    error: {
      code: error instanceof ToolExecutionError ? error.code : "vault_preparation_failed",
      message: getErrorMessage(error),
    },
  };
}

async function buildVaultActionId(input: {
  runId: string;
  toolCallId: string;
  toolName: string;
}): Promise<string> {
  const hash = await sha256Fingerprint(input);
  return `vault-action-${hash.slice("sha256:".length, 39)}`;
}

async function assertVaultPreparedBinding(
  toolName: string,
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  if (action.toolName !== toolName || !(await verifyPreparedActionFingerprint(action))) {
    throw new ToolExecutionError(
      "fingerprint_mismatch",
      "Prepared vault action identity or fingerprint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  const authorized = context.authorizedAction;
  if (
    !authorized ||
    authorized.preparedActionId !== action.id ||
    authorized.payloadFingerprint !== action.payloadFingerprint ||
    !authorized.grantId.trim()
  ) {
    throw new ToolExecutionError(
      "authorization_mismatch",
      "Prepared vault action lacks its exact authority binding.",
      { mutationState: "not_applied" },
    );
  }
}

function requirePreparedString(
  args: Record<string, JsonValue>,
  key: string,
): string {
  const value = args[key];
  if (typeof value !== "string" || !value) {
    throw new ToolExecutionError(
      "invalid_prepared_action",
      `Prepared vault action is missing ${key}.`,
      { mutationState: "not_applied" },
    );
  }
  return value;
}

async function createVaultActionReceipt(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  operation: ResourceAction;
  message: string;
  startedAt: string;
  committedAt: string;
  effects?: ActionReceipt["effects"];
  observedRevision?: string;
  readbackStatus?: ActionReceipt["readback"]["status"];
  commitKind?: ActionReceipt["commitKind"];
  reconciliationGrantId?: string;
}): Promise<ActionReceipt> {
  const grantId = input.context.authorizedAction?.grantId ?? input.reconciliationGrantId!;
  const commitKind = input.commitKind ?? "committed";
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    commitKind,
    observedRevision: input.observedRevision ?? null,
  });
  return {
    version: 1,
    id: `vault-receipt-${receiptHash.slice("sha256:".length, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: input.operation,
    resource: { ...input.action.target },
    relatedResources: input.action.relatedResources,
    message: input.message,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    commitKind,
    readback: {
      status: input.readbackStatus ?? "verified",
      checkedAt: input.committedAt,
      ...(input.observedRevision
        ? {
            observedRevision: input.observedRevision,
            observedFingerprint: input.observedRevision,
          }
        : {}),
    },
    effects: input.effects,
  };
}

async function buildPreparedVaultAction(input: {
  context: ToolExecutionContext;
  toolName: string;
  targetPath: string;
  normalizedArgs: Record<string, JsonValue>;
  preview: {
    summary: string;
    destination: string;
    before?: Record<string, JsonValue>;
    after?: Record<string, JsonValue>;
    outboundPayload?: Record<string, JsonValue>;
    warnings: string[];
    outboundBytes: number;
  };
  expectedTargetRevision?: string;
}): Promise<PreparedAction> {
  const preparedAt = vaultNow(input.context);
  const runId = requireVaultRunId(input.context);
  const toolCallId = requireVaultToolCallId(input.context);
  return withPreparedActionFingerprint({
    version: 1,
    id: await buildVaultActionId({
      runId,
      toolCallId,
      toolName: input.toolName,
    }),
    runId,
    toolCallId,
    toolName: input.toolName,
    target: {
      system: "vault",
      resourceType: "markdown",
      id: input.targetPath,
      path: input.targetPath,
    },
    relatedResources: [],
    normalizedArgs: input.normalizedArgs,
    preview: input.preview,
    ...(input.expectedTargetRevision
      ? { expectedTargetRevision: input.expectedTargetRevision }
      : {}),
    idempotencyKey: `${runId}:${toolCallId}:${input.toolName}`,
    preparedAt: preparedAt.toISOString(),
    expiresAt: new Date(
      preparedAt.getTime() + PREPARED_VAULT_ACTION_TTL_MS,
    ).toISOString(),
  });
}

async function assertVaultContentRevision(
  current: string,
  action: PreparedAction,
  expectedRevision: string,
): Promise<void> {
  const currentRevision = await sha256Fingerprint(current);
  if (
    currentRevision !== expectedRevision ||
    action.expectedTargetRevision !== expectedRevision
  ) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The vault target changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
}

async function prepareReplaceCurrentFile(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    const text = getString(args, "text");
    if (!hasAuthorizedCurrentNoteReplaceIntent(context.originalPrompt)) {
      throw new Error(
        "replace_current_file requires the user to explicitly ask for rewrite, replace, clean up, reset, start fresh, overwrite, expand an under-target draft, edit/revise the existing note, or clear/delete current note content and then write new content.",
      );
    }
    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    assertSafeCurrentNoteWritePayload({
      kind: "replace",
      text,
      currentContent: current,
      allowDestructiveShortReplace:
        allowsDestructiveShortCurrentNoteReplace(context.originalPrompt),
    });
    const contentRevision = await sha256Fingerprint(current);
    const outboundBytes = getByteLength(text);
    const action = await buildPreparedVaultAction({
      context,
      toolName: "replace_current_file",
      targetPath: file.path,
      normalizedArgs: {
        path: file.path,
        text,
        contentRevision,
      },
      preview: {
        summary: `Replace ${file.path} after creating a backup.`,
        destination: file.path,
        before: { path: file.path, bytes: getByteLength(current) },
        after: { path: file.path, bytes: outboundBytes },
        outboundPayload: { text },
        warnings: ["Replacement creates a backup then overwrites the note."],
        outboundBytes,
      },
      expectedTargetRevision: contentRevision,
    });
    return { ok: true, action };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

async function executePreparedReplaceCurrentFile(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("replace_current_file", action, context);
  const path = requirePreparedString(action.normalizedArgs, "path");
  const text = typeof action.normalizedArgs.text === "string"
    ? action.normalizedArgs.text
    : (() => {
        throw new ToolExecutionError(
          "invalid_prepared_action",
          "Prepared vault action is missing text.",
          { mutationState: "not_applied" },
        );
      })();
  const contentRevision = requirePreparedString(
    action.normalizedArgs,
    "contentRevision",
  );
  const file = getActiveMarkdownFile(context);
  if (file.path !== path) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The active note changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
  const current = await context.app.vault.read(file);
  await assertVaultContentRevision(current, action, contentRevision);
  assertSafeCurrentNoteWritePayload({
    kind: "replace",
    text,
    currentContent: current,
    allowDestructiveShortReplace:
      allowsDestructiveShortCurrentNoteReplace(context.originalPrompt),
  });
  const startedAt = vaultNow(context).toISOString();
  const backupPath = await backupCurrentFile(context, file, current);
  await replaceVaultFileIfUnchanged(context, file, current, text);
  const observed = await context.app.vault.read(file);
  if (observed !== text) {
    throw new ToolExecutionError(
      "vault_readback_failed",
      "Vault replace acknowledged, but readback did not match the approved content.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = vaultNow(context).toISOString();
  const bytesWritten = getByteLength(text);
  // A replace destroys the prior content in full; carrying its byte length
  // keeps wipes distinguishable from no-ops in the durable record.
  const bytesDeleted = getByteLength(current);
  return {
    output: {
      path: file.path,
      backupPath,
      bytesWritten,
      bytesDeleted,
    },
    mutationState: "applied",
    receipt: await createVaultActionReceipt({
      action,
      context,
      operation: "replace",
      message: `Replaced ${file.path} after backup.`,
      startedAt,
      committedAt,
      effects: { bytesWritten, bytesDeleted },
      observedRevision: await sha256Fingerprint(observed),
    }),
  };
}

async function prepareReplaceFile(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    assertReplaceIntent(context, "replace_file");
    const path = normalizeVaultPath(getRequiredString(args, "path"), {
      requireMarkdown: true,
    });
    const text = getString(args, "text");
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    assertSafeCurrentNoteWritePayload({
      kind: "replace",
      text,
      currentContent: current,
      allowDestructiveShortReplace:
        allowsDestructiveShortCurrentNoteReplace(context.originalPrompt),
    });
    const contentRevision = await sha256Fingerprint(current);
    const outboundBytes = getByteLength(text);
    const action = await buildPreparedVaultAction({
      context,
      toolName: "replace_file",
      targetPath: file.path,
      normalizedArgs: {
        path: file.path,
        text,
        contentRevision,
      },
      preview: {
        summary: `Replace ${file.path} after creating a backup.`,
        destination: file.path,
        before: { path: file.path, bytes: getByteLength(current) },
        after: { path: file.path, bytes: outboundBytes },
        outboundPayload: { path: file.path, text },
        warnings: ["Replacement creates a backup then overwrites the file."],
        outboundBytes,
      },
      expectedTargetRevision: contentRevision,
    });
    return { ok: true, action };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

async function executePreparedReplaceFile(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("replace_file", action, context);
  const path = requirePreparedString(action.normalizedArgs, "path");
  const text = typeof action.normalizedArgs.text === "string"
    ? action.normalizedArgs.text
    : (() => {
        throw new ToolExecutionError(
          "invalid_prepared_action",
          "Prepared vault action is missing text.",
          { mutationState: "not_applied" },
        );
      })();
  const contentRevision = requirePreparedString(
    action.normalizedArgs,
    "contentRevision",
  );
  const file = getMarkdownFileByPath(context, path);
  const current = await context.app.vault.read(file);
  await assertVaultContentRevision(current, action, contentRevision);
  assertSafeCurrentNoteWritePayload({
    kind: "replace",
    text,
    currentContent: current,
    allowDestructiveShortReplace:
      allowsDestructiveShortCurrentNoteReplace(context.originalPrompt),
  });
  const startedAt = vaultNow(context).toISOString();
  const backupPath = await backupCurrentFile(context, file, current);
  await replaceVaultFileIfUnchanged(context, file, current, text);
  const observed = await context.app.vault.read(file);
  if (observed !== text) {
    throw new ToolExecutionError(
      "vault_readback_failed",
      "Vault replace acknowledged, but readback did not match the approved content.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = vaultNow(context).toISOString();
  const bytesWritten = getByteLength(text);
  // A replace destroys the prior content in full; carrying its byte length
  // keeps wipes distinguishable from no-ops in the durable record.
  const bytesDeleted = getByteLength(current);
  return {
    output: {
      path: file.path,
      operation: "replace",
      backupPath,
      bytesWritten,
      bytesDeleted,
    },
    mutationState: "applied",
    receipt: await createVaultActionReceipt({
      action,
      context,
      operation: "replace",
      message: `Replaced ${file.path} after backup.`,
      startedAt,
      committedAt,
      effects: { bytesWritten, bytesDeleted },
      observedRevision: await sha256Fingerprint(observed),
    }),
  };
}

async function prepareDeleteCurrentFile(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    expectNoArgs(args, "delete_current_file");
    if (!DELETE_INTENT_PATTERN.test(context.originalPrompt)) {
      throw new Error(
        "delete_current_file requires the user to explicitly ask to delete, remove, or trash the current note.",
      );
    }
    const file = getActiveMarkdownFile(context);
    const current = await context.app.vault.read(file);
    const contentRevision = await sha256Fingerprint(current);
    const bytesDeleted = getByteLength(current);
    const action = await buildPreparedVaultAction({
      context,
      toolName: "delete_current_file",
      targetPath: file.path,
      normalizedArgs: {
        path: file.path,
        contentRevision,
        bytesDeleted,
      },
      preview: {
        summary: `Trash ${file.path} after creating a backup.`,
        destination: file.path,
        before: { path: file.path, bytes: bytesDeleted },
        after: { path: file.path, present: false },
        outboundPayload: { path: file.path },
        warnings: [
          "This deletes the current note into Obsidian trash after backup and requires double confirmation.",
        ],
        outboundBytes: 0,
      },
      expectedTargetRevision: contentRevision,
    });
    return { ok: true, action };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

async function executePreparedDeleteCurrentFile(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("delete_current_file", action, context);
  const path = requirePreparedString(action.normalizedArgs, "path");
  const contentRevision = requirePreparedString(
    action.normalizedArgs,
    "contentRevision",
  );
  const file = getActiveMarkdownFile(context);
  if (file.path !== path) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The active note changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
  const current = await context.app.vault.read(file);
  await assertVaultContentRevision(current, action, contentRevision);
  const startedAt = vaultNow(context).toISOString();
  const backupPath = await backupCurrentFile(context, file, current);
  await trashVaultPath(context, file);
  if (getAbstractPath(context, path)) {
    throw new ToolExecutionError(
      "vault_readback_failed",
      "Vault trash was requested, but the note is still present.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = vaultNow(context).toISOString();
  const bytesDeleted = getByteLength(current);
  const observedRevision = await sha256Fingerprint({ absent: true, id: path });
  return {
    output: {
      path,
      operation: "trash",
      backupPath,
      bytesDeleted,
    },
    mutationState: "applied",
    receipt: await createVaultActionReceipt({
      action,
      context,
      operation: "delete",
      message: `Trashed ${path} after backup.`,
      startedAt,
      committedAt,
      effects: { bytesDeleted, affectedCount: 1 },
      observedRevision,
    }),
  };
}

async function prepareDeletePath(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
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
    if (type === "folder" && affectedCount > 0 && !recursive) {
      throw new Error("delete_path requires recursive=true for non-empty folders.");
    }
    const deletionManifest = await buildVaultDeletionManifest(
      context,
      path,
      type,
      recursive,
    );
    const contentRevision = deletionManifest.fingerprint;
    const bytesDeleted = deletionManifest.bytes;
    const action = await buildPreparedVaultAction({
      context,
      toolName: "delete_path",
      targetPath: path,
      normalizedArgs: {
        path,
        recursive,
        pathType: type,
        contentRevision,
        bytesDeleted,
        affectedCount,
      },
      preview: {
        summary: `Trash vault ${type} ${path}${recursive ? " recursively" : ""}.`,
        destination: path,
        before: {
          path,
          type,
          affectedCount,
          bytes: bytesDeleted,
        },
        after: { path, present: false },
        outboundPayload: { path, recursive },
        warnings: [
          "This moves the path into Obsidian trash and requires double confirmation.",
        ],
        outboundBytes: 0,
      },
      expectedTargetRevision: contentRevision,
    });
    return { ok: true, action };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

async function executePreparedDeletePath(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("delete_path", action, context);
  const path = requirePreparedString(action.normalizedArgs, "path");
  const contentRevision = requirePreparedString(
    action.normalizedArgs,
    "contentRevision",
  );
  const recursive = action.normalizedArgs.recursive === true;
  const pathType = requirePreparedString(action.normalizedArgs, "pathType");
  const target = getAbstractPath(context, path);
  if (!target) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The vault path is no longer present; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
  if (getPathType(target) !== pathType) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The vault path type changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
  const currentRevision = (
    await buildVaultDeletionManifest(
      context,
      path,
      pathType as VaultPathType,
      recursive,
    )
  ).fingerprint;
  if (
    currentRevision !== contentRevision ||
    action.expectedTargetRevision !== contentRevision
  ) {
    throw new ToolExecutionError(
      "vault_precondition_changed",
      "The vault target changed after preparation; prepare the action again.",
      { mutationState: "not_applied" },
    );
  }
  const startedAt = vaultNow(context).toISOString();
  await trashVaultPath(context, target);
  if (getAbstractPath(context, path)) {
    throw new ToolExecutionError(
      "vault_readback_failed",
      "Vault trash was requested, but the path is still present.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = vaultNow(context).toISOString();
  const bytesDeleted =
    typeof action.normalizedArgs.bytesDeleted === "number"
      ? action.normalizedArgs.bytesDeleted
      : undefined;
  const affectedCount =
    typeof action.normalizedArgs.affectedCount === "number"
      ? action.normalizedArgs.affectedCount
      : 1;
  const observedRevision = await sha256Fingerprint({ absent: true, id: path });
  return {
    output: {
      path,
      operation: "trash",
      bytesDeleted,
      affectedCount,
    },
    mutationState: "applied",
    receipt: await createVaultActionReceipt({
      action,
      context,
      operation: "delete",
      message: `Trashed ${path}.`,
      startedAt,
      committedAt,
      effects: {
        ...(bytesDeleted === undefined ? {} : { bytesDeleted }),
        affectedCount,
      },
      observedRevision,
    }),
  };
}

async function prepareAppendResearchMemory(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    assertResearchMemoryEnabled(context);
    const topic = getRequiredString(args, "topic").trim();
    const text = getRequiredString(args, "text").trim();
    if (!topic || !text) throw new Error("append_research_memory requires non-empty topic and text.");
    const path = buildResearchMemoryPath(context, topic);
    const keywords = getOptionalStringArray(args, "keywords");
    const sourcePaths = getOptionalStringArray(args, "sourcePaths");
    sourcePaths.forEach((sourcePath) => assertSafeMarkdownPath(sourcePath));
    const sourceUrls = getOptionalStringArray(args, "sourceUrls");
    const nowIso = vaultNow(context).toISOString();
    const entryText = formatResearchMemoryAppend({ topic, text, keywords, sourcePaths, sourceUrls, nowIso });
    const file = context.app.vault.getFileByPath(path);
    const current = file ? await context.app.vault.read(file) : null;
    return { ok: true, action: await buildPreparedVaultAction({
      context, toolName: "append_research_memory", targetPath: path,
      normalizedArgs: { path, topic, text, keywords, sourcePaths, sourceUrls, nowIso, entryText,
        contentHash: hashResearchMemoryText(text),
        priorRevision: current === null ? null : await sha256Fingerprint(current),
        alreadyPresent: current !== null && researchMemoryContentPresent(current, text),
      },
      preview: { summary: `Append durable research memory to ${path}.`, destination: path,
        after: { topic, text }, warnings: [], outboundBytes: 0 },
    }) };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

/** Memory is content-deduplicated; a stale index alone never proves a no-op. */
function researchMemoryContentPresent(current: string, text: string): boolean {
  return `${current}\n`.includes(`\n\n${text}\n`);
}

function preparedResearchMemoryFields(action: PreparedAction) {
  const args = action.normalizedArgs;
  const path = requirePreparedString(args, "path");
  assertSafeMarkdownPath(path);
  if (path !== action.target.path || path !== action.target.id) {
    throw new ToolExecutionError("invalid_prepared_action", "Research memory target differs from its sealed path.", { mutationState: "not_applied" });
  }
  return {
    path, topic: requirePreparedString(args, "topic"), text: requirePreparedString(args, "text"),
    entryText: requirePreparedString(args, "entryText"), nowIso: requirePreparedString(args, "nowIso"),
    contentHash: requirePreparedString(args, "contentHash"), keywords: getOptionalStringArray(args, "keywords"),
    sourcePaths: getOptionalStringArray(args, "sourcePaths"), sourceUrls: getOptionalStringArray(args, "sourceUrls"),
  };
}

async function indexVerifiedResearchMemory(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  const entry = preparedResearchMemoryFields(action);
  const index = context.getResearchMemoryIndex?.() ?? [];
  const previous = index.find((row) => row.path === entry.path);
  // The note is the source of truth. Repair only the derived index after
  // readback; replay must not increment it twice or replace newer topic data.
  if (previous?.contentHash === entry.contentHash ||
      (previous && Date.parse(previous.lastUpdated) > Date.parse(entry.nowIso))) return;
  await context.setResearchMemoryIndex?.(upsertResearchMemoryIndexEntry(index, {
    topic: entry.topic, path: entry.path, keywords: entry.keywords, lastUpdated: entry.nowIso,
    confidence: "high", sourcePaths: entry.sourcePaths, sourceUrls: entry.sourceUrls,
    contentHash: entry.contentHash, updateCount: (previous?.updateCount ?? 0) + 1,
    targetId: previous?.targetId ?? entry.topic, verificationState: "unverified",
  }));
}

async function executePreparedAppendResearchMemory(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("append_research_memory", action, context);
  assertResearchMemoryEnabled(context);
  const entry = preparedResearchMemoryFields(action);
  const startedAt = vaultNow(context).toISOString();
  await ensureParentFolder(context, entry.path, true);
  let file = context.app.vault.getFileByPath(entry.path);
  let bytesWritten = 0;
  let operation = "append";
  if (!file) {
    const initial = `# ${entry.topic}\n\n${entry.entryText}`;
    // Obsidian create is no-overwrite. A racing creator is left intact; a
    // retry prepares the now-existing note and uses its atomic transform.
    file = await context.app.vault.create(entry.path, initial);
    bytesWritten = getByteLength(initial);
    operation = "create";
  } else {
    await transformVaultFile(context, file, (current) => {
      if (researchMemoryContentPresent(current, entry.text)) return current;
      const append = `${current.length && !current.endsWith("\n") ? "\n" : ""}${entry.entryText}`;
      bytesWritten = getByteLength(append);
      return `${current}${append}`;
    });
  }
  const observed = await context.app.vault.read(file);
  if (!researchMemoryContentPresent(observed, entry.text)) {
    throw new ToolExecutionError("vault_readback_failed", "Research memory content changed before readback; preserve the edit and reconcile before replay.", { mutationState: "may_have_applied" });
  }
  await indexVerifiedResearchMemory(action, context);
  const duplicate = bytesWritten === 0;
  const committedAt = vaultNow(context).toISOString();
  const indexed = context.getResearchMemoryIndex?.().find((row) => row.path === entry.path);
  return {
    mutationState: "applied",
    output: { path: entry.path, operation: duplicate ? "duplicate" : operation,
      topic: entry.topic, keywords: indexed?.keywords ?? entry.keywords,
      lastUpdated: indexed?.lastUpdated ?? entry.nowIso, contentHash: entry.contentHash, duplicate, bytesWritten },
    receipt: await createVaultActionReceipt({ action, context, operation: "append",
      message: duplicate ? `Verified existing research memory in ${entry.path}.` : `Saved research memory in ${entry.path}.`,
      startedAt, committedAt, commitKind: duplicate ? "no_op" : "committed",
      observedRevision: await sha256Fingerprint(observed), effects: { bytesWritten, affectedCount: duplicate ? 0 : 1, changed: !duplicate },
    }),
  };
}

async function reconcileAppendResearchMemory(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<ActionReconciliationResult> {
  assertResearchMemoryEnabled(context);
  const entry = preparedResearchMemoryFields(action);
  const file = context.app.vault.getFileByPath(entry.path);
  const current = file ? await context.app.vault.read(file) : null;
  const observedRevision = current === null ? null : await sha256Fingerprint(current);
  // A new append needs the exact sealed entry. An already-satisfied request
  // instead retains its explicit no-op proof; an index hash never substitutes.
  if (current !== null && (current.includes(entry.entryText) ||
      (action.normalizedArgs.alreadyPresent === true && researchMemoryContentPresent(current, entry.text)))) {
    await indexVerifiedResearchMemory(action, context);
    const checkedAt = vaultNow(context).toISOString();
    return { outcome: "committed", message: "Exact research memory readback reconciled; the note was not mutated.",
      receipt: await createVaultActionReceipt({ action, context, operation: "append",
        message: `Reconciled research memory in ${entry.path} from exact readback.`,
        startedAt: checkedAt, committedAt: checkedAt, commitKind: "reconciled",
        reconciliationGrantId: "reconciled-exact-readback", observedRevision: observedRevision!,
      }),
    };
  }
  return observedRevision === action.normalizedArgs.priorRevision
    ? { outcome: "not_applied", message: "Memory note still matches the sealed pre-write state; no replay was performed." }
    : { outcome: "still_uncertain", message: "Memory note changed and the exact sealed content is absent; preserve user edits and review before replay." };
}

async function prepareDeleteResearchMemoryEntry(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    assertResearchMemoryEnabled(context);
    if (!/\b(delete|remove|trash)\b/i.test(context.originalPrompt)) {
      throw new Error(
        "delete_research_memory_entry requires explicit delete, remove, or trash intent.",
      );
    }
    const topic = getRequiredString(args, "topic").trim();
    const indexed = findResearchMemoryIndexEntry(context, topic);
    const path = indexed?.path ?? buildResearchMemoryPath(context, topic);
    const file = getMarkdownFileByPath(context, path);
    const current = await context.app.vault.read(file);
    const contentRevision = await sha256Fingerprint(current);
    const bytesDeleted = getByteLength(current);
    const resolvedTopic = indexed?.topic ?? topic;
    const action = await buildPreparedVaultAction({
      context,
      toolName: "delete_research_memory_entry",
      targetPath: path,
      normalizedArgs: {
        topic: resolvedTopic,
        path,
        contentRevision,
        bytesDeleted,
      },
      preview: {
        summary: `Trash research memory note ${path} and remove its index entry.`,
        destination: path,
        before: { path, topic: resolvedTopic, bytes: bytesDeleted },
        after: { path, present: false },
        outboundPayload: { topic: resolvedTopic, path },
        warnings: [
          "This trashes a research memory note after backup and requires double confirmation.",
        ],
        outboundBytes: 0,
      },
      expectedTargetRevision: contentRevision,
    });
    return { ok: true, action };
  } catch (error) {
    return prepareVaultFailure(error);
  }
}

async function executePreparedDeleteResearchMemoryEntry(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertVaultPreparedBinding("delete_research_memory_entry", action, context);
  assertResearchMemoryEnabled(context);
  const path = requirePreparedString(action.normalizedArgs, "path");
  const topic = requirePreparedString(action.normalizedArgs, "topic");
  const contentRevision = requirePreparedString(
    action.normalizedArgs,
    "contentRevision",
  );
  const file = getMarkdownFileByPath(context, path);
  const current = await context.app.vault.read(file);
  await assertVaultContentRevision(current, action, contentRevision);
  const startedAt = vaultNow(context).toISOString();
  const backupPath = await backupCurrentFile(context, file, current);
  await trashVaultPath(context, file);
  const nextIndex = (context.getResearchMemoryIndex?.() ?? []).filter(
    (entry) => entry.path !== path,
  );
  await context.setResearchMemoryIndex?.(nextIndex);
  if (getAbstractPath(context, path)) {
    throw new ToolExecutionError(
      "vault_readback_failed",
      "Vault trash was requested, but the research memory note is still present.",
      { mutationState: "may_have_applied" },
    );
  }
  const committedAt = vaultNow(context).toISOString();
  const bytesDeleted = getByteLength(current);
  const observedRevision = await sha256Fingerprint({ absent: true, id: path });
  return {
    output: {
      path,
      operation: "trash",
      topic,
      backupPath,
      bytesDeleted,
    },
    mutationState: "applied",
    receipt: await createVaultActionReceipt({
      action,
      context,
      operation: "delete",
      message: `Trashed research memory ${path} after backup.`,
      startedAt,
      committedAt,
      effects: { bytesDeleted, affectedCount: 1 },
      observedRevision,
    }),
  };
}
