import type { SemanticIndexService } from "../embeddings/semanticIndexTypes";

/**
 * A read-only MCP server over the vault retrieval stack.
 *
 * The index, the hybrid scorer and the cross-encoder rerank are the most
 * reusable thing this project has, and until now the only way to ask them
 * anything was to be the plugin. This exposes them over MCP so an editor, a
 * terminal agent, or another Claude session can search the same vault with the
 * same ranking, without a second index and without a copy of the scoring.
 *
 * Three deliberate limits, because this is the boundary where a vault meets
 * other software:
 *
 * 1. **Read-only, structurally.** There are two tools and neither writes.
 *    The vault beneath is opened through {@link ReadOnlyVaultAdapterV1}, whose
 *    mutating methods throw, so "read-only" is a property of the object graph
 *    rather than a promise in a description.
 * 2. **stdio only.** The server speaks JSON-RPC on stdin and stdout and never
 *    opens a socket. It is a child process of whoever launched it, it exits
 *    with them, and nothing on the network can reach it. That is also why it
 *    is not the "backend service" AGENTS.md rules out: no port, no daemon, no
 *    lifetime of its own.
 * 3. **The index is never built here.** Building writes to the vault, takes
 *    minutes, and belongs to the plugin that owns the settings. A server
 *    pointed at a vault with no index says so and returns nothing, rather than
 *    starting an hours-long rebuild inside somebody's editor session.
 *
 * The transport is deliberately not abstracted behind a library: MCP over
 * stdio is newline-delimited JSON-RPC 2.0, the whole surface used here is
 * three methods, and a dependency for that would be larger than the thing it
 * replaced.
 */

export const RETRIEVAL_MCP_PROTOCOL_VERSION_V1 = "2024-11-05";
export const RETRIEVAL_MCP_SERVER_NAME_V1 = "agentic-researcher-retrieval";
export const MAX_MCP_SEARCH_LIMIT_V1 = 20;
export const DEFAULT_MCP_SEARCH_LIMIT_V1 = 8;
export const MAX_MCP_SNIPPET_CHARS_V1 = 2_000;
export const DEFAULT_MCP_SNIPPET_CHARS_V1 = 800;

export interface JsonRpcRequestV1 {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponseV1 {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string };
}

export const JSON_RPC_METHOD_NOT_FOUND_V1 = -32601;
export const JSON_RPC_INVALID_PARAMS_V1 = -32602;
export const JSON_RPC_INTERNAL_ERROR_V1 = -32603;

export const RETRIEVAL_MCP_TOOLS_V1 = Object.freeze([
  {
    name: "search_vault",
    description:
      "Search an Obsidian vault's persisted semantic index and return ranked passages. Hybrid ranking (embedding similarity fused with BM25) and, when the vault is configured for it, a local cross-encoder rerank of the shortlist. Read-only: this never writes to the vault and never builds the index.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What to look for." },
        limit: {
          type: "integer",
          description: `Passages to return. Default ${DEFAULT_MCP_SEARCH_LIMIT_V1}, maximum ${MAX_MCP_SEARCH_LIMIT_V1}.`,
        },
        folder: {
          type: "string",
          description: "Optional vault-relative folder to restrict the search to.",
        },
        maxSnippetChars: {
          type: "integer",
          description: `Characters per passage. Default ${DEFAULT_MCP_SNIPPET_CHARS_V1}, maximum ${MAX_MCP_SNIPPET_CHARS_V1}.`,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "read_note",
    description:
      "Read one note from the vault by its vault-relative path, as returned by search_vault. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Vault-relative path, e.g. Notes/sharding.md" },
        maxChars: {
          type: "integer",
          description: "Maximum characters to return. Default 20000.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
  },
] as const);

export const MAX_NOTE_READ_CHARS_V1 = 20_000;

export interface RetrievalMcpDependenciesV1 {
  search: SemanticIndexService["search"];
  readNote: (path: string, maxChars: number) => Promise<string>;
  vaultName: string;
  serverVersion: string;
}

function clampInteger(value: unknown, fallback: number, max: number): number {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number.parseInt(value, 10)
        : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

function textContent(text: string) {
  return { content: [{ type: "text", text }] };
}

function errorContent(text: string) {
  return { content: [{ type: "text", text }], isError: true };
}

async function callSearchV1(
  dependencies: RetrievalMcpDependenciesV1,
  args: Record<string, unknown>,
): Promise<unknown> {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (!query) return errorContent("search_vault requires a non-empty query.");
  const folder = typeof args.folder === "string" && args.folder.trim() ? args.folder.trim() : null;
  const result = await dependencies.search({
    query,
    limit: clampInteger(args.limit, DEFAULT_MCP_SEARCH_LIMIT_V1, MAX_MCP_SEARCH_LIMIT_V1),
    folder,
    maxSnippetChars: clampInteger(
      args.maxSnippetChars,
      DEFAULT_MCP_SNIPPET_CHARS_V1,
      MAX_MCP_SNIPPET_CHARS_V1,
    ),
    // The caller is reading these passages to answer with, which is what the
    // deep shortlist and the rerank stage exist for.
    mode: "deep",
  });
  if (!result.ok) {
    // A vault with no index is the ordinary case for a fresh checkout, not a
    // protocol error: say what is missing and let the caller decide.
    return errorContent(
      `The vault index could not answer this search (${result.code ?? "unavailable"}): ${
        result.message ?? "no index available"
      }. Build or refresh the index in the Obsidian plugin; this server never writes to the vault.`,
    );
  }
  return textContent(
    JSON.stringify(
      {
        vault: dependencies.vaultName,
        query,
        reranked: result.reranked ?? false,
        results: result.results.map((hit) => ({
          path: hit.path,
          heading: hit.heading ?? null,
          score: hit.score,
          snippet: hit.snippet,
        })),
      },
      null,
      2,
    ),
  );
}

async function callReadV1(
  dependencies: RetrievalMcpDependenciesV1,
  args: Record<string, unknown>,
): Promise<unknown> {
  const notePath = typeof args.path === "string" ? args.path.trim() : "";
  if (!notePath) return errorContent("read_note requires a path.");
  try {
    const text = await dependencies.readNote(
      notePath,
      clampInteger(args.maxChars, MAX_NOTE_READ_CHARS_V1, MAX_NOTE_READ_CHARS_V1),
    );
    return textContent(text);
  } catch (error) {
    return errorContent(
      `Could not read ${notePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Handle one JSON-RPC request. Returns null for a notification, which by
 * protocol takes no response — answering one is a protocol violation that some
 * clients treat as a fatal error.
 */
export async function handleRetrievalMcpRequestV1(
  request: JsonRpcRequestV1,
  dependencies: RetrievalMcpDependenciesV1,
): Promise<JsonRpcResponseV1 | null> {
  const id = request.id ?? null;
  const isNotification = request.id === undefined || request.id === null;
  const ok = (result: unknown): JsonRpcResponseV1 => ({ jsonrpc: "2.0", id, result });
  const fail = (code: number, message: string): JsonRpcResponseV1 => ({
    jsonrpc: "2.0",
    id,
    error: { code, message },
  });

  switch (request.method) {
    case "initialize":
      return ok({
        protocolVersion: RETRIEVAL_MCP_PROTOCOL_VERSION_V1,
        capabilities: { tools: {} },
        serverInfo: {
          name: RETRIEVAL_MCP_SERVER_NAME_V1,
          version: dependencies.serverVersion,
        },
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return null;
    case "tools/list":
      return ok({ tools: RETRIEVAL_MCP_TOOLS_V1 });
    case "ping":
      return ok({});
    case "tools/call": {
      const name = request.params?.name;
      const args = (request.params?.arguments ?? {}) as Record<string, unknown>;
      try {
        if (name === "search_vault") return ok(await callSearchV1(dependencies, args));
        if (name === "read_note") return ok(await callReadV1(dependencies, args));
        return fail(JSON_RPC_INVALID_PARAMS_V1, `Unknown tool: ${String(name)}`);
      } catch (error) {
        // A thrown handler must not kill the server: the client would lose
        // every later request to one bad query.
        return fail(
          JSON_RPC_INTERNAL_ERROR_V1,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    default:
      if (isNotification) return null;
      return fail(
        JSON_RPC_METHOD_NOT_FOUND_V1,
        `Unsupported method: ${String(request.method)}`,
      );
  }
}
