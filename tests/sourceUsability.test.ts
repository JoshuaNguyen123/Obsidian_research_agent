import test from "node:test";
import assert from "node:assert/strict";

import {
  evaluateSourceUsability,
  selectNextUsableSourceCandidate,
} from "../src/agent/sourceUsability";
import { evidenceFromToolResult } from "../src/agent/missionEvidence";
import { isFetchedWebEvidence } from "../src/agent/missionPlan";

test("empty and parser-failed web pages never become mission evidence", () => {
  for (const parserStatus of ["empty", "missing_content"] as const) {
    const evidence = evidenceFromToolResult("web_fetch", {
      toolName: "web_fetch",
      ok: true,
      output: {
        url: "https://example.com/empty",
        title: "Empty",
        content: "",
        parserStatus,
      },
    });
    assert.equal(evidence, null);
  }
});

test("parsed non-empty web pages create passage-backed fetched evidence", () => {
  const evidence = evidenceFromToolResult("web_fetch", {
    toolName: "web_fetch",
    ok: true,
    output: {
      url: "https://example.com/source",
      title: "Useful source",
      query: "template research",
      content:
        "Template research benefits from explicit source provenance and read-back verification. This passage contains enough grounded content to cite.",
      parserStatus: "parsed",
    },
  });
  assert.ok(evidence);
  assert.equal(evidence.usableSource, true);
  assert.ok((evidence.passageIds?.length ?? 0) > 0);
  assert.equal(isFetchedWebEvidence(evidence), true);
});

test("a URL without a persisted passage is navigation rather than fetched proof", () => {
  assert.equal(
    isFetchedWebEvidence({
      id: "web:legacy",
      kind: "web_source",
      title: "Legacy URL",
      url: "https://example.com/legacy",
      summary: "URL only",
      confidence: "high",
    }),
    false,
  );
});

test("source usability and fallback selection stay bounded and deterministic", () => {
  assert.equal(
    evaluateSourceUsability({
      content: "Useful evidence passage with concrete facts and context.",
      sourceLocator: "https://example.com/a",
      parserStatus: "parsed",
    }).usable,
    true,
  );
  const selected = selectNextUsableSourceCandidate([
    { url: "https://example.com/a", attempted: true },
    { url: "https://example.com/b", parserStatus: "empty" },
    { url: "https://example.com/c" },
  ]);
  assert.equal(selected?.url, "https://example.com/c");
});
