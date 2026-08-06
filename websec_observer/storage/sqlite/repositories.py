from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from websec_observer.domain.enums import (
    Confidence,
    FindingStatus,
    ReplayStatus,
    ScopeDisposition,
    Severity,
    SessionStatus,
)
from websec_observer.domain.models import (
    CapturedRequest,
    CapturedResponse,
    CapturedTransaction,
    Finding,
    ParameterOverride,
    ReplayRun,
    TestProject,
    TestSession,
    WebSocketConnection,
    WebSocketFrame,
)
from websec_observer.storage.sqlite.orm import (
    FindingRow,
    NetworkRequestRow,
    NetworkResponseRow,
    ProjectRow,
    ReplayRunRow,
    SessionRow,
    WebSocketConnectionRow,
    WebSocketFrameRow,
)


class SqliteProjectRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, project: TestProject) -> None:
        self._session.add(
            ProjectRow(
                id=str(project.id),
                name=project.name,
                base_url=project.base_url,
                allowed_hosts=list(project.allowed_hosts),
                denied_hosts=list(project.denied_hosts),
                passive_only=project.passive_only,
                active_validation_config={},
                created_at=project.created_at,
            )
        )
        await self._session.flush()

    async def get(self, project_id: UUID) -> TestProject | None:
        row = await self._session.get(ProjectRow, str(project_id))
        return _project_from_row(row) if row else None

    async def list(self) -> Sequence[TestProject]:
        rows = (await self._session.scalars(select(ProjectRow).order_by(ProjectRow.created_at))).all()
        return tuple(_project_from_row(row) for row in rows)


class SqliteSessionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, session: TestSession) -> None:
        self._session.add(_session_to_row(session))
        await self._session.flush()

    async def get(self, session_id: UUID) -> TestSession | None:
        row = await self._session.get(SessionRow, str(session_id))
        return _session_from_row(row) if row else None

    async def update(self, session: TestSession) -> None:
        row = await self._session.get(SessionRow, str(session.id))
        if row is None:
            raise LookupError(f"session not found: {session.id}")
        row.project_id = str(session.project_id)
        row.status = session.status.value
        row.started_at = session.started_at
        row.ended_at = session.ended_at
        row.browser_version = session.browser_version
        row.user_agent = session.user_agent


class SqliteFindingRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add_many(self, findings: Sequence[Finding]) -> None:
        now = datetime.now(UTC)
        self._session.add_all(
            [
                FindingRow(
                    id=str(item.id),
                    session_id=str(item.session_id),
                    rule_id=item.rule_id,
                    rule_version="1",
                    title=item.title,
                    category=item.category,
                    severity=item.severity.value,
                    confidence=item.confidence.value,
                    affected_url=item.affected_url,
                    affected_request_id=None,
                    description=item.description,
                    evidence=dict(item.evidence),
                    remediation=item.remediation,
                    references=list(item.references),
                    false_positive_notes=item.false_positive_notes,
                    safe_reproduction="",
                    status=item.status.value,
                    analyst_note=None,
                    fingerprint=None,
                    created_at=now,
                    updated_at=now,
                )
                for item in findings
            ]
        )

    async def list_for_session(self, session_id: UUID) -> Sequence[Finding]:
        statement = (
            select(FindingRow)
            .where(FindingRow.session_id == str(session_id))
            .order_by(FindingRow.created_at, FindingRow.id)
        )
        rows = (await self._session.scalars(statement)).all()
        return tuple(_finding_from_row(row) for row in rows)


class SqliteTransactionRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add_many(self, transactions: Sequence[CapturedTransaction]) -> None:
        request_rows: list[NetworkRequestRow] = []
        response_rows: list[NetworkResponseRow] = []
        for transaction in transactions:
            request = transaction.request
            request_rows.append(
                NetworkRequestRow(
                    id=str(request.id),
                    session_id=str(request.session_id),
                    action_id=str(request.action_id) if request.action_id else None,
                    browser_request_id=request.browser_request_id,
                    timestamp=request.timestamp,
                    resource_type=request.resource_type,
                    method=request.method,
                    url=request.url,
                    scheme=request.scheme,
                    host=request.host,
                    port=request.port,
                    path=request.path,
                    query=dict(request.query),
                    headers=dict(request.headers),
                    cookies=dict(request.cookies),
                    body=request.body,
                    body_encoding=request.body_encoding,
                    initiator=dict(request.initiator),
                    redirect_from_id=(
                        str(request.redirect_from_id) if request.redirect_from_id else None
                    ),
                    size=request.size,
                    scope_disposition=request.scope_disposition.value,
                    truncated=request.truncated,
                    body_sha256=request.body_sha256,
                )
            )
            if transaction.response is not None:
                response = transaction.response
                response_rows.append(
                    NetworkResponseRow(
                        request_id=str(response.request_id),
                        timestamp=response.timestamp,
                        status=response.status,
                        status_text=response.status_text,
                        headers=dict(response.headers),
                        cookies=dict(response.cookies),
                        content_type=response.content_type,
                        body=response.body,
                        body_encoding=response.body_encoding,
                        size=response.size,
                        duration_ms=response.duration_ms,
                        remote_ip=response.remote_ip,
                        protocol=response.protocol,
                        from_cache=response.from_cache,
                        truncated=response.truncated,
                        decode_error=response.decode_error,
                    )
                )
        self._session.add_all(request_rows)
        await self._session.flush()
        self._session.add_all(response_rows)

    async def list_for_session(self, session_id: UUID) -> Sequence[CapturedTransaction]:
        request_statement = (
            select(NetworkRequestRow)
            .where(NetworkRequestRow.session_id == str(session_id))
            .order_by(NetworkRequestRow.timestamp, NetworkRequestRow.id)
        )
        request_rows = (await self._session.scalars(request_statement)).all()
        if not request_rows:
            return ()
        request_ids = [row.id for row in request_rows]
        response_statement = select(NetworkResponseRow).where(
            NetworkResponseRow.request_id.in_(request_ids)
        )
        response_rows = (await self._session.scalars(response_statement)).all()
        responses = {row.request_id: row for row in response_rows}
        return tuple(
            CapturedTransaction(
                request=_captured_request_from_row(row),
                response=(
                    _captured_response_from_row(responses[row.id])
                    if row.id in responses
                    else None
                ),
            )
            for row in request_rows
        )


class SqliteWebSocketRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add_connection(self, connection: WebSocketConnection) -> None:
        self._session.add(
            WebSocketConnectionRow(
                id=str(connection.id),
                session_id=str(connection.session_id),
                action_id=None,
                url=connection.url,
                handshake_request={},
                handshake_response={},
                origin=connection.origin,
                subprotocol=connection.subprotocol,
                opened_at=connection.opened_at,
                closed_at=connection.closed_at,
                scope_disposition=connection.scope_disposition.value,
            )
        )
        await self._session.flush()

    async def close_connection(self, connection_id: UUID, closed_at: object) -> None:
        row = await self._session.get(WebSocketConnectionRow, str(connection_id))
        if row is None:
            raise LookupError(f"websocket connection not found: {connection_id}")
        row.closed_at = closed_at  # type: ignore[assignment]

    async def add_frames(self, frames: Sequence[WebSocketFrame]) -> None:
        self._session.add_all(
            [
                WebSocketFrameRow(
                    id=str(frame.id),
                    connection_id=str(frame.connection_id),
                    direction=frame.direction,
                    timestamp=frame.timestamp,
                    opcode=frame.opcode,
                    payload=frame.payload,
                    payload_encoding=frame.payload_encoding,
                    size=frame.size,
                    truncated=frame.truncated,
                )
                for frame in frames
            ]
        )
        await self._session.flush()

    async def list_for_session(self, session_id: UUID) -> Sequence[WebSocketFrame]:
        statement = (
            select(WebSocketFrameRow)
            .join(WebSocketConnectionRow)
            .where(WebSocketConnectionRow.session_id == str(session_id))
            .order_by(WebSocketFrameRow.timestamp, WebSocketFrameRow.id)
        )
        rows = (await self._session.scalars(statement)).all()
        return tuple(
            WebSocketFrame(
                id=UUID(row.id),
                connection_id=UUID(row.connection_id),
                direction=row.direction,
                timestamp=_aware(row.timestamp),
                opcode=row.opcode,
                payload=row.payload,
                payload_encoding=row.payload_encoding,
                size=row.size,
                truncated=row.truncated,
            )
            for row in rows
        )


def _project_from_row(row: ProjectRow) -> TestProject:
    return TestProject(
        id=UUID(row.id),
        name=row.name,
        base_url=row.base_url,
        allowed_hosts=tuple(row.allowed_hosts),
        denied_hosts=tuple(row.denied_hosts),
        passive_only=row.passive_only,
        created_at=row.created_at.replace(tzinfo=UTC) if row.created_at.tzinfo is None else row.created_at,
    )


def _session_to_row(session: TestSession) -> SessionRow:
    return SessionRow(
        id=str(session.id),
        project_id=str(session.project_id),
        status=session.status.value,
        started_at=session.started_at,
        ended_at=session.ended_at,
        browser_version=session.browser_version,
        user_agent=session.user_agent,
        config_snapshot={},
        captured_count=0,
        dropped_count=0,
    )


def _session_from_row(row: SessionRow) -> TestSession:
    def aware(value: datetime | None) -> datetime | None:
        return value.replace(tzinfo=UTC) if value is not None and value.tzinfo is None else value

    return TestSession(
        id=UUID(row.id),
        project_id=UUID(row.project_id),
        status=SessionStatus(row.status),
        started_at=aware(row.started_at),
        ended_at=aware(row.ended_at),
        browser_version=row.browser_version,
        user_agent=row.user_agent,
    )


def _finding_from_row(row: FindingRow) -> Finding:
    return Finding(
        id=UUID(row.id),
        session_id=UUID(row.session_id),
        rule_id=row.rule_id,
        title=row.title,
        category=row.category,
        severity=Severity(row.severity),
        confidence=Confidence(row.confidence),
        affected_url=row.affected_url,
        description=row.description,
        remediation=row.remediation,
        evidence=row.evidence,
        references=tuple(row.references),
        false_positive_notes=row.false_positive_notes,
        status=FindingStatus(row.status),
    )


def _captured_request_from_row(row: NetworkRequestRow) -> CapturedRequest:
    return CapturedRequest(
        id=UUID(row.id),
        session_id=UUID(row.session_id),
        browser_request_id=row.browser_request_id,
        timestamp=row.timestamp.replace(tzinfo=UTC) if row.timestamp.tzinfo is None else row.timestamp,
        resource_type=row.resource_type,
        method=row.method,
        url=row.url,
        scheme=row.scheme,
        host=row.host,
        port=row.port,
        path=row.path,
        query=row.query,
        headers=row.headers,
        cookies=row.cookies,
        body=row.body,
        body_encoding=row.body_encoding,
        initiator=row.initiator,
        redirect_from_id=UUID(row.redirect_from_id) if row.redirect_from_id else None,
        size=row.size,
        scope_disposition=ScopeDisposition(row.scope_disposition),
        truncated=row.truncated,
        body_sha256=row.body_sha256,
    )


def _captured_response_from_row(row: NetworkResponseRow) -> CapturedResponse:
    return CapturedResponse(
        request_id=UUID(row.request_id),
        timestamp=row.timestamp.replace(tzinfo=UTC) if row.timestamp.tzinfo is None else row.timestamp,
        status=row.status,
        status_text=row.status_text,
        headers=row.headers,
        cookies=row.cookies,
        content_type=row.content_type,
        body=row.body,
        body_encoding=row.body_encoding,
        size=row.size,
        duration_ms=row.duration_ms,
        remote_ip=row.remote_ip,
        protocol=row.protocol,
        from_cache=row.from_cache,
        truncated=row.truncated,
        decode_error=row.decode_error,
    )


class SqliteReplayRepository:
    def __init__(self, session: AsyncSession) -> None:
        self._session = session

    async def add(self, replay: ReplayRun) -> None:
        await self._session.merge(ReplayRunRow(
            id=str(replay.id), session_id=str(replay.session_id), request_id=str(replay.request_id),
            status=replay.status.value,
            overrides=[{"location": item.location, "name": item.name, "value": item.value} for item in replay.overrides],
            started_at=replay.started_at, ended_at=replay.ended_at,
            response_status=replay.response_status, response_preview=replay.response_preview, error=replay.error,
        ))
        await self._session.flush()

    async def list_for_session(self, session_id: UUID) -> Sequence[ReplayRun]:
        rows = (await self._session.scalars(select(ReplayRunRow).where(ReplayRunRow.session_id == str(session_id)).order_by(ReplayRunRow.started_at, ReplayRunRow.id))).all()
        return tuple(ReplayRun(
            id=UUID(row.id), session_id=UUID(row.session_id), request_id=UUID(row.request_id),
            status=ReplayStatus(row.status),
            overrides=tuple(ParameterOverride(**item) for item in row.overrides),
            started_at=row.started_at, ended_at=row.ended_at,
            response_status=row.response_status, response_preview=row.response_preview, error=row.error,
        ) for row in rows)
