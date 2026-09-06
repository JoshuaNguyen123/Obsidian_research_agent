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
import type {
  SandboxExecutionJournalV1,
  SandboxExecutionReconciliationV2,
  SandboxNotAppliedProofV2,
} from "./DurableSandboxExecutionJournalV1";

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
  /** Required durable write-ahead execution journal for every caller. */
  executionJournal: SandboxExecutionJournalV1;
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
    /**
     * Host-declared generated artifacts for this exact command. When present
     * they replace the model's optional `expectedArtifacts` argument outright,
     * so a command whose outputs the profile owns can never have that set
     * widened, narrowed, or renamed from a tool call.
     */
    expectedArtifacts?: SandboxPrepareInputV2["expectedArtifacts"];
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
  /**
   * Optional read-only supplemental receipt source. The mandatory execution
   * journal remains authoritative: supplemental evidence may complete an
   * uncertain dispatch with exact receipts, but it cannot downgrade durable
   * dispatch uncertainty to `not_applied` or replace a terminal journal state.
   */
  reconcileExecutionReceipt?(input: {
    runId: string;
    action: PreparedSandboxActionV2;
    context: ScopedExtensionContextV1;
  }): Promise<SandboxExecutionReconciliationV2>;
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
  requireExecutionJournal(options);
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
      : name === "code_validate_fast"
        ? "Purpose: Sandbox smoke validation. Use when: after workspace edits. Do not use when: calling verify_all or repo scripts as tools. Required: workspace scope. Next: code_repair_record_cycle if red, else targeted/full. Side effects: read/execute sandbox. Run the selected immutable RepositoryProfileV2 command only inside a verified sandbox."
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
          ? await preparationStageV2("sandbox_host_preparation_failed", () =>
              options.resolvePreparationInput!({
                purpose,
                workspaceId: normalized.workspaceId,
                context,
              }),
            )
          : null;
        const profile =
          hostProof?.profile ??
          (await preparationStageV2("repository_profile_lookup_failed", () =>
            options.getProfile(normalized.profileKey!),
          ));
        if (!profile) {
          return failure("repository_profile_missing", "The trusted RepositoryProfileV2 is unavailable.");
        }
        await preparationStageV2("repository_profile_invalid", () =>
          parseRepositoryProfileV2(profile),
        );
        const prepared = await preparationStageV2(
          "sandbox_prepare_rejected_by_manager",
          () => resolveSandboxManager(options.sandboxManager).prepareExecution({
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
          expectedArtifacts:
            hostProof?.expectedArtifacts ?? normalized.expectedArtifacts,
          environment: normalized.environment,
          }),
        );
        if (prepared.status === "blocked") {
          return failure(prepared.blocker.code, prepared.blocker.message);
        }
        const action = corePreparedAction(name, resourceType, prepared.action, context);
        const journal = await preparationStageV2("sandbox_journal_unavailable", () =>
          options.executionJournal.recordPrepared({
            runId: action.runId,
            action: prepared.action,
          }),
        );
        if (journal.status !== "prepared") {
          // This module's own known condition. It used to raise a plain Error,
          // which the classifier then reported as `sandbox_prepare_rejected` -
          // a replay of an already-dispatched action was indistinguishable in
          // telemetry from an unknown host exception.
          throw new CodeSandboxContributionErrorV2(
            "sandbox_journal_state_conflict",
            "This exact prepared sandbox action already has a terminal or ambiguous durable state; reconcile it instead of preparing a replay.",
          );
        }
        return {
          ok: true,
          action,
        };
      } catch (error) {
        return failure(...sandboxPreparationFailureV2(error));
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
      try {
        const dispatch = await options.executionJournal.markDispatching({
          runId: action.runId,
          action: sandboxAction,
        });
        if (dispatch.status !== "dispatch_uncertain") {
          throw new Error(`Unexpected durable dispatch state ${dispatch.status}.`);
        }
      } catch (error) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_journal_dispatch_failed",
          "Sandbox execution did not start because its durable dispatch marker failed. The underlying error text is withheld because it can carry host paths, command output, or credentials.",
        );
      }
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
      try {
        await options.executionJournal.recordExecutionReceipt({
          runId: action.runId,
          action: sandboxAction,
          receipt: result.receipt,
        });
      } catch (error) {
        throw new CodeSandboxContributionErrorV2(
          "sandbox_journal_receipt_failed",
          "Sandbox executed, but its durable execution receipt failed persistence/readback. The underlying error text is withheld because it can carry host paths, command output, or credentials.",
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
          await options.executionJournal.recordValidationReceipt({
            runId: action.runId,
            action: sandboxAction,
            validationReceipt,
          });
        } catch (error) {
          throw new CodeSandboxContributionErrorV2(
            "validation_receipt_persistence_failed",
            "Validation executed, but durable scoped receipt persistence/readback failed. The underlying error text is withheld because it can carry host paths, command output, or credentials.",
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
    async reconcile(action, context) {
      const sandboxAction = extractSandboxAction(action);
      let reconciliation: SandboxExecutionReconciliationV2;
      try {
        reconciliation = await options.executionJournal.reconcile({
          runId: action.runId,
          action: sandboxAction,
        });
        if (
          reconciliation.outcome === "still_uncertain" &&
          options.reconcileExecutionReceipt
        ) {
          const supplemental = await options.reconcileExecutionReceipt({
            runId: action.runId,
            action: sandboxAction,
            context,
          });
          if (supplemental.outcome === "committed") {
            await options.executionJournal.recordExecutionReceipt({
              runId: action.runId,
              action: sandboxAction,
              receipt: supplemental.receipt,
            });
            if (
              sandboxAction.repairRequestId !== null &&
              supplemental.validationReceipt !== undefined
            ) {
              await options.executionJournal.recordValidationReceipt({
                runId: action.runId,
                action: sandboxAction,
                validationReceipt: supplemental.validationReceipt,
              });
            }
            reconciliation = await options.executionJournal.reconcile({
              runId: action.runId,
              action: sandboxAction,
            });
          } else if (supplemental.outcome === "not_applied") {
            return {
              outcome: "still_uncertain" as const,
              message: boundedReconciliationMessage(
                "The durable journal marks sandbox dispatch as uncertain; supplemental not-applied evidence cannot downgrade that write-ahead state.",
              ),
            };
          } else {
            reconciliation = supplemental;
          }
        }
      } catch (error) {
        return {
          outcome: "still_uncertain" as const,
          message: boundedReconciliationMessage(
            // The caught error is foreign text. Length-bounding and keyword
            // redaction do not remove host paths, note titles, or command
            // output, so the detail is withheld rather than trimmed.
            "Durable sandbox receipt readback failed. The underlying error text is withheld because it can carry host paths, command output, or credentials.",
          ),
        };
      }
      if (reconciliation.outcome === "still_uncertain") {
        return {
          outcome: "still_uncertain" as const,
          message: boundedReconciliationMessage(reconciliation.message),
        };
      }
      if (reconciliation.outcome === "not_applied") {
        verifyNotAppliedProof(reconciliation.proof, sandboxAction);
        return {
          outcome: "not_applied" as const,
          message: boundedReconciliationMessage(reconciliation.message),
        };
      }
      const sandboxReceipt = verifyReconciledSandboxReceipt(
        reconciliation.receipt,
        sandboxAction,
      );
      if (sandboxAction.repairRequestId !== null) {
        verifyReconciledValidationReceipt(
          reconciliation.validationReceipt,
          sandboxAction,
          sandboxReceipt,
        );
      }
      const receipt = actionReceipt(
        action,
        context,
        sandboxReceipt,
        capabilityAction,
        "reconciled",
      );
      return {
        outcome: "committed" as const,
        receipt,
        message: "Durable sandbox execution and validation receipt readback matches the exact prepared action.",
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
    authorizationGrantId?: string;
    startedAt: string;
    completedAt: string;
    importedArtifacts: Array<{ path: string }>;
  },
  operation: ActionReceiptV1["operation"],
  commitKind: ActionReceiptV1["commitKind"] = "committed",
): ActionReceiptV1 {
  const grantId = commitKind === "reconciled"
    ? requiredId(sandboxReceipt.authorizationGrantId, "sandbox receipt authorizationGrantId")
    : requiredId(context.authorizedAction?.grantId, "authorized action grantId");
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
    grantId,
    idempotencyKey: action.idempotencyKey,
    providerRequestId: sandboxReceipt.fingerprint,
    startedAt: sandboxReceipt.startedAt,
    committedAt: sandboxReceipt.completedAt,
    commitKind,
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

function verifyReconciledSandboxReceipt(
  input: SandboxExecutionReceiptV2,
  action: PreparedSandboxActionV2,
): SandboxExecutionReceiptV2 {
  const receipt = JSON.parse(JSON.stringify(input)) as SandboxExecutionReceiptV2;
  const expectedKeys = [
    "version", "id", "actionId", "provider", "profileKey", "projectId",
    "commandId", "purpose", "status", "exitCode", "commandFingerprint",
    "stagingManifestFingerprint", "boundaryProbeFingerprint", "stdoutSha256",
    "stderrSha256", "stdoutBytes", "stderrBytes", "importedArtifacts",
    "authorizationGrantId", "startedAt", "completedAt", "fingerprint",
  ].sort();
  if (
    !receipt ||
    typeof receipt !== "object" ||
    Array.isArray(receipt) ||
    canonicalJson(Object.keys(receipt).sort()) !== canonicalJson(expectedKeys)
  ) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_reconciliation_receipt_invalid",
      "Durable sandbox reconciliation receipt has unknown or missing fields.",
    );
  }
  const { fingerprint, ...evidence } = receipt;
  if (
    receipt.version !== 1 ||
    receipt.actionId !== action.id ||
    receipt.provider !== action.provider ||
    receipt.profileKey !== action.profileKey ||
    receipt.projectId !== action.projectId ||
    receipt.commandId !== action.commandId ||
    receipt.purpose !== action.purpose ||
    receipt.commandFingerprint !== sha256Canonical(action.command) ||
    receipt.stagingManifestFingerprint !== sha256Canonical(action.stagingManifest) ||
    receipt.boundaryProbeFingerprint !== action.probeFingerprint ||
    !["verified", "failed"].includes(receipt.status) ||
    (receipt.status === "verified") !== (receipt.exitCode === 0) ||
    !Number.isSafeInteger(receipt.exitCode) ||
    fingerprint !== sha256Canonical(evidence)
  ) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_reconciliation_receipt_mismatch",
      "Durable sandbox receipt does not match the exact prepared action or canonical execution evidence.",
    );
  }
  requiredId(receipt.id, "sandbox receipt id");
  requiredId(receipt.authorizationGrantId, "sandbox receipt authorizationGrantId");
  requiredFingerprint(receipt.stdoutSha256, "sandbox stdout hash");
  requiredFingerprint(receipt.stderrSha256, "sandbox stderr hash");
  if (
    !Number.isSafeInteger(receipt.stdoutBytes) || receipt.stdoutBytes < 0 ||
    !Number.isSafeInteger(receipt.stderrBytes) || receipt.stderrBytes < 0 ||
    !Number.isFinite(Date.parse(receipt.startedAt)) ||
    !Number.isFinite(Date.parse(receipt.completedAt)) ||
    Date.parse(receipt.completedAt) < Date.parse(receipt.startedAt) ||
    !Array.isArray(receipt.importedArtifacts) ||
    receipt.importedArtifacts.length > 100
  ) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_reconciliation_receipt_invalid",
      "Durable sandbox receipt metadata is invalid.",
    );
  }
  const importedPaths = new Set<string>();
  for (const artifact of receipt.importedArtifacts) {
    if (
      !artifact ||
      typeof artifact !== "object" ||
      Array.isArray(artifact) ||
      canonicalJson(Object.keys(artifact).sort()) !==
        canonicalJson(["bytes", "path", "readbackSha256", "sha256"])
    ) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_reconciliation_receipt_invalid",
        "Durable sandbox artifact receipt is invalid.",
      );
    }
    const path = requiredString(artifact.path, "sandbox artifact path", 2_048);
    if (
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      importedPaths.has(path) ||
      artifact.sha256 !== artifact.readbackSha256 ||
      !/^sha256:[0-9a-f]{64}$/u.test(artifact.sha256) ||
      !Number.isSafeInteger(artifact.bytes) ||
      artifact.bytes < 0 ||
      artifact.bytes > 10 * 1024 * 1024
    ) {
      throw new CodeSandboxContributionErrorV2(
        "sandbox_reconciliation_receipt_invalid",
        "Durable sandbox artifact readback evidence is unsafe or mismatched.",
      );
    }
    importedPaths.add(path);
  }
  return receipt;
}

function verifyReconciledValidationReceipt(
  input: JsonValueV1 | undefined,
  action: PreparedSandboxActionV2,
  sandboxReceipt: SandboxExecutionReceiptV2,
): void {
  const receipt = requiredRecord(input, "durable validation receipt");
  const binding = requiredRecord(receipt.binding, "durable validation receipt binding");
  const { version: _version, kindName: _kindName, id: _id, fingerprint, ...evidence } = receipt;
  const expectedKind = action.purpose === "validation_fast"
    ? "fast"
    : action.purpose === "validation_targeted"
      ? "targeted"
      : "full";
  if (
    receipt.version !== 1 ||
    receipt.kindName !== "code_validation" ||
    receipt.id !== sandboxReceipt.id ||
    receipt.operationId !== action.id ||
    receipt.kind !== expectedKind ||
    receipt.status !== (sandboxReceipt.status === "verified" ? "passed" : "failed") ||
    receipt.startedAt !== sandboxReceipt.startedAt ||
    receipt.completedAt !== sandboxReceipt.completedAt ||
    binding.requestId !== action.repairRequestId ||
    binding.workspaceId !== action.workspaceId ||
    binding.profileKey !== action.profileKey ||
    binding.inputWorkspaceManifestFingerprint !== action.workspaceManifestFingerprint ||
    binding.stagingManifestFingerprint !== sha256Canonical(action.stagingManifest) ||
    typeof fingerprint !== "string" ||
    fingerprint !== sha256Canonical(evidence)
  ) {
    throw new CodeSandboxContributionErrorV2(
      "validation_reconciliation_receipt_mismatch",
      "Durable validation receipt does not match the exact repair-bound sandbox action.",
    );
  }
}

function verifyNotAppliedProof(
  input: SandboxNotAppliedProofV2,
  action: PreparedSandboxActionV2,
): void {
  const proof = requiredRecord(input, "sandbox not-applied proof");
  const evidence = {
    actionId: proof.actionId,
    actionFingerprint: proof.actionFingerprint,
    checkedAt: proof.checkedAt,
  };
  if (
    proof.actionId !== action.id ||
    proof.actionFingerprint !== action.payloadFingerprint ||
    !Number.isFinite(Date.parse(String(proof.checkedAt))) ||
    proof.fingerprint !== sha256Canonical(evidence)
  ) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_reconciliation_not_applied_invalid",
      "Sandbox not-applied outcome lacks exact fingerprinted durable readback proof.",
    );
  }
}

function boundedReconciliationMessage(input: string): string {
  const value = input
    .replace(/(?:token|password|secret|authorization|credential)\s*[=:]\s*\S+/giu, "credential=[REDACTED]")
    .trim();
  return (value || "Sandbox reconciliation remains uncertain.").slice(0, 1_000);
}

function requireExecutionJournal(
  options: CodeExecutionContributionFactoryOptionsV2,
): SandboxExecutionJournalV1 {
  const journal = (
    options as CodeExecutionContributionFactoryOptionsV2 & {
      executionJournal?: SandboxExecutionJournalV1;
    }
  ).executionJournal;
  const requiredMethods = [
    "recordPrepared",
    "markDispatching",
    "recordExecutionReceipt",
    "recordValidationReceipt",
    "reconcile",
  ] as const;
  if (
    !journal ||
    requiredMethods.some((method) => typeof journal[method] !== "function")
  ) {
    throw new CodeSandboxContributionErrorV2(
      "sandbox_execution_journal_required",
      "Code execution contributions require a durable write-ahead journal before they can be constructed.",
    );
  }
  return journal;
}

function failure(code: string, message: string): PreparedActionResultV1 {
  return { ok: false, error: { code, message } };
}

/**
 * Preserve the stable, privacy-safe code from our own validation boundary.
 * Collapsing every typed preparation failure into `sandbox_prepare_rejected`
 * made live reliability telemetry unable to distinguish model arguments from
 * provider, staging, or manifest defects. Unknown exceptions remain generic.
 */
function sandboxPreparationFailureCodeV2(error: unknown): string {
  return error instanceof CodeSandboxContributionErrorV2
    ? error.code
    : "sandbox_prepare_rejected";
}

/**
 * Bounded preparation stages. A failed tool call keeps only its error CODE in
 * the retained mission evidence, so the code string is the entire channel this
 * boundary has to telemetry; the stage is derived from it rather than carried
 * as a second field. `unattributed` is a first-class value: an exception this
 * module did not raise at a known step stays unexplained instead of borrowing
 * a stage that would read as an explanation.
 */
export const SANDBOX_PREPARATION_FAILURE_STAGES_V2 = [
  "arguments",
  "identity",
  "host_preparation",
  "profile",
  "sandbox_prepare",
  "journal",
  "unattributed",
] as const;

export type SandboxPreparationFailureStageV2 =
  (typeof SANDBOX_PREPARATION_FAILURE_STAGES_V2)[number];

/**
 * Coarse cause class, for triage only. `model_arguments` is a mistake the
 * model can correct on the next call; `host_environment` and `durable_state`
 * are not. `null` means this boundary genuinely does not know: neither
 * `SandboxManagerV2Error` nor `RepositoryProfileV2Error` carries a code, and
 * guessing a sub-cause from their message text would be inventing evidence.
 */
export const SANDBOX_PREPARATION_FAILURE_CAUSES_V2 = [
  "model_arguments",
  "host_environment",
  "durable_state",
] as const;

export type SandboxPreparationFailureCauseV2 =
  (typeof SANDBOX_PREPARATION_FAILURE_CAUSES_V2)[number];

/**
 * The closed set of codes this boundary assigns, each bound to the stage that
 * produced it. Blocker codes returned by SandboxManagerV2 are a separate typed
 * vocabulary that passes through unchanged and is deliberately absent here.
 */
const SANDBOX_PREPARATION_FAILURE_TABLE_V2: Readonly<
  Record<
    string,
    { stage: SandboxPreparationFailureStageV2; cause: SandboxPreparationFailureCauseV2 | null }
  >
> = {
  invalid_arguments: { stage: "arguments", cause: "model_arguments" },
  invalid_canonical_value: { stage: "arguments", cause: "model_arguments" },
  mission_identity_required: { stage: "identity", cause: "model_arguments" },
  sandbox_host_preparation_failed: { stage: "host_preparation", cause: "host_environment" },
  repository_profile_lookup_failed: { stage: "profile", cause: "host_environment" },
  repository_profile_missing: { stage: "profile", cause: "host_environment" },
  repository_profile_invalid: { stage: "profile", cause: null },
  sandbox_prepare_rejected_by_manager: { stage: "sandbox_prepare", cause: null },
  sandbox_journal_unavailable: { stage: "journal", cause: "durable_state" },
  sandbox_journal_state_conflict: { stage: "journal", cause: "durable_state" },
  sandbox_prepare_rejected: { stage: "unattributed", cause: null },
};

/** Every code the preparation boundary can assign, in a stable order. */
export const SANDBOX_PREPARATION_FAILURE_CODES_V2: readonly string[] =
  Object.keys(SANDBOX_PREPARATION_FAILURE_TABLE_V2);

/**
 * Pure, allowlisted projection from a retained `errorCode` to its bounded
 * stage and cause. Evidence consumers read this instead of building a second
 * classifier; an unrecognized code yields nulls rather than a default.
 */
export function classifySandboxPreparationFailureV2(code: string): {
  stage: SandboxPreparationFailureStageV2 | null;
  cause: SandboxPreparationFailureCauseV2 | null;
} {
  const entry = Object.prototype.hasOwnProperty.call(
    SANDBOX_PREPARATION_FAILURE_TABLE_V2,
    code,
  )
    ? SANDBOX_PREPARATION_FAILURE_TABLE_V2[code]
    : undefined;
  return entry ? { stage: entry.stage, cause: entry.cause } : { stage: null, cause: null };
}

/**
 * Run one preparation step and attribute anything it throws to that step.
 *
 * Attribution is STRUCTURAL — derived from which call threw — never from the
 * message text. `SandboxManagerV2Error` and `RepositoryProfileV2Error` carry
 * no code of their own, so before this the only way to tell "the model named a
 * validation command that does not exist" from "the host staging boundary
 * failed" was to read their prose, and both arrived as `sandbox_prepare_rejected`.
 * An error that already carries one of our codes keeps it: the inner code is
 * always the more specific of the two.
 */
async function preparationStageV2<T>(
  code: string,
  step: () => Promise<T> | T,
): Promise<T> {
  try {
    return await step();
  } catch (error) {
    if (error instanceof CodeSandboxContributionErrorV2) throw error;
    throw new CodeSandboxContributionErrorV2(code, WITHHELD_PREPARATION_DETAIL_V2);
  }
}

/**
 * Withheld-text notice for any failure whose message this boundary did not
 * author. A caught exception's `message` is arbitrary foreign text: host
 * `ENOENT` strings carry absolute vault paths, spawn failures carry command
 * lines, and provider SDK errors carry request payloads. That message used to
 * be copied verbatim into `PreparedActionResultV1.error.message`, which the
 * runner turns into the tool run's error and persists on the mission event
 * stream. The code is bounded; the message must be too.
 */
const WITHHELD_PREPARATION_DETAIL_V2 =
  "Sandbox preparation failed. The underlying error text is withheld because it can carry host paths, command output, or credentials; use the failure code to attribute it.";

/**
 * Bounded `{code, message}` pair for one caught preparation failure. Only the
 * messages this module authored are re-emitted; every other message is
 * replaced by a fixed notice.
 */
function sandboxPreparationFailureV2(error: unknown): [code: string, message: string] {
  const code = sandboxPreparationFailureCodeV2(error);
  return [
    code,
    error instanceof CodeSandboxContributionErrorV2
      ? error.message
      : WITHHELD_PREPARATION_DETAIL_V2,
  ];
}

function assertAllowedArgs(args: Record<string, unknown>, allowed: readonly string[]): void {
  const expected = new Set(allowed);
  const unknown = Object.keys(args).filter((key) => !expected.has(key));
  // Argument NAMES are model-authored text, not product vocabulary: a model
  // that invents `apiToken` or a note title as a key would otherwise write it
  // into a persisted error. The count is the diagnosable part; the keys are
  // already visible to the model in its own call.
  if (unknown.length > 0) {
    throw new CodeSandboxContributionErrorV2(
      "invalid_arguments",
      `Rejected ${unknown.length} unknown argument name(s); this tool accepts only ${expected.size} declared argument(s).`,
    );
  }
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
