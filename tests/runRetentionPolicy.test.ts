/**
 * Pins Agent Runs retention to Chat's resume plan. The selector may age out
 * only plugin-owned notes whose `buildMissionResumePlan` is
 * `canResume === false` with reason `ledger_already_complete` or
 * `user_dismissed`. It does not invent a second completeness predicate.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatMissionLedgerBlock,
  isTerminalCompleteLedger,
  isUserDismissedMissionLedger,
  markMissionLedgerUserDismissed,
  type MissionLedger,
} from "../src/agent/missionLedger";
import { buildMissionResumePlan } from "../src/agent/missionResume";
import {
  chatResumePlanAllowsRetention,
  classifyOwnedAgentRunPath,
  resolveRunRetentionPolicy,
  selectPrunableRunArtifacts,
  sweepAgentRunsRetentionBestEffort,
  type RunRetentionArtifactV1,
} from "../src/agent/runRetentionPolicy";

const NOW = new Date("2026-08-25T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

function note(
  overrides: Partial<RunRetentionArtifactV1> & { path: string },
): RunRetentionArtifactV1 {
  return {
    mtimeMs: NOW.getTime() - 31 * DAY,
    kind: "run_note",
    canResume: false,
    resumeReason: "ledger_already_complete",
    runId: overrides.path.replace(/^Agent Runs\//u, "").replace(/\.md$/u, ""),
    ...overrides,
  };
}

function sampleLedger(overrides: Partial<MissionLedger> = {}): MissionLedger {
  return {
    schemaVersion: 2,
    revision: 1,
    runId: "run-sample",
    mission: "Write a short note about retention.",
    route: "direct",
    createdAt: "2026-07-20T09:34:15.579Z",
    updatedAt: "2026-07-20T09:34:15.579Z",
    status: "running",
    loopBudget: {
      hardCap: 20,
      toolStepBudget: 16,
      finalizationReserve: 2,
      expectedTools: [],
    },
    tasks: [],
    milestones: [],
    evidence: [],
    receipts: [],
    blockers: [],
    dependencyStatus: [],
    approvals: [],
    nextActions: [],
    remainingActions: [],
    iterationCount: 1,
    progressScore: 0,
    stalledCount: 0,
    resumeCount: 0,
    lastSafeStep: 1,
    continuationCommand: "continue run run-sample",
    ...overrides,
  };
}

function completeLedger(runId: string): MissionLedger {
  return sampleLedger({
    runId,
    continuationCommand: `continue run ${runId}`,
    status: "complete",
    acceptance: {
      status: "pass",
      confidence: 1,
      missing: [],
      reasons: [],
      checkedAt: "2026-07-20T10:00:00.000Z",
    },
  });
}

test("classifyOwnedAgentRunPath only accepts plugin-owned Agent Runs markdown", () => {
  const rows: Array<{ path: string; kind: RunRetentionArtifactV1["kind"]; rule: string }> = [
    {
      path: "Agent Runs/run-1.md",
      kind: "run_note",
      rule: "direct Agent Runs/*.md notes are plugin-owned run notes",
    },
    {
      path: "Agent Runs/Mission Graphs/run-1.md",
      kind: "mission_graph",
      rule: "Agent Runs/Mission Graphs/*.md notes are plugin-owned graph store files",
    },
    {
      path: "Agent Runs/notes-from-user.md",
      kind: "run_note",
      rule: "path ownership is the Agent Runs/*.md regex; ledger-less notes are excluded later",
    },
    {
      path: "Agent Runs/sub/nested.md",
      kind: "foreign",
      rule: "nested Agent Runs paths are foreign and must never be selected",
    },
    {
      path: "Agent Runs/Missions/nested.md",
      kind: "foreign",
      rule: "durable mission folder notes are not retention candidates",
    },
    {
      path: "Research/Agent Runs.md",
      kind: "foreign",
      rule: "files outside Agent Runs/ are foreign",
    },
    {
      path: "Agent Runs/run-1.txt",
      kind: "foreign",
      rule: "non-markdown Agent Runs files are foreign",
    },
  ];
  for (const row of rows) {
    assert.equal(
      classifyOwnedAgentRunPath(row.path),
      row.kind,
      row.rule,
    );
  }
});

test("chatResumePlanAllowsRetention allowlists Chat terminal reasons only", () => {
  const rows: Array<{
    plan: { canResume?: boolean; reason?: string };
    allowed: boolean;
    rule: string;
  }> = [
    {
      plan: { canResume: false, reason: "ledger_already_complete" },
      allowed: true,
      rule: "Chat reason ledger_already_complete may age out",
    },
    {
      plan: { canResume: false, reason: "user_dismissed" },
      allowed: true,
      rule: "Chat reason user_dismissed may age out",
    },
    {
      plan: { canResume: false, reason: "proof_debt_blocked" },
      allowed: false,
      rule: "proof_debt_blocked stays even though canResume is false",
    },
    {
      plan: { canResume: false, reason: "ledger_has_blockers" },
      allowed: false,
      rule: "ledger_has_blockers is still Chat-resume-shaped remaining work",
    },
    {
      plan: { canResume: false, reason: "research_plan_has_remaining_work" },
      allowed: false,
      rule: "research_plan_has_remaining_work must never be pruned",
    },
    {
      plan: { canResume: true, reason: "ledger_has_remaining_work" },
      allowed: false,
      rule: "anything Chat still treats as resume-eligible must stay",
    },
    {
      plan: { reason: "ledger_already_complete" },
      allowed: false,
      rule: "missing canResume fails closed; do not infer completeness",
    },
  ];
  for (const row of rows) {
    assert.equal(
      chatResumePlanAllowsRetention(row.plan),
      row.allowed,
      row.rule,
    );
  }
});

test("exported isTerminalCompleteLedger matches Chat's terminal-complete meaning", () => {
  const complete = completeLedger("run-complete");
  const running = sampleLedger({ runId: "run-running" });
  assert.equal(
    isTerminalCompleteLedger(complete),
    true,
    "complete + acceptance pass is the same terminal predicate Chat uses",
  );
  assert.equal(
    buildMissionResumePlan(complete).reason,
    "ledger_already_complete",
    "Chat names a terminal-complete ledger ledger_already_complete",
  );
  assert.equal(
    isTerminalCompleteLedger(running),
    false,
    "running ledgers are not terminal-complete",
  );
  assert.equal(
    buildMissionResumePlan(running).canResume,
    true,
    "Chat still treats a running ledger as resume-eligible",
  );
});

test("age boundary keeps 29-day terminal runs; 31-day runs only prune past the cap", () => {
  const recent = note({
    path: "Agent Runs/recent.md",
    mtimeMs: NOW.getTime() - 29 * DAY,
    runId: "recent",
  });
  const agedNewer = note({
    path: "Agent Runs/aged-newer.md",
    mtimeMs: NOW.getTime() - 31 * DAY,
    runId: "aged-newer",
  });
  const agedOlder = note({
    path: "Agent Runs/aged-older.md",
    mtimeMs: NOW.getTime() - 40 * DAY,
    runId: "aged-older",
  });
  const underCap = selectPrunableRunArtifacts(
    [recent, agedNewer],
    { retentionDays: 30, maxTerminalRuns: 200 },
    NOW,
  );
  assert.deepEqual(
    underCap.paths,
    [],
    "keep everything ≤ runRetentionDays old, and keep a 31-day terminal run when the aged set is under the cap",
  );
  const overCap = selectPrunableRunArtifacts(
    [recent, agedNewer, agedOlder],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    overCap.paths,
    ["Agent Runs/aged-older.md"],
    "a 31-day terminal run prunes only as overflow past maxTerminalRuns; 29-day notes always stay",
  );
});

test("count boundary prunes the 201st oldest aged terminal when max=200", () => {
  const entries: RunRetentionArtifactV1[] = [];
  for (let index = 0; index < 201; index += 1) {
    entries.push(
      note({
        path: `Agent Runs/run-${index}.md`,
        runId: `run-${index}`,
        mtimeMs: NOW.getTime() - (31 + index) * DAY,
      }),
    );
  }
  const selected = selectPrunableRunArtifacts(
    entries,
    { retentionDays: 30, maxTerminalRuns: 200 },
    NOW,
  );
  assert.deepEqual(
    selected.paths,
    ["Agent Runs/run-200.md"],
    "among aged terminal runs keep the most recent runRetentionMaxRuns; the 201st oldest is overflow",
  );
});

test("non-terminal and resumable Chat plans are excluded from the aged-terminal set", () => {
  const running = note({
    path: "Agent Runs/running.md",
    runId: "running",
    ledger: sampleLedger({ runId: "running", status: "running" }),
  });
  const blocked = note({
    path: "Agent Runs/blocked.md",
    runId: "blocked",
    ledger: sampleLedger({
      runId: "blocked",
      status: "blocked",
      blockers: ["Need a credential."],
    }),
  });
  const budget = note({
    path: "Agent Runs/budget.md",
    runId: "budget",
    ledger: sampleLedger({ runId: "budget", status: "budget" }),
  });
  const remainingWork = note({
    path: "Agent Runs/remaining.md",
    runId: "remaining",
    canResume: true,
    resumeReason: "ledger_has_remaining_work",
  });
  for (const entry of [running, blocked, budget]) {
    const plan = buildMissionResumePlan(entry.ledger!);
    assert.equal(
      plan.canResume,
      true,
      `Chat must still treat ${entry.ledger!.status} ledgers as resume-eligible`,
    );
  }
  const selected = selectPrunableRunArtifacts(
    [running, blocked, budget, remainingWork],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    selected.paths,
    [],
    "running/blocked/budget and other Chat-resumable plans must never be pruned",
  );
});

test("user_dismissed may prune; proof_debt_blocked must not", () => {
  const dismissedNewer = note({
    path: "Agent Runs/dismissed-newer.md",
    runId: "dismissed-newer",
    mtimeMs: NOW.getTime() - 31 * DAY,
    resumeReason: "user_dismissed",
  });
  const dismissedOlder = note({
    path: "Agent Runs/dismissed-older.md",
    runId: "dismissed-older",
    mtimeMs: NOW.getTime() - 40 * DAY,
    resumeReason: "user_dismissed",
  });
  const proofDebtNewer = note({
    path: "Agent Runs/debt-newer.md",
    runId: "debt-newer",
    mtimeMs: NOW.getTime() - 31 * DAY,
    canResume: false,
    resumeReason: "proof_debt_blocked",
  });
  const proofDebtOlder = note({
    path: "Agent Runs/debt-older.md",
    runId: "debt-older",
    mtimeMs: NOW.getTime() - 50 * DAY,
    canResume: false,
    resumeReason: "proof_debt_blocked",
  });

  const dismissedLedger = sampleLedger({ runId: "dismissed-chat", status: "blocked" });
  markMissionLedgerUserDismissed(dismissedLedger, new Date("2026-07-20T12:00:00.000Z"));
  assert.equal(
    isUserDismissedMissionLedger(dismissedLedger),
    true,
    "dismiss uses the exported Chat dismiss predicate",
  );
  assert.equal(
    buildMissionResumePlan(dismissedLedger).reason,
    "user_dismissed",
    "Chat names a dismissed ledger user_dismissed",
  );
  assert.equal(
    buildMissionResumePlan(dismissedLedger).canResume,
    false,
    "Chat refuses resume after user dismiss",
  );

  const selected = selectPrunableRunArtifacts(
    [dismissedNewer, dismissedOlder, proofDebtNewer, proofDebtOlder],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    selected.paths,
    ["Agent Runs/dismissed-older.md"],
    "user_dismissed may prune as overflow; proof_debt_blocked is never part of the aged-terminal set",
  );
});

test("disabled policy (0) selects nothing", () => {
  const old = note({ path: "Agent Runs/old.md", runId: "old" });
  assert.deepEqual(
    selectPrunableRunArtifacts(
      [old],
      { retentionDays: 0, maxTerminalRuns: 200 },
      NOW,
    ).paths,
    [],
    "runRetentionDays 0 disables the sweep",
  );
  assert.deepEqual(
    selectPrunableRunArtifacts(
      [old],
      { retentionDays: 30, maxTerminalRuns: 0 },
      NOW,
    ).paths,
    [],
    "runRetentionMaxRuns 0 disables the sweep",
  );
});

test("ledger-less Agent Runs/notes-from-user.md is never selected", () => {
  const selected = selectPrunableRunArtifacts(
    [
      {
        path: "Agent Runs/notes-from-user.md",
        mtimeMs: NOW.getTime() - 400 * DAY,
        kind: "run_note",
      },
      note({
        path: "Agent Runs/complete-kept.md",
        runId: "complete-kept",
        mtimeMs: NOW.getTime() - 31 * DAY,
      }),
      note({
        path: "Agent Runs/complete-old.md",
        runId: "complete-old",
        mtimeMs: NOW.getTime() - 40 * DAY,
      }),
    ],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    selected.paths,
    ["Agent Runs/complete-old.md"],
    "a ledger-less Agent Runs note has no Chat plan and must fail closed even when terminal overflow exists",
  );
});

test("unpaired Mission Graphs note is never selected", () => {
  const selected = selectPrunableRunArtifacts(
    [
      {
        path: "Agent Runs/Mission Graphs/orphan.md",
        mtimeMs: NOW.getTime() - 400 * DAY,
        kind: "mission_graph",
        runId: "orphan",
      },
      note({
        path: "Agent Runs/complete-kept.md",
        runId: "complete-kept",
        mtimeMs: NOW.getTime() - 31 * DAY,
      }),
      note({
        path: "Agent Runs/complete-old.md",
        runId: "complete-old",
        mtimeMs: NOW.getTime() - 40 * DAY,
      }),
    ],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    selected.paths,
    ["Agent Runs/complete-old.md"],
    "a graph-store note with no matching ledger must fail closed and stay",
  );
});

test("pruning a run note also selects its paired graph when overflowing the cap", () => {
  const selected = selectPrunableRunArtifacts(
    [
      note({
        path: "Agent Runs/run-kept.md",
        runId: "run-kept",
        mtimeMs: NOW.getTime() - 31 * DAY,
      }),
      note({
        path: "Agent Runs/run-old.md",
        runId: "run-old",
        mtimeMs: NOW.getTime() - 40 * DAY,
      }),
      {
        path: "Agent Runs/Mission Graphs/run-old.md",
        mtimeMs: NOW.getTime() - 40 * DAY,
        kind: "mission_graph",
        runId: "run-old",
      },
      {
        path: "Agent Runs/Mission Graphs/run-kept.md",
        mtimeMs: NOW.getTime() - 31 * DAY,
        kind: "mission_graph",
        runId: "run-kept",
      },
    ],
    { retentionDays: 30, maxTerminalRuns: 1 },
    NOW,
  );
  assert.deepEqual(
    [...selected.paths].sort(),
    ["Agent Runs/Mission Graphs/run-old.md", "Agent Runs/run-old.md"].sort(),
    "overflowing a terminal run note also selects its paired Mission Graphs note; the kept run's graph stays",
  );
});

test("resolveRunRetentionPolicy reads optional settings with 30/200 fallbacks", () => {
  assert.deepEqual(
    resolveRunRetentionPolicy({}),
    { retentionDays: 30, maxTerminalRuns: 200 },
    "absent WS-A keys fall back to 30 days and 200 terminal runs",
  );
  assert.deepEqual(
    resolveRunRetentionPolicy({ runRetentionDays: 0, runRetentionMaxRuns: 0 }),
    { retentionDays: 0, maxTerminalRuns: 0 },
    "explicit 0 must disable rather than fall back",
  );
});

test("sweep uses Chat plans, skips ledger-less notes, and never throws", async () => {
  const complete = completeLedger("run-old");
  complete.updatedAt = "2026-07-01T00:00:00.000Z";
  const kept = completeLedger("run-kept");
  const running = sampleLedger({ runId: "run-running", status: "running" });
  const files = new Map<
    string,
    { content: string; mtime: number; trashed?: boolean }
  >([
    [
      "Agent Runs/run-old.md",
      {
        content: formatMissionLedgerBlock(complete),
        mtime: NOW.getTime() - 40 * DAY,
      },
    ],
    [
      "Agent Runs/run-kept.md",
      {
        content: formatMissionLedgerBlock(kept),
        mtime: NOW.getTime() - 31 * DAY,
      },
    ],
    [
      "Agent Runs/run-running.md",
      {
        content: formatMissionLedgerBlock(running),
        mtime: NOW.getTime() - 400 * DAY,
      },
    ],
    [
      "Agent Runs/notes-from-user.md",
      {
        content: "# Personal notes\n\nNot a ledger.\n",
        mtime: NOW.getTime() - 400 * DAY,
      },
    ],
    [
      "Agent Runs/Mission Graphs/run-old.md",
      {
        content: "# graph\n",
        mtime: NOW.getTime() - 40 * DAY,
      },
    ],
    [
      "Agent Runs/Mission Graphs/orphan.md",
      {
        content: "# unpaired graph\n",
        mtime: NOW.getTime() - 400 * DAY,
      },
    ],
  ]);
  const fileObjs = [...files.keys()].map((path) => ({
    path,
    extension: "md",
    stat: { mtime: files.get(path)!.mtime },
  }));
  const vault = {
    getFiles: () => fileObjs.filter((file) => files.has(file.path)),
    read: async (file: { path: string }) => files.get(file.path)!.content,
    getFileByPath: (path: string) =>
      fileObjs.find((file) => file.path === path && files.has(path)) ?? null,
    trash: async (file: { path: string }, system: boolean) => {
      assert.equal(system, false, "trash must use vault.trash(file, false)");
      files.delete(file.path);
    },
  };

  const result = await sweepAgentRunsRetentionBestEffort({
    vault,
    policy: { retentionDays: 30, maxTerminalRuns: 1 },
    now: NOW,
  });
  assert.deepEqual(
    [...result.trashed].sort(),
    ["Agent Runs/Mission Graphs/run-old.md", "Agent Runs/run-old.md"].sort(),
    "onload sweep trashes the overflowing terminal run and its paired graph via Chat's plan",
  );
  assert.equal(
    files.has("Agent Runs/run-running.md"),
    true,
    "resumable running notes must remain",
  );
  assert.equal(
    files.has("Agent Runs/notes-from-user.md"),
    true,
    "ledger-less Agent Runs/notes-from-user.md must remain",
  );
  assert.equal(
    files.has("Agent Runs/Mission Graphs/orphan.md"),
    true,
    "unpaired Mission Graphs notes must remain",
  );

  const brokenVault = {
    getFiles: () => {
      throw new Error("vault exploded");
    },
    read: async () => {
      throw new Error("read exploded");
    },
  };
  const safe = await sweepAgentRunsRetentionBestEffort({
    vault: brokenVault,
    policy: { retentionDays: 30, maxTerminalRuns: 200 },
    now: NOW,
  });
  assert.deepEqual(
    safe.trashed,
    [],
    "sweep failure must never throw or block plugin load",
  );
});
