import assert from "node:assert/strict";
import test from "node:test";
import { createDefaultToolRegistry } from "../src/tools/createToolRegistry";
import { evaluateActionPolicy } from "../src/agent/policyEngine";
import type { ResearchMemoryIndexEntry, ToolExecutionContext } from "../src/tools/types";

function fixture() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  let index: ResearchMemoryIndexEntry[] = [];
  let beforeProcess: (() => void) | undefined;
  let failIndex = false;
  const getFile = (path: string) => files.has(path) ? { path, extension: "md" } : null;
  const context = {
    runId: "memory-segment", rootMissionId: "memory-root", nodeId: "memory-node", operationId: "memory-call",
    originalPrompt: "Save this to research memory.",
    settings: { researchMemoryEnabled: true },
    now: () => new Date("2026-09-05T10:00:00Z"),
    getResearchMemoryIndex: () => index,
    setResearchMemoryIndex: async (value: ResearchMemoryIndexEntry[]) => {
      if (failIndex) throw new Error("Lost response after note write");
      index = value;
    },
    app: { vault: {
      getFileByPath: getFile,
      getAbstractFileByPath: (path: string) => getFile(path) ?? (folders.has(path) ? { path } : null),
      getFolderByPath: (path: string) => folders.has(path) ? { path } : null,
      createFolder: async (path: string) => { folders.add(path); },
      read: async (file: { path: string }) => files.get(file.path)!,
      create: async (path: string, text: string) => {
        if (files.has(path)) throw new Error("File already exists");
        files.set(path, text); return getFile(path)!;
      },
      modify: async () => { throw new Error("Non-atomic note mutation"); },
      process: async (file: { path: string }, transform: (text: string) => string) => {
        beforeProcess?.(); beforeProcess = undefined;
        const result = transform(files.get(file.path)!);
        files.set(file.path, result); return result;
      },
    } },
  } as unknown as ToolExecutionContext;
  const registry = createDefaultToolRegistry();
  const call = { name: "append_research_memory", arguments: { topic: "Convergence", text: "Durable memory evidence.", keywords: ["merge"] } };
  const prepare = async () => {
    const prepared = await registry.prepare!(call, context);
    assert.ok(prepared.ok, JSON.stringify(prepared));
    return prepared.action;
  };
  return { files, context, registry, call, prepare, get index() { return index; },
    beforeProcess: (hook: () => void) => { beforeProcess = hook; },
    failIndex: (value: boolean) => { failIndex = value; },
  };
}

function authorize(action: Awaited<ReturnType<ReturnType<typeof fixture>["prepare"]>>) {
  return { preparedActionId: action.id, payloadFingerprint: action.payloadFingerprint, grantId: "exact-memory-grant" };
}

test("memory append requires a sealed action and exact non-read authority", async () => {
  const f = fixture();
  assert.equal((await f.registry.execute(f.call, f.context)).error?.code, "prepared_action_required");
  const action = await f.prepare();
  assert.equal(f.files.size, 0);
  assert.equal(action.runId, "memory-segment");
  assert.equal((await f.registry.executePrepared!(action, f.context)).error?.code, "authorization_required");
  assert.equal((await f.registry.executePrepared!(action, f.context, { ...authorize(action), grantId: "policy:scoped-read" })).error?.code, "authorization_scope_mismatch");
  const result = await f.registry.executePrepared!(action, f.context, authorize(action));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.mutationState, "applied");
  assert.equal(result.receipt?.grantId, "exact-memory-grant");
  assert.equal(result.receipt?.readback.status, "verified");
  assert.equal(result.receipt?.payloadFingerprint, action.payloadFingerprint);
  assert.equal(result.receipt?.effects?.bytesWritten, Buffer.byteLength(f.files.get(action.target.path!)!));
  assert.equal(f.index.length, 1);
});

test("atomic memory append preserves an edit made immediately before its transformation", async () => {
  const f = fixture();
  const action = await f.prepare();
  const path = action.target.path!;
  f.files.set(path, "User note");
  f.beforeProcess(() => f.files.set(path, "User note\nIntervening user edit"));
  const result = await f.registry.executePrepared!(action, f.context, authorize(action));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(f.files.get(path)!.startsWith("User note\nIntervening user edit\n"));
  assert.ok(f.files.get(path)!.includes(f.call.arguments.text));
});

test("lost response after memory write reconciles the note and derived index without a second append", async () => {
  const f = fixture();
  const action = await f.prepare();
  f.failIndex(true);
  assert.equal((await f.registry.executePrepared!(action, f.context, authorize(action))).ok, false);
  const written = f.files.get(action.target.path!);
  assert.ok(written?.includes(f.call.arguments.text));
  f.failIndex(false);
  const reconciled = await f.registry.reconcile!(action, { ...f.context, authorizedAction: authorize(action) });
  assert.equal(reconciled.outcome, "committed", JSON.stringify(reconciled));
  assert.equal(reconciled.receipt?.commitKind, "reconciled");
  assert.equal(f.index.length, 1);
  assert.equal(f.files.get(action.target.path!), written);
  const replay = await f.registry.executePrepared!(action, f.context, authorize(action));
  assert.equal(replay.ok, true, JSON.stringify(replay));
  assert.equal(replay.receipt?.commitKind, "no_op");
  assert.equal(replay.receipt?.effects?.bytesWritten, 0);
  assert.equal(f.files.get(action.target.path!), written);
  assert.equal(f.index[0].updateCount, 1);
});

test("a stale memory index cannot certify missing note content or an ambiguous post-write edit", async () => {
  const f = fixture();
  const action = await f.prepare();
  assert.equal((await f.registry.reconcile!(action, f.context)).outcome, "not_applied");
  await f.registry.executePrepared!(action, f.context, authorize(action));
  f.files.set(action.target.path!, "User replaced the memory note.");
  assert.equal((await f.registry.reconcile!(action, f.context)).outcome, "still_uncertain");
  const retry = await f.prepare();
  const result = await f.registry.executePrepared!(retry, f.context, authorize(retry));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.receipt?.effects?.changed, true);
  assert.ok(f.files.get(action.target.path!)!.startsWith("User replaced the memory note."));
});

test("prepared memory keeps the gather exception without bypassing scope or exact authority", async () => {
  const f = fixture();
  const action = await f.prepare();
  const context = {
    toolName: action.toolName, descriptor: f.registry.getDescriptor!(action.toolName), preparedAction: action,
    principal: "single_agent" as const, scopeAllowed: true, isDesktop: true, writeAutonomy: true,
    researchPhase: { researchBearing: true, phase: "gather" as const, writeToolsAllowed: false,
      reason: "Gathering evidence", acceptanceAllowed: false, gatherComplete: false, analyzeComplete: false },
    now: f.context.now!(),
  };
  assert.equal(evaluateActionPolicy(context).action, "allow");
  assert.equal(evaluateActionPolicy({ ...context, scopeAllowed: false }).action, "block");
  assert.equal(evaluateActionPolicy({ ...context, writeAutonomy: false }).action, "require_approval");
  assert.equal(evaluateActionPolicy({ ...context, preparedAction: null }).action, "block");
});
