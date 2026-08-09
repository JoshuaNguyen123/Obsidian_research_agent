import test from "node:test";
import assert from "node:assert/strict";
import { mergeResearchWorkerResult } from "../src/orchestrator/teamEvidenceMerge";
import type { ResearchWorkerResult } from "../src/orchestrator/researchWorker";
import { createSourceCandidateLedger } from "../src/orchestrator/sourceCandidateLedger";

test("empty handoff recovery instructs Lead to web_search then web_fetch", () => {
  const worker: ResearchWorkerResult = {
    handoff: {
      id: "h1",
      fromParticipantId: "researcher",
      toParticipantId: "lead",
      taskId: "t1",
      status: "rejected",
      summary: "No usable sources",
      sourceIds: [],
      evidenceIds: [],
      unresolvedQuestions: ["What is X?"],
      confidence: "low",
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    },
    evidence: [],
    claimPassages: [],
    finalSummary: "No usable sources",
    modelSteps: 2,
    toolCalls: 1,
    sourceLedger: createSourceCandidateLedger({
      runId: "run-1",
      query: "X",
    }),
  };
  const merged = mergeResearchWorkerResult({ worker });
  assert.match(merged.promptContext, /web_search/i);
  assert.match(merged.promptContext, /web_fetch/i);
  assert.equal(merged.merge.evidenceAccepted, 0);
});

test("usable handoff makes the Lead-only proof and write contract explicit", () => {
  const worker: ResearchWorkerResult = {
    handoff: {
      id: "h-proof",
      fromParticipantId: "researcher",
      toParticipantId: "lead",
      taskId: "research",
      status: "ready",
      summary: "Evidence is ready.",
      sourceIds: ["https://example.com/source"],
      evidenceIds: ["web_fetch:https://example.com/source"],
      unresolvedQuestions: [],
      confidence: "high",
      stopReason: "handoff_ready",
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
    },
    evidence: [
      {
        id: "web_fetch:https://example.com/source",
        kind: "web_source",
        title: "Primary source",
        summary: "Fetched primary evidence.",
        url: "https://example.com/source",
        sourceId: "https://example.com/source",
        passageIds: ["source:abc123:passage:0-120"],
        usableSource: true,
        confidence: "high",
      },
    ],
    claimPassages: [],
    finalSummary: "Evidence is ready.",
    modelSteps: 2,
    toolCalls: 2,
    sourceLedger: createSourceCandidateLedger({
      runId: "run-proof",
      query: "proof",
    }),
  };

  const merged = mergeResearchWorkerResult({ worker });
  assert.match(merged.promptContext, /Researcher is read-only/iu);
  assert.match(
    merged.promptContext,
    /passages=\[source:abc123:passage:0-120\]/u,
  );
  assert.match(merged.promptContext, /Never prepend another passage:/iu);
  assert.match(merged.promptContext, /## Limitations/iu);
  assert.match(merged.promptContext, /## Confidence/iu);
  assert.match(merged.promptContext, /append exactly once/iu);
});

test("usable partial evidence cannot upgrade a rejected worker handoff", () => {
  const worker: ResearchWorkerResult = {
    handoff: {
      id: "h-rejected-partial",
      fromParticipantId: "specialist",
      toParticipantId: "lead",
      taskId: "research",
      status: "rejected",
      summary: "One of two required sources was gathered.",
      sourceIds: ["https://example.com/partial"],
      evidenceIds: ["web_fetch:https://example.com/partial"],
      unresolvedQuestions: ["One usable source is still missing."],
      confidence: "medium",
      stopReason: "no_usable_evidence",
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    },
    evidence: [
      {
        id: "web_fetch:https://example.com/partial",
        kind: "web_source",
        title: "Partial evidence",
        summary: "A usable but incomplete evidence record.",
        url: "https://example.com/partial",
        sourceId: "https://example.com/partial",
        passageIds: ["passage-partial-1"],
        usableSource: true,
        confidence: "medium",
      },
    ],
    claimPassages: [],
    finalSummary: "One of two required sources was gathered.",
    modelSteps: 6,
    toolCalls: 2,
    sourceLedger: createSourceCandidateLedger({
      runId: "run-rejected-partial",
      query: "partial proof",
    }),
  };

  const merged = mergeResearchWorkerResult({ worker });
  assert.equal(merged.handoff.status, "rejected");
  assert.equal(merged.merge.evidenceAccepted, 1);
  assert.match(merged.promptContext, /One usable source is still missing/iu);
});
