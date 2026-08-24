import assert from "node:assert/strict";
import test from "node:test";

import {
  findUnbackedGraphClaimsV1,
  isGraphClaimBackedV1,
  type GraphClaimV1,
  type ObservedExecutionLinkageV1,
} from "../e2e/fixtures/graphRuntimeLinkage";

const READ_FINGERPRINT = `sha256:${"a".repeat(64)}`;
const OTHER_FINGERPRINT = `sha256:${"b".repeat(64)}`;

function evidenceClaim(overrides: Partial<GraphClaimV1> = {}): GraphClaimV1 {
  return {
    nodeId: "tool-02-linear_get_issue",
    toolName: "linear_get_issue",
    claimKind: "evidence",
    id: "evidence:2:tool-02-linear_get_issue",
    fingerprint: READ_FINGERPRINT,
    ...overrides,
  };
}

function receiptClaim(overrides: Partial<GraphClaimV1> = {}): GraphClaimV1 {
  return {
    nodeId: "tool-11-code_commit_verified",
    toolName: "code_commit_verified",
    claimKind: "receipt",
    id: "receipt-commit-1",
    fingerprint: OTHER_FINGERPRINT,
    ...overrides,
  };
}

test("a graph evidence claim no execution produced is reported", () => {
  // The whole point of the check: the graph must not be able to invent work.
  // A fabricated claim has no observed execution behind it.
  const unbacked = findUnbackedGraphClaimsV1(
    [evidenceClaim({ fingerprint: OTHER_FINGERPRINT })],
    [
      {
        name: "linear_get_issue",
        descriptorEffect: "read",
        evidenceId: null,
        evidenceFingerprint: READ_FINGERPRINT,
      },
    ],
  );
  assert.equal(unbacked.length, 1);
  assert.equal(unbacked[0]?.claimKind, "evidence");
});

test("a graph evidence claim a real execution produced is accepted", () => {
  assert.deepEqual(
    findUnbackedGraphClaimsV1(
      [evidenceClaim()],
      [
        {
          name: "linear_get_issue",
          descriptorEffect: "read",
          evidenceId: "evidence:2:tool-02-linear_get_issue",
          evidenceFingerprint: READ_FINGERPRINT,
        },
      ],
    ),
    [],
  );
});

test("an execution the graph never recorded is not a violation", () => {
  // This is the inversion. The runner may execute a Soft companion with
  // missionGraphExecution = null and write no evidence at all, so an observed
  // execution with no matching claim is expected, not a failure. The forward
  // form of this check died on exactly that: a third linear_get_issue re-read
  // with a real fingerprint, evidenceId null, and no node anywhere.
  const observed: ObservedExecutionLinkageV1[] = [
    {
      name: "linear_get_issue",
      sequence: 12,
      descriptorEffect: "read",
      evidenceId: "evidence:2:tool-02-linear_get_issue",
      evidenceFingerprint: READ_FINGERPRINT,
    },
    {
      name: "linear_get_issue",
      sequence: 45,
      descriptorEffect: "read",
      evidenceId: null,
      evidenceFingerprint: OTHER_FINGERPRINT,
    },
  ];
  assert.deepEqual(findUnbackedGraphClaimsV1([evidenceClaim()], observed), []);
});

test("an evidence id the graph does not claim cannot back its claim", () => {
  // Fingerprint alone is not enough when the execution names its evidence: a
  // matching hash under a different id is a different record.
  assert.equal(
    isGraphClaimBackedV1(evidenceClaim(), [
      {
        name: "linear_get_issue",
        descriptorEffect: "read",
        evidenceId: "evidence:9:some-other-node",
        evidenceFingerprint: READ_FINGERPRINT,
      },
    ]),
    false,
  );
});

test("a receipt claim needs an execution whose receipt read back verified", () => {
  const unverified: ObservedExecutionLinkageV1[] = [
    {
      name: "code_commit_verified",
      descriptorEffect: "reversible_mutation",
      receiptId: "receipt-commit-1",
      receiptReadbackStatus: "pending",
    },
  ];
  assert.equal(findUnbackedGraphClaimsV1([receiptClaim()], unverified).length, 1);

  const verified: ObservedExecutionLinkageV1[] = [
    {
      name: "code_commit_verified",
      descriptorEffect: "reversible_mutation",
      receiptId: "receipt-commit-1",
      receiptReadbackStatus: "verified",
    },
  ];
  assert.deepEqual(findUnbackedGraphClaimsV1([receiptClaim()], verified), []);
});

test("an empty observed journal cannot discharge any claim", () => {
  // The minimumEvents floor is asserted separately in the lane; this pins the
  // other half, that claims are not vacuously satisfied by an empty journal.
  assert.equal(
    findUnbackedGraphClaimsV1([evidenceClaim(), receiptClaim()], []).length,
    2,
  );
});
