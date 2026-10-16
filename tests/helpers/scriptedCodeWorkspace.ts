import { createHash } from "node:crypto";
import { withPreparedActionFingerprint } from "../../src/agent/actions/canonicalize";
import type {
  ActionReceipt,
  PreparedAction,
  ResourceRef,
  ToolDescriptor,
} from "../../src/agent/actions/types";
import type { JsonSchemaObject } from "../../src/model/types";
import type { AgentTool, ToolExecutionContext } from "../../src/tools/types";
import {
  describeUnifiedPatchFileV1,
  parseUnifiedPatchV1,
  planUnifiedPatchFileV1,
} from "../../extensions/code/workspaces/UnifiedPatchV1";

/*
 * A small code workspace held in memory, with the code tools a coding pass
 * calls. Every write is a prepared, fingerprinted action whose receipt names
 * the workspace file, as the real workspace tools' receipts do; validations
 * run a caller-supplied check over the files and answer as the sandbox tools
 * answer (a status, a validation receipt with its failure fingerprint); the
 * commit is prepared only after a passing fast cycle and a targeted and a full
 * validation of the files as they are now. It stands in for the code
 * extension so a runner test can drive a whole pass without a sandbox or Git.
 */

export type ScriptedValidationKind = "fast" | "targeted" | "full";

export interface ScriptedValidation {
  id: string;
  kind: ScriptedValidationKind;
  status: "passed" | "failed";
  failureFingerprint: string | null;
  diagnostic: string;
  contentFingerprint: string;
  order: number;
}

export interface ScriptedCodeWorkspaceState {
  workspaceId: string | null;
  files: Map<string, string>;
  /** Tool names in the order they ran (prepared actions once executed). */
  executed: string[];
  validations: ScriptedValidation[];
  passedFastCycle: boolean;
  commits: Array<{ commitSha: string; contentFingerprint: string }>;
  /** The argv of each `code_sandbox_run` that ran. */
  commands: string[][];
}

export interface ScriptedCodeWorkspaceOptions {
  now: () => Date;
  files: Record<string, string>;
  /** Decides each validation from the files as they are when it runs. */
  check: (
    files: ReadonlyMap<string, string>,
    kind: ScriptedValidationKind,
  ) => { passed: boolean; diagnostic: string };
  workspaceId?: string;
  profileKey?: string;
  /**
   * Answer as the real tools do where validation recovery reads them: a failed
   * validation carries the sandbox's diagnostic excerpt, an edit its mutation
   * receipt, and the workspace its repository write scope.
   */
  diagnosticExcerpts?: boolean;
  /** What a `code_sandbox_run` program prints, from its argv and the files. */
  command?: (
    argv: readonly string[],
    files: ReadonlyMap<string, string>,
  ) => { exitCode: number; stdout: string; stderr: string };
  /**
   * Protected repository controls by path (a file, or a folder covering what
   * is under it) and the confirmations a change to one asks for, as the real
   * tool's classification sets them: 1 for an exact-diff control (a manifest,
   * a lockfile), 2 for a double-exact one (a workflow, a hook). A prepared
   * write that touches one carries that `requiredConfirmations`, the
   * `requiresProfileRedetection` mark and a warning; any other carries one
   * confirmation, as every real code workspace write does.
   */
  protectedControls?: Record<string, 1 | 2>;
}

const sha = (value: string): string =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function contentFingerprint(files: ReadonlyMap<string, string>): string {
  return sha(
    JSON.stringify(
      [...files.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

const READ_POLICY = {
  approval: { allowPromptGrant: true, allowPersistentGrant: true, fallback: "none" as const },
  execution: { preparation: "none" as const, desktopOnly: true, cacheable: false, parallelSafe: true },
  durability: { journal: false, receipt: false, readback: "none" as const, reconciliation: "none" as const },
};

function readDescriptor(name: string, resourceType: string, action: "read" | "list" | "search" = "read"): ToolDescriptor {
  return {
    version: 1,
    name,
    capability: { system: "workspace", resourceType, action },
    effect: "read",
    risk: "low",
    ...READ_POLICY,
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
  };
}

function preparedDescriptor(input: {
  name: string;
  system?: "workspace" | "git";
  resourceType: string;
  action: ToolDescriptor["capability"]["action"];
  effect: ToolDescriptor["effect"];
  receiptKind: NonNullable<ToolDescriptor["receiptKind"]>;
  allowPersistentGrant?: boolean;
}): ToolDescriptor {
  return {
    version: 1,
    name: input.name,
    capability: {
      system: input.system ?? "workspace",
      resourceType: input.resourceType,
      action: input.action,
    },
    effect: input.effect,
    risk: input.effect === "destructive_mutation" ? "high" : "medium",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: input.allowPersistentGrant ?? true,
      fallback: "exact",
    },
    execution: { preparation: "required", desktopOnly: true, cacheable: false, parallelSafe: false },
    durability: { journal: true, receipt: true, readback: "required", reconciliation: "required" },
    allowedPrincipals: ["host", "single_agent", "lead", "code_worker"],
    receiptKind: input.receiptKind,
  };
}

const looseSchema = (properties: Record<string, unknown>): JsonSchemaObject => ({
  type: "object",
  properties: properties as JsonSchemaObject["properties"],
  additionalProperties: true,
});

export function createScriptedCodeWorkspace(options: ScriptedCodeWorkspaceOptions): {
  tools: AgentTool[];
  state: ScriptedCodeWorkspaceState;
} {
  const state: ScriptedCodeWorkspaceState = {
    workspaceId: null,
    files: new Map(Object.entries(options.files)),
    executed: [],
    validations: [],
    passedFastCycle: false,
    commits: [],
    commands: [],
  };
  const defaultWorkspaceId = options.workspaceId ?? "code-pager-1";
  const profileKey = options.profileKey ?? "pager-repo";
  let sequence = 0;
  const nextId = (prefix: string) => `${prefix}-${++sequence}`;
  const workspaceOf = (args: Record<string, unknown>): string =>
    state.workspaceId ??
    (typeof args.workspaceId === "string" && args.workspaceId.trim()
      ? args.workspaceId
      : defaultWorkspaceId);
  const resource = (workspaceId: string, path: string): ResourceRef => ({
    system: "workspace",
    resourceType: "code_workspace",
    id: `${workspaceId}:${path}`,
    workspaceId,
    path,
  });
  const nowIso = () => options.now().toISOString();
  /** The confirmations the protected controls a change touches ask for, if any. */
  const protectionOf = (paths: readonly string[]): 1 | 2 | undefined => {
    let level: 0 | 1 | 2 = 0;
    for (const [control, confirmations] of Object.entries(options.protectedControls ?? {})) {
      if (paths.some((path) => path === control || path.startsWith(`${control}/`))) {
        level = Math.max(level, confirmations) as 1 | 2;
      }
    }
    return level === 0 ? undefined : level;
  };

  const prepare = async (
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
    target: ResourceRef,
    summary: string,
    after?: Record<string, string>,
    protection?: 1 | 2,
  ): Promise<{ ok: true; action: PreparedAction }> => {
    const id = nextId(`action-${name}`);
    const normalizedArgs = JSON.parse(JSON.stringify(args));
    if (protection) normalizedArgs.requiresProfileRedetection = true;
    return {
      ok: true,
      action: await withPreparedActionFingerprint({
        version: 1,
        id,
        runId: context.runId ?? "scripted-run",
        toolCallId: `${id}-call`,
        toolName: name,
        target,
        relatedResources: [],
        normalizedArgs,
        preview: {
          summary,
          destination: target.id,
          warnings: protection
            ? [`Protected repository control(s) require ${protection === 2 ? "double-exact" : "exact-diff"} approval and profile re-detection.`]
            : [],
          outboundBytes: 0,
          ...(after ? { after } : {}),
        },
        ...(options.protectedControls ? { requiredConfirmations: protection ?? 1 } : {}),
        idempotencyKey: id,
        preparedAt: nowIso(),
        expiresAt: new Date(options.now().getTime() + 10 * 60_000).toISOString(),
      }),
    };
  };
  const receiptFor = (
    action: PreparedAction,
    context: ToolExecutionContext,
    operation: ActionReceipt["operation"],
    message: string,
  ): ActionReceipt => ({
    version: 1,
    id: `receipt-${action.id}`,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation,
    resource: action.target,
    message,
    payloadFingerprint: action.payloadFingerprint,
    grantId: context.authorizedAction?.grantId ?? "scripted-grant",
    idempotencyKey: action.idempotencyKey,
    startedAt: nowIso(),
    committedAt: nowIso(),
    commitKind: "committed",
    readback: { status: "verified", checkedAt: nowIso() },
    effects: { affectedCount: 1 },
  });

  const read = (
    name: string,
    resourceType: string,
    execute: (args: Record<string, unknown>) => unknown,
    action: "read" | "list" | "search" = "read",
  ): AgentTool => ({
    name,
    description: `Scripted ${name}.`,
    parameters: looseSchema({ workspaceId: { type: "string" }, path: { type: "string" } }),
    descriptor: readDescriptor(name, resourceType, action),
    async execute(args) {
      state.executed.push(name);
      return execute(args);
    },
  });

  const write = (input: {
    name: string;
    action: ToolDescriptor["capability"]["action"];
    effect?: ToolDescriptor["effect"];
    operation: string;
    apply: (args: Record<string, unknown>) => { path: string; output?: Record<string, unknown> };
    pathOf: (args: Record<string, unknown>) => string;
    /** What the prepared action names as its kind of change, as the real tool does. */
    after?: (args: Record<string, unknown>) => Record<string, string>;
    /** Every path the change touches, when it is more than `pathOf`'s one. */
    pathsOf?: (args: Record<string, unknown>) => string[];
  }): AgentTool => ({
    name: input.name,
    description: `Scripted ${input.name}.`,
    parameters: looseSchema({ workspaceId: { type: "string" }, path: { type: "string" } }),
    descriptor: preparedDescriptor({
      name: input.name,
      resourceType: "code_workspace",
      action: input.action,
      effect: input.effect ?? "reversible_mutation",
      receiptKind: "code_change",
      allowPersistentGrant: input.effect !== "destructive_mutation",
    }),
    async execute() {
      return { status: "blocked", code: "prepared_action_required" };
    },
    prepare: async (args, context) =>
      prepare(
        input.name,
        args,
        context,
        resource(workspaceOf(args), input.pathOf(args)),
        `${input.operation} ${input.pathOf(args)}`,
        input.after?.(args),
        protectionOf(input.pathsOf?.(args) ?? [input.pathOf(args)]),
      ),
    async executePrepared(action, context) {
      const args = action.normalizedArgs as Record<string, unknown>;
      const before = state.files.get(input.pathOf(args));
      const applied = input.apply(args);
      state.executed.push(input.name);
      const after = state.files.get(applied.path);
      // The manager's own mutation receipt, which validation recovery reads to
      // know which file an edit changed, when the run asks for it.
      const mutation = options.diagnosticExcerpts && after !== undefined
        ? {
            receipt: {
              version: 2,
              path: applied.path,
              beforeSha256: before === undefined ? null : sha(before),
              afterSha256: sha(after),
            },
          }
        : {};
      const receipt = receiptFor(action, context, input.action, `${input.operation} ${applied.path}`);
      return {
        mutationState: "applied",
        output: { status: "ok", operation: input.operation, path: applied.path, ...applied.output, ...mutation },
        receipt: "receipt" in mutation
          ? { ...receipt, readback: { ...receipt.readback, observedRevision: sha(after!) } }
          : receipt,
      };
    },
  });

  const validation = (kind: ScriptedValidationKind): AgentTool => {
    const name = `code_validate_${kind}`;
    return {
      name,
      description: `Scripted ${kind} validation.`,
      parameters: looseSchema({ workspaceId: { type: "string" }, profileKey: { type: "string" } }),
      descriptor: preparedDescriptor({
        name,
        resourceType: "validation_run",
        action: "validate",
        effect: "execution",
        receiptKind: "artifact",
      }),
      async execute() {
        return { status: "blocked", code: "prepared_sandbox_action_required" };
      },
      prepare: async (args, context) =>
        prepare(name, args, context, {
          system: "workspace",
          resourceType: "validation_run",
          id: `${workspaceOf(args)}:${kind}`,
          workspaceId: workspaceOf(args),
        }, `Run ${kind} validation`),
      async executePrepared(action, context) {
        const verdict = options.check(state.files, kind);
        const record: ScriptedValidation = {
          id: nextId(`validation-${kind}`),
          kind,
          status: verdict.passed ? "passed" : "failed",
          failureFingerprint: verdict.passed ? null : sha(`${kind}:${verdict.diagnostic}`),
          diagnostic: verdict.diagnostic,
          contentFingerprint: contentFingerprint(state.files),
          order: state.validations.length,
        };
        state.validations.push(record);
        state.executed.push(name);
        return {
          mutationState: "applied",
          output: {
            status: record.status,
            kind,
            diagnostic: verdict.diagnostic,
            // The sandbox's own excerpt, as a real validation answers, when asked for.
            ...(options.diagnosticExcerpts && record.status === "failed"
              ? { validationDiagnosticExcerpt: { version: 1, stdout: "", stderr: verdict.diagnostic, truncated: false, redactedLines: 0 } }
              : {}),
            validationReceipt: {
              id: record.id,
              kind,
              status: record.status,
              failureFingerprint: record.failureFingerprint,
            },
          },
          receipt: receiptFor(action, context, "validate", `${kind} validation ${record.status}`),
        };
      },
    };
  };

  const latest = (kind: ScriptedValidationKind) =>
    [...state.validations].reverse().find((entry) => entry.kind === kind) ?? null;

  const tools: AgentTool[] = [
    read("code_sandbox_status", "sandbox_status", () => ({
      status: "available",
      executionAvailable: true,
      editingAvailable: true,
    })),
    {
      name: "code_workspace_create",
      description: "Scripted workspace create.",
      parameters: looseSchema({ workspaceId: { type: "string" }, kind: { type: "string" } }),
      descriptor: preparedDescriptor({
        name: "code_workspace_create",
        resourceType: "code_workspace",
        action: "create",
        effect: "reversible_mutation",
        receiptKind: "code_change",
      }),
      async execute() {
        return { status: "blocked", code: "prepared_action_required" };
      },
      prepare: async (args, context) => {
        const workspaceId = workspaceOf(args);
        return prepare("code_workspace_create", args, context, resource(workspaceId, workspaceId), `Create ${workspaceId}`);
      },
      async executePrepared(action, context) {
        const workspaceId = (action.target as { workspaceId: string }).workspaceId;
        state.workspaceId = workspaceId;
        state.executed.push("code_workspace_create");
        return {
          mutationState: "applied",
          output: {
            status: "ok",
            workspaceId,
            kind: "repository",
            profileKey,
            repositoryWriteScope: options.diagnosticExcerpts
              ? { allowedPaths: ["."], projects: [{ id: "pager", allowedPaths: ["src", "tests"] }] }
              : { allowedPaths: ["."] },
          },
          receipt: receiptFor(action, context, "create", `Created ${workspaceId}`),
        };
      },
    },
    read("code_workspace_status", "code_workspace", (args) => ({
      workspaceId: workspaceOf(args),
      files: state.files.size,
    })),
    read("code_workspace_stat", "code_workspace", (args) => {
      const path = String(args.path ?? "");
      const content = state.files.get(path);
      return content === undefined
        ? { path, exists: false }
        : { path, exists: true, bytes: content.length, sha256: sha(content) };
    }),
    read(
      "code_workspace_list",
      "code_workspace",
      () => ({
        path: ".",
        entries: [...state.files.keys()].sort().map((path) => ({ path, type: "file" })),
      }),
      "list",
    ),
    read("code_workspace_read", "code_workspace", (args) => {
      const path = String(args.path ?? "");
      const content = state.files.get(path);
      if (content === undefined) throw new Error(`No file ${path} in the workspace.`);
      return { workspaceId: workspaceOf(args), path, content, sha256: sha(content) };
    }),
    read(
      "code_workspace_search",
      "code_workspace",
      (args) => {
        const query = String(args.query ?? "");
        const results = [...state.files.entries()].flatMap(([path, content]) =>
          content
            .split("\n")
            .map((text, index) => ({ path, line: index + 1, text }))
            .filter((entry) => query && entry.text.includes(query)),
        );
        return { query, results, matchCount: results.length };
      },
      "search",
    ),
    write({
      name: "code_workspace_create_file",
      action: "create",
      operation: "create",
      pathOf: (args) => String(args.path ?? ""),
      apply: (args) => {
        const path = String(args.path ?? "");
        if (state.files.has(path)) throw new Error(`${path} already exists.`);
        state.files.set(path, String(args.content ?? ""));
        return { path };
      },
    }),
    write({
      name: "code_workspace_write_expected",
      action: "update",
      operation: "write",
      pathOf: (args) => String(args.path ?? ""),
      apply: (args) => {
        const path = String(args.path ?? "");
        state.files.set(path, String(args.content ?? ""));
        return { path };
      },
    }),
    write({
      name: "code_workspace_patch",
      action: "update",
      operation: "patch",
      pathOf: (args) => String(args.path ?? ""),
      apply: (args) => {
        const path = String(args.path ?? "");
        let content = state.files.get(path);
        if (content === undefined) throw new Error(`No file ${path} in the workspace.`);
        const replacements = Array.isArray(args.replacements) ? args.replacements : [];
        for (const replacement of replacements as Array<Record<string, unknown>>) {
          const oldText = String(replacement.oldText ?? "");
          if (!oldText || !content.includes(oldText)) {
            throw new Error(`oldText was not found in ${path}.`);
          }
          content = content.replace(oldText, String(replacement.newText ?? ""));
        }
        state.files.set(path, content);
        return { path, output: { sha256: sha(content) } };
      },
    }),
    write({
      name: "code_workspace_apply_patch",
      action: "update",
      operation: "apply_patch",
      pathOf: (args) => parseUnifiedPatchV1(args.patch)[0]!.path,
      pathsOf: (args) =>
        parseUnifiedPatchV1(args.patch).flatMap((file) => (file.fromPath ? [file.fromPath, file.path] : [file.path])),
      // The real tool's rule: a delete makes the patch a trash, else a rename a move,
      // else adding only a create, else an update.
      after: (args) => {
        const kinds = parseUnifiedPatchV1(args.patch).map((file) => file.kind);
        return {
          operation: kinds.includes("delete")
            ? "trash"
            : kinds.includes("rename")
              ? "move"
              : kinds.every((kind) => kind === "add")
                ? "create"
                : "update",
        };
      },
      apply: (args) => {
        // All or nothing, as the workspace manager's batch is.
        const files = parseUnifiedPatchV1(args.patch);
        const next = new Map(state.files);
        const lines: string[] = [];
        for (const file of files) {
          const source = file.fromPath ?? file.path;
          const plan = planUnifiedPatchFileV1(file, file.kind === "add" ? null : state.files.get(source) ?? null);
          if (file.kind === "add" && state.files.has(file.path)) throw new Error(`${file.path} already exists.`);
          if (file.fromPath) next.delete(file.fromPath);
          if (plan.after === null) next.delete(file.path);
          else next.set(file.path, plan.after);
          lines.push(describeUnifiedPatchFileV1(file, plan));
        }
        state.files.clear();
        for (const [path, content] of next) state.files.set(path, content);
        return {
          path: files[0]!.path,
          output: { files: files.map((file, index) => ({ path: file.path, fromPath: file.fromPath, line: lines[index] })) },
        };
      },
    }),
    write({
      name: "code_workspace_mkdir",
      action: "create",
      operation: "mkdir",
      pathOf: (args) => String(args.path ?? ""),
      apply: (args) => ({ path: String(args.path ?? "") }),
    }),
    write({
      name: "code_workspace_move",
      action: "move",
      operation: "move",
      pathOf: (args) => String(args.from ?? args.path ?? ""),
      apply: (args) => {
        const from = String(args.from ?? args.path ?? "");
        const to = String(args.to ?? "");
        const content = state.files.get(from);
        if (content === undefined) throw new Error(`No file ${from} in the workspace.`);
        state.files.delete(from);
        state.files.set(to, content);
        return { path: to };
      },
    }),
    write({
      name: "code_workspace_copy",
      action: "create",
      operation: "copy",
      pathOf: (args) => String(args.to ?? args.path ?? ""),
      apply: (args) => {
        const from = String(args.from ?? args.path ?? "");
        const to = String(args.to ?? "");
        const content = state.files.get(from);
        if (content === undefined) throw new Error(`No file ${from} in the workspace.`);
        state.files.set(to, content);
        return { path: to };
      },
    }),
    write({
      name: "code_workspace_trash",
      action: "trash",
      effect: "destructive_mutation",
      operation: "trash",
      pathOf: (args) => String(args.path ?? ""),
      apply: (args) => {
        const path = String(args.path ?? "");
        state.files.delete(path);
        return { path };
      },
    }),
    validation("fast"),
    validation("targeted"),
    validation("full"),
    {
      name: "code_repair_record_cycle",
      description: "Scripted repair cycle record.",
      parameters: looseSchema({ workspaceId: { type: "string" }, requestId: { type: "string" } }),
      descriptor: preparedDescriptor({
        name: "code_repair_record_cycle",
        resourceType: "code_repair_checkpoint",
        action: "update",
        effect: "reversible_mutation",
        receiptKind: "code_change",
      }),
      async execute() {
        return { status: "blocked", code: "prepared_action_required" };
      },
      prepare: async (args, context) =>
        prepare("code_repair_record_cycle", args, context, {
          system: "workspace",
          resourceType: "code_repair_checkpoint",
          id: `${workspaceOf(args)}:checkpoint`,
          workspaceId: workspaceOf(args),
        }, "Record the repair cycle"),
      async executePrepared(action, context) {
        const fast = latest("fast");
        const outcome = fast?.status === "passed" ? "passed" : "repaired";
        if (outcome === "passed") state.passedFastCycle = true;
        state.executed.push("code_repair_record_cycle");
        return {
          mutationState: "applied",
          output: { outcome, cycle: 1, validationReceiptId: fast?.id ?? null },
          receipt: receiptFor(action, context, "update", `Repair cycle ${outcome}`),
        };
      },
    },
    read("code_repair_status", "code_repair_checkpoint", () => {
      const last = state.validations.at(-1) ?? null;
      return {
        lastValidation: last
          ? { kind: last.kind, status: last.status, diagnostic: last.diagnostic }
          : null,
      };
    }),
    {
      name: "code_commit_verified",
      description: "Scripted verified commit.",
      parameters: looseSchema({ workspaceId: { type: "string" }, requestId: { type: "string" } }),
      descriptor: preparedDescriptor({
        name: "code_commit_verified",
        system: "git",
        resourceType: "verified_local_commit",
        action: "commit",
        effect: "execution",
        receiptKind: "code_change",
      }),
      async execute() {
        throw new Error("code_commit_verified requires a prepared exact action.");
      },
      prepare: async (args, context) => {
        const current = contentFingerprint(state.files);
        const targeted = latest("targeted");
        const full = latest("full");
        if (!state.passedFastCycle) {
          return { ok: false, error: { code: "passing_fast_validation_missing", message: "A verified passing fast cycle is required before commit preparation." } };
        }
        if (
          targeted?.status !== "passed" ||
          full?.status !== "passed" ||
          full.order < targeted.order ||
          targeted.contentFingerprint !== current ||
          full.contentFingerprint !== current
        ) {
          return { ok: false, error: { code: "validation_not_fresh", message: "A green targeted and a fresh full validation of the current files are required." } };
        }
        return prepare("code_commit_verified", args, context, {
          system: "git",
          resourceType: "verified_local_commit",
          id: `${workspaceOf(args)}:commit`,
          workspaceId: workspaceOf(args),
        }, "Commit the verified change");
      },
      async executePrepared(action, context) {
        const commitSha = createHash("sha1").update(contentFingerprint(state.files)).digest("hex");
        state.commits.push({ commitSha, contentFingerprint: contentFingerprint(state.files) });
        state.executed.push("code_commit_verified");
        return {
          mutationState: "applied",
          output: { status: "committed", commitSha },
          receipt: receiptFor(action, context, "commit", `Committed ${commitSha}`),
        };
      },
    },
  ];
  // CODE-17: one program and its arguments, prepared and approved as the
  // code extension's `code_sandbox_run` is, answering what `options.command`
  // says the program printed over the files as they are.
  tools.push({
    name: "code_sandbox_run",
    description: "Scripted code_sandbox_run.",
    parameters: looseSchema({
      workspaceId: { type: "string" },
      argv: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      timeoutSeconds: { type: "integer" },
    }),
    descriptor: preparedDescriptor({
      name: "code_sandbox_run",
      resourceType: "code_execution",
      action: "execute",
      effect: "execution",
      receiptKind: "artifact",
      allowPersistentGrant: false,
    }),
    async execute() {
      return { status: "blocked", code: "prepared_sandbox_action_required" };
    },
    prepare: async (args, context) => {
      const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
      return prepare("code_sandbox_run", args, context, {
        system: "workspace",
        resourceType: "code_execution",
        id: workspaceOf(args),
        workspaceId: workspaceOf(args),
      }, `Run ${argv.join(" ")} in the verified sandbox`);
    },
    async executePrepared(action, context) {
      const args = action.normalizedArgs as Record<string, unknown>;
      const argv = Array.isArray(args.argv) ? args.argv.map(String) : [];
      const answer = options.command?.(argv, state.files) ?? { exitCode: 0, stdout: "ok\n", stderr: "" };
      state.commands.push(argv);
      state.executed.push("code_sandbox_run");
      return {
        mutationState: "applied",
        output: {
          status: answer.exitCode === 0 ? "passed" : "failed",
          operation: "sandbox_run",
          workspaceId: workspaceOf(args),
          command: argv.join(" "),
          program: argv[0] ?? "",
          cwd: typeof args.cwd === "string" ? args.cwd : ".",
          exitCode: answer.exitCode,
          timedOut: false,
          durationMs: 1_200,
          trust: "untrusted_sandbox_output",
          stdout: answer.stdout,
          stderr: answer.stderr,
          truncated: false,
          redactedLines: 0,
          staged: state.files.size,
          notes: [],
        },
        receipt: receiptFor(action, context, "execute", `Ran ${argv.join(" ")}`),
      };
    },
  });
  return { tools, state };
}
