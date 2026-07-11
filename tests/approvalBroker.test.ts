import test from "node:test";
import assert from "node:assert/strict";
import {
  ApprovalBroker,
  type ApprovalRequest,
} from "../src/agent/approvalBroker";
import { withPreparedActionFingerprint } from "../src/agent/actions";

test("approval broker resolves an approved request", async () => {
  const broker = new ApprovalBroker();
  let requestId = "";
  const promise = broker.request(
    {
      runId: "run-1",
      toolName: "browser_click",
      action: "click",
      reason: "high risk",
      policyTags: ["high_risk_click"],
    },
    {
      timeoutMs: 1000,
      onRequest: (request) => {
        requestId = request.id;
      },
    },
  );

  assert.equal(broker.resolve(requestId, "approved"), true);
  assert.equal(await promise, "approved");
  assert.deepEqual(broker.getPending(), []);
});

test("approval broker expires unresolved requests", async () => {
  const broker = new ApprovalBroker();
  const decision = await broker.request(
    {
      runId: "run-1",
      toolName: "run_code_block",
      action: "long run",
      reason: "timeout",
      policyTags: ["long_code_timeout"],
    },
    { timeoutMs: 1 },
  );

  assert.equal(decision, "expired");
});

test("approval cannot settle before async request persistence completes", async () => {
  const broker = new ApprovalBroker();
  let releasePersistence!: () => void;
  const persistence = new Promise<void>((resolve) => {
    releasePersistence = resolve;
  });
  let requestId = "";
  let settled = false;

  const decisionPromise = broker.request(
    {
      runId: "run-durable-approval",
      toolName: "install_code_dependency",
      action: "install package",
      reason: "Dependency installation changes the environment.",
      policyTags: ["dependency_install"],
    },
    {
      onRequest: async (request) => {
        requestId = request.id;
        await persistence;
      },
    },
  );
  decisionPromise.then(() => {
    settled = true;
  });

  await Promise.resolve();
  assert.ok(requestId);
  assert.equal(broker.resolve(requestId, "approved"), true);
  await Promise.resolve();
  assert.equal(settled, false);

  releasePersistence();
  assert.equal(await decisionPromise, "approved");
  assert.equal(settled, true);
});

test("approval broker deep-clones exact prepared payloads", async () => {
  const broker = new ApprovalBroker();
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "linear_create_issue",
    target: {
      system: "linear",
      resourceType: "issue",
      id: "new:call-1",
      teamId: "team-1",
    },
    relatedResources: [],
    normalizedArgs: { title: "Ticket" },
    preview: {
      summary: "Create issue",
      destination: "Linear team team-1",
      warnings: [],
      outboundBytes: 6,
    },
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
  let callbackRequest!: ApprovalRequest;
  const decisionPromise = broker.request(
    {
      runId: "run-1",
      toolName: "linear_create_issue",
      action: "create issue",
      reason: "external mutation",
      policyTags: ["exact_payload_approval"],
      preparedAction: action,
      requiredConfirmations: 1,
    },
    {
      timeoutMs: 1000,
      onRequest: (request) => {
        callbackRequest = request;
      },
    },
  );

  assert.ok(callbackRequest);
  callbackRequest.policyTags.push("mutated-callback");
  callbackRequest.preparedAction!.target.id = "changed-in-callback";
  action.target.id = "changed-by-caller";

  const stored = broker.getPending()[0];
  assert.deepEqual(stored.policyTags, ["exact_payload_approval"]);
  assert.equal(stored.preparedAction?.target.id, "new:call-1");
  assert.equal(stored.payloadFingerprint, stored.preparedAction?.payloadFingerprint);
  assert.equal(broker.resolve(stored.id, "approved"), true);
  assert.equal(await decisionPromise, "approved");
});

test("approval broker rejects a mismatched payload fingerprint", async () => {
  const action = await withPreparedActionFingerprint({
    version: 1,
    id: "action-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "linear_create_issue",
    target: { system: "linear", resourceType: "issue", id: "new:call-1" },
    relatedResources: [],
    normalizedArgs: {},
    preview: {
      summary: "Create issue",
      destination: "Linear",
      warnings: [],
      outboundBytes: 0,
    },
    preparedAt: "2026-07-11T12:00:00.000Z",
    expiresAt: "2026-07-11T12:05:00.000Z",
  });
  const broker = new ApprovalBroker();

  await assert.rejects(
    broker.request({
      runId: "run-1",
      toolName: "linear_create_issue",
      action: "create issue",
      reason: "external mutation",
      policyTags: ["exact_payload_approval"],
      preparedAction: action,
      payloadFingerprint: "sha256:different",
    }),
    /fingerprint does not match/,
  );
  assert.deepEqual(broker.getPending(), []);
});
