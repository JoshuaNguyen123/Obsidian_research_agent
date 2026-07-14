from __future__ import annotations

import datetime as dt
import json
import platform
import secrets
import sqlite3
import threading
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from pydantic import SecretStr

from schemas import SecretDescription, SecretLeaseResponse


SERVICE_NAME = "agentic-researcher-companion"


class SecretBackend(Protocol):
    name: str

    def get_password(self, service: str, username: str) -> str | None: ...

    def set_password(self, service: str, username: str, password: str) -> None: ...

    def delete_password(self, service: str, username: str) -> None: ...


class KeyringBackend:
    """Small adapter that keeps keyring types out of persisted/plugin state."""

    def __init__(self, backend: object):
        self.backend = backend
        self.name = f"keyring:{backend.__class__.__module__}.{backend.__class__.__name__}"

    def get_password(self, service: str, username: str) -> str | None:
        return self.backend.get_password(service, username)  # type: ignore[attr-defined]

    def set_password(self, service: str, username: str, password: str) -> None:
        self.backend.set_password(service, username, password)  # type: ignore[attr-defined]

    def delete_password(self, service: str, username: str) -> None:
        self.backend.delete_password(service, username)  # type: ignore[attr-defined]


def detect_keyring_backend() -> SecretBackend | None:
    try:
        import keyring

        backend = keyring.get_keyring()
        priority = float(getattr(backend, "priority", 0))
        if priority <= 0 or not is_proven_os_keyring(backend):
            return None
        wrapped = KeyringBackend(backend)
        return wrapped if probe_secret_backend(wrapped) else None
    except Exception:
        return None


def is_proven_os_keyring(backend: object, system: str | None = None) -> bool:
    identity = f"{backend.__class__.__module__}.{backend.__class__.__name__}"
    selected = (system or platform.system()).lower()
    allowed = {
        "windows": {"keyring.backends.Windows.WinVaultKeyring"},
        "darwin": {"keyring.backends.macOS.Keyring"},
        "linux": {
            "keyring.backends.SecretService.Keyring",
            "keyring.backends.kwallet.DBusKeyring",
            "keyring.backends.kwallet.DBusKeyringKWallet4",
            "keyring.backends.kwallet.DBusKeyringKWallet5",
        },
    }
    platform_key = "windows" if selected.startswith("win") else selected
    return identity in allowed.get(platform_key, set())


def probe_secret_backend(backend: SecretBackend) -> bool:
    account = f"probe-{uuid.uuid4()}"
    value = secrets.token_urlsafe(32)
    try:
        backend.set_password(SERVICE_NAME, account, value)
        if backend.get_password(SERVICE_NAME, account) != value:
            return False
        backend.delete_password(SERVICE_NAME, account)
        return backend.get_password(SERVICE_NAME, account) is None
    except Exception:
        return False
    finally:
        try:
            if backend.get_password(SERVICE_NAME, account) is not None:
                backend.delete_password(SERVICE_NAME, account)
        except Exception:
            pass


@dataclass
class _SessionSecret:
    value: SecretStr
    description: SecretDescription


@dataclass
class _Lease:
    lease_id: str
    reference_id: str
    value: SecretStr
    expires_at: dt.datetime


class SecretStore:
    """SecretStoreV1 boundary: opaque references with short, in-memory leases."""

    def __init__(
        self,
        metadata_db_path: Path,
        backend: SecretBackend | None = None,
        allow_session_fallback: bool = True,
        detect_backend: bool = True,
    ):
        self.metadata_db_path = metadata_db_path
        self.backend = (
            backend
            if backend is not None
            else detect_keyring_backend()
            if detect_backend
            else None
        )
        self.allow_session_fallback = allow_session_fallback
        self.conn: sqlite3.Connection | None = None
        self.ready = False
        self._session: dict[str, _SessionSecret] = {}
        self._leases: dict[str, _Lease] = {}
        self._lock = threading.RLock()

    @property
    def persistent(self) -> bool:
        return self.backend is not None

    @property
    def backend_name(self) -> str:
        if self.backend:
            return self.backend.name
        return "session-memory" if self.allow_session_fallback else "unavailable"

    def initialize(self) -> None:
        self.metadata_db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.metadata_db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA busy_timeout=5000")
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS secret_references (
              reference_id TEXT PRIMARY KEY,
              label TEXT NOT NULL,
              metadata_json TEXT NOT NULL,
              backend TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """
        )
        self.conn.commit()
        self.ready = True

    def close(self) -> None:
        with self._lock:
            self._session.clear()
            self._leases.clear()
            if self.conn:
                self.conn.close()
            self.conn = None
            self.ready = False

    def put(
        self,
        value: SecretStr,
        label: str,
        metadata: dict[str, str] | None = None,
    ) -> SecretDescription:
        metadata = metadata or {}
        reference_id = f"secret_{uuid.uuid4()}"
        now = _now()
        if self.backend:
            self.backend.set_password(
                SERVICE_NAME, reference_id, value.get_secret_value()
            )
            description = SecretDescription(
                referenceId=reference_id,
                label=label,
                metadata=metadata,
                backend=self.backend.name,
                persistent=True,
                createdAt=now,
                updatedAt=now,
            )
            try:
                self._conn().execute(
                    """
                    INSERT INTO secret_references (
                      reference_id, label, metadata_json, backend, created_at, updated_at
                    ) VALUES (?, ?, ?, ?, ?, ?)
                    """,
                    (
                        reference_id,
                        label,
                        json.dumps(metadata, sort_keys=True),
                        self.backend.name,
                        now,
                        now,
                    ),
                )
                self._conn().commit()
            except Exception:
                try:
                    self.backend.delete_password(SERVICE_NAME, reference_id)
                finally:
                    raise
            return description

        if not self.allow_session_fallback:
            raise RuntimeError("No secure persistent credential backend is available.")
        description = SecretDescription(
            referenceId=reference_id,
            label=label,
            metadata=metadata,
            backend="session-memory",
            persistent=False,
            createdAt=now,
            updatedAt=now,
        )
        self._session[reference_id] = _SessionSecret(value=value, description=description)
        return description

    def describe(self, reference_id: str) -> SecretDescription:
        session = self._session.get(reference_id)
        if session:
            return session.description
        row = self._conn().execute(
            "SELECT * FROM secret_references WHERE reference_id = ?", (reference_id,)
        ).fetchone()
        if not row:
            raise KeyError(reference_id)
        return SecretDescription(
            referenceId=row["reference_id"],
            label=row["label"],
            metadata=json.loads(row["metadata_json"]),
            backend=row["backend"],
            persistent=True,
            createdAt=row["created_at"],
            updatedAt=row["updated_at"],
        )

    def lease(self, reference_id: str, ttl_seconds: int) -> SecretLeaseResponse:
        self._purge_expired_leases()
        description = self.describe(reference_id)
        if description.persistent:
            if not self.backend:
                raise RuntimeError("The persistent credential backend is unavailable.")
            raw = self.backend.get_password(SERVICE_NAME, reference_id)
            if raw is None:
                raise KeyError(reference_id)
            value = SecretStr(raw)
        else:
            value = self._session[reference_id].value
        expires = dt.datetime.now(dt.UTC) + dt.timedelta(seconds=ttl_seconds)
        lease_id = f"lease_{secrets.token_urlsafe(24)}"
        self._leases[lease_id] = _Lease(
            lease_id=lease_id,
            reference_id=reference_id,
            value=value,
            expires_at=expires,
        )
        return SecretLeaseResponse(
            leaseId=lease_id,
            referenceId=reference_id,
            value=value.get_secret_value(),
            expiresAt=expires.isoformat(),
        )

    def remove(self, reference_id: str) -> bool:
        self._purge_expired_leases()
        session = self._session.pop(reference_id, None)
        if session:
            self._remove_reference_leases(reference_id)
            return True
        row = self._conn().execute(
            "SELECT reference_id FROM secret_references WHERE reference_id = ?",
            (reference_id,),
        ).fetchone()
        if not row:
            return False
        if not self.backend:
            raise RuntimeError("The persistent credential backend is unavailable.")
        try:
            self.backend.delete_password(SERVICE_NAME, reference_id)
        except Exception as exc:
            # Keyring implementations differ on missing-entry errors. Readback
            # decides whether deletion actually failed.
            if self.backend.get_password(SERVICE_NAME, reference_id) is not None:
                raise RuntimeError("Secure credential deletion failed.") from exc
        if self.backend.get_password(SERVICE_NAME, reference_id) is not None:
            raise RuntimeError("Secure credential deletion readback failed.")
        self._conn().execute(
            "DELETE FROM secret_references WHERE reference_id = ?", (reference_id,)
        )
        self._conn().commit()
        self._remove_reference_leases(reference_id)
        return True

    def _remove_reference_leases(self, reference_id: str) -> None:
        for lease_id in [
            lease_id
            for lease_id, lease in self._leases.items()
            if lease.reference_id == reference_id
        ]:
            del self._leases[lease_id]

    def _purge_expired_leases(self) -> None:
        now = dt.datetime.now(dt.UTC)
        for lease_id in [
            lease_id
            for lease_id, lease in self._leases.items()
            if lease.expires_at <= now
        ]:
            del self._leases[lease_id]

    def _conn(self) -> sqlite3.Connection:
        if not self.conn:
            raise RuntimeError("Secret store is not initialized.")
        return self.conn


def _now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()
