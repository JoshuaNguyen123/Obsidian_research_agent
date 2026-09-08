import assert from "node:assert/strict";
import test from "node:test";

import {
  ACCEPTANCE_CRITERION_ID_PATTERN_V1,
  createProjectIdeaBriefV1,
  deriveAcceptedResearchSeedFromProjectIdeaBriefV1,
  parseProjectIdeaAcceptedResearchSeedV1,
  parseProjectIdeaBriefV1,
  ProjectIdeaBriefErrorV1,
  type ProjectIdeaBriefUnsignedV1,
} from "../packages/core-api/src";
import { createAcceptedResearchArtifactV1 } from "../src/integrations/linear/AcceptedResearchArtifactV1";

const CONTENT_SHA = `sha256:${"a".repeat(64)}`;

test("ProjectIdeaBriefV1 is an independently callable deterministic closed contract", () => {
  const input = groundedIdea();
  const first = createProjectIdeaBriefV1(input);
  const second = createProjectIdeaBriefV1(structuredClone(input));

  assert.match(first.fingerprint, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(first.fingerprint, second.fingerprint);
  assert.deepEqual(parseProjectIdeaBriefV1(structuredClone(first)), first);
  assert.equal(first.kind, "project_idea_brief");
  assert.equal(first.version, 1);
});

test("unverified ideation stands alone but cannot masquerade as accepted research", () => {
  const brief = createProjectIdeaBriefV1({
    ...groundedIdea(),
    selectedOptionId: null,
    evidenceStatus: "unverified",
    evidence: [],
    limitations: ["No source or vault evidence has been gathered yet."],
  });

  assert.equal(parseProjectIdeaBriefV1(brief).evidenceStatus, "unverified");
  assert.throws(
    () => deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief),
    (error: unknown) =>
      error instanceof ProjectIdeaBriefErrorV1 &&
      /cannot seed accepted research/iu.test(error.message),
  );
});

test("grounded selected ideation feeds accepted research without inventing evidence", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief);

  assert.equal(seed.projectIdeaFingerprint, brief.fingerprint);
  assert.equal(seed.selectedDirection.id, "option-a");
  assert.equal(seed.selectedOptionId, "option-a");
  assert.equal(seed.hypothesis, brief.hypothesis);
  assert.deepEqual(seed.options, brief.options);
  assert.deepEqual(seed.constraints, brief.constraints);
  assert.deepEqual(seed.limitations, brief.limitations);
  assert.deepEqual(seed.evidence, brief.evidence);
  assert.deepEqual(seed.acceptanceCriteria, brief.acceptanceCriteria);
  assert.notEqual(seed.evidence, brief.evidence);
  assert.notEqual(seed.acceptanceCriteria, brief.acceptanceCriteria);
  assert.equal(seed.kind, "project_idea_accepted_research_seed");
  assert.equal("noteSha256" in seed, false);
  assert.equal("noteReceiptId" in seed, false);
  assert.deepEqual(parseProjectIdeaAcceptedResearchSeedV1(seed), seed);
});

test("the exact ideation seed fits the existing accepted-research gate that feeds Linear", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief);
  const artifact = createAcceptedResearchArtifactV1({
    schemaVersion: 1,
    artifactId: "accepted-idea-checkers-accessibility",
    originRunId: "run-idea-1",
    vaultBindingKey: "vault-fixture",
    notePath: "Projects/Checkers/Research.md",
    noteSha256: `sha256:${"b".repeat(64)}`,
    noteReceiptId: "receipt-note-1",
    evidence: seed.evidence,
    acceptanceCriteria: seed.acceptanceCriteria,
    riskClass: seed.riskClass,
    acceptedAt: "2026-08-19T12:05:00.000Z",
    acceptedBy: "host",
    projectIdeaSeed: seed,
  });

  assert.deepEqual(artifact.evidence, brief.evidence);
  assert.deepEqual(artifact.acceptanceCriteria, brief.acceptanceCriteria);
  assert.equal(artifact.riskClass, brief.riskClass);
  assert.notEqual(artifact.artifactFingerprint, brief.fingerprint);
  assert.equal(
    artifact.projectIdeaSeed?.projectIdeaFingerprint,
    brief.fingerprint,
  );
});

test("durable ideation seed rejects selection and source-brief tampering after restart", () => {
  const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
    createProjectIdeaBriefV1(groundedIdea()),
  );
  assert.throws(
    () => parseProjectIdeaAcceptedResearchSeedV1({
      ...seed,
      hypothesis: "A restarted provider changed the hypothesis.",
    }),
    /fingerprint|source brief/iu,
  );
  assert.throws(
    () => parseProjectIdeaAcceptedResearchSeedV1({
      ...seed,
      selectedDirection: seed.options[1],
    }),
    /does not match/iu,
  );
});

test("promotion requires a selected evaluated option", () => {
  const brief = createProjectIdeaBriefV1({
    ...groundedIdea(),
    selectedOptionId: null,
  });
  assert.throws(
    () => deriveAcceptedResearchSeedFromProjectIdeaBriefV1(brief),
    /select one evaluated option/iu,
  );
});

test("ProjectIdeaBriefV1 rejects tampering, unknown fields, and false evidence claims", () => {
  const brief = createProjectIdeaBriefV1(groundedIdea());
  assert.throws(
    () => parseProjectIdeaBriefV1({ ...brief, problem: "Changed after signing." }),
    /fingerprint does not match/iu,
  );
  assert.throws(
    () => parseProjectIdeaBriefV1({ ...brief, providerAuthority: "none" }),
    /closed contract/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidenceStatus: "grounded",
        evidence: [],
      }),
    /require exact evidence/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        selectedOptionId: "missing-option",
      }),
    /must reference/iu,
  );
});

test("ProjectIdeaBriefV1 rejects unsafe evidence references and leaked credentials", () => {
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidence: [
          {
            id: "vault-1",
            kind: "vault",
            reference: "../Secrets.md",
            contentSha256: CONTENT_SHA,
          },
        ],
      }),
    /safe vault-relative Markdown path/iu,
  );
  assert.throws(
    () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        hypothesis: "Use api_key=super-secret-value to query the provider.",
      }),
    /secret-free/iu,
  );
});

/**
 * One entry per rule this module can reject on, driven through the real
 * validator. `states` is what the message must SAY: the constraint, in terms a
 * caller can act on without a second failed call.
 *
 * A qualification cohort died on this seat. The model was told "project idea
 * option 1 id is invalid" -- a field and no rule -- and its retry was a guess.
 * Three messages did worse than that: one sentence, "must be canonical bounded
 * secret-free text", was the whole answer for five different mistakes.
 */
const REJECTION_PROBES: ReadonlyArray<{
  name: string;
  run: () => unknown;
  states: readonly string[];
}> = [
  {
    name: "a logical id names the pattern it must match",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), ideaId: "not a valid id!" }),
    states: ["must be a logical id", "^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$", "1-160 characters"],
  },
  {
    name: "a non-string where text was required says so",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), title: 7 as unknown as string }),
    states: ["project idea title must be a string"],
  },
  {
    name: "an out-of-range length names the range and what arrived",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), title: "" }),
    states: ["must be 1-200 characters", "received 0"],
  },
  {
    name: "untrimmed text names the trim rule rather than 'canonical'",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), title: "  Padded title  " }),
    states: ["must not begin or end with whitespace"],
  },
  {
    name: "a line break in a single-line field names the line-break rule",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), title: "Two\nlines" }),
    states: ["must be a single line", "no carriage return"],
  },
  {
    name: "a NUL in narrative text names the NUL rule",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), problem: `A problem${"\u0000"}here.` }),
    states: ["must not contain a NUL character"],
  },
  {
    name: "over-long narrative text names its own bound",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), problem: "x".repeat(4_001) }),
    states: ["must be 1-4000 characters", "received 4001"],
  },
  {
    name: "a credential-shaped value names the shapes that are refused",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        hypothesis: "Use api_key=super-secret-value to query the provider.",
      }),
    states: ["must be secret-free text", "credential shape", "not quoted here"],
  },
  {
    name: "a list that is not a list says it must be one",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        proposedWork: "one thing" as unknown as string[],
      }),
    states: ["list must be an array of 1-20 strings"],
  },
  {
    name: "a list outside its bounds names the bounds and the count",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), proposedWork: [] }),
    states: ["list requires 1-20 entries", "received 0"],
  },
  {
    name: "a bound the caller cannot derive from the field carries its reason",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        selectedOptionId: null,
        evidenceStatus: "unverified",
        evidence: [],
        limitations: [],
      }),
    states: [
      "limitation list requires 1-10 entries",
      "An unverified idea must state at least one thing it could not verify",
    ],
  },
  {
    name: "a duplicate list entry names which entry repeats",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        proposedWork: ["Do the work.", "Do the work."],
      }),
    states: ["list entry 2 repeats an earlier entry", "must not contain duplicates"],
  },
  {
    name: "option count names the range and the count",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), options: [] }),
    states: ["require 1-5 entries", "received 0"],
  },
  {
    name: "a duplicate option id names the position and the uniqueness rule",
    run: () => {
      const base = groundedIdea();
      return createProjectIdeaBriefV1({
        ...base,
        options: [base.options[0]!, { ...base.options[1]!, id: base.options[0]!.id }],
      });
    },
    states: ["option 2 repeats the id of an earlier option", "must be unique"],
  },
  {
    name: "an unresolvable selection names what the value must equal",
    run: () =>
      createProjectIdeaBriefV1({ ...groundedIdea(), selectedOptionId: "missing-option" }),
    states: ["must reference one of the project idea options", "or be null"],
  },
  {
    name: "a criterion id names the pattern and the tolerated spellings",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        acceptanceCriteria: [{ id: "AC-0", text: "Out of range." }],
      }),
    // The published pattern itself, not a copy of it: the rejection has to
    // quote the same contract the tool schema advertises.
    states: [ACCEPTANCE_CRITERION_ID_PATTERN_V1, "n from 1 to 99", "no leading zeros"],
  },
  {
    name: "a duplicate criterion id names the canonical collision",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        acceptanceCriteria: [
          { id: "AC-1", text: "The first criterion." },
          { id: "ac-01", text: "The same criterion, respelled." },
        ],
      }),
    states: ["id AC-1 is duplicated", "each id must appear once"],
  },
  {
    name: "an evidence count names the range and the count",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidence: Array.from({ length: 51 }, (_unused, index) => ({
          id: `evidence-${index}`,
          kind: "user" as const,
          reference: `reference-${index}`,
          contentSha256: CONTENT_SHA,
        })),
      }),
    states: ["requires 0-50 entries", "received 51"],
  },
  {
    name: "a duplicate evidence id names the position and the uniqueness rule",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidence: [
          { id: "web-1", kind: "user", reference: "a", contentSha256: CONTENT_SHA },
          { id: "web-1", kind: "user", reference: "b", contentSha256: CONTENT_SHA },
        ],
      }),
    states: ["evidence 2 repeats the id of an earlier entry", "must be unique"],
  },
  {
    name: "an unparseable web reference names the form it must take",
    run: () => createProjectIdeaBriefV1(withWebReference("example.com/page")),
    states: ["must be an absolute HTTP(S) URL", "https://example.com/page"],
  },
  {
    name: "a non-HTTP scheme names the two schemes that are allowed",
    run: () => createProjectIdeaBriefV1(withWebReference("ftp://example.com/page")),
    states: ["must use the http: or https: scheme"],
  },
  {
    name: "a URL carrying userinfo names the component that is refused",
    run: () =>
      createProjectIdeaBriefV1(withWebReference("https://user:pw@example.com/page")),
    states: ["without credentials", "user:password@ component"],
  },
  {
    name: "a backslash in a vault path names the separator rule",
    run: () => createProjectIdeaBriefV1(withVaultReference("Notes\\Research.md")),
    states: ["safe vault-relative Markdown path", "separate folders with"],
  },
  {
    name: "an absolute vault path names the relative-to-root rule",
    run: () => createProjectIdeaBriefV1(withVaultReference("/Notes/Research.md")),
    states: ["relative to the vault root", "no drive letter"],
  },
  {
    name: "a traversal segment names the segment rule",
    run: () => createProjectIdeaBriefV1(withVaultReference("../Secrets.md")),
    states: ["must not contain a", "segment"],
  },
  {
    name: "a non-Markdown vault path names the extension rule",
    run: () => createProjectIdeaBriefV1(withVaultReference("Notes/Research.txt")),
    states: ["must end with the", ".md"],
  },
  {
    name: "a malformed hash names the exact fingerprint form",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        evidence: [
          { id: "web-1", kind: "user", reference: "a", contentSha256: "sha256:nope" },
        ],
      }),
    states: ["must be a SHA-256 fingerprint", "64 lowercase hexadecimal characters"],
  },
  {
    name: "a value outside a catalog names the catalog",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        riskClass: "extreme" as unknown as "low",
      }),
    states: ["fixed catalog: low, medium, high"],
  },
  {
    name: "an over-claimed evidence status names both ways out",
    run: () =>
      createProjectIdeaBriefV1({ ...groundedIdea(), evidenceStatus: "grounded", evidence: [] }),
    states: ["require exact evidence", "at least one evidence entry"],
  },
  {
    name: "an under-claimed evidence status names the opposite rule",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        selectedOptionId: null,
        evidenceStatus: "unverified",
        limitations: ["Nothing was verified."],
      }),
    states: ["must claim no evidence", "must be empty"],
  },
  {
    name: "an unparseable timestamp names the shape and an example",
    run: () => createProjectIdeaBriefV1({ ...groundedIdea(), createdAt: "yesterday" }),
    states: ["must be an ISO-8601 timestamp", "2026-08-19T12:00:00.000Z"],
  },
  {
    name: "a non-canonical timestamp names the canonical spelling",
    run: () =>
      createProjectIdeaBriefV1({ ...groundedIdea(), createdAt: "2026-08-19T12:00:00Z" }),
    states: ["must be a canonical ISO timestamp", "YYYY-MM-DDTHH:MM:SS.sssZ"],
  },
  {
    name: "an unexpected key names the contract size and counts what was extra",
    run: () =>
      parseProjectIdeaBriefV1({
        ...createProjectIdeaBriefV1(groundedIdea()),
        providerAuthority: "none",
      }),
    states: [
      "does not match its closed contract",
      "exactly these 19 keys",
      "Missing: none",
      "Unexpected keys supplied: 1",
    ],
  },
  {
    name: "a missing key is named, because the required list is this module's own",
    run: () => {
      const { fingerprint: _dropped, ...withoutFingerprint } =
        createProjectIdeaBriefV1(groundedIdea());
      return parseProjectIdeaBriefV1(withoutFingerprint);
    },
    states: ["Missing: fingerprint", "Unexpected keys supplied: 0"],
  },
  {
    name: "a non-object where an object was required says what is refused",
    run: () =>
      createProjectIdeaBriefV1({
        ...groundedIdea(),
        options: [[] as unknown as { id: string; title: string; summary: string }],
      }),
    states: ["must be a JSON object", "an array, null, or a primitive is rejected"],
  },
  {
    name: "an unsupported contract names the version and kind it wanted",
    run: () =>
      parseProjectIdeaBriefV1({ ...createProjectIdeaBriefV1(groundedIdea()), version: 2 }),
    states: ["version must be 1", 'kind must be "project_idea_brief"'],
  },
  {
    name: "a tampered brief says the fingerprint must be recomputed",
    run: () =>
      parseProjectIdeaBriefV1({
        ...createProjectIdeaBriefV1(groundedIdea()),
        problem: "Changed after signing.",
      }),
    states: ["fingerprint does not match", "must be recomputed"],
  },
  {
    name: "promotion from unverified ideation names the field to change",
    run: () =>
      deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
        createProjectIdeaBriefV1({
          ...groundedIdea(),
          selectedOptionId: null,
          evidenceStatus: "unverified",
          evidence: [],
          limitations: ["Nothing was verified."],
        }),
      ),
    states: ["cannot seed accepted research", 'set evidenceStatus to "grounded"'],
  },
  {
    name: "promotion without a selection names the field to set",
    run: () =>
      deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
        createProjectIdeaBriefV1({ ...groundedIdea(), selectedOptionId: null }),
      ),
    states: ["select one evaluated option", "set selectedOptionId"],
  },
  {
    name: "a foreign seed kind names the kind it must carry",
    run: () =>
      parseProjectIdeaAcceptedResearchSeedV1({
        ...deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
          createProjectIdeaBriefV1(groundedIdea()),
        ),
        kind: "something_else",
      }),
    states: ['kind must be "project_idea_accepted_research_seed"'],
  },
  {
    name: "a tampered seed names the verbatim-copy rule",
    run: () => {
      // Swap a field the brief reconstruction does NOT cover, so the seed's
      // own fingerprint still verifies and the comparison against the source
      // brief is the rule that actually fires.
      const seed = deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
        createProjectIdeaBriefV1(groundedIdea()),
      );
      return parseProjectIdeaAcceptedResearchSeedV1({
        ...seed,
        selectedDirection: seed.options[1],
      });
    },
    states: ["does not match its fingerprinted source brief", "copied verbatim"],
  },
];

test("every rejection states the rule it enforced, not only the field that broke", () => {
  const messages = new Set<string>();
  for (const probe of REJECTION_PROBES) {
    let message: string | null = null;
    try {
      probe.run();
    } catch (error) {
      assert.ok(
        error instanceof ProjectIdeaBriefErrorV1,
        `${probe.name}: expected a ProjectIdeaBriefErrorV1, got ${String(error)}`,
      );
      message = (error as Error).message;
    }
    // Positive proof, not an absence: a probe that stopped rejecting would
    // otherwise certify a well-worded message that is never produced.
    assert.ok(message !== null, `${probe.name}: the validator accepted the input`);
    messages.add(message);
    for (const clause of probe.states) {
      assert.ok(
        message.includes(clause),
        `${probe.name}: the rejection does not state its rule.\n  expected to contain: ${clause}\n  message: ${message}`,
      );
    }
  }

  assert.ok(
    messages.size >= 35,
    `only ${messages.size} distinct rejections were reached; the corpus is not exercising the module`,
  );

  for (const message of messages) {
    // The transport bound. A tool result is truncated downstream at 400
    // characters, and a rule that states itself past the cut states nothing.
    assert.ok(
      message.length <= 400,
      `a rejection is ${message.length} characters and will be truncated: ${message}`,
    );
    // The shape that killed the cohort: a verdict on a field, with no rule.
    assert.ok(
      !/\b(?:is|are)\s+(?:invalid|not valid|malformed|unacceptable|wrong)\.?$/iu.test(message),
      `a rejection names a field and no constraint: ${message}`,
    );
    // A rule is stated with a modal, and this module uses four of them: the
    // obligations ("must", "requires"), the prohibition ("cannot"), and the
    // uniqueness verdict ("repeats"). A message with none of these is a
    // verdict, not a rule.
    assert.ok(
      /\bmust\b|\brequire|\brepeats\b|\bcannot\b/u.test(message),
      `a rejection states no constraint verb: ${message}`,
    );
  }
});

/**
 * The sentinel is credential-SHAPED on purpose: `SECRET_VALUE` matches it, so
 * the module refuses it, and the question this test asks is what the refusal
 * says. `CREDENTIAL_ID` is the harder case -- a token that is a perfectly legal
 * logical id, so it reaches a rule that used to quote the offending id back.
 */
const SECRET_CORE = "SUPERSEKRET0123456789abcdef";
const SECRET_TEXT = `api_key=${SECRET_CORE}`;
const CREDENTIAL_ID = `sk-live-${SECRET_CORE}`;

test("no rejection can echo a secret-shaped value back to the caller", () => {
  const cases: ReadonlyArray<{ name: string; run: () => unknown }> = [
    {
      name: "free text carrying a credential",
      run: () => createProjectIdeaBriefV1({ ...groundedIdea(), problem: SECRET_TEXT }),
    },
    {
      name: "a single-line field carrying a credential",
      run: () => createProjectIdeaBriefV1({ ...groundedIdea(), title: SECRET_TEXT }),
    },
    {
      name: "a narrative list entry carrying a credential",
      run: () =>
        createProjectIdeaBriefV1({ ...groundedIdea(), proposedWork: [SECRET_TEXT] }),
    },
    {
      name: "an id field carrying a credential",
      run: () => createProjectIdeaBriefV1({ ...groundedIdea(), ideaId: SECRET_TEXT }),
    },
    {
      // The regression this pins. A token-shaped id passes LOGICAL_ID, so the
      // only rule it can break is uniqueness -- and that rejection used to be
      // "Project idea option id ${id} is duplicated."
      name: "a token-shaped option id that collides",
      run: () => {
        const base = groundedIdea();
        return createProjectIdeaBriefV1({
          ...base,
          selectedOptionId: CREDENTIAL_ID,
          options: [
            { ...base.options[0]!, id: CREDENTIAL_ID },
            { ...base.options[1]!, id: CREDENTIAL_ID },
          ],
        });
      },
    },
    {
      name: "a token-shaped evidence id that collides",
      run: () =>
        createProjectIdeaBriefV1({
          ...groundedIdea(),
          evidence: [
            { id: CREDENTIAL_ID, kind: "user", reference: "a", contentSha256: CONTENT_SHA },
            { id: CREDENTIAL_ID, kind: "user", reference: "b", contentSha256: CONTENT_SHA },
          ],
        }),
    },
    {
      name: "a URL carrying a password",
      run: () =>
        createProjectIdeaBriefV1(
          withWebReference(`https://user:${SECRET_CORE}@example.com/page`),
        ),
    },
    {
      name: "a vault path carrying a credential",
      run: () => createProjectIdeaBriefV1(withVaultReference(`../${SECRET_CORE}.md`)),
    },
    {
      name: "a content hash carrying a credential",
      run: () =>
        createProjectIdeaBriefV1({
          ...groundedIdea(),
          evidence: [
            { id: "web-1", kind: "user", reference: "a", contentSha256: SECRET_CORE },
          ],
        }),
    },
    {
      name: "an enumeration value carrying a credential",
      run: () =>
        createProjectIdeaBriefV1({
          ...groundedIdea(),
          riskClass: SECRET_CORE as unknown as "low",
        }),
    },
    {
      name: "a timestamp carrying a credential",
      run: () => createProjectIdeaBriefV1({ ...groundedIdea(), createdAt: SECRET_CORE }),
    },
    {
      name: "an unexpected key whose name and value are both credential-shaped",
      run: () =>
        parseProjectIdeaBriefV1({
          ...createProjectIdeaBriefV1(groundedIdea()),
          [`api_key_${SECRET_CORE}`]: SECRET_TEXT,
        }),
    },
    {
      name: "a promotion seed carrying a credential",
      run: () =>
        parseProjectIdeaAcceptedResearchSeedV1({
          ...deriveAcceptedResearchSeedFromProjectIdeaBriefV1(
            createProjectIdeaBriefV1(groundedIdea()),
          ),
          hypothesis: SECRET_TEXT,
        }),
    },
  ];

  let rejected = 0;
  for (const probe of cases) {
    let message: string | null = null;
    try {
      probe.run();
    } catch (error) {
      message = (error as Error).message;
    }
    assert.ok(
      message !== null,
      `${probe.name}: the validator accepted a credential-carrying value`,
    );
    rejected += 1;
    assert.ok(
      !message.includes(SECRET_CORE),
      `${probe.name}: the rejection quoted the offending value back: ${message}`,
    );
    // Nothing credential-SHAPED may reach the message either, however it got
    // there -- a paraphrase that reconstructed "api_key=..." would be just as
    // bad as an echo.
    assert.ok(
      !/(?:\bBearer\s+[A-Za-z0-9._~+/=-]{8,}|\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*\S+)/iu.test(
        message,
      ),
      `${probe.name}: the rejection itself carries a credential shape: ${message}`,
    );
  }
  // Vacuous-input insurance: every case above must actually have rejected, or
  // "no message echoed a secret" is a statement about no messages.
  assert.equal(rejected, cases.length);
});

function withWebReference(reference: string): ProjectIdeaBriefUnsignedV1 {
  return {
    ...groundedIdea(),
    evidence: [{ id: "web-1", kind: "web", reference, contentSha256: CONTENT_SHA }],
  };
}

function withVaultReference(reference: string): ProjectIdeaBriefUnsignedV1 {
  return {
    ...groundedIdea(),
    evidence: [{ id: "vault-1", kind: "vault", reference, contentSha256: CONTENT_SHA }],
  };
}

function groundedIdea(): ProjectIdeaBriefUnsignedV1 {
  return {
    ideaId: "idea-checkers-accessibility",
    title: "Accessible checkers move guidance",
    problem:
      "New players cannot tell why a candidate move is legal or useful, which makes early sessions frustrating.",
    hypothesis:
      "Concise move explanations will help new players complete a game with fewer abandoned turns.",
    options: [
      {
        id: "option-a",
        title: "Explain the selected move",
        summary:
          "Show one short legality and strategy explanation after a player selects a piece.",
      },
      {
        id: "option-b",
        title: "Show every legal move",
        summary:
          "Highlight all legal moves without explaining their strategic consequence.",
      },
    ],
    selectedOptionId: "option-a",
    proposedWork: [
      "Calculate legal destinations for the selected piece.",
      "Render one concise explanation for each displayed destination.",
    ],
    nonGoals: ["Do not add an automated opponent in this iteration."],
    constraints: ["Keep the rules engine deterministic and locally testable."],
    risks: ["Explanations may obscure the board on small screens."],
    acceptanceCriteria: [
      {
        id: "AC-1",
        text: "Every displayed destination is legal under the existing rules.",
      },
      {
        id: "AC-2",
        text: "Each destination includes one concise human-readable explanation.",
      },
    ],
    evidenceStatus: "grounded",
    evidence: [
      {
        id: "web-1",
        kind: "web",
        reference: "https://example.com/research/checkers-learning",
        contentSha256: CONTENT_SHA,
      },
    ],
    riskClass: "low",
    limitations: ["The source does not measure long-term player retention."],
    createdAt: "2026-08-19T12:00:00.000Z",
  };
}
