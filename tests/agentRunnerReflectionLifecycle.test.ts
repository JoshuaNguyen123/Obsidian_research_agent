import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sourceUrl = new URL("../src/AgentRunner.ts", import.meta.url);
const mainSourceUrl = new URL("../main.ts", import.meta.url);

test("terminal reflection is pinned, receipted, and completed before terminal persistence", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const binding = source.indexOf("const boundInitiatingNotePath =");
  const prepared = source.indexOf("await withPreparedActionFingerprint({", binding);
  const approval = source.indexOf("await requestRunnerToolApproval({", prepared);
  const writeback = source.indexOf("await appendMarkdownReflectionWritebackV1({", approval);
  const receipt = source.indexOf("await recordLedgerReceipt(receipt, step);", writeback);
  const acceptance = source.indexOf("await recordMissionAcceptance(acceptance, step", receipt);
  const persisted = source.indexOf("mission-ledger-complete-${effectiveStopReason}", acceptance);

  assert.ok(binding >= 0);
  assert.ok(prepared > binding);
  assert.ok(approval > prepared);
  assert.ok(writeback > binding);
  assert.ok(writeback > approval);
  assert.ok(receipt > writeback);
  assert.ok(acceptance > receipt);
  assert.ok(persisted > acceptance);

  const bindingBlock = source.slice(binding, prepared);
  assert.match(bindingBlock, /runtimeSnapshot\?\.currentNotePath/u);
  assert.match(bindingBlock, /pinnedCurrentMarkdownPathForRun/u);
  assert.doesNotMatch(bindingBlock, /workspace\?\.getActiveFile/u);

  const approvalBlock = source.slice(prepared, writeback);
  assert.match(approvalBlock, /expectedTargetRevision: expectedBeforeSha256/u);
  assert.match(approvalBlock, /markdown: notePlan\.markdown/u);
  assert.match(approvalBlock, /approvedFingerprint !== preparedAction\.payloadFingerprint/u);
  const receiptBlock = source.slice(writeback, acceptance);
  assert.match(
    receiptBlock,
    /payloadFingerprint: preparedAction\.payloadFingerprint/u,
  );
  assert.match(
    receiptBlock,
    /observedFingerprint: writeback\.afterSha256/u,
  );
});

test("terminal reflection failure prevents a successful completion projection", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const failure = source.indexOf("reflectionWritebackFailure = getUnknownErrorMessage(error)");
  const completion = source.indexOf("const completionReflectionForContinue =", failure);
  const completeRun = source.indexOf("completeRun(", completion);
  const block = source.slice(failure, completeRun);

  assert.ok(failure >= 0);
  assert.match(block, /effectiveStopReason = "budget"/u);
  assert.match(block, /"reflection_writeback_receipt"/u);
  assert.match(block, /reason: "reflection_writeback_failed"/u);
  assert.match(block, /required_tools_failed:reflection_writeback_failed/u);
});

test("code completion reflection resolves immutable examples and fails closed when unavailable", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const resolve = source.indexOf(
    "runToolContext.resolveVerifiedCodeReflectionExamples",
  );
  const plan = source.indexOf("planCompoundCompletionReflection({", resolve);
  const persist = source.indexOf("await recordMissionAcceptance(acceptance, step", plan);
  const block = source.slice(resolve, persist);

  assert.ok(resolve >= 0);
  assert.ok(plan > resolve);
  assert.match(block, /commitSha: codeCommit\.proof\.commitSha/u);
  assert.match(block, /parseVerifiedCodeReflectionExamplesV1/u);
  assert.match(block, /"verified_code_reflection_examples"/u);
  assert.match(block, /code: "reflection_code_examples_unavailable"/u);
  assert.match(block, /shouldPlanGenericInitiatingNoteReflectionV1\(\{/u);
  assert.match(
    block,
    /successfulTerminal:\s*successfulTerminalForInitiatingReflection/u,
  );
  assert.match(block, /reflectionWritebackPreconditionFailed:\s*Boolean\(/u);
  assert.match(block, /canonicalLifecycleReflectionPaid,/u);
  assert.match(block, /codeExamples: verifiedReflectionCodeExamples/u);

  const helper = source.slice(
    source.indexOf("export function shouldPlanGenericInitiatingNoteReflectionV1"),
  );
  assert.match(helper, /input\.successfulTerminal/u);
  assert.match(helper, /!input\.reflectionWritebackPreconditionFailed/u);
  assert.match(helper, /!input\.canonicalLifecycleReflectionPaid/u);
});

test("native host rebinds generic reflection examples to the exact durable handoff", async () => {
  const source = await readFile(mainSourceUrl, "utf8");
  const context = source.indexOf("resolveVerifiedCodeReflectionExamples: async ({");
  const handoff = source.indexOf(
    "bridge.resolveVerifiedCodePublicationHandoff(",
    context,
  );
  const commitCheck = source.indexOf(
    "handoff.commitSha !== commitSha",
    handoff,
  );
  const examples = source.indexOf(
    "bridge.resolveVerifiedCodeReflectionExamples(",
    commitCheck,
  );

  assert.ok(context >= 0);
  assert.ok(handoff > context);
  assert.ok(commitCheck > handoff);
  assert.ok(examples > commitCheck);
});

test("canonical reflection persistence commits durable proof before best-effort Linear projection", async () => {
  const source = await readFile(mainSourceUrl, "utf8");
  const persist = source.indexOf(
    "persistProjectReflectionReceipt: async (receipt, executionContext) => {",
  );
  const verify = source.indexOf(
    "verifyProjectLifecycleCompletion: async (executionContext) => {",
    persist,
  );
  const block = source.slice(persist, verify);
  const receipt = block.indexOf("await this.appendExternalActionReceipt(receipt)");
  const lineage = block.indexOf(
    "await this.persistReflectionProjectLineage(receipt)",
  );
  const projection = block.indexOf("await this.projectAndDispatchLinearProgress(");

  assert.ok(persist >= 0);
  assert.ok(verify > persist);
  assert.ok(receipt >= 0);
  assert.ok(lineage > receipt);
  assert.ok(projection > lineage);
  assert.match(block, /try\s*\{[\s\S]*projectAndDispatchLinearProgress\([\s\S]*false,[\s\S]*\);[\s\S]*\}\s*catch \(error\)/u);
  assert.match(
    block,
    /must never make the no-overwrite artifact look[\s\S]*replayable/u,
  );
  assert.doesNotMatch(
    block,
    /projectAndDispatchLinearProgress\([\s\S]{0,160}true,/u,
  );
});

test("terminal lifecycle verification requires reflection lineage and a drained Linear projection", async () => {
  const source = await readFile(mainSourceUrl, "utf8");
  const verify = source.indexOf(
    "verifyProjectLifecycleCompletion: async (executionContext) => {",
  );
  const resolveExamples = source.indexOf(
    "resolveVerifiedCodeReflectionExamples: async ({",
    verify,
  );
  const block = source.slice(verify, resolveExamples);
  const root = block.indexOf("executionContext.rootMissionId?.trim()");
  const lineage = block.indexOf("this.getProjectLineages().find(");
  const reflection = block.indexOf(
    'commit.stage === "reflection"',
    lineage,
  );
  const drain = block.indexOf("await this.projectAndDispatchLinearProgress(");

  assert.ok(verify >= 0);
  assert.ok(resolveExamples > verify);
  assert.ok(root >= 0);
  assert.ok(lineage > root);
  assert.ok(reflection > lineage);
  assert.ok(drain > reflection);
  assert.match(
    block,
    /Developer mission completion requires a verified Results or Jupyter reflection lineage/u,
  );
  assert.match(
    block,
    /projectAndDispatchLinearProgress\([\s\S]*executionContext,[\s\S]*true,[\s\S]*\);/u,
  );
  assert.doesNotMatch(block, /catch \(error\)/u);
});

test("required terminal Linear drain fails closed without an exact issue binding", async () => {
  const source = await readFile(mainSourceUrl, "utf8");
  const dispatch = source.indexOf(
    "private async projectAndDispatchLinearProgress(",
  );
  const nextMethod = source.indexOf(
    "private linearStateIdForProjectProgress(",
    dispatch,
  );
  const block = source.slice(dispatch, nextMethod);
  const bindings = block.indexOf(
    "projectLinearBindingsFromProjectLineageV1({ lineage })",
  );
  const empty = block.indexOf("if (bindings.length === 0)", bindings);
  const required = block.indexOf("if (requireDrained)", empty);
  const failure = block.indexOf(
    "Linear project progress cannot complete without an exact issue/work-unit binding.",
    required,
  );
  const legacyReturn = block.indexOf("return;", failure);

  assert.ok(dispatch >= 0);
  assert.ok(nextMethod > dispatch);
  assert.ok(bindings >= 0);
  assert.ok(empty > bindings);
  assert.ok(required > empty);
  assert.ok(failure > required);
  assert.ok(legacyReturn > failure);
  assert.match(
    block.slice(required, legacyReturn),
    /if \(requireDrained\)\s*\{\s*throw new Error\(/u,
  );
});

test("runner retries only the terminal Linear drain after a durable canonical reflection", async () => {
  const source = await readFile(sourceUrl, "utf8");
  const canonical = source.indexOf(
    "const canonicalLifecycleReflectionPaid =",
  );
  const verifyCall = source.indexOf(
    "runToolContext.verifyProjectLifecycleCompletion",
    canonical,
  );
  const acceptancePersist = source.indexOf(
    "await recordMissionAcceptance(acceptance, step",
    canonical,
  );
  const terminalPersist = source.indexOf(
    "mission-ledger-complete-${effectiveStopReason}",
    canonical,
  );

  assert.ok(canonical >= 0);
  assert.ok(verifyCall > canonical);
  assert.ok(acceptancePersist > verifyCall);
  assert.ok(terminalPersist > acceptancePersist);

  const canonicalBlock = source.slice(canonical, verifyCall);
  assert.match(canonicalBlock, /canonicalLifecycleReflectionReceiptPaysV1/u);
  assert.match(
    canonicalBlock,
    /missionLedger\?\.receipts|missionLedger\.receipts|resumeLedger\.receipts/u,
  );
  assert.match(canonicalBlock, /writeReceipts/u);

  const guardedDrainBlock = source.slice(canonical, acceptancePersist);
  const verifyBlock = source.slice(verifyCall, acceptancePersist);
  assert.match(
    guardedDrainBlock,
    /canonicalLifecycleReflectionPaid[\s\S]*verifyProjectLifecycleCompletion/u,
  );
  assert.match(
    verifyBlock,
    /await runToolContext\.verifyProjectLifecycleCompletion\(runToolContext\)/u,
  );
  assert.match(verifyBlock, /catch \(error\)/u);
  assert.match(verifyBlock, /effectiveStopReason = "budget"/u);
  assert.match(verifyBlock, /status:[\s\S]*"needs_more_work"/u);
  assert.match(verifyBlock, /missing:[\s\S]*linear_project_progress_terminal_readback/u);
  assert.match(verifyBlock, /proofDebtForFinish = computeProofDebt\(/u);
  assert.match(
    verifyBlock,
    /project_lifecycle_completion|linear_project_progress|terminal_linear/u,
  );
  assert.match(verifyBlock, /nextAction:/u);

  // A retry is reconciliation-only: the immutable Results/notebook writer is
  // not called again after its durable receipt has paid the reflection stage.
  assert.doesNotMatch(verifyBlock, /WRITE_PROJECT_RESULTS_TOOL_NAME/u);
  assert.doesNotMatch(verifyBlock, /APPEND_JUPYTER_REFLECTION_TOOL_NAME/u);
  assert.doesNotMatch(verifyBlock, /toolExecutor\.execute/u);
});

test("GitHub finalization records the note reflection as vault proof, never as an external receipt", async () => {
  const source = await readFile(mainSourceUrl, "utf8");
  const finalize = source.indexOf("finalizeObsidian: async (");
  const plan = source.indexOf(
    "await noteWriter.planProjectCompletionReflection(",
    finalize,
  );
  const prepared = source.indexOf(
    "const preparedAction = await withPreparedActionFingerprint({",
    plan,
  );
  const approval = source.indexOf("const approval = await requestApproval({", prepared);
  const exactCommit = source.indexOf(
    "await noteWriter.appendPreparedProjectCompletionReflection({",
    approval,
  );
  const receipt = source.indexOf("const reflectionReceipt: ActionReceipt", finalize);
  const persistLineage = source.indexOf(
    "await this.persistFinalizedGitHubPublicationLineage({",
    receipt,
  );
  // finalizeObsidian is the last finalizer in the object literal, so bound it
  // by its own return rather than by a sibling key that appears earlier.
  const finalizeReturn = source.indexOf("return {", persistLineage);
  const finalizeObsidianSource = source.slice(finalize, finalizeReturn);

  assert.ok(finalize >= 0);
  assert.ok(plan > finalize);
  assert.ok(prepared > plan);
  assert.ok(approval > prepared);
  assert.ok(exactCommit > approval);
  assert.ok(receipt > exactCommit);
  assert.ok(persistLineage > receipt);
  assert.ok(finalizeReturn > persistLineage);
  // The slice must really be the reflection finalizer, or the guards below
  // would pass vacuously.
  for (const marker of [
    "planProjectCompletionReflection",
    "appendPreparedProjectCompletionReflection",
    "persistFinalizedGitHubPublicationLineage",
  ]) {
    assert.ok(finalizeObsidianSource.includes(marker), marker);
  }

  // Regression: the finalizer used to push this vault receipt into the
  // external action receipt ledger, which accepts Linear and GitHub proof
  // only and rejects every other system by contract. The append threw after
  // the note bytes were already committed, so publish_verified_code_to_github
  // blocked with "the originating Markdown reflection remains pending" and no
  // stated cause. A vault write is proved by the note revision, the
  // publication checkpoint obsidianReceiptId, and the project lineage.
  assert.ok(
    !finalizeObsidianSource.includes("appendExternalActionReceipt"),
    "the note reflection must not enter the Linear/GitHub external proof ledger",
  );
  assert.ok(
    !finalizeObsidianSource.includes("externalActionReceiptLedger"),
    "a vault receipt can never be found in the external ledger, so it must not be searched there",
  );
  assert.ok(finalizeObsidianSource.includes("system: \"vault\""));

  const block = source.slice(receipt, persistLineage);
  for (const fragment of [
    "payloadFingerprint: preparedAction.payloadFingerprint",
    "grantId: approval.approvalId",
    "observedFingerprint: result.afterSha256",
  ]) {
    assert.ok(block.includes(fragment), fragment);
  }

  const preparedBlock = source.slice(prepared, approval);
  for (const fragment of [
    "proposedAppendMarkdown: reflectionPlan.proposedAppendMarkdown",
    "proposedAppendSha256: reflectionPlan.proposedAppendSha256",
    "expectedAfterSha256: reflectionPlan.expectedAfterSha256",
    "markdownExcerpt: reflectionPlan.markdownExcerpt",
    "codeExcerpt: reflectionPlan.codeExcerpt",
    "outboundBytes: reflectionPlan.proposedAppendBytes",
    "presentation: reflectionPlan.presentation",
  ]) {
    assert.ok(preparedBlock.includes(fragment), fragment);
  }

  const finalizeBlock = source.slice(finalize, receipt);
  assert.ok(
    finalizeBlock.includes("commit.stage === \"linear_hierarchy\""),
  );
  assert.ok(
    finalizeBlock.includes("projectLineage ? \"delivery_status\" : \"full_reflection\""),
  );

  const approvalToCommit = source.slice(approval, receipt);
  for (const fragment of [
    "approval.approvalFingerprint !== preparedAction.payloadFingerprint",
    "approvedAppendMarkdown !== reflectionPlan.proposedAppendMarkdown",
  ]) {
    assert.ok(approvalToCommit.includes(fragment), fragment);
  }
});
