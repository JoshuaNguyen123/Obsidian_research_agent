from __future__ import annotations

import json

from fastapi.testclient import TestClient

from auth import CompanionSecurityConfig, authenticated_headers
from config import CompanionConfig
from host_approval_signer import HOST_APPROVAL_SIGNING_KEY_ACCOUNT
from persisted_data import canonical_fingerprint
from secure_store import SERVICE_NAME
from server import create_app

from conftest import FakeKeyringBackend, NoopBrowser, fp


def _evidence(**overrides: object) -> dict[str, object]:
    unsigned: dict[str, object] = {
        "version": 1,
        "kind": "host_approval_receipt_evidence",
        "id": "approval-api-1",
        "preparedActionId": "prepared-api-1",
        "preparedActionFingerprint": fp("a"),
        "confirmationOrdinal": 1,
        "requiredConfirmations": 2,
        "decision": "approved",
        "hostInstanceFingerprint": fp("b"),
        "actorFingerprint": fp("c"),
        "sessionFingerprint": fp("d"),
        "decidedAt": "2026-07-13T12:00:00.000Z",
        **overrides,
    }
    return {
        **unsigned,
        "evidenceFingerprint": canonical_fingerprint(unsigned),
    }


def _rebuild_receipt(receipt: dict[str, object], **overrides: object) -> dict[str, object]:
    unsigned = {key: value for key, value in receipt.items() if key != "fingerprint"}
    unsigned.update(overrides)
    return {**unsigned, "fingerprint": canonical_fingerprint(unsigned)}


def _application(tmp_path, token: str, backend: FakeKeyringBackend | None):
    config = CompanionConfig(
        data_dir=tmp_path / "data",
        approved_data_root=tmp_path,
        security=CompanionSecurityConfig(
            bootstrap_token=token,
            allow_test_client=True,
            max_body_bytes=1_048_576,
        ),
        background_requested=False,
    )
    return create_app(
        config,
        browser_factory=lambda _data, _headless: NoopBrowser(),
        secure_backend=backend,
    )


def test_authenticated_signer_api_provisions_signs_verifies_rotates_and_never_returns_key(
    tmp_path,
) -> None:
    token = "h" * 43
    headers = authenticated_headers(token)
    backend = FakeKeyringBackend()
    application = _application(tmp_path, token, backend)

    with TestClient(application) as client:
        unauthenticated = client.post(
            "/host-approval-signer/sign",
            json={"version": 1, "evidence": _evidence()},
        )
        assert unauthenticated.status_code == 401

        initial = client.get("/host-approval-signer", headers=headers)
        assert initial.status_code == 200
        assert initial.headers["cache-control"] == "no-store"
        assert initial.json()["provisioned"] is False

        provisioned = client.post(
            "/host-approval-signer/provision",
            headers=headers,
            json={"version": 1},
        )
        assert provisioned.status_code == 200
        assert provisioned.headers["cache-control"] == "no-store"
        assert provisioned.json()["persistent"] is True
        assert provisioned.json()["provisioned"] is True
        encoded_key = backend.values[(SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT)]
        assert encoded_key not in provisioned.text

        signed = client.post(
            "/host-approval-signer/sign",
            headers=headers,
            json={"version": 1, "evidence": _evidence()},
        )
        assert signed.status_code == 200
        assert signed.headers["cache-control"] == "no-store"
        receipt = signed.json()
        assert receipt["decision"] == "approved"
        assert encoded_key not in signed.text

        verified = client.post(
            "/host-approval-signer/verify",
            headers=headers,
            json={"version": 1, "receipt": receipt},
        )
        assert verified.status_code == 200
        assert verified.headers["cache-control"] == "no-store"
        assert verified.json()["verified"] is True

        forged = _rebuild_receipt(receipt, authenticator="A" * 43)
        rejected = client.post(
            "/host-approval-signer/verify",
            headers=headers,
            json={"version": 1, "receipt": forged},
        )
        assert rejected.status_code == 200
        assert rejected.json()["reason"] == "authenticator_mismatch"

        rotated = client.post(
            "/host-approval-signer/rotate",
            headers=headers,
            json={"version": 1},
        )
        assert rotated.status_code == 200
        assert rotated.json()["signingKeyFingerprint"] != receipt["signingKeyFingerprint"]
        stale = client.post(
            "/host-approval-signer/verify",
            headers=headers,
            json={"version": 1, "receipt": receipt},
        )
        assert stale.json()["reason"] == "key_mismatch"

        unknown_request_field = client.post(
            "/host-approval-signer/provision",
            headers=headers,
            json={"version": 1, "unexpected": True},
        )
        assert unknown_request_field.status_code == 422
        assert unknown_request_field.headers["cache-control"] == "no-store"

        denied = _evidence(decision="denied")
        denied_request = client.post(
            "/host-approval-signer/sign",
            headers=headers,
            json={"version": 1, "evidence": denied},
        )
        assert denied_request.status_code == 422
        assert denied_request.headers["cache-control"] == "no-store"

        oversized = client.post(
            "/host-approval-signer/sign",
            headers={**headers, "Content-Type": "application/json"},
            content=json.dumps({"version": 1, "padding": "x" * 16_384}),
        )
        assert oversized.status_code == 413
        assert oversized.json() == {
            "ok": False,
            "error": "request_body_too_large",
        }

    persisted = b"".join(
        path.read_bytes()
        for path in (tmp_path / "data").rglob("*")
        if path.is_file()
    )
    assert encoded_key.encode("utf-8") not in persisted


def test_signer_api_stays_unavailable_without_persistent_keyring(tmp_path) -> None:
    token = "u" * 43
    headers = authenticated_headers(token)
    with TestClient(_application(tmp_path, token, None)) as client:
        description = client.get("/host-approval-signer", headers=headers)
        assert description.status_code == 200
        assert description.json() == {
            "version": 1,
            "kind": "host_approval_signer",
            "persistent": False,
            "provisioned": False,
            "backend": "unavailable",
            "signingKeyFingerprint": None,
        }
        provision = client.post(
            "/host-approval-signer/provision",
            headers=headers,
            json={"version": 1},
        )
        assert provision.status_code == 503
        assert provision.headers["cache-control"] == "no-store"
        assert provision.json()["error"] == "persistent_backend_required"
