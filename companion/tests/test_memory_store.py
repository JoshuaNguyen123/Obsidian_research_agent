from __future__ import annotations

import sys
import sqlite3
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_store import MemoryStore
from schemas import MemoryClearRequest, MemoryDeleteRequest, MemorySearchRequest, MemoryWriteRequest


VAULT_A = "vault_" + "a" * 64
VAULT_B = "vault_" + "b" * 64


def test_memory_write_and_search(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")
    store.initialize()
    try:
        memory_id = store.write(
            MemoryWriteRequest(
                vaultScopeId=VAULT_A,
                kind="episodic",
                content="User asked for a Civil War lecture artifact.",
                confidence=0.9,
                tags=["lecture", "history"],
            )
        )
        assert memory_id
        results = store.search(MemorySearchRequest(vaultScopeId=VAULT_A, query="Civil War lecture", limit=5))
        assert len(results) == 1
        assert results[0].kind == "episodic"
        assert results[0].tags == ["lecture", "history"]
        assert results[0].vaultScopeId == VAULT_A
        assert store.search(MemorySearchRequest(vaultScopeId=VAULT_B, query="Civil War lecture")) == []
    finally:
        store.close()


def test_legacy_vault_path_metadata_is_securely_removed_during_migration(tmp_path):
    database = tmp_path / "memory.sqlite3"
    conn = sqlite3.connect(database)
    conn.executescript(
        """
        CREATE TABLE memories (
          id TEXT PRIMARY KEY, kind TEXT NOT NULL, content TEXT NOT NULL,
          confidence REAL NOT NULL, tags_json TEXT NOT NULL, source_url TEXT,
          source_title TEXT, vault_path TEXT, evidence_json TEXT NOT NULL,
          task_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        INSERT INTO memories VALUES (
          'legacy', 'episodic', 'safe content', 1.0, '[]', NULL, NULL,
          'Private/Vault/Secrets.md', '[]', NULL,
          '2026-07-12T00:00:00+00:00', '2026-07-12T00:00:00+00:00'
        );
        """
    )
    conn.commit()
    conn.close()

    store = MemoryStore(database)
    store.initialize()
    try:
        columns = {
            row["name"]
            for row in store.conn.execute("PRAGMA table_info(memories)").fetchall()
        }
        assert "vault_path" not in columns
        assert "note_receipt_fingerprint" in columns
        assert "vault_scope_id" in columns
        assert store.conn.execute(
            "SELECT note_receipt_fingerprint FROM memories WHERE id = 'legacy'"
        ).fetchone()[0] is None
        assert store.conn.execute(
            "SELECT vault_scope_id FROM memories WHERE id = 'legacy'"
        ).fetchone()[0] == "legacy_unscoped"
        assert store.search(MemorySearchRequest(vaultScopeId=VAULT_A, query="safe content")) == []
    finally:
        store.close()
    assert b"Private/Vault/Secrets.md" not in database.read_bytes()


def test_memory_delete_and_clear_are_scoped_and_return_receipts(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")
    store.initialize()
    try:
        first = store.write(MemoryWriteRequest(
            vaultScopeId=VAULT_A, kind="episodic", content="scoped alpha", confidence=1
        ))
        second = store.write(MemoryWriteRequest(
            vaultScopeId=VAULT_A, kind="procedural", content="scoped beta", confidence=1
        ))
        other = store.write(MemoryWriteRequest(
            vaultScopeId=VAULT_B, kind="episodic", content="scoped gamma", confidence=1
        ))

        wrong_scope = store.delete(MemoryDeleteRequest(vaultScopeId=VAULT_B, memoryId=first))
        assert wrong_scope.deletedCount == 0
        deleted = store.delete(MemoryDeleteRequest(vaultScopeId=VAULT_A, memoryId=first))
        assert deleted.deletedIds == [first]
        assert deleted.fingerprint.startswith("sha256:")
        cleared = store.clear(MemoryClearRequest(vaultScopeId=VAULT_A, kinds=["procedural"]))
        assert cleared.deletedIds == [second]
        assert store.search(MemorySearchRequest(vaultScopeId=VAULT_B, query="scoped gamma"))[0].id == other
    finally:
        store.close()
