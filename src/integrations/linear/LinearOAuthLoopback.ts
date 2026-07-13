import { getNodeRequireForObsidian } from "../../platform/nodeRequire";
import type { LinearOAuthLoopbackCallbackV1 } from "./LinearOAuth";

export const LINEAR_OAUTH_LOOPBACK_PATH = "/oauth/linear/callback" as const;
export const LINEAR_OAUTH_LOOPBACK_HOST = "127.0.0.1" as const;
export const LINEAR_OAUTH_LOOPBACK_DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;

const MAX_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_REQUEST_URL_BYTES = 16_384;
const MAX_QUERY_BYTES = 12_288;
const MAX_QUERY_FIELDS = 8;
const MAX_QUERY_KEY_BYTES = 128;
const MAX_QUERY_VALUE_BYTES = 8_192;
const SUCCESS_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Linear authorization received</title></head><body><p>Authorization received. You can close this window and return to Obsidian.</p></body></html>";

type NodeHttpModule = typeof import("node:http");
type RequireImplementation = (specifier: string) => unknown;

export type LinearOAuthLoopbackErrorCodeV1 =
  | "linear_oauth_loopback_invalid_input"
  | "linear_oauth_loopback_unavailable"
  | "linear_oauth_loopback_listen_failed"
  | "linear_oauth_loopback_timeout"
  | "linear_oauth_loopback_aborted"
  | "linear_oauth_loopback_closed"
  | "linear_oauth_loopback_server_failed";

export class LinearOAuthLoopbackErrorV1 extends Error {
  constructor(
    readonly code: LinearOAuthLoopbackErrorCodeV1,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message);
    this.name = "LinearOAuthLoopbackErrorV1";
    if (options && "cause" in options) {
      (this as Error & { cause?: unknown }).cause = options.cause;
    }
  }
}

export interface LinearOAuthLoopbackBeginOptionsV1 {
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Fixed port registered on the Linear OAuth application. Zero or omission
   * asks the OS for an ephemeral port and is intended for tests/local setup.
   */
  port?: number;
  /** Test/runtime seam. The resolved module must be Node's built-in `http`. */
  requireImpl?: RequireImplementation;
}

export interface LinearOAuthLoopbackResultV1 {
  /** Exactly the three fields accepted by LinearOAuthSessionManagerV1. */
  callback: LinearOAuthLoopbackCallbackV1;
  redirectUri: string;
  /** Resolves once for the first exact callback, after the listener is closed. */
  callbackUrl: Promise<string>;
  /** Cancels an unfinished callback and releases the loopback port. */
  close(): Promise<void>;
}

/**
 * Starts a one-shot OAuth receiver on an operating-system-assigned loopback
 * port. The Node import is resolved only when this desktop-only action runs,
 * so importing the integration from Obsidian's browser context stays safe.
 */
export async function beginLinearOAuthLoopbackV1(
  options: LinearOAuthLoopbackBeginOptionsV1 = {},
): Promise<LinearOAuthLoopbackResultV1> {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const requestedPort = normalizePort(options.port);
  if (options.signal?.aborted) {
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_aborted",
      "Linear authorization was cancelled before the callback listener started.",
    );
  }

  const nodeRequire = options.requireImpl ?? getNodeRequireForObsidian();
  if (!nodeRequire) {
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_unavailable",
      "Linear OAuth loopback authorization requires the Obsidian desktop runtime.",
    );
  }

  let http: NodeHttpModule;
  try {
    http = nodeRequire("node:http") as NodeHttpModule;
  } catch (error) {
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_unavailable",
      "The desktop HTTP runtime required for Linear OAuth is unavailable.",
      { cause: error },
    );
  }

  let expectedHost = "";
  let redirectUri = "";
  let accepted = false;
  let terminal = false;
  let resolveCallback!: (value: string) => void;
  let rejectCallback!: (reason: LinearOAuthLoopbackErrorV1) => void;
  const callbackUrl = new Promise<string>((resolve, reject) => {
    resolveCallback = resolve;
    rejectCallback = reject;
  });
  // Cancellation is a normal UI lifecycle event. Keep the public promise
  // rejectable for callers without producing an unhandled rejection when a
  // panel closes before it begins awaiting the result.
  void callbackUrl.catch(() => undefined);

  const server = http.createServer(
    { headersTimeout: 5_000, maxHeaderSize: 8_192, requestTimeout: 5_000 },
    (request, response) => {
      if (!expectedHost || terminal) {
        respond(response, 503, "Authorization callback unavailable.");
        return;
      }
      if (accepted) {
        respond(response, 409, "Authorization callback already received.");
        return;
      }

      const host = request.headers.host;
      if (typeof host !== "string" || host !== expectedHost) {
        respond(response, 400, "Invalid authorization callback host.");
        return;
      }
      if (request.method !== "GET") {
        response.setHeader("Allow", "GET");
        respond(response, 405, "Authorization callback requires GET.");
        return;
      }

      const rawUrl = request.url ?? "";
      const rawUrlBytes = utf8Bytes(rawUrl);
      if (
        rawUrlBytes === 0 ||
        rawUrlBytes > MAX_REQUEST_URL_BYTES ||
        !rawUrl.startsWith("/") ||
        rawUrl.startsWith("//") ||
        rawUrl.includes("#")
      ) {
        respond(response, rawUrlBytes > MAX_REQUEST_URL_BYTES ? 414 : 400,
          "Invalid authorization callback URL.");
        return;
      }

      let callback: URL;
      try {
        callback = new URL(rawUrl, redirectUri);
      } catch {
        respond(response, 400, "Invalid authorization callback URL.");
        return;
      }
      if (
        callback.origin !== `http://${expectedHost}` ||
        callback.pathname !== LINEAR_OAUTH_LOOPBACK_PATH
      ) {
        respond(response, 404, "Authorization callback path not found.");
        return;
      }
      if (!isBoundedQuery(callback)) {
        respond(response, 400, "Invalid authorization callback query.");
        return;
      }

      accepted = true;
      clearLifecycleHooks();
      respond(response, 200, SUCCESS_HTML, "text/html; charset=utf-8");
      const exactCallbackUrl = callback.toString();
      void closeServer().then(
        () => {
          terminal = true;
          resolveCallback(exactCallbackUrl);
        },
        (error) => {
          terminal = true;
          rejectCallback(new LinearOAuthLoopbackErrorV1(
            "linear_oauth_loopback_server_failed",
            "The Linear authorization callback listener could not close cleanly.",
            { cause: error },
          ));
        },
      );
    },
  );
  server.keepAliveTimeout = 1;
  server.maxConnections = 16;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let abortListener: (() => void) | undefined;
  let closing: Promise<void> | undefined;

  function closeServer(): Promise<void> {
    if (closing) {
      return closing;
    }
    closing = new Promise<void>((resolve, reject) => {
      if (!server.listening) {
        resolve();
        return;
      }
      const forceClose = setTimeout(() => server.closeAllConnections?.(), 250);
      forceClose.unref?.();
      server.close((error) => {
        clearTimeout(forceClose);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
      server.closeIdleConnections?.();
    });
    return closing;
  }

  function clearLifecycleHooks(): void {
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (abortListener && options.signal) {
      options.signal.removeEventListener("abort", abortListener);
      abortListener = undefined;
    }
    server.removeListener("error", onRuntimeError);
  }

  function fail(
    code: LinearOAuthLoopbackErrorCodeV1,
    message: string,
    cause?: unknown,
  ): void {
    if (terminal || accepted) {
      return;
    }
    terminal = true;
    clearLifecycleHooks();
    rejectCallback(new LinearOAuthLoopbackErrorV1(code, message, { cause }));
    void closeServer().catch(() => undefined);
  }

  function onRuntimeError(error: Error): void {
    fail(
      "linear_oauth_loopback_server_failed",
      "The Linear authorization callback listener failed.",
      error,
    );
  }

  try {
    await listenOnLoopback(server, requestedPort);
  } catch (error) {
    // Prevent a startup-only failure from leaving an internally rejected
    // promise without a consumer: no result object is returned in this path.
    terminal = true;
    rejectCallback(new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_listen_failed",
      "Could not bind the Linear authorization callback listener.",
      { cause: error },
    ));
    await callbackUrl.catch(() => undefined);
    await closeServer().catch(() => undefined);
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_listen_failed",
      "Could not bind the Linear authorization callback listener.",
      { cause: error },
    );
  }

  const address = server.address();
  if (
    !address ||
    typeof address === "string" ||
    address.address !== LINEAR_OAUTH_LOOPBACK_HOST ||
    address.port < 1_024 ||
    address.port > 65_535 ||
    (requestedPort !== 0 && address.port !== requestedPort)
  ) {
    terminal = true;
    rejectCallback(new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_listen_failed",
      "The Linear authorization callback did not bind to the required loopback address and port.",
    ));
    await callbackUrl.catch(() => undefined);
    await closeServer().catch(() => undefined);
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_listen_failed",
      "The Linear authorization callback did not bind to the required loopback address and port.",
    );
  }

  const callback: LinearOAuthLoopbackCallbackV1 = {
    host: LINEAR_OAUTH_LOOPBACK_HOST,
    port: address.port,
    path: LINEAR_OAUTH_LOOPBACK_PATH,
  };
  expectedHost = `${callback.host}:${callback.port}`;
  redirectUri = `http://${expectedHost}${callback.path}`;

  server.on("error", onRuntimeError);
  timer = setTimeout(() => {
    fail(
      "linear_oauth_loopback_timeout",
      "Timed out waiting for the Linear authorization callback.",
    );
  }, timeoutMs);
  timer.unref?.();

  if (options.signal) {
    abortListener = () => fail(
      "linear_oauth_loopback_aborted",
      "Linear authorization was cancelled while waiting for the callback.",
    );
    options.signal.addEventListener("abort", abortListener, { once: true });
    if (options.signal.aborted) {
      abortListener();
    }
  }

  return Object.freeze({
    callback: Object.freeze(callback),
    redirectUri,
    callbackUrl,
    async close(): Promise<void> {
      if (!terminal && !accepted) {
        fail(
          "linear_oauth_loopback_closed",
          "Linear authorization was cancelled before a callback was received.",
        );
      }
      await closeServer();
    },
  });
}

function listenOnLoopback(
  server: import("node:http").Server,
  port: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, LINEAR_OAUTH_LOOPBACK_HOST);
  });
}

function isBoundedQuery(url: URL): boolean {
  if (utf8Bytes(url.search) > MAX_QUERY_BYTES) {
    return false;
  }
  let fields = 0;
  for (const [key, value] of url.searchParams) {
    fields += 1;
    if (
      fields > MAX_QUERY_FIELDS ||
      utf8Bytes(key) > MAX_QUERY_KEY_BYTES ||
      utf8Bytes(value) > MAX_QUERY_VALUE_BYTES
    ) {
      return false;
    }
  }
  return fields > 0;
}

function respond(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): void {
  response.statusCode = status;
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  response.setHeader("Content-Type", contentType);
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(body);
}

function normalizeTimeout(value: number | undefined): number {
  const timeout = value ?? LINEAR_OAUTH_LOOPBACK_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_MS) {
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_invalid_input",
      `Linear OAuth loopback timeout must be between 1 and ${MAX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeout;
}

function normalizePort(value: number | undefined): number {
  const port = value ?? 0;
  if (
    !Number.isSafeInteger(port) ||
    (port !== 0 && (port < 1_024 || port > 65_535))
  ) {
    throw new LinearOAuthLoopbackErrorV1(
      "linear_oauth_loopback_invalid_input",
      "Linear OAuth loopback port must be zero or an integer between 1024 and 65535.",
    );
  }
  return port;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
