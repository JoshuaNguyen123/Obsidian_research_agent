# AGENTS.md

## Project

Native Obsidian Agentic Researcher is an Obsidian community plugin. It is not a standalone web app. Keep it a native right-side Obsidian assistant that can:

```text
user mission -> read Obsidian context -> plan -> use approved tools -> write back to notes -> show receipts
```

Optimize for real execution inside Obsidian, not abstract control panels or simulation paths.

## Product Direction

- Keep the UI minimal and prompt-first: `Chat` as the main surface, `Run Mission` as the primary action, and details such as planning, tools, receipts, and diagnostics in `Run Details`.
- Preserve the current green-on-black terminal style unless the user asks for a redesign.
- The agent should decide intermediate steps, use tools, write useful note output, and report what happened.
- Prefer append-first behavior. Replace/overwrite requires explicit user intent and backup.
- Ask clarifying questions only when the mission is impossible, dangerous, destructive, or missing required credentials.

## Stack And Architecture

- Use the existing TypeScript, Obsidian Plugin API, vanilla DOM UI, CSS, npm build tooling, and Ollama-compatible client.
- Do not add React, Vue, Svelte, Next.js, Express, FastAPI, LangChain, vector databases, or backend services unless explicitly requested.
- Keep responsibilities separated:
  - `AgentView`: right-side UI, tabs, chat, progress display.
  - `AgentRunner`: agent loop, prompt assembly, step budget, model/tool orchestration.
  - `OllamaClient`: model API access and response parsing.
  - `tools/*`: vault, web, write, and validation behavior.
  - `conversationHistory`: persisted chat memory, capped and filtered.

## Technical Details Maintenance

- Treat `docs/technical_details.md` as the living technical architecture record.
- Update `docs/technical_details.md` in the same change when you alter architecture, agent loop flow, settings, tool contracts, vault safety policy, writeback behavior, model/API behavior, validation strategy, e2e harness behavior, build scripts, or deployment/sync workflow.
- Give details as interview ready answers to technical questions
- Keep the document implementation-grounded: describe actual files, runtime flow, safety checks, limits, and tradeoffs that exist in the repo.
- If a requested change intentionally diverges from the technical details document, update the document and briefly call out the change in the final response.

## Agent Loop

The model plans; the plugin executes. The model must never directly mutate the vault. It may request tool calls, and the plugin validates and runs them.

Core loop:

```text
1. Receive mission.
2. Gather current note/vault context when relevant.
3. Send prompt, bounded chat history, context, and tool definitions to the model.
4. Execute validated tool calls.
5. Return tool results to the model.
6. Stop on final answer, write completion, clarification, user stop, off-topic model output, error, or step budget.
```

Keep `MAX_AGENT_STEPS` and other caps meaningful. Avoid broad autonomous mutations until single-note writeback is reliable.

## Tool And Vault Safety

- Use vault-relative paths and Obsidian vault APIs for vault work.
- Reject unsafe paths: `..`, absolute paths, Windows drive paths, backslashes, system folders, and non-markdown files for markdown-only tools.
- Initial/default tools should remain focused on real note work:
  - `read_current_file`
  - `list_markdown_files`
  - `read_file`
  - `web_search`
  - `web_fetch`
  - `append_to_current_file`
  - `replace_current_file`
  - section/title/path tools already implemented in the repo
- Every write returns a receipt with path, operation, bytes written/deleted where applicable, and backup path for risky writes.
- Replacements and destructive edits require backup in `.agent-backups/`.
- Hard delete is not a default capability; use Obsidian-safe trash behavior only when explicitly implemented and requested.

## Chat History

- Persist only user and assistant chat content.
- Never persist status logs, timing metrics, tool traces, receipts, errors, or hidden thinking as model history.
- Keep history bounded by message count and character caps.
- `Clear chat` must clear persisted chat memory only. It must not modify notes, backups, receipts, settings, or vault files.
- Off-topic model output that fails the runner's final-answer relevance gate must not be persisted as assistant chat memory.

## Git And Editing Discipline

- Before editing files, run `git status --short`.
- Do not revert unrelated user changes.
- Do not clean untracked files unless explicitly asked.
- Keep patches scoped to the requested task.
- Use `apply_patch` for manual edits.
- Do not manually edit generated build artifacts such as `main.js`; update them through the repo build unless there is a repo-specific reason.

## Context Management

- When the context reaches 85%, run context compact before continuing. Preserve the active task, key decisions, files touched, validation state, and remaining steps.

## Validation

Before declaring implementation complete, run the relevant repo checks that exist:

```bash
npm test
npm run build
```

Do not claim tests passed unless they actually ran. For UI work, also verify that the built artifacts contain the expected UI strings/classes when a visual Obsidian check is not available.

## Test Vault Freshness

The live test vault defaults to `%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai`. Set `OBSIDIAN_VAULT` when the vault lives elsewhere.

After every code, UI, CSS, build, or plugin-behavior change:

1. Run `npm run build`.
2. Copy the current plugin artifacts into:

```text
%USERPROFILE%\OneDrive\Desktop\test_vault_obsidian_ai\.obsidian\plugins\agentic-researcher
```

3. Copy only these files unless explicitly asked otherwise:

```text
main.js
styles.css
manifest.json
```

4. Do not overwrite `data.json`; it contains the user's vault-local plugin settings/history.
5. Verify the installed vault copy is not stale by searching it for the new strings/classes you changed.
6. Tell the user to reload the plugin or restart Obsidian if an already-open panel still shows the old UI.

Useful PowerShell sync command:

```powershell
$repo = (Get-Location).Path
$dest = Join-Path $env:USERPROFILE "OneDrive\Desktop\test_vault_obsidian_ai\.obsidian\plugins\agentic-researcher"
Copy-Item -LiteralPath "$repo\main.js" -Destination "$dest\main.js" -Force
Copy-Item -LiteralPath "$repo\styles.css" -Destination "$dest\styles.css" -Force
Copy-Item -LiteralPath "$repo\manifest.json" -Destination "$dest\manifest.json" -Force
```

## Good Change Standard

A good change moves the plugin toward a working native loop: read note, inspect vault or web, synthesize, write useful markdown, and show receipts. Avoid changes that only add unused metadata, policy scaffolding, fake guardrails, or UI controls that bypass real agent execution.
