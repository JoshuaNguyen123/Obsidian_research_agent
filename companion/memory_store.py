from __future__ import annotations

import datetime as dt
import json
import sqlite3
import uuid
from pathlib import Path

from schemas import MemorySearchRequest, MemorySearchResult, MemoryWriteRequest


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
                  id, kind, content, confidence, tags_json, source_url, source_title,
                  note_receipt_fingerprint, evidence_json, task_id, created_at, updated_at
                )
                SELECT id, kind, content, confidence, tags_json, source_url, source_title,
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
              id, kind, content, confidence, tags_json, source_url, source_title,
              note_receipt_fingerprint, evidence_json, task_id, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                memory_id,
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
        params: list[object] = [query]
        where = ["memory_fts MATCH ?"]

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

    def _conn(self) -> sqlite3.Connection:
        if not self.conn:
            raise RuntimeError("Memory store is not initialized.")
        return self.conn


def sanitize_fts_query(query: str) -> str:
    tokens = [token.replace('"', "").strip() for token in query.split() if token.strip()]
    return " OR ".join(tokens[:12]) if tokens else '""'
