from __future__ import annotations

import pytest
from pydantic import SecretStr

from secure_store import (
    SecretStore,
    is_proven_os_keyring,
    probe_secret_backend,
)

from conftest import FakeKeyringBackend


def test_persistent_secret_store_round_trip_and_readback_delete(tmp_path):
    database = tmp_path / "secrets.sqlite3"
    backend = FakeKeyringBackend()
    store = SecretStore(database, backend=backend)
    store.initialize()
    raw_secret = "linear-oauth-refresh-token"
    try:
        description = store.put(
            SecretStr(raw_secret), "Linear OAuth", {"actor": "application"}
        )
        assert description.persistent is True
        assert description.backend == "fake-os-keyring"
        assert "value" not in description.model_dump()
        assert store.describe(description.referenceId) == description

        lease = store.lease(description.referenceId, 30)
        assert lease.value == raw_secret
        assert raw_secret.encode() not in database.read_bytes()
        assert store.remove(description.referenceId) is True
        assert store.remove(description.referenceId) is False
        with pytest.raises(KeyError):
            store.describe(description.referenceId)
    finally:
        store.close()


def test_persistent_secret_metadata_survives_restart_without_plaintext(tmp_path):
    database = tmp_path / "secrets.sqlite3"
    backend = FakeKeyringBackend()
    first = SecretStore(database, backend=backend)
    first.initialize()
    description = first.put(SecretStr("pat-secret"), "GitHub PAT")
    first.close()

    second = SecretStore(database, backend=backend)
    second.initialize()
    try:
        assert second.describe(description.referenceId).label == "GitHub PAT"
        assert second.lease(description.referenceId, 10).value == "pat-secret"
    finally:
        second.close()


def test_session_fallback_is_foreground_only_and_disappears_on_close(tmp_path):
    database = tmp_path / "secrets.sqlite3"
    first = SecretStore(
        database, backend=None, detect_backend=False, allow_session_fallback=True
    )
    first.initialize()
    description = first.put(SecretStr("temporary"), "Foreground only")
    assert description.persistent is False
    first.close()

    second = SecretStore(
        database, backend=None, detect_backend=False, allow_session_fallback=True
    )
    second.initialize()
    try:
        with pytest.raises(KeyError):
            second.describe(description.referenceId)
    finally:
        second.close()

    blocked = SecretStore(
        tmp_path / "blocked.sqlite3",
        backend=None,
        detect_backend=False,
        allow_session_fallback=False,
    )
    blocked.initialize()
    try:
        with pytest.raises(RuntimeError, match="persistent"):
            blocked.put(SecretStr("not-stored"), "Blocked")
    finally:
        blocked.close()


def test_only_explicit_os_keyrings_are_eligible_for_background_persistence():
    safe_type = type("WinVaultKeyring", (), {})
    safe_type.__module__ = "keyring.backends.Windows"
    unsafe_type = type("PlaintextKeyring", (), {})
    unsafe_type.__module__ = "keyrings.alt.file"
    assert is_proven_os_keyring(safe_type(), system="Windows") is True
    assert is_proven_os_keyring(unsafe_type(), system="Windows") is False
    assert is_proven_os_keyring(safe_type(), system="Linux") is False


def test_keyring_probe_requires_write_read_delete_readback():
    healthy = FakeKeyringBackend()
    assert probe_secret_backend(healthy) is True
    assert healthy.values == {}

    class Undeletable(FakeKeyringBackend):
        def delete_password(self, service: str, username: str) -> None:
            return None

    broken = Undeletable()
    assert probe_secret_backend(broken) is False
