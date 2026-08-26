import test from "node:test";
import assert from "node:assert/strict";
import { formatQuotablePassagesForWriteback } from "../src/agent/missionEvidence";
import type { ClaimPassageRef } from "../src/agent/claimLedger";

function passage(id: string, text: string): ClaimPassageRef {
  return { id, text };
}

test("renders passage bytes keyed by id with the copy-exactly contract", () => {
  const block = formatQuotablePassagesForWriteback([
    passage(
      "source:abc:passage:0-120",
      "The committee approved the final draft on Tuesday after a full review.",
    ),
  ]);
  assert.ok(block);
  assert.match(block, /QUOTABLE SOURCE PASSAGES/u);
  assert.match(block, /character-for-character/u);
  assert.match(block, /Quoting is optional\./u);
  assert.match(block, /\[source:abc:passage:0-120\]\nThe committee approved/u);
});

test("allowed ids filter passages instead of merely reordering them", () => {
  const block = formatQuotablePassagesForWriteback(
    [
      passage("allowed:passage:1", "Allowed passage bytes for quoting."),
      passage("stripped:passage:2", "Out-of-scope bytes that must not be offered."),
    ],
    { allowedPassageIds: ["allowed:passage:1"] },
  );
  assert.ok(block);
  assert.match(block, /\[allowed:passage:1\]/u);
  assert.doesNotMatch(block, /stripped:passage:2/u);
  assert.doesNotMatch(block, /must not be offered/u);
});

test("keeps the newest passages when the store exceeds the block budget", () => {
  const passages = Array.from({ length: 20 }, (_, index) =>
    passage(`p:${index}`, `Passage number ${index} body text.`),
  );
  const block = formatQuotablePassagesForWriteback(passages, { maxPassages: 3 });
  assert.ok(block);
  assert.doesNotMatch(block, /\[p:0\]/u);
  assert.match(block, /\[p:17\]/u);
  assert.match(block, /\[p:19\]/u);
});

test("truncation stays a verbatim substring: whitespace cut, no ellipsis", () => {
  const longText =
    "alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima " +
    "mike november oscar papa quebec romeo sierra tango uniform victor whiskey xray yankee zulu ".repeat(6);
  const block = formatQuotablePassagesForWriteback(
    [passage("long:passage:1", longText)],
    { maxCharsPerPassage: 200 },
  );
  assert.ok(block);
  const body = block.split("\n\n")[1].split("\n").slice(1).join("\n");
  assert.ok(body.length <= 200);
  assert.doesNotMatch(body, /(\.\.\.|…)$/u);
  assert.ok(longText.startsWith(body), "rendered body must be a verbatim prefix of the passage");
});

test("total budget bounds the block count but always renders at least one", () => {
  const passages = Array.from({ length: 12 }, (_, index) =>
    passage(`b:${index}`, "x".repeat(500)),
  );
  const block = formatQuotablePassagesForWriteback(passages, {
    maxTotalChars: 1_200,
    maxCharsPerPassage: 500,
  });
  assert.ok(block);
  const blockCount = (block.match(/\[b:\d+\]/gu) ?? []).length;
  assert.ok(blockCount >= 1 && blockCount <= 3, `unexpected block count ${blockCount}`);
});

test("returns null with no usable or no allowed passages", () => {
  assert.equal(formatQuotablePassagesForWriteback([]), null);
  assert.equal(
    formatQuotablePassagesForWriteback([passage("id:1", "   ")]),
    null,
  );
  assert.equal(
    formatQuotablePassagesForWriteback(
      [passage("id:1", "Real bytes.")],
      { allowedPassageIds: ["other:id"] },
    ),
    null,
  );
});
