import assert from "node:assert/strict";
import test from "node:test";
import {
  inferCourtAuthority,
  inferFetchability,
  inferSourceSignals,
} from "../src/agent/sourceSignals";
import { scoreSourceCandidate } from "../src/orchestrator/sourceCandidateLedger";

/*
 * Court hierarchy as a credibility signal.
 *
 * The host lists in `sourceSignals` were STEM-only, so a Supreme Court opinion
 * and an unpublished district order both scored as a generic `.gov` page — the
 * same score a press release gets. In case law "which court said it" *is* the
 * authority, so ranking that cannot see it is ranking that cannot help.
 */

const score = (url: string, title = "") => {
  const signals = inferSourceSignals({ url, title, now: new Date("2026-08-23") });
  return scoreSourceCandidate({
    signals: {
      quality: signals.quality,
      freshness: signals.freshness,
      fetchability: signals.fetchability,
    },
    sourceType: signals.sourceType,
  });
};

test("a court opinion is primary text, not a generic government page", () => {
  const signals = inferSourceSignals({
    url: "https://www.courtlistener.com/opinion/5292018/city-of-tahlequah-v-bond/",
    title: "City of Tahlequah v. Bond — Supreme Court of the United States",
  });
  assert.equal(signals.sourceType, "primary");
});

test("a slip opinion served as a PDF is still the opinion", () => {
  // The extension check would otherwise call it a generic `pdf` and throw away
  // the only fact about it that matters.
  const signals = inferSourceSignals({
    url: "https://www.supremecourt.gov/opinions/21pdf/20-1668_new.pdf",
    title: "City of Tahlequah v. Bond",
  });
  assert.equal(signals.sourceType, "primary");
});

test("precedential weight runs SCOTUS above circuit above district", () => {
  const scotus = inferCourtAuthority(
    "https://www.supremecourt.gov/opinions/21pdf/20-1668.pdf",
    "City of Tahlequah v. Bond, Supreme Court of the United States",
  );
  const circuit = inferCourtAuthority(
    "https://www.ca9.uscourts.gov/opinions/20-35555.pdf",
    "Doe v. Roe, United States Court of Appeals for the Ninth Circuit",
  );
  const district = inferCourtAuthority(
    "https://www.courtlistener.com/opinion/1/doe-v-roe/",
    "Doe v. Roe, United States District Court for the District of Oregon",
  );
  assert.ok(scotus > circuit, `${scotus} !> ${circuit}`);
  assert.ok(circuit > district, `${circuit} !> ${district}`);
  assert.ok(district > 0);
});

test("an unpublished disposition ranks below a published one from the same court", () => {
  const published = inferCourtAuthority(
    "https://www.ca9.uscourts.gov/opinions/20-35555.pdf",
    "Doe v. Roe, Ninth Circuit",
  );
  const unpublished = inferCourtAuthority(
    "https://www.ca9.uscourts.gov/memoranda/20-35556.pdf",
    "Doe v. Roe, Ninth Circuit (unpublished, not for publication)",
  );
  assert.ok(unpublished < published, `${unpublished} !< ${published}`);
});

test("nothing outside law is disturbed", () => {
  assert.equal(inferCourtAuthority("https://arxiv.org/abs/2401.00001", "A paper"), 0);
  assert.equal(inferCourtAuthority("https://example.com/blog", "Some post"), 0);
});

test("a Supreme Court opinion outranks an unpublished district order end to end", () => {
  // Same host and same shape, so the only thing separating them is the court.
  const supreme = score(
    "https://www.courtlistener.com/opinion/1/tahlequah-v-bond/",
    "City of Tahlequah v. Bond, Supreme Court of the United States",
  );
  const unpublished = score(
    "https://www.courtlistener.com/opinion/2/doe-v-roe/",
    "Doe v. Roe, United States District Court (unpublished)",
  );
  assert.ok(supreme > unpublished, `${supreme} !> ${unpublished}`);
});

test("case-law and trial hosts are treated as readable HTML", () => {
  // Both serve their primary text as plain HTML, which is what the parser
  // handles best; leaving them at the generic prior made the retrieval budget
  // prefer sources it could not read.
  assert.ok(
    inferFetchability("https://www.courtlistener.com/opinion/1/a/") >= 0.9,
  );
  assert.ok(inferFetchability("https://www.law.cornell.edu/uscode/text/17/107") >= 0.9);
  assert.ok(inferFetchability("https://clinicaltrials.gov/study/NCT06996132") >= 0.9);
});
