import test from "node:test";
import assert from "node:assert/strict";
import {
  withPreparedActionFingerprint,
  type PreparedAction,
  type ToolDescriptor,
} from "../src/agent/actions";
import {
  createOneShotGrant,
  descriptorAllowsPromptIssuedGrantV1,
} from "../src/agent/authority";
import {
  descriptorAllowsWriteAutonomyPromptGrantV1,
  evaluateActionPolicy,
  isPromptDerivedAuthorityGrantV1,
} from "../src/agent/policyEngine";
import { preparedApprovalMayAutoWithoutCardV1 } from "../src/agent/setLooseCompoundAutonomy";
import { createJupyterReflectionTool } from "../src/tools/jupyterReflectionTool";
import { createProjectResultsTool } from "../src/tools/projectResultsTool";

/**
 * These tests bind to the descriptors the product actually ships. Copying an
 * approval block into a fixture here would let the descriptor drift away from
 * the policy that is supposed to honour it, which is precisely the failure
 * mode this file exists to catch.
 */
function shippedDescriptor(tool: { descriptor?: ToolDescriptor }): ToolDescriptor {
  assert.ok(tool.descriptor, "tool must publish a descriptor");
  return tool.descriptor;
}

const JUPYTER_DESCRIPTOR = shippedDescriptor(createJupyterReflectionTool());
const PROJECT_RESULTS_DESCRIPTOR = shippedDescriptor(createProjectResultsTool());

async function preparedActionFor(
  descriptor: ToolDescriptor,
): Promise<PreparedAction> {
  return withPreparedActionFingerprint({
    version: 1,
    id: `action:${descriptor.name}`,
    runId: "run-1",
    toolCallId: "call-1",
    toolName: descriptor.name,
    target: {
      system: descriptor.capability.system,
      resourceType: descriptor.capability.resourceType,
      id: "Results/reflection.ipynb",
    },
    relatedResources: [],
    normalizedArgs: { markdown: "Reflection" },
    preview: {
      summary: `Write ${descriptor.name}`,
      destination: "Vault",
      outboundPayload: { markdown: "Reflection" },
      warnings: [],
      outboundBytes: 10,
    },
    preparedAt: "2026-08-22T12:00:00.000Z",
    expiresAt: "2026-08-22T12:05:00.000Z",
  });
}

function permissiveClone(descriptor: ToolDescriptor): ToolDescriptor {
  return {
    ...descriptor,
    approval: { ...descriptor.approval, allowPromptGrant: true },
  };
}

const NOW = new Date("2026-08-22T12:01:00.000Z");

for (const descriptor of [JUPYTER_DESCRIPTOR, PROJECT_RESULTS_DESCRIPTOR]) {
  test(`${descriptor.name} keeps its exact approval instead of a prompt grant`, async () => {
    // Guard the premise: this test is only meaningful for a descriptor that
    // withholds prompt-derived authority but names an exact fallback.
    assert.equal(descriptor.approval.allowPromptGrant, false);
    assert.equal(descriptor.approval.fallback, "exact");
    assert.equal(descriptor.execution.preparation, "required");

    const action = await preparedActionFor(descriptor);

    // Write autonomy must NOT short-circuit to an allow. Before the fix this
    // returned allow/["write_autonomy","prepared_fingerprint"], and the runner
    // then threw minting a grant the descriptor forbids.
    const decision = evaluateActionPolicy({
      toolName: descriptor.name,
      descriptor,
      preparedAction: action,
      principal: "single_agent",
      scopeAllowed: true,
      isDesktop: true,
      writeAutonomy: true,
      now: NOW,
    });
    assert.equal(decision.action, "require_approval");
    assert.equal(decision.requiredConfirmations, 1);
    assert.equal(decision.payloadFingerprint, action.payloadFingerprint);
    assert.ok(decision.tags.includes("exact_payload_approval"));
    assert.ok(!decision.tags.includes("write_autonomy"));

    // Write autonomy changes nothing for this descriptor: the same card is
    // required with autonomy off, so the approval is not an autonomy artefact.
    const withoutAutonomy = evaluateActionPolicy({
      toolName: descriptor.name,
      descriptor,
      preparedAction: action,
      principal: "single_agent",
      scopeAllowed: true,
      isDesktop: true,
      writeAutonomy: false,
      now: NOW,
    });
    assert.equal(withoutAutonomy.action, "require_approval");
  });

  test(`${descriptor.name} completes once the exact approval is given`, async () => {
    const action = await preparedActionFor(descriptor);

    // This is the mint the runner performs after the approval card returns
    // "approved". It must succeed; before the fix it threw a TypeError and the
    // run died with authority_grant_invalid.
    const grant = await createOneShotGrant({
      id: "grant:approved",
      action,
      descriptor,
      issuedAt: NOW,
    });
    assert.equal(grant.issuer, "user_approval");
    assert.equal(grant.kind, "one_shot");
    assert.equal(isPromptDerivedAuthorityGrantV1(grant), false);

    const granted = evaluateActionPolicy({
      toolName: descriptor.name,
      descriptor,
      preparedAction: action,
      principal: "single_agent",
      scopeAllowed: true,
      isDesktop: true,
      writeAutonomy: false,
      matchingGrant: grant,
      now: NOW,
    });
    assert.equal(granted.action, "allow");
    assert.ok(granted.tags.includes("authority_grant"));
    assert.equal(granted.grantId, grant.id);
  });

  test(`${descriptor.name} still refuses prompt-issued authority`, async () => {
    const action = await preparedActionFor(descriptor);

    await assert.rejects(
      () =>
        createOneShotGrant({
          id: "grant:write-autonomy",
          action,
          descriptor,
          issuer: "user_prompt",
          issuedAt: NOW,
        }),
      /does not permit prompt-issued one-shot grants/,
      "a prompt-derived grant must remain impossible to mint",
    );

    // Even a well-formed prompt-issued grant minted elsewhere must be refused
    // at evaluation, so the boundary is not merely a mint-site formality.
    const smuggled = await createOneShotGrant({
      id: "grant:smuggled",
      action,
      descriptor: permissiveClone(descriptor),
      issuer: "user_prompt",
      issuedAt: NOW,
    });
    assert.equal(isPromptDerivedAuthorityGrantV1(smuggled), true);

    const refused = evaluateActionPolicy({
      toolName: descriptor.name,
      descriptor,
      preparedAction: action,
      principal: "single_agent",
      scopeAllowed: true,
      isDesktop: true,
      writeAutonomy: true,
      matchingGrant: smuggled,
      now: NOW,
    });
    assert.equal(refused.action, "block");
    assert.ok(refused.tags.includes("prompt_grant_disallowed"));
    assert.ok(refused.tags.includes("fail_closed"));
  });
}

test("every prompt-issued authority path reads the same descriptor predicate", async () => {
  // The runner's set-loose bridge, the write-autonomy bridge and the grant mint
  // all gate on descriptorAllowsPromptIssuedGrantV1. Asserting the predicate
  // here — rather than restating `allowPromptGrant === true` in a fixture — is
  // what keeps those three sites from drifting apart again.
  for (const descriptor of [JUPYTER_DESCRIPTOR, PROJECT_RESULTS_DESCRIPTOR]) {
    assert.equal(descriptorAllowsPromptIssuedGrantV1(descriptor), false);
    assert.equal(
      descriptorAllowsWriteAutonomyPromptGrantV1(descriptor),
      false,
      "the write-autonomy bridge must defer to the same predicate",
    );
    const action = await preparedActionFor(descriptor);
    await assert.rejects(
      () =>
        createOneShotGrant({
          id: "grant:set-loose",
          action,
          descriptor,
          issuer: "user_prompt",
          issuedAt: NOW,
        }),
      "the mint must refuse what the bridges decline to ask for",
    );
  }
  assert.equal(
    descriptorAllowsPromptIssuedGrantV1(permissiveClone(JUPYTER_DESCRIPTOR)),
    true,
  );
});

test("the write-autonomy bridge predicate excludes prompt-grant refusers", () => {
  assert.equal(
    descriptorAllowsWriteAutonomyPromptGrantV1(JUPYTER_DESCRIPTOR),
    false,
  );
  assert.equal(
    descriptorAllowsWriteAutonomyPromptGrantV1(PROJECT_RESULTS_DESCRIPTOR),
    false,
  );
  // The ordinary vault-write shape still takes the bridge; this fix narrows the
  // bridge, it does not remove it.
  assert.equal(
    descriptorAllowsWriteAutonomyPromptGrantV1(
      permissiveClone(JUPYTER_DESCRIPTOR),
    ),
    true,
  );
});

test("an ordinary vault mutation still runs under write autonomy", async () => {
  const descriptor = permissiveClone(JUPYTER_DESCRIPTOR);
  const action = await preparedActionFor(descriptor);
  const decision = evaluateActionPolicy({
    toolName: descriptor.name,
    descriptor,
    preparedAction: action,
    principal: "single_agent",
    scopeAllowed: true,
    isDesktop: true,
    writeAutonomy: true,
    now: NOW,
  });
  assert.equal(decision.action, "allow");
  assert.ok(decision.tags.includes("write_autonomy"));
  assert.ok(decision.tags.includes("prepared_fingerprint"));
});

test("the Bound approval gate keeps the card for a prompt-grant refuser", () => {
  // The runner's central Bound gate skips the Chat card under set-loose or a
  // bundled stage grant. For these descriptors that would be prompt-derived
  // authority, and the auto branch resolves an approval on a node that never
  // entered waiting_approval — the run then dies with
  // "Mission node ... is running; expected waiting_approval".
  for (const descriptor of [JUPYTER_DESCRIPTOR, PROJECT_RESULTS_DESCRIPTOR]) {
    assert.equal(
      preparedApprovalMayAutoWithoutCardV1({
        hasPreparedAction: true,
        descriptors: [descriptor, descriptor],
      }),
      false,
      `${descriptor.name} must keep its approval card`,
    );
  }

  // An ordinary prepared descriptor still auto-approves under set-loose.
  assert.equal(
    preparedApprovalMayAutoWithoutCardV1({
      hasPreparedAction: true,
      descriptors: [permissiveClone(JUPYTER_DESCRIPTOR)],
    }),
    true,
  );

  // A mixed pair is refused: the stricter descriptor governs.
  assert.equal(
    preparedApprovalMayAutoWithoutCardV1({
      hasPreparedAction: true,
      descriptors: [permissiveClone(JUPYTER_DESCRIPTOR), JUPYTER_DESCRIPTOR],
    }),
    false,
  );

  // Tools declaring preparation "none" never reached the descriptor-aware
  // policy path, so this gate deliberately leaves them alone.
  assert.equal(
    preparedApprovalMayAutoWithoutCardV1({
      hasPreparedAction: false,
      descriptors: [JUPYTER_DESCRIPTOR],
    }),
    true,
  );

  // An unknown tool name resolves to no descriptor and must not be blocked.
  assert.equal(
    preparedApprovalMayAutoWithoutCardV1({
      hasPreparedAction: true,
      descriptors: [null, undefined],
    }),
    true,
  );
});

test("prompt-derived classification covers every prompt-bound grant kind", () => {
  assert.equal(
    isPromptDerivedAuthorityGrantV1({ kind: "prompt_bound", issuer: "user_approval" }),
    true,
    "prompt_bound is prompt-derived regardless of issuer",
  );
  assert.equal(
    isPromptDerivedAuthorityGrantV1({ kind: "one_shot", issuer: "user_prompt" }),
    true,
  );
  assert.equal(
    isPromptDerivedAuthorityGrantV1({ kind: "one_shot", issuer: "user_approval" }),
    false,
  );
  assert.equal(
    isPromptDerivedAuthorityGrantV1({ kind: "run_bounded", issuer: "user_prompt" }),
    false,
    "bounded grants are governed by allowPersistentGrant, not allowPromptGrant",
  );
});
