import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseResourceMeasurementArgs, measureStorage, summarizeResourceSamples } from "../scripts/measure-overnight-resources.mjs";

test("overnight observations retain unknowns, outages and actual duration", () => {
  assert.equal(summarizeResourceSamples([], 8).coverage, null);
  const report = summarizeResourceSamples([
    { status: "observed", elapsedMs: 100, heapUsedBytes: null, storageBytes: 40, roundTripMs: 130 },
    { status: "unavailable", elapsedMs: 200 },
    { status: "observed", elapsedMs: 300, heapUsedBytes: 500, storageBytes: 70, roundTripMs: 190 },
  ], 250);
  assert.equal(report.coverage, 2 / 3);
  assert.equal(report.durationSatisfied, false);
  assert.equal(report.heapGrowthBytes, null);
  assert.equal(report.storageGrowthBytes, 30);
  assert.equal(report.acceptedOutputEfficiency, null);
  const restarted = summarizeResourceSamples([
    { status: "observed", elapsedMs: 0, runtimeStartedAt: 10, heapUsedBytes: 500, roundTripMs: 10 },
    { status: "observed", elapsedMs: 100, runtimeStartedAt: 70, heapUsedBytes: 100, roundTripMs: 10 },
  ], 100);
  assert.equal(restarted.runtimeSessions, 2);
  assert.equal(restarted.heapGrowthBytes, null, "A restarted renderer is not a measured memory improvement.");
});

test("measurement refuses remote CDP and unbound vaults", () => {
  const vault = path.resolve("fixture-vault");
  const options = parseResourceMeasurementArgs([`--vault=${vault}`]);
  assert.equal(options.durationMs, 8 * 60 * 60_000);
  assert.throws(() => parseResourceMeasurementArgs([`--vault=${vault}`, "--cdp=http://example.com:9222"]), /loopback/);
  assert.throws(() => parseResourceMeasurementArgs(["--vault=relative"]), /absolute/);
  assert.throws(() => parseResourceMeasurementArgs([`--vault=${vault}`, "--interval-ms=0"]), /bounded/);
});

test("storage inventory counts metadata and fails loudly at its entry bound", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "agentic-storage-measurement-"));
  try {
    await mkdir(path.join(directory, "nested"));
    await writeFile(path.join(directory, "one.md"), "four");
    await writeFile(path.join(directory, "nested", "two.md"), "sixsix");
    assert.deepEqual(await measureStorage(directory), { bytes: 10, files: 2 });
    await assert.rejects(measureStorage(directory, 1), /entry limit/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
