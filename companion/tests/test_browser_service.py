from __future__ import annotations

import sys
import datetime as dt
from pathlib import Path

import pytest

pytest.importorskip("playwright")

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from browser_service import BrowserService
from browser_security import BrowserBoundaryError, sign_safety_decision
from conftest import fp
from schemas import (
    BrowserClickRequest,
    BrowserExtractMarkdownRequest,
    BrowserKeypressRequest,
    BrowserOpenRequest,
)


@pytest.mark.asyncio
async def test_browser_service_observes_clicks_and_extracts_markdown(tmp_path):
    service = BrowserService(tmp_path, allow_file_urls=True)
    await service.start()
    if not service.ready:
        pytest.skip(service.startup_error or "Playwright browser is not ready")

    try:
        page_path = Path(__file__).parent / "fixtures" / "deterministic_page.html"
        url = page_path.as_uri()
        now = dt.datetime.now(dt.UTC)
        observation = await service.open(
            BrowserOpenRequest(
                url=url,
                safetyDecision=sign_safety_decision(
                    "s" * 43,
                    "navigate",
                    {"url": url, "missionMode": "supervised"},
                    policy_fingerprint=fp("1"),
                    nonce="navigate_nonce_1234567890",
                    decided_at=now,
                    expires_at=now + dt.timedelta(seconds=30),
                ),
            )
        )
        assert observation.title == "Deterministic Agent Page"
        assert "Initial state" in (observation.visibleText or "")
        assert observation.candidates

        click_candidate = next(
            candidate
            for candidate in observation.candidates
            if candidate.selector == "#change"
        )
        click_payload = {
            "candidateId": click_candidate.id,
            "selector": "#change",
            "candidateFingerprint": click_candidate.candidateFingerprint,
            "button": "left",
            "observedUrl": observation.url,
            "observationFingerprint": observation.observationFingerprint,
        }
        clicked = await service.click(
            BrowserClickRequest(
                **click_payload,
                safetyDecision=sign_safety_decision(
                    "s" * 43,
                    "click",
                    click_payload,
                    policy_fingerprint=fp("2"),
                    nonce="click_nonce_123456789012",
                    decided_at=now,
                    expires_at=now + dt.timedelta(seconds=30),
                ),
            )
        )
        assert "Clicked state" in (clicked.visibleText or "")

        extracted = await service.extract_markdown(
            BrowserExtractMarkdownRequest(
                includeLinks=True,
                maxChars=2000,
                safetyDecision=sign_safety_decision(
                    "s" * 43,
                    "extract",
                    {"includeLinks": True, "maxChars": 2000},
                    policy_fingerprint=fp("3"),
                    nonce="extract_nonce_1234567890",
                    decided_at=now,
                    expires_at=now + dt.timedelta(seconds=30),
                ),
            )
        )
        assert "Deterministic Agent Page" in (extracted["markdown"] or "")
    finally:
        await service.stop()


@pytest.mark.asyncio
async def test_browser_service_denies_mutated_retargeted_and_unfocused_candidates(tmp_path):
    service = BrowserService(tmp_path, allow_file_urls=True)
    await service.start()
    if not service.ready:
        pytest.skip(service.startup_error or "Playwright browser is not ready")

    token = "s" * 43
    now = dt.datetime.now(dt.UTC)
    page_path = Path(__file__).parent / "fixtures" / "deterministic_page.html"
    url = page_path.as_uri()
    try:
        observation = await service.open(
            BrowserOpenRequest(
                url=url,
                safetyDecision=sign_safety_decision(
                    token,
                    "navigate",
                    {"url": url, "missionMode": "supervised"},
                    policy_fingerprint=fp("4"),
                    nonce="retarget_navigate_nonce_1234",
                    decided_at=now,
                    expires_at=now + dt.timedelta(seconds=30),
                ),
            )
        )
        candidate = next(item for item in observation.candidates if item.selector == "#change")
        payload = {
            "candidateId": candidate.id,
            "selector": candidate.selector,
            "candidateFingerprint": candidate.candidateFingerprint,
            "button": "left",
            "observedUrl": observation.url,
            "observationFingerprint": observation.observationFingerprint,
        }
        await service.page.evaluate(
            "document.querySelector('#change').textContent = 'Changed target'"
        )
        with pytest.raises(BrowserBoundaryError, match="changed"):
            await service.click(
                BrowserClickRequest(
                    **payload,
                    safetyDecision=sign_safety_decision(
                        token,
                        "click",
                        payload,
                        policy_fingerprint=fp("5"),
                        nonce="mutated_click_nonce_12345",
                        decided_at=now,
                        expires_at=now + dt.timedelta(seconds=30),
                    ),
                )
            )

        observation = await service.observe()
        candidate = next(item for item in observation.candidates if item.selector == "#change")
        payload = {
            "candidateId": candidate.id,
            "selector": candidate.selector,
            "candidateFingerprint": candidate.candidateFingerprint,
            "button": "left",
            "observedUrl": observation.url,
            "observationFingerprint": observation.observationFingerprint,
        }
        await service.page.evaluate(
            """
            const original = document.querySelector('#change');
            original.replaceWith(original.cloneNode(true));
            """
        )
        with pytest.raises(BrowserBoundaryError, match="changed"):
            await service.click(
                BrowserClickRequest(
                    **payload,
                    safetyDecision=sign_safety_decision(
                        token,
                        "click",
                        payload,
                        policy_fingerprint=fp("6"),
                        nonce="retarget_click_nonce_1234",
                        decided_at=now,
                        expires_at=now + dt.timedelta(seconds=30),
                    ),
                )
            )

        await service.page.locator("#search").focus()
        observation = await service.observe()
        search = next(item for item in observation.candidates if item.selector == "#search")
        assert search.focused is True
        key_payload = {
            "key": "A",
            "candidateId": search.id,
            "selector": search.selector,
            "candidateFingerprint": search.candidateFingerprint,
            "observedUrl": observation.url,
            "observationFingerprint": observation.observationFingerprint,
        }
        keyed = await service.keypress(
            BrowserKeypressRequest(
                **key_payload,
                safetyDecision=sign_safety_decision(
                    token,
                    "keypress",
                    key_payload,
                    policy_fingerprint=fp("7"),
                    nonce="focused_keypress_nonce_123",
                    decided_at=now,
                    expires_at=now + dt.timedelta(seconds=30),
                ),
            )
        )
        assert await service.page.locator("#search").input_value() == "A"

        search = next(item for item in keyed.candidates if item.selector == "#search")
        await service.page.locator("#change").focus()
        stale_focus_payload = {
            "key": "B",
            "candidateId": search.id,
            "selector": search.selector,
            "candidateFingerprint": search.candidateFingerprint,
            "observedUrl": keyed.url,
            "observationFingerprint": keyed.observationFingerprint,
        }
        with pytest.raises(BrowserBoundaryError, match="focused"):
            await service.keypress(
                BrowserKeypressRequest(
                    **stale_focus_payload,
                    safetyDecision=sign_safety_decision(
                        token,
                        "keypress",
                        stale_focus_payload,
                        policy_fingerprint=fp("8"),
                        nonce="unfocused_keypress_nonce_12",
                        decided_at=now,
                        expires_at=now + dt.timedelta(seconds=30),
                    ),
                )
            )
    finally:
        await service.stop()
