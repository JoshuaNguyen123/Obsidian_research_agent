import { App, PluginSettingTab, Setting } from "obsidian";
import type AgenticResearcherPlugin from "../main";
import { MAX_AGENT_STEPS } from "./tools/constants";

export type ThinkingMode = "auto" | "off" | "low" | "medium" | "high" | "max";
export type StreamWritebackMode = "off" | "all_current_note_content_writes";

export interface AgentSettings {
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  model: string;
  enableStreaming: boolean;
  requestTimeoutMs: number;
  maxAgentSteps: number;
  thinkingMode: ThinkingMode;
  streamWritebackMode: StreamWritebackMode;
  templateFolder: string;
  templateOutputFolder: string;
  researchMemoryEnabled: boolean;
  researchMemoryFolder: string;
  semanticSearchEnabled: boolean;
  semanticEmbeddingModel: string;
  semanticEmbeddingDim: 256 | 512;
  semanticChunkMinTokens: number;
  semanticChunkTargetTokens: number;
  semanticChunkMaxTokens: number;
  semanticChunkOverlapTokens: number;
  semanticPythonCommand: string;
  semanticModelCacheDir: string;
  semanticIndexEnabled: boolean;
  semanticIndexFolder: string;
  semanticIndexDebounceMs: number;
  semanticIndexMaxFiles: number;
  semanticIndexPersistVectors: boolean;
  temperature: number | null;
  topK: number | null;
  topP: number | null;
  numCtx: number | null;
}

export const DEFAULT_SETTINGS: AgentSettings = {
  ollamaApiKey: "",
  ollamaBaseUrl: "https://ollama.com/api",
  model: "gpt-oss:120b",
  enableStreaming: true,
  requestTimeoutMs: 180000,
  maxAgentSteps: MAX_AGENT_STEPS,
  thinkingMode: "auto",
  streamWritebackMode: "all_current_note_content_writes",
  templateFolder: "Templates",
  templateOutputFolder: "",
  researchMemoryEnabled: true,
  researchMemoryFolder: "Agent Research Memory",
  semanticSearchEnabled: true,
  semanticEmbeddingModel: "nomic-ai/nomic-embed-text-v1.5-Q",
  semanticEmbeddingDim: 512,
  semanticChunkMinTokens: 300,
  semanticChunkTargetTokens: 500,
  semanticChunkMaxTokens: 700,
  semanticChunkOverlapTokens: 80,
  semanticPythonCommand: "",
  semanticModelCacheDir: "",
  semanticIndexEnabled: true,
  semanticIndexFolder: "Agent Memory",
  semanticIndexDebounceMs: 3000,
  semanticIndexMaxFiles: 1000,
  semanticIndexPersistVectors: true,
  temperature: null,
  topK: null,
  topP: null,
  numCtx: null,
};

export class AgentSettingTab extends PluginSettingTab {
  private readonly plugin: AgenticResearcherPlugin;

  constructor(app: App, plugin: AgenticResearcherPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Agentic Researcher" });
    containerEl.createEl("p", {
      text: "These settings are used for Ollama-compatible chat and web-search requests.",
      cls: "setting-item-description",
    });

    new Setting(containerEl)
      .setName("Ollama API key")
      .setDesc("Used later for Ollama Cloud requests.")
      .addText((text) => {
        text
          .setPlaceholder("ollama_...")
          .setValue(this.plugin.settings.ollamaApiKey)
          .onChange(async (value) => {
            this.plugin.settings.ollamaApiKey = value.trim();
            await this.plugin.saveSettings();
          });
        text.inputEl.type = "password";
      });

    new Setting(containerEl)
      .setName("Ollama base URL")
      .setDesc("Default Cloud API base URL.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.ollamaBaseUrl)
          .setValue(this.plugin.settings.ollamaBaseUrl)
          .onChange(async (value) => {
            this.plugin.settings.ollamaBaseUrl =
              value.trim() || DEFAULT_SETTINGS.ollamaBaseUrl;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Default model for the future agent runtime.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange(async (value) => {
            this.plugin.settings.model = value.trim() || DEFAULT_SETTINGS.model;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Stream final answers")
      .setDesc("Streams final prose when available; planning and tool selection use standard chat for reliability.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableStreaming)
          .onChange(async (value) => {
            this.plugin.settings.enableStreaming = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Thinking mode")
      .setDesc("Uses Ollama thinking for supported models. Auto enables known thinking-capable families.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("auto", "Auto")
          .addOption("off", "Off")
          .addOption("low", "Low")
          .addOption("medium", "Medium")
          .addOption("high", "High")
          .addOption("max", "Max")
          .setValue(this.plugin.settings.thinkingMode)
          .onChange(async (value) => {
            this.plugin.settings.thinkingMode = isThinkingMode(value)
              ? value
              : DEFAULT_SETTINGS.thinkingMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Maximum agent steps")
      .setDesc(`Upper bound for autonomous planning/tool loops. The hard safety ceiling is ${MAX_AGENT_STEPS}.`)
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.maxAgentSteps))
          .setValue(String(this.plugin.settings.maxAgentSteps))
          .onChange(async (value) => {
            const parsed = parseOptionalInteger(value, {
              min: 1,
              max: MAX_AGENT_STEPS,
            });
            this.plugin.settings.maxAgentSteps =
              parsed ?? DEFAULT_SETTINGS.maxAgentSteps;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Stream note writeback")
      .setDesc("Streams content-producing current-note writes directly into the note.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("all_current_note_content_writes", "All current-note content writes")
          .addOption("off", "Off")
          .setValue(this.plugin.settings.streamWritebackMode)
          .onChange(async (value) => {
            this.plugin.settings.streamWritebackMode = isStreamWritebackMode(value)
              ? value
              : DEFAULT_SETTINGS.streamWritebackMode;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Template folder")
      .setDesc("Vault folder for reusable markdown templates with {{field}} placeholders.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.templateFolder)
          .setValue(this.plugin.settings.templateFolder)
          .onChange(async (value) => {
            this.plugin.settings.templateFolder =
              value.trim() || DEFAULT_SETTINGS.templateFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Template output folder")
      .setDesc("Optional default vault folder for notes created from filled templates.")
      .addText((text) =>
        text
          .setPlaceholder("vault root")
          .setValue(this.plugin.settings.templateOutputFolder)
          .onChange(async (value) => {
            this.plugin.settings.templateOutputFolder = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Research memory")
      .setDesc("Stores durable topic memory as markdown notes in the vault. Clear chat does not remove this memory.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.researchMemoryEnabled)
          .onChange(async (value) => {
            this.plugin.settings.researchMemoryEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Research memory folder")
      .setDesc("Vault folder for durable topic memory notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.researchMemoryFolder)
          .setValue(this.plugin.settings.researchMemoryFolder)
          .onChange(async (value) => {
            this.plugin.settings.researchMemoryFolder =
              value.trim() || DEFAULT_SETTINGS.researchMemoryFolder;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic search")
      .setDesc("Adds local FastEmbed-powered conceptual vault search as a read-only tool.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticSearchEnabled)
          .onChange(async (value) => {
            this.plugin.settings.semanticSearchEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic embedding model")
      .setDesc("FastEmbed model used for semantic_search_notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.semanticEmbeddingModel)
          .setValue(this.plugin.settings.semanticEmbeddingModel)
          .onChange(async (value) => {
            this.plugin.settings.semanticEmbeddingModel =
              value.trim() || DEFAULT_SETTINGS.semanticEmbeddingModel;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic embedding dimension")
      .setDesc("Matryoshka truncation dimension. Use 512 for quality or 256 for a smaller/faster search footprint.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("512", "512")
          .addOption("256", "256")
          .setValue(String(this.plugin.settings.semanticEmbeddingDim))
          .onChange(async (value) => {
            this.plugin.settings.semanticEmbeddingDim =
              value === "256" ? 256 : 512;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic chunk tokens")
      .setDesc("Min, target, max, and overlap token estimates for markdown chunks.")
      .addText((text) =>
        text
          .setPlaceholder("300")
          .setValue(String(this.plugin.settings.semanticChunkMinTokens))
          .onChange(async (value) => {
            this.plugin.settings.semanticChunkMinTokens =
              parseOptionalInteger(value, { min: 50, max: 700 }) ??
              DEFAULT_SETTINGS.semanticChunkMinTokens;
            await this.plugin.saveSettings();
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder("500")
          .setValue(String(this.plugin.settings.semanticChunkTargetTokens))
          .onChange(async (value) => {
            this.plugin.settings.semanticChunkTargetTokens =
              parseOptionalInteger(value, { min: 50, max: 700 }) ??
              DEFAULT_SETTINGS.semanticChunkTargetTokens;
            await this.plugin.saveSettings();
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder("700")
          .setValue(String(this.plugin.settings.semanticChunkMaxTokens))
          .onChange(async (value) => {
            this.plugin.settings.semanticChunkMaxTokens =
              parseOptionalInteger(value, { min: 50, max: 1000 }) ??
              DEFAULT_SETTINGS.semanticChunkMaxTokens;
            await this.plugin.saveSettings();
          }),
      )
      .addText((text) =>
        text
          .setPlaceholder("80")
          .setValue(String(this.plugin.settings.semanticChunkOverlapTokens))
          .onChange(async (value) => {
            this.plugin.settings.semanticChunkOverlapTokens =
              parseOptionalInteger(value, { min: 0, max: 300 }) ??
              DEFAULT_SETTINGS.semanticChunkOverlapTokens;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic Python command")
      .setDesc("Optional Python command for FastEmbed. Leave blank to try python, then py.")
      .addText((text) =>
        text
          .setPlaceholder("python")
          .setValue(this.plugin.settings.semanticPythonCommand)
          .onChange(async (value) => {
            this.plugin.settings.semanticPythonCommand = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic model cache folder")
      .setDesc("Optional local folder for downloaded FastEmbed model files.")
      .addText((text) =>
        text
          .setPlaceholder("FastEmbed default")
          .setValue(this.plugin.settings.semanticModelCacheDir)
          .onChange(async (value) => {
            this.plugin.settings.semanticModelCacheDir = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic index")
      .setDesc("Maintains a derived Markdown map and local JSON vector index for faster conceptual vault search.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticIndexEnabled)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexEnabled = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic index folder")
      .setDesc("Vault folder for Semantic Vault Index.md and semantic-vault-index.json.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.semanticIndexFolder)
          .setValue(this.plugin.settings.semanticIndexFolder)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexFolder = normalizeVaultFolderSetting(
              value,
              DEFAULT_SETTINGS.semanticIndexFolder,
            );
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic index debounce")
      .setDesc("Milliseconds to wait before indexing changed markdown files after vault events.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.semanticIndexDebounceMs))
          .setValue(String(this.plugin.settings.semanticIndexDebounceMs))
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexDebounceMs =
              parseOptionalInteger(value, { min: 250, max: 60000 }) ??
              DEFAULT_SETTINGS.semanticIndexDebounceMs;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Semantic index max files")
      .setDesc("Maximum markdown files to include in the derived semantic index.")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.semanticIndexMaxFiles))
          .setValue(String(this.plugin.settings.semanticIndexMaxFiles))
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexMaxFiles =
              parseOptionalInteger(value, { min: 1, max: 10000 }) ??
              DEFAULT_SETTINGS.semanticIndexMaxFiles;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Persist semantic vectors")
      .setDesc("Stores local embedding vectors in semantic-vault-index.json. Vectors are never shown to the model.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.semanticIndexPersistVectors)
          .onChange(async (value) => {
            this.plugin.settings.semanticIndexPersistVectors = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc("Optional Ollama sampling temperature. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.temperature))
          .onChange(async (value) => {
            this.plugin.settings.temperature = parseOptionalNumber(value, {
              min: 0,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Top K")
      .setDesc("Optional Ollama top_k value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.topK))
          .onChange(async (value) => {
            this.plugin.settings.topK = parseOptionalInteger(value, { min: 1 });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Top P")
      .setDesc("Optional Ollama top_p value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.topP))
          .onChange(async (value) => {
            this.plugin.settings.topP = parseOptionalNumber(value, {
              min: 0,
              max: 1,
            });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Context window")
      .setDesc("Optional Ollama num_ctx value. Leave blank for provider default.")
      .addText((text) =>
        text
          .setPlaceholder("default")
          .setValue(formatOptionalNumber(this.plugin.settings.numCtx))
          .onChange(async (value) => {
            this.plugin.settings.numCtx = parseOptionalInteger(value, { min: 1 });
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Request timeout")
      .setDesc("Maximum time to wait for model and web requests, in milliseconds. Default is 180000 (3 minutes).")
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.requestTimeoutMs))
          .setValue(String(this.plugin.settings.requestTimeoutMs))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value.trim(), 10);
            this.plugin.settings.requestTimeoutMs =
              Number.isFinite(parsed) && parsed > 0
                ? parsed
                : DEFAULT_SETTINGS.requestTimeoutMs;
            await this.plugin.saveSettings();
          }),
      );
  }
}

function isThinkingMode(value: string): value is ThinkingMode {
  return (
    value === "auto" ||
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

function isStreamWritebackMode(value: string): value is StreamWritebackMode {
  return value === "off" || value === "all_current_note_content_writes";
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}

function parseOptionalNumber(
  value: string,
  bounds: { min?: number; max?: number } = {},
): number | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  if (bounds.min !== undefined && parsed < bounds.min) {
    return null;
  }

  if (bounds.max !== undefined && parsed > bounds.max) {
    return null;
  }

  return parsed;
}

function parseOptionalInteger(
  value: string,
  bounds: { min?: number; max?: number } = {},
): number | null {
  const parsed = parseOptionalNumber(value, bounds);
  return parsed === null ? null : Math.trunc(parsed);
}

function normalizeVaultFolderSetting(value: string, fallback: string): string {
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
