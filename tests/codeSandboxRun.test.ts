import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import test from "node:test";
import type { Plugin } from "obsidian";
import type { PreparedActionV1, ScopedExtensionContextV1 } from "../packages/core-api/src";
import { CodeExtensionRuntimeV2 } from "../extensions/code/CodeExtensionRuntimeV2";
import type {HostSandboxDependenciesV1} from "../extensions/code/sandbox/SandboxDependencyPreludeV1";
import {
  CODE_SANDBOX_RUN_EMPTY_PLACEHOLDER_V1,
  CODE_SANDBOX_RUN_PROFILE_KEY_V1,
  type SandboxCommandRunnerV2,
} from "../extensions/code/sandbox";
import { WorkspaceManagerV2 } from "../extensions/code/workspaces";
import { serializeToolResultForModel } from "../src/model/toolResultPayload";
import {
  CODE_SANDBOX_RUN_GUARD_V1,
  boundCommandStreamV1,
  normalizeCodeCommandOutputBudgetCharsV1,
} from "../src/model/codeSandboxRunPayloadV1";
import { evaluateActionPolicy } from "../src/agent/policyEngine";
import type { PreparedAction, ToolDescriptor } from "../src/agent/actions";

/*
 * CODE-17's core half: `code_sandbox_run`, one program and its arguments in
 * the verified sandbox, over the real code runtime, workspace manager, durable
 * execution journal and sandbox manager, with a stand-in for the provider's
 * process. What it stages, what it refuses, what the model reads, and that it
 * always asks.
 */

const NOW = "2026-10-16T12:00:00.000Z";
const SHA = (character: string) => `sha256:${character.repeat(64)}`;
const RUN = "run-sandbox-command";

interface Ran {
  args: string[];
  staged: string[];
}

async function fixture(label: string, answer: { exitCode?: number; stdout?: string; stderr?: string } = {},hostSandboxDependencies?:(workspaceId:string)=>Promise<HostSandboxDependenciesV1|null>) {
  const root = await mkdtemp(path.join(tmpdir(), `code-sandbox-run-${label}-`));
  let tick = Date.parse(NOW);
  const now = () => new Date(tick += 10);
  const manager = new WorkspaceManagerV2({ applicationDataRoot: path.join(root, "app-data"), now });
  const ran: Ran[] = [];
  const sandboxRunner: SandboxCommandRunnerV2 = {
    async run(spec, options) {
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
            runtimeDigest: SHA("f"),
            stagingIsolated: true,
            resourceLimitsEnforced: true,
          }),
          stderr: "",
        };
      }
      ran.push({ args: [...spec.args], staged: (options?.stagedFiles ?? []).map((file) => file.path).sort() });
      return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "ok\n", stderr: answer.stderr ?? "" };
    },
  };
  const plugin = new MemoryPluginData({ schemaVersion: 1 });
  const runtime = new CodeExtensionRuntimeV2({
    plugin: plugin as unknown as Plugin,
    workspaceManager: manager,
    sandboxRunner,
    hostSandboxDependencies,
    now,
  });
  await runtime.initialize();
  await runtime.configureSandboxProvider({
    version: 1,
    kind: "docker",
    executable: "docker",
    priority: 10,
    runtimeReference: "registry.example/agentic-sandbox",
    runtimeDigest: SHA("f"),
    wslDistribution: null,
    runtimeRoot: null,
  });
  await runtime.probeConfiguredSandboxProviders();
  const tools = new Map(
    runtime.getContributions()
      .filter((item) => item.descriptor.kind === "tool")
      .map((item) => {
        const tool = (item as unknown as { tool: Record<string, any> }).tool;
        return [tool.name as string, tool] as const;
      }),
  );
  const context = (runId = RUN): ScopedExtensionContextV1 => ({
    version: 1,
    extensionId: "agentic-researcher-code",
    missionId: runId,
    rootMissionId: runId,
    operationId: `op-${tick}`,
    originalPrompt: "Run the failing test on its own.",
    abortSignal: new AbortController().signal,
    now,
    reportProgress() {},
  });
  const workspace = async (files: Record<string, string>, ownerRunId = RUN, workspaceId = "command-space") => {
    await manager.createScratchWorkspace({ workspaceId, ownerRunId });
    const lease = await manager.acquireLease(workspaceId, `extension:${ownerRunId}`);
    for (const [file, content] of Object.entries(files)) {
      const parent = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";
      if (parent) await manager.mkdir(workspaceId, lease.lease!.id, parent).catch(() => undefined);
      await manager.createFile(workspaceId, lease.lease!.id, file, content);
    }
    await manager.releaseLease(workspaceId, lease.lease!.id);
    return workspaceId;
  };
  const tool = tools.get("code_sandbox_run")!;
  const prepare = (args: Record<string, unknown>, ctx = context()) => tool.prepare(args, ctx) as Promise<
    { ok: true; action: PreparedActionV1 } | { ok: false; error: { code: string; message: string } }
  >;
  const execute = (action: PreparedActionV1, ctx = context()) =>
    tool.executePrepared(action, {
      ...ctx,
      authorizedAction: { preparedActionId: action.id, payloadFingerprint: action.payloadFingerprint, grantId: `grant-${action.id}` },
    }) as Promise<{ output: Record<string, any>; receipt: Record<string, any>; mutationState: string }>;
  return {
    root,
    manager,
    runtime,
    tool,
    ran,
    context,
    workspace,
    prepare,
    execute,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("a command is one prepared execution over the workspace as saved: it runs in the sandbox, network off, and its output comes back", async () => {
  const f = await fixture("lands", { exitCode: 1, stdout: "F\n1 failed in 0.02s\n", stderr: "AssertionError: 1 != 0\n" });
  try {
    const workspaceId = await f.workspace({
      "src/pager.py": "def offset(page, size):\n    return page * size + 1\n",
      "tests/test_pager.py": "from src.pager import offset\n\ndef test_zero():\n    assert offset(0, 10) == 0\n",
      "node_modules/left-pad/index.js": "module.exports = 1;\n",
    });
    assert.equal(f.tool.descriptor.effect, "execution");
    assert.equal(f.tool.descriptor.capability.resourceType, "code_execution");
    assert.equal(f.tool.descriptor.capability.action, "execute");
    assert.equal(f.tool.descriptor.approval.allowPersistentGrant, false);

    const prepared = await f.prepare({ workspaceId, argv: ["python3", "-m", "pytest", "-q", "tests/test_pager.py"] });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    const action = prepared.action;
    assert.equal(action.toolName, "code_sandbox_run");
    assert.equal(action.target.resourceType, "code_execution");
    assert.equal(action.target.workspaceId, workspaceId);
    assert.equal(action.preview.summary, "Run python3 -m pytest -q tests/test_pager.py in the verified docker sandbox");
    assert.equal(action.preview.outboundPayload?.command, "python3 -m pytest -q tests/test_pager.py");
    assert.equal(action.preview.outboundPayload?.program, "python3");
    assert.equal(action.preview.outboundPayload?.cwd, ".");
    assert.equal(action.preview.outboundPayload?.timeoutSeconds, 120);
    assert.equal(action.preview.outboundPayload?.networkMode, "disabled");
    assert.equal(action.preview.outboundPayload?.stagedFiles, 2, "dependency folders are left out");
    const sandboxAction = (action.normalizedArgs as Record<string, any>).sandboxAction;
    assert.equal(sandboxAction.profileKey, CODE_SANDBOX_RUN_PROFILE_KEY_V1);
    assert.equal(sandboxAction.purpose, "code_block");
    assert.deepEqual(sandboxAction.command, { executable: "python3", args: ["-m", "pytest", "-q", "tests/test_pager.py"], cwd: ".", timeoutMs: 120_000 });
    assert.deepEqual(sandboxAction.expectedArtifacts, []);
    assert.equal(sandboxAction.network.mode, "disabled");
    assert.equal(f.ran.length, 0, "preparing runs nothing");

    // It always asks: an execution is never passed under write autonomy.
    const decision = evaluateActionPolicy({
      toolName: "code_sandbox_run",
      descriptor: f.tool.descriptor as ToolDescriptor,
      preparedAction: action as unknown as PreparedAction,
      principal: "single_agent",
      scopeAllowed: true,
      isDesktop: true,
      writeAutonomy: true,
      now: new Date(Date.parse(action.preparedAt) + 1_000),
    });
    assert.equal(decision.action, "require_approval");

    const result = await f.execute(action);
    assert.equal(result.mutationState, "applied");
    assert.equal(f.ran.length, 1);
    assert.deepEqual(f.ran[0]!.staged, ["src/pager.py", "tests/test_pager.py"]);
    assert.equal(result.output.status, "failed");
    assert.equal(result.output.exitCode, 1);
    assert.equal(result.output.command, "python3 -m pytest -q tests/test_pager.py");
    assert.equal(result.output.trust, "untrusted_sandbox_output");
    assert.match(result.output.stdout, /1 failed/u);
    assert.match(result.output.stderr, /AssertionError/u);
    assert.equal(result.receipt.operation, "execute");
    // Nothing came back into the workspace.
    assert.deepEqual(
      (await f.manager.listMetadata(workspaceId, "")).map((entry) => entry.path).sort(),
      ["node_modules", "src", "tests"],
    );

    // What the model reads: the command, its exit code, time and output, fenced as untrusted.
    const serialized = serializeToolResultForModel({ ok: true, toolName: "code_sandbox_run", output: result.output });
    const envelope = JSON.parse(serialized) as Record<string, any>;
    assert.equal(envelope.trust, "untrusted_external_content");
    assert.equal(envelope.guard, CODE_SANDBOX_RUN_GUARD_V1);
    assert.deepEqual(Object.keys(envelope).slice(0, 4), ["toolName", "status", "trust", "guard"]);
    assert.match(envelope.summary, /^python3 -m pytest -q tests\/test_pager\.py exited 1 after /u);
    assert.equal(envelope.output.exitCode, 1);
    assert.match(envelope.output.stdout, /1 failed/u);
    assert.equal("sandboxReceipt" in envelope.output, false);

    // Reconcile proves the run from the durable journal.
    const reconciled = await f.tool.reconcile(action, f.context());
    assert.equal(reconciled.outcome, "committed");
  } finally {
    await f.cleanup();
  }
});

test("a shell, an install, a folder outside the workspace and a long limit are refused before anything is prepared", async () => {
  const f = await fixture("refusals");
  try {
    const workspaceId = await f.workspace({ "main.py": "print(1)\n" });
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ argv: ["sh", "-c", "python3 main.py"] }, "command_program"],
      [{ argv: ["bash", "run.sh"] }, "command_program"],
      [{ argv: ["/usr/bin/python3", "main.py"] }, "command_program"],
      [{ argv: ["npm", "install"] }, "command_install"],
      [{ argv: ["python3", "-m", "pip", "install", "requests"] }, "command_install"],
      [{ argv: ["python3", "-m", "unittest", "-v"] }, "command_sandbox_argument"],
      [{ argv: ["python3", "main.py"], cwd: "../outside" }, "command_cwd"],
      [{ argv: ["python3", "main.py"], cwd: ".git" }, "command_cwd"],
      [{ argv: ["python3", "main.py"], timeoutSeconds: 601 }, "command_timeout"],
      [{ argv: [] }, "command_empty"],
      [{ argv: ["python3", "main.py"], shell: true }, "invalid_arguments"],
    ];
    for (const [args, code] of cases) {
      const prepared = await f.prepare({ workspaceId, ...args });
      assert.equal(prepared.ok, false, JSON.stringify(args));
      if (!prepared.ok) assert.equal(prepared.error.code, code, JSON.stringify(args));
    }
    assert.equal(f.ran.length, 0);
    // Another run's workspace is not this run's to run commands in.
    const foreign = await f.workspace({ "main.py": "print(2)\n" }, "run-someone-else", "foreign-space");
    const refused = await f.prepare({ workspaceId: foreign, argv: ["python3", "main.py"] });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.equal(refused.error.code, "workspace_owner_mismatch");
  } finally {
    await f.cleanup();
  }
});

test("an empty workspace stages one placeholder, so python3 -c still runs; a file changed after approval stops the run", async () => {
  const f = await fixture("staging", { stdout: "2\n" });
  try {
    const empty = await f.workspace({}, RUN, "empty-space");
    const prepared = await f.prepare({ workspaceId: empty, argv: ["python3", "-c", "print(1+1)"] });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    const ran = await f.execute(prepared.action);
    assert.deepEqual(f.ran[0]!.staged, [CODE_SANDBOX_RUN_EMPTY_PLACEHOLDER_V1]);
    assert.equal(ran.output.staged, 0);
    assert.equal(ran.output.exitCode, 0);

    const workspaceId = await f.workspace({ "main.py": "print(1)\n" });
    const again = await f.prepare({ workspaceId, argv: ["python3", "main.py"] });
    assert.equal(again.ok, true);
    if (!again.ok) return;
    const lease = await f.manager.acquireLease(workspaceId, "person:code-page-editor");
    const before = await f.manager.read(workspaceId, "main.py");
    await f.manager.writeExpected(workspaceId, lease.lease!.id, "main.py", "print(2)\n", before.sha256);
    await f.manager.releaseLease(workspaceId, lease.lease!.id);
    await assert.rejects(f.execute(again.action), /changed after this command was prepared|changed after the command was prepared/u);
    assert.equal(f.ran.length, 1, "the changed workspace did not run");
  } finally {
    await f.cleanup();
  }
});

test("a workspace too large to stage whole is staged from the working folder, and the approval and the answer say so", async () => {
  const f = await fixture("large");
  try {
    const workspaceId = await f.workspace({ "pkg/test_one.py": "def test_one():\n    assert True\n" });
    // A checkout this size is files on disk, not changes the workspace made.
    const rootDir = (await f.manager.loadManifest(workspaceId)).canonicalRoot;
    await mkdir(path.join(rootDir, "data"));
    for (let index = 0; index < 100; index += 1) {
      await writeFile(path.join(rootDir, "data", `file-${String(index).padStart(3, "0")}.txt`), `${index}\n`, "utf8");
    }
    const whole = await f.prepare({ workspaceId, argv: ["python3", "-m", "pytest", "-q"] });
    assert.equal(whole.ok, false, "the root cannot be staged whole");
    if (!whole.ok) assert.equal(whole.error.code, "sandbox_staging_too_large");
    const prepared = await f.prepare({ workspaceId, argv: ["python3", "-m", "pytest", "-q"], cwd: "pkg" });
    assert.equal(prepared.ok, true, JSON.stringify(prepared));
    if (!prepared.ok) return;
    assert.equal(prepared.action.preview.outboundPayload?.stagedFiles, 1);
    assert.match(prepared.action.preview.warnings.join(" "), /Only pkg was staged/u);
    const result = await f.execute(prepared.action);
    assert.deepEqual(f.ran[0]!.staged, ["pkg/test_one.py"]);
    assert.match(result.output.notes.join(" "), /Only pkg was staged/u);
    const envelope = JSON.parse(serializeToolResultForModel({ ok: true, toolName: "code_sandbox_run", output: result.output }));
    assert.match(envelope.output.notes.join(" "), /Only pkg was staged/u);
  } finally {
    await f.cleanup();
  }
});

test("a run the sandbox stops at its limit says so, without the sandbox's marker", async () => {
  const f = await fixture("timeout", { exitCode: 124, stdout: "", stderr: "still going\nsandbox_timeout=true" });
  try {
    const workspaceId = await f.workspace({ "loop.py": "while True: pass\n" });
    const prepared = await f.prepare({ workspaceId, argv: ["python3", "loop.py"], timeoutSeconds: 5 });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const result = await f.execute(prepared.action);
    assert.equal(result.output.timedOut, true);
    assert.equal(result.output.stderr.includes("sandbox_timeout"), false);
    const envelope = JSON.parse(serializeToolResultForModel({ ok: true, toolName: "code_sandbox_run", output: result.output }));
    assert.match(envelope.summary, /reached its time limit/u);
    assert.equal(envelope.output.timedOut, true);
  } finally {
    await f.cleanup();
  }
});

test("each stream is bounded by the run's option: its start and its end, with the gap said", () => {
  assert.equal(normalizeCodeCommandOutputBudgetCharsV1(undefined), 2_400);
  assert.equal(normalizeCodeCommandOutputBudgetCharsV1(60_000), 12_000);
  assert.equal(normalizeCodeCommandOutputBudgetCharsV1(10), 800);
  const long = Array.from({ length: 2_000 }, (_, index) => `line ${index}`).join("\n");
  const cut = boundCommandStreamV1(long, 2_400);
  assert.ok(cut.text.startsWith("line 0\n"));
  assert.ok(cut.text.endsWith("line 1999"));
  assert.match(cut.text, /characters left out/u);
  assert.equal(cut.leftOut, long.length - 2_400);
  const output = {
    status: "failed",
    operation: "sandbox_run",
    workspaceId: "w",
    command: "node -e x",
    cwd: ".",
    exitCode: 1,
    durationMs: 1_200,
    stdout: long,
    stderr: "",
    truncated: false,
    redactedLines: 0,
  };
  const guided = JSON.parse(serializeToolResultForModel({ ok: true, toolName: "code_sandbox_run", output }));
  const free = JSON.parse(serializeToolResultForModel(
    { ok: true, toolName: "code_sandbox_run", output },
    { codeCommandOutputBudgetChars: 12_000 },
  ));
  assert.ok(guided.output.stdout.length < 2_600, String(guided.output.stdout.length));
  assert.ok(free.output.stdout.length > 11_000, String(free.output.stdout.length));
  assert.equal(guided.truncated, true);
  assert.equal(guided.trust, "untrusted_external_content");
});

function approvedDependencies():HostSandboxDependenciesV1{return{fingerprint:SHA('d'),node:'__rap_dependencies__/node.cjs',python:'__rap_dependencies__/python.py',files:[{path:'__rap_dependencies__/node.cjs',bytes:new TextEncoder().encode('/* app-owned synthetic installer */')},{path:'__rap_dependencies__/python.py',bytes:new TextEncoder().encode('# app-owned synthetic installer')}]};}

test("host-approved dependency preludes bind fresh command staging and reject changed or missing approval before dispatch",async()=>{
 let dependencies:HostSandboxDependenciesV1|null=approvedDependencies(),lookups=0;const f=await fixture('dependency-command',{},async()=>{lookups++;return dependencies;});
 try{
  const workspaceId=await f.workspace({'main.js':'console.log(42)'});
  const invented=await f.prepare({workspaceId,argv:['node','main.js'],hostDependencies:approvedDependencies()});assert.equal(invented.ok,false);assert.equal(lookups,0);
  const prepared=await f.prepare({workspaceId,argv:['node','main.js']});assert.equal(prepared.ok,true,JSON.stringify(prepared));if(!prepared.ok)return;
  const action=(prepared.action.normalizedArgs as any).sandboxAction;assert.equal(action.command.executable,'node');assert.equal(action.command.args[0],dependencies.node);assert.equal(action.network.mode,'disabled');assert.deepEqual(action.expectedArtifacts,[]);assert.equal(action.stagingManifest.length,3);
  const completed=await f.execute(prepared.action);assert.equal(completed.mutationState,'applied');assert.equal(f.ran.length,1);assert.deepEqual(f.ran[0]!.staged,['__rap_dependencies__/node.cjs','__rap_dependencies__/python.py','main.js']);
  const again=await f.prepare({workspaceId,argv:['node','main.js']});assert.equal(again.ok,true);if(!again.ok)return;
  dependencies.files[0].bytes[0]=42;await assert.rejects(f.execute(again.action),/dependency files changed/u);assert.equal(f.ran.length,1);
  dependencies=null;await assert.rejects(f.runtime.resolveSandboxCommandExecutionInput(action,f.context()),/no longer approved/u);assert.equal(f.ran.length,1);
 }finally{await f.cleanup();}
});

test("fresh validation uses the same host prelude without treating app-owned files as mutable source",async()=>{
 let dependencies=approvedDependencies();const f=await fixture('dependency-validation',{},async()=>dependencies);
 try{
  const workspaceId=await f.workspace({'main.py':'print(42)'}),prepared=await f.runtime.resolveSandboxPreparationInput('validation_fast',workspaceId,f.context()),command=prepared.profile.validationCatalog.find(command=>command.id===prepared.commandId)!;
  assert.equal(command.executable,'python3');assert.deepEqual(command.args.slice(0,4),['-I',dependencies.python,'--execute',dependencies.fingerprint]);
  const action={...prepared,purpose:'validation_fast',profileKey:prepared.profile.key,command:{executable:command.executable,args:command.args,cwd:command.cwd,timeoutMs:command.timeoutMs},expectedArtifacts:[]} as any;
  const staged=await f.runtime.resolveSandboxExecutionInput(action,f.context());assert.equal(staged.stagedFiles.length,3);assert.ok(staged.stagedFiles.some(file=>file.path==='main.py'));
  dependencies={...dependencies,fingerprint:SHA('e')};await assert.rejects(f.runtime.resolveSandboxExecutionInput(action,f.context()),/current approved command/u);
 }finally{await f.cleanup();}
});

test("source collisions and a host prelude outside its reserved folder are refused without expanding the boundary",async()=>{
 let dependencies=approvedDependencies();const f=await fixture('dependency-collision',{},async()=>dependencies);
 try{
  const workspaceId=await f.workspace({'main.js':'console.log(42)','__rap_dependencies__/node.cjs':'untrusted source'});
  const collision=await f.prepare({workspaceId,argv:['node','main.js']});assert.equal(collision.ok,false);if(!collision.ok)assert.equal(collision.error.code,'sandbox_prepare_rejected_by_manager');
  assert.equal((await f.manager.read(workspaceId,'__rap_dependencies__/node.cjs')).content,'untrusted source');
  dependencies={...dependencies,files:[...dependencies.files,{path:'outside.txt',bytes:new Uint8Array([1])}]};const outside=await f.prepare({workspaceId,argv:['node','main.js']});assert.equal(outside.ok,false);assert.equal(f.ran.length,0);
 }finally{await f.cleanup();}
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
