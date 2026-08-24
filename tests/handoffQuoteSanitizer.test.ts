import test from "node:test";
import assert from "node:assert/strict";
import type { ClaimPassageRef } from "../src/agent/claimLedger";
import { sanitizeHandoffQuotes } from "../src/agent/handoffQuoteSanitizer";
import { buildContinuationMemoryBundle } from "../src/agent/continuationMemory";
import { createMissionLedger } from "../src/agent/missionLedger";
import type { MissionEvidence } from "../src/agent/missionLedger";
import {
  findQuoteRawSpan,
  quoteAppearsVerbatim,
} from "../src/agent/quoteMatch";
import { mergeResearchWorkerResult } from "../src/orchestrator/teamEvidenceMerge";
import type { ResearchWorkerResult } from "../src/orchestrator/researchWorker";
import { createSourceCandidateLedger } from "../src/orchestrator/sourceCandidateLedger";

// Mirrors the live 2026-08-24 failure: the cached New Advent bytes read
// "proceedeth ... spake ... worshiped"; the researcher handoff quoted a
// modernized transcription and attributed it to a passage that ends mid-creed.
const EARLY_PASSAGE: ClaimPassageRef = {
  id: "source:newadvent:passage:0-160",
  text:
    "We believe in one God, the Father Almighty, Maker of all things visible " +
    "and invisible; and in one Lord Jesus Christ, the Son of God, the " +
    "only-begotten of his Father.",
  evidenceId: "web_fetch:https://www.newadvent.org/creed",
};
const LATE_PASSAGE: ClaimPassageRef = {
  id: "source:newadvent:passage:400-580",
  text:
    "And in the Holy Ghost, the Lord and Giver of life, who proceedeth from " +
    "the Father, who with the Father and the Son together is worshiped and " +
    "glorified, who spake by the prophets.",
  evidenceId: "web_fetch:https://www.newadvent.org/creed",
};
const MODERNIZED_QUOTE =
  "proceeds from the Father, who with the Father and the Son together is worshipped";
const TRUE_QUOTE =
  "proceedeth from the Father, who with the Father and the Son together is worshiped";

test("modernized quote attributed to a passage is downgraded to a paraphrase", () => {
  const text =
    "The creed states “" +
    MODERNIZED_QUOTE +
    "” [source:newadvent:passage:400-580].";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.downgradedCount, 1);
  assert.equal(result.verifiedCount, 0);
  // The span must no longer be presented as verbatim bytes...
  assert.doesNotMatch(result.text, /["“]proceeds from the Father/u);
  assert.match(result.text, /paraphrase/iu);
  // ...but the researcher's finding itself is preserved for the writer.
  assert.ok(result.text.includes(MODERNIZED_QUOTE));
});

test("genuinely verbatim quote passes through untouched", () => {
  const text =
    "The creed states “" +
    TRUE_QUOTE +
    "” [source:newadvent:passage:400-580].";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.text, text);
  assert.equal(result.verifiedCount, 1);
  assert.equal(result.downgradedCount, 0);
  assert.equal(result.reattributedCount, 0);
});

test("quote attributed to the wrong passage of the same source is reattributed", () => {
  const text =
    "The creed states “" +
    TRUE_QUOTE +
    "” [source:newadvent:passage:0-160].";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.reattributedCount, 1);
  assert.equal(result.downgradedCount, 0);
  assert.ok(result.text.includes(LATE_PASSAGE.id));
  assert.ok(!result.text.includes(EARLY_PASSAGE.id));
  // The corrected capture must satisfy the write-time predicate against the
  // passage it now cites.
  assert.ok(quoteAppearsVerbatim(TRUE_QUOTE, LATE_PASSAGE.text));
});

test("reattribution prefers a sibling passage of the cited source over other sources", () => {
  // The same clause is cached from a second source whose passage sorts ahead
  // of the New Advent sibling; the correction must still stay on the source
  // the researcher cited.
  const mirrorPassage: ClaimPassageRef = {
    id: "source:ccelmirror:passage:100-280",
    text: LATE_PASSAGE.text,
    evidenceId: "web_fetch:https://ccel.example.org/creed",
  };
  const text =
    "The creed states “" +
    TRUE_QUOTE +
    "” [source:newadvent:passage:0-160].";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [mirrorPassage, EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.reattributedCount, 1);
  assert.ok(result.text.includes(LATE_PASSAGE.id));
  assert.ok(!result.text.includes(mirrorPassage.id));
});

test("reattribution presents the passage's actual bytes, not the transcription", () => {
  // Verbatim under normalization (case differs) but cited at the wrong
  // passage: the rewrite must emit the source's raw casing.
  const text =
    "The creed states “Who Proceedeth From The Father, Who With The " +
    "Father And The Son Together Is Worshiped” " +
    "[source:newadvent:passage:0-160].";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.reattributedCount, 1);
  assert.ok(
    result.text.includes(
      "who proceedeth from the Father, who with the Father and the Son " +
        "together is worshiped",
    ),
  );
  assert.ok(result.text.includes(LATE_PASSAGE.id));
});

test("quote with no adjacent source or passage reference is left alone", () => {
  const text =
    "As the saying goes, “measure twice and cut once”, the plan holds.";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
  });
  assert.equal(result.text, text);
  assert.equal(result.downgradedCount, 0);
});

test("URL-attributed modernized quote is downgraded via evidence passage mapping", () => {
  const evidence: MissionEvidence[] = [
    {
      id: "web_fetch:https://www.newadvent.org/creed",
      kind: "web_source",
      title: "Nicene Creed",
      url: "https://www.newadvent.org/creed",
      passageIds: [EARLY_PASSAGE.id, LATE_PASSAGE.id],
      usableSource: true,
      summary: "Fetched creed text.",
      confidence: "high",
    },
  ];
  const text =
    "From https://www.newadvent.org/creed the creed reads “" +
    MODERNIZED_QUOTE +
    "”.";
  const result = sanitizeHandoffQuotes({
    text,
    passages: [EARLY_PASSAGE, LATE_PASSAGE],
    evidence,
  });
  assert.equal(result.downgradedCount, 1);
  assert.doesNotMatch(result.text, /["“]proceeds from the Father/u);
});

test("empty passage store leaves the text unchanged", () => {
  const text =
    "The creed states “" +
    MODERNIZED_QUOTE +
    "” [source:newadvent:passage:400-580].";
  const result = sanitizeHandoffQuotes({ text, passages: [] });
  assert.equal(result.text, text);
});

test("findQuoteRawSpan recovers raw bytes across case, smart quotes, and whitespace", () => {
  const source = "He said,  “Proceedeth   from\nthe Father” — indeed.";
  const offset = findQuoteRawSpan('proceedeth from "the" father'.replace(/"/g, ""), source);
  assert.ok(offset);
  const raw = source.slice(offset.start, offset.end);
  assert.equal(raw, "Proceedeth   from\nthe Father");
  assert.equal(findQuoteRawSpan("absent phrase entirely", source), null);
});

test("merge seam: worker handoff summary reaches the Lead with the quote defused", () => {
  const summary =
    "The Nicene Creed's third article reads “" +
    MODERNIZED_QUOTE +
    "” [source:newadvent:passage:400-580].";
  const worker: ResearchWorkerResult = {
    handoff: {
      id: "h-quote",
      fromParticipantId: "researcher",
      toParticipantId: "lead",
      taskId: "research",
      status: "ready",
      summary,
      sourceIds: ["https://www.newadvent.org/creed"],
      evidenceIds: ["web_fetch:https://www.newadvent.org/creed"],
      unresolvedQuestions: [],
      confidence: "high",
      stopReason: "handoff_ready",
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    },
    evidence: [
      {
        id: "web_fetch:https://www.newadvent.org/creed",
        kind: "web_source",
        title: "Nicene Creed",
        summary: "Fetched creed text.",
        url: "https://www.newadvent.org/creed",
        sourceId: "https://www.newadvent.org/creed",
        passageIds: [EARLY_PASSAGE.id, LATE_PASSAGE.id],
        usableSource: true,
        confidence: "high",
      },
    ],
    claimPassages: [EARLY_PASSAGE, LATE_PASSAGE],
    finalSummary: summary,
    modelSteps: 3,
    toolCalls: 2,
    sourceLedger: createSourceCandidateLedger({
      runId: "run-quote",
      query: "nicene creed",
    }),
  };

  const merged = mergeResearchWorkerResult({ worker });
  assert.doesNotMatch(merged.handoff.summary, /["“]proceeds from the Father/u);
  assert.match(merged.handoff.summary, /paraphrase/iu);
  assert.doesNotMatch(merged.promptContext, /["“]proceeds from the Father/u);
  assert.match(merged.promptContext, /paraphrase/iu);
});

test("continuation seam: ledger evidence summaries defuse unverifiable quotes", () => {
  const ledger = createMissionLedger({
    runId: "run-continuation-quote",
    mission: "Deep research on the Nicene Creed with quotes",
    route: "deep_web",
    loopBudget: {
      hardCap: 10,
      toolStepBudget: 8,
      finalizationReserve: 2,
      expectedTools: ["web_fetch"],
      stopWhenSatisfied: true,
    },
  });
  ledger.claimPassages = [EARLY_PASSAGE, LATE_PASSAGE];
  ledger.evidence.push({
    id: "web_fetch:https://www.newadvent.org/creed",
    kind: "web_source",
    title: "Nicene Creed",
    url: "https://www.newadvent.org/creed",
    passageIds: [LATE_PASSAGE.id],
    usableSource: true,
    summary:
      "The creed reads “" +
      MODERNIZED_QUOTE +
      "” [source:newadvent:passage:400-580].",
    confidence: "high",
  });

  const bundle = buildContinuationMemoryBundle({ ledger });
  assert.equal(bundle.evidenceSummaries.length, 1);
  assert.doesNotMatch(
    bundle.evidenceSummaries[0],
    /["“]proceeds from the Father/u,
  );
  assert.match(bundle.evidenceSummaries[0], /paraphrase/iu);
});
