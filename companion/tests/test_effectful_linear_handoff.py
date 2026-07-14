from __future__ import annotations

import copy
import datetime as dt

import pytest
from pydantic import ValidationError

import coordinator_store as coordinator_store_module
from conftest import fp
from coordinator_store import CoordinatorStore, build_receipt_fingerprint
from persisted_data import PersistedDataRejected, canonical_fingerprint, sanitize_receipt_payload
from schemas import JobCreateRequest, ReceiptAppendRequest


def effectful_linear_job_body() -> dict:
    now = dt.datetime.now(dt.UTC)
    consumed_at = now - dt.timedelta(minutes=2)
    prepared_at = now - dt.timedelta(minutes=1)
    expires_at = now + dt.timedelta(minutes=30)
    grant_expires_at = now + dt.timedelta(hours=1)
    mission_id = "mission-effectful-1"
    node_id = "node-linear-update-1"
    graph_revision = 4
    authorization_fingerprint = fp("a")
    envelope_fingerprint = fp("b")
    prepared_action_fingerprint = fp("e")
    binding = {
        "id": "linear-issue-binding-1",
        "kind": "issue",
        "destinationFingerprint": fp("f"),
    }
    handoff_evidence = {
        "version": 1,
        "kind": "prepared_external_action_handoff",
        "operation": "linear_issue_state_update_v1",
        "status": "prepared",
        "id": "handoff-linear-update-1",
        "missionId": mission_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "nodeId": node_id,
        "nodeFingerprint": fp("c"),
        "executionHost": "headless_runtime",
        "toolName": "linear_update_issue",
        "descriptorFingerprint": fp("d"),
        "preparedActionId": "prepared-action-1",
        "preparedActionFingerprint": prepared_action_fingerprint,
        "binding": binding,
        "authority": {
            "id": "grant-effectful-1",
            "authorityFingerprint": authorization_fingerprint,
            "actionFingerprint": prepared_action_fingerprint,
            "consumedAt": consumed_at.isoformat(),
            "expiresAt": grant_expires_at.isoformat(),
        },
        "payload": {
            "issueId": "linear-issue-1",
            "stateId": "linear-state-done-1",
            "preconditionFingerprint": fp("1"),
            "credentialReferenceId": "secret_linear-credential-1",
        },
        "idempotencyKey": "linear-state-update:mission-effectful-1:node-linear-update-1",
        "reconciliationKey": "linear-state-update:mission-effectful-1:node-linear-update-1",
        "preparedAt": prepared_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }
    handoff = {
        **handoff_evidence,
        "fingerprint": canonical_fingerprint(handoff_evidence),
    }
    identity = {
        "version": 1,
        "missionId": mission_id,
        "nodeId": node_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "authorizationFingerprint": authorization_fingerprint,
        "preparedExternalActionHandoffFingerprint": handoff["fingerprint"],
    }
    idempotency_key = canonical_fingerprint(identity)
    return {
        "id": f"companion-{idempotency_key[len('sha256:'):len('sha256:') + 32]}",
        "missionId": mission_id,
        "nodeId": node_id,
        "executionHost": "linear",
        "payload": {
            "version": 1,
            "graphRevision": graph_revision,
            "executionHost": "headless_runtime",
            "objective": "Apply the exact approved Linear issue state transition.",
            "inputs": {},
            "allowedTools": ["linear_update_issue"],
            "requiredCapabilities": ["linear.issue.update_state"],
            "bindings": [binding],
            "authorization": {
                "version": 1,
                "grantId": "grant-effectful-1",
                "fingerprint": authorization_fingerprint,
                "authorizedAt": consumed_at.isoformat(),
                "expiresAt": grant_expires_at.isoformat(),
            },
            "preparedExternalActionHandoff": handoff,
            "createdAt": prepared_at.isoformat(),
            "updatedAt": prepared_at.isoformat(),
        },
        "capabilityEnvelope": {
            "fingerprint": envelope_fingerprint,
            "authorizationFingerprint": authorization_fingerprint,
        },
        "idempotencyKey": idempotency_key,
    }


def receipt_fingerprint(job, status: str, payload: dict) -> str:
    return build_receipt_fingerprint(
        job={
            "id": job.id,
            "missionId": job.missionId,
            "nodeId": job.nodeId,
            "idempotencyKey": job.idempotencyKey,
            "capabilityEnvelopeFingerprint": job.capabilityEnvelope["fingerprint"],
            "authorizationFingerprint": job.capabilityEnvelope[
                "authorizationFingerprint"
            ],
        },
        provider="linear",
        operation="linear_issue_state_update_v1",
        status=status,
        payload=payload,
    )


def effectful_attempt_id(job) -> str:
    handoff = job.payload["preparedExternalActionHandoff"]
    return canonical_fingerprint(
        {
            "version": 1,
            "jobId": job.id,
            "handoffFingerprint": handoff["fingerprint"],
            "preparedActionFingerprint": handoff["preparedActionFingerprint"],
            "reconciliationKey": handoff["reconciliationKey"],
        }
    )


def test_effectful_linear_job_accepts_only_the_exact_secret_free_handoff():
    body = effectful_linear_job_body()
    parsed = JobCreateRequest(**body)
    handoff = parsed.payload.preparedExternalActionHandoff
    assert handoff is not None
    assert handoff.payload.credentialReferenceId == "secret_linear-credential-1"
    assert parsed.payload.inputs == {}

    plaintext = copy.deepcopy(body)
    plaintext["payload"]["preparedExternalActionHandoff"]["payload"][
        "credentialReferenceId"
    ] = "linear-api-key-plaintext"
    with pytest.raises(ValidationError, match="credentialReferenceId"):
        JobCreateRequest(**plaintext)

    widened = copy.deepcopy(body)
    widened["payload"]["preparedExternalActionHandoff"]["payload"]["command"] = (
        "arbitrary mutation"
    )
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        JobCreateRequest(**widened)

    drifted = copy.deepcopy(body)
    drifted["payload"]["allowedTools"] = ["linear_update_issue", "linear.create"]
    with pytest.raises(ValidationError, match="drifted"):
        JobCreateRequest(**drifted)


def test_effectful_linear_dispatch_receipt_survives_restart_for_readback_reconciliation(
    tmp_path,
):
    database = tmp_path / "coordinator.sqlite3"
    first = CoordinatorStore(database)
    first.initialize()
    job = first.create_job(JobCreateRequest(**effectful_linear_job_body()))
    _leased, token = first.claim_job(job.id, "worker-a", 60)
    dispatched_payload = {
        "attemptId": effectful_attempt_id(job),
        "handoffFingerprint": job.payload["preparedExternalActionHandoff"][
            "fingerprint"
        ],
        "preparedActionFingerprint": job.payload[
            "preparedExternalActionHandoff"
        ]["preparedActionFingerprint"],
        "preconditionFingerprint": fp("1"),
        "targetStateId": "linear-state-done-1",
        "reconciliationMode": "readback_only_after_dispatch",
    }
    dispatched = first.append_receipt(
        job.id,
        ReceiptAppendRequest(
            coordinatorId="worker-a",
            leaseToken=token,
            provider="linear",
            operation="linear_issue_state_update_v1",
            status="dispatched",
            fingerprint=receipt_fingerprint(job, "dispatched", dispatched_payload),
            payload=dispatched_payload,
        ),
    )
    first.close()

    second = CoordinatorStore(database)
    second.initialize()
    try:
        restored = second.get_job(job.id)
        assert restored.state == "running"
        assert second.list_receipts(job.id) == [dispatched]
        second.conn.execute(
            "UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,)
        )
        _reclaimed, retry_token = second.claim_job(job.id, "worker-b", 60)
        verified_payload = {
            **dispatched_payload,
            "issueId": "linear-issue-1",
            "observedStateId": "linear-state-done-1",
            "readbackFingerprint": fp("3"),
        }
        verified = second.append_receipt(
            job.id,
            ReceiptAppendRequest(
                coordinatorId="worker-b",
                leaseToken=retry_token,
                provider="linear",
                operation="linear_issue_state_update_v1",
                status="verified",
                fingerprint=receipt_fingerprint(job, "verified", verified_payload),
                payload=verified_payload,
            ),
        )
        assert [receipt.status for receipt in second.list_receipts(job.id)] == [
            "dispatched",
            "verified",
        ]
        assert verified.payload["reconciliationMode"] == "readback_only_after_dispatch"
    finally:
        second.close()


def test_expired_effectful_authority_can_reclaim_only_after_exact_dispatch_marker(
    tmp_path, monkeypatch
):
    database = tmp_path / "coordinator.sqlite3"
    store = CoordinatorStore(database)
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**effectful_linear_job_body()))
        _leased, token = store.claim_job(job.id, "worker-a", 60)
        handoff = job.payload["preparedExternalActionHandoff"]
        dispatched_payload = {
            "attemptId": effectful_attempt_id(job),
            "handoffFingerprint": handoff["fingerprint"],
            "preparedActionFingerprint": handoff["preparedActionFingerprint"],
            "preconditionFingerprint": handoff["payload"][
                "preconditionFingerprint"
            ],
            "targetStateId": handoff["payload"]["stateId"],
            "reconciliationMode": "readback_only_after_dispatch",
        }
        store.append_receipt(
            job.id,
            ReceiptAppendRequest(
                coordinatorId="worker-a",
                leaseToken=token,
                provider="linear",
                operation="linear_issue_state_update_v1",
                status="dispatched",
                fingerprint=receipt_fingerprint(
                    job, "dispatched", dispatched_payload
                ),
                payload=dispatched_payload,
            ),
        )
        store.conn.execute(
            "UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,)
        )
        after_expiry = (
            dt.datetime.fromisoformat(handoff["expiresAt"]) + dt.timedelta(seconds=1)
        ).timestamp()
        monkeypatch.setattr(
            coordinator_store_module, "_now_epoch", lambda: after_expiry
        )

        reclaimed, _token = store.claim_job(job.id, "worker-b", 60)
        assert reclaimed.state == "running"
        assert reclaimed.attempts == 2
    finally:
        store.close()


def test_linear_receipt_boundary_rejects_commands_and_unknown_mutation_fields():
    accepted = sanitize_receipt_payload(
        "linear",
        {
            "attemptId": fp("4"),
            "handoffFingerprint": fp("5"),
            "targetStateId": "linear-state-done-1",
            "reconciliationMode": "readback_only_after_dispatch",
        },
    )
    assert accepted["targetStateId"] == "linear-state-done-1"

    with pytest.raises(PersistedDataRejected, match="not allowed"):
        sanitize_receipt_payload("linear", {"command": "delete issue"})
