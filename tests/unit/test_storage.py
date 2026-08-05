from __future__ import annotations

from dataclasses import replace
from uuid import uuid4

import pytest
import pytest_asyncio
from sqlalchemy import inspect
from sqlalchemy.ext.asyncio import AsyncEngine

from websec_observer.domain.enums import Confidence, Severity, SessionStatus
from websec_observer.domain.models import Finding, TestProject as Project, TestSession as Session
from websec_observer.storage.sqlite.database import create_database_engine, create_session_factory
from websec_observer.storage.sqlite.orm import Base
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


@pytest_asyncio.fixture
async def engine() -> AsyncEngine:
    value = create_database_engine("sqlite+aiosqlite:///:memory:")
    async with value.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    yield value
    await value.dispose()


@pytest.mark.asyncio
async def test_schema_contains_required_tables_and_indexes(engine: AsyncEngine) -> None:
    async with engine.connect() as connection:
        tables = await connection.run_sync(lambda sync: set(inspect(sync).get_table_names()))
        request_indexes = await connection.run_sync(
            lambda sync: {item["name"] for item in inspect(sync).get_indexes("network_requests")}
        )
    assert {
        "test_projects",
        "test_sessions",
        "user_actions",
        "network_requests",
        "network_responses",
        "websocket_connections",
        "websocket_frames",
        "findings",
        "validation_audits",
    } <= tables
    assert "ix_requests_session_timestamp" in request_indexes
    assert "ix_requests_session_host_path" in request_indexes


@pytest.mark.asyncio
async def test_project_and_session_round_trip_and_update(engine: AsyncEngine) -> None:
    factory = create_session_factory(engine)
    project = Project(
        name="Demo",
        base_url="https://example.test/",
        allowed_hosts=("example.test",),
    )
    session = Session(project_id=project.id)
    async with SqliteUnitOfWork(factory) as uow:
        await uow.projects.add(project)
        await uow.sessions.add(session)
        await uow.commit()
    async with SqliteUnitOfWork(factory) as uow:
        loaded_project = await uow.projects.get(project.id)
        loaded_session = await uow.sessions.get(session.id)
        assert loaded_project == project
        assert loaded_session == session
        await uow.sessions.update(replace(session, status=SessionStatus.RUNNING))
        await uow.commit()
    async with SqliteUnitOfWork(factory) as uow:
        updated = await uow.sessions.get(session.id)
        assert updated is not None
        assert updated.status is SessionStatus.RUNNING


@pytest.mark.asyncio
async def test_uow_rolls_back_on_exception(engine: AsyncEngine) -> None:
    factory = create_session_factory(engine)
    project = Project(
        name="Rollback",
        base_url="https://example.test/",
        allowed_hosts=("example.test",),
    )
    with pytest.raises(RuntimeError, match="abort"):
        async with SqliteUnitOfWork(factory) as uow:
            await uow.projects.add(project)
            raise RuntimeError("abort")
    async with SqliteUnitOfWork(factory) as uow:
        assert await uow.projects.get(project.id) is None


@pytest.mark.asyncio
async def test_findings_round_trip_with_immutable_evidence(engine: AsyncEngine) -> None:
    factory = create_session_factory(engine)
    project = Project(
        name="Finding",
        base_url="https://example.test/",
        allowed_hosts=("example.test",),
    )
    session = Session(project_id=project.id)
    finding = Finding(
        id=uuid4(),
        session_id=session.id,
        rule_id="headers.csp.missing",
        title="Missing CSP",
        category="security_headers",
        severity=Severity.LOW,
        confidence=Confidence.HIGH,
        affected_url="https://example.test/",
        description="No CSP observed.",
        evidence={"header": "Content-Security-Policy"},
        remediation="Define a CSP.",
    )
    async with SqliteUnitOfWork(factory) as uow:
        await uow.projects.add(project)
        await uow.sessions.add(session)
        await uow.findings.add_many((finding,))
        await uow.commit()
    async with SqliteUnitOfWork(factory) as uow:
        assert await uow.findings.list_for_session(session.id) == (finding,)
