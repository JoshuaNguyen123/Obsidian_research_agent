from __future__ import annotations

import os
import plistlib
import platform
import secrets
import shutil
import subprocess
import sys
from xml.sax.saxutils import escape
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Literal

from pydantic import SecretStr

from secure_store import SERVICE_NAME, SecretBackend, detect_keyring_backend
from host_approval_signer import HOST_APPROVAL_SIGNING_KEY_ACCOUNT
from runtime_preflight import require_runtime, verify_runtime
from config import validate_approved_data_boundary


SERVICE_ACCOUNT = "bootstrap-token"
SERVICE_ID = "agentic-researcher-companion"
MAC_LABEL = "com.openai.agentic-researcher-companion"


@dataclass(frozen=True)
class ServiceSpec:
    platform: Literal["windows", "macos", "linux"]
    artifact_path: Path | None
    artifact_content: str | bytes | None
    install_commands: tuple[tuple[str, ...], ...]
    uninstall_commands: tuple[tuple[str, ...], ...]
    companion_dir: Path
    approved_data_root: Path
    data_dir: Path
    code_data_root: Path
    integrations_data_root: Path
    python_executable: Path
    node_executable: Path
    executor_config_path: Path


@dataclass(frozen=True)
class BootstrapProvision:
    account: str
    token: SecretStr
    created: bool


def provision_bootstrap_token(backend: SecretBackend | None = None) -> BootstrapProvision:
    backend = backend or detect_keyring_backend()
    if not backend:
        raise RuntimeError(
            "A persistent OS credential backend is required for background service installation."
        )
    existing = backend.get_password(SERVICE_NAME, SERVICE_ACCOUNT)
    if existing:
        return BootstrapProvision(
            account=SERVICE_ACCOUNT, token=SecretStr(existing), created=False
        )
    token = secrets.token_urlsafe(32)
    backend.set_password(SERVICE_NAME, SERVICE_ACCOUNT, token)
    if backend.get_password(SERVICE_NAME, SERVICE_ACCOUNT) != token:
        try:
            backend.delete_password(SERVICE_NAME, SERVICE_ACCOUNT)
        finally:
            raise RuntimeError("Bootstrap token secure-store readback failed.")
    return BootstrapProvision(account=SERVICE_ACCOUNT, token=SecretStr(token), created=True)


def load_bootstrap_token(backend: SecretBackend | None = None) -> SecretStr:
    backend = backend or detect_keyring_backend()
    if not backend:
        raise RuntimeError("The OS credential backend is unavailable.")
    token = backend.get_password(SERVICE_NAME, SERVICE_ACCOUNT)
    if not token:
        raise RuntimeError("The companion bootstrap token has not been provisioned.")
    return SecretStr(token)


def build_service_spec(
    companion_dir: Path,
    data_dir: Path,
    approved_data_root: Path,
    python_executable: Path | None = None,
    node_executable: Path | None = None,
    port: int = 8765,
    target_platform: str | None = None,
    home: Path | None = None,
) -> ServiceSpec:
    if not 1 <= port <= 65_535:
        raise ValueError("port must be between 1 and 65535")
    python_executable = (python_executable or Path(sys.executable)).resolve()
    discovered_node = node_executable or (
        Path(found) if (found := shutil.which("node")) else None
    )
    if discovered_node is None:
        raise RuntimeError(
            "node_runtime_missing:absolute_executable_required. Provision the exact runtime in runtime-lock.json."
        )
    node_executable = discovered_node.resolve()
    companion_dir = companion_dir.resolve()
    approved_data_root, data_dir = validate_approved_data_boundary(
        approved_data_root, data_dir
    )
    _approved_root, code_data_root = validate_approved_data_boundary(
        approved_data_root, approved_data_root / "code"
    )
    _approved_root, integrations_data_root = validate_approved_data_boundary(
        approved_data_root, approved_data_root / "integrations"
    )
    launcher = (companion_dir / "service_launcher.py").resolve()
    executor_config = data_dir / "worker-executors.json"
    if not launcher.is_relative_to(companion_dir):
        raise ValueError("The service launcher must remain inside the companion directory.")
    system = (target_platform or platform.system()).lower()
    home = (home or Path.home()).resolve()
    common_args = (
        str(python_executable),
        str(launcher),
        "--data-dir",
        str(data_dir),
        "--approved-data-root",
        str(approved_data_root),
        "--port",
        str(port),
        "--node-executable",
        str(node_executable),
        "--executor-config",
        str(executor_config),
        "--code-data-root",
        str(code_data_root),
        "--integrations-data-root",
        str(integrations_data_root),
    )

    if system.startswith("win"):
        artifact_path = data_dir / "service" / f"{SERVICE_ID}-task.xml"
        arguments = subprocess.list2cmdline(common_args[1:])
        task_xml = """<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers><LogonTrigger><Enabled>true</Enabled></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><Hidden>true</Hidden></Settings>
  <Actions Context="Author"><Exec><Command>%s</Command><Arguments>%s</Arguments><WorkingDirectory>%s</WorkingDirectory></Exec></Actions>
</Task>
""" % (
            escape(str(python_executable)),
            escape(arguments),
            escape(str(companion_dir)),
        )
        return ServiceSpec(
            platform="windows",
            artifact_path=artifact_path,
            artifact_content=task_xml.encode("utf-16"),
            install_commands=(
                (
                    "schtasks.exe",
                    "/Create",
                    "/F",
                    "/TN",
                    SERVICE_ID,
                    "/XML",
                    str(artifact_path),
                ),
                ("schtasks.exe", "/Run", "/TN", SERVICE_ID),
            ),
            uninstall_commands=(
                ("schtasks.exe", "/End", "/TN", SERVICE_ID),
                ("schtasks.exe", "/Delete", "/F", "/TN", SERVICE_ID),
            ),
            companion_dir=companion_dir,
            approved_data_root=approved_data_root,
            data_dir=data_dir,
            code_data_root=code_data_root,
            integrations_data_root=integrations_data_root,
            python_executable=python_executable,
            node_executable=node_executable,
            executor_config_path=executor_config,
        )

    if system == "darwin":
        uid = os.getuid() if hasattr(os, "getuid") else int(os.getenv("UID", "501"))
        artifact_path = home / "Library" / "LaunchAgents" / f"{MAC_LABEL}.plist"
        plist = {
            "Label": MAC_LABEL,
            "ProgramArguments": list(common_args),
            "WorkingDirectory": str(companion_dir),
            "RunAtLoad": True,
            "KeepAlive": {"SuccessfulExit": False},
            "ProcessType": "Background",
        }
        return ServiceSpec(
            platform="macos",
            artifact_path=artifact_path,
            artifact_content=plistlib.dumps(plist, sort_keys=True),
            install_commands=(
                ("launchctl", "bootstrap", f"gui/{uid}", str(artifact_path)),
                ("launchctl", "kickstart", "-k", f"gui/{uid}/{MAC_LABEL}"),
            ),
            uninstall_commands=(
                ("launchctl", "bootout", f"gui/{uid}", str(artifact_path)),
            ),
            companion_dir=companion_dir,
            approved_data_root=approved_data_root,
            data_dir=data_dir,
            code_data_root=code_data_root,
            integrations_data_root=integrations_data_root,
            python_executable=python_executable,
            node_executable=node_executable,
            executor_config_path=executor_config,
        )

    if system == "linux":
        artifact_path = home / ".config" / "systemd" / "user" / f"{SERVICE_ID}.service"
        executable = _systemd_quote(str(python_executable))
        arguments = " ".join(_systemd_quote(value) for value in common_args[1:])
        isolation_paths = [
            f"BindPaths={data_dir}",
            f"BindPaths={code_data_root}",
            f"BindPaths={integrations_data_root}",
        ]
        if not companion_dir.is_relative_to(data_dir):
            isolation_paths.append(f"BindReadOnlyPaths={companion_dir}")
        content = "\n".join(
            [
                "[Unit]",
                "Description=Agentic Researcher local companion",
                "After=network.target",
                "",
                "[Service]",
                "Type=simple",
                f"WorkingDirectory={companion_dir}",
                f"ExecStart={executable} {arguments}",
                "Restart=on-failure",
                "NoNewPrivileges=true",
                "PrivateTmp=true",
                "ProtectSystem=strict",
                "ProtectHome=tmpfs",
                *isolation_paths,
                f"ReadWritePaths={data_dir}",
                f"ReadWritePaths={code_data_root}",
                f"ReadWritePaths={integrations_data_root}",
                "",
                "[Install]",
                "WantedBy=default.target",
                "",
            ]
        )
        return ServiceSpec(
            platform="linux",
            artifact_path=artifact_path,
            artifact_content=content,
            install_commands=(
                ("systemctl", "--user", "daemon-reload"),
                ("systemctl", "--user", "enable", "--now", f"{SERVICE_ID}.service"),
            ),
            uninstall_commands=(
                ("systemctl", "--user", "disable", "--now", f"{SERVICE_ID}.service"),
                ("systemctl", "--user", "daemon-reload"),
            ),
            companion_dir=companion_dir,
            approved_data_root=approved_data_root,
            data_dir=data_dir,
            code_data_root=code_data_root,
            integrations_data_root=integrations_data_root,
            python_executable=python_executable,
            node_executable=node_executable,
            executor_config_path=executor_config,
        )

    raise ValueError(f"Unsupported service platform: {system}")


def install_service(
    spec: ServiceSpec,
    backend: SecretBackend | None = None,
    *,
    run_preflight: bool = True,
) -> None:
    _validate_spec_data_boundary(spec)
    spec.code_data_root.mkdir(parents=True, exist_ok=True)
    spec.integrations_data_root.mkdir(parents=True, exist_ok=True)
    _validate_spec_data_boundary(spec)
    if run_preflight:
        require_runtime(spec.companion_dir, spec.node_executable)
    provision_bootstrap_token(backend)
    _validate_spec_data_boundary(spec)
    _write_executor_config(spec.executor_config_path)
    if spec.artifact_path and spec.artifact_content is not None:
        _validate_spec_data_boundary(spec)
        spec.artifact_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = spec.artifact_path.with_suffix(spec.artifact_path.suffix + ".tmp")
        if isinstance(spec.artifact_content, bytes):
            temporary.write_bytes(spec.artifact_content)
        else:
            temporary.write_text(spec.artifact_content, encoding="utf-8", newline="\n")
        temporary.replace(spec.artifact_path)
        if isinstance(spec.artifact_content, bytes):
            if spec.artifact_path.read_bytes() != spec.artifact_content:
                raise RuntimeError("Service definition readback failed.")
        elif spec.artifact_path.read_text(encoding="utf-8") != spec.artifact_content:
            raise RuntimeError("Service definition readback failed.")
    for command in spec.install_commands:
        _validate_spec_data_boundary(spec)
        subprocess.run(command, check=True, shell=False)


def uninstall_service(
    spec: ServiceSpec,
    backend: SecretBackend | None = None,
    remove_bootstrap_token: bool = False,
    remove_host_approval_signing_key: bool = False,
) -> None:
    _validate_spec_data_boundary(spec)
    for command in spec.uninstall_commands:
        _validate_spec_data_boundary(spec)
        completed = subprocess.run(command, check=False, shell=False)
        if completed.returncode not in {0, 1}:
            raise RuntimeError(f"Service removal failed with exit code {completed.returncode}.")
    if spec.artifact_path and spec.artifact_path.exists():
        spec.artifact_path.unlink()
    if spec.executor_config_path.exists():
        spec.executor_config_path.unlink()
    if remove_bootstrap_token:
        selected = backend or detect_keyring_backend()
        if selected:
            _remove_keyring_account(selected, SERVICE_ACCOUNT)
    if remove_host_approval_signing_key:
        selected = backend or detect_keyring_backend()
        if not selected:
            raise RuntimeError(
                "The host approval signing key cannot be removed without the persistent OS credential backend."
            )
        _remove_keyring_account(selected, HOST_APPROVAL_SIGNING_KEY_ACCOUNT)


def _remove_keyring_account(backend: SecretBackend, account: str) -> None:
    try:
        backend.delete_password(SERVICE_NAME, account)
    except Exception:
        if backend.get_password(SERVICE_NAME, account) is not None:
            raise
    if backend.get_password(SERVICE_NAME, account) is not None:
        raise RuntimeError("Secure-store deletion readback failed.")


def service_status(
    spec: ServiceSpec,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> dict[str, str | bool | None]:
    _validate_spec_data_boundary(spec)
    if spec.platform == "windows":
        command = ("schtasks.exe", "/Query", "/TN", SERVICE_ID)
    elif spec.platform == "macos":
        uid = os.getuid() if hasattr(os, "getuid") else int(os.getenv("UID", "501"))
        command = ("launchctl", "print", f"gui/{uid}/{MAC_LABEL}")
    else:
        command = (
            "systemctl",
            "--user",
            "is-active",
            f"{SERVICE_ID}.service",
        )
    completed = runner(command, check=False, shell=False, capture_output=True, text=True)
    active = completed.returncode == 0
    preflight = verify_runtime(spec.companion_dir, spec.node_executable)
    return {
        "platform": spec.platform,
        "installed": active
        or bool(spec.artifact_path and spec.artifact_path.exists()),
        "active": active,
        "artifactPath": str(spec.artifact_path) if spec.artifact_path else None,
        "runtimeReady": preflight.ok,
        "runtimeBlocker": preflight.blocker,
        "runtimeRequiredAction": preflight.required_action,
    }


def _systemd_quote(value: str) -> str:
    # systemd supports C-style double-quoted arguments. Escape only the two
    # characters which can break that boundary.
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _write_executor_config(path: Path) -> None:
    import json

    payload = json.dumps(
        {
            "version": 1,
            "executors": {
                "research": "public_research_fetch_v1",
                "code": "verified_code_manifest_readback_v1",
                "linear": "linear_issue_readback_v1",
                "github": "github_repository_readback_v1",
            },
        },
        separators=(",", ":"),
        sort_keys=True,
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}-{secrets.token_hex(4)}")
    try:
        with temporary.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        try:
            os.chmod(temporary, 0o600)
        except OSError:
            pass
        temporary.replace(path)
        if path.read_text(encoding="utf-8") != payload:
            raise RuntimeError("Worker executor configuration readback failed.")
    finally:
        if temporary.exists():
            temporary.unlink()


def _validate_spec_data_boundary(spec: ServiceSpec) -> None:
    _root, data_dir = validate_approved_data_boundary(
        spec.approved_data_root, spec.data_dir
    )
    _root, code_data_root = validate_approved_data_boundary(
        spec.approved_data_root, spec.code_data_root
    )
    _root, integrations_data_root = validate_approved_data_boundary(
        spec.approved_data_root, spec.integrations_data_root
    )
    expected_code_root = (spec.approved_data_root / "code").resolve(strict=False)
    if code_data_root != expected_code_root:
        raise ValueError("Worker Code data root is not the pinned application-data/code directory.")
    expected_integrations_root = (
        spec.approved_data_root / "integrations"
    ).resolve(strict=False)
    if integrations_data_root != expected_integrations_root:
        raise ValueError(
            "Worker integrations data root is not the pinned application-data/integrations directory."
        )
    if not spec.executor_config_path.resolve(strict=False).is_relative_to(data_dir):
        raise ValueError("Worker executor configuration escaped companion data.")
    if spec.platform == "windows" and spec.artifact_path:
        if not spec.artifact_path.resolve(strict=False).is_relative_to(data_dir):
            raise ValueError("Windows service artifact escaped companion data.")
