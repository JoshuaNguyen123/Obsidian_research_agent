import assert from "node:assert/strict";
import test from "node:test";

import {
  countUnverifiedClaimMarkersV1,
  MAX_AUTO_FOLLOWUPS,
  planCompletionFollowupsV1,
  planReadOnlyFollowups,
} from "../src/agent/autoFollowups";
import { UNVERIFIED_CLAIM_MARKER_V1 } from "../src/agent/degradedDelivery";

const appendReceipt = {
  toolName: "append_to_current_file",
  operation: "append",
  path: "Notes/Plan.md",
};

test("a finished note write earns a link chip whose prompt names the note", () => {
  const followups = planCompletionFollowupsV1({
    mission: "Summarize the meeting into the current note",
    receipts: [appendReceipt],
    finalOutput: "Done.",
    linearEnabled: false,
    missionComplete: true,
  });
  assert.deepEqual(
    followups.map((item) => item.id),
    ["link_related_notes"],
  );
  assert.ok(followups[0].prompt.includes("Notes/Plan.md"), followups[0].prompt);
  assert.ok(/append only/i.test(followups[0].prompt), followups[0].prompt);
});

test("chips are not offered for what the mission already did or cannot use", () => {
  // A link mission does not get a link chip; Linear off means no Linear chip.
  assert.deepEqual(
    planCompletionFollowupsV1({
      mission: "Link this note to related notes",
      receipts: [appendReceipt],
      linearEnabled: false,
      missionComplete: true,
    }),
    [],
  );
  // A Linear mission does not get a Linear chip even with Linear on.
  assert.deepEqual(
    planCompletionFollowupsV1({
      mission: "Publish this note to Linear",
      receipts: [appendReceipt],
      linearEnabled: true,
      missionComplete: true,
    }).map((item) => item.id),
    ["link_related_notes"],
  );
  // A blocked or unfinished mission owes a Continue, not next steps.
  assert.deepEqual(
    planCompletionFollowupsV1({
      mission: "Summarize",
      receipts: [appendReceipt],
      linearEnabled: true,
      missionComplete: false,
    }),
    [],
  );
  // Chat-only output with no written note has nothing to link or publish.
  assert.deepEqual(
    planCompletionFollowupsV1({
      mission: "Explain X",
      receipts: [],
      finalOutput: "An answer.",
      linearEnabled: true,
      missionComplete: true,
    }),
    [],
  );
});

test("unverified-claim markers in the output earn a citation chip first", () => {
  const output = `Claim one ${UNVERIFIED_CLAIM_MARKER_V1}. Claim two ${UNVERIFIED_CLAIM_MARKER_V1}.`;
  assert.equal(countUnverifiedClaimMarkersV1(output), 2);
  assert.equal(countUnverifiedClaimMarkersV1(""), 0);
  const followups = planCompletionFollowupsV1({
    mission: "Write a cited overview",
    receipts: [appendReceipt],
    finalOutput: output,
    linearEnabled: true,
    missionComplete: true,
  });
  assert.deepEqual(
    followups.map((item) => item.id),
    ["cite_unverified_claims", "link_related_notes", "draft_linear_issue"],
  );
  assert.equal(followups[0].label, "Cite 2 unverified claims");
  assert.ok(followups[0].prompt.includes(UNVERIFIED_CLAIM_MARKER_V1));
  assert.ok(followups.length <= MAX_AUTO_FOLLOWUPS);
});

test("the in-run reader planner and the chip planner share one cap", () => {
  assert.equal(MAX_AUTO_FOLLOWUPS, 3);
  const result = {
    output: {
      results: Array.from({ length: 6 }, (_, index) => ({
        url: `https://example.org/${index}`,
      })),
    },
  };
  const followups = planReadOnlyFollowups({
    mission: "cite the latest sources on X",
    lastToolName: "web_search",
    lastToolResult: result,
    acceptanceNeeds: ["web_evidence"],
    alreadyFetchedUrls: [],
    alreadyReadPaths: [],
    maxFollowups: 99,
  });
  assert.ok(followups.length <= MAX_AUTO_FOLLOWUPS, String(followups.length));
});
