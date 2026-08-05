from __future__ import annotations

import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

import pytest
from sqlalchemy import select

from websec_observer.capture.browser_controller import BrowserOptions
from websec_observer.capture.network_listener import CaptureLimits
from websec_observer.capture.session_service import CaptureSessionService
from websec_observer.domain.enums import SessionStatus
from websec_observer.domain.models import TestProject as Project, TestSession as Session
from websec_observer.storage.sqlite.database import create_database_engine, create_session_factory
from websec_observer.storage.sqlite.orm import Base, NetworkRequestRow, NetworkResponseRow
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork

RAW_PASSWORD = "capture-password-sentinel"
RAW_TOKEN = "capture-token-sentinel"


@asynccontextmanager
async def local_application() -> AsyncIterator[int]:
    async def handle(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            header = await reader.readuntil(b"\r\n\r\n")
            first_line = header.split(b"\r\n", 1)[0].decode("ascii")
            method, target, _ = first_line.split(" ", 2)
            content_length = 0
            for line in header.split(b"\r\n")[1:]:
                if line.lower().startswith(b"content-length:"):
                    content_length = int(line.split(b":", 1)[1].strip())
            if content_length:
                await reader.readexactly(content_length)
            if target == "/redirect":
                writer.write(
                    b"HTTP/1.1 302 Found\r\nLocation: /\r\nContent-Length: 0\r\n"
                    b"Connection: close\r\n\r\n"
                )
                await writer.drain()
                return
            if target == "/":
                body = (
                    "<!doctype html><script>"
                    "fetch('/api?access_token=" + RAW_TOKEN + "', {"
                    "method:'POST',headers:{'Content-Type':'application/json',"
                    "'Authorization':'Bearer " + RAW_TOKEN + "'},"
                    "body:JSON.stringify({password:'" + RAW_PASSWORD + "',name:'Ada'})"
                    "});</script>"
                    "<img src='http://localhost:PORT/pixel'>"
                ).encode()
                content_type = "text/html; charset=utf-8"
            elif target.startswith("/api"):
                body = (
                    '{"ok":true,"access_token":"' + RAW_TOKEN + '","password":"' + RAW_PASSWORD + '"}'
                ).encode()
                content_type = "application/json"
            else:
                body = b"pixel"
                content_type = "text/plain"
            body = body.replace(b"PORT", str(port).encode())
            response = (
                b"HTTP/1.1 200 OK\r\nContent-Type: "
                + content_type.encode()
                + b"\r\nContent-Length: "
                + str(len(body)).encode()
                + b"\r\nConnection: close\r\n\r\n"
                + body
            )
            writer.write(response)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handle, "127.0.0.1", 0)
    port = int(server.sockets[0].getsockname()[1])
    try:
        yield port
    finally:
        server.close()
        await server.wait_closed()


@pytest.mark.integration
@pytest.mark.asyncio
async def test_local_browser_capture_is_scoped_redacted_and_persisted() -> None:
    engine = create_database_engine("sqlite+aiosqlite:///:memory:")
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    factory = create_session_factory(engine)
    project = Project(
        name="Local capture",
        base_url="http://127.0.0.1/",
        allowed_hosts=("127.0.0.1",),
    )
    session = Session(project_id=project.id)
    async with SqliteUnitOfWork(factory) as uow:
        await uow.projects.add(project)
        await uow.sessions.add(session)
        await uow.commit()

    capture = CaptureSessionService(
        project,
        session,
        factory,
        BrowserOptions(headless=True),
        limits=CaptureLimits(max_request_body_bytes=4096, max_response_body_bytes=8192),
        resource_types=frozenset({"document", "fetch", "xhr", "image"}),
    )
    async with local_application() as port:
        page = await capture.start()
        async with page.expect_response(lambda response: "/api?" in response.url):
            await page.goto(f"http://127.0.0.1:{port}/redirect")
        stats = await capture.stop()
    assert stats.accepted == stats.persisted
    assert stats.persisted >= 4
    assert capture.session.status is SessionStatus.COMPLETED
    assert capture.session.started_at is not None
    assert capture.session.ended_at is not None
    assert capture.session.user_agent

    async with factory() as db:
        requests = (await db.scalars(select(NetworkRequestRow))).all()
        responses = (await db.scalars(select(NetworkResponseRow))).all()
    serialized = repr(
        [
            (row.url, row.path, row.query, row.headers, row.body, row.scope_disposition)
            for row in requests
        ]
        + [(row.headers, row.body) for row in responses]
    )
    assert RAW_PASSWORD not in serialized
    assert RAW_TOKEN not in serialized
    api_request = next(row for row in requests if row.path == "/api")
    assert api_request.method == "POST"
    assert api_request.query["access_token"] == "[REDACTED]"
    assert api_request.headers["authorization"] == "[REDACTED]"
    redirected_document = next(row for row in requests if row.path == "/")
    assert redirected_document.redirect_from_id is not None
    third_party = next(row for row in requests if row.host == "localhost")
    assert third_party.scope_disposition == "allow_metadata_only"
    assert third_party.path == "/"
    assert third_party.headers == {}
    assert third_party.body is None
    await engine.dispose()
