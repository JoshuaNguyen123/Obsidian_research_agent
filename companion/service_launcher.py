from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import threading
from pathlib import Path
from typing import Callable

import uvicorn
from pydantic import SecretStr

from auth import CompanionSecurityConfig
from config import CompanionConfig, validate_approved_data_boundary
from runtime_preflight import require_runtime
from persisted_data import canonical_fingerprint
from service_manager import load_bootstrap_token


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the authenticated local companion service.")
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--approved-data-root", type=Path, required=True)
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--node-executable", type=Path, required=True)
    parser.add_argument("--executor-config", type=Path, required=True)
    parser.add_argument("--code-data-root", type=Path, required=True)
    parser.add_argument("--integrations-data-root", type=Path, required=True)
    return parser.parse_args()


class WorkerSupervisor:
    """Owns the standalone worker and its private bootstrap-token stdin pipe."""

    def __init__(
        self,
        *,
        node_executable: Path,
        worker_script: Path,
        base_url: str,
        executor_config: Path,
        code_application_data_root: Path,
        integrations_application_data_root: Path,
        bootstrap_token: SecretStr,
        boundary_validator: Callable[[], None] | None = None,
        popen: Callable[..., subprocess.Popen] = subprocess.Popen,
    ):
        self.node_executable = node_executable.resolve()
        self.worker_script = worker_script.resolve()
        self.base_url = base_url
        self.executor_config = executor_config.resolve()
        self.code_application_data_root = code_application_data_root.resolve()
        self.integrations_application_data_root = integrations_application_data_root.resolve()
        self.bootstrap_token = bootstrap_token
        self._boundary_validator = boundary_validator
        self._popen = popen
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._process: subprocess.Popen | None = None
        self._lock = threading.Lock()
        self.last_diagnostic: str | None = None

    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            raise RuntimeError("The companion worker supervisor is already running.")
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="agentic-researcher-worker-supervisor",
            daemon=True,
        )
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        with self._lock:
            process = self._process
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
        if self._thread:
            self._thread.join(timeout=10)
        self._thread = None

    def _run(self) -> None:
        backoff = 0.25
        while not self._stop.is_set():
            command = (
                str(self.node_executable),
                str(self.worker_script),
                "--base-url",
                self.base_url,
                "--executor-config",
                str(self.executor_config),
                "--coordinator-id",
                "agentic-researcher-service-worker",
                "--code-application-data-root",
                str(self.code_application_data_root),
                "--integrations-application-data-root",
                str(self.integrations_application_data_root),
            )
            creationflags = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0
            )
            try:
                if self._boundary_validator:
                    self._boundary_validator()
                process = self._popen(
                    command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    shell=False,
                    env=_clean_worker_environment(),
                    creationflags=creationflags,
                )
                with self._lock:
                    self._process = process
                secret = bytearray(self.bootstrap_token.get_secret_value().encode("utf-8"))
                try:
                    if process.stdin is None:
                        raise RuntimeError("Worker bootstrap stdin pipe is unavailable.")
                    process.stdin.write(secret)
                    process.stdin.flush()
                    process.stdin.close()
                finally:
                    secret[:] = b"\x00" * len(secret)
                drainers = [
                    threading.Thread(
                        target=self._drain,
                        args=(stream,),
                        daemon=True,
                    )
                    for stream in (process.stdout, process.stderr)
                    if stream is not None
                ]
                for drainer in drainers:
                    drainer.start()
                process.wait()
                for drainer in drainers:
                    drainer.join(timeout=1)
            except Exception as exc:
                self.last_diagnostic = _redact_worker_diagnostic(
                    str(exc), self.bootstrap_token.get_secret_value()
                )
            finally:
                with self._lock:
                    self._process = None
            if self._stop.wait(backoff):
                break
            backoff = min(backoff * 2, 10.0)

    def _drain(self, stream: object) -> None:
        captured = bytearray()
        while not self._stop.is_set():
            chunk = stream.read(4096)  # type: ignore[attr-defined]
            if not chunk:
                break
            remaining = max(0, 16_384 - len(captured))
            captured.extend(chunk[:remaining])
        if captured:
            text = captured.decode("utf-8", errors="replace")
            self.last_diagnostic = _redact_worker_diagnostic(
                text, self.bootstrap_token.get_secret_value()
            )
            captured[:] = b"\x00" * len(captured)


def validate_worker_data_roots(
    approved_data_root: Path,
    code_data_root: Path,
    integrations_data_root: Path,
) -> tuple[Path, Path]:
    """Pin each standalone worker store to its extension-owned sibling root."""
    approved_root, resolved_code_root = validate_approved_data_boundary(
        approved_data_root, code_data_root
    )
    if resolved_code_root != (approved_root / "code").resolve(strict=False):
        raise RuntimeError(
            "Worker Code data root is not the pinned application-data/code directory."
        )
    _, resolved_integrations_root = validate_approved_data_boundary(
        approved_root, integrations_data_root
    )
    if resolved_integrations_root != (approved_root / "integrations").resolve(strict=False):
        raise RuntimeError(
            "Worker integrations data root is not the pinned application-data/integrations directory."
        )
    return resolved_code_root, resolved_integrations_root


def main() -> None:
    args = parse_args()
    companion_dir = Path(__file__).resolve().parent
    node_executable = args.node_executable.resolve()
    require_runtime(companion_dir, node_executable)
    token = load_bootstrap_token()
    config = CompanionConfig(
        data_dir=args.data_dir,
        approved_data_root=args.approved_data_root,
        security=CompanionSecurityConfig(
            bootstrap_token=token.get_secret_value(),
            bind_host=args.host,
        ),
        background_requested=True,
        allow_session_secrets=False,
        browser_headless=True,
    )
    from server import create_app

    data_dir = config.validate_data_boundary()
    code_data_root, integrations_data_root = validate_worker_data_roots(
        args.approved_data_root,
        args.code_data_root,
        args.integrations_data_root,
    )
    executor_config = args.executor_config.resolve(strict=True)
    if not executor_config.is_relative_to(data_dir) or executor_config.is_symlink():
        raise RuntimeError("Worker executor configuration escaped approved companion data.")
    config.validate_data_boundary()
    catalog = json.loads(executor_config.read_text(encoding="utf-8"))
    installed_executor_domains = _installed_executor_domains(catalog)
    catalog_fingerprint = canonical_fingerprint(catalog)

    supervisor = WorkerSupervisor(
        node_executable=node_executable,
        worker_script=companion_dir / "standalone-worker.cjs",
        base_url=f"http://{config.security.bind_host}:{args.port}",
        executor_config=args.executor_config,
        code_application_data_root=code_data_root,
        integrations_application_data_root=integrations_data_root,
        bootstrap_token=token,
        boundary_validator=config.validate_data_boundary,
    )
    supervisor.start()
    try:
        uvicorn.run(
            create_app(
                config,
                expected_worker_catalog_fingerprint=catalog_fingerprint,
                installed_executor_domains=installed_executor_domains,
                worker_diagnostic_provider=lambda: supervisor.last_diagnostic,
            ),
            host=config.security.bind_host,
            port=args.port,
            access_log=False,
            server_header=False,
            date_header=False,
        )
    finally:
        supervisor.stop()


def _installed_executor_domains(catalog: object) -> tuple[str, ...]:
    expected = {
        "research": "public_research_fetch_v1",
        "code": "verified_code_manifest_readback_v1",
        "linear": "linear_issue_readback_v1",
        "github": "github_repository_readback_v1",
    }
    if not isinstance(catalog, dict) or set(catalog) != {"version", "executors"}:
        raise RuntimeError("Worker executor catalog has unknown or missing fields.")
    if catalog.get("version") != 1 or not isinstance(catalog.get("executors"), dict):
        raise RuntimeError("Worker executor catalog version is unsupported.")
    executors = catalog["executors"]
    if any(domain not in expected for domain in executors):
        raise RuntimeError("Worker executor catalog contains an unknown domain.")
    for domain, executor_id in executors.items():
        if executor_id != expected[domain]:
            raise RuntimeError(f"Worker executor catalog contains an unknown {domain} executor.")
    return tuple(domain for domain in expected if domain in executors)


def _clean_worker_environment() -> dict[str, str]:
    allowed = {
        "HOME",
        "USERPROFILE",
        "LOCALAPPDATA",
        "APPDATA",
        "XDG_DATA_HOME",
        "LANG",
        "LC_ALL",
        "SYSTEMROOT",
        "WINDIR",
        "TMP",
        "TEMP",
    }
    return {key: value for key, value in os.environ.items() if key in allowed}


def _redact_worker_diagnostic(value: str, bootstrap_token: str) -> str:
    redacted = value.replace(bootstrap_token, "[REDACTED]")
    redacted = re.sub(r"Bearer\s+\S+", "Bearer [REDACTED]", redacted, flags=re.I)
    redacted = re.sub(
        r"(?:token|secret|password|authorization)\s*[=:]\s*[^\s,;}]+",
        "credential=[REDACTED]",
        redacted,
        flags=re.I,
    )
    return redacted[:4_096]


if __name__ == "__main__":
    main()
