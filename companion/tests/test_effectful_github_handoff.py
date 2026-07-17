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


def _iso(value: dt.datetime) -> str:
    return value.astimezone(dt.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def _approval_receipt(
    prepared_action_id: str,
    prepared_action_fingerprint: str,
    decided_at: dt.datetime,
) -> dict:
    evidence = {
        "version": 1,
        "kind": "host_approval_receipt_evidence",
        "id": "github-approval-receipt-1",
        "preparedActionId": prepared_action_id,
        "preparedActionFingerprint": prepared_action_fingerprint,
        "confirmationOrdinal": 1,
        "requiredConfirmations": 1,
        "decision": "approved",
        "hostInstanceFingerprint": fp("1"),
        "actorFingerprint": fp("2"),
        "sessionFingerprint": fp("3"),
        "decidedAt": _iso(decided_at),
    }
    evidence_fingerprint = canonical_fingerprint(evidence)
    unsigned = {
        **evidence,
        "kind": "host_approval_receipt",
        "evidenceFingerprint": evidence_fingerprint,
        "signingKeyFingerprint": fp("4"),
        "authenticator": "A" * 43,
    }
    return {**unsigned, "fingerprint": canonical_fingerprint(unsigned)}


def effectful_github_job_body() -> dict:
    now = dt.datetime.now(dt.UTC)
    decided_at = now - dt.timedelta(minutes=4)
    consumed_at = now - dt.timedelta(minutes=3)
    prepared_at = now - dt.timedelta(minutes=2)
    expires_at = now + dt.timedelta(minutes=30)
    grant_expires_at = now + dt.timedelta(hours=1)
    mission_id = "mission-github-effectful-1"
    node_id = "node-github-push-1"
    graph_revision = 8
    authorization_fingerprint = fp("a")
    envelope_fingerprint = fp("b")
    prepared_action_fingerprint = fp("c")
    binding = {
        "id": "github-repository-binding-1",
        "kind": "github-repository",
        "destinationFingerprint": fp("d"),
    }
    action_evidence = {
        "version": 1,
        "kind": "prepared_background_github_action",
        "operation": "github_verified_branch_push_v1",
        "status": "prepared",
        "id": "prepared-github-background-1",
        "missionId": mission_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "nodeId": node_id,
        "nodeFingerprint": fp("e"),
        "executionHost": "headless_runtime",
        "toolName": "github_publish_verified_branch",
        "descriptorFingerprint": fp("f"),
        "preparedActionId": "prepared-github-action-1",
        "preparedActionFingerprint": prepared_action_fingerprint,
        "binding": {
            "id": binding["id"],
            "destinationFingerprint": binding["destinationFingerprint"],
            "repositoryBindingKey": "repository-binding-1",
            "repositoryBindingFingerprint": fp("5"),
            "repositoryProfileKey": "repository-profile-1",
            "repositoryProfileFingerprint": fp("6"),
            "owner": "acme",
            "repository": "research-agent",
            "repositoryId": 42,
            "verifiedAccountId": 7,
            "verifiedAccountLogin": "agent-bot",
            "credentialReferenceId": "secret_github-credential-1",
        },
        "authority": {
            "id": "grant-github-effectful-1",
            "authorityFingerprint": fp("7"),
            "actionFingerprint": prepared_action_fingerprint,
            "consumedAt": _iso(consumed_at),
            "expiresAt": _iso(grant_expires_at),
            "requiredConfirmations": 1,
            "confirmationReceipts": [
                _approval_receipt(
                    "prepared-github-action-1",
                    prepared_action_fingerprint,
                    decided_at,
                )
            ],
        },
        "payload": {
            "publicationId": "github-publication-1",
            "checkpointFingerprint": fp("8"),
            "checkpointStatus": "local_verified",
            "handoffFingerprint": fp("9"),
            "branch": "codex/repair-1",
            "baseBranch": "main",
            "baseSha": "a" * 40,
            "headSha": "b" * 40,
            "expectedRemoteSha": None,
            "pushMode": "create",
        },
        "idempotencyKey": fp("0"),
        "reconciliationKey": fp("0"),
        "preparedAt": _iso(prepared_at),
        "expiresAt": _iso(expires_at),
    }
    action = {**action_evidence, "fingerprint": canonical_fingerprint(action_evidence)}
    package_evidence = {
        "version": 1,
        "kind": "prepared_background_github_package_identity",
        "packageId": "background-github-package-1",
        "packageFingerprint": fp("a"),
        "actionFingerprint": action["fingerprint"],
        "preparedActionFingerprint": prepared_action_fingerprint,
        "operation": action["operation"],
        "publicationId": action["payload"]["publicationId"],
        "repositoryBindingFingerprint": action["binding"][
            "repositoryBindingFingerprint"
        ],
        "repositoryProfileFingerprint": action["binding"][
            "repositoryProfileFingerprint"
        ],
        "verifiedAccountId": action["binding"]["verifiedAccountId"],
        "backgroundAuthorizationFingerprint": authorization_fingerprint,
        "preparedAt": _iso(prepared_at),
        "expiresAt": _iso(expires_at),
    }
    package = {
        **package_evidence,
        "fingerprint": canonical_fingerprint(package_evidence),
    }
    identity = {
        "version": 1,
        "missionId": mission_id,
        "nodeId": node_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "authorizationFingerprint": authorization_fingerprint,
        "preparedBackgroundGitHubActionFingerprint": action["fingerprint"],
    }
    key = canonical_fingerprint(identity)
    return {
        "id": f"companion-{key.removeprefix('sha256:')[:32]}",
        "missionId": mission_id,
        "nodeId": node_id,
        "executionHost": "github",
        "payload": {
            "version": 1,
            "graphRevision": graph_revision,
            "executionHost": "headless_runtime",
            "objective": "Publish one exact verified agent-owned branch.",
            "inputs": {},
            "allowedTools": ["github_publish_verified_branch"],
            "requiredCapabilities": ["github.branch.push"],
            "bindings": [binding],
            "authorization": {
                "version": 1,
                "grantId": "grant-github-background-1",
                "fingerprint": authorization_fingerprint,
                "authorizedAt": _iso(consumed_at),
                "expiresAt": _iso(grant_expires_at),
            },
            "preparedExternalActionHandoff": None,
            "preparedBackgroundCodeAction": None,
            "preparedBackgroundCodePackage": None,
            "preparedBackgroundGitHubAction": action,
            "preparedBackgroundGitHubPackage": package,
            "createdAt": _iso(prepared_at),
            "updatedAt": _iso(prepared_at),
        },
        "capabilityEnvelope": {
            "fingerprint": envelope_fingerprint,
            "authorizationFingerprint": authorization_fingerprint,
        },
        "idempotencyKey": key,
    }


def github_attempt_id(job) -> str:
    action = job.payload["preparedBackgroundGitHubAction"]
    return canonical_fingerprint(
        {
            "version": 1,
            "jobId": job.id,
            "operation": action["operation"],
            "actionFingerprint": action["fingerprint"],
            "preparedActionFingerprint": action["preparedActionFingerprint"],
            "reconciliationKey": action["reconciliationKey"],
        }
    )


def test_github_action_and_package_roundtrip_are_closed_and_remote_safe():
    body = effectful_github_job_body()
    parsed = JobCreateRequest(**body)
    assert parsed.payload.preparedBackgroundGitHubAction is not None
    assert parsed.payload.preparedBackgroundGitHubPackage is not None
    serialized = parsed.model_dump(mode="json")
    flattened = str(serialized)
    assert "repositoryRoot" not in flattened
    assert "applicationDataRoot" not in flattened
    assert "command" not in flattened
    assert "reviewText" not in flattened
    assert "github_pat_" not in flattened

    widened = copy.deepcopy(body)
    widened["payload"]["preparedBackgroundGitHubPackage"][
        "applicationDataRoot"
    ] = "C:\\companion\\integrations"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        JobCreateRequest(**widened)

    command = copy.deepcopy(body)
    command["payload"]["preparedBackgroundGitHubAction"]["command"] = "git push --force"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        JobCreateRequest(**command)

    mixed = copy.deepcopy(body)
    mixed["payload"]["preparedExternalActionHandoff"] = {}
    with pytest.raises(ValidationError):
        JobCreateRequest(**mixed)


def test_github_transport_survives_store_restart_without_widening_payload(tmp_path):
    body = effectful_github_job_body()
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    created = store.create_job(JobCreateRequest(**body))
    store.close()

    restarted = CoordinatorStore(
        tmp_path / "coordinator.sqlite3", integrity_key="i" * 43
    )
    restarted.initialize()
    try:
        restored = restarted.get_job(created.id)
        assert restored.payload["preparedBackgroundGitHubAction"]["fingerprint"] == body[
            "payload"
        ]["preparedBackgroundGitHubAction"]["fingerprint"]
        assert restored.payload["preparedBackgroundGitHubPackage"]["fingerprint"] == body[
            "payload"
        ]["preparedBackgroundGitHubPackage"]["fingerprint"]
        assert "repositoryRoot" not in str(restored.payload)
    finally:
        restarted.close()


def test_expired_github_authority_reclaims_only_from_exact_ambiguous_marker(
    tmp_path, monkeypatch
):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**effectful_github_job_body()))
        _leased, token = store.claim_job(job.id, "worker-github-a", 60)
        action = job.payload["preparedBackgroundGitHubAction"]
        marker_payload = {
            "attemptId": github_attempt_id(job),
            "actionFingerprint": action["fingerprint"],
            "packageFingerprint": job.payload["preparedBackgroundGitHubPackage"][
                "packageFingerprint"
            ],
        }
        marker_fingerprint = build_receipt_fingerprint(
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
            provider="github",
            operation=action["operation"],
            status="ambiguous",
            payload=marker_payload,
        )
        store.append_receipt(
            job.id,
            ReceiptAppendRequest(
                coordinatorId="worker-github-a",
                leaseToken=token,
                provider="github",
                operation=action["operation"],
                status="ambiguous",
                fingerprint=marker_fingerprint,
                payload=marker_payload,
            ),
        )
        store.conn.execute(
            "UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,)
        )
        store._refresh_job_integrity_locked(store.conn, job.id)
        expired = dt.datetime.fromisoformat(action["expiresAt"].replace("Z", "+00:00"))
        expired += dt.timedelta(seconds=1)
        monkeypatch.setattr(
            coordinator_store_module, "_now_epoch", lambda: expired.timestamp()
        )
        reclaimed, _token = store.claim_job(job.id, "worker-github-b", 60)
        assert reclaimed.attempts == 2
    finally:
        store.close()


def test_expired_github_authority_without_marker_cannot_start_dispatch(
    tmp_path, monkeypatch
):
    store = CoordinatorStore(tmp_path / "coordinator.sqlite3", integrity_key="i" * 43)
    store.initialize()
    try:
        job = store.create_job(JobCreateRequest(**effectful_github_job_body()))
        _leased, _token = store.claim_job(job.id, "worker-github-a", 60)
        store.conn.execute(
            "UPDATE jobs SET lease_expires_at = 0 WHERE id = ?", (job.id,)
        )
        store._refresh_job_integrity_locked(store.conn, job.id)
        action = job.payload["preparedBackgroundGitHubAction"]
        expired = dt.datetime.fromisoformat(action["expiresAt"].replace("Z", "+00:00"))
        expired += dt.timedelta(seconds=1)
        monkeypatch.setattr(
            coordinator_store_module, "_now_epoch", lambda: expired.timestamp()
        )
        with pytest.raises(Exception, match="expired"):
            store.claim_job(job.id, "worker-github-b", 60)
    finally:
        store.close()
