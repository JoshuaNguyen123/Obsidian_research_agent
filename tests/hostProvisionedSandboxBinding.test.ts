import test from "node:test";
import assert from "node:assert/strict";

import {
  hostProvisionedSandboxAdoptionDecisionV1,
  readHostProvisionedSandboxBindingV1,
  HOST_PROVISIONED_SANDBOX_VARIABLE_NAMES_V1,
  HOST_PROVISIONED_SANDBOX_READINESS_TIMEOUT_MS_V1,
} from "../extensions/code/sandbox/HostProvisionedSandboxBindingV1";
import {
  WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2,
  type SandboxProviderConfigV2,
} from "../extensions/code/sandbox/SandboxManager";
import { evaluateMissionReadinessPreflightV1 } from "../src/agent/missionReadinessPreflight";
import {
  deliveredHostDirectoryPathV1,
  getRequiredCodeWorkflowToolNames,
  getRoutedCodeWorkflowToolNames,
  missionRequiresSandboxValidationV1,
} from "../src/AgentRunner";
import { buildCapabilityReadinessV2 } from "../src/agent/capabilityReadiness";

const DIGEST = `sha256:${"d".repeat(64)}`;

/** Exactly what scripts/setup-wsl2-sandbox.ps1 persists on a Windows host. */
const PROVISIONED_WSL2_ENV = Object.freeze({
  AGENTIC_SANDBOX_CI_EXECUTABLE: "wsl.exe",
  AGENTIC_SANDBOX_CI_RUNTIME_REFERENCE: "agentic-language-runtime",
  AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: DIGEST,
  AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION: "AgenticResearcherSandbox",
  AGENTIC_SANDBOX_CI_RUNTIME_ROOT: "/opt/agentic/runtime",
});

test("host-provisioned WSL2 bindings adopt from the names provisioning already writes", () => {
  const binding = readHostProvisionedSandboxBindingV1(
    PROVISIONED_WSL2_ENV,
    "win32",
  );
  assert.ok(binding, "a provisioned Windows host must yield a binding");
  assert.deepEqual(binding.provider, {
    version: 1,
    kind: "wsl2",
    executable: "wsl.exe",
    priority: 30,
    runtimeReference: "agentic-language-runtime",
    runtimeDigest: DIGEST,
    wslDistribution: "AgenticResearcherSandbox",
    runtimeRoot: "/opt/agentic/runtime",
  } satisfies SandboxProviderConfigV2);
  assert.equal(
    binding.variableNames.includes("AGENTIC_SANDBOX_CI_RUNTIME_DIGEST"),
    true,
  );
});

test("canonical production names win over the legacy CI names", () => {
  const canonicalDigest = `sha256:${"a".repeat(64)}`;
  const binding = readHostProvisionedSandboxBindingV1(
    {
      ...PROVISIONED_WSL2_ENV,
      AGENTIC_SANDBOX_PROVIDER: "wsl2",
      AGENTIC_SANDBOX_RUNTIME_DIGEST: canonicalDigest,
    },
    "win32",
  );
  assert.equal(binding?.provider.runtimeDigest, canonicalDigest);
});

test("an incomplete or malformed host environment yields no binding", () => {
  assert.equal(readHostProvisionedSandboxBindingV1({}, "win32"), null);
  assert.equal(
    readHostProvisionedSandboxBindingV1(
      { ...PROVISIONED_WSL2_ENV, AGENTIC_SANDBOX_CI_RUNTIME_DIGEST: "not-a-digest" },
      "win32",
    ),
    null,
    "a malformed digest must never reach durable provider state",
  );
  assert.equal(
    readHostProvisionedSandboxBindingV1(
      { ...PROVISIONED_WSL2_ENV, AGENTIC_SANDBOX_CI_WSL_DISTRIBUTION: "" },
      "win32",
    ),
    null,
    "WSL2 without a dedicated distribution is not a usable boundary",
  );
  assert.equal(
    readHostProvisionedSandboxBindingV1(PROVISIONED_WSL2_ENV, "freebsd"),
    null,
    "an unmapped platform declares no default provider",
  );
});

test("podman and bubblewrap bindings resolve from their platform defaults", () => {
  const podman = readHostProvisionedSandboxBindingV1(
    {
      AGENTIC_SANDBOX_RUNTIME_REFERENCE: "registry.example/agentic-sandbox",
      AGENTIC_SANDBOX_RUNTIME_DIGEST: DIGEST,
    },
    "darwin",
  );
  assert.equal(podman?.provider.kind, "podman");
  assert.equal(podman?.provider.executable, "podman");
  assert.equal(podman?.provider.runtimeRoot, null);

  const bubblewrap = readHostProvisionedSandboxBindingV1(
    {
      AGENTIC_SANDBOX_RUNTIME_REFERENCE: "agentic-language-runtime",
      AGENTIC_SANDBOX_RUNTIME_DIGEST: DIGEST,
      AGENTIC_SANDBOX_RUNTIME_ROOT: "/opt/agentic/runtime",
    },
    "linux",
  );
  assert.equal(bubblewrap?.provider.kind, "bubblewrap");
  assert.equal(bubblewrap?.provider.executable, "bwrap");
});

test("adoption reflects missing, unchanged, and re-provisioned host bindings", () => {
  const binding = readHostProvisionedSandboxBindingV1(
    PROVISIONED_WSL2_ENV,
    "win32",
  )!.provider;

  assert.deepEqual(
    hostProvisionedSandboxAdoptionDecisionV1({ configured: [], binding }),
    { adopt: true, reason: "missing_binding" },
  );
  assert.deepEqual(
    hostProvisionedSandboxAdoptionDecisionV1({
      configured: [binding],
      binding,
    }),
    { adopt: false, reason: "already_bound" },
  );
  assert.deepEqual(
    hostProvisionedSandboxAdoptionDecisionV1({
      configured: [{ ...binding, runtimeDigest: `sha256:${"b".repeat(64)}` }],
      binding,
    }),
    { adopt: true, reason: "binding_changed" },
    "a re-provisioned runtime must refresh the stale digest",
  );
  assert.deepEqual(
    hostProvisionedSandboxAdoptionDecisionV1({
      configured: [binding],
      binding: null,
    }),
    { adopt: false, reason: "no_host_binding" },
  );
});

test("a hand-configured provider of another kind is never displaced", () => {
  const docker: SandboxProviderConfigV2 = {
    version: 1,
    kind: "docker",
    executable: "docker",
    priority: 10,
    runtimeReference: "registry.example/agentic-sandbox",
    runtimeDigest: `sha256:${"c".repeat(64)}`,
    wslDistribution: null,
    runtimeRoot: null,
  };
  const binding = readHostProvisionedSandboxBindingV1(
    PROVISIONED_WSL2_ENV,
    "win32",
  )!.provider;
  assert.deepEqual(
    hostProvisionedSandboxAdoptionDecisionV1({
      configured: [docker],
      binding,
    }),
    { adopt: true, reason: "missing_binding" },
  );
});

test("only non-secret sandbox identity variables are ever read", () => {
  for (const name of HOST_PROVISIONED_SANDBOX_VARIABLE_NAMES_V1) {
    assert.match(name, /^AGENTIC_SANDBOX(?:_CI)?_[A-Z_]+$/u);
    assert.equal(/TOKEN|KEY|SECRET|PASSWORD/u.test(name), false);
  }
});

test("the foreground readiness budget cannot abort the fixed WSL2 probe early", () => {
  assert.equal(WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2, 90_000);
  assert.equal(
    HOST_PROVISIONED_SANDBOX_READINESS_TIMEOUT_MS_V1,
    WSL2_SANDBOX_PROBE_TIMEOUT_MS_V2 + 15_000,
  );
});

function codeReadiness(input: {
  executionAvailable: boolean;
  probeObservedAt: string | null;
}) {
  return buildCapabilityReadinessV2(
    {
      observedAt: "2026-07-26T06:00:00.000Z",
      model: { status: "ready", message: "ok", checkedAt: null },
      notes: { outputProfile: "active_or_new_note", streamingReady: true },
      browser: { enabled: false, companionHealthy: false, checkedAt: null },
      code: {
        registered: true,
        repositoryProfileCount: 0,
        runtimeUnresolvedProfileCount: 0,
        editingAvailable: true,
        executionAvailable: input.executionAvailable,
        probeObservedAt: input.probeObservedAt,
        probeBlocker: input.executionAvailable
          ? null
          : "No sandbox provider has passed its boundary probe.",
      },
      linear: {
        credentialPresent: false,
        snapshotObservedAt: null,
        snapshotFreshUntil: null,
        queueEnabled: false,
        queueApprovalActive: false,
        queueApprovalExpiresAt: null,
      },
      github: {
        enabled: false,
        connected: false,
        waitingForUser: false,
        accountLogin: null,
        credentialObservedAt: null,
        repositoryProfileCount: 0,
        trustedPrivateRepositoryCount: 0,
        repositoryReadbackObservedAt: null,
      },
      background: {
        registered: false,
        configured: false,
        healthy: false,
        checkedAt: null,
        blocker: null,
      },
    },
    new Date("2026-07-26T06:05:00.000Z"),
  );
}

test("the exact reported prompt plans sandbox validation and gates on it at submit", () => {
  const prompt = "Can you create a cli checkers game in Python on my desktop?";
  assert.equal(missionRequiresSandboxValidationV1(prompt), true);

  const blocked = evaluateMissionReadinessPreflightV1({
    prompt,
    readiness: codeReadiness({
      executionAvailable: false,
      probeObservedAt: "2026-07-26T06:04:00.000Z",
    }),
    sandboxValidationRequired: true,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.primary?.id, "sandbox");
  assert.equal(blocked.primary?.nextAction, "Run sandbox boundary probe");
  assert.deepEqual(
    blocked.checks.filter((check) => check.required).map((check) => check.id),
    ["sandbox"],
    "single-stage code delivery gates on the sandbox only",
  );

  const ready = evaluateMissionReadinessPreflightV1({
    prompt,
    readiness: codeReadiness({
      executionAvailable: true,
      probeObservedAt: "2026-07-26T06:04:00.000Z",
    }),
    sandboxValidationRequired: true,
  });
  assert.equal(ready.ok, true, "an adopted and freshly probed sandbox starts");
});

test("a scratch desktop delivery plans no repository-only step", () => {
  for (const prompt of [
    "Can you create a cli checkers game in Python on my desktop?",
    "write a number guessing game in Python on my desktop",
    "save a tic tac toe game in Python to my Documents folder",
  ]) {
    const ladder = getRequiredCodeWorkflowToolNames(prompt);
    // code_repair_record_cycle and code_commit_verified resolve a trusted
    // repository worktree and fail closed with trusted_repository_required on
    // a scratch workspace. Planning either one stranded the mission after the
    // files were authored but before they were exported.
    assert.equal(
      ladder.includes("code_repair_record_cycle"),
      false,
      `repository-only repair planned for a scratch delivery: ${prompt}`,
    );
    assert.equal(ladder.includes("code_commit_verified"), false);
    assert.equal(ladder.includes("code_validate_fast"), true);
    assert.equal(ladder.includes("code_workspace_export_directory"), true);
  }
  assert.equal(
    getRoutedCodeWorkflowToolNames(
      "write a small python game on my desktop",
    ).includes("code_repair_record_cycle"),
    false,
  );
});

test("a trusted repository mission still plans the full repair ladder", () => {
  const ladder = getRequiredCodeWorkflowToolNames(
    "Implement a TypeScript math package in the exact trusted local repository at C:/work/pkg, create repository workspace w1, validate it, and commit.",
  );
  assert.equal(ladder.includes("code_repair_record_cycle"), true);
  assert.equal(ladder.includes("code_validate_targeted"), true);
  assert.equal(ladder.includes("code_validate_full"), true);
  assert.equal(ladder.includes("code_commit_verified"), true);
});

test("a delivered Desktop export is named in the completion summary", () => {
  const exportReceipt = {
    toolName: "code_workspace_export_directory",
    operation: "create" as const,
    message: "Exported the verified workspace.",
    resource: {
      system: "workspace" as const,
      resourceType: "directory",
      id: "export-1",
      path: "C:\\Users\\person\\Desktop\\code-deliverable-abc123",
    },
  };
  assert.equal(
    deliveredHostDirectoryPathV1([
      { toolName: "code_workspace_create_file", operation: "create", message: "Created main.py." },
      exportReceipt,
    ]),
    "C:\\Users\\person\\Desktop\\code-deliverable-abc123",
    "a user who asked for a deliverable on their desktop needs the exact path",
  );
  // Only a real export receipt names a path; ordinary writes must not.
  assert.equal(
    deliveredHostDirectoryPathV1([
      { toolName: "append_to_current_file", operation: "append", message: "Appended." },
    ]),
    null,
  );
  assert.equal(deliveredHostDirectoryPathV1([]), null);
});

test("prompts without a sandbox ladder keep passing the preflight untouched", () => {
  assert.equal(
    missionRequiresSandboxValidationV1("summarize my notes on cell biology"),
    false,
  );
  const result = evaluateMissionReadinessPreflightV1({
    prompt: "summarize my notes on cell biology",
    readiness: codeReadiness({
      executionAvailable: false,
      probeObservedAt: null,
    }),
    sandboxValidationRequired: false,
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.checks, []);
});
