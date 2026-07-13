from __future__ import annotations

import hmac
import ipaddress
import secrets
from dataclasses import dataclass, field
from typing import Iterable

from fastapi import Request
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send


DEFAULT_MAX_BODY_BYTES = 1_048_576
HOST_APPROVAL_MAX_BODY_BYTES = 16_384
_CLOSED_ROUTE_BODY_LIMITS = {
    "/host-approval-signer/provision": 1_024,
    "/host-approval-signer/rotate": 1_024,
    "/host-approval-signer/sign": HOST_APPROVAL_MAX_BODY_BYTES,
    "/host-approval-signer/verify": HOST_APPROVAL_MAX_BODY_BYTES,
}


def generate_bootstrap_token() -> str:
    """Return a URL-safe token with 256 bits of entropy."""

    return secrets.token_urlsafe(32)


def is_loopback_host(host: str) -> bool:
    normalized = host.strip().strip("[]").lower()
    if normalized == "localhost":
        return True
    try:
        return ipaddress.ip_address(normalized).is_loopback
    except ValueError:
        return False


@dataclass(frozen=True)
class CompanionSecurityConfig:
    bootstrap_token: str = field(default_factory=generate_bootstrap_token, repr=False)
    bind_host: str = "127.0.0.1"
    max_body_bytes: int = DEFAULT_MAX_BODY_BYTES
    trusted_origins: tuple[str, ...] = ()
    allow_test_client: bool = False

    def __post_init__(self) -> None:
        if not is_loopback_host(self.bind_host):
            raise ValueError("The companion may bind only to a loopback address.")
        if len(self.bootstrap_token.encode("utf-8")) < 32:
            raise ValueError("The bootstrap token must contain at least 256 bits of material.")
        if self.max_body_bytes < 1_024 or self.max_body_bytes > 16 * 1_048_576:
            raise ValueError("max_body_bytes must be between 1 KiB and 16 MiB.")


class CompanionBoundaryMiddleware:
    """Authenticate and constrain every HTTP endpoint before request parsing."""

    def __init__(self, app: ASGIApp, config: CompanionSecurityConfig):
        self.app = app
        self.config = config

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        if not self._is_allowed_client(scope):
            await self._reject(scope, receive, send, 403, "loopback_client_required")
            return

        headers = {
            key.decode("latin-1").lower(): value.decode("latin-1")
            for key, value in scope.get("headers", [])
        }
        origin = headers.get("origin")
        if origin and origin not in self.config.trusted_origins:
            await self._reject(scope, receive, send, 403, "browser_origin_not_allowed")
            return

        supplied = self._bearer_token(headers.get("authorization", ""))
        if not supplied or not hmac.compare_digest(supplied, self.config.bootstrap_token):
            await self._reject(scope, receive, send, 401, "authentication_required")
            return

        request_body_limit = min(
            self.config.max_body_bytes,
            _CLOSED_ROUTE_BODY_LIMITS.get(
                str(scope.get("path", "")), self.config.max_body_bytes
            ),
        )
        content_length = headers.get("content-length")
        if content_length:
            try:
                if int(content_length) > request_body_limit:
                    await self._reject(scope, receive, send, 413, "request_body_too_large")
                    return
            except ValueError:
                await self._reject(scope, receive, send, 400, "invalid_content_length")
                return

        replay = await self._buffer_limited_body(receive, request_body_limit)
        if replay is None:
            await self._reject(scope, receive, send, 413, "request_body_too_large")
            return
        response_send = send
        if str(scope.get("path", "")).startswith("/host-approval-signer"):

            async def no_store_send(message: Message) -> None:
                if message["type"] == "http.response.start":
                    headers = [
                        (key, value)
                        for key, value in message.get("headers", [])
                        if key.lower() != b"cache-control"
                    ]
                    headers.append((b"cache-control", b"no-store"))
                    message = {**message, "headers": headers}
                await send(message)

            response_send = no_store_send
        await self.app(scope, replay, response_send)

    def _is_allowed_client(self, scope: Scope) -> bool:
        client = scope.get("client")
        if not client:
            return False
        host = str(client[0])
        return is_loopback_host(host) or (self.config.allow_test_client and host == "testclient")

    async def _buffer_limited_body(
        self, receive: Receive, max_body_bytes: int
    ) -> Receive | None:
        messages: list[Message] = []
        received = 0
        while True:
            message = await receive()
            messages.append(message)
            if message["type"] == "http.disconnect":
                break
            if message["type"] != "http.request":
                continue
            received += len(message.get("body", b""))
            if received > max_body_bytes:
                return None
            if not message.get("more_body", False):
                break

        index = 0

        async def replay() -> Message:
            nonlocal index
            if index < len(messages):
                message = messages[index]
                index += 1
                return message
            return await receive()

        return replay

    @staticmethod
    def _bearer_token(value: str) -> str | None:
        scheme, separator, token = value.partition(" ")
        if separator and scheme.lower() == "bearer" and token:
            return token
        return None

    @staticmethod
    async def _reject(
        scope: Scope,
        receive: Receive,
        send: Send,
        status_code: int,
        code: str,
    ) -> None:
        response = JSONResponse(
            status_code=status_code,
            content={"ok": False, "error": code},
            headers={"Cache-Control": "no-store"},
        )
        if status_code == 401:
            response.headers["WWW-Authenticate"] = "Bearer"
        await response(scope, receive, send)


def authenticated_headers(token: str) -> dict[str, str]:
    """Test/client helper which never logs or persists the supplied token."""

    return {"Authorization": f"Bearer {token}"}


def require_no_browser_origin(request: Request, allowed: Iterable[str] = ()) -> None:
    """Defense-in-depth helper for callers embedding selected routes elsewhere."""

    origin = request.headers.get("origin")
    if origin and origin not in set(allowed):
        raise PermissionError("Browser origins are not accepted by the companion.")
