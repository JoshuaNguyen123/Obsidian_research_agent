import { Notice, Plugin, TAbstractFile, TFile, WorkspaceLeaf } from "obsidian";
import { AgentView, AGENT_VIEW_TYPE } from "./src/AgentView";
import {
  appendConversationMessage,
  normalizeConversationHistory,
  type AgentConversationMessage,
} from "./src/conversationHistory";
import {
  createConfiguredModelClient,
  requestUrlTransport,
} from "./src/model/createModelClient";
import { createPythonFastEmbedProvider } from "./src/embeddings/pythonFastEmbedProvider";
import {
  createSemanticIndexService,
  getSemanticIndexPaths,
  shouldSemanticIndexTrackPath,
} from "./src/embeddings/semanticIndex";
import type { SemanticIndexService } from "./src/embeddings/semanticIndexTypes";
import type { ModelClient } from "./src/model/types";
import { AgentSettings, AgentSettingTab, DEFAULT_SETTINGS } from "./src/settings";
import { getProjectMemoryLocation } from "./src/agent/projectMemory";
import { createDefaultToolRegistry } from "./src/tools/createToolRegistry";
import { MAX_AGENT_STEPS } from "./src/tools/constants";
import type {
  ResearchMemoryIndexEntry,
  ToolExecutionContext,
  ToolRegistry,
} from "./src/tools/types";

const LEGACY_DEFAULT_REQUEST_TIMEOUT_MS = 60000;

export default class AgenticResearcherPlugin extends Plugin {
  settings: AgentSettings = { ...DEFAULT_SETTINGS };
  conversationHistory: AgentConversationMessage[] = [];
  researchMemoryIndex: ResearchMemoryIndexEntry[] = [];
  private lastActiveMarkdownFile: TFile | null = null;
  private semanticIndexService: SemanticIndexService | null = null;
  private semanticIndexQueuedPaths = new Set<string>();
  private semanticIndexTimer: ReturnType<typeof setTimeout> | null = null;

  async onload() {
    await this.loadSettings();
    this.semanticIndexService = this.createSemanticIndexService();
    this.updateLastActiveMarkdownFile(this.resolveCurrentMarkdownFile());
    await this.loadProjectMemoryData();

    this.registerView(
      AGENT_VIEW_TYPE,
      (leaf: WorkspaceLeaf) => new AgentView(leaf, this),
    );

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.updateLastActiveMarkdownFile(file);
        void this.loadProjectMemoryData();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (leaf) => {
        this.updateLastActiveMarkdownFile(getMarkdownFileFromLeaf(leaf));
        void this.loadProjectMemoryData();
      }),
    );

    this.registerEvent(
      this.app.vault.on("create", (file) => {
        this.queueSemanticIndexPath(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        this.queueSemanticIndexPath(file);
      }),
    );

    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.queueSemanticIndexRemoval(file.path);
      }),
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.queueSemanticIndexRemoval(oldPath);
        this.queueSemanticIndexPath(file);
      }),
    );

    this.addRibbonIcon("bot", "Open Agentic Researcher", () => {
      void this.activateView();
    });

    this.addCommand({
      id: "open-agentic-researcher",
      name: "Open Agentic Researcher",
      callback: () => {
        void this.activateView();
      },
    });

    this.addCommand({
      id: "rebuild-semantic-vault-index",
      name: "Rebuild Semantic Vault Index",
      callback: async () => {
        const result = await this.getSemanticIndexService().rebuild();
        new Notice(
          result.ok
            ? `Semantic index rebuilt: ${result.noteCount} notes, ${result.chunkCount} chunks.`
            : `Semantic index rebuild failed: ${result.message ?? result.code ?? "unknown error"}`,
        );
      },
    });

    this.addCommand({
      id: "open-semantic-vault-index",
      name: "Open Semantic Vault Index",
      callback: async () => {
        const { markdownPath } = getSemanticIndexPaths(this.settings);
        const file = this.app.vault.getFileByPath(markdownPath);
        if (!file) {
          new Notice("Semantic Vault Index.md does not exist yet.");
          return;
        }
        const leaf = this.app.workspace.getLeaf("tab");
        await leaf.openFile(file);
      },
    });

    this.addSettingTab(new AgentSettingTab(this.app, this));
  }

  onunload() {
    if (this.semanticIndexTimer) {
      clearTimeout(this.semanticIndexTimer);
      this.semanticIndexTimer = null;
    }
  }

  async activateView() {
    const existingLeaves = this.app.workspace.getLeavesOfType(AGENT_VIEW_TYPE);

    if (existingLeaves.length > 0) {
      await this.app.workspace.revealLeaf(existingLeaves[0]);
      return;
    }

    const leaf = this.app.workspace.getRightLeaf(false);

    if (!leaf) {
      new Notice("Unable to open Agentic Researcher panel.");
      return;
    }

    await leaf.setViewState({
      type: AGENT_VIEW_TYPE,
      active: true,
    });

    await this.app.workspace.revealLeaf(leaf);
  }

  async loadSettings() {
    const data = await this.loadData();
    const record = isRecord(data) ? data : {};
    const {
      conversationHistory: rawHistory,
      researchMemoryIndex: rawResearchMemoryIndex,
      ...settingsData
    } = record;

    const settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    if (
      settings.requestTimeoutMs === LEGACY_DEFAULT_REQUEST_TIMEOUT_MS ||
      !Number.isFinite(settings.requestTimeoutMs) ||
      settings.requestTimeoutMs <= 0
    ) {
      settings.requestTimeoutMs = DEFAULT_SETTINGS.requestTimeoutMs;
    }
    if (
      !Number.isFinite(settings.maxAgentSteps) ||
      settings.maxAgentSteps <= 0
    ) {
      settings.maxAgentSteps = DEFAULT_SETTINGS.maxAgentSteps;
    } else {
      settings.maxAgentSteps = Math.min(
        MAX_AGENT_STEPS,
        Math.max(1, Math.trunc(settings.maxAgentSteps)),
      );
    }
    settings.semanticSearchEnabled = settings.semanticSearchEnabled !== false;
    settings.semanticEmbeddingModel =
      typeof settings.semanticEmbeddingModel === "string" &&
      settings.semanticEmbeddingModel.trim()
        ? settings.semanticEmbeddingModel.trim()
        : DEFAULT_SETTINGS.semanticEmbeddingModel;
    settings.semanticEmbeddingDim =
      settings.semanticEmbeddingDim === 256 ? 256 : 512;
    settings.semanticChunkMinTokens = clampIntegerSetting(
      settings.semanticChunkMinTokens,
      50,
      700,
      DEFAULT_SETTINGS.semanticChunkMinTokens,
    );
    settings.semanticChunkTargetTokens = clampIntegerSetting(
      settings.semanticChunkTargetTokens,
      settings.semanticChunkMinTokens,
      700,
      DEFAULT_SETTINGS.semanticChunkTargetTokens,
    );
    settings.semanticChunkMaxTokens = clampIntegerSetting(
      settings.semanticChunkMaxTokens,
      settings.semanticChunkTargetTokens,
      1000,
      DEFAULT_SETTINGS.semanticChunkMaxTokens,
    );
    settings.semanticChunkOverlapTokens = clampIntegerSetting(
      settings.semanticChunkOverlapTokens,
      0,
      Math.max(0, settings.semanticChunkMinTokens - 1),
      DEFAULT_SETTINGS.semanticChunkOverlapTokens,
    );
    settings.semanticPythonCommand =
      typeof settings.semanticPythonCommand === "string"
        ? settings.semanticPythonCommand.trim()
        : "";
    settings.semanticModelCacheDir =
      typeof settings.semanticModelCacheDir === "string"
        ? settings.semanticModelCacheDir.trim()
        : "";
    settings.semanticIndexEnabled = settings.semanticIndexEnabled !== false;
    settings.semanticIndexFolder = normalizeVaultFolderSetting(
      settings.semanticIndexFolder,
      DEFAULT_SETTINGS.semanticIndexFolder,
    );
    settings.semanticIndexDebounceMs = clampIntegerSetting(
      settings.semanticIndexDebounceMs,
      250,
      60000,
      DEFAULT_SETTINGS.semanticIndexDebounceMs,
    );
    settings.semanticIndexMaxFiles = clampIntegerSetting(
      settings.semanticIndexMaxFiles,
      1,
      10000,
      DEFAULT_SETTINGS.semanticIndexMaxFiles,
    );
    settings.semanticIndexPersistVectors =
      settings.semanticIndexPersistVectors !== false;

    this.settings = settings;
    this.semanticIndexService = this.createSemanticIndexService();
    this.conversationHistory = normalizeConversationHistory(rawHistory);
    this.researchMemoryIndex =
      normalizeResearchMemoryIndex(rawResearchMemoryIndex);
  }

  async saveSettings() {
    await this.savePluginData();
  }

  async appendConversationMessage(message: AgentConversationMessage) {
    this.conversationHistory = appendConversationMessage(
      this.conversationHistory,
      message,
    );
    await this.savePluginData();
    await this.saveProjectMemoryData();
  }

  async clearConversationHistory() {
    this.conversationHistory = [];
    await this.savePluginData();
    await this.saveProjectMemoryData();
  }

  async setResearchMemoryIndex(entries: ResearchMemoryIndexEntry[]) {
    this.researchMemoryIndex = normalizeResearchMemoryIndex(entries);
    await this.savePluginData();
    await this.saveProjectMemoryData();
  }

  private async savePluginData() {
    await this.saveData({
      ...this.settings,
      conversationHistory: this.conversationHistory,
      researchMemoryIndex: this.researchMemoryIndex,
    });
  }

  private async loadProjectMemoryData() {
    const location = getProjectMemoryLocation(this.getCurrentMarkdownFile()?.path ?? null);
    const conversationHistory = await this.readProjectMemoryJson(
      location.conversationPath,
    );
    const researchMemoryIndex = await this.readProjectMemoryJson(
      location.researchIndexPath,
    );

    if (conversationHistory !== null) {
      this.conversationHistory = normalizeConversationHistory(conversationHistory);
    }

    if (researchMemoryIndex !== null) {
      this.researchMemoryIndex =
        normalizeResearchMemoryIndex(researchMemoryIndex);
    }
  }

  private async saveProjectMemoryData() {
    const location = getProjectMemoryLocation(this.getCurrentMarkdownFile()?.path ?? null);
    await this.writeProjectMemoryJson(
      location.conversationPath,
      this.conversationHistory,
    );
    await this.writeProjectMemoryJson(
      location.researchIndexPath,
      this.researchMemoryIndex,
    );
  }

  private async readProjectMemoryJson(path: string): Promise<unknown | null> {
    const file = this.app.vault.getFileByPath(path);
    if (!file) {
      return null;
    }

    try {
      return JSON.parse(await this.app.vault.read(file));
    } catch (error) {
      console.warn(`Unable to read Agent Memory file ${path}`, error);
      return null;
    }
  }

  private async writeProjectMemoryJson(path: string, value: unknown) {
    try {
      await ensureVaultFolderPath(this.app, getVaultParentPath(path));
      const text = `${JSON.stringify(value, null, 2)}\n`;
      const file = this.app.vault.getFileByPath(path);
      if (file) {
        await this.app.vault.modify(file, text);
      } else {
        await this.app.vault.create(path, text);
      }
    } catch (error) {
      console.warn(`Unable to write Agent Memory file ${path}`, error);
    }
  }

  createModelClient(): ModelClient {
    return createConfiguredModelClient(this.settings);
  }

  createToolRegistry(): ToolRegistry {
    return createDefaultToolRegistry();
  }

  createToolExecutionContext(originalPrompt: string): ToolExecutionContext {
    return {
      app: this.app,
      settings: this.settings,
      originalPrompt,
      httpTransport: requestUrlTransport,
      getCurrentMarkdownFile: () => this.getCurrentMarkdownFile(),
      getCurrentMarkdownContent: (file) => this.getCurrentMarkdownContent(file),
      setCurrentMarkdownContent: (file, content) =>
        this.setCurrentMarkdownContent(file, content),
      getResearchMemoryIndex: () => [...this.researchMemoryIndex],
      setResearchMemoryIndex: (entries) => this.setResearchMemoryIndex(entries),
      semanticEmbeddingProvider: createPythonFastEmbedProvider(this.settings),
      semanticIndexService: this.getSemanticIndexService(),
    };
  }

  getCurrentMarkdownFile(): TFile | null {
    const resolved = this.resolveCurrentMarkdownFile();
    if (resolved) {
      this.updateLastActiveMarkdownFile(resolved);
      return resolved;
    }

    if (this.lastActiveMarkdownFile) {
      const file = this.app.vault.getFileByPath(this.lastActiveMarkdownFile.path);
      if (file && file.extension === "md") {
        this.lastActiveMarkdownFile = file;
        return file;
      }
    }

    return null;
  }

  getCurrentMarkdownContent(file: TFile): string | null {
    const liveFile = this.getCurrentMarkdownFile();
    if (!liveFile || liveFile.path !== file.path) {
      return null;
    }

    const recentText = getMarkdownTextFromLeaf(
      this.app.workspace.getMostRecentLeaf(),
      file,
    );
    if (recentText !== null) {
      return recentText;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const text = getMarkdownTextFromLeaf(leaf, file);
      if (text !== null) {
        return text;
      }
    }

    return null;
  }

  setCurrentMarkdownContent(file: TFile, content: string): boolean {
    const recentEditor = getMarkdownEditorFromLeaf(
      this.app.workspace.getMostRecentLeaf(),
      file,
    );
    if (recentEditor?.setValue) {
      recentEditor.setValue(content);
      return true;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const editor = getMarkdownEditorFromLeaf(leaf, file);
      if (editor?.setValue) {
        editor.setValue(content);
        return true;
      }
    }

    return false;
  }

  private createSemanticIndexService(): SemanticIndexService {
    return createSemanticIndexService({
      app: this.app,
      getSettings: () => this.settings,
      getEmbeddingProvider: () => createPythonFastEmbedProvider(this.settings),
    });
  }

  private getSemanticIndexService(): SemanticIndexService {
    if (!this.semanticIndexService) {
      this.semanticIndexService = this.createSemanticIndexService();
    }
    return this.semanticIndexService;
  }

  private queueSemanticIndexPath(file: TAbstractFile | null) {
    if (!this.settings.semanticIndexEnabled || !(file instanceof TFile)) {
      return;
    }
    if (!shouldSemanticIndexTrackPath(file.path, this.settings)) {
      return;
    }
    this.semanticIndexQueuedPaths.add(file.path);
    this.scheduleSemanticIndexFlush();
  }

  private queueSemanticIndexRemoval(path: string) {
    if (!this.settings.semanticIndexEnabled) {
      return;
    }
    this.semanticIndexQueuedPaths.add(path);
    this.scheduleSemanticIndexFlush();
  }

  private scheduleSemanticIndexFlush() {
    if (this.semanticIndexTimer) {
      clearTimeout(this.semanticIndexTimer);
    }
    this.semanticIndexTimer = setTimeout(() => {
      this.semanticIndexTimer = null;
      void this.flushSemanticIndexQueue();
    }, this.settings.semanticIndexDebounceMs);
  }

  private async flushSemanticIndexQueue() {
    if (!this.settings.semanticIndexEnabled || this.semanticIndexQueuedPaths.size === 0) {
      return;
    }
    const paths = [...this.semanticIndexQueuedPaths];
    this.semanticIndexQueuedPaths.clear();

    try {
      await this.getSemanticIndexService().updatePaths(paths);
    } catch (error) {
      console.warn("Unable to update semantic index.", error);
    }
  }

  private resolveCurrentMarkdownFile(): TFile | null {
    const activeFile = this.app.workspace.getActiveFile();
    if (isMarkdownFile(activeFile)) {
      return activeFile;
    }

    const recentFile = getMarkdownFileFromLeaf(
      this.app.workspace.getMostRecentLeaf(),
    );
    if (recentFile) {
      return recentFile;
    }

    for (const leaf of this.app.workspace.getLeavesOfType("markdown")) {
      const file = getMarkdownFileFromLeaf(leaf);
      if (file) {
        return file;
      }
    }

    return null;
  }

  private updateLastActiveMarkdownFile(file: TFile | null) {
    if (isMarkdownFile(file)) {
      this.lastActiveMarkdownFile = file;
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clampIntegerSetting(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(parsed), min), max);
}

function normalizeVaultFolderSetting(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim().replace(/\/+$/, "");
  if (!trimmed) {
    return fallback;
  }
  if (
    trimmed.includes("..") ||
    trimmed.includes("\\") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:/.test(trimmed)
  ) {
    return fallback;
  }

  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === ".")) {
    return fallback;
  }

  return trimmed;
}

function normalizeResearchMemoryIndex(
  value: unknown,
): ResearchMemoryIndexEntry[] {
  if (!Array.isArray(value)) {
    return [];
  }

  const entries: ResearchMemoryIndexEntry[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      continue;
    }

    const topic = typeof item.topic === "string" ? item.topic.trim() : "";
    const path = typeof item.path === "string" ? item.path.trim() : "";
    const lastUpdated =
      typeof item.lastUpdated === "string" ? item.lastUpdated.trim() : "";
    if (!topic || !path || !lastUpdated) {
      continue;
    }

    const keywords = Array.isArray(item.keywords)
      ? item.keywords
          .filter((keyword): keyword is string => typeof keyword === "string")
          .map((keyword) => keyword.trim())
          .filter(Boolean)
          .slice(0, 24)
      : [];

    entries.push({ topic, path, keywords, lastUpdated });
  }

  return entries.slice(0, 200);
}

function isMarkdownFile(file: TFile | null | undefined): file is TFile {
  return Boolean(file && file.extension === "md");
}

function getVaultParentPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash <= 0 ? "" : normalized.slice(0, slash);
}

async function ensureVaultFolderPath(
  app: AgenticResearcherPlugin["app"],
  path: string,
) {
  const parts = path
    .split("/")
    .map((part) => part.trim())
    .filter(Boolean);
  let currentPath = "";

  for (const part of parts) {
    currentPath = currentPath ? `${currentPath}/${part}` : part;
    const existing = app.vault.getAbstractFileByPath(currentPath);
    if (existing) {
      continue;
    }

    await app.vault.createFolder(currentPath);
  }
}

function getMarkdownFileFromLeaf(leaf: WorkspaceLeaf | null): TFile | null {
  const file = (leaf?.view as { file?: TFile | null } | undefined)?.file;
  return isMarkdownFile(file) ? file : null;
}

function getMarkdownTextFromLeaf(
  leaf: WorkspaceLeaf | null,
  file: TFile,
): string | null {
  const editor = getMarkdownEditorFromLeaf(leaf, file);
  const value = editor?.getValue?.();
  return typeof value === "string" ? value : null;
}

function getMarkdownEditorFromLeaf(
  leaf: WorkspaceLeaf | null,
  file: TFile,
):
  | {
      getValue?: () => string;
      setValue?: (value: string) => void;
    }
  | null {
  const view = leaf?.view as
    | {
        file?: TFile | null;
        editor?: {
          getValue?: () => string;
          setValue?: (value: string) => void;
        };
      }
    | undefined;
  if (!view || view.file?.path !== file.path) {
    return null;
  }

  return view.editor ?? null;
}
