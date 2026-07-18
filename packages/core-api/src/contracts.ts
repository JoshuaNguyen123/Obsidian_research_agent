export const AGENTIC_RESEARCHER_CORE_API_MAJOR = 1 as const;
export const AGENTIC_RESEARCHER_CORE_API_MINOR = 2 as const;

export type CoreApiMajorV1 = typeof AGENTIC_RESEARCHER_CORE_API_MAJOR;
export type CoreApiMinorV1 = typeof AGENTIC_RESEARCHER_CORE_API_MINOR;
export type CoreLifecycleStateV1 = "loading" | "ready" | "unloading";

export type JsonValueV1 =
  | null
  | boolean
  | number
  | string
  | JsonValueV1[]
  | { [key: string]: JsonValueV1 };

export interface JsonSchemaObjectV1 {
  type?: string | string[];
  description?: string;
  properties?: Record<string, JsonSchemaObjectV1>;
  required?: string[];
  items?: JsonSchemaObjectV1;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchemaObjectV1;
  [key: string]: unknown;
}

export type ResourceSystemV1 =
  | "vault"
  | "web"
  | "browser"
  | "workspace"
  | "git"
  | "linear"
  | "github";

export type ResourceActionV1 =
  | "read"
  | "list"
  | "search"
  | "create"
  | "append"
  | "update"
  | "replace"
  | "move"
  | "archive"
  | "unarchive"
  | "trash"
  | "delete"
  | "restore"
  | "link"
  | "unlink"
  | "validate"
  | "promote"
  | "merge"
  | "execute"
  | "install"
  | "commit"
  | "integrate"
  | "publish";

export interface ResourceRefV1 {
  system: ResourceSystemV1;
  resourceType: string;
  id: string;
  identifier?: string;
  url?: string;
  path?: string;
  accountId?: string;
  containerId?: string;
  workspaceId?: string;
  teamId?: string;
  projectId?: string;
  repositoryId?: string;
  repositoryProfileId?: string;
  revision?: string;
}

export interface ToolDescriptorV1 {
  version: 1;
  name: string;
  capability: {
    system: ResourceSystemV1;
    resourceType: string;
    action: ResourceActionV1;
  };
  effect:
    | "read"
    | "reversible_mutation"
    | "destructive_mutation"
    | "execution"
    | "publish";
  risk: "low" | "medium" | "high" | "critical";
  approval: {
    allowPromptGrant: boolean;
    allowPersistentGrant: boolean;
    fallback: "none" | "exact" | "double_exact" | "block";
  };
  execution: {
    preparation: "none" | "optional" | "required";
    desktopOnly?: boolean;
    cacheable: boolean;
    parallelSafe: boolean;
  };
  durability: {
    journal: boolean;
    receipt: boolean;
    readback: "none" | "optional" | "required";
    reconciliation: "none" | "optional" | "required";
  };
  allowedPrincipals: Array<
    "host" | "single_agent" | "lead" | "researcher" | "code_worker"
  >;
  receiptKind?: "vault_write" | "artifact" | "external_action" | "code_change";
  operationGoals?: string[];
}

export interface PreparedActionV1 {
  version: 1;
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  target: ResourceRefV1;
  relatedResources: ResourceRefV1[];
  normalizedArgs: Record<string, JsonValueV1>;
  preview: {
    summary: string;
    destination: string;
    before?: Record<string, JsonValueV1>;
    after?: Record<string, JsonValueV1>;
    outboundPayload?: Record<string, JsonValueV1>;
    duplicateCandidates?: ResourceRefV1[];
    warnings: string[];
    outboundBytes: number;
  };
  payloadFingerprint: string;
  expectedTargetRevision?: string;
  idempotencyKey?: string;
  reconciliationKey?: string;
  /** Host-enforced escalation for this exact fingerprinted payload. */
  requiredConfirmations?: 1 | 2;
  preparedAt: string;
  expiresAt: string;
}

export type PreparedActionResultV1 =
  | { ok: true; action: PreparedActionV1 }
  | { ok: false; error: { code: string; message: string } };

export interface AuthorizedActionContextV1 {
  preparedActionId: string;
  payloadFingerprint: string;
  grantId: string;
}

export interface ActionReceiptV1 {
  version: 1;
  id: string;
  runId: string;
  actionId: string;
  toolName: string;
  operation: ResourceActionV1;
  resource: ResourceRefV1;
  relatedResources?: ResourceRefV1[];
  message: string;
  payloadFingerprint: string;
  grantId: string;
  idempotencyKey?: string;
  providerRequestId?: string;
  startedAt: string;
  committedAt: string;
  commitKind: "committed" | "reconciled";
  readback: {
    status: "verified" | "not_required";
    checkedAt: string;
    observedRevision?: string;
    observedFingerprint?: string;
  };
  effects?: {
    bytesWritten?: number;
    bytesDeleted?: number;
    affectedCount?: number;
    changedFields?: string[];
  };
}

export interface ActionReconciliationResultV1 {
  outcome: "committed" | "not_applied" | "still_uncertain";
  receipt?: ActionReceiptV1;
  message: string;
}

/**
 * This is the complete context an extension handler may receive from core.
 * Privileged Obsidian objects, raw settings, model clients, and secrets are
 * intentionally absent. Provider clients and scoped resource handles remain
 * owned by the registering extension or a future explicitly versioned handle.
 */
export interface ScopedExtensionContextV1 {
  version: 1;
  extensionId: string;
  missionId?: string;
  /** Durable root identity shared by every verified continuation segment. */
  rootMissionId?: string;
  operationId?: string;
  originalPrompt?: string;
  deadlineAt?: number;
  abortSignal: AbortSignal;
  authorizedAction?: AuthorizedActionContextV1;
  now(): Date;
  reportProgress(message: string): void;
}

export type ExtensionContributionKindV1 =
  | "tool"
  | "mission_executor"
  | "mission_verifier"
  | "settings"
  | "status"
  | "background_handler"
  | "serializer";

export interface ExtensionContributionDescriptorV1<
  TKind extends ExtensionContributionKindV1 = ExtensionContributionKindV1,
> {
  version: 1;
  kind: TKind;
  id: string;
  displayName: string;
  description?: string;
}

export interface ExtensionToolV1 {
  name: string;
  description: string;
  parameters: JsonSchemaObjectV1;
  descriptor: ToolDescriptorV1;
  execute(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<unknown>;
  prepare?(
    args: Record<string, unknown>,
    context: ScopedExtensionContextV1,
  ): Promise<PreparedActionResultV1>;
  executePrepared?(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<{
    output?: unknown;
    receipt: ActionReceiptV1;
    mutationState: "applied";
  }>;
  reconcile?(
    action: PreparedActionV1,
    context: ScopedExtensionContextV1,
  ): Promise<ActionReconciliationResultV1>;
}

export interface ExtensionToolContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"tool">;
  tool: ExtensionToolV1;
}

export interface MissionExecutorInputV1 {
  missionId: string;
  nodeId: string;
  objective: string;
  inputs: Record<string, JsonValueV1>;
}

export interface MissionExecutorResultV1 {
  status:
    | "complete"
    | "blocked"
    | "waiting_approval"
    | "waiting_obsidian"
    | "cancelled";
  outputs?: Record<string, JsonValueV1>;
  evidence?: JsonValueV1[];
  message?: string;
}

export interface MissionExecutorContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"mission_executor">;
  execute(
    input: MissionExecutorInputV1,
    context: ScopedExtensionContextV1,
  ): Promise<MissionExecutorResultV1>;
}

export interface MissionVerifierInputV1 {
  missionId: string;
  nodeId: string;
  objective: string;
  outputs: Record<string, JsonValueV1>;
  evidence: JsonValueV1[];
  receiptIds: string[];
}

export interface MissionVerifierResultV1 {
  status: "pass" | "fail" | "needs_more_work" | "blocked";
  message: string;
  missing: string[];
  evidenceIds: string[];
  receiptIds: string[];
}

export interface MissionVerifierContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"mission_verifier">;
  verify(
    input: MissionVerifierInputV1,
    context: ScopedExtensionContextV1,
  ): Promise<MissionVerifierResultV1>;
}

export interface ExtensionSettingFieldV1 {
  id: string;
  type: "string" | "boolean" | "integer" | "secret_reference" | "select";
  label: string;
  description?: string;
  defaultValue?: JsonValueV1;
  options?: Array<{ label: string; value: string }>;
}

export interface SettingsContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"settings">;
  section: {
    id: string;
    title: string;
    fields: ExtensionSettingFieldV1[];
  };
}

export interface ExtensionHealthStatusV1 {
  status: "healthy" | "degraded" | "blocked" | "disabled";
  summary: string;
  details?: Record<string, JsonValueV1>;
  checkedAt: string;
}

export interface StatusContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"status">;
  readStatus(context: ScopedExtensionContextV1): Promise<ExtensionHealthStatusV1>;
}

export interface BackgroundEventV1 {
  type: string;
  payload: JsonValueV1;
  occurredAt: string;
}

export interface BackgroundHandlerContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"background_handler">;
  handle(
    event: BackgroundEventV1,
    context: ScopedExtensionContextV1,
  ): Promise<void>;
}

export interface SerializerContributionV1 {
  descriptor: ExtensionContributionDescriptorV1<"serializer">;
  target: "receipt" | "pending_action";
  type: string;
  serialize(value: unknown, context: ScopedExtensionContextV1): Promise<JsonValueV1>;
  deserialize(
    value: JsonValueV1,
    context: ScopedExtensionContextV1,
  ): Promise<unknown>;
}

export type ExtensionContributionV1 =
  | ExtensionToolContributionV1
  | MissionExecutorContributionV1
  | MissionVerifierContributionV1
  | SettingsContributionV1
  | StatusContributionV1
  | BackgroundHandlerContributionV1
  | SerializerContributionV1;

export interface ExtensionManifestV1 {
  id: string;
  displayName: string;
  version: string;
  apiMajor: number;
  apiMinor: number;
}

export interface RegisterExtensionRequestV1 {
  manifest: ExtensionManifestV1;
  contributions: ExtensionContributionV1[];
}

/** Opaque by identity: copied token-shaped objects are never accepted. */
export interface ExtensionRegistrationTokenV1 {
  version: 1;
  id: string;
  extensionId: string;
  apiMajor: CoreApiMajorV1;
  apiMinor: CoreApiMinorV1;
  issuedAt: string;
  signal: AbortSignal;
}

export interface RegisteredContributionV1<T extends ExtensionContributionV1> {
  extensionId: string;
  token: ExtensionRegistrationTokenV1;
  contribution: T;
}

export interface ExtensionMissionSnapshotV1 {
  version: 1;
  missionId: string;
  createdAt: string;
  apiMajor: CoreApiMajorV1;
  apiMinor: CoreApiMinorV1;
  tools: ReadonlyArray<RegisteredContributionV1<ExtensionToolContributionV1>>;
  executors: ReadonlyArray<RegisteredContributionV1<MissionExecutorContributionV1>>;
  verifiers: ReadonlyArray<RegisteredContributionV1<MissionVerifierContributionV1>>;
  settings: ReadonlyArray<RegisteredContributionV1<SettingsContributionV1>>;
  statuses: ReadonlyArray<RegisteredContributionV1<StatusContributionV1>>;
  backgroundHandlers: ReadonlyArray<
    RegisteredContributionV1<BackgroundHandlerContributionV1>
  >;
  serializers: ReadonlyArray<RegisteredContributionV1<SerializerContributionV1>>;
}

export interface ExpectedExtensionV1 {
  id: string;
  displayName: string;
  apiMajor: CoreApiMajorV1;
  minimumApiMinor: CoreApiMinorV1;
  optional: boolean;
}

export interface ExpectedExtensionStatusV1 extends ExpectedExtensionV1 {
  availability: "registered" | "missing" | "incompatible";
  registeredVersion?: string;
  message: string;
}

export type ExtensionStateNamespaceV1 = "code" | "integrations" | "companion";

/**
 * Secret-free state offered by core to the extension that owns the namespace.
 * The registration token, rather than this payload, is the authority boundary.
 */
export interface ExtensionStateMigrationOfferV1 {
  version: 1;
  migrationId: string;
  namespace: ExtensionStateNamespaceV1;
  mode: "legacy_v2" | "new_install";
  preparedAt: string;
  sourceSnapshotHash: string | null;
  snapshotHash: string;
  snapshot: JsonValueV1;
  alreadyVerified: boolean;
  acknowledgedAt: string | null;
  retainedReleaseIds: [string, string] | null;
  pendingSecureImportKinds: string[];
}

/** The extension returns the value read back from its own data.json. */
export interface ExtensionStateMigrationReadbackV1 {
  version: 1;
  migrationId: string;
  namespace: ExtensionStateNamespaceV1;
  snapshot: JsonValueV1;
  acknowledgedAt: string;
}

export interface ExtensionStateMigrationResultV1 {
  version: 1;
  migrationId: string;
  namespace: ExtensionStateNamespaceV1;
  snapshotHash: string;
  verified: true;
  pendingSecureImportKinds: string[];
}

export interface AgenticResearcherCoreApiV1 {
  readonly apiMajor: CoreApiMajorV1;
  readonly apiMinor: CoreApiMinorV1;
  readonly state: CoreLifecycleStateV1;
  registerExtension(request: RegisterExtensionRequestV1): ExtensionRegistrationTokenV1;
  unregisterExtension(token: ExtensionRegistrationTokenV1, reason?: string): boolean;
  getStateMigrationOffer(
    token: ExtensionRegistrationTokenV1,
  ): ExtensionStateMigrationOfferV1;
  acknowledgeStateMigration(
    token: ExtensionRegistrationTokenV1,
    readback: ExtensionStateMigrationReadbackV1,
  ): Promise<ExtensionStateMigrationResultV1>;
}

export class ExtensionUnavailableErrorV1 extends Error {
  readonly code = "extension_unavailable";
  readonly mutationState = "not_applied" as const;

  constructor(readonly extensionId: string) {
    super(`Extension is unavailable: ${extensionId}`);
    this.name = "ExtensionUnavailableErrorV1";
  }
}

export class ExtensionRegistrationErrorV1 extends Error {
  constructor(
    readonly code:
      | "core_not_ready"
      | "core_unloading"
      | "api_major_mismatch"
      | "api_minor_unsupported"
      | "duplicate_extension"
      | "duplicate_contribution"
      | "invalid_manifest"
      | "invalid_contribution",
    message: string,
  ) {
    super(message);
    this.name = "ExtensionRegistrationErrorV1";
  }
}
