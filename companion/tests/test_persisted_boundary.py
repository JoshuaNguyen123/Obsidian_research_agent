from __future__ import annotations

import pytest
from pydantic import ValidationError

from coordinator_store import CoordinatorStore
from persisted_data import PersistedDataRejected, sanitize_completion_output
from schemas import EventAppendRequest, JobCreateRequest, ReceiptAppendRequest

from conftest import valid_job_body


@pytest.mark.parametrize(
    "payload",
    [
        {"githubToken": "plain"},
        {"nested": {"api_key": "plain"}},
        {"path": "C:\\Users\\me\\vault\\Secret.md"},
        {"command": "npm test"},
    ],
)
def test_event_persistence_has_one_closed_redaction_boundary(payload):
    with pytest.raises((ValidationError, PersistedDataRejected)):
        EventAppendRequest(
            coordinatorId="worker-a",
            leaseToken="lease-value",
            type="job_progress",
            payload=payload,
        )


def test_output_and_blocker_allowlist_rejects_credentials_paths_and_commands():
    with pytest.raises(PersistedDataRejected, match="credential"):
        sanitize_completion_output(
            "github", {"outputs": {"githubToken": "plain"}}
        )
    with pytest.raises(PersistedDataRejected, match="path"):
        sanitize_completion_output(
            "code", {"blocker": {"code": "failed", "message": "src/private.ts"}}
        )
    with pytest.raises(PersistedDataRejected, match="command"):
        sanitize_completion_output(
            "code", {"blocker": {"code": "failed", "requiredAction": "npm test"}}
        )


def test_closed_domain_job_rejects_ambiguous_target_and_accepts_logical_binding():
    with pytest.raises(ValidationError, match="not allowed"):
        JobCreateRequest(**valid_job_body(inputs={"target": "src/index.ts"}))

    body = valid_job_body(domain="code", inputs={"repositoryBindingId": "repo-main"})
    body["payload"]["bindings"] = [
        {
            "id": "repo-main",
            "kind": "repository",
            "destinationFingerprint": "sha256:" + "d" * 64,
        }
    ]
    body["payload"]["inputs"] = {
        "repositoryBinding": {"bindingId": "repo-main", "selector": None}
    }
    body["payload"]["allowedTools"] = ["code.read"]
    body["payload"]["requiredCapabilities"] = ["code.read"]
    parsed = JobCreateRequest(**body)
    assert parsed.payload.bindings[0].id == "repo-main"


def test_completion_store_rejects_secret_before_sqlite_write(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3")
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**valid_job_body()))
        _leased, token = store.claim_job(job.id, "worker-a", 60)
        with pytest.raises(PersistedDataRejected):
            store.complete_job(
                job.id,
                "worker-a",
                token,
                "complete",
                {"outputs": {"githubToken": "must-not-persist"}},
            )
        assert b"must-not-persist" not in (tmp_path / "coordinator.sqlite3").read_bytes()
    finally:
        store.close()
