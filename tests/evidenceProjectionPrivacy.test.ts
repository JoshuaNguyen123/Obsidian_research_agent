import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  armToolCallCollector,
  harvestToolCallCollector,
  peekToolCallCollectorDiagnosticsV1,
  resetToolCallCollectorStateForTestsV1,
} from "../e2e/fixtures/toolCallCollector";
import { normalizeMissionToolEventV1 } from "../e2e/fixtures/toolCallOutcomes";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * Privacy is a release blocker for this evidence lane, so these tests drive the
 * REAL page-side projection rather than asserting over hand-built fixtures. A
 * fake `window` plus a fake page whose `evaluate` actually invokes the passed
 * function means the code under test is the same code that runs inside the
 * Obsidian renderer.
 *
 * Every "must not appear" assertion is paired with a "must appear" assertion on
 * the same captured object. A projection that returned `{}` would satisfy every
 * privacy rule and be worthless; the positive half is what makes these tests
 * mean something.
 */

/** Distinctive strings. If any reaches the projection, the boundary leaked. */
const POISON = {
  credential: "sk-live-DEADBEEF-must-not-escape",
  notePath: "Research/Private Client Note.md",
  backupPath: ".agent-backups/Private Client Note.md",
  noteBody: "The patient's diagnosis was confirmed on Tuesday.",
  command: "python3 /home/user/secrets/run_payroll.py --token abc123",
  providerPayload: "assistant said: here is the full completion text",
  hiddenReasoning: "Let me think step by step about the user's private data",
  toolArgument: "vault/Some Folder/Unlisted Draft.md",
} as const;

const POISON_PATTERN = new RegExp(
  Object.values(POISON)
    .map((value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|"),
  "u",
);

interface FakeHandlers {
  onStatus?: (message: unknown) => void;
  onTrace?: (event: unknown) => void;
  onToolDone?: (event: unknown) => void;
  onReceipt?: (receipt: unknown) => void;
  onMetric?: (event: unknown) => void;
}

/**
 * Install a fake Obsidian window whose plugin records the handlers the
 * collector subscribes with, so a test can fire poisoned mission events at the
 * real page-side code.
 */
function installFakeRenderer(): { handlers: FakeHandlers } {
  const captured: { handlers: FakeHandlers } = { handlers: {} };
  (globalThis as Record<string, unknown>).window = {
    app: {
      plugins: {
        plugins: {
          "agentic-researcher": {
            getMissionRunSnapshot: () => ({
              isRunning: false,
              runId: "run-1",
              droppedEventCount: 0,
              providerUsageScopeId: "scope-1",
            }),
            subscribeMissionEvents: (handlers: FakeHandlers) => {
              captured.handlers = handlers;
              return () => undefined;
            },
          },
        },
      },
    },
  };
  return captured;
}

function uninstallFakeRenderer(): void {
  delete (globalThis as Record<string, unknown>).window;
}

/** A page whose `evaluate` really runs the projection, and records its output. */
function fakePage(): { page: any; crossed: unknown[] } {
  const crossed: unknown[] = [];
  const page = {
    isClosed: () => false,
    evaluate: async (fn: (arg: any) => unknown, arg: unknown) => {
      const result = await fn(arg as any);
      crossed.push(result);
      return result;
    },
  };
  return { page, crossed };
}

function firePoisonedMissionEvents(handlers: FakeHandlers): void {
  handlers.onStatus?.(`SYS> writing ${POISON.notePath}: ${POISON.noteBody}`);
  handlers.onTrace?.({
    kind: "tool_start",
    id: "3:0:append_to_current_file",
    toolName: "append_to_current_file",
    message: `appending to ${POISON.notePath}`,
    path: POISON.notePath,
    inputPreview: { content: POISON.noteBody, apiKey: POISON.credential },
  });
  handlers.onTrace?.({
    kind: "tool_result",
    id: "3:0:append_to_current_file:result",
    toolName: "append_to_current_file",
    message: POISON.noteBody,
    outputPreview: POISON.providerPayload,
    error: { code: "execution_failed", message: `failed writing ${POISON.notePath}` },
  });
  handlers.onToolDone?.({
    id: "3:1:code_run",
    name: "code_run",
    step: 3,
    ok: false,
    message: POISON.command,
    output: { stdout: POISON.command, thinking: POISON.hiddenReasoning },
    error: { code: "sandbox_prepare_rejected", message: POISON.command },
  });
  handlers.onReceipt?.({
    id: "receipt-9",
    toolName: "append_to_current_file",
    operation: "append",
    bytesWritten: 128,
    path: POISON.notePath,
    backupPath: POISON.backupPath,
    message: POISON.noteBody,
    output: POISON.providerPayload,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: "2026-09-06T18:00:00.000Z",
      observedRevision: "fnv1a32:0badf00d",
      observedFingerprint: "fnv1a32:deadbeef",
      priorRevision: "fnv1a32:00000001",
    },
  });
  handlers.onMetric?.({
    kind: "tool",
    name: "web_fetch",
    step: 3,
    durationMs: 0,
    cached: true,
    // The real runner builds this as `${name}:${stableStringify(args)}`, so it
    // literally carries the tool arguments.
    cacheKey: `web_fetch:{"path":"${POISON.toolArgument}","apiKey":"${POISON.credential}"}`,
    savedDurationMs: 812,
  });
}

test("no vault content, path, command, payload, credential or reasoning crosses the page boundary", async () => {
  resetToolCallCollectorStateForTestsV1();
  const renderer = installFakeRenderer();
  const { page, crossed } = fakePage();
  try {
    await armToolCallCollector(page);
    firePoisonedMissionEvents(renderer.handlers);

    const diagnostics = await peekToolCallCollectorDiagnosticsV1(page);
    const counts = await harvestToolCallCollector(page);
    const everythingThatCrossed = JSON.stringify({ crossed, diagnostics, counts });

    // --- the negative half -------------------------------------------------
    assert.doesNotMatch(
      everythingThatCrossed,
      POISON_PATTERN,
      "a raw argument, note body, path, command, provider payload, credential or hidden reasoning reached the projection",
    );
    // Named individually so a failure says WHICH class leaked.
    for (const [name, value] of Object.entries(POISON)) {
      assert.ok(
        !everythingThatCrossed.includes(value),
        `${name} must not cross the renderer boundary`,
      );
    }
    // The free-form status/trace ring is deliberately excluded from the
    // projection; it exists only for harness diagnostics on the page.
    assert.ok(
      !everythingThatCrossed.includes("recent"),
      "the free-form status ring must never be projected",
    );

    // --- the positive half: the projection is not simply empty -------------
    assert.equal(counts.coverage, "complete");
    assert.equal(counts.attempted, 2, "both logical calls were captured");
    assert.equal(counts.succeeded, 0);
    assert.equal(counts.failed, 2);
    assert.equal(
      counts.failureBuckets?.execution_failed,
      1,
      "the allowlisted failure code survived",
    );
    assert.equal(
      counts.servedFromCache,
      1,
      "the cached-serve signal survived while its cacheKey did not",
    );
    assert.equal(counts.transportExecuted, 0);
    assert.deepEqual(
      counts.failureDetails?.map((detail) => detail.errorCode).sort(),
      ["execution_failed", "sandbox_prepare_rejected"],
      "typed causes are retained verbatim; their messages are not",
    );
    assert.ok(
      diagnostics.some((entry) => entry.toolName === "code_run"),
      "diagnostics still identify the failing tool",
    );
    assert.ok(
      everythingThatCrossed.includes("append_to_current_file"),
      "tool identity is allowed and must still be present",
    );
    // The readback's two identity digests are the ONE thing the projection may
    // carry beyond the verdict: they are hashes of content, and the cohort gate
    // needs them to tell 500 distinct deliveries from one stale snapshot. The
    // rest of the readback stays on the page.
    assert.equal(counts.writeReceipts, 1, "the append receipt is a written artifact");
    assert.ok(
      typeof counts.artifactIdentity === "string" && counts.artifactIdentity.startsWith("sha256:"),
      "the identity digests crossed and were hashed; until 2026-09-06 the projection dropped them",
    );
    for (const kept of ["checkedAt", "priorRevision", "fnv1a32:00000001"]) {
      assert.ok(!everythingThatCrossed.includes(kept), `${kept} must stay on the page`);
    }
  } finally {
    uninstallFakeRenderer();
    resetToolCallCollectorStateForTestsV1();
  }
});

test("normalization drops payload fields from every event source it accepts", () => {
  const metric = normalizeMissionToolEventV1(
    {
      kind: "tool",
      name: "web_fetch",
      step: 2,
      cached: true,
      cacheKey: `web_fetch:{"url":"${POISON.toolArgument}"}`,
      inputChars: 4096,
    },
    "metric",
  );
  assert.deepEqual(metric, {
    kind: "tool_execution",
    toolName: "web_fetch",
    step: 2,
    servedFromCache: true,
  });
  assert.doesNotMatch(JSON.stringify(metric), POISON_PATTERN);

  // A non-tool metric says nothing about a tool execution and must be dropped
  // rather than counted as a transport.
  assert.equal(
    normalizeMissionToolEventV1({ kind: "run", name: "mission", cached: false }, "metric"),
    null,
  );

  const receipt = normalizeMissionToolEventV1(
    {
      id: "receipt-1",
      toolName: "replace_current_file",
      operation: "replace",
      bytesWritten: 12,
      path: POISON.notePath,
      backupPath: POISON.backupPath,
      message: POISON.noteBody,
      output: POISON.providerPayload,
    },
    "receipt",
  );
  assert.doesNotMatch(JSON.stringify(receipt), POISON_PATTERN);
  assert.equal((receipt as any)?.receipt?.operation, "replace", "work signal retained");

  const done = normalizeMissionToolEventV1(
    {
      id: "1:0:code_run",
      name: "code_run",
      ok: false,
      message: POISON.command,
      output: POISON.command,
      error: { code: "invalid_arguments", message: POISON.command },
    },
    "tool_done",
  );
  assert.doesNotMatch(JSON.stringify(done), POISON_PATTERN);
  assert.equal((done as any)?.errorCode, "invalid_arguments", "typed cause retained");
});

/**
 * Source guard. Comments are stripped FIRST: this file and the collector both
 * name the forbidden fields in prose to explain why they are forbidden, and a
 * lexical check that cannot tell prose from code would either fire on the
 * explanation or be silently disabled to stop it firing. Both outcomes have
 * already happened in this repo.
 */
function sourceWithoutComments(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), "utf8")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/(^|[^:])\/\/.*$/gmu, "$1");
}

test("the collector's page-side code never reads a payload-bearing field", () => {
  const collector = sourceWithoutComments("e2e/fixtures/toolCallCollector.ts");
  // Positive proof the stripper left real code behind, so this test cannot
  // pass by having deleted everything it was supposed to inspect.
  assert.ok(
    collector.includes("subscribeMissionEvents") && collector.includes("onMetric"),
    "comment stripping must not remove the code under inspection",
  );
  for (const forbidden of [
    "cacheKey",
    "inputPreview",
    "outputPreview",
    "backupPath",
    "restoredFromBackupPath",
    "toPath",
  ]) {
    assert.ok(
      !collector.includes(forbidden),
      `the page-side projection must never read ${forbidden}`,
    );
  }
  // `path` and `message` are read in exactly one allowed place each: never in
  // the projected event objects. Assert the projection objects specifically.
  assert.doesNotMatch(
    collector,
    /push\(\{[^}]*\b(?:path|content|command|output|message)\s*:/su,
    "a projected event must not carry a path, content, command, output or message field",
  );
});

test("preserveFailureEvidence's metadata parameter is documented as caller-selected", () => {
  // The helper writes whatever it is handed, verbatim, to disk. It guarantees
  // WHEN a record exists, never WHAT is safe to put in it. Agent 1's bounded
  // private failed-program artifact rides on that distinction.
  const source = readFileSync(
    path.join(REPO_ROOT, "e2e/fixtures/preserveFailureEvidence.ts"),
    "utf8",
  );
  assert.match(
    source,
    /Callers select the evidence fields/u,
    "the helper must state that sanitization is the caller's duty, not its own",
  );
});
