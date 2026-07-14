import type {
  SecretLeaseV1,
  SecretStoreV1,
} from "../../../packages/core-api/src/secretStoreV1";
import type {
  HttpResponse,
  HttpTransport,
} from "../../model/types";

export const LINEAR_OAUTH_AUTHORIZE_ENDPOINT = "https://linear.app/oauth/authorize";
export const LINEAR_OAUTH_TOKEN_ENDPOINT = "https://api.linear.app/oauth/token";
export const LINEAR_OAUTH_REVOKE_ENDPOINT = "https://api.linear.app/oauth/revoke";
export const LINEAR_OAUTH_REFRESH_REPLAY_GRACE_MS = 30 * 60 * 1_000;
export const LINEAR_OAUTH_DEFAULT_ACCESS_TOKEN_SECONDS = 24 * 60 * 60;
export const LINEAR_OAUTH_MAX_ACTIVE_SESSIONS = 8;
export const LINEAR_OAUTH_MAX_REFRESH_RECONCILIATION_ATTEMPTS = 8;

const OAUTH_SESSION_TTL_MS = 10 * 60 * 1_000;
const MIN_LOOPBACK_PORT = 1_024;
const MAX_LOOPBACK_PORT = 65_535;
const MAX_OAUTH_RESPONSE_BYTES = 128_000;
const MAX_TOKEN_BYTES = 65_536;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const CALLBACK_PATH = "/oauth/linear/callback";
const SECRET_REFERENCE_PATTERN = /^(?:secret|credential)_[A-Za-z0-9-]{8,128}$/;
const SAFE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{3,256}$/;
const SESSION_ID_PATTERN = /^linear_oauth_session_[A-Za-z0-9_-]{20,128}$/;
const PENDING_ID_PATTERN = /^linear_oauth_refresh_[A-Za-z0-9_-]{20,128}$/;

export type LinearOAuthActorV1 = "user" | "app";
export type LinearOAuthScopeV1 = "read" | "write";

export interface LinearOAuthLoopbackCallbackV1 {
  host: "127.0.0.1";
  port: number;
  path: typeof CALLBACK_PATH;
}

export interface LinearOAuthAuthorizationRequestV1 {
  version: 1;
  sessionId: string;
  actor: LinearOAuthActorV1;
  scopes: LinearOAuthScopeV1[];
  authorizationUrl: string;
  redirectUri: string;
  createdAt: string;
  expiresAt: string;
}

export interface LinearOAuthCodeGrantV1 {
  readonly disposed: boolean;
  readonly sessionId: string;
  readonly actor: LinearOAuthActorV1;
  readonly scopes: readonly LinearOAuthScopeV1[];
  readonly redirectUri: string;
  withGrant<TResult>(
    use: (grant: { code: string; codeVerifier: string }) => Promise<TResult>,
  ): Promise<TResult>;
  dispose(): void;
  toJSON(): {
    redacted: true;
    sessionId: string;
    actor: LinearOAuthActorV1;
    scopes: readonly LinearOAuthScopeV1[];
    redirectUri: string;
  };
}

interface PrivateOAuthSessionV1 {
  sessionId: string;
  state: string;
  verifier: string;
  actor: LinearOAuthActorV1;
  scopes: LinearOAuthScopeV1[];
  redirectUri: string;
  callback: LinearOAuthLoopbackCallbackV1;
  createdAt: string;
  expiresAt: string;
}

export interface LinearOAuthSessionManagerV1Options {
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  sha256?: (value: Uint8Array) => Promise<Uint8Array>;
}

/**
 * One-time, foreground PKCE session manager. Verifiers and state values never
 * cross a serialization boundary and are discarded when the callback is used.
 */
export class LinearOAuthSessionManagerV1 {
  private readonly sessions = new Map<string, PrivateOAuthSessionV1>();
  private readonly now: () => Date;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly sha256: (value: Uint8Array) => Promise<Uint8Array>;

  constructor(options: LinearOAuthSessionManagerV1Options = {}) {
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.sha256 = options.sha256 ?? sha256Bytes;
  }

  async begin(input: {
    clientId: string;
    actor: LinearOAuthActorV1;
    scopes?: readonly LinearOAuthScopeV1[];
    callback: LinearOAuthLoopbackCallbackV1;
  }): Promise<LinearOAuthAuthorizationRequestV1> {
    this.pruneExpired();
    if (this.sessions.size >= LINEAR_OAUTH_MAX_ACTIVE_SESSIONS) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_session_limit",
        "Too many Linear authorization sessions are active; cancel or finish one first.",
      );
    }
    const clientId = normalizeClientId(input.clientId);
    const actor = normalizeActor(input.actor);
    const scopes = normalizeScopes(input.scopes ?? ["read", "write"]);
    const callback = normalizeCallback(input.callback);
    const now = requireValidDate(this.now(), "OAuth session time");
    const state = base64Url(this.randomBytes(32));
    const verifier = base64Url(this.randomBytes(64));
    if (verifier.length < 43 || verifier.length > 128) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_crypto_unavailable",
        "A valid PKCE verifier could not be generated.",
      );
    }
    const challenge = base64Url(
      await this.sha256(new TextEncoder().encode(verifier)),
    );
    let sessionId = "";
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = `linear_oauth_session_${base64Url(this.randomBytes(24))}`;
      if (!this.sessions.has(candidate)) {
        sessionId = candidate;
        break;
      }
    }
    if (!sessionId) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_crypto_unavailable",
        "A unique Linear authorization session could not be generated.",
      );
    }
    const redirectUri = callbackUri(callback);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + OAUTH_SESSION_TTL_MS).toISOString();
    const authorizationUrl = new URL(LINEAR_OAUTH_AUTHORIZE_ENDPOINT);
    authorizationUrl.searchParams.set("client_id", clientId);
    authorizationUrl.searchParams.set("redirect_uri", redirectUri);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("scope", scopes.join(","));
    authorizationUrl.searchParams.set("actor", actor);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    this.sessions.set(sessionId, {
      sessionId,
      state,
      verifier,
      actor,
      scopes,
      redirectUri,
      callback,
      createdAt,
      expiresAt,
    });
    return Object.freeze({
      version: 1 as const,
      sessionId,
      actor,
      scopes: [...scopes],
      authorizationUrl: authorizationUrl.toString(),
      redirectUri,
      createdAt,
      expiresAt,
    });
  }

  completeCallback(input: {
    sessionId: string;
    callbackUrl: string;
  }): LinearOAuthCodeGrantV1 {
    this.pruneExpired();
    const sessionId = normalizeSessionId(input.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_session_not_found",
        "The Linear authorization session is missing, expired, or already used.",
      );
    }
    const callback = parseCallbackUrl(input.callbackUrl, session.callback);
    if (
      callback.searchParams.getAll("state").length !== 1 ||
      callback.searchParams.getAll("code").length > 1 ||
      callback.searchParams.getAll("error").length > 1
    ) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_invalid_callback",
        "The Linear authorization callback contained repeated fields.",
      );
    }
    const state = callback.searchParams.get("state") ?? "";
    if (!constantTimeEqual(state, session.state)) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_state_mismatch",
        "The Linear authorization callback state did not match this session.",
      );
    }
    const providerError = callback.searchParams.get("error");
    if (providerError) {
      this.sessions.delete(sessionId);
      session.verifier = "";
      session.state = "";
      throw new LinearOAuthErrorV1(
        "linear_oauth_authorization_denied",
        "Linear authorization was denied or cancelled.",
      );
    }
    const code = boundedOpaqueValue(
      callback.searchParams.get("code"),
      "authorization code",
      8,
      8_192,
    );
    if (
      [...callback.searchParams.keys()].some(
        (key) => key !== "code" && key !== "state",
      )
    ) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_invalid_callback",
        "The Linear authorization callback contained unexpected fields.",
      );
    }
    this.sessions.delete(sessionId);
    const verifier = session.verifier;
    session.verifier = "";
    session.state = "";
    return createCodeGrant({
      code,
      verifier,
      sessionId,
      actor: session.actor,
      scopes: session.scopes,
      redirectUri: session.redirectUri,
    });
  }

  cancel(sessionId: string): boolean {
    const normalized = normalizeSessionId(sessionId);
    const session = this.sessions.get(normalized);
    if (!session) return false;
    session.verifier = "";
    session.state = "";
    return this.sessions.delete(normalized);
  }

  toJSON(): { version: 1; redacted: true; activeSessions: number } {
    this.pruneExpired();
    return { version: 1, redacted: true, activeSessions: this.sessions.size };
  }

  private pruneExpired(): void {
    const now = requireValidDate(this.now(), "OAuth session time").getTime();
    for (const [id, session] of this.sessions) {
      if (Date.parse(session.expiresAt) <= now) this.cancel(id);
    }
  }
}

export interface LinearOAuthCredentialV1 {
  version: 1;
  credentialId: string;
  actor: LinearOAuthActorV1;
  scopes: LinearOAuthScopeV1[];
  accessTokenReferenceId: string;
  refreshTokenReferenceId: string;
  tokenType: "Bearer";
  issuedAt: string;
  accessExpiresAt: string;
  refreshGeneration: number;
}

export interface PendingLinearOAuthRefreshV1 {
  version: 1;
  pendingId: string;
  credentialId: string;
  refreshTokenReferenceId: string;
  actor: LinearOAuthActorV1;
  scopes: LinearOAuthScopeV1[];
  status: "reconcile_required";
  attempts: number;
  firstAttemptAt: string;
  lastAttemptAt: string;
  replayGraceExpiresAt: string;
  lastError: {
    code: "linear_oauth_refresh_ambiguous" | "linear_oauth_secret_commit_failed";
    message: string;
  };
}

export type LinearOAuthRefreshResultV1 =
  | {
      status: "rotated";
      credential: LinearOAuthCredentialV1;
      pending: null;
      cleanupRequiredReferenceIds: string[];
    }
  | {
      status: "reconcile_required";
      credential: LinearOAuthCredentialV1;
      pending: PendingLinearOAuthRefreshV1;
    };

export interface LinearOAuthRefreshOptionsV1 {
  /** Host persists the new opaque references before retiring the old pair. */
  deferRetirement?: boolean;
}

export interface LinearOAuthClientV1Options {
  clientId: string;
  transport: HttpTransport;
  secretStore: SecretStoreV1;
  sessionManager?: LinearOAuthSessionManagerV1;
  timeoutMs?: number;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
}

export class LinearOAuthClientV1 {
  readonly sessionManager: LinearOAuthSessionManagerV1;
  private readonly clientId: string;
  private readonly transport: HttpTransport;
  private readonly secretStore: SecretStoreV1;
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly randomBytes: (length: number) => Uint8Array;

  constructor(options: LinearOAuthClientV1Options) {
    this.clientId = normalizeClientId(options.clientId);
    this.transport = options.transport;
    this.secretStore = options.secretStore;
    this.timeoutMs = clampInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      250,
      MAX_TIMEOUT_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.sessionManager = options.sessionManager ?? new LinearOAuthSessionManagerV1({
      now: this.now,
      randomBytes: this.randomBytes,
    });
  }

  beginAuthorization(input: {
    actor: LinearOAuthActorV1;
    scopes?: readonly LinearOAuthScopeV1[];
    callback: LinearOAuthLoopbackCallbackV1;
  }): Promise<LinearOAuthAuthorizationRequestV1> {
    return this.sessionManager.begin({
      clientId: this.clientId,
      actor: input.actor,
      scopes: input.scopes,
      callback: input.callback,
    });
  }

  completeCallback(input: {
    sessionId: string;
    callbackUrl: string;
  }): LinearOAuthCodeGrantV1 {
    return this.sessionManager.completeCallback(input);
  }

  async exchangeCode(grant: LinearOAuthCodeGrantV1): Promise<LinearOAuthCredentialV1> {
    try {
      return await grant.withGrant(async ({ code, codeVerifier }) => {
        const tokenPair = await this.requestToken({
          grant_type: "authorization_code",
          client_id: this.clientId,
          code,
          redirect_uri: grant.redirectUri,
          code_verifier: codeVerifier,
        }, false);
        return this.commitTokenPair(tokenPair, {
          actor: grant.actor,
          scopes: [...grant.scopes],
          refreshGeneration: 0,
        });
      });
    } finally {
      grant.dispose();
    }
  }

  leaseAccessToken(
    credential: LinearOAuthCredentialV1,
    ttlSeconds = 60,
  ): Promise<SecretLeaseV1> {
    const normalized = parseLinearOAuthCredentialV1(credential);
    return this.secretStore.lease(normalized.accessTokenReferenceId, { ttlSeconds });
  }

  async refresh(
    credential: LinearOAuthCredentialV1,
    options: LinearOAuthRefreshOptionsV1 = {},
  ): Promise<LinearOAuthRefreshResultV1> {
    return this.rotateCredential(
      parseLinearOAuthCredentialV1(credential),
      null,
      options,
    );
  }

  async reconcileRefresh(
    credential: LinearOAuthCredentialV1,
    pending: PendingLinearOAuthRefreshV1,
    options: LinearOAuthRefreshOptionsV1 = {},
  ): Promise<LinearOAuthRefreshResultV1> {
    const normalizedCredential = parseLinearOAuthCredentialV1(credential);
    const normalizedPending = parsePendingLinearOAuthRefreshV1(pending);
    if (
      normalizedPending.credentialId !== normalizedCredential.credentialId ||
      normalizedPending.refreshTokenReferenceId !==
        normalizedCredential.refreshTokenReferenceId
    ) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_reconciliation_mismatch",
        "The pending Linear refresh does not match this credential.",
      );
    }
    if (this.nowMs() >= Date.parse(normalizedPending.replayGraceExpiresAt)) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_refresh_grace_expired",
        "The Linear refresh replay grace period expired; reconnect Linear.",
      );
    }
    if (
      normalizedPending.attempts >=
        LINEAR_OAUTH_MAX_REFRESH_RECONCILIATION_ATTEMPTS
    ) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_refresh_attempts_exhausted",
        "Linear refresh reconciliation reached its bounded attempt limit; reconnect Linear.",
      );
    }
    if (
      normalizedPending.actor !== normalizedCredential.actor ||
      normalizedPending.scopes.join(",") !== normalizedCredential.scopes.join(",")
    ) {
      throw new LinearOAuthErrorV1(
        "linear_oauth_reconciliation_mismatch",
        "The pending Linear refresh authority does not match this credential.",
      );
    }
    return this.rotateCredential(normalizedCredential, normalizedPending, options);
  }

  async revoke(
    credential: LinearOAuthCredentialV1,
    token: "access" | "refresh" | "both" = "both",
  ): Promise<{ revoked: Array<"access" | "refresh"> }> {
    const normalized = parseLinearOAuthCredentialV1(credential);
    const targets: Array<{ kind: "access" | "refresh"; referenceId: string }> = [];
    if (token === "access" || token === "both") {
      targets.push({ kind: "access", referenceId: normalized.accessTokenReferenceId });
    }
    if (token === "refresh" || token === "both") {
      targets.push({ kind: "refresh", referenceId: normalized.refreshTokenReferenceId });
    }
    const revoked: Array<"access" | "refresh"> = [];
    for (const target of targets) {
      const lease = await this.secretStore.lease(target.referenceId, { ttlSeconds: 60 });
      try {
        await lease.withSecret(async (value) => {
          await this.requestForm(
            LINEAR_OAUTH_REVOKE_ENDPOINT,
            { token: value },
            false,
          );
        });
      } finally {
        lease.dispose();
      }
      await this.secretStore.remove(target.referenceId);
      revoked.push(target.kind);
    }
    return { revoked };
  }

  private async rotateCredential(
    credential: LinearOAuthCredentialV1,
    pending: PendingLinearOAuthRefreshV1 | null,
    options: LinearOAuthRefreshOptionsV1,
  ): Promise<LinearOAuthRefreshResultV1> {
    const attemptedAt = this.nowIso();
    const lease = await this.secretStore.lease(credential.refreshTokenReferenceId, {
      ttlSeconds: 60,
    });
    let tokenPair: TokenPair;
    try {
      tokenPair = await lease.withSecret((refreshToken) =>
        this.requestToken({
          grant_type: "refresh_token",
          client_id: this.clientId,
          refresh_token: refreshToken,
        }, true));
    } catch (error) {
      lease.dispose();
      if (isAmbiguousOAuthError(error)) {
        return {
          status: "reconcile_required",
          credential,
          pending: this.buildPendingRefresh(
            credential,
            pending,
            attemptedAt,
            "linear_oauth_refresh_ambiguous",
          ),
        };
      }
      throw error;
    } finally {
      lease.dispose();
    }

    let rotated: LinearOAuthCredentialV1;
    try {
      rotated = await this.commitTokenPair(tokenPair, {
        actor: credential.actor,
        scopes: credential.scopes,
        refreshGeneration: credential.refreshGeneration + 1,
        credentialId: credential.credentialId,
      });
    } catch {
      return {
        status: "reconcile_required",
        credential,
        pending: this.buildPendingRefresh(
          credential,
          pending,
          attemptedAt,
          "linear_oauth_secret_commit_failed",
        ),
      };
    }

    const oldReferenceIds = [
      credential.accessTokenReferenceId,
      credential.refreshTokenReferenceId,
    ];
    if (options.deferRetirement === true) {
      return {
        status: "rotated",
        credential: rotated,
        pending: null,
        cleanupRequiredReferenceIds: oldReferenceIds,
      };
    }
    const cleanupRequiredReferenceIds: string[] = [];
    for (const referenceId of oldReferenceIds) {
      try {
        if (!(await this.secretStore.remove(referenceId))) {
          cleanupRequiredReferenceIds.push(referenceId);
        }
      } catch {
        cleanupRequiredReferenceIds.push(referenceId);
      }
    }
    return {
      status: "rotated",
      credential: rotated,
      pending: null,
      cleanupRequiredReferenceIds,
    };
  }

  private buildPendingRefresh(
    credential: LinearOAuthCredentialV1,
    previous: PendingLinearOAuthRefreshV1 | null,
    attemptedAt: string,
    code: PendingLinearOAuthRefreshV1["lastError"]["code"],
  ): PendingLinearOAuthRefreshV1 {
    const firstAttemptAt = previous?.firstAttemptAt ?? attemptedAt;
    return Object.freeze({
      version: 1 as const,
      pendingId: previous?.pendingId ??
        `linear_oauth_refresh_${base64Url(this.randomBytes(24))}`,
      credentialId: credential.credentialId,
      refreshTokenReferenceId: credential.refreshTokenReferenceId,
      actor: credential.actor,
      scopes: [...credential.scopes],
      status: "reconcile_required" as const,
      attempts: (previous?.attempts ?? 0) + 1,
      firstAttemptAt,
      lastAttemptAt: attemptedAt,
      replayGraceExpiresAt: previous?.replayGraceExpiresAt ??
        new Date(
          Date.parse(firstAttemptAt) + LINEAR_OAUTH_REFRESH_REPLAY_GRACE_MS,
        ).toISOString(),
      lastError: {
        code,
        message: code === "linear_oauth_secret_commit_failed"
          ? "Linear rotated the token, but secure local commit was not confirmed."
          : "Linear refresh dispatch was ambiguous and requires replay reconciliation.",
      },
    });
  }

  private async commitTokenPair(
    pair: TokenPair,
    input: {
      actor: LinearOAuthActorV1;
      scopes: LinearOAuthScopeV1[];
      refreshGeneration: number;
      credentialId?: string;
    },
  ): Promise<LinearOAuthCredentialV1> {
    let accessReferenceId = "";
    let refreshReferenceId = "";
    try {
      const access = await this.secretStore.put({
        value: pair.accessToken,
        label: "Linear OAuth access token",
        metadata: {
          provider: "linear",
          actor: input.actor,
          credentialKind: "oauth_access_token",
          scope: input.scopes.join(","),
        },
      });
      accessReferenceId = access.referenceId;
      const refresh = await this.secretStore.put({
        value: pair.refreshToken,
        label: "Linear OAuth refresh token",
        metadata: {
          provider: "linear",
          actor: input.actor,
          credentialKind: "oauth_refresh_token",
          scope: input.scopes.join(","),
        },
      });
      refreshReferenceId = refresh.referenceId;
      const issuedAt = this.nowIso();
      return Object.freeze({
        version: 1 as const,
        credentialId: input.credentialId ??
          `linear_oauth_credential_${base64Url(this.randomBytes(24))}`,
        actor: input.actor,
        scopes: [...input.scopes],
        accessTokenReferenceId: access.referenceId,
        refreshTokenReferenceId: refresh.referenceId,
        tokenType: "Bearer" as const,
        issuedAt,
        accessExpiresAt: new Date(
          Date.parse(issuedAt) + pair.expiresInSeconds * 1_000,
        ).toISOString(),
        refreshGeneration: input.refreshGeneration,
      });
    } catch {
      if (accessReferenceId) {
        try {
          await this.secretStore.remove(accessReferenceId);
        } catch {
          // Best-effort removal; never include secret material in the error.
        }
      }
      if (refreshReferenceId) {
        try {
          await this.secretStore.remove(refreshReferenceId);
        } catch {
          // Best-effort removal; never include secret material in the error.
        }
      }
      throw new LinearOAuthErrorV1(
        "linear_oauth_secret_store_failed",
        "Linear credentials could not be committed to the secure store.",
      );
    } finally {
      pair.accessToken = "";
      pair.refreshToken = "";
    }
  }

  private async requestToken(
    form: Record<string, string>,
    mutationMayHaveApplied: boolean,
  ): Promise<TokenPair> {
    const response = await this.requestForm(
      LINEAR_OAUTH_TOKEN_ENDPOINT,
      form,
      mutationMayHaveApplied,
    );
    try {
      return parseTokenPair(response);
    } catch (error) {
      if (mutationMayHaveApplied) {
        throw new LinearOAuthErrorV1(
          "linear_oauth_refresh_ambiguous",
          "Linear refresh returned an ambiguous response and requires reconciliation.",
          { retryable: true, ambiguous: true },
        );
      }
      throw error;
    }
  }

  private async requestForm(
    endpoint: string,
    form: Record<string, string>,
    mutationMayHaveApplied: boolean,
  ): Promise<HttpResponse> {
    const body = new URLSearchParams(form).toString();
    let response: HttpResponse;
    try {
      response = await this.transport({
        url: endpoint,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        headers: {
          Accept: "application/json",
          "Cache-Control": "no-store",
        },
        body,
        throw: false,
        timeoutMs: this.timeoutMs,
      });
    } catch {
      throw new LinearOAuthErrorV1(
        mutationMayHaveApplied
          ? "linear_oauth_refresh_ambiguous"
          : "linear_oauth_network",
        mutationMayHaveApplied
          ? "Linear refresh dispatch was ambiguous and requires reconciliation."
          : "Linear OAuth could not be reached.",
        { retryable: true, ambiguous: mutationMayHaveApplied },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const ambiguous = mutationMayHaveApplied &&
        (response.status === 408 || response.status === 429 || response.status >= 500);
      throw new LinearOAuthErrorV1(
        ambiguous ? "linear_oauth_refresh_ambiguous" : "linear_oauth_http",
        ambiguous
          ? "Linear refresh dispatch was ambiguous and requires reconciliation."
          : "Linear rejected the OAuth request.",
        {
          status: response.status,
          retryable: ambiguous || response.status === 429,
          ambiguous,
        },
      );
    }
    return response;
  }

  private nowIso(): string {
    return requireValidDate(this.now(), "OAuth client time").toISOString();
  }

  private nowMs(): number {
    return requireValidDate(this.now(), "OAuth client time").getTime();
  }
}

export type LinearOAuthErrorCodeV1 =
  | "linear_oauth_invalid_input"
  | "linear_oauth_crypto_unavailable"
  | "linear_oauth_session_limit"
  | "linear_oauth_session_not_found"
  | "linear_oauth_state_mismatch"
  | "linear_oauth_invalid_callback"
  | "linear_oauth_authorization_denied"
  | "linear_oauth_network"
  | "linear_oauth_http"
  | "linear_oauth_invalid_response"
  | "linear_oauth_secret_store_failed"
  | "linear_oauth_refresh_ambiguous"
  | "linear_oauth_refresh_grace_expired"
  | "linear_oauth_refresh_attempts_exhausted"
  | "linear_oauth_reconciliation_mismatch";

/** Redacted provider error. It never retains response bodies or original errors. */
export class LinearOAuthErrorV1 extends Error {
  constructor(
    readonly code: LinearOAuthErrorCodeV1,
    message: string,
    readonly options: {
      status?: number;
      retryable?: boolean;
      ambiguous?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "LinearOAuthErrorV1";
  }

  get status(): number | undefined {
    return this.options.status;
  }

  get retryable(): boolean {
    return this.options.retryable === true;
  }

  get ambiguous(): boolean {
    return this.options.ambiguous === true;
  }

  toJSON(): {
    name: "LinearOAuthErrorV1";
    code: LinearOAuthErrorCodeV1;
    message: string;
    status?: number;
    retryable: boolean;
    ambiguous: boolean;
    redacted: true;
  } {
    return {
      name: "LinearOAuthErrorV1",
      code: this.code,
      message: this.message,
      ...(this.status !== undefined ? { status: this.status } : {}),
      retryable: this.retryable,
      ambiguous: this.ambiguous,
      redacted: true,
    };
  }
}

export function parseLinearOAuthCredentialV1(
  value: unknown,
): LinearOAuthCredentialV1 {
  const record = exactRecord(value, [
    "version",
    "credentialId",
    "actor",
    "scopes",
    "accessTokenReferenceId",
    "refreshTokenReferenceId",
    "tokenType",
    "issuedAt",
    "accessExpiresAt",
    "refreshGeneration",
  ], "Linear OAuth credential");
  if (record.version !== 1) invalidInput("Unsupported Linear OAuth credential version.");
  const credentialId = boundedIdentifier(record.credentialId, "credential id", 256);
  if (!/^linear_oauth_credential_[A-Za-z0-9_-]{20,128}$/.test(credentialId)) {
    invalidInput("Linear OAuth credential id is malformed.");
  }
  const issuedAt = canonicalTimestamp(record.issuedAt, "credential issue time");
  const accessExpiresAt = canonicalTimestamp(
    record.accessExpiresAt,
    "access token expiry",
  );
  if (Date.parse(accessExpiresAt) <= Date.parse(issuedAt)) {
    invalidInput("Linear OAuth access token expiry must follow its issue time.");
  }
  if (record.tokenType !== "Bearer") invalidInput("Linear OAuth token type is invalid.");
  if (!Number.isSafeInteger(record.refreshGeneration) || Number(record.refreshGeneration) < 0) {
    invalidInput("Linear OAuth refresh generation is invalid.");
  }
  const accessTokenReferenceId = normalizeSecretReference(
    record.accessTokenReferenceId,
    "access token reference",
  );
  const refreshTokenReferenceId = normalizeSecretReference(
    record.refreshTokenReferenceId,
    "refresh token reference",
  );
  if (accessTokenReferenceId === refreshTokenReferenceId) {
    invalidInput("Linear OAuth access and refresh references must be distinct.");
  }
  return {
    version: 1,
    credentialId,
    actor: normalizeActor(record.actor),
    scopes: normalizeScopes(record.scopes as readonly LinearOAuthScopeV1[]),
    accessTokenReferenceId,
    refreshTokenReferenceId,
    tokenType: "Bearer",
    issuedAt,
    accessExpiresAt,
    refreshGeneration: Number(record.refreshGeneration),
  };
}

export function parsePendingLinearOAuthRefreshV1(
  value: unknown,
): PendingLinearOAuthRefreshV1 {
  const record = exactRecord(value, [
    "version",
    "pendingId",
    "credentialId",
    "refreshTokenReferenceId",
    "actor",
    "scopes",
    "status",
    "attempts",
    "firstAttemptAt",
    "lastAttemptAt",
    "replayGraceExpiresAt",
    "lastError",
  ], "pending Linear OAuth refresh");
  if (record.version !== 1 || record.status !== "reconcile_required") {
    invalidInput("Pending Linear OAuth refresh state is invalid.");
  }
  const pendingId = boundedIdentifier(record.pendingId, "pending refresh id", 256);
  if (!PENDING_ID_PATTERN.test(pendingId)) invalidInput("Pending refresh id is malformed.");
  const credentialId = boundedIdentifier(record.credentialId, "credential id", 256);
  if (!/^linear_oauth_credential_[A-Za-z0-9_-]{20,128}$/.test(credentialId)) {
    invalidInput("Pending refresh credential id is malformed.");
  }
  if (!Number.isSafeInteger(record.attempts) || Number(record.attempts) < 1 || Number(record.attempts) > 20) {
    invalidInput("Pending refresh attempt count is invalid.");
  }
  const firstAttemptAt = canonicalTimestamp(record.firstAttemptAt, "first refresh attempt");
  const lastAttemptAt = canonicalTimestamp(record.lastAttemptAt, "last refresh attempt");
  const replayGraceExpiresAt = canonicalTimestamp(
    record.replayGraceExpiresAt,
    "refresh replay grace expiry",
  );
  if (
    Date.parse(lastAttemptAt) < Date.parse(firstAttemptAt) ||
    Date.parse(lastAttemptAt) > Date.parse(replayGraceExpiresAt) ||
    Date.parse(replayGraceExpiresAt) !==
      Date.parse(firstAttemptAt) + LINEAR_OAUTH_REFRESH_REPLAY_GRACE_MS
  ) {
    invalidInput("Pending refresh timestamps are inconsistent.");
  }
  const lastError = exactRecord(
    record.lastError,
    ["code", "message"],
    "pending refresh error",
  );
  if (
    lastError.code !== "linear_oauth_refresh_ambiguous" &&
    lastError.code !== "linear_oauth_secret_commit_failed"
  ) {
    invalidInput("Pending refresh error code is invalid.");
  }
  const message = boundedText(lastError.message, "pending refresh error message", 1, 500);
  return {
    version: 1,
    pendingId,
    credentialId,
    refreshTokenReferenceId: normalizeSecretReference(
      record.refreshTokenReferenceId,
      "refresh token reference",
    ),
    actor: normalizeActor(record.actor),
    scopes: normalizeScopes(record.scopes as readonly LinearOAuthScopeV1[]),
    status: "reconcile_required",
    attempts: Number(record.attempts),
    firstAttemptAt,
    lastAttemptAt,
    replayGraceExpiresAt,
    lastError: { code: lastError.code, message },
  };
}

interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

function parseTokenPair(response: HttpResponse): TokenPair {
  let value = response.json;
  if (value === undefined && typeof response.text === "string") {
    if (new TextEncoder().encode(response.text).byteLength > MAX_OAUTH_RESPONSE_BYTES) {
      invalidResponse();
    }
    try {
      value = JSON.parse(response.text);
    } catch {
      invalidResponse();
    }
  }
  if (!isRecord(value)) invalidResponse();
  const accessToken = boundedOpaqueValue(
    value.access_token,
    "access token",
    8,
    MAX_TOKEN_BYTES,
    "linear_oauth_invalid_response",
  );
  const refreshToken = boundedOpaqueValue(
    value.refresh_token,
    "refresh token",
    8,
    MAX_TOKEN_BYTES,
    "linear_oauth_invalid_response",
  );
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") {
    invalidResponse();
  }
  const expiresInSeconds = value.expires_in === undefined
    ? LINEAR_OAUTH_DEFAULT_ACCESS_TOKEN_SECONDS
    : Number(value.expires_in);
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < 300 ||
    expiresInSeconds > 172_800
  ) {
    invalidResponse();
  }
  return { accessToken, refreshToken, expiresInSeconds };
}

function createCodeGrant(input: {
  code: string;
  verifier: string;
  sessionId: string;
  actor: LinearOAuthActorV1;
  scopes: LinearOAuthScopeV1[];
  redirectUri: string;
}): LinearOAuthCodeGrantV1 {
  let code = input.code;
  let verifier = input.verifier;
  let disposed = false;
  const grant: LinearOAuthCodeGrantV1 = {
    get disposed() {
      return disposed;
    },
    sessionId: input.sessionId,
    actor: input.actor,
    scopes: Object.freeze([...input.scopes]),
    redirectUri: input.redirectUri,
    async withGrant<TResult>(
      use: (material: { code: string; codeVerifier: string }) => Promise<TResult>,
    ): Promise<TResult> {
      if (disposed) {
        throw new LinearOAuthErrorV1(
          "linear_oauth_session_not_found",
          "The Linear authorization grant is already disposed.",
        );
      }
      return use({ code, codeVerifier: verifier });
    },
    dispose(): void {
      code = "";
      verifier = "";
      disposed = true;
    },
    toJSON() {
      return {
        redacted: true as const,
        sessionId: input.sessionId,
        actor: input.actor,
        scopes: Object.freeze([...input.scopes]),
        redirectUri: input.redirectUri,
      };
    },
  };
  return Object.freeze(grant);
}

function parseCallbackUrl(
  input: string,
  expected: LinearOAuthLoopbackCallbackV1,
): URL {
  if (typeof input !== "string" || input.length > 16_384) {
    invalidInput("Linear OAuth callback URL is invalid.", "linear_oauth_invalid_callback");
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    invalidInput("Linear OAuth callback URL is invalid.", "linear_oauth_invalid_callback");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== expected.host ||
    Number(url.port) !== expected.port ||
    url.pathname !== expected.path ||
    url.username ||
    url.password ||
    url.hash
  ) {
    invalidInput(
      "Linear OAuth callback did not target the bound loopback endpoint.",
      "linear_oauth_invalid_callback",
    );
  }
  return url;
}

function normalizeCallback(value: LinearOAuthLoopbackCallbackV1): LinearOAuthLoopbackCallbackV1 {
  if (
    !isRecord(value) ||
    Object.keys(value).length !== 3 ||
    value.host !== "127.0.0.1" ||
    value.path !== CALLBACK_PATH ||
    !Number.isSafeInteger(value.port) ||
    Number(value.port) < MIN_LOOPBACK_PORT ||
    Number(value.port) > MAX_LOOPBACK_PORT
  ) {
    invalidInput(
      `Linear OAuth requires a 127.0.0.1 callback on ports ${MIN_LOOPBACK_PORT}-${MAX_LOOPBACK_PORT} at ${CALLBACK_PATH}.`,
    );
  }
  return {
    host: "127.0.0.1",
    port: Number(value.port),
    path: CALLBACK_PATH,
  };
}

function callbackUri(callback: LinearOAuthLoopbackCallbackV1): string {
  return `http://${callback.host}:${callback.port}${callback.path}`;
}

function normalizeActor(value: unknown): LinearOAuthActorV1 {
  if (value !== "user" && value !== "app") {
    invalidInput("Linear OAuth actor must be user or app.");
  }
  return value;
}

function normalizeScopes(value: readonly LinearOAuthScopeV1[]): LinearOAuthScopeV1[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    invalidInput("Linear OAuth scopes must contain read, write, or both.");
  }
  const scopes: LinearOAuthScopeV1[] = [];
  for (const item of value) {
    if (item !== "read" && item !== "write") {
      invalidInput("Linear OAuth scope is unsupported.");
    }
    if (scopes.includes(item)) invalidInput("Linear OAuth scopes must be unique.");
    scopes.push(item);
  }
  return scopes;
}

function normalizeClientId(value: unknown): string {
  const clientId = boundedText(value, "client id", 3, 256);
  if (!SAFE_CLIENT_ID_PATTERN.test(clientId)) invalidInput("Linear OAuth client id is malformed.");
  return clientId;
}

function normalizeSessionId(value: unknown): string {
  const id = boundedIdentifier(value, "session id", 256);
  if (!SESSION_ID_PATTERN.test(id)) invalidInput("Linear OAuth session id is malformed.");
  return id;
}

function normalizeSecretReference(value: unknown, label: string): string {
  const reference = boundedIdentifier(value, label, 256);
  if (!SECRET_REFERENCE_PATTERN.test(reference)) {
    invalidInput(`Linear OAuth ${label} is malformed.`);
  }
  return reference;
}

function exactRecord(
  value: unknown,
  keys: string[],
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) invalidInput(`${label} must be an object.`);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    invalidInput(`${label} has unexpected or missing fields.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedOpaqueValue(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
  code: LinearOAuthErrorCodeV1 = "linear_oauth_invalid_callback",
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/.test(value)
  ) {
    invalidInput(`Linear OAuth ${label} is invalid.`, code);
  }
  return value;
}

function boundedText(
  value: unknown,
  label: string,
  minimum: number,
  maximum: number,
): string {
  if (typeof value !== "string") invalidInput(`Linear OAuth ${label} must be text.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    invalidInput(`Linear OAuth ${label} is outside its allowed bound.`);
  }
  return normalized;
}

function boundedIdentifier(value: unknown, label: string, maximum: number): string {
  const normalized = boundedText(value, label, 1, maximum);
  if (!/^[A-Za-z0-9._:-]+$/.test(normalized)) {
    invalidInput(`Linear OAuth ${label} is malformed.`);
  }
  return normalized;
}

function canonicalTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string") invalidInput(`Linear OAuth ${label} is invalid.`);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    invalidInput(`Linear OAuth ${label} is invalid.`);
  }
  return value;
}

function requireValidDate(value: Date, label: string): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    invalidInput(`${label} is invalid.`);
  }
  return value;
}

function invalidInput(
  message: string,
  code: LinearOAuthErrorCodeV1 = "linear_oauth_invalid_input",
): never {
  throw new LinearOAuthErrorV1(code, message);
}

function invalidResponse(): never {
  throw new LinearOAuthErrorV1(
    "linear_oauth_invalid_response",
    "Linear returned an invalid OAuth response.",
  );
}

function isAmbiguousOAuthError(error: unknown): boolean {
  return error instanceof LinearOAuthErrorV1 && error.ambiguous;
}

function secureRandomBytes(length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > 65_536) {
    invalidInput("Secure random byte request is invalid.");
  }
  if (!globalThis.crypto?.getRandomValues) {
    throw new LinearOAuthErrorV1(
      "linear_oauth_crypto_unavailable",
      "Secure browser cryptography is unavailable.",
    );
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length));
}

async function sha256Bytes(value: Uint8Array): Promise<Uint8Array> {
  if (!globalThis.crypto?.subtle) {
    throw new LinearOAuthErrorV1(
      "linear_oauth_crypto_unavailable",
      "Secure browser cryptography is unavailable.",
    );
  }
  // Uint8Array may be backed by SharedArrayBuffer in newer TypeScript DOM
  // declarations, while SubtleCrypto deliberately accepts ArrayBuffer only.
  // Copy into a fresh, exclusively owned ArrayBuffer at this crypto boundary.
  const input = new ArrayBuffer(value.byteLength);
  new Uint8Array(input).set(value);
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input));
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  for (const byte of value) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}
