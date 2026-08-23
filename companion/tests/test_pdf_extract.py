from __future__ import annotations

import base64
import io
from typing import Sequence

import pytest
from pypdf import PageObject, PdfWriter

from pdf_extract import extract_pdf_text, normalize_pdf_text


def build_pdf(pages: Sequence[str]) -> bytes:
    """Assemble a minimal, valid PDF whose pages carry exactly this text.

    Hand-rolled rather than fixture-loaded so a test can state the document it
    means: a page given "" gets a real but empty content stream, which is what
    a scanned, image-only page looks like to a text extractor.
    """

    objects: list[bytes] = []

    def add(body: bytes) -> int:
        objects.append(body)
        return len(objects)

    add(b"")  # 1: catalog, patched once the kids are known.
    add(b"")  # 2: page tree, likewise.
    font = add(b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")

    kids: list[int] = []
    for text in pages:
        if text:
            escaped = text.replace("\\", r"\\").replace("(", r"\(").replace(")", r"\)")
            stream = f"BT /F1 12 Tf 72 720 Td ({escaped}) Tj ET".encode("latin-1")
        else:
            stream = b""
        content = add(
            b"<< /Length %d >>\nstream\n%s\nendstream" % (len(stream), stream)
        )
        kids.append(
            add(
                b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
                b"/Resources << /Font << /F1 %d 0 R >> >> /Contents %d 0 R >>"
                % (font, content)
            )
        )

    objects[0] = b"<< /Type /Catalog /Pages 2 0 R >>"
    objects[1] = b"<< /Type /Pages /Kids [%s] /Count %d >>" % (
        b" ".join(b"%d 0 R" % kid for kid in kids),
        len(kids),
    )

    out = bytearray(b"%PDF-1.4\n")
    offsets: list[int] = []
    for index, body in enumerate(objects, start=1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % index + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (
        len(objects) + 1,
        xref,
    )
    return bytes(out)


def build_encrypted_pdf(password: str) -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=612, height=792)
    writer.encrypt(password, f"owner-{password}")
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


def test_multi_page_extraction_keeps_page_markers_a_citation_can_point_at():
    extraction = extract_pdf_text(
        build_pdf(["Opinion of the Court", "Justice Kagan dissenting"])
    )

    assert extraction.status == "parsed"
    assert extraction.reason is None
    assert extraction.page_count == 2
    assert extraction.pages_extracted == 2
    assert extraction.pages_skipped == 0
    assert extraction.truncated is False
    assert extraction.text == (
        "## Page 1\n\nOpinion of the Court\n\n## Page 2\n\nJustice Kagan dissenting"
    )


def test_page_budget_stops_early_and_reports_the_document_as_truncated():
    extraction = extract_pdf_text(
        build_pdf([f"page body {index}" for index in range(1, 6)]), max_pages=2
    )

    assert extraction.status == "parsed"
    assert extraction.page_count == 5
    assert extraction.pages_extracted == 2
    assert extraction.truncated is True
    assert "## Page 3" not in extraction.text


def test_character_cap_bounds_the_output_and_is_reported():
    pages = ["A" * 400, "B" * 400, "C" * 400]

    unbounded = extract_pdf_text(build_pdf(pages))
    assert unbounded.truncated is False
    assert len(unbounded.text) > 500

    capped = extract_pdf_text(build_pdf(pages), max_chars=500)
    assert capped.status == "parsed"
    assert len(capped.text) <= 500
    assert capped.truncated is True
    assert capped.text.startswith("## Page 1\n\nAAA")


def test_one_broken_page_is_skipped_rather_than_failing_the_document(monkeypatch):
    original = PageObject.extract_text
    calls = {"count": 0}

    def flaky(self, *args, **kwargs):
        calls["count"] += 1
        if calls["count"] == 2:
            raise ValueError("malformed content stream")
        return original(self, *args, **kwargs)

    monkeypatch.setattr(PageObject, "extract_text", flaky)

    extraction = extract_pdf_text(build_pdf(["first", "second", "third"]))

    assert extraction.status == "parsed"
    assert extraction.page_count == 3
    assert extraction.pages_extracted == 2
    assert extraction.pages_skipped == 1
    assert "## Page 1\n\nfirst" in extraction.text
    assert "## Page 3\n\nthird" in extraction.text
    assert "second" not in extraction.text


def test_an_image_only_pdf_reports_no_extractable_text_rather_than_success():
    extraction = extract_pdf_text(build_pdf(["", ""]))

    assert extraction.status == "empty"
    assert extraction.reason == "no_extractable_text"
    assert extraction.text == ""
    assert extraction.page_count == 2
    assert extraction.pages_extracted == 0


def test_an_encrypted_pdf_is_reported_as_encrypted_not_as_an_empty_document():
    extraction = extract_pdf_text(build_encrypted_pdf("reader-password"))

    assert extraction.status == "empty"
    assert extraction.reason == "encrypted"
    assert extraction.text == ""


@pytest.mark.parametrize("data", [b"", b"not a pdf at all", b"%PDF-1.4\ntruncated"])
def test_unparseable_bytes_are_reported_rather_than_raised(data):
    extraction = extract_pdf_text(data)

    assert extraction.status == "empty"
    assert extraction.reason == "unreadable_document"


def test_ragged_intra_line_spacing_collapses_but_paragraph_breaks_survive():
    raw = "The   Court \t held that   \n\n\n  the   statute  \napplies.  "

    assert normalize_pdf_text(raw) == "The Court held that\n\nthe statute\napplies."


def test_the_route_returns_the_empty_signal_for_a_document_with_no_text(
    companion_client,
):
    client, headers, _config = companion_client

    parsed = client.post(
        "/document/extract_text",
        json={
            "contentBase64": base64.b64encode(build_pdf(["Syllabus"])).decode("ascii"),
            "sourceUrl": "https://reports.example/opinion.pdf",
        },
        headers=headers,
    )
    assert parsed.status_code == 200, parsed.text
    assert parsed.json()["status"] == "parsed"
    assert parsed.json()["text"] == "## Page 1\n\nSyllabus"
    assert parsed.json()["url"] == "https://reports.example/opinion.pdf"

    empty = client.post(
        "/document/extract_text",
        json={"contentBase64": base64.b64encode(build_pdf([""])).decode("ascii")},
        headers=headers,
    )
    assert empty.status_code == 200, empty.text
    assert empty.json()["status"] == "empty"
    assert empty.json()["reason"] == "no_extractable_text"


def test_the_route_rejects_non_base64_content_and_local_provenance(companion_client):
    client, headers, _config = companion_client

    invalid = client.post(
        "/document/extract_text",
        json={"contentBase64": "not base64!!"},
        headers=headers,
    )
    assert invalid.status_code == 400

    local = client.post(
        "/document/extract_text",
        json={
            "contentBase64": base64.b64encode(build_pdf(["x"])).decode("ascii"),
            "sourceUrl": "file:///etc/passwd",
        },
        headers=headers,
    )
    assert local.status_code == 422
