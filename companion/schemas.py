from __future__ import annotations

import datetime as dt
from urllib.parse import parse_qsl, urlparse
from typing import Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    SecretStr,
    ValidationInfo,
    field_validator,
    model_validator,
)

from persisted_data import (
    FINGERPRINT_PATTERN,
    STABLE_ID_PATTERN,
    canonical_fingerprint,
    normalize_key,
    require_fingerprint,
    sanitize_event_payload,
    validate_persisted_text,
    validate_binding,
    validate_job_inputs,
)


class ClosedModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class HealthResponse(BaseModel):
    ok: bool = True
    service: str = "obsidian-research-companion"
    browserReady: bool
    memoryReady: bool
    coordinatorReady: bool = False
    secureStorePersistent: bool = False
    backgroundEnabled: bool = False
    backgroundBlocker: str | None = None
    workerReady: bool = False
    workerDiagnostic: str | None = None
    installedExecutorDomains: list[Literal["research", "code", "linear", "github"]] = Field(
        default_factory=list
    )
    executorCatalogVersion: Literal[1] = 1
    version: str = "0.3.0"


class CompanionStatusResponse(BaseModel):
    ok: bool = True
    coordinatorId: str
    queuedJobs: int
    leasedJobs: int
    eventCount: int
    receiptCount: int
    secureStorePersistent: bool
    secureStoreBackend: str
    backgroundRequested: bool
    backgroundEnabled: bool
    backgroundBlocker: str | None = None
    workerReady: bool = False
    workerDiagnostic: str | None = None
    installedExecutorDomains: list[Literal["research", "code", "linear", "github"]] = Field(
        default_factory=list
    )
    executorCatalogVersion: Literal[1] = 1


class WorkerHeartbeatRequest(ClosedModel):
    coordinatorId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    catalogFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    polledAt: str


class WorkerHeartbeatResponse(BaseModel):
    ok: bool = True
    workerReady: bool
    expiresAt: str


class SafetyPolicyDecisionV1(ClosedModel):
    version: Literal[1]
    decision: Literal["allow"]
    action: Literal[
        "navigate",
        "observe",
        "click",
        "type",
        "keypress",
        "scroll",
        "screenshot",
        "extract",
    ]
    policyFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    payloadFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    nonce: str = Field(min_length=22, max_length=128, pattern=r"^[A-Za-z0-9_-]+$")
    decidedAt: str
    expiresAt: str
    signature: str = Field(pattern=r"^hmac-sha256:[0-9a-f]{64}$", repr=False)


class BrowserOpenRequest(ClosedModel):
    url: str = Field(max_length=8_192)
    missionMode: Literal["supervised", "extract_only"] = "supervised"
    safetyDecision: SafetyPolicyDecisionV1


class BrowserClickRequest(ClosedModel):
    candidateId: str = Field(min_length=1, max_length=512)
    selector: str = Field(min_length=1, max_length=4_096)
    candidateFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    button: Literal["left", "middle", "right"] = "left"
    observedUrl: str = Field(max_length=8_192)
    observationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    safetyDecision: SafetyPolicyDecisionV1


class BrowserTypeRequest(ClosedModel):
    candidateId: str = Field(min_length=1, max_length=512)
    selector: str = Field(min_length=1, max_length=4_096)
    candidateFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    text: str = Field(max_length=100_000)
    clearFirst: bool = False
    observedUrl: str = Field(max_length=8_192)
    observationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    safetyDecision: SafetyPolicyDecisionV1


class BrowserObserveRequest(ClosedModel):
    safetyDecision: SafetyPolicyDecisionV1


class BrowserKeypressRequest(ClosedModel):
    key: str = Field(min_length=1, max_length=128)
    candidateId: str = Field(min_length=1, max_length=512)
    selector: str = Field(min_length=1, max_length=4_096)
    candidateFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    observedUrl: str = Field(max_length=8_192)
    observationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    safetyDecision: SafetyPolicyDecisionV1


class BrowserScrollRequest(ClosedModel):
    direction: Literal["up", "down", "left", "right"]
    amount: int = Field(default=700, ge=1, le=3000)
    safetyDecision: SafetyPolicyDecisionV1


class BrowserScreenshotRequest(ClosedModel):
    fullPage: bool = False
    safetyDecision: SafetyPolicyDecisionV1


class BrowserExtractMarkdownRequest(ClosedModel):
    includeLinks: bool = True
    maxChars: int = Field(default=60_000, ge=1, le=250_000)
    safetyDecision: SafetyPolicyDecisionV1


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
    formAction: str | None = None
    formMethod: str | None = None
    submitsForm: bool = False
    inputType: str | None = None
    text: str | None = None
    candidateFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    enabled: bool
    visible: bool
    focused: bool = False
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
    observationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class MemoryEvidenceRefV1(ClosedModel):
    kind: Literal["screenshot", "source", "receipt", "memory"]
    url: str | None = Field(default=None, max_length=8_192)
    id: str | None = Field(default=None, pattern=STABLE_ID_PATTERN.pattern)
    title: str | None = Field(default=None, max_length=2_048)

    @field_validator("url")
    @classmethod
    def validate_url(cls, value: str | None) -> str | None:
        return _safe_public_reference_url(value)


class MemoryWriteRequest(ClosedModel):
    vaultScopeId: str = Field(pattern=r"^vault_[a-f0-9]{64}$")
    kind: Literal["episodic", "semantic", "procedural", "source"]
    content: str = Field(min_length=1, max_length=250_000)
    confidence: float = Field(ge=0, le=1)
    tags: list[str] = Field(default_factory=list, max_length=100)
    sourceUrl: str | None = Field(default=None, max_length=8_192)
    sourceTitle: str | None = Field(default=None, max_length=2_048)
    noteReceiptFingerprint: str | None = Field(
        default=None, pattern=FINGERPRINT_PATTERN.pattern
    )
    evidenceRefs: list[MemoryEvidenceRefV1] = Field(default_factory=list, max_length=100)
    taskId: str | None = Field(default=None, pattern=STABLE_ID_PATTERN.pattern)

    @field_validator("content")
    @classmethod
    def reject_plaintext_credentials(cls, value: str) -> str:
        return validate_persisted_text(value, "memory.content")

    @field_validator("sourceUrl")
    @classmethod
    def validate_source_url(cls, value: str | None) -> str | None:
        return _safe_public_reference_url(value)

    @field_validator("sourceTitle")
    @classmethod
    def validate_source_title(cls, value: str | None) -> str | None:
        return None if value is None else validate_persisted_text(value, "sourceTitle")

    @field_validator("tags")
    @classmethod
    def validate_tags(cls, value: list[str]) -> list[str]:
        if any(not tag or len(tag) > 128 for tag in value):
            raise ValueError("Memory tags must be bounded non-empty text.")
        return [validate_persisted_text(tag, "tag") for tag in value]


class MemoryWriteResponse(BaseModel):
    id: str


class MemorySearchRequest(ClosedModel):
    vaultScopeId: str = Field(pattern=r"^vault_[a-f0-9]{64}$")
    query: str = Field(min_length=1, max_length=4_096)
    kinds: list[Literal["episodic", "semantic", "procedural", "source"]] | None = Field(
        default=None, max_length=4
    )
    tags: list[str] | None = Field(default=None, max_length=100)
    limit: int = Field(default=10, ge=1, le=50)
    minScore: float | None = None


class MemorySearchResult(BaseModel):
    id: str
    vaultScopeId: str
    kind: str
    content: str
    score: float
    confidence: float
    tags: list[str]
    sourceUrl: str | None = None
    sourceTitle: str | None = None
    noteReceiptFingerprint: str | None = None
    createdAt: str


class MemorySearchResponse(BaseModel):
    results: list[MemorySearchResult]


class MemoryDeleteRequest(ClosedModel):
    vaultScopeId: str = Field(pattern=r"^vault_[a-f0-9]{64}$")
    memoryId: str = Field(pattern=STABLE_ID_PATTERN.pattern)


class MemoryClearRequest(ClosedModel):
    vaultScopeId: str = Field(pattern=r"^vault_[a-f0-9]{64}$")
    kinds: list[Literal["episodic", "semantic", "procedural", "source"]] | None = Field(
        default=None, max_length=4
    )


class MemoryMutationReceiptV1(ClosedModel):
    version: Literal[1] = 1
    operation: Literal["delete", "clear"]
    vaultScopeId: str = Field(pattern=r"^vault_[a-f0-9]{64}$")
    deletedCount: int = Field(ge=0)
    deletedIds: list[str] = Field(default_factory=list, max_length=500)
    observedAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class BackgroundAuthorizationV1(ClosedModel):
    version: Literal[1]
    grantId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    authorizedAt: str
    expiresAt: str | None

    @field_validator("authorizedAt", "expiresAt")
    @classmethod
    def validate_timestamp(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError as exc:
            raise ValueError("Authorization timestamps must be ISO-8601.") from exc
        if parsed.tzinfo is None:
            raise ValueError("Authorization timestamps require a timezone.")
        return value


class LinearQueueConfigurationV1(ClosedModel):
    version: Literal[1]
    workspaceId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    queueProjectId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    credentialReferenceId: str = Field(
        pattern=r"^(?:secret|credential)_[A-Za-z0-9-]{8,128}$"
    )
    authoritySubjectId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    authority: BackgroundAuthorizationV1
    queueBindingFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    configurationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_exact_queue_authority(self) -> "LinearQueueConfigurationV1":
        expected_subject = f"linear-queue-project:{self.queueProjectId}"
        if self.authoritySubjectId != expected_subject:
            raise ValueError("Linear queue authority belongs to another project.")
        if self.authority.expiresAt is None:
            raise ValueError("Linear queue polling requires expiring authority.")
        authorized_at = dt.datetime.fromisoformat(
            self.authority.authorizedAt.replace("Z", "+00:00")
        )
        expires_at = dt.datetime.fromisoformat(
            self.authority.expiresAt.replace("Z", "+00:00")
        )
        if expires_at - authorized_at != dt.timedelta(hours=4):
            raise ValueError("Linear queue authority must use the exact four-hour grant.")
        expected_binding = canonical_fingerprint(
            {
                "version": 1,
                "system": "linear",
                "workspaceId": self.workspaceId,
                "queueProjectId": self.queueProjectId,
            }
        )
        if self.queueBindingFingerprint != expected_binding:
            raise ValueError("Linear queue binding fingerprint drifted.")
        expected_configuration = canonical_fingerprint(
            self.model_dump(exclude={"configurationFingerprint"})
        )
        if self.configurationFingerprint != expected_configuration:
            raise ValueError("Linear queue configuration fingerprint drifted.")
        return self


class LinearQueueCursorV1(ClosedModel):
    updatedAt: str
    issueId: str = Field(pattern=STABLE_ID_PATTERN.pattern)

    @field_validator("updatedAt")
    @classmethod
    def validate_updated_at(cls, value: str) -> str:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Linear queue cursor requires a timezone.")
        return value


class LinearQueueCandidateObservationV1(ClosedModel):
    issueId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    identifier: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    queueProjectId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    remoteStateId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    remoteUpdatedAt: str
    workItemFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    readbackFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    candidateFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_candidate_fingerprint(self) -> "LinearQueueCandidateObservationV1":
        updated_at = dt.datetime.fromisoformat(
            self.remoteUpdatedAt.replace("Z", "+00:00")
        )
        if updated_at.tzinfo is None:
            raise ValueError("Linear queue candidate timestamp requires a timezone.")
        expected = canonical_fingerprint(
            self.model_dump(exclude={"candidateFingerprint"})
        )
        if self.candidateFingerprint != expected:
            raise ValueError("Linear queue candidate fingerprint drifted.")
        return self


class LinearQueueScanClaimRequest(ClosedModel):
    coordinatorId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    catalogFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    claimedAt: str

    @field_validator("claimedAt")
    @classmethod
    def validate_claimed_at(cls, value: str) -> str:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Linear queue scan claim requires a timezone.")
        return value


class LinearQueueScanClaimResponse(BaseModel):
    claimed: bool
    reason: Literal[
        "claimed",
        "disabled",
        "not_due",
        "authority_expired",
        "scan_in_progress",
    ]
    scanId: str | None = None
    scanToken: str | None = Field(default=None, repr=False)
    configuration: LinearQueueConfigurationV1 | None = None
    cursor: LinearQueueCursorV1 | None = None
    nextScanAt: str | None = None


class LinearQueueScanCompleteRequest(ClosedModel):
    coordinatorId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    scanId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    scanToken: SecretStr
    configurationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    scannedAt: str
    candidates: list[LinearQueueCandidateObservationV1] = Field(
        default_factory=list, max_length=10
    )
    cursor: LinearQueueCursorV1 | None = None

    @model_validator(mode="after")
    def validate_scan_result(self) -> "LinearQueueScanCompleteRequest":
        scanned_at = dt.datetime.fromisoformat(self.scannedAt.replace("Z", "+00:00"))
        if scanned_at.tzinfo is None:
            raise ValueError("Linear queue scan completion requires a timezone.")
        if len({item.candidateFingerprint for item in self.candidates}) != len(
            self.candidates
        ):
            raise ValueError("Linear queue scan contains duplicate candidates.")
        return self


class LinearQueueScanFailureRequest(ClosedModel):
    coordinatorId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    scanId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    scanToken: SecretStr
    configurationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    failedAt: str
    errorCode: Literal[
        "linear_queue_provider_unavailable",
        "linear_queue_invalid_response",
        "linear_queue_credential_unavailable",
    ]


class LinearQueueRescanRequestV1(ClosedModel):
    configurationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    requestedAt: str
    reason: Literal["terminal_readback"]

    @field_validator("requestedAt")
    @classmethod
    def validate_requested_at(cls, value: str) -> str:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        if parsed.tzinfo is None:
            raise ValueError("Linear queue rescan request requires a timezone.")
        return value


class LinearQueueStatusV1(BaseModel):
    enabled: bool
    configurationFingerprint: str | None = None
    queueProjectId: str | None = None
    authorityExpiresAt: str | None = None
    cursor: LinearQueueCursorV1 | None = None
    nextScanAt: str | None = None
    lastScanStartedAt: str | None = None
    lastScanCompletedAt: str | None = None
    lastErrorCode: str | None = None
    candidateCount: int = 0
    scheduledReadbackCount: int = 0
    latestEventSequence: int = 0


class LinearQueueEventRecordV1(BaseModel):
    sequence: int
    type: Literal[
        "linear_queue_configured",
        "linear_queue_disabled",
        "linear_queue_scan_started",
        "linear_queue_scan_completed",
        "linear_queue_scan_failed",
        "linear_queue_rescan_requested",
        "linear_queue_authority_expired",
        "linear_queue_candidate_scheduled",
    ]
    payload: dict[str, Any]
    createdAt: str


class LogicalBindingRefV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    kind: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    destinationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class PreparedExternalActionBindingV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    kind: Literal["issue", "linear-work-item"]
    destinationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class ConsumedExternalActionGrantV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    authorityFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    consumedAt: str
    expiresAt: str


class LinearIssueStateUpdatePayloadV1(ClosedModel):
    issueId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    stateId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preconditionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    credentialReferenceId: str = Field(
        pattern=r"^(?:secret|credential)_[A-Za-z0-9-]{8,128}$"
    )


class PreparedExternalActionHandoffV1(ClosedModel):
    version: Literal[1]
    kind: Literal["prepared_external_action_handoff"]
    operation: Literal["linear_issue_state_update_v1"]
    status: Literal["prepared"]
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    missionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    graphRevision: int = Field(ge=0)
    capabilityEnvelopeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    nodeId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    nodeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    executionHost: Literal["companion", "headless_runtime"]
    toolName: Literal["linear_update_issue"]
    descriptorFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedActionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    binding: PreparedExternalActionBindingV1
    authority: ConsumedExternalActionGrantV1
    payload: LinearIssueStateUpdatePayloadV1
    idempotencyKey: str = Field(min_length=1, max_length=512)
    reconciliationKey: str = Field(min_length=1, max_length=512)
    preparedAt: str
    expiresAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_fingerprint_and_lifetime(self) -> "PreparedExternalActionHandoffV1":
        if self.idempotencyKey != self.reconciliationKey:
            raise ValueError("Linear handoff idempotency and reconciliation keys differ.")
        prepared_at = dt.datetime.fromisoformat(self.preparedAt.replace("Z", "+00:00"))
        expires_at = dt.datetime.fromisoformat(self.expiresAt.replace("Z", "+00:00"))
        consumed_at = dt.datetime.fromisoformat(
            self.authority.consumedAt.replace("Z", "+00:00")
        )
        grant_expires = dt.datetime.fromisoformat(
            self.authority.expiresAt.replace("Z", "+00:00")
        )
        if any(
            stamp.tzinfo is None
            for stamp in (prepared_at, expires_at, consumed_at, grant_expires)
        ):
            raise ValueError("Linear handoff timestamps require a timezone.")
        if consumed_at > prepared_at or not prepared_at < expires_at <= grant_expires:
            raise ValueError("Linear handoff lifetime is outside its consumed grant.")
        if self.authority.actionFingerprint != self.preparedActionFingerprint:
            raise ValueError("Linear handoff authority is bound to another action.")
        evidence = self.model_dump(exclude={"fingerprint"})
        if canonical_fingerprint(evidence) != self.fingerprint:
            raise ValueError("Linear handoff fingerprint does not match its evidence.")
        return self


class PreparedBackgroundCodeBindingV1(ClosedModel):
    workspaceId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    repositoryProfileKey: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    destinationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class ConsumedBackgroundCodeGrantV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    authorityFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    consumedAt: str
    expiresAt: str


class PreparedBackgroundCodePayloadV1(ClosedModel):
    repairCheckpointId: str = Field(min_length=1, max_length=512)
    repairRequestFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedCheckpointSequence: int = Field(ge=0)
    workspaceBindingFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repositoryProfileFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    sandboxCapabilityFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class PreparedBackgroundCodeActionV1(ClosedModel):
    version: Literal[1]
    kind: Literal["prepared_background_code_action"]
    operation: Literal["prepared_code_validation_commit_v1"]
    status: Literal["prepared"]
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    missionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    graphRevision: int = Field(ge=0)
    capabilityEnvelopeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    nodeId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    nodeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    executionHost: Literal["companion", "headless_runtime"]
    toolName: Literal["code_validate_commit_prepared"]
    descriptorFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedActionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    binding: PreparedBackgroundCodeBindingV1
    authority: ConsumedBackgroundCodeGrantV1
    payload: PreparedBackgroundCodePayloadV1
    idempotencyKey: str = Field(min_length=1, max_length=512)
    reconciliationKey: str = Field(min_length=1, max_length=512)
    preparedAt: str
    expiresAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_fingerprint_and_lifetime(self) -> "PreparedBackgroundCodeActionV1":
        if self.idempotencyKey != self.reconciliationKey:
            raise ValueError("Code action idempotency and reconciliation keys differ.")
        prepared_at = dt.datetime.fromisoformat(self.preparedAt.replace("Z", "+00:00"))
        expires_at = dt.datetime.fromisoformat(self.expiresAt.replace("Z", "+00:00"))
        consumed_at = dt.datetime.fromisoformat(self.authority.consumedAt.replace("Z", "+00:00"))
        grant_expires = dt.datetime.fromisoformat(self.authority.expiresAt.replace("Z", "+00:00"))
        if any(stamp.tzinfo is None for stamp in (prepared_at, expires_at, consumed_at, grant_expires)):
            raise ValueError("Code action timestamps require a timezone.")
        if consumed_at > prepared_at or not prepared_at < expires_at <= grant_expires:
            raise ValueError("Code action lifetime is outside its consumed grant.")
        if self.authority.actionFingerprint != self.preparedActionFingerprint:
            raise ValueError("Code action authority is bound to another action.")
        if canonical_fingerprint(self.model_dump(exclude={"fingerprint"})) != self.fingerprint:
            raise ValueError("Code action fingerprint does not match its evidence.")
        return self


class PreparedBackgroundCodePackageIdentityV1(ClosedModel):
    version: Literal[1]
    kind: Literal["prepared_background_code_package_identity"]
    packageId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    packageFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    executionPlanFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    handoffFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    workspaceId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    workspaceBindingFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repositoryProfileKey: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    repositoryProfileFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    consumedActionAuthorityFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    backgroundAuthorizationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedAt: str
    expiresAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_fingerprint_and_lifetime(self) -> "PreparedBackgroundCodePackageIdentityV1":
        prepared_at = dt.datetime.fromisoformat(self.preparedAt.replace("Z", "+00:00"))
        expires_at = dt.datetime.fromisoformat(self.expiresAt.replace("Z", "+00:00"))
        if prepared_at.tzinfo is None or expires_at.tzinfo is None or expires_at <= prepared_at:
            raise ValueError("Code package identity lifetime is invalid.")
        if canonical_fingerprint(self.model_dump(exclude={"fingerprint"})) != self.fingerprint:
            raise ValueError("Code package identity fingerprint does not match its evidence.")
        return self


GitHubBackgroundOperationV1 = Literal[
    "github_verified_branch_push_v1",
    "github_draft_pull_request_v1",
    "github_review_repair_fast_forward_v1",
    "github_pull_request_merge_v1",
    "github_pull_request_auto_merge_v1",
]


def _canonical_github_timestamp(value: str, label: str) -> dt.datetime:
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as error:
        raise ValueError(f"{label} must be a canonical ISO timestamp.") from error
    if parsed.tzinfo is None:
        raise ValueError(f"{label} must include a timezone.")
    canonical = parsed.astimezone(dt.UTC).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )
    if value != canonical:
        raise ValueError(f"{label} must be a canonical ISO timestamp.")
    return parsed


def _validate_git_branch(value: str, label: str, *, agent_owned: bool = False) -> str:
    if (
        not 1 <= len(value) <= 255
        or value.startswith(("-", "/"))
        or value.endswith(("/", "."))
        or ".." in value
        or "//" in value
        or "@{" in value
        or any(character.isspace() or character in "~^:?*[\\]" for character in value)
    ):
        raise ValueError(f"{label} is invalid.")
    if agent_owned and (not value.startswith("codex/") or value == "codex/"):
        raise ValueError("Background GitHub mutations are limited to codex/ branches.")
    return value


class HostApprovalReceiptEvidenceV1(ClosedModel):
    version: Literal[1]
    kind: Literal["host_approval_receipt_evidence"]
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    confirmationOrdinal: Literal[1, 2]
    requiredConfirmations: Literal[1, 2]
    decision: Literal["approved"]
    hostInstanceFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actorFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    sessionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    decidedAt: str
    evidenceFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_closed_evidence(self) -> "HostApprovalReceiptEvidenceV1":
        _canonical_github_timestamp(self.decidedAt, "Approval decision time")
        if self.confirmationOrdinal > self.requiredConfirmations:
            raise ValueError("Approval confirmation ordinal exceeds its required count.")
        if (
            canonical_fingerprint(self.model_dump(exclude={"evidenceFingerprint"}))
            != self.evidenceFingerprint
        ):
            raise ValueError("Host approval evidence fingerprint does not match its contents.")
        return self


class HostApprovalReceiptV1(ClosedModel):
    version: Literal[1]
    kind: Literal["host_approval_receipt"]
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    confirmationOrdinal: Literal[1, 2]
    requiredConfirmations: Literal[1, 2]
    decision: Literal["approved", "denied"]
    hostInstanceFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actorFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    sessionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    decidedAt: str
    evidenceFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    signingKeyFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    authenticator: str = Field(min_length=32, max_length=512, pattern=r"^[A-Za-z0-9_-]+$")
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_closed_receipt(self) -> "HostApprovalReceiptV1":
        _canonical_github_timestamp(self.decidedAt, "Approval decision time")
        if self.confirmationOrdinal > self.requiredConfirmations:
            raise ValueError("Approval confirmation ordinal exceeds its required count.")
        evidence = self.model_dump(
            exclude={
                "evidenceFingerprint",
                "signingKeyFingerprint",
                "authenticator",
                "fingerprint",
            }
        )
        evidence["kind"] = "host_approval_receipt_evidence"
        if canonical_fingerprint(evidence) != self.evidenceFingerprint:
            raise ValueError("Host approval evidence fingerprint does not match its contents.")
        if canonical_fingerprint(self.model_dump(exclude={"fingerprint"})) != self.fingerprint:
            raise ValueError("Host approval receipt fingerprint does not match its contents.")
        return self


class HostApprovalSignerMutationRequestV1(ClosedModel):
    version: Literal[1]


class HostApprovalSignRequestV1(ClosedModel):
    version: Literal[1]
    evidence: HostApprovalReceiptEvidenceV1


class HostApprovalVerifyRequestV1(ClosedModel):
    version: Literal[1]
    receipt: HostApprovalReceiptV1


class HostApprovalSignerDescriptionV1(ClosedModel):
    version: Literal[1] = 1
    kind: Literal["host_approval_signer"] = "host_approval_signer"
    persistent: bool
    provisioned: bool
    backend: str = Field(min_length=1, max_length=512)
    signingKeyFingerprint: str | None = Field(
        default=None, pattern=FINGERPRINT_PATTERN.pattern
    )


class HostApprovalVerificationResultV1(ClosedModel):
    version: Literal[1] = 1
    verified: bool
    reason: Literal[
        "verified",
        "signer_unavailable",
        "key_mismatch",
        "authenticator_mismatch",
        "decision_not_approved",
    ]
    signingKeyFingerprint: str | None = Field(
        default=None, pattern=FINGERPRINT_PATTERN.pattern
    )


class PreparedBackgroundGitHubBindingV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    destinationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repositoryBindingKey: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    repositoryBindingFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repositoryProfileKey: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    repositoryProfileFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    owner: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    repository: str = Field(min_length=1, max_length=100, pattern=r"^[A-Za-z0-9_.-]+$")
    repositoryId: int = Field(ge=1, le=9_007_199_254_740_991)
    verifiedAccountId: int = Field(ge=1, le=9_007_199_254_740_991)
    verifiedAccountLogin: str = Field(
        min_length=1,
        max_length=39,
        pattern=r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$",
    )
    credentialReferenceId: str = Field(
        min_length=16,
        max_length=256,
        pattern=r"^(?:secret|credential)_[A-Za-z0-9-]{8,128}$",
    )

    @model_validator(mode="after")
    def validate_names(self) -> "PreparedBackgroundGitHubBindingV1":
        if self.owner in {".", ".."} or self.repository in {".", ".."}:
            raise ValueError("GitHub owner and repository names are invalid.")
        if self.verifiedAccountLogin.endswith("-"):
            raise ValueError("Verified GitHub account login is invalid.")
        return self


class ConsumedBackgroundGitHubGrantV1(ClosedModel):
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    authorityFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    consumedAt: str
    expiresAt: str
    requiredConfirmations: Literal[1, 2]
    confirmationReceipts: list[HostApprovalReceiptV1] = Field(min_length=1, max_length=2)

    @model_validator(mode="after")
    def normalize_receipts(self) -> "ConsumedBackgroundGitHubGrantV1":
        self.confirmationReceipts = sorted(
            self.confirmationReceipts, key=lambda receipt: receipt.confirmationOrdinal
        )
        if (
            len({receipt.id for receipt in self.confirmationReceipts})
            != len(self.confirmationReceipts)
            or len({receipt.fingerprint for receipt in self.confirmationReceipts})
            != len(self.confirmationReceipts)
            or len({receipt.confirmationOrdinal for receipt in self.confirmationReceipts})
            != len(self.confirmationReceipts)
        ):
            raise ValueError("Host approval receipt identities and ordinals must be distinct.")
        return self


class GitHubVerifiedBranchPushPayloadV1(ClosedModel):
    publicationId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    checkpointFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    checkpointStatus: Literal["local_verified", "push_prepared"]
    handoffFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    branch: str
    baseBranch: str
    baseSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    headSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    expectedRemoteSha: str | None = Field(
        default=None, pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$"
    )
    pushMode: Literal["create", "fast_forward"]

    @model_validator(mode="after")
    def validate_push(self) -> "GitHubVerifiedBranchPushPayloadV1":
        self.branch = _validate_git_branch(self.branch, "Agent branch", agent_owned=True)
        self.baseBranch = _validate_git_branch(self.baseBranch, "Base branch")
        self.baseSha = self.baseSha.lower()
        self.headSha = self.headSha.lower()
        self.expectedRemoteSha = (
            self.expectedRemoteSha.lower() if self.expectedRemoteSha is not None else None
        )
        if (self.pushMode == "create") != (self.expectedRemoteSha is None):
            raise ValueError("Create pushes require no remote SHA; fast-forwards require one.")
        return self


class GitHubDraftPullRequestPayloadV1(ClosedModel):
    publicationId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    checkpointFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    checkpointStatus: Literal["pushed_verified"]
    handoffFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    publishApprovalFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    workflowApprovalFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    branch: str
    headSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    baseBranch: str
    baseSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    titleFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    bodyFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_pull_request(self) -> "GitHubDraftPullRequestPayloadV1":
        self.branch = _validate_git_branch(self.branch, "Agent branch", agent_owned=True)
        self.baseBranch = _validate_git_branch(self.baseBranch, "Base branch")
        self.headSha = self.headSha.lower()
        self.baseSha = self.baseSha.lower()
        return self


class GitHubReviewRepairFastForwardPayloadV1(ClosedModel):
    publicationId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    checkpointFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    checkpointStatus: Literal["repair_required"]
    workflowApprovalFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repairId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    pullRequestNumber: int = Field(ge=1, le=9_007_199_254_740_991)
    branch: str
    baseBranch: str
    baseSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    expectedOldHeadSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    newHeadSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    previousHandoffFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    handoffFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_repair(self) -> "GitHubReviewRepairFastForwardPayloadV1":
        self.branch = _validate_git_branch(self.branch, "Agent branch", agent_owned=True)
        self.baseBranch = _validate_git_branch(self.baseBranch, "Base branch")
        self.baseSha = self.baseSha.lower()
        self.expectedOldHeadSha = self.expectedOldHeadSha.lower()
        self.newHeadSha = self.newHeadSha.lower()
        if self.expectedOldHeadSha == self.newHeadSha:
            raise ValueError("Review repair must advance the owned branch.")
        return self


class GitHubMergePayloadV1(ClosedModel):
    publicationId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    checkpointFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    checkpointStatus: Literal["review_or_merge_ready"]
    workflowApprovalFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    pullRequestNumber: int = Field(ge=1, le=9_007_199_254_740_991)
    branch: str
    headSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    baseBranch: str
    baseSha: str = Field(pattern=r"^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$")
    pullRequestUpdatedAt: str
    proofSnapshotFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    requiredChecksFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    mergeMethod: Literal["squash", "merge", "rebase"]

    @model_validator(mode="after")
    def validate_merge(self) -> "GitHubMergePayloadV1":
        self.branch = _validate_git_branch(self.branch, "Agent branch", agent_owned=True)
        self.baseBranch = _validate_git_branch(self.baseBranch, "Base branch")
        self.headSha = self.headSha.lower()
        self.baseSha = self.baseSha.lower()
        _canonical_github_timestamp(self.pullRequestUpdatedAt, "Pull request updatedAt")
        return self


class PreparedBackgroundGitHubActionV1(ClosedModel):
    version: Literal[1]
    kind: Literal["prepared_background_github_action"]
    operation: GitHubBackgroundOperationV1
    status: Literal["prepared"]
    id: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    missionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    graphRevision: int = Field(ge=0, le=9_007_199_254_740_991)
    capabilityEnvelopeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    nodeId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    nodeFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    executionHost: Literal["companion", "headless_runtime"]
    toolName: Literal[
        "github_publish_verified_branch",
        "github_create_draft_pull_request",
        "github_update_owned_branch",
        "github_merge_pull_request",
        "github_enable_auto_merge",
    ]
    descriptorFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedActionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    binding: PreparedBackgroundGitHubBindingV1
    authority: ConsumedBackgroundGitHubGrantV1
    payload: (
        GitHubVerifiedBranchPushPayloadV1
        | GitHubDraftPullRequestPayloadV1
        | GitHubReviewRepairFastForwardPayloadV1
        | GitHubMergePayloadV1
    )
    idempotencyKey: str = Field(min_length=1, max_length=512)
    reconciliationKey: str = Field(min_length=1, max_length=512)
    preparedAt: str
    expiresAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_action(self) -> "PreparedBackgroundGitHubActionV1":
        tool_and_payload = {
            "github_verified_branch_push_v1": (
                "github_publish_verified_branch", GitHubVerifiedBranchPushPayloadV1
            ),
            "github_draft_pull_request_v1": (
                "github_create_draft_pull_request", GitHubDraftPullRequestPayloadV1
            ),
            "github_review_repair_fast_forward_v1": (
                "github_update_owned_branch", GitHubReviewRepairFastForwardPayloadV1
            ),
            "github_pull_request_merge_v1": (
                "github_merge_pull_request", GitHubMergePayloadV1
            ),
            "github_pull_request_auto_merge_v1": (
                "github_enable_auto_merge", GitHubMergePayloadV1
            ),
        }
        expected_tool, expected_payload = tool_and_payload[self.operation]
        if self.toolName != expected_tool or not isinstance(self.payload, expected_payload):
            raise ValueError("GitHub operation does not match its closed tool and payload.")
        prepared_at = _canonical_github_timestamp(self.preparedAt, "preparedAt")
        expires_at = _canonical_github_timestamp(self.expiresAt, "expiresAt")
        consumed_at = _canonical_github_timestamp(self.authority.consumedAt, "consumedAt")
        grant_expires = _canonical_github_timestamp(self.authority.expiresAt, "grant expiresAt")
        if consumed_at > prepared_at or not prepared_at < expires_at <= grant_expires:
            raise ValueError("GitHub action lifetime is outside its consumed grant.")
        if self.idempotencyKey != self.reconciliationKey:
            raise ValueError("GitHub action idempotency and reconciliation keys differ.")
        if self.authority.actionFingerprint != self.preparedActionFingerprint:
            raise ValueError("GitHub action authority is bound to another prepared action.")
        merge_operation = self.operation in {
            "github_pull_request_merge_v1", "github_pull_request_auto_merge_v1"
        }
        required = 2 if merge_operation else 1
        receipts = self.authority.confirmationReceipts
        if self.authority.requiredConfirmations != required or len(receipts) != required:
            raise ValueError("GitHub action has the wrong exact confirmation count.")
        first = receipts[0]
        for index, receipt in enumerate(receipts, start=1):
            if (
                receipt.decision != "approved"
                or receipt.preparedActionId != self.preparedActionId
                or receipt.preparedActionFingerprint != self.preparedActionFingerprint
                or receipt.requiredConfirmations != required
                or receipt.confirmationOrdinal != index
                or _canonical_github_timestamp(receipt.decidedAt, "decidedAt") > consumed_at
                or receipt.hostInstanceFingerprint != first.hostInstanceFingerprint
                or receipt.actorFingerprint != first.actorFingerprint
                or receipt.sessionFingerprint != first.sessionFingerprint
                or receipt.signingKeyFingerprint != first.signingKeyFingerprint
            ):
                raise ValueError("GitHub approval receipts are not exact, ordered, and stable.")
        if (
            isinstance(self.payload, GitHubDraftPullRequestPayloadV1)
            and self.payload.workflowApprovalFingerprint != self.preparedActionFingerprint
        ):
            raise ValueError("Draft pull request is not bound to its exact workflow approval.")
        if (
            isinstance(
                self.payload,
                (GitHubReviewRepairFastForwardPayloadV1, GitHubMergePayloadV1),
            )
            and self.payload.workflowApprovalFingerprint != self.preparedActionFingerprint
        ):
            raise ValueError("GitHub workflow action is not bound to its exact approval.")
        if canonical_fingerprint(self.model_dump(exclude={"fingerprint"})) != self.fingerprint:
            raise ValueError("GitHub action fingerprint does not match its evidence.")
        return self


class PreparedBackgroundGitHubPackageIdentityV1(ClosedModel):
    version: Literal[1]
    kind: Literal["prepared_background_github_package_identity"]
    packageId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    packageFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    actionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedActionFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    operation: GitHubBackgroundOperationV1
    publicationId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    repositoryBindingFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    repositoryProfileFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    verifiedAccountId: int = Field(ge=1, le=9_007_199_254_740_991)
    backgroundAuthorizationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    preparedAt: str
    expiresAt: str
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_identity(self) -> "PreparedBackgroundGitHubPackageIdentityV1":
        prepared_at = _canonical_github_timestamp(self.preparedAt, "preparedAt")
        expires_at = _canonical_github_timestamp(self.expiresAt, "expiresAt")
        if expires_at <= prepared_at:
            raise ValueError("GitHub package identity lifetime is invalid.")
        if canonical_fingerprint(self.model_dump(exclude={"fingerprint"})) != self.fingerprint:
            raise ValueError("GitHub package identity fingerprint does not match its evidence.")
        return self


class CompanionJobPayloadV1(ClosedModel):
    version: Literal[1]
    graphRevision: int = Field(ge=0)
    executionHost: Literal["companion", "headless_runtime"]
    objective: str = Field(min_length=1, max_length=8_192)
    inputs: dict[str, Any]
    allowedTools: list[str] = Field(max_length=100)
    requiredCapabilities: list[str] = Field(max_length=100)
    bindings: list[LogicalBindingRefV1] = Field(max_length=100)
    authorization: BackgroundAuthorizationV1
    preparedExternalActionHandoff: PreparedExternalActionHandoffV1 | None = None
    preparedBackgroundCodeAction: PreparedBackgroundCodeActionV1 | None = None
    preparedBackgroundCodePackage: PreparedBackgroundCodePackageIdentityV1 | None = None
    preparedBackgroundGitHubAction: PreparedBackgroundGitHubActionV1 | None = None
    preparedBackgroundGitHubPackage: PreparedBackgroundGitHubPackageIdentityV1 | None = None
    createdAt: str
    updatedAt: str

    @field_validator("objective")
    @classmethod
    def reject_objective_credentials(cls, value: str) -> str:
        return validate_persisted_text(value, "objective")

    @field_validator("allowedTools", "requiredCapabilities")
    @classmethod
    def validate_stable_ids(cls, value: list[str]) -> list[str]:
        if len(value) != len(set(value)):
            raise ValueError("Capability and tool ids must be unique.")
        if any(not STABLE_ID_PATTERN.fullmatch(item) for item in value):
            raise ValueError("Capability and tool ids must be logical stable ids.")
        return value


class CapabilityEnvelopeProjectionV1(ClosedModel):
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    authorizationFingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)


class JobCreateRequest(ClosedModel):
    id: str = Field(min_length=1, max_length=256)
    missionId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    nodeId: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    executionHost: Literal["research", "code", "linear", "github"]
    payload: CompanionJobPayloadV1
    capabilityEnvelope: CapabilityEnvelopeProjectionV1
    idempotencyKey: str = Field(pattern=FINGERPRINT_PATTERN.pattern)

    @model_validator(mode="after")
    def validate_exact_host_binding(self, info: ValidationInfo) -> "JobCreateRequest":
        authorization = self.payload.authorization
        if self.capabilityEnvelope.authorizationFingerprint != authorization.fingerprint:
            raise ValueError("Capability envelope authorization fingerprint does not match the job grant.")
        expected = canonical_fingerprint(
            {
                "version": 1,
                "missionId": self.missionId,
                "nodeId": self.nodeId,
                "graphRevision": self.payload.graphRevision,
                "capabilityEnvelopeFingerprint": self.capabilityEnvelope.fingerprint,
                "authorizationFingerprint": authorization.fingerprint,
                **(
                    {
                        "preparedExternalActionHandoffFingerprint":
                            self.payload.preparedExternalActionHandoff.fingerprint
                    }
                    if self.payload.preparedExternalActionHandoff is not None
                    else {}
                ),
                **(
                    {
                        "preparedBackgroundCodeActionFingerprint":
                            self.payload.preparedBackgroundCodeAction.fingerprint,
                    }
                    if self.payload.preparedBackgroundCodeAction is not None
                    and self.payload.preparedBackgroundCodePackage is not None
                    else {}
                ),
                **(
                    {
                        "preparedBackgroundGitHubActionFingerprint":
                            self.payload.preparedBackgroundGitHubAction.fingerprint,
                    }
                    if self.payload.preparedBackgroundGitHubAction is not None
                    and self.payload.preparedBackgroundGitHubPackage is not None
                    else {}
                ),
            }
        )
        if self.idempotencyKey != expected:
            raise ValueError("Job idempotencyKey is not bound to the exact host envelope and grant.")
        expected_id = f"companion-{expected[len('sha256:'):len('sha256:') + 32]}"
        if self.id != expected_id:
            raise ValueError("Job id is not derived from its canonical idempotency binding.")
        allow_expired = bool(info.context and info.context.get("allow_expired"))
        authorized_at = dt.datetime.fromisoformat(
            authorization.authorizedAt.replace("Z", "+00:00")
        )
        if authorized_at > dt.datetime.now(dt.UTC) + dt.timedelta(seconds=5):
            raise ValueError("Background authorization is future-dated.")
        if authorization.expiresAt is not None:
            expires = dt.datetime.fromisoformat(authorization.expiresAt.replace("Z", "+00:00"))
            if expires <= authorized_at:
                raise ValueError("Background authorization expiry must follow issuance.")
            if not allow_expired and expires <= dt.datetime.now(dt.UTC):
                raise ValueError("Background authorization has expired.")
        self.payload.inputs = validate_job_inputs(self.executionHost, self.payload.inputs)
        handoff = self.payload.preparedExternalActionHandoff
        code_action = self.payload.preparedBackgroundCodeAction
        code_package = self.payload.preparedBackgroundCodePackage
        github_action = self.payload.preparedBackgroundGitHubAction
        github_package = self.payload.preparedBackgroundGitHubPackage
        prepared_families = sum(
            (
                handoff is not None,
                code_action is not None or code_package is not None,
                github_action is not None or github_package is not None,
            )
        )
        if prepared_families > 1:
            raise ValueError("Linear, Code, and GitHub contracts cannot share a job.")
        if (code_action is None) != (code_package is None):
            raise ValueError("Prepared Code action and package identity must be supplied together.")
        if (github_action is None) != (github_package is None):
            raise ValueError("Prepared GitHub action and package identity must be supplied together.")
        if handoff is not None:
            if (
                self.executionHost != "linear"
                or self.payload.executionHost != handoff.executionHost
                or self.missionId != handoff.missionId
                or self.nodeId != handoff.nodeId
                or self.payload.graphRevision != handoff.graphRevision
                or self.capabilityEnvelope.fingerprint
                != handoff.capabilityEnvelopeFingerprint
                or self.payload.allowedTools != ["linear_update_issue"]
                or self.payload.inputs
            ):
                raise ValueError(
                    "Prepared Linear handoff drifted from its exact companion job."
                )
            matching_bindings = [
                binding
                for binding in self.payload.bindings
                if binding.id == handoff.binding.id
            ]
            if (
                len(matching_bindings) != 1
                or matching_bindings[0].kind != handoff.binding.kind
                or matching_bindings[0].destinationFingerprint
                != handoff.binding.destinationFingerprint
            ):
                raise ValueError("Prepared Linear handoff binding drifted.")
        if code_action is not None and code_package is not None:
            if (
                self.executionHost != "code"
                or self.payload.executionHost != code_action.executionHost
                or self.missionId != code_action.missionId
                or self.nodeId != code_action.nodeId
                or self.payload.graphRevision != code_action.graphRevision
                or self.capabilityEnvelope.fingerprint
                != code_action.capabilityEnvelopeFingerprint
                or self.payload.allowedTools != ["code_validate_commit_prepared"]
                or self.payload.inputs
                or code_package.handoffFingerprint != code_action.fingerprint
                or code_package.workspaceId != code_action.binding.workspaceId
                or code_package.workspaceBindingFingerprint
                != code_action.payload.workspaceBindingFingerprint
                or code_package.repositoryProfileKey
                != code_action.binding.repositoryProfileKey
                or code_package.repositoryProfileFingerprint
                != code_action.payload.repositoryProfileFingerprint
                or code_package.consumedActionAuthorityFingerprint
                != code_action.authority.authorityFingerprint
                or code_package.backgroundAuthorizationFingerprint
                != authorization.fingerprint
            ):
                raise ValueError("Prepared Code package drifted from its exact companion job.")
            matching_bindings = [
                binding for binding in self.payload.bindings
                if binding.id == code_action.binding.workspaceId
            ]
            if (
                len(matching_bindings) != 1
                or matching_bindings[0].kind not in (
                    "repository", "repository-workspace", "code-workspace"
                )
                or matching_bindings[0].destinationFingerprint
                != code_action.binding.destinationFingerprint
            ):
                raise ValueError("Prepared Code workspace binding drifted.")
        if github_action is not None and github_package is not None:
            if (
                self.executionHost != "github"
                or self.payload.executionHost != github_action.executionHost
                or self.missionId != github_action.missionId
                or self.nodeId != github_action.nodeId
                or self.payload.graphRevision != github_action.graphRevision
                or self.capabilityEnvelope.fingerprint
                != github_action.capabilityEnvelopeFingerprint
                or self.payload.allowedTools != [github_action.toolName]
                or self.payload.inputs
                or github_package.actionFingerprint != github_action.fingerprint
                or github_package.preparedActionFingerprint
                != github_action.preparedActionFingerprint
                or github_package.operation != github_action.operation
                or github_package.publicationId != github_action.payload.publicationId
                or github_package.repositoryBindingFingerprint
                != github_action.binding.repositoryBindingFingerprint
                or github_package.repositoryProfileFingerprint
                != github_action.binding.repositoryProfileFingerprint
                or github_package.verifiedAccountId
                != github_action.binding.verifiedAccountId
                or github_package.backgroundAuthorizationFingerprint
                != authorization.fingerprint
            ):
                raise ValueError("Prepared GitHub package drifted from its exact companion job.")
            matching_bindings = [
                binding
                for binding in self.payload.bindings
                if binding.id == github_action.binding.id
            ]
            if (
                len(matching_bindings) != 1
                or matching_bindings[0].kind not in (
                    "github-repository", "repository"
                )
                or matching_bindings[0].destinationFingerprint
                != github_action.binding.destinationFingerprint
            ):
                raise ValueError("Prepared GitHub repository binding drifted.")
        binding_records = [binding.model_dump() for binding in self.payload.bindings]
        for binding in binding_records:
            validate_binding(self.executionHost, binding)
        binding_ids = {binding.id for binding in self.payload.bindings}
        for referenced in _binding_references(self.payload.inputs):
            if referenced not in binding_ids:
                raise ValueError(f"Input references unknown logical binding {referenced!r}.")
        return self


class JobRecord(BaseModel):
    id: str
    missionId: str
    nodeId: str
    executionHost: str
    state: str
    payload: dict[str, Any]
    capabilityEnvelope: dict[str, Any]
    output: dict[str, Any]
    idempotencyKey: str
    ownerCoordinatorId: str | None = None
    leaseExpiresAt: str | None = None
    attempts: int
    createdAt: str
    updatedAt: str


class JobClaimRequest(ClosedModel):
    coordinatorId: str = Field(min_length=1, max_length=256)
    leaseSeconds: int = Field(default=60, ge=5, le=300)


class JobLeaseResponse(BaseModel):
    job: JobRecord
    leaseToken: str = Field(repr=False)


class JobLeaseMutationRequest(ClosedModel):
    coordinatorId: str = Field(min_length=1, max_length=256)
    leaseToken: SecretStr
    leaseSeconds: int = Field(default=60, ge=5, le=300)


class JobCompletionRequest(ClosedModel):
    coordinatorId: str = Field(min_length=1, max_length=256)
    leaseToken: SecretStr
    state: Literal["complete", "blocked", "cancelled", "failed"]
    output: dict[str, Any] = Field(default_factory=dict)



class EventAppendRequest(ClosedModel):
    coordinatorId: str = Field(min_length=1, max_length=256)
    leaseToken: SecretStr
    type: str = Field(min_length=1, max_length=128, pattern=r"^[A-Za-z0-9_.:-]+$")
    payload: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_persisted_event(self) -> "EventAppendRequest":
        self.payload = sanitize_event_payload(self.type, self.payload)
        return self


class EventRecord(BaseModel):
    sequence: int
    jobId: str
    type: str
    payload: dict[str, Any]
    createdAt: str


class ReceiptAppendRequest(ClosedModel):
    coordinatorId: str = Field(min_length=1, max_length=256)
    leaseToken: SecretStr
    provider: Literal["research", "code", "linear", "github", "companion"]
    operation: str = Field(pattern=STABLE_ID_PATTERN.pattern)
    status: Literal["prepared", "dispatched", "verified", "ambiguous", "failed"]
    fingerprint: str = Field(pattern=FINGERPRINT_PATTERN.pattern)
    payload: dict[str, Any] = Field(default_factory=dict)


class ReceiptRecord(BaseModel):
    id: str
    jobId: str
    provider: str
    operation: str
    status: str
    fingerprint: str
    payload: dict[str, Any]
    createdAt: str


class SecretPutRequest(ClosedModel):
    value: SecretStr
    label: str = Field(min_length=1, max_length=256)
    metadata: dict[str, str] = Field(default_factory=dict)

    @field_validator("metadata")
    @classmethod
    def reject_secret_metadata(cls, value: dict[str, str]) -> dict[str, str]:
        allowed = {"account", "actor", "credentialkind", "provider", "scope"}
        if any(normalize_key(key) not in allowed for key in value):
            raise ValueError("Secret metadata has a closed non-secret field set.")
        if any(len(entry) > 512 for entry in value.values()):
            raise ValueError("Secret metadata values must be bounded.")
        return value


class SecretDescription(BaseModel):
    referenceId: str
    label: str
    metadata: dict[str, str]
    backend: str
    persistent: bool
    createdAt: str
    updatedAt: str


class SecretLeaseRequest(BaseModel):
    ttlSeconds: int = Field(default=60, ge=1, le=300)


class SecretLeaseResponse(BaseModel):
    leaseId: str
    referenceId: str
    value: str = Field(repr=False)
    expiresAt: str


class SecretRemoveResponse(BaseModel):
    removed: bool


def _binding_references(value: Any) -> set[str]:
    references: set[str] = set()
    if isinstance(value, list):
        for entry in value:
            references.update(_binding_references(entry))
    elif isinstance(value, dict):
        if set(value).issubset({"bindingId", "selector"}) and "bindingId" in value:
            binding_id = value["bindingId"]
            if not isinstance(binding_id, str) or not STABLE_ID_PATTERN.fullmatch(binding_id):
                raise ValueError("Input bindingId must be a logical stable id.")
            selector = value.get("selector")
            if selector is not None:
                if not isinstance(selector, str) or not selector or len(selector) > 256:
                    raise ValueError("Input binding selector must be a bounded logical selector.")
                lowered = selector.replace("\\", "/").lower()
                if selector.startswith("/") or "../" in lowered or ".obsidian" in lowered:
                    raise ValueError("Input binding selectors cannot contain paths.")
            references.add(binding_id)
        else:
            for nested in value.values():
                references.update(_binding_references(nested))
    return references


def _safe_public_reference_url(value: str | None) -> str | None:
    if value is None:
        return None
    parsed = urlparse(value)
    if parsed.scheme.lower() not in {"http", "https"} or not parsed.hostname:
        raise ValueError("Memory source references require HTTP(S) URLs.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Memory source URLs cannot contain credentials.")
    for key, _entry in parse_qsl(parsed.query):
        if any(marker in normalize_key(key) for marker in ("token", "secret", "password", "apikey", "credential")):
            raise ValueError("Memory source URL contains a credential-like query field.")
    return value
