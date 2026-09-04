import assert from "node:assert/strict";
import test from "node:test";
import {
  renderCitedNoteBodyV1,
  SOURCES_HEADING_V1,
} from "../src/agent/citationBibliography";
import type { MissionEvidence } from "../src/agent/missionLedger";

/*
 * Citation tokens exist so the runner can prove a sentence is backed by a span
 * of a fetched source. `source:1f3a9c:passage:1200-1900` is exactly right for
 * that and exactly wrong to leave in someone's note: it is unreadable, it is
 * unclickable, and it tells a reader nothing about who said the thing.
 */

const NOW = () => new Date("2026-09-04T11:00:00Z");

function evidence(partial: Partial<MissionEvidence>): MissionEvidence {
  return {
    id: partial.id ?? "e1",
    kind: (partial.kind ?? "source") as MissionEvidence["kind"],
    title: partial.title ?? "Untitled",
    summary: partial.summary ?? "",
    confidence: partial.confidence ?? "medium",
    ...partial,
  } as MissionEvidence;
}

test("tokens become footnotes and each source is listed once", () => {
  const content = [
    "# Findings",
    "",
    "The balance sheet reached 4.5 trillion source:aa11:passage:1200-1900.",
    "A second point from the same page source:aa11:passage:3000-3600.",
    "And one from elsewhere source:bb22:passage:10-700.",
  ].join("\n");

  const result = renderCitedNoteBodyV1({
    content,
    now: NOW,
    evidence: [
      evidence({
        id: "e1",
        title: "Federal Reserve balance sheet",
        url: "https://example.test/fed",
        sourceId: "source:aa11",
      }),
      evidence({
        id: "e2",
        title: "Second source",
        url: "https://example.test/other",
        passageIds: ["source:bb22:passage:10-700"],
      }),
    ],
  });

  assert.equal(result.changed, true);
  assert.equal(result.entries.length, 2, "one entry per source, not per citation");
  assert.equal(result.unresolvedTokens.length, 0);

  // The prose above the section is untouched apart from the markers themselves.
  assert.match(result.content, /reached 4\.5 trillion \[\^1\]\./u);
  assert.match(result.content, /same page \[\^1\]\./u);
  assert.match(result.content, /from elsewhere \[\^2\]\./u);
  // The prose is clean; the tokens live in the Sources section (asserted below).
  const body = result.content.slice(0, result.content.indexOf(SOURCES_HEADING_V1));
  assert.doesNotMatch(body, /source:[a-z0-9]+:passage:/u);

  // Markers are numbered by first appearance, and the section carries what a
  // reader needs to check the claim: who, where, which span, and when it was read.
  const section = result.content.slice(result.content.indexOf(SOURCES_HEADING_V1));
  assert.match(
    section,
    /\[\^1\]: Federal Reserve balance sheet — https:\/\/example\.test\/fed \(cited chars 1200-1900, 3000-3600, accessed 2026-09-04\)/u,
  );
  assert.match(section, /\[\^2\]: Second source — https:\/\/example\.test\/other/u);
  // Every token survives, in its definition: the runner's proof contract is
  // checked against the payload, so a body with the tokens stripped out
  // entirely would turn a verified write into an unverifiable one.
  assert.match(section, /source:aa11:passage:1200-1900 source:aa11:passage:3000-3600/u);
  assert.match(section, /source:bb22:passage:10-700/u);
});

test("a token whose source the mission never recorded is left alone", () => {
  // A visible token is a defect a reader can see and report. A fabricated
  // source entry is one they cannot.
  const content = "A claim source:zz99:passage:5-50 with no evidence behind it.";
  const result = renderCitedNoteBodyV1({ content, evidence: [], now: NOW });
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
  assert.deepEqual(result.unresolvedTokens, ["source:zz99:passage:5-50"]);
  assert.equal(result.entries.length, 0);
});

test("known and unknown tokens in one draft: the known ones render, the rest stay", () => {
  const content =
    "Known source:aa11:passage:1-100 and unknown source:zz99:passage:5-50 together.";
  const result = renderCitedNoteBodyV1({
    content,
    now: NOW,
    evidence: [evidence({ title: "Known page", url: "https://example.test/k", sourceId: "source:aa11" })],
  });
  assert.equal(result.changed, true);
  assert.match(result.content, /Known \[\^1\] and unknown source:zz99:passage:5-50 together\./u);
  assert.deepEqual(result.unresolvedTokens, ["source:zz99:passage:5-50"]);
});

test("rendering twice does not append the section twice", () => {
  // Retries, correction passes and a second write of the same draft all reach
  // this path; appending twice would corrupt the note.
  const content = "A claim source:aa11:passage:1-100.";
  const evidenceList = [
    evidence({ title: "Known page", url: "https://example.test/k", sourceId: "source:aa11" }),
  ];
  const once = renderCitedNoteBodyV1({ content, evidence: evidenceList, now: NOW });
  const twice = renderCitedNoteBodyV1({
    content: once.content,
    evidence: evidenceList,
    now: NOW,
  });
  assert.equal(twice.changed, false);
  assert.equal(twice.content, once.content);
  assert.equal(
    (once.content.match(/## Sources/gu) ?? []).length,
    1,
  );
});

test("a draft with no citations is returned byte-identical", () => {
  const content = "# Notes\n\nNothing here cites anything at all.\n";
  const result = renderCitedNoteBodyV1({
    content,
    evidence: [evidence({ sourceId: "source:aa11" })],
    now: NOW,
  });
  assert.equal(result.changed, false);
  assert.equal(result.content, content);
});

test("a vault-path source is cited by path when it has no URL", () => {
  const result = renderCitedNoteBodyV1({
    content: "From my own note source:cc33:passage:0-400.",
    now: NOW,
    evidence: [
      evidence({ title: "Meeting notes", path: "Work/Meeting notes.md", sourceId: "source:cc33" }),
    ],
  });
  assert.equal(result.changed, true);
  assert.match(
    result.content,
    /\[\^1\]: Meeting notes — Work\/Meeting notes\.md \(cited chars 0-400, accessed 2026-09-04\)/u,
  );
});

test("a token already wrapped in brackets is consumed whole", () => {
  // `[source:...]` is how the drafts in this repo's fixtures cite. Replacing
  // only the token inside leaves `[[^1]]`, which Obsidian parses as the start
  // of a wikilink rather than a footnote reference.
  const result = renderCitedNoteBodyV1({
    content: "A protocol claim [source:aa11:passage:0-67] and a bare one source:aa11:passage:70-90.",
    now: NOW,
    evidence: [
      evidence({ title: "MCP overview", url: "https://example.test/mcp", sourceId: "source:aa11" }),
    ],
  });
  assert.equal(result.changed, true);
  assert.match(result.content, /A protocol claim \[\^1\] and a bare one \[\^1\]\./u);
  assert.doesNotMatch(result.content, /\[\[\^1\]\]/u);
});
