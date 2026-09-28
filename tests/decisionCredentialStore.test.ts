import assert from "node:assert/strict";
import test from "node:test";

import {
  DecisionCredentialStoreV1,
  parseDecisionCredentialReferenceV1,
} from "../src/decisions/decisionCredentialStore";
import { ObsidianSecretStoreV1 } from "../src/integrations/ObsidianSecretStoreV1";

function secureStore(storage = new Map<string, string>()) {
  let sequence = 0;
  return {
    storage,
    store: new ObsidianSecretStoreV1(
      {
        getSecret: (id) => storage.get(id) ?? null,
        setSecret: (id, value) => {
          storage.set(id, value);
        },
      },
      {
        now: () => new Date("2026-09-28T12:00:00.000Z"),
        randomId: () => `decision-credential-${String(++sequence).padStart(2, "0")}`,
      },
    ),
  };
}

test("the decision credential persists only as a SecretStorage reference and survives restart", async () => {
  const { store, storage } = secureStore();
  const first = new DecisionCredentialStoreV1(store);
  assert.deepEqual(await first.load(null), { value: "", migrated: false });
  assert.deepEqual(await first.synchronize("sk-or-v1-decision-secret"), []);
  const reference = first.snapshot();
  assert.match(reference?.referenceId ?? "", /^secret-obsidian-/u);
  assert.equal(reference?.metadata.provider, "openrouter");
  assert.equal(reference?.metadata.credentialKind, "decision_api_key");
  // The persisted projection carries no credential text.
  assert.doesNotMatch(JSON.stringify(reference), /decision-secret/u);
  assert.equal(storage.size, 1);

  const restarted = new DecisionCredentialStoreV1(store);
  const loaded = await restarted.load(JSON.parse(JSON.stringify(reference)));
  assert.equal(loaded.value, "sk-or-v1-decision-secret");
  assert.equal(loaded.migrated, false);

  // An unchanged value writes nothing; a new value retires the old reference.
  assert.deepEqual(await restarted.synchronize("sk-or-v1-decision-secret"), []);
  const retired = await restarted.synchronize("sk-or-v1-rotated");
  assert.deepEqual(retired, [reference!.referenceId]);
  await restarted.removeRetired(retired);
  assert.equal(storage.get(reference!.referenceId), "");
  assert.notEqual(restarted.snapshot()?.referenceId, reference!.referenceId);

  // Clearing the value clears the reference.
  const cleared = await restarted.synchronize("");
  assert.equal(cleared.length, 1);
  assert.equal(restarted.snapshot(), null);
});

test("legacy plaintext is migrated into SecretStorage", async () => {
  const { store } = secureStore();
  const credential = new DecisionCredentialStoreV1(store);
  const loaded = await credential.load(undefined, "  sk-or-legacy  ");
  assert.deepEqual(loaded, { value: "sk-or-legacy", migrated: true });
  assert.match(credential.snapshot()?.referenceId ?? "", /^secret-obsidian-/u);
});

test("legacy plaintext SecretStorage refuses is usable but not reported as migrated", async () => {
  const credential = new DecisionCredentialStoreV1(
    new ObsidianSecretStoreV1(
      {
        getSecret: () => null,
        setSecret: () => {
          throw new Error("SecretStorage unavailable");
        },
      },
      { now: () => new Date("2026-09-28T12:00:00.000Z"), randomId: () => "decision-credential-01" },
    ),
  );
  assert.deepEqual(await credential.load(undefined, "sk-or-legacy"), {
    value: "sk-or-legacy",
    migrated: false,
  });
  assert.equal(credential.snapshot(), null);
});

test("a reference that cannot be leased reads as no credential and is never overwritten by an empty save", async () => {
  const { store, storage } = secureStore();
  const first = new DecisionCredentialStoreV1(store);
  await first.load(null);
  await first.synchronize("sk-or-v1-kept");
  const reference = first.snapshot()!;
  storage.set(reference.referenceId, "not json");
  const restarted = new DecisionCredentialStoreV1(store);
  assert.deepEqual(await restarted.load(reference), { value: "", migrated: false });
  // The reference survives an unrelated save so the value is not lost.
  assert.deepEqual(await restarted.synchronize(""), []);
  assert.equal(restarted.snapshot()?.referenceId, reference.referenceId);
});

test("a model credential reference is not accepted as the decision credential", () => {
  assert.equal(
    parseDecisionCredentialReferenceV1({
      version: 1,
      referenceId: "secret-obsidian-model-credential-01",
      label: "ollama model API credential",
      metadata: { provider: "ollama", credentialKind: "model_api_key", actor: "lead" },
      backend: "obsidian-secret-storage",
      persistent: true,
      createdAt: "2026-09-28T12:00:00.000Z",
      updatedAt: "2026-09-28T12:00:00.000Z",
    }),
    null,
  );
  assert.equal(parseDecisionCredentialReferenceV1("secret-obsidian-x"), null);
  assert.equal(parseDecisionCredentialReferenceV1(null), null);
});
