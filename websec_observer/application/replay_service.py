from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.domain.enums import ReplayStatus
from websec_observer.domain.models import ParameterOverride, ReplayRun
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class ReplayService:
    """Creates auditable replay records; transport execution is an adapter concern."""

    def __init__(self, factory: async_sessionmaker[AsyncSession]) -> None:
        self._factory = factory

    async def create(
        self,
        *,
        session_id: UUID,
        request_id: UUID,
        overrides: tuple[ParameterOverride, ...] = (),
    ) -> ReplayRun:
        replay = ReplayRun(
            session_id=session_id,
            request_id=request_id,
            status=ReplayStatus.CREATED,
            overrides=overrides,
            started_at=datetime.now(UTC),
        )
        async with SqliteUnitOfWork(self._factory) as uow:
            await uow.replays.add(replay)
            await uow.commit()
        return replay

    async def finish(
        self,
        replay: ReplayRun,
        *,
        status: ReplayStatus,
        response_status: int | None = None,
        response_preview: str | None = None,
        error: str | None = None,
    ) -> ReplayRun:
        if status not in {ReplayStatus.SUCCEEDED, ReplayStatus.FAILED, ReplayStatus.BLOCKED}:
            raise ValueError("replay must finish with a terminal status")
        finished = ReplayRun(
            id=replay.id, session_id=replay.session_id, request_id=replay.request_id,
            status=status, overrides=replay.overrides, started_at=replay.started_at,
            ended_at=datetime.now(UTC), response_status=response_status,
            response_preview=response_preview, error=error,
        )
        async with SqliteUnitOfWork(self._factory) as uow:
            await uow.replays.add(finished)
            await uow.commit()
        return finished
