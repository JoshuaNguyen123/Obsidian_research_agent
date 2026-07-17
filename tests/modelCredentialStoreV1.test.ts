import assert from "node:assert/strict";
import test from "node:test";

import { ModelCredentialStoreV1 } from "../src/integrations/ModelCredentialStoreV1";
import { ObsidianSecretStoreV1 } from "../src/integrations/ObsidianSecretStoreV1";

test("model credentials migrate to opaque SecretStorage references and survive restart", async () => {
  const storage = new Map<string, string>();
  let sequence = 0;
  const secureStore = new ObsidianSecretStoreV1(
    {
      getSecret: (id) => storage.get(id) ?? null,
      setSecret: (id, value) => { storage.set(id, value); },
    },
    {
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      randomId: () => `model-credential-${String(++sequence).padStart(2, "0")}`,
    },
  );
  const first = new ModelCredentialStoreV1(secureStore);
  const loaded = await first.load(null, {
    ollama: "ollama-secret-value",
    openAiCompatible: "",
  });

  assert.equal(loaded.migrated, true);
  assert.equal(loaded.values.ollama, "ollama-secret-value");
  assert.match(first.snapshot().ollama?.referenceId ?? "", /^secret-obsidian-/u);
  assert.doesNotMatch(JSON.stringify(first), /ollama-secret-value/u);

  const restarted = new ModelCredentialStoreV1(secureStore);
  const resumed = await restarted.load(first.snapshot(), {});
  assert.equal(resumed.values.ollama, "ollama-secret-value");

  const retired = await restarted.synchronize({
    ollama: "replacement-secret-value",
    openAiCompatible: "",
  });
  assert.equal(retired.length, 1);
  await restarted.removeRetired(retired);
  assert.equal(storage.get(retired[0]), "");
  assert.doesNotMatch(JSON.stringify(restarted), /replacement-secret-value/u);
});

test("an unavailable opaque reference is preserved by unrelated settings saves", async () => {
  const storage = new Map<string, string>();
  const secureStore = new ObsidianSecretStoreV1(
    {
      getSecret: (id) => storage.get(id) ?? null,
      setSecret: (id, value) => { storage.set(id, value); },
    },
    {
      now: () => new Date("2026-07-17T12:00:00.000Z"),
      randomId: () => "unavailable-model-ref-01",
    },
  );
  const seeded = new ModelCredentialStoreV1(secureStore);
  await seeded.load(null, { ollama: "temporary-value", openAiCompatible: "" });
  const references = seeded.snapshot();
  storage.clear();

  const restarted = new ModelCredentialStoreV1(secureStore);
  const loaded = await restarted.load(references, {});
  assert.equal(loaded.values.ollama, "");
  assert.deepEqual(
    await restarted.synchronize({ ollama: "", openAiCompatible: "" }),
    [],
  );
  assert.equal(
    restarted.snapshot().ollama?.referenceId,
    references.ollama?.referenceId,
  );
});
