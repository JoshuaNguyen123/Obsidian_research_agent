# Agentic Researcher

Agentic Researcher is a native Obsidian community plugin that adds a right-side research assistant inside Obsidian. It is built around a prompt-first chat surface, a `Run Mission` action, and a `Run Details` view for planning, tool activity, receipts, and diagnostics.

The plugin is intended to run real research and note-writing workflows inside an Obsidian vault:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

## Features

- Native Obsidian view with a minimal green-on-black mission console.
- Ollama-compatible model client for local model chat and streaming.
- Agent loop with bounded steps, tool validation, and run receipts.
- Vault tools for reading markdown files, inspecting folders, editing sections, appending to notes, replacing notes with backups, moving paths, and Obsidian-safe trash flows.
- Web search and fetch tools for sourced research when enabled by the mission.
- Persisted chat history capped to useful user and assistant messages only.
- `Run Details` diagnostics for model config, status, planning, tool timeline, receipts, and trace logs.

## Requirements

- Obsidian 1.5.0 or newer.
- Node.js and npm.
- A local or compatible Ollama API endpoint if you want model-backed runs.

## Install For Development

```bash
npm install
npm run build
```

Copy the plugin files into an Obsidian vault plugin folder:

```text
<vault>/.obsidian/plugins/agentic-researcher/
```

Required files:

```text
main.js
manifest.json
styles.css
```

Then enable `Agentic Researcher` in Obsidian's community plugin settings.

## Development

Run tests:

```bash
npm test
```

Create a production build:

```bash
npm run build
```

Start the development build watcher:

```bash
npm run dev
```

## Project Layout

```text
main.ts                    Plugin entrypoint
src/AgentView.ts           Right-side Obsidian UI
src/AgentRunner.ts         Agent loop and model/tool orchestration
src/model/                 Ollama-compatible model client
src/tools/                 Vault, web, validation, and registry tools
src/conversationHistory.ts Persisted bounded chat memory
tests/                     Node test suite
```

## GitHub Notes

This repository intentionally ignores local planning and agent context such as `AGENTS.md`, `docs/`, `skills/`, `.agents/`, and `.codex/`. Those files can stay on a developer machine without being published to GitHub.
