import test from "node:test";
import assert from "node:assert/strict";
import { replaceVaultFileIfUnchanged, transformVaultFile } from "../src/tools/atomicVaultWrite";
import type { ToolExecutionContext } from "../src/tools/types";

test("atomic transformations preserve interleaved edits and reject stale replacement", async () => {
  let content = "original";
  let beforeTransform: (() => void) | undefined;
  const context = { app: { vault: { process: async (_file: unknown, transform: (s: string) => string) => {
    beforeTransform?.();
    content = transform(content);
    return content;
  } } } } as unknown as ToolExecutionContext;
  const file = { path: "Note.md" } as never;
  beforeTransform = () => { content += "\nuser edit"; };
  await transformVaultFile(context, file, (current) => `${current}\nagent append`);
  assert.equal(content, "original\nuser edit\nagent append");
  const expected = content;
  await assert.rejects(replaceVaultFileIfUnchanged(context, file, expected, "replacement"), { code: "vault_write_conflict", mutationState: "not_applied" });
  assert.equal(content, `${expected}\nuser edit`);
});

test("a host without atomic support cannot acknowledge an unsafe write", async () => {
  const context = { app: { vault: {} } } as ToolExecutionContext;
  await assert.rejects(transformVaultFile(context, { path: "Note.md" } as never, () => "replacement"), { code: "vault_atomic_write_unavailable" });
});
