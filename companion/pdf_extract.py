from __future__ import annotations

import io
import re
from dataclasses import dataclass
from typing import Any, Literal

from pypdf import PdfReader


DEFAULT_MAX_PAGES = 100
DEFAULT_MAX_CHARS = 60_000

_CONTROL_CHARACTERS = re.compile(r"[\x00-\x08\x0b\x0e-\x1f\x7f]")
_HORIZONTAL_WHITESPACE = re.compile(r"[^\S\n]+")
_BLANK_LINE_RUN = re.compile(r"\n{3,}")


@dataclass(frozen=True)
class PdfExtraction:
    """The outcome of one bounded PDF text extraction.

    ``status`` carries the distinction a researcher actually needs: ``"empty"``
    with a ``reason`` means the document is unusable and another source should
    be tried, which is a different answer from a parsed document that happens
    to be short. An empty ``text`` alone cannot express that difference.
    """

    status: Literal["parsed", "empty"]
    text: str
    page_count: int
    pages_extracted: int
    pages_skipped: int
    truncated: bool
    reason: str | None = None


def extract_pdf_text(
    data: bytes,
    *,
    max_pages: int = DEFAULT_MAX_PAGES,
    max_chars: int = DEFAULT_MAX_CHARS,
) -> PdfExtraction:
    """Turn PDF bytes into page-marked plain text within fixed bounds.

    Every page is extracted independently: a page whose content stream pypdf
    cannot decode is counted and skipped, never fatal, because one broken page
    in a 90-page opinion must not cost the other 89. Output keeps a
    ``## Page N`` heading per page so a citation can point at a page rather
    than at the document.
    """

    page_budget = max(1, int(max_pages))
    char_budget = max(1, int(max_chars))

    if not data:
        return _no_text("unreadable_document")
    try:
        reader = PdfReader(io.BytesIO(bytes(data)))
    except Exception:
        return _no_text("unreadable_document")
    if getattr(reader, "is_encrypted", False) and not _unlock(reader):
        return _no_text("encrypted")
    try:
        pages = list(reader.pages)
    except Exception:
        return _no_text("unreadable_document")

    page_count = len(pages)
    considered = pages[:page_budget]
    beyond_page_budget = page_count > len(considered)
    beyond_char_budget = False
    sections: list[str] = []
    used = 0
    extracted = 0
    skipped = 0

    for number, page in enumerate(considered, start=1):
        try:
            body = normalize_pdf_text(page_text(page))
        except Exception:
            skipped += 1
            continue
        if not body:
            continue
        separator = "\n\n" if sections else ""
        remaining = char_budget - used - len(separator)
        if remaining <= 0:
            beyond_char_budget = True
            break
        section = f"## Page {number}\n\n{body}"
        if len(section) > remaining:
            section = section[:remaining].rstrip()
            beyond_char_budget = True
            # A fragment too short to carry any page body is noise, not a
            # citable passage.
            if "\n" not in section:
                break
        used += len(separator) + len(section)
        sections.append(section)
        extracted += 1
        if beyond_char_budget:
            break

    truncated = beyond_page_budget or beyond_char_budget
    text = "\n\n".join(sections)
    if not text:
        return PdfExtraction(
            status="empty",
            text="",
            page_count=page_count,
            pages_extracted=0,
            pages_skipped=skipped,
            truncated=truncated,
            reason="no_extractable_text",
        )
    return PdfExtraction(
        status="parsed",
        text=text,
        page_count=page_count,
        pages_extracted=extracted,
        pages_skipped=skipped,
        truncated=truncated,
    )


def page_text(page: Any) -> str:
    """The single seam every page extraction travels through."""

    return page.extract_text() or ""


def normalize_pdf_text(value: str) -> str:
    """Collapse pypdf's ragged intra-line spacing without losing paragraphs.

    pypdf reconstructs lines from glyph positions, so a single line arrives
    padded with runs of spaces. Those runs carry no meaning and wreck passage
    matching, but blank lines between them are the only paragraph structure a
    PDF ever offers, so they survive.
    """

    if not value:
        return ""
    text = value.replace("\r\n", "\n").replace("\r", "\n").replace("\x0c", "\n\n")
    text = _CONTROL_CHARACTERS.sub("", text)
    text = _HORIZONTAL_WHITESPACE.sub(" ", text)
    text = "\n".join(line.strip() for line in text.split("\n"))
    return _BLANK_LINE_RUN.sub("\n\n", text).strip()


def _unlock(reader: PdfReader) -> bool:
    # Publishers routinely "encrypt" a PDF only to assert print/copy
    # restrictions; those open with an empty user password. Anything that needs
    # a real password is reported as encrypted rather than silently empty.
    try:
        return bool(reader.decrypt(""))
    except Exception:
        return False


def _no_text(reason: str) -> PdfExtraction:
    return PdfExtraction(
        status="empty",
        text="",
        page_count=0,
        pages_extracted=0,
        pages_skipped=0,
        truncated=False,
        reason=reason,
    )
