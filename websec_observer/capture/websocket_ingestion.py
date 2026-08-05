from __future__ import annotations

from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from websec_observer.domain.models import WebSocketConnection, WebSocketFrame
from websec_observer.storage.sqlite.batching import AsyncBatchWriter
from websec_observer.storage.sqlite.unit_of_work import SqliteUnitOfWork


class WebSocketIngestionService:
    def __init__(self, factory: async_sessionmaker[AsyncSession], queue_size: int = 2_000) -> None:
        self._factory = factory
        self._connections = AsyncBatchWriter(self._persist_connections, batch_size=50, queue_size=queue_size)
        self._frames = AsyncBatchWriter(self._persist_frames, batch_size=100, queue_size=queue_size)

    async def start(self) -> None:
        await self._connections.start()
        await self._frames.start()

    async def submit_connection(self, connection: WebSocketConnection) -> None:
        await self._connections.put(connection)

    async def submit_frames(self, frames: Sequence[WebSocketFrame]) -> None:
        for frame in frames:
            await self._frames.put(frame)

    async def stop(self) -> None:
        await self._connections.stop()
        await self._frames.stop()

    async def _persist_connections(self, items: Sequence[WebSocketConnection]) -> None:
        async with SqliteUnitOfWork(self._factory) as uow:
            for item in items:
                await uow.websockets.add_connection(item)
            await uow.commit()

    async def _persist_frames(self, items: Sequence[WebSocketFrame]) -> None:
        async with SqliteUnitOfWork(self._factory) as uow:
            await uow.websockets.add_frames(items)
            await uow.commit()
