from __future__ import annotations

import datetime as dt
import pytest
from pydantic import ValidationError

from coordinator_store import (
    CoordinatorStore,
    CoordinatorStoreError,
    build_completion_fingerprint,
    build_receipt_fingerprint,
    IdempotencyConflict,
    JobLeaseConflict,
    JobLeaseInvalid,
)
from schemas import JobCreateRequest, ReceiptAppendRequest
from conftest import valid_job_body


def job_request(**overrides) -> JobCreateRequest:
    values = valid_job_body()
    values.update(overrides)
    return JobCreateRequest(**values)


def receipt_fingerprint(job, provider, operation, status, payload):
    return build_receipt_fingerprint(
        job={
            "id": job.id,
            "missionId": job.missionId,
            "nodeId": job.nodeId,
            "idempotencyKey": job.idempotencyKey,
            "capabilityEnvelopeFingerprint": job.capabilityEnvelope["fingerprint"],
            "authorizationFingerprint": job.capabilityEnvelope["authorizationFingerprint"],
        },
        provider=provider,
        operation=operation,
        status=status,
        payload=payload,
    )


def job_binding(job):
    return {
        "id": job.id,
        "missionId": job.missionId,
        "nodeId": job.nodeId,
        "idempotencyKey": job.idempotencyKey,
        "capabilityEnvelopeFingerprint": job.capabilityEnvelope["fingerprint"],
        "authorizationFingerprint": job.capabilityEnvelope["authorizationFingerprint"],
    }


def test_job_lease_is_single_owner_and_events_and_receipts_are_replayable(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3")
    store.initialize()
    try:
        created = store.create_job(job_request())
        duplicate = store.create_job(job_request())
        assert duplicate.id == created.id
        with pytest.raises(IdempotencyConflict):
            different = valid_job_body(inputs={"query": "different"})
            store.create_job(JobCreateRequest(**different))

        claimed, token = store.claim_job(created.id, "worker-a", 60)
        assert claimed.state == "running"
        assert claimed.attempts == 1
        with pytest.raises(JobLeaseConflict):
            store.claim_job(created.id, "worker-b", 60)
        with pytest.raises(JobLeaseConflict):
            store.claim_job(created.id, "worker-a", 60)
        with pytest.raises(JobLeaseInvalid):
            store.heartbeat_job(created.id, "worker-a", "wrong-token", 60)

        event = store.append_event(
            created.id, "worker-a", token, "progress", {"percent": 25}
        )
        assert event.sequence >= 3
        receipt_payload = {"sourceCount": 2}
        fingerprint = receipt_fingerprint(
            created, "research", "fetch", "verified", receipt_payload
        )
        receipt = store.append_receipt(
            created.id,
            ReceiptAppendRequest(
                coordinatorId="worker-a",
                leaseToken=token,
                provider="research",
                operation="fetch",
                status="verified",
                fingerprint=fingerprint,
                payload=receipt_payload,
            ),
        )
        assert receipt.status == "verified"
        assert store.list_receipts(created.id) == [receipt]
        assert [item.type for item in store.replay_events(created.id)] == [
            "job_queued",
            "lease_acquired",
            "progress",
            "external_receipt_recorded",
        ]

        result = {"status": "complete", "outputs": {"answer": "verified"}}
        result["resultFingerprint"] = build_completion_fingerprint(
            job=job_binding(created), result=result
        )
        complete = store.complete_job(
            created.id,
            "worker-a",
            token,
            "complete",
            result,
        )
        assert complete.state == "complete"
        assert complete.output["resultFingerprint"].startswith("sha256:")
        with pytest.raises(JobLeaseConflict):
            store.claim_job(created.id, "worker-b", 60)
    finally:
        store.close()


def test_job_and_active_lease_survive_restart_without_duplicate_owner(tmp_path):
    database = tmp_path / "coordinator.sqlite3"
    first = CoordinatorStore(database)
    first.initialize()
    created = first.create_job(job_request())
    first.claim_job(created.id, "worker-a", 60)
    first.close()

    second = CoordinatorStore(database)
    second.initialize()
    try:
        restored = second.get_job(created.id)
        assert restored.ownerCoordinatorId == "worker-a"
        assert restored.state == "running"
        with pytest.raises(JobLeaseConflict):
            second.claim_job(created.id, "worker-b", 60)
        assert second.status_counts() == {
            "queuedJobs": 0,
            "leasedJobs": 1,
            "eventCount": 2,
            "receiptCount": 0,
        }
    finally:
        second.close()


def test_expired_lease_can_be_reclaimed_by_exactly_one_new_owner(tmp_path):
    database = tmp_path / "coordinator.sqlite3"
    store = CoordinatorStore(database)
    store.initialize()
    try:
        created = store.create_job(job_request())
        store.claim_job(created.id, "worker-a", 60)
        store.conn.execute(
            "UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (created.id,)
        )
        reclaimed, _token = store.claim_job(created.id, "worker-b", 60)
        assert reclaimed.ownerCoordinatorId == "worker-b"
        assert reclaimed.attempts == 2
        with pytest.raises(JobLeaseConflict):
            store.claim_job(created.id, "worker-c", 60)
    finally:
        store.close()


def test_companion_job_schema_rejects_vault_paths_and_content():
    with pytest.raises(ValidationError, match="not allowed|path"):
        JobCreateRequest(**valid_job_body(inputs={"vaultPath": "Notes/private.md"}))
    with pytest.raises(ValidationError, match="path"):
        JobCreateRequest(**valid_job_body(inputs={"query": "src/private.ts"}))
    with pytest.raises(ValidationError, match="credential"):
        JobCreateRequest(**valid_job_body(inputs={"query": {"githubToken": "plain"}}))
    with pytest.raises(ValidationError, match="command"):
        JobCreateRequest(**valid_job_body(inputs={"query": {"command": "npm test"}}))
    accepted = JobCreateRequest(
        **valid_job_body(inputs={"secretRef": "secret_opaque123"})
    )
    assert accepted.payload.inputs == {"secretRef": "secret_opaque123"}


def test_arbitrary_receipt_fingerprint_and_duplicate_event_fail_closed(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3")
    store.initialize()
    try:
        job = store.create_job(job_request())
        _leased, token = store.claim_job(job.id, "worker-a", 60)
        payload = {"sourceCount": 1}
        with pytest.raises(CoordinatorStoreError, match="fingerprint"):
            store.append_receipt(
                job.id,
                ReceiptAppendRequest(
                    coordinatorId="worker-a",
                    leaseToken=token,
                    provider="research",
                    operation="fetch",
                    status="verified",
                    fingerprint="sha256:" + "f" * 64,
                    payload=payload,
                ),
            )
        fingerprint = receipt_fingerprint(
            job, "research", "fetch", "verified", payload
        )
        request = ReceiptAppendRequest(
            coordinatorId="worker-a",
            leaseToken=token,
            provider="research",
            operation="fetch",
            status="verified",
            fingerprint=fingerprint,
            payload=payload,
        )
        first = store.append_receipt(job.id, request)
        before = len(store.replay_events(job.id))
        second = store.append_receipt(job.id, request)
        assert second.id == first.id
        assert len(store.replay_events(job.id)) == before
    finally:
        store.close()


def test_sqlite_job_ledger_contains_no_lease_token_plaintext(tmp_path):
    database = tmp_path / "coordinator.sqlite3"
    store = CoordinatorStore(database)
    store.initialize()
    try:
        created = store.create_job(job_request())
        _job, token = store.claim_job(created.id, "worker-a", 60)
        raw = database.read_bytes()
        assert token.encode() not in raw
        stored = store.conn.execute(
            "SELECT lease_token_hash FROM jobs WHERE id = ?", (created.id,)
        ).fetchone()[0]
        assert len(stored) == 64
    finally:
        store.close()


def test_worker_readiness_requires_fresh_matching_single_coordinator_heartbeat(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3")
    store.initialize()
    expected = "sha256:" + "c" * 64
    try:
        assert store.worker_status(expected)["workerReady"] is False
        with pytest.raises(CoordinatorStoreError, match="catalog"):
            store.record_worker_heartbeat(
                "worker-a",
                "sha256:" + "d" * 64,
                dt.datetime.now(dt.UTC).isoformat(),
                expected,
            )
        recorded = store.record_worker_heartbeat(
            "worker-a",
            expected,
            dt.datetime.now(dt.UTC).isoformat(),
            expected,
        )
        assert recorded["workerReady"] is True
        assert store.worker_status(expected)["workerReady"] is True
        with pytest.raises(JobLeaseConflict):
            store.record_worker_heartbeat(
                "worker-b",
                expected,
                dt.datetime.now(dt.UTC).isoformat(),
                expected,
            )
        store.conn.execute("UPDATE worker_heartbeat SET received_at = 0")
        assert store.worker_status(expected)["workerDiagnostic"] == "worker_heartbeat_expired"
    finally:
        store.close()


def test_public_research_worker_receipt_event_and_completion_contract_round_trip(tmp_path):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3")
    store.initialize()
    try:
        job = store.create_job(job_request())
        _leased, token = store.claim_job(job.id, "worker-a", 60)
        store.append_event(
            job.id,
            "worker-a",
            token,
            "job_progress",
            {"message": "Fetching authorized public source 1/2."},
        )
        receipt_payload = {
            "evidenceFingerprint": "sha256:" + "e" * 64,
            "sourceCount": 1,
            "sourceUrls": ["https://example.com/source"],
        }
        fingerprint = receipt_fingerprint(
            job,
            "research",
            "public_research_fetch",
            "verified",
            receipt_payload,
        )
        receipt = store.append_receipt(
            job.id,
            ReceiptAppendRequest(
                coordinatorId="worker-a",
                leaseToken=token,
                provider="research",
                operation="public_research_fetch",
                status="verified",
                fingerprint=fingerprint,
                payload=receipt_payload,
            ),
        )
        result = {
            "status": "complete",
            "outputs": {
                "summary": "Source: https://example.com/source\nPublic text.",
                "sourceCount": 1,
                "evidenceFingerprint": "sha256:" + "e" * 64,
            },
            "evidence": [
                {
                    "kind": "public_web_source",
                    "url": "https://example.com/source",
                    "fingerprint": "sha256:" + "f" * 64,
                }
            ],
            "receiptIds": [receipt.id],
            "blocker": None,
        }
        result["resultFingerprint"] = build_completion_fingerprint(
            job=job_binding(job), result=result
        )
        completed = store.complete_job(
            job.id, "worker-a", token, "complete", result
        )
        assert completed.output == result
    finally:
        store.close()
