# Single-Agent Web-Acting Research Upgrade

## Objective

Upgrade the current Obsidian-native single agent into a bounded experience collector:

```text
Prompt -> plan -> tool use -> observation -> reflection -> memory write -> vault artifact
```

The system remains single-agent, local-first, and Obsidian-native. It adds:

- **Design packages**: UI flows, logistics systems, service blueprints, architecture maps, project ideation boards, and mind maps as one `.canvas` plus one markdown brief.
- **Long research mode**: adaptive long-running missions with up to 60 hard-capped steps, milestones, checkpoints, evidence ledgers, receipts, diagnostics, and final vault artifacts.
- **Visible browser automation**: desktop-only browser navigation through a local companion service: open, observe, click, type, keypress, scroll, screenshot, and extract readable markdown.

Never expose hidden chain-of-thought. Prove work through visible plans, tool traces, observations, decisions, checkpoints, memories, evidence, receipts, and artifacts.

## Mandatory Non-Goals

Do not build:

- second-agent orchestration, reviewer subagents, agent swarms, background agents, or inter-agent messaging
- unrestricted web browsing, hidden browser sessions, arbitrary crawling, scraping at scale, or browser actions without receipts
- login, credential entry, password/API-key entry into websites, checkout, payment, account mutation, email sending, uploads, or form submission
- cloud memory, hosted sync, remote vector databases, cloud embeddings, multi-user memory, or account-linked memory
- mobile browser automation on Obsidian mobile, iOS, Android, or remote browser providers
- a full browser UI replacement; Chat remains primary and browser state belongs in `Run Details`
- generalized game automation, reinforcement learning, online game bots, anti-cheat bypassing, or competitive game automation
- autonomous destructive vault automation, mass delete/rename, folder moves, overwrites, canvas deletion, plugin config destruction, or `data.json` edits

All artifact writes must be path-safe and no-overwrite by default.

## Target Architecture

Existing plugin remains the orchestrator:

```text
AgentRunner:
- route prompt
- choose mission budget
- choose allowed tools
- run bounded loop
- record ledger
- request memory search/write
- request artifact creation
- finalize response

ToolRegistry:
- expose tools based on route, settings, and safety
- wrap tool calls with receipts
- enforce approval/safety decisions

AgentView:
- render Chat
- render Run Details
- render browser observation, screenshots/paths, candidates, milestones, receipts, memory writes, evidence, and artifacts
```

Add a local companion service:

```text
companion/
  requirements.txt
  server.py
  browser_service.py
  memory_store.py
  schemas.py
  web_extract.py
  static/
    ruffle-host.html
  data/
    .gitkeep
    README.md
```

Runtime data under `companion/data/` must be gitignored except placeholder docs. The companion owns FastAPI, Playwright, screenshots, readable extraction, SQLite + FTS memory, and optional Ruffle static hosting. It does not make agent decisions.

## Settings

Extend settings with:

```ts
companionBaseUrl: string;              // default "http://127.0.0.1:8765"
browserToolsEnabled: boolean;          // default false
experienceMemoryEnabled: boolean;      // default false
defaultBrowserMissionMode: "supervised" | "extract_only"; // default "supervised"
maxAgentSteps: number;                 // default 60, hard cap 60
```

Rules:

- `maxAgentSteps` cannot exceed `60`.
- Browser tools require desktop, `browserToolsEnabled === true`, and healthy companion.
- Memory tools require `experienceMemoryEnabled === true` and healthy companion.
- Mobile disables browser action tools and may allow extraction-only only when safe.

## Agent Routes And Budgets

Route concepts:

```ts
type AgentRoute =
  | "simple_answer"
  | "vault_write"
  | "source_research"
  | "long_research"
  | "browser_learning"
  | "design_package";
```

Route to:

- `long_research` for deep/long research, investigate, compare sources, multi-source, strategy, broad constraints, multiple artifacts, evidence requirements, or high step-count tasks.
- `design_package` for UI flows, logistics systems, service blueprints, architecture maps, project ideation boards, mind maps, Canvas artifacts, and visual planning artifacts.
- `browser_learning` for explicit web interaction, page navigation, game/workflow learning, clicking, scrolling, or observing a live page.

Constants:

```ts
MAX_AGENT_STEPS = 60
DEFAULT_AGENT_STEPS = 30
FINALIZATION_RESERVE_STEPS = 4
REFLECTION_INTERVAL_STEPS = 5
```

Budget policy:

- `simple_answer`: 4-8 steps
- `vault_write`: 8-16 steps
- `source_research`: 16-30 steps
- `design_package`: 20-40 steps
- `browser_learning`: 24-50 steps
- `long_research`: 30-60 steps

Explicit user step requests override defaults but never exceed 60. Always reserve final steps for verification, artifact write, memory/reflection write, and final response.

## Mission Ledger

Extend the existing `Agent Runs/<runId>.md` ledger toward milestone records with stages:

```ts
"plan" | "gather" | "browser_observe" | "browser_act" |
"synthesize" | "verify" | "write_save" | "memory_reflection" | "next_action"
```

Each milestone records mission id, step number, stage, summary, decision, tool calls, evidence refs, artifacts, errors, next action, and timestamp. Keep resume compatibility with current mission-ledger behavior.

## Browser Loop

Every browser mission follows:

```text
observe -> decide safe action -> safety check -> act once -> observe result -> record receipt -> reflect every N actions -> store memory when useful
```

Do not batch multiple browser actions into one hidden step. Every browser action must produce a tool call, safety decision, result, receipt, visible observation/error, and ledger entry.

## Memory Behavior

Memory kinds:

```ts
"episodic" | "semantic" | "procedural" | "source"
```

Rules:

- Search relevant memories before research, writing, browser learning, design package generation, and continuation prompts.
- Write memory after meaningful tasks.
- Write semantic/procedural memory only when evidence is strong.
- Source memory must include citation/source metadata.
- Memory writes must appear in `Run Details`.

Promotion meanings:

- episodic: one-time event or task result
- semantic: durable preference, project fact, or stable system fact
- procedural: reusable method, workflow, tactic, browser/game strategy
- source: extracted page, citation, source summary, evidence-bearing content

## Public Interfaces

Create `src/agent/ToolContracts.ts` for shared browser, memory, receipt, artifact, and safety contracts. Include mission ids, step numbers, risk, timestamps, safety decisions, artifacts, errors, bounds, risk hints, page state hints, confidence, tags, source metadata, vault path, evidence refs, and score.

Create `src/agent/SafetyPolicy.ts` with browser base checks, blocked URL protocols, high-risk text patterns, and explicit allow/require-approval/block decisions.

Create `src/agent/CompanionClient.ts` with health, browser, screenshot, markdown extraction, and memory methods using a timeout-backed fetch wrapper.

Create or adapt `src/agent/AgentBudget.ts` with a 60-step hard cap, 30-step default, four-step finalization reserve, route defaults, and explicit-step clamping.

## Tool Registry Integration

Modify the existing registry and runner filtering rather than replacing them.

Browser tools:

```text
browser_open_page
browser_observe
browser_click
browser_type
browser_keypress
browser_scroll
browser_screenshot
browser_extract_markdown
```

Memory tools:

```text
memory_search
memory_write_observation
memory_write_task_summary
memory_write_procedural
memory_write_source
```

Design tool:

```text
create_design_package
```

Each tool must check settings, desktop/health availability, route intent, and `SafetyPolicy` before companion calls. Blocked tools return structured blocked results and visible receipts where appropriate.

## Design Package Tool

Create:

```text
src/agent/design/DesignPackageTypes.ts
src/agent/design/CreateDesignPackageTool.ts
src/agent/design/CanvasWriter.ts
src/agent/design/MarkdownBriefWriter.ts
```

Design kinds: `ui_flow`, `logistics_system`, `service_blueprint`, `project_ideation`, `architecture`, `mind_map`.

Item kinds: `persona`, `screen`, `actor`, `service`, `resource`, `queue`, `database`, `milestone`, `risk`, `metric`, `dependency`, `decision`, `note`.

Input includes title, kind, target folder, items, edges, optional brief markdown, and `overwrite?: false`. Result includes canvas path, brief path, item count, edge count.

Canvas writer must default to `Design Packages`, slugify title, create unique no-overwrite `.canvas` and `.md` paths, reject traversal, ensure parent folders safely, write valid JSON Canvas, write a markdown brief with title/package kind/Canvas wikilink/items/relationships, and emit receipts/artifact refs. Prefer existing `src/design/layout.ts`, `src/design/jsonCanvas.ts`, and `src/tools/designTools.ts` patterns.

## Companion Service

Add `companion/requirements.txt`:

```text
fastapi>=0.111.0
uvicorn[standard]>=0.30.0
playwright>=1.45.0
pydantic>=2.7.0
beautifulsoup4>=4.12.0
html2text>=2024.2.26
pytest>=8.2.0
pytest-asyncio>=0.23.0
httpx>=0.27.0
```

Create:

- `companion/schemas.py` with health, browser request/response, clickable candidate, and memory write/search models.
- `companion/server.py` with FastAPI lifespan, static mount, `/health`, browser endpoints, and memory endpoints.
- `companion/browser_service.py` with visible Playwright Chromium, a single MVP page, open/observe/click/type/key/scroll/screenshot/extract, screenshots under `data/screenshots`, clickable candidates, summaries, and risk hints.
- `companion/web_extract.py` using BeautifulSoup and `html2text`, stripping script/style/noscript/svg and preserving links when requested.
- `companion/memory_store.py` with SQLite `memories` plus FTS5 `memory_fts`, JSON tags/evidence, and typed search results.
- `companion/static/ruffle-host.html` for bounded Flash/SWF experiments.
- `companion/data/.gitkeep` and `companion/data/README.md`.
- `.gitignore` rules for runtime DBs, screenshots, caches, venvs, and browser artifacts.

## Companion Docs

Create `docs/companion_service.md` with purpose, local-only safety model, Windows PowerShell setup, health check URL/JSON, and safety notes. The plugin remains orchestrator and safety gate.

## UI Requirements

Keep Chat primary. Add Run Details sections for Browser, Actions, Milestones, Memory, Evidence, and Artifacts.

Fallback message:

```text
Live browser embedding is unavailable. Showing screenshot and extracted page state instead.
```

Mobile behavior disables `browser_open_page`, click/type/key/scroll/screenshot and reports disabled browser automation clearly. Extraction-only can be allowed only when safe.

## Tests

Unit tests:

- `AgentBudget`: clamp to 60, reserve, long/design/browser budgets.
- `SafetyPolicy`: observe allowed, mobile/unhealthy/protocol/high-risk blocking, approval handling.
- `CompanionClient`: health, timeout, HTTP error formatting, browser observation, memory write/search.
- `MissionLedger`: milestone serialization/resume compatibility/receipts.
- `DesignPackage`: canvas+brief creation, no overwrite, path safety, traversal rejection, receipt, valid Canvas JSON, brief summaries.

Companion tests:

```text
companion/tests/test_health.py
companion/tests/test_memory_store.py
companion/tests/test_browser_service.py
companion/tests/fixtures/deterministic_page.html
```

E2E tests:

- complex design prompt creates Canvas plus markdown brief
- long research prompt uses long budget, milestones, checkpoints, final artifact
- browser prompt opens Browser section, navigates deterministic page, clicks, extracts markdown, saves source memory
- Civil War lecture stores task memory and later retrieves it for a follow-up quiz
- game-learning smoke records multiple observations and writes procedural memory

## Validation

Final validation sequence:

```bash
npm test
npm run build
cd companion
pytest
cd ..
npm run sync:test-vault
npm run test:e2e
```

After sync verify `main.js`, `styles.css`, and `manifest.json` are current and `data.json` is untouched.

## Implementation Phases

1. Repository survey: inspect `src/`, `tests/`, `docs/`, `package.json`, `manifest.json`, `AgentRunner`, `AgentView`, settings, registry, artifact writer, and e2e.
2. Contracts and settings: tool contracts, safety policy, settings additions/migration, tests.
3. Budgeting and mission ledger: agent budget, milestone ledger extension, runner integration, 60-step cap, reserve.
4. Companion skeleton: requirements, server, schemas, data placeholders, docs.
5. Memory store: companion memory, client methods, memory tools, Run Details rendering.
6. Browser service: Playwright service, markdown extraction, safety-gated tools, browser Run Details.
7. Design package tool: types, writers, registry tool, receipts, tests.
8. UI integration: browser/action/milestone/memory/evidence/artifact sections, fallback, mobile degradation.
9. Docs and technical details: update implementation-grounded docs.
10. Full validation and review: unsafe loopholes, path traversal, overwrite behavior, mobile behavior, hidden chain-of-thought, untested changes, settings migration, localhost binding, and `data.json`.

## Critical Review Checklist

```text
[ ] No hidden chain-of-thought displayed or persisted.
[ ] Browser page text cannot override system/developer/user instructions.
[ ] Browser actions are disabled unless settings + desktop + companion health allow them.
[ ] All medium/high-risk actions pass through SafetyPolicy.
[ ] High-risk actions are blocked or approval-only.
[ ] MAX_AGENT_STEPS is 60 everywhere.
[ ] Existing 30-step references are updated where appropriate.
[ ] Finalization reserve cannot be consumed by tool loops.
[ ] Memory writes are explicit and visible.
[ ] Source memories include source metadata.
[ ] Design package writes are path-safe.
[ ] Design package writes do not overwrite.
[ ] Companion runtime data is gitignored.
[ ] Mobile browser automation is disabled or degraded.
[ ] Docs explain local companion setup.
[ ] Tests cover deterministic browser behavior.
[ ] Synced plugin files are current.
[ ] data.json is untouched.
```

## Recommended First Codex Turn

```markdown
Use GPT-5.5. Start in planning mode.

Read the repository and the plan at `docs/plans/single_agent_web_acting_upgrade.md`.

Do not code yet.

Return:
1. Existing architecture map.
2. Files you will modify.
3. Files you will add.
4. Test files you will add or update.
5. Risk areas.
6. Phase-by-phase implementation sequence.
7. Any conflicts between the plan and the actual repository.

After that, wait for the next instruction to implement Phase 1.
```

Then implement Phase 1 only:

```markdown
Implement Phase 1 only.

Scope:
- Tool contracts
- Safety policy
- settings additions/migration if needed
- unit tests for safety policy and settings defaults

Do not implement browser service, memory store, design package, or UI yet.

Run the narrowest relevant tests and report results.
```
