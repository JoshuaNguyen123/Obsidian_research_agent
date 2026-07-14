from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import threading
from collections.abc import Callable

from persisted_data import canonical_fingerprint
from schemas import (
    HostApprovalReceiptEvidenceV1,
    HostApprovalReceiptV1,
    HostApprovalSignerDescriptionV1,
    HostApprovalVerificationResultV1,
)
from secure_store import SERVICE_NAME, SecretBackend, probe_secret_backend


HOST_APPROVAL_SIGNING_KEY_ACCOUNT = "host-approval-signing-key-v1"
HOST_APPROVAL_SIGNING_KEY_BYTES = 32


class HostApprovalSignerError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class HostApprovalSigner:
    """Persistent keyring-backed signer; raw key material never crosses this boundary."""

    def __init__(
        self,
        backend: SecretBackend | None,
        random_bytes: Callable[[int], bytes] = secrets.token_bytes,
    ):
        self.backend = backend
        self.random_bytes = random_bytes
        self._lock = threading.RLock()

    def describe(self) -> HostApprovalSignerDescriptionV1:
        with self._lock:
            if self.backend is None:
                return HostApprovalSignerDescriptionV1(
                    persistent=False,
                    provisioned=False,
                    backend="unavailable",
                    signingKeyFingerprint=None,
                )
            key = self._load_key(required=False)
            if key is None:
                return HostApprovalSignerDescriptionV1(
                    persistent=True,
                    provisioned=False,
                    backend=self.backend.name,
                    signingKeyFingerprint=None,
                )
            try:
                return HostApprovalSignerDescriptionV1(
                    persistent=True,
                    provisioned=True,
                    backend=self.backend.name,
                    signingKeyFingerprint=_key_fingerprint(key),
                )
            finally:
                _zero(key)

    def provision(self) -> HostApprovalSignerDescriptionV1:
        with self._lock:
            self._require_healthy_persistent_backend()
            existing = self._load_key(required=False)
            if existing is not None:
                _zero(existing)
                return self.describe()
            self._replace_with_new_key(previous=None)
            return self.describe()

    def rotate(self) -> HostApprovalSignerDescriptionV1:
        with self._lock:
            self._require_healthy_persistent_backend()
            previous = self.backend.get_password(
                SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
            )
            self._replace_with_new_key(previous=previous)
            return self.describe()

    def sign(
        self, evidence: HostApprovalReceiptEvidenceV1
    ) -> HostApprovalReceiptV1:
        with self._lock:
            key = self._load_key(required=True)
            assert key is not None
            try:
                signing_key_fingerprint = _key_fingerprint(key)
                authenticator = _authenticator(key, evidence.evidenceFingerprint)
                unsigned = {
                    **evidence.model_dump(),
                    "kind": "host_approval_receipt",
                    "signingKeyFingerprint": signing_key_fingerprint,
                    "authenticator": authenticator,
                }
                return HostApprovalReceiptV1(
                    **unsigned,
                    fingerprint=canonical_fingerprint(unsigned),
                )
            finally:
                _zero(key)

    def verify(
        self, receipt: HostApprovalReceiptV1
    ) -> HostApprovalVerificationResultV1:
        with self._lock:
            key = self._load_key(required=False)
            if key is None:
                return HostApprovalVerificationResultV1(
                    verified=False,
                    reason="signer_unavailable",
                    signingKeyFingerprint=None,
                )
            try:
                signing_key_fingerprint = _key_fingerprint(key)
                if receipt.decision != "approved":
                    return HostApprovalVerificationResultV1(
                        verified=False,
                        reason="decision_not_approved",
                        signingKeyFingerprint=signing_key_fingerprint,
                    )
                if not hmac.compare_digest(
                    receipt.signingKeyFingerprint, signing_key_fingerprint
                ):
                    return HostApprovalVerificationResultV1(
                        verified=False,
                        reason="key_mismatch",
                        signingKeyFingerprint=signing_key_fingerprint,
                    )
                expected_authenticator = _authenticator(
                    key, receipt.evidenceFingerprint
                )
                if not hmac.compare_digest(
                    receipt.authenticator, expected_authenticator
                ):
                    return HostApprovalVerificationResultV1(
                        verified=False,
                        reason="authenticator_mismatch",
                        signingKeyFingerprint=signing_key_fingerprint,
                    )
                return HostApprovalVerificationResultV1(
                    verified=True,
                    reason="verified",
                    signingKeyFingerprint=signing_key_fingerprint,
                )
            finally:
                _zero(key)

    def remove(self) -> bool:
        with self._lock:
            if self.backend is None:
                raise HostApprovalSignerError(
                    "persistent_backend_required",
                    "A persistent OS credential backend is required.",
                )
            existing = self.backend.get_password(
                SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
            )
            if existing is None:
                return False
            try:
                self.backend.delete_password(
                    SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
                )
            except Exception as error:
                if self.backend.get_password(
                    SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
                ) is not None:
                    raise HostApprovalSignerError(
                        "signing_key_delete_failed",
                        "Host approval signing-key deletion failed.",
                    ) from error
            if self.backend.get_password(
                SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
            ) is not None:
                raise HostApprovalSignerError(
                    "signing_key_delete_failed",
                    "Host approval signing-key deletion readback failed.",
                )
            return True

    def _require_healthy_persistent_backend(self) -> None:
        if self.backend is None or not probe_secret_backend(self.backend):
            raise HostApprovalSignerError(
                "persistent_backend_required",
                "A healthy persistent OS credential backend is required for host approval signing.",
            )

    def _replace_with_new_key(self, previous: str | None) -> None:
        assert self.backend is not None
        generated = self.random_bytes(HOST_APPROVAL_SIGNING_KEY_BYTES)
        if len(generated) != HOST_APPROVAL_SIGNING_KEY_BYTES:
            raise HostApprovalSignerError(
                "secure_random_failed",
                "Host approval signing-key generation returned the wrong size.",
            )
        key = bytearray(generated)
        encoded = _encode_key(key)
        try:
            self.backend.set_password(
                SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT, encoded
            )
            if not hmac.compare_digest(
                self.backend.get_password(
                    SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
                )
                or "",
                encoded,
            ):
                raise HostApprovalSignerError(
                    "signing_key_readback_failed",
                    "Host approval signing-key secure-store readback failed.",
                )
        except Exception:
            try:
                if previous is None:
                    self.backend.delete_password(
                        SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
                    )
                else:
                    self.backend.set_password(
                        SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT, previous
                    )
            finally:
                _zero(key)
            raise
        _zero(key)

    def _load_key(self, *, required: bool) -> bytearray | None:
        if self.backend is None:
            if required:
                raise HostApprovalSignerError(
                    "persistent_backend_required",
                    "A persistent OS credential backend is required for host approval signing.",
                )
            return None
        encoded = self.backend.get_password(
            SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT
        )
        if encoded is None:
            if required:
                raise HostApprovalSignerError(
                    "signing_key_unavailable",
                    "The host approval signing key has not been provisioned.",
                )
            return None
        try:
            key = bytearray(_decode_key(encoded))
        except (ValueError, TypeError) as error:
            raise HostApprovalSignerError(
                "signing_key_invalid",
                "The host approval signing key failed secure-store validation.",
            ) from error
        if len(key) != HOST_APPROVAL_SIGNING_KEY_BYTES:
            _zero(key)
            raise HostApprovalSignerError(
                "signing_key_invalid",
                "The host approval signing key failed secure-store validation.",
            )
        return key


def _key_fingerprint(key: bytes | bytearray) -> str:
    return f"sha256:{hashlib.sha256(key).hexdigest()}"


def _authenticator(key: bytes | bytearray, evidence_fingerprint: str) -> str:
    digest = hmac.new(
        key, evidence_fingerprint.encode("ascii"), hashlib.sha256
    ).digest()
    return base64.urlsafe_b64encode(digest).decode("ascii").rstrip("=")


def _encode_key(key: bytes | bytearray) -> str:
    return base64.urlsafe_b64encode(key).decode("ascii").rstrip("=")


def _decode_key(value: str) -> bytes:
    if len(value) != 43 or any(
        character not in "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
        for character in value
    ):
        raise ValueError("Signing key encoding is invalid.")
    return base64.urlsafe_b64decode(value + "=")


def _zero(value: bytearray) -> None:
    for index in range(len(value)):
        value[index] = 0
