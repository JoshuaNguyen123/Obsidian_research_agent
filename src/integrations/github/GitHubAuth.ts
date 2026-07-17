import type {
  SecretLeaseV1,
  SecretStoreV1,
} from "../../../packages/core-api/src/secretStoreV1";
import type { HttpResponse, HttpTransport } from "../../model/types";

export const GITHUB_DEVICE_CODE_ENDPOINT = "https://github.com/login/device/code";
export const GITHUB_DEVICE_ACCESS_TOKEN_ENDPOINT =
  "https://github.com/login/oauth/access_token";
export const GITHUB_DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";
export const GITHUB_DEVICE_MINIMUM_POLL_INTERVAL_SECONDS = 5;
export const GITHUB_DEVICE_SLOW_DOWN_SECONDS = 5;
export const GITHUB_DEVICE_MAX_ACTIVE_SESSIONS = 8;

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;
const MIN_DEVICE_EXPIRY_SECONDS = 60;
const MAX_DEVICE_EXPIRY_SECONDS = 3_600;
const MAX_POLL_INTERVAL_SECONDS = 120;
const MAX_TOKEN_BYTES = 8_192;
const MAX_USER_CODE_BYTES = 64;
const MAX_SCOPES = 20;
const MAX_SCOPE_BYTES = 128;
const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]{3,256}$/;
const SESSION_ID_PATTERN = /^github_device_session_[A-Za-z0-9_-]{20,128}$/;
const CREDENTIAL_ID_PATTERN = /^github_credential_[A-Za-z0-9_-]{20,128}$/;
const SECRET_REFERENCE_PATTERN = /^(?:(?:secret|credential)_[A-Za-z0-9-]{8,128}|secret-obsidian-[a-z0-9-]{16,48})$/;
const SCOPE_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;
const FINE_GRAINED_PAT_PATTERN = /^github_pat_[A-Za-z0-9_-]{20,500}$/;

export type GitHubCredentialKindV1 = "oauth_device" | "fine_grained_pat";

export interface GitHubAuthenticatedIdentityV1 {
  id: number;
  login: string;
}

export interface GitHubCredentialV1 {
  version: 1;
  credentialId: string;
  credentialKind: GitHubCredentialKindV1;
  tokenReferenceId: string;
  account: GitHubAuthenticatedIdentityV1;
  scopes: string[];
  issuedAt: string;
}

export interface GitHubDeviceFlowStateV1 {
  version: 1;
  sessionId: string;
  status: "waiting_for_user";
  userCode: string;
  verificationUri: string;
  scopes: string[];
  intervalSeconds: number;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  nextPollAt: string;
}

export type GitHubDevicePollResultV1 =
  | {
      status: "pending";
      reason: "authorization_pending" | "slow_down";
      state: GitHubDeviceFlowStateV1;
    }
  | {
      status: "authorized";
      credential: GitHubCredentialV1;
    };

interface PrivateDeviceSessionV1 {
  sessionId: string;
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  scopes: string[];
  intervalSeconds: number;
  attempts: number;
  createdAt: string;
  expiresAt: string;
  nextPollAt: string;
  polling: boolean;
  cancelled: boolean;
  abortController: AbortController;
}

export interface GitHubAuthV1Options {
  clientId: string;
  transport: HttpTransport;
  secretStore: SecretStoreV1;
  validateIdentity: (
    token: string,
    signal?: AbortSignal,
  ) => Promise<unknown>;
  timeoutMs?: number;
  now?: () => Date;
  randomBytes?: (length: number) => Uint8Array;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export type GitHubAuthErrorCodeV1 =
  | "github_auth_invalid_input"
  | "github_auth_invalid_response"
  | "github_auth_http"
  | "github_auth_network"
  | "github_auth_session_limit"
  | "github_auth_session_not_found"
  | "github_auth_poll_in_progress"
  | "github_auth_cancelled"
  | "github_auth_expired"
  | "github_auth_access_denied"
  | "github_auth_device_flow_disabled"
  | "github_auth_identity_validation_failed"
  | "github_auth_secret_store_failed";

export class GitHubAuthErrorV1 extends Error {
  constructor(
    readonly code: GitHubAuthErrorCodeV1,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubAuthErrorV1";
  }

  toJSON(): {
    name: "GitHubAuthErrorV1";
    code: GitHubAuthErrorCodeV1;
    message: string;
    status?: number;
  } {
    return {
      name: "GitHubAuthErrorV1",
      code: this.code,
      message: this.message,
      ...(this.status === undefined ? {} : { status: this.status }),
    };
  }
}

/**
 * Foreground GitHub credential coordinator. Provider device codes and plaintext
 * tokens never cross a serialization boundary. Persistable results contain
 * only an opaque SecretStoreV1 reference and the identity read back from /user.
 */
export class GitHubAuthV1 {
  private readonly clientId: string;
  private readonly transport: HttpTransport;
  private readonly secretStore: SecretStoreV1;
  private readonly validateIdentity: GitHubAuthV1Options["validateIdentity"];
  private readonly timeoutMs: number;
  private readonly now: () => Date;
  private readonly randomBytes: (length: number) => Uint8Array;
  private readonly sleep: NonNullable<GitHubAuthV1Options["sleep"]>;
  private readonly sessions = new Map<string, PrivateDeviceSessionV1>();

  constructor(options: GitHubAuthV1Options) {
    this.clientId = normalizeClientId(options.clientId);
    this.transport = options.transport;
    this.secretStore = options.secretStore;
    this.validateIdentity = options.validateIdentity;
    this.timeoutMs = clampInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      250,
      MAX_TIMEOUT_MS,
    );
    this.now = options.now ?? (() => new Date());
    this.randomBytes = options.randomBytes ?? secureRandomBytes;
    this.sleep = options.sleep ?? defaultSleep;
  }

  async beginDeviceFlow(
    scopes: readonly string[] = [],
    signal?: AbortSignal,
  ): Promise<GitHubDeviceFlowStateV1> {
    this.pruneExpired();
    if (this.sessions.size >= GITHUB_DEVICE_MAX_ACTIVE_SESSIONS) {
      throw new GitHubAuthErrorV1(
        "github_auth_session_limit",
        "Too many GitHub device authorization sessions are active; cancel or finish one first.",
      );
    }
    assertNotAborted(signal);
    const normalizedScopes = normalizeScopes(scopes);
    const form = new URLSearchParams({ client_id: this.clientId });
    if (normalizedScopes.length > 0) {
      form.set("scope", normalizedScopes.join(" "));
    }
    const response = await this.requestForm(
      GITHUB_DEVICE_CODE_ENDPOINT,
      form,
      signal,
    );
    const payload = requireRecord(response, "GitHub returned an invalid device authorization response.");
    const deviceCode = boundedOpaque(
      payload.device_code,
      "device code",
      8,
      MAX_TOKEN_BYTES,
    );
    const userCode = boundedDisplayCode(payload.user_code);
    const verificationUri = normalizeVerificationUri(payload.verification_uri);
    const expiresIn = boundedProviderInteger(
      payload.expires_in,
      "expires_in",
      MIN_DEVICE_EXPIRY_SECONDS,
      MAX_DEVICE_EXPIRY_SECONDS,
    );
    const intervalSeconds = Math.max(
      GITHUB_DEVICE_MINIMUM_POLL_INTERVAL_SECONDS,
      boundedProviderInteger(
        payload.interval ?? GITHUB_DEVICE_MINIMUM_POLL_INTERVAL_SECONDS,
        "interval",
        1,
        MAX_POLL_INTERVAL_SECONDS,
      ),
    );
    const now = this.nowDate();
    const sessionId = this.uniqueId("github_device_session_", this.sessions);
    const session: PrivateDeviceSessionV1 = {
      sessionId,
      deviceCode,
      userCode,
      verificationUri,
      scopes: normalizedScopes,
      intervalSeconds,
      attempts: 0,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + expiresIn * 1_000).toISOString(),
      nextPollAt: now.toISOString(),
      polling: false,
      cancelled: false,
      abortController: new AbortController(),
    };
    this.sessions.set(sessionId, session);
    return publicDeviceState(session);
  }

  getDeviceFlowState(sessionId: string): GitHubDeviceFlowStateV1 {
    this.pruneExpired();
    return publicDeviceState(this.requireSession(sessionId));
  }

  async pollDeviceFlow(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<GitHubDevicePollResultV1> {
    const session = this.requireSession(sessionId);
    if (session.polling) {
      throw new GitHubAuthErrorV1(
        "github_auth_poll_in_progress",
        "This GitHub device authorization session is already being polled.",
      );
    }
    session.polling = true;
    try {
      await this.waitForPollWindow(session, signal);
      this.assertSessionActive(session, signal);
      session.attempts += 1;
      const form = new URLSearchParams({
        client_id: this.clientId,
        device_code: session.deviceCode,
        grant_type: GITHUB_DEVICE_GRANT_TYPE,
      });
      let response: HttpResponse;
      const linkedSignal = linkAbortSignals([
        session.abortController.signal,
        signal,
      ]);
      try {
        response = await this.requestFormResponse(
          GITHUB_DEVICE_ACCESS_TOKEN_ENDPOINT,
          form,
          linkedSignal.signal,
        );
      } catch (error) {
        if (session.cancelled || session.abortController.signal.aborted || signal?.aborted) {
          throw cancelledError();
        }
        session.nextPollAt = new Date(
          this.nowMs() + session.intervalSeconds * 1_000,
        ).toISOString();
        if (error instanceof GitHubAuthErrorV1) throw error;
        throw new GitHubAuthErrorV1(
          "github_auth_network",
          "The GitHub device authorization request could not be completed.",
        );
      } finally {
        linkedSignal.dispose();
      }
      this.assertSessionActive(session, signal);
      const payload = recordOrNull(response.json);
      const providerError = payload === null
        ? null
        : optionalProviderError(payload.error);
      if (
        providerError === "authorization_pending" ||
        providerError === "slow_down" ||
        providerError === "expired_token" ||
        providerError === "access_denied" ||
        providerError === "device_flow_disabled"
      ) {
        return this.handleProviderPollError(session, providerError);
      }
      if (response.status < 200 || response.status >= 300) {
        session.nextPollAt = new Date(
          this.nowMs() + session.intervalSeconds * 1_000,
        ).toISOString();
        throw new GitHubAuthErrorV1(
          "github_auth_http",
          "GitHub rejected the device authorization request.",
          response.status,
        );
      }
      if (payload === null) {
        invalidResponse("GitHub returned an invalid device token response.");
      }
      if (providerError) {
        return this.handleProviderPollError(session, providerError);
      }
      const accessToken = boundedOpaque(
        payload.access_token,
        "access token",
        20,
        MAX_TOKEN_BYTES,
      );
      if (String(payload.token_type ?? "").toLowerCase() !== "bearer") {
        throw new GitHubAuthErrorV1(
          "github_auth_invalid_response",
          "GitHub returned an unsupported token type.",
        );
      }
      const responseScopes = normalizeProviderScope(payload.scope, session.scopes);
      this.deleteSession(session);
      const credential = await this.commitCredential(
        accessToken,
        "oauth_device",
        responseScopes,
        signal,
      );
      return { status: "authorized", credential };
    } finally {
      session.polling = false;
    }
  }

  cancelDeviceFlow(sessionId: string): boolean {
    const normalized = normalizeSessionId(sessionId);
    const session = this.sessions.get(normalized);
    if (!session) return false;
    this.deleteSession(session, true);
    return true;
  }

  async importFineGrainedPat(
    token: string,
    signal?: AbortSignal,
  ): Promise<GitHubCredentialV1> {
    assertNotAborted(signal);
    if (typeof token !== "string" || !FINE_GRAINED_PAT_PATTERN.test(token)) {
      throw new GitHubAuthErrorV1(
        "github_auth_invalid_input",
        "A valid fine-grained GitHub personal access token is required.",
      );
    }
    return this.commitCredential(token, "fine_grained_pat", [], signal);
  }

  async withCredentialToken<TResult>(
    credential: GitHubCredentialV1,
    use: (token: string) => Promise<TResult>,
    ttlSeconds = 60,
  ): Promise<TResult> {
    const normalized = parseGitHubCredentialV1(credential);
    let lease: SecretLeaseV1;
    try {
      lease = await this.secretStore.lease(normalized.tokenReferenceId, {
        ttlSeconds: clampInteger(ttlSeconds, 1, 300),
      });
    } catch {
      throw new GitHubAuthErrorV1(
        "github_auth_secret_store_failed",
        "The GitHub credential could not be leased from secure storage.",
      );
    }
    try {
      return await lease.withSecret(use);
    } catch {
      throw new GitHubAuthErrorV1(
        "github_auth_secret_store_failed",
        "The leased GitHub credential operation failed.",
      );
    } finally {
      lease.dispose();
    }
  }

  async removeCredential(credential: GitHubCredentialV1): Promise<boolean> {
    const normalized = parseGitHubCredentialV1(credential);
    try {
      return await this.secretStore.remove(normalized.tokenReferenceId);
    } catch {
      throw new GitHubAuthErrorV1(
        "github_auth_secret_store_failed",
        "The GitHub credential could not be removed from secure storage.",
      );
    }
  }

  toJSON(): { version: 1; redacted: true; activeSessions: number } {
    this.pruneExpired();
    return { version: 1, redacted: true, activeSessions: this.sessions.size };
  }

  private handleProviderPollError(
    session: PrivateDeviceSessionV1,
    providerError: string,
  ): GitHubDevicePollResultV1 {
    if (providerError === "authorization_pending") {
      session.nextPollAt = new Date(
        this.nowMs() + session.intervalSeconds * 1_000,
      ).toISOString();
      return {
        status: "pending",
        reason: "authorization_pending",
        state: publicDeviceState(session),
      };
    }
    if (providerError === "slow_down") {
      session.intervalSeconds = Math.min(
        MAX_POLL_INTERVAL_SECONDS,
        session.intervalSeconds + GITHUB_DEVICE_SLOW_DOWN_SECONDS,
      );
      session.nextPollAt = new Date(
        this.nowMs() + session.intervalSeconds * 1_000,
      ).toISOString();
      return {
        status: "pending",
        reason: "slow_down",
        state: publicDeviceState(session),
      };
    }
    this.deleteSession(session);
    if (providerError === "expired_token") {
      throw new GitHubAuthErrorV1(
        "github_auth_expired",
        "The GitHub device authorization session expired; start a new one.",
      );
    }
    if (providerError === "access_denied") {
      throw new GitHubAuthErrorV1(
        "github_auth_access_denied",
        "GitHub device authorization was denied or cancelled.",
      );
    }
    if (providerError === "device_flow_disabled") {
      throw new GitHubAuthErrorV1(
        "github_auth_device_flow_disabled",
        "GitHub device authorization is disabled for this OAuth application.",
      );
    }
    throw new GitHubAuthErrorV1(
      "github_auth_invalid_response",
      "GitHub returned an unsupported device authorization result.",
    );
  }

  private async commitCredential(
    token: string,
    credentialKind: GitHubCredentialKindV1,
    scopes: readonly string[],
    signal?: AbortSignal,
  ): Promise<GitHubCredentialV1> {
    let referenceId = "";
    try {
      const description = await this.secretStore.put({
        value: token,
        label:
          credentialKind === "oauth_device"
            ? "GitHub OAuth device credential"
            : "GitHub fine-grained personal access token",
        metadata: {
          provider: "github",
          credentialKind,
          ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
        },
      });
      referenceId = requireSecretReference(description.referenceId);
      const readback = await this.secretStore.describe(referenceId);
      if (readback.referenceId !== referenceId) {
        throw new Error("Secret reference readback mismatch.");
      }
    } catch {
      if (referenceId) await bestEffortRemove(this.secretStore, referenceId);
      throw new GitHubAuthErrorV1(
        "github_auth_secret_store_failed",
        "The GitHub credential could not be committed to secure storage.",
      );
    }

    let identity: GitHubAuthenticatedIdentityV1;
    try {
      assertNotAborted(signal);
      const lease = await this.secretStore.lease(referenceId, { ttlSeconds: 60 });
      try {
        identity = normalizeIdentity(
          await lease.withSecret((leasedToken) =>
            this.validateIdentity(leasedToken, signal)),
        );
      } finally {
        lease.dispose();
      }
    } catch {
      await bestEffortRemove(this.secretStore, referenceId);
      throw new GitHubAuthErrorV1(
        "github_auth_identity_validation_failed",
        "GitHub could not verify the authenticated account identity.",
      );
    }

    return freezeCredential({
      version: 1,
      credentialId: this.uniqueCredentialId(),
      credentialKind,
      tokenReferenceId: referenceId,
      account: identity,
      scopes: normalizeScopes(scopes),
      issuedAt: this.nowIso(),
    });
  }

  private async requestForm(
    url: string,
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const response = await this.requestFormResponse(url, form, signal);
    if (response.status < 200 || response.status >= 300) {
      throw new GitHubAuthErrorV1(
        "github_auth_http",
        "GitHub rejected the authorization request.",
        response.status,
      );
    }
    return response.json;
  }

  private async requestFormResponse(
    url: string,
    form: URLSearchParams,
    signal?: AbortSignal,
  ): Promise<HttpResponse> {
    assertNotAborted(signal);
    try {
      return await this.transport({
        url,
        method: "POST",
        contentType: "application/x-www-form-urlencoded",
        body: form.toString(),
        headers: { Accept: "application/json" },
        timeoutMs: this.timeoutMs,
        abortSignal: signal,
        throw: false,
      });
    } catch {
      throw new GitHubAuthErrorV1(
        signal?.aborted ? "github_auth_cancelled" : "github_auth_network",
        signal?.aborted
          ? "GitHub authorization was cancelled."
          : "The GitHub authorization service could not be reached.",
      );
    }
  }

  private async waitForPollWindow(
    session: PrivateDeviceSessionV1,
    externalSignal?: AbortSignal,
  ): Promise<void> {
    this.assertSessionActive(session, externalSignal);
    const delayMs = Math.max(0, Date.parse(session.nextPollAt) - this.nowMs());
    if (delayMs === 0) return;
    const controller = new AbortController();
    const abort = () => controller.abort();
    session.abortController.signal.addEventListener("abort", abort, { once: true });
    externalSignal?.addEventListener("abort", abort, { once: true });
    try {
      let remainingMs = delayMs;
      for (let attempt = 0; attempt < 3 && remainingMs > 0; attempt += 1) {
        await this.sleep(remainingMs, controller.signal);
        remainingMs = Math.max(
          0,
          Date.parse(session.nextPollAt) - this.nowMs(),
        );
      }
      if (remainingMs > 0) {
        throw new GitHubAuthErrorV1(
          "github_auth_poll_in_progress",
          "The GitHub device authorization polling interval has not elapsed.",
        );
      }
    } catch {
      if (
        !controller.signal.aborted &&
        !session.cancelled &&
        !externalSignal?.aborted
      ) {
        throw new GitHubAuthErrorV1(
          "github_auth_poll_in_progress",
          "The GitHub device authorization polling interval has not elapsed.",
        );
      }
      throw cancelledError();
    } finally {
      session.abortController.signal.removeEventListener("abort", abort);
      externalSignal?.removeEventListener("abort", abort);
    }
  }

  private assertSessionActive(
    session: PrivateDeviceSessionV1,
    signal?: AbortSignal,
  ): void {
    if (
      session.cancelled ||
      session.abortController.signal.aborted ||
      signal?.aborted
    ) {
      throw cancelledError();
    }
    if (this.nowMs() >= Date.parse(session.expiresAt)) {
      this.deleteSession(session);
      throw new GitHubAuthErrorV1(
        "github_auth_expired",
        "The GitHub device authorization session expired; start a new one.",
      );
    }
  }

  private requireSession(sessionId: string): PrivateDeviceSessionV1 {
    const session = this.sessions.get(normalizeSessionId(sessionId));
    if (!session) {
      throw new GitHubAuthErrorV1(
        "github_auth_session_not_found",
        "The GitHub device authorization session is missing, expired, or already used.",
      );
    }
    return session;
  }

  private deleteSession(session: PrivateDeviceSessionV1, cancelled = false): void {
    session.cancelled = cancelled;
    session.deviceCode = "";
    this.sessions.delete(session.sessionId);
    if (cancelled) session.abortController.abort();
  }

  private pruneExpired(): void {
    const now = this.nowMs();
    for (const session of this.sessions.values()) {
      if (Date.parse(session.expiresAt) <= now) this.deleteSession(session);
    }
  }

  private uniqueId(
    prefix: string,
    existing: ReadonlyMap<string, unknown>,
  ): string {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const candidate = `${prefix}${base64Url(this.randomBytes(24))}`;
      if (!existing.has(candidate)) return candidate;
    }
    throw new GitHubAuthErrorV1(
      "github_auth_invalid_input",
      "A unique GitHub authorization session could not be generated.",
    );
  }

  private uniqueCredentialId(): string {
    return `github_credential_${base64Url(this.randomBytes(24))}`;
  }

  private nowDate(): Date {
    const date = this.now();
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
      throw new GitHubAuthErrorV1(
        "github_auth_invalid_input",
        "GitHub authorization time is invalid.",
      );
    }
    return date;
  }

  private nowMs(): number {
    return this.nowDate().getTime();
  }

  private nowIso(): string {
    return this.nowDate().toISOString();
  }
}

export function parseGitHubCredentialV1(value: unknown): GitHubCredentialV1 {
  const record = requireRecord(value, "GitHub credential state is invalid.");
  if (record.version !== 1) invalidInput("GitHub credential version is invalid.");
  const credentialId = requiredPattern(
    record.credentialId,
    CREDENTIAL_ID_PATTERN,
    "GitHub credential ID",
  );
  const credentialKind = record.credentialKind;
  if (credentialKind !== "oauth_device" && credentialKind !== "fine_grained_pat") {
    invalidInput("GitHub credential kind is invalid.");
  }
  const tokenReferenceId = requireSecretReference(record.tokenReferenceId);
  const account = normalizeIdentity(record.account);
  const scopes = normalizeScopes(Array.isArray(record.scopes) ? record.scopes : []);
  const issuedAt = requireIso(record.issuedAt, "GitHub credential issuedAt");
  return freezeCredential({
    version: 1,
    credentialId,
    credentialKind,
    tokenReferenceId,
    account,
    scopes,
    issuedAt,
  });
}

function publicDeviceState(session: PrivateDeviceSessionV1): GitHubDeviceFlowStateV1 {
  return Object.freeze({
    version: 1 as const,
    sessionId: session.sessionId,
    status: "waiting_for_user" as const,
    userCode: session.userCode,
    verificationUri: session.verificationUri,
    scopes: Object.freeze([...session.scopes]) as unknown as string[],
    intervalSeconds: session.intervalSeconds,
    attempts: session.attempts,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    nextPollAt: session.nextPollAt,
  });
}

function freezeCredential(value: GitHubCredentialV1): GitHubCredentialV1 {
  return Object.freeze({
    ...value,
    account: Object.freeze({ ...value.account }),
    scopes: Object.freeze([...value.scopes]) as unknown as string[],
  });
}

function normalizeClientId(value: unknown): string {
  if (typeof value !== "string" || !CLIENT_ID_PATTERN.test(value)) {
    invalidInput("A valid GitHub OAuth client ID is required.");
  }
  return value;
}

function normalizeSessionId(value: unknown): string {
  return requiredPattern(value, SESSION_ID_PATTERN, "GitHub device session ID");
}

function normalizeIdentity(value: unknown): GitHubAuthenticatedIdentityV1 {
  const record = requireRecord(value, "GitHub returned an invalid account identity.");
  if (!Number.isSafeInteger(record.id) || Number(record.id) <= 0) {
    invalidInput("GitHub returned an invalid account identity.");
  }
  if (
    typeof record.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(record.login)
  ) {
    invalidInput("GitHub returned an invalid account identity.");
  }
  return Object.freeze({ id: Number(record.id), login: record.login });
}

function normalizeScopes(value: readonly unknown[]): string[] {
  if (value.length > MAX_SCOPES) invalidInput("Too many GitHub OAuth scopes were requested.");
  const scopes: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !SCOPE_PATTERN.test(entry)) {
      invalidInput("A GitHub OAuth scope is invalid.");
    }
    if (!scopes.includes(entry)) scopes.push(entry);
  }
  if (scopes.join(" ").length > 512) {
    invalidInput("GitHub OAuth scopes exceed the bounded request size.");
  }
  return scopes;
}

function normalizeProviderScope(value: unknown, fallback: readonly string[]): string[] {
  if (value === undefined || value === null || value === "") return normalizeScopes(fallback);
  if (typeof value !== "string" || value.length > MAX_SCOPES * MAX_SCOPE_BYTES) {
    invalidResponse("GitHub returned invalid OAuth scope metadata.");
  }
  return normalizeScopes(value.split(/[\s,]+/).filter(Boolean));
}

function normalizeVerificationUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_048) {
    invalidResponse("GitHub returned an invalid verification URL.");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    invalidResponse("GitHub returned an invalid verification URL.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.pathname !== "/login/device" ||
    url.search ||
    url.username ||
    url.password ||
    url.hash
  ) {
    invalidResponse("GitHub returned an invalid verification URL.");
  }
  return url.toString();
}

function boundedDisplayCode(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > MAX_USER_CODE_BYTES ||
    !/^[A-Za-z0-9-]+$/.test(value)
  ) {
    invalidResponse("GitHub returned an invalid user verification code.");
  }
  return value;
}

function boundedOpaque(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    /\s|[\u0000-\u001F\u007F]/.test(value)
  ) {
    invalidResponse(`GitHub returned an invalid ${field}.`);
  }
  return value;
}

function optionalProviderError(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.length > 128) {
    invalidResponse("GitHub returned an invalid device authorization error.");
  }
  return value;
}

function requireSecretReference(value: unknown): string {
  return requiredPattern(value, SECRET_REFERENCE_PATTERN, "GitHub secret reference");
}

function requiredPattern(value: unknown, pattern: RegExp, field: string): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    invalidInput(`${field} is invalid.`);
  }
  return value;
}

function boundedProviderInteger(
  value: unknown,
  field: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    invalidResponse(`GitHub returned an invalid ${field}.`);
  }
  return Number(value);
}

function requireIso(value: unknown, field: string): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    invalidInput(`${field} is invalid.`);
  }
  return new Date(value).toISOString();
}

function requireRecord(value: unknown, message: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    invalidResponse(message);
  }
  return value as Record<string, unknown>;
}

function recordOrNull(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function invalidInput(message: string): never {
  throw new GitHubAuthErrorV1("github_auth_invalid_input", message);
}

function invalidResponse(message: string): never {
  throw new GitHubAuthErrorV1("github_auth_invalid_response", message);
}

function cancelledError(): GitHubAuthErrorV1 {
  return new GitHubAuthErrorV1(
    "github_auth_cancelled",
    "GitHub authorization was cancelled.",
  );
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelledError();
}

async function bestEffortRemove(store: SecretStoreV1, referenceId: string): Promise<void> {
  try {
    await store.remove(referenceId);
  } catch {
    // The caller still receives a redacted failure; no secret value is exposed.
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function secureRandomBytes(length: number): Uint8Array {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) {
    throw new GitHubAuthErrorV1(
      "github_auth_invalid_input",
      "Secure randomness is unavailable for GitHub authorization.",
    );
  }
  const output = new Uint8Array(length);
  cryptoApi.getRandomValues(output);
  return output;
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function linkAbortSignals(
  signals: Array<AbortSignal | undefined>,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  const abort = () => controller.abort();
  for (const signal of active) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener("abort", abort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const signal of active) signal.removeEventListener("abort", abort);
    },
  };
}
