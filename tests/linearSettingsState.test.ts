import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveLinearCapabilityGate,
  evaluateLinearQueueConfiguration,
  normalizeLinearCredentialReference,
  reconcileLinearSelections,
  type LinearCapabilitySnapshotV1,
} from "../src/integrations/linear";

const snapshot = {
  schemaVersion: 1,
  sourceOperations: [
    "connection.context",
    "teams.list",
    "projects.list",
    "workflow_states.list",
  ],
  viewer: { id: "viewer-1", name: "Researcher" },
  workspace: { id: "workspace-1", name: "Acme" },
  teams: [{ id: "team-1", name: "Platform", key: "PLAT" }],
  projects: [
    {
      id: "project-1",
      name: "Agent queue",
      url: "https://linear.app/acme/project/queue",
      teamIds: ["team-1"],
    },
  ],
  workflowStates: [
    { id: "started-1", name: "In Progress", type: "started", teamId: "team-1" },
    { id: "completed-1", name: "Done", type: "completed", teamId: "team-1" },
    { id: "blocked-1", name: "Blocked", type: "canceled", teamId: "team-1" },
  ],
  sources: [
    { operation: "connection.context", enabled: true, itemCount: 1, truncated: false, errorCode: null },
    { operation: "teams.list", enabled: true, itemCount: 1, truncated: false, errorCode: null },
    { operation: "projects.list", enabled: true, itemCount: 1, truncated: false, errorCode: null },
    { operation: "workflow_states.list", enabled: true, itemCount: 3, truncated: false, errorCode: null },
  ],
  capabilities: [
    { id: "authenticated_connection", enabled: true, summary: "Connected." },
    { id: "team_selection", enabled: true, summary: "Teams available." },
    { id: "project_selection", enabled: true, summary: "Projects available." },
    { id: "workflow_state_selection", enabled: true, summary: "States available." },
    { id: "read_only_discovery", enabled: true, summary: "Discovery available." },
    { id: "mutation_authority", enabled: false, summary: "Approval required." },
  ],
  discoveredAt: "2026-07-12T16:00:00.000Z",
  freshUntil: "2026-07-12T16:15:00.000Z",
  snapshotHash: `sha256:${"a".repeat(64)}`,
} as LinearCapabilitySnapshotV1;

test("Linear queue readiness is derived from discovered bindings, not a magic gate", () => {
  assert.equal(deriveLinearCapabilityGate(snapshot), 2);
  assert.deepEqual(
    evaluateLinearQueueConfiguration(snapshot, {
      teamId: "team-1",
      projectId: "project-1",
      startedStateId: "started-1",
      completedStateId: "completed-1",
      blockedStateId: "blocked-1",
    }),
    {
      ready: true,
      reason: "Queue bindings are verified against Acme.",
    },
  );
  assert.match(
    evaluateLinearQueueConfiguration(snapshot, {
      teamId: "team-injected",
      projectId: "project-1",
      startedStateId: "started-1",
      completedStateId: "completed-1",
    }).reason,
    /connection-derived Linear team/,
  );
  assert.equal(deriveLinearCapabilityGate(null), 0);
});

test("Linear selection migration preserves known IDs and only auto-selects unambiguous choices", () => {
  assert.deepEqual(
    reconcileLinearSelections(snapshot, {
      teamId: "legacy-team",
      projectId: "legacy-project",
      startedStateId: "legacy-started",
      completedStateId: "legacy-completed",
      blockedStateId: "legacy-blocked",
    }),
    {
      teamId: "team-1",
      projectId: "project-1",
      startedStateId: "started-1",
      completedStateId: "completed-1",
      blockedStateId: "",
      changed: true,
    },
  );
});

test("persisted Linear credential metadata is strict and cannot contain plaintext", () => {
  const description = normalizeLinearCredentialReference({
    version: 1,
    referenceId: "secret_12345678-abcd-1234-abcd-123456789abc",
    label: "Linear personal API credential",
    metadata: { provider: "linear", credentialKind: "personal_api_key" },
    backend: "keyring",
    persistent: true,
    createdAt: "2026-07-12T16:00:00.000Z",
    updatedAt: "2026-07-12T16:00:00.000Z",
  });
  assert.equal(description?.referenceId, "secret_12345678-abcd-1234-abcd-123456789abc");
  assert.equal(JSON.stringify(description).includes("lin_api_"), false);
  assert.equal(
    normalizeLinearCredentialReference({ ...description, value: "lin_api_secret" }),
    null,
  );
  assert.equal(
    normalizeLinearCredentialReference({
      ...description,
      metadata: { provider: "linear", token: "lin_api_secret" },
    }),
    null,
  );
});
