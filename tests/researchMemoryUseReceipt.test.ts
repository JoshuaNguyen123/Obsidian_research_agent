import assert from "node:assert/strict";
import test from "node:test";

import { buildResearchMemoryUseReceiptV1 } from "../src/agent/researchHypotheses";

test("research memory use receipt exposes only stable IDs, counts, labels, and relevance", () => {
  const receipt = buildResearchMemoryUseReceiptV1([
    {
      version: 2,
      id: "research-record-1",
      vaultScopeId: "vault-private",
      origin: "vault_local",
      topic: "American checkers movement",
      path: "private/research.md",
      keywords: ["checkers", "movement"],
      lastUpdated: "2026-07-19T00:00:00.000Z",
      sourceLabels: [
        { kind: "note", reference: "private/research.md" },
        { kind: "public_url", reference: "https://example.test/rules" },
      ],
      createdAt: "2026-07-19T00:00:00.000Z",
      fingerprint: `sha256:${"a".repeat(64)}`,
      verificationState: "unverified",
    },
  ], "Build a checkers movement engine");

  assert.deepEqual(receipt, {
    version: 1,
    domain: "research",
    recordIds: ["research-record-1"],
    recordCount: 1,
    sourceCategories: ["note", "public_url"],
    relevance: "keyword_match_to_current_mission",
    verification: "unverified_prior_context",
  });
  assert.doesNotMatch(JSON.stringify(receipt), /private\/research|vault-private|example\.test/u);
});
