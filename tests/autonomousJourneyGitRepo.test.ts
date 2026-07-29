import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createAutonomousJourneyPythonFixture } from "../e2e/fixtures/autonomousJourneyGitRepo";

const execFileAsync = promisify(execFile);

const REFERENCE_IMPLEMENTATION = `
PROOF_MARKER = "__MARKER__"


class GCounter:
    def __init__(self, replica_id):
        self.replica_id = replica_id
        self._counts = {}

    def increment(self, amount=1):
        if not isinstance(amount, int) or amount < 0:
            raise ValueError("amount must be a non-negative integer")
        self._counts[self.replica_id] = self._counts.get(self.replica_id, 0) + amount

    @property
    def value(self):
        return sum(self._counts.values())

    def merge(self, other):
        for replica, count in other._counts.items():
            self._counts[replica] = max(self._counts.get(replica, 0), count)


class ORSet:
    def __init__(self, replica_id):
        self.replica_id = replica_id
        self._sequence = 0
        self._adds = {}
        self._removes = set()

    def add(self, item):
        self._sequence += 1
        tag = (self.replica_id, self._sequence)
        self._adds.setdefault(item, set()).add(tag)

    def remove(self, item):
        self._removes.update(self._adds.get(item, set()))

    @property
    def value(self):
        return {
            item
            for item, tags in self._adds.items()
            if tags.difference(self._removes)
        }

    def merge(self, other):
        for item, tags in other._adds.items():
            self._adds.setdefault(item, set()).update(tags)
        self._removes.update(other._removes)
`;

test("autonomous journey fixture starts red and verifies CRDT behavior", async () => {
  const fixture = await createAutonomousJourneyPythonFixture(
    "AUTONOMOUS_PROOF_123",
  );
  const linkedWorktree = path.join(
    tmpdir(),
    `agentic-autonomous-linked-${randomUUID()}`,
  );
  const linkedBranch = `codex/workspace-${randomUUID()}`;
  try {
    await execFileAsync(
      "git",
      [
        "worktree",
        "add",
        "-b",
        linkedBranch,
        linkedWorktree,
        "HEAD",
      ],
      {
        cwd: fixture.root,
        windowsHide: true,
        timeout: 60_000,
      },
    );
    await assert.rejects(
      fixture.runAcceptance(),
      /returned non-zero exit code|Command failed|No module named|crdt_sync/iu,
    );
    await writeFile(
      path.join(fixture.root, "crdt_sync.py"),
      REFERENCE_IMPLEMENTATION.replace("__MARKER__", fixture.marker),
      "utf8",
    );
    await writeFile(
      path.join(fixture.root, "README.md"),
      `# CRDT sync library\n\nProof marker: ${fixture.marker}\n\nRun \`python -m unittest discover -s tests -v\`.\n`,
      "utf8",
    );

    const output = await fixture.runAcceptance();
    assert.match(output, /Ran 5 tests/iu);
    assert.match(output, /\bOK\b/u);
    await fixture.assertProtectedContract(fixture.root);
    const inspected = await fixture.inspectWorktree(fixture.root);
    assert.match(inspected.status, /README\.md/u);
    assert.match(inspected.status, /crdt_sync\.py/u);
    assert.doesNotMatch(inspected.status, /__pycache__|\.pyc/iu);
    const tree = await fixture.snapshotTree(fixture.root);
    assert.deepEqual(
      tree.map((entry) => entry.path),
      [
        ".gitignore",
        "crdt_sync.py",
        "README.md",
        "scripts/verify_project.py",
        "tests/test_crdt_contract.py",
      ],
    );
    assert.ok(tree.every((entry) => /^[a-f0-9]{64}$/u.test(entry.sha256)));
    await fixture.removeOwnedWorktree(linkedWorktree, linkedBranch);
  } finally {
    await fixture.cleanup();
  }
  await assert.rejects(
    lstat(linkedWorktree),
    (error: NodeJS.ErrnoException) => error.code === "ENOENT",
  );
});
