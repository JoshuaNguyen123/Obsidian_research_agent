import assert from "node:assert/strict";
import test from "node:test";
import { formatApprovalCardModelV1 } from "../src/ui/approvalCardModel";
import {
  buildBundledApprovalPreview,
  bundledPreviewToApprovalRequest,
} from "../src/agent/bundledApprovalPreview";
import type { ApprovalRequest } from "../src/agent/approvalBroker";
import type { PreparedAction } from "../src/agent/actions";

function preparedAction(
  overrides: Partial<PreparedAction["preview"]> = {},
): PreparedAction {
  return {
    version: 1,
    id: "prep-1",
    runId: "run-1",
    toolCallId: "call-1",
    toolName: "replace_current_file",
    target: {
      system: "vault",
      resourceType: "markdown",
      id: "Notes/Draft.md",
      identifier: "Notes/Draft.md",
    },
    relatedResources: [],
    normalizedArgs: {},
    preview: {
      summary: "Replace the whole note with the revised draft.",
      destination: "Notes/Draft.md",
      warnings: [],
      outboundBytes: 2048,
      ...overrides,
    },
    payloadFingerprint: `sha256:${"d".repeat(64)}`,
    preparedAt: "2026-07-31T12:00:00.000Z",
    expiresAt: "2026-07-31T12:05:00.000Z",
  } as PreparedAction;
}

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    id: "approval-1",
    runId: "run-1",
    toolName: "replace_current_file",
    action: "replace",
    reason: "Whole-note replacement needs your approval.",
    policyTags: ["bound_write"],
    expiresAtMs: 0,
    preparedAction: preparedAction(),
    ...overrides,
  };
}

test("the card model composes every asserted string byte-identically", () => {
  const model = formatApprovalCardModelV1(request());
  assert.equal(model.title, "replace_current_file: replace");
  assert.equal(model.policyLine, "policy=bound_write");
  assert.equal(model.approveLabel, "Approve");
  assert.equal(model.denyLabel, "Deny");
  assert.ok(model.preview);
  assert.equal(model.preview.destination, "Notes/Draft.md");
  assert.equal(
    model.preview.targetLine,
    "target=vault:markdown Notes/Draft.md",
  );
  // The research lane e2e asserts this exact prefix; changing the format is a
  // breaking change to the fixtures.
  // 24 chars of the fingerprint survive: "sha256:" (7) + 17 hex chars.
  assert.match(model.preview.fingerprintLine, /^fingerprint=sha256:d{17}…/u);
  assert.match(model.preview.fingerprintLine, / outbound=2048B confirmation=1\/1$/u);
});

test("empty policy tags fall back to approval_required", () => {
  const model = formatApprovalCardModelV1(request({ policyTags: [] }));
  assert.equal(model.policyLine, "policy=approval_required");
});

test("two-step deletion escalates the approve label per confirmation", () => {
  const first = formatApprovalCardModelV1(
    request({ requiredConfirmations: 2, confirmationIndex: 1 }),
  );
  assert.equal(first.approveLabel, "Approve deletion");
  const second = formatApprovalCardModelV1(
    request({ requiredConfirmations: 2, confirmationIndex: 2 }),
  );
  assert.equal(second.approveLabel, "Confirm permanent delete");
  assert.match(second.preview?.fingerprintLine ?? "", /confirmation=2\/2$/u);
});

test("a request with no prepared action renders title and reason only", () => {
  const model = formatApprovalCardModelV1(
    request({ preparedAction: undefined }),
  );
  assert.equal(model.preview, null);
  assert.ok(model.title.length > 0);
  assert.ok(model.reason.length > 0);
});

test("diff, payload, duplicates, and warnings are surfaced when present", () => {
  const model = formatApprovalCardModelV1(
    request({
      preparedAction: preparedAction({
        before: { title: "Old" },
        after: { title: "New" },
        outboundPayload: { title: "New" },
        duplicateCandidates: [
          {
            system: "linear",
            resourceType: "issue",
            id: "issue-1",
            identifier: "APP-12",
            url: "https://linear.app/issue/APP-12",
          },
        ],
        warnings: ["Existing issue looks similar."],
      }),
    }),
  );
  assert.ok(model.preview?.diffJson?.includes('"before"'));
  assert.ok(model.preview?.diffJson?.includes('"after"'));
  assert.ok(model.preview?.outboundPayloadJson?.includes('"title": "New"'));
  assert.deepEqual(model.preview?.duplicateLines, [
    "APP-12 — https://linear.app/issue/APP-12",
  ]);
  assert.deepEqual(model.preview?.warningLines, [
    "warning=Existing issue looks similar.",
  ]);
});

test("a bundled compound preview request produces a coherent card", async () => {
  // The bundled preview is the one approval that grants a whole Bound stage;
  // its card must carry the bundle fingerprint in the policy line so the
  // grant is auditable from the card alone.
  const preview = await buildBundledApprovalPreview({
    runId: "run-bundle-1",
    stages: ["accepted_research", "linear_hierarchy"],
    toolNames: ["publish_research_to_linear", "linear_create_issue"],
    now: new Date("2026-07-31T12:00:00.000Z"),
  });
  const bundled: ApprovalRequest = {
    ...bundledPreviewToApprovalRequest(preview),
    id: "approval-bundle",
    expiresAtMs: 0,
  };
  const model = formatApprovalCardModelV1(bundled);
  assert.match(model.title, /^bundled_compound_bound_preview: /u);
  assert.match(model.policyLine, /bundled_approval_preview/u);
  assert.match(model.policyLine, new RegExp(`bundle:${preview.bundleFingerprint}`, "u"));
  assert.equal(model.preview, null);
  assert.equal(model.approveLabel, "Approve");
});
