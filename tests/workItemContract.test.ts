import assert from "node:assert/strict";
import test from "node:test";

import { sha256Text } from "../src/agent/queue/fingerprint";
import {
  createLinearIntegrationState,
  parseLinearIntegrationState,
  recordLinearIntegrationFailure,
  recordLinearIntegrationSuccess,
} from "../src/integrations/linear/LinearIntegrationState";
import {
  parseRenderedWorkItemSpecV1,
} from "../src/integrations/linear/WorkItemParser";
import {
  renderWorkItemSpecV1,
  WORK_ITEM_CONTRACT_END,
} from "../src/integrations/linear/WorkItemRenderer";
import {
  createWorkItemSpecV1,
  parseWorkItemSpecV1,
  verifyWorkItemSpecV1,
  type WorkItemSpecV1Unsigned,
} from "../src/integrations/linear/WorkItemSpecV1";

const UNSIGNED: WorkItemSpecV1Unsigned = {
  schemaVersion: 1,
  ready: true,
  executionClass: "code",
  objective: "Add a resumable Linear execution queue.",
  repositoryKey: "research-agent",
  acceptanceCriteria: [
    { id: "AC-1", text: "Queue state survives a plugin restart." },
    { id: "AC-2", text: "Expired leases can be recovered without double execution." },
  ],
  validationRequirements: ["npm test", "npm run build"],
  evidenceRefs: ["https://linear.app/acme/issue/ENG-42"],
  riskClass: "medium",
  originRunId: "run-2026-07-11",
  generation: 0,
};

test("canonical SHA-256 implementation matches the standard test vector", () => {
  assert.equal(
    sha256Text("abc"),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("work item creation fingerprints the exact strict v1 contract", () => {
  const spec = createWorkItemSpecV1(UNSIGNED);
  assert.match(spec.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(parseWorkItemSpecV1(JSON.parse(JSON.stringify(spec))), spec);
  assert.equal(verifyWorkItemSpecV1(spec), true);

  const reordered = createWorkItemSpecV1({
    generation: 0,
    originRunId: "run-2026-07-11",
    riskClass: "medium",
    evidenceRefs: ["https://linear.app/acme/issue/ENG-42"],
    validationRequirements: ["npm test", "npm run build"],
    acceptanceCriteria: [
      { text: "Queue state survives a plugin restart.", id: "AC-1" },
      { text: "Expired leases can be recovered without double execution.", id: "AC-2" },
    ],
    repositoryKey: "research-agent",
    objective: "Add a resumable Linear execution queue.",
    executionClass: "code",
    ready: true,
    schemaVersion: 1,
  });
  assert.equal(reordered.fingerprint, spec.fingerprint);
});

test("rendered Linear descriptions round-trip through the machine contract", () => {
  const spec = createWorkItemSpecV1(UNSIGNED);
  const markdown = renderWorkItemSpecV1(spec, {
    problemImpact: "Duplicate execution could corrupt an autonomous coding run.",
    confidenceLimitations: "The queue is deterministic; remote webhook delivery is out of scope.",
    proposedWork: ["Persist a revisioned queue and expiring leases."],
    nonGoals: ["Automatic pull-request merging."],
    scope: ["Linear issue ingestion and queue state."],
    dependencies: ["A configured Linear workspace."],
  });
  const parsed = parseRenderedWorkItemSpecV1(markdown);
  assert.deepEqual(parsed.spec, spec);
  assert.match(markdown, /## Problem \/ impact/);
  assert.match(markdown, /## Confidence \/ limitations/);
  assert.match(markdown, /## Proposed work \/ non-goals/);
  assert.match(markdown, /## Scope \/ dependencies/);
  assert.match(markdown, /## Acceptance criteria/);
  assert.match(markdown, /- \[ \] \*\*AC-1\*\*/);
  assert.ok(markdown.endsWith(WORK_ITEM_CONTRACT_END));
});

test("tampering, unknown fields, duplicate markers, and unsafe readiness fail closed", () => {
  const spec = createWorkItemSpecV1(UNSIGNED);
  const tampered = {
    ...spec,
    objective: "Execute an unrelated objective.",
  };
  assert.throws(() => parseWorkItemSpecV1(tampered), /fingerprint/i);
  assert.throws(
    () => parseWorkItemSpecV1({ ...spec, unexpected: true }),
    /unknown: unexpected/i,
  );
  assert.throws(
    () => createWorkItemSpecV1({ ...UNSIGNED, repositoryKey: undefined }),
    /repository key/i,
  );
  assert.throws(
    () => createWorkItemSpecV1({ ...UNSIGNED, ready: false as true }),
    /literal true/i,
  );
  assert.throws(
    () =>
      createWorkItemSpecV1({
        ...UNSIGNED,
        acceptanceCriteria: [{ id: "criterion-1", text: "Invalid id." }],
      }),
    /AC-1 through AC-99/i,
  );
  assert.throws(
    () => parseRenderedWorkItemSpecV1(`${renderWorkItemSpecV1(spec)}\n${WORK_ITEM_CONTRACT_END}`),
    /exactly one complete/i,
  );
});

test("Linear integration metadata is strict, secret-free, and monotonic", () => {
  const fingerprint = `sha256:${"a".repeat(64)}`;
  const initial = createLinearIntegrationState({
    at: "2026-07-11T12:00:00.000Z",
    configFingerprint: fingerprint,
  });
  const failed = recordLinearIntegrationFailure(initial, {
    at: "2026-07-11T12:01:00.000Z",
    code: "linear_timeout",
    message: "Linear request timed out.",
    retryable: true,
    operationId: "operation-1",
  });
  const recovered = recordLinearIntegrationSuccess(failed, {
    at: "2026-07-11T12:02:00.000Z",
    workspaceId: "workspace-1",
    operationId: "operation-1",
    reconciled: true,
  });
  assert.equal(recovered.lastError, null);
  assert.equal(recovered.lastReconciledAt, "2026-07-11T12:02:00.000Z");
  assert.deepEqual(parseLinearIntegrationState(JSON.parse(JSON.stringify(recovered))), recovered);
  assert.equal("apiKey" in recovered, false);
  assert.throws(
    () => recordLinearIntegrationSuccess(recovered, { at: "2026-07-11T11:00:00.000Z" }),
    /backwards/i,
  );
});
