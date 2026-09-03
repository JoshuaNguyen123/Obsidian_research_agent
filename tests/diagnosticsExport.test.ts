import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildDiagnosticsReportV1,
  copyDiagnosticsReportToClipboardV1,
  DIAGNOSTICS_EXPORT_VAULT_PATH,
  extractFailureEvidenceFromRunSnapshotV1,
  formatDiagnosticsReportJsonV1,
  formatDiagnosticsReportMarkdownV1,
  isSafeDiagnosticsExportPathV1,
  redactDiagnosticsSecretsV1,
  writeDiagnosticsExportNoteV1,
} from "../src/ui/diagnosticsExport";

const NOTE_BODY =
  "This is the full note body that a bug report must never attach.";

function reportText(input: Parameters<typeof buildDiagnosticsReportV1>[0]): {
  json: string;
  markdown: string;
} {
  const report = buildDiagnosticsReportV1({
    generatedAt: "2026-09-03T03:00:00.000Z",
    ...input,
  });
  return {
    json: formatDiagnosticsReportJsonV1(report),
    markdown: formatDiagnosticsReportMarkdownV1(report),
  };
}

describe("diagnostics export builder", () => {
  it("stamps the plugin version and omits a missing run snapshot", () => {
    const report = buildDiagnosticsReportV1({
      generatedAt: "2026-09-03T03:00:00.000Z",
      pluginVersion: "0.4.0",
      obsidianVersion: "1.8.10",
      platform: "win32",
      startupPhase: "ready",
      model: { id: "deepseek-v4-pro", provider: "ollama" },
    });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.pluginVersion, "0.4.0");
    assert.equal(report.obsidianVersion, "1.8.10");
    assert.equal(report.platform, "win32");
    assert.equal(report.startupPhase, "ready");
    assert.equal(report.model.id, "deepseek-v4-pro");
    assert.equal(report.model.provider, "ollama");
    assert.equal(report.lastFailure, null);
    assert.equal(report.sandbox.lastProbe, null);
    const markdown = formatDiagnosticsReportMarkdownV1(report);
    assert.match(markdown, /Plugin version: 0\.4\.0/);
    assert.match(markdown, /No run snapshot/);
    assert.doesNotMatch(markdown, /api[_-]?key/i);
  });

  it("carries startup timing into the report and the markdown when the plugin measured it", () => {
    const report = buildDiagnosticsReportV1({
      startupPhase: "ready",
      startupTiming: {
        coreReadyMs: 87.4,
        runNoteCount: 214,
        phases: { load_settings: 12, load_project_memory: 31.2, negative: -3 },
        layoutReadyAfterMs: 640.5,
        deferred: { sweep_agent_runs_retention: 12.5 },
      },
    });
    assert.deepEqual(report.startup, {
      coreReadyMs: 87.4,
      runNoteCount: 214,
      phases: { load_settings: 12, load_project_memory: 31.2, negative: 0 },
      layoutReadyAfterMs: 640.5,
      deferred: { sweep_agent_runs_retention: 12.5 },
    });
    const markdown = formatDiagnosticsReportMarkdownV1(report);
    assert.match(markdown, /## Startup/);
    assert.match(markdown, /Core ready: 87\.4 ms/);
    assert.match(markdown, /Run notes in vault: 214/);
    assert.match(markdown, /load_project_memory: 31\.2 ms/);
    assert.match(markdown, /Layout ready after: 640\.5 ms/);
    assert.match(markdown, /layout-ready sweep_agent_runs_retention: 12\.5 ms/);
    assert.equal(buildDiagnosticsReportV1({ startupPhase: "ready" }).startup, null);
    assert.doesNotMatch(
      formatDiagnosticsReportMarkdownV1(buildDiagnosticsReportV1({})),
      /## Startup/,
    );
  });

  it("redacts secrets from stop detail and tool errors", () => {
    const { json, markdown } = reportText({
      pluginVersion: "0.4.0",
      model: { id: "glm-5.2", provider: "openai_compatible" },
      runSnapshot: {
        stopReason: "error",
        stopDetail:
          "Provider rejected the key sk-live-secretvalue123 and Bearer abcdefghijklmnop",
        failureEvidence: {
          stopDetail: "api_key=super-secret-token",
          lastToolFailure: {
            name: "web_fetch",
            errorCode: "auth_failed",
            errorMessage: "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
            args: { url: "https://example.com" },
          },
        },
      },
    });
    for (const text of [json, markdown]) {
      assert.match(text, /0\.4\.0/);
      assert.doesNotMatch(text, /sk-live-secretvalue123/);
      assert.doesNotMatch(text, /abcdefghijklmnop/);
      assert.doesNotMatch(text, /super-secret-token/);
      assert.doesNotMatch(text, /ghp_abcdefghijklmnopqrstuvwxyz123456/);
      assert.match(text, /\[redacted\]/);
    }
  });

  it("omits note bodies even when they are short enough to preview", () => {
    const { json, markdown } = reportText({
      pluginVersion: "0.4.0",
      runSnapshot: {
        failureEvidence: {
          lastToolFailure: {
            name: "append_to_current_file",
            errorCode: "write_blocked",
            errorMessage: "held",
            args: {
              content: NOTE_BODY,
              text: "also a body",
              title: "Safe title",
            },
          },
        },
      },
    });
    for (const text of [json, markdown]) {
      assert.doesNotMatch(text, /full note body/);
      assert.doesNotMatch(text, /also a body/);
      assert.match(text, /omitted content/);
    }
  });

  it("omits vault paths and command lines from the serialized report", () => {
    const { json, markdown } = reportText({
      pluginVersion: "0.4.0",
      runSnapshot: {
        failureEvidence: {
          lastToolFailure: {
            name: "code_workspace_create_file",
            args: {
              path: "Notes/Draft.md",
              cwd: "C:\\Users\\joshb\\vault",
              command: "wsl.exe -- echo secret",
            },
          },
        },
      },
    });
    for (const text of [json, markdown]) {
      assert.doesNotMatch(text, /Notes\/Draft\.md/);
      assert.doesNotMatch(text, /C:\\\\Users/);
      assert.doesNotMatch(text, /wsl\.exe/);
    }
  });

  it("includes sandbox last-probe status without provider command details", () => {
    const report = buildDiagnosticsReportV1({
      generatedAt: "2026-09-03T03:00:00.000Z",
      pluginVersion: "0.4.0",
      sandboxLastProbe: {
        observedAt: "2026-09-03T02:00:00.000Z",
        status: {
          mode: "sandbox_verified",
          executionAvailable: true,
          editingAvailable: true,
          selectedProvider: "wsl2",
          blocker: null,
        },
      },
    });
    assert.equal(report.sandbox.lastProbe?.observedAt, "2026-09-03T02:00:00.000Z");
    assert.equal(report.sandbox.lastProbe?.status?.mode, "sandbox_verified");
    assert.equal(report.sandbox.lastProbe?.status?.selectedProvider, "wsl2");
    const json = formatDiagnosticsReportJsonV1(report);
    assert.doesNotMatch(json, /executable/);
    assert.doesNotMatch(json, /wsl\.exe/);
  });

  it("extracts last-failure facts from a run snapshot without graph prose", () => {
    const evidence = extractFailureEvidenceFromRunSnapshotV1({
      lastComplete: { stopReason: "error", stopDetail: "Blocked: path_exists" },
      lastMissionGraph: {
        nodes: {
          "node-write": {
            id: "node-write",
            status: "blocked",
            blocker: {
              code: "path_exists",
              message: "file already exists",
              requiredAction: "read then write_expected",
            },
          },
        },
      },
      diagnosticAttestations: [
        {
          id: "node-write:create-file-collision-replan-failed",
          toolName: "code_workspace_create_file",
          errorCode: "path_exists",
          message: "refused",
        },
      ],
    });
    assert.ok(evidence);
    assert.equal(evidence.blocker?.code, "path_exists");
    assert.equal(evidence.activeNodeId, "node-write");
    assert.equal(evidence.lastToolFailure?.name, "code_workspace_create_file");

    const report = buildDiagnosticsReportV1({
      pluginVersion: "0.4.0",
      runSnapshot: {
        lastComplete: { stopReason: "error", stopDetail: "Blocked: path_exists" },
        lastMissionGraph: {
          nodes: {
            "node-write": {
              id: "node-write",
              status: "blocked",
              blocker: {
                code: "path_exists",
                message: "file already exists",
                requiredAction: "read then write_expected",
              },
            },
          },
        },
      },
    });
    assert.ok(report.lastFailure);
    assert.equal(report.lastFailure.stopReason, "error");
    assert.match(report.lastFailure.facts.map((fact) => fact.key).join(","), /blocker_code/);
  });
});

describe("diagnostics export helpers", () => {
  it("redacts secret-shaped strings in isolation", () => {
    assert.match(
      redactDiagnosticsSecretsV1("Authorization: Bearer abcdefghijklmnop"),
      /\[redacted\]/,
    );
    assert.doesNotMatch(
      redactDiagnosticsSecretsV1("Authorization: Bearer abcdefghijklmnop"),
      /abcdefghijklmnop/,
    );
  });

  it("accepts only the vault-relative diagnostics path", () => {
    assert.equal(isSafeDiagnosticsExportPathV1(DIAGNOSTICS_EXPORT_VAULT_PATH), true);
    assert.equal(isSafeDiagnosticsExportPathV1("../secrets.md"), false);
    assert.equal(isSafeDiagnosticsExportPathV1("C:/Windows/diagnostics-export.md"), false);
    assert.equal(isSafeDiagnosticsExportPathV1("Agent Runs\\diagnostics-export.md"), false);
    assert.equal(isSafeDiagnosticsExportPathV1("/tmp/diagnostics-export.md"), false);
  });

  it("copies the report through the clipboard adapter", async () => {
    let copied = "";
    const ok = await copyDiagnosticsReportToClipboardV1("hello", {
      writeText: async (text) => {
        copied = text;
      },
    });
    assert.equal(ok, true);
    assert.equal(copied, "hello");
    const failed = await copyDiagnosticsReportToClipboardV1("hello", {
      writeText: async () => {
        throw new Error("denied");
      },
    });
    assert.equal(failed, false);
  });

  it("writes the markdown note at the safe path and refuses an override", async () => {
    const files = new Map<string, string>();
    const vault = {
      getFileByPath(path: string) {
        return files.has(path) ? { path } : null;
      },
      getAbstractFileByPath(path: string) {
        return files.has(path) ? { path } : null;
      },
      async create(path: string, data: string) {
        files.set(path, data);
      },
      async modify(file: { path: string }, data: string) {
        files.set(file.path, data);
      },
      async createFolder(path: string) {
        files.set(path, "");
      },
    };
    const first = await writeDiagnosticsExportNoteV1({
      markdown: "# diagnostics\n",
      vault,
    });
    assert.equal(first.path, DIAGNOSTICS_EXPORT_VAULT_PATH);
    assert.equal(first.created, true);
    assert.equal(files.get(DIAGNOSTICS_EXPORT_VAULT_PATH), "# diagnostics\n");

    const second = await writeDiagnosticsExportNoteV1({
      markdown: "# updated\n",
      vault,
    });
    assert.equal(second.created, false);
    assert.equal(files.get(DIAGNOSTICS_EXPORT_VAULT_PATH), "# updated\n");

    await assert.rejects(
      () =>
        writeDiagnosticsExportNoteV1({
          markdown: "nope",
          vault,
          path: "../escape.md",
        }),
      /not a safe vault-relative/,
    );
  });
});
