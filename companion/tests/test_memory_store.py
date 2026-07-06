from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from memory_store import MemoryStore
from schemas import MemorySearchRequest, MemoryWriteRequest


def test_memory_write_and_search(tmp_path):
    store = MemoryStore(tmp_path / "memory.sqlite3")
    store.initialize()
    try:
        memory_id = store.write(
            MemoryWriteRequest(
                kind="episodic",
                content="User asked for a Civil War lecture artifact.",
                confidence=0.9,
                tags=["lecture", "history"],
            )
        )
        assert memory_id
        results = store.search(MemorySearchRequest(query="Civil War lecture", limit=5))
        assert len(results) == 1
        assert results[0].kind == "episodic"
        assert results[0].tags == ["lecture", "history"]
    finally:
        store.close()
