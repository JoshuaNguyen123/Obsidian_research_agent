import os
import base64
from pathlib import Path
import time

from document_engine import DocumentEngineIdentity
import pdf_extract
from test_pdf_extract import build_pdf


def _owned_artifact():
    file = Path(pdf_extract.__file__).resolve()
    assert "full-qualification" in file.parts, "never mutate a vendor or installed dependency"
    return file


def test_real_dependency_replacement_with_preserved_stat_invalidates_generation(tmp_path):
    file = tmp_path / "parser.py"
    file.write_bytes(b"original")
    stamp = file.stat()
    engine = DocumentEngineIdentity(artifact_paths=(file,))
    first = engine.observe()
    assert first["status"] == "ready"
    assert engine.observe() == first
    file.write_bytes(b"replaced")
    os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
    assert file.stat().st_size == stamp.st_size
    assert file.stat().st_mtime_ns == stamp.st_mtime_ns
    assert engine.observe()["status"] == "unavailable"
    file.write_bytes(b"original")
    assert engine.observe()["status"] == "unavailable", "changed generation stays invalid until restart"
    restarted = DocumentEngineIdentity(artifact_paths=(file,)).observe()
    assert restarted["status"] == "ready"
    assert restarted["generation"] != first["generation"]


def test_actual_loaded_engine_reports_only_opaque_digests():
    started = time.monotonic()
    engine = DocumentEngineIdentity()
    first = engine.observe()
    assert first["status"] == "ready"
    assert len(first["loadedEngineSha256"]) == 64
    assert len(first["effectiveConfigurationSha256"]) == 64
    assert first["loadedEngineSha256"] != "0" * 64
    assert engine.observe() == first
    assert str(Path.cwd()) not in str(first)
    assert time.monotonic() - started < 15


def test_missing_artifact_refuses_identity(tmp_path):
    engine = DocumentEngineIdentity(artifact_paths=(tmp_path / "missing",))
    assert engine.observe()["status"] == "unavailable"


def test_same_name_and_version_do_not_establish_same_engine(tmp_path):
    one, two = tmp_path / "a", tmp_path / "b"
    one.write_bytes(b"first engine")
    two.write_bytes(b"other engine")
    a = DocumentEngineIdentity(artifact_paths=(one,)).observe()
    b = DocumentEngineIdentity(artifact_paths=(two,)).observe()
    assert a["status"] == b["status"] == "ready"
    assert a["loadedEngineSha256"] != b["loadedEngineSha256"]


def test_authenticated_health_and_extract_echo_bind_actual_engine(companion_client):
    client, headers, _ = companion_client
    first = client.get("/health", headers=headers)
    assert first.status_code == 200
    assert first.headers["cache-control"] == "no-store"
    identity = first.json()["documentExtractionIdentity"]
    assert identity["status"] == "ready"
    parsed = client.post("/document/extract_text", headers=headers, json={
        "contentBase64": base64.b64encode(build_pdf(["Real page text"])).decode(),
    })
    assert parsed.status_code == 200, parsed.text
    assert parsed.headers["cache-control"] == "no-store"
    assert parsed.json()["text"] == "## Page 1\n\nReal page text"
    assert parsed.json()["documentExtractionIdentity"] == identity
    assert client.get("/health").status_code == 401
    assert client.get("/health", headers={"Authorization": "Bearer wrong"}).status_code == 401


def test_same_session_health_observes_changed_artifact_before_reuse(companion_client):
    client, headers, _ = companion_client
    file = _owned_artifact()
    content, stamp = file.read_bytes(), file.stat()
    before = client.get("/health", headers=headers).json()["documentExtractionIdentity"]
    assert before["status"] == "ready"
    try:
        file.write_bytes(content[:-1] + (b" " if content[-1:] != b" " else b"\n"))
        os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        assert file.stat().st_size == stamp.st_size
        assert file.stat().st_mtime_ns == stamp.st_mtime_ns
        changed = client.get("/health", headers=headers)
        assert changed.status_code == 200
        assert changed.json()["pdfReady"] is False
        identity = changed.json()["documentExtractionIdentity"]
        assert identity["generation"] == before["generation"]
        assert identity["status"] == "unavailable"
        refused = client.post("/document/extract_text", headers=headers, json={
            "contentBase64": base64.b64encode(build_pdf(["Changed engine must refuse"])).decode(),
        })
        assert refused.status_code == 503
    finally:
        file.write_bytes(content)
        os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))


def test_artifact_change_during_actual_parse_discards_output(companion_client, monkeypatch):
    import server
    client, headers, _ = companion_client
    file = _owned_artifact()
    content, stamp = file.read_bytes(), file.stat()
    extract = server.extract_pdf_text

    def replace_after_parse(*args, **kwargs):
        result = extract(*args, **kwargs)
        assert result.text == "## Page 1\n\nParsed before replacement"
        file.write_bytes(content[:-1] + (b" " if content[-1:] != b" " else b"\n"))
        os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
        return result

    monkeypatch.setattr(server, "extract_pdf_text", replace_after_parse)
    try:
        response = client.post("/document/extract_text", headers=headers, json={
            "contentBase64": base64.b64encode(build_pdf(["Parsed before replacement"])).decode(),
        })
        assert response.status_code == 503
        assert "stale output discarded" in response.json()["detail"]
        assert "Parsed before replacement" not in response.text
    finally:
        file.write_bytes(content)
        os.utime(file, ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
