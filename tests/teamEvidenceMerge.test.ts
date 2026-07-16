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
        passageIds: ["passage-source-1"],
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
  assert.match(merged.promptContext, /\[passage:<id>\]/u);
  assert.match(merged.promptContext, /## Limitations/iu);
  assert.match(merged.promptContext, /## Confidence/iu);
  assert.match(merged.promptContext, /append exactly once/iu);
});
