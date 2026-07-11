import type {
  PreparedAction,
  ResourceAction,
  ResourceSystem,
  ToolDescriptor,
} from "../actions";

export type AuthorityGrantKind =
  | "prompt_bound"
  | "one_shot"
  | "run_bounded"
  | "scheduled_bounded";

export interface AuthoritySelector {
  accountIds?: string[];
  workspaceIds?: string[];
  teamIds?: string[];
  projectIds?: string[];
  repositoryIds?: string[];
  repositoryProfileIds?: string[];
  containerIds?: string[];
  resourceIds?: string[];
  pathPrefixes?: string[];
}

export interface AuthorityRule {
  system: ResourceSystem;
  resourceTypes: string[];
  actions: ResourceAction[];
  selector: AuthoritySelector;
}

export interface AuthorityGrantLimits {
  maxActions: number;
  maxExternalMutations: number;
  maxCreates: number;
  maxDeletes: number;
  maxOutboundBytes: number;
}

export interface AuthorityGrantUsage {
  actions: number;
  externalMutations: number;
  creates: number;
  deletes: number;
  outboundBytes: number;
  lastUsedAt?: string;
}

export interface AuthorityGrantV1 {
  version: 1;
  id: string;
  kind: AuthorityGrantKind;
  issuer: "user_prompt" | "user_approval";
  subject: { type: "run" | "schedule"; id: string };
  rules: AuthorityRule[];
  actionFingerprint?: string;
  limits: AuthorityGrantLimits;
  usage: AuthorityGrantUsage;
  state: "active" | "revoked" | "expired" | "exhausted";
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
  authorityFingerprint: string;
}

export interface AuthorityEvaluationInput {
  grant: AuthorityGrantV1;
  action: PreparedAction;
  descriptor: ToolDescriptor;
  subject?: AuthorityGrantV1["subject"];
  now?: Date;
}

export type AuthorityEvaluation =
  | { allowed: true; grant: AuthorityGrantV1 }
  | { allowed: false; reason: string };

export interface OneShotGrantInput {
  id: string;
  action: PreparedAction;
  descriptor: ToolDescriptor;
  issuer?: AuthorityGrantV1["issuer"];
  issuedAt?: Date;
  expiresAt?: Date;
}

export interface BoundedGrantInput {
  id: string;
  kind: "run_bounded" | "scheduled_bounded";
  subject: AuthorityGrantV1["subject"];
  rules: AuthorityRule[];
  limits: AuthorityGrantLimits;
  issuer?: AuthorityGrantV1["issuer"];
  issuedAt?: Date;
  expiresAt?: Date;
}
