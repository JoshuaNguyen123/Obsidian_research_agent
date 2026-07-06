from __future__ import annotations

import sys
from pathlib import Path

import pytest

pytest.importorskip("playwright")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browser_service import BrowserService
from schemas import (
    BrowserClickRequest,
    BrowserExtractMarkdownRequest,
    BrowserOpenRequest,
)


@pytest.mark.asyncio
async def test_browser_service_observes_clicks_and_extracts_markdown(tmp_path):
    service = BrowserService(tmp_path)
    await service.start()
    if not service.ready:
        pytest.skip(service.startup_error or "Playwright browser is not ready")

    try:
        page_path = Path(__file__).parent / "fixtures" / "deterministic_page.html"
        observation = await service.open(BrowserOpenRequest(url=page_path.as_uri()))
        assert observation.title == "Deterministic Agent Page"
        assert "Initial state" in (observation.visibleText or "")
        assert observation.candidates

        clicked = await service.click(BrowserClickRequest(selector="#change"))
        assert "Clicked state" in (clicked.visibleText or "")

        extracted = await service.extract_markdown(
            BrowserExtractMarkdownRequest(includeLinks=True, maxChars=2000)
        )
        assert "Deterministic Agent Page" in (extracted["markdown"] or "")
    finally:
        await service.stop()
