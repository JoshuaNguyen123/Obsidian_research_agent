from __future__ import annotations

import base64
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import subprocess
import sys
import time
import os
import signal

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
    @unittest.skipUnless(sys.platform == "linux", "The sandbox runtime uses Linux pipes")
    def test_output_arrives_before_exit_and_final_bytes_are_unchanged(self) -> None:
        events = []
        script = "import time,sys; print('early',flush=True); time.sleep(.4); print('late',flush=True); print('error',file=sys.stderr,flush=True)"
        with subprocess.Popen([sys.executable, "-c", script], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
            stdout, stderr = runtime._communicate_bounded(process, 3, lambda stream, data, cut: events.append((stream, data, cut, process.poll())))
        self.assertEqual(stdout, b"early\nlate\n")
        self.assertEqual(stderr, b"error\n")
        self.assertEqual(events[0][:2], ("stdout", b"early\n"))
        self.assertIsNone(events[0][3], "first output must arrive while the child is still running")

    @unittest.skipUnless(sys.platform == "linux", "The sandbox runtime uses Linux pipes")
    def test_progress_is_bounded_but_final_output_retains_the_existing_full_limit(self) -> None:
        events = []
        with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdout.write('x'*20000)"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
            stdout, stderr = runtime._communicate_bounded(process, 3, lambda stream, data, cut: events.append((stream, data, cut)))
        self.assertEqual(stdout, b"x" * 20000)
        self.assertEqual(stderr, b"")
        self.assertEqual(sum(len(event[1]) for event in events), 8192)
        self.assertTrue(events[-1][2])

    @unittest.skipUnless(sys.platform == "linux", "The sandbox runtime uses Linux pipes")
    def test_oversized_command_output_is_refused_while_draining(self) -> None:
        with subprocess.Popen([sys.executable, "-c", "import sys; sys.stdout.write('x'*1100000)"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
            try:
                with self.assertRaisesRegex(runtime.ProtocolError, "exceeded 1 MiB"):
                    runtime._communicate_bounded(process, 3)
            finally:
                if process.poll() is None: os.killpg(process.pid, signal.SIGKILL)
                process.wait()

    @unittest.skipUnless(sys.platform == "linux", "The sandbox runtime uses Linux pipes")
    def test_timeout_retains_the_prefix_and_does_not_wait_forever_for_open_pipes(self) -> None:
        with subprocess.Popen([sys.executable, "-c", "import time; print('started',flush=True); time.sleep(3)"], stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True) as process:
            started = time.monotonic()
            try:
                with self.assertRaises(subprocess.TimeoutExpired) as raised:
                    runtime._communicate_bounded(process, .3)
                self.assertEqual(raised.exception.output, b"started\n")
                self.assertLess(time.monotonic() - started, 2)
            finally:
                if process.poll() is None: os.killpg(process.pid, signal.SIGKILL)
                process.wait()

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
