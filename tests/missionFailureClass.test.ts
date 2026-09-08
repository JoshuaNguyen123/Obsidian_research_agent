import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMissionFailureV1,
  isModelContentErrorCodeV1,
  missionFailureRepeatsUsefullyV1,
  type MissionFailureClassV1,
} from "../src/agent/missionFailureClass";
import { ModelClientError } from "../src/model/types";

test("a dead or unreadable remote source is attributed to the source", () => {
  assert.equal(
    classifyMissionFailureV1({
      toolName: "web_fetch",
      errorCode: "source_http_error",
      errorMessage:
        "web_fetch could not retrieve https://example.com/x (status 404).",
    }),
    "external",
  );
  assert.equal(
    classifyMissionFailureV1({
      toolName: "web_fetch",
      errorCode: "source_unusable",
      errorMessage: "no usable passages",
    }),
    "external",
  );
  // A bare message carrying a server status still reads as external.
  assert.equal(
    classifyMissionFailureV1({
      toolName: "web_search",
      errorMessage: "Provider returned status 503 for the search request.",
    }),
    "external",
  );
});

test("provider outages are external, but our own credentials are not", () => {
  assert.equal(
    classifyMissionFailureV1({
      error: new ModelClientError("network", "request timed out after 600000ms"),
    }),
    "external",
  );
  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "network" }),
    "external",
  );
  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "rate_limit" }),
    "external",
  );
  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "api", httpStatus: 500 }),
    "external",
  );

  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "auth" }),
    "product",
  );
  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "missing_api_key" }),
    "product",
  );
  assert.equal(
    classifyMissionFailureV1({ httpStatus: 403, errorMessage: "forbidden" }),
    "product",
  );
});

test("host refusals are product failures, whatever the tool", () => {
  const productCodes = [
    "tool_not_allowed",
    "mission_graph_authority_blocked",
    "unsafe_path",
    "prepared_action_required",
    "vault_precondition_changed",
    "approval_denied",
    "proof_gated_writeback_required",
  ];
  for (const errorCode of productCodes) {
    assert.equal(
      classifyMissionFailureV1({ toolName: "append_to_current_file", errorCode }),
      "product",
      errorCode,
    );
  }
});

test("bad arguments and failed content verification are model_content", () => {
  assert.equal(
    classifyMissionFailureV1({
      toolName: "read_file",
      errorCode: "invalid_arguments",
      errorMessage: "path is required",
    }),
    "model_content",
  );
  assert.equal(
    classifyMissionFailureV1({
      toolName: "create_research_pack",
      errorCode: "research_pack_verification_failed",
    }),
    "model_content",
  );
  // No code at all: the shared safe-failure classifier still recognizes schema
  // shape failures.
  assert.equal(
    classifyMissionFailureV1({
      toolName: "model",
      errorMessage: "tool schema validation failed for the emitted call",
    }),
    "model_content",
  );
});

test("an empty or off-track response is a shape failure, not a content failure", () => {
  assert.equal(
    classifyMissionFailureV1({
      toolName: "model",
      errorMessage: "empty response with no tool calls",
    }),
    "model_transient",
  );
  assert.equal(
    classifyMissionFailureV1({ modelErrorCategory: "invalid_response" }),
    "model_transient",
  );
});

test("unattributable failures stay unknown rather than guessing", () => {
  assert.equal(classifyMissionFailureV1({}), "unknown");
  assert.equal(
    classifyMissionFailureV1({
      toolName: "count_words",
      errorMessage: "something went sideways",
    }),
    "unknown",
  );
});

test("classification never throws on hostile input", () => {
  const hostile: unknown[] = [
    { errorCode: null },
    { errorMessage: 42 },
    { modelErrorCategory: {} },
    { httpStatus: Number.NaN },
    { error: { get name() { throw new Error("boom"); } } },
  ];
  for (const signals of hostile) {
    const result = classifyMissionFailureV1(
      signals as Parameters<typeof classifyMissionFailureV1>[0],
    );
    assert.ok(
      ["external", "model_transient", "model_content", "product", "unknown"]
        .includes(result),
      `unexpected class ${result}`,
    );
  }
});

test("only external and shape failures are worth repeating unchanged", () => {
  const expectations: Array<[MissionFailureClassV1, boolean]> = [
    ["external", true],
    ["model_transient", true],
    ["model_content", false],
    ["product", false],
    ["unknown", false],
  ];
  for (const [failureClass, repeats] of expectations) {
    assert.equal(
      missionFailureRepeatsUsefullyV1(failureClass),
      repeats,
      failureClass,
    );
  }
});

test("a validator that refuses the model's payload is a model-content failure", () => {
  // The live shape: create_project_idea_brief refused a brief the model built
  // out of its own arguments, nothing was applied, and the run was ended by a
  // failure the model could have corrected. The code is the only signal the
  // host gets, so it has to carry the attribution.
  assert.equal(
    classifyMissionFailureV1({
      toolName: "create_project_idea_brief",
      errorCode: "project_idea_brief_invalid",
      errorMessage:
        "Grounding reference 2 does not match its closed contract.",
    }),
    "model_content",
  );
  assert.equal(isModelContentErrorCodeV1("project_idea_brief_invalid"), true);
});

test("a code that names arguments as the fault is recognised in any spelling", () => {
  // The suffix test this replaces knew one word order and one plural, so six
  // validators that had said "argument" in their own names were still read as
  // unattributable. Every code below is a real one in this repo.
  for (const code of [
    "invalid_arguments",
    "linear_issue_template_invalid_arguments",
    "vault_append_invalid_arguments",
    "github_repository_invalid_argument",
    "github_private_repository_cleanup_invalid_argument",
    "linear_queue_vault_arguments_invalid",
    "github_publication_arguments_invalid",
    "git_argument_invalid",
  ]) {
    assert.equal(isModelContentErrorCodeV1(code), true, code);
    assert.equal(
      classifyMissionFailureV1({ errorCode: code }),
      "model_content",
      code,
    );
  }
});

test("a refusal, a permission denial and a not-found never become argument errors", () => {
  // The widening hazard, stated as a test. 106 codes in this repo end in
  // `_invalid` and most are refusals or host state; if any of them started
  // claiming to be a correctable argument fault, the model would be told to
  // resend the same blocked call with tidier arguments and the block would be
  // exempted from the failed-tool count on its first occurrence. Losing
  // recovery for a real refusal is worse than the miss this predicate fixes.
  const mustNotBeArgumentErrors: Array<[string, MissionFailureClassV1]> = [
    // An authority refusal that ends in `_invalid` — the exact code a blanket
    // suffix rule would have swallowed.
    ["authority_grant_invalid", "product"],
    // A not-found from a remote integration.
    ["linear_not_found", "external"],
    ["prepared_action_required", "product"],
    ["mission_graph_authority_blocked", "product"],
    ["approval_denied", "product"],
    // Host-state and readback codes that merely share the `_invalid` suffix.
    ["diff_readback_invalid", "unknown"],
    ["checkpoint_fingerprint_invalid", "unknown"],
    ["vault_root_invalid", "unknown"],
  ];
  for (const [code, expected] of mustNotBeArgumentErrors) {
    assert.equal(isModelContentErrorCodeV1(code), false, code);
    assert.notEqual(
      classifyMissionFailureV1({ errorCode: code }),
      "model_content",
      code,
    );
    assert.equal(classifyMissionFailureV1({ errorCode: code }), expected, code);
  }
});

test("the model-content predicate tolerates absent and hostile codes", () => {
  assert.equal(isModelContentErrorCodeV1(undefined), false);
  assert.equal(isModelContentErrorCodeV1(""), false);
  assert.equal(isModelContentErrorCodeV1("   "), false);
  // Casing and stray whitespace are transport noise, not a different code.
  assert.equal(isModelContentErrorCodeV1("  Invalid_Arguments  "), true);
});
