import { readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

const apply = process.argv.includes("--apply");
const localAppData = process.env.LOCALAPPDATA?.trim();
if (!localAppData) {
  throw new Error("LOCALAPPDATA is required for owned daily-use runtime cleanup.");
}

const roots = [
  path.join(localAppData, "AgenticResearcher", "code", "repository-worktrees"),
  path.join(localAppData, "AgenticResearcher", "code", "workspaces-v2"),
];
const ownedName = /^du03-live-\d{10,}$/u;
const matched = [];

for (const configuredRoot of roots) {
  const root = await realpath(configuredRoot).catch(() => null);
  if (!root) continue;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !ownedName.test(entry.name)) continue;
    const target = await realpath(path.join(root, entry.name));
    if (path.dirname(target) !== root || path.basename(target) !== entry.name) {
      throw new Error(`Refusing unsafe daily-use cleanup target: ${target}`);
    }
    matched.push(target);
    if (apply) await rm(target, { recursive: true, force: true });
  }
}

console.log(JSON.stringify({
  version: 1,
  mode: apply ? "applied" : "dry_run",
  matchedCount: matched.length,
  removedCount: apply ? matched.length : 0,
}, null, 2));
