import assert from "node:assert/strict";
import test from "node:test";
import type { TFile } from "obsidian";
import {
  applyRunNoteStatusFrontmatter,
  isIncompleteRuntimeStatus,
  isMissionRuntimeStatus,
  MISSION_RUNTIME_STATUSES,
  readRunNoteStatusFromFrontmatter,
  readRunNoteStatusFromMetadataCache,
  RUN_NOTE_STATUS_FRONTMATTER_KEY,
} from "../src/agent/runNoteStatus";
import {
  createMissionRuntimeSnapshot,
  formatMissionRuntimeSnapshotBlock,
  parseMissionRuntimeSnapshotFromMarkdown,
  replaceRuntimeSnapshotBlock,
} from "../src/agent/runStore";

test("status frontmatter is prepended to a bare note and updated in place afterwards", () => {
  const bare = "# Agent Run run-a\n\n## Mission Ledger\n```json\n{}\n```\n";
  const running = applyRunNoteStatusFrontmatter(bare, "running");
  assert.equal(
    running,
    `---\n${RUN_NOTE_STATUS_FRONTMATTER_KEY}: running\n---\n${bare}`,
  );
  const complete = applyRunNoteStatusFrontmatter(running, "complete");
  assert.equal(
    complete,
    `---\n${RUN_NOTE_STATUS_FRONTMATTER_KEY}: complete\n---\n${bare}`,
  );
  // Idempotent: the same status returns the same bytes (no spurious rewrite).
  assert.equal(applyRunNoteStatusFrontmatter(complete, "complete"), complete);
});

test("status frontmatter keeps other properties and the body untouched", () => {
  const note = "---\ntags: [research]\nowner: me\n---\n# Agent Run run-b\n\nbody\n";
  const marked = applyRunNoteStatusFrontmatter(note, "blocked");
  assert.equal(
    marked,
    `---\ntags: [research]\nowner: me\n${RUN_NOTE_STATUS_FRONTMATTER_KEY}: blocked\n---\n# Agent Run run-b\n\nbody\n`,
  );
  const updated = applyRunNoteStatusFrontmatter(marked, "complete");
  assert.equal(
    updated,
    `---\ntags: [research]\nowner: me\n${RUN_NOTE_STATUS_FRONTMATTER_KEY}: complete\n---\n# Agent Run run-b\n\nbody\n`,
  );
});

test("the runtime snapshot fence still parses under the frontmatter", () => {
  const snapshot = createMissionRuntimeSnapshot({
    runId: "run-c",
    originalMission: "Parse under frontmatter.",
    status: "complete",
    createdAt: new Date("2026-09-03T10:00:00.000Z"),
  });
  const block = formatMissionRuntimeSnapshotBlock(snapshot);
  const note = applyRunNoteStatusFrontmatter(
    replaceRuntimeSnapshotBlock("# Agent Run run-c\n", block),
    snapshot.status,
  );
  assert.ok(note.startsWith(`---\n${RUN_NOTE_STATUS_FRONTMATTER_KEY}: complete\n---\n# Agent Run run-c`));
  const parsed = parseMissionRuntimeSnapshotFromMarkdown(note);
  assert.equal(parsed?.runId, "run-c");
  assert.equal(parsed?.status, "complete");
});

test("frontmatter and metadata-cache readers accept only the status vocabulary", () => {
  for (const status of MISSION_RUNTIME_STATUSES) {
    assert.ok(isMissionRuntimeStatus(status));
    assert.equal(
      readRunNoteStatusFromFrontmatter({ [RUN_NOTE_STATUS_FRONTMATTER_KEY]: status }),
      status,
    );
  }
  assert.equal(readRunNoteStatusFromFrontmatter({ [RUN_NOTE_STATUS_FRONTMATTER_KEY]: "done" }), null);
  assert.equal(readRunNoteStatusFromFrontmatter({}), null);
  assert.equal(readRunNoteStatusFromFrontmatter(null), null);
  assert.equal(readRunNoteStatusFromFrontmatter("complete"), null);

  const file = { path: "Agent Runs/run-d.md" } as TFile;
  const cache = new Map<string, Record<string, unknown>>([
    ["Agent Runs/run-d.md", { [RUN_NOTE_STATUS_FRONTMATTER_KEY]: "complete" }],
  ]);
  const app = {
    metadataCache: {
      getFileCache: (target: TFile) => {
        const frontmatter = cache.get(target.path);
        return frontmatter ? { frontmatter } : null;
      },
    },
  };
  assert.equal(readRunNoteStatusFromMetadataCache(app, file), "complete");
  assert.equal(
    readRunNoteStatusFromMetadataCache(app, { path: "Agent Runs/unindexed.md" } as TFile),
    null,
    "an unindexed note reads as unknown, never as terminal",
  );
  assert.equal(readRunNoteStatusFromMetadataCache({ vault: {} }, file), null);
  assert.equal(readRunNoteStatusFromMetadataCache(null, file), null);
  assert.equal(
    readRunNoteStatusFromMetadataCache(
      { metadataCache: { getFileCache: () => { throw new Error("cache exploded"); } } },
      file,
    ),
    null,
  );
});

test("only complete is terminal for the load-path skip", () => {
  assert.equal(isIncompleteRuntimeStatus("complete"), false);
  for (const status of MISSION_RUNTIME_STATUSES.filter((value) => value !== "complete")) {
    assert.equal(isIncompleteRuntimeStatus(status), true, status);
  }
});
