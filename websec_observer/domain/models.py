from dataclasses import dataclass, field
from datetime import UTC, datetime
from types import MappingProxyType
from typing import Any, Mapping
from uuid import UUID, uuid4

from websec_observer.domain.enums import (
    Confidence,
    FindingStatus,
    ScopeDisposition,
    Severity,
    SessionStatus,
    ReplayStatus,
)


@dataclass(frozen=True, slots=True)
class TestProject:
    name: str
    base_url: str
    allowed_hosts: tuple[str, ...]
    denied_hosts: tuple[str, ...] = ()
    passive_only: bool = True
    id: UUID = field(default_factory=uuid4)
    created_at: datetime = field(default_factory=lambda: datetime.now(UTC))


@dataclass(frozen=True, slots=True)
class TestSession:
    project_id: UUID
    status: SessionStatus = SessionStatus.CREATED
    id: UUID = field(default_factory=uuid4)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    browser_version: str | None = None
    user_agent: str | None = None


@dataclass(frozen=True, slots=True)
class FindingDraft:
    rule_id: str
    title: str
    category: str
    severity: Severity
    confidence: Confidence
    affected_url: str
    description: str
    remediation: str
    evidence: Mapping[str, Any]
    references: tuple[str, ...] = ()
    false_positive_notes: str = ""
    safe_reproduction: str = ""

    def __post_init__(self) -> None:
        object.__setattr__(self, "evidence", MappingProxyType(dict(self.evidence)))


@dataclass(frozen=True, slots=True)
class Finding(FindingDraft):
    session_id: UUID = field(default_factory=uuid4)
    id: UUID = field(default_factory=uuid4)
    status: FindingStatus = FindingStatus.OPEN


@dataclass(frozen=True, slots=True)
class CapturedRequest:
    id: UUID
    session_id: UUID
    browser_request_id: str
    timestamp: datetime
    resource_type: str
    method: str
    url: str
    scheme: str
    host: str
    port: int | None
    path: str
    query: Mapping[str, Any]
    headers: Mapping[str, Any]
    cookies: Mapping[str, Any]
    body: bytes | None
    body_encoding: str | None
    initiator: Mapping[str, Any]
    redirect_from_id: UUID | None
    size: int | None
    scope_disposition: ScopeDisposition
    truncated: bool = False
    body_sha256: str | None = None
    action_id: UUID | None = None

    def __post_init__(self) -> None:
        for name in ("query", "headers", "cookies", "initiator"):
            object.__setattr__(self, name, MappingProxyType(dict(getattr(self, name))))


@dataclass(frozen=True, slots=True)
class CapturedResponse:
    request_id: UUID
    timestamp: datetime
    status: int
    status_text: str
    headers: Mapping[str, Any]
    cookies: Mapping[str, Any]
    content_type: str | None
    body: bytes | None
    body_encoding: str | None
    size: int | None
    duration_ms: float | None
    remote_ip: str | None
    protocol: str | None
    from_cache: bool
    truncated: bool = False
    decode_error: str | None = None

    def __post_init__(self) -> None:
        object.__setattr__(self, "headers", MappingProxyType(dict(self.headers)))
        object.__setattr__(self, "cookies", MappingProxyType(dict(self.cookies)))


@dataclass(frozen=True, slots=True)
class CapturedTransaction:
    request: CapturedRequest
    response: CapturedResponse | None


@dataclass(frozen=True, slots=True)
class ParameterOverride:
    """A user-approved value change; parameter identity remains immutable."""

    location: str  # query, json, form
    name: str
    value: str


@dataclass(frozen=True, slots=True)
class ReplayRun:
    session_id: UUID
    request_id: UUID
    status: ReplayStatus = ReplayStatus.CREATED
    overrides: tuple[ParameterOverride, ...] = ()
    id: UUID = field(default_factory=uuid4)
    started_at: datetime | None = None
    ended_at: datetime | None = None
    response_status: int | None = None
    response_preview: str | None = None
    error: str | None = None


@dataclass(frozen=True, slots=True)
class WebSocketConnection:
    id: UUID
    session_id: UUID
    url: str
    opened_at: datetime
    closed_at: datetime | None = None
    origin: str | None = None
    subprotocol: str | None = None
    scope_disposition: ScopeDisposition = ScopeDisposition.ALLOW_FULL


@dataclass(frozen=True, slots=True)
class WebSocketFrame:
    id: UUID
    connection_id: UUID
    direction: str
    timestamp: datetime
    opcode: int
    payload: bytes | None
    payload_encoding: str | None
    size: int
    truncated: bool = False


@dataclass(frozen=True, slots=True)
class UserAction:
    id: UUID
    session_id: UUID
    action_type: str
    page_url: str
    selector: str | None
    description: str | None
    timestamp: datetime
