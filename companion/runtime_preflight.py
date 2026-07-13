from __future__ import annotations

import importlib.metadata
import json
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class RuntimePreflight:
    ok: bool
    blocker: str | None
    required_action: str | None


def verify_runtime(
    companion_dir: Path,
    node_executable: Path,
    *,
    python_version: tuple[int, int] | None = None,
    distribution_version: Callable[[str], str] = importlib.metadata.version,
    runner: Callable[..., subprocess.CompletedProcess] = subprocess.run,
) -> RuntimePreflight:
    try:
        lock = json.loads((companion_dir / "runtime-lock.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError, KeyError):
        return _blocked("runtime_manifest_missing_or_invalid")
    required_python = lock["python"]
    actual_python = ".".join(
        str(part) for part in (python_version or sys.version_info[:2])
    )
    if actual_python != required_python:
        return _blocked(f"python_version_mismatch:{actual_python}:required:{required_python}")

    try:
        requirements = _requirements(companion_dir / lock["requirements"])
    except (OSError, RuntimeError, KeyError):
        return _blocked("pinned_requirements_missing_or_invalid")
    for name, required in requirements.items():
        distribution = name.split("[", 1)[0]
        try:
            actual = distribution_version(distribution)
        except importlib.metadata.PackageNotFoundError:
            return _blocked(f"python_dependency_missing:{distribution}=={required}")
        if actual != required:
            return _blocked(
                f"python_dependency_mismatch:{distribution}=={actual}:required:{required}"
            )

    if not node_executable.is_absolute() or not node_executable.is_file():
        return _blocked("node_runtime_missing:absolute_executable_required")
    completed = runner(
        (str(node_executable), "--version"),
        check=False,
        shell=False,
        capture_output=True,
        text=True,
        timeout=10,
    )
    actual_node = completed.stdout.strip().removeprefix("v")
    if completed.returncode != 0 or actual_node != lock["node"]:
        return _blocked(
            f"node_version_mismatch:{actual_node or 'unavailable'}:required:{lock['node']}"
        )
    return RuntimePreflight(ok=True, blocker=None, required_action=None)


def require_runtime(companion_dir: Path, node_executable: Path) -> None:
    result = verify_runtime(companion_dir, node_executable)
    if not result.ok:
        raise RuntimeError(f"{result.blocker}. {result.required_action}")


def _requirements(path: Path) -> dict[str, str]:
    pinned: dict[str, str] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if "==" not in stripped or any(operator in stripped for operator in (">=", "<=", "~=", "!=")):
            raise RuntimeError(f"Unpinned companion requirement: {stripped}")
        name, version = stripped.split("==", 1)
        if not name or not version:
            raise RuntimeError(f"Invalid companion requirement: {stripped}")
        pinned[name] = version
    return pinned


def _blocked(code: str) -> RuntimePreflight:
    return RuntimePreflight(
        ok=False,
        blocker=code,
        required_action=(
            "Provision the exact pinned Python and Node runtimes from companion/runtime-lock.json; "
            "the companion never installs or upgrades dependencies automatically."
        ),
    )
