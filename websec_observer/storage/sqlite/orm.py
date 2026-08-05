from __future__ import annotations

from datetime import datetime
from typing import Any

from sqlalchemy import (
    JSON,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    LargeBinary,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


class Base(DeclarativeBase):
    pass


class ProjectRow(Base):
    __tablename__ = "test_projects"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    base_url: Mapped[str] = mapped_column(Text, nullable=False)
    allowed_hosts: Mapped[list[str]] = mapped_column(JSON, nullable=False)
    denied_hosts: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    passive_only: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
    active_validation_config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)


class SessionRow(Base):
    __tablename__ = "test_sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    project_id: Mapped[str] = mapped_column(
        ForeignKey("test_projects.id", ondelete="CASCADE"), nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    browser_version: Mapped[str | None] = mapped_column(String(200))
    user_agent: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    config_snapshot: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    captured_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    dropped_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    __table_args__ = (Index("ix_sessions_project_started", "project_id", "started_at"),)


class UserActionRow(Base):
    __tablename__ = "user_actions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False
    )
    action_type: Mapped[str] = mapped_column(String(40), nullable=False)
    page_url: Mapped[str] = mapped_column(Text, nullable=False)
    selector: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    correlation_start: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    correlation_end: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    __table_args__ = (Index("ix_actions_session_timestamp", "session_id", "timestamp"),)


class NetworkRequestRow(Base):
    __tablename__ = "network_requests"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False
    )
    action_id: Mapped[str | None] = mapped_column(
        ForeignKey("user_actions.id", ondelete="SET NULL")
    )
    browser_request_id: Mapped[str] = mapped_column(String(300), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    resource_type: Mapped[str] = mapped_column(String(32), nullable=False)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    scheme: Mapped[str] = mapped_column(String(10), nullable=False)
    host: Mapped[str] = mapped_column(String(253), nullable=False)
    port: Mapped[int | None] = mapped_column(Integer)
    path: Mapped[str] = mapped_column(Text, nullable=False)
    query: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    headers: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    cookies: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    body: Mapped[bytes | None] = mapped_column(LargeBinary)
    body_encoding: Mapped[str | None] = mapped_column(String(40))
    initiator: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    redirect_from_id: Mapped[str | None] = mapped_column(
        ForeignKey("network_requests.id", ondelete="SET NULL")
    )
    size: Mapped[int | None] = mapped_column(Integer)
    scope_disposition: Mapped[str] = mapped_column(String(32), nullable=False)
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    body_sha256: Mapped[str | None] = mapped_column(String(64))
    __table_args__ = (
        UniqueConstraint("session_id", "browser_request_id", name="uq_request_session_browser_id"),
        Index("ix_requests_session_timestamp", "session_id", "timestamp"),
        Index("ix_requests_session_host_path", "session_id", "host", "path"),
        Index("ix_requests_session_resource", "session_id", "resource_type"),
        Index("ix_requests_action", "action_id"),
    )


class NetworkResponseRow(Base):
    __tablename__ = "network_responses"
    request_id: Mapped[str] = mapped_column(
        ForeignKey("network_requests.id", ondelete="CASCADE"), primary_key=True
    )
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    status: Mapped[int] = mapped_column(Integer, nullable=False)
    status_text: Mapped[str] = mapped_column(String(200), nullable=False, default="")
    headers: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    cookies: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    content_type: Mapped[str | None] = mapped_column(String(300))
    body: Mapped[bytes | None] = mapped_column(LargeBinary)
    body_encoding: Mapped[str | None] = mapped_column(String(40))
    size: Mapped[int | None] = mapped_column(Integer)
    duration_ms: Mapped[float | None] = mapped_column(Float)
    remote_ip: Mapped[str | None] = mapped_column(String(45))
    protocol: Mapped[str | None] = mapped_column(String(30))
    from_cache: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    decode_error: Mapped[str | None] = mapped_column(String(200))
    __table_args__ = (Index("ix_responses_status", "status"),)


class WebSocketConnectionRow(Base):
    __tablename__ = "websocket_connections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False
    )
    action_id: Mapped[str | None] = mapped_column(
        ForeignKey("user_actions.id", ondelete="SET NULL")
    )
    url: Mapped[str] = mapped_column(Text, nullable=False)
    handshake_request: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    handshake_response: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False, default=dict)
    origin: Mapped[str | None] = mapped_column(Text)
    subprotocol: Mapped[str | None] = mapped_column(String(200))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    scope_disposition: Mapped[str] = mapped_column(String(32), nullable=False)
    __table_args__ = (Index("ix_websockets_session_opened", "session_id", "opened_at"),)


class WebSocketFrameRow(Base):
    __tablename__ = "websocket_frames"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    connection_id: Mapped[str] = mapped_column(
        ForeignKey("websocket_connections.id", ondelete="CASCADE"), nullable=False
    )
    direction: Mapped[str] = mapped_column(String(16), nullable=False)
    timestamp: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    opcode: Mapped[int] = mapped_column(Integer, nullable=False)
    payload: Mapped[bytes | None] = mapped_column(LargeBinary)
    payload_encoding: Mapped[str | None] = mapped_column(String(40))
    size: Mapped[int] = mapped_column(Integer, nullable=False)
    truncated: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    __table_args__ = (Index("ix_frames_connection_timestamp", "connection_id", "timestamp"),)


class FindingRow(Base):
    __tablename__ = "findings"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False
    )
    rule_id: Mapped[str] = mapped_column(String(200), nullable=False)
    rule_version: Mapped[str] = mapped_column(String(50), nullable=False, default="1")
    title: Mapped[str] = mapped_column(String(500), nullable=False)
    category: Mapped[str] = mapped_column(String(100), nullable=False)
    severity: Mapped[str] = mapped_column(String(20), nullable=False)
    confidence: Mapped[str] = mapped_column(String(20), nullable=False)
    affected_url: Mapped[str] = mapped_column(Text, nullable=False)
    affected_request_id: Mapped[str | None] = mapped_column(
        ForeignKey("network_requests.id", ondelete="SET NULL")
    )
    description: Mapped[str] = mapped_column(Text, nullable=False)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    remediation: Mapped[str] = mapped_column(Text, nullable=False)
    references: Mapped[list[str]] = mapped_column(JSON, nullable=False, default=list)
    false_positive_notes: Mapped[str] = mapped_column(Text, nullable=False, default="")
    safe_reproduction: Mapped[str] = mapped_column(Text, nullable=False, default="")
    status: Mapped[str] = mapped_column(String(32), nullable=False)
    analyst_note: Mapped[str | None] = mapped_column(Text)
    fingerprint: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    __table_args__ = (
        Index("ix_findings_session_severity", "session_id", "severity"),
        Index("ix_findings_session_category", "session_id", "category"),
        Index("ix_findings_session_status", "session_id", "status"),
        UniqueConstraint("session_id", "fingerprint", name="uq_finding_session_fingerprint"),
    )


class ValidationAuditRow(Base):
    __tablename__ = "validation_audits"
    id: Mapped[str] = mapped_column(String(36), primary_key=True)
    session_id: Mapped[str] = mapped_column(
        ForeignKey("test_sessions.id", ondelete="CASCADE"), nullable=False
    )
    finding_id: Mapped[str | None] = mapped_column(
        ForeignKey("findings.id", ondelete="SET NULL")
    )
    rule_id: Mapped[str] = mapped_column(String(200), nullable=False)
    method: Mapped[str] = mapped_column(String(16), nullable=False)
    url: Mapped[str] = mapped_column(Text, nullable=False)
    scope_decision: Mapped[str] = mapped_column(String(32), nullable=False)
    budget_used: Mapped[int] = mapped_column(Integer, nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    result: Mapped[str | None] = mapped_column(String(100))
    failure_reason: Mapped[str | None] = mapped_column(Text)
