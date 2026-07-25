import assert from "node:assert/strict";
import test from "node:test";

import type {
  ExtensionRegistrationTokenV1,
  MissionVerifierContributionV1,
  MissionVerifierInputV1,
  MissionVerifierResultV1,
  RegisteredContributionV1,
} from "../packages/core-api/src";
import { runExtensionVerifiers } from "../src/agent/extensionVerifiers";

function token(extensionId: string, aborted = false): ExtensionRegistrationTokenV1 {
  const controller = new AbortController();
  if (aborted) controller.abort();
  return {
    version: 1,
    id: `token-${extensionId}`,
    extensionId,
    apiMajor: 1 as never,
    apiMinor: 0 as never,
    issuedAt: "2026-07-24T00:00:00.000Z",
    signal: controller.signal,
  };
}

function registered(
  extensionId: string,
  verify: MissionVerifierContributionV1["verify"],
  options: { aborted?: boolean } = {},
): RegisteredContributionV1<MissionVerifierContributionV1> {
  return {
    extensionId,
    token: token(extensionId, options.aborted),
    contribution: {
      descriptor: {
        id: `${extensionId}-verifier`,
        kind: "mission_verifier",
        displayName: `${extensionId} verifier`,
      } as never,
      verify,
    },
  };
}

const INPUT: MissionVerifierInputV1 = {
  missionId: "mission-1",
  nodeId: "mission-1:verify",
  objective: "Summarize the topic with sources.",
  outputs: {},
  evidence: [],
  receiptIds: [],
};

const ACTIVE = { isTokenActive: () => true };

test("verifier results map onto verification checks with bounded fields", async () => {
  const result: MissionVerifierResultV1 = {
    status: "needs_more_work",
    message: "Two claims lack citations.",
    missing: ["claim 1 citation", "claim 2 citation"],
    evidenceIds: ["evidence-1"],
    receiptIds: ["receipt-1"],
  };
  const checks = await runExtensionVerifiers(
    { verifiers: [registered("quality-ext", async () => result)] },
    INPUT,
    { ...ACTIVE, now: () => new Date(0) },
  );
  assert.equal(checks.length, 1);
  const check = checks[0]!;
  assert.equal(check.kind, "extension");
  assert.equal(check.status, "needs_more_work");
  assert.equal(check.id, "extension:quality-ext:quality-ext-verifier");
  assert.equal(check.targetNodeId, "mission-1:verify");
  assert.deepEqual(check.missing, ["claim 1 citation", "claim 2 citation"]);
  assert.deepEqual(check.evidenceIds, ["evidence-1"]);
  assert.deepEqual(check.receiptIds, ["receipt-1"]);
});

test("a throwing verifier fails closed as blocked instead of being skipped", async () => {
  const checks = await runExtensionVerifiers(
    {
      verifiers: [
        registered("broken-ext", async () => {
          throw new Error("verifier exploded");
        }),
      ],
    },
    INPUT,
    ACTIVE,
  );
  assert.equal(checks[0]!.status, "blocked");
  assert.match(checks[0]!.missing[0] ?? "", /verifier exploded/u);
});

test("a hanging verifier times out to blocked", async () => {
  const checks = await runExtensionVerifiers(
    {
      verifiers: [
        registered("slow-ext", () => new Promise<never>(() => {})),
      ],
    },
    INPUT,
    { ...ACTIVE, timeoutMs: 1_000 },
  );
  assert.equal(checks[0]!.status, "blocked");
  assert.match(checks[0]!.missing[0] ?? "", /timed out/u);
});

test("revoked or unloaded verifiers are blocked, never bypassed", async () => {
  const revoked = await runExtensionVerifiers(
    {
      verifiers: [
        registered("gone-ext", async () => ({
          status: "pass",
          message: "should never run",
          missing: [],
          evidenceIds: [],
          receiptIds: [],
        })),
      ],
    },
    INPUT,
    { isTokenActive: () => false },
  );
  assert.equal(revoked[0]!.status, "blocked");

  const aborted = await runExtensionVerifiers(
    {
      verifiers: [
        registered(
          "aborted-ext",
          async () => ({
            status: "pass",
            message: "should never run",
            missing: [],
            evidenceIds: [],
            receiptIds: [],
          }),
          { aborted: true },
        ),
      ],
    },
    INPUT,
    ACTIVE,
  );
  assert.equal(aborted[0]!.status, "blocked");
});

test("multiple verifiers all run and passes stay passes", async () => {
  const pass: MissionVerifierResultV1 = {
    status: "pass",
    message: "All checks passed.",
    missing: [],
    evidenceIds: [],
    receiptIds: [],
  };
  const checks = await runExtensionVerifiers(
    {
      verifiers: [
        registered("first-ext", async () => pass),
        registered("second-ext", async () => pass),
      ],
    },
    INPUT,
    ACTIVE,
  );
  assert.deepEqual(
    checks.map((check) => check.status),
    ["pass", "pass"],
  );
});
