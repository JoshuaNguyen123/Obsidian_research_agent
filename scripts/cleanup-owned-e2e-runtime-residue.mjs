/**
 * Remove local runtime residue that only the e2e lanes ever create.
 *
 * The previous script matched exactly one prefix (`du03-live-<digits>`), so
 * every other lane's workspaces accumulated indefinitely: a development host
 * had 203 workspace metadata directories, 65 repository worktrees, and 1,619
 * temp directories left behind. The leak that produced the largest share of
 * those temp directories is fixed in GitWorktreeManager.dispose(); this script
 * clears what already accumulated.
 *
 * Safety: dry run by default (`--apply` to delete). Only directories whose
 * names match an owned e2e pattern are eligible, each candidate is realpath'd
 * and must remain a direct child of its declared root, and anything ambiguous
 * — a bare run id, a plain deliverable name — is reported for a human to
 * decide rather than removed.
 */

import { readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const apply = process.argv.includes("--apply");
const localAppData = process.env.LOCALAPPDATA?.trim();
if (!localAppData) {
  throw new Error("LOCALAPPDATA is required for owned e2e runtime cleanup.");
}

const codeRoot = path.join(localAppData, "AgenticResearcher", "code");

/** Names only the e2e harnesses produce. Anchored, no free-form wildcards. */
const OWNED_WORKSPACE_NAMES = [
  /^du03-live-\d{10,}$/u,
  /^du03-checkers-[0-9a-f]{8,}$/u,
  /^du03-request-[0-9a-f]{8,}$/u,
  /^du06-[0-9a-f]{8,}$/u,
  /^flow-real-(?:[0-9a-f]{8,}|workspace)$/u,
  /^compound-smoke-[0-9a-f]{8,}$/u,
  /^obs-hello-[0-9a-f]{8,}$/u,
  /^number-guess-[0-9a-f]{8,}$/u,
  /^desktop-(?:code|checkers)-real-\d{10,}$/u,
  /^phase4-[a-z0-9-]+-e2e_phase4_\d{10,}-\d+$/u,
  /^phase4-(?:crud|languages|notebook|repair|code)-[a-z0-9_-]+$/u,
];

/** Temp directories the harnesses and the orchestrator create. */
const OWNED_TEMP_NAMES = [
  /^agentic-researcher-disabled-hooks-[A-Za-z0-9]{6,}$/u,
  /^agentic-researcher-disabled-git-hooks-[A-Za-z0-9]{6,}$/u,
  /^agentic-flow-real-typescript-[A-Za-z0-9]{6,}$/u,
  /^agentic-phase4-[a-z-]+-[A-Za-z0-9]{6,}$/u,
  /^agentic-code-package-[A-Za-z0-9]{6,}$/u,
  /^agentic-background-code-[A-Za-z0-9]{6,}$/u,
  /^agentic-researcher-daily-use-[A-Za-z0-9]{6,}$/u,
  /^agentic-researcher-e2e-[A-Za-z0-9]{6,}$/u,
];

const targets = [
  {
    root: path.join(codeRoot, "workspaces-v2"),
    owned: OWNED_WORKSPACE_NAMES,
    label: "workspace metadata",
    reportUnowned: true,
  },
  {
    root: path.join(codeRoot, "repository-worktrees"),
    owned: OWNED_WORKSPACE_NAMES,
    label: "repository worktrees",
    reportUnowned: true,
  },
  {
    root: os.tmpdir(),
    owned: OWNED_TEMP_NAMES,
    label: "temp directories",
    reportUnowned: false,
  },
];

const report = [];
const skipped = [];
let matchedTotal = 0;
let removedTotal = 0;

for (const target of targets) {
  const root = await realpath(target.root).catch(() => null);
  if (!root) {
    report.push({ root: target.root, label: target.label, state: "absent" });
    continue;
  }
  let matched = 0;
  let removed = 0;
  let bytes = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!target.owned.some((pattern) => pattern.test(entry.name))) {
      // Report unowned residue instead of guessing: a bare run id or a plain
      // deliverable name may belong to a real user mission.
      if (target.reportUnowned) {
        skipped.push({ root: target.label, name: entry.name });
      }
      continue;
    }
    const candidate = await realpath(path.join(root, entry.name)).catch(
      () => null,
    );
    if (!candidate) continue;
    if (
      path.dirname(candidate) !== root ||
      path.basename(candidate) !== entry.name
    ) {
      throw new Error(`Refusing unsafe e2e cleanup target: ${candidate}`);
    }
    matched += 1;
    bytes += await directoryBytes(candidate);
    if (apply) {
      await rm(candidate, { recursive: true, force: true });
      removed += 1;
    }
  }
  matchedTotal += matched;
  removedTotal += removed;
  report.push({
    root: target.root,
    label: target.label,
    matched,
    removed,
    approxBytes: bytes,
  });
}

console.log(
  JSON.stringify(
    {
      version: 1,
      mode: apply ? "applied" : "dry_run",
      matchedCount: matchedTotal,
      removedCount: removedTotal,
      targets: report,
      unownedRetained: skipped,
    },
    null,
    2,
  ),
);

async function directoryBytes(root) {
  let total = 0;
  const queue = [root];
  let visited = 0;
  while (queue.length > 0) {
    const current = queue.pop();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      visited += 1;
      if (visited > 20_000) return total;
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const info = await stat(absolute).catch(() => null);
      if (info) total += info.size;
    }
  }
  return total;
}
