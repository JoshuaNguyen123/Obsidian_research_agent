import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";

import { createPreparedBackgroundCodeActionV1 } from "../packages/core-api/src/preparedBackgroundCodeActionV1";
import {
  createPreparedBackgroundCodePackageV1,
  parsePreparedBackgroundCodePackageV1,
  PreparedBackgroundCodePackageStoreV1,
  type PreparedBackgroundCodePackageRequirementsV1,
  type PreparedBackgroundCodePackageV1,
} from "../extensions/code/background";

const NOW = "2026-07-13T12:00:00.000Z";
const EXPIRES = "2026-07-13T12:10:00.000Z";

test("persists a path-free package transactionally and reloads it after restart", async (t) => {
  const fixture = await createFixture(t);
  const preparedPackage = packageFixture();
  const first = await fixture.store.persist(preparedPackage);

  assert.deepEqual(first.package, preparedPackage);
  assert.equal(first.receipt.readbackVerified, true);
  assert.equal(first.receipt.packageFingerprint, preparedPackage.fingerprint);
  assert.match(first.receipt.fileSha256, /^sha256:[0-9a-f]{64}$/u);

  const packagePath = path.join(fixture.store.packageRoot, `${preparedPackage.id}.json`);
  const bytes = await fs.readFile(packagePath);
  assert.equal(
    first.receipt.fileSha256,
    `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  );
  assert.equal(first.receipt.bytes, bytes.byteLength);

  const serialized = bytes.toString("utf8");
  for (const forbidden of [
    "C:\\Users\\operator\\trusted-repository",
    "/home/operator/trusted-repository",
    ".obsidian",
    "vaultPath",
    "objective",
    "command",
    "npm test",
    "ghp_example-secret-token",
    "super-secret-value",
  ]) {
    assert.equal(serialized.includes(forbidden), false, `package leaked ${forbidden}`);
  }

  const restarted = fixture.restart();
  assert.deepEqual(await restarted.load(requirementsFor(preparedPackage)), preparedPackage);

  const duplicate = await restarted.persist(preparedPackage);
  assert.deepEqual(duplicate.package, preparedPackage);
  assert.equal(duplicate.receipt.readbackVerified, true);
});

test("enforces one exact live owner lease across store restarts", async (t) => {
  const fixture = await createFixture(t);
  const preparedPackage = packageFixture();
  const requirements = requirementsFor(preparedPackage);
  await fixture.store.persist(preparedPackage);

  const ownerA = await fixture.store.claim({
    requirements,
    ownerId: "companion-owner-a",
    leaseMs: 5_000,
  });
  assert.deepEqual(
    await fixture.restart().loadForWorker({
      requirements,
      ownerId: ownerA.ownerId,
      leaseId: ownerA.leaseId,
    }),
    preparedPackage,
  );

  await assert.rejects(
    fixture.restart().claim({
      requirements,
      ownerId: "companion-owner-b",
      leaseMs: 5_000,
    }),
    /live owner lease/u,
  );

  fixture.setNow("2026-07-13T12:00:01.000Z");
  const renewed = await fixture.restart().renew({
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    ownerId: ownerA.ownerId,
    leaseId: ownerA.leaseId,
    leaseMs: 5_000,
  });
  assert.equal(renewed.leaseId, ownerA.leaseId);
  assert.equal(renewed.expiresAt, "2026-07-13T12:00:06.000Z");

  await fixture.restart().release({
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    ownerId: ownerA.ownerId,
    leaseId: ownerA.leaseId,
  });
  const ownerB = await fixture.restart().claim({
    requirements,
    ownerId: "companion-owner-b",
    leaseMs: 5_000,
  });
  assert.equal(ownerB.ownerId, "companion-owner-b");
  assert.notEqual(ownerB.leaseId, ownerA.leaseId);
});

test("rejects tampered, expired, and scope-drifted packages before worker use", async (t) => {
  const fixture = await createFixture(t);
  const preparedPackage = packageFixture();
  const requirements = requirementsFor(preparedPackage);
  await fixture.store.persist(preparedPackage);

  const exactDrifts: Array<Partial<PreparedBackgroundCodePackageRequirementsV1>> = [
    { packageFingerprint: fp("0") },
    { jobId: "different-job" },
    { handoffFingerprint: fp("1") },
    { workspaceId: "different-workspace" },
    { workspaceBindingFingerprint: fp("2") },
    { repositoryProfileKey: "different-profile" },
    { repositoryProfileFingerprint: fp("3") },
    { consumedActionAuthorityFingerprint: fp("4") },
    { backgroundAuthorizationFingerprint: fp("5") },
  ];
  for (const drift of exactDrifts) {
    await assert.rejects(
      fixture.store.load({ ...requirements, ...drift }),
      /exact worker scope/u,
    );
  }

  fixture.setNow(EXPIRES);
  await assert.rejects(fixture.restart().load(requirements), /expired/u);
  await assert.rejects(
    fixture.restart().claim({ requirements, ownerId: "expired-worker", leaseMs: 5_000 }),
    /expired/u,
  );

  fixture.setNow(NOW);
  const packagePath = path.join(fixture.store.packageRoot, `${preparedPackage.id}.json`);
  const tampered = JSON.parse(await fs.readFile(packagePath, "utf8")) as Record<string, unknown>;
  tampered.workspaceId = "tampered-workspace";
  await fs.writeFile(packagePath, `${JSON.stringify(tampered)}\n`, { encoding: "utf8" });
  await assert.rejects(fixture.restart().load(requirements), /fingerprint does not match/u);
});

test("closed parsing and storage boundaries reject command, secret, path, and vault material", async (t) => {
  const fixture = await createFixture(t);
  const preparedPackage = packageFixture();

  for (const unknownField of [
    { command: "powershell -c whoami" },
    { vaultPath: ".obsidian/plugins/agentic-researcher/data.json" },
    { credential: "ghp_example-secret-token" },
  ]) {
    assert.throws(
      () => parsePreparedBackgroundCodePackageV1({ ...preparedPackage, ...unknownField }),
      /closed contract/u,
    );
  }
  assert.throws(
    () => parsePreparedBackgroundCodePackageV1({
      ...preparedPackage,
      jobId: "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    }),
    /secret, path, vault, or command material/u,
  );
  assert.throws(
    () => parsePreparedBackgroundCodePackageV1({
      ...preparedPackage,
      jobId: "C:\\Users\\operator\\repository",
    }),
    /secret, path, vault, or command material/u,
  );

  assert.throws(
    () => new PreparedBackgroundCodePackageStoreV1({ applicationDataRoot: "relative-app-data" }),
    /absolute application-data/u,
  );
  assert.throws(
    () => new PreparedBackgroundCodePackageStoreV1({
      applicationDataRoot: path.join(fixture.root, "test_vault_obsidian_ai", "app-data"),
    }),
    /cannot be stored in an Obsidian or vault path/u,
  );
  assert.throws(
    () => new PreparedBackgroundCodePackageStoreV1({
      applicationDataRoot: path.join(fixture.root, ".obsidian", "plugins", "agentic-researcher"),
    }),
    /cannot be stored in an Obsidian or vault path/u,
  );
});

async function createFixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agentic-code-package-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  let now = NOW;
  let randomSequence = 0;
  const options = () => ({
    applicationDataRoot: path.join(root, "per-user-app-data"),
    now: () => new Date(now),
    randomId: () => `package-store-random-${++randomSequence}`,
  });
  const store = new PreparedBackgroundCodePackageStoreV1(options());
  return {
    root,
    store,
    setNow(value: string) {
      now = value;
    },
    restart() {
      return new PreparedBackgroundCodePackageStoreV1(options());
    },
  };
}

function packageFixture(): PreparedBackgroundCodePackageV1 {
  const preparedActionFingerprint = fp("6");
  const handoff = createPreparedBackgroundCodeActionV1({
    id: "prepared-background-code-action-1",
    missionId: "mission-1",
    graphRevision: 4,
    capabilityEnvelopeFingerprint: fp("7"),
    nodeId: "code-node-1",
    nodeFingerprint: fp("8"),
    executionHost: "headless_runtime",
    descriptorFingerprint: fp("9"),
    preparedActionId: "prepared-code-action-1",
    preparedActionFingerprint,
    binding: {
      workspaceId: "workspace-1",
      repositoryProfileKey: "profile-1",
      destinationFingerprint: fp("a"),
    },
    authority: {
      id: "consumed-code-grant-1",
      authorityFingerprint: fp("b"),
      actionFingerprint: preparedActionFingerprint,
      consumedAt: "2026-07-13T11:59:59.000Z",
      expiresAt: EXPIRES,
    },
    payload: {
      repairCheckpointId: "code-repair:run-1:workspace-1",
      repairRequestFingerprint: fp("c"),
      preparedCheckpointSequence: 3,
      workspaceBindingFingerprint: fp("d"),
      repositoryProfileFingerprint: fp("e"),
      sandboxCapabilityFingerprint: fp("f"),
    },
    idempotencyKey: fp("1"),
    reconciliationKey: fp("1"),
    preparedAt: NOW,
    expiresAt: EXPIRES,
  });
  return createPreparedBackgroundCodePackageV1({
    jobId: "companion-code-job-1",
    backgroundAuthorizationFingerprint: fp("2"),
    executionPlanFingerprint: fp("4"),
    repairCheckpointStage: "repairing",
    sandboxProvider: "docker",
    sandboxBoundaryFingerprint: fp("3"),
    handoff,
  });
}

function requirementsFor(
  preparedPackage: PreparedBackgroundCodePackageV1,
): PreparedBackgroundCodePackageRequirementsV1 {
  return {
    packageId: preparedPackage.id,
    packageFingerprint: preparedPackage.fingerprint,
    jobId: preparedPackage.jobId,
    handoffFingerprint: preparedPackage.handoffFingerprint,
    executionPlanFingerprint: preparedPackage.executionPlanFingerprint,
    workspaceId: preparedPackage.workspaceId,
    workspaceBindingFingerprint: preparedPackage.workspaceBindingFingerprint,
    repositoryProfileKey: preparedPackage.repositoryProfileKey,
    repositoryProfileFingerprint: preparedPackage.repositoryProfileFingerprint,
    consumedActionAuthorityFingerprint: preparedPackage.consumedActionAuthorityFingerprint,
    backgroundAuthorizationFingerprint: preparedPackage.backgroundAuthorizationFingerprint,
  };
}

function fp(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
