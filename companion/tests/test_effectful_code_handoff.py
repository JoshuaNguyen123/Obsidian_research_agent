from __future__ import annotations

import copy
import datetime as dt

import pytest
from pydantic import ValidationError

import coordinator_store as coordinator_store_module
from conftest import fp
from coordinator_store import CoordinatorStore, build_receipt_fingerprint
from persisted_data import canonical_fingerprint
from schemas import JobCreateRequest, ReceiptAppendRequest


def effectful_code_job_body() -> dict:
    now = dt.datetime.now(dt.UTC)
    consumed_at = now - dt.timedelta(minutes=2)
    prepared_at = now - dt.timedelta(minutes=1)
    expires_at = now + dt.timedelta(minutes=30)
    grant_expires_at = now + dt.timedelta(hours=1)
    mission_id = "mission-code-effectful-1"
    node_id = "node-code-commit-1"
    graph_revision = 7
    authorization_fingerprint = fp("a")
    envelope_fingerprint = fp("b")
    action_fingerprint = fp("c")
    binding = {
        "id": "workspace-code-1",
        "kind": "repository-workspace",
        "destinationFingerprint": fp("d"),
    }
    action_evidence = {
        "version": 1,
        "kind": "prepared_background_code_action",
        "operation": "prepared_code_validation_commit_v1",
        "status": "prepared",
        "id": "prepared-code-background-1",
        "missionId": mission_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "nodeId": node_id,
        "nodeFingerprint": fp("e"),
        "executionHost": "headless_runtime",
        "toolName": "code_validate_commit_prepared",
        "descriptorFingerprint": fp("f"),
        "preparedActionId": "prepared-code-action-1",
        "preparedActionFingerprint": action_fingerprint,
        "binding": {
            "workspaceId": binding["id"],
            "repositoryProfileKey": "profile-code-1",
            "destinationFingerprint": binding["destinationFingerprint"],
        },
        "authority": {
            "id": "grant-code-effectful-1",
            "authorityFingerprint": authorization_fingerprint,
            "actionFingerprint": action_fingerprint,
            "consumedAt": consumed_at.isoformat(),
            "expiresAt": grant_expires_at.isoformat(),
        },
        "payload": {
            "repairCheckpointId": "code-repair:run-code-1:workspace-code-1",
            "repairRequestFingerprint": fp("1"),
            "preparedCheckpointSequence": 4,
            "workspaceBindingFingerprint": fp("2"),
            "repositoryProfileFingerprint": fp("3"),
            "sandboxCapabilityFingerprint": fp("4"),
        },
        "idempotencyKey": fp("5"),
        "reconciliationKey": fp("5"),
        "preparedAt": prepared_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }
    action = {**action_evidence, "fingerprint": canonical_fingerprint(action_evidence)}
    package_evidence = {
        "version": 1,
        "kind": "prepared_background_code_package_identity",
        "packageId": "background-code-package-1",
        "packageFingerprint": fp("6"),
        "executionPlanFingerprint": fp("7"),
        "handoffFingerprint": action["fingerprint"],
        "workspaceId": binding["id"],
        "workspaceBindingFingerprint": action["payload"]["workspaceBindingFingerprint"],
        "repositoryProfileKey": action["binding"]["repositoryProfileKey"],
        "repositoryProfileFingerprint": action["payload"]["repositoryProfileFingerprint"],
        "consumedActionAuthorityFingerprint": action["authority"]["authorityFingerprint"],
        "backgroundAuthorizationFingerprint": authorization_fingerprint,
        "preparedAt": prepared_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }
    package = {**package_evidence, "fingerprint": canonical_fingerprint(package_evidence)}
    identity = {
        "version": 1,
        "missionId": mission_id,
        "nodeId": node_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "authorizationFingerprint": authorization_fingerprint,
        "preparedBackgroundCodeActionFingerprint": action["fingerprint"],
    }
    key = canonical_fingerprint(identity)
    return {
        "id": f"companion-{key.removeprefix('sha256:')[:32]}",
        "missionId": mission_id,
        "nodeId": node_id,
        "executionHost": "code",
        "payload": {
            "version": 1,
            "graphRevision": graph_revision,
            "executionHost": "headless_runtime",
            "objective": "Validate and commit one exact host-prepared change.",
            "inputs": {},
            "allowedTools": ["code_validate_commit_prepared"],
            "requiredCapabilities": ["code.sandbox.execute", "code.commit.local"],
            "bindings": [binding],
            "authorization": {
                "version": 1,
                "grantId": "grant-code-effectful-1",
                "fingerprint": authorization_fingerprint,
                "authorizedAt": consumed_at.isoformat(),
                "expiresAt": grant_expires_at.isoformat(),
            },
            "preparedExternalActionHandoff": None,
            "preparedBackgroundCodeAction": action,
            "preparedBackgroundCodePackage": package,
            "createdAt": prepared_at.isoformat(),
            "updatedAt": prepared_at.isoformat(),
        },
        "capabilityEnvelope": {
            "fingerprint": envelope_fingerprint,
            "authorizationFingerprint": authorization_fingerprint,
        },
        "idempotencyKey": key,
    }


def code_attempt_id(job) -> str:
    handoff = job.payload["preparedBackgroundCodeAction"]
    return canonical_fingerprint({
        "version": 1,
        "jobId": job.id,
        "handoffFingerprint": handoff["fingerprint"],
        "repairCheckpointId": handoff["payload"]["repairCheckpointId"],
        "reconciliationKey": handoff["reconciliationKey"],
    })


def test_code_action_and_package_roundtrip_are_closed_and_remote_safe():
    body = effectful_code_job_body()
    parsed = JobCreateRequest(**body)
    assert parsed.payload.preparedBackgroundCodeAction is not None
    assert parsed.payload.preparedBackgroundCodePackage is not None
    serialized = parsed.model_dump(mode="json")
    assert "repositoryRoot" not in str(serialized)
    assert "command" not in str(serialized)
    assert "credential" not in str(serialized).lower()

    widened = copy.deepcopy(body)
    widened["payload"]["preparedBackgroundCodePackage"]["repositoryRoot"] = "C:\\repo"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        JobCreateRequest(**widened)

    mixed = copy.deepcopy(body)
    mixed["payload"]["preparedExternalActionHandoff"] = {}
    with pytest.raises(ValidationError):
        JobCreateRequest(**mixed)

    drifted = copy.deepcopy(body)
    drifted["payload"]["preparedBackgroundCodePackage"]["executionPlanFingerprint"] = fp("9")
    with pytest.raises(ValidationError, match="fingerprint"):
        JobCreateRequest(**drifted)


def test_expired_code_authority_reclaims_only_from_exact_ambiguous_marker(tmp_path, monkeypatch):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**effectful_code_job_body()))
        _leased, token = store.claim_job(job.id, "worker-code-a", 60)
        handoff = job.payload["preparedBackgroundCodeAction"]
        marker_payload = {
            "attemptId": code_attempt_id(job),
            "handoffFingerprint": handoff["fingerprint"],
            "repairCheckpointId": handoff["payload"]["repairCheckpointId"],
            "checkpointSequence": handoff["payload"]["preparedCheckpointSequence"],
        }
        marker_fingerprint = build_receipt_fingerprint(
            job={
                "id": job.id,
                "missionId": job.missionId,
                "nodeId": job.nodeId,
                "idempotencyKey": job.idempotencyKey,
                "capabilityEnvelopeFingerprint": job.capabilityEnvelope["fingerprint"],
                "authorizationFingerprint": job.capabilityEnvelope["authorizationFingerprint"],
            },
            provider="code",
            operation="prepared_code_validation_commit_v1",
            status="ambiguous",
            payload=marker_payload,
        )
        store.append_receipt(
            job.id,
            ReceiptAppendRequest(
                coordinatorId="worker-code-a",
                leaseToken=token,
                provider="code",
                operation="prepared_code_validation_commit_v1",
                status="ambiguous",
                fingerprint=marker_fingerprint,
                payload=marker_payload,
            ),
        )
        store.conn.execute("UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,))
        store._refresh_job_integrity_locked(store.conn, job.id)
        expired = dt.datetime.fromisoformat(handoff["expiresAt"]) + dt.timedelta(seconds=1)
        monkeypatch.setattr(coordinator_store_module, "_now_epoch", lambda: expired.timestamp())
        reclaimed, _token = store.claim_job(job.id, "worker-code-b", 60)
        assert reclaimed.attempts == 2
    finally:
        store.close()


def test_dispatched_code_marker_does_not_extend_expired_commit_authority(tmp_path, monkeypatch):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**effectful_code_job_body()))
        _leased, token = store.claim_job(job.id, "worker-code-a", 60)
        handoff = job.payload["preparedBackgroundCodeAction"]
        payload = {
            "attemptId": code_attempt_id(job),
            "handoffFingerprint": handoff["fingerprint"],
            "repairCheckpointId": handoff["payload"]["repairCheckpointId"],
        }
        fingerprint = build_receipt_fingerprint(
            job={
                "id": job.id,
                "missionId": job.missionId,
                "nodeId": job.nodeId,
                "idempotencyKey": job.idempotencyKey,
                "capabilityEnvelopeFingerprint": job.capabilityEnvelope["fingerprint"],
                "authorizationFingerprint": job.capabilityEnvelope["authorizationFingerprint"],
            },
            provider="code",
            operation="prepared_code_validation_commit_v1",
            status="dispatched",
            payload=payload,
        )
        store.append_receipt(job.id, ReceiptAppendRequest(
            coordinatorId="worker-code-a", leaseToken=token, provider="code",
            operation="prepared_code_validation_commit_v1", status="dispatched",
            fingerprint=fingerprint, payload=payload,
        ))
        store.conn.execute("UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,))
        store._refresh_job_integrity_locked(store.conn, job.id)
        expired = dt.datetime.fromisoformat(handoff["expiresAt"]) + dt.timedelta(seconds=1)
        monkeypatch.setattr(coordinator_store_module, "_now_epoch", lambda: expired.timestamp())
        with pytest.raises(Exception, match="expired"):
            store.claim_job(job.id, "worker-code-b", 60)
    finally:
        store.close()
