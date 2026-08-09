import {
  createServer,
  request as requestHttp,
  type IncomingMessage,
} from "node:http";
import { once } from "node:events";

export interface AuthenticatedOllamaProxySnapshotV1 {
  authorizedRequests: number;
  rejectedRequests: number;
  models: string[];
  paths: string[];
  responses: Array<{
    path: string;
    status: number;
    contentType: string | null;
    contentLength: string | null;
    transferEncoding: string | null;
    firstBytesHex: string;
  }>;
}

export interface AuthenticatedOllamaProxyV1 {
  baseUrl: string;
  snapshot(): AuthenticatedOllamaProxySnapshotV1;
  close(): Promise<void>;
}

/**
 * Disposable loopback boundary used to prove that Lead and Specialist send
 * different credentials to different endpoints while both still make real
 * Ollama model calls. The token is never logged or returned by snapshot().
 */
export async function startAuthenticatedOllamaProxyV1(options: {
  expectedBearerToken: string;
  upstreamBaseUrl?: string;
}): Promise<AuthenticatedOllamaProxyV1> {
  const expected = options.expectedBearerToken.trim();
  if (!expected) throw new Error("Authenticated Ollama proxy requires a token.");
  const upstream = new URL(options.upstreamBaseUrl ?? "http://127.0.0.1:11434");
  if (!isLoopback(upstream.hostname)) {
    throw new Error("Authenticated Ollama proxy upstream must be loopback.");
  }

  let authorizedRequests = 0;
  let rejectedRequests = 0;
  const models = new Set<string>();
  const paths = new Set<string>();
  const responses: AuthenticatedOllamaProxySnapshotV1["responses"] = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${expected}`) {
        rejectedRequests += 1;
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid disposable slot credential" }));
        return;
      }
      authorizedRequests += 1;
      const requestPath = request.url?.startsWith("/") ? request.url : "/";
      paths.add(requestPath.split("?")[0] ?? requestPath);
      const body = await readBoundedBody(request, 8 * 1024 * 1024);
      if (body.length > 0) {
        try {
          const parsed = JSON.parse(body.toString("utf8"));
          if (typeof parsed?.model === "string" && parsed.model.trim()) {
            models.add(parsed.model.trim());
          }
        } catch {
          // The upstream owns schema validation; metrics are best-effort only.
        }
      }
      const target = new URL(requestPath, upstream);
      await new Promise<void>((resolve, reject) => {
        const upstreamRequest = requestHttp(
          {
            protocol: target.protocol,
            hostname: target.hostname,
            port: target.port,
            path: `${target.pathname}${target.search}`,
            method: request.method ?? "GET",
            headers: {
              "content-type":
                request.headers["content-type"] ?? "application/json",
              ...(body.length > 0
                ? { "content-length": String(body.length) }
                : {}),
            },
          },
          (upstreamResponse) => {
            const headers = { ...upstreamResponse.headers };
            delete headers.connection;
            delete headers["keep-alive"];
            response.writeHead(upstreamResponse.statusCode ?? 502, headers);
            const responseProof = {
              path: target.pathname,
              status: upstreamResponse.statusCode ?? 502,
              contentType: stringHeader(upstreamResponse.headers["content-type"]),
              contentLength: stringHeader(upstreamResponse.headers["content-length"]),
              transferEncoding: stringHeader(
                upstreamResponse.headers["transfer-encoding"],
              ),
              firstBytesHex: "",
            };
            upstreamResponse.once("data", (chunk) => {
              responseProof.firstBytesHex = Buffer.from(chunk)
                .subarray(0, 48)
                .toString("hex");
            });
            upstreamResponse.pipe(response);
            upstreamResponse.once("end", () => {
              responses.push(responseProof);
              if (responses.length > 8) responses.shift();
              resolve();
            });
            upstreamResponse.once("error", reject);
          },
        );
        upstreamRequest.once("error", reject);
        upstreamRequest.end(body.length > 0 ? body : undefined);
      });
    } catch (error) {
      if (response.headersSent) {
        response.destroy(error instanceof Error ? error : undefined);
      } else {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error:
              error instanceof Error
                ? error.message.slice(0, 300)
                : "proxy failure",
          }),
        );
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Authenticated Ollama proxy did not bind a TCP port.");
  }
  return {
    // OllamaClient treats the configured base as the API root and appends
    // `/chat`; retain `/api` so the proxy forwards to Ollama's `/api/chat`.
    baseUrl: `http://127.0.0.1:${address.port}/api`,
    snapshot: () => ({
      authorizedRequests,
      rejectedRequests,
      models: [...models].sort(),
      paths: [...paths].sort(),
      responses: responses.map((item) => ({ ...item })),
    }),
    close: async () => {
      if (!server.listening) return;
      server.close();
      await once(server, "close");
    },
  };
}

function stringHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value.join(", ");
  return typeof value === "string" ? value : null;
}

async function readBoundedBody(
  request: IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const raw of request) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    total += chunk.length;
    if (total > maxBytes) {
      throw new Error("Disposable Ollama proxy request exceeded its body limit.");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function isLoopback(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}
