import test from "node:test";
import assert from "node:assert/strict";
import {
  extractClaimsFromDraft,
  isNotATopicClaimV1,
  nonClaimKindV1,
  normalizeClaimLedger,
  serializeClaimLedger,
  type ResearchClaim,
} from "../src/agent/claimLedger";
import { planClaimSupportChecksV1 } from "../src/decisions/claimSupportAssessment";

const token = (source: string, start: number, end: number) => `source:${source}:passage:${start}-${end}`;
const claimOf = (claims: readonly ResearchClaim[], match: string) => {
  const found = claims.find((claim) => claim.text.includes(match));
  assert.ok(found, `no claim holds "${match}"`);
  return found;
};

test("a bibliography line is not a claim; a sentence citing a URL in passing is", () => {
  const entries = [
    `"Calorie Restriction with or without Time-Restricted Eating in Weight Loss." *New England Journal of Medicine*, April 21, 2022; 386:1495-1504. https://www.nejm.org/doi/full/10.1056/NEJMoa2114833 (passages: ${token("a1", 0, 90)})`,
    "https://claude.com/docs/connectors/building/mcp — Anthropic/Claude product documentation",
    "FCIC press release on the report findings (official; snapshot version above) — https://example.org/fcic.pdf",
    "Jamshed H, Steger FL, Bryan DR, et al.",
  ];
  for (const entry of entries) assert.equal(nonClaimKindV1(entry), "bibliography", entry);
  for (const claim of [
    "A citywide survey (https://example.org/survey) found that trees cooled pavements by 20 °C.",
    "The rate rose to 9% in 2023, according to https://example.org/rates and two later reports.",
    "Data portal: https://example.org/portal shows that admissions fell by a third.",
    `In Claude, an MCP server appears to users as a connector (${token("a1", 0, 90)}, https://claude.com/docs/connectors/building/mcp).`,
  ]) {
    assert.equal(nonClaimKindV1(claim), null, claim);
  }
});

test("notes on quotations and passage ids, and the model's asides, are not claims", () => {
  assert.equal(nonClaimKindV1("Passage IDs are copied verbatim from the fetched snapshots; bounded reads only."), "quote_note");
  assert.equal(nonClaimKindV1("*Note: quotations above are copied verbatim from the cached source passages.*"), "quote_note");
  assert.equal(nonClaimKindV1("All quoted fragments are now either explicitly verify-supported or display verbatim."), "quote_note");
  assert.equal(nonClaimKindV1("Here is the complete corrected note content:"), "aside");
  assert.equal(nonClaimKindV1("The summary below is the final deliverable, ready to paste under that heading."), "aside");
  assert.equal(nonClaimKindV1("I've revised the note so that every quotation carries its citation."), "aside");
  assert.equal(nonClaimKindV1("Sources fetched on 2026-10-23, three URLs across three distinct host domains."), "source_list");
  // Claims that only open like one.
  assert.equal(nonClaimKindV1("Quotations from the 2019 trial show that naps had no effect on recall."), null);
  assert.equal(nonClaimKindV1("Here is why the scale matters: reefs bleached this widely rarely recover."), null);
  assert.equal(nonClaimKindV1("Sources of methane include cattle, which account for 30% of emissions."), null);
});

test("a Sources section and the list under a Sources label are not claims; what follows the list is", () => {
  const draft = [
    "# Urban trees",
    "",
    `Street trees lowered pavement temperatures by up to 12 °C in the survey ${token("b2", 0, 80)}.`,
    "",
    "**Sources fetched (2026-10-20), two distinct domains:**",
    `- The municipal survey of street-tree cooling, 2022 ${token("b2", 0, 80)}`,
    "- City Climate Office, canopy targets policy page",
    "",
    `Canopy cover in the city rose from 18% to 25% between 2010 and 2020 ${token("b2", 120, 200)}.`,
    "",
    "## Sources of error",
    "",
    "Satellite canopy maps undercount young street trees by about a fifth.",
    "",
    "## References and tiers",
    "",
    "1. The survey report, tier 1, the city's own measurements of its streets.",
    "Each tier is ranked by how directly the source measured the streets.",
  ].join("\n");
  const claims = extractClaimsFromDraft(draft);
  assert.equal(claimOf(claims, "Sources fetched (2026-10-20)").nonClaim, "source_list");
  assert.equal(claimOf(claims, "municipal survey of street-tree cooling").nonClaim, "source_list");
  assert.equal(claimOf(claims, "City Climate Office").nonClaim, "source_list");
  assert.equal(claimOf(claims, "The survey report, tier 1").nonClaim, "source_list");
  assert.equal(claimOf(claims, "Each tier is ranked").nonClaim, "source_list");
  for (const factual of ["lowered pavement temperatures", "rose from 18% to 25%", "Satellite canopy maps undercount"]) {
    const claim = claimOf(claims, factual);
    assert.equal(claim.nonClaim, undefined, factual);
    assert.equal(claim.status, "ungrounded", factual);
  }
});

test("the claim-support planner never asks about a cited non-claim, and the field survives a save", () => {
  const passage = { id: token("c3", 0, 60), text: "The announcement was published on 25 November 2024 by Anthropic." };
  const claims: ResearchClaim[] = [
    {
      id: "claim:s-bib",
      text: `https://www.anthropic.com/news/mcp — Anthropic's announcement page, dated Nov 25, 2024 (${passage.id}).`,
      status: "grounded",
      passageIds: [passage.id],
    },
    {
      id: "claim:s-list",
      text: `The announcement page, tier 2 (${passage.id}).`,
      status: "exempt",
      passageIds: [passage.id],
      nonClaim: "source_list",
    },
    {
      id: "claim:s-fact",
      text: `Anthropic published the announcement in November 2024 (${passage.id}).`,
      status: "grounded",
      passageIds: [passage.id],
    },
  ];
  assert.equal(isNotATopicClaimV1(claims[0]!), true);
  assert.equal(isNotATopicClaimV1(claims[1]!), true);
  assert.equal(isNotATopicClaimV1(claims[2]!), false);
  const planned = planClaimSupportChecksV1({ claims, passages: [passage] });
  assert.deepEqual(planned.checks.map((check) => check.claimId), ["claim:s-fact"]);
  assert.equal(planned.processStatements, 2);

  const ledger = normalizeClaimLedger(
    JSON.parse(
      JSON.stringify(
        serializeClaimLedger({
          version: 1,
          status: "pass",
          claims,
          knownPassageIds: [passage.id],
          missing: [],
          reasons: [],
          requireQuoteSpans: false,
        } as never),
      ),
    ),
  );
  assert.equal(ledger?.claims.find((claim) => claim.id === "claim:s-list")?.nonClaim, "source_list");
  assert.equal(ledger?.claims.find((claim) => claim.id === "claim:s-fact")?.nonClaim, undefined);
});
