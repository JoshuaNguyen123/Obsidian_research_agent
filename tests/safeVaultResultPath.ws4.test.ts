import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCKED_VAULT_ROOTS,
  isSafeVaultResultPath,
  normalizeVaultPath,
} from "../src/tools/validation";

test("isSafeVaultResultPath uses normalizeVaultPath and blocked roots", () => {
  assert.equal(isSafeVaultResultPath("Agent Work/Results/run.md"), true);
  assert.equal(
    isSafeVaultResultPath("Agent Work/Results/run.ipynb"),
    true,
  );
  assert.equal(isSafeVaultResultPath(".obsidian/plugins/note.md"), false);
  assert.equal(isSafeVaultResultPath(".obsidian/workspace.md"), false);
  assert.equal(isSafeVaultResultPath(".trash/note.md"), false);
  assert.equal(isSafeVaultResultPath(".agent-backups/note.md"), false);
  assert.equal(isSafeVaultResultPath("C:/Users/me/note.md"), false);
  assert.equal(isSafeVaultResultPath("../secret.md"), false);
  assert.equal(isSafeVaultResultPath("folder\\note.md"), false);

  assert.ok(BLOCKED_VAULT_ROOTS.has(".obsidian"));
  assert.throws(() => normalizeVaultPath(".obsidian/workspace.md"));
});
