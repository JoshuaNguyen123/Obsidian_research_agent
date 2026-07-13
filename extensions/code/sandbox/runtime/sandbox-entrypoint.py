#!/usr/bin/env python3
"""Agentic Researcher sandbox runtime protocol v1.

This executable belongs *inside* a digest-pinned OCI image or a read-only
bubblewrap runtime root. The Obsidian plugin never invokes it on the host.
It accepts only the closed boundary-probe or staged-execution protocols and
returns one bounded JSON document on stdout.
"""

from __future__ import annotations

import base64
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
try:
    import resource
except ImportError:  # pragma: no cover - importable for protocol tests on Windows only
    resource = None  # type: ignore[assignment]
import signal
import subprocess
import sys
from typing import Any, Iterable


MAX_STDIN_BYTES = 16 * 1024 * 1024
MAX_STREAM_BYTES = 1024 * 1024
MAX_ARTIFACT_BYTES = 10 * 1024 * 1024
MAX_FILES = 100
SHA256_PREFIX = "sha256:"
ALLOWED_ENVIRONMENT = {"CI", "LANG", "LC_ALL", "NO_COLOR", "SOURCE_DATE_EPOCH", "TZ"}
WORKSPACE_ROOT = Path("/workspace")
RUNTIME_IDENTITY_PATHS = (
    Path("/opt/agentic/runtime-digest"),
    Path("/runtime/.agentic-runtime-digest"),
)
RUNTIME_MANIFEST_PATHS = (
    Path("/opt/agentic/runtime-manifest.json"),
    Path("/runtime/runtime-manifest.json"),
)


class ProtocolError(RuntimeError):
    pass


def _sha256(data: bytes) -> str:
    return f"{SHA256_PREFIX}{hashlib.sha256(data).hexdigest()}"


def _canonical_json(value: Any) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode("utf-8")


def _exact_object(value: Any, keys: set[str], label: str) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != keys:
        raise ProtocolError(f"{label} does not match protocol v1")
    return value


def _fingerprint(value: Any, label: str) -> str:
    if not isinstance(value, str) or len(value) != 71 or not value.startswith(SHA256_PREFIX):
        raise ProtocolError(f"{label} is not a SHA-256 fingerprint")
    suffix = value[len(SHA256_PREFIX):]
    if any(character not in "0123456789abcdef" for character in suffix):
        raise ProtocolError(f"{label} is not a lowercase SHA-256 fingerprint")
    return value


def _safe_relative_path(value: Any) -> str:
    if not isinstance(value, str) or not 1 <= len(value) <= 500 or "\\" in value or "\x00" in value:
        raise ProtocolError("sandbox path is invalid")
    path = PurePosixPath(value)
    if path.is_absolute() or str(path) != value or any(part in ("", ".", "..") for part in path.parts):
        raise ProtocolError("sandbox path is not a normalized relative path")
    if any(part.lower() == ".git" for part in path.parts):
        raise ProtocolError("sandbox path cannot enter .git")
    return value


def _canonical_base64(value: Any, maximum: int, label: str) -> bytes:
    if not isinstance(value, str) or len(value) > math.ceil(maximum / 3) * 4 + 4:
        raise ProtocolError(f"{label} is not bounded base64")
    try:
        decoded = base64.b64decode(value, validate=True)
    except Exception as error:
        raise ProtocolError(f"{label} is not canonical base64") from error
    if len(decoded) > maximum or base64.b64encode(decoded).decode("ascii") != value:
        raise ProtocolError(f"{label} is not canonical base64")
    return decoded


def decode_staging_bundle(data: bytes) -> list[tuple[str, bytes]]:
    if not 1 <= len(data) <= MAX_STDIN_BYTES:
        raise ProtocolError("staging bundle exceeds its byte boundary")
    try:
        parsed = json.loads(data.decode("utf-8"))
    except Exception as error:
        raise ProtocolError("staging bundle is not UTF-8 JSON") from error
    bundle = _exact_object(parsed, {"version", "files", "manifestFingerprint"}, "staging bundle")
    if bundle["version"] != 1 or not isinstance(bundle["files"], list) or not 1 <= len(bundle["files"]) <= MAX_FILES:
        raise ProtocolError("staging bundle version or file count is invalid")
    files: list[tuple[str, bytes]] = []
    manifest: list[dict[str, Any]] = []
    seen: set[str] = set()
    total = 0
    for raw in bundle["files"]:
        entry = _exact_object(raw, {"path", "sha256", "bytes", "contentBase64"}, "staged file")
        relative = _safe_relative_path(entry["path"])
        if relative in seen:
            raise ProtocolError("staging bundle contains duplicate paths")
        seen.add(relative)
        if not isinstance(entry["bytes"], int) or not 0 <= entry["bytes"] <= 2_000_000:
            raise ProtocolError("staged file byte count is invalid")
        content = _canonical_base64(entry["contentBase64"], 2_000_000, f"staged file {relative}")
        expected = _fingerprint(entry["sha256"], f"staged file {relative}")
        if len(content) != entry["bytes"] or _sha256(content) != expected:
            raise ProtocolError(f"staged file hash or size mismatch: {relative}")
        total += len(content)
        if total > 10_000_000:
            raise ProtocolError("staging bundle exceeds 10 MB")
        files.append((relative, content))
        manifest.append({"path": relative, "sha256": expected, "bytes": len(content)})
    manifest.sort(key=lambda entry: entry["path"])
    if _fingerprint(bundle["manifestFingerprint"], "staging manifest") != _sha256(_canonical_json(manifest)):
        raise ProtocolError("staging manifest fingerprint changed")
    return sorted(files, key=lambda entry: entry[0])


def _write_staging(files: Iterable[tuple[str, bytes]], workspace: Path) -> None:
    workspace.mkdir(mode=0o700, parents=False, exist_ok=True)
    root = workspace.resolve(strict=True)
    for relative, content in files:
        target = workspace.joinpath(*PurePosixPath(relative).parts)
        target.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        parent = target.parent.resolve(strict=True)
        if root != parent and root not in parent.parents:
            raise ProtocolError("staging parent escaped /workspace")
        with target.open("xb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if target.is_symlink() or target.stat().st_nlink != 1:
            raise ProtocolError("staged file is not an isolated regular file")
        if target.name in {"gradlew", "mvnw"}:
            target.chmod(0o700)


def _snapshot(workspace: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not workspace.exists():
        return result
    for target in sorted(workspace.rglob("*")):
        if target.is_symlink():
            raise ProtocolError("sandbox workspace contains a symbolic link")
        if not target.is_file():
            continue
        relative = target.relative_to(workspace).as_posix()
        _safe_relative_path(relative)
        if target.stat().st_nlink != 1:
            raise ProtocolError("sandbox workspace contains a hard-linked file")
        data = target.read_bytes()
        if len(data) > MAX_ARTIFACT_BYTES:
            raise ProtocolError("sandbox workspace contains an oversized file")
        result[relative] = _sha256(data)
    return result


def collect_artifacts(workspace: Path, before: dict[str, str]) -> list[dict[str, Any]]:
    artifacts: list[dict[str, Any]] = []
    total = 0
    for target in sorted(workspace.rglob("*")):
        if target.is_symlink():
            raise ProtocolError("sandbox output contains a symbolic link")
        if not target.is_file():
            continue
        relative = _safe_relative_path(target.relative_to(workspace).as_posix())
        if target.stat().st_nlink != 1:
            raise ProtocolError("sandbox output contains a hard-linked file")
        content = target.read_bytes()
        digest = _sha256(content)
        if before.get(relative) == digest:
            continue
        total += len(content)
        if len(content) > MAX_ARTIFACT_BYTES or total > MAX_ARTIFACT_BYTES or len(artifacts) >= MAX_FILES:
            raise ProtocolError("sandbox artifact output exceeds its fixed boundary")
        artifacts.append({
            "path": relative,
            "sha256": digest,
            "bytes": len(content),
            "contentBase64": base64.b64encode(content).decode("ascii"),
        })
    return artifacts


def _load_runtime_identity(expected: str) -> None:
    _fingerprint(expected, "expected sandbox runtime digest")
    for candidate in RUNTIME_IDENTITY_PATHS:
        if candidate.is_file() and candidate.read_text("utf-8").strip() == expected:
            return
    raise ProtocolError("read-only runtime identity does not match the configured digest")


def _runtime_allows(command: str, command_digest: str) -> None:
    _fingerprint(command_digest, "expected command runtime digest")
    for candidate in RUNTIME_MANIFEST_PATHS:
        if not candidate.is_file():
            continue
        try:
            manifest = json.loads(candidate.read_text("utf-8"))
        except Exception as error:
            raise ProtocolError("runtime manifest is not valid UTF-8 JSON") from error
        record = _exact_object(manifest, {"version", "commandRuntimeDigests"}, "runtime manifest")
        mappings = record["commandRuntimeDigests"]
        if record["version"] != 1 or not isinstance(mappings, dict):
            raise ProtocolError("runtime manifest version is invalid")
        allowed = mappings.get(command_digest)
        if isinstance(allowed, list) and command in allowed and all(isinstance(item, str) for item in allowed):
            return
        raise ProtocolError("runtime manifest does not bind this command to the expected immutable digest")
    raise ProtocolError("sandbox runtime manifest is missing")


def _mount_entries() -> list[tuple[str, set[str], str, set[str]]]:
    entries: list[tuple[str, set[str], str, set[str]]] = []
    try:
        text = Path("/proc/self/mountinfo").read_text("utf-8")
    except OSError:
        return entries
    for line in text.splitlines():
        before, separator, after = line.partition(" - ")
        fields = before.split()
        trailing = after.split()
        if not separator or len(fields) < 6 or len(trailing) < 3:
            continue
        mountpoint = fields[4].replace("\\040", " ")
        entries.append((mountpoint, set(fields[5].split(",")), trailing[0], set(trailing[2].split(","))))
    return entries


def _mount_for(path: str) -> tuple[str, set[str], str, set[str]] | None:
    candidates = [entry for entry in _mount_entries() if path == entry[0] or path.startswith(entry[0].rstrip("/") + "/")]
    return max(candidates, key=lambda entry: len(entry[0]), default=None)


def _read_only_mount(path: str) -> bool:
    mount = _mount_for(path)
    return bool(mount and ("ro" in mount[1] or "ro" in mount[3]))


def _network_blocked() -> bool:
    try:
        routes = Path("/proc/net/route").read_text("ascii").splitlines()[1:]
    except OSError:
        return False
    return not any(len(line.split()) > 1 and line.split()[1] == "00000000" for line in routes)


def _resource_limits_enforced() -> bool:
    cgroup = Path("/sys/fs/cgroup")
    if cgroup.is_dir():
        try:
            pids = (cgroup / "pids.max").read_text("ascii").strip()
            memory = (cgroup / "memory.max").read_text("ascii").strip()
            cpu = (cgroup / "cpu.max").read_text("ascii").strip()
            if pids != "max" and memory != "max" and cpu.split()[0] != "max":
                return True
        except OSError:
            pass
    if resource is None:
        return False
    limits = [resource.getrlimit(resource.RLIMIT_NPROC), resource.getrlimit(resource.RLIMIT_AS), resource.getrlimit(resource.RLIMIT_CPU)]
    return all(soft != resource.RLIM_INFINITY for soft, _hard in limits)


def boundary_proof(expected_runtime_digest: str) -> dict[str, Any]:
    _load_runtime_identity(expected_runtime_digest)
    runtime_path = "/runtime" if Path("/runtime").exists() else "/opt/agentic"
    workspace_mount = _mount_for("/workspace")
    host_markers = ("/host", "/host_mnt", "/run/host", "/mnt/c", "/mnt/host")
    socket_markers = ("/var/run/docker.sock", "/run/docker.sock", "/run/podman/podman.sock")
    return {
        "version": 1,
        "uid": os.getuid(),
        "networkBlocked": _network_blocked(),
        "rootReadOnly": _read_only_mount("/"),
        "hostRootAbsent": not any(Path(marker).exists() for marker in host_markers),
        "containerSocketAbsent": not any(Path(marker).exists() for marker in socket_markers),
        "runtimeReadOnly": _read_only_mount(runtime_path),
        "runtimeDigest": expected_runtime_digest,
        "stagingIsolated": bool(workspace_mount and workspace_mount[2] == "tmpfs"),
        "resourceLimitsEnforced": _resource_limits_enforced(),
    }


def _parse_execution(argv: list[str]) -> tuple[str, str, str, int, int, int, int, list[str]]:
    expected = [
        "--staging-stdin", "--artifacts-stdout", "--expected-runtime-digest",
        "--expected-command-runtime-digest", "--command-cwd", "--cpu-count",
        "--memory-mb", "--pid-limit", "--timeout-ms",
    ]
    values: dict[str, str] = {}
    cursor = 0
    for flag in expected:
        if cursor >= len(argv) or argv[cursor] != flag:
            raise ProtocolError(f"missing or out-of-order execution flag: {flag}")
        cursor += 1
        if flag in {"--staging-stdin", "--artifacts-stdout"}:
            continue
        if cursor >= len(argv):
            raise ProtocolError(f"execution flag has no value: {flag}")
        values[flag] = argv[cursor]
        cursor += 1
    if cursor >= len(argv) or argv[cursor] != "--" or cursor + 1 >= len(argv):
        raise ProtocolError("sandbox execution command separator is missing")
    command = argv[cursor + 1:]
    if len(command) > 65 or any(not value or len(value) > 1024 or "\x00" in value for value in command):
        raise ProtocolError("sandbox command is invalid or too large")
    cwd = values["--command-cwd"]
    if cwd != ".":
        _safe_relative_path(cwd)
    cpu = _bounded_int(values["--cpu-count"], 1, 8, "cpu count")
    memory = _bounded_int(values["--memory-mb"], 128, 8192, "memory limit")
    pids = _bounded_int(values["--pid-limit"], 8, 512, "PID limit")
    timeout = _bounded_int(values["--timeout-ms"], 1000, 1_800_000, "timeout")
    return values["--expected-runtime-digest"], values["--expected-command-runtime-digest"], cwd, cpu, memory, pids, timeout, command


def _bounded_int(value: str, minimum: int, maximum: int, label: str) -> int:
    try:
        parsed = int(value, 10)
    except ValueError as error:
        raise ProtocolError(f"{label} is not an integer") from error
    if not minimum <= parsed <= maximum:
        raise ProtocolError(f"{label} is out of bounds")
    return parsed


def _clean_environment() -> dict[str, str]:
    output = {"HOME": "/tmp/home", "PATH": "/runtime/bin:/usr/bin:/bin"}
    for key in sorted(ALLOWED_ENVIRONMENT):
        value = os.environ.get(key)
        if value is not None and len(value) <= 512 and "\x00" not in value and "\n" not in value and "\r" not in value:
            output[key] = value
    return output


def _preexec(cpu: int, memory_mb: int, pids: int, timeout_ms: int):
    if resource is None:
        raise ProtocolError("sandbox runtime requires Linux resource limits")
    def apply() -> None:
        os.setsid()
        resource.setrlimit(resource.RLIMIT_AS, (memory_mb * 1024 * 1024, memory_mb * 1024 * 1024))
        resource.setrlimit(resource.RLIMIT_NPROC, (pids, pids))
        cpu_seconds = max(1, math.ceil(timeout_ms / 1000))
        resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
        if hasattr(os, "sched_getaffinity") and hasattr(os, "sched_setaffinity"):
            available = sorted(os.sched_getaffinity(0))
            os.sched_setaffinity(0, set(available[:cpu]))
    return apply


def execute(argv: list[str], stdin: bytes, workspace: Path = WORKSPACE_ROOT) -> dict[str, Any]:
    runtime_digest, command_digest, cwd, cpu, memory, pids, timeout, command = _parse_execution(argv)
    _load_runtime_identity(runtime_digest)
    _runtime_allows(command[0], command_digest)
    files = decode_staging_bundle(stdin)
    _write_staging(files, workspace)
    before = _snapshot(workspace)
    command_cwd = workspace if cwd == "." else workspace.joinpath(*PurePosixPath(cwd).parts)
    resolved_cwd = command_cwd.resolve(strict=True)
    workspace_root = workspace.resolve(strict=True)
    if workspace_root != resolved_cwd and workspace_root not in resolved_cwd.parents:
        raise ProtocolError("command cwd escaped /workspace")
    try:
        process = subprocess.Popen(
            command,
            cwd=resolved_cwd,
            env=_clean_environment(),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            start_new_session=False,
            preexec_fn=_preexec(cpu, memory, pids, timeout),
        )
        stdout, stderr = process.communicate(timeout=timeout / 1000)
    except subprocess.TimeoutExpired:
        os.killpg(process.pid, signal.SIGKILL)
        stdout, stderr = process.communicate()
        stderr = stderr + b"\nsandbox_timeout=true"
        exit_code = 124
    else:
        exit_code = process.returncode if 0 <= process.returncode <= 255 else 255
    if len(stdout) > MAX_STREAM_BYTES or len(stderr) > MAX_STREAM_BYTES:
        raise ProtocolError("sandbox command stream exceeded 1 MiB")
    return {
        "version": 1,
        "exitCode": exit_code,
        "stdoutBase64": base64.b64encode(stdout).decode("ascii"),
        "stderrBase64": base64.b64encode(stderr).decode("ascii"),
        "artifacts": collect_artifacts(workspace, before),
    }


def main(argv: list[str]) -> int:
    try:
        if argv == ["--boundary-probe-json", "--expected-runtime-digest"]:
            raise ProtocolError("boundary probe digest is missing")
        if len(argv) == 3 and argv[:2] == ["--boundary-probe-json", "--expected-runtime-digest"]:
            proof = boundary_proof(argv[2])
            sys.stdout.buffer.write(_canonical_json(proof))
            return 0
        stdin = sys.stdin.buffer.read(MAX_STDIN_BYTES + 1)
        result = execute(argv, stdin)
        sys.stdout.buffer.write(_canonical_json(result))
        return 0
    except Exception as error:
        message = str(error).replace("\x00", "")[:2000]
        sys.stderr.write(f"sandbox_protocol_error={message}\n")
        return 70


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
