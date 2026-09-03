import assert from "node:assert/strict";
import test from "node:test";
import { buildHostMissionGraphPlanV1 } from "../src/agent/missionGraphHost";
import { planMissionGraphV3 } from "../src/agent/missionGraphPlanner";
import {
  MissionGraphSession,
  type MissionGraphToolStartResult,
} from "../src/agent/missionGraphSession";
import type {
  MissionEvidenceRefV1,
  MissionGraphV3,
  MissionNodeV3,
  MissionReceiptRefV1,
} from "../src/agent/missionGraphV3";
import { descriptorFor } from "../src/tools/toolDescriptors";
import type { ToolExecutionContext, ToolRegistry } from "../src/tools/types";

const GRAPH_TIME = new Date("2026-07-11T18:00:00.000Z");

test("resume splice carries replace beside a proven replace node", async () => {
  const { session, harness } = await openPlannedWriteSession({
    missionId: "ws3-resume-replace",
    toolName: "replace_current_file",
  });
  await completeFirstWrite(session, harness, "replace_current_file");
  const healed = await session.spliceResumeCurrentNoteWriteNode({
    objective: "Pay the remaining owed current-note replace.",
    currentNotePath: "Research/Brief.md",
    wallClockMs: 30_000,
    minimumReceipts: 1,
    requiredReceiptKinds: ["vault_write"],
    writeKind: "replace",
    owedWriteCount: 1,
    contentVerifiedOwedWork: true,
  });
  assert.equal(healed.splicedNodeId, "resume-current-note-write");
  assert.deepEqual(session.graph.nodes["resume-current-note-write"]?.allowedTools, [
    "replace_current_file",
  ]);
});

test("resume splice carries edit_current_section for edit kind", async () => {
  const { session, harness } = await openPlannedWriteSession({
    missionId: "ws3-resume-edit",
    toolName: "edit_current_section",
  });
  await completeFirstWrite(session, harness, "edit_current_section");
  const healed = await session.spliceResumeCurrentNoteWriteNode({
    objective: "Pay the remaining owed current-note section edit.",
    currentNotePath: "Research/Brief.md",
    wallClockMs: 30_000,
    minimumReceipts: 1,
    requiredReceiptKinds: ["vault_write"],
    writeKind: "edit",
    owedWriteCount: 1,
    contentVerifiedOwedWork: true,
  });
  assert.equal(healed.splicedNodeId, "resume-current-note-write");
  assert.deepEqual(session.graph.nodes["resume-current-note-write"]?.allowedTools, [
    "edit_current_section",
  ]);
});

test("omitting writeKind on an append-only envelope still heals as append", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "ws3-resume-append-default",
    allowedTools: ["append_to_current_file"],
    plannedTools: [],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const healed = await session.spliceResumeCurrentNoteWriteNode({
    objective: "Pay the owed current-note append.",
    currentNotePath: "Research/Brief.md",
    wallClockMs: 30_000,
    minimumReceipts: 1,
    requiredReceiptKinds: ["vault_write"],
  });
  assert.equal(healed.splicedNodeId, "resume-current-note-write");
  assert.deepEqual(session.graph.nodes["resume-current-note-write"]?.allowedTools, [
    "append_to_current_file",
  ]);
});

test("expectedTools recover replace when writeKind is omitted", async () => {
  const { session, harness } = await openPlannedWriteSession({
    missionId: "ws3-resume-replace-from-tools",
    toolName: "replace_current_file",
  });
  await completeFirstWrite(session, harness, "replace_current_file");
  const healed = await session.spliceResumeCurrentNoteWriteNode({
    objective: "Pay the remaining owed current-note replace.",
    currentNotePath: "Research/Brief.md",
    wallClockMs: 30_000,
    minimumReceipts: 1,
    requiredReceiptKinds: ["vault_write"],
    expectedTools: ["replace_current_file"],
    owedWriteCount: 1,
    contentVerifiedOwedWork: true,
  });
  assert.equal(healed.splicedNodeId, "resume-current-note-write");
  assert.deepEqual(session.graph.nodes["resume-current-note-write"]?.allowedTools, [
    "replace_current_file",
  ]);
});

test("a replace writeKind on a dual-envelope stub does not silently append", async () => {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: "ws3-resume-replace-no-silent-append",
    allowedTools: ["append_to_current_file", "replace_current_file"],
    plannedTools: [],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  const healed = await session.spliceResumeCurrentNoteWriteNode({
    objective: "Pay the owed current-note replace.",
    currentNotePath: "Research/Brief.md",
    wallClockMs: 30_000,
    minimumReceipts: 1,
    requiredReceiptKinds: ["vault_write"],
    writeKind: "replace",
  });
  assert.equal(healed.splicedNodeId, "resume-current-note-write");
  assert.deepEqual(session.graph.nodes["resume-current-note-write"]?.allowedTools, [
    "replace_current_file",
  ]);
  assert.equal(
    session.graph.nodes["resume-current-note-write"]?.allowedTools.includes(
      "append_to_current_file",
    ),
    false,
    "Interrupted replace must heal as replace, not append, once the stub allowlist includes replace_current_file.",
  );
});

async function openPlannedWriteSession(input: {
  missionId: string;
  toolName: string;
}): Promise<{
  session: MissionGraphSession;
  harness: ReturnType<typeof createVaultHarness>;
}> {
  const harness = createVaultHarness();
  const graph = await graphFor({
    missionId: input.missionId,
    allowedTools: [input.toolName],
    plannedTools: [input.toolName],
  });
  const session = await MissionGraphSession.open({
    context: harness.context,
    initialGraph: graph,
  });
  return { session, harness };
}

async function completeFirstWrite(
  session: MissionGraphSession,
  harness: ReturnType<typeof createVaultHarness>,
  toolName: string,
): Promise<void> {
  const started = requireExecution(await session.beginToolExecution(toolName));
  const writeNode = session.graph.nodes[started.nodeId]!;
  await session.finishToolExecution(started, {
    ok: true,
    evidence: evidenceFor(writeNode, "1", harness.nextTimestamp()),
    receipt: receiptFor(writeNode, "2", harness.nextTimestamp()),
  });
  assert.equal(session.graph.nodes[started.nodeId]?.status, "complete");
}

function requireExecution(result: MissionGraphToolStartResult) {
  if (!result.ok) throw new Error(result.reason);
  return result.execution;
}

function evidenceFor(
  node: MissionNodeV3,
  character: string,
  observedAt: string,
): MissionEvidenceRefV1 {
  return {
    id: `evidence-${node.id}-${character}`.slice(0, 128),
    kind: node.completionContract.requiredEvidenceKinds[0] ?? "tool-result",
    fingerprint: fp(character),
    observedAt,
  };
}

function receiptFor(
  node: MissionNodeV3,
  character: string,
  committedAt: string,
): MissionReceiptRefV1 {
  return {
    id: `receipt-${node.id}-${character}`.slice(0, 128),
    kind: node.completionContract.requiredReceiptKinds[0] ?? "action-receipt",
    fingerprint: fp(character),
    committedAt,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64).slice(0, 64)}`;
}

async function graphFor(input: {
  missionId: string;
  allowedTools: string[];
  plannedTools: string[];
}): Promise<MissionGraphV3> {
  const names = input.allowedTools;
  const descriptors = new Map(
    names.map((name) => [name, descriptorFor(name)] as const),
  );
  const registry: ToolRegistry = {
    getDefinitions: () =>
      names.map((name) => ({
        type: "function" as const,
        function: { name, parameters: { type: "object" } },
      })),
    getDescriptor: (name) => descriptors.get(name) ?? null,
    execute: async (call) => ({ ok: true, toolName: call.name }),
  };
  const objective = "Execute the bounded session fixture mission.";
  const host = await buildHostMissionGraphPlanV1({
    missionId: input.missionId,
    objective,
    toolRegistry: registry,
    allowedToolNames: input.allowedTools,
    plannedToolNames: input.plannedTools,
    currentNotePath: "Research/Brief.md",
    maxToolCalls: 4,
    maxWallClockMs: 120_000,
    now: GRAPH_TIME,
  });
  return (
    await planMissionGraphV3({
      mission: {
        missionId: input.missionId,
        objective,
      },
      routerMode: "off",
      capabilityEnvelope: host.capabilityEnvelope,
      deterministicProposal: host.deterministicProposal,
      allowedToolDescriptors: host.allowedToolDescriptors,
      now: () => GRAPH_TIME.toISOString(),
    })
  ).graph;
}

function createVaultHarness(): {
  context: ToolExecutionContext;
  nextTimestamp: () => string;
} {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let nowMs = Date.parse("2026-07-11T19:00:00.000Z");
  const nextDate = () => {
    const now = new Date(nowMs);
    nowMs += 1_000;
    return now;
  };
  const getFile = (path: string) =>
    files.has(path) ? { path, name: path.split("/").at(-1) ?? path } : null;
  return {
    nextTimestamp: () => nextDate().toISOString(),
    context: {
      app: {
        vault: {
          getFileByPath: getFile,
          getFolderByPath: (path: string) =>
            folders.has(path)
              ? { path, name: path.split("/").at(-1) ?? path }
              : null,
          createFolder: async (path: string) => {
            folders.add(path);
          },
          create: async (path: string, content: string) => {
            files.set(path, content);
            return getFile(path);
          },
          read: async (file: { path: string }) => files.get(file.path) ?? "",
          modify: async (file: { path: string }, content: string) => {
            files.set(file.path, content);
          },
        },
      },
      settings: {},
      originalPrompt: "mission graph resume write-kind fixture",
      httpTransport: {},
      now: nextDate,
    } as unknown as ToolExecutionContext,
  };
}
