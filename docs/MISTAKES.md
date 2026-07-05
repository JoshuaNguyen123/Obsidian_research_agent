# Mistakes And Lessons Learned

## Repeated Test Assertions Need Strong Patch Context

While correcting the autonomous web-streaming tests, a broad `apply_patch` replacement for `assert.equal(chatRequests.length, ...)` briefly changed an earlier unrelated test. The fix was to restore the accidental edit and use nearby test names plus surrounding fixture context for subsequent patches.

Lesson: in large test files with repeated assertions or repeated tool-call fixture lines, patch with the test name and local setup in the hunk. Do not rely on a short repeated assertion as the only context.

## Generated Writing Must Not Depend On A Missing Append Tool

The generated-output e2e initially failed with `append_to_current_file was not available` after the mock model tried to call an append tool while streamed current-note writeback had intentionally removed that tool. That reproduced the product failure mode where the agent streamed an answer into chat but could not write the active note.

Lesson: when streaming writeback owns the note mutation, generated writing prompts should be finalized through runner-owned writeback, not through a model-requested append tool. The mock harness must also cover the no-append-tool path instead of only testing tool-call append behavior.

## E2E Mock Readiness Must Verify The Actual Client

The generated-output matrix first failed with `model 'playwright-e2e-mock' not found` because the test only set the model name and did not prove the active plugin/view references were actually using the patched mock client.

Lesson: e2e setup must verify `createModelClient()` on the running plugin instance returns the mock sentinel before submitting prompts. Patching only settings or one plugin reference is not enough inside Obsidian's live view lifecycle.

## Project Memory Can Pollute Prompt-Matrix Runs

Generated-output e2e runs picked up earlier prompt history from project-local memory under `E2E Agent Tests/Agent Memory`, causing later prompts to inherit the wrong topic.

Lesson: e2e scenarios that assert prompt-specific generated output must clear both plugin in-memory chat history and project-local memory JSON for their test folder before each matrix run.

## Full Request Matching Can Reuse The Wrong Prompt

The mock streaming implementation matched generated-output prompts against the full model request, including prior user messages. That let a Gilgamesh prompt receive Revolutionary War content because the earlier prompt was still present in history.

Lesson: model mocks should inspect the latest user message first and use full request text only as a fallback. This keeps table-driven prompt tests from passing or failing because of stale history text.

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
