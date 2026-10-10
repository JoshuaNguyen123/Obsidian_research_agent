import test from "node:test";
import assert from "node:assert/strict";
import { detectEvidenceConflicts, evaluateEvidenceConflictAcceptance, projectEvidenceConflictAcknowledgements } from "../src/agent/evidenceConflicts";
const actualPassages = [
  {
    "id": "source:o19nux:passage:88-787",
    "startChar": 88,
    "endChar": 787,
    "text": "esign decision for an API-based research workspace pilot; no actual customer identity, production deployment or business result is claimed.\",\n  \"decision\": \"Select a design for unrestricted customer rollout, or retain a bounded evaluation when evidence is insufficient.\",\n  \"rolloutRequires\": {\n    \"acceptedRunsAtLeast\": 14,\n    \"attemptedRuns\": 15,\n    \"meanObservedCliElapsedMsAtMost\": 60000,\n    \"meanEstimatedUsageCostUsdAtMost\": 0.01,\n    \"criticalUnsupportedClaims\": 0,\n    \"semanticSupportReviewed\": true\n  },\n  \"authority\": \"Analysis only; no purchases, increased request allowance, deployment, external messages or customer-data writes. An unmeasured design can receive a bounded follow-up",
    "selection": "query_match",
    "matchedTerms": [
      "evidence"
    ]
  },
  {
    "id": "source:o19nux:passage:339-1038",
    "startChar": 339,
    "endChar": 1038,
    "text": "e is insufficient.\",\n  \"rolloutRequires\": {\n    \"acceptedRunsAtLeast\": 14,\n    \"attemptedRuns\": 15,\n    \"meanObservedCliElapsedMsAtMost\": 60000,\n    \"meanEstimatedUsageCostUsdAtMost\": 0.01,\n    \"criticalUnsupportedClaims\": 0,\n    \"semanticSupportReviewed\": true\n  },\n  \"authority\": \"Analysis only; no purchases, increased request allowance, deployment, external messages or customer-data writes. An unmeasured design can receive a bounded follow-up evaluation, not unrestricted rollout.\",\n  \"missingEvidence\": \"P95 latency, first-token latency, actual account invoice, memory, customer population representativeness and completed semantic review are not measured in the supplied observations.\"\n}\n```",
    "selection": "query_match",
    "matchedTerms": [
      "evidence"
    ]
  },
  {
    "id": "source:148nvb8:passage:0-700",
    "startChar": 0,
    "endChar": 700,
    "text": "# Measured API design observations\n\nObserver: codex-root, owner-authorized agent. These are existing observed runs; the answering model did not execute them.\n\n## baseline\n\n```json\n{\n  \"variant\": \"baseline\",\n  \"commit\": \"98866ebad7880f8a58e34c2857e3309b1453a65f\",\n  \"vendorSha\": \"c90a84a8d6480d516a08fec98078108f7ed777b5\",\n  \"attempted\": 15,\n  \"accepted\": 0,\n  \"failed\": 15,\n  \"notAttempted\": 57,\n  \"actualProviderRequests\": 120,\n  \"cliElapsedTotalMs\": 669067,\n  \"cliElapsedMeanMs\": 44604.46666666667,\n  \"estimatedUsageCostUsd\": 0.10978017999999999,\n  \"meanEstimatedUsageCostUsd\": 0.007318678666666666,\n  \"semanticAccuracy\": null,\n  \"criticalUnsupportedClaims\": null,\n  \"invoiceCostUsd\": null,\n  \"hold",
    "selection": "query_match",
    "matchedTerms": [
      "authorized",
      "answering"
    ]
  },
  {
    "id": "source:148nvb8:passage:854-1554",
    "startChar": 854,
    "endChar": 1554,
    "text": "3155276ac8fb1fd9c32af6189197c6d7adcf9a\",\n  \"attempted\": 15,\n  \"accepted\": 0,\n  \"failed\": 15,\n  \"notAttempted\": 57,\n  \"actualProviderRequests\": 107,\n  \"cliElapsedTotalMs\": 616203,\n  \"cliElapsedMeanMs\": 41080.2,\n  \"estimatedUsageCostUsd\": 0.10480990999999999,\n  \"meanEstimatedUsageCostUsd\": 0.006987327333333333,\n  \"semanticAccuracy\": null,\n  \"criticalUnsupportedClaims\": null,\n  \"invoiceCostUsd\": null,\n  \"holderReleaseSucceeded\": 15\n}\n```\n\n## Proposed context repair\n\nRemote core 750988a86e0938c05b70f605964baeb9f462a5dc passes 592/592 controlled runner/serializer tests versus 581/592 on its immediately prior core. Those controls use controlled sources and model responses. No actual hosted task ru",
    "selection": "coverage"
  },
  {
    "id": "source:148nvb8:passage:1707-2406",
    "startChar": 1707,
    "endChar": 2406,
    "text": "ed design.\n\n## Coverage and comparison limits\n\nThe matched source batch has 30 failed and 114 unattempted slots in its full 144 denominator: each variant attempts five academic tasks three times, with eight forwarded API requests allowed per run. All completion and semantic checks remain failed or unassessed; suppressed drafts are not accepted answers. CLI elapsed time includes host work, verification, failures and release waiting; it is not provider-only or first-token latency. Original API response usage gives estimates, not invoices. Quota was not reached. The baseline release checks fail 15/15 and candidate release checks pass 15/15; later baseline PID absence is a separate observation.",
    "selection": "coverage"
  }
];
test("actual API observations and unmeasured-metrics caveat do not contradict",()=>{
 assert.deepEqual(detectEvidenceConflicts(actualPassages),[]);
});
test("shared grammar cannot turn different measured outcomes into a material contradiction",()=>{
 assert.deepEqual(detectEvidenceConflicts([{id:"source:a:passage:0-100",text:"The measured observations are successful source reads."},{id:"source:b:passage:0-100",text:"First-token latency is not measured in the supplied observations."}]),[]);
});
test("true treatment polarity remains an open dual-source conflict",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-100",text:"The treatment improves patient survival in randomized adults."},{id:"source:b:passage:0-100",text:"The treatment does not improve patient survival in randomized adults."}]);
 assert.equal(rows.length,1);assert.equal(rows[0].status,"open");assert.deepEqual(rows[0].passageIds,["source:a:passage:0-100","source:b:passage:0-100"]);
 const bound=projectEvidenceConflictAcknowledgements(rows,"The treatment improves survival [source:a:passage:0-100] [source:b:passage:0-100].");
 assert.ok(evaluateEvidenceConflictAcceptance({conflicts:bound,finalOutput:"No limitations"}).missing.some(item=>item.startsWith("open_evidence_conflicts:")));
});
test("true comparable numeric disagreement remains a conflict",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-100",text:"The treatment survival rate was 20 percent among adult patients."},{id:"source:b:passage:0-100",text:"The treatment survival rate was 60 percent among adult patients."}]);
 assert.equal(rows.length,1);assert.equal(rows[0].status,"open");
});
test("a grammatical paraphrase retains the same substantive conflict",()=>{
 const rows=detectEvidenceConflicts([{id:"source:a:passage:0-100",text:"Treatment improves patient survival in randomized adults."},{id:"source:b:passage:0-100",text:"Treatment does not improve patient survival in randomized adults."}]);assert.equal(rows.length,1);
});
