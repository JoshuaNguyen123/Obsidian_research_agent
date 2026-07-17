from __future__ import annotations

import asyncio
import datetime as dt
import json
import socket
from pathlib import Path

import pytest

from browser_security import (
    BrowserBoundaryError,
    BrowserSafetyVerifier,
    open_pinned_public_connection,
    sign_safety_decision,
    validate_public_http_url,
)
from persisted_data import PersistedDataRejected, canonical_json
from schemas import SafetyPolicyDecisionV1

from conftest import fp


def test_canonical_json_matches_shared_typescript_vectors():
    assert canonical_json({"z": 1.0, "a": -0.0, "unicode": "é"}) == (
        '{"a":0,"unicode":"é","z":1}'
    )
    assert canonical_json({"small": 1e-7, "fixed": 1e-6}) == (
        '{"fixed":0.000001,"small":1e-7}'
    )
    assert canonical_json({"b": [1, True, None], "a": {"y": 2, "x": 1}}) == (
        '{"a":{"x":1,"y":2},"b":[1,true,null]}'
    )


def test_canonical_json_shared_unicode_and_numeric_boundary_vectors():
    vectors = json.loads(
        (Path(__file__).parent / "canonical_json_vectors.json").read_text(encoding="utf-8")
    )
    for vector in vectors:
        if "error" in vector:
            with pytest.raises(PersistedDataRejected, match=vector["error"]):
                canonical_json(vector["value"])
        else:
            assert canonical_json(vector["value"]) == vector["canonical"], vector["name"]


def test_safety_attestation_is_exact_short_lived_and_single_use():
    token = "s" * 43
    now = dt.datetime(2026, 7, 12, 12, 0, tzinfo=dt.UTC)
    payload = {"url": "https://example.com", "missionMode": "supervised"}
    signed = sign_safety_decision(
        token,
        "navigate",
        payload,
        policy_fingerprint=fp("1"),
        nonce="nonce_12345678901234567890",
        decided_at=now,
        expires_at=now + dt.timedelta(seconds=30),
    )
    verifier = BrowserSafetyVerifier(token, now=lambda: now)
    decision = SafetyPolicyDecisionV1(**signed)
    verifier.verify("navigate", payload, decision)
    with pytest.raises(BrowserBoundaryError, match="already consumed"):
        verifier.verify("navigate", payload, decision)

    changed = BrowserSafetyVerifier(token, now=lambda: now)
    with pytest.raises(BrowserBoundaryError, match="changed"):
        changed.verify(
            "navigate",
            {"url": "https://attacker.example", "missionMode": "supervised"},
            decision,
        )
    forged = decision.model_copy(update={"signature": "hmac-sha256:" + "0" * 64})
    with pytest.raises(BrowserBoundaryError, match="signature"):
        changed.verify("navigate", payload, forged)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "url",
    [
        "http://127.0.0.1/admin",
        "http://10.0.0.1/",
        "http://169.254.169.254/latest/meta-data",
        "http://metadata.google.internal/computeMetadata/v1",
        "http://[::1]/",
        "file:///etc/passwd",
        "http://user:password@example.com/",
    ],
)
async def test_browser_navigation_blocks_ssrf_metadata_and_local_targets(url):
    with pytest.raises(BrowserBoundaryError):
        await validate_public_http_url(url)


@pytest.mark.asyncio
async def test_dns_resolution_rejects_any_private_answer_and_accepts_public_only():
    def mixed(_host, _port, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.2", 443)),
        ]

    with pytest.raises(BrowserBoundaryError, match="Private"):
        await validate_public_http_url("https://example.com", mixed)

    def public(_host, _port, **_kwargs):
        return [
            (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))
        ]

    assert await validate_public_http_url("https://example.com/path", public) == (
        "https://example.com/path"
    )


@pytest.mark.asyncio
async def test_connection_time_resolution_blocks_dns_rebinding_before_dial():
    calls = 0
    dialed: list[tuple[str, int]] = []

    def rebinding(_host, _port, **_kwargs):
        nonlocal calls
        calls += 1
        address = "93.184.216.34" if calls == 1 else "127.0.0.1"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))]

    async def connector(host: str, port: int):
        dialed.append((host, port))
        raise AssertionError("A rebound private address must never be dialed")

    await validate_public_http_url("https://example.com", rebinding)
    with pytest.raises(BrowserBoundaryError, match="Private"):
        await open_pinned_public_connection(
            "example.com",
            443,
            resolver=rebinding,
            connector=connector,
        )
    assert dialed == []


@pytest.mark.asyncio
async def test_connection_time_proxy_dials_the_validated_ip_literal():
    dialed: list[tuple[str, int]] = []

    def public(_host, _port, **_kwargs):
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]

    class DummyWriter:
        pass

    async def connector(host: str, port: int):
        dialed.append((host, port))
        return asyncio.StreamReader(), DummyWriter()

    await open_pinned_public_connection(
        "example.com",
        443,
        resolver=public,
        connector=connector,
    )
    assert dialed == [("93.184.216.34", 443)]
