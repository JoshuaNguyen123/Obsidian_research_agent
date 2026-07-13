import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
} from "../agent/actions/canonicalize";
import type {
  ActionReceipt,
  JsonValue,
  PreparedAction,
  PreparedActionResult,
  ToolDescriptor,
} from "../agent/actions";
import {
  DiagramArtifactStore,
  sha256DiagramContent,
} from "../design/diagramArtifactStore";
import {
  MermaidBlockError,
  type MermaidBlockReadResult,
  type MermaidBlockSelector,
  readMermaidBlock,
  upsertMermaidBlock,
  validateMermaidText,
} from "../design/mermaidBlocks";
import type {
  AgentTool,
  AgentToolActionExecution,
  ToolExecutionContext,
} from "./types";
import { ToolExecutionError } from "./types";
import { getRequiredString, isRecord, normalizeVaultPath } from "./validation";

const MERMAID_MUTATION_INTENT =
  /\b(add|insert|upsert|update|revise|edit|change|modify|replace|create|write|fix|adjust)\b[\s\S]{0,120}\bmermaid\b|\bmermaid\b[\s\S]{0,120}\b(add|insert|upsert|update|revise|edit|change|modify|replace|create|write|fix|adjust)\b/i;

export function createMermaidTools(): AgentTool[] {
  return [readMermaidBlockTool, upsertMermaidBlockTool];
}

export const readMermaidBlockTool: AgentTool = {
  name: "read_mermaid_block",
  descriptor: createMermaidReadDescriptor(),
  description:
    "Read one exact Mermaid block from a Markdown note by heading or stable block id, returning the note SHA-256 required for safe edits.",
  parameters: {
    type: "object",
    required: ["path", "selector"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative Markdown path containing the Mermaid block.",
      },
      selector: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["heading", "block_id"] },
          heading: { type: "string" },
          blockId: { type: "string" },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  async execute(args, context) {
    const path = normalizeMarkdownPath(getRequiredString(args, "path"));
    const selector = parseMermaidSelector(args.selector);
    const artifact = await new DiagramArtifactStore(context.app.vault).read(path);
    let block: MermaidBlockReadResult;
    try {
      block = readMermaidBlock(artifact.content, selector);
    } catch (error) {
      if (error instanceof MermaidBlockError && error.code === "block_not_found") {
        return {
          path,
          operation: "read",
          sha256: artifact.sha256,
          bytes: artifact.bytes,
          selector,
          matched: false,
          mermaid: null,
          metadata: null,
        };
      }
      throw error;
    }
    return {
      path,
      operation: "read",
      sha256: artifact.sha256,
      bytes: artifact.bytes,
      selector,
      matched: true,
      mermaid: block.mermaid,
      metadata: block.metadata,
    };
  },
};

export const upsertMermaidBlockTool: AgentTool = {
  name: "upsert_mermaid_block",
  descriptor: createMermaidMutationDescriptor(),
  description:
    "Insert or update one Mermaid block in a Markdown note by exact heading or stable block id. Requires a fresh note baseHash, exact approval, verified backup, readback, and rollback on failure.",
  parameters: {
    type: "object",
    required: ["path", "baseHash", "selector", "mermaid"],
    properties: {
      path: {
        type: "string",
        description: "Vault-relative .md path to update.",
      },
      baseHash: {
        type: "string",
        description: "Exact note SHA-256 returned by read_mermaid_block.",
      },
      selector: {
        type: "object",
        required: ["kind"],
        properties: {
          kind: { type: "string", enum: ["heading", "block_id"] },
          heading: { type: "string" },
          blockId: { type: "string" },
        },
        additionalProperties: false,
      },
      mermaid: {
        type: "string",
        description: "Mermaid source without Markdown fence delimiters.",
      },
    },
    additionalProperties: false,
  },
  async execute() {
    throw new ToolExecutionError(
      "preparation_required",
      "upsert_mermaid_block must be prepared and exactly approved before mutation.",
      { mutationState: "not_applied" },
    );
  },
  prepare: prepareMermaidUpsert,
  executePrepared: executePreparedMermaidUpsert,
};

function createMermaidReadDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "read_mermaid_block",
    capability: { system: "vault", resourceType: "mermaid_block", action: "read" },
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
    allowedPrincipals: ["single_agent", "lead", "researcher"],
  };
}

function createMermaidMutationDescriptor(): ToolDescriptor {
  return {
    version: 1,
    name: "upsert_mermaid_block",
    capability: { system: "vault", resourceType: "mermaid_block", action: "update" },
    effect: "reversible_mutation",
    risk: "high",
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: false,
      fallback: "exact",
    },
    execution: { preparation: "required", cacheable: false, parallelSafe: false },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "optional",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "artifact",
  };
}

async function prepareMermaidUpsert(
  args: Record<string, unknown>,
  context: ToolExecutionContext,
): Promise<PreparedActionResult> {
  try {
    if (!MERMAID_MUTATION_INTENT.test(context.originalPrompt)) {
      throw new ToolExecutionError(
        "intent_required",
        "upsert_mermaid_block requires explicit Mermaid diagram insertion or edit intent.",
      );
    }
    const path = normalizeMarkdownPath(getRequiredString(args, "path"));
    const baseHash = getRequiredString(args, "baseHash");
    const selector = parseMermaidSelector(args.selector);
    const mermaid = validateMermaidText(getRequiredString(args, "mermaid"));
    const store = new DiagramArtifactStore(context.app.vault);
    const current = await store.read(path);
    if (current.sha256 !== baseHash) {
      throw new ToolExecutionError(
        "vault_precondition_changed",
        "Markdown baseHash no longer matches the persisted note; read the Mermaid block again before preparing an edit.",
        { mutationState: "not_applied" },
      );
    }
    const upsert = upsertMermaidBlock(current.content, selector, mermaid);
    const expectedAfterSha256 = await sha256DiagramContent(upsert.markdown);
    const normalizedSelector = jsonValue(selector);
    const changedRange = jsonValue(upsert.changedRange);
    const preparedAt = now(context);
    const runId = context.runId?.trim() || `mermaid-run-${token()}`;
    const toolCallId = context.operationId?.trim() || `mermaid-call-${token()}`;
    const targetId = `${path}#${selectorId(selector)}`;
    const idHash = await sha256Fingerprint({
      runId,
      toolCallId,
      toolName: "upsert_mermaid_block",
      targetId,
      baseHash,
      expectedAfterSha256,
    });
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: `mermaid-action-${idHash.slice(7, 39)}`,
      runId,
      toolCallId,
      toolName: "upsert_mermaid_block",
      target: {
        system: "vault",
        resourceType: "mermaid_block",
        id: targetId,
        path,
        revision: baseHash,
      },
      relatedResources: [
        { system: "vault", resourceType: "markdown", id: path, path, revision: baseHash },
      ],
      normalizedArgs: {
        path,
        baseHash,
        selector: normalizedSelector,
        mermaid,
        content: upsert.markdown,
        expectedAfterSha256,
        operation: upsert.operation,
        changedRange,
      },
      preview: {
        summary: `${upsert.operation === "insert" ? "Insert" : "Update"} the Mermaid block selected by ${selectorLabel(selector)} in ${path}.`,
        destination: `${path} (${selectorLabel(selector)})`,
        before: {
          sha256: baseHash,
          matched: upsert.before.matched,
        },
        after: {
          sha256: expectedAfterSha256,
          matched: true,
          operation: upsert.operation,
        },
        outboundPayload: { selector: normalizedSelector, mermaid },
        warnings: [
          "The note hash is checked again immediately before mutation.",
          "Only the selected Mermaid block range is changed; a verified backup is retained.",
          "Failed hash readback or Mermaid validation is rolled back.",
        ],
        outboundBytes: new TextEncoder().encode(upsert.markdown).byteLength,
      },
      expectedTargetRevision: baseHash,
      idempotencyKey: `${runId}:${toolCallId}:upsert_mermaid_block`,
      reconciliationKey: `vault:mermaid:${targetId}`,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(preparedAt.getTime() + 120_000).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof ToolExecutionError || error instanceof MermaidBlockError
            ? error.code
            : "mermaid_upsert_preparation_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function executePreparedMermaidUpsert(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<AgentToolActionExecution> {
  await assertPreparedMermaidBinding(action, context);
  const path = requirePreparedString(action, "path");
  const baseHash = requirePreparedString(action, "baseHash");
  const content = requirePreparedString(action, "content");
  const expectedAfterSha256 = requirePreparedString(action, "expectedAfterSha256");
  const mermaid = requirePreparedString(action, "mermaid");
  const selector = parseMermaidSelector(action.normalizedArgs.selector);
  const startedAt = now(context).toISOString();
  const update = await new DiagramArtifactStore(context.app.vault).update({
    path,
    expectedSha256: baseHash,
    content,
    validator: ({ content: persisted }) =>
      validatePersistedMermaid(persisted, selector, mermaid),
  });
  if (update.status !== "committed" || update.afterSha256 !== expectedAfterSha256) {
    throw new ToolExecutionError(
      update.status === "rollback_failed"
        ? "mermaid_upsert_rollback_failed"
        : "mermaid_upsert_rolled_back",
      update.error?.message ?? "Mermaid block edit did not commit and was rolled back.",
      {
        mutationState:
          update.status === "rollback_failed" ? "may_have_applied" : "not_applied",
        details: {
          path,
          backupPath: update.backupPath,
          rollbackStatus: update.rollbackStatus,
          finalSha256: update.finalSha256,
        },
      },
    );
  }
  const committedAt = now(context).toISOString();
  const receipt = await createMermaidReceipt({
    action,
    context,
    startedAt,
    committedAt,
    observedRevision: update.afterSha256,
    backupPath: update.backupPath,
    bytesWritten: update.bytesWritten,
  });
  return {
    mutationState: "applied",
    receipt,
    output: {
      path,
      operation: action.normalizedArgs.operation,
      selector,
      beforeSha256: update.beforeSha256,
      afterSha256: update.afterSha256,
      backupPath: update.backupPath,
      backupSha256: update.backupSha256,
      bytesWritten: update.bytesWritten,
      changedRange: action.normalizedArgs.changedRange,
      rollbackStatus: update.rollbackStatus,
      receipt: update,
    },
  };
}

async function assertPreparedMermaidBinding(
  action: PreparedAction,
  context: ToolExecutionContext,
): Promise<void> {
  if (
    action.toolName !== "upsert_mermaid_block" ||
    !(await verifyPreparedActionFingerprint(action))
  ) {
    throw new ToolExecutionError(
      "fingerprint_mismatch",
      "Prepared Mermaid edit identity or fingerprint is invalid.",
      { mutationState: "not_applied" },
    );
  }
  const authorization = context.authorizedAction;
  if (
    !authorization ||
    authorization.preparedActionId !== action.id ||
    authorization.payloadFingerprint !== action.payloadFingerprint ||
    !authorization.grantId.trim()
  ) {
    throw new ToolExecutionError(
      "authorization_mismatch",
      "Prepared Mermaid edit lacks its exact authority binding.",
      { mutationState: "not_applied" },
    );
  }
}

function validatePersistedMermaid(
  content: string,
  selector: MermaidBlockSelector,
  expectedMermaid: string,
): { ok: boolean; errors: string[] } {
  try {
    const selected = readMermaidBlock(content, selector);
    const validated = validateMermaidText(selected.mermaid);
    if (validated !== expectedMermaid) {
      return { ok: false, errors: ["Persisted Mermaid block differs from the prepared source."] };
    }
    return { ok: true, errors: [] };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

async function createMermaidReceipt(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  startedAt: string;
  committedAt: string;
  observedRevision: string;
  backupPath: string;
  bytesWritten: number;
}): Promise<ActionReceipt> {
  const receiptHash = await sha256Fingerprint({
    actionId: input.action.id,
    observedRevision: input.observedRevision,
  });
  return {
    version: 1,
    id: `mermaid-receipt-${receiptHash.slice(7, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: input.action.toolName,
    operation: "update",
    resource: { ...input.action.target },
    relatedResources: [
      {
        system: "vault",
        resourceType: "mermaid_backup",
        id: input.backupPath,
        path: input.backupPath,
      },
    ],
    message: `Updated ${input.action.target.id} with exact note-hash readback and verified backup.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId: input.context.authorizedAction!.grantId,
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt: input.committedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: input.committedAt,
      observedRevision: input.observedRevision,
      observedFingerprint: input.observedRevision,
    },
    effects: {
      bytesWritten: input.bytesWritten,
      affectedCount: 1,
      changedFields: [selectorId(parseMermaidSelector(input.action.normalizedArgs.selector))],
    },
  };
}

function parseMermaidSelector(value: unknown): MermaidBlockSelector {
  if (!isRecord(value)) {
    throw new MermaidBlockError(
      "invalid_selector",
      "Mermaid selector must be an object with kind heading or block_id.",
    );
  }
  const keys = Object.keys(value).sort();
  if (value.kind === "heading") {
    if (keys.join(",") !== "heading,kind" || typeof value.heading !== "string") {
      throw new MermaidBlockError(
        "invalid_selector",
        "Heading selector must contain exactly kind and heading.",
      );
    }
    return { kind: "heading", heading: value.heading };
  }
  if (value.kind === "block_id") {
    if (keys.join(",") !== "blockId,kind" || typeof value.blockId !== "string") {
      throw new MermaidBlockError(
        "invalid_selector",
        "Block-id selector must contain exactly kind and blockId.",
      );
    }
    return { kind: "block_id", blockId: value.blockId };
  }
  throw new MermaidBlockError(
    "invalid_selector",
    "Mermaid selector kind must be heading or block_id.",
  );
}

function normalizeMarkdownPath(path: string): string {
  const normalized = normalizeVaultPath(path);
  if (!normalized.toLowerCase().endsWith(".md")) {
    throw new ToolExecutionError(
      "unsafe_path",
      "Mermaid block path must end with .md.",
    );
  }
  return normalized;
}

function requirePreparedString(action: PreparedAction, key: string): string {
  const value = action.normalizedArgs[key];
  if (typeof value !== "string" || !value) {
    throw new ToolExecutionError(
      "invalid_prepared_action",
      `Prepared Mermaid edit is missing ${key}.`,
      { mutationState: "not_applied" },
    );
  }
  return value;
}

function jsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function selectorId(selector: MermaidBlockSelector): string {
  return selector.kind === "heading"
    ? `heading:${selector.heading}`
    : `block-id:${selector.blockId}`;
}

function selectorLabel(selector: MermaidBlockSelector): string {
  return selector.kind === "heading"
    ? `heading "${selector.heading}"`
    : `block id "${selector.blockId}"`;
}

function now(context: ToolExecutionContext): Date {
  return context.now?.() ?? new Date();
}

let sequence = 0;
function token(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return uuid;
  sequence += 1;
  return `${Date.now().toString(36)}-${sequence.toString(36)}`;
}
