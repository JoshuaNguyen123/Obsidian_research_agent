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
