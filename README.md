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
- Graph-aware vault tools for explicit links, backlinks, unresolved links, related-note discovery, link suggestions, and controlled inline wiki-link insertion with backups.
- `count_words` support for active notes and safe markdown paths, plus one-pass generated draft word-count correction for explicit word targets.
- Web search and fetch tools for sourced research when enabled by the mission.
- Persisted chat history capped to useful user and assistant messages only.
- `Run Details` diagnostics for model config, status, planning, tool timeline, receipts, and trace logs.
- Click `Stop Mission` while a run is active to request a controlled stop before the next model, tool, or writeback step.
- Model/API calls default to a 3-minute timeout and emit waiting status updates during long responses.
- Final-answer streaming buffers early output and stops off-topic responses before unrelated text is displayed or persisted.
- Streamed note writeback suppresses model-emitted tool-call markup, retries once with a content-only instruction, and leaves the note unchanged if the retry still returns a tool request.
- Short follow-ups such as `Continue` can inherit a pending current-note read intent from recent chat instead of producing another "I'll read it" preamble.
- Current-note prompt extraction lets prompts such as `Read the prompt on the page` read the visible note, execute the prompt written there, and stream generated writing back into that same note when the page prompt asks for prose or markdown output.
- Prompt-on-page source, citation, verification, vault, and graph requests route through the normal tool loop before writeback, so the run shows tool progress instead of waiting inside one long direct stream.

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

Sync the built plugin artifacts into the live test vault:

```bash
npm run sync:test-vault
```

Run the Obsidian desktop e2e test:

```bash
npm run test:e2e
```

The e2e harness builds the plugin, syncs only `main.js`, `manifest.json`, and `styles.css` into the live test vault plugin folder, launches a controlled Obsidian process, and verifies a real append mission against a seeded note. By default it resolves the vault as `%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai`; set `OBSIDIAN_VAULT` to override it. Close any already-running Obsidian window before running it.

## Project Layout

```text
main.ts                    Plugin entrypoint
src/AgentView.ts           Right-side Obsidian UI
src/AgentRunner.ts         Agent loop and model/tool orchestration
src/model/                 Ollama-compatible model client
src/tools/                 Vault, web, validation, and registry tools
src/conversationHistory.ts Persisted bounded chat memory
tests/                     Node test suite
e2e/                       Playwright Obsidian desktop tests
scripts/                   Local helper scripts for vault sync and validation
docs/                      Project specification and technical details
```

## Technical Documentation

Architecture, implementation choices, runtime flow, tool contracts, and validation details live in `docs/technical_details.md`. Update that document when changing core architecture, agent flow, settings, tool behavior, safety rules, test strategy, or build/deployment workflows.

## GitHub Notes

This repository keeps project instructions and technical documentation in source control. Local-only agent, skill, and planning context should use ignored paths such as `AGENTS.local.md`, `agents.local.md`, `skills/`, `.agents/`, and `.codex/`.
