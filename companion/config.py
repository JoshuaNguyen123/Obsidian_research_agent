from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

from auth import DEFAULT_MAX_BODY_BYTES, CompanionSecurityConfig, generate_bootstrap_token


def _env_bool(name: str, default: bool = False) -> bool:
    value = os.getenv(name)
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class CompanionConfig:
    data_dir: Path
    security: CompanionSecurityConfig
    approved_data_root: Path | None = None
    background_requested: bool = False
    allow_session_secrets: bool = True
    browser_headless: bool = False

    def validate_data_boundary(self) -> Path:
        if self.background_requested and self.approved_data_root is None:
            raise ValueError(
                "Background companion data requires an explicit approved application-data root."
            )
        _root, resolved = validate_approved_data_boundary(
            self.approved_data_root or self.data_dir.parent,
            self.data_dir,
        )
        return resolved

    @classmethod
    def from_environment(cls, default_data_dir: Path) -> "CompanionConfig":
        token = os.getenv("AGENTIC_COMPANION_BOOTSTRAP_TOKEN") or generate_bootstrap_token()
        bind_host = os.getenv("AGENTIC_COMPANION_HOST", "127.0.0.1")
        max_body_bytes = int(
            os.getenv("AGENTIC_COMPANION_MAX_BODY_BYTES", str(DEFAULT_MAX_BODY_BYTES))
        )
        trusted_origins = tuple(
            origin.strip()
            for origin in os.getenv("AGENTIC_COMPANION_TRUSTED_ORIGINS", "").split(",")
            if origin.strip()
        )
        return cls(
            data_dir=Path(os.getenv("AGENTIC_COMPANION_DATA_DIR", default_data_dir)),
            approved_data_root=Path(
                os.getenv("AGENTIC_COMPANION_APPROVED_DATA_ROOT", default_data_dir)
            ),
            security=CompanionSecurityConfig(
                bootstrap_token=token,
                bind_host=bind_host,
                max_body_bytes=max_body_bytes,
                trusted_origins=trusted_origins,
            ),
            background_requested=_env_bool("AGENTIC_COMPANION_BACKGROUND"),
            allow_session_secrets=_env_bool(
                "AGENTIC_COMPANION_ALLOW_SESSION_SECRETS", default=True
            ),
            browser_headless=_env_bool("AGENTIC_COMPANION_BROWSER_HEADLESS"),
        )


def validate_approved_data_boundary(
    approved_data_root: Path,
    data_dir: Path,
) -> tuple[Path, Path]:
    """Require canonical, existing, non-reparse app-data containment."""

    raw_root = approved_data_root.expanduser()
    raw_data = data_dir.expanduser()
    if not raw_root.is_absolute() or not raw_data.is_absolute():
        raise ValueError("Companion data paths must be absolute.")
    if raw_root == Path(raw_root.anchor) or raw_data == Path(raw_data.anchor):
        raise ValueError("Companion data paths cannot be filesystem roots.")
    if not raw_root.is_dir():
        raise ValueError("The approved companion application-data root must already exist.")
    if raw_data.exists() and not raw_data.is_dir():
        raise ValueError("The companion data path must be a directory.")

    resolved_root = raw_root.resolve(strict=True)
    resolved_data = raw_data.resolve(strict=False)
    if not _same_path(raw_root, resolved_root) or not _same_path(raw_data, resolved_data):
        raise ValueError("Companion data paths must be canonical and cannot traverse links.")
    try:
        resolved_data.relative_to(resolved_root)
    except ValueError as exc:
        raise ValueError(
            "Companion data must remain inside the approved application-data root."
        ) from exc

    cursor = raw_data
    while True:
        if cursor.exists() and _is_reparse_or_symlink(cursor):
            raise ValueError(
                "Companion data paths cannot contain symbolic links or reparse points."
            )
        if _same_path(cursor, raw_root):
            break
        parent = cursor.parent
        if parent == cursor:
            raise ValueError(
                "Companion data escaped the approved application-data root."
            )
        cursor = parent

    for candidate in (resolved_data, *resolved_data.parents):
        if candidate.name.lower() == ".obsidian" or (candidate / ".obsidian").is_dir():
            raise ValueError(
                "The companion data directory cannot be inside an Obsidian vault."
            )
        if _same_path(candidate, resolved_root):
            break
    return resolved_root, resolved_data


def _same_path(left: Path, right: Path) -> bool:
    return os.path.normcase(os.path.abspath(left)) == os.path.normcase(os.path.abspath(right))


def _is_reparse_or_symlink(path: Path) -> bool:
    if path.is_symlink():
        return True
    try:
        attributes = getattr(os.lstat(path), "st_file_attributes", 0)
    except OSError:
        return True
    reparse_flag = getattr(__import__("stat"), "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)
    return bool(attributes & reparse_flag)
