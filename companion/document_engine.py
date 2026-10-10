"""Opaque identities for the actual loaded PDF engine; not remote attestation.

Each observation rehashes the artifact inventory. Replaced artifacts invalidate
this generation until restart, including same-size/preserved-mtime changes.
No version-only, stat-only or cached-health identity authorizes derived reuse.
"""
from __future__ import annotations

import hashlib
import importlib
import json
import marshal
import os
from pathlib import Path
import sys
import threading
import uuid

import pypdf
import pdf_extract

MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
MAX_ARTIFACT_FILES = 512


def _digest(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def _parser_artifacts() -> tuple[Path, ...]:
    package = Path(pypdf.__file__).resolve().parent
    files = sorted(path for path in package.rglob("*") if path.is_file() and path.suffix in {".py", ".pyd", ".so"})
    provider = pypdf._crypt_providers.crypt_provider[0]
    if provider in {"cryptography", "pycryptodome"}:
        dependency = importlib.import_module("cryptography" if provider == "cryptography" else "Crypto")
        root = Path(dependency.__file__).resolve().parent
        files.extend(sorted(path for path in root.rglob("*") if path.is_file() and path.suffix in {".py", ".pyd", ".so", ".dll"}))
    for name in ("zlib", "struct", "re", "codecs", "encodings", "unicodedata", "io"):
        module = importlib.import_module(name)
        location = getattr(module, "__file__", None)
        if location:
            files.append(Path(location).resolve())
    files.extend([Path(sys.executable).resolve(), Path(pdf_extract.__file__).resolve(),
                  Path(__file__).resolve(), Path(__file__).with_name("server.py"), Path(__file__).with_name("schemas.py")])
    if os.name == "nt":
        # CPython's small executable delegates to this actual interpreter DLL.
        import ctypes
        buffer = ctypes.create_unicode_buffer(32768)
        length = ctypes.windll.kernel32.GetModuleFileNameW(ctypes.c_void_p(sys.dllhandle), buffer, len(buffer))
        if not length or length >= len(buffer):
            raise RuntimeError("Interpreter artifact identity unavailable")
        files.append(Path(buffer.value).resolve())
    return tuple(dict.fromkeys(files))


def _hash_artifacts(files: tuple[Path, ...]) -> list[dict[str, object]]:
    if not files or len(files) > MAX_ARTIFACT_FILES:
        raise RuntimeError("Engine artifact inventory outside bounds")
    used = 0
    hashes = []
    for number, file in enumerate(files):
        # Stream a bounded read. File names and absolute paths never leave this
        # process. A stable stat is not evidence of unchanged contents.
        hashed = hashlib.sha256()
        size = 0
        with file.open("rb") as stream:
            while chunk := stream.read(64 * 1024):
                used += len(chunk)
                size += len(chunk)
                if used > MAX_ARTIFACT_BYTES:
                    raise RuntimeError("Engine artifacts exceed identity bound")
                hashed.update(chunk)
        hashes.append({"slot": number, "bytes": size, "sha256": hashed.hexdigest()})
    return hashes


class DocumentEngineIdentity:
    def __init__(self, *, artifact_paths: tuple[Path, ...] | None = None):
        self._lock = threading.Lock()
        self._generation = uuid.uuid4().hex
        self._injected_paths = artifact_paths
        self._paths: tuple[Path, ...] = ()
        self._artifacts: list[dict[str, object]] = []
        self._available = False
        self._loaded_digest = "0" * 64
        self._configuration_digest = _digest({
            "schemaVersion": 1, "policy": "pypdf-page-marked-text-v1",
            "defaultMaxPages": pdf_extract.DEFAULT_MAX_PAGES,
            "defaultMaxChars": pdf_extract.DEFAULT_MAX_CHARS,
            "requestMaxPages": 2000, "requestMaxChars": 250000,
            "strict": False, "encryptedPassword": "empty-only",
        })
        try:
            self._paths = artifact_paths if artifact_paths is not None else _parser_artifacts()
            self._artifacts = _hash_artifacts(self._paths)
            bindings = [pdf_extract.extract_pdf_text, pdf_extract.normalize_pdf_text,
                        pdf_extract.page_text, pdf_extract._unlock, pdf_extract._no_text,
                        pypdf.PdfReader.__init__, pypdf.PdfReader.read,
                        pypdf.PageObject.extract_text]
            self._loaded_digest = _digest({
                "schemaVersion": 1, "python": sys.version,
                "implementation": sys.implementation.name,
                "cacheTag": sys.implementation.cache_tag,
                "pypdfVersion": pypdf.__version__, "artifacts": self._artifacts,
                "loadedBindings": [hashlib.sha256(marshal.dumps(value.__code__)).hexdigest() for value in bindings],
                "configuration": self._configuration_digest,
            })
            self._available = True
        except (OSError, RuntimeError, AttributeError):
            self._available = False

    def observe(self) -> dict[str, object]:
        with self._lock:
            if self._available:
                try:
                    paths = self._injected_paths if self._injected_paths is not None else _parser_artifacts()
                    if paths != self._paths or _hash_artifacts(paths) != self._artifacts:
                        self._available = False
                except (OSError, RuntimeError, AttributeError):
                    self._available = False
            return {
                "schemaVersion": 1, "generation": self._generation,
                "loadedEngineSha256": self._loaded_digest,
                "effectiveConfigurationSha256": self._configuration_digest,
                "status": "ready" if self._available else "unavailable",
            }
