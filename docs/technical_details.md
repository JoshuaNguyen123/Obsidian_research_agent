# Technical Details

## Purpose

Agentic Researcher is a native Obsidian community plugin. It runs inside an Obsidian vault as a right-side assistant, not as a standalone web app or external service.

The core product flow is:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

The implementation favors a small native surface, real Obsidian vault APIs, bounded model/tool execution, append-first note writing, and visible receipts for every write.

## Technical Choices

- Language and runtime: TypeScript compiled into a single Obsidian plugin bundle, with `main.ts` as the plugin entrypoint and `main.js` as the generated build artifact.
- UI: native Obsidian `ItemView`, vanilla DOM APIs, and `styles.css`. The project intentionally does not use React, Vue, Svelte, Next.js, Express, FastAPI, LangChain, vector databases, or a backend service.
- Model API: an Ollama-compatible chat client, with configurable API key, base URL, model, timeout, sampling options, thinking mode, and streaming behavior.
- Vault access: Obsidian `app.vault` and `app.workspace` APIs only. Tools use vault-relative paths and reject unsafe paths before any vault operation.
- Testing: Node's built-in test runner for unit tests, TypeScript build checks through `npm run build`, and Playwright for Obsidian desktop e2e coverage.
- Local test deployment: `npm run sync:test-vault` copies only `main.js`, `styles.css`, and `manifest.json` into the live test vault plugin folder. It never overwrites `data.json`.

## Runtime Architecture

`main.ts` owns plugin lifecycle. On load it reads persisted settings and chat history, registers the `agentic-researcher-view`, adds the ribbon icon, adds the `Open Agentic Researcher` command, and registers the settings tab.

`src/AgentView.ts` owns the right-side UI. It renders two tabs:

- `Chat`: persistent chat transcript, mission textarea, `Run Mission`, `Clear chat`, and run status.
- `Run Details`: model config, status stream, planning stream, final answer stream, tool timeline, receipts, metrics, and trace rows. Each section has a stable CSS class so compact Obsidian side panels can stack and wrap diagnostic content without overlapping.

`src/AgentRunner.ts` owns the agent loop. It classifies mission intent, builds prompt context, selects allowed tools, optionally reads the current note first, calls the model, executes validated tool calls, returns tool results to the model, and stops on final answer, write completion, clarification, user stop, error, or step budget.

`src/model/OllamaClient.ts` owns request and response normalization for Ollama-compatible chat. It supports standard chat and streaming chat, validates response shapes, parses tool calls, maps provider errors into `ModelClientError`, and includes auth headers when configured.

`src/model/createModelClient.ts` wires the model client to Obsidian `requestUrl` for normal requests and a hybrid streaming transport for streaming responses. Streaming first tries `fetch`; on desktop it can fall back to Node `http` or `https`.

`src/tools/createToolRegistry.ts` combines vault tools and web tools into a `DefaultToolRegistry`. The registry exposes model tool definitions and executes only known tools.

`src/tools/vaultTools.ts` owns note and vault operations. It includes read, list, search, batch-read, word count, path info, create, append, replace, move, trash, retitle, section-edit, current-note append, current-note replace, and current-note delete behavior.

`src/tools/graphTools.ts` owns graph-aware note relationship tools. It reads Obsidian `metadataCache` when available, falls back to markdown parsing when needed, builds ephemeral note profiles from vault markdown files, ranks related notes with local heuristics, suggests wiki links, and performs controlled inline wiki-link insertion with backups.

`src/tools/wordCount.ts` owns markdown visible-text counting shared by `count_words` and generated draft verification. It strips frontmatter, fenced code blocks, inline code markers, and common markdown syntax before counting Unicode word tokens.

`src/tools/webTools.ts` owns `web_search` and `web_fetch`. These call the configured Ollama-compatible `/web_search` and `/web_fetch` endpoints and normalize compact source output for model consumption.

`src/conversationHistory.ts` owns persisted chat memory. It stores only user and assistant messages, trims by message count and character caps, and excludes status logs, traces, receipts, timings, errors, and hidden thinking.

## Agent Loop Flow

1. `AgentView` captures the mission prompt and appends the user chat message.
2. `AgentRunner` classifies the mission into chat-only, vault-context, note-output, explicit mutation, or explicit delete modes.
3. The runner builds runtime context including date/time, settings-derived model options, bounded chat history, current-note context when relevant, and allowed tool definitions.
4. If current-note observation is required, the runner executes `read_current_file` before the first model planning call.
5. The model receives the system prompt, mission context, optional current-note context, optional recent chat history, and exact available tool definitions.
6. The model may return tool calls. The plugin validates that each requested tool is allowed for the mission before execution.
7. Tool results are serialized and returned to the model for the next step.
8. Write tools stop the loop after a successful write and emit receipts. Chat-only runs stop on final answer. The loop also stops on clarification, user stop, error, or step budget.

For simple target-only current-note writes, the runner skips the planner loop. Prompts such as `In this note, write me a summary of the Vietnam War` do not need existing note content, vault search, web sources, graph context, or word-count verification, so `AgentRunner` removes `read_current_file`, emits `Using direct note writeback; no tool loop needed...`, and starts streaming append writeback directly. Prompts that ask to read, check, summarize, analyze, extract from, edit, replace, retitle, delete, or answer based on the current note still read the current note first. Prompts that require sources, citations, verification, vault context, graph relationships, specific files, or word-count checks still route through the relevant tool loop before drafting.

Some local or Ollama-compatible models respond with a tool request in assistant text instead of native `tool_calls`. `AgentRunner` recovers those known tool requests from normal fenced code blocks, escaped fenced code blocks such as `\`\`\`json`, inline JSON objects inside prose, and XML-ish `<requested_tool_call><name>...</name></requested_tool_call>` blocks. It normalizes root folder paths such as `/` to the vault root, stores the recovered call back into internal assistant history as a structured tool call, and then sends it through the same per-mission allow-list and tool execution path. This keeps the loop moving when the model writes `{ "name": "list_folder", "arguments": { "path": "/" } }` as text, while still rejecting tools that are not allowed for the current mission.

Current-note prompt extraction synchronizes with the visible markdown editor. When the user asks something like `Read the prompt on the page`, `AgentRunner` exposes `read_current_file`, reads the active note once, and then reclassifies the extracted note text as the active mission prompt for tool selection, diagnostics, relevance checks, and writeback mode. That initial read satisfies current-note context for the rest of the run, so `read_current_file` is removed from the reclassified tool list and the model is told to use the included note context instead of reading the same note again. If the page prompt asks for generated prose or markdown output, the runner treats it as note-output intent and can use streaming append writeback so the response appears below the prompt in the same note while also streaming in chat. If the extracted page prompt asks for sources, citations, verification, vault context, graph relationships, specific files, or word-count checks, the first model planning call is primed to request the relevant source/vault tools before streamed writeback can begin. This avoids both the slow opaque direct stream and the redundant read-current-note loop. Destructive operations still require explicit replace/delete wording.

Streamed note writeback buffers a model stream attempt until it can tell the output is normal content rather than a tool request. If the model emits known JSON/fenced/XML-ish tool-call markup during writeback, the runner emits a status line, displays nothing, writes nothing, and retries once with a stronger content-only instruction. If the retry is also a tool request or returns no writable content, the run fails cleanly and leaves the note unchanged. Genuine stream interruptions after content still preserve the existing partial-write receipt behavior.

The plugin tracks the last active markdown file from Obsidian `file-open` and `active-leaf-change` events. `ToolExecutionContext` exposes `getCurrentMarkdownFile` and `getCurrentMarkdownContent` so tools can resolve the visible editor even after focus moves into the right-side assistant pane. `read_current_file` prefers live editor text when available, then falls back to the vault cache.

`AgentView` owns run cancellation. While a run is active, the primary button changes from `Run Mission` to `Stop Mission`. Clicking it aborts the run's `AbortController`, records a stop request in the status stream, and leaves the button in a temporary `Stopping...` state until the runner returns.

Short follow-up prompts are resolved before tool selection when recent chat clearly points at a pending tool workflow. If the prior assistant message said it would read the current note and the user replies `Continue` or `read it`, `AgentRunner` routes the turn as `Read the current note.` for tool selection while keeping the user's actual text in chat history. If the recent chat contains vault traversal context or a pending vault tool request, prompts such as `Continue` or `Keep going` route as a continuation of the prior vault exploration, so folder and file inspection tools stay available. Final-answer relevance checks use this resolved intent instead of the literal words `keep going`, which prevents valid continuation answers from being incorrectly stopped as off-topic.

The abort signal is passed from `AgentView` to `AgentRunner`, then into model chat and streaming requests. The runner checks the signal before each model, tool, final-answer, and writeback step so a stopped run does not continue into another autonomous action. The Ollama transport also receives the signal; streaming fetch and desktop Node streaming can be interrupted directly, while Obsidian `requestUrl` is raced against the signal so the UI can stop waiting even if the underlying platform request cannot be cancelled.

Model/API waits are intentionally long enough for slow local or cloud models. The default `requestTimeoutMs` is `180000` milliseconds (3 minutes), and the plugin migrates the old 60-second default to the new value in memory. While a model chat or streaming request is pending, the runner emits `Still waiting...` status lines every 30 seconds so `Run Details` shows progress during long responses. High thinking modes and very large cloud models can still delay the first token; source/citation prompt-on-page runs are routed into visible tool steps before writeback so the user sees earlier progress and the model gets source context before drafting.

Plain static generation prompts such as "write a 500 word essay" are chat-first. They do not write to the active note unless the user explicitly asks to append, save, write, update, or insert into a note, file, markdown, or vault target.

Generated drafts with explicit word targets get one internal verification pass. Exact prompts such as `exactly 300 words` require the exact count. Non-exact prompts such as `300 word essay` accept a 10 percent tolerance. Chat-only drafts are counted before display when possible; prompt-on-page writeback counts only generated output, not the prompt already in the note, before writing. If the count is outside the target, the runner asks the model for one content-only correction without high thinking mode and reports the final count in Run Details.

Graph and related-note questions are search-first. Read-only graph prompts expose `get_note_graph_context`, `find_related_notes`, and `suggest_note_links`; explicit connect/link prompts may also expose `link_related_notes_in_current_file`. The graph layer distinguishes explicit Obsidian graph connections from inferred semantic relationships. Explicit relationships come from resolved links, backlinks, and unresolved links in Obsidian metadata. Semantic relationships are inferred locally from titles, aliases, tags, headings, shared graph neighbors, and content-term overlap. The implementation does not use embeddings, a vector database, a backend service, or a persisted semantic index.

English user missions are English-first. The runner adds a per-run response language policy that defaults English prompts to English output and tells the model not to switch into Chinese, translated programming problems, or unrelated templates unless the user explicitly asks for that. Final-answer and streaming writeback prompts repeat this constraint so both chat answers and raw markdown writes follow the same rule.

Final-answer streaming also has an early relevance gate. `AgentRunner` extracts meaningful topic anchors from the current mission, buffers the first answer text, and releases it only after the output overlaps the mission topic. If enough early output arrives without semantic overlap, the runner throws an `invalid_response` model error, emits `Stopped model output because it drifted off topic from the current mission.`, and does not display or persist the unrelated assistant text. The guard is intentionally disabled for prompts without at least two meaningful anchors so generic note commands are not blocked by short answers.

Important limits live in `src/tools/constants.ts`:

- `MAX_AGENT_STEPS = 6`
- `MAX_FILE_READ_CHARS = 12000`
- `MAX_INITIAL_CURRENT_NOTE_CHARS = 6000`
- `MAX_TOOL_RESULT_CHARS = 8000`
- `MAX_LISTED_FILES = 300`
- `MAX_BATCH_READ_FILES = 20`
- `MAX_BATCH_READ_CHARS_PER_FILE = 6000`
- `MAX_SEARCH_RESULTS = 30`
- `MAX_WEB_RESULTS = 10`
- `MAX_WEB_FETCH_CHARS = 6000`

## Tool Selection And Safety

The model can plan, but the plugin executes. The model never directly mutates the vault.

Allowed tools are filtered per mission. For example:

- Target-only current-note append prompts can skip `read_current_file` and stream writeback directly.
- Current-note prompts that depend on existing note content expose `read_current_file` and the relevant read/write tools.
- Vault-context questions expose read-only traversal/search tools and do not expose write tools unless the user also asks to save or write.
- Graph connection questions expose graph/read tools first and do not expose the inline link writer unless the user explicitly asks to connect or link notes.
- Word-count and length-check questions expose `count_words`, which returns count metadata only and never returns note content.
- Web tools are exposed only for web, current, latest, source, citation, research, or verification intent.
- Replace, edit, retitle, move, create, and delete tools require explicit intent.
- Inline related-note linking requires explicit connect/link wording and creates a backup before inserting wiki links.
- Plain essay/article/summary drafting remains chat-only unless the prompt contains explicit persistence intent.

Vault path safety is centralized in `src/tools/validation.ts`. Unsafe paths are rejected before vault access:

- parent traversal with `..`
- absolute paths
- Windows drive paths
- backslashes
- empty/current-directory segments
- blocked system roots such as `.obsidian`, `.agent-backups`, `.trash`, and `trash`
- non-markdown targets for markdown-only tools

Write behavior is append-first. Replace and destructive operations require explicit user intent and backup or Obsidian-safe trash behavior. Replacements and section edits create backups in `.agent-backups/`. Hard delete is not a default capability.

Every write receipt includes the operation, path, relevant byte counts, affected count when applicable, and backup path when a backup is involved.

Inline graph-link receipts include the current note path, operation `link_related_notes`, backup path, inserted links, skipped suggestions, and byte counts. The writer skips frontmatter, fenced code blocks, inline code, existing markdown links, and existing wiki links.

## Settings And Persistence

Plugin settings are stored through Obsidian plugin data:

- `ollamaApiKey`
- `ollamaBaseUrl`
- `model`
- `enableStreaming`
- `requestTimeoutMs`
- `thinkingMode`
- `streamWritebackMode`
- `temperature`
- `topK`
- `topP`
- `numCtx`

The same data file also stores bounded `conversationHistory`. Only user and assistant chat messages are persisted. Operational details are intentionally excluded so future model prompts do not learn from status logs or tool traces.

`Clear chat` clears only persisted chat memory. It does not modify notes, backups, receipts, settings, or vault files.

## UI And Receipts

The UI is intentionally prompt-first. `Chat` is the default surface and `Run Mission` is the primary action. The mission form uses a native submit button plus an explicit click handler, and the textarea stops Obsidian hotkey propagation so text entry stays focused inside the assistant pane. Pressing `Enter` submits the mission; `Shift+Enter` inserts a newline. `Clear chat` clears only persisted conversation memory, stops its pointer/key events from bubbling into Obsidian, and returns focus to the prompt after the confirmation dialog closes. During an active run, the primary button becomes `Stop Mission` so cancellation stays in the main workflow. Details are grouped in `Run Details` so the main workflow stays small.

The view emits and renders:

- status lines for run progress
- phase and activity metrics
- model configuration diagnostics
- planning and final-answer streams
- tool timeline rows with success/error state
- write receipts
- trace rows for intent, allowed tools, model calls, tool starts/results, receipts, metrics, phases, and completion

Model Config reports context with separate terms:

- `context_scope`: `none`, `current_note`, `vault`, or `vault_and_current_note`
- `vault_question`: whether the mission was classified as a vault-wide context question
- `current_note_context`: whether the runner planned to read the active note before model planning

This distinction matters because a note-output mission can use current-note context even when it is not a vault-wide question.

The visual style is green-on-black terminal-like styling unless a future change explicitly redesigns it.

Assistant content is sanitized before it is rendered or streamed into note writes. The sanitizer strips common provider special tokens such as `<|begin_of_sentence|>` and tokenizer variants using fullwidth separators or sentencepiece underscores, including `<｜begin▁of▁sentence｜>`.

## Build, Sync, And Test Workflow

Development commands:

```bash
npm test
npm run build
npm run dev
```

E2E commands:

```bash
npm run sync:test-vault
npm run test:e2e
npm run test:e2e:headed
```

`npm run test:e2e` performs a production build, syncs plugin artifacts into the live test vault, and runs Playwright.

The e2e harness:

- requires Obsidian to be closed before it starts
- temporarily enables `agentic-researcher` in `community-plugins.json` and restores the original file afterward
- launches Obsidian with a remote debugging port
- connects Playwright over CDP
- opens the live test vault
- creates a unique markdown note under `E2E Agent Tests/`
- patches the plugin's model client in memory for deterministic output
- disables persistence writes in memory so `data.json` stays unchanged
- runs an append mission through the real UI
- verifies the note content, tool timeline, append receipt, run log, and unchanged `data.json`

Default e2e environment values:

```text
OBSIDIAN_EXE=%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe
OBSIDIAN_VAULT=%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai
OBSIDIAN_CDP_PORT=11223
```

After code, UI, CSS, build, or plugin-behavior changes, build and sync the current artifacts into:

```text
%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai\.obsidian\plugins\agentic-researcher
```

Only copy:

```text
main.js
styles.css
manifest.json
```

Do not overwrite `data.json`.

## Extension Guidance

Prefer extending the existing loop and tool registry over adding new subsystems. New capabilities should answer these questions before implementation:

- Which mission intent exposes the capability?
- Which tool contract or UI event needs to change?
- What exact vault paths or note scopes can it touch?
- What receipt or trace proves what happened?
- What caps or safety checks prevent broad autonomous mutation?
- Which unit tests and e2e assertions prove the behavior?

Update this document when those answers change.
