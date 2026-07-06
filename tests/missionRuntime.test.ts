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
  readMissionLedgerByRunId,
  summarizeMissionLedger,
  upsertLedgerEvidence,
  writeMissionLedger,
  type MissionLedger,
} from "../src/agent/missionLedger";
import {
  evidenceFromReceipt,
  evidenceFromToolResult,
} from "../src/agent/missionEvidence";
import {
  buildMissionResumeContext,
  extractRequestedRunId,
  formatLedgerForModel,
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

  const block = formatMissionLedgerBlock(ledger);
  const parsed = parseMissionLedgerFromMarkdown(`# Agent Run\n\n${block}`);
  assert.equal(parsed?.runId, "run:test");
  assert.equal(parsed?.evidence.length, 1);
  assert.equal(parsed?.evidence[0].title, "Source updated");
  assert.equal(parsed?.receipts[0], "receipt:append");

  const firstWrite = await writeMissionLedger(mock.context, ledger);
  assert.equal(firstWrite?.path, "Agent Runs/run-test.md");
  ledger.status = "complete";
  const secondWrite = await writeMissionLedger(mock.context, ledger);
  assert.equal(secondWrite?.path, "Agent Runs/run-test.md");
  const file = mock.files.get("Agent Runs/run-test.md") ?? "";
  assert.equal((file.match(/## Mission Ledger/g) ?? []).length, 1);
  assert.match(file, /"status": "complete"/);
  assert.deepEqual(summarizeMissionLedger(ledger), {
    runId: "run:test",
    status: "complete",
    evidenceCount: 1,
    receiptCount: 1,
    expectedTools: ["web_search", "web_fetch"],
    nextAction: "none",
  });
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
