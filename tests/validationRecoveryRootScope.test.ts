import test from "node:test";
import assert from "node:assert/strict";
import { getReceiptBackedWorkspaceRecoveryPathsV1, getDiagnosticSelectedWorkspaceCorrectionPaths, validationRecoveryPathAtOrBelowV1 } from "../src/agent/verifiedWorkspaceBinding";
import type { AgentRunReceipt } from "../src/AgentRunner";
import type { MissionGraphV3 } from "../packages/headless-runtime/src/missionGraphV3";

const before = `sha256:${"a".repeat(64)}`;
const after = `sha256:${"b".repeat(64)}`;
function scope(paths: string[] = ["."]): AgentRunReceipt {
  return { toolName: "code_workspace_create", operation: "create", message: "created", commitKind: "committed", readback: { status: "verified", checkedAt: "2026-10-13T00:00:00Z" }, resource: { system: "workspace", resourceType: "code_workspace", id: "w", workspaceId: "w", path: "w" }, output: { repositoryWriteScope: { profileKey: "trusted", projects: [{ projectId: "root", projectRoot: ".", allowedPaths: paths }] } } } as AgentRunReceipt;
}
function changed(path = "src/ticket.js"): AgentRunReceipt {
  return { toolName: "code_workspace_patch", operation: "update", message: "patched", path, commitKind: "committed", readback: { status: "verified", checkedAt: "2026-10-13T00:00:00Z", observedRevision: after }, output: { path, receipt: { version: 2, path, beforeSha256: before, afterSha256: after } } } as AgentRunReceipt;
}
test("a verified root-scoped repository recovers only its exact changed file", () => {
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(), changed()]), ["src/ticket.js"]);
});
test("a root scope alone grants no guessed filename", () => {
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope()]), []);
});
test("root-scoped recovery rejects unverified and unchanged mutations", () => {
  // Deliberately malformed external data: the public receipt type excludes it.
  const unverified = changed(); unverified.readback = { status: "mismatch", checkedAt: "2026-10-13T00:00:00Z" } as unknown as AgentRunReceipt["readback"];
  const noChange = changed(); (noChange.output as any).receipt.beforeSha256 = after;
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(), unverified, noChange]), []);
});
test("root scope still rejects traversal and absolute candidate paths", () => {
  for (const path of ["../outside.js", "/outside.js", "C:/outside.js", "src/../outside.js", "src//outside.js", "src/a\u0000.js"]) {
    assert.equal(validationRecoveryPathAtOrBelowV1(".", path), false, path);
    assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(), changed(path)]), [], path);
  }
});
test("different scope receipts remain ambiguous and subdirectory scope stays narrow", () => {
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(), scope(["src"]), changed()]), []);
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(["lib"]), changed()]), []);
  assert.deepEqual(getReceiptBackedWorkspaceRecoveryPathsV1([scope(["src"]), changed()]), ["src/ticket.js"]);
});
test("a test assertion can select the sole verified implementation, never infer a choice between two", () => {
  const graph = { nodes: {} } as MissionGraphV3;
  const diagnostic = { stdout: "AssertionError: expected ready at /workspace/test/ticket.test.js:4", stderr: "", truncated: false, redactedLines: 0 };
  assert.deepEqual(getDiagnosticSelectedWorkspaceCorrectionPaths(graph, diagnostic, [scope(), changed()]), ["src/ticket.js"]);
  assert.deepEqual(getDiagnosticSelectedWorkspaceCorrectionPaths(graph, diagnostic, [scope(), changed(), changed("src/other.js")]), []);
});
