import type { PreparedAction, ToolDescriptor } from "../actions";
import {
  consumeAuthorityGrant,
  evaluateAuthorityGrant,
  revokeAuthorityGrant,
  verifyAuthorityGrantFingerprint,
} from "./grants";
import type { AuthorityGrantV1 } from "./types";

export const AUTHORITY_GRANT_STORE_VERSION = 1 as const;
export const MAX_STORED_AUTHORITY_GRANTS = 32;

export interface AuthorityGrantStoreStateV1 {
  version: typeof AUTHORITY_GRANT_STORE_VERSION;
  revision: number;
  grants: AuthorityGrantV1[];
  updatedAt: string;
}

export class AuthorityGrantStore {
  private state: AuthorityGrantStoreStateV1;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    initial: AuthorityGrantStoreStateV1,
    private readonly persist: (
      state: AuthorityGrantStoreStateV1,
      expectedRevision: number,
    ) => Promise<void>,
  ) {
    this.state = cloneState(initial);
  }

  snapshot(): AuthorityGrantStoreStateV1 {
    return cloneState(this.state);
  }

  get(grantId: string): AuthorityGrantV1 | null {
    const grant = this.state.grants.find((item) => item.id === grantId);
    return grant ? cloneGrant(grant) : null;
  }

  async upsert(grant: AuthorityGrantV1, now = new Date()): Promise<void> {
    if (!(await verifyAuthorityGrantFingerprint(grant))) {
      throw new Error("Authority grant fingerprint is invalid.");
    }
    await this.mutate((current) => {
      const grants = [
        ...current.grants.filter((item) => item.id !== grant.id),
        cloneGrant(grant),
      ];
      if (grants.length > MAX_STORED_AUTHORITY_GRANTS) {
        const removable = grants
          .filter((item) => item.state !== "active")
          .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt));
        while (
          grants.length > MAX_STORED_AUTHORITY_GRANTS &&
          removable.length > 0
        ) {
          const remove = removable.shift()!;
          const index = grants.findIndex((item) => item.id === remove.id);
          if (index >= 0) grants.splice(index, 1);
        }
      }
      if (grants.length > MAX_STORED_AUTHORITY_GRANTS) {
        throw new Error("Active authority grant limit reached.");
      }
      return nextState(current, grants, now);
    });
  }

  async authorizeAndConsume(input: {
    grantId: string;
    action: PreparedAction;
    descriptor: ToolDescriptor;
    /** Explicit queue/schedule subject; defaults to the prepared action run. */
    subject?: AuthorityGrantV1["subject"];
    now?: Date;
  }): Promise<AuthorityGrantV1> {
    let consumed: AuthorityGrantV1 | null = null;
    await this.mutate(async (current) => {
      const index = current.grants.findIndex((item) => item.id === input.grantId);
      if (index < 0) throw new Error("Authority grant was not found.");
      const grant = current.grants[index];
      const evaluation = await evaluateAuthorityGrant({
        grant,
        action: input.action,
        descriptor: input.descriptor,
        subject: input.subject,
        now: input.now,
      });
      if (!evaluation.allowed) throw new Error(evaluation.reason);
      const result = await consumeAuthorityGrant({
        grant,
        action: input.action,
        descriptor: input.descriptor,
        subject: input.subject,
        now: input.now,
      });
      if (!result.allowed) throw new Error(result.reason);
      consumed = result.grant;
      const grants = current.grants.map((item, itemIndex) =>
        itemIndex === index ? cloneGrant(result.grant) : item,
      );
      return nextState(current, grants, input.now ?? new Date());
    });
    if (!consumed) throw new Error("Authority grant consumption failed.");
    return cloneGrant(consumed);
  }

  async revoke(grantId: string, now = new Date()): Promise<void> {
    await this.mutate((current) => {
      const index = current.grants.findIndex((item) => item.id === grantId);
      if (index < 0) return current;
      const grants = current.grants.map((item, itemIndex) =>
        itemIndex === index ? revokeAuthorityGrant(item, now) : item,
      );
      return nextState(current, grants, now);
    });
  }

  private async mutate(
    update: (
      current: AuthorityGrantStoreStateV1,
    ) => AuthorityGrantStoreStateV1 | Promise<AuthorityGrantStoreStateV1>,
  ): Promise<void> {
    const operation = this.tail.catch(() => undefined).then(async () => {
      const current = cloneState(this.state);
      const next = await update(current);
      if (next === current) return;
      assertState(next);
      await this.persist(cloneState(next), current.revision);
      this.state = cloneState(next);
    });
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    await operation;
  }
}

export function createAuthorityGrantStoreState(
  now = new Date(),
): AuthorityGrantStoreStateV1 {
  return {
    version: AUTHORITY_GRANT_STORE_VERSION,
    revision: 0,
    grants: [],
    updatedAt: now.toISOString(),
  };
}

export function normalizeAuthorityGrantStoreState(
  value: unknown,
): AuthorityGrantStoreStateV1 | null {
  if (!isRecord(value) || value.version !== AUTHORITY_GRANT_STORE_VERSION) {
    return null;
  }
  if (
    !Number.isSafeInteger(value.revision) ||
    (value.revision as number) < 0 ||
    !Array.isArray(value.grants) ||
    value.grants.length > MAX_STORED_AUTHORITY_GRANTS ||
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt))
  ) {
    return null;
  }
  const grants = value.grants.filter(isGrantShape).map(cloneGrant);
  if (grants.length !== value.grants.length || new Set(grants.map((item) => item.id)).size !== grants.length) {
    return null;
  }
  return {
    version: AUTHORITY_GRANT_STORE_VERSION,
    revision: value.revision as number,
    grants,
    updatedAt: new Date(Date.parse(value.updatedAt)).toISOString(),
  };
}

function nextState(
  current: AuthorityGrantStoreStateV1,
  grants: AuthorityGrantV1[],
  now: Date,
): AuthorityGrantStoreStateV1 {
  return {
    version: AUTHORITY_GRANT_STORE_VERSION,
    revision: current.revision + 1,
    grants: grants.map(cloneGrant),
    updatedAt: now.toISOString(),
  };
}

function assertState(state: AuthorityGrantStoreStateV1): void {
  if (!normalizeAuthorityGrantStoreState(state)) {
    throw new Error("Authority grant store state is invalid.");
  }
}

function cloneState(state: AuthorityGrantStoreStateV1): AuthorityGrantStoreStateV1 {
  return JSON.parse(JSON.stringify(state)) as AuthorityGrantStoreStateV1;
}

function cloneGrant(grant: AuthorityGrantV1): AuthorityGrantV1 {
  return JSON.parse(JSON.stringify(grant)) as AuthorityGrantV1;
}

function isGrantShape(value: unknown): value is AuthorityGrantV1 {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.authorityFingerprint === "string" &&
    Array.isArray(value.rules) &&
    isRecord(value.usage) &&
    isRecord(value.limits)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
