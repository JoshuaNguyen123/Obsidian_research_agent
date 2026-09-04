# Agentic Researcher

Agentic Researcher is one desktop Obsidian community plugin that adds a right-side research assistant, bounded code workspace, authenticated companion controls, and Linear/GitHub integrations. It is built around a prompt-first chat surface, a `Run Mission` action, and a `Run Details` view for planning, tool activity, receipts, and diagnostics.

Code, Companion, and Integrations are internal capability modules, not separately installed Obsidian plugins. Upgrading from the earlier split development build imports each legacy `data.json` namespace into core with hash provenance; development sync moves the old plugin folders into `.obsidian/plugins/.agentic-researcher-retired/` so their data remains recoverable while Obsidian lists only `Agentic Researcher`.

The plugin is intended to run real research and note-writing workflows inside an Obsidian vault:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

## Features

- Native Obsidian view with a minimal, theme-adaptive mission console (all colors derive from the active Obsidian theme's variables).
- A durable `MissionGraphV3` is the authoritative plan; the conditional `Orchestrator` tab is a projection of that graph, while Chat and Run Details remain the primary surfaces.
- Ollama Cloud BYOK is the default agentic model connection. The API key stays in Obsidian SecretStorage; local Ollama and other compatible endpoints remain supported as optional alternatives.
- Agent loop with bounded steps, tool validation, and run receipts.
- Vault tools for reading markdown files, inspecting folders, editing sections, appending to notes, replacing notes with backups, moving paths, and Obsidian-safe trash flows.
- Graph-aware vault tools for explicit links, backlinks, unresolved links, related-note discovery, link suggestions, and controlled inline wiki-link insertion with backups.
- `count_words` support for active notes and safe markdown paths, plus one-pass generated draft word-count correction for explicit word targets.
- Web search and fetch tools for sourced research when enabled by the mission.
- Truthful source gating rejects empty/unparsed pages as proof and supports cache, provider, and safety-gated browser extraction fallbacks.
- Metadata-aware template ranking, dry rendering, safe built-ins, collision handling, and read-back verification.
- Built-in Code capability with durable scratch folders and trusted Git worktrees, bounded file CRUD, repository profiles, sandbox-only validation, repair checkpoints, and verified local commits. Creation covers Python, TypeScript, JavaScript, C, C++, HTML, CSS, Rust, Go, Java, and C#.
- Native Canvas, SVG, and Mermaid read/patch tools with optimistic concurrency, transactional design packages, structural QA, bounded layout repair, readback, and receipts.
- A descriptor-based external-action kernel with prepared-action fingerprints, scoped authority grants, exact approval previews, canonical receipts, readback, and reconciliation.
- Fixed Linear GraphQL tools through capability gates 0-5; the model cannot submit arbitrary GraphQL, credentials remain host-owned, and Linear tools appear only for explicit Linear intent.
- A durable Linear queue scanner/coordinator with strict executable-ticket contracts, four-hour grants, two-ticket concurrency, project/resource locks, and a 25-start UTC-day limit.
- Built-in Integrations capability with explicit research-to-note-to-Linear publication, reverse Linear work-item execution, secure credential references, a bounded GitHub catalog, verified Git push, draft pull requests, review handling, and separately approved merge.
- Built-in Companion controller for an authenticated loopback service with SQLite jobs, leases, event replay, OS service lifecycle commands, and a shared TypeScript headless worker. The service remains a separate local process; it is not another Obsidian plugin. Vault operations always wait for connected Obsidian.
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
- Highlight any text in a markdown note and run **Research selection (web)** from the command palette or editor context menu: the side panel opens and cited findings stream/append onto the current page by default. Use **Research selection (chat only)** when you want an answer without mutating the note.
- Chat is the mission console; **Chat only** is an explicit opt-out from note writeback. Research-shaped missions default to proof-gated streamed append under the Automatic autonomy profile.

## Requirements

- Obsidian **Desktop** 1.11.4 or newer (`manifest.json` `minAppVersion` and `isDesktopOnly`; the credential system is built on `app.secretStorage`, which shipped in 1.11.4). This plugin does not run on mobile.
- Node.js and npm (development only).
- An Ollama Cloud API key for the default **bring-your-own-key paid cloud** model. You pay the provider you configure. Local Ollama and compatible endpoints are optional alternatives.
- Vault research, citations, and note writeback work **without WSL**, Docker, or the companion. Those extras are only for code execution and optional unattended background work.

## Model requirements and reliability status

The recommended model is `glm-5.3-flash:cloud`. The eval record (`docs/eval/kpi-dashboard.md`, generated 2026-09-03T01:40:14.084Z from 194 product rows) measures it at **83.3% green** (95/114 runs) and **92.9% tool-call success** (1002/1078 succeeded across 110 rows with tool data). `deepseek-v4-pro` is **55.7% green** (39/70) and **47.1% tool-call success** (65/138 across 4 tool-bearing rows). Cheaper models still fail composed journeys: `minimax-m3:cloud` measured **33.3% green** (2/6). Research is the mature path; complex multi-stage code work is still being hardened.

## What this plugin executes and writes

This section is for community-plugin reviewers and users. It states what the installed plugin may start, where it writes besides ordinary note edit, and which network families it can call. The plugin does not download code or extra artifacts at runtime.

### External programs

When the matching capability is used, the plugin may start:

- `git` for trusted worktrees, verified local commits, and GitHub push
- `python` (or `py` / `python3`) as the optional FastEmbed semantic-embedding helper; retrieval degrades to non-semantic search if Python or FastEmbed is missing
- `wsl.exe` when the host-provisioned WSL2 sandbox is the bound code-execution provider
- an optional background companion service: a separate local loopback process, not another Obsidian plugin. Install and control materialize a Python helper under the application-data root and may resolve a host `node` executable for the worker. Vault operations still wait for connected Obsidian.

Research-only vault work does not need git, WSL, or the companion.

### Writes outside ordinary note edit

- `%LOCALAPPDATA%\AgenticResearcher` on Windows (companion runtime under `companion\`, durable code workspace state under `code\`). Other desktops use `~/Library/Application Support/AgenticResearcher` on macOS and `$XDG_DATA_HOME/agentic-researcher` or `~/.local/share/agentic-researcher` on Linux.
- `os.tmpdir()/agentic-researcher-workspaces` for ephemeral scratch workspaces
- `.agent-backups/` inside the vault before replacements and other destructive edits

Intended product writes still go into the vault as notes, receipts, and run records.

### Network

Model and integration calls are bring-your-own-key. You pay the provider you configured. This plugin does not bill usage and does not send product telemetry.

Outbound families, only when that capability is enabled or the mission needs them:

- Ollama Cloud or a local/compatible Ollama endpoint
- OpenAI, OpenRouter, and other OpenAI-compatible BYOK endpoints
- GitHub
- Linear
- Keyless scholarly and reference fallbacks already implemented in `src/tools/freeSearchProviders.ts`: Wikipedia, OpenAlex, arXiv, Crossref, PubMed, ClinicalTrials.gov, and CourtListener

Missions that search or fetch the web also call the configured primary search provider and the pages they retrieve.

### Fourth install artifact

Obsidian's community installer downloads three files: `main.js`, `manifest.json`, and `styles.css`.

`companion-assets.json` (~984 KB) is a fourth artifact. It is not fetched at runtime. Without it the plugin still loads; chat, research, and vault tools keep working, and the companion service stays disabled.

To enable the companion after a community install, copy a `companion-assets.json` that matches this plugin build from the repository (or a matching release zip) into:

```text
<vault>/.obsidian/plugins/agentic-researcher/
```

A missing, stale, or hash-mismatched file is refused. The companion stays off. The rest of the plugin keeps running.

## Install For Development

Desktop-only. The default model is bring-your-own-key paid cloud. Research works without WSL. The companion is a fourth optional artifact and is not in the community zip.

```bash
npm install
npm run build
```

Copy the plugin files into an Obsidian vault plugin folder:

```text
<vault>/.obsidian/plugins/agentic-researcher/
```

Community zip / community-installer files (exactly these three):

```text
main.js
manifest.json
styles.css
```

Optional fourth file for the local companion service. It is **not** in the community zip. Research and overnight vault work run without it (see [What this plugin executes and writes](#what-this-plugin-executes-and-writes)):

```text
companion-assets.json
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

Run only the Obsidian desktop journey you changed (Obsidian must be closed first). Every lane drives the installed plugin inside real Obsidian. Paid/live lanes use a real model, a real external service, or both. The zero-cloud lane uses the production OpenAI-compatible HTTP client against an authenticated deterministic loopback backend; it never injects a model client into the plugin:

```bash
npm run test:e2e                        # the reported daily-use failure: bare Desktop checkers prompt, real model
npm run test:e2e:offline                # zero-cloud installed-runtime chat + current-note append proof
npm run test:e2e:desktop-code-delivery  # bare Desktop prompt, number-guessing game
npm run test:e2e:research               # DU-02 proof-gated sourced writeback
npm run test:e2e:code                   # protected local WSL2 DU-03 repository delivery
npm run test:e2e:compound               # protected local WSL2/provider DU-06
npm run test:e2e:compound-real          # Obsidian → Linear → Code → GitHub → reflection
npm run test:e2e:hello-github           # TypeScript app plus a real private GitHub draft PR
npm run test:e2e:retained-journey       # full autonomous journey that keeps its artifacts
npm run test:e2e:byok-autonomous-journey # flagship two-phase journey with verifier
npm run test:e2e:configured-linear      # real Linear workspace, no model calls
npm run test:e2e:github-askpass         # real verified git push runtime, no model calls
npm run test:e2e:live                   # opt-in disposable provider mutation and cleanup
```

The old injected mock-model matrix was removed. It passed on a machine where the product could not run a mission at all: those lanes called `configureSandboxProvider` themselves, so a plugin holding zero sandbox providers still looked healthy while a real "write a Python game on my desktop" request stopped at `code_validate_fast`. Live lanes now assert the sandbox the product adopted for itself, and `--mock-ai` is refused with an explicit error. The offline lane is narrower: it proves installed application routing, production transport, note mutation/readback, receipts, and cloud isolation, but does not claim live-model competence. `npm run test:e2e:live` remains separately guarded: Linear uses one disposable issue and GitHub one disposable draft branch/PR, independently verifies the result, and cleans up. Live merge is not part of the protected release workflow.

Two GitHub Actions tiers exist. `ci-hosted.yml` runs the hygiene checks, build, and unit suite on GitHub-hosted Ubuntu for every push and pull request. Everything that needs a real vault, a live provider, or the attested sandbox is manual-only and targets the repository owner's trusted self-hosted Windows runner, labeled `agentic-daily-use`; normal pushes and public-fork pull requests never trigger that machine. Workflows pin every Action by commit SHA, keep live provider lanes manual and exact-SHA, expose each credential only to its exact provider step, and upload only redacted daily-use summaries for three days. The runner executes validation and agent-capability tests; it does not host the Obsidian agent itself.

The protected self-hosted Windows machine provides the dedicated attested WSL2 runtime required by the product's sandbox contract. Run DU-03 live and DU-06 locally at the exact pushed SHA when GitHub Actions is intentionally not dispatched; exact-SHA redacted proof is staged only under ignored `.agentic-proof/<sha>/`. A successful DU-06 creates and independently reads a real disposable Linear hierarchy, private GitHub repository, branch, and draft pull request, then deletes those disposable resources. Only the deliberately retained Linear evidence issue remains, so the test repository is expected to be absent after a green cleanup.

The e2e harness builds the one plugin artifact set, syncs it without overwriting core `data.json`, safely retires split-plugin folders with their data intact, launches a controlled Obsidian process, and verifies missions against seeded notes. It resolves a user-profile-scoped local test vault by default; set `OBSIDIAN_VAULT` to override it. Close any already-running Obsidian window before running it.

**Honest limits:** ordinary vault work and any unapproved external mutation still require Obsidian to remain open. The optional companion can resume only installed, already-authorized non-vault operations; vault nodes stop in `waiting_obsidian`. A secure persistent OS credential backend and explicit service installation are mandatory for unattended work. Generated-code execution stays disabled until a Docker, Podman, dedicated WSL2, or bubblewrap provider passes the boundary probe. The plugin adopts a binding that host provisioning (`npm run setup:sandbox:wsl2`) already recorded in the user environment and probes it once per session, so a provisioned machine needs no manual settings entry; the boundary probe remains the only authority for execution availability. The structured model router is authoritative only in the automatic autonomy profile; conservative mode remains deterministic.

## Linear-First Work Queue

Linear is an optional, disabled-by-default work-item handoff between research and execution. Configure `Enable Linear`, connect with OAuth or save a personal API credential, and choose connection-derived team, project, and workflow states in plugin settings. The connection test is read-only. Foreground OAuth tokens and personal credentials are written to Obsidian SecretStorage with readback; plugin data retains only an opaque `SecretStoreV1` reference. The personal-key input intentionally returns to blank after saving—use the saved/connected status and connection readback as proof that it persisted. The Companion credential backend is needed only for authorized background continuation, not ordinary foreground Linear use. A legacy plaintext key is cleared only after verified secure-store migration and is never included in prompts or worker settings.

The automatic queue can be enabled only when the internal Linear capability gate is 5. While Obsidian is open, it scans at most ten project issues every 15 minutes from a durable updated-since cursor. Execution also requires a separate user-authorized four-hour grant. The coordinator rechecks that grant, reserves the daily budget, acquires durable issue/repository locks, posts and verifies a claim comment, and verifies the started-state update before routing work. Ambiguous mutations enter reconciliation instead of being retried blindly.

Current execution support is bounded by trusted logical bindings:

- `research` tickets run through the Researcher/Lead path with a web-read-only scoped registry and chat-only output, then must include the ticket's acceptance IDs and evidence references before Linear can be completed.
- `vault` tickets require the exact `current-vault` binding and can create only the host-derived note `Agent Work/Linear Queue/<work-item-fingerprint>.md`; issue text cannot supply a path, command, or new authority.
- `code` tickets resolve only a trusted `repositoryKey`, run through the built-in Code capability's durable worktree/sandbox/repair path, and remain `waiting_for_publication` after a verified local commit until their required GitHub and backlink proof exists.
- `human` tickets are never covered by the automatic grant.
- GitHub exposes only a fixed catalog against a host-resolved trusted repository profile. Source changes remain local-worktree-only. Push uses ephemeral askpass, remote-SHA readback, and no force-push; draft publication and merge use separate exact approval snapshots, with merge requiring two confirmations.

While Obsidian is open, the reverse queue performs a mandatory fresh issue read before claiming work and reconciles ambiguous provider mutations by readback. The companion currently runs only operations advertised by its installed executor catalog; unsupported effectful background work is persisted as a resumable blocker rather than retried or simulated.

See local `docs/plans/linear-first-unified-agent.md` for the detailed delivery graph, invariants, and remaining promotion gates.

## Project Layout

```text
main.ts                         Unified plugin entrypoint and capability host
src/AgentView.ts                Right-side Obsidian UI
src/AgentRunner.ts              Model loop and MissionGraph orchestration
src/model/                      Ollama-compatible model client
src/tools/                      Core vault, web, diagram, and integration adapters
src/agent/missionGraph*.ts      Canonical graph planning, persistence, projection, and resume
src/integrations/linear/        Linear contracts, OAuth, publication, queue lineage, and reconciliation
src/integrations/github/        GitHub auth, fixed transport, secure push, publication, and checkpoints
packages/core-api/              Versioned extension registration and shared contracts
packages/headless-runtime/      Environment-neutral mission and companion worker runtime
extensions/code/                Internal durable workspaces, sandbox, repair, and commit module
extensions/integrations/        Internal Linear/GitHub prepared-action module
extensions/companion/           Internal authenticated background-service controller module
tests/                          Node test suite
e2e/                            Native Obsidian Playwright projects and fixtures
scripts/                        Build, sync, release-gate, and validation helpers
docs/                           Local-only specs, plans, and technical details (gitignored)
```

## Technical Documentation

Architecture, implementation choices, runtime flow, tool contracts, and validation details live locally in `docs/technical_details.md` (ignored by git). Update that document when changing core architecture, agent flow, settings, tool behavior, safety rules, test strategy, or build/deployment workflows. Long implementation plans belong in local `docs/plans/`. Detailed Linear delivery notes live locally in `docs/plans/linear-first-unified-agent.md`.

## GitHub Notes

Product and contributor instructions in this README are public. `AGENTS.md`, `agents.md`, project documentation under `docs/`, and other agent/skill/planning context are local-only and ignored; do not force-add them. Runtime databases, SQLite sidecars, vault state, Playwright reports/authentication, and environment files are also ignored and must never be committed or uploaded as public diagnostics.
