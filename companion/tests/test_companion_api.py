from __future__ import annotations

import datetime as dt
import json
from fastapi.testclient import TestClient
import server as server_module

from auth import CompanionSecurityConfig, authenticated_headers
from config import CompanionConfig
from server import create_app
from coordinator_store import build_completion_fingerprint, build_receipt_fingerprint

from conftest import FakeKeyringBackend, NoopBrowser, fp, valid_job_body


def _job_body() -> dict:
    return valid_job_body(
        inputs={"query": "durable companion"},
        mission_id="mission-api",
        node_id="research-1",
    )


def test_authenticated_job_api_claim_replay_receipt_and_completion(companion_client):
    client, headers, _config = companion_client
    created = client.post("/jobs", headers=headers, json=_job_body())
    assert created.status_code == 200
    job_id = created.json()["id"]

    claim = client.post(
        f"/jobs/{job_id}/claim",
        headers=headers,
        json={"coordinatorId": "worker-api", "leaseSeconds": 60},
    )
    assert claim.status_code == 200
    lease = claim.json()["leaseToken"]

    event = client.post(
        f"/jobs/{job_id}/events",
        headers=headers,
        json={
            "coordinatorId": "worker-api",
            "leaseToken": lease,
            "type": "progress",
            "payload": {"step": 1},
        },
    )
    assert event.status_code == 200

    replay = client.get(
        f"/jobs/{job_id}/events?after=0&follow=false", headers=headers
    )
    assert replay.status_code == 200
    assert replay.headers["content-type"].startswith("text/event-stream")
    assert "event: job_queued" in replay.text
    assert "event: progress" in replay.text

    remote_job = created.json()
    receipt_payload = {"sourceCount": 2}
    receipt_fingerprint = build_receipt_fingerprint(
        job={
            "id": remote_job["id"],
            "missionId": remote_job["missionId"],
            "nodeId": remote_job["nodeId"],
            "idempotencyKey": remote_job["idempotencyKey"],
            "capabilityEnvelopeFingerprint": remote_job["capabilityEnvelope"]["fingerprint"],
            "authorizationFingerprint": remote_job["capabilityEnvelope"]["authorizationFingerprint"],
        },
        provider="research",
        operation="fetch_verified_sources",
        status="verified",
        payload=receipt_payload,
    )
    receipt = client.post(
        f"/jobs/{job_id}/receipts",
        headers=headers,
        json={
            "coordinatorId": "worker-api",
            "leaseToken": lease,
            "provider": "research",
            "operation": "fetch_verified_sources",
            "status": "verified",
            "fingerprint": receipt_fingerprint,
            "payload": receipt_payload,
        },
    )
    assert receipt.status_code == 200

    job_binding = {
        "id": remote_job["id"],
        "missionId": remote_job["missionId"],
        "nodeId": remote_job["nodeId"],
        "idempotencyKey": remote_job["idempotencyKey"],
        "capabilityEnvelopeFingerprint": remote_job["capabilityEnvelope"]["fingerprint"],
        "authorizationFingerprint": remote_job["capabilityEnvelope"]["authorizationFingerprint"],
    }
    result = {"status": "complete", "outputs": {"answer": "verified"}}
    result["resultFingerprint"] = build_completion_fingerprint(
        job=job_binding, result=result
    )
    completed = client.post(
        f"/jobs/{job_id}/complete",
        headers=headers,
        json={
            "coordinatorId": "worker-api",
            "leaseToken": lease,
            "state": "complete",
            "output": result,
        },
    )
    assert completed.status_code == 200
    assert completed.json()["state"] == "complete"
    assert client.get(f"/jobs/{job_id}/receipts", headers=headers).json()[
        "receipts"
    ][0]["fingerprint"] == receipt_fingerprint


def test_non_follow_event_replay_drains_multiple_sparse_pages(companion_client):
    client, headers, _config = companion_client
    created = client.post("/jobs", headers=headers, json=_job_body())
    assert created.status_code == 200
    job_id = created.json()["id"]
    store = client.app.state.coordinator
    conn = store._conn()

    with store._transaction(conn):
        for step in range(600):
            store._append_event_locked(
                conn, job_id, "progress", {"step": step}, dt.datetime.now(dt.UTC).timestamp()
            )

    other = client.post(
        "/jobs",
        headers=headers,
        json=valid_job_body(
            mission_id="mission-api-sparse-gap", node_id="research-gap"
        ),
    )
    assert other.status_code == 200

    with store._transaction(conn):
        for step in range(600, 1_205):
            store._append_event_locked(
                conn, job_id, "progress", {"step": step}, dt.datetime.now(dt.UTC).timestamp()
            )

    replay = client.get(
        f"/jobs/{job_id}/events?after=0&follow=false", headers=headers
    )
    assert replay.status_code == 200
    assert replay.text.count("event: progress") == 1_205
    ids = [
        int(line.removeprefix("id: "))
        for line in replay.text.splitlines()
        if line.startswith("id: ")
    ]
    assert ids == sorted(ids)
    assert len(ids) == 1_206
    assert any(right - left > 1 for left, right in zip(ids, ids[1:]))


def test_non_follow_event_replay_exposes_typed_resumable_boundary(
    companion_client, monkeypatch
):
    client, headers, _config = companion_client
    created = client.post("/jobs", headers=headers, json=_job_body())
    job_id = created.json()["id"]
    store = client.app.state.coordinator
    conn = store._conn()
    with store._transaction(conn):
        for step in range(700):
            store._append_event_locked(
                conn, job_id, "progress", {"step": step}, dt.datetime.now(dt.UTC).timestamp()
            )
    monkeypatch.setattr(server_module, "EVENT_REPLAY_LIMIT", 500)
    replay = client.get(
        f"/jobs/{job_id}/events?after=0&follow=false", headers=headers
    )
    assert "event: replay_boundary" in replay.text
    assert '"complete":false' in replay.text
    assert '"reason":"event_limit"' in replay.text
    boundary_data = replay.text.split("event: replay_boundary\n", 1)[1]
    boundary_payload = boundary_data.split("data: ", 1)[1].split("\n", 1)[0]
    assert json.loads(boundary_payload)["afterSequence"] > 0


def test_background_claim_is_disabled_without_persistent_secret_backend(tmp_path):
    token = "b" * 43
    config = CompanionConfig(
        data_dir=tmp_path / "data",
        approved_data_root=tmp_path,
        security=CompanionSecurityConfig(
            bootstrap_token=token, allow_test_client=True
        ),
        background_requested=True,
    )
    app = create_app(
        config,
        browser_factory=lambda _data, _headless: NoopBrowser(),
        secure_backend=None,
    )
    with TestClient(app) as client:
        headers = authenticated_headers(token)
        health = client.get("/health", headers=headers).json()
        assert health["backgroundEnabled"] is False
        assert health["backgroundBlocker"] == (
            "secure_persistent_credential_backend_required"
        )
        job_id = client.post("/jobs", headers=headers, json=_job_body()).json()["id"]
        claim = client.post(
            f"/jobs/{job_id}/claim",
            headers=headers,
            json={"coordinatorId": "worker", "leaseSeconds": 60},
        )
        assert claim.status_code == 503


def test_background_claim_is_enabled_with_persistent_secret_backend(tmp_path):
    token = "p" * 43
    config = CompanionConfig(
        data_dir=tmp_path / "data",
        approved_data_root=tmp_path,
        security=CompanionSecurityConfig(
            bootstrap_token=token, allow_test_client=True
        ),
        background_requested=True,
    )
    app = create_app(
        config,
        browser_factory=lambda _data, _headless: NoopBrowser(),
        secure_backend=FakeKeyringBackend(),
        expected_worker_catalog_fingerprint=fp("c"),
    )
    with TestClient(app) as client:
        headers = authenticated_headers(token)
        initial = client.get("/health", headers=headers).json()
        assert initial["backgroundEnabled"] is False
        heartbeat = client.post(
            "/worker/heartbeat",
            headers=headers,
            json={
                "coordinatorId": "agentic-researcher-service-worker",
                "catalogFingerprint": fp("c"),
                "polledAt": dt.datetime.now(dt.UTC).isoformat(),
            },
        )
        assert heartbeat.status_code == 200
        assert client.get("/health", headers=headers).json()["backgroundEnabled"] is True
        job_id = client.post("/jobs", headers=headers, json=_job_body()).json()["id"]
        claim = client.post(
            f"/jobs/{job_id}/claim",
            headers=headers,
            json={"coordinatorId": "worker", "leaseSeconds": 60},
        )
        assert claim.status_code == 200


def test_session_secret_api_never_persists_plaintext(companion_client):
    client, headers, config = companion_client
    value = "github-token-that-must-not-be-persisted"
    created = client.post(
        "/secrets",
        headers=headers,
        json={"value": value, "label": "GitHub", "metadata": {"account": "octo"}},
    )
    assert created.status_code == 200
    description = created.json()
    assert "value" not in description
    assert description["persistent"] is False

    leased = client.post(
        f"/secrets/{description['referenceId']}/lease",
        headers=headers,
        json={"ttlSeconds": 30},
    )
    assert leased.status_code == 200
    assert leased.json()["value"] == value
    assert leased.headers["cache-control"] == "no-store"
    assert value.encode() not in (config.data_dir / "secrets.sqlite3").read_bytes()

    removed = client.delete(
        f"/secrets/{description['referenceId']}", headers=headers
    )
    assert removed.json() == {"removed": True}
    assert client.get(
        f"/secrets/{description['referenceId']}", headers=headers
    ).status_code == 404


def test_memory_api_rejects_legacy_vault_path_instead_of_ignoring_it(companion_client):
    client, headers, _config = companion_client
    response = client.post(
        "/memory/write",
        headers=headers,
        json={
            "kind": "episodic",
            "content": "safe observation",
            "confidence": 0.9,
            "vaultPath": "Private/Secrets.md",
        },
    )
    assert response.status_code == 422
