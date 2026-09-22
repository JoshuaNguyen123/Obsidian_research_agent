import assert from "node:assert/strict";
import test from "node:test";

import { toMissionEvidenceAttestation } from "../src/agent/missionGraphSelectors";
import type { MissionEvidence } from "../src/agent/missionLedger";
import { getUrlHostname } from "../src/agent/sourceSignals";

/**
 * The runtime evidence projection deliberately carries no URLs. The real-web
 * lane counted distinct domains from `item.url` on that projection, so the
 * count started from an empty set and the lane's distinct-domain assertion
 * could not pass, whatever the mission fetched.
 */

function webEvidence(id: string, url: string): MissionEvidence {
  return {
    id,
    kind: "web_source",
    url,
    usableSource: true,
    parserStatus: "parsed",
    passageIds: [`source:${id}:passage:0-100`],
    confidence: "high",
  } as unknown as MissionEvidence;
}

test("the attestation carries the hostname the distinct-domain check counts, never the URL", () => {
  const url = "https://www.Nature.com/articles/s41586-024-0001?utm=feed";
  const attested = toMissionEvidenceAttestation(webEvidence("a", url));
  assert.equal(attested.sourceDomain, getUrlHostname(url));
  assert.equal(attested.sourceDomain, "nature.com");
  const serialized = JSON.stringify(attested);
  assert.ok(!serialized.includes("/articles/"), "no path may leak through");
  assert.ok(!serialized.includes("utm="), "no query may leak through");
});

test("two fetched sources on two hosts attest two domains", () => {
  const domains = new Set(
    [
      webEvidence("a", "https://www.nature.com/articles/1"),
      webEvidence("b", "https://arxiv.org/abs/2401.00001"),
      webEvidence("c", "https://nature.com/articles/2"),
    ]
      .map(toMissionEvidenceAttestation)
      .map((item) => item.sourceDomain),
  );
  assert.deepEqual([...domains].sort(), ["arxiv.org", "nature.com"]);
});

test("evidence without a parseable URL attests no domain", () => {
  const vaultNote = {
    id: "v",
    kind: "vault_note",
    confidence: "medium",
  } as unknown as MissionEvidence;
  assert.equal(toMissionEvidenceAttestation(vaultNote).sourceDomain, undefined);
  assert.equal(
    toMissionEvidenceAttestation(webEvidence("x", "not a url")).sourceDomain,
    undefined,
  );
});
