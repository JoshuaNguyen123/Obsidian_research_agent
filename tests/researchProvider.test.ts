import test from "node:test";
import assert from "node:assert/strict";

import {
  buildResearchFallbackCandidates,
  retrieveUsableResearchSource,
  type ResearchRetrievalProvider,
} from "../src/orchestrator/researchProvider";

test("provider-neutral retrieval rejects empty proof and falls back", async () => {
  const provider: ResearchRetrievalProvider = {
    id: "test",
    strategies: ["cached_section", "provider_fetch", "browser_extract"],
    async retrieve(candidate) {
      if (candidate.strategy !== "browser_extract") {
        return {
          title: "Empty",
          url: candidate.url,
          content: "",
          parserStatus: "empty",
        };
      }
      return {
        title: "Usable",
        url: candidate.url,
        content:
          "Browser extraction returned a concrete source passage with enough context for claim-level verification and citation.",
        parserStatus: "parsed",
      };
    },
  };
  const result = await retrieveUsableResearchSource({
    candidates: buildResearchFallbackCandidates({
      url: "https://example.com/report",
    }),
    providers: [provider],
  });
  assert.equal(result.output?.title, "Usable");
  assert.ok(result.passageIds.length > 0);
  assert.deepEqual(result.attempts.map((item) => item.status), [
    "unparsed",
    "unparsed",
    "usable",
  ]);
});
