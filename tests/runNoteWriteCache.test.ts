import { processTestVaultFile } from "./helpers/atomicTestVault";
import test from "node:test";
import assert from "node:assert/strict";
import { appendAgentRunCheckpoint } from "../src/agent/checkpoints";
import {
  createMissionLedger,
  parseMissionLedgerFromMarkdown,
  writeMissionLedger,
  writeMissionLedgerWithRuntimeSnapshot,
  type MissionEvidence,
} from "../src/agent/missionLedger";
import {
  capRuntimeEvidence,
  clearAgentRunMarkdownCacheForTests,
  createMissionRuntimeSnapshot,
  formatMissionRuntimeSnapshotBlock,
  MAX_RUNTIME_EVIDENCE,
  parseMissionRuntimeSnapshotFromMarkdown,
  readAgentRunMarkdownForUpdate,
  rememberAgentRunMarkdownWrite,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import type { ToolExecutionContext } from "../src/tools/types";

/**
 * A vault whose adapter exposes read/write/stat like Obsidian's desktop
 * adapter, with call counters, so a test can prove which reads happened.
 */
function createAdapterVault() {
  const files = new Map<string, string>();
  const stats = new Map<string, { mtime: number; size: number }>();
  const folders = new Set<string>(["Agent Runs"]);
  let clock = 1000;
  const counts = { adapterRead: 0, adapterWrite: 0, adapterStat: 0, vaultRead: 0 };
  const touch = (path: string, content: string) => {
    files.set(path, content);
    stats.set(path, { mtime: ++clock, size: Buffer.byteLength(content) });
  };
  const getFileByPath = (path: string) => {
    if (!files.has(path)) {
      return null;
    }
    const name = path.split("/").pop() ?? path;
    return {
      path,
      name,
      basename: name.replace(/[.]md$/i, ""),
      extension: name.split(".").pop()?.toLowerCase() ?? "",
      stat: { mtime: stats.get(path)?.mtime ?? 0 },
    };
  };
  const vault = {
    adapter: {
      read: async (path: string) => {
        counts.adapterRead += 1;
        const content = files.get(path);
        if (content === undefined) {
          throw new Error(`ENOENT: ${path}`);
        }
        return content;
      },
      write: async (path: string, data: string) => {
        counts.adapterWrite += 1;
        touch(path, data);
      },
      stat: async (path: string) => {
        counts.adapterStat += 1;
        const stat = stats.get(path);
        return stat ? { type: "file", ...stat, ctime: stat.mtime } : null;
      },
    },
    getFolderByPath: (path: string) =>
      folders.has(path) ? { path, name: path.split("/").pop() ?? path } : null,
    createFolder: async (path: string) => {
      folders.add(path);
    },
    getFileByPath,
    getFiles: () =>
      [...files.keys()]
        .map(getFileByPath)
        .filter((file): file is NonNullable<typeof file> => Boolean(file)),
    create: async (path: string, content: string) => {
      touch(path, content);
    },
    read: async (file: { path: string }) => {
      counts.vaultRead += 1;
      return files.get(file.path) ?? "";
    },
    process: function (file: any, transform: (content: string) => string): Promise<string> {
      return processTestVaultFile(this, file, transform);
    },
    modify: async (file: { path: string }, content: string) => {
      touch(file.path, content);
    },
  };
  const context = {
    app: { vault },
    now: () => new Date("2026-09-03T04:00:00.000Z"),
  } as unknown as ToolExecutionContext;
  return {
    context,
    files,
    counts,
    adapter: vault.adapter,
    externalEdit: (path: string, content: string) => touch(path, content),
  };
}

function snapshotNotes(markdown: string | undefined): string[] {
  return parseMissionRuntimeSnapshotFromMarkdown(markdown ?? "")?.notes ?? [];
}

test("run-note rewrites skip the pre-read while the adapter stat matches the last exact write", async () => {
  clearAgentRunMarkdownCacheForTests();
  const vault = createAdapterVault();
  const path = "Agent Runs/run-cache-a.md";
  const base = createMissionRuntimeSnapshot({
    runId: "run-cache-a",
    originalMission: "Cache the pre-read.",
    status: "running",
    createdAt: new Date("2026-09-03T03:00:00.000Z"),
  });

  const created = await writeMissionRuntimeSnapshot(vault.context, base);
  assert.equal(created?.revision, 1);
  assert.equal(created?.commitProof, "vault_acknowledged");

  // The note was created through vault.create, which proves nothing about
  // the bytes on disk, so the first rewrite pre-reads once and reads back once.
  vault.counts.adapterRead = 0;
  const second = await writeMissionRuntimeSnapshot(vault.context, {
    ...base,
    notes: ["second"],
  });
  assert.equal(second?.revision, 2);
  assert.equal(second?.commitProof, "adapter_exact_readback");
  assert.equal(vault.counts.adapterRead, 2, "unremembered note: pre-read + readback");

  // The exact write was remembered with its stat: only the readback remains.
  vault.counts.adapterRead = 0;
  const third = await writeMissionRuntimeSnapshot(vault.context, {
    ...base,
    notes: ["third"],
  });
  assert.equal(third?.revision, 3);
  assert.equal(third?.commitProof, "adapter_exact_readback");
  assert.equal(vault.counts.adapterRead, 1, "remembered note: readback only");
  assert.deepEqual(snapshotNotes(vault.files.get(path)), ["third"]);

  // Anything that changes the stat (a human edit, a sync client) forces a
  // real pre-read, and the foreign bytes survive the splice.
  vault.externalEdit(path, `${vault.files.get(path)}\n## Human note\n\nkeep me\n`);
  vault.counts.adapterRead = 0;
  const fourth = await writeMissionRuntimeSnapshot(vault.context, {
    ...base,
    notes: ["fourth"],
  });
  assert.equal(fourth?.revision, 4);
  assert.equal(vault.counts.adapterRead, 2, "changed stat: pre-read + readback");
  assert.match(vault.files.get(path) ?? "", /keep me/);
  assert.deepEqual(snapshotNotes(vault.files.get(path)), ["fourth"]);

  // And the write after that is cached again.
  vault.counts.adapterRead = 0;
  const fifth = await writeMissionRuntimeSnapshot(vault.context, {
    ...base,
    notes: ["fifth"],
  });
  assert.equal(fifth?.revision, 5);
  assert.equal(vault.counts.adapterRead, 1);
});

test("a same-size same-mtime foreign rewrite is the only blind spot, and a stat change of either field is enough", async () => {
  clearAgentRunMarkdownCacheForTests();
  const vault = createAdapterVault();
  const path = "Agent Runs/run-cache-b.md";
  vault.externalEdit(path, "# Agent Run run-cache-b\n\noriginal\n");
  const vaultRead = async () => {
    vault.counts.vaultRead += 1;
    return vault.files.get(path) ?? "";
  };

  const first = await readAgentRunMarkdownForUpdate({
    path,
    adapter: vault.adapter,
    vaultRead,
  });
  assert.equal(first, "# Agent Run run-cache-b\n\noriginal\n");
  assert.equal(vault.counts.adapterRead, 1);

  const cached = await readAgentRunMarkdownForUpdate({
    path,
    adapter: vault.adapter,
    vaultRead,
  });
  assert.equal(cached, first);
  assert.equal(vault.counts.adapterRead, 1, "a stat hit serves the remembered bytes");

  // Same byte length, different mtime: a real read.
  vault.externalEdit(path, "# Agent Run run-cache-b\n\nORIGINAL\n");
  const reread = await readAgentRunMarkdownForUpdate({
    path,
    adapter: vault.adapter,
    vaultRead,
  });
  assert.equal(reread, "# Agent Run run-cache-b\n\nORIGINAL\n");
  assert.equal(vault.counts.adapterRead, 2);
  assert.equal(vault.counts.vaultRead, 0, "the adapter read wins when present");

  // After an exact write the remembered bytes are the written ones.
  await vault.adapter.write(path, "# Agent Run run-cache-b\n\nwritten\n");
  await rememberAgentRunMarkdownWrite({
    path,
    adapter: vault.adapter,
    markdown: "# Agent Run run-cache-b\n\nwritten\n",
  });
  const afterWrite = await readAgentRunMarkdownForUpdate({
    path,
    adapter: vault.adapter,
    vaultRead,
  });
  assert.equal(afterWrite, "# Agent Run run-cache-b\n\nwritten\n");
  assert.equal(vault.counts.adapterRead, 2, "a remembered write needs no read");
});

test("without an adapter stat every pre-read is a real read", async () => {
  clearAgentRunMarkdownCacheForTests();
  let reads = 0;
  const vaultRead = async () => {
    reads += 1;
    return "content";
  };
  const path = "Agent Runs/run-cache-c.md";

  assert.equal(
    await readAgentRunMarkdownForUpdate({ path, adapter: undefined, vaultRead }),
    "content",
  );
  assert.equal(
    await readAgentRunMarkdownForUpdate({ path, adapter: undefined, vaultRead }),
    "content",
  );
  assert.equal(reads, 2, "no adapter: the vault read runs every time");

  const statlessAdapter = { read: async () => "adapter content" };
  assert.equal(
    await readAgentRunMarkdownForUpdate({ path, adapter: statlessAdapter, vaultRead }),
    "adapter content",
  );
  assert.equal(
    await readAgentRunMarkdownForUpdate({ path, adapter: statlessAdapter, vaultRead }),
    "adapter content",
  );
  assert.equal(reads, 2, "a stat-less adapter reads through its own read");

  const failingStat = {
    read: async () => "after failed stat",
    stat: async () => {
      throw new Error("stat unavailable");
    },
  };
  assert.equal(
    await readAgentRunMarkdownForUpdate({ path, adapter: failingStat, vaultRead }),
    "after failed stat",
  );
});

test("snapshot, ledger, and checkpoint writers share one remembered note", async () => {
  clearAgentRunMarkdownCacheForTests();
  const vault = createAdapterVault();
  const runId = "run-cache-d";
  const path = "Agent Runs/run-cache-d.md";
  const snapshot = createMissionRuntimeSnapshot({
    runId,
    originalMission: "Share one note.",
    status: "running",
    createdAt: new Date("2026-09-03T03:00:00.000Z"),
  });
  await writeMissionRuntimeSnapshot(vault.context, snapshot);
  await writeMissionRuntimeSnapshot(vault.context, { ...snapshot, notes: ["warm"] });
  assert.deepEqual([...vault.files.keys()], [path], "all three writers target one note");

  vault.counts.adapterRead = 0;
  const ledger = createMissionLedger({
    runId,
    mission: "Share one note.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-09-03T03:00:00.000Z"),
  });
  assert.ok(await writeMissionLedger(vault.context, ledger));
  assert.equal(
    vault.counts.adapterRead,
    1,
    "the ledger writer reuses the snapshot writer's remembered bytes",
  );

  vault.counts.adapterRead = 0;
  const checkpoint = await appendAgentRunCheckpoint(vault.context, {
    runId,
    step: 5,
    maxSteps: 30,
    status: "running",
    route: "grounded_workflow",
    toolNames: ["web_search"],
    message: "Checkpoint survives.",
    timestamp: new Date("2026-09-03T03:05:00.000Z"),
  });
  assert.equal(checkpoint.path, path);
  assert.equal(
    vault.counts.adapterRead,
    1,
    "the checkpoint appender reuses the ledger writer's remembered bytes",
  );

  vault.counts.adapterRead = 0;
  await writeMissionRuntimeSnapshot(vault.context, {
    ...snapshot,
    notes: ["after checkpoint"],
  });
  assert.equal(vault.counts.adapterRead, 1);

  const markdown = vault.files.get(path) ?? "";
  assert.deepEqual(snapshotNotes(markdown), ["after checkpoint"]);
  assert.equal(parseMissionLedgerFromMarkdown(markdown)?.runId, runId);
  assert.match(markdown, /Checkpoint survives\./);
  assert.deepEqual([...vault.files.keys()], [path]);
});

test("the combined writer lands the ledger and the snapshot in one exact write", async () => {
  clearAgentRunMarkdownCacheForTests();
  const vault = createAdapterVault();
  const runId = "run-combined";
  const path = "Agent Runs/run-combined.md";
  const ledger = createMissionLedger({
    runId,
    mission: "Combine the writes.",
    route: "grounded_workflow",
    loopBudget: {
      hardCap: 30,
      toolStepBudget: 5,
      finalizationReserve: 1,
      expectedTools: ["web_search"],
      stopWhenSatisfied: true,
    },
    now: new Date("2026-09-03T03:00:00.000Z"),
  });
  const snapshot = createMissionRuntimeSnapshot({
    runId,
    originalMission: "Combine the writes.",
    status: "running",
    createdAt: new Date("2026-09-03T03:00:00.000Z"),
  });

  const created = await writeMissionLedgerWithRuntimeSnapshot(
    vault.context,
    ledger,
    snapshot,
  );
  assert.ok(created);
  assert.equal(created.ledger.revision, 1);
  assert.equal(created.snapshot.revision, 1);
  assert.equal(created.snapshot.commitProof, "vault_acknowledged");
  assert.equal(ledger.revision, 1, "the live ledger carries the staged revision");
  assert.equal(snapshot.revision, 1, "the live snapshot carries the staged revision");
  assert.equal(vault.counts.adapterWrite, 0, "creation goes through vault.create");
  let markdown = vault.files.get(path) ?? "";
  assert.equal(parseMissionLedgerFromMarkdown(markdown)?.revision, 1);
  assert.equal(parseMissionRuntimeSnapshotFromMarkdown(markdown)?.revision, 1);

  vault.counts.adapterRead = 0;
  vault.counts.adapterWrite = 0;
  const second = await writeMissionLedgerWithRuntimeSnapshot(
    vault.context,
    ledger,
    snapshot,
  );
  assert.ok(second);
  assert.equal(second.ledger.revision, 2);
  assert.equal(second.snapshot.revision, 2);
  assert.equal(second.snapshot.commitProof, "adapter_exact_readback");
  assert.equal(vault.counts.adapterWrite, 1, "both blocks in one write");
  assert.equal(vault.counts.adapterRead, 2, "unremembered note: pre-read + readback");
  markdown = vault.files.get(path) ?? "";
  assert.equal(parseMissionLedgerFromMarkdown(markdown)?.revision, 2);
  assert.equal(parseMissionRuntimeSnapshotFromMarkdown(markdown)?.revision, 2);
  assert.equal((markdown.match(/## Mission Ledger/g) ?? []).length, 1);
  assert.equal((markdown.match(/## Runtime Snapshot/g) ?? []).length, 1);

  vault.counts.adapterRead = 0;
  vault.counts.adapterWrite = 0;
  const third = await writeMissionLedgerWithRuntimeSnapshot(
    vault.context,
    ledger,
    snapshot,
  );
  assert.equal(third?.ledger.revision, 3);
  assert.equal(third?.snapshot.revision, 3);
  assert.equal(vault.counts.adapterWrite, 1);
  assert.equal(vault.counts.adapterRead, 1, "remembered note: readback only");

  // The single-block writers continue the same revision lines.
  const ledgerOnly = await writeMissionLedger(vault.context, ledger);
  assert.equal(ledgerOnly?.revision, 4);
  const snapshotOnly = await writeMissionRuntimeSnapshot(vault.context, snapshot);
  assert.equal(snapshotOnly?.revision, 4);
  markdown = vault.files.get(path) ?? "";
  assert.equal(parseMissionLedgerFromMarkdown(markdown)?.revision, 4);
  assert.equal(parseMissionRuntimeSnapshotFromMarkdown(markdown)?.revision, 4);
  assert.deepEqual([...vault.files.keys()], [path]);

  await assert.rejects(
    writeMissionLedgerWithRuntimeSnapshot(vault.context, ledger, {
      ...snapshot,
      runId: "run-other",
    }),
    /different run notes/,
  );
});

test("the runtime snapshot fence is compact JSON that the parser round-trips", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-compact",
    originalMission: "Compact the write-ahead log.",
    status: "running",
    createdAt: new Date("2026-09-03T03:00:00.000Z"),
    notes: ["one", "two"],
  });
  const block = formatMissionRuntimeSnapshotBlock(snapshot);
  const lines = block.split("\n");

  assert.equal(lines[0], "## Runtime Snapshot");
  assert.equal(lines[1], "```json");
  assert.equal(lines[3], "```");
  assert.equal(lines.length, 5, "heading, fence, one JSON line, fence, trailing newline");
  assert.deepEqual(JSON.parse(lines[2]), JSON.parse(JSON.stringify(snapshot)));

  const parsed = parseMissionRuntimeSnapshotFromMarkdown(
    `# Agent Run run-compact\n\n${block}\n## Mission Ledger\n\nunrelated\n`,
  );
  assert.equal(parsed?.runId, "run-compact");
  assert.deepEqual(parsed?.notes, ["one", "two"]);
});

test("the persisted evidence projection drops the oldest non-usable records first", () => {
  const evidence: MissionEvidence[] = Array.from(
    { length: MAX_RUNTIME_EVIDENCE + 40 },
    (_, index) => ({
      id: `evidence-${index}`,
      kind: "web_source" as MissionEvidence["kind"],
      title: `Source ${index}`,
      summary: "summary",
      confidence: "medium" as const,
      usableSource: index % 2 === 0,
    }),
  );

  const capped = capRuntimeEvidence(evidence);
  assert.equal(capped.length, MAX_RUNTIME_EVIDENCE);
  assert.equal(capped[0]?.id, "evidence-0", "the oldest usable source survives");
  assert.equal(
    capped.some((record) => record.id === "evidence-1"),
    false,
    "the oldest non-usable record is evicted first",
  );
  assert.equal(
    capped.some((record) => record.id === "evidence-79"),
    false,
    "forty non-usable records go: indices 1, 3, ..., 79",
  );
  assert.equal(capped.some((record) => record.id === "evidence-81"), true);
  assert.deepEqual(
    capped.map((record) => record.id),
    evidence
      .filter((record) => !(record.usableSource === false && Number(record.id.slice(9)) <= 79))
      .map((record) => record.id),
    "order is preserved",
  );

  const allUsable = evidence.map((record) => ({ ...record, usableSource: true }));
  const cappedUsable = capRuntimeEvidence(allUsable);
  assert.equal(cappedUsable.length, MAX_RUNTIME_EVIDENCE);
  assert.equal(cappedUsable[0]?.id, "evidence-40", "then the oldest overall");

  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-evidence-cap",
    originalMission: "Cap the evidence.",
    status: "running",
    createdAt: new Date("2026-09-03T03:00:00.000Z"),
    evidence,
  });
  assert.equal(snapshot.evidence.length, MAX_RUNTIME_EVIDENCE);
  assert.equal(capRuntimeEvidence(evidence.slice(0, 10)).length, 10);
});
