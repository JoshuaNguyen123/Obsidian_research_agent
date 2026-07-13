from __future__ import annotations

import asyncio
import datetime as dt
import hashlib
import hmac
import ipaddress
import socket
import threading
from typing import Any, Awaitable, Callable
from urllib.parse import urlparse

from persisted_data import canonical_fingerprint, canonical_json
from schemas import SafetyPolicyDecisionV1


Resolver = Callable[..., Any]
_METADATA_HOSTS = {
    "metadata",
    "metadata.aws.internal",
    "metadata.azure.internal",
    "metadata.google.internal",
    "metadata.internal",
    "instance-data",
    "100.100.100.200",
    "169.254.169.254",
}


class BrowserBoundaryError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class BrowserSafetyVerifier:
    """Verifies short-lived host SafetyPolicy attestations and consumes nonces."""

    def __init__(self, bootstrap_token: str, now: Callable[[], dt.datetime] | None = None):
        self._key = bootstrap_token.encode("utf-8")
        self._now = now or (lambda: dt.datetime.now(dt.UTC))
        self._seen_nonces: dict[str, dt.datetime] = {}
        self._lock = threading.Lock()

    def verify(
        self,
        action: str,
        action_payload: dict[str, Any],
        decision: SafetyPolicyDecisionV1,
    ) -> None:
        if decision.action != action or decision.decision != "allow":
            raise BrowserBoundaryError(
                "safety_decision_mismatch",
                "The SafetyPolicy decision does not match this browser action.",
            )
        expected_payload = canonical_fingerprint(action_payload)
        if not hmac.compare_digest(decision.payloadFingerprint, expected_payload):
            raise BrowserBoundaryError(
                "safety_payload_mismatch",
                "The browser action changed after the SafetyPolicy decision.",
            )
        now = self._now()
        decided = _timestamp(decision.decidedAt, "decidedAt")
        expires = _timestamp(decision.expiresAt, "expiresAt")
        if decided > now + dt.timedelta(seconds=5) or expires <= now:
            raise BrowserBoundaryError("safety_decision_expired", "The SafetyPolicy decision is stale.")
        if expires - decided > dt.timedelta(seconds=60):
            raise BrowserBoundaryError(
                "safety_window_too_wide",
                "Browser SafetyPolicy decisions may be valid for at most 60 seconds.",
            )
        signed = decision.model_dump(exclude={"signature"})
        digest = hmac.new(
            self._key,
            canonical_json(signed).encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        expected_signature = f"hmac-sha256:{digest}"
        if not hmac.compare_digest(decision.signature, expected_signature):
            raise BrowserBoundaryError(
                "safety_signature_invalid",
                "The browser SafetyPolicy signature is invalid.",
            )
        with self._lock:
            self._purge_nonces(now)
            if decision.nonce in self._seen_nonces:
                raise BrowserBoundaryError(
                    "safety_nonce_replayed",
                    "The browser SafetyPolicy decision nonce was already consumed.",
                )
            self._seen_nonces[decision.nonce] = expires

    def _purge_nonces(self, now: dt.datetime) -> None:
        for nonce in [nonce for nonce, expiry in self._seen_nonces.items() if expiry <= now]:
            del self._seen_nonces[nonce]


def sign_safety_decision(
    bootstrap_token: str,
    action: str,
    action_payload: dict[str, Any],
    *,
    policy_fingerprint: str,
    nonce: str,
    decided_at: dt.datetime,
    expires_at: dt.datetime,
) -> dict[str, Any]:
    signed = {
        "version": 1,
        "decision": "allow",
        "action": action,
        "policyFingerprint": policy_fingerprint,
        "payloadFingerprint": canonical_fingerprint(action_payload),
        "nonce": nonce,
        "decidedAt": decided_at.isoformat(),
        "expiresAt": expires_at.isoformat(),
    }
    digest = hmac.new(
        bootstrap_token.encode("utf-8"),
        canonical_json(signed).encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {**signed, "signature": f"hmac-sha256:{digest}"}


async def validate_public_http_url(
    url: str,
    resolver: Resolver = socket.getaddrinfo,
) -> str:
    parsed = urlparse(url)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise BrowserBoundaryError("unsafe_url", "Browser navigation requires HTTP or HTTPS.")
    if parsed.username is not None or parsed.password is not None:
        raise BrowserBoundaryError("unsafe_url", "Browser URLs cannot contain credentials.")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname in _METADATA_HOSTS or hostname == "localhost" or hostname.endswith(".localhost"):
        raise BrowserBoundaryError("ssrf_target_blocked", "Local and metadata hosts are blocked.")
    try:
        literal = ipaddress.ip_address(hostname)
        addresses = [literal]
    except ValueError:
        try:
            records = await asyncio.to_thread(
                resolver,
                hostname,
                parsed.port or (443 if parsed.scheme.lower() == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except (OSError, socket.gaierror) as exc:
            raise BrowserBoundaryError("dns_resolution_failed", "Browser target DNS failed.") from exc
        addresses = []
        for record in records:
            try:
                addresses.append(ipaddress.ip_address(record[4][0]))
            except (ValueError, IndexError):
                continue
    if not addresses or any(not address.is_global for address in addresses):
        raise BrowserBoundaryError(
            "ssrf_target_blocked",
            "Private, loopback, link-local, reserved, and metadata addresses are blocked.",
        )
    return url


def browser_action_payload(request: Any) -> dict[str, Any]:
    return request.model_dump(exclude={"safetyDecision"})


def _timestamp(value: str, field: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise BrowserBoundaryError("invalid_safety_timestamp", f"{field} is invalid.") from exc
    if parsed.tzinfo is None:
        raise BrowserBoundaryError("invalid_safety_timestamp", f"{field} requires a timezone.")
    return parsed.astimezone(dt.UTC)
