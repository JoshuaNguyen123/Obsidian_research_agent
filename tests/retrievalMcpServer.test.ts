import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  DEFAULT_MCP_SEARCH_LIMIT_V1,
  JSON_RPC_METHOD_NOT_FOUND_V1,
  MAX_MCP_SEARCH_LIMIT_V1,
  RETRIEVAL_MCP_PROTOCOL_VERSION_V1,
  RETRIEVAL_MCP_TOOLS_V1,
  handleRetrievalMcpRequestV1,
  type RetrievalMcpDependenciesV1,
} from "../src/mcp/retrievalMcpServerV1";
import {
  ReadOnlyVaultAdapterV1,
  ReadOnlyVaultError,
} from "../src/mcp/readOnlyVaultAdapterV1";
import {
  resolveMcpRetrievalSettingsV1,
  withheldMcpSettingKeysV1,
} from "../src/mcp/retrievalMcpSettingsV1";

/*
 * The retrieval stack is the most reusable thing here, and the only way to ask
 * it anything used to be to be the plugin. Exposing it is also the point where
 * a vault meets other software, so most of these tests are about the limits:
 * read-only as a property of the object graph rather than a promise, no path
 * escaping the vault, dotfolders (and therefore `.obsidian` and anything
 * stored in it) never listed, and a missing index reported instead of built.
 */

async function vaultFixture(name: string) {
  const root = await mkdtemp(path.join(tmpdir(), `mcp-vault-${name}-`));
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await mkdir(path.join(root, ".obsidian", "plugins"), { recursive: true });
  await writeFile(path.join(root, "Notes", "sharding.md"), "# Sharding\n\nThe conclusion.\n");
  await writeFile(path.join(root, "Notes", "ledger.md"), "# Ledger\n\nEntries.\n");
  await writeFile(path.join(root, "top.md"), "# Top\n\nRoot note.\n");
  await writeFile(path.join(root, ".obsidian", "secrets.json"), '{"apiKey":"sk-do-not-leak"}');
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

function dependencies(
  overrides: Partial<RetrievalMcpDependenciesV1> = {},
): RetrievalMcpDependenciesV1 {
  return {
    search: async () => ({
      ok: true,
      results: [
        { path: "Notes/sharding.md", heading: "Sharding", score: 0.9, snippet: "The conclusion." },
      ],
      reranked: true,
    }) as never,
    readNote: async () => "# Sharding\n\nThe conclusion.\n",
    vaultName: "Vault",
    serverVersion: "0.4.0",
    ...overrides,
  };
}

test("the vault listing never exposes dotfolders", async () => {
  const fixture = await vaultFixture("dotfolders");
  try {
    const app = new ReadOnlyVaultAdapterV1(fixture.root).asApp();
    const paths = app.vault.getFiles().map((file) => file.path).sort();
    assert.deepEqual(paths, ["Notes/ledger.md", "Notes/sharding.md", "top.md"]);
    // `.obsidian` holds workspace layout, plugin settings, and whatever keys
    // are stored in them. It is not vault content and must never be listed.
    assert.ok(!paths.some((entry) => entry.includes(".obsidian")));
    assert.equal(app.vault.getFileByPath(".obsidian/secrets.json"), null);
  } finally {
    await fixture.cleanup();
  }
});

test("every mutating vault method throws rather than being absent", async () => {
  // Read-only has to be a property of the object, not of the descriptions: a
  // missing method would be a TypeError somewhere unrelated, while a throwing
  // one names what was attempted.
  const fixture = await vaultFixture("readonly");
  try {
    const vault = new ReadOnlyVaultAdapterV1(fixture.root).asApp().vault as unknown as Record<
      string,
      () => unknown
    >;
    for (const method of ["create", "createFolder", "modify", "delete", "trash", "rename"]) {
      assert.throws(
        () => vault[method]!(),
        ReadOnlyVaultError,
        `${method} must refuse`,
      );
    }
  } finally {
    await fixture.cleanup();
  }
});

test("no path escapes the vault, before or after symlink resolution", async () => {
  const fixture = await vaultFixture("escape");
  const outside = await mkdtemp(path.join(tmpdir(), "mcp-outside-"));
  try {
    await writeFile(path.join(outside, "private.md"), "# Private\n");
    const adapter = new ReadOnlyVaultAdapterV1(fixture.root);
    const app = adapter.asApp();
    for (const escape of ["../private.md", "/etc/passwd", "Notes/../../private.md"]) {
      assert.equal(app.vault.getFileByPath(escape), null, escape);
      assert.equal(app.vault.getFolderByPath(escape), null, escape);
    }

    // A symlink inside the vault pointing out of it: the name is contained,
    // the file is not. This is the case the second containment check exists
    // for, and the reason resolution happens before the comparison.
    let linked = true;
    try {
      await symlink(outside, path.join(fixture.root, "linked"), "dir");
    } catch {
      linked = false; // Windows without developer mode; the check still holds.
    }
    if (linked) {
      adapter.refresh();
      assert.equal(app.vault.getFolderByPath("linked"), null, "a symlink out of the vault");
    }
  } finally {
    await rm(outside, { recursive: true, force: true });
    await fixture.cleanup();
  }
});

test("the protocol surface is initialize, tools/list, tools/call, and nothing that writes", async () => {
  const initialize = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    dependencies(),
  );
  assert.equal(
    (initialize?.result as { protocolVersion: string }).protocolVersion,
    RETRIEVAL_MCP_PROTOCOL_VERSION_V1,
  );

  const listed = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    dependencies(),
  );
  const tools = (listed?.result as { tools: readonly { name: string }[] }).tools;
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    ["read_note", "search_vault"],
    "two tools, and neither of them writes",
  );
  for (const tool of RETRIEVAL_MCP_TOOLS_V1) {
    assert.ok(
      !/\b(write|create|append|delete|modify|rebuild|index)\b/u.test(tool.name),
      `${tool.name} must not be a mutation`,
    );
  }

  const unknown = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 3, method: "vault/write" },
    dependencies(),
  );
  assert.equal(unknown?.error?.code, JSON_RPC_METHOD_NOT_FOUND_V1);
});

test("a notification is not answered", async () => {
  // Answering one is a protocol violation, and some clients treat it as fatal.
  for (const method of ["notifications/initialized", "notifications/cancelled"]) {
    assert.equal(
      await handleRetrievalMcpRequestV1({ jsonrpc: "2.0", method }, dependencies()),
      null,
      method,
    );
  }
  assert.equal(
    await handleRetrievalMcpRequestV1({ jsonrpc: "2.0", method: "unknown/notification" }, dependencies()),
    null,
    "a request with no id takes no response even when the method is unknown",
  );
});

test("search clamps its arguments and asks for a deep, ranked pass", async () => {
  const seen: Record<string, unknown>[] = [];
  const deps = dependencies({
    search: (async (request: Record<string, unknown>) => {
      seen.push(request);
      return { ok: true, results: [], reranked: false };
    }) as never,
  });
  await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_vault", arguments: { query: "sharding", limit: 10_000 } } },
    deps,
  );
  assert.equal(seen[0]?.limit, MAX_MCP_SEARCH_LIMIT_V1);
  assert.equal(seen[0]?.mode, "deep");

  await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "search_vault", arguments: { query: "sharding" } } },
    deps,
  );
  assert.equal(seen[1]?.limit, DEFAULT_MCP_SEARCH_LIMIT_V1);
});

test("a vault with no index says so instead of building one", async () => {
  // Building writes to the vault, takes minutes, and belongs to the plugin
  // that owns the settings. Starting one inside somebody's editor session
  // because they typed a query would be the worst possible surprise.
  const response = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_vault", arguments: { query: "anything" } } },
    dependencies({
      search: (async () => ({ ok: false, code: "index_missing", message: "No index.", results: [] })) as never,
    }),
  );
  const result = response?.result as { isError?: boolean; content: { text: string }[] };
  assert.equal(result.isError, true);
  assert.match(result.content[0]!.text, /index_missing/u);
  assert.match(result.content[0]!.text, /never writes to the vault/u);
});

test("a thrown handler answers with an error instead of killing the server", async () => {
  const response = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "search_vault", arguments: { query: "boom" } } },
    dependencies({
      search: (async () => {
        throw new Error("helper died");
      }) as never,
    }),
  );
  assert.equal(response?.id, 7);
  assert.match(response?.error?.message ?? "", /helper died/u);
});

test("an empty query is refused without reaching the index", async () => {
  let called = false;
  const response = await handleRetrievalMcpRequestV1(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "search_vault", arguments: { query: "   " } } },
    dependencies({
      search: (async () => {
        called = true;
        return { ok: true, results: [] };
      }) as never,
    }),
  );
  assert.equal(called, false);
  assert.equal((response?.result as { isError?: boolean }).isError, true);
});

test("vault settings reach the server, credentials do not", async () => {
  // The failure that made this module exist: importing DEFAULT_SETTINGS pulls
  // in src/settings.ts, which imports Notice and PluginSettingTab from
  // "obsidian" as runtime values, and that package ships types only. The
  // server died at load with "Cannot find module 'obsidian'" the first time it
  // ran. Nothing in this chain may import it.
  const stored = {
    semanticEmbeddingModel: "BAAI/bge-small-en-v1.5",
    semanticChunkTargetTokens: 512,
    semanticRerankMode: "cross_encoder",
    // Everything below is in a real data.json and must not travel.
    apiKey: "sk-must-not-leak",
    ollamaApiKey: "also-secret",
    baseUrl: "https://ollama.com/api",
    model: "glm-5.3-flash:cloud",
  };
  const resolved = resolveMcpRetrievalSettingsV1(stored) as unknown as Record<string, unknown>;

  // The vault's own values win: the index manifest records what it was built
  // with, and searching it with different ones is refused, not degraded.
  assert.equal(resolved.semanticEmbeddingModel, "BAAI/bge-small-en-v1.5");
  assert.equal(resolved.semanticChunkTargetTokens, 512);
  assert.equal(resolved.semanticRerankMode, "cross_encoder");
  // Unstated keys still come from the defaults.
  assert.equal(resolved.semanticIndexFolder, "Agent Memory");

  for (const secret of ["apiKey", "ollamaApiKey", "baseUrl", "model"]) {
    assert.equal(
      resolved[secret],
      undefined,
      `${secret} must not travel into a process exposed to other software`,
    );
  }
  assert.deepEqual(withheldMcpSettingKeysV1(stored).sort(), [
    "apiKey",
    "baseUrl",
    "model",
    "ollamaApiKey",
  ]);

  // Unreadable stored settings yield the defaults rather than refusing to
  // start: a vault indexed with the defaults is the common case.
  for (const payload of [null, undefined, "not an object", [], 42]) {
    const fallback = resolveMcpRetrievalSettingsV1(payload) as unknown as Record<string, unknown>;
    assert.equal(fallback.semanticIndexFolder, "Agent Memory");
    assert.equal(fallback.semanticIndexEnabled, true);
  }
});

test("no module in the server's import chain requires obsidian at runtime", () => {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const chain = [
    "scripts/mcp-retrieval-server.ts",
    "src/mcp/retrievalMcpServerV1.ts",
    "src/mcp/readOnlyVaultAdapterV1.ts",
    "src/mcp/retrievalMcpSettingsV1.ts",
  ];
  for (const file of chain) {
    const source = readFileSync(path.join(root, file), "utf8");
    for (const line of source.split(/\r?\n/u)) {
      if (!line.includes('from "obsidian"')) continue;
      assert.ok(
        line.trimStart().startsWith("import type"),
        `${file} imports obsidian as a runtime value: ${line.trim()}`,
      );
    }
    assert.ok(
      !/from "\.\.\/src\/settings"|from "\.\.\/settings"/u.test(
        source.replace(/import type[\s\S]*?from "[^"]*";/gu, ""),
      ),
      `${file} must not import the settings module as a value`,
    );
  }
});
