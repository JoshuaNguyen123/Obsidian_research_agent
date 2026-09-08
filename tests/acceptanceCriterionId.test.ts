import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createProjectIdeaBriefV1,
  type ProjectIdeaBriefUnsignedV1,
} from "../packages/core-api/src";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";
import {
  ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1,
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
  isCanonicalAcceptanceCriterionIdV1,
  normalizeAcceptanceCriterionIdV1,
} from "../src/integrations/linear/acceptanceCriterionIdV1";
import { parseAcceptedResearchNotePackageV1 } from "../src/integrations/linear/AcceptedResearchNoteWriter";
import { createWorkItemSpecV1 } from "../src/integrations/linear/WorkItemSpecV1";
import { createProjectIdeaBriefTool } from "../src/tools/projectIdeaBriefTool";

const FIXTURE_SHA = `sha256:${"a".repeat(64)}`;

test("the id contract is published to the model, not only enforced after the call", () => {
  // The defect this pins: `create_project_idea_brief` declared the criterion id
  // as a bare string with no pattern and no description, while three separate
  // validators rejected anything but `AC-<n>`. A real compound run burned a
  // tool call discovering by failure a rule the schema could have stated.
  // Assert through the tool surface the MODEL actually receives, not a private
  // const -- the point is what the caller can see.
  const schema = createProjectIdeaBriefTool().parameters as unknown as {
    properties: {
      acceptanceCriteria: {
        items: { properties: { id: Record<string, unknown> } };
      };
    };
  };
  const id = schema.properties.acceptanceCriteria.items.properties.id;
  assert.equal(id.pattern, ACCEPTANCE_CRITERION_ID_PATTERN_V1);
  assert.equal(id.description, ACCEPTANCE_CRITERION_ID_DESCRIPTION_V1);
  // The published pattern must actually be the rule the validators apply --
  // a schema advertising a DIFFERENT contract than the one enforced would be
  // worse than advertising none.
  const published = new RegExp(ACCEPTANCE_CRITERION_ID_PATTERN_V1, "u");
  for (const accepted of ["AC-1", "AC-9", "AC-10", "AC-99"]) {
    assert.ok(published.test(accepted), `${accepted} must satisfy the published pattern`);
    assert.ok(isCanonicalAcceptanceCriterionIdV1(accepted));
  }
  for (const rejected of ["AC-0", "AC-100", "AC-01", "ac-1", "AC1", "1"]) {
    assert.ok(!published.test(rejected), `${rejected} must not satisfy the published pattern`);
  }
});

test("the obvious spellings of one intent normalize instead of failing the call", () => {
  // Lenient at the boundary, canonical in storage. Each variant maps to exactly
  // one id, so this cannot merge two distinct criteria.
  for (const [input, expected] of [
    ["AC-7", "AC-7"],
    ["  AC-7  ", "AC-7"],
    ["ac-7", "AC-7"],
    ["Ac-7", "AC-7"],
    ["AC7", "AC-7"],
    ["ac7", "AC-7"],
    ["AC-07", "AC-7"],
    ["7", "AC-7"],
    ["07", "AC-7"],
    ["AC 7", "AC-7"],
    ["AC-99", "AC-99"],
    ["99", "AC-99"],
  ] as const) {
    assert.equal(
      normalizeAcceptanceCriterionIdV1(input),
      expected,
      `${JSON.stringify(input)} should normalize to ${expected}`,
    );
  }
});

test("ambiguous or out-of-range ids still fail closed", () => {
  // Tolerating variant SPELLINGS must not become tolerating variant MEANINGS.
  for (const rejected of [
    "AC-0",
    "0",
    "AC-100",
    "100",
    "AC-",
    "AC",
    "",
    "   ",
    "criterion 1",
    "AC-1: the text",
    "AC--1",
    "XC-1",
    "AC-1a",
    "-1",
    null,
    undefined,
    7,
    { id: "AC-1" },
  ]) {
    assert.equal(
      normalizeAcceptanceCriterionIdV1(rejected as unknown),
      null,
      `${JSON.stringify(rejected)} must be refused`,
    );
  }
});

test("normalization makes a duplicate visible that three separate regexes could not", () => {
  // "AC-1" and "ac-01" are the same criterion. Before normalization each seat
  // compared raw strings, so a caller could submit both and the duplicate check
  // would pass while the rendered issue carried two AC-1 rows.
  assert.equal(normalizeAcceptanceCriterionIdV1("AC-1"), "AC-1");
  assert.equal(normalizeAcceptanceCriterionIdV1("ac-01"), "AC-1");
  assert.equal(
    normalizeAcceptanceCriterionIdV1("AC-1"),
    normalizeAcceptanceCriterionIdV1("ac-01"),
  );
});

/**
 * The four seats that turn a caller-supplied acceptance-criterion id into a
 * stored one, each driven through its own real validator rather than through a
 * restatement of its rules. Each returns the id as stored, or null when the
 * seat refuses the value.
 *
 * `ProjectIdeaBriefV1` is the seat whose rejection motivated the shared
 * normalizer, and it was the last one still enforcing its own inlined copy.
 */
const SEATS: ReadonlyArray<readonly [string, (id: string) => string | null]> = [
  ["ProjectIdeaBriefV1", storedByProjectIdeaBrief],
  ["AcceptedResearchArtifactV1", storedByAcceptedResearchArtifact],
  ["AcceptedResearchNoteWriter", storedByAcceptedResearchNotePackage],
  ["WorkItemSpecV1", storedByWorkItemSpec],
];

test("all four seats answer one predicate, including the forms that drifted", () => {
  // Before this call the brief seat rejected `ac-01`, `AC1` and `AC-01` while
  // the three Linear validators downstream accepted and canonicalized them --
  // so a model could satisfy the seat that publishes to Linear and still fail
  // the seat that creates the brief in the first place. The table is the
  // agreement, asserted seat-by-seat so a single drifting seat is named.
  const table: ReadonlyArray<readonly [string, string | null]> = [
    // Canonical.
    ["AC-1", "AC-1"],
    ["AC-9", "AC-9"],
    ["AC-10", "AC-10"],
    ["AC-99", "AC-99"],
    // The drifted forms: accepted by the three Linear seats, refused by the
    // brief seat until the fourth copy was routed through the normalizer.
    ["ac-01", "AC-1"],
    ["AC1", "AC-1"],
    ["AC-01", "AC-1"],
    ["ac-1", "AC-1"],
    ["Ac-7", "AC-7"],
    ["AC 7", "AC-7"],
    ["  AC-7  ", "AC-7"],
    ["7", "AC-7"],
    ["07", "AC-7"],
    // Ambiguous or out of range: every seat must still fail closed.
    ["AC-0", null],
    ["AC-100", null],
    ["0", null],
    ["AC", null],
    ["AC--1", null],
    ["XC-1", null],
    ["AC-1a", null],
    ["AC-1: the text", null],
    ["", null],
  ];

  for (const [input, expected] of table) {
    for (const [seat, store] of SEATS) {
      assert.equal(
        store(input),
        expected,
        `${seat} stored ${JSON.stringify(input)} as ${JSON.stringify(
          store(input),
        )}, but every seat must agree on ${JSON.stringify(expected)}`,
      );
    }
  }
});

test("routing the fourth seat through the normalizer canonicalizes what it stores", () => {
  // The behaviour change this closes, stated as a value rather than a claim:
  // the brief seat now ACCEPTS the variant spellings, and what it persists --
  // and therefore what its fingerprint covers -- is the canonical form, so a
  // tolerated variant never reaches a promotion seed or a rendered issue.
  const brief = createProjectIdeaBriefV1(
    groundedIdeaFixture([
      { id: "ac-01", text: "The first criterion holds." },
      { id: "AC2", text: "The second criterion holds." },
    ]),
  );
  assert.deepEqual(
    brief.acceptanceCriteria.map((criterion) => criterion.id),
    ["AC-1", "AC-2"],
  );
  // Two spellings of one id are now a duplicate rather than two criteria --
  // the collision four separate regexes could not see.
  assert.throws(
    () =>
      createProjectIdeaBriefV1(
        groundedIdeaFixture([
          { id: "AC-1", text: "The first criterion holds." },
          { id: "ac-01", text: "The same criterion, spelled differently." },
        ]),
      ),
    /acceptance criterion id AC-1 is duplicated/iu,
  );
});

/**
 * The set of files that enforce this id form, derived rather than listed.
 *
 * The previous guard named three seats by hand. The product had four, so the
 * fourth copy -- the one in `packages/core-api/src/projectIdeaBriefV1.ts` that
 * had already drifted in effect -- was never in scope of the check that was
 * supposed to prevent exactly it. A guard whose file list is narrower than the
 * product's does not fail; it reports success over the subset it can see, and
 * this repository has already paid for that twice.
 *
 * So the seat list is computed from the tree: exactly one file may carry the
 * pattern, and it is the file that defines it. Every other file gets the rule
 * by importing it.
 *
 * The exemption that is deliberately NOT offered is "the file already imports
 * something from the shared module". That was the first shape of this guard,
 * and reverting the routing in `projectIdeaBriefV1.ts` did not turn it red:
 * the file still imported ACCEPTANCE_CRITERION_ID_PATTERN_V1 for its rejection
 * text, so the private regex it had just re-grown was waved through. A guard
 * with an exemption is a guard the next copy will satisfy.
 */
const RULE_COPY = /(?:\/|["'`])\^?AC-\[1-9\]\[0-9\]\?\$?(?:\/|["'`])/u;
// Anchored to the start of a line, which is where a real export declaration
// sits and where a mention of one -- inside a regex literal, a string, or an
// indented comment -- does not. Without the anchor this very file counts as a
// second definition of the rule, because it names the declaration it is
// looking for. Excluding this file by name would have hidden that; making the
// predicate precise enough to tell a declaration from a mention does not.
const RULE_DEFINITION = /^export function normalizeAcceptanceCriterionIdV1\b/mu;
const UNSCANNED_DIRECTORIES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "test-results",
  "playwright-report",
]);

interface RuleSeatScanV1 {
  scanned: number;
  definitions: string[];
  /** Carries a copy of the pattern while not being the file that defines it. */
  inlinedCopies: string[];
}

function scanForRuleCopies(root: URL): RuleSeatScanV1 {
  const scan: RuleSeatScanV1 = { scanned: 0, definitions: [], inlinedCopies: [] };
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || UNSCANNED_DIRECTORIES.has(entry.name)) {
        continue;
      }
      const full = join(directory, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(full, name);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      scan.scanned += 1;
      const source = readFileSync(full, "utf8");
      const defines = RULE_DEFINITION.test(source);
      if (defines) scan.definitions.push(name);
      if (!RULE_COPY.test(source) || defines) continue;
      scan.inlinedCopies.push(name);
    }
  };
  walk(fileURLToPath(root), "");
  scan.definitions.sort();
  scan.inlinedCopies.sort();
  return scan;
}

/**
 * Copies of the rule that are known, still unrouted, and deliberately left
 * alone by the change that derived this guard: both live outside the territory
 * that change was allowed to touch. This is a quarantine, not a seat list --
 * it may only shrink. Routing one of these through the shared module makes
 * this assertion fail until its line here is deleted, which is the point: a
 * pin that outlives the defect it records is the next inert guard.
 *
 * A copy that is NOT on this list fails the guard the moment it appears, which
 * is the property the hand-written seat list did not have.
 */
const KNOWN_UNROUTED_RULE_COPIES = [
  // `parseAcceptanceCriteria` re-inlines the pattern the V1 spec now imports.
  "src/integrations/linear/WorkItemSpecV2.ts",
  // `isValidCriterionIdentifier`, the publication tool's own criterion check.
  "src/tools/researchPublicationTool.ts",
];

test("one definition serves every seat, and the seat list is derived, not declared", () => {
  const scan = scanForRuleCopies(new URL("../", import.meta.url));

  // Vacuous-input insurance. A walk that stopped descending, or a pattern that
  // stopped matching, would otherwise report a perfectly consolidated rule
  // over an empty scan. Both halves are positive proofs: the scan reached the
  // tree, and it found the definition it is measuring everything else against.
  assert.ok(
    scan.scanned > 500,
    `only ${scan.scanned} TypeScript files scanned; the walk is not reaching the repository`,
  );
  assert.deepEqual(
    scan.definitions,
    ["packages/core-api/src/acceptanceCriterionIdV1.ts"],
    "the rule must have exactly one definition, and it must be the shared module",
  );

  assert.deepEqual(
    scan.inlinedCopies,
    KNOWN_UNROUTED_RULE_COPIES,
    "a file carries its own copy of the acceptance-criterion id pattern: import normalizeAcceptanceCriterionIdV1 (or isCanonicalAcceptanceCriterionIdV1) from the shared module instead, and if you routed one of the quarantined copies, delete its line from KNOWN_UNROUTED_RULE_COPIES",
  );
});

test("the derived guard is not vacuous: a fifth inlined copy fails it", () => {
  // Drive the real scanner over a real tree, because the failure this guards
  // against is the scanner not seeing a file at all. A synthetic root carries
  // the shared definition, one routed consumer, and one new inlined copy; only
  // the last may be reported.
  //
  // The fifth copy is written from the shared constant rather than typed out,
  // so that proving the guard works does not itself plant a literal copy of
  // the pattern in this file -- which the guard would then have to report.
  const root = mkdtempSync(join(tmpdir(), "ac-id-guard-"));
  try {
    mkdirSync(join(root, "packages", "core-api", "src"), { recursive: true });
    mkdirSync(join(root, "src", "seats"), { recursive: true });
    copyFileSync(
      fileURLToPath(
        new URL("../packages/core-api/src/acceptanceCriterionIdV1.ts", import.meta.url),
      ),
      join(root, "packages", "core-api", "src", "acceptanceCriterionIdV1.ts"),
    );
    writeFileSync(
      join(root, "src", "seats", "routedSeat.ts"),
      [
        'import { normalizeAcceptanceCriterionIdV1 } from "../shared";',
        "",
        "// Enforces the rule without restating it, which is the whole point.",
        "export const store = (id: unknown) => normalizeAcceptanceCriterionIdV1(id);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "src", "seats", "fifthCopy.ts"),
      [
        "export function isCriterionId(value: unknown): boolean {",
        `  return typeof value === "string" && /${ACCEPTANCE_CRITERION_ID_PATTERN_V1}/u.test(value);`,
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    const scan = scanForRuleCopies(pathToFileURL(`${root}/`));
    assert.deepEqual(scan.definitions, [
      "packages/core-api/src/acceptanceCriterionIdV1.ts",
    ]);
    assert.deepEqual(
      scan.inlinedCopies,
      ["src/seats/fifthCopy.ts"],
      "the scanner must flag a newly inlined copy and must not flag a routed consumer",
    );
    // And the assertion the real guard makes would fail on it, rather than
    // widening to absorb it.
    assert.throws(
      () => assert.deepEqual(scan.inlinedCopies, KNOWN_UNROUTED_RULE_COPIES),
      assert.AssertionError,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function groundedIdeaFixture(
  acceptanceCriteria: ReadonlyArray<{ id: string; text: string }>,
): ProjectIdeaBriefUnsignedV1 {
  return {
    ideaId: "idea-acceptance-criterion-agreement",
    title: "One acceptance-criterion id rule",
    problem: "Four validators disagreed about the same criterion id spelling.",
    hypothesis: "One shared predicate removes the disagreement at every seat.",
    options: [
      {
        id: "option-a",
        title: "Route every seat through the shared normalizer",
        summary: "Each seat calls one predicate and stores the canonical form.",
      },
    ],
    selectedOptionId: "option-a",
    proposedWork: ["Route the remaining inlined copy through the normalizer."],
    nonGoals: ["Do not widen what the canonical stored form may look like."],
    constraints: ["Storage stays canonical even when the boundary is lenient."],
    risks: ["A tolerated spelling could mask a genuinely distinct criterion."],
    acceptanceCriteria: acceptanceCriteria.map((criterion) => ({ ...criterion })),
    evidenceStatus: "grounded",
    evidence: [
      {
        id: "web-1",
        kind: "web",
        reference: "https://example.com/research/acceptance-criteria",
        contentSha256: FIXTURE_SHA,
      },
    ],
    riskClass: "low",
    limitations: ["The agreement is asserted over one table of id spellings."],
    createdAt: "2026-09-07T12:00:00.000Z",
  };
}

/**
 * Each seat below drives its real validator and reports only what that seat
 * STORED, so the table above compares behaviour rather than error text. A seat
 * that refuses the value reports null, whatever exception type it happens to
 * raise.
 */
function stored(
  run: () => ReadonlyArray<{ id: string }>,
): string | null {
  try {
    return run()[0]?.id ?? null;
  } catch {
    return null;
  }
}

function storedByProjectIdeaBrief(id: string): string | null {
  return stored(
    () =>
      createProjectIdeaBriefV1(
        groundedIdeaFixture([{ id, text: "The criterion holds." }]),
      ).acceptanceCriteria,
  );
}

function storedByAcceptedResearchArtifact(id: string): string | null {
  return stored(
    () =>
      createAcceptedResearchArtifactV1({
        schemaVersion: 1,
        artifactId: "accepted-acceptance-criterion-agreement",
        originRunId: "run-agreement-1",
        vaultBindingKey: "vault-fixture",
        notePath: "Projects/Agreement/Research.md",
        noteSha256: FIXTURE_SHA,
        noteReceiptId: "receipt-note-1",
        evidence: [
          {
            id: "web-1",
            kind: "web",
            reference: "https://example.com/research/acceptance-criteria",
            contentSha256: FIXTURE_SHA,
          },
        ],
        acceptanceCriteria: [{ id, text: "The criterion holds." }],
        riskClass: "low",
        acceptedAt: "2026-09-07T12:05:00.000Z",
        acceptedBy: "host",
      }).acceptanceCriteria,
  );
}

function storedByAcceptedResearchNotePackage(id: string): string | null {
  return stored(
    () =>
      parseAcceptedResearchNotePackageV1({
        schemaVersion: 1,
        title: "One acceptance-criterion id rule",
        problemImpact: "Four validators disagreed about one criterion id.",
        evidence: [
          {
            id: "web-1",
            kind: "web",
            reference: "https://example.com/research/acceptance-criteria",
            contentSha256: FIXTURE_SHA,
            label: "Evidence",
            summary: "Supports the work.",
          },
        ],
        confidenceLimitations: "The agreement is asserted over one table.",
        proposedWork: ["Route the remaining inlined copy."],
        nonGoals: ["Do not widen the canonical stored form."],
        scope: ["The four acceptance-criterion seats."],
        dependencies: [],
        acceptanceCriteria: [{ id, text: "The criterion holds." }],
        validationRequirementKeys: ["trusted.validation"],
        riskClass: "low",
        executionClass: "research",
        objective: "Make every seat answer one acceptance-criterion predicate.",
        vaultBindingKey: "vault-fixture",
        originRunId: "run-agreement-1",
      }).acceptanceCriteria,
  );
}

function storedByWorkItemSpec(id: string): string | null {
  return stored(
    () =>
      createWorkItemSpecV1({
        schemaVersion: 1,
        ready: true,
        executionClass: "research",
        objective: "Make every seat answer one acceptance-criterion predicate.",
        acceptanceCriteria: [{ id, text: "The criterion holds." }],
        validationRequirements: ["npm test"],
        evidenceRefs: ["https://example.com/research/acceptance-criteria"],
        riskClass: "low",
        originRunId: "run-agreement-1",
        generation: 0,
      }).acceptanceCriteria,
  );
}
