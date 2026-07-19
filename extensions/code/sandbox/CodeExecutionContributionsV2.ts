import { createHash } from "node:crypto";

import type {
  ActionReceiptV1,
  ExtensionContributionV1,
  ExtensionToolContributionV1,
  JsonSchemaObjectV1,
  JsonValueV1,
  PreparedActionResultV1,
  PreparedActionV1,
  ScopedExtensionContextV1,
  ToolDescriptorV1,
} from "@agentic-researcher/core-api";

import {
  detectRepositoryProfileV2,
  parseRepositoryProfileV2,
  type RepositoryDetectionInputV2,
  type RepositoryProfileV2,
} from "../repositories/RepositoryProfileV2";
import {
  SandboxManagerV2,
  parsePreparedSandboxActionV2,
  type PreparedSandboxActionV2,
  type SandboxArtifactImporterV2,
  type SandboxExecutionReceiptV2,
  type SandboxValidationDiagnosticsV1,
  type SandboxPrepareInputV2,
  type SandboxStagedFileBytesV2,
} from "./SandboxManager";

export const CODE_EXECUTION_TOOL_NAMES_V2 = [
  "code_repository_detect_profile",
  "code_sandbox_status",
  "code_validate_fast",
  "code_validate_targeted",
  "code_validate_full",
  "run_code_block",
  "render_html_preview",
  "install_code_dependency",
] as const;

export interface CodeExecutionContributionFactoryOptionsV2 {
  sandboxManager: SandboxManagerV2 | (() => SandboxManagerV2);
  getProfile(profileKey: string): Promise<RepositoryProfileV2 | null>;
  /** Resolve mutable workspace proof on the host; model arguments never carry hashes. */
  resolvePreparationInput?(input: {
    purpose: SandboxPrepareInputV2["purpose"];
    workspaceId: string;
    context: ScopedExtensionContextV1;
  }): Promise<{
    profile: RepositoryProfileV2;
    projectId: string;
    commandId: string;
    workspaceId?: string;
    repairRequestId?: string | null;
    workspaceManifestFingerprint: string;
    stagingManifest: SandboxPrepareInputV2["stagingManifest"];
  }>;
  resolveExecutionInput?(
    action: PreparedActionV1,
    sandboxAction: PreparedSandboxActionV2,
    context: ScopedExtensionContextV1,
  ): Promise<{
    stagedFiles: readonly SandboxStagedFileBytesV2[];
    artifactImporter?: SandboxArtifactImporterV2;
  }>;
  /** Persistence and exact readback must finish before validation success returns. */
  observeValidationReceipt?(input: {
    runId: string;
    requestId: string;
    action: PreparedSandboxActionV2;
    receipt: SandboxExecutionReceiptV2;
    /** Hash/size metadata only; raw child-process output never crosses this boundary. */
    diagnostics: SandboxValidationDiagnosticsV1;
    context: ScopedExtensionContextV1;
  }): Promise<JsonValueV1>;
}

interface ParsedSandboxToolArgsV2
  extends Omit<
    SandboxPrepareInputV2,
    | "profile"
    | "purpose"
    | "projectId"
    | "commandId"
    | "workspaceManifestFingerprint"
    | "stagingManifest"
  > {
  profileKey: string | null;
  projectId: string | null;
  commandId: string | null;
  workspaceManifestFingerprint: string | null;
  stagingManifest: SandboxPrepareInputV2["stagingManifest"] | null;
}

/**
 * Full code-extension capability factory. Execution tools are prepared-only
 * and route exclusively through SandboxManagerV2; there is no native fallback.
 */
export function createCodeExecutionContributionsV2(
  options: CodeExecutionContributionFactoryOptionsV2,
): ExtensionContributionV1[] {
  return [
    detectProfileContribution(),
    sandboxStatusToolContribution(options.sandboxManager),
    preparedSandboxContribution(options, "code_validate_fast", "validation_fast"),
    preparedSandboxContribution(options, "code_validate_targeted", "validation_targeted"),
    preparedSandboxContribution(options, "code_validate_full", "validation_full"),
    preparedSandboxContribution(options, "run_code_block", "code_block"),
    htmlPreviewContribution(),
    preparedSandboxContribution(options, "install_code_dependency", "lockfile_restore"),
    sandboxHealthContribution(options.sandboxManager),
  ];
}

export function createCodeSandboxHealthContributionV2(
  manager: SandboxManagerV2,
): ExtensionContributionV1 {
  return sandboxHealthContribution(manager);
}

function detectProfileContribution(): ExtensionToolContributionV1 {
  const name = "code_repository_detect_profile";
  return toolContribution(
    name,
    "Detect a closed RepositoryProfileV2 from a bounded repository file inventory without executing repository code.",
    descriptor(name, "repository_profile", "read", "read", "low", "none"),
    {
      type: "object",
      additionalProperties: false,
      properties: {
        key: { type: "string" },
        displayName: { type: "string" },
        repositoryRoot: { type: "string" },
        defaultBranch: { type: "string" },
        files: { type: "array", items: { type: "string" } },
        fileContents: { type: "object", additionalProperties: { type: "string" } },
        fileHashes: { type: "object", additionalProperties: { type: "string" } },
        runtimeDigests: { type: "object", additionalProperties: { type: "string" } },
        allowedPaths: { type: "array", items: { type: "string" } },
        generatedOutputs: { type: "array", items: { type: "string" } },
        requiredGitHubChecks: { type: "array", items: { type: "string" } },
      },
      required: ["key", "displayName", "repositoryRoot", "defaultBranch", "files"],
    },
    async (args) => {
      assertAllowedArgs(args, [
        "key", "displayName", "repositoryRoot", "defaultBranch", "files",
        "fileContents", "fileHashes", "runtimeDigests", "allowedPaths",
        "generatedOutputs", "requiredGitHubChecks",
      ]);
      return detectRepositoryProfileV2(args as unknown as RepositoryDetectionInputV2);
    },
  );
}

function sandboxStatusToolContribution(
  manager: SandboxManagerV2 | (() => SandboxManagerV2),
): ExtensionToolContributionV1 {
  const name = "code_sandbox_status";
  return toolContribution(
    name,
    "Read cached sandbox provider status without probing, starting a process, or mutating provider state.",
    descriptor(name, "sandbox_status", "read", "read", "low", "none"),
    { type: "object", properties: {}, additionalProperties: false },
    async (args) => {
      assertAllowedArgs(args, []);
      return resolveSandboxManager(manager).readStatus();
    },
  );
}

function preparedSandboxContribution(
  options: CodeExecutionContributionFactoryOptionsV2,
  name:
    | "code_validate_fast"
    | "code_validate_targeted"
    | "code_validate_full"
    | "run_code_block"
    | "install_code_dependency",
  purpose: SandboxPrepareInputV2["purpose"],
): ExtensionToolContributionV1 {
  const install = purpose === "lockfile_restore";
  const capabilityAction = install ? "install" as const : purpose.startsWith("validation_") ? "validate" as const : "execute" as const;
  const resourceType = install
    ? "lockfile_restore"
    : purpose === "code_block" ? "code_execution" : "validation_run";
  const tool: ExtensionToolContributionV1["tool"] = {
    name,
    description: install
      ? "Restore only profile-declared lockfiles in a verified sandbox after exact prepared approval; arbitrary package installation is not supported."
      : "Run the selected immutable RepositoryProfileV2 command only inside a verified sandbox.",
    parameters: sandboxParameters(Boolean(options.resolvePreparationInput)),
    descriptor: descriptor(
      name,
      resourceType,
      capabilityAction,
      "execution",
      install ? "high" : "medium",
      "required",
      "exact",
    ),
    async execute() {
      return {
        status: "blocked",
        code: "prepared_sandbox_action_required",
        message: `${name} can run only through prepare and executePrepared; native execution is unavailable.`,
        editingAvailable: true,
        executionAvailable: false,
      };
    },
    async prepare(args, context): Promise<PreparedActionResultV1> {
      try {
        const normalized = parseSandboxToolArgs(
          args,
          Boolean(options.resolvePreparationInput),
        );
        const hostProof = options.resolvePreparationInput
          ? await options.resolvePreparationInput({
              purpose,
              workspaceId: normalized.workspaceId,
              context,
            })
          : null;
        const profile = hostProof?.profile ?? await options.getProfile(normalized.profileKey!);
        if (!profile) {
          return failure("repository_profile_missing", "The trusted RepositoryProfileV2 is unavailable.");
        }
        parseRepositoryProfileV2(profile);
        const prepared = await resolveSandboxManager(
          options.sandboxManager,
        ).prepareExecution({
          profile,
          purpose,
          projectId: hostProof?.projectId ?? normalized.projectId!,
          commandId: hostProof?.commandId ?? normalized.commandId!,
          workspaceId: hostProof?.workspaceId ?? normalized.workspaceId,
          repairRequestId:
            hostProof?.repairRequestId !== undefined
              ? hostProof.repairRequestId
              : normalized.repairRequestId,
          workspaceManifestFingerprint:
            hostProof?.workspaceManifestFingerprint ?? normalized.workspaceManifestFingerprint!,
          stagingManifest: hostProof?.stagingManifest ?? normalized.stagingManifest!,
          expectedArtifacts: normalized.expectedArtifacts,
          environment: normalized.environment,
        });
        if (prepared.status === "blocked") {
          return failure(prepared.blocker.code, prepared.blocker.message);
        }
        return {
          ok: true,
          action: corePreparedAction(name, resourceType, prepared.action, context),
        };
      } catch (error) {
        return failure(
          "sandbox_prepare_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
    async executePrepared(action, context) {
      const sandboxAction = extractSandboxAction(action);
      if (!context.authorizedAction) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_authorization_required",
          "Prepared sandbox execution lacks a host authorization binding.",
        );
      }
      if (!options.resolveExecutionInput) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_staging_unavailable",
          "No hash-verifying workspace staging boundary is connected; native execution is not a fallback.",
        );
      }
      const executionInput = await options.resolveExecutionInput(
        action,
        sandboxAction,
        context,
      );
      const result = await resolveSandboxManager(
        options.sandboxManager,
      ).executePrepared(sandboxAction, {
        authorization: {
          preparedActionId: sandboxAction.id,
          payloadFingerprint: sandboxAction.payloadFingerprint,
          grantId: context.authorizedAction.grantId,
        },
        stagedFiles: executionInput.stagedFiles,
        artifactImporter: executionInput.artifactImporter,
        signal: context.abortSignal,
      });
      if (result.status === "blocked") {
        throw new CodeSandboxContributionErrorV2(
          result.blocker.code,
          result.blocker.message,
        );
      }
      let validationReceipt: JsonValueV1 | undefined;
      if (sandboxAction.repairRequestId !== null) {
        if (!options.observeValidationReceipt) {
          throw new CodeSandboxContributionErrorV2(
            "validation_receipt_observer_missing",
            "Validation executed, but no durable repair receipt observer is connected; success is withheld.",
          );
        }
        try {
          validationReceipt = await options.observeValidationReceipt({
            runId: action.runId,
            requestId: sandboxAction.repairRequestId,
            action: sandboxAction,
            receipt: result.receipt,
            diagnostics: result.diagnostics,
            context,
          });
          const durable = requiredRecord(
            validationReceipt,
            "durable validation receipt readback",
          );
          if (
            durable.id !== result.receipt.id ||
            durable.kindName !== "code_validation" ||
            typeof durable.fingerprint !== "string" ||
            !/^sha256:[0-9a-f]{64}$/u.test(durable.fingerprint)
          ) {
            throw new Error(
              "Durable validation receipt readback does not match the sandbox receipt identity.",
            );
          }
        } catch (error) {
          throw new CodeSandboxContributionErrorV2(
            "validation_receipt_persistence_failed",
            `Validation executed, but durable scoped receipt persistence/readback failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const receipt = actionReceipt(
        action,
        context,
        result.receipt,
        capabilityAction,
      );
      return {
        output: {
          status: result.status,
          sandboxReceipt: result.receipt,
          ...(validationReceipt === undefined ? {} : { validationReceipt }),
          ...(sandboxAction.repairRequestId === null
            ? {}
            : {
                validationDiagnostics: result.diagnostics,
                validationDiagnosticExcerpt: result.diagnosticExcerpt,
              }),
          nativeFallbackUsed: false,
        },
        receipt,
        mutationState: "applied" as const,
      };
    },
    async reconcile(action) {
      return {
        outcome: "still_uncertain" as const,
        message:
          `Sandbox action ${action.id} has no trusted committed receipt in this process. ` +
          "Preserve the pending action and inspect the workspace hash index before preparing a replacement; never use native execution as reconciliation.",
      };
    },
  };
  return {
    descriptor: {
      version: 1,
      kind: "tool",
      id: `agentic-researcher-code:${name}`,
      displayName: name,
    },
    tool,
  };
}

function htmlPreviewContribution(): ExtensionToolContributionV1 {
  const name = "render_html_preview";
  return toolContribution(
    name,
    "Return an inert iframe descriptor with an empty sandbox token set and script-denying CSP. It never evaluates HTML on the host.",
    descriptor(name, "html_preview", "read", "read", "low", "none"),
    {
      type: "object",
      additionalProperties: false,
      properties: {
        html: { type: "string", maxLength: 1_000_000 },
        title: { type: "string", maxLength: 160 },
      },
      required: ["html"],
    },
    async (args) => {
      assertAllowedArgs(args, ["html", "title"]);
      const html = requiredString(args.html, "html", 1_000_000, true);
      const title = args.title === undefined
        ? "Sandboxed HTML preview"
        : requiredString(args.title, "title", 160);
      return {
        version: 1,
        kind: "csp_sandboxed_html_preview",
        title,
        srcdoc: html,
        sourceFingerprint: sha256Text(html),
        iframeSandboxTokens: [],
        csp: [
          "default-src 'none'",
          "script-src 'none'",
          "connect-src 'none'",
          "object-src 'none'",
          "frame-src 'none'",
          "form-action 'none'",
          "base-uri 'none'",
          "img-src data: https:",
          "style-src 'unsafe-inline'",
          "font-src data:",
        ].join("; "),
        hostExecution: false,
        scriptExecution: "blocked",
      };
    },
  );
}

function sandboxHealthContribution(
  manager: SandboxManagerV2 | (() => SandboxManagerV2),
): ExtensionContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "status",
      id: "agentic-researcher-code:sandbox-health",
      displayName: "Code sandbox health",
    },
    async readStatus(context) {
      const status = resolveSandboxManager(manager).readStatus();
      return {
        status: status.executionAvailable ? "healthy" : "degraded",
        summary: status.executionAvailable
          ? `Sandbox execution verified through ${status.selectedProvider}.`
          : "Editing remains available; generated-code execution is blocked until a provider passes its boundary probe.",
        details: status as unknown as Record<string, JsonValueV1>,
        checkedAt: context.now().toISOString(),
      };
    },
  };
}

function toolContribution(
  name: string,
  description: string,
  toolDescriptor: ToolDescriptorV1,
  parameters: ExtensionToolContributionV1["tool"]["parameters"],
  execute: ExtensionToolContributionV1["tool"]["execute"],
): ExtensionToolContributionV1 {
  return {
    descriptor: {
      version: 1,
      kind: "tool",
      id: `agentic-researcher-code:${name}`,
      displayName: name,
    },
    tool: { name, description, parameters, descriptor: toolDescriptor, execute },
  };
}

function descriptor(
  name: string,
  resourceType: string,
  action: ToolDescriptorV1["capability"]["action"],
  effect: ToolDescriptorV1["effect"],
  risk: ToolDescriptorV1["risk"],
  preparation: ToolDescriptorV1["execution"]["preparation"],
  fallback: ToolDescriptorV1["approval"]["fallback"] = "none",
): ToolDescriptorV1 {
  const prepared = preparation === "required";
  return {
    version: 1,
    name,
    capability: { system: "workspace", resourceType, action },
    effect,
    risk,
    approval: {
      allowPromptGrant: true,
      allowPersistentGrant: action === "validate" || effect === "read",
      fallback,
    },
    execution: {
      preparation,
      desktopOnly: true,
      cacheable: !prepared,
      parallelSafe: !prepared,
    },
    durability: {
      journal: prepared,
      receipt: prepared,
      readback: prepared ? "required" : "none",
      reconciliation: prepared ? "required" : "none",
    },
    allowedPrincipals: ["host", "single_agent", "lead"],
    ...(prepared ? { receiptKind: "artifact" as const } : {}),
  };
}

function sandboxParameters(
  hostResolvesWorkspaceProof = false,
): ExtensionToolContributionV1["tool"]["parameters"] {
  const workspaceProofProperties: Record<string, JsonSchemaObjectV1> = {};
  if (!hostResolvesWorkspaceProof) {
    workspaceProofProperties.profileKey = { type: "string" };
    workspaceProofProperties.projectId = { type: "string" };
    workspaceProofProperties.commandId = { type: "string" };
    workspaceProofProperties.workspaceManifestFingerprint = { type: "string" };
    workspaceProofProperties.stagingManifest = {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          path: { type: "string" },
          sha256: { type: "string" },
          bytes: { type: "integer" },
        },
        required: ["path", "sha256", "bytes"],
      },
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      ...workspaceProofProperties,
      workspaceId: { type: "string" },
      repairRequestId: { type: ["string", "null"] },
      expectedArtifacts: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string" },
            expectedSha256: { type: ["string", "null"] },
            maxBytes: { type: "integer" },
            required: { type: "boolean" },
          },
          required: ["path", "expectedSha256", "maxBytes", "required"],
        },
      },
      environment: { type: "object", additionalProperties: { type: "string" } },
    },
    required: [
      "workspaceId",
      "repairRequestId",
      ...(hostResolvesWorkspaceProof
        ? []
        : [
            "profileKey",
            "projectId",
            "commandId",
            "workspaceManifestFingerprint",
            "stagingManifest",
          ]),
    ],
  };
}

function resolveSandboxManager(
  manager: SandboxManagerV2 | (() => SandboxManagerV2),
): SandboxManagerV2 {
  return typeof manager === "function" ? manager() : manager;
}

function parseSandboxToolArgs(
  args: Record<string, unknown>,
  hostResolvesWorkspaceProof: boolean,
): ParsedSandboxToolArgsV2 {
  assertAllowedArgs(args, [
    "workspaceId", "repairRequestId", "expectedArtifacts", "environment",
    ...(hostResolvesWorkspaceProof
      ? []
      : [
          "profileKey", "projectId", "commandId",
          "workspaceManifestFingerprint", "stagingManifest",
        ]),
  ]);
  return {
    profileKey: hostResolvesWorkspaceProof ? null : requiredId(args.profileKey, "profileKey"),
    projectId: hostResolvesWorkspaceProof ? null : requiredId(args.projectId, "projectId"),
    commandId: hostResolvesWorkspaceProof ? null : requiredId(args.commandId, "commandId"),
    workspaceId: requiredId(args.workspaceId, "workspaceId"),
    repairRequestId: args.repairRequestId === null
      ? null
      : requiredId(args.repairRequestId, "repairRequestId"),
    workspaceManifestFingerprint: hostResolvesWorkspaceProof
      ? null
      : requiredFingerprint(
          args.workspaceManifestFingerprint,
          "workspaceManifestFingerprint",
        ),
    stagingManifest: hostResolvesWorkspaceProof
      ? null
      : requiredArray(
          args.stagingManifest,
          "stagingManifest",
        ) as SandboxPrepareInputV2["stagingManifest"],
    expectedArtifacts: args.expectedArtifacts === undefined
      ? []
      : requiredArray(args.expectedArtifacts, "expectedArtifacts") as SandboxPrepareInputV2["expectedArtifacts"],
    environment: args.environment === undefined
      ? {}
      : requiredRecord(args.environment, "environment") as Record<string, string>,
  };
}

function corePreparedAction(
  toolName: string,
  resourceType: string,
  sandboxAction: PreparedSandboxActionV2,
  context: ScopedExtensionContextV1,
): PreparedActionV1 {
  const runId = context.missionId?.trim();
  if (!runId) throw new CodeSandboxContributionErrorV2("mission_identity_required", "Prepared sandbox actions require a mission id.");
  const toolCallId = context.operationId?.trim() || `${sandboxAction.commandId}:prepare`;
  const normalizedArgs = {
    sandboxAction: sandboxAction as unknown as JsonValueV1,
  };
  const previewPayload = canonicalJson(normalizedArgs);
  const core = {
    version: 1 as const,
    id: `${sandboxAction.id}:${toolName}`,
    runId,
    toolCallId,
    toolName,
    target: {
      system: "workspace" as const,
      resourceType,
      id: sandboxAction.workspaceId,
      workspaceId: sandboxAction.workspaceId,
      repositoryProfileId: sandboxAction.profileKey,
      revision: sandboxAction.workspaceManifestFingerprint,
    },
    relatedResources: [
      {
        system: "git" as const,
        resourceType: "repository_profile",
        id: sandboxAction.profileKey,
        repositoryProfileId: sandboxAction.profileKey,
      },
    ],
    normalizedArgs,
    preview: {
      summary: `${toolName} via verified ${sandboxAction.provider} sandbox`,
      destination: `workspace ${sandboxAction.workspaceId}`,
      outboundPayload: {
        commandId: sandboxAction.commandId,
        runtimeDigest: sandboxAction.runtimeDigest,
        stagingManifestFingerprint: sha256Canonical(sandboxAction.stagingManifest),
        networkMode: sandboxAction.network.mode,
      },
      warnings: sandboxAction.network.mode === "exact_approval_required"
        ? ["Network is granted only for this exact lockfile restoration; no application credentials are forwarded."]
        : [],
      outboundBytes: Buffer.byteLength(previewPayload, "utf8"),
    },
    expectedTargetRevision: sandboxAction.workspaceManifestFingerprint,
    idempotencyKey: `${runId}:${sandboxAction.id}`,
    preparedAt: sandboxAction.preparedAt,
    expiresAt: sandboxAction.expiresAt,
  };
  return { ...core, payloadFingerprint: sha256Canonical(core) };
}

function extractSandboxAction(action: PreparedActionV1): PreparedSandboxActionV2 {
  const normalized = requiredRecord(action.normalizedArgs, "normalizedArgs");
  assertAllowedArgs(normalized, ["sandboxAction"]);
  return parsePreparedSandboxActionV2(normalized.sandboxAction);
}

function actionReceipt(
  action: PreparedActionV1,
  context: ScopedExtensionContextV1,
  sandboxReceipt: {
    id: string;
    fingerprint: string;
    startedAt: string;
    completedAt: string;
    importedArtifacts: Array<{ path: string }>;
  },
  operation: ActionReceiptV1["operation"],
): ActionReceiptV1 {
  const authorized = context.authorizedAction!;
  return {
    version: 1,
    id: sandboxReceipt.id,
    runId: action.runId,
    actionId: action.id,
    toolName: action.toolName,
    operation,
    resource: { ...action.target },
    relatedResources: action.relatedResources.map((resource) => ({ ...resource })),
    message: `Sandbox ${operation} completed with canonical validation and artifact readback receipt.`,
    payloadFingerprint: action.payloadFingerprint,
    grantId: authorized.grantId,
    idempotencyKey: action.idempotencyKey,
    providerRequestId: sandboxReceipt.fingerprint,
    startedAt: sandboxReceipt.startedAt,
    committedAt: sandboxReceipt.completedAt,
    commitKind: "committed",
    readback: {
      status: "verified",
      checkedAt: sandboxReceipt.completedAt,
      observedRevision: action.expectedTargetRevision,
      observedFingerprint: sandboxReceipt.fingerprint,
    },
    effects: {
      affectedCount: sandboxReceipt.importedArtifacts.length,
      changedFields: sandboxReceipt.importedArtifacts.map((artifact) => artifact.path),
    },
  };
}

function failure(code: string, message: string): PreparedActionResultV1 {
  return { ok: false, error: { code, message } };
}

function assertAllowedArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !expected.has(key));
  if (unknown.length > 0) throw new CodeSandboxContributionErrorV2("invalid_arguments", `Unknown arguments: ${unknown.join(", ")}.`);
}

function requiredId(value: unknown, label: string): string {
  const result = requiredString(value, label, 256);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(result)) throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} is invalid.`);
  return result;
}

function requiredFingerprint(value: unknown, label: string): string {
  const result = requiredString(value, label, 71);
  if (!/^sha256:[0-9a-f]{64}$/.test(result)) throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} must be canonical sha256.`);
  return result;
}

function requiredString(value: unknown, label: string, maxLength: number, allowControls = false): string {
  if (typeof value !== "string") throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} must be a string.`);
  const result = allowControls ? value : value.trim();
  if (!result || result.length > maxLength || (!allowControls && /[\0\r\n]/.test(result))) {
    throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} is invalid.`);
  }
  return result;
}

function requiredArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} must be an array.`);
  return value;
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CodeSandboxContributionErrorV2("invalid_arguments", `${label} must be an object.`);
  return value as Record<string, unknown>;
}

function sha256Text(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new CodeSandboxContributionErrorV2("invalid_canonical_value", "Unsafe canonical number.");
    return Object.is(value, -0) ? "0" : JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (!value || typeof value !== "object") throw new CodeSandboxContributionErrorV2("invalid_canonical_value", "Unsupported canonical value.");
  return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

export class CodeSandboxContributionErrorV2 extends Error {
  readonly mutationState = "not_applied" as const;

  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CodeSandboxContributionErrorV2";
  }
}
