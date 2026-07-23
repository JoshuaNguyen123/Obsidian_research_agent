import assert from "node:assert/strict";
import test from "node:test";
import {
  chatStatsPlaceholderCopy,
  clearChatConfirmCopy,
  clearChatDoneCopy,
  chatApprovalAttentionTitle,
  chatMissionGraphBlockerTitle,
  chatModelConnectionGateNext,
  chatModelConnectionGateTitle,
  chatProviderBlockerTitle,
  chatWriteInterruptedNextCopy,
  chatWriteInterruptedTitle,
  compoundLifecycleReadinessChatLine,
  compoundLifecycleReadinessTitle,
  continueLatestRunSafeCopy,
  isPartialWritebackStopDetail,
  inferTeamRolePhaseFromStatus,
  isToolIntentGateFailure,
  missionGraphPlannerFallbackCopy,
  missionReceiptWrittenChatLine,
  noteStreamingActiveChatLine,
  receiptUrlWorkstreamLine,
  teamRoleStripCopy,
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
  assert.equal(chatWriteInterruptedTitle(), "Write interrupted");
  assert.equal(chatMissionGraphBlockerTitle(), "Mission blocked");
  assert.equal(
    isPartialWritebackStopDetail(
      "Streamed writeback cannot safely retry after partial note apply (partial_write_no_safe_retry).",
    ),
    true,
  );
  assert.match(chatWriteInterruptedNextCopy(), /Continue Latest Run/i);
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
  assert.equal(
    toolStepChatLine(
      "read_template",
      false,
      "read_template requires the user to ask about templates.",
      { skipped: true },
    ),
    "Used read_template: skipped — read_template requires the user to ask about templates.",
  );
  assert.equal(
    isToolIntentGateFailure({
      message:
        "Tool returned error: read_template (read_template requires the user to ask about templates.)",
    }),
    true,
  );
  assert.equal(
    isToolIntentGateFailure({ message: "Tool complete: web_search" }),
    false,
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

test("compound readiness and live workstream copy stay advertising-safe", () => {
  assert.equal(
    compoundLifecycleReadinessTitle(),
    "End-to-end workflow setup required",
  );
  assert.match(
    compoundLifecycleReadinessChatLine(["Linear: Connect Linear"]),
    /End-to-end mission blocked/i,
  );
  assert.match(noteStreamingActiveChatLine(), /Streaming into the active note/);
  assert.equal(
    receiptUrlWorkstreamLine("github", "https://github.com/acme/repo/pull/1"),
    "github: https://github.com/acme/repo/pull/1",
  );
  assert.match(
    missionReceiptWrittenChatLine("Agent Work/Mission Receipts/run-1.md"),
    /Mission receipt written/,
  );
});

test("team role strip and chat surface copy stay stable", () => {
  assert.equal(teamRoleStripCopy({ phase: "idle" }), "Team: idle");
  assert.equal(teamRoleStripCopy({ phase: "researcher" }), "Team: Researcher");
  assert.equal(
    teamRoleStripCopy({ phase: "handoff", handoffReady: true }),
    "Team: Researcher > Handoff OK",
  );
  assert.equal(
    teamRoleStripCopy({ phase: "handoff", handoffReady: false }),
    "Team: Researcher > Handoff rejected",
  );
  assert.equal(
    teamRoleStripCopy({ phase: "lead" }),
    "Team: Researcher > Handoff OK > Lead",
  );
  assert.deepEqual(inferTeamRolePhaseFromStatus("Researcher step 2/8"), {
    phase: "researcher",
  });
  assert.deepEqual(inferTeamRolePhaseFromStatus("Handoff accepted."), {
    phase: "handoff",
    handoffReady: true,
  });
  assert.match(chatStatsPlaceholderCopy({ stepLabel: "step 3/40" }), /step 3\/40/);
});
