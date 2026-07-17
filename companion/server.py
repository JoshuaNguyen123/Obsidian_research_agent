from __future__ import annotations

import asyncio
import json
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Callable

from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from auth import CompanionBoundaryMiddleware
from browser_security import (
    BrowserBoundaryError,
    BrowserSafetyVerifier,
    browser_action_payload,
)
from browser_service import BrowserService
from config import CompanionConfig
from coordinator_store import (
    CoordinatorStore,
    CoordinatorStoreError,
    IdempotencyConflict,
    JobLeaseConflict,
    JobLeaseInvalid,
    JobNotFound,
)
from memory_store import MemoryStore
from host_approval_signer import HostApprovalSigner, HostApprovalSignerError
from schemas import (
    BrowserClickRequest,
    BrowserExtractMarkdownRequest,
    BrowserKeypressRequest,
    BrowserOpenRequest,
    BrowserObserveRequest,
    BrowserScreenshotRequest,
    BrowserScrollRequest,
    BrowserTypeRequest,
    CompanionStatusResponse,
    EventAppendRequest,
    EventRecord,
    HealthResponse,
    HostApprovalReceiptV1,
    HostApprovalSignRequestV1,
    HostApprovalSignerDescriptionV1,
    HostApprovalSignerMutationRequestV1,
    HostApprovalVerificationResultV1,
    HostApprovalVerifyRequestV1,
    JobClaimRequest,
    JobCompletionRequest,
    JobCreateRequest,
    JobLeaseMutationRequest,
    JobLeaseResponse,
    JobRecord,
    LinearQueueConfigurationV1,
    LinearQueueEventRecordV1,
    LinearQueueScanClaimRequest,
    LinearQueueScanClaimResponse,
    LinearQueueScanCompleteRequest,
    LinearQueueScanFailureRequest,
    LinearQueueRescanRequestV1,
    LinearQueueStatusV1,
    MemoryClearRequest,
    MemoryDeleteRequest,
    MemoryMutationReceiptV1,
    MemorySearchRequest,
    MemorySearchResponse,
    MemoryWriteRequest,
    MemoryWriteResponse,
    ReceiptAppendRequest,
    ReceiptRecord,
    SecretDescription,
    SecretLeaseRequest,
    SecretLeaseResponse,
    SecretPutRequest,
    SecretRemoveResponse,
    WorkerHeartbeatRequest,
    WorkerHeartbeatResponse,
)
from secure_store import SecretBackend, SecretStore


DEFAULT_DATA_DIR = Path(__file__).parent / "data"
STATIC_DIR = Path(__file__).parent / "static"
_AUTO_SECURE_BACKEND = object()
EVENT_REPLAY_PAGE_SIZE = 500
EVENT_REPLAY_LIMIT = 10_000
EVENT_REPLAY_TIME_LIMIT_SECONDS = 5.0


def create_app(
    config: CompanionConfig | None = None,
    *,
    browser_factory: Callable[[Path, bool], BrowserService] | None = None,
    secure_backend: SecretBackend | None | object = _AUTO_SECURE_BACKEND,
    expected_worker_catalog_fingerprint: str | None = None,
    installed_executor_domains: tuple[str, ...] = (),
    worker_diagnostic_provider: Callable[[], str | None] | None = None,
) -> FastAPI:
    selected = config or CompanionConfig.from_environment(DEFAULT_DATA_DIR)
    data_dir = selected.validate_data_boundary()
    browser_factory = browser_factory or (
        lambda data_dir, headless: BrowserService(data_dir=data_dir, headless=headless)
    )

    @asynccontextmanager
    async def lifespan(instance: FastAPI):
        selected.validate_data_boundary()
        data_dir.mkdir(parents=True, exist_ok=True)
        selected.validate_data_boundary()
        STATIC_DIR.mkdir(parents=True, exist_ok=True)
        instance.state.browser = browser_factory(
            data_dir, selected.browser_headless
        )
        instance.state.memory = MemoryStore(data_dir / "memory.sqlite3")
        instance.state.coordinator = CoordinatorStore(
            data_dir / "coordinator.sqlite3",
            integrity_key=selected.security.bootstrap_token,
        )
        instance.state.secrets = SecretStore(
            data_dir / "secrets.sqlite3",
            backend=(
                None if secure_backend is _AUTO_SECURE_BACKEND else secure_backend
            ),  # type: ignore[arg-type]
            allow_session_fallback=(
                selected.allow_session_secrets and not selected.background_requested
            ),
            detect_backend=secure_backend is _AUTO_SECURE_BACKEND,
        )
        instance.state.host_approval_signer = HostApprovalSigner(
            instance.state.secrets.backend
        )
        instance.state.coordinator_id = f"coordinator_{uuid.uuid4()}"
        instance.state.config = selected
        instance.state.browser_safety = BrowserSafetyVerifier(
            selected.security.bootstrap_token
        )
        selected.validate_data_boundary()
        instance.state.memory.initialize()
        instance.state.coordinator.initialize()
        instance.state.secrets.initialize()
        await instance.state.browser.start()
        try:
            yield
        finally:
            await instance.state.browser.stop()
            instance.state.memory.close()
            instance.state.coordinator.close()
            instance.state.secrets.close()

    application = FastAPI(
        title="Obsidian Research Companion",
        version="0.3.0",
        lifespan=lifespan,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
    )
    application.add_middleware(CompanionBoundaryMiddleware, config=selected.security)
    application.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

    @application.exception_handler(CoordinatorStoreError)
    async def coordinator_error_handler(
        _request: Request, exc: CoordinatorStoreError
    ) -> JSONResponse:
        if isinstance(exc, JobNotFound):
            status_code = 404
        elif isinstance(exc, (JobLeaseConflict, IdempotencyConflict)):
            status_code = 409
        elif isinstance(exc, JobLeaseInvalid):
            status_code = 403
        else:
            status_code = 400
        return JSONResponse(
            status_code=status_code,
            content={"ok": False, "error": exc.code, "detail": str(exc)},
            headers={"Cache-Control": "no-store"},
        )

    @application.exception_handler(BrowserBoundaryError)
    async def browser_boundary_error_handler(
        _request: Request, exc: BrowserBoundaryError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=403,
            content={"ok": False, "error": exc.code, "detail": str(exc)},
            headers={"Cache-Control": "no-store"},
        )

    @application.exception_handler(HostApprovalSignerError)
    async def host_approval_signer_error_handler(
        _request: Request, exc: HostApprovalSignerError
    ) -> JSONResponse:
        return JSONResponse(
            status_code=503,
            content={"ok": False, "error": exc.code, "detail": str(exc)},
            headers={"Cache-Control": "no-store"},
        )

    @application.get("/health", response_model=HealthResponse)
    async def health() -> HealthResponse:
        persistent = application.state.secrets.persistent
        worker = _worker_status(
            application, expected_worker_catalog_fingerprint, worker_diagnostic_provider
        )
        background_enabled = (
            selected.background_requested and persistent and worker["workerReady"]
        )
        return HealthResponse(
            browserReady=application.state.browser.ready,
            memoryReady=application.state.memory.ready,
            coordinatorReady=application.state.coordinator.ready,
            secureStorePersistent=persistent,
            backgroundEnabled=background_enabled,
            backgroundBlocker=_background_blocker(
                selected, persistent, bool(worker["workerReady"])
            ),
            installedExecutorDomains=list(installed_executor_domains),
            **worker,
        )

    @application.get("/status", response_model=CompanionStatusResponse)
    async def status() -> CompanionStatusResponse:
        persistent = application.state.secrets.persistent
        worker = _worker_status(
            application, expected_worker_catalog_fingerprint, worker_diagnostic_provider
        )
        counts = application.state.coordinator.status_counts()
        return CompanionStatusResponse(
            coordinatorId=application.state.coordinator_id,
            **counts,
            secureStorePersistent=persistent,
            secureStoreBackend=application.state.secrets.backend_name,
            backgroundRequested=selected.background_requested,
            backgroundEnabled=(
                selected.background_requested and persistent and worker["workerReady"]
            ),
            backgroundBlocker=_background_blocker(
                selected, persistent, bool(worker["workerReady"])
            ),
            installedExecutorDomains=list(installed_executor_domains),
            **worker,
        )

    @application.post("/worker/heartbeat", response_model=WorkerHeartbeatResponse)
    async def worker_heartbeat(
        request: WorkerHeartbeatRequest,
    ) -> WorkerHeartbeatResponse:
        if not expected_worker_catalog_fingerprint:
            raise HTTPException(
                status_code=503,
                detail="Worker executor catalog is not configured.",
            )
        result = application.state.coordinator.record_worker_heartbeat(
            request.coordinatorId,
            request.catalogFingerprint,
            request.polledAt,
            expected_worker_catalog_fingerprint,
        )
        return WorkerHeartbeatResponse(**result)

    @application.get(
        "/host-approval-signer", response_model=HostApprovalSignerDescriptionV1
    )
    async def describe_host_approval_signer(
        response: Response,
    ) -> HostApprovalSignerDescriptionV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.host_approval_signer.describe()

    @application.post(
        "/host-approval-signer/provision",
        response_model=HostApprovalSignerDescriptionV1,
    )
    async def provision_host_approval_signer(
        _request: HostApprovalSignerMutationRequestV1, response: Response
    ) -> HostApprovalSignerDescriptionV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.host_approval_signer.provision()

    @application.post(
        "/host-approval-signer/rotate",
        response_model=HostApprovalSignerDescriptionV1,
    )
    async def rotate_host_approval_signer(
        _request: HostApprovalSignerMutationRequestV1, response: Response
    ) -> HostApprovalSignerDescriptionV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.host_approval_signer.rotate()

    @application.post(
        "/host-approval-signer/sign", response_model=HostApprovalReceiptV1
    )
    async def sign_host_approval_receipt(
        request: HostApprovalSignRequestV1, response: Response
    ) -> HostApprovalReceiptV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.host_approval_signer.sign(request.evidence)

    @application.post(
        "/host-approval-signer/verify",
        response_model=HostApprovalVerificationResultV1,
    )
    async def verify_host_approval_receipt(
        request: HostApprovalVerifyRequestV1, response: Response
    ) -> HostApprovalVerificationResultV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.host_approval_signer.verify(request.receipt)

    @application.put(
        "/linear-queue/configuration", response_model=LinearQueueStatusV1
    )
    async def configure_linear_queue(
        request: LinearQueueConfigurationV1, response: Response
    ) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        _require_linear_queue_background(application, selected, installed_executor_domains)
        try:
            description = application.state.secrets.describe(
                request.credentialReferenceId
            )
        except KeyError as exc:
            raise HTTPException(
                status_code=404,
                detail="Linear queue credential reference was not found.",
            ) from exc
        if not description.persistent:
            raise HTTPException(
                status_code=503,
                detail="Linear queue polling requires a persistent OS credential reference.",
            )
        return application.state.coordinator.configure_linear_queue(request)

    @application.delete(
        "/linear-queue/configuration", response_model=LinearQueueStatusV1
    )
    async def disable_linear_queue(response: Response) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.coordinator.disable_linear_queue()

    @application.get("/linear-queue/status", response_model=LinearQueueStatusV1)
    async def linear_queue_status(response: Response) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        return application.state.coordinator.linear_queue_status()

    @application.post(
        "/linear-queue/scans/claim", response_model=LinearQueueScanClaimResponse
    )
    async def claim_linear_queue_scan(
        request: LinearQueueScanClaimRequest, response: Response
    ) -> LinearQueueScanClaimResponse:
        response.headers["Cache-Control"] = "no-store"
        _require_linear_queue_background(application, selected, installed_executor_domains)
        if not expected_worker_catalog_fingerprint:
            raise HTTPException(
                status_code=503,
                detail="Worker executor catalog is not configured.",
            )
        return application.state.coordinator.claim_linear_queue_scan(
            request, expected_worker_catalog_fingerprint
        )

    @application.post(
        "/linear-queue/scans/complete", response_model=LinearQueueStatusV1
    )
    async def complete_linear_queue_scan(
        request: LinearQueueScanCompleteRequest, response: Response
    ) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        _require_linear_queue_background(application, selected, installed_executor_domains)
        return application.state.coordinator.complete_linear_queue_scan(request)

    @application.post(
        "/linear-queue/scans/fail", response_model=LinearQueueStatusV1
    )
    async def fail_linear_queue_scan(
        request: LinearQueueScanFailureRequest, response: Response
    ) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        _require_linear_queue_background(application, selected, installed_executor_domains)
        return application.state.coordinator.fail_linear_queue_scan(request)

    @application.post("/linear-queue/rescan", response_model=LinearQueueStatusV1)
    async def request_linear_queue_rescan(
        request: LinearQueueRescanRequestV1, response: Response
    ) -> LinearQueueStatusV1:
        response.headers["Cache-Control"] = "no-store"
        _require_linear_queue_background(application, selected, installed_executor_domains)
        return application.state.coordinator.request_linear_queue_rescan(request)

    @application.get("/linear-queue/events")
    async def replay_linear_queue_events(
        after: int = Query(default=0, ge=0),
        limit: int = Query(default=500, ge=1, le=500),
    ) -> dict[str, list[LinearQueueEventRecordV1]]:
        return {
            "events": application.state.coordinator.replay_linear_queue_events(
                after, limit
            )
        }

    @application.post("/browser/open")
    async def browser_open(request: BrowserOpenRequest):
        _verify_browser_action(application, "navigate", request)
        return await application.state.browser.open(request)

    @application.post("/browser/observe")
    async def browser_observe(request: BrowserObserveRequest):
        _verify_browser_action(application, "observe", request)
        return await application.state.browser.observe()

    @application.post("/browser/click")
    async def browser_click(request: BrowserClickRequest):
        _verify_browser_action(application, "click", request)
        return await application.state.browser.click(request)

    @application.post("/browser/type")
    async def browser_type(request: BrowserTypeRequest):
        _verify_browser_action(application, "type", request)
        return await application.state.browser.type(request)

    @application.post("/browser/keypress")
    async def browser_keypress(request: BrowserKeypressRequest):
        _verify_browser_action(application, "keypress", request)
        return await application.state.browser.keypress(request)

    @application.post("/browser/scroll")
    async def browser_scroll(request: BrowserScrollRequest):
        _verify_browser_action(application, "scroll", request)
        return await application.state.browser.scroll(request)

    @application.post("/browser/screenshot")
    async def browser_screenshot(request: BrowserScreenshotRequest):
        _verify_browser_action(application, "screenshot", request)
        return await application.state.browser.screenshot(request)

    @application.post("/browser/extract_markdown")
    async def browser_extract_markdown(request: BrowserExtractMarkdownRequest):
        _verify_browser_action(application, "extract", request)
        return await application.state.browser.extract_markdown(request)

    @application.post("/memory/write", response_model=MemoryWriteResponse)
    async def memory_write(request: MemoryWriteRequest) -> MemoryWriteResponse:
        return MemoryWriteResponse(id=application.state.memory.write(request))

    @application.post("/memory/search", response_model=MemorySearchResponse)
    async def memory_search(request: MemorySearchRequest) -> MemorySearchResponse:
        return MemorySearchResponse(results=application.state.memory.search(request))

    @application.post("/memory/delete", response_model=MemoryMutationReceiptV1)
    async def memory_delete(request: MemoryDeleteRequest) -> MemoryMutationReceiptV1:
        return application.state.memory.delete(request)

    @application.post("/memory/clear", response_model=MemoryMutationReceiptV1)
    async def memory_clear(request: MemoryClearRequest) -> MemoryMutationReceiptV1:
        return application.state.memory.clear(request)

    @application.post("/jobs", response_model=JobRecord)
    async def create_job(request: JobCreateRequest) -> JobRecord:
        return application.state.coordinator.create_job(request)

    @application.get("/jobs")
    async def list_jobs(
        state: list[str] | None = Query(default=None),
        limit: int = Query(default=100, ge=1, le=500),
    ) -> dict[str, list[JobRecord]]:
        return {"jobs": application.state.coordinator.list_jobs(state, limit)}

    @application.get("/jobs/{job_id}", response_model=JobRecord)
    async def get_job(job_id: str) -> JobRecord:
        return application.state.coordinator.get_job(job_id)

    @application.post("/jobs/{job_id}/claim", response_model=JobLeaseResponse)
    async def claim_job(job_id: str, request: JobClaimRequest) -> JobLeaseResponse:
        worker = application.state.coordinator.worker_status(
            expected_worker_catalog_fingerprint
        )
        _require_background_available(
            selected,
            application.state.secrets.persistent,
            bool(worker["workerReady"]),
        )
        job, lease_token = application.state.coordinator.claim_job(
            job_id, request.coordinatorId, request.leaseSeconds
        )
        return JobLeaseResponse(job=job, leaseToken=lease_token)

    @application.post("/jobs/{job_id}/heartbeat", response_model=JobRecord)
    async def heartbeat_job(
        job_id: str, request: JobLeaseMutationRequest
    ) -> JobRecord:
        return application.state.coordinator.heartbeat_job(
            job_id,
            request.coordinatorId,
            request.leaseToken.get_secret_value(),
            request.leaseSeconds,
        )

    @application.post("/jobs/{job_id}/complete", response_model=JobRecord)
    async def complete_job(job_id: str, request: JobCompletionRequest) -> JobRecord:
        return application.state.coordinator.complete_job(
            job_id,
            request.coordinatorId,
            request.leaseToken.get_secret_value(),
            request.state,
            request.output,
        )

    @application.post("/jobs/{job_id}/events", response_model=EventRecord)
    async def append_event(job_id: str, request: EventAppendRequest) -> EventRecord:
        return application.state.coordinator.append_event(
            job_id,
            request.coordinatorId,
            request.leaseToken.get_secret_value(),
            request.type,
            request.payload,
        )

    @application.get("/jobs/{job_id}/events")
    async def stream_events(
        job_id: str,
        after: int = Query(default=0, ge=0),
        follow: bool = Query(default=True),
    ) -> StreamingResponse:
        application.state.coordinator.get_job(job_id)

        async def event_stream():
            sequence = after
            idle_cycles = 0
            emitted = 0
            replay_started = time.monotonic()
            while True:
                events = application.state.coordinator.replay_events(
                    job_id, sequence, EVENT_REPLAY_PAGE_SIZE
                )
                for event in events:
                    sequence = event.sequence
                    emitted += 1
                    payload = json.dumps(event.model_dump(), separators=(",", ":"))
                    yield f"id: {event.sequence}\nevent: {event.type}\ndata: {payload}\n\n"
                    idle_cycles = 0
                if not follow:
                    if not events:
                        break
                    event_limit_hit = emitted >= EVENT_REPLAY_LIMIT
                    time_limit_hit = (
                        time.monotonic() - replay_started
                        >= EVENT_REPLAY_TIME_LIMIT_SECONDS
                    )
                    if event_limit_hit or time_limit_hit:
                        boundary = json.dumps(
                            {
                                "afterSequence": sequence,
                                "complete": False,
                                "reason": (
                                    "event_limit" if event_limit_hit else "time_limit"
                                ),
                            },
                            separators=(",", ":"),
                        )
                        yield (
                            f"id: {sequence}\nevent: replay_boundary\n"
                            f"data: {boundary}\n\n"
                        )
                        break
                    # Drain another page. Job event sequences are globally sparse,
                    # so the cursor always advances to the last actual event id.
                    continue
                if events:
                    continue
                await asyncio.sleep(0.25)
                idle_cycles += 1
                if idle_cycles >= 60:
                    yield ": keepalive\n\n"
                    idle_cycles = 0

        return StreamingResponse(
            event_stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-store",
                "X-Accel-Buffering": "no",
            },
        )

    @application.post("/jobs/{job_id}/receipts", response_model=ReceiptRecord)
    async def append_receipt(
        job_id: str, request: ReceiptAppendRequest
    ) -> ReceiptRecord:
        return application.state.coordinator.append_receipt(job_id, request)

    @application.get("/jobs/{job_id}/receipts")
    async def list_receipts(job_id: str) -> dict[str, list[ReceiptRecord]]:
        return {"receipts": application.state.coordinator.list_receipts(job_id)}

    @application.post("/secrets", response_model=SecretDescription)
    async def put_secret(
        request: SecretPutRequest, response: Response
    ) -> SecretDescription:
        response.headers["Cache-Control"] = "no-store"
        try:
            return application.state.secrets.put(
                request.value, request.label, request.metadata
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    @application.get("/secrets/{reference_id}", response_model=SecretDescription)
    async def describe_secret(
        reference_id: str, response: Response
    ) -> SecretDescription:
        response.headers["Cache-Control"] = "no-store"
        try:
            return application.state.secrets.describe(reference_id)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Secret reference not found.") from exc

    @application.post(
        "/secrets/{reference_id}/lease", response_model=SecretLeaseResponse
    )
    async def lease_secret(
        reference_id: str, request: SecretLeaseRequest, response: Response
    ) -> SecretLeaseResponse:
        response.headers["Cache-Control"] = "no-store"
        try:
            return application.state.secrets.lease(reference_id, request.ttlSeconds)
        except KeyError as exc:
            raise HTTPException(status_code=404, detail="Secret reference not found.") from exc

    @application.delete(
        "/secrets/{reference_id}", response_model=SecretRemoveResponse
    )
    async def remove_secret(
        reference_id: str, response: Response
    ) -> SecretRemoveResponse:
        response.headers["Cache-Control"] = "no-store"
        try:
            return SecretRemoveResponse(
                removed=application.state.secrets.remove(reference_id)
            )
        except RuntimeError as exc:
            raise HTTPException(status_code=503, detail=str(exc)) from exc

    return application


def _background_blocker(
    config: CompanionConfig, persistent: bool, worker_ready: bool
) -> str | None:
    if config.background_requested and not persistent:
        return "secure_persistent_credential_backend_required"
    if config.background_requested and not worker_ready:
        return "authenticated_worker_heartbeat_required"
    return None


def _require_background_available(
    config: CompanionConfig, persistent: bool, worker_ready: bool
) -> None:
    blocker = _background_blocker(config, persistent, worker_ready)
    if blocker:
        raise HTTPException(
            status_code=503,
            detail=f"Background work is disabled: {blocker}.",
        )


def _require_linear_queue_background(
    application: FastAPI,
    config: CompanionConfig,
    installed_executor_domains: tuple[str, ...],
) -> None:
    # create_app already binds the expected catalog in the route closures. The
    # persistent store and fixed installed-domain checks are the authority
    # boundary here; scan claims separately prove the exact live heartbeat.
    if not config.background_requested:
        raise HTTPException(
            status_code=503,
            detail="Linear queue polling requires the installed background service.",
        )
    if not application.state.secrets.persistent:
        raise HTTPException(
            status_code=503,
            detail="Linear queue polling requires a persistent OS credential store.",
        )
    if "linear" not in installed_executor_domains:
        raise HTTPException(
            status_code=503,
            detail="The fixed Linear companion executor is not installed.",
        )


def _verify_browser_action(application: FastAPI, action: str, request: object) -> None:
    decision = getattr(request, "safetyDecision")
    application.state.browser_safety.verify(
        action, browser_action_payload(request), decision
    )


def _worker_status(
    application: FastAPI,
    expected_catalog_fingerprint: str | None,
    diagnostic_provider: Callable[[], str | None] | None,
) -> dict[str, object]:
    status = application.state.coordinator.worker_status(
        expected_catalog_fingerprint
    )
    if not status["workerReady"] and diagnostic_provider:
        diagnostic = diagnostic_provider()
        if diagnostic:
            status["workerDiagnostic"] = diagnostic[:4_096]
    return status


app = create_app()
