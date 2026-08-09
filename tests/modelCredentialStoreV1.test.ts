import assert from "node:assert/strict";
import test from "node:test";

import {
  createSpecialistCredentialBindingV1,
  ModelCredentialStoreV1,
} from "../src/integrations/ModelCredentialStoreV1";
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
    specialist: "specialist-secret-value",
  });

  assert.equal(loaded.migrated, true);
  assert.equal(loaded.values.ollama, "ollama-secret-value");
  assert.equal(loaded.values.specialist, "specialist-secret-value");
  assert.match(first.snapshot().ollama?.referenceId ?? "", /^secret-obsidian-/u);
  assert.match(
    first.snapshot().specialist?.referenceId ?? "",
    /^secret-obsidian-/u,
  );
  assert.notEqual(
    first.snapshot().specialist?.referenceId,
    first.snapshot().ollama?.referenceId,
  );
  assert.doesNotMatch(JSON.stringify(first), /ollama-secret-value/u);
  assert.doesNotMatch(JSON.stringify(first), /specialist-secret-value/u);

  const restarted = new ModelCredentialStoreV1(secureStore);
  const resumed = await restarted.load(first.snapshot(), {});
  assert.equal(resumed.values.ollama, "ollama-secret-value");
  assert.equal(resumed.values.specialist, "specialist-secret-value");

  const retired = await restarted.synchronize({
    ollama: "replacement-secret-value",
    openAiCompatible: "",
    specialist: "specialist-secret-value",
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
  await seeded.load(null, {
    ollama: "temporary-value",
    openAiCompatible: "",
    specialist: "specialist-temporary-value",
  });
  const references = seeded.snapshot();
  storage.clear();

  const restarted = new ModelCredentialStoreV1(secureStore);
  const loaded = await restarted.load(references, {});
  assert.equal(loaded.values.ollama, "");
  assert.deepEqual(
    await restarted.synchronize({
      ollama: "",
      openAiCompatible: "",
      specialist: "",
    }),
    [],
  );
  assert.equal(
    restarted.snapshot().ollama?.referenceId,
    references.ollama?.referenceId,
  );
  assert.equal(
    restarted.snapshot().specialist?.referenceId,
    references.specialist?.referenceId,
  );
});

test("the Specialist credential rotates independently from both Lead provider keys", async () => {
  const storage = new Map<string, string>();
  let sequence = 0;
  const secureStore = new ObsidianSecretStoreV1(
    {
      getSecret: (id) => storage.get(id) ?? null,
      setSecret: (id, value) => {
        storage.set(id, value);
      },
    },
    {
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      randomId: () => `agent-slot-${String(++sequence).padStart(8, "0")}`,
    },
  );
  const credentials = new ModelCredentialStoreV1(secureStore);
  await credentials.load(null, {
    ollama: "lead-ollama",
    openAiCompatible: "lead-openai",
    specialist: "specialist-v1",
  });
  const before = credentials.snapshot();

  const retired = await credentials.synchronize({
    ollama: "lead-ollama",
    openAiCompatible: "lead-openai",
    specialist: "specialist-v2",
  });
  const after = credentials.snapshot();

  assert.deepEqual(retired, [before.specialist?.referenceId]);
  assert.equal(after.ollama?.referenceId, before.ollama?.referenceId);
  assert.equal(
    after.openAiCompatible?.referenceId,
    before.openAiCompatible?.referenceId,
  );
  assert.notEqual(after.specialist?.referenceId, before.specialist?.referenceId);
  assert.equal(after.specialist?.metadata.actor, "specialist");
  assert.doesNotMatch(JSON.stringify(credentials), /specialist-v2/u);
});

test("a persisted reference cannot be relabelled across Lead and Specialist slots", async () => {
  const storage = new Map<string, string>();
  let sequence = 0;
  const secureStore = new ObsidianSecretStoreV1(
    {
      getSecret: (id) => storage.get(id) ?? null,
      setSecret: (id, value) => {
        storage.set(id, value);
      },
    },
    {
      now: () => new Date("2026-08-08T12:00:00.000Z"),
      randomId: () => `slot-binding-${String(++sequence).padStart(8, "0")}`,
    },
  );
  const seeded = new ModelCredentialStoreV1(secureStore);
  await seeded.load(null, {
    ollama: "lead-only-secret",
    openAiCompatible: "",
    specialist: "specialist-only-secret",
  });
  const references = seeded.snapshot();
  assert.ok(references.ollama);

  const restarted = new ModelCredentialStoreV1(secureStore);
  const loaded = await restarted.load(
    {
      ...references,
      specialist: {
        ...references.ollama,
        metadata: {
          ...references.ollama?.metadata,
          actor: "specialist",
        },
      },
    },
    {},
  );

  assert.equal(loaded.values.ollama, "lead-only-secret");
  assert.equal(loaded.values.specialist, "");
  assert.notEqual(loaded.values.specialist, loaded.values.ollama);
});

test("a Specialist key is retired instead of leased across provider destinations", async () => {
  const storage = new Map<string, string>();
  let sequence = 0;
  const secureStore = new ObsidianSecretStoreV1(
    {
      getSecret: (id) => storage.get(id) ?? null,
      setSecret: (id, value) => { storage.set(id, value); },
    },
    {
      now: () => new Date("2026-08-09T12:00:00.000Z"),
      randomId: () => `destination-binding-${String(++sequence).padStart(4, "0")}`,
    },
  );
  const firstBinding = createSpecialistCredentialBindingV1({
    provider: "openai_compatible",
    baseUrl: "https://models.example.test/tenant-a/v1",
  });
  const seeded = new ModelCredentialStoreV1(secureStore);
  await seeded.load(
    null,
    { specialist: "tenant-a-secret" },
    firstBinding,
  );
  const referenceId = seeded.snapshot().specialist?.referenceId;
  assert.ok(referenceId);
  assert.equal(seeded.snapshot().specialist?.metadata.provider, "openai_compatible");
  assert.equal(
    seeded.snapshot().specialist?.metadata.endpoint,
    "https://models.example.test/tenant-a/v1",
  );

  const restarted = new ModelCredentialStoreV1(secureStore);
  const loaded = await restarted.load(
    seeded.snapshot(),
    {},
    createSpecialistCredentialBindingV1({
      provider: "openai_compatible",
      baseUrl: "https://models.example.test/tenant-b/v1",
    }),
  );
  assert.equal(loaded.values.specialist, "");
  assert.equal(restarted.snapshot().specialist, null);
  assert.equal(storage.get(referenceId!), "");
});
