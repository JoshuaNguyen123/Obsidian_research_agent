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
