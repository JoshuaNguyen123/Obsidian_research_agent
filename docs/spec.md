# One-Day MVP Spec: Agentic Obsidian Researcher Plugin

> Current status: this document is retained as the original one-day MVP scope, not as the current product contract. The implementation has moved beyond the MVP and now includes continuous autonomous loop budgets up to 30 steps, checkpoint notes under `Agent Runs/`, larger bounded chat history with prompt-time compaction, metadata-only vault indexing, optional seeded templates, web search/fetch/source-note tools, explicit desktop-only code execution, sandboxed HTML previews, native JSON Canvas and SVG design artifact tools, artifact verification, and Playwright e2e coverage for long-loop and design workflows. For the current implementation-grounded architecture, use `docs/technical_details.md`.

## 1. Objective

Build a native Obsidian plugin that provides a minimal right-side chat panel for an agentic research assistant.

The assistant should be able to:

* Read the current active note.
* List markdown files in the vault.
* Read selected markdown files by vault-relative path.
* Search the web through an Ollama Cloud web-search adapter.
* Call Ollama Cloud chat API with tool definitions.
* Run a bounded tool-using agent loop.
* Append generated markdown to the current note.
* Replace the current note only after creating a backup.
* Show visible progress/status updates while it works.

The goal is not to build the final autonomous researcher. The goal is to build the first credible execution slice:

```text
Chat panel → current note context → Ollama call → tool execution → note writeback
```

---

## 2. Product Scope

### In Scope for Day One

| Feature                          | Included |
| -------------------------------- | -------- |
| Right-side Obsidian chat panel   | Yes      |
| Prompt input                     | Yes      |
| Run button                       | Yes      |
| Current-note reading             | Yes      |
| Vault markdown file listing      | Yes      |
| Read markdown file by path       | Yes      |
| Ollama Cloud chat call           | Yes      |
| Ollama Cloud web-search adapter  | Yes      |
| Agent tool loop                  | Yes      |
| Append to current note           | Yes      |
| Patch note title/frontmatter     | Yes      |
| Replace current note with backup | Yes      |
| Progress/status rendering        | Yes      |
| Hard file deletion               | No       |
| Full-vault autonomous mutation   | No       |
| Embeddings/RAG index             | No       |
| Mobile sync/execution            | No       |
| Complex diff viewer              | No       |
| Background daemon                | No       |

---

## 3. Non-Goals

The one-day version should intentionally avoid:

* Repo-wide autonomous editing.
* Arbitrary file deletion.
* Shell execution.
* Plugin self-modification.
* Embedding generation.
* Vector database integration.
* Persistent memory.
* Multi-day mission state.
* Complex approval policy engine.
* Polished UI framework.
* React/Vue/Svelte frontend.
* Full streaming token transport if it slows the MVP.

The priority is execution, not architecture ceremony.

---

## 4. User Experience

The user opens a right-side panel called **Agentic Researcher**.

The panel contains:

* Chat/output log.
* Textarea prompt input.
* `Run Mission` button.
* Visible step/status messages.

Example user prompt:

```text
Research MCP servers and append a concise cited summary to this note.
```

Expected visible flow:

```text
User: Research MCP servers and append a concise cited summary to this note.

Agent:
Planning...
Reading current note...
Searching web: MCP servers Model Context Protocol
Drafting note update...
Appending to current note...
Done.
```

Expected note writeback:

```md
## Agent Research — 2026-07-03

<generated research summary>

### Sources

- <source 1>
- <source 2>
- <source 3>
```

---

## 5. Technical Architecture

```text
Obsidian Plugin
├── main.ts
├── styles.css
└── src/
    ├── AgentView.ts
    ├── AgentLoop.ts
    ├── OllamaClient.ts
    ├── settings.ts
    └── tools/
        ├── vaultTools.ts
        └── webTools.ts
```

### Core Responsibilities

| File                  | Responsibility                                             |
| --------------------- | ---------------------------------------------------------- |
| `main.ts`             | Register plugin, settings, right-side view, ribbon command |
| `AgentView.ts`        | Render chat UI, prompt box, run button, progress output    |
| `AgentLoop.ts`        | Manage model/tool loop and stopping conditions             |
| `OllamaClient.ts`     | Call Ollama chat endpoint                                  |
| `tools/vaultTools.ts` | Read/list/append/replace vault notes                       |
| `tools/webTools.ts`   | Call Ollama web-search API                                 |
| `settings.ts`         | Store API key, base URL, model                             |
| `styles.css`          | Minimal right-panel styling                                |

---

## 6. Settings

Add plugin settings for:

```ts
interface AgentSettings {
  ollamaApiKey: string;
  ollamaBaseUrl: string;
  model: string;
}
```

Default settings:

```ts
const DEFAULT_SETTINGS: AgentSettings = {
  ollamaApiKey: "",
  ollamaBaseUrl: "https://ollama.com/api",
  model: "gpt-oss:120b",
};
```

Required setting behavior:

* If `ollamaApiKey` is missing, show a clear UI error.
* Allow the model name to be changed.
* Allow base URL override for future local/remote compatibility.

---

## 7. Tool Contracts

The model may request tools, but only the plugin executes tools.

The model must never directly mutate the vault.

### Tool List

| Tool                     | Purpose                           | Write Access | Day-One Risk |
| ------------------------ | --------------------------------- | -----------: | ------------ |
| `read_current_file`      | Read active markdown note         |           No | Low          |
| `list_markdown_files`    | List vault markdown files         |           No | Low          |
| `read_file`              | Read a specific markdown file     |           No | Medium       |
| `web_search`             | Search web through Ollama adapter |           No | Medium       |
| `append_to_current_file` | Append markdown to active note    |          Yes | Medium       |
| `retitle_current_file`   | Patch title/frontmatter/H1        |          Yes | Medium       |
| `replace_current_file`   | Replace active note after backup  |          Yes | High         |

### Tool: `read_current_file`

Input:

```json
{}
```

Output:

```json
{
  "path": "Projects/example.md",
  "content": "..."
}
```

Rules:

* Requires an active markdown file.
* Maximum content returned to model: `12,000` characters.

---

### Tool: `list_markdown_files`

Input:

```json
{}
```

Output:

```json
[
  {
    "path": "Projects/example.md",
    "basename": "example"
  }
]
```

Rules:

* Only list `.md` files.
* Maximum files returned: `300`.

---

### Tool: `read_file`

Input:

```json
{
  "path": "Projects/example.md"
}
```

Output:

```json
{
  "path": "Projects/example.md",
  "content": "..."
}
```

Rules:

* Only read `.md` files.
* Reject absolute paths.
* Reject parent traversal with `..`.
* Maximum content returned to model: `12,000` characters.

---

### Tool: `web_search`

Input:

```json
{
  "query": "MCP servers Model Context Protocol",
  "max_results": 5
}
```

Output:

```json
{
  "results": [
    {
      "title": "...",
      "url": "...",
      "snippet": "..."
    }
  ]
}
```

Rules:

* Maximum results: `10`.
* Default results: `5`.
* Tool result passed back to model must be truncated to `12,000` characters.

---

### Tool: `append_to_current_file`

Input:

```json
{
  "text": "## Agent Research\n\n..."
}
```

Output:

```json
{
  "path": "Projects/example.md",
  "bytesWritten": 1234
}
```

Rules:

* Only appends to the current active markdown note.
* Does not modify arbitrary files.
* Preserves existing note content.
* Preferred only for explicit append/add/insert tasks.

---

### Tool: `retitle_current_file`

Input:

```json
{
  "title": "Native Obsidian Agentic Research"
}
```

Output:

```json
{
  "path": "Projects/example.md",
  "title": "Native Obsidian Agentic Research",
  "previousFrontmatterTitle": "Old Agent Notes",
  "previousH1": "Old Agent Notes",
  "updatedFrontmatterTitle": "Native Obsidian Agentic Research",
  "updatedH1": "Native Obsidian Agentic Research",
  "changed": true,
  "suggestedFileRename": {
    "from": "Projects/example.md",
    "to": "Projects/Native Obsidian Agentic Research.md"
  },
  "bytesWritten": 1234
}
```

Rules:

* Only patches the current active markdown note.
* Detect YAML frontmatter only when the file begins with `---`.
* Preserve frontmatter delimiters and existing metadata.
* Update an existing frontmatter `title:` field, or insert one when frontmatter exists.
* Replace the first body H1, or insert one after frontmatter when missing.
* Ignore lower headings and headings inside fenced code blocks when finding the note title.
* Do not rename the file. Return a suggested file rename separately.

---

### Tool: `replace_current_file`

Input:

```json
{
  "text": "# Rewritten Note\n\n..."
}
```

Output:

```json
{
  "path": "Projects/example.md",
  "backupPath": ".agent-backups/1720000000000-example.md",
  "bytesWritten": 1234
}
```

Rules:

* Only replaces the current active markdown note.
* Must create a backup before replacement.
* Must write backup to `.agent-backups/`.
* Only use when the user explicitly asks to rewrite, replace, clean up, reset, or start fresh.
* Do not expose this as a casual/default tool.

---

## 8. Agent Loop

### Loop Design

The plugin runs a bounded loop:

```text
1. Receive user prompt.
2. Read current note context.
3. Send system prompt + user request + context to Ollama.
4. Model either:
   a. Returns final answer, or
   b. Requests one or more tool calls.
5. Plugin executes requested tools.
6. Tool results are appended to conversation.
7. Repeat until final answer or step budget is reached.
```

### Step Budget

```ts
const MAX_AGENT_STEPS = 60;
const FINALIZATION_RESERVE_STEPS = 4;
```

If the model does not finish within the run's route-specific step budget:

```text
Stopped at safety limit. Review partial results.
```

### Agent Operating Rules

System prompt should enforce:

```text
You are an agentic research assistant running inside Obsidian.

You can:
- read the current note
- list vault markdown files
- read specific markdown files
- search the web
- open explicitly requested source URLs with a source-note receipt
- inspect a metadata-only vault index
- run explicitly requested desktop code
- render explicitly requested HTML/CSS previews
- create verified JSON Canvas and SVG design artifacts
- append to the current note
- patch the current note title/frontmatter
- replace the current note after backup

Operating rules:
1. Prefer reading the current note before writing.
2. Use web_search only when the user asks for web search, current/recent/latest information, verification, or sources/citations.
3. For static writing tasks such as "write/generate a 300 word essay", answer directly without tools unless the user explicitly asks for current information or citations.
4. Treat the active note as structured markdown, not an append-only buffer.
5. For title, heading, rename, retitle, organize, restructure, or improve requests, use retitle_current_file for title changes instead of appending a new H1.
6. Do not append duplicate H1 titles.
7. Updating the markdown H1 is separate from renaming the file; suggest file renames only when the tool returns a suggestion.
8. Prefer append_to_current_file only for explicit append/add/insert requests that do not replace an existing title or section.
9. Never overwrite a note unless the user explicitly asks for rewrite, replace, clean up, reset, or start fresh.
10. Include sources when using web_search.
11. Stop when the requested note update has been completed.
12. Do not request tools outside the provided tool list.
```

---

## 9. UI Spec

### Right-Side Panel

The panel should contain:

```text
┌─────────────────────────────┐
│ Agentic Researcher           │
├─────────────────────────────┤
│ Chat / status log            │
│                             │
│ Planning...                 │
│ Reading current note...      │
│ Searching web...             │
│ Appending to note...         │
│ Done.                        │
├─────────────────────────────┤
│ Textarea prompt input        │
├─────────────────────────────┤
│ Run Mission button           │
└─────────────────────────────┘
```

### UI Requirements

* User can open panel from ribbon icon.
* User can open panel from command palette.
* User can type a prompt.
* User can click `Run Mission`.
* UI shows each agent status event.
* UI shows tool names as they execute.
* UI shows success/failure at the end.
* UI should not freeze during long requests.
* Errors should be shown in the log, not thrown silently.

---

## 10. Progress / Streaming Behavior

For day one, prioritize **progress-event streaming** over true token streaming.

Required progress events:

```text
Planning...
Reading current note...
Agent step 1/10...
Running tool: web_search
Running tool: append_to_current_file
Done.
```

Optional later:

* True token streaming.
* Partial markdown draft display.
* Live editor insertion.
* Tool result cards.
* Source cards.

Day-one implementation should still feel active even if actual model response streaming is not implemented.

---

## 11. Vault Safety Rules

### General Guards

```ts
const MAX_AGENT_STEPS = 60;
const FINALIZATION_RESERVE_STEPS = 4;
const CHECKPOINT_EVERY_STEPS = 5;
const MAX_FILE_READ_CHARS = 12000;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_LISTED_FILES = 300;
const MAX_WEB_RESULTS = 10;
```

### Path Guards

Reject paths that:

* Contain `..`
* Start with `/`
* Match Windows absolute path format like `C:\`
* Do not end in `.md`

Example guard:

```ts
function assertSafeVaultPath(path: string) {
  if (path.includes("..")) {
    throw new Error("Unsafe path: parent traversal is not allowed.");
  }

  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    throw new Error("Unsafe path: absolute paths are not allowed.");
  }

  if (!path.endsWith(".md")) {
    throw new Error("Only markdown files are allowed.");
  }
}
```

### Write Guards

* Append is allowed by default.
* Replace requires automatic backup.
* Delete is not implemented in day-one MVP.
* Clearing a note should be treated as `replace_current_file("")` with backup.
* Arbitrary file writes are not implemented.
* Background mutation of non-active files is not implemented.

---

## 12. Implementation Plan

### Hour 0–1: Plugin Scaffolding

Tasks:

* Confirm plugin builds.
* Register right-side view.
* Add ribbon icon.
* Add command palette command.
* Add settings object.

Deliverables:

* `main.ts`
* `settings.ts`
* Basic view registration

Acceptance:

* Plugin loads in Obsidian.
* Right-side panel opens.

---

### Hour 1–2: Chat Panel UI

Tasks:

* Build `AgentView.ts`.
* Add log area.
* Add prompt textarea.
* Add `Run Mission` button.
* Wire button to placeholder mission runner.

Deliverables:

* `AgentView.ts`
* `styles.css`

Acceptance:

* User can type prompt.
* Clicking button prints prompt and status message.

---

### Hour 2–3: Vault Tools

Tasks:

* Implement `read_current_file`.
* Implement `list_markdown_files`.
* Implement `read_file`.
* Implement `append_to_current_file`.
* Implement `replace_current_file`.
* Add backup creation for replace.
* Add path guards.

Deliverables:

* `tools/vaultTools.ts`

Acceptance:

* Current note can be read.
* Markdown files can be listed.
* Specific markdown file can be read.
* Text can be appended to current note.
* Current note can be replaced after backup.

---

### Hour 3–4: Ollama Client

Tasks:

* Implement chat API client.
* Implement web-search adapter.
* Add API key handling.
* Add readable errors for failed auth/network/API calls.

Deliverables:

* `OllamaClient.ts`
* `tools/webTools.ts`

Acceptance:

* Plugin can call Ollama chat endpoint.
* Plugin can call web-search adapter.
* Missing API key produces useful error.

---

### Hour 4–6: Agent Loop

Tasks:

* Implement tool definitions.
* Implement bounded loop.
* Implement tool-call execution.
* Append tool results back into conversation.
* Stop after final response or step budget.
* Truncate large tool outputs.

Deliverables:

* `AgentLoop.ts`

Acceptance:

* Model can request `read_current_file`.
* Model can request `web_search`.
* Model can request `append_to_current_file`.
* Agent stops after completion.

---

### Hour 6–7: Progress Events

Tasks:

* Emit status updates from agent loop.
* Show step count.
* Show tool names.
* Show write completion.
* Show errors in UI.

Deliverables:

* Updated `AgentView.ts`
* Updated `AgentLoop.ts`

Acceptance:

* User can see what the agent is doing.
* Long-running missions feel active.

---

### Hour 7–8: Manual QA and Hardening

Tasks:

* Test current-note summary.
* Test web research.
* Test vault traversal.
* Test append.
* Test replace with backup.
* Test missing API key.
* Test unsafe path rejection.
* Test no active note behavior.

Deliverables:

* Working one-day MVP.
* Short internal test notes.

Acceptance:

* All day-one acceptance tests pass.

---

## 13. Acceptance Tests

### Test 1: Open Panel

Action:

```text
Open Agentic Researcher from ribbon or command palette.
```

Expected:

* Right-side panel opens.
* Prompt input appears.
* Run button appears.

---

### Test 2: Summarize Current Note

Prompt:

```text
Summarize the current note and append 5 action items.
```

Expected:

* Agent reads current note.
* Agent appends markdown to current note.
* UI shows progress.
* Existing note content is preserved.

---

### Test 3: Web Research

Prompt:

```text
Research MCP servers and append a concise cited summary to this note.
```

Expected:

* Agent uses `web_search`.
* Agent appends a sourced summary.
* Output includes source section.
* UI shows search progress.

---

### Test 4: Vault File Awareness

Prompt:

```text
Look at the markdown file names in this vault and suggest where this note belongs.
```

Expected:

* Agent calls `list_markdown_files`.
* Agent may read a small number of relevant files.
* Agent appends or returns a placement recommendation.

---

### Test 5: Replace Current Note

Prompt:

```text
Rewrite this note into a clean project brief. Replace the current note.
```

Expected:

* Agent reads current note.
* Agent creates backup in `.agent-backups/`.
* Agent replaces active note.
* UI shows backup path.

---

### Test 6: Unsafe Path Rejection

Prompt or tool request attempts:

```text
Read ../secret.md
```

Expected:

* Tool rejects request.
* UI shows clear error.
* No file is read.

---

### Test 7: Step Budget

Force the model into excessive tool use.

Expected:

* Agent stops after ten steps.
* UI says:

```text
Stopped after step budget. Review partial results.
```

---

## 14. Definition of Done

The one-day MVP is complete when:

* Plugin loads successfully.
* Right-side panel opens.
* User can submit a mission prompt.
* Agent can read the current note.
* Agent can list vault markdown files.
* Agent can read a specific markdown file.
* Agent can call Ollama chat API.
* Agent can call Ollama web-search adapter.
* Agent can run a bounded tool loop.
* Agent can append to the current note.
* Agent can replace current note after backup.
* UI shows progress events.
* Unsafe paths are rejected.
* Agent stops after max step budget.
* No hard deletion exists.
* No shell execution exists.

---

## 15. Backlog After Day One

### Sprint 2: Better Streaming

* True token streaming.
* Partial response rendering.
* Tool result cards.
* Source cards.
* Better cancellation.

### Sprint 3: Safer Editing

* Diff preview.
* Undo last agent write.
* Approval for replace.
* Smart note section replacement.
* Edit selected text only.

### Sprint 4: Better Research

* Fetch source pages.
* Extract readable page text.
* Citation formatting.
* Source deduplication.
* Research receipts.

### Sprint 5: Vault Context

* Local vault index.
* Recently edited notes.
* Linked notes.
* Backlinks.
* Tag-aware retrieval.
* Folder-scoped context.

### Sprint 6: Mission Runtime

* Durable mission log.
* Pause/resume missions.
* Multi-step research plans.
* Retry failed tools.
* Run receipts.

### Sprint 7: Mobile-Aware Execution

* Mobile request capture.
* Desktop execution host.
* Sync receipts back to vault.
* iPhone-safe mission dashboard.

---

## 16. Primary Engineering Principle

Do not spend day one building another control plane.

Build the execution plane:

```text
Read note → search web → reason with model → write note
```

Everything else is secondary until that loop works end to end.
