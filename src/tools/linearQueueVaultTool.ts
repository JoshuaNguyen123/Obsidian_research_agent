import {
  sha256Fingerprint,
  verifyPreparedActionFingerprint,
  withPreparedActionFingerprint,
  type ActionReceipt,
  type PreparedAction,
  type PreparedActionResult,
  type ToolDescriptor,
} from "../agent/actions";
import {
  ToolExecutionError,
  type AgentTool,
  type AgentToolActionExecution,
  type ToolExecutionContext,
} from "./types";
import { normalizeVaultPath } from "./validation";

const PREPARED_QUEUE_VAULT_ACTION_TTL_MS = 5 * 60_000;
const MAX_QUEUE_VAULT_NOTE_BYTES = 512_000;

export interface LinearQueueVaultCreateToolOptionsV1 {
  /** Exact host-resolved destination. Linear/model text cannot change it. */
  targetPath: string;
  vaultBindingKey: string;
  /** Provider-readback lineage appended by the host, never supplied by ticket text. */
  lineage: {
    issueId: string;
    identifier: string;
    issueUrl: string;
    contractFingerprint: string;
  };
}

/**
 * Queue vault work receives its complete context from the signed work item.
 * The model-visible catalog is therefore closed to the one host-bound create
 * operation; unrelated vault reads must never become ambient queue authority.
 */
export function isLinearQueueVaultExecutionToolAllowedV1(
  toolName: string,
): boolean {
  return toolName === "create_file";
}

/**
 * Queue-only replacement for the ordinary create_file tool. It retains the
 * familiar model contract while requiring a fingerprinted prepared action and
 * an exact scheduled authority grant. The destination is closed over by the
 * host, so untrusted Linear content can supply note prose but never a path.
 */
export function createLinearQueueVaultCreateToolV1(
  options: LinearQueueVaultCreateToolOptionsV1,
): AgentTool {
  const targetPath = normalizeVaultPath(options.targetPath, {
    requireMarkdown: true,
  });
  const vaultBindingKey = logicalKey(options.vaultBindingKey, "vault binding key");
  const lineageFooter = buildHostLineageFooter(options.lineage);
  const descriptor: ToolDescriptor = {
    version: 1,
    name: "create_file",
    capability: { system: "vault", resourceType: "markdown", action: "create" },
    effect: "reversible_mutation",
    risk: "medium",
    approval: {
      allowPromptGrant: false,
      allowPersistentGrant: true,
      fallback: "exact",
    },
    execution: {
      preparation: "required",
      cacheable: false,
      parallelSafe: false,
    },
    durability: {
      journal: true,
      receipt: true,
      readback: "required",
      reconciliation: "required",
    },
    allowedPrincipals: ["single_agent", "lead"],
    receiptKind: "vault_write",
    operationGoals: ["write_receipt"],
  };

  return {
    name: "create_file",
    description:
      `Create the one host-bound Linear queue result note at ${targetPath}. ` +
      "The path must match exactly; ticket text cannot select another vault destination.",
    parameters: {
      type: "object",
      required: ["path", "content"],
      properties: {
        path: {
          type: "string",
          description: `Exact host-bound path: ${targetPath}`,
        },
        content: {
          type: "string",
          description: "Complete Markdown result, including acceptance and evidence references.",
        },
        createFolders: {
          type: "boolean",
          description: "Must be true when supplied; the host creates only the bound parent path.",
        },
      },
      additionalProperties: false,
    },
    descriptor,
    async execute() {
      throw new ToolExecutionError(
        "prepared_action_required",
        "Linear queue vault creation requires preparation and scheduled authority.",
        { mutationState: "not_applied" },
      );
    },
    prepare: (args, context) =>
      prepareCreate({
        args,
        context,
        targetPath,
        vaultBindingKey,
        lineageFooter,
      }),
    executePrepared: (action, context) =>
      executePreparedCreate({ action, context, targetPath, vaultBindingKey }),
    reconcile: (action, context) =>
      reconcileCreate({ action, context, targetPath, vaultBindingKey }),
  };
}

async function prepareCreate(input: {
  args: Record<string, unknown>;
  context: ToolExecutionContext;
  targetPath: string;
  vaultBindingKey: string;
  lineageFooter: string;
}): Promise<PreparedActionResult> {
  try {
    assertExactKeys(input.args, ["path", "content"], ["createFolders"]);
    const requestedPath = normalizeVaultPath(requiredString(input.args.path, "path"), {
      requireMarkdown: true,
    });
    if (requestedPath !== input.targetPath) {
      throw notApplied(
        "linear_queue_vault_path_rejected",
        "The queue result path does not match the host-resolved trusted vault binding.",
      );
    }
    if (input.args.createFolders !== undefined && input.args.createFolders !== true) {
      throw notApplied(
        "linear_queue_vault_arguments_invalid",
        "createFolders may be omitted or set to true for the exact host-bound parent.",
      );
    }
    const modelContent = boundedMarkdown(input.args.content);
    const content = boundedMarkdown(
      `${modelContent.trimEnd()}\n\n${input.lineageFooter}\n`,
    );
    if (input.context.app.vault.getAbstractFileByPath(input.targetPath)) {
      throw notApplied(
        "linear_queue_vault_target_exists",
        "The deterministic queue result note already exists; reconcile the prior action instead of overwriting it.",
      );
    }
    const runId = requiredIdentity(input.context.runId, "run id");
    const toolCallId = requiredIdentity(input.context.operationId, "tool call id");
    const preparedAt = input.context.now?.() ?? new Date();
    const contentSha256 = await sha256Fingerprint(content);
    const absentRevision = await absentFingerprint(input.targetPath);
    const actionId = await sha256Fingerprint({
      runId,
      toolCallId,
      toolName: "create_file",
      targetPath: input.targetPath,
      contentSha256,
    });
    const action = await withPreparedActionFingerprint({
      version: 1,
      id: `linear-queue-vault-${actionId.slice("sha256:".length, 39)}`,
      runId,
      toolCallId,
      toolName: "create_file",
      target: {
        system: "vault",
        resourceType: "markdown",
        id: input.targetPath,
        path: input.targetPath,
        containerId: input.vaultBindingKey,
      },
      relatedResources: [],
      normalizedArgs: {
        path: input.targetPath,
        content,
        contentSha256,
        createFolders: true,
        vaultBindingKey: input.vaultBindingKey,
        absentRevision,
      },
      preview: {
        summary: `Create queue result note ${input.targetPath}.`,
        destination: input.targetPath,
        before: { path: input.targetPath, present: false },
        after: {
          path: input.targetPath,
          bytes: utf8Bytes(content),
          sha256: contentSha256,
        },
        outboundPayload: { path: input.targetPath, content },
        warnings: [],
        outboundBytes: utf8Bytes(content),
      },
      expectedTargetRevision: absentRevision,
      idempotencyKey: `linear-queue-vault:${input.targetPath}:${contentSha256}`,
      reconciliationKey: `vault:${input.vaultBindingKey}:${input.targetPath}`,
      requiredConfirmations: 1,
      preparedAt: preparedAt.toISOString(),
      expiresAt: new Date(
        preparedAt.getTime() + PREPARED_QUEUE_VAULT_ACTION_TTL_MS,
      ).toISOString(),
    });
    return { ok: true, action };
  } catch (error) {
    return {
      ok: false,
      error: {
        code:
          error instanceof ToolExecutionError
            ? error.code
            : "linear_queue_vault_preparation_failed",
        message: safeError(error),
      },
    };
  }
}

async function executePreparedCreate(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  targetPath: string;
  vaultBindingKey: string;
}): Promise<AgentToolActionExecution> {
  await assertPreparedBinding(input);
  const content = preparedString(input.action, "content");
  const contentSha256 = preparedString(input.action, "contentSha256");
  if ((await sha256Fingerprint(content)) !== contentSha256) {
    throw notApplied(
      "linear_queue_vault_payload_drift",
      "The prepared queue note content no longer matches its approved hash.",
    );
  }
  const startedAt = nowIso(input.context);
  const existing = input.context.app.vault.getFileByPath(input.targetPath);
  if (existing) {
    const observed = await input.context.app.vault.read(existing);
    if (observed !== content) {
      throw notApplied(
        "linear_queue_vault_target_changed",
        "The deterministic queue result path now contains different bytes.",
      );
    }
    return {
      output: {
        path: input.targetPath,
        operation: "create",
        bytesWritten: 0,
        reconciled: true,
        sha256: contentSha256,
      },
      mutationState: "applied",
      receipt: await buildReceipt({
        action: input.action,
        context: input.context,
        content,
        contentSha256,
        startedAt,
        commitKind: "reconciled",
        bytesWritten: 0,
      }),
    };
  }
  if (input.context.app.vault.getAbstractFileByPath(input.targetPath)) {
    throw notApplied(
      "linear_queue_vault_target_changed",
      "The deterministic queue result path is no longer absent.",
    );
  }
  const absentRevision = preparedString(input.action, "absentRevision");
  if (
    input.action.expectedTargetRevision !== absentRevision ||
    (await absentFingerprint(input.targetPath)) !== absentRevision
  ) {
    throw notApplied(
      "linear_queue_vault_precondition_changed",
      "The queue result target precondition changed after preparation.",
    );
  }
  await ensureParentFolders(input.context, input.targetPath);
  await input.context.app.vault.create(input.targetPath, content);
  const created = input.context.app.vault.getFileByPath(input.targetPath);
  if (!created) {
    throw possiblyApplied(
      "linear_queue_vault_readback_failed",
      "Vault creation returned without a readable Markdown file.",
    );
  }
  const observed = await input.context.app.vault.read(created);
  if (observed !== content || (await sha256Fingerprint(observed)) !== contentSha256) {
    throw possiblyApplied(
      "linear_queue_vault_readback_failed",
      "Created queue result note failed exact readback.",
    );
  }
  return {
    output: {
      path: input.targetPath,
      operation: "create",
      bytesWritten: utf8Bytes(content),
      reconciled: false,
      sha256: contentSha256,
    },
    mutationState: "applied",
    receipt: await buildReceipt({
      action: input.action,
      context: input.context,
      content,
      contentSha256,
      startedAt,
      commitKind: "committed",
      bytesWritten: utf8Bytes(content),
    }),
  };
}

async function reconcileCreate(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  targetPath: string;
  vaultBindingKey: string;
}): Promise<{
  outcome: "committed" | "not_applied" | "still_uncertain";
  receipt?: ActionReceipt;
  message: string;
}> {
  if (
    input.action.toolName !== "create_file" ||
    input.action.target.path !== input.targetPath ||
    input.action.target.containerId !== input.vaultBindingKey ||
    !(await verifyPreparedActionFingerprint(input.action))
  ) {
    return {
      outcome: "still_uncertain",
      message: "The queue vault action binding or fingerprint is invalid.",
    };
  }
  const existing = input.context.app.vault.getFileByPath(input.targetPath);
  if (!existing) {
    return {
      outcome: "not_applied",
      message: "The queue result note is absent.",
    };
  }
  const content = preparedString(input.action, "content");
  const contentSha256 = preparedString(input.action, "contentSha256");
  const observed = await input.context.app.vault.read(existing);
  if (observed !== content || (await sha256Fingerprint(observed)) !== contentSha256) {
    return {
      outcome: "still_uncertain",
      message: "The queue result path exists with bytes that do not match the prepared action.",
    };
  }
  const checkedAt = nowIso(input.context);
  return {
    outcome: "committed",
    message: "Exact vault readback proves the queue result note was committed.",
    receipt: await buildReceipt({
      action: input.action,
      context: input.context,
      content,
      contentSha256,
      startedAt: input.action.preparedAt,
      commitKind: "reconciled",
      bytesWritten: utf8Bytes(content),
      committedAt: checkedAt,
      fallbackGrantId: "linear-queue-vault-reconciliation",
    }),
  };
}

async function assertPreparedBinding(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  targetPath: string;
  vaultBindingKey: string;
}): Promise<void> {
  if (
    input.action.toolName !== "create_file" ||
    input.action.target.system !== "vault" ||
    input.action.target.resourceType !== "markdown" ||
    input.action.target.path !== input.targetPath ||
    input.action.target.containerId !== input.vaultBindingKey ||
    input.action.normalizedArgs.path !== input.targetPath ||
    input.action.normalizedArgs.vaultBindingKey !== input.vaultBindingKey ||
    !(await verifyPreparedActionFingerprint(input.action))
  ) {
    throw notApplied(
      "linear_queue_vault_fingerprint_mismatch",
      "The prepared queue vault action does not match its host binding.",
    );
  }
  const authorization = input.context.authorizedAction;
  if (
    !authorization ||
    authorization.preparedActionId !== input.action.id ||
    authorization.payloadFingerprint !== input.action.payloadFingerprint ||
    !authorization.grantId.trim()
  ) {
    throw notApplied(
      "linear_queue_vault_authority_missing",
      "The prepared queue vault action lacks its exact scheduled grant binding.",
    );
  }
}

async function buildReceipt(input: {
  action: PreparedAction;
  context: ToolExecutionContext;
  content: string;
  contentSha256: string;
  startedAt: string;
  commitKind: "committed" | "reconciled";
  bytesWritten: number;
  committedAt?: string;
  fallbackGrantId?: string;
}): Promise<ActionReceipt> {
  const committedAt = input.committedAt ?? nowIso(input.context);
  const receiptFingerprint = await sha256Fingerprint({
    actionId: input.action.id,
    contentSha256: input.contentSha256,
    commitKind: input.commitKind,
  });
  return {
    version: 1,
    id: `linear-queue-vault-receipt-${receiptFingerprint.slice("sha256:".length, 39)}`,
    runId: input.action.runId,
    actionId: input.action.id,
    toolName: "create_file",
    operation: "create",
    resource: { ...input.action.target, revision: input.contentSha256 },
    message: `Created and verified Linear queue result note ${input.action.target.path}.`,
    payloadFingerprint: input.action.payloadFingerprint,
    grantId:
      input.context.authorizedAction?.grantId ??
      input.fallbackGrantId ??
      "linear-queue-vault-reconciliation",
    idempotencyKey: input.action.idempotencyKey,
    startedAt: input.startedAt,
    committedAt,
    commitKind: input.commitKind,
    readback: {
      status: "verified",
      checkedAt: committedAt,
      observedRevision: input.contentSha256,
      observedFingerprint: input.contentSha256,
    },
    effects: {
      bytesWritten: input.bytesWritten,
      affectedCount: 1,
    },
  };
}

async function ensureParentFolders(
  context: ToolExecutionContext,
  targetPath: string,
): Promise<void> {
  const segments = targetPath.split("/").slice(0, -1);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = context.app.vault.getAbstractFileByPath(current);
    if (existing) {
      const path = (existing as { path?: unknown }).path;
      const children = (existing as { children?: unknown }).children;
      if (path !== current || !Array.isArray(children)) {
        throw notApplied(
          "linear_queue_vault_parent_conflict",
          `A non-folder path blocks the trusted queue destination: ${current}.`,
        );
      }
      continue;
    }
    try {
      await context.app.vault.createFolder(current);
    } catch (error) {
      if (!/already exists|folder exists/iu.test(safeError(error))) throw error;
    }
  }
}

async function absentFingerprint(path: string): Promise<string> {
  return sha256Fingerprint({ absent: true, path });
}

function boundedMarkdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\u0000")) {
    throw notApplied(
      "linear_queue_vault_content_invalid",
      "Queue vault output must be non-empty UTF-8 Markdown without NUL bytes.",
    );
  }
  if (utf8Bytes(value) > MAX_QUEUE_VAULT_NOTE_BYTES) {
    throw notApplied(
      "linear_queue_vault_content_too_large",
      `Queue vault output exceeds ${MAX_QUEUE_VAULT_NOTE_BYTES} bytes.`,
    );
  }
  return value;
}

function buildHostLineageFooter(
  value: LinearQueueVaultCreateToolOptionsV1["lineage"],
): string {
  if (!value || typeof value !== "object") {
    throw new Error("Linear queue vault lineage is required.");
  }
  const issueId = boundedLineageIdentity(value.issueId, "Linear issue id");
  if (!/^[A-Z][A-Z0-9]{0,15}-[1-9][0-9]{0,9}$/u.test(value.identifier)) {
    throw new Error("Linear issue identifier is invalid.");
  }
  const contractFingerprint = requiredFingerprint(
    value.contractFingerprint,
    "work-item contract fingerprint",
  );
  let issueUrl: URL;
  try {
    issueUrl = new URL(value.issueUrl);
  } catch {
    throw new Error("Linear issue URL is invalid.");
  }
  if (
    issueUrl.protocol !== "https:" ||
    issueUrl.hostname.toLowerCase() !== "linear.app" ||
    issueUrl.username ||
    issueUrl.password ||
    issueUrl.hash ||
    value.issueUrl.length > 2_000
  ) {
    throw new Error("Linear issue URL must be a credential-free linear.app HTTPS URL.");
  }
  return [
    "## Linear lineage",
    "",
    `- Source issue: [${value.identifier}](${issueUrl.toString()})`,
    `- Provider issue ID: \`${issueId}\``,
    `- Work-item contract: \`${contractFingerprint}\``,
  ].join("\n");
}

function boundedLineageIdentity(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/u.test(value)
  ) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

function requiredFingerprint(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`${label} must be a SHA-256 fingerprint.`);
  }
  return value;
}

function preparedString(action: PreparedAction, key: string): string {
  const value = action.normalizedArgs[key];
  if (typeof value !== "string" || !value) {
    throw notApplied(
      "linear_queue_vault_action_invalid",
      `Prepared queue vault action is missing ${key}.`,
    );
  }
  return value;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw notApplied(
      "linear_queue_vault_arguments_invalid",
      `${label} is required.`,
    );
  }
  return value.trim();
}

function requiredIdentity(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256) {
    throw notApplied(
      "linear_queue_vault_context_invalid",
      `Queue vault ${label} is unavailable.`,
    );
  }
  return value.trim();
}

function logicalKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-z0-9][a-z0-9._-]{0,127}$/u.test(value)) {
    throw new TypeError(`${label} is invalid.`);
  }
  return value;
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[],
): void {
  const allowed = new Set([...required, ...optional]);
  if (
    required.some((key) => !(key in value)) ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    throw notApplied(
      "linear_queue_vault_arguments_invalid",
      "Queue vault arguments do not match the closed tool contract.",
    );
  }
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function nowIso(context: ToolExecutionContext): string {
  return (context.now?.() ?? new Date()).toISOString();
}

function notApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, { mutationState: "not_applied" });
}

function possiblyApplied(code: string, message: string): ToolExecutionError {
  return new ToolExecutionError(code, message, {
    mutationState: "may_have_applied",
  });
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Queue vault operation failed.")
    .replace(/(token|secret|password)\s*[=:]\s*[^\s,;}]+/giu, "$1=[REDACTED]")
    .slice(0, 1_000);
}
