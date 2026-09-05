import { processTestVaultFile } from "./helpers/atomicTestVault";
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPluginVersionStampIfMissing,
  normalizePluginVersion,
  normalizePluginVersionStamp,
  readPluginVersionStampFromHost,
} from "../src/agent/pluginVersionStamp";
import {
  createMissionLedger,
  createPrePlanningAnchorLedger,
  formatMissionLedgerBlock,
  parseMissionLedgerFromMarkdown,
  summarizeMissionLedger,
  writeMissionLedger,
} from "../src/agent/missionLedger";
import {
  createMissionRuntimeSnapshot,
  formatMissionRuntimeSnapshotBlock,
  parseMissionRuntimeSnapshotFromMarkdown,
  writeMissionRuntimeSnapshot,
} from "../src/agent/runStore";
import type { ToolExecutionContext } from "../src/tools/types";

const LOOP_BUDGET = {
  hardCap: 4,
  toolStepBudget: 2,
  finalizationReserve: 1,
  expectedTools: ["web_search"],
  stopWhenSatisfied: true,
};

test("normalizePluginVersion accepts only short dotted build ids", () => {
  assert.equal(normalizePluginVersion("0.4.0"), "0.4.0");
  assert.equal(normalizePluginVersion("1.5.0"), "1.5.0");
  assert.equal(normalizePluginVersion("0.4.0-beta"), "0.4.0-beta");
  assert.equal(normalizePluginVersion(" 0.4.0 "), "0.4.0");
  assert.equal(normalizePluginVersion(null), undefined);
  assert.equal(normalizePluginVersion(""), undefined);
  assert.equal(normalizePluginVersion("C:\\Users\\josh\\secret.md"), undefined);
  assert.equal(normalizePluginVersion("Agent Runs/run-1.md"), undefined);
  assert.equal(normalizePluginVersion("sk-live-abcdefghijklmnopqrstuvwxyz"), undefined);
  assert.equal(
    normalizePluginVersion("Research the current note and append sources."),
    undefined,
  );
  assert.equal(normalizePluginVersion("0.4.0 / vault/Notes/secret.md"), undefined);
});

test("new mission ledgers include a host-supplied plugin version", () => {
  const ledger = createMissionLedger({
    runId: "run-versioned",
    mission: "Stamp this run.",
    route: "grounded_workflow",
    loopBudget: LOOP_BUDGET,
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });

  assert.equal(ledger.pluginVersion, "0.4.0");
  assert.equal(ledger.minAppVersion, "1.5.0");
  assert.equal(ledger.schemaVersion, 2);

  const parsed = parseMissionLedgerFromMarkdown(formatMissionLedgerBlock(ledger));
  assert.ok(parsed);
  assert.equal(parsed.pluginVersion, "0.4.0");
  assert.equal(parsed.minAppVersion, "1.5.0");
  assert.match(formatMissionLedgerBlock(ledger), /- Plugin version: 0\.4\.0/);
  assert.equal(summarizeMissionLedger(parsed).pluginVersion, "0.4.0");
});

test("createMissionLedger omits the version stamp unless the host passed one", () => {
  const ledger = createMissionLedger({
    runId: "run-unstamped",
    mission: "No host stamp.",
    route: "grounded_workflow",
    loopBudget: LOOP_BUDGET,
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(ledger.pluginVersion, undefined);
  assert.equal(ledger.minAppVersion, undefined);
});

test("old ledgers without pluginVersion still parse", () => {
  const markdown = [
    "## Mission Ledger",
    "```json",
    JSON.stringify({
      schemaVersion: 2,
      runId: "legacy-run",
      mission: "Older build left no version.",
      route: "grounded_workflow",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
      status: "running",
      loopBudget: {
        hardCap: 4,
        toolStepBudget: 2,
        finalizationReserve: 1,
        expectedTools: ["web_search"],
      },
    }),
    "```",
    "",
  ].join("\n");

  const ledger = parseMissionLedgerFromMarkdown(markdown);
  assert.ok(ledger);
  assert.equal(ledger.pluginVersion, undefined);
  assert.equal(ledger.minAppVersion, undefined);
  assert.equal(ledger.runId, "legacy-run");
  assert.equal(ledger.schemaVersion, 2);
});

test("null or secret-like pluginVersion values are dropped on read", () => {
  const markdown = [
    "## Mission Ledger",
    "```json",
    JSON.stringify({
      schemaVersion: 2,
      runId: "tainted-run",
      mission: "Reject a stuffed token.",
      route: "grounded_workflow",
      createdAt: "2026-08-01T12:00:00.000Z",
      updatedAt: "2026-08-01T12:00:00.000Z",
      status: "running",
      pluginVersion: null,
      minAppVersion: "sk-live-not-a-version",
      loopBudget: {
        hardCap: 4,
        toolStepBudget: 2,
        finalizationReserve: 1,
        expectedTools: [],
      },
    }),
    "```",
    "",
  ].join("\n");

  const ledger = parseMissionLedgerFromMarkdown(markdown);
  assert.ok(ledger);
  assert.equal(ledger.pluginVersion, undefined);
  assert.equal(ledger.minAppVersion, undefined);
});

test("pre-planning anchors accept the same host stamp", () => {
  const ledger = createPrePlanningAnchorLedger({
    runId: "run-anchor",
    mission: "Accepted before planning.",
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(ledger.pluginVersion, "0.4.0");
  assert.equal(ledger.minAppVersion, "1.5.0");
});

test("writeMissionLedger stamps a missing version from host context", async () => {
  const mock = createLedgerWriteContext({
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
  });
  const ledger = createMissionLedger({
    runId: "run-context-stamp",
    mission: "Stamp on persist.",
    route: "grounded_workflow",
    loopBudget: LOOP_BUDGET,
    now: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(ledger.pluginVersion, undefined);

  const written = await writeMissionLedger(mock.context, ledger);
  assert.ok(written);
  assert.equal(ledger.pluginVersion, "0.4.0");
  assert.equal(ledger.minAppVersion, "1.5.0");

  const persisted = parseMissionLedgerFromMarkdown(
    mock.files.get("Agent Runs/run-context-stamp.md") ?? "",
  );
  assert.ok(persisted);
  assert.equal(persisted.pluginVersion, "0.4.0");
  assert.equal(persisted.minAppVersion, "1.5.0");
});

test("writeMissionLedger does not overwrite a create-time version", async () => {
  const mock = createLedgerWriteContext({
    pluginVersion: "0.5.0",
    minAppVersion: "1.6.0",
  });
  const ledger = createMissionLedger({
    runId: "run-keep-create",
    mission: "Keep the first build id.",
    route: "grounded_workflow",
    loopBudget: LOOP_BUDGET,
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
    now: new Date("2026-09-02T12:00:00.000Z"),
  });

  await writeMissionLedger(mock.context, ledger);
  const persisted = parseMissionLedgerFromMarkdown(
    mock.files.get("Agent Runs/run-keep-create.md") ?? "",
  );
  assert.equal(persisted?.pluginVersion, "0.4.0");
  assert.equal(persisted?.minAppVersion, "1.5.0");
});

test("runtime snapshots include and restore a host version stamp", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "snap-versioned",
    originalMission: "Stamp the snapshot.",
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(snapshot.pluginVersion, "0.4.0");
  assert.equal(snapshot.minAppVersion, "1.5.0");
  assert.equal(snapshot.version, 2);

  const parsed = parseMissionRuntimeSnapshotFromMarkdown(
    formatMissionRuntimeSnapshotBlock(snapshot),
  );
  assert.ok(parsed);
  assert.equal(parsed.pluginVersion, "0.4.0");
  assert.equal(parsed.minAppVersion, "1.5.0");
});

test("old runtime snapshots without pluginVersion still parse", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "snap-legacy",
    originalMission: "Older snapshot.",
    createdAt: new Date("2026-08-01T12:00:00.000Z"),
  });
  const json = JSON.parse(formatMissionRuntimeSnapshotBlock(snapshot).split("```json\n")[1].split("\n```")[0]);
  delete json.pluginVersion;
  delete json.minAppVersion;
  const markdown = [
    "## Runtime Snapshot",
    "```json",
    JSON.stringify(json),
    "```",
    "",
  ].join("\n");
  const parsed = parseMissionRuntimeSnapshotFromMarkdown(markdown);
  assert.ok(parsed);
  assert.equal(parsed.pluginVersion, undefined);
  assert.equal(parsed.runId, "snap-legacy");
});

test("writeMissionRuntimeSnapshot stamps a missing version from host context", async () => {
  const mock = createLedgerWriteContext({
    pluginVersion: "0.4.0",
    minAppVersion: "1.5.0",
  });
  const snapshot = createMissionRuntimeSnapshot({
    runId: "snap-context-stamp",
    originalMission: "Stamp on persist.",
    createdAt: new Date("2026-09-02T12:00:00.000Z"),
  });
  assert.equal(snapshot.pluginVersion, undefined);

  const written = await writeMissionRuntimeSnapshot(mock.context, snapshot);
  assert.ok(written);
  assert.equal(snapshot.pluginVersion, "0.4.0");

  const persisted = parseMissionRuntimeSnapshotFromMarkdown(
    mock.files.get("Agent Runs/snap-context-stamp.md") ?? "",
  );
  assert.ok(persisted);
  assert.equal(persisted.pluginVersion, "0.4.0");
  assert.equal(persisted.minAppVersion, "1.5.0");
});

test("applyPluginVersionStampIfMissing never copies invalid host values", () => {
  const stamp = normalizePluginVersionStamp({
    pluginVersion: "../../.env",
    minAppVersion: "Bearer abc.def.ghi",
  });
  assert.deepEqual(stamp, {});
  const target = applyPluginVersionStampIfMissing<{ pluginVersion?: string }>(
    {},
    stamp,
  );
  assert.equal(target.pluginVersion, undefined);
  assert.deepEqual(
    readPluginVersionStampFromHost({
      pluginVersion: "0.4.0",
      minAppVersion: "1.5.0",
      apiKey: "sk-should-never-be-read",
    }),
    { pluginVersion: "0.4.0", minAppVersion: "1.5.0" },
  );
});

function createLedgerWriteContext(stamp: {
  pluginVersion?: string;
  minAppVersion?: string;
}) {
  const files = new Map<string, string>();
  const folders = new Set<string>();
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
    };
  };
  const context = {
    app: {
      vault: {
        getFolderByPath: (path: string) =>
          folders.has(path) ? { path } : null,
        createFolder: async (path: string) => {
          folders.add(path);
        },
        getFileByPath,
        create: async (path: string, content: string) => {
          files.set(path, content);
        },
        read: async (file: { path: string }) => files.get(file.path) ?? "",
        process: function (file: any, transform: (content: string) => string): Promise<string> {
          return processTestVaultFile(this, file, transform);
        },
        modify: async (file: { path: string }, content: string) => {
          files.set(file.path, content);
        },
      },
    },
    pluginVersion: stamp.pluginVersion,
    minAppVersion: stamp.minAppVersion,
  } as unknown as ToolExecutionContext;
  return { context, files };
}
