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

`main.ts` owns plugin lifecycle. On load it reads persisted settings, bounded chat history, and the research-memory index, registers the `agentic-researcher-view`, adds the ribbon icon, adds the `Open Agentic Researcher` command, and registers the settings tab.

`src/AgentView.ts` owns the right-side UI. It renders two tabs:

- `Chat`: persistent chat transcript, mission textarea, `Run Mission`, `Clear chat`, and run status.
- `Run Details`: model config, status stream, planning stream, final answer stream, tool timeline, receipts, verification summaries, HTML preview, metrics, and trace rows. Each section has a stable CSS class so compact Obsidian side panels can stack and wrap diagnostic content without overlapping.

`src/AgentRunner.ts` owns the agent loop. It classifies mission intent, builds prompt context, selects allowed tools, optionally reads the current note first, calls the model, executes validated tool calls, returns tool results to the model, and stops on final answer, write completion, clarification, user stop, error, or step budget.

`src/agent/generatedOutputPolicy.ts`, `src/agent/currentNoteResetPolicy.ts`, `src/agent/loopPlanner.ts`, `src/agent/loopDecision.ts`, and `src/agent/projectMemory.ts` hold the pure policy logic that used to live as broad runner regex branches. They classify generated writing/diagram prompts, distinguish delete-only from clear-then-write requests, allocate adaptive tool/finalization budgets, decide whether the loop should continue or force final synthesis, and resolve project-local memory paths beside the active note.

`src/agent/missionScope.ts`, `src/agent/missionLedger.ts`, `src/agent/missionEvidence.ts`, and `src/agent/missionResume.ts` own the new explicit autonomy layer. Mission scope is derived during classification and tightens the existing tool allow-list without exposing any tools that routing would otherwise block. The ledger module writes a human-readable `Agent Runs/<runId>.md` record with one machine-readable fenced JSON block, evidence and receipt ids, blockers, next actions, route, and loop budget. Evidence conversion turns successful source/vault/artifact tool results and write receipts into compact resumable records. Resume loading accepts `continue run <runId>` and falls back to the latest ledger for generic continue/resume prompts.

`src/languageGuard.ts` owns the hard English-only inspection layer. It detects CJK characters with `[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]`, ignores URL text during inspection, exposes an assertion helper for final output, and builds the deterministic repair prompt used when a buffered answer needs to be rewritten in English before display.

`src/model/OllamaClient.ts` owns request and response normalization for Ollama-compatible chat. It supports standard chat and streaming chat, validates response shapes, parses tool calls, maps provider errors into `ModelClientError`, and includes auth headers when configured.

`src/model/createModelClient.ts` wires the model client to Obsidian `requestUrl` for normal requests and a hybrid streaming transport for streaming responses. Streaming first tries `fetch`; on desktop it can fall back to Node `http` or `https`.

`src/tools/createToolRegistry.ts` combines vault tools, vault-index tools, semantic search tools, web tools, source-opening tools, code tools, and design tools into a `DefaultToolRegistry`. The registry exposes model tool definitions and executes only known tools.

`src/tools/vaultTools.ts` owns note and vault operations. It includes read, list, search, batch-read, compound vault inspection, word count, path info, create, append, replace, move, trash, retitle, section-edit, section-append, current-note append, current-note replace, current-note delete, and durable research-memory behavior. `inspect_vault_context` is the compound read tool for bounded folder-content questions; it uses Obsidian vault APIs, reads markdown files only, excludes blocked/system paths, supports `other_folders`, `all_vault`, and `current_folder` scopes, defaults to 12 files and 1200 characters per file, prioritizes recently modified markdown files before applying the cap for named target folders, and returns active-file metadata, folder summaries, selected files, bounded file contents, skipped entries, truncation flags, and applied limits.

Vault content search is local and ranked before truncation. `search_markdown_files` scores path/title exact matches, path/title term matches, exact phrase matches, and content-term overlap, then returns the best `MAX_SEARCH_RESULTS` results with scores and reasons. It does not use embeddings, ChromaDB, a backend, or a persisted index.

`src/tools/semanticSearchTools.ts` owns `semantic_search_notes`, the read-only conceptual vault search tool. It is exposed for prompts such as `What do my notes say about MCP?`, theme/concept searches, and related-note questions where exact wording may differ. The tool reads markdown only through Obsidian vault APIs, rejects unsafe folders through the same vault-relative path policy, skips system roots, chunks notes by headings and paragraphs, and defaults to 300/500/700 token min/target/max chunks with 80-token overlap. In production, `main.ts` injects `createPythonFastEmbedProvider` through `ToolExecutionContext.semanticEmbeddingProvider`; tests and e2e can inject deterministic providers. The provider runs an on-demand local Python helper with JSON over stdin/stdout, no shell interpolation, a timeout, and bounded stdout/stderr. The helper uses FastEmbed `TextEmbedding` with `nomic-ai/nomic-embed-text-v1.5-Q`, prefixes documents as `search_document:` and queries as `search_query:`, downloads/verifies the model on first initialization, applies Matryoshka truncation to 512 dimensions by default, and returns plain float vectors only to the plugin. The model never sees vectors. Tool output is compact and citation-ready: path, title, score, semanticScore, lexicalScore, reasons, heading, and bounded snippet. If Python, FastEmbed, or model download fails, the tool reports `fallbackUsed: true` and falls back to lexical/title/tag/path scoring instead of failing the mission. There is no vector database, HTTP embedding service, background daemon, or persisted semantic index.

Template behavior also lives in `src/tools/vaultTools.ts`. Reusable templates are normal markdown files in the configured template folder, defaulting to `Templates`, and use plain `{{field}}` placeholders. The tools can list saved templates, read a saved template, create a reusable template, or fill either a saved template or ad hoc template text into a newly created markdown note. `seed_default_templates` can create the built-in starter templates for research briefs, research notes, Linear tickets, experiment logs, essay sections, and design briefs, but it is exposed only for explicit create/seed/default-template intent and skips existing files instead of overwriting them.

Research memory also lives in `src/tools/vaultTools.ts`. `append_research_memory` writes durable topic memory as markdown under the active-note project folder, defaulting to `Agent Memory/Research`, and updates the project-local memory index with topic, path, keywords, and last-updated time. `read_research_memory` reads a topic note by slug/index entry, and `search_research_memory` ranks the index by topic/keyword overlap and returns bounded excerpts from matching memory notes. The markdown note is the source of truth; the JSON index is only the recall map.

`src/tools/graphTools.ts` owns graph-aware note relationship tools. It reads Obsidian `metadataCache` when available, falls back to markdown parsing when needed, builds ephemeral note profiles from vault markdown files, ranks related notes with local heuristics, suggests wiki links, and performs controlled inline wiki-link insertion with backups.

`src/tools/wordCount.ts` owns markdown visible-text counting shared by `count_words` and generated draft verification. It strips frontmatter, fenced code blocks, inline code markers, and common markdown syntax before counting Unicode word tokens.

`src/tools/webTools.ts` owns `web_search` and `web_fetch`. These call the configured Ollama-compatible `/web_search` and `/web_fetch` endpoints and normalize compact source output for model consumption.

`src/tools/webViewerTools.ts` owns `open_web_source`. It requires explicit open/view/source intent, accepts only HTTP/HTTPS URLs without credentials, creates or updates a markdown source note under `Agent Sources/`, and then best-effort calls `window.open`. It does not claim to automate Obsidian Web Viewer; Obsidian and user settings decide where the URL opens.

`src/tools/codeTools.ts` owns explicit desktop-only code execution and HTML preview. `run_code_block` requires run/execute/compile/test intent and a desktop Obsidian runtime before lazily importing Node builtins. It supports Python, JavaScript, TypeScript, HTML preview metadata, and C/C++ compile-run when the corresponding local runtime/compiler exists. `render_html_preview` requires preview/render intent and returns a complete sandboxed `srcdoc` document for the UI preview pane. Runtime errors, missing language runtimes, nonzero exits, stdout/stderr, timeouts, and duration metadata are returned to the model instead of being hidden.

`src/ui/htmlPreview.ts` owns sandboxed preview document creation and iframe rendering. The iframe sandbox string is intentionally empty, and the generated preview document includes a Content Security Policy that disables scripts and network connections while allowing inline styles and ordinary image/media/font URLs.

`src/design/jsonCanvas.ts`, `src/design/layout.ts`, and `src/design/svgDesign.ts` own native design artifact generation. JSON Canvas helpers validate `.canvas` files against Obsidian-compatible node and edge structure, including ids, node geometry, node types, link URLs, and edge references. Layout helpers can build simple row, column, or grid canvases from model-provided items and include a title node when the model supplies a canvas title. SVG helpers render escaped wireframe shapes without scripts, event handlers, or `javascript:` URLs.

`src/tools/designTools.ts` owns `create_design_canvas` and `create_svg_design`. Both require explicit draw/design/canvas/diagram/wireframe/SVG intent, reject existing output paths, create parent folders only when requested or by default, write through Obsidian vault APIs, read the artifact back, verify it, optionally open it in Obsidian, and return path, byte count, and node/edge or shape counts.

`src/tools/vaultIndexTools.ts` owns `inspect_vault_index`. It wraps `src/memory/vaultIndex.ts`, which builds a metadata-only index from Obsidian files and metadata cache. The tool returns paths, basenames, extensions, mtimes, headings, tags, and links; it does not read note bodies. This gives the model a notebook map without exploding prompt context.

`src/agent/checkpoints.ts` owns legacy visible markdown checkpoints under `Agent Runs/<runId>.md`. The runner appends checkpoint entries every five model/tool steps, immediately before a final answer for long runs when due, and on budget stop when vault access is available. Checkpoints include run id, step, max steps, route, slow-path reason, tool names, and timestamp so long missions leave durable, sync-friendly progress notes.

Mission ledgers now live in the same `Agent Runs/<runId>.md` file. `AgentRunner` creates the ledger after `RunPlan` and `LoopBudgetPlan` exist, then updates it after tool successes, write receipts, blockers, user stop, completion, and budget stops. The markdown stays readable through a Mission Summary section, while the fenced JSON block is the parseable resume source. A prompt such as `continue run run-123` loads that specific ledger as transient system context with incomplete tasks, evidence summaries, blockers, and next actions. Generic `continue`, `keep going`, or `resume` still falls back to the latest ledger/checkpoint. None of this resume text is persisted into chat history.

`src/memory/contextCompaction.ts` owns prompt-time chat compaction. Persisted chat history remains normal user/assistant messages, but before prompt assembly the runner keeps recent messages exactly and summarizes older messages into a deterministic compact system context. The summary is not persisted as assistant memory.

`src/agent/verification.ts` owns verification helpers for generated artifacts and previews: JSON Canvas parsing/validation, SVG safety and shape counts, code request validation, HTML preview document/sandbox checks, and source-note checks.

`src/conversationHistory.ts` owns persisted chat memory. It stores only user and assistant messages, trims by message count and character caps, and excludes status logs, traces, receipts, timings, errors, and hidden thinking.

## Agent Loop Flow

1. `AgentView` captures the mission prompt and appends the user chat message.
2. `AgentRunner` classifies the mission into chat-only, vault-context, note-output, explicit mutation, or explicit delete modes, and derives an `AutonomyScope` for read, write, and destructive permissions.
3. The runner builds runtime context including date/time, settings-derived model options, bounded chat history, current-note context when relevant, and tool definitions filtered by routing plus scope.
4. If current-note observation is required, the runner executes `read_current_file` before the first model planning call.
5. After route and loop budget planning, the runner creates a mission ledger under `Agent Runs/<runId>.md` when vault APIs are available.
6. The model receives the system prompt, mission context, scope summary, optional current-note context, optional resume context, optional recent chat history, and exact available tool definitions.
7. The model may return tool calls. The plugin validates that each requested tool is allowed for the mission before execution.
8. Tool results are serialized and returned to the model for the next step; successful source/vault/artifact results are also compacted into ledger evidence when possible.
9. Write tools stop the loop after a successful write, emit receipts, and add receipt evidence to the ledger. Chat-only runs stop on final answer. The loop also stops on clarification, user stop, error, or step budget.

Each mission gets a `RunPlan` before the loop starts. The run plan records `route`, `maxStepsForRun`, `slowPathReason`, `expectedTimeClass`, `thinking`, `allowedTools`, and whether the English guard is required. `MAX_AGENT_STEPS = 30` is the hard safety ceiling, and the persisted `maxAgentSteps` setting lets the user set a lower or equal autonomous loop cap. The runner then derives a `LoopBudgetPlan` from `src/agent/loopPlanner.ts`: generated sourced essays get a small source-tool budget plus one reserved finalization pass, direct writeback gets one synthesis pass, artifact prompts get only the tool room they need, and ordinary chat answers use a short one-or-two-step path. Planning output includes `tool_budget=...` and `finalization_reserved=1` so Run Details shows the adaptive budget instead of only the hard cap. The mission ledger stores the same budget fields plus expected tools so resume can tell whether the previous run was still gathering evidence or ready to synthesize. Explicit design, code execution, HTML preview, and source-opening prompts route as artifact-like grounded workflows so the model has room to plan, call tools, verify outputs, and summarize. The `prefetched_vault_answer` route handles simple folder-content questions by running `inspect_vault_context` locally first, then making a single model call with `think` omitted and no model-visible tools. The `prefetched_vault_writeback` route uses the same local prefetch, then streams the synthesized markdown through current-note append writeback with no model-visible tools. Thinking is route-specific: quick local/direct/prefetched paths disable thinking, while grounded workflows and prompts such as `deep research`, `in-depth research`, and `deep dive` use the settings-derived thinking mode when the selected model supports it.

During model/tool loops, `AgentRunner` maintains a transient `LoopLedger` with successful tools, failed tools, repeated tool calls, whether required tools are satisfied, whether a finalization pass is reserved, and whether a write completed. It also maintains mission operation goals keyed by concrete capabilities: read current note, web search, web fetch, current-note title, current-note content, current-note replace, section edit, path create, path append, path replace, path move, path delete, and current-note delete. Model-requested and runner-owned tool calls go through the same observed execution path so tool start/done events, metrics, serialized tool messages, receipts, ledger evidence, and operation-goal status are recorded consistently. A write-like tool no longer completes the run by itself; the runner only stops after every requested operation goal is either not requested or done. This lets a single mission retitle a note and then write content, or create/update/delete multiple explicit paths without stopping after the first mutation.

`src/agent/loopDecision.ts` lets the runner own loop control: once required web/vault/design tools are satisfied, the runner removes tools and forces a final no-tool synthesis/writeback; if the same tool call repeats without progress, the runner gives one corrective prompt and then stops instead of burning all remaining steps. Source/citation/verification prompts require `web_search` and at least one `web_fetch` when `web_fetch` is available; simpler web-search summary prompts may finish after search context. If the model answers too early after the corrective prompt, `AgentRunner` can perform a deterministic read-only fallback: build a compact query from the mission, run `web_search`, fetch the first safe HTTP/HTTPS result with `web_fetch`, append both tool results to the model messages, and then force no-tool final synthesis or streamed note writeback. The fallback is limited to web read tools; the runner does not auto-create, replace, move, or delete vault content without explicit user intent and validated tool routing. Vault traversal prompts keep the existing map/select/read policy: map folders or markdown files, select likely notes, then read content before synthesizing. This prevents source prompts from ending with `Stopped at safety limit` after the last `web_fetch` when enough context has already been gathered.

Long grounded loops emit live planning updates through `onPlanningStart`, `onPlanningDelta`, and `onPlanningDone`. The delta shows only observable routing metadata such as `Step 4/30`, `route=grounded_workflow`, `reason=needs_web_sources`, and the allowed tool names. Hidden model thinking is still discarded by `AgentView` and is not displayed or persisted. Runs that reach step 15 emit a long-run status warning. Runs checkpoint every five steps through `src/agent/checkpoints.ts`; if the run stops at the budget limit, the runner forces a final budget checkpoint so the partial progress is inspectable under `Agent Runs/`.

The model may ask one concise clarifying question when a mission is impossible, dangerous, destructive, missing required credentials, or lacks a required target/value that tools cannot discover. `AgentRunner` detects short clarifying-question answers, emits the assistant question normally, and completes the run with `clarifying_question` so the UI shows `Needs clarification`.

The runner creates one per-mission `AgentRuntimeCache` and passes it through `ToolExecutionContext`. It caches successful read-only tool results by stable tool name plus normalized arguments for `read_current_file`, `inspect_vault_context`, `inspect_vault_index`, `list_markdown_files`, `search_markdown_files`, `semantic_search_notes`, `read_markdown_files`, `read_file`, `count_words`, `web_fetch`, `get_note_graph_context`, `find_related_notes`, and `suggest_note_links`. Cache hits emit tool metrics with `cached=true` and do not call the registry again. `runtimeCache.semanticProfiles` stores per-run semantic chunk profiles keyed by path, mtime, size, model, dimension, and chunk settings; the vectors and chunks are discarded after the mission, so note/profile state does not leak between runs.

For simple target-only current-note writes, the runner skips the planner loop. Prompts such as `In this note, write me a summary of the Vietnam War` do not need existing note content, vault search, web sources, graph context, or word-count verification, so `AgentRunner` removes `read_current_file`, emits `Using direct note writeback; no tool loop needed...`, and starts streaming append writeback directly. Explicit phrases such as `stream it to the page`, `stream it to the note`, or `stream it to the current file` route to live current-note writeback before append-tool routing, so generated output is written through the streaming writer and the receipt reports `streamed: true`. While streaming writeback owns generated current-note content, `append_to_current_file` is suppressed so the model cannot append a full buffered answer instead of live note chunks. Prompts that ask to read, check, summarize, analyze, extract from, edit, replace, retitle, delete, insert below a heading, or answer based on the current note still read the current note first. Prompts that require sources, citations, verification, vault context, vault indexing, graph relationships, research memory, templates, specific files, code execution, HTML preview, source opening, design artifacts, or word-count checks still route through the relevant tool loop before drafting. Research-memory save prompts are excluded from current-note streaming writeback so they must use `append_research_memory` rather than being filtered as a visible final answer.

The current-note streaming writer keeps a short safety/topic/language buffer and then flushes live chunks with lower thresholds than the older bulk buffer. After the initial safety buffer, it flushes at roughly 120 characters or 150 ms, with a 75 ms timer, so provider token-sized chunks can appear in the editor before the run completes. If a generated markdown draft starts with a leading H1, the streaming writer consumes that prefix before append output is released. It updates the existing note title slot through `retitleNoteMarkdown` and streams only the remaining body, turning `# Untitled` plus a generated `# Essay Title` into a single top H1. This does not rename the file; filename rename remains a separate explicit move/rename operation.

Vault and folder content questions are guarded against chat-only refusals. Prompts such as `What do the other notes in the other folders say?` and `gather details from the other folders` route through `prefetched_vault_answer`: the runner calls `inspect_vault_context` with `scope: "other_folders"`, adds the JSON result as system context, tells the model to cite vault-relative paths, and sends no tools to the model. Named-folder traversal prompts such as `traverse the 3 folders named Untitled, Untitled 1 and Untitled 2` pass `targetFolders` to `inspect_vault_context`, which matches vault-relative folder paths or folder basenames, reads bounded markdown descendants, excludes the active prompt note, prioritizes recent files before the per-run cap, and reports matched/unmatched targets. When the extracted page prompt also asks to stream or write the findings onto the current page, `prefetched_vault_writeback` runs the same local inspection first and then streams the answer into the current note with an append receipt. The prefetched vault JSON is also included in the relevance anchors for the single answer/writeback call so source-derived terms are not falsely blocked as off-topic. Topic-search prompts such as `What do my notes say about MCP?` expose `semantic_search_notes` alongside the normal search/batch-read tools, and the system prompt tells the model to call semantic search first for conceptual vault questions while still preferring exact file/title/path tools for exact requests. Vault/folder routing wins over generic research verbs like `gather`, so those prompts do not expose web tools unless the user explicitly asks for web, sources, citations, latest/current outside information, or verification. If a grounded vault fallback is needed and the model tries to answer before any vault traversal tool has run, `AgentRunner` adds one corrective system message that tells it not to claim it cannot access the vault and to request a vault tool. If the next step still makes no tool progress, the run stops with a clear error and no vault files are changed instead of looping to the full step cap.

Some local or Ollama-compatible models respond with a tool request in assistant text instead of native `tool_calls`. `AgentRunner` recovers those known tool requests from normal fenced code blocks, escaped fenced code blocks such as `\`\`\`json`, inline JSON objects inside prose, and XML-ish `<requested_tool_call><name>...</name></requested_tool_call>` blocks. It normalizes root folder paths such as `/` to the vault root, stores the recovered call back into internal assistant history as a structured tool call, and then sends it through the same per-mission allow-list and tool execution path. This keeps the loop moving when the model writes `{ "name": "list_folder", "arguments": { "path": "/" } }` as text, while still rejecting tools that are not allowed for the current mission.

Current-note prompt extraction synchronizes with the visible markdown editor. When the user asks something like `Read the prompt on the page` or `Refer to the notes in the notepage as the prompt`, `AgentRunner` exposes `read_current_file`, reads the active note once, extracts only the active instruction block, and then reclassifies that extracted text as the active mission prompt for tool selection, diagnostics, relevance checks, and writeback mode. The extractor stops before generated-output headings such as `## Findings`, `## Results`, `## Sources`, `## Answer`, and generated story headings, so prior output remains note context instead of becoming the next instruction. `notepage` is treated as an active-note/page alias, but generic phrases such as `delete all the notes on the page` are not prompt-on-page triggers. That initial read satisfies current-note context for the rest of the run, so `read_current_file` is removed from the reclassified tool list and the model is told to use the included note context instead of reading the same note again. If the page prompt asks for generated prose or markdown output, the runner treats it as note-output intent and can use streaming append writeback so the response appears below the prompt in the same note while also streaming in chat. If the extracted page prompt asks for named-folder vault traversal plus current-page writeback, the runner uses deterministic `prefetched_vault_writeback` instead of asking the model to call vault tools. If the extracted page prompt asks for sources, citations, verification, broader vault context, graph relationships, specific files, or word-count checks, the first model planning call is primed to request the relevant source/vault tools before streamed writeback can begin. If the model refuses required read tools once, the runner gives one corrective prompt and then stops with a clear no-write error instead of looping through the full step budget. Destructive operations still require explicit replace/delete wording.

Streamed note writeback uses an early safety buffer, not full-response buffering. `AgentRunner` holds suspicious stream prefixes such as XML-ish tool requests, fenced JSON/tool blocks, and raw JSON long enough to decide whether they are tool calls. The same buffer also applies the final-answer topic/language gate before any chunk is emitted or written. For English prompts with clear semantic anchors, the stream must overlap the requested topic and must not drift into a primarily CJK response unless the user asked for that language. Short topic words such as `war` are treated as meaningful anchors, while workflow words such as `write`, `append`, `this`, `note`, `action`, and `item` are ignored. Code-generation prompts can release code-shaped output such as fenced `python` blocks even when the code does not repeat generic words like `solution` or `page`. After the first safe release, ordinary markdown and code chunks are written directly; only post-release chunks that look like raw JSON, tool-call fences, function/tool call markup, or XML-ish tool requests stay buffered. `finish()` flushes any remaining safe trailing buffer. The writer batches flushes by size and time, updates the visible active markdown editor first when `ToolExecutionContext.setCurrentMarkdownContent` can resolve it, then persists the same content through `vault.modify`. It also schedules a short delayed flush so small chunks still appear in the note while the model is running. If the model emits known JSON/fenced/XML-ish tool-call markup during writeback before content is written, the runner emits a status line, displays nothing, writes nothing, and retries once with a stronger content-only instruction. If writeback ends with an unclosed fenced code block or no writable content, the runner retries once with a complete-answer instruction. If an English run emits CJK before any note content is writable, the English-only guard blocks the chunk, emits a language-gate lifecycle status, discards non-writable buffered content, and retries once with the English-only repair instruction. If the retry is also a tool request, returns no writable content, or still fails the language guard, the run fails cleanly and leaves the note unchanged. Genuine stream interruptions after content still preserve the existing partial-write receipt behavior.

Streaming model calls emit lifecycle events through `AgentRunEvents.onStreamLifecycle`. The UI renders these as status lines so the user can tell whether the run is waiting for provider bytes, connected, receiving thinking, receiving answer text, buffering for safety, buffering for language, showing safe chat content, or writing safe content to the note. These statuses are intentionally separate from hidden model thinking; they describe observable transport and guard states.

The plugin tracks the last active markdown file from Obsidian `file-open` and `active-leaf-change` events. `ToolExecutionContext` exposes `getCurrentMarkdownFile`, `getCurrentMarkdownContent`, and `setCurrentMarkdownContent` so tools and streaming writeback can resolve or update the visible editor even after focus moves into the right-side assistant pane. `read_current_file` prefers live editor text when available, then falls back to the vault cache.

`AgentView` owns run cancellation. While a run is active, the primary button changes from `Run Mission` to `Stop Mission`. Clicking it aborts the run's `AbortController`, records a stop request in the status stream, and leaves the button in a temporary `Stopping...` state until the runner returns.

Follow-up prompts are resolved before tool selection when recent chat clearly points at a pending tool workflow or prior assistant content. If the prior assistant message said it would read the current note and the user replies `Continue` or `read it`, `AgentRunner` routes the turn as `Read the current note.` for tool selection while keeping the user's actual text in chat history. If the recent chat contains vault traversal context or a pending vault tool request, prompts such as `Continue` or `Keep going` route as a continuation of the prior vault exploration, so folder and file inspection tools stay available. If the prior assistant committed to revising, editing, expanding, improving, or rewriting the current essay/note and the user replies with a short approval such as `go ahead`, `do it`, or `go ahead and revise`, the runner resolves the turn to a whole-current-note revision intent before tool selection. That path reads the current note and uses replace-with-backup/streamed replace writeback instead of waiting for a named section heading. If the user asks to write, copy, save, paste, or put `this essay`, `this answer`, `this response`, or similar prior assistant content onto the page/document/note, the runner routes the turn as `Append the most recent assistant response from this chat to the current Obsidian note.` That disables direct streaming writeback for this case so the model must use the validated `append_to_current_file` tool and the existing write-required correction path can recover from copy/paste-only replies. Final-answer relevance checks use the resolved intent and, for context-dependent follow-ups such as `my favorite things`, `above`, `below`, or `continue`, also include the recent substantive assistant message and current-note context when available. This allows outputs grounded in prior facts such as Toyota, lion, and blue while preserving the off-topic guard for unrelated code/template drift.

The abort signal is passed from `AgentView` to `AgentRunner`, then into model chat and streaming requests. The runner checks the signal before each model, tool, final-answer, and writeback step so a stopped run does not continue into another autonomous action. The Ollama transport also receives the signal; streaming fetch and desktop Node streaming can be interrupted directly, while Obsidian `requestUrl` is raced against the signal so the UI can stop waiting even if the underlying platform request cannot be cancelled.

Model/API waits are intentionally long enough for slow local or cloud models. The default `requestTimeoutMs` is `180000` milliseconds (3 minutes), and the plugin migrates the old 60-second default to the new value in memory. While a model chat or streaming request is pending, the runner emits `Still waiting...` status lines every 30 seconds so `Run Details` shows progress during long responses. High thinking modes and very large cloud models can still delay the first token; source/citation prompt-on-page runs are routed into visible tool steps before writeback so the user sees earlier progress and the model gets source context before drafting.

Generated-output prompts are note-first when an active markdown note exists. `analyzeGeneratedOutputPrompt` classifies essays, how-tos, explanations, diagrams, and general prompts; essays/how-tos/explanations default to current-note append, clear/delete-plus-write wording defaults to current-note replace with backup, and diagram prompts default to native JSON Canvas unless the user explicitly asks for SVG. If no current markdown note is available and the prompt does not name a note/page/path target, the runner falls back to chat-only instead of failing a write tool. Web research prompts remain answer-only when the generated policy resolves to `chat_only`; otherwise citation/source prompts use `web_search` and optionally `web_fetch`, then force a no-tool final writeback after source context is gathered. Web intent treats standalone chat-history words such as `most recent assistant response` differently from current-facts recency; `recent/latest/current` requires a current-information noun such as news, version, facts, reports, or papers before it forces web tools. In this plugin, `page` and `document` are treated as aliases for the active Obsidian markdown note.

Generated drafts with explicit word targets get one internal verification pass. Exact prompts such as `exactly 300 words` require the exact count. Non-exact prompts such as `300 word essay` accept a 10 percent tolerance. The runner carries the generated word target as system context so the check still works after prompt-on-page extraction or sourced-tool finalization. Chat-only drafts are counted before display when possible; prompt-on-page writeback counts only generated output, not the prompt already in the note. Streaming writeback still streams the first safe draft live; if the count is outside the target, the runner asks the model for one content-only correction without high thinking mode, replaces the streamed note region and live chat message with the corrected draft, and reports the final count in Run Details.

Graph and related-note questions are search-first. Read-only graph prompts expose `semantic_search_notes`, `get_note_graph_context`, `find_related_notes`, and `suggest_note_links`; explicit connect/link prompts may also expose `link_related_notes_in_current_file`. The graph layer distinguishes explicit Obsidian graph connections from inferred semantic relationships. Explicit relationships come from resolved links, backlinks, and unresolved links in Obsidian metadata. `find_related_notes` remains heuristic and infers local relationships from titles, aliases, tags, headings, shared graph neighbors, and content-term overlap. `semantic_search_notes` is the separate embedding-backed conceptual retrieval path; it is still read-only and does not create a vector database, backend service, or persisted semantic index.

Graph profile construction is cached inside the same per-run cache. Repeated graph or related-note tools reuse the same ephemeral profile map for the mission, including titles, aliases, tags, headings, outgoing links, backlinks, unresolved links, and local content terms. The profile map is not written to disk.

English user missions are English-first. The runner adds a per-run response language policy that defaults English prompts to English output and tells the model not to switch into Chinese, translated programming problems, or unrelated templates unless the user explicitly asks for that. Final-answer and streaming writeback prompts repeat this constraint so both chat answers and raw markdown writes follow the same rule. Buffered direct answers that contain CJK are repaired once with low-temperature settings before display. Streaming answers and writebacks are blocked before visible release if the CJK detector matches. URLs are allowed to remain unchanged.

Final-answer streaming also has an early relevance gate. `AgentRunner` extracts meaningful topic anchors from the current mission, buffers the first answer text, and releases it only after the output overlaps the mission topic or, for coding prompts, after the output is recognizably code. If enough early output arrives without semantic overlap, the runner throws an `invalid_response` model error, emits `Stopped model output because it drifted off topic from the current mission.`, and does not display or persist the unrelated assistant text. The guard is intentionally disabled for prompts without at least two meaningful anchors so generic note commands are not blocked by short answers.

Important limits live in `src/tools/constants.ts`:

- `MAX_AGENT_STEPS = 30`
- `CHECKPOINT_EVERY_STEPS = 5`
- `LONG_RUN_STEP_WARN_AT = 15`
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

- `AutonomyScope` is a tightening layer over the normal routing allow-list. It does not grant tools. Broad prompts such as `update my whole vault` without a current-note, file, folder, artifact, or research-memory target keep read/planning tools but remove write/delete surfaces and should produce a plan or concise clarification instead of a write receipt.
- Target-only current-note append prompts can skip `read_current_file` and stream writeback directly.
- `page` and `document` are active-note aliases for write/read intent; follow-up prompts that refer to recent assistant content use `append_to_current_file`.
- Current-note prompts that depend on existing note content expose `read_current_file` and the relevant read/write tools.
- Whole-note revision prompts such as `edit the essay`, `revise the paragraphs`, or short approvals after an assistant edit commitment expose current-note read context and route to current-note replacement with backup. Named heading/section prompts continue to use section-edit tools.
- Section-targeted prompts such as `below the Findings section` expose `append_to_current_section`, validate the heading, create a backup, insert before the next peer/parent heading, and suppress broad `append_to_current_file`.
- Vault-context questions expose read-only traversal/search tools and do not expose write tools unless the user also asks to save or write. Simple other-folder content questions use `inspect_vault_context` before the model call; broader vault searches use `search_markdown_files` and `read_markdown_files`.
- Conceptual vault questions expose `semantic_search_notes` as a read-only first search option. Exact path, title, heading, or filename requests still prefer `read_file`, `search_markdown_files`, `inspect_vault_index`, list tools, and explicit read tools. Delete, move, replace, and direct current-note write-only prompts do not expose semantic search.
- Vault map/index prompts expose `inspect_vault_index`, which returns metadata only and does not read note bodies.
- Research-memory prompts expose `search_research_memory` and `read_research_memory`; explicit save/remember/persist prompts expose `append_research_memory`.
- Graph connection questions expose graph/read tools first and do not expose the inline link writer unless the user explicitly asks to connect or link notes.
- Word-count and length-check questions expose `count_words`, which returns count metadata only and never returns note content.
- Template prompts expose `list_templates` and `read_template`; explicit template creation exposes `create_template`; explicit fill/use/apply template prompts expose `fill_template`.
- Generated essays, how-tos, and explanations use streamed current-note writeback by default when an active note exists. They do not expose `append_to_current_file` while streaming writeback owns the append/replace operation, so the model cannot fail by calling an absent append tool.
- The agent can chain explicit CRUD operations through validated tools. Read operations include current-note/file/vault/graph/count/web tools. Create operations include file, folder, template, and artifact tools. Write operations include current-note, section, path, and research-memory appends. Update operations include retitle, replace with backup, section edit, move/rename path, and related-note link insertion. Delete operations include `delete_current_file` and `delete_path` only for explicit delete intent; current-note destructive changes create backups and path deletes use Obsidian trash behavior.
- Web tools are exposed only for web, current, latest, source, citation, research, or verification intent. Standalone `recent` in chat-history phrases such as `most recent assistant response` does not trigger web. For web/source prompts, `AgentRunner` requires at least `web_search` before accepting a final answer. Source, citation, bibliography, source URL, and verification prompts also require at least one `web_fetch` when that tool is available so the final answer can cite a fetched page rather than only a search result snippet.
- `open_web_source` is exposed only for explicit open/view/show/launch source or URL intent. It writes a source note receipt and best-effort opens the URL; `web_search` and `web_fetch` remain the factual research path.
- `run_code_block` is exposed only for explicit run/execute/evaluate/test/compile code intent. It is desktop-only at execution time and lazily imports Node builtins only after intent and desktop checks pass.
- `render_html_preview` is exposed only for explicit preview/render/show HTML, CSS, web page, mockup, or prototype intent.
- `create_design_canvas` and `create_svg_design` are exposed only for explicit create/make/draw/generate/build/draft/render/save/write design intent. Generic design/diagram/map prompts default to JSON Canvas unless the prompt clearly asks for SVG, wireframe, mockup, screen, layout, or UI design.
- Replace, edit, retitle, move, create, and delete tools require explicit intent.
- Template filling creates a new markdown note by default and does not overwrite existing notes. If the model answers in chat for an explicit template fill/create request, the runner asks it to use the required template write tool.
- Design artifact requests are treated as explicit vault writes. If the model answers in chat without creating the requested Canvas or SVG, the runner asks it to use the required artifact write tool.
- Inline related-note linking requires explicit connect/link wording and creates a backup before inserting wiki links.
- Plain essay/article/summary drafting is chat-only only when there is no active note target or the prompt explicitly asks for chat-only output.

The runner also sends a compact tool-authority system message with each model-planning request. Tool names are categorized as `read`, `write`, `edit`, `delete`, `web`, or `code`, and the model is told to use the smallest valid sequence. The authority map is advisory prompt context; the plugin's allow-list, path validation, backups, and receipt checks remain the actual enforcement layer.

Vault path safety is centralized in `src/tools/validation.ts`. Unsafe paths are rejected before vault access:

- parent traversal with `..`
- absolute paths
- Windows drive paths
- backslashes
- empty/current-directory segments
- blocked system roots such as `.obsidian`, `.agent-backups`, `.trash`, and `trash`
- non-markdown targets for markdown-only tools

Write behavior is append-first. Replace and destructive operations require explicit user intent and backup or Obsidian-safe trash behavior. Replacements, section edits, and section-targeted insertions create backups in `.agent-backups/`; backup and generated parent-folder creation are idempotent and treat Obsidian's existing-folder race as success before writing the target file. `Delete all notes/content on the page and write...`, `keep the note but delete contents`, `start cleanly`, `clear it and write again`, and `edit over it` are interpreted as replace-current-page requests with backup, not as vault note deletion, so the note is not trashed before the generated output is written. `Delete this/current note` without a follow-up write routes to Obsidian-safe trash with backup. Hard delete is not a default capability.

Every write receipt includes the operation, path, relevant byte counts, affected count when applicable, and backup path when a backup is involved. The runner converts receipts into `receipt` evidence records in the mission ledger and stores the evidence ids in the ledger's `receipts` array. Run Details also labels receipt operations as `note_append`, `note_replace`, or `note_delete` where applicable.

Inline graph-link receipts include the current note path, operation `link_related_notes`, backup path, inserted links, skipped suggestions, and byte counts. The writer skips frontmatter, fenced code blocks, inline code, existing markdown links, and existing wiki links.

Template write receipts use the existing create receipt shape. `create_template` reports the template path, configured template folder, placeholder names, and bytes written. `fill_template` reports the created note path, whether the source was a saved template or ad hoc template text, the saved template path when applicable, placeholder names, applied value keys, and bytes written.

Source-opening and design tools also use write receipts. `open_web_source` reports the source note path, URL, open fallback, and bytes written. `create_design_canvas` reports the `.canvas` path, bytes written, node count, edge count, and open result. `create_svg_design` reports the `.svg` path, bytes written, shape count, and open result. Code execution does not write vault files by default, so stdout/stderr and exit metadata stay in the tool timeline and verification section rather than receipts.

## Settings And Persistence

Plugin settings are stored through Obsidian plugin data:

- `ollamaApiKey`
- `ollamaBaseUrl`
- `model`
- `enableStreaming`
- `requestTimeoutMs`
- `maxAgentSteps`
- `thinkingMode`
- `streamWritebackMode`
- `templateFolder`
- `templateOutputFolder`
- `researchMemoryEnabled`
- `researchMemoryFolder`
- `temperature`
- `topK`
- `topP`
- `numCtx`

Plugin data remains the settings fallback, but active project memory is also mirrored into vault files beside the active note. `getProjectMemoryLocation(activeFilePath)` resolves `<active-note-folder>/Agent Memory/conversation-history.json`, `<active-note-folder>/Agent Memory/research-memory-index.json`, and `<active-note-folder>/Agent Memory/Research/`. `main.ts` loads those JSON files when the active markdown file changes and saves bounded chat/research memory there after updates. Only user and assistant chat messages are persisted in chat history. Operational details are intentionally excluded so future model prompts do not learn from status logs or tool traces. Persisted chat caps are currently 60 messages, 16,000 characters per message, and 120,000 total characters. Before prompt assembly, `compactConversationForPrompt` keeps recent messages exactly under a prompt budget and summarizes older messages into a non-persisted compact context block. The research-memory index stores topic, path, keywords, and last-updated metadata for vault markdown notes under `Agent Memory/Research`; the markdown notes remain the durable source of truth.

Mission ledgers are not chat memory and do not live under `Agent Memory`. They are per-run operational records in `Agent Runs/<runId>.md`. When loaded for resume, only a transient system-context summary is injected into the current model request. That summary includes incomplete tasks, evidence summaries, blockers, and next actions, but it is not saved through `conversationHistory`.

`Clear chat` clears only persisted chat memory. It does not modify notes, backups, receipts, settings, vault files, research-memory markdown, run ledgers, or the research-memory index. `AgentView` uses an inline two-click confirmation (`Clear chat` then `Confirm clear`) instead of a native blocking popup, guards the action with `isClearingChat`, re-renders only the chat log, clears pending live assistant state, forces the chat tab active, clears any loader state, restores `running=false`, enables the textarea, removes `aria-disabled`, restores the run button state, and focuses the prompt immediately, on timeout, and on the next animation frame so a real mouse click can type a new mission immediately after clearing. This deliberate recovery focus moves the caret to the end only during programmatic restoration.

## UI And Receipts

The UI is intentionally prompt-first. `Chat` is the default surface and `Run Mission` is the primary action. The mission form uses a native submit button plus an explicit click handler, and the textarea stops Obsidian hotkey propagation so text entry stays focused inside the assistant pane. Textarea pointer, mouse down, and click events stop propagation but do not call the focus helper or set the selection range, so clicking inside a long prompt leaves the native caret at the clicked word. Programmatic focus restoration uses `focusPrompt({ moveCaretToEnd: true })` only after deliberate recovery paths such as clear-chat completion. The chat log and CRT loader sit below the form z-index, and the loader has `pointer-events: none`, so status elements cannot intercept prompt clicks. Pressing `Enter` submits the mission; `Shift+Enter` inserts a newline. `Clear chat` clears only persisted conversation memory, stops its pointer/key events from bubbling into Obsidian, changes to inline `Confirm clear` for five seconds, and returns focus to the prompt without opening an OS modal. During an active run, the primary button becomes `Stop Mission` so cancellation stays in the main workflow. The chat log also shows a non-persisted CRT-style loader strip at the bottom during runs; it mirrors current status, tool, and stream lifecycle text without becoming chat history. Details are grouped in `Run Details` so the main workflow stays small.

The view emits and renders:

- status lines for run progress
- phase and activity metrics
- model configuration diagnostics
- planning and final-answer streams
- tool timeline rows with success/error state
- write receipts
- verification rows for Canvas, SVG, code, HTML preview, and source-note artifacts
- sandboxed HTML previews when a tool returns `previewHtml`
- trace rows for intent, allowed tools, model calls, tool starts/results, receipts, metrics, phases, and completion

Model Config reports context with separate terms:

- `context_scope`: `none`, `current_note`, `vault`, or `vault_and_current_note`
- `vault_question`: whether the mission was classified as a vault-wide context question
- `current_note_context`: whether the runner planned to read the active note before model planning
- `note_writeback`: whether this run writes with a validated tool, streams directly to the current note, streams after prerequisite tools, or does not write
- `route`: the chosen `RunPlan` route, such as `instant_local`, `direct_writeback`, `prefetched_vault_answer`, `prefetched_vault_writeback`, `single_model_answer`, `tool_required`, or `grounded_workflow`
- `step_cap`: the route-specific loop cap for this run
- `slow_path`: the reason the run needs a slower path, such as web sources, vault context, graph context, word count, or edit/replace planning
- `english_guard`: whether the English-only guard is active for visible output

This distinction matters because a note-output mission can use current-note context even when it is not a vault-wide question.

The config event treats the run plan as authoritative for vault diagnostics. If `slow_path=needs_vault_context`, the UI reports `mission=vault_context_answer`, `vault_question=on`, and a vault-inclusive `context_scope` even for browse-style prompts that were not phrased as direct questions. This keeps `Model Config` aligned with the actual allowed tools and grounded workflow route.

The visual style is green-on-black terminal-like styling unless a future change explicitly redesigns it.

Stream lifecycle rows are labeled with stable diagnostic names such as `chat_stream` for first visible chat content and `note_stream` for first safe note write. Planning rows include `tool_budget` and `finalization_reserved`, and receipt metadata includes `note_append`, `note_replace`, or `note_delete` labels so the user can distinguish chat streaming, note streaming, append/replace/delete writes, and adaptive loop budgeting without reading raw tool payloads.

`Run Details` intentionally remains diagnostic rather than a control panel. The Model Config section includes run id, route, scope, writeback mode, usage counters, autonomy scope, and compact mission-ledger summary fields: status, evidence count, receipt count, expected tools, and next action. The Planning section is cleared at run start and receives live route/tool metadata for each step. The Tool timeline contains the raw expandable output/error payloads. The Receipts section is only for vault writes. The Verification section summarizes concrete artifact checks such as Canvas node/edge counts, SVG shape counts, HTML preview readiness, code exit status, and saved source-note paths. The Preview section is empty unless a tool result includes `previewHtml`, in which case `AgentView` renders the returned srcdoc directly into a sandboxed iframe.

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
- backs up `%APPDATA%\Obsidian\obsidian.json`, temporarily marks only the configured `OBSIDIAN_VAULT` as `open: true`, and restores the original file after Obsidian exits
- temporarily enables `agentic-researcher` in `community-plugins.json` and restores the original file afterward
- launches Obsidian with a remote debugging port and the configured `OBSIDIAN_VAULT` path as the only vault target
- connects Playwright over CDP
- does not use `obsidian://open`; the harness rejects the run if Obsidian opens any vault whose `app.vault.adapter.basePath` differs from `OBSIDIAN_VAULT`, or if more than one renderer opens for the expected vault
- creates a unique markdown note under `E2E Agent Tests/`
- patches the plugin's model client in memory for deterministic output
- seeds and restores `data.json` when testing persisted-chat clearing
- patches persistence writes in memory for deterministic assertions
- runs isolated Playwright scenarios for clear-chat prompt typing, append, prior-assistant writeback, streaming writeback, folder traversal, semantic note search, autonomous loop depths, checkpoint creation during long autonomous runs, prompt-on-page traversal, current-page replacement, explicit CRUD chaining, generated-output prompt matrix coverage, native Canvas/SVG design artifact creation, and research-memory save/clear/reload/recall through the real UI
- each mock scenario opens a fresh controlled Obsidian process, creates its own note/markers, installs and verifies the actual `playwright-e2e-mock` model client through `createModelClient()`, asserts the submitted prompt appears in the user log, and verifies Run Details used the mock model
- verifies the note content, tool timeline, 1/5/10/15/25/30-step autonomous loop completion, long-run checkpoint and ledger notes under `Agent Runs/`, append/replace/design receipts, backup receipt paths, full read/create/write/update/delete path-tool receipts, replacement backup contents, moved/deleted path absence, valid `.canvas`/`.svg` artifacts, run log, Run Mission click target, post-clear prompt typing, clicked-position prompt editing, streamed chat/note chunks, project-local memory JSON/markdown behavior, and restored `data.json`

`e2e/promptMatrix.ts` defines generated-output scenarios for short essays, 500-word drafts, 1000-word sourced drafts, text-level citation prompts, cast-iron steak instructions, diagonalization explanations, three-block diagrams, and delete-plus-write replacement. The Gilgamesh 500-word scenario is included in the opt-in real-AI smoke subset and checks the newly generated text, not just the full accumulated note, for at least 350 words plus core epic terms such as Gilgamesh, Enkidu, and mortality. The real-AI smoke run executes Gilgamesh first in a fresh note, then submits a follow-up prompt that explicitly requires the `count_words` tool before appending any other generated content. It then exercises additional live note generation, web/source work, and replace-write safety; the three-block canvas artifact remains in the deterministic mock matrix because live free-form artifact creation is provider-dependent. `e2e/aiHarness.ts` keeps normal e2e deterministic with the mock model and adds opt-in real-AI smoke coverage. Real-AI tests run only when `E2E_REAL_AI=1` and `E2E_AI_MODE=real` are set. The default real-AI model is `gpt-oss:120b-cloud`; `E2E_OLLAMA_API_KEY` can override credentials, but otherwise the browser-side harness preserves the plugin's saved Ollama API key. They use scenario-specific mission timeouts up to 900000 ms and Playwright test timeouts up to 1800000 ms, then wait on observable completion signals such as first streamed chat content, note terms, receipts, run-button recovery, source-tool rows, mock artifact files, `count_words` tool rows, and absence of `Stopped at safety limit` instead of relying on exact prose. Between real-AI prompt submissions, the harness waits `E2E_AI_CALL_PAUSE_MS` milliseconds, defaulting to 30000 ms, so slower agents have time to settle after long generations before the next e2e call starts.

Semantic e2e keeps the mock chat model by default, but `E2E_SEMANTIC_EMBEDDING_MODE=ollama` swaps the injected semantic embedding provider to local Ollama `/api/embed`. That provider prefixes inputs as `search_document:` and `search_query:`, uses `nomic-embed-text:v1.5` by default, applies the same normalize/truncate/renormalize step expected from the production FastEmbed provider, and the mock model fails the test if `semantic_search_notes` falls back to lexical mode.

Default e2e environment values:

```text
OBSIDIAN_EXE=%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe
OBSIDIAN_VAULT=%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai
OBSIDIAN_CDP_PORT=11223
E2E_REAL_AI=0
E2E_AI_MODE=mock
E2E_AI_MODEL=gpt-oss:120b-cloud
E2E_MISSION_TIMEOUT_MS=180000
E2E_AI_CALL_PAUSE_MS=30000
E2E_SEMANTIC_EMBEDDING_MODE=mock
E2E_SEMANTIC_EMBEDDING_MODEL=nomic-embed-text:v1.5
E2E_SEMANTIC_EMBEDDING_BASE_URL=http://127.0.0.1:11434
E2E_SEMANTIC_EMBEDDING_TIMEOUT_MS=120000
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
