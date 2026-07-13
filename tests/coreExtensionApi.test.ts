import test from "node:test";
import assert from "node:assert/strict";
import {
  ExtensionRegistrationErrorV1,
  ExtensionUnavailableErrorV1,
  type ExtensionContributionDescriptorV1,
  type ExtensionContributionV1,
  type ExtensionToolContributionV1,
  type RegisterExtensionRequestV1,
  type ScopedExtensionContextV1,
  type ToolDescriptorV1,
} from "../packages/core-api/src";
import { CoreApiHost } from "../src/extensions/CoreApiHost";
import { EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS } from "../src/extensions/expectedExtensions";
import {
  createDefaultToolRegistry,
  getCoreToolNameReservations,
  getReservedCoreToolNames,
} from "../src/tools/createToolRegistry";
import { LINEAR_TOOL_OPERATION_MAP } from "../src/integrations/linear/LinearTools";

test("core API exposes version 1.2 and remains registration-compatible with 1.0", () => {
  const host = new CoreApiHost({
    now: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  const api = host.getApi();
  assert.equal(api.apiMajor, 1);
  assert.equal(api.apiMinor, 2);
  assert.equal(api.state, "loading");
  assert.throws(
    () => api.registerExtension(registration("agentic-researcher-code")),
    errorWithCode("core_not_ready"),
  );

  host.markReady();
  assert.equal(api.state, "ready");
  assert.throws(
    () =>
      api.registerExtension({
        ...registration("agentic-researcher-code"),
        manifest: {
          ...registration("agentic-researcher-code").manifest,
          apiMajor: 2,
        },
      }),
    errorWithCode("api_major_mismatch"),
  );
  assert.throws(
    () =>
      api.registerExtension({
        ...registration("agentic-researcher-code"),
        manifest: {
          ...registration("agentic-researcher-code").manifest,
          apiMinor: 3,
        },
      }),
    errorWithCode("api_minor_unsupported"),
  );

  const legacyRequest = registration("agentic-researcher-integrations");
  legacyRequest.manifest.apiMinor = 0;
  const legacyToken = api.registerExtension(legacyRequest);
  assert.equal(legacyToken.apiMinor, 2, "token advertises the host contract version");
  assert.equal(api.unregisterExtension(legacyToken), true);

  const statuses = host.getExpectedExtensionStatuses(
    EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS,
  );
  assert.equal(statuses[0].availability, "incompatible");
  assert.equal(statuses[1].availability, "missing");
  assert.ok(Object.isFrozen(statuses));
});

test("registry change notification runs after an incompatible registration fails", () => {
  let changes = 0;
  const host = new CoreApiHost({ onRegistryChange: () => changes++ });
  host.markReady();
  assert.throws(
    () =>
      host.registerExtension({
        ...registration("agentic-researcher-code"),
        manifest: {
          ...registration("agentic-researcher-code").manifest,
          apiMajor: 2,
        },
      }),
    errorWithCode("api_major_mismatch"),
  );
  assert.equal(changes, 1);
  assert.equal(
    host.getExpectedExtensionStatuses(EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS)[0]
      .availability,
    "incompatible",
  );
});

test("state migration transport requires the exact active registration token", async () => {
  const hash = `sha256:${"a".repeat(64)}`;
  const host = new CoreApiHost({
    getStateMigrationOffer(extensionId) {
      assert.equal(extensionId, "agentic-researcher-code");
      return {
        version: 1,
        migrationId: hash,
        namespace: "code",
        mode: "new_install",
        preparedAt: "2026-07-11T12:00:00.000Z",
        sourceSnapshotHash: null,
        snapshotHash: hash,
        snapshot: { schemaVersion: 1 },
        alreadyVerified: false,
        acknowledgedAt: null,
        retainedReleaseIds: null,
        pendingSecureImportKinds: [],
      };
    },
    async acknowledgeStateMigration(extensionId, readback) {
      assert.equal(extensionId, "agentic-researcher-code");
      assert.equal(readback.namespace, "code");
      return {
        version: 1,
        migrationId: hash,
        namespace: "code",
        snapshotHash: hash,
        verified: true,
        pendingSecureImportKinds: [],
      };
    },
  });
  host.markReady();
  const api = host.getApi();
  const token = api.registerExtension(registration("agentic-researcher-code"));
  const forged = Object.freeze({ ...token });
  assert.throws(() => api.getStateMigrationOffer(forged), /not active/i);
  assert.equal(api.getStateMigrationOffer(token).namespace, "code");
  const result = await api.acknowledgeStateMigration(token, {
    version: 1,
    migrationId: hash,
    namespace: "code",
    snapshot: { schemaVersion: 1 },
    acknowledgedAt: "2026-07-11T12:01:00.000Z",
  });
  assert.equal(result.verified, true);
  host.unregisterExtension(token);
  assert.throws(() => api.getStateMigrationOffer(token), /not active/i);
});

test("registry accepts every v1 contribution kind and freezes mission snapshots", () => {
  const host = readyHost();
  const request = registration("agentic-researcher-code", allContributions());
  const originalDescriptor = request.contributions[0].descriptor;
  const token = host.registerExtension(request);
  const first = host.createMissionSnapshot("mission-one");

  assert.deepEqual(
    [
      first.tools.length,
      first.executors.length,
      first.verifiers.length,
      first.settings.length,
      first.statuses.length,
      first.backgroundHandlers.length,
      first.serializers.length,
    ],
    [1, 1, 1, 1, 1, 1, 1],
  );
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first.tools));
  assert.ok(Object.isFrozen(first.tools[0]));
  assert.ok(Object.isFrozen(first.tools[0].contribution));
  assert.ok(Object.isFrozen(first.tools[0].contribution.tool.parameters));
  assert.equal(first.tools[0].token, token);

  originalDescriptor.displayName = "mutated by extension";
  assert.equal(first.tools[0].contribution.descriptor.displayName, "Fixture Tool");

  host.registerExtension(
    registration("agentic-researcher-integrations", [
      statusContribution("integration-status"),
    ]),
  );
  const second = host.createMissionSnapshot("mission-two");
  assert.equal(first.statuses.length, 1, "existing mission snapshot must not grow");
  assert.equal(second.statuses.length, 2);
});

test("tool contributions may use an extension-qualified descriptor identity", () => {
  const host = readyHost();
  const contribution = toolContribution("code_workspace_read");
  contribution.descriptor.id =
    "agentic-researcher-code:code_workspace_read";
  const token = host.registerExtension(
    registration("agentic-researcher-code", [contribution]),
  );
  assert.equal(
    host.createMissionSnapshot("qualified-tool-id").tools[0].contribution.tool
      .name,
    "code_workspace_read",
  );
  host.unregisterExtension(token);
});

test("duplicate registrations and contribution identities are rejected transactionally", () => {
  const host = readyHost();
  const first = registration("agentic-researcher-code", [toolContribution("code_read")]);
  host.registerExtension(first);
  assert.throws(
    () => host.registerExtension(first),
    errorWithCode("duplicate_extension"),
  );
  assert.throws(
    () =>
      host.registerExtension(
        registration("agentic-researcher-integrations", [toolContribution("code_read")]),
      ),
    errorWithCode("duplicate_contribution"),
  );
  assert.throws(
    () =>
      host.registerExtension(
        registration("agentic-researcher-companion", [
          statusContribution("same-status"),
          statusContribution("same-status"),
        ]),
      ),
    errorWithCode("duplicate_contribution"),
  );
  assert.deepEqual(host.getRegisteredExtensionIds(), ["agentic-researcher-code"]);
});

test("host tool reservations reject collisions transactionally and preserve migration owners", () => {
  const reservations = getCoreToolNameReservations();
  const host = new CoreApiHost({ toolNameReservations: reservations });
  host.markReady();

  const coreOnly = reservations.filter((item) => item.ownerExtensionId === null);
  assert.ok(coreOnly.some((item) => item.name === "read_current_file"));
  for (const reservation of reservations) {
    const unauthorizedExtensionId =
      reservation.ownerExtensionId === "agentic-researcher-code"
        ? "agentic-researcher-integrations"
        : "agentic-researcher-code";
    assert.throws(
      () =>
        host.registerExtension(
          registration(unauthorizedExtensionId, [
            toolContribution(reservation.name),
          ]),
        ),
      errorWithCode("duplicate_contribution"),
      reservation.name,
    );
  }

  const codeName = reservations.find(
    (item) => item.ownerExtensionId === "agentic-researcher-code",
  )?.name;
  const linearName = reservations.find(
    (item) => item.ownerExtensionId === "agentic-researcher-integrations",
  )?.name;
  const companionName = reservations.find(
    (item) => item.ownerExtensionId === "agentic-researcher-companion",
  )?.name;
  assert.ok(codeName && linearName && companionName);
  assert.deepEqual(host.getRegisteredExtensionIds(), []);

  const token = host.registerExtension(
    registration("agentic-researcher-code", [toolContribution(codeName)]),
  );
  const integrationToken = host.registerExtension(
    registration("agentic-researcher-integrations", [toolContribution(linearName)]),
  );
  const companionToken = host.registerExtension(
    registration("agentic-researcher-companion", [toolContribution(companionName)]),
  );
  assert.deepEqual(
    host
      .createMissionSnapshot("owner-adoption")
      .tools.map((item) => item.contribution.tool.name),
    [codeName, linearName, companionName],
  );
  host.unregisterExtension(token);
  host.unregisterExtension(integrationToken);
  host.unregisterExtension(companionToken);
});

test("reservation catalog covers every built-in and fixed Linear tool exactly once", () => {
  const reservations = getCoreToolNameReservations();
  const names = reservations.map((item) => item.name);
  const reserved = getReservedCoreToolNames();
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(reserved, names);
  assert.ok(Object.isFrozen(reservations));
  assert.ok(Object.isFrozen(reserved));

  const builtInNames = createDefaultToolRegistry()
    .getDefinitions()
    .map((definition) => definition.function.name);
  for (const name of builtInNames) {
    assert.ok(names.includes(name), `missing built-in reservation: ${name}`);
  }
  for (const name of Object.keys(LINEAR_TOOL_OPERATION_MAP)) {
    assert.equal(
      reservations.find((item) => item.name === name)?.ownerExtensionId,
      "agentic-researcher-integrations",
      `fixed Linear name must be integration-owned: ${name}`,
    );
  }
});

test("unregister aborts the token, removes future capabilities, and disables stale wrappers", async () => {
  const host = readyHost();
  const token = host.registerExtension(
    registration("agentic-researcher-code", [statusContribution("code-status")]),
  );
  const snapshot = host.createMissionSnapshot("mission-stale-wrapper");
  const staleStatus = snapshot.statuses[0].contribution;
  const forged = Object.freeze({ ...token });
  assert.equal(host.unregisterExtension(forged), false, "token identity must be opaque");
  assert.equal(host.isTokenActive(token), true);

  assert.equal(host.unregisterExtension(token, "test_unload"), true);
  assert.equal(token.signal.aborted, true);
  assert.equal(token.signal.reason, "test_unload");
  assert.equal(host.unregisterExtension(token), false);
  assert.equal(host.createMissionSnapshot("mission-after-unload").statuses.length, 0);
  assert.match(
    host.getExpectedExtensionStatuses(EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS)[0]
      .message,
    /last registration ended: test_unload/i,
  );
  await assert.rejects(
    () => staleStatus.readStatus(scopedContext()),
    (error: unknown) =>
      error instanceof ExtensionUnavailableErrorV1 &&
      error.code === "extension_unavailable" &&
      error.mutationState === "not_applied",
  );
});

test("core unload unregisters and aborts every extension and is terminal", () => {
  const host = readyHost();
  const first = host.registerExtension(
    registration("agentic-researcher-code", [statusContribution("code-status")]),
  );
  const second = host.registerExtension(
    registration("agentic-researcher-integrations", [
      statusContribution("integration-status"),
    ]),
  );

  assert.equal(host.beginUnload("plugin_unload"), 2);
  assert.equal(host.state, "unloading");
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, true);
  assert.equal(host.beginUnload(), 0);
  assert.throws(() => host.markReady(), errorWithCode("core_unloading"));
  assert.throws(
    () => host.registerExtension(registration("agentic-researcher-companion")),
    errorWithCode("core_unloading"),
  );
});

test("prepared tools must provide both preparation and prepared execution", () => {
  const host = readyHost();
  const contribution = toolContribution("prepared_tool");
  contribution.tool.descriptor.execution.preparation = "required";
  assert.throws(
    () => host.registerExtension(registration("agentic-researcher-code", [contribution])),
    errorWithCode("invalid_contribution"),
  );
});

test("runtime registration rejects malformed and safety-incoherent tool descriptors", () => {
  const host = readyHost();
  const malformed = toolContribution("malformed_descriptor");
  (malformed.tool.descriptor.capability as { system: string }).system = "shell";
  assert.throws(
    () =>
      host.registerExtension(
        registration("agentic-researcher-code", [malformed]),
      ),
    errorWithCode("invalid_contribution"),
  );

  const unsafeMutation = toolContribution("unsafe_mutation");
  unsafeMutation.tool.descriptor.capability.action = "delete";
  unsafeMutation.tool.descriptor.effect = "destructive_mutation";
  assert.throws(
    () =>
      host.registerExtension(
        registration("agentic-researcher-code", [unsafeMutation]),
      ),
    errorWithCode("invalid_contribution"),
  );
});

test("expected extension catalog is immutable and version bound", () => {
  assert.ok(Object.isFrozen(EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS));
  assert.deepEqual(
    EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS.map((item) => item.id),
    [
      "agentic-researcher-code",
      "agentic-researcher-integrations",
      "agentic-researcher-companion",
    ],
  );
  assert.ok(
    EXPECTED_AGENTIC_RESEARCHER_EXTENSIONS.every(
      (item) => item.apiMajor === 1 && item.minimumApiMinor === 2,
    ),
  );
});

function readyHost(): CoreApiHost {
  const host = new CoreApiHost({
    now: () => new Date("2026-07-11T12:00:00.000Z"),
  });
  host.markReady();
  return host;
}

function registration(
  id: string,
  contributions: ExtensionContributionV1[] = [statusContribution(`${id}-status`)],
): RegisterExtensionRequestV1 {
  return {
    manifest: {
      id,
      displayName: id,
      version: "0.1.0",
      apiMajor: 1,
      apiMinor: 1,
    },
    contributions,
  };
}

function allContributions(): ExtensionContributionV1[] {
  return [
    toolContribution("fixture_tool"),
    {
      descriptor: contributionDescriptor("mission_executor", "fixture-executor", "Executor"),
      async execute() {
        return { status: "complete", outputs: { ok: true } };
      },
    },
    {
      descriptor: contributionDescriptor("mission_verifier", "fixture-verifier", "Verifier"),
      async verify() {
        return {
          status: "pass",
          message: "Verified.",
          missing: [],
          evidenceIds: [],
          receiptIds: [],
        };
      },
    },
    {
      descriptor: contributionDescriptor("settings", "fixture-settings", "Settings"),
      section: {
        id: "fixture",
        title: "Fixture",
        fields: [{ id: "enabled", type: "boolean", label: "Enabled", defaultValue: true }],
      },
    },
    statusContribution("fixture-status"),
    {
      descriptor: contributionDescriptor(
        "background_handler",
        "fixture-background",
        "Background",
      ),
      async handle() {},
    },
    {
      descriptor: contributionDescriptor("serializer", "fixture-serializer", "Serializer"),
      target: "receipt",
      type: "fixture_receipt",
      async serialize() {
        return { fixture: true };
      },
      async deserialize(value) {
        return value;
      },
    },
  ];
}

function toolContribution(name: string): ExtensionToolContributionV1 {
  return {
    descriptor: contributionDescriptor("tool", name, "Fixture Tool"),
    tool: {
      name,
      description: "Fixture extension tool.",
      parameters: {
        type: "object",
        properties: { value: { type: "string" } },
        additionalProperties: false,
      },
      descriptor: toolDescriptor(name),
      async execute(args) {
        return { value: args.value ?? null };
      },
    },
  };
}

function statusContribution(id: string): ExtensionContributionV1 {
  return {
    descriptor: contributionDescriptor("status", id, "Fixture Status"),
    async readStatus() {
      return {
        status: "healthy",
        summary: "Ready.",
        checkedAt: "2026-07-11T12:00:00.000Z",
      };
    },
  };
}

function contributionDescriptor<TKind extends ExtensionContributionDescriptorV1["kind"]>(
  kind: TKind,
  id: string,
  displayName: string,
): ExtensionContributionDescriptorV1<TKind> {
  return { version: 1, kind, id, displayName };
}

function toolDescriptor(name: string): ToolDescriptorV1 {
  return {
    version: 1,
    name,
    capability: { system: "workspace", resourceType: "fixture", action: "read" },
    effect: "read",
    risk: "low",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: true,
      fallback: "none",
    },
    execution: { preparation: "none", cacheable: true, parallelSafe: true },
    durability: {
      journal: false,
      receipt: false,
      readback: "none",
      reconciliation: "none",
    },
    allowedPrincipals: ["single_agent", "lead"],
  };
}

function scopedContext(): ScopedExtensionContextV1 {
  return {
    version: 1,
    extensionId: "fixture",
    abortSignal: new AbortController().signal,
    now: () => new Date("2026-07-11T12:00:00.000Z"),
    reportProgress() {},
  };
}

function errorWithCode(code: ExtensionRegistrationErrorV1["code"]) {
  return (error: unknown) =>
    error instanceof ExtensionRegistrationErrorV1 && error.code === code;
}
