import test from "node:test";
import assert from "node:assert/strict";
import {
  addSourceCandidate,
  buildResearchQueryVariants,
  claimSourceCandidate,
  computeSourceProofDebt,
  createSourceCandidateLedger,
  recordSourceCandidateOutcome,
} from "../src/orchestrator/sourceCandidateLedger";
import {
  analyzeTemplateDocument,
  discoverAndRankTemplates,
  dryRenderTemplate,
  groupMissingTemplateFields,
  suggestCollisionFreeTemplatePath,
  verifyRenderedTemplate,
} from "../src/orchestrator/templateIntelligence";
import {
  buildTransactionalResearchPackPlan,
  createResearchTemplateWorkflow,
  reduceResearchTemplateWorkflow,
  stableContentHash,
  verifyTransactionalResearchPack,
  type ResearchTemplateWorkflowEvent,
} from "../src/orchestrator/researchTemplateWorkflow";
import {
  applySourceDeltasToResearchMemory,
  computeResearchSourceDeltas,
  evaluateContinuousResearchRun,
  evaluateContinuousResearchVerification,
  hashResearchSource,
  supersedeResearchMemory,
  transitionResearchMemory,
  type ContinuousResearchPolicy,
  type ResearchMemoryRecord,
} from "../src/orchestrator/continuousResearch";

test("continuous research verification fails closed on clarification or missing hashes", () => {
  const base = {
    acceptancePassed: true,
    acceptedEvidenceCount: 1,
    previousSourceHashes: { "https://example.com/": "old" },
    currentSourceHashes: { "https://example.com/": "new" },
  };
  assert.equal(
    evaluateContinuousResearchVerification({
      ...base,
      terminalSucceeded: false,
    }),
    false,
  );
  assert.equal(
    evaluateContinuousResearchVerification({
      ...base,
      terminalSucceeded: true,
      currentSourceHashes: {},
    }),
    false,
  );
  assert.equal(
    evaluateContinuousResearchVerification({
      ...base,
      terminalSucceeded: true,
    }),
    true,
  );
});

test("source candidate ledger deduplicates URLs, leases work, and exposes proof debt", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  let ledger = createSourceCandidateLedger({
    runId: "run-roi",
    query: "template intelligence",
    now,
    proofRequirements: [
      {
        claimId: "claim-1",
        description: "Template selection is metadata aware.",
        minUsableSources: 2,
        preferredSourceTypes: ["primary"],
      },
    ],
  });
  const first = addSourceCandidate(
    ledger,
    {
      id: "official",
      query: "template intelligence",
      title: "Official guide",
      url: "HTTPS://Example.com/guide/?utm_source=test&b=2&a=1#section",
      sourceType: "official",
      signals: { quality: 0.9, freshness: 0.7, fetchability: 0.9 },
      claimIds: ["claim-1"],
    },
    now,
  );
  ledger = first.ledger;
  const duplicate = addSourceCandidate(
    ledger,
    {
      query: "another query",
      title: "Same official guide",
      url: "https://example.com/guide?a=1&b=2",
      sourceType: "official",
      signals: { quality: 0.8, freshness: 0.8, fetchability: 0.8 },
      claimIds: ["claim-1"],
    },
    now,
  );
  assert.equal(duplicate.deduplicated, true);
  assert.equal(Object.keys(duplicate.ledger.candidates).length, 1);
  assert.equal(duplicate.ledger.duplicateCount, 1);
  ledger = duplicate.ledger;

  const claimed = claimSourceCandidate(ledger, "official", "researcher", {
    now,
    leaseMs: 60_000,
  });
  assert.equal(claimed.accepted, true);
  const collision = claimSourceCandidate(claimed.ledger, "official", "lead", {
    now: new Date(now.getTime() + 1_000),
  });
  assert.equal(collision.reason, "leased");
  ledger = recordSourceCandidateOutcome(claimed.ledger, "official", {
    status: "usable",
    evidenceIds: ["evidence-official"],
  });
  assert.deepEqual(computeSourceProofDebt(ledger), [
    {
      claimId: "claim-1",
      description: "Template selection is metadata aware.",
      required: 2,
      accepted: 1,
      missing: 1,
      acceptedCandidateIds: ["official"],
      preferredTypesMissing: ["primary"],
    },
  ]);

  const primary = addSourceCandidate(ledger, {
    id: "primary",
    query: "template intelligence",
    title: "Specification",
    url: "https://standards.example/spec",
    sourceType: "primary",
    signals: { quality: 1, freshness: 0.8, fetchability: 1 },
    claimIds: ["claim-1"],
  });
  ledger = recordSourceCandidateOutcome(primary.ledger, "primary", {
    status: "usable",
    evidenceIds: ["evidence-primary"],
  });
  assert.deepEqual(computeSourceProofDebt(ledger), []);
});

test("query variants are bounded, deterministic, and domain-aware", () => {
  const variants = buildResearchQueryVariants("  source   verification ", {
    preferredDomains: ["https://openai.com/docs", "openai.com"],
    maxVariants: 6,
  });
  assert.equal(variants[0], "source verification");
  assert.ok(variants.includes("source verification filetype:pdf"));
  assert.ok(variants.includes("source verification site:openai.com"));
  assert.equal(new Set(variants).size, variants.length);
  assert.ok(variants.length <= 6);
});

test("template intelligence ranks metadata and renders only declared values and safe builtins", () => {
  const ranked = discoverAndRankTemplates(
    [
      {
        path: "Templates/Meeting.md",
        content: "# {{title}}\n\n{{notes}}",
        metadata: { kind: "meeting", tags: ["team"] },
      },
      {
        path: "Templates/Research Brief.md",
        content:
          "---\ntitle: {{frontmatter_title}}\ndate: {{date}}\n---\n# {{title}}\n\nTopic: {{topic}}\nAudience: {{audience}}",
        metadata: {
          kind: "research",
          tags: ["sources", "brief"],
          description: "A source-backed research brief",
          fields: [
            { name: "topic", required: true, group: "Research" },
            {
              name: "audience",
              required: false,
              defaultValue: "Internal",
              group: "Optional",
            },
          ],
        },
      },
    ],
    {
      query: "research brief sources",
      kind: "research",
      tags: ["sources"],
      availableValues: { topic: "Agent orchestration" },
    },
  );
  assert.equal(ranked[0].path, "Templates/Research Brief.md");
  assert.ok(ranked[0].score > ranked[1].score);

  const missing = groupMissingTemplateFields(ranked[0].fields, {});
  assert.deepEqual(missing.map((group) => [group.group, group.fields.map((field) => field.name)]), [
    ["Research", ["topic"]],
  ]);
  const rendered = dryRenderTemplate(ranked[0], {
    title: "Agent Orchestration\nInjected",
    now: new Date(2026, 6, 10, 14, 5, 6),
    values: { topic: "Safe template rendering" },
  });
  assert.equal(rendered.canCreate, true);
  assert.match(rendered.content, /title: "Agent Orchestration Injected"/);
  assert.match(rendered.content, /date: 2026-07-10/);
  assert.match(rendered.content, /Audience: Internal/);
  assert.deepEqual(rendered.unresolvedPlaceholders, []);

  const collision = suggestCollisionFreeTemplatePath(
    "Research/Agent Orchestration.md",
    ["research/agent orchestration.md", "Research/Agent Orchestration 2.md"],
  );
  assert.equal(collision, "Research/Agent Orchestration 3.md");
  assert.equal(verifyRenderedTemplate(rendered.content, rendered.content.replace(/\n/g, "\r\n")).passed, true);
  assert.equal(verifyRenderedTemplate(rendered.content, `${rendered.content}\n{{missing}}`).passed, false);
});

test("template analysis infers required fields while excluding safe builtins", () => {
  const template = analyzeTemplateDocument({
    path: "Templates/Quick.md",
    content: "# {{title}}\n{{topic}} on {{date}}",
  });
  assert.deepEqual(template.placeholders, ["title", "topic", "date"]);
  assert.deepEqual(template.fields.map((field) => field.name), ["topic"]);
});

test("research template workflow enforces ordered durable phases and verifies a collision-safe pack", () => {
  const initial = createResearchTemplateWorkflow({
    id: "workflow-1",
    runId: "run-1",
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  const plan = buildTransactionalResearchPackPlan({
    transactionId: "tx-1",
    baseFolder: "Research",
    title: "Agent Teams",
    brief: "Define the decision and scope.",
    sources: [
      {
        id: "source-1",
        title: "Primary source",
        url: "https://example.com/source",
        passage: "A verified passage.",
      },
    ],
    synthesis: "The evidence supports a bounded two-agent preview.",
    existingPaths: ["Research/Agent Teams/Brief.md"],
  });
  assert.equal(plan.rootPath, "Research/Agent Teams 2");
  assert.deepEqual(plan.artifacts.map((artifact) => artifact.role), [
    "brief",
    "sources",
    "synthesis",
    "index",
  ]);
  assert.ok(plan.artifacts.every((artifact) => artifact.mustNotExist));

  const preview = "# Agent Teams\n\nPreview.";
  const events: ResearchTemplateWorkflowEvent[] = [
    workflowEvent(1, { kind: "template_selected", templatePath: "Templates/Research.md" }),
    workflowEvent(2, {
      kind: "research_completed",
      findings: [
        {
          id: "finding-1",
          summary: "Bounded delegation improves coverage.",
          sourceIds: ["source-1"],
          confidence: "high",
        },
      ],
    }),
    workflowEvent(3, { kind: "fields_resolved", values: { topic: "Agent Teams" } }),
    workflowEvent(4, { kind: "preview_prepared", content: preview }),
    workflowEvent(5, {
      kind: "preview_approved",
      approvedHash: stableContentHash(preview),
    }),
    workflowEvent(6, {
      kind: "pack_created",
      plan,
      createdPaths: plan.verifyPaths,
    }),
    workflowEvent(7, {
      kind: "verification_completed",
      passed: true,
      verifiedPaths: plan.verifyPaths,
    }),
  ];
  const completed = events.reduce(reduceResearchTemplateWorkflow, initial);
  assert.equal(completed.status, "complete");
  assert.equal(completed.phase, "complete");
  assert.deepEqual(completed.completedPhases, [
    "discover",
    "research",
    "resolve",
    "preview",
    "create",
    "verify",
  ]);

  const readBack = Object.fromEntries(
    plan.artifacts.map((artifact) => [artifact.path, artifact.content]),
  );
  assert.equal(verifyTransactionalResearchPack(plan, readBack).passed, true);
  readBack[plan.artifacts[0].path] = "changed";
  assert.deepEqual(verifyTransactionalResearchPack(plan, readBack).mismatchedPaths, [
    plan.artifacts[0].path,
  ]);
});

test("research template workflow blocks out-of-order approval and preserves blocked phase", () => {
  const initial = createResearchTemplateWorkflow({ id: "wf", runId: "run-1" });
  assert.throws(
    () =>
      reduceResearchTemplateWorkflow(
        initial,
        workflowEvent(1, {
          kind: "preview_approved",
          approvedHash: "fnv1a32:00000000",
        }),
      ),
    /requires preview phase/,
  );
  const blocked = reduceResearchTemplateWorkflow(
    initial,
    workflowEvent(1, { kind: "workflow_blocked", blocker: "Missing credentials" }),
  );
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.phase, "discover");
});

test("continuous research respects quiet hours, intervals, and exponential retry", () => {
  const policy: ContinuousResearchPolicy = {
    enabled: true,
    intervalMinutes: 60,
    pinnedTargetIds: ["topic:agents"],
    quietHours: { startMinute: 22 * 60, endMinute: 7 * 60 },
    retry: { maxAttempts: 3, baseDelayMinutes: 10, maxDelayMinutes: 60 },
  };
  const emptyState = {
    lastCompletedAt: null,
    lastAttemptAt: null,
    consecutiveFailures: 0,
    lastSourceHashes: {},
  };
  const quietNow = new Date(2026, 6, 10, 23, 30, 0);
  const quiet = evaluateContinuousResearchRun(policy, emptyState, quietNow);
  assert.equal(quiet.reason, "quiet_hours");
  assert.equal(new Date(quiet.nextEligibleAt!).getHours(), 7);
  assert.equal(new Date(quiet.nextEligibleAt!).getDate(), quietNow.getDate() + 1);

  const interval = evaluateContinuousResearchRun(
    { ...policy, quietHours: undefined },
    {
      ...emptyState,
      lastCompletedAt: "2026-07-10T12:00:00.000Z",
    },
    new Date("2026-07-10T12:30:00.000Z"),
  );
  assert.equal(interval.reason, "interval_not_due");

  const retry = evaluateContinuousResearchRun(
    { ...policy, quietHours: undefined },
    {
      ...emptyState,
      lastAttemptAt: "2026-07-10T12:00:00.000Z",
      consecutiveFailures: 2,
    },
    new Date("2026-07-10T12:15:00.000Z"),
  );
  assert.equal(retry.reason, "retry_backoff");
  assert.equal(retry.nextEligibleAt, "2026-07-10T12:20:00.000Z");
  assert.equal(
    evaluateContinuousResearchRun(
      { ...policy, quietHours: undefined },
      { ...emptyState, consecutiveFailures: 3 },
      new Date("2026-07-10T12:15:00.000Z"),
    ).reason,
    "retry_exhausted",
  );
});

test("continuous research hashes normalized sources and moves memory through verified, stale, superseded", () => {
  const previousHashes = { a: hashResearchSource("Same   content\n") };
  const { deltas, currentHashes } = computeResearchSourceDeltas(previousHashes, [
    { sourceId: "a", content: "Same content" },
    { sourceId: "b", content: "New source" },
  ]);
  assert.deepEqual(deltas.map((delta) => [delta.sourceId, delta.kind]), [
    ["a", "unchanged"],
    ["b", "added"],
  ]);

  const record: ResearchMemoryRecord = {
    id: "memory-1",
    targetId: "topic:agents",
    state: "unverified",
    sourceIds: ["a"],
    sourceHashes: { a: previousHashes.a },
    updatedAt: "2026-07-09T12:00:00.000Z",
  };
  const verified = transitionResearchMemory(record, "verified", {
    now: new Date("2026-07-10T12:00:00.000Z"),
  });
  const changed = computeResearchSourceDeltas(currentHashes, [
    { sourceId: "a", content: "Materially changed" },
    { sourceId: "b", content: "New source" },
  ]).deltas;
  const [stale] = applySourceDeltasToResearchMemory(
    [verified],
    changed,
    new Date("2026-07-11T12:00:00.000Z"),
  );
  assert.equal(stale.state, "stale");

  const replacement: ResearchMemoryRecord = {
    ...record,
    id: "memory-2",
    state: "verified",
    sourceHashes: currentHashes,
    updatedAt: "2026-07-12T12:00:00.000Z",
  };
  const superseded = supersedeResearchMemory(
    [stale],
    replacement,
    new Date("2026-07-12T12:00:00.000Z"),
  );
  assert.equal(superseded[0].state, "superseded");
  assert.equal(superseded[0].supersededById, "memory-2");
  assert.throws(
    () => transitionResearchMemory(superseded[0], "verified"),
    /Invalid research-memory transition/,
  );
});

function workflowEvent<
  T extends Omit<ResearchTemplateWorkflowEvent, "runId" | "sequence" | "occurredAt">,
>(sequence: number, event: T): ResearchTemplateWorkflowEvent {
  return {
    ...event,
    runId: "run-1",
    sequence,
    occurredAt: new Date(Date.parse("2026-07-10T12:00:00.000Z") + sequence * 1_000).toISOString(),
  } as ResearchTemplateWorkflowEvent;
}
