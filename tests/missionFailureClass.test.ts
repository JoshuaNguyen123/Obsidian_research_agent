import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyMissionFailureV1,
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
