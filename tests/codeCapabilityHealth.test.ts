import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { Plugin } from "obsidian";
import type { ScopedExtensionContextV1 } from "../packages/core-api/src";
import { CodeExtensionRuntimeV2 } from "../extensions/code/CodeExtensionRuntimeV2";
import type {
  SandboxCommandRunnerV2,
  SandboxProviderConfigV2,
} from "../extensions/code/sandbox";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";

const DIGEST = `sha256:${"f".repeat(64)}`;

test("Code health separates isolation from generated-artifact execution/readback", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-health-"));
  try {
    const artifact = new TextEncoder().encode(
      "agentic-researcher-generated-code-health-v1\n",
    );
    const runner: SandboxCommandRunnerV2 = {
      async run(spec) {
        if (spec.purpose === "boundary_probe") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              version: 1,
              uid: 65532,
              networkBlocked: true,
              rootReadOnly: true,
              hostRootAbsent: true,
              containerSocketAbsent: true,
              runtimeReadOnly: true,
              runtimeDigest: DIGEST,
              stagingIsolated: true,
              resourceLimitsEnforced: true,
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: "health ok",
          stderr: "",
          artifacts: { "dist/capability-health.txt": artifact },
        };
      },
    };
    const plugin = new MemoryPluginData({ schemaVersion: 1 });
    const runtime = new CodeExtensionRuntimeV2({
      plugin: plugin as unknown as Plugin,
      sandboxRunner: runner,
      workspaceManager: new WorkspaceManagerV2({
        applicationDataRoot: path.join(root, "app-data"),
      }),
      now: () => new Date("2026-08-07T12:00:00.000Z"),
    });
    await runtime.initialize();
    const provider: SandboxProviderConfigV2 = {
      version: 1,
      kind: "docker",
      executable: "docker",
      priority: 1,
      runtimeReference: "ghcr.io/openai/agentic-sandbox",
      runtimeDigest: DIGEST,
      wslDistribution: null,
      runtimeRoot: null,
    };
    await runtime.configureSandboxProvider(provider);
    const proof = await runtime.probeGeneratedArtifactExecutionReadbackV1();
    assert.equal(proof.status, "healthy");
    assert.equal(proof.provider, "docker");
    assert.match(proof.receiptFingerprint ?? "", /^sha256:[a-f0-9]{64}$/u);
    assert.equal(proof.artifactFingerprint, sha256(artifact));

    const statuses = runtime
      .getContributions()
      .filter((contribution) => contribution.descriptor.kind === "status");
    assert.ok(
      statuses.some(
        (contribution) =>
          contribution.descriptor.displayName === "Code sandbox isolation",
      ),
    );
    assert.ok(
      statuses.some(
        (contribution) =>
          contribution.descriptor.displayName ===
          "Generated-code execution and readback",
      ),
    );
    const context: ScopedExtensionContextV1 = {
      version: 1,
      extensionId: "agentic-researcher-code",
      missionId: "health-test",
      operationId: "health-test",
      abortSignal: new AbortController().signal,
      now: () => new Date("2026-08-07T12:00:00.000Z"),
      reportProgress() {},
    };
    const generated = statuses.find(
      (contribution) =>
        contribution.descriptor.displayName ===
        "Generated-code execution and readback",
    );
    assert.ok(generated && "readStatus" in generated);
    if (generated && "readStatus" in generated) {
      const health = await generated.readStatus(context);
      assert.equal(health.status, "healthy");
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

class MemoryPluginData {
  private data: Record<string, unknown>;

  constructor(initial: Record<string, unknown>) {
    this.data = structuredClone(initial);
  }

  async loadData(): Promise<unknown> {
    return structuredClone(this.data);
  }

  async saveData(value: unknown): Promise<void> {
    this.data = structuredClone(value as Record<string, unknown>);
  }
}

function sha256(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
