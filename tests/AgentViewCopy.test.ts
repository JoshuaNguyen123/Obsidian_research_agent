import assert from "node:assert/strict";
import test from "node:test";
import {
  artifactLinkChatLine,
  clearChatConfirmCopy,
  clearChatDoneCopy,
  chatApprovalAttentionTitle,
  chatModelConnectionGateNext,
  chatModelConnectionGateTitle,
  chatProviderBlockerTitle,
  compoundLifecycleReadinessChatLine,
  compoundLifecycleReadinessTitle,
  continueLatestRunSafeCopy,
  endToEndStarterMissionLabel,
  endToEndStarterMissionPrompt,
  missionGraphPlannerFallbackCopy,
  missionReceiptWrittenChatLine,
  noteStreamingActiveChatLine,
  toolStepChatLine,
} from "../src/ui/agentViewCopy";

test("AgentView clear-chat copy stays vault-safe", () => {
  assert.match(clearChatConfirmCopy(), /chat history only/i);
  assert.match(clearChatConfirmCopy(), /Notes/);
  assert.match(clearChatDoneCopy(), /Vault notes were not modified/i);
});

test("AgentView approval and tool chat lines are stable", () => {
  assert.equal(
    chatApprovalAttentionTitle("replace_current_file"),
    "Approval needed: replace_current_file",
  );
  assert.equal(chatProviderBlockerTitle(), "Cloud model blocked");
  assert.match(
    continueLatestRunSafeCopy({ runId: "r1", completedWriteCount: 1 }),
    /will not be replayed/i,
  );
  assert.equal(
    toolStepChatLine("web_search", true, "Found 3 results"),
    "Used web_search: ok — Found 3 results",
  );
  assert.equal(
    toolStepChatLine("web_fetch", false),
    "Used web_fetch: failed — failed",
  );
  assert.equal(chatModelConnectionGateTitle(), "Model connection required");
  assert.match(chatModelConnectionGateNext(), /Test connection/i);
});

test("mission graph planner fallback copy is visible when reason is set", () => {
  assert.equal(missionGraphPlannerFallbackCopy(null), null);
  assert.equal(missionGraphPlannerFallbackCopy(""), null);
  assert.match(
    missionGraphPlannerFallbackCopy("structured_timeout") ?? "",
    /host fallback \(structured_timeout\)/i,
  );
});

test("end-to-end starter and live workstream copy stay advertising-safe", () => {
  assert.match(endToEndStarterMissionPrompt(), /end to end/i);
  assert.match(endToEndStarterMissionPrompt(), /Linear/i);
  assert.match(endToEndStarterMissionPrompt(), /GitHub/i);
  assert.equal(endToEndStarterMissionLabel(), "End-to-end checkers workflow");
  assert.equal(
    compoundLifecycleReadinessTitle(),
    "End-to-end workflow setup required",
  );
  assert.match(
    compoundLifecycleReadinessChatLine(["Linear: Connect Linear"]),
    /End-to-end mission blocked/i,
  );
  assert.match(noteStreamingActiveChatLine(), /Streaming into the active note/);
  assert.match(
    artifactLinkChatLine("github", "https://github.com/acme/repo/pull/1"),
    /https:\/\/github\.com\/acme\/repo\/pull\/1/,
  );
  assert.match(
    missionReceiptWrittenChatLine("Agent Work/Mission Receipts/run-1.md"),
    /Mission receipt written/,
  );
});
