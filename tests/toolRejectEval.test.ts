import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildOffFrontierToolRejectionMessage,
  buildProofGatedWritebackHoldV1,
  buildRepeatedInvalidToolCallCorrectiveV1,
  buildToolRejectEvalV1,
  classifyOffFrontierRefusalV1,
  describeOffFrontierToolNearMiss,
  FRONTIER_NARROWED_REFUSAL_CODE_V1,
  isHostCausedOffFrontierRefusalV1,
  isHostNarrowedOffFrontierRefusalV1,
  isHostWithheldOffFrontierRefusalV1,
  looksLikeUnfilledToolNamePlaceholderV1,
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

// --- Off-frontier refusal provenance -------------------------------------
// AgentRunner clears and rebuilds `stepAllowedToolNames` after every committed
// call in a multi-call response (src/AgentRunner.ts, the `toolIndex > 0`
// refresh). Calls 2..N are therefore validated against a menu that changed
// AFTER the model answered. Before this predicate existed, such a refusal was
// recorded as `tool_not_allowed` -- the bucket that means the model named a
// tool it was never offered -- so the census could not tell the two apart.

test("a name never offered at step start stays attributed to the model", () => {
  const facts = classifyOffFrontierRefusalV1({
    toolName: "git_commit",
    offeredAtStepStartToolNames: ["web_search", "web_fetch"],
    liveReadyToolNames: ["web_search"],
    responseCallIndex: 2,
    responseCallCount: 3,
  });
  assert.equal(facts.offeredAtStepStart, false);
  assert.equal(facts.provenance, "model_named_unoffered_tool");
  assert.equal(isHostNarrowedOffFrontierRefusalV1(facts), false);
});

test("a name offered at step start and refused later in the SAME response is host-caused", () => {
  const facts = classifyOffFrontierRefusalV1({
    toolName: "create_folder",
    offeredAtStepStartToolNames: ["create_folder", "create_file", "read_file"],
    liveReadyToolNames: ["create_file", "read_file"],
    responseCallIndex: 1,
    responseCallCount: 3,
  });
  assert.equal(facts.offeredAtStepStart, true);
  assert.equal(facts.provenance, "host_narrowed_mid_response");
  assert.equal(isHostNarrowedOffFrontierRefusalV1(facts), true);
  assert.equal(facts.responseCallIndex, 1);
  assert.equal(facts.responseCallCount, 3);
  // The census needs to see WHAT the rebuild took away, not just that one
  // name is missing.
  assert.deepEqual(facts.droppedSinceStepStart, ["create_folder"]);
});

test("index 0 can never be blamed on a mid-response rebuild", () => {
  // The rebuild only runs for toolIndex > 0, so a first-call refusal of an
  // offered name would mean the offered menu and the validating menu already
  // disagreed. That is its own finding and must not be folded into either of
  // the other two buckets.
  const facts = classifyOffFrontierRefusalV1({
    toolName: "create_folder",
    offeredAtStepStartToolNames: ["create_folder"],
    liveReadyToolNames: [],
    responseCallIndex: 0,
    responseCallCount: 1,
  });
  assert.equal(facts.provenance, "host_narrowed_before_first_call");
  assert.equal(isHostNarrowedOffFrontierRefusalV1(facts), false);
});

test("host-narrowed refusals classify as frontier_narrowed, never unknown_tool", () => {
  // `unknown_tool` is the category for a name the model invented. Applying it
  // to a name the host itself listed in the menu is the misattribution this
  // seat exists to end.
  assert.equal(
    mapToolRejectCategory({
      toolName: "create_folder",
      code: FRONTIER_NARROWED_REFUSAL_CODE_V1,
    }),
    "frontier_narrowed",
  );
});

test("the host-narrowed refusal code is disjoint from the tool_not_allowed bucket", () => {
  // The shared refusal vocabulary buckets by substring. A code containing
  // "tool_not_allowed" would keep inflating the very bucket it is meant to
  // drain, and the census split would silently be a no-op.
  assert.doesNotMatch(FRONTIER_NARROWED_REFUSAL_CODE_V1, /tool_not_allowed/u);
});

test("the rejection message tells a host-narrowed model the truth", () => {
  const facts = classifyOffFrontierRefusalV1({
    toolName: "create_folder",
    offeredAtStepStartToolNames: ["create_folder", "create_file"],
    liveReadyToolNames: ["create_file"],
    responseCallIndex: 1,
    responseCallCount: 3,
  });
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "create_folder",
    readyFrontierToolNames: ["create_file"],
    preferredNextTool: "create_file",
    offFrontier: facts,
  });
  // The old text claimed the tool was "not available for this prompt". The
  // model had just been offered it, so that sentence is false and invites a
  // retry loop against a contradiction the model cannot resolve.
  assert.doesNotMatch(message, /not available for this prompt/u);
  assert.match(message, /WAS offered at the start of this step/u);
  assert.match(message, /call 2 of 3/u);
  assert.match(message, /category=frontier_narrowed/u);
  assert.match(message, /Nothing was executed for this call/u);
  assert.match(message, /do not re-issue this call in this turn/u);
});

test("near-miss name coaching is withheld when the name was already correct", () => {
  // describeOffFrontierToolNearMiss teaches "you invented a name, use this one
  // instead". For a host-narrowed refusal the name was right, so the coaching
  // is not merely useless -- it is false teaching.
  const narrowed = buildOffFrontierToolRejectionMessage({
    toolName: "git_commit",
    readyFrontierToolNames: ["code_commit_verified"],
    offFrontier: classifyOffFrontierRefusalV1({
      toolName: "git_commit",
      offeredAtStepStartToolNames: ["git_commit", "code_commit_verified"],
      liveReadyToolNames: ["code_commit_verified"],
      responseCallIndex: 1,
      responseCallCount: 2,
    }),
  });
  assert.doesNotMatch(narrowed, /Near-miss/u);
  // Model-side naming errors keep the coaching they have always had.
  const invented = buildOffFrontierToolRejectionMessage({
    toolName: "git_commit",
    readyFrontierToolNames: ["code_commit_verified"],
    offFrontier: classifyOffFrontierRefusalV1({
      toolName: "git_commit",
      offeredAtStepStartToolNames: ["code_commit_verified"],
      liveReadyToolNames: ["code_commit_verified"],
      responseCallIndex: 0,
      responseCallCount: 1,
    }),
  });
  assert.match(invented, /Near-miss/u);
});

test("the eval record carries the provenance the census needs", () => {
  const record = buildToolRejectEvalV1({
    userIntentExcerpt: "Create two folders",
    selectedTool: "create_folder",
    errorCategory: "frontier_narrowed",
    readyFrontier: ["create_file"],
    offFrontier: classifyOffFrontierRefusalV1({
      toolName: "create_folder",
      offeredAtStepStartToolNames: ["create_folder", "create_file"],
      liveReadyToolNames: ["create_file"],
      responseCallIndex: 1,
      responseCallCount: 3,
    }),
  });
  assert.equal(record.offFrontier?.offeredAtStepStart, true);
  assert.equal(record.offFrontier?.responseCallIndex, 1);
  assert.equal(record.offFrontier?.responseCallCount, 3);
  assert.equal(record.offFrontier?.provenance, "host_narrowed_mid_response");
  // The status line is JSON-serialized onto onStatus; the facts must survive.
  const roundTripped = JSON.parse(JSON.stringify(record));
  assert.equal(roundTripped.offFrontier.provenance, "host_narrowed_mid_response");
});

test("the runner's step-menu gate consumes the shared predicate, not a private copy", () => {
  // This codebase's recurring failure is a second copy of a shared classifier
  // drifting from the original. The gate must call the predicate.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const gateAt = runnerSource.indexOf(
    "if (!stepAllowedToolNames.has(toolCall.name)) {",
  );
  assert.ok(gateAt > 0, "step-menu gate not found");
  const window = runnerSource.slice(gateAt, gateAt + 6600);
  assert.match(window, /classifyOffFrontierRefusalV1\(\{/u);
  assert.match(window, /isHostNarrowedOffFrontierRefusalV1\(/u);
  assert.match(window, /FRONTIER_NARROWED_REFUSAL_CODE_V1/u);
  // The step-start menu is `stepTools`; reading the LIVE set here would make
  // offeredAtStepStart trivially false and the instrumentation a lie.
  assert.match(window, /offeredAtStepStartToolNames: stepTools\.map\(/u);
  assert.match(window, /liveReadyToolNames: \[\.\.\.stepAllowedToolNames\]/u);
  // The facts must reach the trace structurally, not only inside prose.
  assert.match(window, /outputPreview: \{ offFrontier: offFrontierFacts \}/u);
});

// --- The four diagnoses behind one bucket ---------------------------------
// `tool_not_allowed` was ~59% of live refusals and nominally meant "the model
// named a tool it was never offered". It actually held at least four
// populations with four different fixes. These tests pin the split.

test("an unfilled function-calling template is a formatting failure, not a misselection", () => {
  // Observed live: a model emitted a call literally named `$TOOL_NAME`. It did
  // not choose the wrong tool -- it failed to substitute into its own
  // template. Counting that as wrong-tool-selection hides a formatting bug.
  for (const placeholder of [
    "$TOOL_NAME",
    "${tool_name}",
    "{{tool}}",
    "<tool_name>",
    "[TOOL]",
    "tool_name",
    "function_name",
  ]) {
    assert.equal(
      looksLikeUnfilledToolNamePlaceholderV1(placeholder),
      true,
      `${placeholder} should read as an unfilled placeholder`,
    );
  }
  // Real names -- including plausible-but-wrong ones -- must never be
  // reclassified as placeholders; genuine misselection is its own diagnosis.
  for (const real of [
    "web_fetch",
    "append_to_current_file",
    "git_commit",
    "create_repo",
    "code_workspace_write_expected",
  ]) {
    assert.equal(
      looksLikeUnfilledToolNamePlaceholderV1(real),
      false,
      `${real} must not read as a placeholder`,
    );
  }
  assert.equal(looksLikeUnfilledToolNamePlaceholderV1(""), false);
  assert.equal(looksLikeUnfilledToolNamePlaceholderV1(null), false);

  const facts = classifyOffFrontierRefusalV1({
    toolName: "$TOOL_NAME",
    offeredAtStepStartToolNames: ["web_fetch", "web_search"],
    liveReadyToolNames: ["web_fetch", "web_search"],
    responseCallIndex: 0,
    responseCallCount: 1,
  });
  assert.equal(facts.provenance, "model_emitted_placeholder_name");
  // Model-side, so not host-caused -- the host/model split must stay honest.
  assert.equal(isHostCausedOffFrontierRefusalV1(facts), false);
});

test("a tool offered in an EARLIER step and withheld since is host-caused menu decay", () => {
  // The model was taught `append_to_current_file` at steps 1-4 and kept
  // pursuing it at step 6 after the host stopped offering it. Its selection
  // was correct at the moment it learned it.
  const facts = classifyOffFrontierRefusalV1({
    toolName: "append_to_current_file",
    offeredAtStepStartToolNames: ["web_search"],
    liveReadyToolNames: ["web_search"],
    responseCallIndex: 0,
    responseCallCount: 1,
    lastOfferedAtStep: 4,
    withheldBy: "proof_gate_containment: withheld after repeated proof-gated rejections",
  });
  assert.equal(facts.provenance, "host_withheld_since_earlier_step");
  assert.equal(facts.offeredInEarlierStep, true);
  assert.equal(facts.lastOfferedAtStep, 4);
  assert.match(String(facts.withheldBy), /proof_gate_containment/u);
  assert.equal(isHostWithheldOffFrontierRefusalV1(facts), true);
  assert.equal(isHostCausedOffFrontierRefusalV1(facts), true);
  // It is NOT the mid-response class: nothing about this response narrowed
  // the menu, and conflating the two would point at the wrong fix.
  assert.equal(isHostNarrowedOffFrontierRefusalV1(facts), false);
});

test("menu decay outranks the placeholder reading for a real name", () => {
  // A name the run once offered is a real tool, so even a placeholder-shaped
  // one is decay, not a template slip.
  const facts = classifyOffFrontierRefusalV1({
    toolName: "tool_name",
    offeredAtStepStartToolNames: [],
    liveReadyToolNames: [],
    responseCallIndex: 0,
    responseCallCount: 1,
    lastOfferedAtStep: 2,
  });
  assert.equal(facts.provenance, "host_withheld_since_earlier_step");
});

test("a withheld-tool refusal says the menu changed and why", () => {
  // "Not available for this prompt", after four steps of offering it, is
  // actively misleading: it reads as "you invented this name".
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "append_to_current_file",
    readyFrontierToolNames: ["web_search"],
    preferredNextTool: "web_search",
    offFrontier: classifyOffFrontierRefusalV1({
      toolName: "append_to_current_file",
      offeredAtStepStartToolNames: ["web_search"],
      liveReadyToolNames: ["web_search"],
      responseCallIndex: 0,
      responseCallCount: 1,
      lastOfferedAtStep: 4,
      withheldBy:
        "proof_gate_containment: withheld after repeated proof-gated rejections",
    }),
  });
  assert.doesNotMatch(message, /not available for this prompt/u);
  assert.match(message, /THE MENU CHANGED/u);
  assert.match(message, /offered at step 4 of this run/u);
  assert.match(message, /category=frontier_withheld/u);
  assert.match(message, /Reason: proof_gate_containment/u);
  assert.match(message, /Your name selection was correct when you learned it/u);
});

test("a placeholder refusal is not told to pick a different tool name", () => {
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "$TOOL_NAME",
    readyFrontierToolNames: ["web_fetch"],
    preferredNextTool: "web_fetch",
    offFrontier: classifyOffFrontierRefusalV1({
      toolName: "$TOOL_NAME",
      offeredAtStepStartToolNames: ["web_fetch"],
      liveReadyToolNames: ["web_fetch"],
      responseCallIndex: 0,
      responseCallCount: 1,
    }),
  });
  assert.match(message, /unfilled template placeholder, not a tool name/u);
  assert.match(message, /category=placeholder_tool_name/u);
  // The frontier listing and the call directive still stand: the model needs
  // the literal name to substitute.
  assert.match(message, /Ready frontier tool\(s\) now: web_fetch\./u);
});

test("the four classes are mutually exclusive over the same refusal inputs", () => {
  // One refusal, one diagnosis. If two classes could claim the same event the
  // census would double-count and the split would not add up.
  const cases = [
    {
      label: "mid-response narrowing",
      input: {
        toolName: "create_folder",
        offeredAtStepStartToolNames: ["create_folder"],
        liveReadyToolNames: [],
        responseCallIndex: 1,
        responseCallCount: 2,
      },
      expected: "host_narrowed_mid_response",
    },
    {
      label: "cross-step decay",
      input: {
        toolName: "append_to_current_file",
        offeredAtStepStartToolNames: ["web_search"],
        liveReadyToolNames: ["web_search"],
        responseCallIndex: 0,
        responseCallCount: 1,
        lastOfferedAtStep: 4,
      },
      expected: "host_withheld_since_earlier_step",
    },
    {
      label: "placeholder",
      input: {
        toolName: "$TOOL_NAME",
        offeredAtStepStartToolNames: ["web_search"],
        liveReadyToolNames: ["web_search"],
        responseCallIndex: 0,
        responseCallCount: 1,
      },
      expected: "model_emitted_placeholder_name",
    },
    {
      label: "genuine misselection",
      input: {
        toolName: "git_commit",
        offeredAtStepStartToolNames: ["web_search"],
        liveReadyToolNames: ["web_search"],
        responseCallIndex: 0,
        responseCallCount: 1,
      },
      expected: "model_named_unoffered_tool",
    },
  ] as const;
  const seen = new Set<string>();
  for (const testCase of cases) {
    const facts = classifyOffFrontierRefusalV1({ ...testCase.input });
    assert.equal(facts.provenance, testCase.expected, testCase.label);
    assert.equal(seen.has(facts.provenance), false, `${testCase.label} duplicated`);
    seen.add(facts.provenance);
  }
  assert.equal(seen.size, 4);
});

test("the runner records the offered-menu history the decay class depends on", () => {
  // Without a per-run history of what was offered when, `offeredAtStepStart`
  // alone cannot separate decay from a name that was never offered at all --
  // both look like "not on this step's menu".
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  assert.match(runnerSource, /const offeredToolNameLastStep = new Map<string, number>\(\);/u);
  assert.match(
    runnerSource,
    /const toolMenuWithholdReasonByTool = new Map<string, string>\(\);/u,
  );
  // History is written once the step menu is FINAL, after every withholding
  // transform, or it would record tools the model was never shown.
  const historyAt = runnerSource.indexOf("offeredToolNameLastStep.set(name, step)");
  const menuAt = runnerSource.indexOf(
    "const stepAllowedToolNames = new Set(",
  );
  assert.ok(menuAt > 0 && historyAt > menuAt);
  // Both known withholders name themselves, so the refusal can say why.
  assert.match(runnerSource, /"proof_gate_containment: /u);
  assert.match(runnerSource, /`phase_menu_ceiling: /u);
});
