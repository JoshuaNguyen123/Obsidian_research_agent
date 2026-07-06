# Mistakes And Lessons Learned

## Acceptance Gates Must Not Treat Every Exposed Tool As Required

The first mission-acceptance implementation treated route-expected or exposed tools as mandatory completion requirements, and it also matched the bare word `current` as web-current evidence. That made ordinary current-note and web-search flows ask for extra model turns after a valid final answer.

Lesson: completion acceptance should distinguish available tools from required proof. Force another step only for actionable missing requirements such as write receipts, explicit web/source evidence, word-count checks, or explicit vault-before-answering requests. Do not make broad tool exposure itself a hard acceptance item, and do not treat `current note` as current-events web intent.

## Follow-Up Revision Approvals Must Complete The Edit

The user reproduced a flow where the assistant said it would revise an essay, then `Go ahead and revise` and `Edit the essay` did not produce the expected note edit. The runner recognized only a narrow set of continuation phrases, and broad essay/paragraph edit wording could fall into section-edit routing that expects a named heading.

Lesson: short approval follow-ups after an assistant edit commitment must resolve to a concrete current-note revision mission before tool selection. Whole-essay/body/paragraph revision should replace the current note with a backup unless the user names a specific heading or section.

## Repeated Test Assertions Need Strong Patch Context

While correcting the autonomous web-streaming tests, a broad `apply_patch` replacement for `assert.equal(chatRequests.length, ...)` briefly changed an earlier unrelated test. The fix was to restore the accidental edit and use nearby test names plus surrounding fixture context for subsequent patches.

Lesson: in large test files with repeated assertions or repeated tool-call fixture lines, patch with the test name and local setup in the hunk. Do not rely on a short repeated assertion as the only context.

## Generated Writing Must Not Depend On A Missing Append Tool

The generated-output e2e initially failed with `append_to_current_file was not available` after the mock model tried to call an append tool while streamed current-note writeback had intentionally removed that tool. That reproduced the product failure mode where the agent streamed an answer into chat but could not write the active note.

Lesson: when streaming writeback owns the note mutation, generated writing prompts should be finalized through runner-owned writeback, not through a model-requested append tool. The mock harness must also cover the no-append-tool path instead of only testing tool-call append behavior.

## Stream-To-Page Must Be Live Note Writeback

The user reproduced `stream it to the page` essay prompts where the assistant waited for the full excerpt and then reported `Done. append Untitled.md.` That violated the visible product promise because the active note did not receive live safe chunks while the provider streamed.

Lesson: explicit stream-to-page/note/document/current-file wording must route to `streamCurrentNoteWriteback` before append-tool routing. While the runner owns that streamed current-note write, `append_to_current_file` should be suppressed for generated current-note output and the receipt should report streamed writeback.

## Generated H1 Must Replace The Existing Note Title Slot

The generated essay title was written below the existing `# Untitled` heading, leaving two H1s and keeping the visible top note title unchanged.

Lesson: streamed generated markdown needs a leading-H1 consumer. If the first generated block is `# Title`, update the existing frontmatter/H1 through the note-title helper and stream only the remaining body. Do not rename the file unless the user explicitly asks for a file rename or move.

## Generated H1 Retitle Must Use Latest Note Content

The first generated-title fix retitled the initial note snapshot captured when streaming writeback started. If the editor/body content changed between writer setup and the first generated H1, the title patch could miss or discard the latest active body state.

Lesson: leading-H1 consumption should apply the targeted title replacement to the latest active markdown content available from the editor hook, then stream only the generated body. This keeps the header/body split from turning into a stale-snapshot write.

## Title Replacement Must Accept Markdown Variants

Generated and existing note titles are not always emitted as a plain `# Title` line. A streamed provider can split the heading across chunks, include up to three leading spaces, or include a closing hash marker such as `# Title #`. Frontmatter can also use `Title:` casing.

Lesson: note-title replacement must use a tolerant targeted Markdown heading match and case-insensitive frontmatter title matching. Tests should cover split streamed headings and decorated H1 lines so the title/body split does not leave `# Untitled` in place.

## Compound Missions Must Not Stop After The First Mutation

The runner previously treated any successful write-like tool as mission completion. A prompt such as `change the title and write the essay` could stop after `retitle_current_file`, and multi-step CRUD prompts could stop after the first create/update/delete tool.

Lesson: completion must be tracked by requested operation goals, not by a single `wroteToNote` boolean. Read, web, create, write, update, delete, title, replace, section, and path goals should be marked done only by their mapped successful tools or by runner-owned streamed writeback. The runner should execute every tool call returned in one model response sequentially and continue until all requested goals are done.

## Source Prompts Need Tool-Enforced Web Evidence

Citation and quote prompts could fail with `I could not get the model to request the required web research tools before answering` because the model ignored the corrective prompt and the runner had no deterministic fallback.

Lesson: source/citation/verification prompts should require `web_search` and `web_fetch` when available. If the model answers too early after one correction, the runner may run a read-only web fallback itself, add those tool results to the messages, and then force no-tool drafting or streamed writeback. This fallback must stay read-only and must not mutate vault files.

## Clear-Then-Write Wording Is Replace With Backup

The phrases `keep the note, but delete all the contents`, `start cleanly`, `clear it and write again`, and `edit over it` were too easy to miss. The runner could append onto stale content or route to the wrong destructive tool.

Lesson: clear/delete-contents plus a follow-up write means replace the current note content with a backup, not append and not trash the note. Delete-only prompts can use safe trash behavior, but delete-plus-write should preserve the note path and complete the new write.

## E2E Mock Readiness Must Verify The Actual Client

The generated-output matrix first failed with `model 'playwright-e2e-mock' not found` because the test only set the model name and did not prove the active plugin/view references were actually using the patched mock client.

Lesson: e2e setup must verify `createModelClient()` on the running plugin instance returns the mock sentinel before submitting prompts. Patching only settings or one plugin reference is not enough inside Obsidian's live view lifecycle.

## Project Memory Can Pollute Prompt-Matrix Runs

Generated-output e2e runs picked up earlier prompt history from project-local memory under `E2E Agent Tests/Agent Memory`, causing later prompts to inherit the wrong topic.

Lesson: e2e scenarios that assert prompt-specific generated output must clear both plugin in-memory chat history and project-local memory JSON for their test folder before each matrix run.

## Full Request Matching Can Reuse The Wrong Prompt

The mock streaming implementation matched generated-output prompts against the full model request, including prior user messages. That let a Gilgamesh prompt receive Revolutionary War content because the earlier prompt was still present in history.

Lesson: model mocks should inspect the latest user message first and use full request text only as a fallback. This keeps table-driven prompt tests from passing or failing because of stale history text.

## Word-Count Targets Must Be Scoped To The Current Prompt

The user reproduced a prompt-matrix flow where a later short Grapes of Wrath stream-to-page prompt inherited the earlier `1000 word` target and started a correction pass against the wrong request.

Lesson: streamed writeback word-count correction should read the active mission's generated-word-target system context first and only fall back to the latest user prompt. It must not scan older chat history or current-note context for numeric word targets when deciding whether to correct the current streamed draft.

## Loop-Depth E2E Must Assert The Requested Max

The loop-depth UI could show `Agent step 5 of max 5` for prompts that explicitly requested 10, 15, 25, or 30 model steps because the grounded-workflow route budget stayed at its default five-step cap. The Playwright test also masked the bug by expecting `Math.min(steps, 5)`.

Lesson: diagnostic prompts that explicitly request a number of model/agent/planning/loop steps should set the run cap to that requested count, still bounded by settings and the hard max. E2E assertions must check the actual requested `Step N/N` and `Agent step N of max N` display, not the old route default.

## Obsidian Vault Cache Races Can Surface As File-Exists Errors

The generated-output e2e hit intermittent `File already exists` failures while recreating seed notes in a live Obsidian vault. The adapter could report a stale path state even after cleanup.

Lesson: Playwright vault helpers should upsert seed files and retry after file-exists races instead of assuming a delete/create sequence is immediately visible to Obsidian's file cache.

## Canvas Title Nodes Are Not User Diagram Blocks

The three-block diagram test initially counted all JSON Canvas nodes and failed because the design tool adds a title node in addition to the three requested content nodes.

Lesson: diagram assertions should count user content nodes separately from generated title/decorative nodes. The receipt can still report the full node count, but product expectations should match the requested blocks.

## Raw Tool-Markup Assertions Should Not Ban Receipts

The generated-output e2e initially treated any mention of tool names as raw tool markup, so valid receipts and diagnostic rows could fail the test.

Lesson: raw-markup assertions should reject actual leaked tool-call syntax such as `<tool_call`, not legitimate Run Details labels, receipt operations, or tool timeline names.

## Delete-Then-Write Is Replace, Not Trash-Then-Stop

The user reproduced a flow where the agent deleted the note and stopped before writing the requested new essay. That made the destructive step succeed while the useful generated output never happened.

Lesson: compound prompts like `delete the current note content and write...` must route to replace-current-note with a backup. Delete-only prompts can use trash behavior, but delete-plus-write should not call the delete tool or stop after deletion.

## Real-AI E2E Calls Need Settling Time Between Prompts

The real-AI generated-output e2e path can ask the model several long prompts in sequence. Running the next prompt immediately after the previous observable assertion risks cutting short slower model/agent completion behavior or stacking calls before the prior run has fully settled.

Lesson: real-AI e2e should pause between prompt submissions. Keep mock tests fast, but give opt-in real model runs a configurable `E2E_AI_CALL_PAUSE_MS` gap, defaulting to 30 seconds and overridable to several minutes for slower agents.

## Generated-Output E2E Needs Substance Checks

The Gilgamesh generated-output scenario only checked that the note contained the word `Gilgamesh`, which allowed a shallow one-sentence response to satisfy the test even though the user wanted a useful 500-word essay.

Lesson: long-form generated-output e2e scenarios should assert on the newly generated text, not only the accumulated note. For the Gilgamesh essay, require a substantial minimum word count, core topic terms, enough runtime for real generation, and a real `count_words` follow-up in the opt-in real-AI path.

## Real-AI E2E Must Use The Plugin's Real Provider Settings

The real-AI e2e harness defaulted to `gpt-oss:120b` and required `E2E_OLLAMA_API_KEY`, even though the plugin already stores the intended Ollama Cloud credential and the required provider model is `gpt-oss:120b-cloud`.

Lesson: opt-in real-AI e2e should default to `gpt-oss:120b-cloud` and preserve the plugin's saved API key unless an explicit env override is supplied. Do not duplicate or print credentials in test output.

## Live-Provider Smoke Tests Should Avoid Nondeterministic Artifact Prompts

The real-AI smoke subset included a free-form three-block diagram prompt. The live provider completed the essay and source prompts but did not create the expected `.canvas` file, so the test failed on provider-dependent tool choice instead of the requested long-form generation behavior.

Lesson: keep native artifact/tool-shape assertions in the deterministic mock matrix unless the live prompt explicitly exercises a stable tool contract. The opt-in real-AI path should focus on live generation, source/tool use, word-count verification, write receipts, and safety-limit regressions.

## Loader Placeholders Can Flash During Reload Or Run Start

The chat CRT loader created its DOM with default `idle` text and then activated during run startup. Even though inactive CSS hid the loader, Obsidian reloads and the run-start sequence could briefly paint that stale background text before the real loading status arrived.

Lesson: transient UI elements should be blank and `aria-hidden` while inactive, and activation should seed the first meaningful status before display. E2E should assert the absence of stale placeholder text, not only the final hidden/visible state.

## Multi-Control Settings Rows Need A Real Layout

The semantic chunk token setting put four `Setting.addText` controls into one Obsidian setting row. In the settings modal this collapsed the label/description area, left a large blank card, and let the final input overflow the panel.

Lesson: grouped settings need explicit labels, a bounded grid or stacked layout, and a settings-panel e2e check for narrow widths. Do not rely on Obsidian's default single-row `Setting` layout for four related inputs.

## Grounded Writeback Must Not Clear Write Tools Too Early

The runner could gather required web evidence, then force a no-tool finalization step while a current-note writeback was still pending. If the model requested `append_to_current_file`, `replace_current_file`, or another valid follow-up tool in that step, Run Details showed red `Rejected unavailable tool` rows even though the mission still needed a write.

Lesson: read/source gathering and current-note writing can belong to the same grounded run. Preserve matching write tools while a write goal or streaming writeback is pending, and only clear the tool list for pure answer synthesis.

## Filled Template Defaults Should Follow The Active Project

Blank `templateOutputFolder` previously meant vault root, which made generated notes from filled templates land outside the active project folder unless the model supplied an explicit target path.

Lesson: saved reusable templates can stay in the configured template folder, but filled-template output should default to the active note's project folder when no explicit target or output setting is provided.
