import assert from "node:assert/strict";
import test from "node:test";

import type { AgentRunReceipt } from "../src/AgentRunner";
import {
  buildClaimReceiptAnchorsV1,
  isReceiptBackedClaimSentenceV1,
} from "../src/agent/receiptBackedClaims";
import { runMissionVerifiers } from "../src/agent/verifiers";

/**
 * BYOK livelock (two-subsystems-disagree #20): the claim ledger demanded a web
 * passage for sentences that report the run's own receipts, which no passage
 * can ground, while the research frontier could only fetch more pages. These
 * tests run the real verifier, so they measure what the proof debt sees.
 */

const RECEIPTS: AgentRunReceipt[] = [
  {
    toolName: "linear_create_issue",
    operation: "create",
    message: "Created APP-507",
    resource: {
      system: "linear",
      resourceType: "issue",
      id: "0b6f3c1e-8a55-4d2c-9d8e-111111111111",
      identifier: "APP-507",
      url: "https://linear.app/acme/issue/APP-507/battery-follow-up",
    },
  } as AgentRunReceipt,
  {
    toolName: "append_to_current_file",
    operation: "append",
    message: "Appended 4217 bytes",
    path: "Research/Solid-state batteries.md",
    bytesWritten: 4217,
  } as AgentRunReceipt,
  {
    toolName: "create_project_idea_brief",
    operation: "create",
    message: "Created the brief",
    path: "Agent Work/Battery brief.md",
  } as AgentRunReceipt,
];

const anchors = buildClaimReceiptAnchorsV1(RECEIPTS);

for (const sentence of [
  "Created Linear issue APP-507 to track the follow-up.",
  "Appended 4,217 bytes to Research/Solid-state batteries.md.",
  "I appended 4217 bytes to the current note.",
  "The create_project_idea_brief tool was called exactly once.",
  "Saved the brief to [[Battery brief]] for review.",
  "APP-507 was filed at https://linear.app/acme/issue/APP-507/battery-follow-up.",
]) {
  test(`a receipt report is exempt: ${sentence}`, () => {
    assert.equal(isReceiptBackedClaimSentenceV1(sentence, anchors), true);
  });
}

for (const sentence of [
  // A world claim riding on a receipt anchor keeps its debt.
  "Created Linear issue APP-507 because sodium-ion cells cost thirty percent less than lithium cells.",
  // The anchor is a note TITLE written as prose, not a note reference: this is
  // the topic, and a topical sentence must not be exempt.
  "Researchers published battery brief findings showing solid electrolytes resist dendrites.",
  // A count that no receipt recorded.
  "Appended 9,999 bytes to the current note.",
  // No action verb.
  "Solid-state batteries remove the flammable liquid electrolyte.",
  // A factual sentence with no receipt anchor at all.
  "Toyota added solid-state cells to its 2027 production roadmap.",
]) {
  test(`a claim about the world still owes a passage: ${sentence}`, () => {
    assert.equal(isReceiptBackedClaimSentenceV1(sentence, anchors), false);
  });
}

test("with no receipts nothing is exempt", () => {
  const none = buildClaimReceiptAnchorsV1([]);
  assert.equal(
    isReceiptBackedClaimSentenceV1("Created Linear issue APP-507 to track the follow-up.", none),
    false,
  );
});

test("the verifier stops demanding passages for receipt sentences and still demands them for facts", () => {
  const finalOutput = [
    "Created Linear issue APP-507 to track the follow-up.",
    "Appended 4,217 bytes to Research/Solid-state batteries.md.",
    "The create_project_idea_brief tool was called exactly once.",
    "Solid electrolytes raise practical energy density by removing the separator stack.",
  ].join(" ");
  const verification = runMissionVerifiers({
    evidence: [],
    receipts: RECEIPTS,
    finalOutput,
    prompt: "deep research with cited passages",
    requireClaimGrounding: true,
  });
  const ledger = verification.claimLedger;
  assert.ok(ledger, "claim grounding must run");
  const byText = new Map(ledger.claims.map((claim) => [claim.text, claim.status]));
  assert.equal(byText.get("Created Linear issue APP-507 to track the follow-up."), "exempt");
  assert.equal(byText.get("Appended 4,217 bytes to Research/Solid-state batteries.md."), "exempt");
  assert.equal(byText.get("The create_project_idea_brief tool was called exactly once."), "exempt");
  assert.equal(
    byText.get("Solid electrolytes raise practical energy density by removing the separator stack."),
    "ungrounded",
  );
  const ungrounded = ledger.missing.filter((item) => item.startsWith("claim_grounding:ungrounded:"));
  assert.equal(ungrounded.length, 1, "only the factual claim remains owed");
  assert.ok(ledger.reasons.includes("receipt_backed_claims:3"), "the exemption is named");
});

test("the same draft with no receipts owes a passage for every sentence, as before", () => {
  const finalOutput = "Created Linear issue APP-507 to track the follow-up.";
  const verification = runMissionVerifiers({
    evidence: [],
    receipts: [],
    finalOutput,
    prompt: "deep research with cited passages",
    requireClaimGrounding: true,
  });
  assert.deepEqual(
    verification.claimLedger?.claims.map((claim) => claim.status),
    ["ungrounded"],
  );
});
