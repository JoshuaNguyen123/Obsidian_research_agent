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
