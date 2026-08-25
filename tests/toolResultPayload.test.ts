import assert from "node:assert/strict";
import test from "node:test";

import { serializeToolResultForModel } from "../src/model/toolResultPayload";

test("code validation model payload preserves bounded redacted repair diagnostics", () => {
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_validate_fast",
    output: {
      status: "failed",
      sandboxReceipt: {
        id: "sandbox-receipt-private-details-must-not-be-copied-wholesale",
      },
      validationReceipt: {
        id: "validation-1",
        kindName: "code_validation",
        kind: "fast",
        status: "failed",
        fingerprint: `sha256:${"1".repeat(64)}`,
        failureFingerprint: `sha256:${"2".repeat(64)}`,
        internalValue: "must-not-cross",
      },
      validationDiagnostics: {
        version: 1,
        stdoutSha256: `sha256:${"3".repeat(64)}`,
        stderrSha256: `sha256:${"4".repeat(64)}`,
        stdoutBytes: 81,
        stderrBytes: 0,
        truncated: false,
        redactedLines: 1,
      },
      validationDiagnosticExcerpt: {
        version: 1,
        stdout: "test/math.test.mjs must import node:test and currently contains Markdown",
        stderr: "[redacted credential-shaped diagnostic line]",
        truncated: false,
        redactedLines: 1,
      },
    },
  });

  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.equal(payload.summary, "code_validate_fast completed with failed validation.");
  assert.equal(payload.output.status, "failed");
  assert.equal(payload.output.validationReceipt.id, "validation-1");
  assert.equal(payload.output.validationReceipt.internalValue, undefined);
  assert.equal(
    payload.output.validationDiagnosticExcerpt.trust,
    "untrusted_sandbox_output",
  );
  assert.match(payload.output.validationDiagnosticExcerpt.stdout, /node:test/iu);
  assert.match(payload.output.validationDiagnosticExcerpt.stderr, /redacted credential/iu);
  assert.doesNotMatch(serialized, /must-not-cross|private-details/iu);
});

test("code repair cycle payload preserves the host-verified outcome", () => {
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_repair_record_cycle",
    output: {
      version: 1,
      kindName: "code_repair_cycle",
      id: "cycle-1",
      cycle: 1,
      outcome: "repaired",
      validationReceiptId: "validation-1",
      validationFingerprint: `sha256:${"5".repeat(64)}`,
      cycleFingerprint: `sha256:${"6".repeat(64)}`,
      fingerprint: `sha256:${"7".repeat(64)}`,
      internalCheckpoint: "must-not-cross",
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.equal(
    payload.summary,
    "code_repair_record_cycle recorded cycle 1 as repaired.",
  );
  assert.equal(payload.output.outcome, "repaired");
  assert.equal(payload.output.cycle, 1);
  assert.doesNotMatch(serialized, /must-not-cross/iu);
});

test("workspace creation payload preserves only the bounded repository write scope", () => {
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_workspace_create",
    output: {
      workspaceId: "private-workspace-id",
      canonicalRoot: "C:\\private\\worktree",
      repositoryWriteScope: {
        profileKey: "crdt-library",
        projects: [{
          projectId: "root",
          projectRoot: ".",
          allowedPaths: [
            "README.md",
            "crdt_sync.py",
            "docs",
            "pyproject.toml",
            "src",
          ],
          privateControl: "must-not-cross",
        }],
        credentialReferenceId: "must-not-cross",
      },
    },
  });

  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.deepEqual(payload.output.repositoryWriteScope, {
    profileKey: "crdt-library",
    projects: [{
      projectId: "root",
      projectRoot: ".",
      allowedPaths: [
        "README.md",
        "crdt_sync.py",
        "docs",
        "pyproject.toml",
        "src",
      ],
    }],
    truncated: false,
    totalProjects: 1,
    totalAllowedPaths: 5,
  });
  assert.doesNotMatch(
    serialized,
    /private-workspace-id|C:\\\\private|must-not-cross/iu,
  );
});

test("known-folder export payload preserves the verified absolute destination", () => {
  const destinationPath =
    "C:\\Users\\example\\OneDrive\\Desktop\\number-guessing-game-run123";
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_workspace_export_directory",
    output: {
      status: "ok",
      operation: "export_directory",
      workspaceId: "workspace-1",
      sourcePath: "",
      destinationRoot: "desktop",
      destinationPath,
      files: 1,
      directories: 0,
      bytesWritten: 512,
      fingerprint: `sha256:${"8".repeat(64)}`,
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.equal(payload.output.destinationRoot, "desktop");
  assert.equal(payload.output.destinationPath, destinationPath);
  assert.doesNotMatch(serialized, /workspace-1/u);
});

test("read_current_file model payload keeps full note content for edit missions", () => {
  const body = `${"Paragraph about Holden. ".repeat(400)}TAIL_MARKER_END`;
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "read_current_file",
    output: {
      path: "Essays/catcher.md",
      content: body,
      totalChars: body.length,
      returnedChars: body.length,
      offset: 0,
      truncated: false,
      nextOffset: null,
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.equal(payload.output.path, "Essays/catcher.md");
  assert.equal(payload.output.content, body);
  assert.equal(payload.output.contentEvidence, undefined);
  assert.match(payload.output.content, /TAIL_MARKER_END/);
});

test("sandbox status payload preserves the execution answer the model asked for", () => {
  // The generic whitelist matched none of this tool's keys, so a successful
  // status check reached the model as bare success with no output -- and the
  // model re-called it in a loop hoping for the state.
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "code_sandbox_status",
    output: {
      version: 1,
      mode: "sandbox_verified",
      executionAvailable: true,
      editingAvailable: true,
      selectedProvider: "wsl2",
      providers: [
        {
          provider: "wsl2",
          state: "verified",
          diagnostic: "Boundary probe passed.",
          probeFingerprint: `sha256:${"5".repeat(64)}`,
          checkedAt: "2026-08-24T00:00:00.000Z",
        },
        {
          provider: "docker",
          state: "unprobed",
          diagnostic: "Boundary probe has not run.",
          probeFingerprint: null,
          checkedAt: null,
        },
      ],
      blocker: null,
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.equal(payload.output.mode, "sandbox_verified");
  assert.equal(payload.output.executionAvailable, true);
  assert.equal(payload.output.selectedProvider, "wsl2");
  assert.equal(payload.output.blocker, null);
  assert.equal(payload.output.providers.length, 2);
  assert.equal(payload.output.providers[0].provider, "wsl2");
  assert.equal(payload.output.providers[0].state, "verified");
  // Nothing was withheld, so the payload must not claim truncation: the old
  // length-comparison heuristic flagged every slimmed result as truncated
  // and the model could not tell "re-read" from "that is everything".
  assert.equal(payload.truncated, false);
  assert.doesNotMatch(serialized, /probeFingerprint/u);
});

test("linear issue payload survives the host issue-binding round trip", async () => {
  const { findNestedLinearIssueRecord } = await import(
    "../src/agent/linearIssueBinding"
  );
  const description = `## Contract\n${"specification line\n".repeat(30)}`;
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "linear_get_issue",
    output: {
      id: "dc62477e-19bf-48ec-8331-16648e6c747f",
      identifier: "APP-410",
      title: "Dependency-Free Python CRDT Library",
      url: "https://linear.app/example/issue/APP-410/crdt",
      state: { name: "Todo", type: "unstarted", internalOrder: 3 },
      description,
      internalTeamPayload: "must-not-cross",
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  // The description is the mission's product specification; losing it left
  // the model implementing from a title alone.
  assert.equal(payload.output.description, description);
  assert.equal(payload.output.state.name, "Todo");
  assert.equal(payload.output.state.internalOrder, undefined);
  assert.ok(payload.omittedKeys.includes("internalTeamPayload"));
  // The host re-parses this very message to bind the issue identity; the
  // slimmed payload must still satisfy the agent-side record contract.
  const record = findNestedLinearIssueRecord(payload.output, 0);
  assert.ok(record);
  assert.equal(record!.identifier, "APP-410");
  assert.equal(record!.id, "dc62477e-19bf-48ec-8331-16648e6c747f");
});

test("oversized linear description truncates honestly instead of vanishing", () => {
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "linear_get_issue",
    output: {
      id: "dc62477e-19bf-48ec-8331-16648e6c747f",
      identifier: "APP-410",
      title: "Dependency-Free Python CRDT Library",
      url: "https://linear.app/example/issue/APP-410/crdt",
      description: "x".repeat(6000),
    },
  });
  const payload = JSON.parse(serialized) as Record<string, any>;
  assert.ok(payload.output.description.length <= 4100);
  assert.equal(payload.output.descriptionTruncated, true);
  assert.equal(payload.truncated, true);
});

const LINEAR_ISSUE_FIXTURE_IDENTITY = {
  id: "dc62477e-19bf-48ec-8331-16648e6c747f",
  identifier: "APP-410",
  title: "Dependency-Free Python CRDT Library",
  url: "https://linear.app/example/issue/APP-410/crdt",
};

function serializeLinearIssueDescription(description: string): Record<string, any> {
  const serialized = serializeToolResultForModel({
    ok: true,
    toolName: "linear_get_issue",
    output: { ...LINEAR_ISSUE_FIXTURE_IDENTITY, description },
  });
  return JSON.parse(serialized) as Record<string, any>;
}

test("oversized linear description preserves the trailing signed contract byte-for-byte", () => {
  // The mission treats the trailing fenced json block as the sole product
  // specification. Tonight's live clip cut mid-acceptance-criterion and
  // dropped the whole contract, forcing the model to reconstruct requirements
  // from fragments. The prose before the contract is clipped instead.
  const contract =
    "```json\n" +
    JSON.stringify(
      {
        workItem: "APP-410",
        acceptanceCriteria: [
          "GCounter merge is commutative, associative, idempotent",
          "ORSet supports concurrent add/remove with add-wins semantics",
        ],
        validationRequirementKeys: ["python-unittest"],
      },
      null,
      2,
    ) +
    "\n```\n";
  const earlyBlock = "```json\n{\"context\": \"an earlier block that is NOT the contract\"}\n```\n";
  const description =
    `## Requirements\n${earlyBlock}${"requirement line\n".repeat(400)}${contract}`;
  assert.ok(description.length > 4000);
  const payload = serializeLinearIssueDescription(description);
  // The trailing contract survives byte-for-byte (last fenced json block wins).
  assert.ok(payload.output.description.endsWith(contract));
  // The clip is explicit, honest, and placed before the preserved block.
  assert.ok(
    payload.output.description.includes(
      "[... description clipped; full text in Linear ...]",
    ),
  );
  assert.ok(payload.output.description.startsWith("## Requirements\n"));
  assert.equal(payload.output.descriptionTruncated, true);
  assert.equal(payload.truncated, true);
});

test("under-cap linear description with a contract block is untouched", () => {
  const description =
    "Short prose.\n\n```json\n{\"workItem\": \"APP-410\"}\n```\n";
  const payload = serializeLinearIssueDescription(description);
  assert.equal(payload.output.description, description);
  assert.equal(payload.output.descriptionTruncated, undefined);
});

test("oversized linear description without a fenced json block keeps the legacy clip byte-for-byte", () => {
  const description = "x".repeat(6000);
  const payload = serializeLinearIssueDescription(description);
  assert.equal(
    payload.output.description,
    `${"x".repeat(4000)}\n\n[truncated]`,
  );
  assert.equal(payload.output.descriptionTruncated, true);
});

test("prose after the trailing contract rides along inside the preserved tail", () => {
  // Pinned behavior for a contract block that is near, but not exactly at,
  // the end: the preserved tail runs from the last fenced json block to the
  // end, so short acceptance notes after the contract are not clipped out
  // from under it.
  const contract = "```json\n{\"workItem\": \"APP-410\"}\n```";
  const trailingProse = "\n\nAcceptance notes after the contract apply.\n";
  const description = `${"p".repeat(6000)}${contract}${trailingProse}`;
  const payload = serializeLinearIssueDescription(description);
  assert.ok(payload.output.description.endsWith(`${contract}${trailingProse}`));
  assert.ok(
    payload.output.description.includes(
      "[... description clipped; full text in Linear ...]",
    ),
  );
  assert.equal(payload.output.descriptionTruncated, true);
});

test("a pathologically large contract tail falls back to the legacy clip", () => {
  const contract = `\`\`\`json\n{"blob": "${"9".repeat(13000)}"}\n\`\`\``;
  const description = `${"p".repeat(5000)}${contract}`;
  const payload = serializeLinearIssueDescription(description);
  assert.equal(
    payload.output.description,
    `${description.slice(0, 4000)}\n\n[truncated]`,
  );
  assert.equal(payload.output.descriptionTruncated, true);
});

test("an unterminated trailing json fence keeps the legacy clip", () => {
  const description = `${"p".repeat(6000)}\`\`\`json\n{"open": true}\n`;
  const payload = serializeLinearIssueDescription(description);
  assert.equal(
    payload.output.description,
    `${description.slice(0, 4000)}\n\n[truncated]`,
  );
  assert.equal(payload.output.descriptionTruncated, true);
});
