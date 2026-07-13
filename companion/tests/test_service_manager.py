from __future__ import annotations

import os
import subprocess
from pathlib import Path

import pytest
from pydantic import SecretStr

import service_manager
from host_approval_signer import HOST_APPROVAL_SIGNING_KEY_ACCOUNT
from service_launcher import WorkerSupervisor, validate_worker_data_roots
from secure_store import SERVICE_NAME
from service_manager import (
    SERVICE_ACCOUNT,
    build_service_spec,
    install_service,
    load_bootstrap_token,
    provision_bootstrap_token,
    service_status,
    uninstall_service,
)

from conftest import FakeKeyringBackend


@pytest.mark.parametrize(
    ("platform_name", "expected_platform", "marker"),
    [
        ("windows", "windows", "schtasks.exe"),
        ("darwin", "macos", "launchctl"),
        ("linux", "linux", "systemctl"),
    ],
)
def test_service_specs_are_explicit_loopback_launches_without_tokens(
    tmp_path, platform_name, expected_platform, marker
):
    companion = tmp_path / "companion"
    companion.mkdir()
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (companion / "service_launcher.py").write_text("# fixture", encoding="utf-8")
    secret = "must-not-enter-service-definition"
    spec = build_service_spec(
        companion_dir=companion,
        data_dir=data_dir,
        approved_data_root=tmp_path,
        python_executable=tmp_path / "python",
        target_platform=platform_name,
        home=tmp_path / "home",
    )
    assert spec.platform == expected_platform
    serialized = repr(spec)
    assert marker in serialized
    assert secret not in serialized
    assert "AGENTIC_COMPANION_BOOTSTRAP_TOKEN" not in serialized
    definition = (
        spec.artifact_content.decode("utf-16")
        if platform_name == "windows"
        else serialized
    )
    assert "service_launcher.py" in definition
    assert spec.code_data_root == (tmp_path / "code").resolve()
    assert spec.integrations_data_root == (tmp_path / "integrations").resolve()
    assert "--code-data-root" in definition
    assert "--integrations-data-root" in definition


def test_bootstrap_token_is_random_keyring_backed_and_readable_only_by_helper():
    backend = FakeKeyringBackend()
    provisioned = provision_bootstrap_token(backend)
    token = provisioned.token.get_secret_value()
    assert provisioned.created is True
    assert len(token) >= 43
    assert backend.values[(SERVICE_NAME, SERVICE_ACCOUNT)] == token
    assert load_bootstrap_token(backend).get_secret_value() == token
    second = provision_bootstrap_token(backend)
    assert second.created is False
    assert second.token.get_secret_value() == token


def test_linux_install_remove_and_status_are_explicit_and_secret_free(
    tmp_path, monkeypatch
):
    companion = tmp_path / "companion"
    companion.mkdir()
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    (companion / "service_launcher.py").write_text("# fixture", encoding="utf-8")
    spec = build_service_spec(
        companion_dir=companion,
        data_dir=data_dir,
        approved_data_root=tmp_path,
        python_executable=tmp_path / "python",
        target_platform="linux",
        home=tmp_path / "home",
    )
    backend = FakeKeyringBackend()
    calls: list[tuple[str, ...]] = []

    def fake_run(command, **_kwargs):
        calls.append(tuple(command))
        return subprocess.CompletedProcess(command, 0, stdout="active", stderr="")

    monkeypatch.setattr(service_manager.subprocess, "run", fake_run)
    install_service(spec, backend, run_preflight=False)
    assert spec.artifact_path and spec.artifact_path.exists()
    token = backend.values[(SERVICE_NAME, SERVICE_ACCOUNT)]
    assert token not in spec.artifact_path.read_text(encoding="utf-8")
    assert all(token not in repr(command) for command in calls)
    assert spec.executor_config_path.read_text(encoding="utf-8") == (
        '{"executors":{"code":"verified_code_manifest_readback_v1","github":"github_repository_readback_v1","linear":"linear_issue_readback_v1","research":"public_research_fetch_v1"},"version":1}'
    )
    assert "ProtectHome=tmpfs" in (spec.artifact_path.read_text(encoding="utf-8"))

    status = service_status(spec, runner=fake_run)
    assert status["installed"] is True
    assert status["active"] is True

    signer_key = "host-signer-key-material-that-must-survive-normal-removal"
    backend.set_password(
        SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT, signer_key
    )
    uninstall_service(spec, backend, remove_bootstrap_token=True)
    assert not spec.artifact_path.exists()
    assert not spec.executor_config_path.exists()
    assert (SERVICE_NAME, SERVICE_ACCOUNT) not in backend.values
    assert backend.values[(SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT)] == signer_key

    uninstall_service(
        spec,
        backend,
        remove_host_approval_signing_key=True,
    )
    assert (SERVICE_NAME, HOST_APPROVAL_SIGNING_KEY_ACCOUNT) not in backend.values


def test_windows_long_paths_use_task_xml_not_tr_command(tmp_path):
    long_segment = "agentic-companion-" + "x" * 90
    companion = tmp_path / long_segment / long_segment / "runtime"
    companion.mkdir(parents=True)
    (companion / "service_launcher.py").write_text("# fixture", encoding="utf-8")
    data_dir = tmp_path / long_segment / long_segment / "data"
    data_dir.mkdir()
    spec = build_service_spec(
        companion_dir=companion,
        data_dir=data_dir,
        approved_data_root=tmp_path,
        python_executable=tmp_path / long_segment / "python.exe",
        node_executable=tmp_path / long_segment / "node.exe",
        target_platform="windows",
        home=tmp_path,
    )
    create = spec.install_commands[0]
    assert "/XML" in create
    assert "/TR" not in create
    xml = spec.artifact_content.decode("utf-16")
    assert str(spec.node_executable) in xml
    assert "AGENTIC_COMPANION_BOOTSTRAP_TOKEN" not in xml


def test_service_spec_rejects_data_outside_approved_root(tmp_path):
    approved_root = tmp_path / "approved"
    approved_root.mkdir()
    outside = tmp_path / "outside"
    outside.mkdir()
    companion = tmp_path / "companion"
    companion.mkdir()
    (companion / "service_launcher.py").write_text("# fixture", encoding="utf-8")

    with pytest.raises(ValueError, match="approved application-data root"):
        build_service_spec(
            companion_dir=companion,
            data_dir=outside,
            approved_data_root=approved_root,
            python_executable=tmp_path / "python",
            node_executable=tmp_path / "node",
            target_platform="linux",
            home=tmp_path / "home",
        )


def test_launcher_rejects_code_or_integrations_root_drift(tmp_path):
    approved_root = tmp_path / "approved"
    code_root = approved_root / "code"
    integrations_root = approved_root / "integrations"
    code_root.mkdir(parents=True)
    integrations_root.mkdir()
    assert validate_worker_data_roots(
        approved_root, code_root, integrations_root
    ) == (code_root.resolve(), integrations_root.resolve())
    with pytest.raises(RuntimeError, match="pinned application-data/code"):
        validate_worker_data_roots(
            approved_root, approved_root / "wrong-code", integrations_root
        )
    with pytest.raises(RuntimeError, match="application-data/integrations"):
        validate_worker_data_roots(
            approved_root, code_root, approved_root / "wrong-integrations"
        )


def test_install_revalidates_data_boundary_after_link_swap(tmp_path):
    approved_root = tmp_path / "approved"
    data_dir = approved_root / "data"
    data_dir.mkdir(parents=True)
    outside = tmp_path / "outside"
    outside.mkdir()
    companion = tmp_path / "companion"
    companion.mkdir()
    (companion / "service_launcher.py").write_text("# fixture", encoding="utf-8")
    spec = build_service_spec(
        companion_dir=companion,
        data_dir=data_dir,
        approved_data_root=approved_root,
        python_executable=tmp_path / "python",
        node_executable=tmp_path / "node",
        target_platform="linux",
        home=tmp_path / "home",
    )

    original = approved_root / "data-original"
    data_dir.rename(original)
    try:
        os.symlink(outside, data_dir, target_is_directory=True)
    except OSError as exc:
        original.rename(data_dir)
        pytest.skip(f"Directory symlinks are unavailable for this boundary test: {exc}")
    with pytest.raises(ValueError, match="canonical|links|reparse"):
        install_service(spec, FakeKeyringBackend(), run_preflight=False)


def test_worker_supervisor_passes_stable_coordinator_and_token_only_over_stdin(tmp_path):
    captured = {}

    class Pipe:
        def __init__(self):
            self.data = bytearray()

        def write(self, value):
            self.data.extend(value)

        def flush(self):
            return None

        def close(self):
            return None

        def read(self, _size):
            return b""

    class Process:
        def __init__(self):
            self.stdin = Pipe()
            self.stdout = Pipe()
            self.stderr = Pipe()
            self.done = False

        def wait(self, timeout=None):
            self.done = True
            supervisor._stop.set()
            return 1

        def poll(self):
            return 1 if self.done else None

        def terminate(self):
            self.done = True

        def kill(self):
            self.done = True

    def popen(command, **kwargs):
        captured["command"] = tuple(command)
        captured["env"] = dict(kwargs["env"])
        captured["process"] = Process()
        return captured["process"]

    token = "worker-bootstrap-token-material-1234567890"
    supervisor = WorkerSupervisor(
        node_executable=tmp_path / "node",
        worker_script=tmp_path / "standalone-worker.cjs",
        base_url="http://127.0.0.1:8765",
        executor_config=tmp_path / "worker-executors.json",
        code_application_data_root=tmp_path / "code",
        integrations_application_data_root=tmp_path / "integrations",
        bootstrap_token=SecretStr(token),
        popen=popen,
    )
    supervisor.start()
    supervisor._thread.join(timeout=5)
    command = captured["command"]
    assert command[command.index("--coordinator-id") + 1] == (
        "agentic-researcher-service-worker"
    )
    assert command[command.index("--code-application-data-root") + 1] == str(
        (tmp_path / "code").resolve()
    )
    assert command[command.index("--integrations-application-data-root") + 1] == str(
        (tmp_path / "integrations").resolve()
    )
    assert token not in repr(command)
    assert token not in repr(captured["env"])
    assert captured["process"].stdin.data == token.encode()
    supervisor.stop()
