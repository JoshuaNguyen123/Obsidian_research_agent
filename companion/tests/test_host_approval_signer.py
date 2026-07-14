from __future__ import annotations

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from host_approval_signer import (
    HOST_APPROVAL_SIGNING_KEY_ACCOUNT,
    HostApprovalSigner,
    HostApprovalSignerError,
    _authenticator,
    _key_fingerprint,
)
from persisted_data import canonical_fingerprint
from schemas import HostApprovalReceiptEvidenceV1, HostApprovalReceiptV1
from secure_store import SERVICE_NAME

from conftest import FakeKeyringBackend, fp


FIXED_KEY = bytes(range(32))


def _evidence(**overrides: object) -> HostApprovalReceiptEvidenceV1:
    unsigned = {
        "version": 1,
        "kind": "host_approval_receipt_evidence",
        "id": "approval-receipt-1",
        "preparedActionId": "prepared-action-1",
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
    return HostApprovalReceiptEvidenceV1(
        **unsigned,
        evidenceFingerprint=canonical_fingerprint(unsigned),
    )


def _rebuild_receipt(
    receipt: HostApprovalReceiptV1, **overrides: object
) -> HostApprovalReceiptV1:
    unsigned = receipt.model_dump(exclude={"fingerprint"})
    unsigned.update(overrides)
    return HostApprovalReceiptV1(
        **unsigned,
        fingerprint=canonical_fingerprint(unsigned),
    )


def _denied_receipt(receipt: HostApprovalReceiptV1) -> HostApprovalReceiptV1:
    evidence = receipt.model_dump(
        exclude={
            "evidenceFingerprint",
            "signingKeyFingerprint",
            "authenticator",
            "fingerprint",
        }
    )
    evidence["kind"] = "host_approval_receipt_evidence"
    evidence["decision"] = "denied"
    unsigned = {
        **evidence,
        "kind": "host_approval_receipt",
        "evidenceFingerprint": canonical_fingerprint(evidence),
        "signingKeyFingerprint": receipt.signingKeyFingerprint,
        "authenticator": receipt.authenticator,
    }
    return HostApprovalReceiptV1(
        **unsigned,
        fingerprint=canonical_fingerprint(unsigned),
    )


def test_shared_hmac_vector_is_stable_and_base64url() -> None:
    vector_path = Path(__file__).with_name("host_approval_hmac_vectors.json")
    vector = json.loads(vector_path.read_text(encoding="utf-8"))[0]
    key = bytes.fromhex(vector["keyHex"])
    assert _key_fingerprint(key) == vector["signingKeyFingerprint"]
    assert _authenticator(key, vector["evidenceFingerprint"]) == vector["authenticator"]
    assert "=" not in vector["authenticator"]


def test_signer_requires_persistent_keyring_and_never_provisions_session_state() -> None:
    signer = HostApprovalSigner(None, random_bytes=lambda _length: FIXED_KEY)
    assert signer.describe().model_dump() == {
        "version": 1,
        "kind": "host_approval_signer",
        "persistent": False,
        "provisioned": False,
        "backend": "unavailable",
        "signingKeyFingerprint": None,
    }
    with pytest.raises(HostApprovalSignerError, match="persistent OS credential backend"):
        signer.provision()
    with pytest.raises(HostApprovalSignerError, match="has not been provisioned|persistent"):
        signer.sign(_evidence())


def test_provision_sign_verify_and_describe_do_not_return_raw_key_material() -> None:
    backend = FakeKeyringBackend()
    signer = HostApprovalSigner(backend, random_bytes=lambda _length: FIXED_KEY)
    description = signer.provision()
    expected_key_fingerprint = _key_fingerprint(FIXED_KEY)
    assert description.persistent is True
    assert description.provisioned is True
    assert description.signingKeyFingerprint == expected_key_fingerprint
    encoded_key = backend.values[(SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT)]
    assert len(encoded_key) == 43
    assert encoded_key not in description.model_dump_json()

    evidence = _evidence()
    receipt = signer.sign(evidence)
    assert receipt.authenticator == _authenticator(FIXED_KEY, evidence.evidenceFingerprint)
    assert receipt.signingKeyFingerprint == expected_key_fingerprint
    assert encoded_key not in receipt.model_dump_json()
    verification = signer.verify(receipt)
    assert verification.verified is True
    assert verification.reason == "verified"


def test_verifier_rejects_forged_tampered_denied_and_wrong_session_receipts() -> None:
    backend = FakeKeyringBackend()
    signer = HostApprovalSigner(backend, random_bytes=lambda _length: FIXED_KEY)
    signer.provision()
    receipt = signer.sign(_evidence())

    forged = _rebuild_receipt(receipt, authenticator="A" * 43)
    assert signer.verify(forged).reason == "authenticator_mismatch"

    wrong_key = _rebuild_receipt(receipt, signingKeyFingerprint=fp("e"))
    assert signer.verify(wrong_key).reason == "key_mismatch"

    denied = _denied_receipt(receipt)
    assert signer.verify(denied).reason == "decision_not_approved"

    changed_evidence = _evidence(sessionFingerprint=fp("f"))
    tampered_session = _rebuild_receipt(
        receipt,
        sessionFingerprint=changed_evidence.sessionFingerprint,
        evidenceFingerprint=changed_evidence.evidenceFingerprint,
    )
    assert signer.verify(tampered_session).reason == "authenticator_mismatch"


def test_closed_evidence_rejects_unknown_fields_noncanonical_time_and_bad_ordinals() -> None:
    valid = _evidence().model_dump()
    with pytest.raises(ValidationError):
        HostApprovalReceiptEvidenceV1(**valid, unexpected=True)

    for override in (
        {"decidedAt": "2026-07-13T12:00:00Z"},
        {"confirmationOrdinal": 2, "requiredConfirmations": 1},
    ):
        unsigned = {**valid, **override}
        unsigned.pop("evidenceFingerprint")
        with pytest.raises(ValidationError):
            HostApprovalReceiptEvidenceV1(
                **unsigned,
                evidenceFingerprint=canonical_fingerprint(unsigned),
            )


def test_rotation_invalidates_old_receipts_and_requires_fresh_approval_sealing() -> None:
    backend = FakeKeyringBackend()
    keys = iter((bytes(range(32)), bytes(reversed(range(32)))))
    signer = HostApprovalSigner(backend, random_bytes=lambda _length: next(keys))
    first_description = signer.provision()
    old_receipt = signer.sign(_evidence())

    rotated = signer.rotate()
    assert rotated.signingKeyFingerprint != first_description.signingKeyFingerprint
    assert signer.verify(old_receipt).reason == "key_mismatch"

    fresh_receipt = signer.sign(_evidence(id="approval-receipt-after-rotation"))
    assert fresh_receipt.signingKeyFingerprint == rotated.signingKeyFingerprint
    assert signer.verify(fresh_receipt).verified is True
