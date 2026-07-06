from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field


class HealthResponse(BaseModel):
    ok: bool = True
    service: str = "obsidian-research-companion"
    browserReady: bool
    memoryReady: bool
    version: str = "0.1.0"


class BrowserOpenRequest(BaseModel):
    url: str
    missionMode: Literal["supervised", "extract_only"] = "supervised"


class BrowserClickRequest(BaseModel):
    candidateId: str | None = None
    selector: str | None = None
    x: float | None = None
    y: float | None = None
    button: Literal["left", "middle", "right"] = "left"


class BrowserTypeRequest(BaseModel):
    candidateId: str | None = None
    selector: str | None = None
    text: str
    clearFirst: bool = False


class BrowserKeypressRequest(BaseModel):
    key: str


class BrowserScrollRequest(BaseModel):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(default=700, ge=1, le=3000)


class BrowserScreenshotRequest(BaseModel):
    fullPage: bool = False


class BrowserExtractMarkdownRequest(BaseModel):
    includeLinks: bool = True
    maxChars: int = Field(default=60_000, ge=1, le=250_000)


class Bounds(BaseModel):
    x: float
    y: float
    width: float
    height: float


class ClickableCandidate(BaseModel):
    id: str
    label: str
    role: str | None = None
    tagName: str | None = None
    selector: str | None = None
    href: str | None = None
    text: str | None = None
    enabled: bool
    visible: bool
    bounds: Bounds | None = None
    riskHints: list[str] = Field(default_factory=list)


class BrowserObservation(BaseModel):
    url: str
    title: str | None = None
    visibleTextSummary: str | None = None
    visibleText: str | None = None
    screenshotPath: str | None = None
    candidates: list[ClickableCandidate] = Field(default_factory=list)
    pageStateHints: list[str] = Field(default_factory=list)
    observedAt: str


class MemoryWriteRequest(BaseModel):
    kind: Literal["episodic", "semantic", "procedural", "source"]
    content: str
    confidence: float = Field(ge=0, le=1)
    tags: list[str] = Field(default_factory=list)
    sourceUrl: str | None = None
    sourceTitle: str | None = None
    vaultPath: str | None = None
    evidenceRefs: list[dict] = Field(default_factory=list)
    taskId: str | None = None


class MemoryWriteResponse(BaseModel):
    id: str


class MemorySearchRequest(BaseModel):
    query: str
    kinds: list[str] | None = None
    tags: list[str] | None = None
    limit: int = Field(default=10, ge=1, le=50)
    minScore: float | None = None


class MemorySearchResult(BaseModel):
    id: str
    kind: str
    content: str
    score: float
    confidence: float
    tags: list[str]
    sourceUrl: str | None = None
    sourceTitle: str | None = None
    vaultPath: str | None = None
    createdAt: str


class MemorySearchResponse(BaseModel):
    results: list[MemorySearchResult]
