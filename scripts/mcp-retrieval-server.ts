import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createPythonFastEmbedProvider } from "../src/embeddings/pythonFastEmbedProvider";
import { createSemanticIndexService } from "../src/embeddings/semanticIndex";
import {
  handleRetrievalMcpRequestV1,
  type JsonRpcRequestV1,
} from "../src/mcp/retrievalMcpServerV1";
import { ReadOnlyVaultAdapterV1 } from "../src/mcp/readOnlyVaultAdapterV1";
import {
  resolveMcpRetrievalSettingsV1,
  withheldMcpSettingKeysV1,
} from "../src/mcp/retrievalMcpSettingsV1";
import type { AgentSettings } from "../src/settings";

/**
 * Read-only MCP server over one vault's retrieval stack.
 *
 *   npm run mcp:retrieval -- --vault "C:/path/to/Vault"
 *
 * Speaks newline-delimited JSON-RPC on stdin/stdout, so it is launched as a
 * child process by whatever MCP client wants it and exits with that client. It
 * opens no socket and holds no state of its own.
 *
 * Settings come from the vault's own `data.json` when one is there, so the
 * server searches with the same embedding model, chunking and rerank
 * configuration the plugin indexed with. That is not a nicety: the index
 * manifest records the model and chunking it was built with, and searching it
 * with different ones is a rebuild-or-refuse, not a slightly worse ranking.
 *
 * Everything the process writes that is not a protocol response goes to
 * stderr. A stray `console.log` here is a parse error at the client, which is
 * why nothing below prints to stdout except a serialized response.
 */

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1] ?? null;
}

/**
 * The plugin's stored settings, if this vault has them. Absent or unreadable
 * settings fall back to the shipped defaults rather than failing: a vault that
 * was indexed with the defaults is the common case.
 */
function loadVaultSettings(vaultRoot: string): AgentSettings {
  const candidate = path.join(
    vaultRoot,
    ".obsidian",
    "plugins",
    "agentic-researcher",
    "data.json",
  );
  try {
    if (fs.existsSync(candidate)) {
      const parsed: unknown = JSON.parse(fs.readFileSync(candidate, "utf8"));
      const withheld = withheldMcpSettingKeysV1(parsed);
      process.stderr.write(
        `Using retrieval settings from ${candidate}` +
          (withheld.length > 0
            ? ` (${withheld.length} non-retrieval keys, including any credentials, left behind)`
            : "") +
          "\n",
      );
      return resolveMcpRetrievalSettingsV1(parsed);
    }
  } catch (error) {
    process.stderr.write(
      `Ignoring unreadable settings at ${candidate}: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  process.stderr.write("No plugin settings in this vault; using retrieval defaults.\n");
  return resolveMcpRetrievalSettingsV1(null);
}

async function main(): Promise<void> {
  const vaultRoot = argValue("--vault") ?? process.env.AGENTIC_MCP_VAULT ?? null;
  if (!vaultRoot) {
    fail('Usage: mcp-retrieval-server --vault "<path to vault>"');
  }

  const adapter = new ReadOnlyVaultAdapterV1(vaultRoot);
  const settings = loadVaultSettings(vaultRoot);
  const app = adapter.asApp();
  const provider = createPythonFastEmbedProvider(() => settings);
  const service = createSemanticIndexService({
    app,
    getSettings: () => settings,
    getEmbeddingProvider: () => provider,
  });

  const dependencies = {
    search: service.search.bind(service),
    readNote: async (notePath: string, maxChars: number) => {
      const file = app.vault.getFileByPath(notePath);
      if (!file) throw new Error("no such note in this vault");
      const text = await app.vault.cachedRead(file);
      return text.length > maxChars ? `${text.slice(0, maxChars)}\n…[truncated]` : text;
    },
    vaultName: path.basename(path.resolve(vaultRoot)),
    serverVersion: readVersion(),
  };

  const lines = readline.createInterface({ input: process.stdin });
  // Requests are answered in arrival order. The embedding helper serializes
  // anyway, so overlapping them would buy nothing and would let a slow query
  // reorder a client's replies.
  let queue: Promise<void> = Promise.resolve();
  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    queue = queue.then(async () => {
      let request: JsonRpcRequestV1;
      try {
        request = JSON.parse(trimmed) as JsonRpcRequestV1;
      } catch {
        process.stderr.write(`Ignoring unparseable line: ${trimmed.slice(0, 200)}\n`);
        return;
      }
      try {
        // Current metadata lets the index loader invalidate changed manifest/shard stamps.
        adapter.refresh();
        const response = await handleRetrievalMcpRequestV1(request, dependencies);
        if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
      } catch (error) {
        process.stderr.write(
          `Handler failed: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    });
  });
  lines.on("close", () => {
    void provider.dispose?.();
  });
  process.stderr.write(`Retrieval MCP server ready for vault ${dependencies.vaultName}\n`);
}

function readVersion(): string {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname ?? ".", "..", "manifest.json"), "utf8"),
    ) as { version?: string };
    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

void main().catch((error: unknown) => {
  fail(error instanceof Error ? error.stack ?? error.message : String(error));
});
