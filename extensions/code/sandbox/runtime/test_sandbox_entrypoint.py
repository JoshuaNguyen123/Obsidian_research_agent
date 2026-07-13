from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

ENTRYPOINT = Path(__file__).with_name("sandbox-entrypoint.py")
SPEC = importlib.util.spec_from_file_location("agentic_sandbox_entrypoint", ENTRYPOINT)
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)


def bundle(files: dict[str, bytes]) -> bytes:
    manifest = [
        {"path": path, "sha256": runtime._sha256(content), "bytes": len(content)}
        for path, content in sorted(files.items())
    ]
    return json.dumps({
        "version": 1,
        "files": [
            {
                **entry,
                "contentBase64": base64.b64encode(files[entry["path"]]).decode("ascii"),
            }
            for entry in manifest
        ],
        "manifestFingerprint": runtime._sha256(runtime._canonical_json(manifest)),
    }, separators=(",", ":")).encode("utf-8")


class SandboxRuntimeProtocolTests(unittest.TestCase):
    def test_staging_bundle_requires_canonical_hashes_and_paths(self) -> None:
        decoded = runtime.decode_staging_bundle(bundle({"src/value.txt": b"safe\n"}))
        self.assertEqual(decoded, [("src/value.txt", b"safe\n")])
        parsed = json.loads(bundle({"src/value.txt": b"safe\n"}))
        parsed["files"][0]["path"] = "../escape"
        with self.assertRaisesRegex(runtime.ProtocolError, "normalized relative path"):
            runtime.decode_staging_bundle(json.dumps(parsed).encode("utf-8"))

    def test_artifacts_include_only_changed_hash_verified_files(self) -> None:
        with tempfile.TemporaryDirectory() as folder:
            workspace = Path(folder)
            (workspace / "source.txt").write_bytes(b"source")
            before = runtime._snapshot(workspace)
            (workspace / "source.txt").write_bytes(b"changed")
            (workspace / "nested").mkdir()
            (workspace / "nested" / "output.bin").write_bytes(bytes([0, 255, 1]))
            artifacts = runtime.collect_artifacts(workspace, before)
            self.assertEqual([entry["path"] for entry in artifacts], ["nested/output.bin", "source.txt"])
            for artifact in artifacts:
                content = base64.b64decode(artifact["contentBase64"], validate=True)
                self.assertEqual(artifact["sha256"], runtime._sha256(content))
                self.assertEqual(artifact["bytes"], len(content))

    def test_execution_flags_are_closed_and_bounded(self) -> None:
        digest = f"sha256:{'a' * 64}"
        parsed = runtime._parse_execution([
            "--staging-stdin", "--artifacts-stdout",
            "--expected-runtime-digest", digest,
            "--expected-command-runtime-digest", digest,
            "--command-cwd", "src",
            "--cpu-count", "1", "--memory-mb", "256",
            "--pid-limit", "32", "--timeout-ms", "30000",
            "--", "node", "test.js",
        ])
        self.assertEqual(parsed[-1], ["node", "test.js"])
        with self.assertRaisesRegex(runtime.ProtocolError, "out-of-order"):
            runtime._parse_execution(["--artifacts-stdout"])


if __name__ == "__main__":
    unittest.main()
