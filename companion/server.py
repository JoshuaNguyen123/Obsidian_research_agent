from __future__ import annotations

from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from browser_service import BrowserService
from memory_store import MemoryStore
from schemas import (
    BrowserClickRequest,
    BrowserExtractMarkdownRequest,
    BrowserKeypressRequest,
    BrowserOpenRequest,
    BrowserScreenshotRequest,
    BrowserScrollRequest,
    BrowserTypeRequest,
    HealthResponse,
    MemorySearchRequest,
    MemorySearchResponse,
    MemoryWriteRequest,
    MemoryWriteResponse,
)


DATA_DIR = Path(__file__).parent / "data"
STATIC_DIR = Path(__file__).parent / "static"


@asynccontextmanager
async def lifespan(app: FastAPI):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    STATIC_DIR.mkdir(parents=True, exist_ok=True)
    app.state.browser = BrowserService(data_dir=DATA_DIR)
    app.state.memory = MemoryStore(DATA_DIR / "memory.sqlite3")
    await app.state.browser.start()
    app.state.memory.initialize()
    try:
        yield
    finally:
        await app.state.browser.stop()
        app.state.memory.close()


app = FastAPI(title="Obsidian Research Companion", version="0.1.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(
        browserReady=app.state.browser.ready,
        memoryReady=app.state.memory.ready,
    )


@app.post("/browser/open")
async def browser_open(request: BrowserOpenRequest):
    return await app.state.browser.open(request)


@app.post("/browser/observe")
async def browser_observe():
    return await app.state.browser.observe()


@app.post("/browser/click")
async def browser_click(request: BrowserClickRequest):
    return await app.state.browser.click(request)


@app.post("/browser/type")
async def browser_type(request: BrowserTypeRequest):
    return await app.state.browser.type(request)


@app.post("/browser/keypress")
async def browser_keypress(request: BrowserKeypressRequest):
    return await app.state.browser.keypress(request)


@app.post("/browser/scroll")
async def browser_scroll(request: BrowserScrollRequest):
    return await app.state.browser.scroll(request)


@app.post("/browser/screenshot")
async def browser_screenshot(request: BrowserScreenshotRequest):
    return await app.state.browser.screenshot(request)


@app.post("/browser/extract_markdown")
async def browser_extract_markdown(request: BrowserExtractMarkdownRequest):
    return await app.state.browser.extract_markdown(request)


@app.post("/memory/write", response_model=MemoryWriteResponse)
async def memory_write(request: MemoryWriteRequest) -> MemoryWriteResponse:
    return MemoryWriteResponse(id=app.state.memory.write(request))


@app.post("/memory/search", response_model=MemorySearchResponse)
async def memory_search(request: MemorySearchRequest) -> MemorySearchResponse:
    return MemorySearchResponse(results=app.state.memory.search(request))
