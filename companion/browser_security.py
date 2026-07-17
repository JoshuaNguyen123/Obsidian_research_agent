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
Connector = Callable[..., Awaitable[tuple[asyncio.StreamReader, asyncio.StreamWriter]]]
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
    await resolve_public_addresses(
        hostname,
        parsed.port or (443 if parsed.scheme.lower() == "https" else 80),
        resolver,
    )
    return url


async def resolve_public_addresses(
    hostname: str,
    port: int,
    resolver: Resolver = socket.getaddrinfo,
) -> list[ipaddress.IPv4Address | ipaddress.IPv6Address]:
    hostname = hostname.rstrip(".").lower()
    if hostname in _METADATA_HOSTS or hostname == "localhost" or hostname.endswith(".localhost"):
        raise BrowserBoundaryError("ssrf_target_blocked", "Local and metadata hosts are blocked.")
    if not 1 <= port <= 65_535:
        raise BrowserBoundaryError("unsafe_url", "Browser target port is invalid.")
    try:
        literal = ipaddress.ip_address(hostname)
        addresses = [literal]
    except ValueError:
        try:
            records = await asyncio.to_thread(
                resolver,
                hostname,
                port,
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
    return addresses


async def open_pinned_public_connection(
    hostname: str,
    port: int,
    *,
    resolver: Resolver = socket.getaddrinfo,
    connector: Connector = asyncio.open_connection,
) -> tuple[asyncio.StreamReader, asyncio.StreamWriter]:
    """Resolve and validate at connect time, then dial the accepted IP literal."""
    addresses = await resolve_public_addresses(hostname, port, resolver)
    last_error: OSError | None = None
    for address in addresses:
        try:
            return await connector(str(address), port)
        except OSError as exc:
            last_error = exc
    raise BrowserBoundaryError(
        "browser_connect_failed",
        "Browser target connection failed after public-address validation.",
    ) from last_error


class PinnedPublicProxy:
    """Loopback HTTP CONNECT proxy that pins every origin connection to a validated IP."""

    def __init__(
        self,
        resolver: Resolver = socket.getaddrinfo,
        connector: Connector = asyncio.open_connection,
        on_boundary_error: Callable[[BrowserBoundaryError], None] | None = None,
    ):
        self._resolver = resolver
        self._connector = connector
        self._on_boundary_error = on_boundary_error
        self._server: asyncio.AbstractServer | None = None

    @property
    def server_url(self) -> str:
        if not self._server or not self._server.sockets:
            raise RuntimeError("Pinned browser proxy is not running.")
        port = int(self._server.sockets[0].getsockname()[1])
        return f"http://127.0.0.1:{port}"

    async def start(self) -> None:
        if self._server is not None:
            return
        self._server = await asyncio.start_server(
            self._handle_client,
            host="127.0.0.1",
            port=0,
            limit=65_536,
        )

    async def stop(self) -> None:
        if self._server is None:
            return
        self._server.close()
        await self._server.wait_closed()
        self._server = None

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        upstream_writer: asyncio.StreamWriter | None = None
        try:
            header = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10)
            if len(header) > 65_536:
                raise BrowserBoundaryError("proxy_request_too_large", "Browser proxy request is too large.")
            request_line, headers = _parse_proxy_header(header)
            method, target, version = request_line
            if method == "CONNECT":
                hostname, port = _parse_authority(target, 443)
                upstream_reader, upstream_writer = await open_pinned_public_connection(
                    hostname,
                    port,
                    resolver=self._resolver,
                    connector=self._connector,
                )
                writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
                await writer.drain()
            else:
                parsed = urlparse(target)
                if parsed.scheme.lower() != "http" or not parsed.hostname:
                    raise BrowserBoundaryError(
                        "unsafe_url",
                        "Plain proxy requests require an absolute HTTP URL.",
                    )
                if parsed.username is not None or parsed.password is not None:
                    raise BrowserBoundaryError("unsafe_url", "Browser URLs cannot contain credentials.")
                port = parsed.port or 80
                upstream_reader, upstream_writer = await open_pinned_public_connection(
                    parsed.hostname,
                    port,
                    resolver=self._resolver,
                    connector=self._connector,
                )
                origin_target = parsed.path or "/"
                if parsed.query:
                    origin_target += f"?{parsed.query}"
                upstream_writer.write(
                    _origin_request(method, origin_target, version, headers)
                )
                await upstream_writer.drain()
            await _relay_bidirectional(reader, writer, upstream_reader, upstream_writer)
        except BrowserBoundaryError as exc:
            if self._on_boundary_error:
                self._on_boundary_error(exc)
            if not writer.is_closing():
                writer.write(b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
        except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, asyncio.TimeoutError, OSError):
            if not writer.is_closing():
                writer.write(b"HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
                await writer.drain()
        finally:
            if upstream_writer and not upstream_writer.is_closing():
                upstream_writer.close()
                await upstream_writer.wait_closed()
            if not writer.is_closing():
                writer.close()
                await writer.wait_closed()


def _parse_proxy_header(header: bytes) -> tuple[tuple[str, str, str], list[tuple[str, str]]]:
    try:
        lines = header.decode("iso-8859-1").split("\r\n")
        method, target, version = lines[0].split(" ", 2)
    except (UnicodeDecodeError, ValueError) as exc:
        raise BrowserBoundaryError("proxy_request_invalid", "Browser proxy request is invalid.") from exc
    method = method.upper()
    if method not in {"CONNECT", "GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"}:
        raise BrowserBoundaryError("proxy_method_blocked", "Browser proxy method is blocked.")
    if version not in {"HTTP/1.0", "HTTP/1.1"}:
        raise BrowserBoundaryError("proxy_request_invalid", "Browser proxy version is invalid.")
    parsed_headers: list[tuple[str, str]] = []
    for line in lines[1:]:
        if not line:
            continue
        if ":" not in line:
            raise BrowserBoundaryError("proxy_request_invalid", "Browser proxy header is invalid.")
        name, value = line.split(":", 1)
        if not name or any(character.isspace() for character in name):
            raise BrowserBoundaryError("proxy_request_invalid", "Browser proxy header name is invalid.")
        parsed_headers.append((name, value.lstrip()))
    return (method, target, version), parsed_headers


def _parse_authority(authority: str, default_port: int) -> tuple[str, int]:
    parsed = urlparse(f"//{authority}")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise BrowserBoundaryError("unsafe_url", "Browser proxy authority is invalid.")
    try:
        port = parsed.port or default_port
    except ValueError as exc:
        raise BrowserBoundaryError("unsafe_url", "Browser proxy port is invalid.") from exc
    return parsed.hostname, port


def _origin_request(
    method: str,
    target: str,
    version: str,
    headers: list[tuple[str, str]],
) -> bytes:
    output = [f"{method} {target} {version}"]
    for name, value in headers:
        if name.lower() in {"proxy-connection", "connection"}:
            continue
        output.append(f"{name}: {value}")
    output.extend(["Connection: close", "", ""])
    return "\r\n".join(output).encode("iso-8859-1")


async def _relay_bidirectional(
    client_reader: asyncio.StreamReader,
    client_writer: asyncio.StreamWriter,
    upstream_reader: asyncio.StreamReader,
    upstream_writer: asyncio.StreamWriter,
) -> None:
    async def relay(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        while True:
            chunk = await reader.read(65_536)
            if not chunk:
                return
            writer.write(chunk)
            await writer.drain()

    tasks = {
        asyncio.create_task(relay(client_reader, upstream_writer)),
        asyncio.create_task(relay(upstream_reader, client_writer)),
    }
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*done, *pending, return_exceptions=True)


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
