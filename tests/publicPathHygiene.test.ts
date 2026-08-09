import assert from "node:assert/strict";
import test from "node:test";

import { findForbiddenPublicPaths } from "../scripts/check-path-hygiene.mjs";

test("public path hygiene rejects local agent folders and context documents", () => {
  assert.deepEqual(
    findForbiddenPublicPaths([
      ".agents/config.json",
      "nested/.Codex/state.json",
      ".claude/settings.json",
      "docs/technical_details.md",
      "skills/local/SKILL.md",
      "AGENTS.md",
      "notes/Claude.md",
      "CODEX.md",
      "MEMORY.md",
      "workspace.private.local.md",
    ]),
    [
      ".agents/config.json",
      "nested/.Codex/state.json",
      ".claude/settings.json",
      "docs/technical_details.md",
      "skills/local/SKILL.md",
      "AGENTS.md",
      "notes/Claude.md",
      "CODEX.md",
      "MEMORY.md",
      "workspace.private.local.md",
    ],
  );
});

test("public path hygiene preserves intentional product and repository files", () => {
  assert.deepEqual(
    findForbiddenPublicPaths([
      "README.md",
      "SECURITY.md",
      "src/agent/missionPlan.ts",
      ".github/workflows/test.yml",
      "companion/data/README.md",
    ]),
    [],
  );
});
