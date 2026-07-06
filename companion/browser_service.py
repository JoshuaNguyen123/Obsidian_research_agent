from __future__ import annotations

import datetime as dt
import re
from pathlib import Path
from typing import Any

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
    from playwright.async_api import Browser, Page, async_playwright
except Exception:  # pragma: no cover - lets memory/health tests run before Playwright install.
    Browser = Any  # type: ignore
    Page = Any  # type: ignore
    async_playwright = None  # type: ignore


class BrowserService:
    def __init__(self, data_dir: Path):
        self.data_dir = data_dir
        self.screenshot_dir = data_dir / "screenshots"
        self.playwright = None
        self.browser: Browser | None = None
        self.page: Page | None = None
        self.ready = False
        self.startup_error: str | None = None

    async def start(self) -> None:
        self.screenshot_dir.mkdir(parents=True, exist_ok=True)
        if async_playwright is None:
            self.startup_error = "Playwright is not installed."
            self.ready = False
            return

        try:
            self.playwright = await async_playwright().start()
            self.browser = await self.playwright.chromium.launch(headless=False)
            self.page = await self.browser.new_page()
            self.ready = True
        except Exception as exc:  # pragma: no cover - environment dependent.
            self.startup_error = str(exc)
            self.ready = False

    async def stop(self) -> None:
        self.ready = False
        if self.browser:
            await self.browser.close()
        if self.playwright:
            await self.playwright.stop()

    async def open(self, request: BrowserOpenRequest) -> BrowserObservation:
        page = self._page()
        await page.goto(request.url, wait_until="domcontentloaded")
        return await self.observe()

    async def observe(self) -> BrowserObservation:
        page = self._page()
        title = await page.title()
        url = page.url
        visible_text = await safe_body_text(page)
        candidates = await self._clickable_candidates()
        screenshot = await self._save_screenshot(full_page=False)
        return BrowserObservation(
            url=url,
            title=title,
            visibleText=visible_text[:20_000],
            visibleTextSummary=summarize_text(visible_text),
            screenshotPath=str(screenshot),
            candidates=candidates,
            pageStateHints=derive_page_state_hints(visible_text),
            observedAt=dt.datetime.now(dt.UTC).isoformat(),
        )

    async def click(self, request: BrowserClickRequest) -> BrowserObservation:
        page = self._page()
        if request.selector:
            await page.locator(request.selector).first.click(button=request.button)
        elif request.x is not None and request.y is not None:
            await page.mouse.click(request.x, request.y, button=request.button)
        else:
            raise ValueError("Click requires selector or x/y coordinates.")
        await page.wait_for_timeout(300)
        return await self.observe()

    async def type(self, request: BrowserTypeRequest) -> BrowserObservation:
        if not request.selector:
            raise ValueError("Type requires selector in the MVP implementation.")
        locator = self._page().locator(request.selector).first
        if request.clearFirst:
            await locator.fill("")
        await locator.type(request.text)
        return await self.observe()

    async def keypress(self, request: BrowserKeypressRequest) -> BrowserObservation:
        await self._page().keyboard.press(request.key)
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
        return await self._page().evaluate(
            """
            () => {
              const nodes = Array.from(document.querySelectorAll(
                'a,button,input,textarea,select,[role="button"],[onclick]'
              ));
              return nodes.slice(0, 100).map((el, index) => {
                const rect = el.getBoundingClientRect();
                const text = (el.innerText || el.value || el.getAttribute('aria-label') || '').trim();
                const label = text || el.getAttribute('href') || el.tagName.toLowerCase();
                const type = el.getAttribute('type') || '';
                return {
                  id: `candidate-${index}`,
                  label,
                  role: el.getAttribute('role') || type || el.tagName.toLowerCase(),
                  tagName: el.tagName.toLowerCase(),
                  selector: cssPath(el),
                  href: el.getAttribute('href'),
                  text,
                  enabled: !el.disabled,
                  visible: !!(rect.width && rect.height),
                  bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                  riskHints: riskHints(label, type)
                };
              });
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

    async def _save_screenshot(self, full_page: bool) -> Path:
        timestamp = dt.datetime.now(dt.UTC).strftime("%Y%m%dT%H%M%S%fZ")
        path = self.screenshot_dir / f"{timestamp}.png"
        await self._page().screenshot(path=str(path), full_page=full_page)
        return path

    def _page(self) -> Page:
        if not self.ready or not self.page:
            raise RuntimeError(self.startup_error or "Browser page is not initialized.")
        return self.page


async def safe_body_text(page: Page) -> str:
    try:
        return await page.locator("body").inner_text(timeout=5_000)
    except Exception:
        return ""


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
