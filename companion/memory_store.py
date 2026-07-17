from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid
from pathlib import Path

from persisted_data import canonical_fingerprint
from schemas import (
    MemoryClearRequest,
    MemoryDeleteRequest,
    MemoryMutationReceiptV1,
    MemorySearchRequest,
    MemorySearchResult,
    MemoryWriteRequest,
)


LEGACY_UNSCOPED = "legacy_unscoped"


class MemoryStore:
    def __init__(self, db_path: Path):
        self.db_path = db_path
        self.conn: sqlite3.Connection | None = None
        self.ready = False

    def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA secure_delete=ON")
        columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(memories)").fetchall()
        }
        if "vault_path" in columns:
            self.conn.executescript(
                """
                ALTER TABLE memories RENAME TO memories_legacy_vault_paths;
                CREATE TABLE memories (
                  id TEXT PRIMARY KEY,
                  vault_scope_id TEXT NOT NULL,
                  kind TEXT NOT NULL,
                  content TEXT NOT NULL,
                  confidence REAL NOT NULL,
                  tags_json TEXT NOT NULL,
                  source_url TEXT,
                  source_title TEXT,
                  note_receipt_fingerprint TEXT,
                  evidence_json TEXT NOT NULL,
                  task_id TEXT,
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                INSERT INTO memories (
                  id, vault_scope_id, kind, content, confidence, tags_json, source_url, source_title,
                  note_receipt_fingerprint, evidence_json, task_id, created_at, updated_at
                )
                SELECT id, 'legacy_unscoped', kind, content, confidence, tags_json, source_url, source_title,
                       NULL, evidence_json, task_id, created_at, updated_at
                FROM memories_legacy_vault_paths;
                DROP TABLE memories_legacy_vault_paths;
                """
            )
            self.conn.execute("VACUUM")
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS memories (
              id TEXT PRIMARY KEY,
              vault_scope_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              content TEXT NOT NULL,
              confidence REAL NOT NULL,
              tags_json TEXT NOT NULL,
              source_url TEXT,
              source_title TEXT,
              note_receipt_fingerprint TEXT,
              evidence_json TEXT NOT NULL,
              task_id TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
              id UNINDEXED,
              kind UNINDEXED,
              content,
              tags
            );
            """
        )
        columns = {
            row["name"]
            for row in self.conn.execute("PRAGMA table_info(memories)").fetchall()
        }
        if "vault_scope_id" not in columns:
            self.conn.execute(
                "ALTER TABLE memories ADD COLUMN vault_scope_id TEXT NOT NULL DEFAULT 'legacy_unscoped'"
            )
        self.conn.commit()
        self.ready = True

    def close(self) -> None:
        if self.conn:
            self.conn.close()
        self.conn = None
        self.ready = False

    def write(self, request: MemoryWriteRequest) -> str:
        conn = self._conn()
        memory_id = str(uuid.uuid4())
        now = dt.datetime.now(dt.UTC).isoformat()
        tags_json = json.dumps(request.tags)
        evidence_json = json.dumps(
            [reference.model_dump() for reference in request.evidenceRefs]
        )
        conn.execute(
            """
            INSERT INTO memories (
              id, vault_scope_id, kind, content, confidence, tags_json, source_url, source_title,
              note_receipt_fingerprint, evidence_json, task_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memory_id,
                request.vaultScopeId,
                request.kind,
                request.content,
                request.confidence,
                tags_json,
                request.sourceUrl,
                request.sourceTitle,
                request.noteReceiptFingerprint,
                evidence_json,
                request.taskId,
                now,
                now,
            ),
        )
        conn.execute(
            """
            INSERT INTO memory_fts (id, kind, content, tags)
            VALUES (?, ?, ?, ?)
            """,
            (memory_id, request.kind, request.content, " ".join(request.tags)),
        )
        conn.commit()
        return memory_id

    def search(self, request: MemorySearchRequest) -> list[MemorySearchResult]:
        conn = self._conn()
        query = sanitize_fts_query(request.query)
        params: list[object] = [query, request.vaultScopeId]
        where = ["memory_fts MATCH ?", "m.vault_scope_id = ?"]

        if request.kinds:
            placeholders = ",".join("?" for _ in request.kinds)
            where.append(f"m.kind IN ({placeholders})")
            params.extend(request.kinds)

        if request.tags:
            for tag in request.tags:
                where.append("m.tags_json LIKE ?")
                params.append(f'%"{tag}"%')

        sql = f"""
            SELECT
              m.*,
              bm25(memory_fts) AS score
            FROM memory_fts
            JOIN memories m ON m.id = memory_fts.id
            WHERE {" AND ".join(where)}
            ORDER BY score ASC
            LIMIT ?
        """
        params.append(request.limit)
        rows = conn.execute(sql, params).fetchall()

        results: list[MemorySearchResult] = []
        for row in rows:
            score = float(row["score"])
            if request.minScore is not None and score > request.minScore:
                continue
            results.append(
                MemorySearchResult(
                    id=row["id"],
                    vaultScopeId=row["vault_scope_id"],
                    kind=row["kind"],
                    content=row["content"],
                    score=score,
                    confidence=float(row["confidence"]),
                    tags=json.loads(row["tags_json"]),
                    sourceUrl=row["source_url"],
                    sourceTitle=row["source_title"],
                    noteReceiptFingerprint=row["note_receipt_fingerprint"],
                    createdAt=row["created_at"],
                )
            )
        return results

    def delete(self, request: MemoryDeleteRequest) -> MemoryMutationReceiptV1:
        return self._delete_scoped(
            operation="delete",
            vault_scope_id=request.vaultScopeId,
            memory_id=request.memoryId,
            kinds=None,
        )

    def clear(self, request: MemoryClearRequest) -> MemoryMutationReceiptV1:
        return self._delete_scoped(
            operation="clear",
            vault_scope_id=request.vaultScopeId,
            memory_id=None,
            kinds=request.kinds,
        )

    def _delete_scoped(
        self,
        *,
        operation: str,
        vault_scope_id: str,
        memory_id: str | None,
        kinds: list[str] | None,
    ) -> MemoryMutationReceiptV1:
        conn = self._conn()
        where = ["vault_scope_id = ?"]
        params: list[object] = [vault_scope_id]
        if memory_id is not None:
            where.append("id = ?")
            params.append(memory_id)
        if kinds:
            placeholders = ",".join("?" for _ in kinds)
            where.append(f"kind IN ({placeholders})")
            params.extend(kinds)
        rows = conn.execute(
            f"SELECT id FROM memories WHERE {' AND '.join(where)} ORDER BY id",
            params,
        ).fetchall()
        deleted_ids = [str(row["id"]) for row in rows]
        if deleted_ids:
            placeholders = ",".join("?" for _ in deleted_ids)
            conn.execute(f"DELETE FROM memory_fts WHERE id IN ({placeholders})", deleted_ids)
            conn.execute(f"DELETE FROM memories WHERE id IN ({placeholders})", deleted_ids)
            conn.commit()
        observed_at = dt.datetime.now(dt.UTC).isoformat()
        fingerprint = canonical_fingerprint(
            {
                "version": 1,
                "operation": operation,
                "vaultScopeId": vault_scope_id,
                "deletedCount": len(deleted_ids),
                "deletedIds": deleted_ids,
            }
        )
        return MemoryMutationReceiptV1(
            operation=operation,
            vaultScopeId=vault_scope_id,
            deletedCount=len(deleted_ids),
            deletedIds=deleted_ids,
            observedAt=observed_at,
            fingerprint=fingerprint,
        )

    def _conn(self) -> sqlite3.Connection:
        if not self.conn:
            raise RuntimeError("Memory store is not initialized.")
        return self.conn


def sanitize_fts_query(query: str) -> str:
    tokens = [token.replace('"', "").strip() for token in query.split() if token.strip()]
    return " OR ".join(tokens[:12]) if tokens else '""'
