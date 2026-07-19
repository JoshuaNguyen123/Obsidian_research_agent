import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ensureVaultScopeId,
  isResearchMemoryRecordV2,
  migrateResearchMemoryIndexV2,
} from "../src/agent/researchMemoryV2";

describe("ResearchMemoryRecordV2", () => {
  it("migrates a vault-local legacy record without changing its source note", () => {
    const scope = `vault_${"a".repeat(64)}`;
    const observedAt = "2026-07-16T12:00:00.000Z";
    const [record] = migrateResearchMemoryIndexV2(
      [{
        topic: "Compaction safety",
        path: "Agent Research Memory/compaction.md",
        keywords: ["handoff"],
        lastUpdated: "2026-07-15T00:00:00.000Z",
        sourcePaths: ["Research/source.md"],
        sourceUrls: ["https://example.com/source"],
      }],
      scope,
      observedAt,
    );

    assert.equal(record.version, 2);
    assert.equal(record.vaultScopeId, scope);
    assert.equal(record.verificationState, "unverified");
    assert.equal(record.path, "Agent Research Memory/compaction.md");
    assert.deepEqual(record.sourceLabels.map((item) => item.kind), [
      "note",
      "note",
      "public_url",
    ]);
    assert.match(record.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.equal(isResearchMemoryRecordV2(record, scope), true);
  });

  it("isolates identity and validation by vault scope", () => {
    const firstScope = `vault_${"a".repeat(64)}`;
    const secondScope = `vault_${"b".repeat(64)}`;
    const entry = {
      topic: "Scoped",
      path: "Memory/scoped.md",
      keywords: [],
      lastUpdated: "2026-07-16T00:00:00.000Z",
    };
    const [first] = migrateResearchMemoryIndexV2([entry], firstScope);
    const [second] = migrateResearchMemoryIndexV2([entry], secondScope);
    assert.notEqual(first.id, second.id);
    assert.equal(isResearchMemoryRecordV2(first, secondScope), false);
  });

  it("creates and preserves only opaque vault scope identifiers", () => {
    const generated = ensureVaultScopeId("C:/private/vault");
    assert.match(generated, /^vault_[a-f0-9]{64}$/);
    assert.equal(ensureVaultScopeId(generated), generated);
  });

  it("quarantines legacy verified authority as unverified current-vault memory", () => {
    const scope = `vault_${"c".repeat(64)}`;
    const [record] = migrateResearchMemoryIndexV2(
      [{
        topic: "Legacy authority",
        path: "Agent Research Memory/legacy.md",
        keywords: ["legacy"],
        lastUpdated: "2026-07-15T00:00:00.000Z",
        verificationState: "verified",
        verifiedAt: "2026-07-15T01:00:00.000Z",
      }],
      scope,
      "2026-07-16T12:00:00.000Z",
    );

    assert.equal(record.verificationState, "unverified");
    assert.equal(record.verifiedAt, undefined);
    assert.equal(record.path, "Agent Research Memory/legacy.md");
    assert.equal(isResearchMemoryRecordV2(record, scope), true);
  });

  it("excludes volatile verification timestamps from V2 fingerprints", () => {
    const scope = `vault_${"d".repeat(64)}`;
    const base = {
      version: 2 as const,
      id: `research_memory_${"e".repeat(24)}`,
      vaultScopeId: scope,
      topic: "Stable verification identity",
      path: "Agent Research Memory/stable.md",
      keywords: ["stable"],
      lastUpdated: "2026-07-16T00:00:00.000Z",
      createdAt: "2026-07-16T00:00:00.000Z",
      verificationState: "verified" as const,
    };
    const [first] = migrateResearchMemoryIndexV2(
      [{ ...base, verifiedAt: "2026-07-16T01:00:00.000Z" }],
      scope,
    );
    const [second] = migrateResearchMemoryIndexV2(
      [{ ...base, verifiedAt: "2026-07-16T02:00:00.000Z" }],
      scope,
    );

    assert.equal(first.verificationState, "verified");
    assert.equal(second.verificationState, "verified");
    assert.equal(first.fingerprint, second.fingerprint);
    assert.equal(isResearchMemoryRecordV2(first, scope), true);
    assert.equal(isResearchMemoryRecordV2(second, scope), true);
  });
});
