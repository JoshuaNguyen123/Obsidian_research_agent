from __future__ import annotations

import datetime as dt
import re
import socket
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from browser_security import BrowserBoundaryError, PinnedPublicProxy, validate_public_http_url
from persisted_data import canonical_fingerprint

from schemas import (
    BrowserClickRequest,
    BrowserExtractMarkdownRequest,
    BrowserKeypressRequest,
    BrowserObservation,
    BrowserOpenRequest,
    BrowserScreenshotRequest,
    BrowserScrollRequest,
    BrowserTypeRequest,
)
from web_extract import html_to_markdown

try:
    from playwright.async_api import (
        Browser,
        BrowserContext,
        ElementHandle,
        Page,
        async_playwright,
    )
except Exception:  # pragma: no cover - lets memory/health tests run before Playwright install.
    Browser = Any  # type: ignore
    Page = Any  # type: ignore
    BrowserContext = Any  # type: ignore
    ElementHandle = Any  # type: ignore
    async_playwright = None  # type: ignore


class BrowserService:
    def __init__(
        self,
        data_dir: Path,
        headless: bool = False,
        allow_file_urls: bool = False,
        resolver: Any = None,
    ):
        self.data_dir = data_dir
        self.headless = headless
        self.allow_file_urls = allow_file_urls
        self.resolver = resolver
        self.screenshot_dir = data_dir / "screenshots"
        self.playwright = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None
        self.ready = False
        self.startup_error: str | None = None
        self.last_observation_fingerprint: str | None = None
        self.last_candidates: dict[str, dict[str, Any]] = {}
        self.last_candidate_handles: dict[str, ElementHandle] = {}
        self.pending_boundary_error: BrowserBoundaryError | None = None
        self.pinned_proxy: PinnedPublicProxy | None = None

    async def start(self) -> None:
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        if async_playwright is None:
            self.startup_error = "Playwright is not installed."
            self.ready = False
            return

        try:
            self.playwright = await async_playwright().start()
            self.pinned_proxy = PinnedPublicProxy(
                resolver=self.resolver or socket.getaddrinfo,
                on_boundary_error=self._record_proxy_boundary_error,
            )
            await self.pinned_proxy.start()
            self.browser = await self.playwright.chromium.launch(
                headless=self.headless,
                proxy={"server": self.pinned_proxy.server_url, "bypass": "<-loopback>"},
            )
            self.context = await self.browser.new_context(
                service_workers="block",
                accept_downloads=False,
            )
            self.page = await self.context.new_page()
            await self.page.route("**/*", self._guard_route)
            await self.page.add_init_script(
                """
                Object.defineProperty(globalThis, 'WebSocket', {
                  configurable: false,
                  writable: false,
                  value: class BlockedWebSocket {
                    constructor() { throw new Error('WebSocket blocked by companion boundary'); }
                  }
                });
                """
            )
            self.ready = True
        except Exception as exc:  # pragma: no cover - environment dependent.
            self.startup_error = str(exc)
            self.ready = False
            if self.browser:
                await self.browser.close()
                self.browser = None
            if self.playwright:
                await self.playwright.stop()
                self.playwright = None
            if self.pinned_proxy:
                await self.pinned_proxy.stop()
                self.pinned_proxy = None

    async def stop(self) -> None:
        self.ready = False
        await self._dispose_candidate_handles()
        try:
            if self.browser:
                await self.browser.close()
        finally:
            self.browser = None
            try:
                if self.playwright:
                    await self.playwright.stop()
            finally:
                self.playwright = None
                if self.pinned_proxy:
                    await self.pinned_proxy.stop()
                    self.pinned_proxy = None

    async def open(self, request: BrowserOpenRequest) -> BrowserObservation:
        await self._validate_target(request.url)
        page = self._page()
        self.pending_boundary_error = None
        try:
            await page.goto(request.url, wait_until="domcontentloaded")
        except Exception:
            if self.pending_boundary_error:
                raise self.pending_boundary_error
            raise
        if self.pending_boundary_error:
            error = self.pending_boundary_error
            await page.goto("about:blank")
            raise error
        try:
            await self._validate_target(page.url)
        except BrowserBoundaryError:
            await page.goto("about:blank")
            raise
        return await self.observe()

    async def observe(self) -> BrowserObservation:
        page = self._page()
        title = await page.title()
        url = page.url
        visible_text = await safe_body_text(page)
        candidates = await self._clickable_candidates()
        screenshot = await self._save_screenshot(full_page=False)
        observation_payload = {
            "url": url,
            "title": title,
            "visibleText": visible_text[:20_000],
            "candidates": candidates,
            "pageStateHints": derive_page_state_hints(visible_text),
        }
        fingerprint = canonical_fingerprint(observation_payload)
        self.last_observation_fingerprint = fingerprint
        self.last_candidates = {
            str(candidate["id"]): candidate for candidate in candidates
        }
        return BrowserObservation(
            url=url,
            title=title,
            visibleText=visible_text[:20_000],
            visibleTextSummary=summarize_text(visible_text),
            screenshotPath=str(screenshot),
            candidates=candidates,
            pageStateHints=derive_page_state_hints(visible_text),
            observedAt=dt.datetime.now(dt.UTC).isoformat(),
            observationFingerprint=fingerprint,
        )

    async def click(self, request: BrowserClickRequest) -> BrowserObservation:
        self._require_observation(request.observedUrl, request.observationFingerprint)
        handle = await self._require_live_candidate(
            request.candidateId,
            request.selector,
            request.candidateFingerprint,
        )
        await handle.click(button=request.button)
        await self._page().wait_for_timeout(300)
        return await self.observe()

    async def type(self, request: BrowserTypeRequest) -> BrowserObservation:
        self._require_observation(request.observedUrl, request.observationFingerprint)
        handle = await self._require_live_candidate(
            request.candidateId,
            request.selector,
            request.candidateFingerprint,
        )
        if request.clearFirst:
            await handle.fill("")
        await handle.type(request.text)
        return await self.observe()

    async def keypress(self, request: BrowserKeypressRequest) -> BrowserObservation:
        self._require_observation(request.observedUrl, request.observationFingerprint)
        handle = await self._require_live_candidate(
            request.candidateId,
            request.selector,
            request.candidateFingerprint,
            require_focus=True,
        )
        await handle.press(request.key)
        return await self.observe()

    async def scroll(self, request: BrowserScrollRequest) -> BrowserObservation:
        amount = request.amount
        dx = amount if request.direction == "right" else -amount if request.direction == "left" else 0
        dy = amount if request.direction == "down" else -amount if request.direction == "up" else 0
        await self._page().mouse.wheel(dx, dy)
        await self._page().wait_for_timeout(200)
        return await self.observe()

    async def screenshot(self, request: BrowserScreenshotRequest) -> dict[str, str]:
        path = await self._save_screenshot(full_page=request.fullPage)
        return {"screenshotPath": str(path)}

    async def extract_markdown(self, request: BrowserExtractMarkdownRequest) -> dict[str, str | None]:
        page = self._page()
        html = await page.content()
        markdown = html_to_markdown(html, base_url=page.url, include_links=request.includeLinks)
        return {
            "url": page.url,
            "title": await page.title(),
            "markdown": markdown[: request.maxChars],
        }

    async def _clickable_candidates(self) -> list[dict[str, Any]]:
        await self._dispose_candidate_handles()
        handles = await self._page().query_selector_all(
            'a,button,input,textarea,select,[role="button"],[onclick]'
        )
        candidates: list[dict[str, Any]] = []
        for index, handle in enumerate(handles[:100]):
            candidate = await handle.evaluate(
                """
              (el) => {
                const rect = el.getBoundingClientRect();
                const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
                const label = text || el.getAttribute('href') || el.tagName.toLowerCase();
                const inputType = el.getAttribute('type');
                const role = el.getAttribute('role') || inputType || el.tagName.toLowerCase();
                const form = el.form || el.closest('form');
                const formAction = form
                  ? (el.getAttribute('formaction') || form.getAttribute('action') || location.href)
                  : null;
                const formMethod = form
                  ? (el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase()
                  : null;
                const tagName = el.tagName.toLowerCase();
                const effectiveType = (inputType || (tagName === 'button' ? 'submit' : '')).toLowerCase();
                const submitsForm = !!form && (
                  (tagName === 'button' && effectiveType === 'submit') ||
                  (tagName === 'input' && /^(?:submit|image)$/.test(effectiveType))
                );
                return {
                  label,
                  role,
                  tagName,
                  selector: cssPath(el),
                  href: el.getAttribute('href'),
                  formAction,
                  formMethod,
                  submitsForm,
                  inputType,
                  text,
                  enabled: !el.disabled,
                  visible: !!(rect.width && rect.height),
                  focused: document.activeElement === el,
                  bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  riskHints: riskHints(label, inputType || '')
                };

              function riskHints(label, type) {
                const text = `${label} ${type}`;
                const hints = [];
                if (/password|login|sign in/i.test(text)) hints.push('credentials_possible');
                if (/checkout|payment|purchase|buy now/i.test(text)) hints.push('payment_possible');
                if (/upload|file/i.test(text)) hints.push('upload_possible');
                if (/download|exe|dmg|msi|pkg|sh/i.test(text)) hints.push('download_possible');
                if (/delete|remove|submit/i.test(text)) hints.push('mutation_possible');
                return hints;
              }
              function cssPath(el) {
                if (el.id) return `#${CSS.escape(el.id)}`;
                const parts = [];
                while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
                  let part = el.tagName.toLowerCase();
                  const parent = el.parentElement;
                  if (parent) {
                    const same = Array.from(parent.children).filter(child => child.tagName === el.tagName);
                    if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
                  }
                  parts.unshift(part);
                  el = parent;
                }
                return parts.join(' > ');
              }
            }
                """
            )
            candidate_id = f"candidate-{index}"
            candidate["id"] = candidate_id
            candidate["candidateFingerprint"] = candidate_fingerprint(
                candidate_id, candidate
            )
            candidates.append(candidate)
            self.last_candidate_handles[candidate_id] = handle
        for handle in handles[100:]:
            await handle.dispose()
        return candidates

    async def _save_screenshot(self, full_page: bool) -> Path:
        timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S%fZ")
        path = self.screenshot_dir / f"{timestamp}.png"
        await self._page().screenshot(path=str(path), full_page=full_page)
        return path

    def _page(self) -> Page:
        if not self.ready or not self.page:
            raise RuntimeError(self.startup_error or "Browser page is not initialized.")
        return self.page

    def _require_observation(self, observed_url: str, fingerprint: str) -> None:
        page = self._page()
        if page.url != observed_url or self.last_observation_fingerprint != fingerprint:
            raise BrowserBoundaryError(
                "stale_browser_observation",
                "The browser page changed after the host SafetyPolicy decision.",
            )

    async def _require_live_candidate(
        self,
        candidate_id: str,
        selector: str,
        fingerprint: str,
        *,
        require_focus: bool = False,
    ) -> ElementHandle:
        candidate = self.last_candidates.get(candidate_id)
        handle = self.last_candidate_handles.get(candidate_id)
        if (
            not candidate
            or not handle
            or candidate.get("selector") != selector
            or candidate.get("candidateFingerprint") != fingerprint
            or candidate.get("visible") is not True
            or candidate.get("enabled") is not True
        ):
            raise BrowserBoundaryError(
                "unobserved_browser_target",
                "Click and type targets must match one enabled, visible observed candidate.",
            )
        live = await handle.evaluate(
            """
            (el) => {
              const rect = el.getBoundingClientRect();
              const inputType = el.getAttribute('type');
              const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
              const form = el.form || el.closest('form');
              const formAction = form
                ? (el.getAttribute('formaction') || form.getAttribute('action') || location.href)
                : null;
              const formMethod = form
                ? (el.getAttribute('formmethod') || form.getAttribute('method') || 'get').toLowerCase()
                : null;
              const tagName = el.tagName.toLowerCase();
              const effectiveType = (inputType || (tagName === 'button' ? 'submit' : '')).toLowerCase();
              const submitsForm = !!form && (
                (tagName === 'button' && effectiveType === 'submit') ||
                (tagName === 'input' && /^(?:submit|image)$/.test(effectiveType))
              );
              return {
                connected: el.isConnected,
                focused: document.activeElement === el,
                role: el.getAttribute('role') || inputType || el.tagName.toLowerCase(),
                selector: cssPath(el),
                href: el.getAttribute('href'),
                formAction,
                formMethod,
                submitsForm,
                inputType,
                text,
                enabled: !el.disabled,
                visible: !!(rect.width && rect.height)
              };

              function cssPath(el) {
                if (el.id) return `#${CSS.escape(el.id)}`;
                const parts = [];
                while (el && el.nodeType === Node.ELEMENT_NODE && parts.length < 4) {
                  let part = el.tagName.toLowerCase();
                  const parent = el.parentElement;
                  if (parent) {
                    const same = Array.from(parent.children).filter(child => child.tagName === el.tagName);
                    if (same.length > 1) part += `:nth-of-type(${same.indexOf(el) + 1})`;
                  }
                  parts.unshift(part);
                  el = parent;
                }
                return parts.join(' > ');
              }
            }
            """
        )
        live_fingerprint = candidate_fingerprint(candidate_id, live)
        if (
            live.get("connected") is not True
            or live.get("visible") is not True
            or live.get("enabled") is not True
            or live.get("selector") != selector
            or live_fingerprint != fingerprint
        ):
            raise BrowserBoundaryError(
                "browser_target_changed",
                "The observed browser target changed before the approved action.",
            )
        if require_focus and live.get("focused") is not True:
            raise BrowserBoundaryError(
                "browser_focus_changed",
                "Keypress requires the exact attested candidate to remain focused.",
            )
        return handle

    async def _dispose_candidate_handles(self) -> None:
        handles = list(self.last_candidate_handles.values())
        self.last_candidate_handles = {}
        for handle in handles:
            try:
                await handle.dispose()
            except Exception:
                pass

    async def _validate_target(self, url: str) -> None:
        if self.allow_file_urls and urlparse(url).scheme.lower() == "file":
            return
        if self.resolver is None:
            await validate_public_http_url(url)
        else:
            await validate_public_http_url(url, self.resolver)

    async def _guard_route(self, route: Any) -> None:
        url = route.request.url
        scheme = urlparse(url).scheme.lower()
        if scheme in {"about", "data", "blob"}:
            await route.continue_()
            return
        try:
            await self._validate_target(url)
        except BrowserBoundaryError as exc:
            self.pending_boundary_error = exc
            await route.abort("blockedbyclient")
            return
        await route.continue_()

    def _record_proxy_boundary_error(self, error: BrowserBoundaryError) -> None:
        self.pending_boundary_error = error


async def safe_body_text(page: Page) -> str:
    try:
        return await page.locator("body").inner_text(timeout=5_000)
    except Exception:
        return ""


def candidate_fingerprint(candidate_id: str, value: dict[str, Any]) -> str:
    return canonical_fingerprint(
        {
            "version": 1,
            "candidateId": candidate_id,
            "selector": value.get("selector"),
            "role": value.get("role"),
            "text": value.get("text"),
            "href": value.get("href"),
            "formAction": value.get("formAction"),
            "formMethod": value.get("formMethod"),
            "submitsForm": value.get("submitsForm"),
            "inputType": value.get("inputType"),
        }
    )


def summarize_text(text: str, max_chars: int = 800) -> str:
    compact = re.sub(r"\s+", " ", text).strip()
    return compact[:max_chars]


def derive_page_state_hints(text: str) -> list[str]:
    hints: list[str] = []
    for pattern, label in [
        (r"log\s*in|sign\s*in|password", "login_or_credentials_possible"),
        (r"checkout|payment|purchase|buy now", "payment_or_purchase_possible"),
        (r"upload|choose file", "upload_possible"),
        (r"download", "download_possible"),
    ]:
        if re.search(pattern, text, flags=re.I):
            hints.append(label)
    return hints
