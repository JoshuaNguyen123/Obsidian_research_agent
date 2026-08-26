import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildOffFrontierToolRejectionMessage,
  buildProofGatedWritebackHoldV1,
  buildRepeatedInvalidToolCallCorrectiveV1,
  buildToolRejectEvalV1,
  describeOffFrontierToolNearMiss,
  mapToolRejectCategory,
} from "../src/agent/toolRejectEval";

test("maps invented commit/git_add to code_commit_verified when listed", () => {
  assert.match(
    String(describeOffFrontierToolNearMiss("git_commit", ["code_commit_verified"])),
    /code_commit_verified/,
  );
  assert.match(
    String(describeOffFrontierToolNearMiss("git_add", ["code_commit_verified"])),
    /code_commit_verified/,
  );
});

test("maps create_repo and publish aliases when listed", () => {
  assert.match(
    String(
      describeOffFrontierToolNearMiss("create_repo", [
        "github_create_repository",
      ]),
    ),
    /github_create_repository/,
  );
  assert.match(
    String(
      describeOffFrontierToolNearMiss("draft_pr", [
        "publish_verified_code_to_github",
      ]),
    ),
    /publish_verified_code_to_github/,
  );
});

test("rejection message includes category and Preferred next", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "git_commit",
    readyFrontierToolNames: ["code_validate_fast", "code_commit_verified"],
    preferredNextTool: "code_commit_verified",
  });
  assert.match(message, /category=/);
  assert.match(message, /Preferred next: code_commit_verified/);
  assert.match(message, /Near-miss:.*code_commit_verified/);
  assert.match(message, /do not repeat/);
});

test("classifies off-frontier as unknown_tool", () => {
  assert.equal(
    mapToolRejectCategory({
      toolName: "git_commit",
      message: "Tool is not available for this prompt",
    }),
    "unknown_tool",
  );
});

test("builds eval records", () => {
  const record = buildToolRejectEvalV1({
    userIntentExcerpt: "implement hello and commit",
    selectedTool: "git_commit",
    expectedPrerequisite: "code_commit_verified",
    errorCategory: "unknown_tool",
    readyFrontier: ["code_commit_verified"],
  });
  assert.equal(record.result, "rejected");
  assert.equal(record.selectedTool, "git_commit");
  assert.equal(record.expectedPrerequisite, "code_commit_verified");
});

// A proof-verification hold tells the model "return the corrected content as
// your final answer, do not call the write tool"; the frontier rejection must
// never answer with "call that exact name" for the same tool, or the two
// subsystems command opposite next moves in the same transcript.
test("held preferred write tool gets the held-truth line, not a call directive", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "read_source_section",
    readyFrontierToolNames: ["append_to_current_file"],
    preferredNextTool: "append_to_current_file",
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /append_to_current_file is currently held by proof verification — return the corrected note content as your final answer instead of calling it\./,
  );
  assert.doesNotMatch(message, /Call that exact name/);
  assert.doesNotMatch(message, /Preferred next:/);
  // The frontier listing is factual and stays.
  assert.match(
    message,
    /Ready frontier tool\(s\) now: append_to_current_file\./,
  );
});

test("without held tools the message is byte-identical to the unheld format", () => {
  const baseline = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: ["semantic_search_notes", "append_to_current_file"],
  });
  assert.equal(
    baseline,
    "Tool is not available for this prompt: web_fetch " +
      "category=unknown_tool " +
      "Ready frontier tool(s) now: semantic_search_notes, append_to_current_file. " +
      "Preferred next: semantic_search_notes, append_to_current_file. Call that exact name. " +
      "Correct only that issue; do not repeat this exact call.",
  );
  // An explicitly empty held set must not change a single byte either.
  assert.equal(
    buildOffFrontierToolRejectionMessage({
      toolName: "web_fetch",
      readyFrontierToolNames: [
        "semantic_search_notes",
        "append_to_current_file",
      ],
      heldWriteToolNames: [],
    }),
    baseline,
  );
});

test("held tool is excluded from the fallback preferred join", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: [
      "append_to_current_file",
      "web_search",
      "read_source_section",
    ],
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /Preferred next: web_search, read_source_section\. Call that exact name\./,
  );
  assert.doesNotMatch(message, /Preferred next: append_to_current_file/);
});

test("a frontier of only held tools keeps the listing but drops the directive", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "web_fetch",
    readyFrontierToolNames: ["append_to_current_file"],
    heldWriteToolNames: ["append_to_current_file"],
  });
  assert.match(
    message,
    /Ready frontier tool\(s\) now: append_to_current_file\./,
  );
  assert.doesNotMatch(message, /Call that exact name/);
  assert.match(
    message,
    /append_to_current_file is currently held by proof verification/,
  );
});

test("an empty ready frontier never instructs the model to call a tool named none", () => {
  // Observed live: "Preferred next: none. Call that exact name." — the model
  // dutifully tried to call `none`, which is not a tool, and looped.
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "read_current_file",
    readyFrontierToolNames: [],
  });
  assert.doesNotMatch(message, /Preferred next: none/u);
  assert.doesNotMatch(message, /Call that exact name/u);
  assert.match(
    message,
    /No tool is ready to call; return your best final answer instead\./u,
  );
});

test("an authority refusal's real reason classifies as invalid_state, not unknown_tool", () => {
  // The builder used to classify a hardcoded "not available for this prompt"
  // stand-in, stamping every mission-graph authority refusal unknown_tool —
  // for a tool the model was correctly OFFERED (proof-matrix
  // interrupted-continuation, 2026-08-25). Classification must read the
  // refusing subsystem's actual message.
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "append_to_current_file",
    readyFrontierToolNames: [],
    reasonMessage:
      "Tool append_to_current_file is not ready in the authoritative mission graph.",
  });
  assert.match(message, /category=invalid_state/u);
  assert.doesNotMatch(message, /category=unknown_tool/u);
  // Without a real reason the historical default stands.
  assert.match(
    buildOffFrontierToolRejectionMessage({
      toolName: "append_to_current_file",
      readyFrontierToolNames: [],
    }),
    /category=unknown_tool/u,
  );
});

// ---------------------------------------------------------------------------
// proof-gated writeback hold: one builder, both seats
// ---------------------------------------------------------------------------

test("the mutation-boundary hold teaches the same remedy as the step-loop hold", () => {
  // The bug: the same gate held the same write for the same reason at two
  // seats, and only the step-loop seat told the model what to do instead. The
  // boundary seat is the LAST gate before bytes land, so a remedy-free hold
  // there strands the mission's only write.
  const preMutation = buildProofGatedWritebackHoldV1({
    toolName: "append_to_current_file",
    boundary: "pre_mutation",
    evidenceSatisfied: true,
    missing: ["passage_quote_exact"],
  });
  const commit = buildProofGatedWritebackHoldV1({
    toolName: "append_to_current_file",
    boundary: "commit",
    evidenceSatisfied: true,
    missing: ["passage_quote_exact"],
  });
  const remedy =
    "Return the complete corrected note content as the final answer without another write tool call;";
  assert.ok(preMutation.message.includes(remedy));
  assert.ok(
    commit.message.includes(remedy),
    "the mutation-boundary hold must name the same concrete next action",
  );
  // The cause clause still differs per seat; only the remedy is shared.
  assert.match(commit.message, /at the mutation boundary/u);
  assert.match(commit.message, /No note bytes were changed\./u);
  assert.match(preMutation.message, /before mutation/u);
  assert.equal(preMutation.systemCorrective, commit.systemCorrective);
});

test("the verification arm reports the held tool at both seats", () => {
  // lastProofGatedHoldToolName feeds heldWriteToolNames on two refusal
  // builders. Only the step-loop seat ever set it, so an off-frontier
  // rejection kept advising the exact tool the boundary was holding.
  for (const boundary of ["pre_mutation", "commit"] as const) {
    const hold = buildProofGatedWritebackHoldV1({
      toolName: "append_to_current_file",
      boundary,
      evidenceSatisfied: true,
    });
    assert.equal(hold.heldWriteToolName, "append_to_current_file");
    assert.equal(hold.narrowsOfferedFrontier, false);
  }
  // The evidence arm makes the opposite pair of decisions at both seats.
  for (const boundary of ["pre_mutation", "commit"] as const) {
    const hold = buildProofGatedWritebackHoldV1({
      toolName: "append_to_current_file",
      boundary,
      evidenceSatisfied: false,
      blockingProofs: ["web_evidence"],
    });
    assert.equal(hold.heldWriteToolName, null);
    assert.equal(hold.narrowsOfferedFrontier, true);
    assert.match(hold.systemCorrective, /web_evidence/u);
    assert.ok(
      hold.message.includes(
        "Continue with the allowed read and research tools before drafting the final writeback.",
      ),
    );
  }
});

test("step-loop hold wording is preserved byte-for-byte by the shared builder", () => {
  // Regression guard on the refactor: the seat that was already correct must
  // not have its contract reworded while the other seat is brought up to it.
  assert.equal(
    buildProofGatedWritebackHoldV1({
      toolName: "append_to_current_file",
      boundary: "pre_mutation",
      evidenceSatisfied: false,
      missing: ["web_evidence", "vault_evidence"],
      blockingProofs: ["web_evidence", "vault_evidence"],
    }).message,
    "Held append_to_current_file before mutation because required research evidence is still incomplete (web_evidence, vault_evidence). Continue with the allowed read and research tools before drafting the final writeback.",
  );
  assert.equal(
    buildProofGatedWritebackHoldV1({
      toolName: "append_to_current_file",
      boundary: "pre_mutation",
      evidenceSatisfied: true,
      missing: ["passage_quote_exact"],
      quoteCorrections: [
        {
          passageId: "p1",
          attempted: "a claim",
          passageExcerpt: "the real text",
        },
      ],
    }).message,
    "Held append_to_current_file before mutation because this sourced writeback requires final passage verification (passage_quote_exact). Return the complete corrected note content as the final answer without another write tool call; read tools such as web_search or read_source_section may still be used first to verify exact quotations. The runner will verify and commit the final content exactly once. Quote correction for p1: your draft quoted \"a claim\" but the cited passage actually reads: \"the real text\".",
  );
});

test("both AgentRunner proof-gate seats consume the shared hold builder", () => {
  // Source-level single-authority guard: neither seat may re-inline the
  // message, the corrective, or the two side-effect decisions.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const seats = runnerSource.match(/buildProofGatedWritebackHoldV1\(\{/gu) ?? [];
  assert.equal(
    seats.length,
    2,
    "exactly two seats must call the shared proof-gate hold builder",
  );
  assert.equal(
    runnerSource.match(/boundary: "commit"/gu)?.length,
    1,
    "the mutation-boundary seat must declare its boundary through the builder",
  );
  assert.equal(
    runnerSource.match(/boundary: "pre_mutation"/gu)?.length,
    1,
    "the step-loop seat must declare its boundary through the builder",
  );
  // The remedy and corrective sentences must exist only in toolRejectEval.ts.
  assert.doesNotMatch(
    runnerSource,
    /Held \$\{toolCall\.name\} (?:before mutation|at the mutation boundary)/u,
    "proof-gate hold wording must not be re-inlined in AgentRunner",
  );
  assert.doesNotMatch(
    runnerSource,
    /Do not request a current-note write tool again/u,
    "the proof-gate system corrective must not be re-inlined in AgentRunner",
  );
});

// ---------------------------------------------------------------------------
// repeated invalid tool call: the repeat must not go silent
// ---------------------------------------------------------------------------

test("a twice-failed call gets a terminal corrective naming what to do instead", () => {
  // The bug: the FIRST identical failure received a rich corrective (schema,
  // prerequisite tool, exact section list); the repeat received a ledger
  // blocker and a trace and nothing the model could read. The host stopped
  // retrying without telling the model it had.
  const withAlternatives = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "code_validate_fast",
    failureCode: "workspace_not_found",
    readyFrontierToolNames: [
      "code_workspace_create",
      "code_validate_fast",
      "code_workspace_read",
    ],
  });
  assert.match(withAlternatives, /Blocked code_validate_fast/u);
  assert.match(withAlternatives, /workspace_not_found/u);
  assert.match(
    withAlternatives,
    /call one of these exact names instead: code_workspace_create, code_workspace_read\./u,
  );
  // The blocked tool must never be offered back as its own alternative.
  assert.doesNotMatch(
    withAlternatives,
    /instead: [^.]*code_validate_fast/u,
  );
  assert.match(withAlternatives, /Do not repeat this exact call\./u);

  // With nothing else ready the corrective must name the final-answer exit
  // rather than leaving the model with no legal move.
  const noAlternatives = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "append_to_current_file",
    failureCode: "invalid_arguments",
    readyFrontierToolNames: ["append_to_current_file"],
  });
  assert.match(
    noAlternatives,
    /return your best final answer and state in one sentence that append_to_current_file could not be completed\./u,
  );
});

test("both AgentRunner repeat-blocker seats deliver the corrective", () => {
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  assert.equal(
    runnerSource.match(/buildRepeatedInvalidToolCallCorrectiveV1\(\{/gu)?.length,
    2,
    "both repeated_invalid_tool_call seats must push the shared corrective",
  );
  // Each repeat seat must push it, not merely trace it: the corrective is
  // only useful if it reaches the transcript.
  for (const marker of [
    "repeated-invalid-tool-call",
    "repeated-invalid-required-literal",
  ]) {
    const seatAt = runnerSource.indexOf(marker);
    assert.ok(seatAt > 0, `missing repeat seat ${marker}`);
    const window = runnerSource.slice(seatAt, seatAt + 900);
    assert.match(
      window,
      /messages\.push\(\{[\s\S]*buildRepeatedInvalidToolCallCorrectiveV1/u,
      `repeat seat ${marker} must push the corrective into the transcript`,
    );
  }
});
