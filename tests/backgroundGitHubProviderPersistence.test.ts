import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { BackgroundGitHubProviderPersistenceV1 } from "../extensions/integrations/background/BackgroundGitHubProviderPersistenceV1";
import type { GitPushAttemptNamespaceV1 } from "../src/integrations/github/GitPushAttemptStore";

test("independent provider instances elect one different next revision and the loser returns false", async (t) => {
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-provider-cas-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const left = new BackgroundGitHubProviderPersistenceV1(root, {
      randomId: () => `left-${Math.random().toString(16).slice(2)}`,
    }).gitPushAttempts();
    const right = new BackgroundGitHubProviderPersistenceV1(root, {
      randomId: () => `right-${Math.random().toString(16).slice(2)}`,
    }).gitPushAttempts();
    const leftNamespace = namespace(`left-${index}`);
    const rightNamespace = namespace(`right-${index}`);

    const settled = await Promise.allSettled([
      left.write(leftNamespace, 0),
      right.write(rightNamespace, 0),
    ]);
    const rejected = settled.find(
      (entry): entry is PromiseRejectedResult => entry.status === "rejected",
    );
    if (rejected) {
      assert.fail(rejected.reason instanceof Error ? rejected.reason.stack : String(rejected.reason));
    }
    const results = settled.map((entry) => (entry as PromiseFulfilledResult<boolean>).value);

    assert.equal(results.filter(Boolean).length, 1, JSON.stringify(results));
    const winner = results[0] ? leftNamespace : rightNamespace;
    assert.deepEqual(await left.read(), winner);
    assert.deepEqual(await right.read(), winner);
    const directory = path.join(root, "background-github-provider-v1");
    const names = await fs.readdir(directory);
    assert.equal(names.some((name) => name.endsWith(".lock")), false);
    assert.equal(
      names.filter((name) => name.endsWith(".revision-1.claim.json")).length,
      1,
    );
  }));
});

test("a crash-after-claim is completed from WAL and replay survives WAL cleanup", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-provider-recovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "background-github-provider-v1");
  await fs.mkdir(directory, { recursive: true });
  const fileName = "git-push-attempts.json";
  const value = namespace("recovered");
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const walName = `${fileName}.revision-1.${digest}.wal.json`;
  const sourceName = `${fileName}.revision-1.${digest}.claim-source.json`;
  const claimName = `${fileName}.revision-1.claim.json`;
  const claim = Buffer.from(JSON.stringify({
    version: 1,
    namespaceFileName: fileName,
    expectedRevision: 0,
    nextRevision: 1,
    namespaceSha256: digest,
  }), "utf8");
  await fs.writeFile(path.join(directory, walName), bytes, { mode: 0o600, flag: "wx" });
  await fs.writeFile(path.join(directory, sourceName), claim, { mode: 0o600, flag: "wx" });
  await fs.link(path.join(directory, sourceName), path.join(directory, claimName));

  const restarted = new BackgroundGitHubProviderPersistenceV1(root).gitPushAttempts();
  assert.deepEqual(await restarted.read(), value);
  await assert.rejects(fs.stat(path.join(directory, walName)), /ENOENT/u);
  assert.deepEqual(
    await new BackgroundGitHubProviderPersistenceV1(root).gitPushAttempts().read(),
    value,
    "the retained immutable claim/source journal must not require the cleaned WAL after commit",
  );
  assert.equal(await restarted.write(value, 0), false);
  const claimStats = await fs.stat(path.join(directory, claimName), { bigint: true });
  const sourceStats = await fs.stat(path.join(directory, sourceName), { bigint: true });
  assert.equal(claimStats.nlink, BigInt(2));
  assert.equal(claimStats.ino, sourceStats.ino);
});

test("an immutable winning claim without its WAL fails before canonical commit", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-provider-missing-wal-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "background-github-provider-v1");
  await fs.mkdir(directory, { recursive: true });
  const fileName = "git-push-attempts.json";
  const value = namespace("missing-wal");
  const digest = createHash("sha256")
    .update(Buffer.from(JSON.stringify(value), "utf8"))
    .digest("hex");
  const sourcePath = path.join(
    directory,
    `${fileName}.revision-1.${digest}.claim-source.json`,
  );
  const claimPath = path.join(directory, `${fileName}.revision-1.claim.json`);
  await fs.writeFile(sourcePath, JSON.stringify({
    version: 1,
    namespaceFileName: fileName,
    expectedRevision: 0,
    nextRevision: 1,
    namespaceSha256: digest,
  }), { mode: 0o600, flag: "wx" });
  await fs.link(sourcePath, claimPath);

  await assert.rejects(
    new BackgroundGitHubProviderPersistenceV1(root).gitPushAttempts().read(),
    /winning revision WAL is missing/iu,
  );
  await assert.rejects(
    fs.stat(path.join(directory, fileName)),
    /ENOENT/u,
    "missing pre-commit WAL must never synthesize canonical state",
  );
});

test("revision claim links outside their exact content-addressed source are rejected", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "background-github-provider-link-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "background-github-provider-v1");
  await fs.mkdir(directory, { recursive: true });
  const claimPath = path.join(directory, "git-push-attempts.json.revision-1.claim.json");
  const outside = path.join(root, "outside-claim.json");
  await fs.writeFile(outside, "{}", { mode: 0o600 });
  await fs.link(outside, claimPath);

  await assert.rejects(
    new BackgroundGitHubProviderPersistenceV1(root).gitPushAttempts().read(),
    /claim|hard-link ownership/iu,
  );
});

function namespace(marker: string): GitPushAttemptNamespaceV1 {
  return {
    version: 1,
    revision: 1,
    attempts: {
      [marker]: { marker },
    },
  } as unknown as GitPushAttemptNamespaceV1;
}
