import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  blockedSummaryFromFactsV1,
  buildRunFailureEvidenceV1,
  formatToolArgumentsPreviewV1,
  isRunFailureDiagnosticTraceV1,
  narrativeBlamesTheModelV1,
  reframeBlockedWhyV1,
  runFailureEvidenceHeadingV1,
} from "../src/ui/runFailureEvidence";

function keys(facts: readonly { key: string }[]): string[] {
  return facts.map((fact) => fact.key);
}

function valueFor(
  facts: readonly { key: string; value: string }[],
  key: string,
): string {
  const fact = facts.find((candidate) => candidate.key === key);
  assert.ok(fact, `expected a ${key} fact, got ${keys(facts).join(", ")}`);
  return fact.value;
}

describe("run failure evidence", () => {
  it("returns nothing when the run left no artifacts behind", () => {
    assert.deepEqual(buildRunFailureEvidenceV1({ stopDetail: "It failed." }), []);
    assert.deepEqual(
      buildRunFailureEvidenceV1({
        blocker: { code: "none", message: "none", requiredAction: "none" },
        activeNodeId: "none",
      }),
      [],
    );
  });

  it("leads with the blocker code, then the tool call that failed", () => {
    const facts = buildRunFailureEvidenceV1({
      blocker: {
        code: "path_exists",
        message: "main.py already exists",
        requiredAction: "read it, then write_expected",
      },
      activeNodeId: "node-create-file",
      lastToolFailure: {
        name: "code_workspace_create_file",
        step: 7,
        errorCode: "path_exists",
        errorMessage: "Path already exists: main.py",
        args: { path: "main.py", createFolders: false },
      },
    });
    assert.equal(keys(facts)[0], "blocker_code");
    assert.equal(keys(facts)[1], "failed_tool");
    assert.match(
      valueFor(facts, "failed_tool"),
      /code_workspace_create_file\(path="main\.py", createFolders=false\) \(step 7\)/,
    );
    assert.match(
      valueFor(facts, "failed_tool_error"),
      /path_exists — Path already exists: main\.py/,
    );
    assert.equal(valueFor(facts, "stalled_node"), "node-create-file");
  });

  it("names a one-tool frontier, because that is a different bug from a stalled model", () => {
    const facts = buildRunFailureEvidenceV1({
      stopDetail:
        "Blocked: the model twice returned no tool call against the same unchanged executable frontier. Retry with a tool-compliant model or continue after changing the frontier.",
      diagnostics: [
        {
          id: "model-tool-noncompliance-9",
          code: "model_tool_noncompliance",
          message: "the model twice returned no tool call",
          detail: {
            code: "model_tool_noncompliance",
            rejectedFrontier: ["code_workspace_create_file"],
            attempts: 2,
          },
        },
      ],
    });
    assert.equal(valueFor(facts, "offered_frontier"), "code_workspace_create_file");
    const frontier = facts.find((fact) => fact.key === "offered_frontier");
    assert.equal(frontier?.label, "Only legal tool call");
  });

  it("counts a wider frontier instead of implying there was only one option", () => {
    const facts = buildRunFailureEvidenceV1({
      diagnostics: [
        {
          id: "model-tool-noncompliance-3",
          detail: { rejectedFrontier: ["read_file", "append_to_current_file"] },
        },
      ],
    });
    const frontier = facts.find((fact) => fact.key === "offered_frontier");
    assert.equal(frontier?.label, "Tools the model was allowed (2)");
    assert.equal(frontier?.value, "read_file, append_to_current_file");
  });

  it("surfaces an attested refusal by the reason in its trace id", () => {
    // cc9f06e attested this trace specifically so the precondition that
    // refused the replan becomes readable instead of invisible.
    const facts = buildRunFailureEvidenceV1({
      diagnostics: [
        {
          id: "node-7:create-file-collision-replan-failed",
          message: "collision replan precondition refused: frontier is pinned",
        },
      ],
    });
    const refusal = facts.find((fact) => fact.key.startsWith("refusal:"));
    assert.ok(refusal, "expected the attested refusal to surface");
    assert.match(refusal.value, /create-file-collision-replan-failed/);
    assert.match(refusal.value, /frontier is pinned/);
  });

  it("caps how many refusals it shows so the newest stays visible", () => {
    const facts = buildRunFailureEvidenceV1({
      diagnostics: Array.from({ length: 9 }, (_, index) => ({
        id: `node-${index}:rejected`,
        code: `reason_${index}`,
        message: `refusal ${index}`,
      })),
    });
    const refusals = facts.filter((fact) => fact.key.startsWith("refusal:"));
    assert.equal(refusals.length, 3);
    assert.match(refusals[0].value, /reason_0/);
  });

  it("reports long tool arguments by size, never by content", () => {
    const preview = formatToolArgumentsPreviewV1({
      path: "Notes/Draft.md",
      content: "x".repeat(4000),
    });
    assert.match(preview, /path="Notes\/Draft\.md"/);
    assert.match(preview, /content=<4000 chars>/);
    assert.doesNotMatch(preview, /xxxx/);
  });

  it("summarizes nested and repeated arguments without spilling them", () => {
    assert.equal(formatToolArgumentsPreviewV1(undefined), "");
    assert.equal(
      formatToolArgumentsPreviewV1({ items: [1, 2, 3], nested: { a: 1 } }),
      "items=[3], nested={…}",
    );
    const many = formatToolArgumentsPreviewV1(
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`k${index}`, index]),
      ),
    );
    assert.match(many, /\+3 more$/);
  });
});

describe("misdirecting narrative", () => {
  it("recognizes the stop reasons that blame the model or the provider", () => {
    for (const detail of [
      "Retry with a tool-compliant model or continue after changing the frontier.",
      "Use a tool-compliant model or change the dependency-ready frontier.",
      "model_tool_noncompliance: the frontier was unchanged",
      "Blocked: the model twice returned no tool call.",
      "The provider is flaky; try again later.",
    ]) {
      assert.equal(
        narrativeBlamesTheModelV1(detail),
        true,
        `should flag: ${detail}`,
      );
    }
  });

  it("leaves an honest, specific stop reason alone", () => {
    for (const detail of [
      "Linear rejected the issue create: team not found.",
      "Streaming writeback stopped after partial note apply.",
      "Approval was denied for github_update_issue.",
      "",
    ]) {
      assert.equal(narrativeBlamesTheModelV1(detail), false, detail);
    }
  });

  it("only reframes the narrative when there are facts that contradict it", () => {
    const why = "Retry with a tool-compliant model.";
    assert.equal(reframeBlockedWhyV1({ why, facts: [] }), why);
    const reframed = reframeBlockedWhyV1({
      why,
      facts: [{ key: "blocker_code", label: "Blocker", value: "path_exists" }],
    });
    assert.notEqual(reframed, why);
    assert.match(reframed, /the facts above are what it actually recorded/);
  });

  it("does not touch an honest narrative even when facts exist", () => {
    const why = "Linear rejected the issue create: team not found.";
    assert.equal(
      reframeBlockedWhyV1({
        why,
        facts: [{ key: "blocker_code", label: "Blocker", value: "team_missing" }],
      }),
      why,
    );
  });

  it("names the evidence block for the reader", () => {
    assert.equal(runFailureEvidenceHeadingV1(), "What actually happened");
  });
});

describe("failure diagnostic traces", () => {
  it("collects errors, rejections, and attested refusals", () => {
    assert.equal(
      isRunFailureDiagnosticTraceV1({ id: "x", kind: "error" }),
      true,
    );
    assert.equal(
      isRunFailureDiagnosticTraceV1({ id: "x", kind: "tool_rejected" }),
      true,
    );
    assert.equal(
      isRunFailureDiagnosticTraceV1({
        id: "step-3",
        kind: "status",
        error: { code: "unsafe_path" },
      }),
      true,
    );
    assert.equal(
      isRunFailureDiagnosticTraceV1({
        id: "node-7:create-file-collision-replan-failed",
        kind: "status",
      }),
      true,
    );
    assert.equal(
      isRunFailureDiagnosticTraceV1({
        id: "writeback:proof-gated-writeback-rejected",
        kind: "status",
      }),
      true,
    );
  });

  it("ignores ordinary progress traces", () => {
    for (const id of [
      "agent-step-response-4",
      "loop-decision-2",
      "receipt:append_to_current_file",
      "operation-goals:1",
    ]) {
      assert.equal(
        isRunFailureDiagnosticTraceV1({ id, kind: "status" }),
        false,
        id,
      );
    }
  });
});

describe("blocked summary", () => {
  it("puts the leading fact before a model-blaming summary", () => {
    const summary = blockedSummaryFromFactsV1({
      summary: "Retry with a tool-compliant model or continue after changing the frontier.",
      facts: [
        { key: "blocker_code", label: "Blocker", value: "path_exists" },
        { key: "stalled_node", label: "Stalled at", value: "node-7" },
      ],
    });
    assert.match(summary, /^Blocker: path_exists — Retry with a tool-compliant model/);
  });

  it("leaves an honest summary and a factless run untouched", () => {
    assert.equal(
      blockedSummaryFromFactsV1({
        summary: "Linear rejected the issue create: team not found.",
        facts: [{ key: "blocker_code", label: "Blocker", value: "team_missing" }],
      }),
      "Linear rejected the issue create: team not found.",
    );
    assert.equal(
      blockedSummaryFromFactsV1({
        summary: "Retry with a tool-compliant model.",
        facts: [],
      }),
      "Retry with a tool-compliant model.",
    );
  });
});
