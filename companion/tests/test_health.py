from __future__ import annotations

import pytest

from auth import CompanionSecurityConfig, generate_bootstrap_token
from config import CompanionConfig


def test_health_and_status_require_authentication(companion_client):
    client, headers, _config = companion_client
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401

    response = client.get("/health", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body == {
        "ok": True,
        "service": "obsidian-research-companion",
        "browserReady": False,
        "memoryReady": True,
        "coordinatorReady": True,
        "secureStorePersistent": False,
        "backgroundEnabled": False,
        "backgroundBlocker": None,
        "workerReady": False,
        "workerDiagnostic": "worker_catalog_unconfigured",
        "installedExecutorDomains": [],
        "executorCatalogVersion": 1,
        "version": "0.3.0",
    }

    status = client.get("/status", headers=headers)
    assert status.status_code == 200
    assert status.json()["secureStoreBackend"] == "session-memory"
    assert status.json()["backgroundEnabled"] is False
    assert status.json()["installedExecutorDomains"] == []
    assert status.json()["executorCatalogVersion"] == 1


@pytest.mark.parametrize(
    ("method", "path"),
    [
        ("GET", "/health"),
        ("GET", "/status"),
        ("POST", "/browser/open"),
        ("POST", "/browser/observe"),
        ("POST", "/browser/click"),
        ("POST", "/browser/type"),
        ("POST", "/browser/keypress"),
        ("POST", "/browser/scroll"),
        ("POST", "/browser/screenshot"),
        ("POST", "/browser/extract_markdown"),
        ("POST", "/memory/write"),
        ("POST", "/memory/search"),
        ("POST", "/memory/delete"),
        ("POST", "/memory/clear"),
        ("POST", "/jobs"),
        ("POST", "/worker/heartbeat"),
        ("GET", "/jobs"),
        ("GET", "/jobs/job-1"),
        ("POST", "/jobs/job-1/claim"),
        ("POST", "/jobs/job-1/heartbeat"),
        ("POST", "/jobs/job-1/complete"),
        ("GET", "/jobs/job-1/events"),
        ("POST", "/jobs/job-1/events"),
        ("GET", "/jobs/job-1/receipts"),
        ("POST", "/jobs/job-1/receipts"),
        ("POST", "/secrets"),
        ("GET", "/secrets/secret-1"),
        ("POST", "/secrets/secret-1/lease"),
        ("DELETE", "/secrets/secret-1"),
        ("GET", "/static/ruffle-host.html"),
    ],
)
def test_every_endpoint_rejects_unauthenticated_requests(
    companion_client, method, path
):
    client, _headers, _config = companion_client
    assert client.request(method, path).status_code == 401


def test_request_boundary_rejects_oversized_body_and_browser_origin(companion_client):
    client, headers, _config = companion_client
    oversized = client.post(
        "/memory/search",
        headers={**headers, "Content-Type": "application/json"},
        content=b"x" * 4_097,
    )
    assert oversized.status_code == 413
    assert oversized.json()["error"] == "request_body_too_large"

    browser_origin = client.get(
        "/health", headers={**headers, "Origin": "https://attacker.example"}
    )
    assert browser_origin.status_code == 403
    assert "access-control-allow-origin" not in browser_origin.headers


def test_security_config_is_loopback_only_and_generates_256_bit_token():
    token = generate_bootstrap_token()
    assert len(token) >= 43
    with pytest.raises(ValueError, match="loopback"):
        CompanionSecurityConfig(bootstrap_token=token, bind_host="0.0.0.0")


def test_companion_data_directory_cannot_be_inside_an_obsidian_vault(tmp_path):
    vault = tmp_path / "vault"
    (vault / ".obsidian").mkdir(parents=True)
    config = CompanionConfig(
        data_dir=vault / "companion-data",
        security=CompanionSecurityConfig(bootstrap_token="v" * 43),
    )
    with pytest.raises(ValueError, match="Obsidian vault"):
        config.validate_data_boundary()
