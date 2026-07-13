# Agentic Researcher

Agentic Researcher is a native Obsidian community plugin that adds a right-side research assistant inside Obsidian. It is built around a prompt-first chat surface, a `Run Mission` action, and a `Run Details` view for planning, tool activity, receipts, and diagnostics.

The plugin is intended to run real research and note-writing workflows inside an Obsidian vault:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

## Features

- Native Obsidian view with a minimal green-on-black mission console.
- A durable `MissionGraphV3` is the authoritative plan; the conditional `Orchestrator` tab is a projection of that graph, while Chat and Run Details remain the primary surfaces.
- Ollama-compatible model client for local model chat and streaming.
- Agent loop with bounded steps, tool validation, and run receipts.
- Vault tools for reading markdown files, inspecting folders, editing sections, appending to notes, replacing notes with backups, moving paths, and Obsidian-safe trash flows.
- Graph-aware vault tools for explicit links, backlinks, unresolved links, related-note discovery, link suggestions, and controlled inline wiki-link insertion with backups.
- `count_words` support for active notes and safe markdown paths, plus one-pass generated draft word-count correction for explicit word targets.
- Web search and fetch tools for sourced research when enabled by the mission.
- Truthful source gating rejects empty/unparsed pages as proof and supports cache, provider, and safety-gated browser extraction fallbacks.
- Metadata-aware template ranking, dry rendering, safe built-ins, collision handling, and read-back verification.
- Optional Code extension with durable scratch folders and trusted Git worktrees, bounded file CRUD, repository profiles, sandbox-only validation, repair checkpoints, and verified local commits.
- Native Canvas, SVG, and Mermaid read/patch tools with optimistic concurrency, transactional design packages, structural QA, bounded layout repair, readback, and receipts.
- A descriptor-based external-action kernel with prepared-action fingerprints, scoped authority grants, exact approval previews, canonical receipts, readback, and reconciliation.
- Fixed Linear GraphQL tools through capability gates 0-5; the model cannot submit arbitrary GraphQL, credentials remain host-owned, and Linear tools appear only for explicit Linear intent.
- A durable Linear queue scanner/coordinator with strict executable-ticket contracts, four-hour grants, two-ticket concurrency, project/resource locks, and a 25-start UTC-day limit.
- Optional Integrations extension with explicit research-to-note-to-Linear publication, reverse Linear work-item execution, secure credential references, a bounded GitHub catalog, verified Git push, draft pull requests, review handling, and separately approved merge.
- Optional authenticated loopback Companion service with SQLite jobs, leases, event replay, OS service lifecycle commands, and a shared TypeScript headless worker. Vault operations always wait for connected Obsidian.
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
npm run test:e2e                       # default deterministic core-mock lane
npm run test:e2e:deterministic-matrix  # core, integration, sandbox, and companion-restart lanes
npm run test:e2e:integration           # deterministic Linear/GitHub integration mocks
npm run test:e2e:sandbox               # deterministic sandbox boundary lane
npm run test:e2e:companion             # deterministic companion restart lane
npm run test:e2e:real                  # opt-in real-AI lane
npm run test:e2e:live                  # opt-in disposable external-provider mutation lane
```

`npm run test:e2e` is deterministic by default and does not call a live model. The deterministic matrix runs the core mock, integration mock, sandbox, and companion-restart Playwright projects. `npm run test:e2e:real` is the explicit real-model lane. `npm run test:e2e:live` is a guarded, credentialed disposable-provider lane: Linear creates, reads, duplicate-searches, comments on, and trashes one test issue; GitHub pushes a local-worktree commit with ephemeral askpass, verifies a draft PR, and cleans up its PR/branch. Live merge requires a separate exact confirmation and performs a compensating cleanup merge.

The e2e harness builds all plugin artifacts, syncs each lane's required extensions into the test vault without overwriting any existing `data.json`, launches a controlled Obsidian process, and verifies missions against seeded notes. By default it resolves the vault as `%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai`; set `OBSIDIAN_VAULT` to override it. Close any already-running Obsidian window before running it.

**Honest limits:** ordinary vault work and any unapproved external mutation still require Obsidian to remain open. The optional companion can resume only installed, already-authorized non-vault operations; vault nodes stop in `waiting_obsidian`. A secure persistent OS credential backend and explicit service installation are mandatory for unattended work. Generated-code execution stays disabled until a Docker, Podman, dedicated WSL2, or bubblewrap provider passes the boundary probe. The structured model router is authoritative only in the automatic autonomy profile; conservative mode remains deterministic.

## Linear-First Work Queue

Linear is an optional, disabled-by-default work-item handoff between research and execution. Configure `Enable Linear`, OAuth or a personal API credential, and choose connection-derived team, project, and workflow states in plugin settings. The connection test is read-only. New credentials are stored through an opaque `SecretStoreV1` reference when the authenticated secure companion is available. A pre-existing plaintext key remains in explicit foreground compatibility mode until the user runs the verified migration action; it is never silently copied or cleared, and it is never included in prompts or worker settings.

The automatic queue can be enabled only when the internal Linear capability gate is 5. While Obsidian is open, it scans at most ten project issues every 15 minutes from a durable updated-since cursor. Execution also requires a separate user-authorized four-hour grant. The coordinator rechecks that grant, reserves the daily budget, acquires durable issue/repository locks, posts and verifies a claim comment, and verifies the started-state update before routing work. Ambiguous mutations enter reconciliation instead of being retried blindly.

Current execution support is bounded by trusted logical bindings:

- `research` tickets run through the Researcher/Lead path with a web-read-only scoped registry and chat-only output, then must include the ticket's acceptance IDs and evidence references before Linear can be completed.
- `vault` tickets require the exact `current-vault` binding and can create only the host-derived note `Agent Work/Linear Queue/<work-item-fingerprint>.md`; issue text cannot supply a path, command, or new authority.
- `code` tickets resolve only a trusted `repositoryKey`, run through the Code extension's durable worktree/sandbox/repair path, and remain `waiting_for_publication` after a verified local commit until their required GitHub and backlink proof exists.
- `human` tickets are never covered by the automatic grant.
- GitHub exposes only a fixed catalog against a host-resolved trusted repository profile. Source changes remain local-worktree-only. Push uses ephemeral askpass, remote-SHA readback, and no force-push; draft publication and merge use separate exact approval snapshots, with merge requiring two confirmations.

While Obsidian is open, the reverse queue performs a mandatory fresh issue read before claiming work and reconciles ambiguous provider mutations by readback. The companion currently runs only operations advertised by its installed executor catalog; unsupported effectful background work is persisted as a resumable blocker rather than retried or simulated.

See local `docs/plans/linear-first-unified-agent.md` for the detailed delivery graph, invariants, and remaining promotion gates.

## Project Layout

```text
main.ts                         Core plugin entrypoint and extension host
src/AgentView.ts                Right-side Obsidian UI
src/AgentRunner.ts              Model loop and MissionGraph orchestration
src/model/                      Ollama-compatible model client
src/tools/                      Core vault, web, diagram, and integration adapters
src/agent/missionGraph*.ts      Canonical graph planning, persistence, projection, and resume
src/integrations/linear/        Linear contracts, OAuth, publication, queue lineage, and reconciliation
src/integrations/github/        GitHub auth, fixed transport, secure push, publication, and checkpoints
packages/core-api/              Versioned extension registration and shared contracts
packages/headless-runtime/      Environment-neutral mission and companion worker runtime
extensions/code/                Durable workspaces, repository profiles, sandbox, repair, and commit
extensions/integrations/        Optional Linear/GitHub extension boundary
extensions/companion/           Optional authenticated local background coordinator
tests/                          Node test suite
e2e/                            Native Obsidian Playwright projects and fixtures
scripts/                        Build, sync, release-gate, and validation helpers
docs/                           Local-only specs, plans, and technical details (gitignored)
```

## Technical Documentation

Architecture, implementation choices, runtime flow, tool contracts, and validation details live locally in `docs/technical_details.md` (ignored by git). Update that document when changing core architecture, agent flow, settings, tool behavior, safety rules, test strategy, or build/deployment workflows. Long implementation plans belong in local `docs/plans/`. Detailed Linear delivery notes live locally in `docs/plans/linear-first-unified-agent.md`.

## GitHub Notes

This repository keeps `AGENTS.md` and product/README instructions in source control. Project documentation under `docs/` is local-only and must not be committed. Other local-only agent, skill, and planning context should use ignored paths such as `AGENTS.local.md`, `agents.local.md`, `skills/`, `.agents/`, and `.codex/`.
