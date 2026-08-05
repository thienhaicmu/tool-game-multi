from __future__ import annotations

from dataclasses import replace
from datetime import UTC, datetime

from playwright.async_api import Page
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.capture.browser_controller import BrowserController, BrowserOptions
from websec_observer.capture.ingestion import TransactionIngestionService
from websec_observer.capture.network_listener import CaptureLimits, NetworkListener
from websec_observer.capture.action_tracker import ActionTracker
from websec_observer.capture.websocket_ingestion import WebSocketIngestionService
from websec_observer.capture.websocket_listener import WebSocketListener
from websec_observer.common.redaction import SensitiveDataRedactor
from websec_observer.common.scope import CanonicalScopePolicy
from websec_observer.domain.enums import SessionStatus
from websec_observer.domain.models import TestProject, TestSession
from websec_observer.storage.sqlite.batching import BatchWriterStats
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class CaptureSessionService:
    """Application service coordinating storage, capture, and graceful lifecycle transitions."""

    def __init__(
        self,
        project: TestProject,
        session: TestSession,
        factory: async_sessionmaker[AsyncSession],
        browser_options: BrowserOptions,
        *,
        limits: CaptureLimits | None = None,
        resource_types: frozenset[str] | None = None,
    ) -> None:
        if session.project_id != project.id:
            raise ValueError("session does not belong to project")
        self._project = project
        self._session = session
        self._factory = factory
        self._ingestion = TransactionIngestionService(factory)
        action_tracker = ActionTracker(session.id)
        self._websocket_ingestion = WebSocketIngestionService(factory)
        websocket_listener = WebSocketListener(
            session.id,
            CanonicalScopePolicy(project.allowed_hosts, project.denied_hosts),
            SensitiveDataRedactor(),
            self._websocket_ingestion.submit_connection,
            self._websocket_ingestion.submit_frames,
        )
        listener = NetworkListener(
            session.id,
            CanonicalScopePolicy(project.allowed_hosts, project.denied_hosts),
            SensitiveDataRedactor(),
            self._ingestion.submit,
            limits=limits,
            capture_resource_types=resource_types,
        )
        self._websocket_listener = websocket_listener
        self._browser = BrowserController(browser_options, listener, (websocket_listener, action_tracker))
        self.action_tracker = action_tracker
        self._started = False

    @property
    def session(self) -> TestSession:
        return self._session

    async def start(self) -> Page:
        if self._started:
            raise RuntimeError("capture session already started")
        self._session = replace(
            self._session, status=SessionStatus.STARTING, started_at=datetime.now(UTC)
        )
        await self._save_session()
        await self._ingestion.start()
        await self._websocket_ingestion.start()
        try:
            page = await self._browser.start()
            browser = page.context.browser
            self._session = replace(
                self._session,
                status=SessionStatus.RUNNING,
                browser_version=browser.version if browser else None,
                user_agent=await page.evaluate("navigator.userAgent"),
            )
            await self._save_session()
            self._started = True
            return page
        except BaseException:
            await self._ingestion.stop()
            await self._websocket_ingestion.stop()
            self._session = replace(
                self._session, status=SessionStatus.FAILED, ended_at=datetime.now(UTC)
            )
            await self._save_session()
            raise

    async def stop(self) -> BatchWriterStats:
        if not self._started:
            raise RuntimeError("capture session is not running")
        self._session = replace(self._session, status=SessionStatus.STOPPING)
        await self._save_session()
        try:
            await self._browser.stop()
            stats = await self._ingestion.stop()
            await self._websocket_ingestion.stop()
        except BaseException:
            self._session = replace(
                self._session, status=SessionStatus.FAILED, ended_at=datetime.now(UTC)
            )
            await self._save_session()
            self._started = False
            raise
        self._session = replace(
            self._session, status=SessionStatus.COMPLETED, ended_at=datetime.now(UTC)
        )
        await self._save_session()
        self._started = False
        return stats

    async def _save_session(self) -> None:
        async with SqliteUnitOfWork(self._factory) as uow:
            await uow.sessions.update(self._session)
            await uow.commit()
