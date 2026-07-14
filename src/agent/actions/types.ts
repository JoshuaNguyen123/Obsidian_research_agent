export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ResourceSystem =
  | "vault"
  | "web"
  | "browser"
  | "workspace"
  | "git"
  | "linear"
  | "github";

export type ResourceAction =
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

export interface ResourceRef {
  system: ResourceSystem;
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

export type ActionEffect =
  | "read"
  | "reversible_mutation"
  | "destructive_mutation"
  | "execution"
  | "publish";

export type ToolPrincipal =
  | "host"
  | "single_agent"
  | "lead"
  | "researcher"
  | "code_worker";

export interface ToolDescriptor {
  version: 1;
  name: string;
  capability: {
    system: ResourceSystem;
    resourceType: string;
    action: ResourceAction;
  };
  effect: ActionEffect;
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
  allowedPrincipals: ToolPrincipal[];
  receiptKind?: "vault_write" | "artifact" | "external_action" | "code_change";
  operationGoals?: string[];
}

export interface PreparedActionPreview {
  summary: string;
  destination: string;
  before?: Record<string, JsonValue>;
  after?: Record<string, JsonValue>;
  outboundPayload?: Record<string, JsonValue>;
  duplicateCandidates?: ResourceRef[];
  warnings: string[];
  outboundBytes: number;
}

export interface PreparedAction {
  version: 1;
  id: string;
  runId: string;
  toolCallId: string;
  toolName: string;
  target: ResourceRef;
  relatedResources: ResourceRef[];
  normalizedArgs: Record<string, JsonValue>;
  preview: PreparedActionPreview;
  payloadFingerprint: string;
  expectedTargetRevision?: string;
  idempotencyKey?: string;
  reconciliationKey?: string;
  /** Host-enforced escalation for this exact fingerprinted payload. */
  requiredConfirmations?: 1 | 2;
  preparedAt: string;
  expiresAt: string;
}

export type PreparedActionInput = Omit<PreparedAction, "payloadFingerprint">;

export type PreparedActionResult =
  | { ok: true; action: PreparedAction }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
      };
    };

export interface AuthorizedActionContext {
  preparedActionId: string;
  payloadFingerprint: string;
  grantId: string;
}

export interface ActionReceipt {
  version: 1;
  id: string;
  runId: string;
  actionId: string;
  toolName: string;
  operation: ResourceAction;
  resource: ResourceRef;
  relatedResources?: ResourceRef[];
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

export interface ActionReconciliationResult {
  outcome: "committed" | "not_applied" | "still_uncertain";
  receipt?: ActionReceipt;
  message: string;
}
