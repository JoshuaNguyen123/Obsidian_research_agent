import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildInvalidToolCallFailureSignatureV1,
  buildOffFrontierToolRejectionMessage,
  buildProofGatedWritebackHoldV1,
  buildRepeatedInvalidToolCallCorrectiveV1,
  buildToolRejectEvalV1,
  classifyOffFrontierRefusalV1,
  describeOffFrontierToolNearMiss,
  FRONTIER_NARROWED_REFUSAL_CODE_V1,
  FRONTIER_WITHHELD_REFUSAL_CODE_V1,
  invalidToolCallRepeatKeyV1,
  isHostCausedOffFrontierRefusalV1,
  isNameOnlyToolFailureCodeV1,
  isHostNarrowedOffFrontierRefusalV1,
  isHostWithheldOffFrontierRefusalV1,
  looksLikeUnfilledToolNamePlaceholderV1,
  mapToolRejectCategory,
  type ToolRejectCategoryV1,
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
  const ordinaryRefusalAt = runnerSource.indexOf(
    "const offFrontierFacts = classifyOffFrontierRefusalV1({",
    gateAt,
  );
  const nextGateAt = runnerSource.indexOf(
    "const setLooseSoftWriteBypass",
    ordinaryRefusalAt,
  );
  assert.ok(ordinaryRefusalAt > gateAt, "ordinary refusal branch not found");
  assert.ok(nextGateAt > ordinaryRefusalAt, "step-menu gate boundary not found");
  const window = runnerSource.slice(ordinaryRefusalAt, nextGateAt);
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
  // These shapes are pinned so that when this predicate and AgentRunner's
  // `isPlaceholderToolNameV1` (595075e) are collapsed into one, any behavioral
  // difference between them fails here instead of drifting silently.
  for (const placeholder of [
    "$TOOL_NAME",
    "${tool_name}",
    "{{tool}}",
    "<tool_name>",
    "</tool>",
    "tool_name",
    "toolname",
    "your_tool_name",
    "exact tool name",
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

// ---------------------------------------------------------------------------
// pending mission-graph node: a REAL tool that is not ready, not an unknown one
// ---------------------------------------------------------------------------

test("a pending mission-graph node classifies invalid_state, never unknown_tool", () => {
  // The node was located by looking this exact name up in the graph's own
  // allowedTools, so its existence PROVES the tool is real and planned.
  // `unknown_tool` means "the model named a tool that does not exist"; the old
  // arm returned it on the mere presence of a node id, in front of the
  // invalid_state arm, so every authority deferral read as a model naming
  // error (proof-matrix interrupted-continuation, 2026-08-25: 7 consecutive
  // mission_graph_authority_blocked refusals, all category=unknown_tool).
  assert.equal(
    mapToolRejectCategory({
      toolName: "code_commit_verified",
      pendingGraphNodeId: "tool-11-code_commit_verified",
      message: "Tool code_commit_verified is not ready in the authoritative mission graph.",
    }),
    "invalid_state",
  );
  // The exact inputs the step-menu gate builds: a hardcoded "off-frontier"
  // stand-in plus the plan-dependency code. "off-frontier" matches the
  // unknown_tool text arm, so ordering alone decides this one.
  assert.equal(
    mapToolRejectCategory({
      toolName: "code_commit_verified",
      pendingGraphNodeId: "tool-11-code_commit_verified",
      message: "off-frontier",
      code: "plan_dependency_violation",
    }),
    "invalid_state",
  );
});

test("a genuinely unknown tool still classifies unknown_tool", () => {
  // No pending node: the graph reserves no slot for this name at all.
  assert.equal(
    mapToolRejectCategory({
      toolName: "git_commit",
      message: "off-frontier",
      code: "tool_not_allowed",
    }),
    "unknown_tool",
  );
  assert.equal(
    mapToolRejectCategory({
      toolName: "$TOOL_NAME",
      message: "Tool is not available for this prompt",
    }),
    "unknown_tool",
  );
  assert.equal(
    mapToolRejectCategory({ toolName: "verify_all", message: "unknown tool" }),
    "unknown_tool",
  );
});

test("a specific refusal reason still outranks the pending-node default", () => {
  // The node deferral is the DEFAULT diagnosis for a pending node, not an
  // override. A refusal that names a real fault is still that fault.
  assert.equal(
    mapToolRejectCategory({
      toolName: "code_commit_verified",
      pendingGraphNodeId: "tool-11-code_commit_verified",
      message: "Approval denied by the user.",
    }),
    "unauthorized",
  );
  assert.equal(
    mapToolRejectCategory({
      toolName: "append_to_current_file",
      pendingGraphNodeId: "tool-4-append_to_current_file",
      message: "missing required argument: content",
    }),
    "missing_argument",
  );
  assert.equal(
    mapToolRejectCategory({
      toolName: "web_fetch",
      pendingGraphNodeId: "tool-2-web_fetch",
      code: "rate_limit",
    }),
    "rate_limit_or_transient",
  );
});

test("classification without a pending node is unchanged", () => {
  // The specific arms were extracted into one shared predicate so the two
  // paths cannot drift. This pins that the extraction moved no behaviour.
  const cases: Array<[string, ToolRejectCategoryV1]> = [
    ["missing required argument", "missing_argument"],
    ["invalid argument: wrong type", "invalid_argument"],
    ["extra argument supplied", "extra_argument"],
    ["approval expired", "unauthorized"],
    ["ambiguous target note", "ambiguous_target"],
    ["plan_dependency not satisfied", "invalid_state"],
    ["blocked by safety policy", "policy_rejection"],
    ["econnreset while calling provider", "rate_limit_or_transient"],
    ["something nobody has a bucket for", "other"],
  ];
  for (const [message, expected] of cases) {
    assert.equal(
      mapToolRejectCategory({ toolName: "any_tool", message }),
      expected,
      message,
    );
  }
});

test("an authority deferral stops claiming the tool is unavailable", () => {
  // The prose and the category printed one clause apart used to contradict
  // each other: "Tool is not available for this prompt: X category=invalid_state".
  // "not available for this prompt" is also the exact substring the shared
  // refusal vocabulary buckets as "the model named a tool it was never
  // offered", so the false sentence also mis-bucketed the census.
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "append_to_current_file",
    readyFrontierToolNames: ["web_search"],
    reasonMessage:
      "Tool append_to_current_file is not ready in the authoritative mission graph.",
  });
  assert.match(message, /category=invalid_state/u);
  assert.doesNotMatch(message, /not available for this prompt/u);
  assert.match(message, /the name is valid and the call was well-formed/u);
  // A refusal whose own reason says the name is unknown keeps the old text.
  assert.match(
    buildOffFrontierToolRejectionMessage({
      toolName: "git_commit",
      readyFrontierToolNames: ["code_commit_verified"],
      reasonMessage: "unknown tool git_commit",
    }),
    /Tool is not available for this prompt: git_commit/u,
  );
});

// --- Instance #17: the refusal must not name what the authority will refuse --
// Live compound run on main @3860ee6, verbatim:
//
//   step 21  model calls `append_file`; the host refuses AND instructs:
//            "Tool is not available for this prompt: append_file
//             category=unknown_tool
//             Ready frontier tool(s) now: read_current_file,
//             list_markdown_files, read_file, read_template, web_search,
//             web_fetch. Preferred next: read_current_file. Call that exact
//             name."
//   step 22  model obeys EXACTLY and calls `read_current_file`:
//            "code: mission_graph_authority_blocked ... Ready frontier tool(s)
//             now: none. No tool is ready to call; return your best final
//             answer instead."
//
// The step-21 list is `stepAllowedToolNames` — the OFFERED menu, into which
// `constrainToolsToMissionGraphFrontier` unions every read-effect capability
// grant. The authority that judged step 22 reads the graph's ready nodes and
// had none. Two definitions of "ready frontier", one turn apart.

test("an empty authoritative frontier never yields a call directive", () => {
  // The discriminating case. On the unfixed tree `preferredNextTool` was
  // printed verbatim whatever the frontier said, so an empty frontier still
  // produced "Preferred next: read_current_file. Call that exact name." — the
  // step-21 sentence, with the step-22 frontier.
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "append_file",
    readyFrontierToolNames: [],
    preferredNextTool: "read_current_file",
  });
  assert.match(message, /Ready frontier tool\(s\) now: none\./u);
  assert.match(
    message,
    /No tool is ready to call; return your best final answer instead\./u,
  );
  assert.doesNotMatch(message, /Call that exact name/u);
  assert.doesNotMatch(message, /Preferred next:/u);
  // Not one tool name may appear anywhere in the message, near-miss coaching
  // included: a message that names a tool the authority will refuse is the
  // defect, whether it commands the call or merely suggests it.
  for (const name of [
    "read_current_file",
    "list_markdown_files",
    "read_file",
    "read_template",
    "web_search",
    "web_fetch",
    "append_to_current_file",
  ]) {
    assert.doesNotMatch(
      message,
      new RegExp(name, "u"),
      `${name} must not be named when nothing is ready`,
    );
  }
  // Near-miss coaching has an unconditional hedged arm ("use X when listed on
  // the frontier") that fires even for an empty frontier. Hedged or not, it
  // names a tool, and on an empty authoritative frontier there is none to name.
  const coached = buildOffFrontierToolRejectionMessage({
    toolName: "git_commit",
    readyFrontierToolNames: [],
  });
  assert.doesNotMatch(coached, /Near-miss/u);
  assert.doesNotMatch(coached, /code_commit_verified/u);
  assert.match(
    coached,
    /No tool is ready to call; return your best final answer instead\./u,
  );
});

test("a preferred tool the frontier does not list is never commanded", () => {
  // Same invariant one notch weaker: the frontier is non-empty, but the
  // caller's preferred hint came from a different (wider) authority. The
  // message may only command a name it has just listed as ready.
  const message = buildOffFrontierToolRejectionMessage({
    toolName: "append_file",
    readyFrontierToolNames: ["code_commit_verified"],
    preferredNextTool: "read_current_file",
  });
  assert.doesNotMatch(message, /Preferred next: read_current_file/u);
  assert.match(message, /Preferred next: code_commit_verified\./u);
  assert.match(message, /Call that exact name/u);
});

test("the repeated-invalid corrective stays silent when nothing is admissible", () => {
  // The other directive seat. "Either change the arguments, or call one of
  // these exact names instead: ..." is the same order in different words.
  const corrective = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "code_workspace_create_file",
    failureCode: "invalid_arguments",
    readyFrontierToolNames: [],
  });
  assert.match(corrective, /No other tool is ready/u);
  assert.doesNotMatch(corrective, /call one of these exact names/u);
});

test("the step-menu refusal seat reads the authority, not the offered menu", () => {
  // Source-level guard, same convention as the predicate guard above: the
  // behavioural assertions cannot see which list the runner hands the builder,
  // and handing it `stepAllowedToolNames` is exactly the bug. `liveReadyTool-
  // Names` must KEEP reading the offered menu — that argument answers "did the
  // host's own menu change?", a different question from "what will authority
  // admit?", and pointing it at the graph would silently reclassify every
  // capability-read refusal as menu decay.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const gateAt = runnerSource.indexOf(
    "if (!stepAllowedToolNames.has(toolCall.name)) {",
  );
  assert.ok(gateAt > 0, "step-menu gate not found");
  const ordinaryRefusalAt = runnerSource.indexOf(
    "const offFrontierFacts = classifyOffFrontierRefusalV1({",
    gateAt,
  );
  const nextGateAt = runnerSource.indexOf(
    "const setLooseSoftWriteBypass",
    ordinaryRefusalAt,
  );
  assert.ok(ordinaryRefusalAt > gateAt, "ordinary refusal branch not found");
  assert.ok(nextGateAt > ordinaryRefusalAt, "step-menu gate boundary not found");
  const window = runnerSource.slice(ordinaryRefusalAt, nextGateAt);
  assert.match(window, /authoritativeRefusalFrontierToolNamesV1\(\{/u);
  assert.match(window, /readyFrontierToolNames: authoritativeRejectFrontier/u);
  assert.match(window, /readyFrontier: authoritativeRejectFrontier/u);
  assert.match(window, /liveReadyToolNames: \[\.\.\.stepAllowedToolNames\]/u);
  // The refused name itself must never be advertised back at the model.
  assert.match(window, /excludeToolNames: \[toolCall\.name\]/u);
  // The offered menu must not reach any of the three message-facing fields.
  assert.doesNotMatch(
    window,
    /readyFrontierToolNames: \[\.\.\.stepAllowedToolNames\]/u,
    "the refusal message must not advertise the offered menu",
  );
  assert.doesNotMatch(
    window,
    /readyFrontier: \[\.\.\.stepAllowedToolNames\]/u,
    "the eval record must not report the offered menu as the frontier",
  );
});

test("every message seat that names a tool consumes the one shared predicate", () => {
  // Four seats can put a tool name in front of the model as something to call
  // next. All four must read the same authority; a fifth copy is how this
  // repo's recurring failure reproduces.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const consumers = runnerSource.match(
    /authoritativeRefusalFrontierToolNamesV1\(\{/gu,
  );
  assert.ok(
    consumers && consumers.length >= 6,
    `expected every naming seat to consume the shared predicate, saw ${
      consumers?.length ?? 0
    }`,
  );
  // No seat may hand the model a menu straight from the offered catalog or the
  // step menu. These are the exact shapes that shipped the contradiction.
  assert.doesNotMatch(
    runnerSource,
    /Choose one exact name from: \$\{tools\.map\(/u,
    "the schema correction must not offer the whole catalog as callable",
  );
  // pickPreferredNextTool is pure ordering over whatever list it is handed, so
  // the routing card's `preferredNext` is only as honest as its input.
  const authorityAt = runnerSource.indexOf(
    "const authoritativeOfferedToolNames =",
  );
  assert.ok(authorityAt > 0, "routing-card authority list not found");
  const cardAt = runnerSource.indexOf(
    "const preferredNext = pickPreferredNextTool({",
    authorityAt,
  );
  assert.ok(cardAt > authorityAt, "routing-card preferredNext not found");
  assert.match(
    runnerSource.slice(authorityAt, cardAt),
    /authoritativeRefusalFrontierToolNamesV1\(\{/u,
  );
  assert.match(
    runnerSource.slice(cardAt, cardAt + 400),
    /readyFrontierToolNames: authoritativeOfferedToolNames,/u,
  );
  // OFFER-side half. This guard used to pin the residual instead: the card's
  // `offered:` list stayed the raw step menu, on the reasoning that narrowing
  // what the model MAY call has a different blast radius. It still does -- and
  // this is not that change. `stepTools` is untouched, so every schema stays
  // callable; only the card's TEXT narrows. That matters because the header
  // over it says "authoritative; call only listed tools", which promises
  // callability the raw menu could not keep on a set-loose run over an exact
  // planned frontier. The list is now the authority-admitted intersection, and
  // the header claims authority only when it is (fail-closed: an empty
  // intersection falls back to the raw menu AND drops the claim, because an
  // empty "call only listed tools" directive is a deadlock, not a truth).
  const cardBody = runnerSource.slice(cardAt, cardAt + 1400);
  assert.match(
    cardBody,
    /offeredToolLines: buildOfferedToolLines\(\{\s*readyFrontierToolNames: offeredToolsAreAuthoritative\s*\?\s*authoritativeOfferedToolNames\s*:\s*readyToolNames,/u,
  );
  assert.match(cardBody, /offeredToolsAreAuthoritative,/u);
});
// ---------------------------------------------------------------------------
// Name-only refusal signatures.
//
// Measured cause (2026-08-27 census; all 39 `tool_not_allowed` came from one
// lane): every recovered refusal named a REAL product tool, at call index 0,
// against an authoritative frontier holding 0-1 tools -- and the same name came
// back step after step because the repeat guard keyed its signature on the
// arguments the step-menu gate never read.
// ---------------------------------------------------------------------------

test("a name-only refusal ignores the arguments, so varied retries collide", () => {
  // The exact live shape: interrupted-continuation refused
  // `append_to_current_file` at steps 1, 2, 4, 5, 6, 8 and 9 of one run. The
  // model varied the content it tried to append every time, so an
  // argument-keyed signature was fresh on every attempt and
  // `repeated_invalid_tool_call` never fired.
  const first = buildInvalidToolCallFailureSignatureV1({
    toolName: "append_to_current_file",
    failureCode: "tool_not_allowed",
    argumentsSignature: JSON.stringify({ content: "first reflection draft" }),
  });
  const second = buildInvalidToolCallFailureSignatureV1({
    toolName: "append_to_current_file",
    failureCode: "tool_not_allowed",
    argumentsSignature: JSON.stringify({ content: "a totally different draft" }),
  });
  assert.equal(first, second, "the same refused name must be one signature");
  assert.doesNotMatch(
    first,
    /reflection draft/u,
    "arguments must not appear in a name-only signature",
  );
  // ...and it must still separate two DIFFERENT names, or the guard would
  // block a name the model has only just started getting wrong.
  assert.notEqual(
    first,
    buildInvalidToolCallFailureSignatureV1({
      toolName: "create_file",
      failureCode: "tool_not_allowed",
      argumentsSignature: JSON.stringify({ content: "first reflection draft" }),
    }),
  );
  // ...and two different CODES for one name stay distinct, so a name later
  // refused for a real reason still earns its own first-failure teaching.
  assert.notEqual(
    first,
    buildInvalidToolCallFailureSignatureV1({
      toolName: "append_to_current_file",
      failureCode: "invalid_arguments",
      argumentsSignature: JSON.stringify({ content: "first reflection draft" }),
    }),
  );
});

test("genuine argument faults stay argument-keyed", () => {
  // The other half of the discrimination. `invalid_arguments` and
  // `workspace_not_found` ARE decided by the arguments, so a corrected call
  // must read as a new failure and earn its own schema correction rather than
  // being blocked as a repeat.
  for (const failureCode of ["invalid_arguments", "workspace_not_found"]) {
    assert.equal(isNameOnlyToolFailureCodeV1(failureCode), false, failureCode);
    assert.notEqual(
      buildInvalidToolCallFailureSignatureV1({
        toolName: "code_validate_fast",
        failureCode,
        argumentsSignature: JSON.stringify({ workspaceId: "ws-typo" }),
      }),
      buildInvalidToolCallFailureSignatureV1({
        toolName: "code_validate_fast",
        failureCode,
        argumentsSignature: JSON.stringify({ workspaceId: "ws-correct" }),
      }),
      failureCode + " must keep its arguments in the signature",
    );
  }
});

test("plan_dependency_violation is deliberately NOT name-only", () => {
  // A deferred node EXISTS and is merely not ready yet, so the identical call
  // can legitimately succeed once its dependency completes. Name-keying it
  // would blocklist a call the graph is about to authorise. Observed live in
  // the compound lane as `create_project_idea_brief` deferred at steps 4 and 6
  // -- a real loop, but one whose cure is dependency ordering, not a name ban.
  assert.equal(isNameOnlyToolFailureCodeV1("plan_dependency_violation"), false);
  assert.equal(
    invalidToolCallRepeatKeyV1("plan_dependency_violation"),
    "arguments",
  );
  // The host-caused frontier drift codes are likewise excluded: they carry
  // their own "the menu changed" coaching and are not the model's error.
  assert.equal(
    isNameOnlyToolFailureCodeV1(FRONTIER_NARROWED_REFUSAL_CODE_V1),
    false,
  );
  assert.equal(
    isNameOnlyToolFailureCodeV1(FRONTIER_WITHHELD_REFUSAL_CODE_V1),
    false,
  );
  assert.equal(isNameOnlyToolFailureCodeV1(null), false);
  assert.equal(isNameOnlyToolFailureCodeV1(""), false);
  // Both name-only codes, and the key they select.
  assert.equal(isNameOnlyToolFailureCodeV1("tool_not_allowed"), true);
  assert.equal(isNameOnlyToolFailureCodeV1("unknown_tool"), true);
  assert.equal(invalidToolCallRepeatKeyV1("tool_not_allowed"), "name");
  assert.equal(invalidToolCallRepeatKeyV1("unknown_tool"), "name");
});

test("a name-keyed repeat corrective never blames the arguments", () => {
  const nameKeyed = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "append_to_current_file",
    failureCode: "tool_not_allowed",
    readyFrontierToolNames: ["web_search", "read_current_file"],
    repeatKey: "name",
  });
  // The two attempts carried DIFFERENT arguments, so the historical sentence
  // would be a plain falsehood, and its remedy would advise the one move that
  // provably cannot work.
  assert.doesNotMatch(nameKeyed, /same arguments failed twice/u);
  assert.doesNotMatch(nameKeyed, /change the arguments/u);
  assert.match(nameKeyed, /refused twice \(tool_not_allowed\)/u);
  assert.match(nameKeyed, /decided by the name alone/u);
  assert.match(
    nameKeyed,
    /Call one of these exact names instead: web_search, read_current_file\./u,
  );
  // The blocked tool must never be advertised back as its own alternative.
  assert.doesNotMatch(nameKeyed, /instead: [^.]*append_to_current_file/u);

  // Empty authoritative frontier -- the measured case -- must name the exit
  // rather than leaving the model with no legal move.
  const stranded = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "append_to_current_file",
    failureCode: "tool_not_allowed",
    readyFrontierToolNames: [],
    repeatKey: "name",
  });
  assert.match(stranded, /No other tool is ready\./u);
  assert.match(
    stranded,
    /Return your best final answer and state in one sentence that append_to_current_file could not be completed\./u,
  );
  assert.doesNotMatch(stranded, /change the arguments/u);
});

test("the argument-keyed corrective is unchanged when no repeatKey is given", () => {
  // Default must stay byte-identical to the historical wording: this change
  // adds an arm, it does not reword the existing one.
  const explicit = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "code_validate_fast",
    failureCode: "workspace_not_found",
    readyFrontierToolNames: ["code_workspace_create"],
    repeatKey: "arguments",
  });
  const defaulted = buildRepeatedInvalidToolCallCorrectiveV1({
    toolName: "code_validate_fast",
    failureCode: "workspace_not_found",
    readyFrontierToolNames: ["code_workspace_create"],
  });
  assert.equal(defaulted, explicit);
  assert.match(defaulted, /the same arguments failed twice/u);
  assert.match(defaulted, /Do not repeat this exact call\./u);
});

test("AgentRunner mints every repeat signature through the shared builder", () => {
  // Source-level single-authority guard. The bug this fixes was two seats
  // disagreeing about what "the same failure" means: the step-menu gate
  // refused on the NAME while the repeat guard remembered name + arguments.
  // Re-inlining a template literal here would silently restore it.
  const runnerSource = readFileSync(
    new URL("../src/AgentRunner.ts", import.meta.url),
    "utf8",
  );
  const seats =
    runnerSource.match(/buildInvalidToolCallFailureSignatureV1\(\{/gu) ?? [];
  assert.equal(
    seats.length,
    2,
    "both repeat-signature seats must call the shared builder",
  );
  // No seat may rebuild the signature by hand.
  assert.doesNotMatch(
    runnerSource,
    /\$\{toolCall\.name\}:\$\{failureCode\}:\$\{stableStringify/u,
    "the argument-keyed signature must not be re-inlined",
  );
  assert.doesNotMatch(
    runnerSource,
    /\$\{toolCall\.name\}:invalid_arguments:\$\{stableStringify/u,
    "the literal-contract seat must not re-inline its signature either",
  );
  // The corrective must be told which key caught the repeat, or it reverts to
  // claiming the arguments matched.
  assert.match(
    runnerSource,
    /repeatKey: invalidToolCallRepeatKeyV1\(failureCode\)/u,
  );
});

test("the observed seven-refusal loop collapses to one signature", () => {
  // Arithmetic on REAL data, not a projection. A recovered run refused
  // `append_to_current_file` at steps 1,2,4,5,6,8,9 -- seven events for one
  // name, because the model varied its arguments each time and the
  // argument-keyed signature minted a fresh identity on every attempt.
  //
  // The node is ELEVEN in the plan, so no admissible frontier widening could
  // have admitted it; the only available saving is to stop re-issuing it.
  const observedAttempts = [
    { path: "Notes/a.md", content: "first" },
    { path: "Notes/a.md", content: "second attempt" },
    { path: "Notes/b.md", content: "third" },
    { path: "Notes/b.md", content: "fourth", mode: "append" },
    { path: "Notes/c.md", content: "fifth" },
    { path: "Notes/c.md", content: "sixth", heading: "## Notes" },
    { path: "Notes/d.md", content: "seventh" },
  ].map((value) => JSON.stringify(value));
  const signatures = new Set(
    observedAttempts.map((args) =>
      buildInvalidToolCallFailureSignatureV1({
        toolName: "append_to_current_file",
        failureCode: "tool_not_allowed",
        argumentsSignature: args,
      }),
    ),
  );
  // One name, one signature -- so the repeat guard fires on the SECOND event
  // and the remaining five are never issued.
  assert.equal(
    signatures.size,
    1,
    "seven argument spellings of one refused name must collapse to one signature",
  );

  // The contrast that proves this is not blanket suppression: a genuine
  // argument fault keeps its arguments, so seven distinct argument faults stay
  // seven distinct signatures and each still gets its own correction.
  const argumentFaults = new Set(
    observedAttempts.map((args) =>
      buildInvalidToolCallFailureSignatureV1({
        toolName: "code_workspace_read",
        failureCode: "invalid_arguments",
        argumentsSignature: args,
      }),
    ),
  );
  assert.ok(
    argumentFaults.size > 1,
    "argument faults must stay argument-keyed so the model can correct them",
  );
});
