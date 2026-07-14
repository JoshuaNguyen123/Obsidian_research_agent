import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveAutonomyScope,
  isBroadUnscopedVaultMutation,
} from "../src/agent/missionScope";
import {
  addLedgerReceipt,
  createMissionLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
  readLatestMissionLedger,
  readMissionLedgerByRunId,
  setLedgerAcceptance,
  setLedgerDependencyStatus,
  summarizeMissionLedger,
  upsertLedgerEvidence,
  upsertMissionEvidenceRecord,
  writeMissionLedger,
  type MissionEvidence,
  type MissionLedger,
} from "../src/agent/missionLedger";
import {
  evidenceFromReceipt,
  evidenceFromToolResult,
} from "../src/agent/missionEvidence";
import {
  buildMissionResumeContext,
  buildMissionResumePlan,
  extractRequestedRunId,
  formatLedgerForModel,
  hasMissionResumeIntent,
} from "../src/agent/missionResume";
import type { ToolExecutionContext, ToolExecutionResult } from "../src/tools/types";

test("mission scope detects current-note, vault, web, artifact, and destructive scope", () => {
  const currentNote = deriveAutonomyScope("Append this to the current note.", {
    noteOutput: true,
    explicitMutation: true,
  });
  assert.equal(currentNote.write.currentNote, true);
  assert.equal(currentNote.read.currentNote, true);

  const web = deriveAutonomyScope("Research latest MCP sources with citations.");
  assert.equal(web.read.web, true);

  const artifact = deriveAutonomyScope("Create a canvas diagram for the flow.", {
    explicitMutation: true,
    explicitPersistence: true,
  });
  assert.equal(artifact.write.artifacts, true);

  const destructive = deriveAutonomyScope("Replace the current note with a fresh brief.", {
    explicitMutation: true,
    explicitPersistence: true,
  });
  assert.equal(destructive.destructive.replaceCurrentNote, true);

  const broadVault = deriveAutonomyScope("Update my whole vault with this project summary.", {
    noteOutput: true,
    explicitMutation: true,
    explicitPersistence: true,
  });
  assert.equal(broadVault.read.vault, true);
  assert.equal(broadVault.write.currentNote, false);
  assert.equal(isBroadUnscopedVaultMutation(broadVault), true);
});

test("mission ledger creates, updates, serializes, parses, and summarizes durable state", async () => {
  const mock = createMissionLedgerContext();
  const ledger = createMissionLedger({
    runId: "run:test",
    mission: "Research MCP sources.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-05T12:00:00.000Z"),
  });

  upsertLedgerEvidence(ledger, {
    id: "web:source",
    kind: "web_source",
    title: "Source",
    url: "https://example.com",
    summary: "Example source.",
    confidence: "high",
  });
  upsertLedgerEvidence(ledger, {
    id: "web:source",
    kind: "web_source",
    title: "Source updated",
    url: "https://example.com",
    summary: "Updated source.",
    confidence: "high",
  });
  addLedgerReceipt(ledger, "receipt:append");
  setLedgerAcceptance(
    ledger,
    {
      status: "pass",
      confidence: 0.92,
      missing: [],
      reasons: ["required_evidence_and_receipts_present"],
    },
    new Date("2026-07-05T12:00:00.000Z"),
  );
  setLedgerDependencyStatus(ledger, [
    {
      category: "provider_auth",
      status: "ok",
      capability: "model requests",
      summary: "Provider auth configured.",
      nextAction: "No user action needed.",
      checkedAt: "2026-07-05T12:00:00.000Z",
    },
  ]);

  const block = formatMissionLedgerBlock(ledger);
  const parsed = parseMissionLedgerFromMarkdown(`# Agent Run\n\n${block}`);
  assert.equal(parsed?.runId, "run:test");
  assert.equal(parsed?.evidence.length, 1);
  assert.equal(parsed?.evidence[0].title, "Source updated");
  assert.equal(parsed?.receipts[0], "receipt:append");

  const firstWrite = await writeMissionLedger(mock.context, ledger);
  assert.equal(firstWrite?.path, "Agent Runs/run-test.md");
  assert.equal(firstWrite?.revision, 1);
  ledger.status = "complete";
  const secondWrite = await writeMissionLedger(mock.context, ledger);
  assert.equal(secondWrite?.path, "Agent Runs/run-test.md");
  assert.equal(secondWrite?.revision, 2);

  const concurrentFirst = {
    ...ledger,
    blockers: [...ledger.blockers, "first queued update"],
  };
  const concurrentSecond = {
    ...ledger,
    blockers: [...ledger.blockers, "second queued update"],
  };
  const concurrentWrites = await Promise.all([
    writeMissionLedger(mock.context, concurrentFirst),
    writeMissionLedger(mock.context, concurrentSecond),
  ]);
  assert.deepEqual(
    concurrentWrites.map((result) => result?.revision),
    [3, 4],
  );
  const file = mock.files.get("Agent Runs/run-test.md") ?? "";
  assert.equal((file.match(/## Mission Ledger/g) ?? []).length, 1);
  assert.equal((file.match(/### Mission Summary/g) ?? []).length, 1);
  assert.match(file, /"status": "complete"/);
  assert.match(file, /"revision": 4/);
  assert.deepEqual(summarizeMissionLedger(ledger), {
    runId: "run:test",
    status: "complete",
    acceptance: {
      status: "pass",
      confidence: 0.92,
      missing: [],
      reasons: ["required_evidence_and_receipts_present"],
      checkedAt: "2026-07-05T12:00:00.000Z",
    },
    evidenceCount: 1,
    receiptCount: 1,
    expectedTools: ["web_search", "web_fetch"],
    nextAction: "none",
    remainingActions: [],
    continuationCommand: "continue run run:test",
    canResume: false,
    blockerCategory: undefined,
    dependencyStatus: [
      {
        category: "provider_auth",
        status: "ok",
        capability: "model requests",
        summary: "Provider auth configured.",
        nextAction: "No user action needed.",
        checkedAt: "2026-07-05T12:00:00.000Z",
      },
    ],
    iterationCount: 0,
    progressScore: 0,
    stalledCount: 0,
  });
});

test("mission ledger save coalesces legacy generated summaries and preserves trailing sections", async () => {
  const mock = createMissionLedgerContext();
  const ledger = createTestLedger();
  await writeMissionLedger(mock.context, ledger);

  const path = "Agent Runs/run-test.md";
  const first = mock.files.get(path) ?? "";
  const summaryStart = first.indexOf("### Mission Summary");
  assert.ok(summaryStart >= 0);
  const generatedSummary = first.slice(summaryStart).trimEnd();
  mock.files.set(
    path,
    [
      first.trimEnd(),
      "",
      generatedSummary,
      "",
      "## Step 1 - retained checkpoint",
      "",
      "This checkpoint must survive summary repair.",
      "",
    ].join("\n"),
  );

  ledger.status = "complete";
  const result = await writeMissionLedger(mock.context, ledger);
  const repaired = mock.files.get(path) ?? "";

  assert.equal(result?.revision, 2);
  assert.equal((repaired.match(/## Mission Ledger/g) ?? []).length, 1);
  assert.equal((repaired.match(/### Mission Summary/g) ?? []).length, 1);
  assert.match(repaired, /- Status: complete/);
  assert.match(repaired, /## Step 1 - retained checkpoint/);
  assert.match(repaired, /This checkpoint must survive summary repair\./);
});

test("mission evidence converts web, vault, artifact, and receipt outputs and dedupes by id", () => {
  const ledger = createTestLedger();
  const webEvidence = evidenceFromToolResult("web_fetch", okResult({
    url: "https://example.com/mcp",
    title: "MCP",
    content: "A long source body about MCP servers.",
  }));
  const vaultEvidence = evidenceFromToolResult("read_file", okResult({
    path: "Research/MCP.md",
    content: "Vault note about MCP.",
  }));
  const artifactEvidence = evidenceFromToolResult("create_design_canvas", okResult({
    path: "Designs/Flow.canvas",
    nodeCount: 2,
    edgeCount: 1,
    bytesWritten: 200,
  }));
  const receiptEvidence = evidenceFromReceipt({
    toolName: "append_to_current_file",
    operation: "append",
    message: "append Current.md",
    path: "Current.md",
    bytesWritten: 12,
  });

  assert.equal(webEvidence?.kind, "web_source");
  assert.equal(vaultEvidence?.kind, "vault_note");
  assert.equal(artifactEvidence?.kind, "artifact");
  assert.equal(receiptEvidence.kind, "receipt");

  for (const evidence of [
    webEvidence,
    vaultEvidence,
    artifactEvidence,
    receiptEvidence,
    receiptEvidence,
  ]) {
    if (evidence) {
      upsertLedgerEvidence(ledger, evidence);
    }
  }
  assert.equal(ledger.evidence.length, 4);
});

test("same-source section evidence merges passage ids in memory and ledger round trips", () => {
  const url = "https://example.com/sectioned-source";
  const first = evidenceFromToolResult("read_source_section", okResult({
    url,
    normalizedUrl: url,
    title: "Sectioned source",
    sourceStartChar: 0,
    content: "First-section claim and context.",
  }));
  const second = evidenceFromToolResult("read_source_section", okResult({
    url,
    normalizedUrl: url,
    title: "Sectioned source",
    sourceStartChar: 6000,
    content: "Second-section limitation and conclusion.",
  }));
  assert.ok(first?.passageId);
  assert.ok(second?.passageId);
  assert.notEqual(first.passageId, second.passageId);

  const inMemory: MissionEvidence[] = [];
  upsertMissionEvidenceRecord(inMemory, first);
  upsertMissionEvidenceRecord(inMemory, second);
  assert.equal(inMemory.length, 1);
  assert.equal(inMemory[0].passageId, first.passageId);
  assert.equal(inMemory[0].sourceId, first.sourceId);
  assert.equal(inMemory[0].url, url);
  assert.ok(inMemory[0].passageIds?.includes(first.passageId));
  assert.ok(inMemory[0].passageIds?.includes(second.passageId));

  const ledger = createTestLedger();
  upsertLedgerEvidence(ledger, first);
  upsertLedgerEvidence(ledger, second);
  const restored = parseMissionLedgerFromMarkdown(
    formatMissionLedgerBlock(ledger),
  );
  assert.equal(restored?.evidence.length, 1);
  assert.equal(restored?.evidence[0].passageId, first.passageId);
  assert.ok(restored?.evidence[0].passageIds?.includes(first.passageId));
  assert.ok(restored?.evidence[0].passageIds?.includes(second.passageId));
});

test("mission resume parses explicit run ids and formats transient resume context", async () => {
  const mock = createMissionLedgerContext();
  const ledger = createTestLedger();
  ledger.status = "blocked";
  ledger.evidence.push({
    id: "web:1",
    kind: "web_source",
    title: "Saved source",
    url: "https://example.com/source",
    summary: "Useful source summary.",
    confidence: "high",
  });
  ledger.blockers.push("Need one more source.");
  ledger.nextActions.push("Fetch the second source.");
  await writeMissionLedger(mock.context, ledger);

  assert.equal(extractRequestedRunId("continue run run:test"), "run:test");
  const loaded = await readMissionLedgerByRunId(mock.context, "run:test");
  assert.equal(loaded?.path, "Agent Runs/run-test.md");

  const resume = await buildMissionResumeContext({
    prompt: "continue run run:test",
    activeIntentPrompt: "continue run run:test",
    toolContext: mock.context,
  });
  assert.equal(resume?.ledger.runId, "run:test");
  assert.match(resume?.promptContext ?? "", /Do not persist this ledger text/);
  assert.match(formatLedgerForModel(ledger), /Useful source summary/);
  assert.match(formatLedgerForModel(ledger), /Continuation command: continue run run:test/);
  assert.match(formatLedgerForModel(ledger), /Proof debt \(recomputed/);
  assert.equal(resume?.plan.proofDebt.empty, false);
  assert.ok(resume?.plan.proofDebt);
});

test("research memory continuation does not trigger mission ledger resume", async () => {
  const mock = createMissionLedgerContext();
  await writeMissionLedger(mock.context, createTestLedger());

  assert.equal(
    hasMissionResumeIntent("Continue this research from memory: routing topic"),
    false,
  );
  assert.equal(
    hasMissionResumeIntent("continue run run:test"),
    true,
  );
  assert.equal(
    hasMissionResumeIntent(
      "Run a new overnight study, inspect the graph, and continue with deep sources until the mission is complete.",
    ),
    false,
  );
  assert.equal(
    hasMissionResumeIntent("Please resume the unfinished mission."),
    true,
  );

  const resume = await buildMissionResumeContext({
    prompt: "Continue this research from memory: routing topic",
    activeIntentPrompt: "Continue this research from memory: routing topic",
    toolContext: mock.context,
  });
  assert.equal(resume, null);
});

test("generic resume selects latest incomplete ledger before newer complete ledgers", async () => {
  const mock = createMissionLedgerContext();
  const incomplete = createMissionLedger({
    runId: "run:incomplete",
    mission: "Continue this mission.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: ["web_search"],
      stopWhenSatisfied: false,
    },
    now: new Date("2026-07-05T12:00:00.000Z"),
  });
  incomplete.status = "budget";
  incomplete.remainingActions = ["Fetch one more source."];
  await writeMissionLedger(mock.context, incomplete);

  const complete = createMissionLedger({
    runId: "run:complete",
    mission: "Already done.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: [],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-07-05T12:01:00.000Z"),
  });
  complete.status = "complete";
  complete.acceptance = {
    status: "pass",
    confidence: 0.95,
    missing: [],
    reasons: ["done"],
    checkedAt: "2026-07-05T12:01:00.000Z",
  };
  await writeMissionLedger(mock.context, complete);

  const latest = await readLatestMissionLedger(mock.context);
  assert.equal(latest?.ledger.runId, "run:incomplete");

  const resume = await buildMissionResumeContext({
    prompt: "continue",
    activeIntentPrompt: "continue",
    toolContext: mock.context,
  });
  assert.equal(resume?.plan.continuationCommand, "continue run run:incomplete");
  assert.ok(
    resume?.plan.remainingActions.includes("Fetch one more source."),
  );
});

test("resume plan next action comes from proof debt and skips completed subquestions", () => {
  const ledger = createTestLedger();
  ledger.status = "budget";
  ledger.researchPlan = {
    version: 1,
    mode: "deep_web",
    sourceRequirements: { minFetchedSources: 2, minDistinctDomains: 1 },
    coverageRequirements: {
      minVaultCoverageConfidence: "medium",
      expandWhenSampledOrTruncated: true,
    },
    subquestions: [
      {
        id: "rq-1",
        question: "Already answered question",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "complete",
        evidenceIds: ["web:1"],
      },
      {
        id: "rq-2",
        question: "Still unpaid fetch question",
        requiredEvidenceType: "web_source",
        minEvidence: 1,
        status: "in_progress",
        evidenceIds: [],
      },
    ],
    evidenceIds: ["web_search:1", "web:1"],
    status: "in_progress",
  };
  ledger.acceptance = {
    status: "needs_more_work",
    confidence: 0.4,
    missing: ["web_evidence", "fetched_sources"],
    reasons: ["need_fetch"],
    checkedAt: "2026-07-05T12:00:00.000Z",
  };
  ledger.nextActions = [
    "Continue research item rq-1: Already answered question",
    "Stale narrative keep going",
  ];
  ledger.remainingActions = ["Reopen rq-1 somehow"];

  const plan = buildMissionResumePlan(ledger);
  assert.equal(plan.proofDebt.empty, false);
  assert.equal(plan.proofDebt.nextAction.toolName, "web_fetch");
  assert.match(plan.remainingActions[0] ?? "", /web_fetch/);
  assert.ok(plan.remainingActions.some((item) => item.includes("rq-2")));
  assert.ok(!plan.remainingActions.some((item) => /\brq-1\b/.test(item)));
  assert.match(formatLedgerForModel(ledger), /Resume next action \(from proof debt\): web_fetch/);
  assert.match(formatLedgerForModel(ledger), /do not reopen completed research subquestions/i);
});

function createTestLedger(): MissionLedger {
  return createMissionLedger({
    runId: "run:test",
    mission: "Test mission.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: [],
      stopWhenSatisfied: false,
    },
    now: new Date("2026-07-05T12:00:00.000Z"),
  });
}

function okResult(output: unknown): ToolExecutionResult {
  return {
    ok: true,
    toolName: "test",
    output,
  };
}

function createMissionLedgerContext() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const mtimes = new Map<string, number>();
  let mtime = 1000;

  const getFileByPath = (path: string) => {
    if (!files.has(path)) {
      return null;
    }
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/\.md$/i, ""),
      extension: name.split(".").pop()?.toLowerCase() ?? "",
      stat: {
        mtime: mtimes.get(path) ?? 0,
      },
    };
  };

  const context = {
    app: {
      vault: {
        getFolderByPath: (path: string) =>
          folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
        createFolder: async (path: string) => {
          folders.add(path);
        },
        getFileByPath,
        getFiles: () =>
          [...files.keys()]
            .map((path) => getFileByPath(path))
            .filter((file): file is NonNullable<typeof file> => Boolean(file)),
        create: async (path: string, content: string) => {
          files.set(path, content);
          mtimes.set(path, ++mtime);
        },
        read: async (file: { path: string }) => files.get(file.path) ?? "",
        modify: async (file: { path: string }, content: string) => {
          files.set(file.path, content);
          mtimes.set(file.path, ++mtime);
        },
      },
    },
  } as unknown as ToolExecutionContext;

  return {
    context,
    files,
    folders,
  };
}
