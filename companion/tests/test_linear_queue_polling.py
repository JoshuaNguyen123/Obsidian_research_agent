from __future__ import annotations

import datetime as dt
import json

import pytest
from pydantic import ValidationError

import coordinator_store as coordinator_store_module
from coordinator_store import CoordinatorStore, CoordinatorStoreError, JobLeaseConflict
from persisted_data import canonical_fingerprint
from schemas import (
    LinearQueueCandidateObservationV1,
    LinearQueueConfigurationV1,
    LinearQueueCursorV1,
    LinearQueueRescanRequestV1,
    LinearQueueScanClaimRequest,
    LinearQueueScanCompleteRequest,
)


CATALOG_FINGERPRINT = "sha256:" + "c" * 64
WORKER_ID = "worker-linear-queue"


def queue_configuration(now: dt.datetime) -> LinearQueueConfigurationV1:
    authorized_at = now - dt.timedelta(minutes=1)
    authority = {
        "version": 1,
        "grantId": "linear-queue-grant-test",
        "fingerprint": "sha256:" + "a" * 64,
        "authorizedAt": authorized_at.isoformat(),
        "expiresAt": (authorized_at + dt.timedelta(hours=4)).isoformat(),
    }
    body = {
        "version": 1,
        "workspaceId": "workspace-linear-test",
        "queueProjectId": "project-linear-test",
        "credentialReferenceId": "secret_linearqueue123",
        "authoritySubjectId": "linear-queue-project:project-linear-test",
        "authority": authority,
        "queueBindingFingerprint": canonical_fingerprint(
            {
                "version": 1,
                "system": "linear",
                "workspaceId": "workspace-linear-test",
                "queueProjectId": "project-linear-test",
            }
        ),
    }
    body["configurationFingerprint"] = canonical_fingerprint(body)
    return LinearQueueConfigurationV1.model_validate(body)


def candidate(now: dt.datetime, **overrides) -> LinearQueueCandidateObservationV1:
    body = {
        "issueId": "issue-linear-test",
        "identifier": "LIN-123",
        "queueProjectId": "project-linear-test",
        "remoteStateId": "state-triage",
        "remoteUpdatedAt": now.isoformat(),
        "workItemFingerprint": "sha256:" + "b" * 64,
        "readbackFingerprint": "sha256:" + "d" * 64,
    }
    body.update(overrides)
    body["candidateFingerprint"] = canonical_fingerprint(body)
    return LinearQueueCandidateObservationV1.model_validate(body)


def heartbeat(store: CoordinatorStore, now: dt.datetime) -> None:
    store.record_worker_heartbeat(
        WORKER_ID,
        CATALOG_FINGERPRINT,
        now.isoformat(),
        CATALOG_FINGERPRINT,
    )


def claim(store: CoordinatorStore, now: dt.datetime):
    heartbeat(store, now)
    result = store.claim_linear_queue_scan(
        LinearQueueScanClaimRequest(
            coordinatorId=WORKER_ID,
            catalogFingerprint=CATALOG_FINGERPRINT,
            claimedAt=now.isoformat(),
        ),
        CATALOG_FINGERPRINT,
    )
    assert result.claimed is True
    assert result.scanToken
    return result


def complete(
    store: CoordinatorStore,
    configuration: LinearQueueConfigurationV1,
    scan,
    now: dt.datetime,
    observations: list[LinearQueueCandidateObservationV1],
):
    return store.complete_linear_queue_scan(
        LinearQueueScanCompleteRequest(
            coordinatorId=WORKER_ID,
            scanId=scan.scanId,
            scanToken=scan.scanToken,
            configurationFingerprint=configuration.configurationFingerprint,
            scannedAt=now.isoformat(),
            candidates=observations,
            cursor=LinearQueueCursorV1(
                updatedAt=now.isoformat(), issueId="issue-linear-test"
            ),
        )
    )


def test_queue_scan_schedules_only_fingerprint_bound_readback_and_dedupes_restart(
    tmp_path,
):
    database = tmp_path / "coordinator.sqlite3"
    now = dt.datetime.now(dt.UTC)
    configuration = queue_configuration(now)
    observation = candidate(now)

    first = CoordinatorStore(database, integrity_key="i" * 43)
    first.initialize()
    try:
        configured = first.configure_linear_queue(configuration)
        assert configured.enabled is True
        first_scan = claim(first, now)
        completed = complete(first, configuration, first_scan, now, [observation])
        assert completed.candidateCount == 1
        assert completed.scheduledReadbackCount == 1

        jobs = first.list_jobs(limit=20)
        assert len(jobs) == 1
        job = jobs[0]
        assert job.executionHost == "linear"
        assert job.payload["allowedTools"] == ["linear_get_issue"]
        assert job.payload["requiredCapabilities"] == ["linear.issue.read"]
        assert job.payload["inputs"] == {
            "issueId": observation.issueId,
            "credentialReferenceId": configuration.credentialReferenceId,
            "projectBindingId": configuration.queueProjectId,
            "contractFingerprint": observation.workItemFingerprint,
            "queueCandidateFingerprint": observation.candidateFingerprint,
        }
        serialized = json.dumps(job.model_dump(), sort_keys=True)
        assert "UNTRUSTED ISSUE BODY" not in serialized
        assert '"path"' not in serialized.lower()
        assert '"command"' not in serialized.lower()
        scheduled = [
            event
            for event in first.replay_linear_queue_events()
            if event.type == "linear_queue_candidate_scheduled"
        ]
        assert len(scheduled) == 1
        assert scheduled[0].payload["candidateFingerprint"] == observation.candidateFingerprint
        assert scheduled[0].payload["jobId"] == job.id
    finally:
        first.close()

    second = CoordinatorStore(database, integrity_key="i" * 43)
    second.initialize()
    try:
        # Simulate the next 15-minute due edge without changing the persisted
        # configuration or candidate identity.
        second.conn.execute(
            "UPDATE linear_queue_configuration SET next_scan_at = 0 WHERE singleton = 1"
        )
        second_scan = claim(second, now)
        completed = complete(second, configuration, second_scan, now, [observation])
        assert completed.candidateCount == 1
        assert completed.scheduledReadbackCount == 1
        assert len(second.list_jobs(limit=20)) == 1
        assert len(
            [
                event
                for event in second.replay_linear_queue_events()
                if event.type == "linear_queue_candidate_scheduled"
            ]
        ) == 1
        requested = second.request_linear_queue_rescan(
            LinearQueueRescanRequestV1(
                configurationFingerprint=configuration.configurationFingerprint,
                requestedAt=now.isoformat(),
                reason="terminal_readback",
            )
        )
        assert dt.datetime.fromisoformat(requested.nextScanAt) < dt.datetime.fromisoformat(
            completed.nextScanAt
        )
        assert (
            dt.datetime.now(dt.UTC)
            - dt.datetime.fromisoformat(requested.nextScanAt)
        ) < dt.timedelta(seconds=2)
        assert second.replay_linear_queue_events()[-1].type == (
            "linear_queue_rescan_requested"
        )
    finally:
        second.close()


def test_wrong_project_and_raw_issue_fields_fail_before_persistence(tmp_path):
    now = dt.datetime.now(dt.UTC)
    configuration = queue_configuration(now)
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        store.configure_linear_queue(configuration)
        scan = claim(store, now)
        wrong_project = candidate(now, queueProjectId="project-other")
        with pytest.raises(CoordinatorStoreError, match="another project"):
            complete(store, configuration, scan, now, [wrong_project])
        assert store.list_jobs(limit=20) == []
        assert store.linear_queue_status().candidateCount == 0
    finally:
        store.close()

    raw_candidate = candidate(now).model_dump()
    raw_candidate["description"] = "UNTRUSTED ISSUE BODY"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        LinearQueueCandidateObservationV1.model_validate(raw_candidate)


def test_expired_queue_authority_cannot_claim_scan_or_readback_job(
    tmp_path, monkeypatch
):
    now = dt.datetime.now(dt.UTC)
    configuration = queue_configuration(now)
    observation = candidate(now)
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        store.configure_linear_queue(configuration)
        scan = claim(store, now)
        complete(store, configuration, scan, now, [observation])
        readback_job = store.list_jobs(limit=20)[0]

        expired = dt.datetime.fromisoformat(configuration.authority.expiresAt) + dt.timedelta(
            seconds=1
        )
        monkeypatch.setattr(
            coordinator_store_module, "_now_epoch", lambda: expired.timestamp()
        )
        with pytest.raises(JobLeaseConflict, match="authorization expired"):
            store.claim_job(readback_job.id, WORKER_ID, 60)
        assert store.get_job(readback_job.id).state == "blocked"

        store.conn.execute(
            "UPDATE linear_queue_configuration SET next_scan_at = 0 WHERE singleton = 1"
        )
        store.conn.execute(
            "UPDATE worker_heartbeat SET received_at = ? WHERE singleton = 1",
            (expired.timestamp(),),
        )
        scan_result = store.claim_linear_queue_scan(
            LinearQueueScanClaimRequest(
                coordinatorId=WORKER_ID,
                catalogFingerprint=CATALOG_FINGERPRINT,
                claimedAt=expired.isoformat(),
            ),
            CATALOG_FINGERPRINT,
        )
        assert scan_result.claimed is False
        assert scan_result.reason == "authority_expired"
    finally:
        store.close()
