from __future__ import annotations

import pytest
from pydantic import ValidationError

from conftest import valid_job_body
from coordinator_store import (
    CoordinatorStore,
    build_completion_fingerprint,
)
from persisted_data import sanitize_completion_output
from schemas import JobCreateRequest


def test_linear_completion_allows_concise_summary_for_chat_resume(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        body = valid_job_body(
            domain="linear",
            inputs={"issueId": "issue-42"},
        )
        body["payload"]["allowedTools"] = ["linear_get_issue"]
        body["payload"]["requiredCapabilities"] = ["linear.issue.read"]
        job = store.create_job(JobCreateRequest(**body))
        _leased, token = store.claim_job(job.id, "worker-a", 60)
        result = {
            "status": "complete",
            "outputs": {
                "issueId": "issue-42",
                "state": "state-done",
                "summary": "Linear issue state update verified by independent readback.",
            },
            "evidence": [],
            "receiptIds": [],
            "blocker": None,
        }
        result["resultFingerprint"] = build_completion_fingerprint(
            job={
                "id": job.id,
                "missionId": job.missionId,
                "nodeId": job.nodeId,
                "idempotencyKey": job.idempotencyKey,
                "capabilityEnvelopeFingerprint": job.capabilityEnvelope[
                    "fingerprint"
                ],
                "authorizationFingerprint": job.capabilityEnvelope[
                    "authorizationFingerprint"
                ],
            },
            result=result,
        )
        completed = store.complete_job(
            job.id,
            "worker-a",
            token,
            "complete",
            result,
        )
        assert completed.state == "complete"
        assert (
            completed.output["outputs"]["summary"]
            == "Linear issue state update verified by independent readback."
        )
    finally:
        store.close()


def test_vault_shaped_inputs_cannot_enter_companion_jobs():
    with pytest.raises((ValidationError, ValueError)):
        JobCreateRequest(
            **valid_job_body(inputs={"notePath": "Secrets.md", "query": "q"})
        )


def test_sanitize_keeps_short_domain_summary_for_host_chat_resume():
    sanitized = sanitize_completion_output(
        "github",
        {
            "status": "complete",
            "outputs": {
                "prNumber": 17,
                "prUrl": "https://github.com/acme/demo/pull/17",
                "summary": "Draft PR verified by independent readback.",
            },
            "evidence": [],
            "receiptIds": [],
            "blocker": None,
            "resultFingerprint": "sha256:" + "a" * 64,
        },
    )
    assert sanitized["outputs"]["summary"] == "Draft PR verified by independent readback."
    assert sanitized["outputs"]["prNumber"] == 17
