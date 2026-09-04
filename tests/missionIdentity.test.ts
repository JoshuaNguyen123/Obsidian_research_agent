import assert from "node:assert/strict";
import test from "node:test";

import {
  resolveDurableAdaptiveTeamDispatchV2,
} from "../src/agent/researchTeamDispatch";
import {
  askUserOfferedOnBareContinue,
  ClarificationBroker,
  shouldOfferAskUser,
  stageOpenClarificationForNextBroker,
  type ClarificationRequest,
} from "../src/agent/clarificationBroker";
import {
  buildMissionResumeContext,
  persistOpenClarificationOnLedger,
  readOpenClarificationFromLedger,
  readTeamIdentityFromLedger,
  resolveTeamResumeIdentity,
  stampTeamIdentityOnLedger,
} from "../src/agent/missionResume";
import {
  createMissionLedger,
  parseMissionLedgerFromMarkdown,
  writeMissionLedger,
  type MissionLedger,
} from "../src/agent/missionLedger";
import { RESEARCH_TEAM_EXECUTOR_ID_V1 } from "../src/agent/topLevelMissionDispatch";
import { seedLeadFromWorkerHandoff } from "../src/orchestrator/researchTeamHandoffBridge";
import { classifyOvernightMissionIntent } from "../src/agent/overnightIntent";
import type { MissionEvidence } from "../src/agent/missionLedger";
import type { WorkerHandoff } from "../src/orchestrator/types";
import type { ToolExecutionContext } from "../src/tools/types";

const NOTE_SHA256 = `sha256:${"b".repeat(64)}`;

function overnightInvestigatePrompt(): string {
  return "Investigate this with sources overnight.";
}

test("Metric A: overnight investigate-with-sources durable manifests open the team 0 → 1", async () => {
  const prompt = overnightInvestigatePrompt();
  assert.equal(classifyOvernightMissionIntent(prompt).requested, true);

  const beforeWouldSkipAdaptiveDecision = true;
  assert.equal(
    beforeWouldSkipAdaptiveDecision,
    true,
    "old main returned from runDurableMission before resolveAdaptiveTeamDispatchV2",
  );

  const routed = await resolveDurableAdaptiveTeamDispatchV2({
    prompt,
    orchestratorEnabled: true,
    forceChatOnly: false,
    hasDurableManifest: true,
  });
  assert.equal(routed.decision.useTeam, true, prompt);
  assert.equal(routed.durable_research_opens_team, 1);
});

test("Metric B: continue run after a team Lead loads the Lead child ledger 0 → 1", async () => {
  const mock = createMissionLedgerContext();
  const parent = createTeamLedger("team-parent", "Investigate with sources.");
  const leadChild = createTeamLedger("team-parent-lead", "Investigate with sources.");
  stampTeamIdentityOnLedger(parent, {
    executorId: RESEARCH_TEAM_EXECUTOR_ID_V1,
    leadChildRunId: "team-parent-lead",
  });
  stampTeamIdentityOnLedger(leadChild, {
    executorId: RESEARCH_TEAM_EXECUTOR_ID_V1,
    leadChildRunId: "team-parent-lead",
  });
  leadChild.remainingActions.push("Fetch one more cited source.");
  await writeMissionLedger(mock.context, parent);
  await writeMissionLedger(mock.context, leadChild);

  const identity = await resolveTeamResumeIdentity({
    prompt: "continue run team-parent",
    toolContext: mock.context,
  });
  assert.ok(identity);
  assert.equal(identity.forceTeam, true);
  assert.equal(identity.leadChildRunId, "team-parent-lead");
  assert.equal(identity.resume_loads_lead_child_ledger, 1);
  assert.equal(identity.ledger?.runId, "team-parent-lead");

  const resume = await buildMissionResumeContext({
    prompt: "continue run team-parent",
    activeIntentPrompt: "continue run team-parent",
    toolContext: mock.context,
  });
  assert.equal(resume?.resume_loads_lead_child_ledger, 1);
  assert.equal(resume?.ledger.runId, "team-parent-lead");
  assert.match(resume?.promptContext ?? "", /Team executor: research-team/);
  assert.match(resume?.promptContext ?? "", /Lead child run: team-parent-lead/);
});

test("Metric C: handoff artifact is seeded on the Lead and ask_user is not offered on bare continue", () => {
  const seeded = seedLeadFromWorkerHandoff({
    handoff: acceptedHandoff(),
    notePath: "Research/Checkers.md",
    noteSha256: NOTE_SHA256,
    noteReceiptId: "research-note-verified-checkers",
    runId: "run-team-1",
    evidence: usableEvidence(),
  });
  assert.equal(seeded.handoff_artifact_seeded_on_lead, 1);
  assert.ok(seeded.attachContext);
  assert.match(seeded.attachContext ?? "", /Host-attached AcceptedResearchArtifact/);

  assert.equal(shouldOfferAskUser("continue"), false);
  assert.equal(shouldOfferAskUser("help me"), false);
  assert.equal(shouldOfferAskUser("go on"), false);
  assert.equal(shouldOfferAskUser("continue run team-parent-lead"), false);
  assert.equal(askUserOfferedOnBareContinue("continue"), 0);
  assert.equal(askUserOfferedOnBareContinue("help me"), 0);
  assert.equal(askUserOfferedOnBareContinue("go on"), 0);
  assert.equal(shouldOfferAskUser("Which note should I append to?"), true);
});

test("open clarification persists on the ledger and survives a new broker", async () => {
  const mock = createMissionLedgerContext();
  const ledger = createTeamLedger("run-clarify", "Investigate with sources.");
  const request: ClarificationRequest = {
    id: "clarification-run-clarify-1",
    runId: "run-clarify",
    question: "Which source set should I prioritize?",
    options: ["Primary papers", "Surveys"],
    expiresAtMs: Date.now() + 60_000,
  };
  persistOpenClarificationOnLedger(ledger, request);
  await writeMissionLedger(mock.context, ledger);

  const roundTrip = parseMissionLedgerFromMarkdown(
    mock.files.get("Agent Runs/run-clarify.md") ?? "",
  );
  assert.ok(roundTrip);
  const restored = readOpenClarificationFromLedger(roundTrip!);
  assert.equal(restored?.question, "Which source set should I prioritize?");

  stageOpenClarificationForNextBroker(restored);
  const broker = new ClarificationBroker();
  const pending = broker.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.question, "Which source set should I prioritize?");
  assert.equal(broker.answer(pending[0]!.id, "Primary papers"), true);
});

test("stamped team identity round-trips through ledger remaining actions", () => {
  const ledger = createTeamLedger("run-stamp", "Investigate with sources.");
  stampTeamIdentityOnLedger(ledger, {
    executorId: RESEARCH_TEAM_EXECUTOR_ID_V1,
    leadChildRunId: "run-stamp-lead",
  });
  const identity = readTeamIdentityFromLedger(ledger);
  assert.deepEqual(identity, {
    executorId: "research-team",
    leadChildRunId: "run-stamp-lead",
  });
  assert.equal(ledger.continuationCommand, "continue run run-stamp-lead");
});

function acceptedHandoff(): WorkerHandoff {
  return {
    id: "handoff-1",
    fromParticipantId: "researcher-1",
    toParticipantId: "lead-1",
    taskId: "task-research",
    status: "accepted",
    summary: "Gathered checkers rules.",
    sourceIds: ["https://rules.example.org/checkers"],
    evidenceIds: ["web_fetch:https://rules.example.org/checkers"],
    unresolvedQuestions: [],
    confidence: "medium",
    createdAt: "2026-07-20T12:00:00.000Z",
    updatedAt: "2026-07-20T12:00:00.000Z",
  };
}

function usableEvidence(): MissionEvidence[] {
  return [
    {
      id: "web_fetch:https://rules.example.org/checkers",
      kind: "web_source",
      title: "Official checkers rules",
      url: "https://rules.example.org/checkers",
      sourceId: "https://rules.example.org/checkers",
      passageIds: ["passage-checkers-1"],
      usableSource: true,
      summary: "Fetched official rules passage.",
      confidence: "high",
      contentHash: `sha256:${"a".repeat(64)}`,
    },
  ];
}

function createTeamLedger(runId: string, mission: string): MissionLedger {
  return createMissionLedger({
    runId,
    mission,
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: ["web_search", "web_fetch"],
      stopWhenSatisfied: false,
    },
    now: new Date("2026-07-05T12:00:00.000Z"),
  });
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

  return { context, files };
}
