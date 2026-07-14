from __future__ import annotations

import sys
from pathlib import Path
from typing import Any

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from auth import CompanionSecurityConfig, authenticated_headers
from config import CompanionConfig
from server import create_app
from persisted_data import canonical_fingerprint


class NoopBrowser:
    def __init__(self):
        self.ready = False
        self.startup_error = "Browser intentionally disabled in API boundary tests."

    async def start(self) -> None:
        return None

    async def stop(self) -> None:
        return None

    async def observe(self) -> dict[str, Any]:
        raise RuntimeError(self.startup_error)


@pytest.fixture
def companion_client(tmp_path):
    token = "t" * 43
    config = CompanionConfig(
        data_dir=tmp_path / "data",
        security=CompanionSecurityConfig(
            bootstrap_token=token,
            allow_test_client=True,
            max_body_bytes=4_096,
        ),
        background_requested=False,
    )
    application = create_app(
        config,
        browser_factory=lambda _data_dir, _headless: NoopBrowser(),
        secure_backend=None,
    )
    with TestClient(application) as client:
        yield client, authenticated_headers(token), config


class FakeKeyringBackend:
    name = "fake-os-keyring"

    def __init__(self):
        self.values: dict[tuple[str, str], str] = {}

    def get_password(self, service: str, username: str) -> str | None:
        return self.values.get((service, username))

    def set_password(self, service: str, username: str, password: str) -> None:
        self.values[(service, username)] = password

    def delete_password(self, service: str, username: str) -> None:
        self.values.pop((service, username), None)


def fp(character: str) -> str:
    return f"sha256:{character * 64}"


def valid_job_body(
    *,
    inputs: dict[str, Any] | None = None,
    domain: str = "research",
    mission_id: str = "mission-1",
    node_id: str = "node-1",
) -> dict[str, Any]:
    authorization_fingerprint = fp("a")
    envelope_fingerprint = fp("b")
    graph_revision = 3
    identity = {
        "version": 1,
        "missionId": mission_id,
        "nodeId": node_id,
        "graphRevision": graph_revision,
        "capabilityEnvelopeFingerprint": envelope_fingerprint,
        "authorizationFingerprint": authorization_fingerprint,
    }
    idempotency_key = canonical_fingerprint(identity)
    return {
        "id": f"companion-{idempotency_key[len('sha256:'):len('sha256:') + 32]}",
        "missionId": mission_id,
        "nodeId": node_id,
        "executionHost": domain,
        "payload": {
            "version": 1,
            "graphRevision": graph_revision,
            "executionHost": "headless_runtime",
            "objective": "Perform bounded authorized research.",
            "inputs": inputs if inputs is not None else {"query": "bounded research"},
            "allowedTools": ["web_search"],
            "requiredCapabilities": ["web.read"],
            "bindings": [],
            "authorization": {
                "version": 1,
                "grantId": "grant-1",
                "fingerprint": authorization_fingerprint,
                "authorizedAt": "2026-07-12T00:00:00+00:00",
                "expiresAt": None,
            },
            "createdAt": "2026-07-12T00:00:00+00:00",
            "updatedAt": "2026-07-12T00:00:00+00:00",
        },
        "capabilityEnvelope": {
            "fingerprint": envelope_fingerprint,
            "authorizationFingerprint": authorization_fingerprint,
        },
        "idempotencyKey": idempotency_key,
    }
