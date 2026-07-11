# Agentic Researcher

Agentic Researcher is a native Obsidian community plugin that adds a right-side research assistant inside Obsidian. It is built around a prompt-first chat surface, a `Run Mission` action, and a `Run Details` view for planning, tool activity, receipts, and diagnostics.

The plugin is intended to run real research and note-writing workflows inside an Obsidian vault:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

## Features

- Native Obsidian view with a minimal green-on-black mission console.
- Conditional `Orchestrator` tab for a live two-agent task tree, evidence handoffs, Git worktrees, validation, merge, and replay while preserving the original Chat and Run Details surfaces.
- Ollama-compatible model client for local model chat and streaming.
- Agent loop with bounded steps, tool validation, and run receipts.
- Vault tools for reading markdown files, inspecting folders, editing sections, appending to notes, replacing notes with backups, moving paths, and Obsidian-safe trash flows.
- Graph-aware vault tools for explicit links, backlinks, unresolved links, related-note discovery, link suggestions, and controlled inline wiki-link insertion with backups.
- `count_words` support for active notes and safe markdown paths, plus one-pass generated draft word-count correction for explicit word targets.
- Web search and fetch tools for sourced research when enabled by the mission.
- Truthful source gating rejects empty/unparsed pages as proof and supports cache, provider, and safety-gated browser extraction fallbacks.
- Metadata-aware template ranking, dry rendering, safe built-ins, collision handling, and read-back verification.
- Approval-gated code-team worktrees with a shell-free code worker and guarded green auto-promotion.
- A descriptor-based external-action kernel with prepared-action fingerprints, scoped authority grants, exact approval previews, canonical receipts, readback, and reconciliation.
- Fixed Linear GraphQL tools through capability gates 0-5; the model cannot submit arbitrary GraphQL, credentials remain host-owned, and Linear tools appear only for explicit Linear intent.
- A durable Linear queue scanner/coordinator with strict executable-ticket contracts, four-hour grants, two-ticket concurrency, project/resource locks, and a 25-start UTC-day limit.
- Pinned continuous-research schedules with quiet hours, retry state, source hashes, and verified/stale/superseded memory states.
- Persisted chat history capped to useful user and assistant messages only.
- `Run Details` diagnostics for model config, status, planning, tool timeline, receipts, and trace logs.
- Click `Stop Mission` while a run is active to request a controlled stop before the next model, tool, or writeback step.
- Model/API calls default to a 3-minute timeout and emit waiting status updates during long responses.
- Final-answer and note-writeback streaming buffer early output and stop off-topic or wrong-language responses before unrelated text is displayed or persisted.
- Streamed note writeback uses a small safety buffer, then streams safe chunks into both chat and the active note while suppressing model-emitted tool-call markup.
- Short follow-ups such as `Continue` can inherit a pending current-note read intent from recent chat instead of producing another "I'll read it" preamble.
- Simple target-only current-note writes skip redundant read/planner loops and stream directly into the active note.
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

Run the Obsidian desktop e2e tests (Obsidian must be closed first):

```bash
npm run test:e2e:mock   # deterministic playwright-e2e-mock
npm run test:e2e        # live gpt-oss:120b-cloud (--real-ai)
npm run test:e2e:real:long
```

The e2e harness builds the plugin, syncs only `main.js`, `manifest.json`, and `styles.css` into the live test vault plugin folder, launches a controlled Obsidian process, and verifies real missions against seeded notes. By default it resolves the vault as `%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai`; set `OBSIDIAN_VAULT` to override it. Close any already-running Obsidian window before running it.

**Honest limits:** overnight / long multi-segment runs require Obsidian to stay open (not a background daemon). Keep-awake and the structured model router are opt-in / experimental.

## Linear-First Work Queue

Linear is an optional, disabled-by-default work-item handoff between research and execution. Configure `Enable Linear`, a personal API key, the default team, queue project, and started/completed workflow state IDs in plugin settings. The connection test is read-only. The key is masked in the UI but stored unencrypted in the plugin's vault-local `data.json`; it is retained by the host and is never included in worker settings or prompts.

The automatic queue can be enabled only when the internal Linear capability gate is 5. While Obsidian is open, it scans at most ten project issues every 15 minutes from a durable updated-since cursor. Execution also requires a separate user-authorized four-hour grant. The coordinator rechecks that grant, reserves the daily budget, acquires durable issue/repository locks, posts and verifies a claim comment, and verifies the started-state update before routing work. Ambiguous mutations enter reconciliation instead of being retried blindly.

Current execution support is intentionally narrower than the queue contract:

- `research` tickets run through the Researcher/Lead path with a web-read-only scoped registry and chat-only output, then must include the ticket's acceptance IDs and evidence references before Linear can be completed.
- `vault` tickets remain ineligible because no trusted automatic vault-target binding is installed.
- `code` tickets may resolve only a trusted local `repositoryKey`, but queue-to-Code-Worker execution/promotion remains blocked pending compatibility e2e proof. The separate, manually approved code-team path is unchanged.
- `human` tickets are never covered by the automatic grant.
- The GitHub REST client is only a host-side scaffold for repository, pull-request, and check reads plus draft-PR creation. GitHub tools, credentials, branch push, publication receipts, and queue completion proof are not registered yet.

See local `docs/plans/linear-first-unified-agent.md` for the detailed delivery graph, invariants, and remaining promotion gates.

## Project Layout

```text
main.ts                    Plugin entrypoint
src/AgentView.ts           Right-side Obsidian UI
src/AgentRunner.ts         Agent loop and model/tool orchestration
src/model/                 Ollama-compatible model client
src/tools/                 Vault, web, validation, and registry tools
src/orchestrator/          Two-agent runtime, evidence, templates, worktrees, continuous research
src/integrations/linear/   Fixed Linear transport, tools, contracts, durability, and reconciliation
src/integrations/github/   Host-side GitHub REST scaffold (not registered as agent tools)
src/agent/actions/         Versioned descriptors, prepared actions, and canonical receipts
src/agent/authority/       Scoped grants and durable usage accounting
src/agent/queue/           Linear scanner, leases, locks, daily limits, and coordinator
src/conversationHistory.ts Persisted bounded chat memory
tests/                     Node test suite
e2e/                       Playwright Obsidian desktop tests
scripts/                   Local helper scripts for vault sync and validation
docs/                      Local-only specs, plans, and technical details (gitignored)
```

## Technical Documentation

Architecture, implementation choices, runtime flow, tool contracts, and validation details live locally in `docs/technical_details.md` (ignored by git). Update that document when changing core architecture, agent flow, settings, tool behavior, safety rules, test strategy, or build/deployment workflows. Long implementation plans belong in local `docs/plans/`. Detailed Linear delivery notes live locally in `docs/plans/linear-first-unified-agent.md`.

## GitHub Notes

This repository keeps `AGENTS.md` and product/README instructions in source control. Project documentation under `docs/` is local-only and must not be committed. Other local-only agent, skill, and planning context should use ignored paths such as `AGENTS.local.md`, `agents.local.md`, `skills/`, `.agents/`, and `.codex/`.
