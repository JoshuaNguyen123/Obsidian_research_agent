from __future__ import annotations

import json
import subprocess

from runtime_preflight import verify_runtime


def _fixture_runtime(tmp_path):
    companion = tmp_path / "companion"
    companion.mkdir()
    requirements = {
        "fastapi": "1.2.3",
        "keyring": "4.5.6",
    }
    (companion / "requirements.txt").write_text(
        "\n".join(f"{name}=={version}" for name, version in requirements.items()) + "\n",
        encoding="utf-8",
    )
    (companion / "runtime-lock.json").write_text(
        json.dumps(
            {
                "version": 1,
                "python": "3.11",
                "node": "24.16.0",
                "requirements": "requirements.txt",
            }
        ),
        encoding="utf-8",
    )
    node = tmp_path / "node"
    node.write_text("fixture", encoding="utf-8")
    return companion, node, requirements


def test_preflight_accepts_only_exact_pinned_runtime_without_installing(tmp_path):
    companion, node, versions = _fixture_runtime(tmp_path)
    commands = []

    def runner(command, **_kwargs):
        commands.append(tuple(command))
        return subprocess.CompletedProcess(command, 0, stdout="v24.16.0\n", stderr="")

    result = verify_runtime(
        companion,
        node.resolve(),
        python_version=(3, 11),
        distribution_version=lambda name: versions[name],
        runner=runner,
    )
    assert result.ok is True
    assert commands == [(str(node.resolve()), "--version")]


def test_preflight_returns_exact_actionable_blocker_and_never_bootstraps(tmp_path):
    companion, node, versions = _fixture_runtime(tmp_path)
    result = verify_runtime(
        companion,
        node.resolve(),
        python_version=(3, 12),
        distribution_version=lambda name: versions[name],
    )
    assert result.ok is False
    assert result.blocker == "python_version_mismatch:3.12:required:3.11"
    assert "never installs" in (result.required_action or "")
